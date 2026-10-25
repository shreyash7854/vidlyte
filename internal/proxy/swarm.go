package proxy

import (
	"context"
	"fmt"
	"hash/fnv"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"byse-resolver/internal/config"
	"byse-resolver/internal/parser"
)

// WorkerProbeResult contains health telemetry for an edge worker.
type WorkerProbeResult struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Healthy   bool   `json:"healthy"`
	LatencyMs int64  `json:"latency_ms"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

// SwarmBalancer orchestrates request distribution across distributed Cloudflare Worker edge nodes.
type SwarmBalancer struct {
	store      *config.ConfigStore
	rrCounter  uint32
	httpClient *http.Client
}

// NewSwarmBalancer creates an operational proxy swarm load balancer.
func NewSwarmBalancer(store *config.ConfigStore) *SwarmBalancer {
	return &SwarmBalancer{
		store: store,
		httpClient: &http.Client{
			Timeout: 4 * time.Second,
		},
	}
}

// HasActiveWorkers returns true if the swarm is enabled and at least one worker is configured.
func (sb *SwarmBalancer) HasActiveWorkers() bool {
	if sb.store == nil {
		return false
	}
	cfg := sb.store.Get().ProxySwarm
	if !cfg.Enabled {
		return false
	}
	for _, w := range cfg.Workers {
		if w.Enabled && strings.TrimSpace(w.URL) != "" {
			return true
		}
	}
	return false
}

// GetWorkerPool returns the currently active, healthy worker candidates.
func (sb *SwarmBalancer) GetWorkerPool() ([]config.ProxyWorker, bool) {
	if sb.store == nil {
		return nil, false
	}

	cfg := sb.store.Get().ProxySwarm
	if !cfg.Enabled || len(cfg.Workers) == 0 {
		return nil, false
	}

	var active []config.ProxyWorker
	for _, w := range cfg.Workers {
		if w.Enabled && strings.TrimSpace(w.URL) != "" {
			active = append(active, w)
		}
	}

	if len(active) == 0 {
		return nil, false
	}

	var healthy []config.ProxyWorker
	for _, w := range active {
		if w.Failures < 5 {
			healthy = append(healthy, w)
		}
	}

	if len(healthy) == 0 {
		return active, true
	}
	return healthy, true
}

// GetWorkerForKey selects a worker deterministically for a specific chunk or key using Rendezvous (HRW) Hashing.
func (sb *SwarmBalancer) GetWorkerForKey(key string) (*config.ProxyWorker, bool) {
	pool, ok := sb.GetWorkerPool()
	if !ok || len(pool) == 0 {
		return nil, false
	}

	if len(pool) == 1 {
		selected := pool[0]
		return &selected, true
	}

	// Highest Random Weight (HRW) consistent hashing
	var bestWorker *config.ProxyWorker
	var bestScore float64 = -1.0

	for i := range pool {
		w := &pool[i]
		score := hrwScore(key, w.URL)
		weight := float64(w.Weight)
		if weight <= 0 {
			weight = 10.0
		}
		// Weight multiplier normalizes around 1.0 (weight 10 = 1.0x)
		weightedScore := float64(score) * (weight / 10.0)
		if weightedScore > bestScore {
			bestScore = weightedScore
			bestWorker = w
		}
	}

	if bestWorker != nil {
		selected := *bestWorker
		return &selected, true
	}

	selected := pool[0]
	return &selected, true
}

func hrwScore(key, node string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(key))
	h.Write([]byte("::"))
	h.Write([]byte(node))
	return h.Sum64()
}

// GetNextWorker selects an edge worker based on the configured strategy.
func (sb *SwarmBalancer) GetNextWorker() (*config.ProxyWorker, bool) {
	pool, ok := sb.GetWorkerPool()
	if !ok || len(pool) == 0 {
		return nil, false
	}

	cfg := sb.store.Get().ProxySwarm
	strategy := strings.ToLower(cfg.Strategy)

	switch strategy {
	case "consistent_hash":
		// Random fallback if no specific key was provided
		fallthrough

	case "round_robin":
		idx := atomic.AddUint32(&sb.rrCounter, 1)
		selected := pool[int(idx)%len(pool)]
		return &selected, true

	case "latency":
		var best *config.ProxyWorker
		for i := range pool {
			w := &pool[i]
			if w.LatencyMs > 0 {
				if best == nil || w.LatencyMs < best.LatencyMs {
					best = w
				}
			}
		}
		if best != nil {
			return best, true
		}
		fallthrough

	case "random":
		fallthrough
	default:
		totalWeight := 0
		for _, w := range pool {
			weight := w.Weight
			if weight <= 0 {
				weight = 10
			}
			totalWeight += weight
		}

		if totalWeight <= 0 {
			selected := pool[rand.Intn(len(pool))]
			return &selected, true
		}

		r := rand.Intn(totalWeight)
		cumulative := 0
		for i := range pool {
			weight := pool[i].Weight
			if weight <= 0 {
				weight = 10
			}
			cumulative += weight
			if r < cumulative {
				return &pool[i], true
			}
		}

		selected := pool[rand.Intn(len(pool))]
		return &selected, true
	}
}

// IsWorkerCompatible determines whether an upstream media URI can be routed to a public Cloudflare edge worker.
// Cloudflare Workers (AS13335) are strictly blocked by upstream origins like embed.vidrift.net via Cloudflare WAF.
// Such streams must be proxied directly by the sovereign Go backend to avoid 403 Forbidden errors.
func IsWorkerCompatible(rawURL, provider string) bool {
	u := strings.ToLower(rawURL)
	p := strings.ToLower(provider)
	if strings.Contains(u, "embed.vidrift.net") || strings.Contains(u, "vidrift") || p == "orion" || p == "vidrift" {
		return false
	}
	return true
}

// BuildProxiedURLForKey constructs an edge-proxied URI deterministically for a specific segment or cache key.
func (sb *SwarmBalancer) BuildProxiedURLForKey(rawURL, provider, key string) string {
	if rawURL == "" {
		return ""
	}

	if !IsWorkerCompatible(rawURL, provider) {
		return ""
	}

	worker, ok := sb.GetWorkerForKey(key)
	if !ok || worker == nil {
		return parser.BuildProxyURL(rawURL, provider)
	}

	return FormatWorkerURL(worker.URL, rawURL, provider)
}

// BuildProxiedURL constructs a proxied URI, routing through an edge worker or falling back to local /proxy.
func (sb *SwarmBalancer) BuildProxiedURL(rawURL, provider string) string {
	if rawURL == "" {
		return ""
	}

	if !IsWorkerCompatible(rawURL, provider) {
		return parser.BuildProxyURL(rawURL, provider)
	}

	worker, ok := sb.GetNextWorker()
	if !ok || worker == nil {
		return parser.BuildProxyURL(rawURL, provider)
	}

	return FormatWorkerURL(worker.URL, rawURL, provider)
}

// FormatWorkerURL formats a target raw URL with the given worker URL template.
func FormatWorkerURL(workerURL, rawURL, provider string) string {
	workerURL = strings.TrimSpace(workerURL)
	escapedTarget := url.QueryEscape(rawURL)
	escapedProvider := url.QueryEscape(provider)

	if strings.HasSuffix(workerURL, "?url=") || strings.HasSuffix(workerURL, "&url=") {
		return fmt.Sprintf("%s%s&provider=%s", workerURL, escapedTarget, escapedProvider)
	}
	if strings.Contains(workerURL, "?") {
		return fmt.Sprintf("%s&url=%s&provider=%s", workerURL, escapedTarget, escapedProvider)
	}
	workerURL = strings.TrimRight(workerURL, "/")
	return fmt.Sprintf("%s?url=%s&provider=%s", workerURL, escapedTarget, escapedProvider)
}

// ProbeAllWorkers tests the latency and health of all registered edge workers concurrently.
func (sb *SwarmBalancer) ProbeAllWorkers(ctx context.Context) []WorkerProbeResult {
	if sb.store == nil {
		return nil
	}

	workers := sb.store.Get().ProxySwarm.Workers
	results := make([]WorkerProbeResult, len(workers))

	var wg sync.WaitGroup
	for i, w := range workers {
		wg.Add(1)
		go func(index int, worker config.ProxyWorker) {
			defer wg.Done()
			res := sb.probeSingleWorker(ctx, worker)
			results[index] = res
		}(i, w)
	}
	wg.Wait()

	// Update store with latest metrics
	_, _ = sb.store.Update(func(c *config.DynamicConfig) error {
		for _, res := range results {
			for j := range c.ProxySwarm.Workers {
				if c.ProxySwarm.Workers[j].ID == res.ID {
					c.ProxySwarm.Workers[j].LatencyMs = res.LatencyMs
					c.ProxySwarm.Workers[j].LastCheck = time.Now().UTC()
					if res.Healthy {
						c.ProxySwarm.Workers[j].Failures = 0
					} else {
						c.ProxySwarm.Workers[j].Failures++
					}
					break
				}
			}
		}
		return nil
	})

	return results
}

func (sb *SwarmBalancer) probeSingleWorker(ctx context.Context, w config.ProxyWorker) WorkerProbeResult {
	res := WorkerProbeResult{
		ID:  w.ID,
		URL: w.URL,
	}

	rawURL := strings.TrimSpace(w.URL)
	if rawURL == "" {
		res.Healthy = false
		res.Status = "Invalid URL"
		res.Error = "Worker URL is empty"
		return res
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		res.Healthy = false
		res.Status = "Invalid Scheme"
		res.Error = "Must start with http:// or https://"
		return res
	}

	// Construct probe URL
	probeURL := rawURL
	if strings.HasSuffix(probeURL, "?url=") || strings.HasSuffix(probeURL, "&url=") {
		probeURL = probeURL + url.QueryEscape("https://httpbin.org/status/200")
	} else if strings.Contains(probeURL, "?") {
		probeURL = probeURL + "&url=" + url.QueryEscape("https://httpbin.org/status/200")
	} else {
		probeURL = probeURL + "?url=" + url.QueryEscape("https://httpbin.org/status/200")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, probeURL, nil)
	if err != nil {
		res.Healthy = false
		res.Status = "Error"
		res.Error = err.Error()
		return res
	}
	req.Header.Set("User-Agent", "VidLyte-Swarm-Prober/1.0")

	start := time.Now()
	resp, err := sb.httpClient.Do(req)
	latency := time.Since(start).Milliseconds()
	res.LatencyMs = latency

	if err != nil {
		res.Healthy = false
		res.Status = "Unreachable"
		res.Error = err.Error()
		return res
	}
	defer resp.Body.Close()

	if resp.StatusCode < 400 || resp.StatusCode == http.StatusMethodNotAllowed {
		res.Healthy = true
		res.Status = fmt.Sprintf("HTTP %d OK (%dms)", resp.StatusCode, latency)
	} else {
		res.Healthy = false
		res.Status = fmt.Sprintf("HTTP %d Degraded", resp.StatusCode)
		res.Error = fmt.Sprintf("Received status code %d", resp.StatusCode)
	}

	return res
}
