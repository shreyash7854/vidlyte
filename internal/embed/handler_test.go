package embed

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"byse-resolver/internal/catalog"
	"byse-resolver/internal/config"
	"byse-resolver/internal/models"
	"byse-resolver/internal/session"
)

type mockResolver struct{}

func (m *mockResolver) Resolve(ctx context.Context, req models.MediaRequest) (*models.MediaResponse, error) {
	return &models.MediaResponse{
		Type:            req.Type,
		ID:              req.ID,
		Season:          req.Season,
		Episode:         req.Episode,
		PrimaryManifest: "https://example.com/stream/master.m3u8",
		Providers: []models.ProviderStreams{
			{Provider: "vidrift", MasterURI: "https://example.com/stream/master.m3u8"},
		},
		ResolvedAt: time.Now().UTC(),
	}, nil
}

func TestEmbedHandler_InstantPlaybackSSR(t *testing.T) {
	cfg := &config.Config{
		TokenTTL: 15 * time.Minute,
	}
	keys := map[string][]byte{"v1": []byte("test-hmac-key-0123456789abcdef01")}
	sessionMgr, err := session.NewManager(keys, "v1", 15*time.Minute)
	if err != nil {
		t.Fatalf("failed to create session manager: %v", err)
	}

	catAdapter := catalog.NewAdapter(&mockResolver{})

	h, err := NewHandler(cfg, sessionMgr, catAdapter)
	if err != nil {
		t.Fatalf("failed to create embed handler: %v", err)
	}

	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	// Test TV embed with full Vidrift query parameters
	req := httptest.NewRequest(http.MethodGet, "/embed/tv/1399/1/1?poster=https://img.com/art.jpg&brandLogo=https://img.com/logo.png&watermark=1&uiScale=1.25&controlBg=solid&font=Space+Grotesk&exit=1&showTitle=1&hide=cast,pip&autoplay=1", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", res.StatusCode)
	}

	csp := res.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-ancestors *") {
		t.Errorf("expected CSP frame-ancestors *, got %q", csp)
	}

	if xfo := res.Header.Get("X-Frame-Options"); xfo != "" {
		t.Errorf("X-Frame-Options must be empty to allow embedding, got %q", xfo)
	}

	body := rec.Body.String()
	if !strings.Contains(body, `<script id="embed-bootstrap" type="application/json">`) {
		t.Errorf("expected inlined SSR configuration block")
	}

	if !strings.Contains(body, "/hls/tv/1399/1/1/master.m3u8?token=") {
		t.Errorf("expected master playlist url with token inlined")
	}

	if !strings.Contains(body, "https://img.com/art.jpg") {
		t.Errorf("expected poster inlined in bootstrap")
	}

	if !strings.Contains(body, "https://img.com/logo.png") {
		t.Errorf("expected brandLogo inlined in bootstrap")
	}
}
