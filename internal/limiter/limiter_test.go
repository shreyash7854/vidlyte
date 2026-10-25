package limiter

import (
	"sync"
	"testing"
	"time"
)

func TestRateLimiter(t *testing.T) {
	t.Run("Burst allowance and subsequent throttling", func(t *testing.T) {
		burst := 5
		rate := 2.0 // 2 tokens/sec
		rl := NewRateLimiter(rate, burst, 1*time.Minute)
		defer rl.Stop()

		ip := "192.0.2.1"

		// First 5 requests must pass
		for i := 0; i < burst; i++ {
			if !rl.Allow(ip) {
				t.Fatalf("request %d should have been allowed within burst", i+1)
			}
		}

		// 6th request immediately after burst should be throttled
		if rl.Allow(ip) {
			t.Fatalf("request immediately after burst should be rejected")
		}

		// Wait 600ms (should replenish ~1.2 tokens)
		time.Sleep(600 * time.Millisecond)

		if !rl.Allow(ip) {
			t.Fatalf("request after replenishment should be allowed")
		}
	})

	t.Run("Independent client IPs", func(t *testing.T) {
		rl := NewRateLimiter(1.0, 2, 1*time.Minute)
		defer rl.Stop()

		ipA := "198.51.100.1"
		ipB := "203.0.113.1"

		// Exhaust IP A
		if !rl.Allow(ipA) || !rl.Allow(ipA) {
			t.Fatal("expected IP A burst to succeed")
		}
		if rl.Allow(ipA) {
			t.Fatal("expected IP A to be throttled")
		}

		// IP B should be untouched
		if !rl.Allow(ipB) || !rl.Allow(ipB) {
			t.Fatal("expected IP B burst to succeed independently")
		}
	})

	t.Run("Concurrent access safety", func(t *testing.T) {
		rl := NewRateLimiter(10.0, 50, 1*time.Minute)
		defer rl.Stop()

		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_ = rl.Allow("10.0.0.1")
			}()
		}
		wg.Wait()
	})
}
