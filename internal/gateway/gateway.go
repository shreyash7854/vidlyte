package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"byse-resolver/internal/catalog"
	"byse-resolver/internal/config"
	"byse-resolver/internal/delivery"
	"byse-resolver/internal/diskcache"
	"byse-resolver/internal/hls"
	"byse-resolver/internal/limiter"
	"byse-resolver/internal/observability"
	"byse-resolver/internal/proxy"
	"byse-resolver/internal/session"
	"byse-resolver/internal/upstream"
)

// PlaybackSessionRequest represents the payload for POST /v1/playback-sessions.
type PlaybackSessionRequest struct {
	AssetID string `json:"asset_id"` // e.g. "tv/1399/1/1" or "movie/550"
	TTLSec  int    `json:"ttl_seconds,omitempty"`
}

// PlaybackSessionResponse represents the response containing the signed gateway URL.
type PlaybackSessionResponse struct {
	AssetID     string    `json:"asset_id"`
	PlaylistURL string    `json:"playlist_url"`
	StreamURL   string    `json:"stream_url,omitempty"`
	MediaType   string    `json:"media_type"`
	Token       string    `json:"token"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type uncachedPayload struct {
	statusCode int
	header     http.Header
	body       []byte
}

// Gateway coordinates session verification, catalog resolution, HLS rewriting, upstream fetching, and streaming delivery.
type Gateway struct {
	cfg       *config.Config
	session   *session.Manager
	catalog   *catalog.Adapter
	upstream  *upstream.Client
	rewriter  *hls.Rewriter
	cache     *diskcache.DiskCache
	limiter   *limiter.RateLimiter
	logger    *slog.Logger
	swarm     *proxy.SwarmBalancer
	startTime time.Time
}

// NewGateway creates and initializes a Gateway instance.
func NewGateway(cfg *config.Config, sess *session.Manager, cat *catalog.Adapter, up *upstream.Client, cache *diskcache.DiskCache, logger *slog.Logger) *Gateway {
	var rl *limiter.RateLimiter
	if cfg.RateLimitEnabled {
		rl = limiter.NewRateLimiter(cfg.RateLimitRate, cfg.RateLimitBurst, 5*time.Minute)
	}

	return &Gateway{
		cfg:       cfg,
		session:   sess,
		catalog:   cat,
		upstream:  up,
		rewriter:  hls.NewRewriter(),
		cache:     cache,
		limiter:   rl,
		logger:    logger,
		startTime: time.Now(),
	}
}

// SetSwarmBalancer binds the proxy swarm balancer for edge chunk routing.
func (gw *Gateway) SetSwarmBalancer(s *proxy.SwarmBalancer) {
	gw.swarm = s
}

// RegisterRoutes registers baseline gateway routes and dispatchers onto the mux.
func (gw *Gateway) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/playback-sessions", gw.HandleCreateSession)
	mux.HandleFunc("GET /hls/", gw.HandleHLSDispatch)
	mux.HandleFunc("GET /healthz", observability.HealthzHandler)
	mux.HandleFunc("GET /readyz", observability.ReadyzHandler)
	mux.HandleFunc("GET /metrics", observability.MetricsHandler)

	// Owner Control & Monitoring endpoints
	mux.HandleFunc("GET /v1/owner/overview", gw.HandleOwnerOverview)
	mux.HandleFunc("POST /v1/owner/whitelist", gw.HandleOwnerWhitelist)
	mux.HandleFunc("POST /v1/owner/settings", gw.HandleOwnerSettings)
	mux.HandleFunc("POST /v1/owner/cache/purge", gw.HandleOwnerCachePurge)
	mux.HandleFunc("GET /v1/owner/probe", gw.HandleOwnerProbe)
}

// HandleCreateSession issues a short-lived, signed playback session for an authorized asset.
func (gw *Gateway) HandleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req PlaybackSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		gw.writeError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	assetID := strings.Trim(req.AssetID, "/")
	if assetID == "" {
		gw.writeError(w, http.StatusBadRequest, "asset_id is required")
		return
	}

	// Verify asset can be resolved through catalog
	info, err := gw.catalog.ResolveAsset(r.Context(), assetID)
	if err != nil {
		gw.writeError(w, http.StatusNotFound, "unauthorized or unresolved asset")
		return
	}

	ttl := gw.cfg.TokenTTL
	if req.TTLSec > 0 && req.TTLSec <= int(gw.cfg.TokenTTL.Seconds()) {
		ttl = time.Duration(req.TTLSec) * time.Second
	}

	clientIP := session.ExtractClientIP(r)
	var token string
	if gw.cfg.BindClientIP {
		token, err = gw.session.IssueTokenForClient(assetID, clientIP, ttl)
	} else {
		token, err = gw.session.IssueToken(assetID, ttl)
	}
	if err != nil {
		gw.logger.Error("failed to issue session token", "error", err)
		gw.writeError(w, http.StatusInternalServerError, "failed to generate playback session")
		return
	}

	playlistURL := fmt.Sprintf("/hls/%s/master.m3u8?token=%s", assetID, token)
	mediaType := "hls"
	var streamURL string
	if strings.Contains(strings.ToLower(info.PrimaryManifest), ".mp4") {
		mediaType = "mp4"
		resID := gw.catalog.RegisterResource(assetID, info.PrimaryManifest, info.Provider)
		streamURL = fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resID, token)
	}
	expiresAt := time.Now().Add(ttl).UTC()

	resp := PlaybackSessionResponse{
		AssetID:     assetID,
		PlaylistURL: playlistURL,
		StreamURL:   streamURL,
		MediaType:   mediaType,
		Token:       token,
		ExpiresAt:   expiresAt,
	}

	_ = info // validated
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(resp)
}

// HandleHLSDispatch inspects /hls/... paths and routes to master playlist or mapped resource handlers.
func (gw *Gateway) HandleHLSDispatch(w http.ResponseWriter, r *http.Request) {
	observability.DefaultMetrics.IncRequests()
	defer observability.DefaultMetrics.DecActive()

	clientIP := session.ExtractClientIP(r)

	// Enforce anti-scraping burst/rate limiting
	if gw.limiter != nil && !gw.limiter.Allow(clientIP) {
		observability.DefaultMetrics.IncRateLimitRejections()
		gw.logger.Warn("playback rate limit throttled client", "client_ip", clientIP, "path", r.URL.Path)
		w.Header().Set("Retry-After", "3")
		gw.writeError(w, http.StatusTooManyRequests, "playback rate limit exceeded; burst downloading throttled")
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/hls/")

	if strings.HasSuffix(path, "/master.m3u8") {
		assetID := strings.TrimSuffix(path, "/master.m3u8")
		gw.serveMasterPlaylist(w, r, assetID, clientIP)
		return
	}

	if strings.Contains(path, "/resource/") {
		parts := strings.SplitN(path, "/resource/", 2)
		assetID := parts[0]
		resourceID := parts[1]
		gw.serveResource(w, r, assetID, resourceID, clientIP)
		return
	}

	http.NotFound(w, r)
}

func (gw *Gateway) serveMasterPlaylist(w http.ResponseWriter, r *http.Request, assetID, clientIP string) {
	token := r.URL.Query().Get("token")
	if token == "" {
		gw.writeError(w, http.StatusUnauthorized, "missing playback token")
		return
	}

	// 1. Validate token in constant time with client IP check
	_, err := gw.session.ValidateTokenForClient(token, assetID, clientIP)
	if err != nil {
		if errors.Is(err, session.ErrIPMismatch) {
			gw.logger.Warn("token client IP mismatch", "asset_id", assetID, "request_ip", clientIP)
			gw.writeError(w, http.StatusForbidden, "playback session bound to a different client IP")
			return
		}
		gw.logger.Warn("token validation rejected", "asset_id", assetID, "reason", err.Error())
		gw.writeError(w, http.StatusForbidden, "invalid or expired playback token")
		return
	}

	// 2. Resolve authorized source manifest
	info, err := gw.catalog.ResolveAsset(r.Context(), assetID)
	if err != nil {
		gw.writeError(w, http.StatusNotFound, "asset source not resolved")
		return
	}

	// 2b. Direct MP4 handler: emit single-file RFC 8216 HLS playlist pointing to opaque gateway resource
	if strings.Contains(strings.ToLower(info.PrimaryManifest), ".mp4") {
		resID := gw.catalog.RegisterResource(assetID, info.PrimaryManifest, info.Provider)
		manifest := fmt.Sprintf("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7200\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:7200.0,\nresource/%s?token=%s\n#EXT-X-ENDLIST\n", resID, token)

		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, no-cache, no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(manifest))
		return
	}

	// 3. Fetch upstream manifest with SSRF protection
	rawContent, finalURL, err := gw.upstream.FetchManifest(r.Context(), info.PrimaryManifest, info.Provider)
	if err != nil {
		// Attempt instant cache eviction and re-resolution if token expired upstream (e.g. 404 / 403)
		gw.catalog.InvalidateAsset(assetID)
		if freshInfo, freshErr := gw.catalog.ResolveAsset(r.Context(), assetID); freshErr == nil && freshInfo.PrimaryManifest != "" && freshInfo.PrimaryManifest != info.PrimaryManifest {
			gw.logger.Info("re-resolved fresh upstream manifest after token expiration", "asset_id", assetID, "old_uri", info.PrimaryManifest, "new_uri", freshInfo.PrimaryManifest)
			info = freshInfo
			rawContent, finalURL, err = gw.upstream.FetchManifest(r.Context(), info.PrimaryManifest, info.Provider)
		}
	}
	if err != nil {
		// Attempt fallback through alternate providers if primary manifest returned an error (e.g. 404)
		var fallbackSuccess bool
		for _, alt := range info.Providers {
			targetURI := alt.MasterURI
			if targetURI == "" && len(alt.Variants) > 0 {
				targetURI = alt.Variants[0].PlaylistURI
			}
			if targetURI != "" && targetURI != info.PrimaryManifest {
				gw.logger.Warn("primary upstream manifest fetch failed, attempting alternate provider", "asset_id", assetID, "failed_provider", info.Provider, "fallback_provider", alt.Provider)
				if content, u, fetchErr := gw.upstream.FetchManifest(r.Context(), targetURI, alt.Provider); fetchErr == nil {
					rawContent = content
					finalURL = u
					info.Provider = alt.Provider
					fallbackSuccess = true
					err = nil
					break
				}
			}
		}
		if !fallbackSuccess {
			gw.logger.Error("upstream manifest fetch error", "asset_id", assetID, "error", err)
			gw.writeError(w, http.StatusBadGateway, "failed to retrieve upstream playlist")
			return
		}
	}

	// 4. Safely rewrite playlist URIs to gateway opaque resource endpoints (or edge worker swarm for media segments)
	register := func(aID, upstreamURI string) string {
		return gw.catalog.RegisterResource(aID, upstreamURI, info.Provider)
	}

	var router hls.SegmentRouter
	if gw.swarm != nil && gw.swarm.HasActiveWorkers() {
		router = func(aID, upstreamURI string) string {
			return gw.swarm.BuildProxiedURLForKey(upstreamURI, info.Provider, upstreamURI)
		}
	}

	rewritten, err := gw.rewriter.RewritePlaylistWithRouter(rawContent, finalURL, assetID, token, register, router)
	if err != nil {
		gw.logger.Error("failed to rewrite playlist", "asset_id", assetID, "error", err)
		gw.writeError(w, http.StatusBadGateway, "malformed upstream playlist")
		return
	}

	// 5. Stream rewritten master playlist
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "private, no-cache, no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(rewritten))
}

func (gw *Gateway) serveResource(w http.ResponseWriter, r *http.Request, assetID, resourceID, clientIP string) {
	token := r.URL.Query().Get("token")
	if token == "" {
		gw.writeError(w, http.StatusUnauthorized, "missing playback token")
		return
	}

	// 1. Validate token with client IP check
	_, err := gw.session.ValidateTokenForClient(token, assetID, clientIP)
	if err != nil {
		if errors.Is(err, session.ErrIPMismatch) {
			gw.writeError(w, http.StatusForbidden, "playback session bound to a different client IP")
			return
		}
		gw.writeError(w, http.StatusForbidden, "invalid or expired playback token")
		return
	}

	// 2. Lookup mapped resource
	entry, ok := gw.catalog.LookupResource(assetID, resourceID)
	if !ok {
		gw.writeError(w, http.StatusNotFound, "resource identifier expired or unknown")
		return
	}

	// 3. Check optional disk cache with singleflight coalescing
	clientRange := r.Header.Get("Range")
	if gw.cache != nil && clientRange == "" {
		if cachedEntry, found := gw.cache.Get(entry.UpstreamURI); found {
			observability.DefaultMetrics.IncCacheHit()
			gw.serveCachedFile(w, r, cachedEntry)
			return
		}
		observability.DefaultMetrics.IncCacheMiss()

		// Coalesce concurrent fetches for identical resource
		val, err := gw.cache.DoCoalesced(entry.UpstreamURI, func() (any, error) {
			// Check if previous coalesced caller already completed caching
			if cachedEntry, found := gw.cache.Get(entry.UpstreamURI); found {
				return cachedEntry, nil
			}

			resp, err := gw.upstream.FetchResource(r.Context(), entry.UpstreamURI, entry.Provider, "")
			if err != nil {
				return nil, err
			}
			defer resp.Body.Close()

			policy := diskcache.EvaluatePolicy(resp.StatusCode, resp.Header, gw.cfg.CacheDefaultTTL)
			if policy.IsCacheable {
				return gw.cache.Put(entry.UpstreamURI, resp.Body, resp.Header, policy.TTL)
			}

			bodyBytes, err := io.ReadAll(resp.Body)
			if err != nil {
				return nil, err
			}
			return &uncachedPayload{statusCode: resp.StatusCode, header: resp.Header, body: bodyBytes}, nil
		})

		if err == nil {
			if cachedEntry, ok := val.(*diskcache.Entry); ok && cachedEntry != nil {
				gw.serveCachedFile(w, r, cachedEntry)
				return
			} else if uncached, ok := val.(*uncachedPayload); ok && uncached != nil {
				_, _ = delivery.StreamResponse(w, r, uncached.statusCode, uncached.header, bytes.NewReader(uncached.body))
				return
			}
		}
	}

	// 3b. If proxy swarm is active and this is a binary media segment, offload to edge worker!
	if gw.swarm != nil && gw.swarm.HasActiveWorkers() && !strings.Contains(strings.ToLower(entry.UpstreamURI), ".m3u8") {
		proxiedURL := gw.swarm.BuildProxiedURLForKey(entry.UpstreamURI, entry.Provider, entry.UpstreamURI)
		if proxiedURL != "" && !strings.HasPrefix(proxiedURL, "/proxy") {
			http.Redirect(w, r, proxiedURL, http.StatusTemporaryRedirect)
			return
		}
	}

	// 4. Fetch upstream resource with Range forwarding and SSRF protection
	resp, err := gw.upstream.FetchResource(r.Context(), entry.UpstreamURI, entry.Provider, clientRange)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return // Client cancelled request
		}
		gw.logger.Error("upstream resource fetch failed", "asset_id", assetID, "error", err)
		gw.writeError(w, http.StatusBadGateway, "failed to fetch media segment")
		return
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")

	// 5. Check if upstream resource is a nested media playlist requiring rewriting
	if strings.Contains(contentType, "mpegurl") || strings.HasSuffix(entry.UpstreamURI, ".m3u8") {
		bodyBytes, err := io.ReadAll(resp.Body)
		if err != nil {
			gw.writeError(w, http.StatusBadGateway, "failed reading nested playlist")
			return
		}

		u, _ := url.Parse(entry.UpstreamURI)
		register := func(aID, uURI string) string {
			return gw.catalog.RegisterResource(aID, uURI, entry.Provider)
		}

		var router hls.SegmentRouter
		if gw.swarm != nil && gw.swarm.HasActiveWorkers() {
			router = func(aID, uURI string) string {
				return gw.swarm.BuildProxiedURLForKey(uURI, entry.Provider, uURI)
			}
		}

		rewritten, err := gw.rewriter.RewritePlaylistWithRouter(string(bodyBytes), u, assetID, token, register, router)
		if err != nil {
			gw.writeError(w, http.StatusBadGateway, "failed rewriting nested playlist")
			return
		}

		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, no-cache, no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write([]byte(rewritten))
		return
	}

	// 6. Stream response with recycled 32KB buffer and backpressure
	_, _ = delivery.StreamResponse(w, r, resp.StatusCode, resp.Header, resp.Body)
}

func (gw *Gateway) serveCachedFile(w http.ResponseWriter, r *http.Request, entry *diskcache.Entry) {
	f, err := os.Open(entry.FilePath)
	if err != nil {
		gw.writeError(w, http.StatusInternalServerError, "failed reading cached media")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", entry.Meta.ContentType)
	w.Header().Set("X-Cache", "HIT")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	http.ServeContent(w, r, entry.Meta.Key, entry.Meta.CachedAt, f)
}

func (gw *Gateway) writeError(w http.ResponseWriter, code int, msg string) {
	observability.DefaultMetrics.RecordStatus(code)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	buf := bytes.Buffer{}
	_ = json.NewEncoder(&buf).Encode(map[string]any{
		"error": msg,
		"code":  code,
	})
	_, _ = w.Write(buf.Bytes())
}

// HandleOwnerOverview returns comprehensive system stats, security state, cache metrics, and cluster health.
func (gw *Gateway) HandleOwnerOverview(w http.ResponseWriter, r *http.Request) {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	bindIP, rlEnabled, burst, rate := gw.cfg.GetSecuritySettings()
	hosts := gw.cfg.GetApprovedHosts()

	var cacheStats map[string]any
	if gw.cache != nil {
		curBytes, maxBytes, fileCount := gw.cache.Stats()
		var utilPct float64
		if maxBytes > 0 {
			utilPct = float64(curBytes) / float64(maxBytes) * 100
		}
		cacheStats = map[string]any{
			"enabled":         true,
			"current_bytes":   curBytes,
			"max_bytes":       maxBytes,
			"file_count":      fileCount,
			"utilization_pct": utilPct,
		}
	} else {
		cacheStats = map[string]any{
			"enabled": false,
		}
	}

	overview := map[string]any{
		"service":         "byse-norm-hls-gateway",
		"version":         "2.4.0-obsidian",
		"status":          "HEALTHY",
		"uptime_seconds":  int64(time.Since(gw.startTime).Seconds()),
		"go_version":      runtime.Version(),
		"goroutines":      runtime.NumGoroutine(),
		"memory_alloc_mb": float64(memStats.Alloc) / (1024 * 1024),
		"security": map[string]any{
			"bind_client_ip":     bindIP,
			"rate_limit_enabled": rlEnabled,
			"rate_limit_burst":   burst,
			"rate_limit_rate":    rate,
			"primary_key_id":     gw.cfg.PrimaryHMACKeyID,
		},
		"approved_hosts": hosts,
		"cache":          cacheStats,
		"metrics":        observability.DefaultMetrics.Snapshot(),
		"client_ip":      session.ExtractClientIP(r),
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(overview)
}

// HandleOwnerWhitelist dynamically adds or removes approved upstream hostnames for SSRF protection.
func (gw *Gateway) HandleOwnerWhitelist(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host   string `json:"host"`
		Action string `json:"action"` // "add" or "remove"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		gw.writeError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	req.Host = strings.TrimSpace(req.Host)
	if req.Host == "" {
		gw.writeError(w, http.StatusBadRequest, "host cannot be empty")
		return
	}

	switch strings.ToLower(req.Action) {
	case "add":
		gw.cfg.AddApprovedHost(req.Host)
		gw.logger.Info("added approved upstream host", "host", req.Host)
	case "remove":
		gw.cfg.RemoveApprovedHost(req.Host)
		gw.logger.Info("removed approved upstream host", "host", req.Host)
	default:
		gw.writeError(w, http.StatusBadRequest, "action must be 'add' or 'remove'")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":         "ok",
		"action":         req.Action,
		"host":           req.Host,
		"approved_hosts": gw.cfg.GetApprovedHosts(),
	})
}

// HandleOwnerSettings updates security policies (IP binding and rate limiting) in-memory without downtime.
func (gw *Gateway) HandleOwnerSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BindClientIP     *bool    `json:"bind_client_ip"`
		RateLimitEnabled *bool    `json:"rate_limit_enabled"`
		RateLimitBurst   *int     `json:"rate_limit_burst"`
		RateLimitRate    *float64 `json:"rate_limit_rate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		gw.writeError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	curBind, curRLEnabled, curBurst, curRate := gw.cfg.GetSecuritySettings()
	if req.BindClientIP != nil {
		curBind = *req.BindClientIP
	}
	if req.RateLimitEnabled != nil {
		curRLEnabled = *req.RateLimitEnabled
	}
	if req.RateLimitBurst != nil && *req.RateLimitBurst > 0 {
		curBurst = *req.RateLimitBurst
	}
	if req.RateLimitRate != nil && *req.RateLimitRate > 0 {
		curRate = *req.RateLimitRate
	}

	gw.cfg.UpdateSecuritySettings(curBind, curRLEnabled, curBurst, curRate)
	if gw.limiter != nil {
		gw.limiter.UpdateParams(curRate, curBurst)
	}

	gw.logger.Info("updated owner security settings",
		"bind_client_ip", curBind,
		"rate_limit_enabled", curRLEnabled,
		"burst", curBurst,
		"rate", curRate)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":             "ok",
		"bind_client_ip":     curBind,
		"rate_limit_enabled": curRLEnabled,
		"rate_limit_burst":   curBurst,
		"rate_limit_rate":    curRate,
	})
}

