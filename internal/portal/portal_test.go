package portal

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"byse-resolver/internal/config"
)

func TestPortalHandler_Serve(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := config.NewConfigStore(filepath.Join(tmpDir, "cfg.json"))
	if err != nil {
		t.Fatalf("failed to init config store: %v", err)
	}

	handler := NewHandler(store)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "VidLyte") {
		t.Errorf("expected VidLyte brand in rendered HTML")
	}
	if !strings.Contains(body, "window.VIDLYTE_CONFIG =") {
		t.Errorf("expected injected window.VIDLYTE_CONFIG")
	}
	if !strings.Contains(body, "Embed") {
		t.Errorf("expected Embed section in portal")
	}
}
