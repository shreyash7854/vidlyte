package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"byse-resolver/internal/config"
)

func TestSwarmBalancer_FallbackToLocal(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := config.NewConfigStore(filepath.Join(tmpDir, "cfg.json"))
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}

	// Disable swarm
	_, _ = store.Update(func(c *config.DynamicConfig) error {
		c.ProxySwarm.Enabled = false
		return nil
	})

	sb := NewSwarmBalancer(store)
	target := "https://example.com/playlist.m3u8"
	proxied := sb.BuildProxiedURL(target, "orion")

	if !strings.HasPrefix(proxied, "/proxy?url=") {
		t.Errorf("expected local fallback /proxy?url=, got: %s", proxied)
	}
	if !strings.Contains(proxied, "provider=orion") {
		t.Errorf("expected provider=orion in URL, got: %s", proxied)
	}
}

func TestSwarmBalancer_WorkerRouting(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := config.NewConfigStore(filepath.Join(tmpDir, "cfg.json"))
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}

	worker1 := "https://cf-worker-1.workers.dev/proxy?url="
	worker2 := "https://cf-worker-2.workers.dev/proxy?url="

	_, _ = store.Update(func(c *config.DynamicConfig) error {
		c.ProxySwarm.Enabled = true
		c.ProxySwarm.Strategy = "round_robin"
		c.ProxySwarm.Workers = []config.ProxyWorker{
			{ID: "w1", Name: "Worker 1", URL: worker1, Enabled: true, Weight: 10},
			{ID: "w2", Name: "Worker 2", URL: worker2, Enabled: true, Weight: 10},
		}
		return nil
	})

	sb := NewSwarmBalancer(store)
	target := "https://upstream.cdn.net/hls/master.m3u8"

	url1 := sb.BuildProxiedURL(target, "framex")
	url2 := sb.BuildProxiedURL(target, "framex")

	if !strings.HasPrefix(url1, "https://cf-worker-") {
		t.Fatalf("expected worker URL prefix, got %s", url1)
	}
	if !strings.HasPrefix(url2, "https://cf-worker-") {
		t.Fatalf("expected worker URL prefix, got %s", url2)
	}
	if url1 == url2 {
		t.Errorf("expected round_robin to rotate between workers, got same: %s", url1)
	}
}

func TestIsWorkerCompatible(t *testing.T) {
	// Vidrift origins block Cloudflare Workers (AS13335)
	if IsWorkerCompatible("https://embed.vidrift.net/api/orion/stream.m4s", "orion") {
		t.Errorf("expected embed.vidrift.net to be flagged as incompatible with workers")
	}
	if IsWorkerCompatible("https://cdn.example.com/stream.m4s", "orion") {
		t.Errorf("expected orion provider to be flagged as incompatible with workers")
	}

	// Other CDNs are worker-compatible
	if !IsWorkerCompatible("https://api.framextv.xyz/stream.m3u8", "framex") {
		t.Errorf("expected framex to be worker compatible")
	}
	if !IsWorkerCompatible("https://blogger.googleusercontent.com/video.mp4", "asianflix") {
		t.Errorf("expected asianflix to be worker compatible")
	}
}

func TestSwarmBalancer_ProbeWorkers(t *testing.T) {
	// Create mock worker HTTP server
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	}))
	defer mockServer.Close()

	tmpDir := t.TempDir()
	store, err := config.NewConfigStore(filepath.Join(tmpDir, "cfg.json"))
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}

	_, _ = store.Update(func(c *config.DynamicConfig) error {
		c.ProxySwarm.Workers = []config.ProxyWorker{
			{ID: "mock-worker", Name: "Mock Worker", URL: mockServer.URL + "/proxy?url=", Enabled: true},
		}
		return nil
	})

	sb := NewSwarmBalancer(store)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	results := sb.ProbeAllWorkers(ctx)
	if len(results) != 1 {
		t.Fatalf("expected 1 probe result, got %d", len(results))
	}
	if !results[0].Healthy {
		t.Errorf("expected mock worker to be healthy, got status: %s (err: %s)", results[0].Status, results[0].Error)
	}
}

func TestSwarmBalancer_ConsistentHashing(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := config.NewConfigStore(filepath.Join(tmpDir, "cfg.json"))
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}

	w1 := "https://cf-node-1.workers.dev/?url="
	w2 := "https://cf-node-2.workers.dev/?url="
	w3 := "https://cf-node-3.workers.dev/?url="

	_, _ = store.Update(func(c *config.DynamicConfig) error {
		c.ProxySwarm.Enabled = true
		c.ProxySwarm.Strategy = "consistent_hash"
		c.ProxySwarm.Workers = []config.ProxyWorker{
			{ID: "w1", Name: "Node 1", URL: w1, Enabled: true, Weight: 10},
			{ID: "w2", Name: "Node 2", URL: w2, Enabled: true, Weight: 10},
			{ID: "w3", Name: "Node 3", URL: w3, Enabled: true, Weight: 10},
		}
		return nil
	})

	sb := NewSwarmBalancer(store)

	// Test determinism: the exact same key must ALWAYS route to the exact same worker
	chunkKey := "tv/289423/1/1/chunk_0042.ts"
	workerA, okA := sb.GetWorkerForKey(chunkKey)
	if !okA || workerA == nil {
		t.Fatalf("expected worker selected")
	}

	workerB, okB := sb.GetWorkerForKey(chunkKey)
	if !okB || workerB == nil {
		t.Fatalf("expected worker selected")
	}

	if workerA.URL != workerB.URL {
		t.Errorf("HRW hashing must be deterministic for identical key: got %s vs %s", workerA.URL, workerB.URL)
	}

	// Test distribution across multiple chunks
	counts := make(map[string]int)
	for i := 0; i < 300; i++ {
		k := filepath.Join("movie/550", "seg_") + string(rune('A'+(i%26))) + string(rune('0'+(i%10)))
		w, ok := sb.GetWorkerForKey(k)
		if ok && w != nil {
			counts[w.ID]++
		}
	}

	// Verify all 3 workers got traffic
	if len(counts) < 3 {
		t.Errorf("expected all 3 workers to receive traffic under HRW hashing, got: %+v", counts)
	}
}

