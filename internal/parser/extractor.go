package parser

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"byse-resolver/internal/models"
)

var (
	gzipReaderPool = sync.Pool{
		New: func() any {
			return new(gzip.Reader)
		},
	}
	audioTagRegex = regexp.MustCompile(`#EXT-X-MEDIA:TYPE=AUDIO.*?(?:LANGUAGE="([^"]*)")?.*?(?:NAME="([^"]*)")?.*?(?:DEFAULT=(YES|NO))?.*?(?:URI="([^"]*)")`)
	streamInfRegex = regexp.MustCompile(`#EXT-X-STREAM-INF:(.*?)\n([^\r\n]+)`)
	bandwidthRegex = regexp.MustCompile(`BANDWIDTH=(\d+)`)
	resolutionRegex = regexp.MustCompile(`RESOLUTION=(\d+x\d+)`)
	codecsRegex = regexp.MustCompile(`CODECS="([^"]*)"`)

	titleRegex    = regexp.MustCompile(`class="(?:pause-title-text|title-main)">([^<]+)<`)
	logoRegex     = regexp.MustCompile(`class="pause-logo"[^>]+(?:data-src|src)="([^"]+)"`)
	kickerRegex   = regexp.MustCompile(`class="pause-kicker"><span>Paused</span>\s*([^<]+)</div>`)
	metaRegex     = regexp.MustCompile(`class="pause-meta">(.*?)</div>`)
	spanRegex     = regexp.MustCompile(`<span>(?:<b>★\s*)?([^<]+?)(?:</b>)?</span>`)
	overviewRegex = regexp.MustCompile(`class="pause-overview">([^<]+)</p>`)
)

const (
	BrowserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	VidriftBaseURL   = "https://embed.vidrift.net"
)

// RawSubtitleTrack represents an inlined subtitle track from Vidrift HTML
type RawSubtitleTrack struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Lang  string `json:"lang"`
	URL   string `json:"url"`
}

// MediaDetails contains parsed presentation metadata from upstream HTML
type MediaDetails struct {
	Title    string   `json:"title"`
	Kicker   string   `json:"kicker"`
	LogoURL  string   `json:"logo_url"`
	Year     string   `json:"year"`
	Rating   string   `json:"rating"`
	Genres   []string `json:"genres"`
	Overview string   `json:"overview"`
}

// RawOrionRung defines quality levels in embedMeta
type RawOrionRung struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// RawOrionStream defines stream objects in embedMeta.orionStreams
type RawOrionStream struct {
	Index           int            `json:"index"`
	URL             string         `json:"url"`
	Type            string         `json:"type"`
	Provider        string         `json:"provider"`
	Name            string         `json:"name"`
	Direct          bool           `json:"direct"`
	Rungs           []RawOrionRung `json:"rungs"`
	SubtitleListURL string         `json:"subtitleListUrl"`
}

// RawEmbedMeta represents the parsed inlined JSON payload from the HTML
type RawEmbedMeta struct {
	TMDBID         string                    `json:"tmdbId"`
	Type           string                    `json:"type"`
	Season         int                       `json:"season"`
	Episode        int                       `json:"episode"`
	PlaybackToken  string                    `json:"playbackToken"`
	EvionURL       string                    `json:"evionUrl"`
	VexonURL       string                    `json:"vexonUrl"`
	OrionStreams   []RawOrionStream          `json:"orionStreams"`
	WarmManifests  map[string]json.RawMessage `json:"warmManifests"`
}

