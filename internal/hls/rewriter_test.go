package hls

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

func TestHLSRewriter(t *testing.T) {
	rw := NewRewriter()
	assetID := "tv/1399/1/1"
	token := "valid-hmac-token"

	// Mock registry mapping
	registry := make(map[string]string)
	counter := 0
	register := func(aID, upstreamURI string) string {
		counter++
		resID := "res" + string(rune('0'+counter))
		registry[resID] = upstreamURI
		return resID
	}

	t.Run("Rewrite Master Playlist with Audio and Stream Inf", func(t *testing.T) {
		masterContent := `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English",DEFAULT=YES,URI="audio/eng.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hin",NAME="Hindi",DEFAULT=NO,URI="https://cdn.example.com/audio/hin.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080,AUDIO="audio"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720,AUDIO="audio"
720p/index.m3u8
`
		playlistURL, _ := url.Parse("https://origin.example.com/streams/live/master.m3u8")

		rewritten, err := rw.RewritePlaylist(masterContent, playlistURL, assetID, token, register)
		if err != nil {
			t.Fatalf("RewritePlaylist failed: %v", err)
		}

		// Verify header intact
		if !strings.HasPrefix(rewritten, "#EXTM3U") {
			t.Errorf("missing #EXTM3U header")
		}

		// Verify relative audio URI was resolved and rewritten
		if !strings.Contains(rewritten, `URI="/hls/tv/1399/1/1/resource/res1?token=valid-hmac-token"`) {
			t.Errorf("audio/eng.m3u8 not rewritten properly: %s", rewritten)
		}
		if registry["res1"] != "https://origin.example.com/streams/live/audio/eng.m3u8" {
			t.Errorf("res1 mapping mismatch: %s", registry["res1"])
		}

		// Verify absolute audio URI was resolved and rewritten
		if !strings.Contains(rewritten, `URI="/hls/tv/1399/1/1/resource/res2?token=valid-hmac-token"`) {
			t.Errorf("hin.m3u8 not rewritten properly: %s", rewritten)
		}
		if registry["res2"] != "https://cdn.example.com/audio/hin.m3u8" {
			t.Errorf("res2 mapping mismatch: %s", registry["res2"])
		}

		// Verify 1080p stream line rewritten
		if !strings.Contains(rewritten, "/hls/tv/1399/1/1/resource/res3?token=valid-hmac-token") {
			t.Errorf("1080p stream line not rewritten properly: %s", rewritten)
		}
		if registry["res3"] != "https://origin.example.com/streams/live/1080p/index.m3u8" {
			t.Errorf("res3 mapping mismatch: %s", registry["res3"])
		}
	})

	t.Run("Rewrite Media Playlist with EXT-X-MAP and segments", func(t *testing.T) {
		mediaContent := `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:6.000,
#EXT-X-BYTERANGE:1500000@720
segment0.mp4
#EXTINF:6.000,
segment1.mp4
#EXT-X-ENDLIST
`
		playlistURL, _ := url.Parse("https://origin.example.com/streams/live/1080p/index.m3u8")

		rewritten, err := rw.RewritePlaylist(mediaContent, playlistURL, assetID, token, register)
		if err != nil {
			t.Fatalf("RewritePlaylist failed: %v", err)
		}

		// Check EXT-X-MAP URI rewritten while BYTERANGE preserved
		if !strings.Contains(rewritten, `#EXT-X-MAP:URI="/hls/tv/1399/1/1/resource/res5?token=valid-hmac-token",BYTERANGE="720@0"`) {
			t.Errorf("EXT-X-MAP not rewritten properly: %s", rewritten)
		}
		if registry["res5"] != "https://origin.example.com/streams/live/1080p/init.mp4" {
			t.Errorf("res5 mapping mismatch: %s", registry["res5"])
		}

		// Check BYTERANGE tag preserved untouched
		if !strings.Contains(rewritten, "#EXT-X-BYTERANGE:1500000@720") {
			t.Errorf("#EXT-X-BYTERANGE was corrupted: %s", rewritten)
		}

		// Check segments rewritten
		if !strings.Contains(rewritten, "/hls/tv/1399/1/1/resource/res6?token=valid-hmac-token") {
			t.Errorf("segment0.mp4 not rewritten properly: %s", rewritten)
		}
	})

	t.Run("Reject non-HLS content", func(t *testing.T) {
		_, err := rw.RewritePlaylist("<html>Not HLS</html>", nil, assetID, token, register)
		if !errors.Is(err, ErrNotHLS) {
			t.Errorf("expected ErrNotHLS, got: %v", err)
		}
	})

	t.Run("Rewrite Media Playlist with Edge Swarm Router", func(t *testing.T) {
		mediaContent := `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
chunk_001.ts
#EXTINF:6.0,
chunk_002.ts
`
		playlistURL, _ := url.Parse("https://origin.example.com/streams/live/chunklist.m3u8")

		router := func(aID, uURI string) string {
			return "https://alpha-lytenode.jadiel35.workers.dev/?url=" + uURI
		}

		rewritten, err := rw.RewritePlaylistWithRouter(mediaContent, playlistURL, assetID, token, register, router)
		if err != nil {
			t.Fatalf("RewritePlaylistWithRouter failed: %v", err)
		}

		if !strings.Contains(rewritten, "https://alpha-lytenode.jadiel35.workers.dev/?url=https://origin.example.com/streams/live/chunk_001.ts") {
			t.Errorf("expected edge worker chunk URL in rewritten playlist, got:\n%s", rewritten)
		}
		if !strings.Contains(rewritten, "https://alpha-lytenode.jadiel35.workers.dev/?url=https://origin.example.com/streams/live/chunk_002.ts") {
			t.Errorf("expected second edge worker chunk URL in rewritten playlist, got:\n%s", rewritten)
		}
	})
}

