package observability

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// Metrics tracks runtime gateway statistics using lock-free atomic counters.
type Metrics struct {
	TotalRequests   int64 `json:"total_requests"`
	ActiveRequests  int64 `json:"active_requests"`
	BytesStreamed   int64 `json:"bytes_streamed"`
	CacheHits       int64 `json:"cache_hits"`
	CacheMisses     int64 `json:"cache_misses"`
	Status2xx       int64 `json:"status_2xx"`
	Status4xx           int64 `json:"status_4xx"`
	Status5xx           int64 `json:"status_5xx"`
	RateLimitRejections int64 `json:"rate_limit_rejections"`
}

var DefaultMetrics = &Metrics{}

func (m *Metrics) IncRequests() {
	atomic.AddInt64(&m.TotalRequests, 1)
	atomic.AddInt64(&m.ActiveRequests, 1)
}

func (m *Metrics) DecActive() {
	atomic.AddInt64(&m.ActiveRequests, -1)
}

func (m *Metrics) AddBytes(n int64) {
	atomic.AddInt64(&m.BytesStreamed, n)
}

func (m *Metrics) IncCacheHit() {
	atomic.AddInt64(&m.CacheHits, 1)
}

func (m *Metrics) IncCacheMiss() {
	atomic.AddInt64(&m.CacheMisses, 1)
}

func (m *Metrics) IncRateLimitRejections() {
	atomic.AddInt64(&m.RateLimitRejections, 1)
}

func (m *Metrics) RecordStatus(code int) {
	switch {
	case code >= 200 && code < 300:
		atomic.AddInt64(&m.Status2xx, 1)
	case code >= 400 && code < 500:
		atomic.AddInt64(&m.Status4xx, 1)
	case code >= 500:
		atomic.AddInt64(&m.Status5xx, 1)
	}
}

// Snapshot returns a copy of current metrics values.
func (m *Metrics) Snapshot() Metrics {
	return Metrics{
		TotalRequests:       atomic.LoadInt64(&m.TotalRequests),
		ActiveRequests:      atomic.LoadInt64(&m.ActiveRequests),
		BytesStreamed:       atomic.LoadInt64(&m.BytesStreamed),
		CacheHits:           atomic.LoadInt64(&m.CacheHits),
		CacheMisses:         atomic.LoadInt64(&m.CacheMisses),
		Status2xx:           atomic.LoadInt64(&m.Status2xx),
		Status4xx:           atomic.LoadInt64(&m.Status4xx),
		Status5xx:           atomic.LoadInt64(&m.Status5xx),
		RateLimitRejections: atomic.LoadInt64(&m.RateLimitRejections),
	}
}

// RedactURLQuery strips tokens and sensitive upstream URLs from logged query strings.
func RedactURLQuery(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	q := u.Query()
	redacted := false

	if q.Has("token") {
		q.Set("token", "[REDACTED]")
		redacted = true
	}
	if q.Has("url") {
		q.Set("url", "[REDACTED]")
		redacted = true
	}
	if q.Has("signature") {
		q.Set("signature", "[REDACTED]")
		redacted = true
	}

	if redacted {
		u.RawQuery = q.Encode()
		// Replace standard URL-encoded "[REDACTED]" for cleaner logs
		return strings.ReplaceAll(u.String(), "%5BREDACTED%5D", "[REDACTED]")
	}

	return rawURL
}

// HealthzHandler returns 200 OK liveness response.
func HealthzHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"alive","time":"` + time.Now().UTC().Format(time.RFC3339) + `"}`))
}

// ReadyzHandler returns 200 OK readiness response.
func ReadyzHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ready","time":"` + time.Now().UTC().Format(time.RFC3339) + `"}`))
}

// MetricsHandler outputs JSON snapshot of gateway metrics.
func MetricsHandler(w http.ResponseWriter, r *http.Request) {
	snap := DefaultMetrics.Snapshot()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(snap)
}
