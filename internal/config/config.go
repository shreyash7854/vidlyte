package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config holds runtime configuration for the HLS distributor gateway.
type Config struct {
	Port              string
	Env               string
	HMACKeys          map[string][]byte
	PrimaryHMACKeyID  string
	TokenTTL          time.Duration
	ApprovedHosts     map[string]bool
	UpstreamTimeout   time.Duration
	UpstreamMaxConns  int
	CacheEnabled      bool
	CacheDir          string
	CacheMaxSizeBytes int64
	CacheDefaultTTL   time.Duration
	LogLevel          string
	BindClientIP      bool
	RateLimitEnabled  bool
	RateLimitBurst    int
	RateLimitRate     float64
	TMDBAPIKey        string
	UpstashRESTURLs   []string
	UpstashRESTTokens []string
	mu                sync.RWMutex
}

// LoadConfig loads configuration from environment variables with safe defaults.
func LoadConfig() (*Config, error) {
	env := getEnv("ENV", "development")

	port := getEnv("PORT", "8080")
	if !strings.HasPrefix(port, ":") && !strings.Contains(port, ":") {
		port = ":" + port
	}

	// Secret management & rotation support
	hmacSecret := os.Getenv("GATEWAY_HMAC_SECRET")
	keyID := getEnv("GATEWAY_HMAC_KEY_ID", "v1")
	keys := make(map[string][]byte)

	if hmacSecret == "" {
		if env == "production" {
			// Auto-generate cryptographically secure 32-byte secret if not provided to avoid crash-loops on initial deploy
			b := make([]byte, 32)
			if _, err := rand.Read(b); err == nil {
				keys[keyID] = b
			} else {
				keys[keyID] = []byte("vidlyte-production-default-secret-32b")
			}
		} else {
			// Dev deterministic fallback so restarting resolver during development doesn't invalidate tokens
			keys[keyID] = []byte("byse-dev-stable-secret-key-32byt")
		}
	} else {
		// Support comma-separated keyID:secret format for key rotation: e.g. "v1:secret1,v2:secret2"
		if strings.Contains(hmacSecret, ":") {
			pairs := strings.Split(hmacSecret, ",")
			for _, pair := range pairs {
				parts := strings.SplitN(strings.TrimSpace(pair), ":", 2)
				if len(parts) == 2 {
					keys[parts[0]] = []byte(parts[1])
				}
			}
		} else {
			keys[keyID] = []byte(hmacSecret)
		}
	}

	tokenTTL, err := time.ParseDuration(getEnv("GATEWAY_TOKEN_TTL", "15m"))
	if err != nil || tokenTTL <= 0 {
		tokenTTL = 15 * time.Minute
	}

	// SSRF Whitelist of allowed upstream hostnames (with dynamic domain resilience)
	hostsRaw := getEnv("GATEWAY_UPSTREAM_HOSTS", "img.animecurx.tech,sacdn.hakunaymatata.com,bcdn.hakunaymatata.com,embed.vidrift.net,mb.vidrift.net,api.framextv.xyz,api.framextv.cc,api.framextv.tech,framextv.cc,framextv.xyz,api.wing.st,cinejoy.pk,rumble.com,hugh.cdn.rumble.cloud,res.cloudinary.com,www.blogger.com,asianflix.one,api.themoviedb.org,127.0.0.1,localhost,cache.vdrk.site,vdrk.site,crap.hybrows.workers.dev,workers.dev")
	approvedHosts := make(map[string]bool)
	for _, h := range strings.Split(hostsRaw, ",") {
		h = strings.TrimSpace(strings.ToLower(h))
		if h != "" {
			approvedHosts[h] = true
		}
	}

	upstreamTimeout, err := time.ParseDuration(getEnv("GATEWAY_UPSTREAM_TIMEOUT", "10s"))
	if err != nil || upstreamTimeout <= 0 {
		upstreamTimeout = 10 * time.Second
	}

	upstreamMaxConns, _ := strconv.Atoi(getEnv("GATEWAY_UPSTREAM_MAX_CONNS", "100"))
	if upstreamMaxConns <= 0 {
		upstreamMaxConns = 100
	}

	cacheEnabled := strings.EqualFold(getEnv("GATEWAY_CACHE_ENABLED", "false"), "true")
	cacheDir := getEnv("GATEWAY_CACHE_DIR", "./scratch/hls_cache")
	cacheMaxMB, _ := strconv.ParseInt(getEnv("GATEWAY_CACHE_MAX_MB", "500"), 10, 64)
	if cacheMaxMB <= 0 {
		cacheMaxMB = 500
	}
	cacheMaxSizeBytes := cacheMaxMB * 1024 * 1024

	cacheTTL, err := time.ParseDuration(getEnv("GATEWAY_CACHE_TTL", "1h"))
	if err != nil || cacheTTL <= 0 {
		cacheTTL = 1 * time.Hour
	}

	logLevel := strings.ToLower(getEnv("LOG_LEVEL", "info"))

	bindClientIP := strings.EqualFold(getEnv("GATEWAY_BIND_CLIENT_IP", "false"), "true")
	rateLimitEnabled := strings.EqualFold(getEnv("GATEWAY_RATE_LIMIT_ENABLED", "true"), "true")
	rateLimitBurst, _ := strconv.Atoi(getEnv("GATEWAY_RATE_LIMIT_BURST", "100"))
	if rateLimitBurst <= 0 {
		rateLimitBurst = 100
	}
	rateLimitRate, _ := strconv.ParseFloat(getEnv("GATEWAY_RATE_LIMIT_RATE", "30.0"), 64)
	if rateLimitRate <= 0 {
		rateLimitRate = 30.0
	}

	return &Config{
		Port:              port,
		Env:               env,
		HMACKeys:          keys,
		PrimaryHMACKeyID:  keyID,
		TokenTTL:          tokenTTL,
		ApprovedHosts:     approvedHosts,
		UpstreamTimeout:   upstreamTimeout,
		UpstreamMaxConns:  upstreamMaxConns,
		CacheEnabled:      cacheEnabled,
		CacheDir:          cacheDir,
		CacheMaxSizeBytes: cacheMaxSizeBytes,
		CacheDefaultTTL:   cacheTTL,
		LogLevel:          logLevel,
		BindClientIP:      bindClientIP,
		RateLimitEnabled:  rateLimitEnabled,
		RateLimitBurst:    rateLimitBurst,
		RateLimitRate:     rateLimitRate,
		TMDBAPIKey:        getEnv("TMDB_API_KEY", ""),
		UpstashRESTURLs:   splitCommaTrim(os.Getenv("UPSTASH_REDIS_REST_URLS")),
		UpstashRESTTokens: splitCommaTrim(os.Getenv("UPSTASH_REDIS_REST_TOKENS")),
	}, nil
}

