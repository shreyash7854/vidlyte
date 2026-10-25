package upstream

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"byse-resolver/internal/config"
)

func TestUpstreamClientSSRF(t *testing.T) {
	cfg := &config.Config{
		ApprovedHosts: map[string]bool{
			"127.0.0.1": true,
			"localhost": true,
			"img.animecurx.tech": true,
		},
		UpstreamTimeout:  2 * time.Second,
		UpstreamMaxConns: 10,
		Env:              "development",
	}

	client := NewClient(cfg)

	t.Run("Allow approved host", func(t *testing.T) {
		u, _ := url.Parse("https://img.animecurx.tech/tvshows/test/index.m3u8")
		if err := client.ValidateURL(u); err != nil {
			t.Errorf("expected approved host to pass validation, got: %v", err)
		}
	})

	t.Run("Block unapproved host (SSRF)", func(t *testing.T) {
		u, _ := url.Parse("https://attacker.com/evil.m3u8")
		err := client.ValidateURL(u)
		if !errors.Is(err, ErrHostNotAllowed) {
			t.Errorf("expected ErrHostNotAllowed, got: %v", err)
		}
	})

	t.Run("Block non-http scheme", func(t *testing.T) {
		u, _ := url.Parse("file:///etc/passwd")
		err := client.ValidateURL(u)
		if err == nil {
			t.Errorf("expected error for file scheme, got nil")
		}
	})

	t.Run("Block malicious redirect to unapproved host", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://malicious.evil.com/leak", http.StatusFound)
		}))
		defer server.Close()

		_, _, err := client.FetchManifest(context.Background(), server.URL+"/redirect", "evion")
		if !errors.Is(err, ErrHostNotAllowed) && !errors.Is(errors.Unwrap(err), ErrHostNotAllowed) {
			t.Errorf("expected redirect to unapproved host to fail with ErrHostNotAllowed, got: %v", err)
		}
	})

	t.Run("Successful manifest fetch with local mock", func(t *testing.T) {
		expectedContent := "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n"
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("User-Agent") == "" {
				t.Errorf("missing User-Agent header")
			}
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = fmt.Fprint(w, expectedContent)
		}))
		defer server.Close()

		content, finalURL, err := client.FetchManifest(context.Background(), server.URL+"/index.m3u8", "evion")
		if err != nil {
			t.Fatalf("FetchManifest failed: %v", err)
		}

		if content != expectedContent {
			t.Errorf("content mismatch: got %q, expected %q", content, expectedContent)
		}
		if finalURL == nil || finalURL.Host != server.Listener.Addr().String() {
			t.Errorf("unexpected final URL: %v", finalURL)
		}
	})

	t.Run("FetchResource Range forwarding", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Range") != "bytes=0-100" {
				t.Errorf("expected Range header 'bytes=0-100', got: %q", r.Header.Get("Range"))
			}
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write([]byte("partial-content-bytes"))
		}))
		defer server.Close()

		resp, err := client.FetchResource(context.Background(), server.URL+"/seg.ts", "evion", "bytes=0-100")
		if err != nil {
			t.Fatalf("FetchResource failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusPartialContent {
			t.Errorf("expected 206 Partial Content, got: %d", resp.StatusCode)
		}
	})
}
