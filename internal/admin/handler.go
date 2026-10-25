package admin

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"byse-resolver/internal/config"
	"byse-resolver/internal/proxy"
)

//go:embed admin.html
var defaultAdminHTML string

// Handler manages the secret admin portal routes.
type Handler struct {
	auth  *AuthManager
	store *config.ConfigStore
	swarm *proxy.SwarmBalancer
}

// NewHandler initializes the Admin Handler.
func NewHandler(auth *AuthManager, store *config.ConfigStore) *Handler {
	return &Handler{
		auth:  auth,
		store: store,
		swarm: proxy.NewSwarmBalancer(store),
	}
}

// RegisterRoutes attaches the secret /admin-login-i paths to the Go HTTP multiplexer.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin-login-i", h.ServeAdminPortal)
	mux.HandleFunc("POST /admin-login-i/auth", h.HandleAuth)
	mux.HandleFunc("POST /admin-login-i/logout", h.HandleLogout)
	mux.HandleFunc("GET /admin-login-i/api/config", h.HandleGetConfig)
	mux.HandleFunc("POST /admin-login-i/api/config", h.HandleUpdateConfig)
	mux.HandleFunc("POST /admin-login-i/api/swarm/test", h.HandleTestSwarm)
}

// ServeAdminPortal serves the mission control HTML with strict no-index headers.
func (h *Handler) ServeAdminPortal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Cache-Control", "no-store, max-age=0")

	// Allow dynamic reload from disk during development
	htmlContent := defaultAdminHTML
	if diskData, err := os.ReadFile("internal/admin/admin.html"); err == nil && len(diskData) > 0 {
		htmlContent = string(diskData)
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(htmlContent))
}

type authRequest struct {
	Secret string `json:"secret"`
}

// HandleAuth verifies the submitted secret password.
func (h *Handler) HandleAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")

	ip := ExtractClientIP(r)
	allowed, waitDuration := h.auth.CheckRateLimit(ip)
	if !allowed {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   fmt.Sprintf("Too many failed attempts. Locked out for %d minutes.", int(waitDuration.Minutes())+1),
		})
		return
	}

	var req authRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Invalid request payload",
		})
		return
	}

	if !h.auth.VerifySecret(req.Secret) {
		remaining, locked := h.auth.RecordFailure(ip)
		w.WriteHeader(http.StatusUnauthorized)
		msg := fmt.Sprintf("Invalid secret. %d attempts remaining.", remaining)
		if locked {
			msg = "Invalid secret. Account locked for 15 minutes."
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   msg,
		})
		return
	}

	// Login Success
	h.auth.ResetFailure(ip)
	cookie := h.auth.CreateSessionCookie(r)
	http.SetCookie(w, cookie)

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
	})
}

// HandleLogout revokes the session cookie.
func (h *Handler) HandleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, h.auth.ClearSessionCookie())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// HandleGetConfig returns the current dynamic configuration.
func (h *Handler) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")

	if !h.auth.ValidateSession(r) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized"})
		return
	}

	cfg := h.store.Get()
	_ = json.NewEncoder(w).Encode(cfg)
}

// HandleUpdateConfig saves new configuration atomically.
func (h *Handler) HandleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")

	if !h.auth.ValidateSession(r) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized"})
		return
	}

	var newConfig config.DynamicConfig
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&newConfig); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": "Malformed configuration JSON"})
		return
	}

	updated, err := h.store.Update(func(c *config.DynamicConfig) error {
		*c = newConfig
		return nil
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	_ = json.NewEncoder(w).Encode(updated)
}

// HandleTestSwarm triggers parallel health probes on all edge proxy workers.
func (h *Handler) HandleTestSwarm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")

	if !h.auth.ValidateSession(r) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized"})
		return
	}

	if h.swarm == nil {
		h.swarm = proxy.NewSwarmBalancer(h.store)
	}

	results := h.swarm.ProbeAllWorkers(r.Context())
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"results": results,
		"config":  h.store.Get().ProxySwarm,
	})
}
