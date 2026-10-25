package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FeaturedPick represents a sample movie or TV show highlighted on the main site.
type FeaturedPick struct {
	ID      string `json:"id"`
	Type    string `json:"type"` // "tv" or "movie"
	Title   string `json:"title"`
	Year    string `json:"year,omitempty"`
	Season  int    `json:"season,omitempty"`
	Episode int    `json:"episode,omitempty"`
}

// AnnouncementBanner represents an announcement bar on the top of the main site.
type AnnouncementBanner struct {
	Enabled bool   `json:"enabled"`
	Message string `json:"message"`
	Link    string `json:"link,omitempty"`
}

// SiteConfig holds brand and presentation parameters for the main portal.
type SiteConfig struct {
	BrandName     string             `json:"brand_name"`
	Tagline       string             `json:"tagline"`
	HeroTitle     string             `json:"hero_title"`
	HeroSubtitle  string             `json:"hero_subtitle"`
	DiscordURL    string             `json:"discord_url"`
	TelegramURL   string             `json:"telegram_url"`
	Banner        AnnouncementBanner `json:"announcement_banner"`
	FeaturedPicks []FeaturedPick     `json:"featured_picks"`
}

// PlayerDomainConfig holds the fleet of player domains/subdomains.
type PlayerDomainConfig struct {
	PrimaryDomain   string   `json:"primary_domain"`   // e.g. "http://localhost:6789" or "https://embed.domain.cc"
	FallbackDomains []string `json:"fallback_domains"` // list of active player mirrors
}

// UpstreamServerConfig represents an upstream media provider/cluster.
type UpstreamServerConfig struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Endpoint  string `json:"endpoint"`
	Enabled   bool   `json:"enabled"`
	Priority  int    `json:"priority"`
	TimeoutMs int    `json:"timeout_ms"`
}

// MonetizationConfig controls the Adsterra popunder smartlink module and anti-adblock detection.
type MonetizationConfig struct {
	PopundersEnabled       bool   `json:"popunders_enabled"`
	SmartlinkURL           string `json:"smartlink_url"`
	MaxPopundersPerSession int    `json:"max_popunders_per_session"`
	CooldownMinutes        int    `json:"cooldown_minutes"`
	TriggerEvent           string `json:"trigger_event"` // "play_click" or "canvas_click"
	AntiAdblockEnabled     bool   `json:"anti_adblock_enabled"`
	AntiAdblockStrictBrave bool   `json:"anti_adblock_strict_brave"`
	AntiAdblockMessage     string `json:"anti_adblock_message"`
}

// ProxyWorker represents a single Cloudflare Worker or edge proxy endpoint.
type ProxyWorker struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	URL       string    `json:"url"` // Format: "https://worker-name.subdomain.workers.dev/proxy?url="
	Enabled   bool      `json:"enabled"`
	Weight    int       `json:"weight"`
	Failures  int       `json:"failures"`
	LatencyMs int64     `json:"latency_ms"`
	LastCheck time.Time `json:"last_check"`
}

// ProxySwarmConfig orchestrates the distributed fleet of proxy workers for high-scale load balancing.
type ProxySwarmConfig struct {
	Enabled       bool          `json:"enabled"`
	Strategy      string        `json:"strategy"` // "random", "round_robin", "latency"
	FallbackLocal bool          `json:"fallback_local"`
	Workers       []ProxyWorker `json:"workers"`
}

// ServerBrandingConfig controls player server display names and visibility.
type ServerBrandingConfig struct {
	ShowServerNames bool              `json:"show_server_names"` // Whether to show server labels in player pills and popovers
	DefaultServer   string            `json:"default_server"`    // e.g. "orion"
	ServerAliases   map[string]string `json:"server_aliases"`    // e.g. {"orion": "Server 1 (High Speed)", "framex": "Server 2 (Backup)", "asianflix": "Server 3 (Anime)"}
}

