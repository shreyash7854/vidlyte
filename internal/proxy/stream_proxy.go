package proxy

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"byse-resolver/internal/parser"
)

var (
	chunkBufferPool = sync.Pool{
		New: func() any {
			b := make([]byte, 32*1024) // 32 KB high-throughput streaming buffer
			return &b
		},
	}

	transport = &http.Transport{
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 50,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true, // Don't decode gzip so we stream raw bytes directly
	}

	proxyClient = &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}
)

// StreamProxy handles high-speed video chunk and manifest proxying with header injection
type StreamProxy struct{}

// NewStreamProxy initializes a StreamProxy instance
func NewStreamProxy() *StreamProxy {
	return &StreamProxy{}
}

// ServeHTTP handles the /proxy endpoint
func (p *StreamProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Handle preflight CORS requests immediately
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		http.Error(w, `{"error":"missing required query parameter: url"}`, http.StatusBadRequest)
		return
	}

	targetURL, err := url.Parse(rawURL)
	if err != nil || (targetURL.Scheme != "http" && targetURL.Scheme != "https") {
		http.Error(w, `{"error":"invalid target url: must be valid http/https"}`, http.StatusBadRequest)
		return
	}

	provider := r.URL.Query().Get("provider")
	if provider == "" {
		provider = "evion"
	}

	// 100% Secure M3U8 Protection: Verify HMAC stream token if signature is provided
	sig := r.URL.Query().Get("sig")
	if sig == "" {
		sig = r.URL.Query().Get("token")
	}
	expStr := r.URL.Query().Get("exp")
	if sig != "" && expStr != "" {
		if !VerifyStreamToken(rawURL, sig, expStr) {
			http.Error(w, `{"error":"forbidden: stream signature token is invalid or expired"}`, http.StatusForbidden)
			return
		}
	}

	// Prepare upstream request
	upstreamReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL.String(), nil)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to create upstream request: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	// Inject mandatory spoofing headers with dynamic domain resilience
	headers := parser.GetHeadersForProvider(provider, targetURL.String())
	upstreamReq.Header.Set("User-Agent", headers.UserAgent)
	upstreamReq.Header.Set("Origin", headers.Origin)
	upstreamReq.Header.Set("Referer", headers.Referer)
	upstreamReq.Header.Set("Accept", "*/*")

	// Forward client Range header for video seeking
	if clientRange := r.Header.Get("Range"); clientRange != "" {
		upstreamReq.Header.Set("Range", clientRange)
	}

	// Execute upstream fetch
	resp, err := proxyClient.Do(upstreamReq)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"upstream fetch failed: %s"}`, err.Error()), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Inject CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type")

	// Forward upstream headers
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		w.Header().Set("Content-Range", cr)
	}
	if ar := resp.Header.Get("Accept-Ranges"); ar != "" {
		w.Header().Set("Accept-Ranges", ar)
	}

	// Check if this is an M3U8 manifest requiring URL rewriting
	contentType := resp.Header.Get("Content-Type")
	isM3U8 := strings.Contains(contentType, "mpegurl") || strings.HasSuffix(targetURL.Path, ".m3u8")

	if isM3U8 && resp.StatusCode == http.StatusOK {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.WriteHeader(resp.StatusCode)
		p.rewriteAndStreamM3U8(w, resp.Body, targetURL, provider)
		return
	}

	// Standard media chunk streaming (e.g. .ts, .m4s, .mp4, subtitles)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	w.WriteHeader(resp.StatusCode)

	bufPtr := chunkBufferPool.Get().(*[]byte)
	defer chunkBufferPool.Put(bufPtr)

	_, _ = io.CopyBuffer(w, resp.Body, *bufPtr)
}

// rewriteAndStreamM3U8 rewrites URI tags and chunk lines so relative files route through /proxy
func (p *StreamProxy) rewriteAndStreamM3U8(w http.ResponseWriter, r io.Reader, baseURL *url.URL, provider string) {
	scanner := bufio.NewScanner(r)
	baseDir := baseURL.Scheme + "://" + baseURL.Host + path.Dir(baseURL.Path) + "/"

	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

		if (strings.HasPrefix(trimmed, "#EXT-X-MEDIA:") || strings.HasPrefix(trimmed, "#EXT-X-MAP:") || strings.HasPrefix(trimmed, "#EXT-X-KEY:")) && strings.Contains(trimmed, "URI=\"") {
			// Rewrite URI in EXT-X-MEDIA, EXT-X-MAP, and EXT-X-KEY
			line = p.rewriteTagURI(trimmed, baseDir, provider)
		} else if strings.HasPrefix(trimmed, "#") || trimmed == "" {
			// Passthrough comments and metadata tags
		} else {
			// This is a stream rung or chunk URL
			fullURL := resolveToFullURL(baseDir, trimmed)
			line = SignProxyURL("/proxy", fullURL, provider)
		}

		_, _ = fmt.Fprintln(w, line)
	}
}

func (p *StreamProxy) rewriteTagURI(line, baseDir, provider string) string {
	parts := strings.Split(line, "URI=\"")
	if len(parts) < 2 {
		return line
	}
	subParts := strings.SplitN(parts[1], "\"", 2)
	if len(subParts) < 2 {
		return line
	}

	originalURI := subParts[0]
	fullURI := resolveToFullURL(baseDir, originalURI)
	proxied := SignProxyURL("/proxy", fullURI, provider)

	return parts[0] + "URI=\"" + proxied + "\"" + subParts[1]
}

func resolveToFullURL(baseDir, target string) string {
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		return target
	}
	u, err := url.Parse(baseDir)
	if err != nil {
		return target
	}
	ref, err := url.Parse(target)
	if err != nil {
		return target
	}
	return u.ResolveReference(ref).String()
}
