package tmdb

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"byse-resolver/internal/parser"
)

var (
	nonAlphanumericRegex = regexp.MustCompile(`[^a-z0-9]+`)
	asianflixSlugRegex   = regexp.MustCompile(`href="https:\/\/asianflix\.one\/([a-z0-9\-]+)\/"`)
)

type slugCacheEntry struct {
	slug      string
	expiresAt time.Time
}

// SlugResolver translates numeric TMDB IDs into URL slugs for AsianFlix fallback.
type SlugResolver struct {
	apiKey     string
	httpClient *http.Client
	cache      map[string]slugCacheEntry
	mu         sync.RWMutex
}

// NewSlugResolver creates a SlugResolver instance with in-memory TTL caching.
func NewSlugResolver(apiKey string) *SlugResolver {
	return &SlugResolver{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 4 * time.Second,
		},
		cache: make(map[string]slugCacheEntry),
	}
}

// Slugify converts a title string and optional release year to a clean URL slug.
func Slugify(title, year string) string {
	clean := strings.ToLower(title)
	clean = nonAlphanumericRegex.ReplaceAllString(clean, "-")
	clean = strings.Trim(clean, "-")

	if year != "" && !strings.Contains(clean, year) {
		clean = clean + "-" + year
	}
	return clean
}

// IsNumeric checks if the ID consists solely of digits (TMDB ID format).
func IsNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// ResolveSlug returns the slug for a given media request ID.
func (r *SlugResolver) ResolveSlug(ctx context.Context, mediaType, id string) (string, error) {
	// If id is already a slug (e.g. "make-me-tingle-2026" or "asianflix:make-me-tingle"), strip prefixes and return
	cleanID := strings.TrimPrefix(id, "asianflix:")
	cleanID = strings.TrimPrefix(cleanID, "af:")
	cleanID = strings.Trim(cleanID, "/")

	if !IsNumeric(cleanID) {
		return cleanID, nil
	}

	// Check cache
	cacheKey := mediaType + ":" + cleanID
	r.mu.RLock()
	entry, found := r.cache[cacheKey]
	r.mu.RUnlock()
	if found && time.Now().Before(entry.expiresAt) {
		return entry.slug, nil
	}

	// 1. If TMDB API key is configured, fetch canonical title and air year
	if r.apiKey != "" {
		tmdbSlug, err := r.fetchTMDBTitle(ctx, mediaType, cleanID)
		if err == nil && tmdbSlug != "" {
			// Cross-verify with AsianFlix search to ensure slug matches
			matchedSlug, err2 := r.searchAsianFlix(ctx, tmdbSlug)
			if err2 == nil && matchedSlug != "" {
				r.setCache(cacheKey, matchedSlug)
				return matchedSlug, nil
			}
			r.setCache(cacheKey, tmdbSlug)
			return tmdbSlug, nil
		}
	}

	// 2. Query AsianFlix search with the numeric ID
	afSlug, err := r.searchAsianFlix(ctx, cleanID)
	if err == nil && afSlug != "" {
		r.setCache(cacheKey, afSlug)
		return afSlug, nil
	}

	// Default fallback: return clean ID
	return cleanID, nil
}

func (r *SlugResolver) setCache(key, slug string) {
	r.mu.Lock()
	r.cache[key] = slugCacheEntry{
		slug:      slug,
		expiresAt: time.Now().Add(24 * time.Hour),
	}
	r.mu.Unlock()
}

type tmdbDetailResponse struct {
	Name         string `json:"name"`
	Title        string `json:"title"`
	FirstAirDate string `json:"first_air_date"`
	ReleaseDate  string `json:"release_date"`
}

func (r *SlugResolver) fetchTMDBTitle(ctx context.Context, mediaType, id string) (string, error) {
	endpointType := "tv"
	if mediaType == "movie" {
		endpointType = "movie"
	}

	reqURL := fmt.Sprintf("https://api.themoviedb.org/3/%s/%s?api_key=%s", endpointType, id, r.apiKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("tmdb api returned status %d", resp.StatusCode)
	}

	var detail tmdbDetailResponse
	if err := json.NewDecoder(resp.Body).Decode(&detail); err != nil {
		return "", err
	}

	title := detail.Name
	if title == "" {
		title = detail.Title
	}

	dateStr := detail.FirstAirDate
	if dateStr == "" {
		dateStr = detail.ReleaseDate
	}

	var year string
	if len(dateStr) >= 4 {
		year = dateStr[:4]
	}

	return Slugify(title, year), nil
}

// searchAsianFlix searches AsianFlix by query text and returns the top matching post slug.
func (r *SlugResolver) searchAsianFlix(ctx context.Context, query string) (string, error) {
	searchURL := fmt.Sprintf("https://asianflix.one/?s=%s", url.QueryEscape(query))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, searchURL, nil)
	if err != nil {
		return "", err
	}

	req.Header.Set("User-Agent", parser.BrowserUserAgent)
	req.Header.Set("Referer", "https://asianflix.one/")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("asianflix search returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return "", err
	}

	matches := asianflixSlugRegex.FindAllStringSubmatch(string(body), -1)
	for _, m := range matches {
		if len(m) > 1 {
			candidate := m[1]
			// Exclude common WordPress taxonomy slugs
			if candidate != "wp-admin" && candidate != "feed" && candidate != "category" && candidate != "tag" && candidate != "wp-json" {
				return candidate, nil
			}
		}
	}

	return "", fmt.Errorf("no matching slug found on asianflix for query: %s", query)
}
