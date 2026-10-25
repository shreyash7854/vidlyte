package middleware

import (
	"compress/gzip"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ResponseWriterWrapper intercepts status codes for metrics/logging.
type responseWriterWrapper struct {
	http.ResponseWriter
	statusCode int
	written    int64
}

func (rw *responseWriterWrapper) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriterWrapper) Write(b []byte) (int, error) {
	if rw.statusCode == 0 {
		rw.statusCode = http.StatusOK
	}
	n, err := rw.ResponseWriter.Write(b)
	rw.written += int64(n)
	return n, err
}

// LoggerMiddleware logs each incoming HTTP request and its duration with slog.
func LoggerMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			wrapped := &responseWriterWrapper{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(wrapped, r)

			duration := time.Since(start)
			safeURI := r.URL.Path
			if r.URL.RawQuery != "" {
				safeURI = r.URL.Path + "?" + r.URL.RawQuery
			}
			if strings.Contains(safeURI, "token=") || strings.Contains(safeURI, "url=") || strings.Contains(safeURI, "signature=") {
				safeURI = redactQuery(safeURI)
			}

			logger.Info("handled request",
				"method", r.Method,
				"uri", safeURI,
				"remote_addr", r.RemoteAddr,
				"status", wrapped.statusCode,
				"bytes", wrapped.written,
				"duration_ms", float64(duration.Microseconds())/1000.0,
			)
		})
	}
}

func redactQuery(raw string) string {
	parts := strings.SplitN(raw, "?", 2)
	if len(parts) < 2 {
		return raw
	}
	pairs := strings.Split(parts[1], "&")
	for i, p := range pairs {
		kv := strings.SplitN(p, "=", 2)
		if len(kv) == 2 {
			k := strings.ToLower(kv[0])
			if k == "token" || k == "url" || k == "signature" || k == "key" {
				pairs[i] = kv[0] + "=[REDACTED]"
			}
		}
	}
	return parts[0] + "?" + strings.Join(pairs, "&")
}

// RecoveryMiddleware gracefully catches panics and returns HTTP 500.
func RecoveryMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					logger.Error("panic recovered", "error", rec, "path", r.URL.Path)
					http.Error(w, `{"error":"internal server error","code":500}`, http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// CORSMiddleware injects permissive CORS headers for modern web frontends.
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range, X-Requested-With")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		return gzip.NewWriter(io.Discard)
	},
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	headerSent  bool
	compressing bool
}

func isMediaRequest(r *http.Request) bool {
	p := strings.ToLower(r.URL.Path)
	if strings.Contains(p, "/resource/") {
		return true
	}
	if isMediaExt(p) {
		return true
	}
	if rawTarget := r.URL.Query().Get("url"); rawTarget != "" {
		if isMediaExt(strings.ToLower(rawTarget)) {
			return true
		}
	}
	return false
}

func isMediaExt(pathOrURL string) bool {
	exts := []string{
		".ts", ".m4s", ".mp4", ".m4a", ".aac", ".key", ".bin",
		".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico",
	}
	clean := pathOrURL
	if idx := strings.Index(clean, "?"); idx != -1 {
		clean = clean[:idx]
	}
	for _, ext := range exts {
		if strings.HasSuffix(clean, ext) {
			return true
		}
	}
	return false
}

func (g *gzipResponseWriter) shouldCompress(code int) bool {
	if code < 200 || code == http.StatusNoContent || code == http.StatusNotModified || code == http.StatusPartialContent {
		return false
	}
	if g.ResponseWriter.Header().Get("Content-Encoding") != "" {
		return false
	}
	ct := strings.ToLower(g.ResponseWriter.Header().Get("Content-Type"))
	if ct != "" {
		if strings.HasPrefix(ct, "video/") ||
			strings.HasPrefix(ct, "audio/") ||
			strings.HasPrefix(ct, "image/") ||
			strings.Contains(ct, "octet-stream") ||
			strings.Contains(ct, "mp2t") ||
			strings.Contains(ct, "iso.segment") {
			return false
		}
	}
	return true
}

func (g *gzipResponseWriter) WriteHeader(code int) {
	if g.headerSent {
		return
	}
	g.headerSent = true

	if g.shouldCompress(code) {
		g.compressing = true
		// Remove Content-Length so HTTP server transmits chunked stream without mismatch
		g.ResponseWriter.Header().Del("Content-Length")
		g.ResponseWriter.Header().Set("Content-Encoding", "gzip")
		g.ResponseWriter.Header().Add("Vary", "Accept-Encoding")
		gz := gzipWriterPool.Get().(*gzip.Writer)
		gz.Reset(g.ResponseWriter)
		g.gz = gz
	}

	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.headerSent {
		if g.ResponseWriter.Header().Get("Content-Type") == "" {
			g.ResponseWriter.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}

	if g.compressing && g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipResponseWriter) Close() error {
	if g.compressing && g.gz != nil {
		err := g.gz.Close()
		gzipWriterPool.Put(g.gz)
		g.gz = nil
		return err
	}
	return nil
}

func (g *gzipResponseWriter) Flush() {
	if g.compressing && g.gz != nil {
		_ = g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// GzipMiddleware dynamically compresses payloads (JSON, playlists, text) while strictly bypassing
// binary media streams, video segments, and HTTP Range requests to avoid Content-Length mismatches.
func GzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			r.Header.Get("Range") != "" ||
			r.Method == http.MethodHead ||
			r.Method == http.MethodOptions ||
			isMediaRequest(r) {
			next.ServeHTTP(w, r)
			return
		}

		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.Close()

		next.ServeHTTP(gw, r)
	})
}