// ExtractEmbedMeta performs zero-copy slice scanning to extract and parse embedMeta
func ExtractEmbedMeta(html []byte) (*RawEmbedMeta, error) {
	key := []byte("var embedMeta =")
	idx := bytes.Index(html, key)
	if idx == -1 {
		key = []byte("embedMeta =")
		idx = bytes.Index(html, key)
		if idx == -1 {
			return nil, errors.New("embedMeta payload not found in document")
		}
	}

	start := idx + len(key)
	for start < len(html) && (html[start] == ' ' || html[start] == '\t' || html[start] == '\r' || html[start] == '\n') {
		start++
	}

	if start >= len(html) || html[start] != '{' {
		return nil, errors.New("malformed embedMeta: opening brace not found")
	}

	// Balance braces to find valid JSON boundary
	depth := 0
	inString := false
	escape := false
	end := -1

	for i := start; i < len(html); i++ {
		b := html[i]
		if inString {
			if escape {
				escape = false
			} else if b == '\\' {
				escape = true
			} else if b == '"' {
				inString = false
			}
			continue
		}

		if b == '"' {
			inString = true
			continue
		}

		if b == '{' {
			depth++
		} else if b == '}' {
			depth--
			if depth == 0 {
				end = i + 1
				break
			}
		}
	}

	if end == -1 {
		return nil, errors.New("unbalanced braces while extracting embedMeta")
	}

	jsonBytes := html[start:end]
	var meta RawEmbedMeta
	if err := json.Unmarshal(jsonBytes, &meta); err != nil {
		return nil, fmt.Errorf("failed to unmarshal embedMeta: %w", err)
	}

	return &meta, nil
}

// ExtractSubtitleTracks parses the var subtitleTracks = [...] array from HTML
func ExtractSubtitleTracks(html []byte) []RawSubtitleTrack {
	key := []byte("var subtitleTracks =")
	idx := bytes.Index(html, key)
	if idx == -1 {
		key = []byte("subtitleTracks =")
		idx = bytes.Index(html, key)
		if idx == -1 {
			return nil
		}
	}

	start := idx + len(key)
	for start < len(html) && (html[start] == ' ' || html[start] == '\t' || html[start] == '\r' || html[start] == '\n') {
		start++
	}

	if start >= len(html) || html[start] != '[' {
		return nil
	}

	depth := 0
	inString := false
	escape := false
	end := -1

	for i := start; i < len(html); i++ {
		b := html[i]
		if inString {
			if escape {
				escape = false
			} else if b == '\\' {
				escape = true
			} else if b == '"' {
				inString = false
			}
			continue
		}

		if b == '"' {
			inString = true
			continue
		}

		if b == '[' {
			depth++
		} else if b == ']' {
			depth--
			if depth == 0 {
				end = i + 1
				break
			}
		}
	}

	if end == -1 {
		return nil
	}

	var tracks []RawSubtitleTrack
	if err := json.Unmarshal(html[start:end], &tracks); err != nil {
		return nil
	}
	return tracks
}

// ExtractMediaDetails parses presentation details from Vidrift pause-card and title elements
func ExtractMediaDetails(html []byte) MediaDetails {
	var details MediaDetails

	if m := titleRegex.FindSubmatch(html); len(m) > 1 {
		t := strings.TrimSpace(string(m[1]))
		if !strings.HasPrefix(strings.ToLower(t), "preparing") {
			details.Title = t
		}
	}

	if m := logoRegex.FindSubmatch(html); len(m) > 1 {
		details.LogoURL = strings.TrimSpace(string(m[1]))
	}

	if m := kickerRegex.FindSubmatch(html); len(m) > 1 {
		details.Kicker = strings.TrimSpace(string(m[1]))
	}

	if m := overviewRegex.FindSubmatch(html); len(m) > 1 {
		details.Overview = strings.TrimSpace(string(m[1]))
	}

	if m := metaRegex.FindSubmatch(html); len(m) > 1 {
		spans := spanRegex.FindAllSubmatch(m[1], -1)
		for _, sp := range spans {
			if len(sp) > 1 {
				val := strings.TrimSpace(string(sp[1]))
				if len(val) == 4 && (strings.HasPrefix(val, "19") || strings.HasPrefix(val, "20")) {
					details.Year = val
				} else if strings.Contains(string(sp[0]), "★") || strings.HasPrefix(val, "★") {
					details.Rating = strings.TrimSpace(strings.TrimPrefix(val, "★"))
				} else if val != "" {
					details.Genres = append(details.Genres, val)
				}
			}
		}
	}

	return details
}

