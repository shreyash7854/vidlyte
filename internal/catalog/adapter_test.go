package catalog

import (
	"context"
	"testing"
	"time"

	"byse-resolver/internal/cache"
	"byse-resolver/internal/service"
)

func TestCatalogAdapter(t *testing.T) {
	memCache := cache.NewMemoryCache(10*time.Minute, 1*time.Minute)
	resolver := service.NewResolverService(memCache)
	adapter := NewAdapter(resolver)

	t.Run("ParseAssetID valid cases", func(t *testing.T) {
		req, err := ParseAssetID("tv/1399/1/1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if req.Type != "tv" || req.ID != "1399" || req.Season != 1 || req.Episode != 1 {
			t.Errorf("unexpected parsed media request: %+v", req)
		}

		mReq, err := ParseAssetID("movie/550")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if mReq.Type != "movie" || mReq.ID != "550" {
			t.Errorf("unexpected parsed movie request: %+v", mReq)
		}

		afReq, err := ParseAssetID("asianflix/make-me-tingle-2026/1/2")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if afReq.Type != "asianflix" || afReq.ID != "make-me-tingle-2026" || afReq.Season != 1 || afReq.Episode != 2 {
			t.Errorf("unexpected parsed asianflix request: %+v", afReq)
		}
	})

	t.Run("ParseAssetID invalid cases", func(t *testing.T) {
		invalidCases := []string{
			"",
			"invalid",
			"tv/1399/invalid/1",
			"tv/1399/1/-1",
			"unknown/123",
		}
		for _, tc := range invalidCases {
			_, err := ParseAssetID(tc)
			if err == nil {
				t.Errorf("expected error for case %q, got nil", tc)
			}
		}
	})

	t.Run("ResolveAsset known title", func(t *testing.T) {
		info, err := adapter.ResolveAsset(context.Background(), "tv/1399/1/1")
		if err != nil {
			t.Fatalf("ResolveAsset failed: %v", err)
		}
		if info.AssetID != "tv/1399/1/1" {
			t.Errorf("expected assetID tv/1399/1/1, got %s", info.AssetID)
		}
		if info.PrimaryManifest == "" {
			t.Errorf("expected non-empty PrimaryManifest")
		}
	})

	t.Run("Register and Lookup Resource", func(t *testing.T) {
		assetID := "tv/1399/1/1"
		upstreamURI := "https://img.animecurx.tech/tvshows/ee3c2a52662960708707/tiles.m3u8"
		provider := "evion"

		resID := adapter.RegisterResource(assetID, upstreamURI, provider)
		if resID == "" {
			t.Fatalf("expected non-empty resource ID")
		}

		entry, ok := adapter.LookupResource(assetID, resID)
		if !ok {
			t.Fatalf("LookupResource failed to find registered resource")
		}
		if entry.UpstreamURI != upstreamURI {
			t.Errorf("expected upstream URI %s, got %s", upstreamURI, entry.UpstreamURI)
		}
		if entry.Provider != provider {
			t.Errorf("expected provider %s, got %s", provider, entry.Provider)
		}

		// Lookup with wrong assetID must fail
		_, ok = adapter.LookupResource("tv/99999/1/1", resID)
		if ok {
			t.Errorf("expected lookup with wrong assetID to fail")
		}
	})
}
