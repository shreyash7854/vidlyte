package diskcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Policy evaluates if upstream response headers allow caching under RFC 7234.
type Policy struct {
	IsCacheable bool
	TTL         time.Duration
}

// EvaluatePolicy checks Cache-Control, Vary, and status codes.
func EvaluatePolicy(statusCode int, header http.Header, defaultTTL time.Duration) Policy {
	// Only cache full 200 OK responses; do not cache partial 206 or errors
	if statusCode != http.StatusOK {
		return Policy{IsCacheable: false}
	}

	cc := strings.ToLower(header.Get("Cache-Control"))
	if strings.Contains(cc, "no-store") || strings.Contains(cc, "private") || strings.Contains(cc, "no-cache") {
		return Policy{IsCacheable: false}
	}

	vary := strings.ToLower(header.Get("Vary"))
	if strings.Contains(vary, "*") || strings.Contains(vary, "authorization") {
		return Policy{IsCacheable: false}
	}

	ttl := defaultTTL
	if strings.Contains(cc, "max-age=") {
		parts := strings.Split(cc, "max-age=")
		if len(parts) > 1 {
			sub := strings.Split(parts[1], ",")[0]
			sec, err := strconv.Atoi(strings.TrimSpace(sub))
			if err == nil && sec > 0 {
				ttl = time.Duration(sec) * time.Second
			} else if sec == 0 {
				return Policy{IsCacheable: false}
			}
		}
	}

	return Policy{
		IsCacheable: true,
		TTL:         ttl,
	}
}

// Metadata stored alongside cached binary media file.
type Metadata struct {
	Key          string      `json:"key"`
	ContentType  string      `json:"content_type"`
	ContentLength int64      `json:"content_length"`
	ExpiresAt    time.Time   `json:"expires_at"`
	CachedAt     time.Time   `json:"cached_at"`
	Headers      http.Header `json:"headers"`
}

// Entry represents a cached item on disk.
type Entry struct {
	FilePath string
	Meta     Metadata
}

// singleFlightGroup coalesces concurrent duplicate fetches into a single execution.
type singleFlightGroup struct {
	mu sync.Mutex
	m  map[string]*call
}

type call struct {
	wg  sync.WaitGroup
	val any
	err error
}

func (g *singleFlightGroup) Do(key string, fn func() (any, error)) (any, error) {
	g.mu.Lock()
	if g.m == nil {
		g.m = make(map[string]*call)
	}
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := new(call)
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()

	return c.val, c.err
}

// DiskCache provides bounded, atomic, LRU-evicted disk storage for explicitly cacheable resources.
type DiskCache struct {
	dir         string
	maxSize     int64
	defaultTTL  time.Duration
	mu          sync.RWMutex
	currentSize int64
	flight      singleFlightGroup
}

// NewDiskCache initializes bounded disk cache.
func NewDiskCache(dir string, maxSize int64, defaultTTL time.Duration) (*DiskCache, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create cache directory: %w", err)
	}

	dc := &DiskCache{
		dir:        dir,
		maxSize:    maxSize,
		defaultTTL: defaultTTL,
	}

	dc.calculateInitialSize()
	return dc, nil
}

func (dc *DiskCache) calculateInitialSize() {
	var total int64
	entries, err := os.ReadDir(dc.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		info, err := e.Info()
		if err == nil && !e.IsDir() {
			total += info.Size()
		}
	}
	dc.currentSize = total
}

func (dc *DiskCache) filePaths(key string) (dataPath, metaPath string) {
	h := sha256.Sum256([]byte(key))
	hashHex := hex.EncodeToString(h[:])
	dataPath = filepath.Join(dc.dir, hashHex+".data")
	metaPath = filepath.Join(dc.dir, hashHex+".meta")
	return
}

// Get checks if an entry is cached and valid.
func (dc *DiskCache) Get(key string) (*Entry, bool) {
	dataPath, metaPath := dc.filePaths(key)

	dc.mu.RLock()
	defer dc.mu.RUnlock()

	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, false
	}

	var meta Metadata
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return nil, false
	}

	// Verify expiry
	if time.Now().After(meta.ExpiresAt) {
		return nil, false
	}

	// Verify data file exists
	if _, err := os.Stat(dataPath); err != nil {
		return nil, false
	}

	return &Entry{
		FilePath: dataPath,
		Meta:     meta,
	}, true
}