// DynamicConfig contains all runtime-mutable state that can be altered from /admin-login-i.
type DynamicConfig struct {
	Site            SiteConfig             `json:"site_config"`
	PlayerFleet     PlayerDomainConfig     `json:"player_fleet"`
	UpstreamServers []UpstreamServerConfig `json:"upstream_servers"`
	Monetization    MonetizationConfig     `json:"monetization"`
	ProxySwarm      ProxySwarmConfig       `json:"proxy_swarm"`
	ServerBranding  ServerBrandingConfig   `json:"server_branding"`
	LastUpdated     time.Time              `json:"last_updated"`
}

// ConfigStore provides thread-safe access and atomic persistence for DynamicConfig.
type ConfigStore struct {
	filePath string
	mu       sync.RWMutex
	current  DynamicConfig
}

// DefaultDynamicConfig returns production-ready initial configuration.
func DefaultDynamicConfig() DynamicConfig {
	return DynamicConfig{
		Site: SiteConfig{
			BrandName:    "VidLyte",
			Tagline:      "Autonomous Sovereign Video Embed API",
			HeroTitle:    "One Universal Iframe URL for Every Movie, Series & Anime",
			HeroSubtitle: "Instant zero-buffering player, adaptive HLS, multi-audio tracks, auto-next, and clean webmaster customization. No API keys, no signups, 100% free.",
			DiscordURL:   "https://discord.gg/vidlyte",
			TelegramURL:  "https://t.me/vidlyte",
			Banner: AnnouncementBanner{
				Enabled: true,
				Message: "⚡ VidLyte Core: Sub-millisecond HLS Stream Proxy & Multi-Source Failover is Live!",
				Link:    "#docs",
			},
			FeaturedPicks: []FeaturedPick{
				{ID: "289423", Type: "tv", Title: "Severance", Season: 1, Episode: 1, Year: "2022"},
				{ID: "1058424", Type: "movie", Title: "Gladiator II", Year: "2024"},
				{ID: "314939", Type: "tv", Title: "Stranger Things", Season: 1, Episode: 1, Year: "2016"},
				{ID: "360817", Type: "movie", Title: "Bhaag Johnny", Year: "2015"},
			},
		},
		PlayerFleet: PlayerDomainConfig{
			PrimaryDomain: "http://localhost:6789",
			FallbackDomains: []string{
				"http://localhost:8080",
			},
		},
		UpstreamServers: []UpstreamServerConfig{
			{
				ID:        "orion",
				Name:      "Orion / Evion Core Cluster",
				Endpoint:  "https://embed.vidrift.net",
				Enabled:   true,
				Priority:  1,
				TimeoutMs: 8000,
			},
			{
				ID:        "framex",
				Name:      "FrameX TV Fallback Cluster",
				Endpoint:  "https://api.framextv.xyz",
				Enabled:   true,
				Priority:  2,
				TimeoutMs: 8000,
			},
			{
				ID:        "asianflix",
				Name:      "AsianFlix / Rumble CDN Cluster",
				Endpoint:  "https://www.blogger.com",
				Enabled:   true,
				Priority:  3,
				TimeoutMs: 7000,
			},
		},
		Monetization: MonetizationConfig{
			PopundersEnabled:       true,
			SmartlinkURL:           "https://beta.smartlink.example/click?key=adsterra_live_vidlyte",
			MaxPopundersPerSession: 2,
			CooldownMinutes:        15,
			TriggerEvent:           "play_click",
			AntiAdblockEnabled:     true,
			AntiAdblockStrictBrave: true,
			AntiAdblockMessage:     "Ad blocker detected. Please disable your ad blocker or Brave Shields to continue watching. It helps us keep this video player available to you.",
		},
		ProxySwarm: ProxySwarmConfig{
			Enabled:       true,
			Strategy:      "consistent_hash",
			FallbackLocal: true,
			Workers: []ProxyWorker{
				{
					ID:        "worker-alpha",
					Name:      "Edge Node Alpha (Cloudflare Edge)",
					URL:       "https://alpha-lytenode.jadiel35.workers.dev/?url=",
					Enabled:   true,
					Weight:    10,
					Failures:  0,
					LatencyMs: 35,
					LastCheck: time.Now().UTC(),
				},
				{
					ID:        "worker-bravo",
					Name:      "Edge Node Bravo (Singapore)",
					URL:       "https://vidlyte-proxy-node2.workers.dev/proxy?url=",
					Enabled:   true,
					Weight:    10,
					Failures:  0,
					LatencyMs: 38,
					LastCheck: time.Now().UTC(),
				},
			},
		},
		ServerBranding: ServerBrandingConfig{
			ShowServerNames: false,
			DefaultServer:   "orion",
			ServerAliases: map[string]string{
				"orion":     "Server 1 (Ultra Fast)",
				"framex":    "Server 2 (Backup)",
				"asianflix": "Server 3 (Anime / Asian)",
			},
		},
		LastUpdated: time.Now().UTC(),
	}
}

