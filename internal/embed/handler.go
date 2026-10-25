package embed

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"byse-resolver/internal/catalog"
	"byse-resolver/internal/config"
	"byse-resolver/internal/models"
	"byse-resolver/internal/parser"
	"byse-resolver/internal/session"
)

//go:embed player.html
var defaultPlayerHTML string

// AdsterraConfig holds monetization, popunder smartlink, and anti-adblock settings.
type AdsterraConfig struct {
	Enabled                bool   `json:"enabled"`
	SmartlinkURL           string `json:"smartlinkUrl"`
	MaxPopunders          int    `json:"maxPopunders"`
	CooldownMins          int    `json:"cooldownMins"`
	TriggerEvent          string `json:"triggerEvent"`
	AntiAdblockEnabled     bool   `json:"antiAdblockEnabled"`
	AntiAdblockStrictBrave bool   `json:"antiAdblockStrictBrave"`
	AntiAdblockMessage     string `json:"antiAdblockMessage"`
}

// ServerBrandingPayload is sent to the client player to control server name visibility and labels.
type ServerBrandingPayload struct {
	ShowServerNames bool              `json:"showServerNames"`
	DefaultServer   string            `json:"defaultServer"`
	ServerAliases   map[string]string `json:"serverAliases"`
}

// PlayerBootstrapConfig is serialized into the HTML document for instant, zero-fetch playback.
type PlayerBootstrapConfig struct {
	AssetID      string                 `json:"assetId"`
	StreamURL    string                 `json:"streamUrl"`
	MediaType    string                 `json:"mediaType"`
	TMDBID       string                 `json:"tmdbId"`
	Season       int                    `json:"season"`
	Episode      int                    `json:"episode"`
	Title        string                 `json:"title"`
	Kicker       string                 `json:"kicker,omitempty"`
	Year         string                 `json:"year,omitempty"`
	Rating       string                 `json:"rating,omitempty"`
	Genres       []string               `json:"genres,omitempty"`
	Overview     string                 `json:"overview,omitempty"`
	LogoURL      string                 `json:"logoUrl,omitempty"`
	Autoplay     bool                   `json:"autoplay"`
	Muted        bool                   `json:"muted"`
	Token         string                   `json:"token"`
	Subtitles     []models.SubtitleTrack   `json:"subtitles"`
	AudioTracks   []models.AudioTrack      `json:"audioTracks"`
	Variants      []models.StreamVariant   `json:"variants,omitempty"`
	Providers     []models.ProviderStreams `json:"providers,omitempty"`
	PlaybackToken string                   `json:"playbackToken,omitempty"`
	Poster        string                   `json:"poster,omitempty"`
	BrandLogo    string                 `json:"brandLogo,omitempty"`
	WatermarkURL string                 `json:"watermarkUrl,omitempty"`
	ShowTitle    bool                   `json:"showTitle"`
	ShowExit     bool                   `json:"showExit"`
	ControlBg    string                 `json:"controlBg,omitempty"`
	UIScale      float64                `json:"uiScale,omitempty"`
	Font         string                 `json:"font,omitempty"`
	Hide         []string               `json:"hide,omitempty"`
	AdConfig     AdsterraConfig         `json:"adConfig"`
	ServerBranding ServerBrandingPayload `json:"serverBranding"`
}

// TemplateData holds values passed to the HTML template renderer.
type TemplateData struct {
	Title      string
	ConfigJSON template.JS
}

// Handler handles the /embed/... endpoints for webmaster iframes.
type Handler struct {
	cfg     *config.Config
	store   *config.ConfigStore
	session *session.Manager
	catalog *catalog.Adapter
	tmpl    *template.Template
}

// NewHandler initializes an EmbedHandler with embedded template.
func NewHandler(cfg *config.Config, s *session.Manager, c *catalog.Adapter) (*Handler, error) {
	return NewHandlerWithStore(cfg, s, c, nil)
}

// NewHandlerWithStore initializes an EmbedHandler with dynamic configuration store.
func NewHandlerWithStore(cfg *config.Config, s *session.Manager, c *catalog.Adapter, store *config.ConfigStore) (*Handler, error) {
	tmpl, err := template.New("player").Parse(defaultPlayerHTML)
	if err != nil {
		return nil, fmt.Errorf("failed to parse embed player template: %w", err)
	}
	return &Handler{
		cfg:     cfg,
		store:   store,
		session: s,
		catalog: c,
		tmpl:    tmpl,
	}, nil
}

