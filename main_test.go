package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"byse-resolver/internal/cache"
	"byse-resolver/internal/handler"
	"byse-resolver/internal/models"
	"byse-resolver/internal/proxy"
	"byse-resolver/internal/service"
)

func setupTestApp() http.Handler {
	memCache := cache.NewMemoryCache(10*time.Minute, 1*time.Minute)
	resolverService := service.NewResolverService(memCache)
	streamProxy := proxy.NewStreamProxy()

	mux := http.NewServeMux()
	h := handler.NewHandler(resolverService, streamProxy)
	h.RegisterRoutes(mux)

	return mux
}

func TestResolveTVRoute(t *testing.T) {
	app := setupTestApp()

	req := httptest.NewRequest("GET", "/tv/289423/1/1", nil)
	rec := httptest.NewRecorder()

	app.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got: %d", rec.Code)
	}

	var resp models.MediaResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Type != "tv" || resp.ID != "289423" || resp.Season != 1 || resp.Episode != 1 {
		t.Errorf("unexpected payload metadata: %+v", resp)
	}

	if len(resp.Variants) == 0 {
		t.Errorf("expected variants, got 0")
	}

	if len(resp.AudioTracks) != 8 {
		t.Errorf("expected 8 audio tracks for 289423, got %d", len(resp.AudioTracks))
	}
}

func TestResolveTitle314939(t *testing.T) {
	app := setupTestApp()

	req := httptest.NewRequest("GET", "/tv/314939/1/1", nil)
	rec := httptest.NewRecorder()

	app.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got: %d", rec.Code)
	}

	var resp models.MediaResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.ID != "314939" {
		t.Errorf("expected ID 314939, got %s", resp.ID)
	}

	if len(resp.AudioTracks) != 12 {
		t.Errorf("expected 12 audio tracks for 314939, got %d", len(resp.AudioTracks))
	}
}

func TestResolveTitle1399_MultiProvider(t *testing.T) {
	app := setupTestApp()

	req := httptest.NewRequest("GET", "/tv/1399/1/1", nil)
	rec := httptest.NewRecorder()

	app.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got: %d", rec.Code)
	}

	var resp models.MediaResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.ID != "1399" {
		t.Errorf("expected ID 1399, got %s", resp.ID)
	}

	// Verify both providers are returned
	if len(resp.Providers) != 2 {
		t.Fatalf("expected 2 providers (orion and evion), got %d", len(resp.Providers))
	}

	// Verify unified audio tracks contain all regional dubs
	if len(resp.AudioTracks) < 5 {
		t.Errorf("expected at least 5 unified audio tracks for 1399, got %d", len(resp.AudioTracks))
	}

	// Verify headers and proxy URLs are attached to every audio track
	for _, track := range resp.AudioTracks {
		if track.Headers.Referer == "" {
			t.Errorf("missing Referer header on track: %s", track.Name)
		}
		if track.Headers.Origin == "" {
			t.Errorf("missing Origin header on track: %s", track.Name)
		}
		if track.Headers.UserAgent == "" {
			t.Errorf("missing UserAgent header on track: %s", track.Name)
		}
		if track.ProxiedURI == "" {
			t.Errorf("missing ProxiedURI on track: %s", track.Name)
		}
		if track.Domain == "" {
			t.Errorf("missing Domain on track: %s", track.Name)
		}
	}

	// Verify top-level proxy rules
	if _, ok := resp.ProxyRules["evion"]; !ok {
		t.Errorf("expected evion in ProxyRules")
	}
	if _, ok := resp.ProxyRules["orion"]; !ok {
		t.Errorf("expected orion in ProxyRules")
	}
}

func TestProxyRouteMissingURL(t *testing.T) {
	app := setupTestApp()
	req := httptest.NewRequest("GET", "/proxy", nil)
	rec := httptest.NewRecorder()

	app.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for missing url parameter, got: %d", rec.Code)
	}
}

func BenchmarkResolveTVRoute(b *testing.B) {
	app := setupTestApp()
	req := httptest.NewRequest("GET", "/tv/289423/1/1", nil)

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)
	}
}