// Put writes an upstream stream into cache atomically using temp files.
func (dc *DiskCache) Put(key string, r io.Reader, header http.Header, ttl time.Duration) (*Entry, error) {
	if ttl <= 0 {
		ttl = dc.defaultTTL
	}
	return dc.PutWithExpiry(key, r, header, time.Now().Add(ttl))
}

// PutWithExpiry writes an upstream stream into cache with an explicit expiry timestamp.
func (dc *DiskCache) PutWithExpiry(key string, r io.Reader, header http.Header, expiresAt time.Time) (*Entry, error) {
	dataPath, metaPath := dc.filePaths(key)

	// Create temp file in same directory for atomic rename
	tmpFile, err := os.CreateTemp(dc.dir, "cachedata-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("failed to create cache temp file: %w", err)
	}
	tmpName := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmpName) // Cleanup if rename wasn't reached
	}()

	n, err := io.Copy(tmpFile, r)
	_ = tmpFile.Close()
	if err != nil {
		return nil, fmt.Errorf("failed writing cache data: %w", err)
	}

	meta := Metadata{
		Key:           key,
		ContentType:   header.Get("Content-Type"),
		ContentLength: n,
		CachedAt:      time.Now(),
		ExpiresAt:     expiresAt,
		Headers:       header,
	}

	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}

	// Atomic rename of data file (with Windows concurrent file sharing handling)
	if err := os.Rename(tmpName, dataPath); err != nil {
		if _, statErr := os.Stat(dataPath); statErr == nil {
			// File already created by another concurrent worker, cleanup temp file
			_ = os.Remove(tmpName)
		} else {
			return nil, fmt.Errorf("atomic rename failed: %w", err)
		}
	}

	// Write metadata file
	if _, statErr := os.Stat(metaPath); statErr != nil {
		_ = os.WriteFile(metaPath, metaJSON, 0644)
	}

	dc.mu.Lock()
	dc.currentSize += n + int64(len(metaJSON))
	dc.evictIfOverBudget()
	dc.mu.Unlock()

	return &Entry{
		FilePath: dataPath,
		Meta:     meta,
	}, nil
}

// DoCoalesced deduplicates concurrent requests for the same cache key.
func (dc *DiskCache) DoCoalesced(key string, fn func() (any, error)) (any, error) {
	return dc.flight.Do(key, fn)
}

type fileItem struct {
	path    string
	size    int64
	modTime time.Time
}

func (dc *DiskCache) evictIfOverBudget() {
	if dc.currentSize <= dc.maxSize {
		return
	}

	entries, err := os.ReadDir(dc.dir)
	if err != nil {
		return
	}

	var files []fileItem
	for _, e := range entries {
		info, err := e.Info()
		if err == nil && !e.IsDir() {
			files = append(files, fileItem{
				path:    filepath.Join(dc.dir, e.Name()),
				size:    info.Size(),
				modTime: info.ModTime(),
			})
		}
	}

	// Sort oldest first (LRU eviction)
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.Before(files[j].modTime)
	})

	for _, f := range files {
		if dc.currentSize <= dc.maxSize {
			break
		}
		if err := os.Remove(f.path); err == nil {
			dc.currentSize -= f.size
		}
	}
}

// Purge removes all cached data and metadata files.
func (dc *DiskCache) Purge() error {
	dc.mu.Lock()
	defer dc.mu.Unlock()

	entries, err := os.ReadDir(dc.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		_ = os.Remove(filepath.Join(dc.dir, e.Name()))
	}
	dc.currentSize = 0
	return nil
}

// Stats returns current size in bytes, max capacity in bytes, and cached file count.
func (dc *DiskCache) Stats() (currentBytes int64, maxBytes int64, fileCount int) {
	dc.mu.RLock()
	defer dc.mu.RUnlock()

	entries, _ := os.ReadDir(dc.dir)
	var count int
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".data") {
			count++
		}
	}
	return dc.currentSize, dc.maxSize, count
}
