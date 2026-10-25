package diskcache

import (
	"bytes"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCachePolicyEvaluation(t *testing.T) {
	t.Run("Allow public cacheable response with max-age", func(t *testing.T) {
		h := http.Header{}
		h.Set("Cache-Control", "public, max-age=3600")
		policy := EvaluatePolicy(http.StatusOK, h, time.Minute)
		if !policy.IsCacheable {
			t.Errorf("expected cacheable policy")
		}
		if policy.TTL != time.Hour {
			t.Errorf("expected 1h TTL, got %v", policy.TTL)
		}
	})

	t.Run("Disallow no-store", func(t *testing.T) {
		h := http.Header{}
		h.Set("Cache-Control", "no-store, no-cache")
		policy := EvaluatePolicy(http.StatusOK, h, time.Minute)
		if policy.IsCacheable {
			t.Errorf("expected uncacheable policy for no-store")
		}
	})

	t.Run("Disallow private", func(t *testing.T) {
		h := http.Header{}
		h.Set("Cache-Control", "private, max-age=60")
		policy := EvaluatePolicy(http.StatusOK, h, time.Minute)
		if policy.IsCacheable {
			t.Errorf("expected uncacheable policy for private")
		}
	})

	t.Run("Disallow Vary: * and Vary: Authorization", func(t *testing.T) {
		h := http.Header{}
		h.Set("Cache-Control", "public, max-age=60")
		h.Set("Vary", "Authorization")
		policy := EvaluatePolicy(http.StatusOK, h, time.Minute)
		if policy.IsCacheable {
			t.Errorf("expected uncacheable policy for Vary: Authorization")
		}
	})

	t.Run("Disallow non-200 OK responses", func(t *testing.T) {
		h := http.Header{}
		h.Set("Cache-Control", "public, max-age=3600")
		policy := EvaluatePolicy(http.StatusPartialContent, h, time.Minute)
		if policy.IsCacheable {
			t.Errorf("expected uncacheable policy for 206 Partial Content")
		}
	})
}

func TestDiskCacheStorage(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "hls-cache-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dc, err := NewDiskCache(tempDir, 1024*1024, 10*time.Minute)
	if err != nil {
		t.Fatalf("NewDiskCache failed: %v", err)
	}

	key := "https://img.animecurx.tech/tvshows/test/seg1.ts"
	payload := []byte("binary-ts-video-segment-payload")
	headers := http.Header{}
	headers.Set("Content-Type", "video/mp2t")

	t.Run("Put and Get entry", func(t *testing.T) {
		entry, err := dc.Put(key, bytes.NewReader(payload), headers, 5*time.Minute)
		if err != nil {
			t.Fatalf("Put failed: %v", err)
		}

		if entry.Meta.ContentLength != int64(len(payload)) {
			t.Errorf("expected content length %d, got %d", len(payload), entry.Meta.ContentLength)
		}

		fetched, ok := dc.Get(key)
		if !ok {
			t.Fatalf("Get failed to retrieve cached entry")
		}

		readBytes, err := os.ReadFile(fetched.FilePath)
		if err != nil {
			t.Fatalf("ReadFile failed: %v", err)
		}
		if !bytes.Equal(readBytes, payload) {
			t.Errorf("payload mismatch")
		}
	})

	t.Run("Expired entry returns false", func(t *testing.T) {
		expiredKey := "https://test.com/expired.ts"
		_, err := dc.PutWithExpiry(expiredKey, bytes.NewReader(payload), headers, time.Now().Add(-10*time.Second))
		if err != nil {
			t.Fatalf("PutWithExpiry failed: %v", err)
		}

		_, ok := dc.Get(expiredKey)
		if ok {
			t.Errorf("expected expired entry to return ok=false")
		}
	})

	t.Run("Concurrent coalescing (singleflight)", func(t *testing.T) {
		var executions int64
		var wg sync.WaitGroup

		coalesceKey := "https://test.com/coalesce.ts"

		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, _ = dc.DoCoalesced(coalesceKey, func() (any, error) {
					time.Sleep(20 * time.Millisecond) // Simulate network latency
					atomic.AddInt64(&executions, 1)
					return "done", nil
				})
			}()
		}

		wg.Wait()

		if atomic.LoadInt64(&executions) != 1 {
			t.Errorf("expected singleflight to coalesce to 1 execution, got: %d", executions)
		}
	})
}
