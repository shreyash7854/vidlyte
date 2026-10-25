package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// UpstashNode represents a single free-tier Upstash Redis database.
type UpstashNode struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	RestURL  string `json:"rest_url"`
	Token    string `json:"token"`
	Enabled  bool   `json:"enabled"`
	Failures uint32 `json:"failures"`
}

// UpstashSwarm manages a decentralized cluster of free Upstash Redis databases.
type UpstashSwarm struct {
	mu         sync.RWMutex
	nodes      []*UpstashNode
	httpClient *http.Client
}

// NewUpstashSwarm initializes an Upstash cluster.
func NewUpstashSwarm(nodes []*UpstashNode) *UpstashSwarm {
	return &UpstashSwarm{
		nodes: nodes,
		httpClient: &http.Client{
			Timeout: 2 * time.Second,
		},
	}
}

// AddNode registers a new Upstash Redis node to the swarm.
func (s *UpstashSwarm) AddNode(node *UpstashNode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes = append(s.nodes, node)
}

// SetNodes updates the active node list.
func (s *UpstashSwarm) SetNodes(nodes []*UpstashNode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes = nodes
}

// HasActiveNodes returns true if at least one Upstash node is configured and enabled.
func (s *UpstashSwarm) HasActiveNodes() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, n := range s.nodes {
		if n.Enabled && strings.TrimSpace(n.RestURL) != "" && strings.TrimSpace(n.Token) != "" {
			return true
		}
	}
	return false
}

func (s *UpstashSwarm) getHealthyNodes() []*UpstashNode {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var active []*UpstashNode
	for _, n := range s.nodes {
		if n.Enabled && strings.TrimSpace(n.RestURL) != "" && strings.TrimSpace(n.Token) != "" {
			active = append(active, n)
		}
	}

	var healthy []*UpstashNode
	for _, n := range active {
		if atomic.LoadUint32(&n.Failures) < 5 {
			healthy = append(healthy, n)
		}
	}

	if len(healthy) == 0 {
		return active
	}
	return healthy
}

func hrwNodeScore(key, nodeID string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(key))
	h.Write([]byte("::upstash::"))
	h.Write([]byte(nodeID))
	return h.Sum64()
}

// SelectNodesForKey selects the primary and fallback Upstash nodes for a given key using HRW hashing.
func (s *UpstashSwarm) SelectNodesForKey(key string) (*UpstashNode, *UpstashNode) {
	nodes := s.getHealthyNodes()
	if len(nodes) == 0 {
		return nil, nil
	}
	if len(nodes) == 1 {
		return nodes[0], nil
	}

	var primary, secondary *UpstashNode
	var bestScore, secondScore uint64

	for _, n := range nodes {
		score := hrwNodeScore(key, n.RestURL)
		if score > bestScore {
			secondScore = bestScore
			secondary = primary
			bestScore = score
			primary = n
		} else if score > secondScore {
			secondScore = score
			secondary = n
		}
	}

	return primary, secondary
}

type upstashCommandResponse struct {
	Result any    `json:"result"`
	Error  string `json:"error,omitempty"`
}

// Get retrieves a cached string value across the Upstash swarm.
func (s *UpstashSwarm) Get(ctx context.Context, key string) (string, bool) {
	primary, secondary := s.SelectNodesForKey(key)
	if primary == nil {
		return "", false
	}

	val, ok := s.executeGet(ctx, primary, key)
	if ok {
		return val, true
	}

	if secondary != nil {
		val2, ok2 := s.executeGet(ctx, secondary, key)
		if ok2 {
			return val2, true
		}
	}

	return "", false
}

