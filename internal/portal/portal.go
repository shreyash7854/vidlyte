package portal

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"strings"

	"byse-resolver/internal/config"
)

//go:embed index.html
var defaultIndexHTML string

// Handler serves the public VidLyte webmaster portal.
type Handler struct {
	store *config.ConfigStore
}

// NewHandler creates a new Portal Handler.
func NewHandler(store *config.ConfigStore) *Handler {
	return &Handler{store: store}
}

// RegisterRoutes registers the portal handler to the Go HTTP multiplexer.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", h.ServePortal)
	mux.HandleFunc("GET /index.html", h.ServePortal)
}

// ServePortal renders the VidLyte landing page with SSR-injected dynamic configuration.
func (h *Handler) ServePortal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60")

	cfg := h.store.Get()
	cfgJSON, err := json.Marshal(cfg)
	if err != nil {
		http.Error(w, "Failed to serialize portal configuration", http.StatusInternalServerError)
		return
	}

	htmlContent := defaultIndexHTML
	if diskData, err := os.ReadFile("internal/portal/index.html"); err == nil && len(diskData) > 0 {
		htmlContent = string(diskData)
	}

	// Inject dynamic config and brand metadata
	injected := strings.Replace(
		htmlContent,
		"/* __VIDLYTE_CONFIG__ */",
		fmt.Sprintf("window.VIDLYTE_CONFIG = %s;", string(cfgJSON)),
		1,
	)

	// Replace title placeholders
	injected = strings.ReplaceAll(injected, "{{.BrandName}}", template.HTMLEscapeString(cfg.Site.BrandName))
	injected = strings.ReplaceAll(injected, "{{.Tagline}}", template.HTMLEscapeString(cfg.Site.Tagline))

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(injected))
}
