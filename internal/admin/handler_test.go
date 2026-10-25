package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"byse-resolver/internal/config"
)

func TestAdminHandler_Lifecycle(t *testing.T) {
	testSecret := "test_secret_32_characters_long_!"
	auth := NewAuthManager(testSecret)

	tmpDir := t.TempDir()
	store, err := config.NewConfigStore(filepath.Join(tmpDir, "cfg.json"))
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}

	handler := NewHandler(auth, store)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	// 1. GET /admin-login-i returns HTML and noindex header
	req := httptest.NewRequest("GET", "/admin-login-i", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 OK, got %d", rec.Code)
	}
	if rec.Header().Get("X-Robots-Tag") != "noindex, nofollow, noarchive" {
		t.Errorf("missing or incorrect X-Robots-Tag header")
	}

	// 2. Unauthenticated GET /admin-login-i/api/config should return 401
	req = httptest.NewRequest("GET", "/admin-login-i/api/config", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized, got %d", rec.Code)
	}

	// 3. Bad password attempts
	badPayload, _ := json.Marshal(map[string]string{"secret": "wrong_password"})
	req = httptest.NewRequest("POST", "/admin-login-i/auth", bytes.NewReader(badPayload))
	req.RemoteAddr = "192.168.1.100:12345"
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for wrong secret, got %d", rec.Code)
	}

	// 4. Exhaust attempts to trigger brute-force jail (5 attempts total)
	for i := 0; i < 4; i++ {
		req = httptest.NewRequest("POST", "/admin-login-i/auth", bytes.NewReader(badPayload))
		req.RemoteAddr = "192.168.1.100:12345"
		rec = httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
	}

	// 6th attempt should be 429 Too Many Requests
	req = httptest.NewRequest("POST", "/admin-login-i/auth", bytes.NewReader(badPayload))
	req.RemoteAddr = "192.168.1.100:12345"
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 Too Many Requests after 5 failures, got %d", rec.Code)
	}

	// 5. Successful login from new IP
	goodPayload, _ := json.Marshal(map[string]string{"secret": testSecret})
	req = httptest.NewRequest("POST", "/admin-login-i/auth", bytes.NewReader(goodPayload))
	req.RemoteAddr = "10.0.0.1:54321"
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on correct secret, got %d", rec.Code)
	}

	cookies := rec.Result().Cookies()
	var sessionCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == SessionCookieName {
			sessionCookie = c
			break
		}
	}
	if sessionCookie == nil {
		t.Fatalf("expected %s cookie to be set", SessionCookieName)
	}

	// 6. Access config API with valid session cookie
	req = httptest.NewRequest("GET", "/admin-login-i/api/config", nil)
	req.AddCookie(sessionCookie)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 OK with valid cookie, got %d", rec.Code)
	}

	// 7. Update config
	newCfg := store.Get()
	newCfg.Site.BrandName = "VidLyte Ultimate"
	newCfg.Monetization.PopundersEnabled = true
	newCfg.Monetization.SmartlinkURL = "https://smartlink.example/test"
	updatePayload, _ := json.Marshal(newCfg)

	req = httptest.NewRequest("POST", "/admin-login-i/api/config", bytes.NewReader(updatePayload))
	req.AddCookie(sessionCookie)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 OK on update, got %d", rec.Code)
	}

	updated := store.Get()
	if updated.Site.BrandName != "VidLyte Ultimate" {
		t.Errorf("expected updated brand name, got %s", updated.Site.BrandName)
	}
	if updated.Monetization.SmartlinkURL != "https://smartlink.example/test" {
		t.Errorf("expected updated smartlink URL, got %s", updated.Monetization.SmartlinkURL)
	}
}
