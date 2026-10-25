package proxy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	tokenSecretOnce sync.Once
	tokenSecretKey  []byte
)

// getSecretKey retrieves or generates the HMAC secret key for stream signing
func getSecretKey() []byte {
	tokenSecretOnce.Do(func() {
		sec := os.Getenv("STREAM_SECRET")
		if sec == "" {
			sec = os.Getenv("VIDLYTE_ADMIN_SECRET")
		}
		if sec == "" {
			sec = os.Getenv("ADMIN_SECRET")
		}
		if sec == "" {
			sec = os.Getenv("GATEWAY_HMAC_SECRET")
		}
		if sec == "" {
			sec = "vidlyte_sovereign_ephemeral_stream_secret_2026_x89f_core"
		}
		tokenSecretKey = []byte(sec)
	})
	return tokenSecretKey
}

// GenerateStreamToken computes an HMAC-SHA256 signature for a target URL and expiration timestamp.
func GenerateStreamToken(targetURL string, exp time.Time) string {
	mac := hmac.New(sha256.New, getSecretKey())
	payload := fmt.Sprintf("%s|%d", targetURL, exp.Unix())
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyStreamToken validates that the token matches the target URL and has not expired.
func VerifyStreamToken(targetURL string, token string, expStr string) bool {
	if token == "" || expStr == "" {
		return false
	}
	expUnix, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return false
	}

	// In production, enforce strict 10-minute clock skew window.
	// In development, allow 24-hour grace period so restarting the resolver does not invalidate active tabs.
	isProd := os.Getenv("ENV") == "production"
	maxExpiry := expUnix + 600
	if !isProd {
		maxExpiry = expUnix + 86400
	}
	if time.Now().Unix() > maxExpiry {
		return false
	}

	// Keys to check: active primary key, plus dev fallback key
	keys := [][]byte{getSecretKey(), []byte("byse-dev-stable-secret-key-32byt")}

	// URLs to test: raw, plus '+' restored if space-encoded
	testURLs := []string{targetURL}
	if strings.Contains(targetURL, " ") {
		testURLs = append(testURLs, strings.ReplaceAll(targetURL, " ", "+"))
	}

	for _, k := range keys {
		for _, u := range testURLs {
			mac := hmac.New(sha256.New, k)
			payload := fmt.Sprintf("%s|%d", u, expUnix)
			mac.Write([]byte(payload))
			expected := hex.EncodeToString(mac.Sum(nil))
			if hmac.Equal([]byte(token), []byte(expected)) {
				return true
			}
		}
	}

	return false
}

// SignProxyURL generates a secure, signed proxy URL with 4-hour expiration.
func SignProxyURL(baseProxyPath string, targetURL string, provider string) string {
	exp := time.Now().Add(4 * time.Hour)
	token := GenerateStreamToken(targetURL, exp)
	return fmt.Sprintf("%s?url=%s&provider=%s&exp=%d&sig=%s",
		baseProxyPath,
		url.QueryEscape(targetURL),
		url.QueryEscape(provider),
		exp.Unix(),
		token,
	)
}