// HandleOwnerCachePurge clears all disk cache entries.
func (gw *Gateway) HandleOwnerCachePurge(w http.ResponseWriter, r *http.Request) {
	if gw.cache == nil {
		gw.writeError(w, http.StatusBadRequest, "disk cache is not enabled")
		return
	}

	if err := gw.cache.Purge(); err != nil {
		gw.logger.Error("failed to purge cache", "error", err)
		gw.writeError(w, http.StatusInternalServerError, "failed to purge cache")
		return
	}

	gw.logger.Info("disk cache purged by owner")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"message": "cache purged successfully",
	})
}

// HandleOwnerProbe concurrently checks HTTP status and latency for all approved upstream hosts.
func (gw *Gateway) HandleOwnerProbe(w http.ResponseWriter, r *http.Request) {
	hosts := gw.cfg.GetApprovedHosts()
	type probeResult struct {
		Host      string `json:"host"`
		Status    string `json:"status"`
		LatencyMS int64  `json:"latency_ms"`
		Code      int    `json:"code,omitempty"`
		Error     string `json:"error,omitempty"`
	}

	results := make([]probeResult, len(hosts))
	var wg sync.WaitGroup
	client := &http.Client{Timeout: 3 * time.Second}

	for i, h := range hosts {
		wg.Add(1)
		go func(idx int, host string) {
			defer wg.Done()
			if host == "127.0.0.1" || host == "localhost" {
				results[idx] = probeResult{
					Host:      host,
					Status:    "ONLINE",
					LatencyMS: 0,
					Code:      200,
				}
				return
			}

			start := time.Now()
			probeURL := "https://" + host
			resp, err := client.Head(probeURL)
			dur := time.Since(start).Milliseconds()

			if err != nil {
				// Fallback to GET with Range 0-0 in case HEAD is rejected
				req, _ := http.NewRequestWithContext(r.Context(), "GET", probeURL, nil)
				req.Header.Set("Range", "bytes=0-0")
				resp, err = client.Do(req)
			}

			if err != nil {
				results[idx] = probeResult{
					Host:      host,
					Status:    "UNREACHABLE",
					LatencyMS: dur,
					Error:     err.Error(),
				}
				return
			}
			_ = resp.Body.Close()

			results[idx] = probeResult{
				Host:      host,
				Status:    "ONLINE",
				LatencyMS: dur,
				Code:      resp.StatusCode,
			}
		}(i, h)
	}

	wg.Wait()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"results": results,
	})
}
