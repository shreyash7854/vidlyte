package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"byse-resolver/internal/catalog"
	"byse-resolver/internal/config"
	"byse-resolver/internal/diskcache"
	"byse-resolver/internal/models"
	"byse-resolver/internal/session"
	"byse-resolver/internal/upstream"
)

type mockResolver struct {
	primaryManifest string
	provider        string
}

func (m *mockResolver) Resolve(ctx context.Context, req models.MediaRequest) (*models.MediaResponse, error) {
	if req.ID == "unauthorized" {
		return nil, fmt.Errorf("asset unauthorized")
	}
	return &models.MediaResponse{
		Type:            req.Type,
		ID:              req.ID,
		Season:          req.Season,
		Episode:         req.Episode,
		PrimaryManifest: m.primaryManifest,
		Providers: []models.ProviderStreams{
			{Provider: m.provider, MasterURI: m.primaryManifest},
		},
	}, nil
}

func setupTestGateway(t *testing.T, upstreamServerURL string, enableCache bool) (*Gateway, *session.Manager, *catalog.Adapter, *diskcache.DiskCache) {
	u, _ := url.Parse(upstreamServerURL)
	cfg := &config.Config{
		ApprovedHosts: map[string]bool{
			u.Hostname(): true,
			"127.0.0.1":  true,
			"localhost":  true,
		},
		UpstreamTimeout:  3 * time.Second,
		UpstreamMaxConns: 20,
		TokenTTL:         10 * time.Minute,
		Env:              "development",
	}

	keys := map[string][]byte{
		"v1": []byte("test-gateway-secret-32-bytes!!!"),
	}
	sessMgr, err := session.NewManager(keys, "v1", 10*time.Minute)
	if err != nil {
		t.Fatalf("failed to init session manager: %v", err)
	}

	mockRes := &mockResolver{
		primaryManifest: upstreamServerURL + "/master.m3u8",
		provider:        "evion",
	}
	catAdapter := catalog.NewAdapter(mockRes)

	upClient := upstream.NewClient(cfg)

	var diskC *diskcache.DiskCache
	if enableCache {
		tmpDir, _ := os.MkdirTemp("", "gw-cache-*")
		diskC, _ = diskcache.NewDiskCache(tmpDir, 10*1024*1024, 1*time.Hour)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	gw := NewGateway(cfg, sessMgr, catAdapter, upClient, diskC, logger)

	return gw, sessMgr, catAdapter, diskC
}

func TestGatewayFullFlow(t *testing.T) {
	// 1. Setup local mock upstream server simulating HLS streams
	segmentData := []byte("binary-video-ts-chunk-payload-data-1234567890")
	var upstreamHitCount int

	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHitCount++
		path := r.URL.Path

		switch {
		case path == "/master.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = fmt.Fprint(w, `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080
1080p/index.m3u8
`)
		case path == "/1080p/index.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = fmt.Fprint(w, `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
seg0.ts
#EXTINF:6.000,
seg1.ts
#EXT-X-ENDLIST
`)
		case strings.HasSuffix(path, ".ts"):
			w.Header().Set("Content-Type", "video/mp2t")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			if r.Header.Get("Range") != "" {
				w.Header().Set("Content-Range", "bytes 0-9/46")
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(segmentData[:10])
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(segmentData)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstreamServer.Close()

	gw, sessMgr, catAdapter, _ := setupTestGateway(t, upstreamServer.URL, true)

	// Pre-seed catalog for test asset "tv/1399/1/1"
	catAdapter.RegisterResource("tv/1399/1/1", upstreamServer.URL+"/master.m3u8", "evion")

	// Helper to resolve test asset to mock upstream
	// We test the gateway HTTP mux
	mux := http.NewServeMux()
	gw.RegisterRoutes(mux)

	// Override adapter's internal resolver behavior using pre-registered resource
	t.Run("Create Session via POST /v1/playback-sessions", func(t *testing.T) {
		body, _ := json.Marshal(PlaybackSessionRequest{
			AssetID: "tv/1399/1/1",
		})
		req := httptest.NewRequest("POST", "/v1/playback-sessions", bytes.NewReader(body))
		rec := httptest.NewRecorder()

		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201 Created, got: %d (%s)", rec.Code, rec.Body.String())
		}

		var resp PlaybackSessionResponse
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if resp.AssetID != "tv/1399/1/1" || resp.Token == "" || !strings.Contains(resp.PlaylistURL, "master.m3u8?token=") {
			t.Errorf("unexpected session response: %+v", resp)
		}
	})

	t.Run("Reject missing or invalid token on playlist request", func(t *testing.T) {
		// No token
		req := httptest.NewRequest("GET", "/hls/tv/1399/1/1/master.m3u8", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("expected 401 Unauthorized for missing token, got: %d", rec.Code)
		}

		// Tampered token
		reqTampered := httptest.NewRequest("GET", "/hls/tv/1399/1/1/master.m3u8?token=invalid.tampered.token.123", nil)
		recTampered := httptest.NewRecorder()
		mux.ServeHTTP(recTampered, reqTampered)
		if recTampered.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for tampered token, got: %d", recTampered.Code)
		}
	})

	t.Run("Authorized Master Playlist Fetch and Rewrite", func(t *testing.T) {
		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		req := httptest.NewRequest("GET", "/hls/tv/1399/1/1/master.m3u8?token="+token, nil)
		rec := httptest.NewRecorder()

		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got: %d (%s)", rec.Code, rec.Body.String())
		}

		body := rec.Body.String()
		if !strings.HasPrefix(body, "#EXTM3U") {
			t.Errorf("expected HLS manifest header, got: %s", body)
		}

		// Verify 1080p variant was rewritten to an opaque gateway resource URL
		if !strings.Contains(body, "/hls/tv/1399/1/1/resource/") || !strings.Contains(body, "?token="+token) {
			t.Errorf("expected rewritten resource URI in master playlist: %s", body)
		}
	})

	t.Run("Authorized Media Segment Fetch through Resource Endpoint", func(t *testing.T) {
		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		resID := catAdapter.RegisterResource("tv/1399/1/1", upstreamServer.URL+"/seg0.ts", "evion")

		req := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/resource/%s?token=%s", resID, token), nil)
		rec := httptest.NewRecorder()

		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got: %d", rec.Code)
		}

		if !bytes.Equal(rec.Body.Bytes(), segmentData) {
			t.Errorf("streamed segment payload mismatch")
		}
		if rec.Header().Get("Content-Type") != "video/mp2t" {
			t.Errorf("expected Content-Type video/mp2t, got: %s", rec.Header().Get("Content-Type"))
		}
	})

	t.Run("Range request partial content streaming", func(t *testing.T) {
		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		resID := catAdapter.RegisterResource("tv/1399/1/1", upstreamServer.URL+"/seg1.ts", "evion")

		req := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/resource/%s?token=%s", resID, token), nil)
		req.Header.Set("Range", "bytes=0-9")
		rec := httptest.NewRecorder()

		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusPartialContent {
			t.Fatalf("expected 206 Partial Content, got: %d", rec.Code)
		}

		if len(rec.Body.Bytes()) != 10 {
			t.Errorf("expected 10 bytes for range 0-9, got: %d", len(rec.Body.Bytes()))
		}
	})

	t.Run("Healthz and Readyz probes", func(t *testing.T) {
		recH := httptest.NewRecorder()
		mux.ServeHTTP(recH, httptest.NewRequest("GET", "/healthz", nil))
		if recH.Code != http.StatusOK {
			t.Errorf("expected 200 for /healthz, got: %d", recH.Code)
		}

		recR := httptest.NewRecorder()
		mux.ServeHTTP(recR, httptest.NewRequest("GET", "/readyz", nil))
		if recR.Code != http.StatusOK {
			t.Errorf("expected 200 for /readyz, got: %d", recR.Code)
		}
	})

	t.Run("Disk Cache hit on second request", func(t *testing.T) {
		initialHits := upstreamHitCount
		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		resID := catAdapter.RegisterResource("tv/1399/1/1", upstreamServer.URL+"/cached_seg.ts", "evion")

		uri := fmt.Sprintf("/hls/tv/1399/1/1/resource/%s?token=%s", resID, token)

		// 1st request -> cache miss, fetches upstream
		rec1 := httptest.NewRecorder()
		mux.ServeHTTP(rec1, httptest.NewRequest("GET", uri, nil))
		if rec1.Code != http.StatusOK {
			t.Fatalf("first request failed: %d", rec1.Code)
		}
		if upstreamHitCount != initialHits+1 {
			t.Errorf("expected upstream hits to increment by 1, got: %d", upstreamHitCount-initialHits)
		}

		// 2nd request -> cache hit! Upstream hits must NOT increment
		rec2 := httptest.NewRecorder()
		mux.ServeHTTP(rec2, httptest.NewRequest("GET", uri, nil))
		if rec2.Code != http.StatusOK {
			t.Fatalf("second request failed: %d", rec2.Code)
		}
		if rec2.Header().Get("X-Cache") != "HIT" {
			t.Errorf("expected X-Cache: HIT, got: %s", rec2.Header().Get("X-Cache"))
		}
		if upstreamHitCount != initialHits+1 {
			t.Errorf("expected cache hit to NOT call upstream, but hits was %d", upstreamHitCount)
		}
	})

	t.Run("SSRF blocked on unapproved upstream host", func(t *testing.T) {
		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		unapprovedResID := catAdapter.RegisterResource("tv/1399/1/1", "https://unapproved.attacker.com/leak.ts", "evion")

		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/resource/%s?token=%s", unapprovedResID, token), nil))

		if rec.Code != http.StatusBadGateway {
			t.Errorf("expected 502 Bad Gateway for SSRF blocked host, got: %d", rec.Code)
		}
	})

	t.Run("Client cancellation propagation", func(t *testing.T) {
		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		resID := catAdapter.RegisterResource("tv/1399/1/1", upstreamServer.URL+"/seg0.ts", "evion")

		ctx, cancel := context.WithCancel(context.Background())
		cancel() // Cancel before executing

		req := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/resource/%s?token=%s", resID, token), nil).WithContext(ctx)
		rec := httptest.NewRecorder()

		mux.ServeHTTP(rec, req)
		// Request should abort gracefully without panics
	})

	t.Run("Client IP binding enforcement", func(t *testing.T) {
		clientIP := "198.51.100.55"
		intruderIP := "203.0.113.88"

		token, err := sessMgr.IssueTokenForClient("tv/1399/1/1", clientIP, 5*time.Minute)
		if err != nil {
			t.Fatalf("failed to issue IP-bound token: %v", err)
		}

		// 1. Request from bound client IP -> 200 OK
		reqValid := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/master.m3u8?token=%s", token), nil)
		reqValid.RemoteAddr = clientIP + ":54321"
		recValid := httptest.NewRecorder()
		mux.ServeHTTP(recValid, reqValid)
		if recValid.Code != http.StatusOK {
			t.Errorf("expected 200 OK from bound IP %s, got: %d (%s)", clientIP, recValid.Code, recValid.Body.String())
		}

		// 2. Request with same token from different IP (e.g. scraped/leached link) -> 403 Forbidden
		reqIntruder := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/master.m3u8?token=%s", token), nil)
		reqIntruder.RemoteAddr = intruderIP + ":12345"
		recIntruder := httptest.NewRecorder()
		mux.ServeHTTP(recIntruder, reqIntruder)
		if recIntruder.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for intruder IP %s, got: %d", intruderIP, recIntruder.Code)
		}
		if !strings.Contains(recIntruder.Body.String(), "different client IP") {
			t.Errorf("expected error message to mention different client IP, got: %s", recIntruder.Body.String())
		}
	})

	t.Run("Anti-scraping rate limit enforcement", func(t *testing.T) {
		rateLimitedCfg := &config.Config{
			ApprovedHosts: map[string]bool{
				"127.0.0.1": true,
				"localhost": true,
			},
			TokenTTL:         10 * time.Minute,
			RateLimitEnabled: true,
			RateLimitBurst:   2,
			RateLimitRate:    1.0,
			Env:              "development",
		}

		rlGw := NewGateway(rateLimitedCfg, sessMgr, catAdapter, upstream.NewClient(rateLimitedCfg), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
		rlMux := http.NewServeMux()
		rlGw.RegisterRoutes(rlMux)

		token, _ := sessMgr.IssueToken("tv/1399/1/1", 5*time.Minute)
		ip := "192.0.2.77"

		// First 2 requests within burst should be 200 OK
		for i := 0; i < 2; i++ {
			req := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/master.m3u8?token=%s", token), nil)
			req.RemoteAddr = ip + ":1111"
			rec := httptest.NewRecorder()
			rlMux.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("request %d: expected 200 OK within burst, got %d", i+1, rec.Code)
			}
		}

		// 3rd request should be throttled with 429 Too Many Requests
		reqThrottled := httptest.NewRequest("GET", fmt.Sprintf("/hls/tv/1399/1/1/master.m3u8?token=%s", token), nil)
		reqThrottled.RemoteAddr = ip + ":1111"
		recThrottled := httptest.NewRecorder()
		rlMux.ServeHTTP(recThrottled, reqThrottled)
		if recThrottled.Code != http.StatusTooManyRequests {
			t.Fatalf("expected 429 Too Many Requests when exceeding burst, got %d", recThrottled.Code)
		}
		if retryAfter := recThrottled.Header().Get("Retry-After"); retryAfter == "" {
			t.Errorf("expected Retry-After header on 429 response")
		}
	})
}
