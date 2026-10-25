package parser

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestExtractEmbedMetaFromCapturedFile(t *testing.T) {
	htmlData, err := os.ReadFile("d:/@1/byse-norm/page_289423.html")
	if err != nil {
		t.Skipf("page_289423.html not available: %v", err)
	}

	meta, err := ExtractEmbedMeta(htmlData)
	if err != nil {
		t.Fatalf("ExtractEmbedMeta failed: %v", err)
	}

	if meta.TMDBID != "289423" {
		t.Errorf("expected TMDBID 289423, got: %s", meta.TMDBID)
	}

	if len(meta.OrionStreams) != 8 {
		t.Errorf("expected 8 Orion streams, got: %d", len(meta.OrionStreams))
	}

	if len(meta.WarmManifests) == 0 {
		t.Errorf("expected warm manifests in payload, got 0")
	}

	// Test inflating warm manifest
	for key, raw := range meta.WarmManifests {
		if strings.HasSuffix(key, "a3.m3u8") || strings.HasSuffix(key, "v2.m3u8") {
			decompressed, err := InflateWarmManifest(raw)
			if err != nil {
				t.Fatalf("failed to inflate %s: %v", key, err)
			}
			if !strings.Contains(decompressed, "#EXTM3U") {
				t.Errorf("expected #EXTM3U header in inflated manifest, got: %s", decompressed[:50])
			}
			break
		}
	}
}

func TestParseHLSManifestEvion(t *testing.T) {
	m3u8Content, err := os.ReadFile("d:/@1/byse-norm/evion_index.m3u8")
	if err != nil {
		t.Skipf("evion_index.m3u8 not available: %v", err)
	}

	baseURL := "https://img.animecurx.tech/tvshows/ee3c2a52662960708707/index.m3u8"
	audioTracks, variants := ParseHLSManifest(string(m3u8Content), baseURL, "evion")

	if len(audioTracks) != 5 {
		t.Errorf("expected 5 audio tracks, got %d", len(audioTracks))
	}

	for _, track := range audioTracks {
		if track.Headers.Referer == "" || track.Headers.Origin == "" {
			t.Errorf("missing headers on track: %s", track.Name)
		}
		if !strings.Contains(track.ProxiedURI, "/proxy?url=") {
			t.Errorf("expected valid ProxiedURI, got: %s", track.ProxiedURI)
		}
	}

	if len(variants) != 2 {
		t.Errorf("expected 2 quality variants (1080p, 720p), got %d", len(variants))
	}
}

func TestExtractSubtitleTracksAndMediaDetails(t *testing.T) {
	htmlData, err := os.ReadFile("../../scratch/vidrift_1440098.html")
	if err != nil {
		htmlData, err = os.ReadFile("d:/@1/byse-norm/scratch/vidrift_1440098.html")
	}
	if err != nil {
		t.Skipf("scratch/vidrift_1440098.html not available: %v", err)
	}

	subtitles := ExtractSubtitleTracks(htmlData)
	if len(subtitles) != 10 {
		t.Errorf("expected 10 subtitle tracks, got %d", len(subtitles))
	}
	if len(subtitles) > 0 && (subtitles[0].Code != "en" || subtitles[0].Label != "English") {
		t.Errorf("expected first subtitle track English, got: %+v", subtitles[0])
	}

	details := ExtractMediaDetails(htmlData)
	if details.Title != "Drawn Together" {
		t.Errorf("expected Title 'Drawn Together', got: %s", details.Title)
	}
	if details.Year != "2026" {
		t.Errorf("expected Year 2026, got: %s", details.Year)
	}
	if details.Rating != "7.0" {
		t.Errorf("expected Rating 7.0, got: %s", details.Rating)
	}
	if len(details.Genres) != 2 || details.Genres[0] != "Romance" || details.Genres[1] != "Thriller" {
		t.Errorf("expected [Romance, Thriller], got: %v", details.Genres)
	}
	if !strings.Contains(details.Overview, "Marfil") {
		t.Errorf("expected overview to mention Marfil, got: %s", details.Overview)
	}
	if !strings.Contains(details.LogoURL, "AbFVWXxZ76enpA1GHCq13CN8xGu.png") {
		t.Errorf("expected valid LogoURL, got: %s", details.LogoURL)
	}
}

func BenchmarkExtractEmbedMeta(b *testing.B) {
	htmlData, err := os.ReadFile("d:/@1/byse-norm/page_289423.html")
	if err != nil {
		b.Skip("test file not available")
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = ExtractEmbedMeta(htmlData)
	}
}

func BenchmarkInflateWarmManifest(b *testing.B) {
	rawJSON := json.RawMessage(`{"gz":"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"}`)

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = InflateWarmManifest(rawJSON)
	}
}

func TestGetHeadersForProviderSubtitleSpoofing(t *testing.T) {
	// TV Subtitles
	tvHeaders := GetHeadersForProvider("orion", "https://embed.vidrift.net/api/subtitles/tv/289423/1/1/en")
	expectedTVReferer := "https://embed.vidrift.net/embed/tv/289423/1/1"
	if tvHeaders.Referer != expectedTVReferer {
		t.Errorf("expected TV subtitle referer %q, got %q", expectedTVReferer, tvHeaders.Referer)
	}
	if tvHeaders.Origin != "https://embed.vidrift.net" {
		t.Errorf("expected origin https://embed.vidrift.net, got %q", tvHeaders.Origin)
	}

	// Movie Subtitles
	movieHeaders := GetHeadersForProvider("orion", "https://embed.vidrift.net/api/subtitles/movie/550/en")
	expectedMovieReferer := "https://embed.vidrift.net/embed/movie/550"
	if movieHeaders.Referer != expectedMovieReferer {
		t.Errorf("expected Movie subtitle referer %q, got %q", expectedMovieReferer, movieHeaders.Referer)
	}

	// Direct embed referer path
	embedHeaders := GetHeadersForProvider("orion", "/embed/tv/289423/1/1")
	if embedHeaders.Referer != expectedTVReferer {
		t.Errorf("expected embed referer %q, got %q", expectedTVReferer, embedHeaders.Referer)
	}
}