func (s *UpstashSwarm) executeGet(ctx context.Context, node *UpstashNode, key string) (string, bool) {
	cmd := []any{"GET", key}
	cmdBytes, _ := json.Marshal(cmd)

	targetURL := strings.TrimRight(node.RestURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(cmdBytes))
	if err != nil {
		return "", false
	}
	req.Header.Set("Authorization", "Bearer "+node.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		atomic.AddUint32(&node.Failures, 1)
		return "", false
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		atomic.AddUint32(&node.Failures, 1)
		return "", false
	}

	var res upstashCommandResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", false
	}

	atomic.StoreUint32(&node.Failures, 0)

	if res.Result == nil {
		return "", false
	}

	if str, ok := res.Result.(string); ok {
		return str, true
	}

	return fmt.Sprintf("%v", res.Result), true
}

// Set stores a key-value pair with TTL in seconds.
func (s *UpstashSwarm) Set(ctx context.Context, key, value string, ttlSec int) bool {
	primary, _ := s.SelectNodesForKey(key)
	if primary == nil {
		return false
	}

	var cmd []any
	if ttlSec > 0 {
		cmd = []any{"SET", key, value, "EX", ttlSec}
	} else {
		cmd = []any{"SET", key, value}
	}

	cmdBytes, _ := json.Marshal(cmd)
	targetURL := strings.TrimRight(primary.RestURL, "/")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(cmdBytes))
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+primary.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		atomic.AddUint32(&primary.Failures, 1)
		return false
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		atomic.StoreUint32(&primary.Failures, 0)
		return true
	}

	atomic.AddUint32(&primary.Failures, 1)
	return false
}

// Del removes a key from the Upstash swarm.
func (s *UpstashSwarm) Del(ctx context.Context, key string) {
	primary, secondary := s.SelectNodesForKey(key)
	nodes := []*UpstashNode{primary}
	if secondary != nil {
		nodes = append(nodes, secondary)
	}

	for _, n := range nodes {
		if n == nil {
			continue
		}
		cmd := []any{"DEL", key}
		cmdBytes, _ := json.Marshal(cmd)
		targetURL := strings.TrimRight(n.RestURL, "/")

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(cmdBytes))
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+n.Token)
			req.Header.Set("Content-Type", "application/json")
			resp, err := s.httpClient.Do(req)
			if err == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}
	}
}

// TieredCache provides a multi-layer cache:
// Tier 1: Local In-Memory LRU (0ms latency, handles identical concurrent requests)
// Tier 2: Upstash Redis Swarm (15ms latency, distributed, survives restarts)
type TieredCache struct {
	memory  *MemoryCache
	upstash *UpstashSwarm
}

// NewTieredCache constructs a coordinated two-tier cache.
func NewTieredCache(mem *MemoryCache, swarm *UpstashSwarm) *TieredCache {
	return &TieredCache{
		memory:  mem,
		upstash: swarm,
	}
}

// Get queries L1 memory first, falling back to L2 Upstash.
func (tc *TieredCache) Get(ctx context.Context, key string) (string, bool) {
	// 1. Tier 1: In-Memory Go RAM (0ms)
	if val, ok := tc.memory.Get(key); ok {
		if str, ok := val.(string); ok {
			return str, true
		}
		return fmt.Sprintf("%v", val), true
	}

	// 2. Tier 2: Upstash Redis Swarm (~15ms)
	if tc.upstash != nil && tc.upstash.HasActiveNodes() {
		if val, ok := tc.upstash.Get(ctx, key); ok {
			// Backfill L1 memory cache (5m default TTL)
			tc.memory.SetWithTTL(key, val, 5*time.Minute)
			return val, true
		}
	}

	return "", false
}

// Set stores in L1 memory and asynchronously saves to L2 Upstash.
func (tc *TieredCache) Set(key, value string, ttl time.Duration) {
	// Write to L1 memory immediately
	tc.memory.SetWithTTL(key, value, ttl)

	// Write to L2 Upstash asynchronously without blocking user request
	if tc.upstash != nil && tc.upstash.HasActiveNodes() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			ttlSec := int(ttl.Seconds())
			tc.upstash.Set(ctx, key, value, ttlSec)
		}()
	}
}
