package gateway

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"byse-resolver/internal/observability"
)

func BenchmarkGatewayThroughput(b *testing.B) {
	// Setup local mock upstream server
	segmentData := make([]byte, 64*1024) // 64 KB segment
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(segmentData)
	}))
	defer upstreamServer.Close()

	gw, sessMgr, catAdapter, _ := setupTestGateway(nil, upstreamServer.URL, true)
	mux := http.NewServeMux()
	gw.RegisterRoutes(mux)

	assetID := "tv/1399/1/1"
	token, _ := sessMgr.IssueToken(assetID, 15*time.Minute)
	resID := catAdapter.RegisterResource(assetID, upstreamServer.URL+"/seg.ts", "evion")
	uri := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resID, token)

	b.ResetTimer()
	b.ReportAllocs()

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			req := httptest.NewRequest("GET", uri, nil)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				b.Errorf("expected 200 OK, got: %d", rec.Code)
			}
		}
	})
}

func TestReproducibleLoadTest(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping load test in short mode")
	}

	segmentData := make([]byte, 32*1024) // 32 KB chunk
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(segmentData)
	}))
	defer upstreamServer.Close()

	gw, sessMgr, catAdapter, _ := setupTestGateway(t, upstreamServer.URL, true)
	mux := http.NewServeMux()
	gw.RegisterRoutes(mux)

	assetID := "tv/1399/1/1"
	token, _ := sessMgr.IssueToken(assetID, 15*time.Minute)
	resID := catAdapter.RegisterResource(assetID, upstreamServer.URL+"/load_seg.ts", "evion")
	uri := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resID, token)

	const totalRequests = 2000
	const concurrency = 20

	latencies := make([]time.Duration, totalRequests)
	var errCount int64
	var completedCount int64

	start := time.Now()
	ch := make(chan int, totalRequests)
	for i := 0; i < totalRequests; i++ {
		ch <- i
	}
	close(ch)

	var wg sync.WaitGroup
	for c := 0; c < concurrency; c++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range ch {
				reqStart := time.Now()
				req := httptest.NewRequest("GET", uri, nil)
				rec := httptest.NewRecorder()
				mux.ServeHTTP(rec, req)
				lat := time.Since(reqStart)

				latencies[idx] = lat
				if rec.Code != http.StatusOK {
					atomic.AddInt64(&errCount, 1)
				}
				atomic.AddInt64(&completedCount, 1)
			}
		}()
	}
	wg.Wait()
	totalDuration := time.Since(start)

	// Calculate metrics
	sort.Slice(latencies, func(i, j int) bool {
		return latencies[i] < latencies[j]
	})

	var sum time.Duration
	for _, l := range latencies {
		sum += l
	}
	avgLat := sum / time.Duration(totalRequests)
	p50 := latencies[int(float64(totalRequests)*0.50)]
	p95 := latencies[int(float64(totalRequests)*0.95)]
	p99 := latencies[int(float64(totalRequests)*0.99)]
	rps := float64(totalRequests) / totalDuration.Seconds()
	errorRate := (float64(errCount) / float64(totalRequests)) * 100.0

	snap := observability.DefaultMetrics.Snapshot()
	cacheHitRatio := 0.0
	if snap.CacheHits+snap.CacheMisses > 0 {
		cacheHitRatio = (float64(snap.CacheHits) / float64(snap.CacheHits+snap.CacheMisses)) * 100.0
	}

	t.Logf("\n--- GATEWAY REPRODUCIBLE LOAD TEST REPORT ---")
	t.Logf("Total Requests:   %d (Concurrency: %d)", totalRequests, concurrency)
	t.Logf("Total Duration:   %v", totalDuration)
	t.Logf("Throughput:       %.2f req/sec", rps)
	t.Logf("Error Rate:       %.2f%% (%d errors)", errorRate, errCount)
	t.Logf("Latency Avg:      %v", avgLat)
	t.Logf("Latency p50:      %v", p50)
	t.Logf("Latency p95:      %v", p95)
	t.Logf("Latency p99:      %v", p99)
	t.Logf("Cache Hit Ratio:  %.2f%%", cacheHitRatio)
	t.Logf("Bytes Streamed:   %d KB", snap.BytesStreamed/1024)
	t.Logf("--------------------------------------------\n")

	if errorRate > 0 {
		t.Errorf("expected 0%% error rate, got: %.2f%%", errorRate)
	}
}
