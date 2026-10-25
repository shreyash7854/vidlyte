package cache

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestUpstashSwarm_HRWSelection(t *testing.T) {
	n1 := &UpstashNode{ID: "node1", RestURL: "https://db1.upstash.io", Token: "t1", Enabled: true}
	n2 := &UpstashNode{ID: "node2", RestURL: "https://db2.upstash.io", Token: "t2", Enabled: true}
	n3 := &UpstashNode{ID: "node3", RestURL: "https://db3.upstash.io", Token: "t3", Enabled: true}

	swarm := NewUpstashSwarm([]*UpstashNode{n1, n2, n3})

	// Determinism check: same key must always pick same primary
	key := "stream:tv:severance:s1e1"
	p1, s1 := swarm.SelectNodesForKey(key)
	p2, s2 := swarm.SelectNodesForKey(key)

	if p1.ID != p2.ID {
		t.Fatalf("expected deterministic primary node selection, got %s vs %s", p1.ID, p2.ID)
	}
	if s1.ID != s2.ID {
		t.Fatalf("expected deterministic secondary node selection, got %s vs %s", s1.ID, s2.ID)
	}
	if p1.ID == s1.ID {
		t.Fatalf("primary and secondary must not be the same node")
	}

	// Distribution check
	nodeCounts := make(map[string]int)
	for i := 0; i < 300; i++ {
		k := "movie:" + string(rune('0'+(i%10))) + string(rune('A'+(i%26)))
		p, _ := swarm.SelectNodesForKey(k)
		nodeCounts[p.ID]++
	}

	if len(nodeCounts) < 3 {
		t.Errorf("expected all 3 nodes to receive hashed keys, got counts: %+v", nodeCounts)
	}
}

func TestUpstashSwarm_GetAndSet(t *testing.T) {
	var mu sync.Mutex
	store := make(map[string]string)

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var cmd []any
		if err := json.NewDecoder(r.Body).Decode(&cmd); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		mu.Lock()
		defer mu.Unlock()

		op, _ := cmd[0].(string)
		switch op {
		case "GET":
			k, _ := cmd[1].(string)
			v, exists := store[k]
			if exists {
				_ = json.NewEncoder(w).Encode(map[string]any{"result": v})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"result": nil})
			}
		case "SET":
			k, _ := cmd[1].(string)
			v, _ := cmd[2].(string)
			store[k] = v
			_ = json.NewEncoder(w).Encode(map[string]any{"result": "OK"})
		case "DEL":
			k, _ := cmd[1].(string)
			delete(store, k)
			_ = json.NewEncoder(w).Encode(map[string]any{"result": 1})
		}
	}))
	defer mockServer.Close()

	n := &UpstashNode{
		ID:      "test-node",
		RestURL: mockServer.URL,
		Token:   "valid-token",
		Enabled: true,
	}

	swarm := NewUpstashSwarm([]*UpstashNode{n})
	ctx := context.Background()

	// Set value
	ok := swarm.Set(ctx, "test_key", "test_value_123", 300)
	if !ok {
		t.Fatalf("expected swarm.Set to succeed")
	}

	// Get value
	val, found := swarm.Get(ctx, "test_key")
	if !found || val != "test_value_123" {
		t.Errorf("expected 'test_value_123', got '%s' (found: %v)", val, found)
	}

	// Delete value
	swarm.Del(ctx, "test_key")
	_, foundAfterDel := swarm.Get(ctx, "test_key")
	if foundAfterDel {
		t.Errorf("expected key to be deleted")
	}
}

func TestTieredCache_L1L2Coordination(t *testing.T) {
	mem := NewMemoryCache(1*time.Minute, 1*time.Minute)

	var mu sync.Mutex
	upstashStore := map[string]string{
		"l2_only_key": "from_upstash_redis",
	}

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var cmd []any
		_ = json.NewDecoder(r.Body).Decode(&cmd)
		mu.Lock()
		defer mu.Unlock()

		op, _ := cmd[0].(string)
		if op == "GET" {
			k, _ := cmd[1].(string)
			if v, ok := upstashStore[k]; ok {
				_ = json.NewEncoder(w).Encode(map[string]any{"result": v})
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil})
	}))
	defer mockServer.Close()

	n := &UpstashNode{ID: "upstash1", RestURL: mockServer.URL, Token: "t", Enabled: true}
	swarm := NewUpstashSwarm([]*UpstashNode{n})

	tc := NewTieredCache(mem, swarm)
	ctx := context.Background()

	// 1. Query key that is only in L2 Upstash
	val, found := tc.Get(ctx, "l2_only_key")
	if !found || val != "from_upstash_redis" {
		t.Fatalf("expected to read from Upstash, got %s (found: %v)", val, found)
	}

	// 2. Query again: should now be backfilled into L1 memory!
	l1Val, l1Found := mem.Get("l2_only_key")
	if !l1Found || l1Val != "from_upstash_redis" {
		t.Errorf("expected L1 memory to be backfilled from L2")
	}
}
