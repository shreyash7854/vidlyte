package models

import "time"

// MediaRequest represents the path parameters parsed from the URL.
type MediaRequest struct {
	Type    string `json:"type"`    // "tv", "movie", or "anime"
	ID      string `json:"id"`      // Media/TMDB ID
	Season  int    `json:"season"`  // Season number (for TV)
	Episode int    `json:"episode"` // Episode number (for TV)
}

// HTTPHeaders defines the exact HTTP headers required by upstream CDNs / gateways.
type HTTPHeaders struct {
	Referer   string `json:"referer"`
	Origin    string `json:"origin"`
	UserAgent string `json:"user_agent"`
}

// ProxyRule provides explicit instructions for cloud players and edge proxies.
type ProxyRule struct {
	Provider        string      `json:"provider"`
	AllowedDirect   bool        `json:"allowed_direct"`
	RequiresProxy   bool        `json:"requires_proxy"`
	CORSStatus      string      `json:"cors_status"`
	RequiredHeaders HTTPHeaders `json:"required_headers"`
	Notes           string      `json:"notes"`
}

// StreamVariant defines an individual quality level (rung) in an adaptive stream.
type StreamVariant struct {
	Resolution    string      `json:"resolution"`
	Bandwidth     int         `json:"bandwidth"`
	Codecs        string      `json:"codecs"`
	PlaylistURI   string      `json:"playlist_uri"`
	ProxiedURI    string      `json:"proxied_uri"`
	Provider      string      `json:"provider"`
	Domain        string      `json:"domain"`
	RequiresProxy bool        `json:"requires_proxy"`
	Headers       HTTPHeaders `json:"headers"`
}

// AudioTrack defines an available audio track/dub for the stream.
type AudioTrack struct {
	Language      string      `json:"language"`
	Name          string      `json:"name"`
	Default       bool        `json:"default"`
	URI           string      `json:"uri"`
	ProxiedURI    string      `json:"proxied_uri"`
	Provider      string      `json:"provider"` // "orion", "evion", etc.
	Domain        string      `json:"domain"`
	RequiresProxy bool        `json:"requires_proxy"`
	Headers       HTTPHeaders `json:"headers"`
}

// SubtitleTrack defines an available subtitle/caption file.
type SubtitleTrack struct {
	Language      string      `json:"language"`
	Label         string      `json:"label"`
	URI           string      `json:"uri"`
	ProxiedURI    string      `json:"proxied_uri"`
	Provider      string      `json:"provider"`
	Domain        string      `json:"domain"`
	RequiresProxy bool        `json:"requires_proxy"`
	Headers       HTTPHeaders `json:"headers"`
}

// ProviderStreams holds streams and tracks scoped to a specific provider.
type ProviderStreams struct {
	Provider        string          `json:"provider"`
	MasterURI       string          `json:"master_uri,omitempty"`
	ProxiedMaster   string          `json:"proxied_master,omitempty"`
	Domain          string          `json:"domain"`
	RequiresProxy   bool            `json:"requires_proxy"`
	Headers         HTTPHeaders     `json:"headers"`
	Variants        []StreamVariant `json:"variants"`
	AudioTracks     []AudioTrack    `json:"audio_tracks"`
}

// MediaResponse is the high-performance response payload returned by the resolver.
type MediaResponse struct {
	Type            string                `json:"type"`
	ID              string                `json:"id"`
	Season          int                   `json:"season,omitempty"`
	Episode         int                   `json:"episode,omitempty"`
	Title           string                `json:"title,omitempty"`
	Kicker          string                `json:"kicker,omitempty"`
	Year            string                `json:"year,omitempty"`
	Rating          string                `json:"rating,omitempty"`
	Genres          []string              `json:"genres,omitempty"`
	Overview        string                `json:"overview,omitempty"`
	LogoURL         string                `json:"logo_url,omitempty"`
	PrimaryManifest string                `json:"primary_manifest,omitempty"`
	ProxiedPrimary  string                `json:"proxied_primary,omitempty"`
	DefaultHeaders  HTTPHeaders           `json:"default_headers"`
	ProxyRules      map[string]ProxyRule  `json:"proxy_rules"`
	Variants        []StreamVariant       `json:"variants"`
	AudioTracks     []AudioTrack          `json:"audio_tracks"` // Unified across all providers
	Providers       []ProviderStreams     `json:"providers,omitempty"`  // Individual provider breakdowns
	Subtitles       []SubtitleTrack       `json:"subtitles"`
	WarmManifest    string                `json:"warm_manifest,omitempty"`
	WarmManifests   map[string]string     `json:"warm_manifests,omitempty"`
	PlaybackToken   string                `json:"playback_token,omitempty"`
	ResolvedAt      time.Time             `json:"resolved_at"`
	ExecutionTimeMs float64               `json:"execution_time_ms"`
}

// ErrorResponse standardizes error responses.
type ErrorResponse struct {
	Error   string `json:"error"`
	Code    int    `json:"code"`
	Details string `json:"details,omitempty"`
}
