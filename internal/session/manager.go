package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrTokenExpired   = errors.New("playback token has expired")
	ErrTokenInvalid   = errors.New("invalid playback token signature")
	ErrAssetMismatch  = errors.New("token asset scope does not match requested asset")
	ErrIPMismatch     = errors.New("playback token is bound to a different client IP")
	ErrUnknownKeyID   = errors.New("unknown token key identifier")
	ErrMalformedToken = errors.New("malformed playback token structure")
	ErrTokenTooLarge  = errors.New("playback token exceeds maximum allowed size")
)

const maxTokenLength = 512

// Manager handles cryptographic creation and verification of short-lived playback tokens.
type Manager struct {
	mu           sync.RWMutex
	keys         map[string][]byte
	primaryKeyID string
	defaultTTL   time.Duration
}

// TokenClaims represents the verified payload of an authorized token.
type TokenClaims struct {
	AssetID   string    `json:"asset_id"`
	ClientIP  string    `json:"client_ip,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
	KeyID     string    `json:"key_id"`
}

// NewManager initializes a session token manager with key rotation support.
func NewManager(keys map[string][]byte, primaryKeyID string, defaultTTL time.Duration) (*Manager, error) {
	if len(keys) == 0 {
		return nil, errors.New("session manager requires at least one HMAC key")
	}
	if _, ok := keys[primaryKeyID]; !ok {
		return nil, fmt.Errorf("primary key ID %q not present in key store", primaryKeyID)
	}
	if defaultTTL <= 0 {
		defaultTTL = 15 * time.Minute
	}

	return &Manager{
		keys:         keys,
		primaryKeyID: primaryKeyID,
		defaultTTL:   defaultTTL,
	}, nil
}

// IssueToken creates a signed, short-lived playback token scoped to a specific assetID (unbound IP).
func (m *Manager) IssueToken(assetID string, ttl time.Duration) (string, error) {
	return m.IssueTokenForClient(assetID, "", ttl)
}

// IssueTokenForClient creates a signed token scoped to assetID and optionally bound to clientIP.
func (m *Manager) IssueTokenForClient(assetID, clientIP string, ttl time.Duration) (string, error) {
	if ttl <= 0 {
		ttl = m.defaultTTL
	}
	return m.IssueTokenWithExpiry(assetID, clientIP, time.Now().Add(ttl))
}

// IssueTokenWithExpiry creates a signed playback token with explicit expiration and optional client IP.
func (m *Manager) IssueTokenWithExpiry(assetID, clientIP string, expiresAt time.Time) (string, error) {
	if assetID == "" {
		return "", errors.New("cannot issue token for empty assetID")
	}

	m.mu.RLock()
	keyID := m.primaryKeyID
	key := m.keys[keyID]
	m.mu.RUnlock()

	assetEncoded := base64.RawURLEncoding.EncodeToString([]byte(assetID))
	expiryHex := strconv.FormatInt(expiresAt.Unix(), 16)

	if clientIP != "" {
		// 5-part IP-bound token: keyID.assetEncoded.expiryHex.ipEncoded.signatureHex
		ipEncoded := base64.RawURLEncoding.EncodeToString([]byte(clientIP))
		message := keyID + ":" + assetEncoded + ":" + expiryHex + ":" + clientIP

		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(message))
		signatureHex := hex.EncodeToString(mac.Sum(nil))

		return keyID + "." + assetEncoded + "." + expiryHex + "." + ipEncoded + "." + signatureHex, nil
	}

	// 4-part unbound token: keyID.assetEncoded.expiryHex.signatureHex
	message := keyID + ":" + assetEncoded + ":" + expiryHex

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	signatureHex := hex.EncodeToString(mac.Sum(nil))

	return keyID + "." + assetEncoded + "." + expiryHex + "." + signatureHex, nil
}

// ValidateToken verifies token signature, expiry, and asset scope without requiring client IP check.
func (m *Manager) ValidateToken(token, expectedAssetID string) (*TokenClaims, error) {
	return m.ValidateTokenForClient(token, expectedAssetID, "")
}

// ValidateTokenForClient verifies token signature, expiry, asset scope, and client IP in constant time.
func (m *Manager) ValidateTokenForClient(token, expectedAssetID, requestClientIP string) (*TokenClaims, error) {
	if len(token) == 0 {
		return nil, ErrMalformedToken
	}
	if len(token) > maxTokenLength {
		return nil, ErrTokenTooLarge
	}

	parts := strings.Split(token, ".")
	if len(parts) != 4 && len(parts) != 5 {
		return nil, ErrMalformedToken
	}

	keyID := parts[0]
	assetEncoded := parts[1]
	expiryHex := parts[2]

	var tokenClientIP string
	var signatureHex string

	if len(parts) == 5 {
		ipBytes, err := base64.RawURLEncoding.DecodeString(parts[3])
		if err != nil {
			return nil, ErrMalformedToken
		}
		tokenClientIP = string(ipBytes)
		signatureHex = parts[4]
	} else {
		signatureHex = parts[3]
	}

	// Lookup key for rotation
	m.mu.RLock()
	key, keyExists := m.keys[keyID]
	m.mu.RUnlock()

	if !keyExists {
		return nil, ErrUnknownKeyID
	}

	// 1. Verify HMAC signature in constant time
	var message string
	if len(parts) == 5 {
		message = keyID + ":" + assetEncoded + ":" + expiryHex + ":" + tokenClientIP
	} else {
		message = keyID + ":" + assetEncoded + ":" + expiryHex
	}

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	expectedSig := mac.Sum(nil)

	actualSig, err := hex.DecodeString(signatureHex)
	if err != nil || len(actualSig) != len(expectedSig) {
		return nil, ErrTokenInvalid
	}

	if subtle.ConstantTimeCompare(actualSig, expectedSig) != 1 {
		return nil, ErrTokenInvalid
	}

	// 2. Decode & check expiry
	expiryUnix, err := strconv.ParseInt(expiryHex, 16, 64)
	if err != nil {
		return nil, ErrMalformedToken
	}
	expiresAt := time.Unix(expiryUnix, 0)
	if time.Now().After(expiresAt) {
		return nil, ErrTokenExpired
	}

	// 3. Decode & check asset scope
	assetBytes, err := base64.RawURLEncoding.DecodeString(assetEncoded)
	if err != nil {
		return nil, ErrMalformedToken
	}
	tokenAssetID := string(assetBytes)

	if expectedAssetID != "" && subtle.ConstantTimeCompare([]byte(tokenAssetID), []byte(expectedAssetID)) != 1 {
		return nil, ErrAssetMismatch
	}

	// 4. Check client IP binding if bound and caller IP is provided
	if tokenClientIP != "" && requestClientIP != "" {
		if subtle.ConstantTimeCompare([]byte(tokenClientIP), []byte(requestClientIP)) != 1 {
			return nil, ErrIPMismatch
		}
	}

	return &TokenClaims{
		AssetID:   tokenAssetID,
		ClientIP:  tokenClientIP,
		ExpiresAt: expiresAt,
		KeyID:     keyID,
	}, nil
}

// ExtractClientIP extracts the caller's IP address from standard proxy headers or connection.
func ExtractClientIP(r *http.Request) string {
	// 1. Cloudflare connecting IP
	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		return cf
	}
	// 2. X-Real-IP
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		return xr
	}
	// 3. X-Forwarded-For (first entry is the original client)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			ip := strings.TrimSpace(parts[0])
			if ip != "" {
				return ip
			}
		}
	}
	// 4. RemoteAddr
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}
