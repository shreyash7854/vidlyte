package service

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"byse-resolver/internal/cache"
	"byse-resolver/internal/models"
)

func TestAsianFlixResolver(t *testing.T) {
	// Mock Blogger server
	bloggerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/feeds/") {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{
			"entry": {
				"title": { "$t": "Make Me Tingle (2026)" },
				"content": {
					"$t": "https://rumble.com/hls-vod/SK_7cf5v5ik/playlist.m3u8|English|https://res.cloudinary.com/dqgj8n990/raw/upload/v1792121278/Make_Me_Tingle_2026_Ep1_emjgsr.vtt;https://rumble.com/hls-vod/qV775QOZDEQ/playlist.m3u8|English|https://res.cloudinary.com/dqgj8n990/raw/upload/v1792121278/Make_Me_Tingle_2026_Ep2_sau3tc.vtt;https://rumble.com/hls-vod/wgVCTl8V34g/playlist.m3u8|English|https://res.cloudinary.com/dqgj8n990/raw/upload/v1792121278/Make_Me_Tingle_2026_Ep3_awjogk.vtt;<img src=\"https://0.soompi.io/wp-content/uploads/2026/10/14205638/make-me-tingle-3_6f8a76.jpeg\"/>"
				}
			}
		}`)
	}))
	defer bloggerServer.Close()

	// Mock AsianFlix server
	asianflixServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=UTF-8")
		fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
	<script id="playlist-js-before">
	const videoPlayerSettings = {"license":"test","playerContainer":"asianflix-one","bloggerAPI":{"blogId":["3471199336054538080","530765432562051036","3941195089360643692"]}};
	</script>
</head>
<body>
	<div id="asianflix-one" data-post-id="8494126467716259839" data-cc-icon="true" data-server-index="3"></div>
</body>
</html>`)
	}))
	defer asianflixServer.Close()

	memCache := cache.NewMemoryCache(10*time.Minute, 1*time.Minute)
	resolver := NewResolverService(memCache)

	// Custom transport redirecting live hosts to test servers
	resolver.httpClient.Transport = &mockTransport{
		asianflixURL: asianflixServer.URL,
		bloggerURL:   bloggerServer.URL,
		original:     http.DefaultTransport,
	}

	t.Run("Resolve AsianFlix Episode 2", func(t *testing.T) {
		resp, err := resolver.Resolve(context.Background(), models.MediaRequest{
			Type:    "tv",
			ID:      "asianflix:make-me-tingle-2026",
			Season:  1,
			Episode: 2,
		})
		if err != nil {
			t.Fatalf("unexpected error resolving AsianFlix: %v", err)
		}

		expectedManifest := "https://rumble.com/hls-vod/qV775QOZDEQ/playlist.m3u8"
		if resp.PrimaryManifest != expectedManifest {
			t.Errorf("expected PrimaryManifest %q, got %q", expectedManifest, resp.PrimaryManifest)
		}

		if len(resp.Subtitles) == 0 {
			t.Fatalf("expected subtitles for episode 2, got 0")
		}

		expectedSub := "https://res.cloudinary.com/dqgj8n990/raw/upload/v1792121278/Make_Me_Tingle_2026_Ep2_sau3tc.vtt"
		if resp.Subtitles[0].URI != expectedSub {
			t.Errorf("expected subtitle URI %q, got %q", expectedSub, resp.Subtitles[0].URI)
		}

		if resp.Subtitles[0].Label != "English" {
			t.Errorf("expected subtitle label 'English', got %q", resp.Subtitles[0].Label)
		}

		// Verify Provider rule
		if rule, ok := resp.ProxyRules["rumble"]; !ok || !rule.AllowedDirect {
			t.Errorf("expected open direct rule for rumble")
		}
	})

	t.Run("Resolve AsianFlix Episode 1", func(t *testing.T) {
		resp, err := resolver.Resolve(context.Background(), models.MediaRequest{
			Type:    "tv",
			ID:      "make-me-tingle-2026",
			Season:  1,
			Episode: 1,
		})
		if err != nil {
			t.Fatalf("unexpected error resolving episode 1: %v", err)
		}

		expectedManifest := "https://rumble.com/hls-vod/SK_7cf5v5ik/playlist.m3u8"
		if resp.PrimaryManifest != expectedManifest {
			t.Errorf("expected PrimaryManifest %q, got %q", expectedManifest, resp.PrimaryManifest)
		}
	})
}

type mockTransport struct {
	asianflixURL string
	bloggerURL   string
	original     http.RoundTripper
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	cloned := req.Clone(req.Context())
	if strings.Contains(req.URL.Host, "asianflix.one") {
		cloned.URL.Scheme = "http"
		cloned.URL.Host = strings.TrimPrefix(m.asianflixURL, "http://")
		return m.original.RoundTrip(cloned)
	}
	if strings.Contains(req.URL.Host, "blogger.com") {
		cloned.URL.Scheme = "http"
		cloned.URL.Host = strings.TrimPrefix(m.bloggerURL, "http://")
		return m.original.RoundTrip(cloned)
	}
	return m.original.RoundTrip(req)
}
