package session

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSessionManager(t *testing.T) {
	keys := map[string][]byte{
		"v1": []byte("test-secret-key-32-bytes-long!!!"),
		"v2": []byte("older-secret-key-32-bytes-long!!"),
	}

	mgr, err := NewManager(keys, "v1", 10*time.Minute)
	if err != nil {
		t.Fatalf("failed to create session manager: %v", err)
	}

	t.Run("Valid token issue and validate", func(t *testing.T) {
		token, err := mgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		if err != nil {
			t.Fatalf("IssueToken failed: %v", err)
		}

		claims, err := mgr.ValidateToken(token, "tv/1399/1/1")
		if err != nil {
			t.Fatalf("ValidateToken failed on valid token: %v", err)
		}

		if claims.AssetID != "tv/1399/1/1" {
			t.Errorf("expected assetID tv/1399/1/1, got %s", claims.AssetID)
		}
		if claims.KeyID != "v1" {
			t.Errorf("expected keyID v1, got %s", claims.KeyID)
		}
	})

	t.Run("IP-bound token validation and mismatch rejection", func(t *testing.T) {
		clientIP := "198.51.100.42"
		token, err := mgr.IssueTokenForClient("tv/1399/1/1", clientIP, 5*time.Minute)
		if err != nil {
			t.Fatalf("IssueTokenForClient failed: %v", err)
		}

		// 1. Same client IP should succeed
		claims, err := mgr.ValidateTokenForClient(token, "tv/1399/1/1", clientIP)
		if err != nil {
			t.Fatalf("expected IP-bound token to validate with same IP, got: %v", err)
		}
		if claims.ClientIP != clientIP {
			t.Errorf("expected claims.ClientIP %s, got %s", clientIP, claims.ClientIP)
		}

		// 2. Different client IP (e.g. scraper distributing link) must be rejected
		intruderIP := "203.0.113.99"
		_, err = mgr.ValidateTokenForClient(token, "tv/1399/1/1", intruderIP)
		if !errors.Is(err, ErrIPMismatch) {
			t.Fatalf("expected ErrIPMismatch for different IP, got: %v", err)
		}
	})

	t.Run("Asset mismatch rejection", func(t *testing.T) {
		token, err := mgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		if err != nil {
			t.Fatalf("IssueToken failed: %v", err)
		}

		_, err = mgr.ValidateToken(token, "tv/99999/1/1")
		if !errors.Is(err, ErrAssetMismatch) {
			t.Errorf("expected ErrAssetMismatch, got: %v", err)
		}
	})

	t.Run("Expired token rejection", func(t *testing.T) {
		token, err := mgr.IssueTokenWithExpiry("tv/1399/1/1", "", time.Now().Add(-10*time.Second))
		if err != nil {
			t.Fatalf("IssueTokenWithExpiry failed: %v", err)
		}

		_, err = mgr.ValidateToken(token, "tv/1399/1/1")
		if !errors.Is(err, ErrTokenExpired) {
			t.Errorf("expected ErrTokenExpired, got: %v", err)
		}
	})

	t.Run("Tampered signature rejection", func(t *testing.T) {
		token, err := mgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		if err != nil {
			t.Fatalf("IssueToken failed: %v", err)
		}

		// Corrupt last character of HMAC signature
		tampered := token[:len(token)-1] + "a"
		if tampered == token {
			tampered = token[:len(token)-1] + "b"
		}

		_, err = mgr.ValidateToken(tampered, "tv/1399/1/1")
		if !errors.Is(err, ErrTokenInvalid) {
			t.Errorf("expected ErrTokenInvalid, got: %v", err)
		}
	})

	t.Run("Malformed token rejection", func(t *testing.T) {
		malformedCases := []string{
			"",
			"not.enough.parts",
			"too.many.parts.here.extra.overflow",
			"invalid-token",
		}
		for _, tc := range malformedCases {
			_, err := mgr.ValidateToken(tc, "tv/1399/1/1")
			if !errors.Is(err, ErrMalformedToken) {
				t.Errorf("case %q: expected ErrMalformedToken, got %v", tc, err)
			}
		}
	})

	t.Run("Key rotation verification", func(t *testing.T) {
		// Old manager issued token with v2
		mgrV2, err := NewManager(keys, "v2", 10*time.Minute)
		if err != nil {
			t.Fatalf("failed to create v2 manager: %v", err)
		}
		tokenV2, err := mgrV2.IssueToken("tv/1399/1/1", 5*time.Minute)
		if err != nil {
			t.Fatalf("mgrV2.IssueToken failed: %v", err)
		}

		// Current manager (primary is v1) should validate token issued with v2
		claims, err := mgr.ValidateToken(tokenV2, "tv/1399/1/1")
		if err != nil {
			t.Fatalf("mgr failed to validate token with older key: %v", err)
		}
		if claims.KeyID != "v2" {
			t.Errorf("expected keyID v2, got %s", claims.KeyID)
		}
	})

	t.Run("ExtractClientIP header inspection", func(t *testing.T) {
		req := httptest.NewRequest("GET", "http://example.com/test", nil)
		req.Header.Set("CF-Connecting-IP", "1.1.1.1")
		req.Header.Set("X-Real-IP", "2.2.2.2")
		req.Header.Set("X-Forwarded-For", "3.3.3.3, 4.4.4.4")
		req.RemoteAddr = "5.5.5.5:1234"

		if ip := ExtractClientIP(req); ip != "1.1.1.1" {
			t.Errorf("expected CF-Connecting-IP 1.1.1.1, got %s", ip)
		}

		req.Header.Del("CF-Connecting-IP")
		if ip := ExtractClientIP(req); ip != "2.2.2.2" {
			t.Errorf("expected X-Real-IP 2.2.2.2, got %s", ip)
		}

		req.Header.Del("X-Real-IP")
		if ip := ExtractClientIP(req); ip != "3.3.3.3" {
			t.Errorf("expected X-Forwarded-For 3.3.3.3, got %s", ip)
		}

		req.Header.Del("X-Forwarded-For")
		if ip := ExtractClientIP(req); ip != "5.5.5.5" {
			t.Errorf("expected RemoteAddr 5.5.5.5, got %s", ip)
		}
	})
}