// RegisterRoutes registers /embed/... routes onto the HTTP mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /embed/tv/{id}/{season}/{episode}", h.HandleTVEmbed)
	mux.HandleFunc("GET /embed/movie/{id}", h.HandleMovieEmbed)
	mux.HandleFunc("GET /embed/{type}/{id}/{season}/{episode}", h.HandleGenericEmbed)
	mux.HandleFunc("GET /api/source/{type}/{id}", h.HandleSourceProxy)
	mux.HandleFunc("GET /api/source/{type}/{id}/{season}/{episode}", h.HandleSourceProxyTV)
}

func (h *Handler) HandleTVEmbed(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	seasonStr := r.PathValue("season")
	episodeStr := r.PathValue("episode")

	season, err1 := strconv.Atoi(seasonStr)
	episode, err2 := strconv.Atoi(episodeStr)
	if id == "" || err1 != nil || err2 != nil || season < 1 || episode < 1 {
		http.Error(w, "Invalid TV episode parameters", http.StatusBadRequest)
		return
	}

	assetID := fmt.Sprintf("tv/%s/%d/%d", id, season, episode)
	title := fmt.Sprintf("Watch %s S%02dE%02d", id, season, episode)
	h.serveEmbedPlayer(w, r, "tv", id, season, episode, assetID, title)
}

func (h *Handler) HandleMovieEmbed(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing movie ID", http.StatusBadRequest)
		return
	}

	assetID := fmt.Sprintf("movie/%s", id)
	title := fmt.Sprintf("Watch Movie %s", id)
	h.serveEmbedPlayer(w, r, "movie", id, 0, 0, assetID, title)
}

func (h *Handler) HandleGenericEmbed(w http.ResponseWriter, r *http.Request) {
	mediaType := r.PathValue("type")
	id := r.PathValue("id")
	seasonStr := r.PathValue("season")
	episodeStr := r.PathValue("episode")

	season, err1 := strconv.Atoi(seasonStr)
	episode, err2 := strconv.Atoi(episodeStr)
	if id == "" || err1 != nil || err2 != nil || season < 1 || episode < 1 {
		http.Error(w, "Invalid media parameters", http.StatusBadRequest)
		return
	}

	assetID := fmt.Sprintf("%s/%s/%d/%d", mediaType, id, season, episode)
	title := fmt.Sprintf("Watch %s", id)
	h.serveEmbedPlayer(w, r, mediaType, id, season, episode, assetID, title)
}