// InflateWarmManifest decompresses a base64-gzipped manifest if necessary
func InflateWarmManifest(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}

	// Case 1: Plain string JSON
	if raw[0] == '"' {
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return "", err
		}
		return str, nil
	}

	// Case 2: {"gz": "base64..."}
	var gzObj struct {
		GZ string `json:"gz"`
	}
	if err := json.Unmarshal(raw, &gzObj); err != nil {
		return "", err
	}

	if gzObj.GZ == "" {
		return "", errors.New("empty gz field in warm manifest")
	}

	compressed, err := base64.StdEncoding.DecodeString(gzObj.GZ)
	if err != nil {
		return "", fmt.Errorf("base64 decode failed: %w", err)
	}

	zr := gzipReaderPool.Get().(*gzip.Reader)
	if err := zr.Reset(bytes.NewReader(compressed)); err != nil {
		gzipReaderPool.Put(zr)
		return "", fmt.Errorf("gzip reset failed: %w", err)
	}
	defer gzipReaderPool.Put(zr)

	decompressed, err := io.ReadAll(zr)
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("gzip inflation failed: %w", err)
	}

	return string(decompressed), nil
}

// ParseHLSManifest extracts audio tracks and video variants from an M3U8 string
func ParseHLSManifest(manifest string, baseURL string, provider string) ([]models.AudioTrack, []models.StreamVariant) {
	var audioTracks []models.AudioTrack
	var variants []models.StreamVariant

	// Extract Audio tracks
	audioMatches := audioTagRegex.FindAllStringSubmatch(manifest, -1)
	for _, m := range audioMatches {
		lang := ""
		name := ""
		isDefault := false
		uri := ""

		for _, sub := range strings.Split(m[0], ",") {
			sub = strings.TrimSpace(sub)
			if strings.HasPrefix(sub, "LANGUAGE=") {
				lang = strings.Trim(strings.TrimPrefix(sub, "LANGUAGE="), "\"")
			} else if strings.HasPrefix(sub, "NAME=") {
				name = strings.Trim(strings.TrimPrefix(sub, "NAME="), "\"")
			} else if strings.HasPrefix(sub, "DEFAULT=") {
				isDefault = strings.EqualFold(strings.Trim(strings.TrimPrefix(sub, "DEFAULT="), "\""), "YES")
			} else if strings.HasPrefix(sub, "URI=") {
				uri = strings.Trim(strings.TrimPrefix(sub, "URI="), "\"")
			}
		}

		if uri != "" {
			fullURI := resolveURI(baseURL, uri)
			audioTracks = append(audioTracks, models.AudioTrack{
				Language:      lang,
				Name:          name,
				Default:       isDefault,
				URI:           fullURI,
				ProxiedURI:    BuildProxyURL(fullURI, provider),
				Provider:      provider,
				Domain:        ExtractDomain(fullURI),
				RequiresProxy: provider == "orion",
				Headers:       GetHeadersForProvider(provider, ""),
			})
		}
	}

	// Extract Stream variants (rungs)
	infMatches := streamInfRegex.FindAllStringSubmatch(manifest, -1)
	for _, m := range infMatches {
		infHeader := m[1]
		rungURI := strings.TrimSpace(m[2])

		bw := 0
		if bwMatch := bandwidthRegex.FindStringSubmatch(infHeader); len(bwMatch) > 1 {
			bw, _ = strconv.Atoi(bwMatch[1])
		}

		res := "unknown"
		if resMatch := resolutionRegex.FindStringSubmatch(infHeader); len(resMatch) > 1 {
			res = resMatch[1]
		}

		codecs := ""
		if codecsMatch := codecsRegex.FindStringSubmatch(infHeader); len(codecsMatch) > 1 {
			codecs = codecsMatch[1]
		}

		fullURI := resolveURI(baseURL, rungURI)
		variants = append(variants, models.StreamVariant{
			Resolution:    res,
			Bandwidth:     bw,
			Codecs:        codecs,
			PlaylistURI:   fullURI,
			ProxiedURI:    BuildProxyURL(fullURI, provider),
			Provider:      provider,
			Domain:        ExtractDomain(fullURI),
			RequiresProxy: provider == "orion",
			Headers:       GetHeadersForProvider(provider, ""),
		})
	}

	return audioTracks, variants
}

