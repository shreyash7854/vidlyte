package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigStore_DefaultAndPersistence(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "test_config.json")

	store, err := NewConfigStore(cfgPath)
	if err != nil {
		t.Fatalf("failed to create config store: %v", err)
	}

	cfg := store.Get()
	if cfg.Site.BrandName != "VidLyte" {
		t.Errorf("expected default brand name VidLyte, got %s", cfg.Site.BrandName)
	}
	if !cfg.Monetization.PopundersEnabled {
		t.Errorf("expected popunders enabled by default")
	}

	// Update store
	_, err = store.Update(func(c *DynamicConfig) error {
		c.Site.BrandName = "VidLyte Pro"
		c.PlayerFleet.PrimaryDomain = "https://player.example.com"
		c.Monetization.MaxPopundersPerSession = 3
		return nil
	})
	if err != nil {
		t.Fatalf("failed to update config store: %v", err)
	}

	// Verify file was written
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		t.Fatalf("expected config file to exist at %s", cfgPath)
	}

	// Re-load in new instance
	store2, err := NewConfigStore(cfgPath)
	if err != nil {
		t.Fatalf("failed to re-load config store: %v", err)
	}
	cfg2 := store2.Get()
	if cfg2.Site.BrandName != "VidLyte Pro" {
		t.Errorf("expected persisted brand name VidLyte Pro, got %s", cfg2.Site.BrandName)
	}
	if cfg2.PlayerFleet.PrimaryDomain != "https://player.example.com" {
		t.Errorf("expected persisted primary domain, got %s", cfg2.PlayerFleet.PrimaryDomain)
	}
	if cfg2.Monetization.MaxPopundersPerSession != 3 {
		t.Errorf("expected max popunders 3, got %d", cfg2.Monetization.MaxPopundersPerSession)
	}
	if !cfg2.ProxySwarm.Enabled || len(cfg2.ProxySwarm.Workers) == 0 {
		t.Errorf("expected proxy swarm to be enabled with default workers")
	}
	if cfg2.ServerBranding.ServerAliases["orion"] == "" {
		t.Errorf("expected server branding with default Orion alias")
	}
}
