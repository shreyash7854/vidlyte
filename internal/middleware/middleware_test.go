package middleware

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestGzipMiddleware_CompressesJSONAndDeletesContentLength(t *testing.T) {
	rawPayload := []byte(`{"status":"ok","message":"hello world from json api test"}`)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(rawPayload)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(rawPayload)
	})

	wrapped := GzipMiddleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()

	wrapped.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected Content-Encoding: gzip, got %q", res.Header.Get("Content-Encoding"))
	}
	if cl := res.Header.Get("Content-Length"); cl != "" {
		t.Fatalf("expected Content-Length to be deleted to avoid mismatch, got %q", cl)
	}

	gzReader, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatalf("failed to create gzip reader: %v", err)
	}
	defer gzReader.Close()

	decompressed, err := io.ReadAll(gzReader)
	if err != nil {
		t.Fatalf("failed reading decompressed body: %v", err)
	}

	if !bytes.Equal(decompressed, rawPayload) {
		t.Fatalf("decompressed body mismatch: got %s, want %s", string(decompressed), string(rawPayload))
	}
}

func TestGzipMiddleware_BypassesMediaSegmentsAndPreservesContentLength(t *testing.T) {
	// Simulate 64 KB video segment
	videoPayload := bytes.Repeat([]byte{0x47, 0x01, 0x02, 0x03}, 16*1024)
	expectedLength := len(videoPayload)

	tests := []struct {
		name        string
		path        string
		contentType string
	}{
		{
			name:        "HLS resource route",
			path:        "/hls/tv/1399/1/1/resource/0cf4db2ef5802ace2ee5cb3d",
			contentType: "video/mp2t",
		},
		{
			name:        "Direct .ts segment",
			path:        "/segments/seg123.ts",
			contentType: "video/mp2t",
		},
		{
			name:        "Direct .m4s fragment",
			path:        "/segments/chunk.m4s",
			contentType: "video/iso.segment",
		},
		{
			name:        "Video content type on generic path",
			path:        "/stream/video-chunk",
			contentType: "video/mp4",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				w.Header().Set("Content-Length", strconv.Itoa(expectedLength))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(videoPayload)
			})

			wrapped := GzipMiddleware(handler)

			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("Accept-Encoding", "gzip, deflate, br")
			rec := httptest.NewRecorder()

			wrapped.ServeHTTP(rec, req)

			res := rec.Result()
			defer res.Body.Close()

			if enc := res.Header.Get("Content-Encoding"); enc != "" {
				t.Fatalf("media stream must not be compressed, got Content-Encoding: %q", enc)
			}

			cl := res.Header.Get("Content-Length")
			if cl != strconv.Itoa(expectedLength) {
				t.Fatalf("expected Content-Length: %d, got %q", expectedLength, cl)
			}

			body, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatalf("failed reading body: %v", err)
			}

			if len(body) != expectedLength {
				t.Fatalf("net::ERR_CONTENT_LENGTH_MISMATCH reproduced! Expected %d bytes, got %d bytes", expectedLength, len(body))
			}
		})
	}
}

func TestGzipMiddleware_BypassesRangeRequests(t *testing.T) {
	payload := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	rangeSlice := payload[0:10]

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-9/%d", len(payload)))
		w.Header().Set("Content-Length", strconv.Itoa(len(rangeSlice)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(rangeSlice)
	})

	wrapped := GzipMiddleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/movie.mp4", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-9")
	rec := httptest.NewRecorder()

	wrapped.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusPartialContent {
		t.Fatalf("expected status 206, got %d", res.StatusCode)
	}
	if enc := res.Header.Get("Content-Encoding"); enc != "" {
		t.Fatalf("Range request must not be compressed, got Content-Encoding: %q", enc)
	}
	if cl := res.Header.Get("Content-Length"); cl != "10" {
		t.Fatalf("expected Content-Length: 10, got %q", cl)
	}
}