// GetHeadersForProvider supplies the exact HTTP headers for each provider with dynamic domain resilience
func GetHeadersForProvider(provider, targetURLOrPath string) models.HTTPHeaders {
	origin := VidriftBaseURL
	referer := VidriftBaseURL + "/"

	if strings.HasPrefix(targetURLOrPath, "http://") || strings.HasPrefix(targetURLOrPath, "https://") {
		if u, err := url.Parse(targetURLOrPath); err == nil && u.Hostname() != "" {
			host := strings.ToLower(u.Hostname())
			switch {
			case strings.Contains(host, "vidrift."):
				parts := strings.Split(host, ".")
				if len(parts) >= 2 {
					base := strings.Join(parts[len(parts)-2:], ".")
					origin = "https://embed." + base
					referer = "https://embed." + base + "/"
				} else {
					origin = "https://" + host
					referer = "https://" + host + "/"
				}
			case strings.Contains(host, "framextv."):
				origin = "https://framextv.cc"
				referer = "https://framextv.cc/"
			case strings.Contains(host, "cinejoy.") || strings.Contains(host, "wing.st"):
				origin = "https://cinejoy.pk"
				referer = "https://cinejoy.pk/"
			case strings.Contains(host, "rumble.") || strings.Contains(host, "asianflix.") || strings.Contains(host, "cloudinary.") || strings.Contains(host, "blogger."):
				origin = "https://asianflix.one"
				referer = "https://asianflix.one/"
			case strings.Contains(host, "animecurx.") || strings.Contains(host, "hakunaymatata.") || strings.Contains(host, "reelvault."):
				origin = "https://embed.vidrift.net"
				referer = "https://embed.vidrift.net/"
			default:
				origin = u.Scheme + "://" + u.Host
				referer = u.Scheme + "://" + u.Host + "/"
			}
		}
	} else if strings.EqualFold(provider, "framextv") {
		origin = "https://framextv.cc"
		referer = "https://framextv.cc/"
	} else if strings.EqualFold(provider, "rumble") || strings.EqualFold(provider, "asianflix") {
		origin = "https://asianflix.one"
		referer = "https://asianflix.one/"
	} else if targetURLOrPath != "" {
		if strings.HasPrefix(targetURLOrPath, "http://") || strings.HasPrefix(targetURLOrPath, "https://") {
			referer = targetURLOrPath
		} else {
			referer = VidriftBaseURL + targetURLOrPath
		}
	}

	// Auto-detect and forge accurate referer for subtitle API requests
	if idx := strings.Index(targetURLOrPath, "/subtitles/"); idx != -1 {
		subPath := targetURLOrPath[idx+len("/subtitles/"):]
		parts := strings.Split(strings.Trim(subPath, "/"), "/")
		if len(parts) >= 2 {
			if parts[0] == "movie" {
				origin = "https://embed.vidrift.net"
				referer = fmt.Sprintf("https://embed.vidrift.net/embed/movie/%s", parts[1])
			} else if parts[0] == "tv" && len(parts) >= 4 {
				origin = "https://embed.vidrift.net"
				referer = fmt.Sprintf("https://embed.vidrift.net/embed/tv/%s/%s/%s", parts[1], parts[2], parts[3])
			}
		}
	} else if strings.Contains(targetURLOrPath, "/embed/") {
		origin = "https://embed.vidrift.net"
		if strings.HasPrefix(targetURLOrPath, "/embed/") {
			referer = "https://embed.vidrift.net" + targetURLOrPath
		}
	}

	pLower := strings.ToLower(provider)
	if pLower == "orion" || pLower == "vela" || pLower == "atlas" || pLower == "titan" || pLower == "lyra" {
		origin = "https://embed.vidrift.net"
		if referer == "" || referer == VidriftBaseURL+"/" {
			referer = "https://embed.vidrift.net/"
		}
	}

	return models.HTTPHeaders{
		Referer:   referer,
		Origin:    origin,
		UserAgent: BrowserUserAgent,
	}
}

// BuildProxyURL generates a safe, URI-encoded proxy path
func BuildProxyURL(rawURL, provider string) string {
	if rawURL == "" {
		return ""
	}
	return fmt.Sprintf("/proxy?url=%s&provider=%s", url.QueryEscape(rawURL), provider)
}

// ExtractDomain parses the host from a URL
func ExtractDomain(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "embed.vidrift.net"
	}
	return u.Host
}

func resolveURI(base, ref string) string {
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return ref
	}
	refURL, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return baseURL.ResolveReference(refURL).String()
}
