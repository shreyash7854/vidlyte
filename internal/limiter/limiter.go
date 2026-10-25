package limiter

import (
	"sync"
	"time"
)

// clientBucket holds the token-bucket state for a single client IP.
type clientBucket struct {
	tokens     float64
	lastUpdate time.Time
}

// RateLimiter implements a high-throughput, thread-safe in-memory token bucket limiter.
// It allows bursts for real player buffer initialization while throttling high-speed video scrapers.
type RateLimiter struct {
	mu         sync.RWMutex
	buckets    map[string]*clientBucket
	rate       float64       // Tokens replenished per second
	burst      float64       // Maximum bucket capacity
	cleanupTTL time.Duration // Eviction age for idle client entries
	stopChan   chan struct{}
}

// NewRateLimiter creates a new rate limiter with background cleanup.
func NewRateLimiter(rate float64, burst int, cleanupTTL time.Duration) *RateLimiter {
	if rate <= 0 {
		rate = 4.0 // 4 requests/sec sustained
	}
	if burst <= 0 {
		burst = 20 // 20 requests burst capacity (initial HLS playlist + segment buffer)
	}
	if cleanupTTL <= 0 {
		cleanupTTL = 5 * time.Minute
	}

	rl := &RateLimiter{
		buckets:    make(map[string]*clientBucket),
		rate:       rate,
		burst:      float64(burst),
		cleanupTTL: cleanupTTL,
		stopChan:   make(chan struct{}),
	}

	go rl.cleanupLoop()
	return rl
}

// Allow checks if the given IP has available token capacity.
func (rl *RateLimiter) Allow(ip string) bool {
	if ip == "" {
		ip = "unknown"
	}

	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[ip]
	if !exists {
		// New client: grant burst minus 1 for current request
		rl.buckets[ip] = &clientBucket{
			tokens:     rl.burst - 1.0,
			lastUpdate: now,
		}
		return true
	}

	// Calculate tokens added since last update
	elapsed := now.Sub(b.lastUpdate).Seconds()
	b.tokens += elapsed * rl.rate
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	b.lastUpdate = now

	if b.tokens >= 1.0 {
		b.tokens -= 1.0
		return true
	}

	// Insufficient tokens: rejected
	return false
}

// Stop terminates the background cleanup goroutine.
func (rl *RateLimiter) Stop() {
	close(rl.stopChan)
}

// UpdateParams dynamically adjusts rate and burst at runtime without downtime.
func (rl *RateLimiter) UpdateParams(rate float64, burst int) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if rate > 0 {
		rl.rate = rate
	}
	if burst > 0 {
		rl.burst = float64(burst)
	}
}

// GetParams returns the current rate and burst settings.
func (rl *RateLimiter) GetParams() (rate float64, burst int) {
	rl.mu.RLock()
	defer rl.mu.RUnlock()
	return rl.rate, int(rl.burst)
}

func (rl *RateLimiter) cleanupLoop() {
	ticker := time.NewTicker(rl.cleanupTTL)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			cutoff := time.Now().Add(-rl.cleanupTTL)
			for ip, b := range rl.buckets {
				if b.lastUpdate.Before(cutoff) {
					delete(rl.buckets, ip)
				}
			}
			rl.mu.Unlock()
		case <-rl.stopChan:
			return
		}
	}
}