func splitCommaTrim(s string) []string {
	if s == "" {
		return nil
	}
	var res []string
	for _, part := range strings.Split(s, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			res = append(res, trimmed)
		}
	}
	return res
}

// GenerateDevSecret returns a secure random hex string for development or tests.
func GenerateDevSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

// IsHostApproved verifies that a hostname is present in the SSRF whitelist,
// supporting exact matches, wildcard subdomains (*.example.com), and resilient domain families (surviving TLD changes).
func (c *Config) IsHostApproved(host string) bool {
	// Strip port if present
	if strings.Contains(host, ":") {
		host = strings.Split(host, ":")[0]
	}
	host = strings.ToLower(strings.TrimSpace(host))

	c.mu.RLock()
	defer c.mu.RUnlock()

	// 1. Direct whitelist match
	if c.ApprovedHosts[host] {
		return true
	}

	// 2. Subdomain wildcard matching (*.domain.com or sub.domain.com)
	for approved := range c.ApprovedHosts {
		if strings.HasPrefix(approved, "*.") {
			suffix := approved[1:]
			if strings.HasSuffix(host, suffix) {
				return true
			}
		} else if strings.HasSuffix(host, "."+approved) {
			return true
		}
	}

	// 3. Resilient domain family matching (survives TLD rotations: .net -> .to -> .cc -> .is -> .xyz)
	resilienceFamilies := []string{"vidrift.", "framextv.", "hakunaymatata.", "animecurx.", "wing.st", "wecollege.net", "movy.bz", "strem.io", "rumble.", "asianflix.", "cloudinary.", "blogger.", "vdrk.site", "workers.dev"}
	for _, family := range resilienceFamilies {
		if strings.Contains(host, family) {
			return true
		}
	}

	return false
}

// AddApprovedHost adds a host to the dynamic SSRF whitelist.
func (c *Config) AddApprovedHost(host string) {
	if strings.Contains(host, ":") {
		host = strings.Split(host, ":")[0]
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ApprovedHosts[host] = true
}

// RemoveApprovedHost removes a host from the SSRF whitelist.
func (c *Config) RemoveApprovedHost(host string) {
	if strings.Contains(host, ":") {
		host = strings.Split(host, ":")[0]
	}
	host = strings.ToLower(strings.TrimSpace(host))
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.ApprovedHosts, host)
}

// GetApprovedHosts returns a sorted slice of all currently approved upstream hosts.
func (c *Config) GetApprovedHosts() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	list := make([]string, 0, len(c.ApprovedHosts))
	for h := range c.ApprovedHosts {
		list = append(list, h)
	}
	sort.Strings(list)
	return list
}

// UpdateSecuritySettings applies runtime anti-scraping policy adjustments without downtime.
func (c *Config) UpdateSecuritySettings(bindClientIP, rateLimitEnabled bool, burst int, rate float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.BindClientIP = bindClientIP
	c.RateLimitEnabled = rateLimitEnabled
	if burst > 0 {
		c.RateLimitBurst = burst
	}
	if rate > 0 {
		c.RateLimitRate = rate
	}
}

// GetSecuritySettings returns snapshot of current security settings.
func (c *Config) GetSecuritySettings() (bindClientIP, rateLimitEnabled bool, burst int, rate float64) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.BindClientIP, c.RateLimitEnabled, c.RateLimitBurst, c.RateLimitRate
}

// String provides safe representation without leaking secrets
func (c *Config) String() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return fmt.Sprintf("Config[Port=%s, Env=%s, TokenTTL=%s, UpstreamHosts=%d, CacheEnabled=%t, CacheMaxMB=%d]",
		c.Port, c.Env, c.TokenTTL, len(c.ApprovedHosts), c.CacheEnabled, c.CacheMaxSizeBytes/(1024*1024))
}
