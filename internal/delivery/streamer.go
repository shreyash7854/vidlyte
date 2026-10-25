package delivery

import (
	"io"
	"net/http"
	"sync"

	"byse-resolver/internal/observability"
)

var (
	bufferPool = sync.Pool{
		New: func() any {
			b := make([]byte, 32*1024) // 32 KB streaming chunk buffer
			return &b
		},
	}
)

// StreamResponse pipes an io.Reader body to http.ResponseWriter with backpressure and recycled buffers.
func StreamResponse(w http.ResponseWriter, r *http.Request, statusCode int, header http.Header, body io.Reader) (int64, error) {
	// Set standard streaming headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range, X-Requested-With")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges")

	if ct := header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if cr := header.Get("Content-Range"); cr != "" {
		w.Header().Set("Content-Range", cr)
	}
	if ar := header.Get("Accept-Ranges"); ar != "" {
		w.Header().Set("Accept-Ranges", ar)
	}
	if cl := header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}

	w.WriteHeader(statusCode)

	bufPtr := bufferPool.Get().(*[]byte)
	defer bufferPool.Put(bufPtr)

	// Stream directly with backpressure; client cancellation naturally stops copy
	written, err := io.CopyBuffer(w, body, *bufPtr)
	observability.DefaultMetrics.AddBytes(written)
	observability.DefaultMetrics.RecordStatus(statusCode)

	return written, err
}