// NewConfigStore initializes the configuration store, loading existing file or saving defaults.
func NewConfigStore(filePath string) (*ConfigStore, error) {
	if filePath == "" {
		filePath = filepath.Join("data", "vidlyte_config.json")
	}

	cs := &ConfigStore{
		filePath: filePath,
		current:  DefaultDynamicConfig(),
	}

	// Try loading from file
	if data, err := os.ReadFile(filePath); err == nil && len(data) > 0 {
		var loaded DynamicConfig
		if err := json.Unmarshal(data, &loaded); err == nil {
			// Backwards compatibility defaults for newly introduced fields
			defaults := DefaultDynamicConfig()
			if len(loaded.ProxySwarm.Workers) == 0 {
				loaded.ProxySwarm = defaults.ProxySwarm
			}
			if loaded.ServerBranding.ServerAliases == nil {
				loaded.ServerBranding = defaults.ServerBranding
			}
			cs.current = loaded
			slog.Info("loaded dynamic config from disk", "path", filePath, "brand", loaded.Site.BrandName, "primary_player", loaded.PlayerFleet.PrimaryDomain)
			return cs, nil
		}
		slog.Warn("failed to parse existing dynamic config; falling back to defaults", "error", err)
	}

	// Ensure directory exists and persist initial defaults
	_ = os.MkdirAll(filepath.Dir(filePath), 0755)
	if err := cs.saveToDisk(cs.current); err != nil {
		slog.Warn("could not persist initial dynamic config to disk (may be ephemeral environment)", "error", err)
	} else {
		slog.Info("persisted default dynamic config to disk", "path", filePath)
	}

	return cs, nil
}

// Get returns an immutable copy of current configuration.
func (cs *ConfigStore) Get() DynamicConfig {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	return cs.current
}

// Update validates, updates in-memory config, and atomically writes to disk.
func (cs *ConfigStore) Update(updater func(*DynamicConfig) error) (DynamicConfig, error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	updated := cs.current
	if err := updater(&updated); err != nil {
		return cs.current, err
	}

	updated.LastUpdated = time.Now().UTC()

	// Validate critical parameters
	if updated.Site.BrandName == "" {
		updated.Site.BrandName = "VidLyte"
	}
	if updated.Monetization.MaxPopundersPerSession <= 0 {
		updated.Monetization.MaxPopundersPerSession = 2
	}

	if err := cs.saveToDisk(updated); err != nil {
		slog.Warn("failed to persist dynamic config to disk (proceeding with memory update)", "error", err)
	}

	cs.current = updated
	slog.Info("dynamic config updated successfully", "brand", updated.Site.BrandName, "player_domain", updated.PlayerFleet.PrimaryDomain, "popunders_enabled", updated.Monetization.PopundersEnabled)
	return updated, nil
}

func (cs *ConfigStore) saveToDisk(cfg DynamicConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal dynamic config: %w", err)
	}

	dir := filepath.Dir(cs.filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	tmpFile := cs.filePath + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("write tmp config file: %w", err)
	}

	if err := os.Rename(tmpFile, cs.filePath); err != nil {
		return fmt.Errorf("atomic rename config file: %w", err)
	}

	return nil
}
