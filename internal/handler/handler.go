package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"byse-resolver/internal/models"
	"byse-resolver/internal/proxy"
	"byse-resolver/internal/service"
)

var bufferPool = sync.Pool{
	New: func() any {
		return bytes.NewBuffer(make([]byte, 0, 4096))
	},
}

// Handler contains endpoints and dependencies for the media router.
type Handler struct {
	resolver *service.ResolverService
	proxy    *proxy.StreamProxy
}

// NewHandler initializes a Handler.
func NewHandler(resolver *service.ResolverService, streamProxy *proxy.StreamProxy) *Handler {
	return &Handler{
		resolver: resolver,
		proxy:    streamProxy,
	}
}

// RegisterRoutes registers Go 1.22+ routing patterns onto the mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health", h.HandleHealth)
	mux.HandleFunc("GET /tv/{id}/{season}/{episode}", h.HandleTV)
	mux.HandleFunc("GET /movie/{id}", h.HandleMovie)
	mux.HandleFunc("GET /anime/{id}/{season}/{episode}", h.HandleGeneric)

	// Stream reverse proxy endpoints
	mux.Handle("GET /proxy", h.proxy)
	mux.Handle("OPTIONS /proxy", h.proxy)
}

// HandleHealth provides a fast liveness check.
func (h *Handler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok","timestamp":"` + time.Now().UTC().Format(time.RFC3339) + `"}`))
}

// HandleTV resolves TV episode streams: /tv/{id}/{season}/{episode}.
func (h *Handler) HandleTV(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	seasonStr := r.PathValue("season")
	episodeStr := r.PathValue("episode")

	if id == "" {
		h.writeError(w, http.StatusBadRequest, "missing title or tmdb id")
		return
	}

	season, err := strconv.Atoi(seasonStr)
	if err != nil || season < 1 {
		h.writeError(w, http.StatusBadRequest, "invalid season parameter: must be positive integer")
		return
	}

	episode, err := strconv.Atoi(episodeStr)
	if err != nil || episode < 1 {
		h.writeError(w, http.StatusBadRequest, "invalid episode parameter: must be positive integer")
		return
	}

	req := models.MediaRequest{
		Type:    "tv",
		ID:      id,
		Season:  season,
		Episode: episode,
	}

	h.resolveAndRespond(w, r, req)
}

// HandleMovie resolves movie streams: /movie/{id}.
func (h *Handler) HandleMovie(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		h.writeError(w, http.StatusBadRequest, "missing title or tmdb id")
		return
	}

	req := models.MediaRequest{
		Type: "movie",
		ID:   id,
	}

	h.resolveAndRespond(w, r, req)
}

// HandleGeneric handles parameterized media types: /{type}/{id}/{season}/{episode}.
func (h *Handler) HandleGeneric(w http.ResponseWriter, r *http.Request) {
	mediaType := r.PathValue("type")
	id := r.PathValue("id")
	seasonStr := r.PathValue("season")
	episodeStr := r.PathValue("episode")

	if mediaType != "tv" && mediaType != "anime" {
		h.writeError(w, http.StatusBadRequest, "unsupported media type: use 'tv', 'anime', or /movie/{id}")
		return
	}

	season, _ := strconv.Atoi(seasonStr)
	episode, _ := strconv.Atoi(episodeStr)

	req := models.MediaRequest{
		Type:    mediaType,
		ID:      id,
		Season:  season,
		Episode: episode,
	}

	h.resolveAndRespond(w, r, req)
}

func (h *Handler) resolveAndRespond(w http.ResponseWriter, r *http.Request, req models.MediaRequest) {
	ctx := r.Context()
	res, err := h.resolver.Resolve(ctx, req)
	if err != nil {
		h.writeError(w, http.StatusNotFound, err.Error())
		return
	}

	h.writeJSON(w, http.StatusOK, res)
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, data any) {
	buf, ok := bufferPool.Get().(*bytes.Buffer)
	if !ok {
		buf = bytes.NewBuffer(make([]byte, 0, 4096))
	}
	buf.Reset()
	defer bufferPool.Put(buf)

	if err := json.NewEncoder(buf).Encode(data); err != nil {
		http.Error(w, `{"error":"failed to serialize response","code":500}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func (h *Handler) writeError(w http.ResponseWriter, code int, msg string) {
	errResp := models.ErrorResponse{
		Error: msg,
		Code:  code,
	}
	h.writeJSON(w, code, errResp)
}