func (h *Handler) serveEmbedPlayer(w http.ResponseWriter, r *http.Request, mediaType, tmdbID string, season, episode int, assetID, defaultTitle string) {
	q := r.URL.Query()

	// 1. Parse Vidrift Embedder Customisation Parameters
	autoplay := true
	if q.Get("autoplay") == "0" || q.Get("autoplay") == "false" {
		autoplay = false
	}

	startMuted := false
	if q.Get("muted") == "1" || q.Get("muted") == "true" {
		startMuted = true
	}

	showTitle := false
	if q.Get("showTitle") == "1" || q.Get("showTitle") == "true" {
		showTitle = true
	}

	showExit := false
	if q.Get("exit") == "1" || q.Get("exit") == "true" {
		showExit = true
	}

	// 2. Resolve asset (Vidrift Primary -> AsianFlix Secondary with TMDB-to-slug translation)
	info, err := h.catalog.ResolveAsset(r.Context(), assetID)
	if err != nil {
		h.renderErrorPlayer(w, http.StatusNotFound, "Stream not found or temporarily unavailable")
		return
	}

	title := defaultTitle
	if info != nil && info.Title != "" {
		title = info.Title
	}
	if customTitle := q.Get("title"); customTitle != "" {
		title = customTitle
	}

	poster := q.Get("poster")
	brandLogo := q.Get("brandLogo")
	watermark := q.Get("watermark")
	controlBg := q.Get("controlBg")
	font := q.Get("font")

	var uiScale float64 = 1.0
	if scaleStr := q.Get("uiScale"); scaleStr != "" {
		if s, err := strconv.ParseFloat(scaleStr, 64); err == nil && s >= 0.5 && s <= 2.5 {
			uiScale = s
		}
	}

	var hideList []string
	if hideStr := q.Get("hide"); hideStr != "" {
		for _, item := range strings.Split(hideStr, ",") {
			item = strings.TrimSpace(item)
			if item != "" {
				hideList = append(hideList, item)
			}
		}
	}

	// 3. Issue session token for streaming
	clientIP := session.ExtractClientIP(r)
	ttl := h.cfg.TokenTTL
	var token string
	if h.cfg.BindClientIP {
		token, err = h.session.IssueTokenForClient(assetID, clientIP, ttl)
	} else {
		token, err = h.session.IssueToken(assetID, ttl)
	}
	if err != nil {
		h.renderErrorPlayer(w, http.StatusInternalServerError, "Failed to initialize playback session")
		return
	}

	// 4. Build playlist stream URL
	playlistURL := fmt.Sprintf("/hls/%s/master.m3u8?token=%s", assetID, token)

	// 5. Construct SSR bootstrap payload for instantaneous startup
	var adCfg AdsterraConfig
	if h.store != nil {
		dyn := h.store.Get()
		adCfg = AdsterraConfig{
			Enabled:                dyn.Monetization.PopundersEnabled,
			SmartlinkURL:           dyn.Monetization.SmartlinkURL,
			MaxPopunders:          dyn.Monetization.MaxPopundersPerSession,
			CooldownMins:          dyn.Monetization.CooldownMinutes,
			TriggerEvent:          dyn.Monetization.TriggerEvent,
			AntiAdblockEnabled:     dyn.Monetization.AntiAdblockEnabled,
			AntiAdblockStrictBrave: dyn.Monetization.AntiAdblockStrictBrave,
			AntiAdblockMessage:     dyn.Monetization.AntiAdblockMessage,
		}
	} else {
		adCfg = AdsterraConfig{
			Enabled:                false,
			MaxPopunders:          2,
			CooldownMins:          15,
			TriggerEvent:          "play_click",
			AntiAdblockEnabled:     true,
			AntiAdblockStrictBrave: true,
			AntiAdblockMessage:     "Ad blocker detected. Please disable your ad blocker or Brave Shields to continue watching.",
		}
	}

	var serverBrand ServerBrandingPayload
	if h.store != nil {
		dyn := h.store.Get()
		serverBrand = ServerBrandingPayload{
			ShowServerNames: dyn.ServerBranding.ShowServerNames,
			DefaultServer:   dyn.ServerBranding.DefaultServer,
			ServerAliases:   dyn.ServerBranding.ServerAliases,
		}
	} else {
		serverBrand = ServerBrandingPayload{
			ShowServerNames: false,
			DefaultServer:   "orion",
			ServerAliases: map[string]string{
				"orion": "Server 1",
			},
		}
	}

	var sanitizedSubs []models.SubtitleTrack
	for _, sub := range info.Subtitles {
		resID := h.catalog.RegisterResource(assetID, sub.URI, sub.Provider)
		opaqueURL := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resID, token)
		sanitizedSubs = append(sanitizedSubs, models.SubtitleTrack{
			Language:   sub.Language,
			Label:      sub.Label,
			URI:        opaqueURL,
			ProxiedURI: opaqueURL,
			Provider:   sub.Provider,
		})
	}

	var sanitizedAudio []models.AudioTrack
	for _, at := range info.AudioTracks {
		var prewarmed string
		if info.WarmManifests != nil {
			if wm, ok := info.WarmManifests[at.URI]; ok {
				prewarmed = wm
			} else if u, parseErr := url.Parse(at.URI); parseErr == nil && u.Path != "" {
				if wm, ok := info.WarmManifests[u.Path]; ok {
					prewarmed = wm
				}
			}
		}
		resID := h.catalog.RegisterResourceWithPrewarmed(assetID, at.URI, at.Provider, prewarmed)
		opaqueURL := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resID, token)
		sanitizedAudio = append(sanitizedAudio, models.AudioTrack{
			Language:      at.Language,
			Name:          at.Name,
			Default:       at.Default,
			URI:           opaqueURL,
			ProxiedURI:    opaqueURL,
			Provider:      at.Provider,
			RequiresProxy: false,
		})
	}

	var sanitizedVariants []models.StreamVariant
	for _, v := range info.Variants {
		var prewarmed string
		if info.WarmManifests != nil {
			if wm, ok := info.WarmManifests[v.PlaylistURI]; ok {
				prewarmed = wm
			} else if u, parseErr := url.Parse(v.PlaylistURI); parseErr == nil && u.Path != "" {
				if wm, ok := info.WarmManifests[u.Path]; ok {
					prewarmed = wm
				}
			}
		}
		resID := h.catalog.RegisterResourceWithPrewarmed(assetID, v.PlaylistURI, v.Provider, prewarmed)
		opaqueURL := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resID, token)
		sanitizedVariants = append(sanitizedVariants, models.StreamVariant{
			Resolution:    v.Resolution,
			Bandwidth:     v.Bandwidth,
			Codecs:        v.Codecs,
			PlaylistURI:   opaqueURL,
			ProxiedURI:    opaqueURL,
			Provider:      v.Provider,
			RequiresProxy: false,
		})
	}

	bootstrap := PlayerBootstrapConfig{
		AssetID:        assetID,
		StreamURL:      playlistURL,
		MediaType:      mediaType,
		TMDBID:         tmdbID,
		Season:         season,
		Episode:        episode,
		Title:          title,
		Kicker:         info.Kicker,
		Year:           info.Year,
		Rating:         info.Rating,
		Genres:         info.Genres,
		Overview:       info.Overview,
		LogoURL:        info.LogoURL,
		Autoplay:       autoplay,
		Muted:          startMuted,
		Token:          token,
		Subtitles:      sanitizedSubs,
		AudioTracks:    sanitizedAudio,
		Variants:       sanitizedVariants,
		Poster:         poster,
		BrandLogo:      brandLogo,
		WatermarkURL:   watermark,
		ShowTitle:      showTitle,
		ShowExit:       showExit,
		ControlBg:      controlBg,
		UIScale:        uiScale,
		Font:           font,
		Hide:           hideList,
		AdConfig:       adCfg,
		ServerBranding: serverBrand,
	}

	bootstrapJSON, err := json.Marshal(bootstrap)
	if err != nil {
		h.renderErrorPlayer(w, http.StatusInternalServerError, "Failed to encode player configuration")
		return
	}

	// 6. Inject iframe-permissive embedding headers
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "frame-ancestors *;")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Del("X-Frame-Options")

	data := TemplateData{
		Title:      title,
		ConfigJSON: template.JS(string(bootstrapJSON)),
	}

	tmpl := h.tmpl
	if diskHTML, err := os.ReadFile("internal/embed/player.html"); err == nil && len(diskHTML) > 0 {
		if parsed, err := template.New("player").Parse(string(diskHTML)); err == nil {
			tmpl = parsed
		}
	}

	w.WriteHeader(http.StatusOK)
	_ = tmpl.Execute(w, data)
}

