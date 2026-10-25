package cache

import (
	"sync"
	"time"
)

type cacheItem struct {
	value      any
	expiration int64
}

// MemoryCache provides a zero-dependency, lock-optimized in-memory cache with TTL.
type MemoryCache struct {
	items sync.Map
	ttl   time.Duration
}

// NewMemoryCache instantiates a high-speed concurrent cache.
func NewMemoryCache(defaultTTL time.Duration, cleanupInterval time.Duration) *MemoryCache {
	c := &MemoryCache{
		ttl: defaultTTL,
	}

	// Janitor goroutine for expired entry cleanup
	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			now := time.Now().UnixNano()
			c.items.Range(func(key, value any) bool {
				item, ok := value.(cacheItem)
				if ok && item.expiration > 0 && now > item.expiration {
					c.items.Delete(key)
				}
				return true
			})
		}
	}()

	return c
}

// Get retrieves a cached value if present and not expired.
func (c *MemoryCache) Get(key string) (any, bool) {
	val, ok := c.items.Load(key)
	if !ok {
		return nil, false
	}

	item, ok := val.(cacheItem)
	if !ok {
		return nil, false
	}

	if item.expiration > 0 && time.Now().UnixNano() > item.expiration {
		c.items.Delete(key)
		return nil, false
	}

	return item.value, true
}

// Set stores a value in cache with the default TTL.
func (c *MemoryCache) Set(key string, value any) {
	c.SetWithTTL(key, value, c.ttl)
}

// SetWithTTL stores a value with an explicit duration.
func (c *MemoryCache) SetWithTTL(key string, value any, duration time.Duration) {
	var exp int64
	if duration > 0 {
		exp = time.Now().Add(duration).UnixNano()
	}

	c.items.Store(key, cacheItem{
		value:      value,
		expiration: exp,
	})
}
