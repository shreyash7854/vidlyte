package admin

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	SessionCookieName = "vidlyte_admin_session"
	SessionDuration   = 12 * time.Hour
	MaxLoginAttempts  = 5
	LockoutDuration   = 15 * time.Minute
)

type failedAttempt struct {
	count       int
	firstFailed time.Time
	lockedUntil time.Time
}

// AuthManager handles secret verification, brute-force mitigation, and signed sessions.
type AuthManager struct {
	adminSecret []byte
	attempts    map[string]*failedAttempt
	mu          sync.Mutex
}

// NewAuthManager initializes auth with the provided secret or environment variables.
func NewAuthManager(secret string) *AuthManager {
	if secret == "" {
		secret = os.Getenv("VIDLYTE_ADMIN_SECRET")
	}
	if secret == "" {
		secret = os.Getenv("ADMIN_SECRET_KEY")
	}
	if secret == "" {
		// Generate deterministic or safe random 32-byte secret for development
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		secret = hex.EncodeToString(b)
	}

	return &AuthManager{
		adminSecret: []byte(secret),
		attempts:    make(map[string]*failedAttempt),
	}
}

// GetSecretString returns the secret for display in development logs if needed.
func (a *AuthManager) GetSecretString() string {
	return string(a.adminSecret)
}

// ExtractClientIP extracts client IP taking Cloudflare and proxies into account.
func ExtractClientIP(r *http.Request) string {
	if cfIP := r.Header.Get("CF-Connecting-IP"); cfIP != "" {
		return strings.TrimSpace(cfIP)
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			ip := strings.TrimSpace(parts[0])
			if ip != "" {
				return ip
			}
		}
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

// CheckRateLimit checks if client IP is currently locked out from brute-force attempts.
func (a *AuthManager) CheckRateLimit(ip string) (bool, time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	attempt, exists := a.attempts[ip]
	if !exists {
		return true, 0
	}

	if attempt.lockedUntil.After(now) {
		return false, attempt.lockedUntil.Sub(now)
	}

	// Reset window after lockout expiration
	if now.Sub(attempt.firstFailed) > LockoutDuration {
		delete(a.attempts, ip)
	}

	return true, 0
}

// RecordFailure records a failed login attempt for the IP.
func (a *AuthManager) RecordFailure(ip string) (remaining int, locked bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	attempt, exists := a.attempts[ip]
	if !exists || now.Sub(attempt.firstFailed) > LockoutDuration {
		a.attempts[ip] = &failedAttempt{
			count:       1,
			firstFailed: now,
		}
		return MaxLoginAttempts - 1, false
	}

	attempt.count++
	if attempt.count >= MaxLoginAttempts {
		attempt.lockedUntil = now.Add(LockoutDuration)
		return 0, true
	}

	return MaxLoginAttempts - attempt.count, false
}

// ResetFailure clears failed attempts for an IP on successful login.
func (a *AuthManager) ResetFailure(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.attempts, ip)
}

// VerifySecret constant-time validates the user-submitted password against the admin secret.
func (a *AuthManager) VerifySecret(submitted string) bool {
	if len(submitted) == 0 || len(a.adminSecret) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(submitted), a.adminSecret) == 1
}

// CreateSessionCookie generates a cryptographically signed session token and cookie.
func (a *AuthManager) CreateSessionCookie(r *http.Request) *http.Cookie {
	expiresAt := time.Now().Add(SessionDuration).Unix()
	payload := fmt.Sprintf("%d", expiresAt)

	mac := hmac.New(sha256.New, a.adminSecret)
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))

	token := fmt.Sprintf("%s.%s", payload, sig)

	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/admin-login-i",
		Expires:  time.Now().Add(SessionDuration),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	}
}

// ValidateSession verifies the session cookie signature and expiry.
func (a *AuthManager) ValidateSession(r *http.Request) bool {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil || cookie == nil || cookie.Value == "" {
		return false
	}

	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return false
	}

	payload := parts[0]
	sigHex := parts[1]

	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, a.adminSecret)
	mac.Write([]byte(payload))
	expectedSig := mac.Sum(nil)

	if subtle.ConstantTimeCompare(sig, expectedSig) != 1 {
		return false
	}

	expiresAt, err := strconv.ParseInt(payload, 10, 64)
	if err != nil || time.Now().Unix() > expiresAt {
		return false
	}

	return true
}

// ClearSessionCookie creates an expired cookie to logout.
func (a *AuthManager) ClearSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/admin-login-i",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	}
}