func (h *Handler) renderErrorPlayer(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "frame-ancestors *;")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Stream Error</title>
<style>body{margin:0;background:#090a0f;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}h2{margin:0;font-size:20px;font-weight:600;}p{margin:0;color:#888;font-size:14px;}</style>
</head>
<body>
  <h2>Stream Unavailable</h2>
  <p>%s</p>
</body>
</html>`, template.HTMLEscapeString(msg))))
}

func (h *Handler) HandleSourceProxy(w http.ResponseWriter, r *http.Request) {
	mediaType := r.PathValue("type")
	id := r.PathValue("id")
	token := r.URL.Query().Get("token")
	provider := r.URL.Query().Get("provider")
	if provider == "" {
		provider = "vela"
	}

	upstreamURL := fmt.Sprintf("https://embed.vidrift.net/api/source/%s/%s?token=%s&provider=%s", mediaType, id, url.QueryEscape(token), url.QueryEscape(provider))
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", parser.BrowserUserAgent)
	req.Header.Set("Referer", fmt.Sprintf("https://embed.vidrift.net/embed/%s/%s", mediaType, id))
	req.Header.Set("Origin", "https://embed.vidrift.net")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (h *Handler) HandleSourceProxyTV(w http.ResponseWriter, r *http.Request) {
	mediaType := r.PathValue("type")
	id := r.PathValue("id")
	season := r.PathValue("season")
	episode := r.PathValue("episode")
	token := r.URL.Query().Get("token")
	provider := r.URL.Query().Get("provider")
	if provider == "" {
		provider = "vela"
	}

	upstreamURL := fmt.Sprintf("https://embed.vidrift.net/api/source/%s/%s/%s/%s?token=%s&provider=%s", mediaType, id, season, episode, url.QueryEscape(token), url.QueryEscape(provider))
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", parser.BrowserUserAgent)
	req.Header.Set("Referer", fmt.Sprintf("https://embed.vidrift.net/embed/%s/%s/%s/%s", mediaType, id, season, episode))
	req.Header.Set("Origin", "https://embed.vidrift.net")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
