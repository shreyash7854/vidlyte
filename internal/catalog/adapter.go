package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"byse-resolver/internal/models"
)

var (
	ErrInvalidAssetID  = errors.New("invalid asset ID format (expected tv/{id}/{season}/{episode} or movie/{id})")
	ErrAssetNotFound   = errors.New("asset not found or unauthorized")
	ErrResourceNotFound = errors.New("resource identifier not found or expired")
)

// ResourceEntry holds the mapped upstream target and provider context.
type ResourceEntry struct {
	UpstreamURI string
	Provider    string
	AssetID     string
	RegisteredAt time.Time
}

// AssetManifestInfo contains the resolved upstream master manifest and provider.
type AssetManifestInfo struct {
	AssetID         string
	PrimaryManifest string
	Provider        string
	Title           string
	Kicker          string
	Year            string
	Rating          string
	Genres          []string
	Overview        string
	LogoURL         string
	Subtitles       []models.SubtitleTrack
	AudioTracks     []models.AudioTrack
	Variants        []models.StreamVariant
	Providers       []models.ProviderStreams
	PlaybackToken   string
}

// SourceResolver defines the contract for resolving media requests into stream metadata.
type SourceResolver interface {
	Resolve(ctx context.Context, req models.MediaRequest) (*models.MediaResponse, error)
}

// Adapter bridges the distributor to the existing ResolverService and manages opaque resource IDs.
type Adapter struct {
	resolver   SourceResolver
	mu         sync.RWMutex
	resources  map[string]*ResourceEntry // key: assetID + ":" + resourceID
	maxEntries int
}

// NewAdapter initializes the catalog adapter.
func NewAdapter(resolver SourceResolver) *Adapter {
	return &Adapter{
		resolver:   resolver,
		resources:  make(map[string]*ResourceEntry),
		maxEntries: 50000,
	}
}

// ParseAssetID splits an asset ID string into a models.MediaRequest.
func ParseAssetID(assetID string) (*models.MediaRequest, error) {
	parts := strings.Split(strings.Trim(assetID, "/"), "/")
	if len(parts) == 0 {
		return nil, ErrInvalidAssetID
	}

	mediaType := parts[0]
	if mediaType == "tv" || mediaType == "anime" || mediaType == "asianflix" {
		if len(parts) != 4 {
			return nil, ErrInvalidAssetID
		}
		season, err1 := strconv.Atoi(parts[2])
		episode, err2 := strconv.Atoi(parts[3])
		if err1 != nil || err2 != nil || season < 1 || episode < 1 {
			return nil, ErrInvalidAssetID
		}
		return &models.MediaRequest{
			Type:    mediaType,
			ID:      parts[1],
			Season:  season,
			Episode: episode,
		}, nil
	} else if mediaType == "movie" {
		if len(parts) != 2 {
			return nil, ErrInvalidAssetID
		}
		return &models.MediaRequest{
			Type: "movie",
			ID:   parts[1],
		}, nil
	}

	return nil, ErrInvalidAssetID
}

// ResolveAsset calls the existing ResolverService to find the authorized upstream stream.
func (a *Adapter) ResolveAsset(ctx context.Context, assetID string) (*AssetManifestInfo, error) {
	req, err := ParseAssetID(assetID)
	if err != nil {
		return nil, err
	}

	mediaResp, err := a.resolver.Resolve(ctx, *req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAssetNotFound, err)
	}

	provider := "evion"
	if len(mediaResp.Providers) > 0 && mediaResp.Providers[0].Provider != "" {
		provider = mediaResp.Providers[0].Provider
	}

	manifestURL := mediaResp.PrimaryManifest
	if manifestURL == "" && len(mediaResp.Variants) > 0 {
		manifestURL = mediaResp.Variants[0].PlaylistURI
	}
	if manifestURL == "" {
		return nil, errors.New("no valid stream manifest resolved for asset")
	}

	return &AssetManifestInfo{
		AssetID:         assetID,
		PrimaryManifest: manifestURL,
		Provider:        provider,
		Title:           mediaResp.Title,
		Kicker:          mediaResp.Kicker,
		Year:            mediaResp.Year,
		Rating:          mediaResp.Rating,
		Genres:          mediaResp.Genres,
		Overview:        mediaResp.Overview,
		LogoURL:         mediaResp.LogoURL,
		Subtitles:       mediaResp.Subtitles,
		AudioTracks:     mediaResp.AudioTracks,
		Variants:        mediaResp.Variants,
		Providers:       mediaResp.Providers,
		PlaybackToken:   mediaResp.PlaybackToken,
	}, nil
}

// RegisterResource creates and stores a deterministic opaque resource ID mapped to the upstream URI.
func (a *Adapter) RegisterResource(assetID, upstreamURI, provider string) string {
	h := sha256.New()
	h.Write([]byte(assetID))
	h.Write([]byte(":"))
	h.Write([]byte(upstreamURI))
	resourceID := hex.EncodeToString(h.Sum(nil))[:24] // 24-char opaque identifier

	key := assetID + ":" + resourceID

	a.mu.Lock()
	defer a.mu.Unlock()

	// Simple bound eviction if table exceeds max capacity
	if len(a.resources) >= a.maxEntries {
		// Remove 1000 oldest
		count := 0
		for k := range a.resources {
			delete(a.resources, k)
			count++
			if count > 1000 {
				break
			}
		}
	}

	a.resources[key] = &ResourceEntry{
		UpstreamURI:  upstreamURI,
		Provider:     provider,
		AssetID:      assetID,
		RegisteredAt: time.Now(),
	}

	return resourceID
}

// LookupResource resolves an opaque resource ID back to its validated upstream URI.
func (a *Adapter) LookupResource(assetID, resourceID string) (*ResourceEntry, bool) {
	key := assetID + ":" + resourceID

	a.mu.RLock()
	entry, ok := a.resources[key]
	a.mu.RUnlock()

	return entry, ok
}

// Invalidator defines the optional capability of purging stale cached streams.
type Invalidator interface {
	Invalidate(req models.MediaRequest)
}

// InvalidateAsset clears any cached resolutions for an asset so fresh tokens are fetched.
func (a *Adapter) InvalidateAsset(assetID string) {
	req, err := ParseAssetID(assetID)
	if err != nil {
		return
	}
	if inv, ok := a.resolver.(Invalidator); ok {
		inv.Invalidate(*req)
	}
}
