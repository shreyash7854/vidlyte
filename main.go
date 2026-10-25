package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"byse-resolver/internal/admin"
	"byse-resolver/internal/cache"
	"byse-resolver/internal/catalog"
	"byse-resolver/internal/config"
	"byse-resolver/internal/diskcache"
	"byse-resolver/internal/embed"
	"byse-resolver/internal/gateway"
	"byse-resolver/internal/handler"
	"byse-resolver/internal/middleware"
	"byse-resolver/internal/portal"
	"byse-resolver/internal/proxy"
	"byse-resolver/internal/service"
	"byse-resolver/internal/session"
	"byse-resolver/internal/tmdb"
	"byse-resolver/internal/upstream"
)

func main() {
	// Configure high-speed structured logging
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load base environment configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		logger.Error("failed to load configuration", "error", err)
		os.Exit(1)
	}

	logger.Info("loaded gateway configuration", "env", cfg.Env, "token_ttl", cfg.TokenTTL.String(), "cache_enabled", cfg.CacheEnabled)

	// Initialize dynamic zero-downtime configuration store
	dynamicStore, err := config.NewConfigStore(filepath.Join("data", "vidlyte_config.json"))
	if err != nil {
		logger.Warn("failed to initialize dynamic config store; proceeding with defaults", "error", err)
	}

	// Initialize thread-safe TTL cache (10m TTL, 1m cleanup cycle)
	memCache := cache.NewMemoryCache(10*time.Minute, 1*time.Minute)

	// Initialize TMDB to slug resolver
	slugResolver := tmdb.NewSlugResolver(cfg.TMDBAPIKey)

	// Initialize domain service (source resolution with Vidrift primary + AsianFlix fallback)
	resolverService := service.NewResolverServiceWithSlug(memCache, slugResolver)
	if dynamicStore != nil {
		resolverService.SetConfigStore(dynamicStore)
	}

	// Initialize distributed Upstash Redis Swarm cluster if configured
	if len(cfg.UpstashRESTURLs) > 0 {
		var upstashNodes []*cache.UpstashNode
		for i, u := range cfg.UpstashRESTURLs {
			token := ""
			if i < len(cfg.UpstashRESTTokens) {
				token = cfg.UpstashRESTTokens[i]
			}
			upstashNodes = append(upstashNodes, &cache.UpstashNode{
				ID:      fmt.Sprintf("upstash-node-%d", i+1),
				Name:    fmt.Sprintf("Upstash Node %d", i+1),
				RestURL: u,
				Token:   token,
				Enabled: true,
			})
		}
		upstashSwarm := cache.NewUpstashSwarm(upstashNodes)
		tieredCache := cache.NewTieredCache(memCache, upstashSwarm)
		resolverService.SetTieredCache(tieredCache)
		logger.Info("initialized distributed Upstash Redis swarm", "nodes", len(upstashNodes))
	}

	// Initialize session token manager
	sessionMgr, err := session.NewManager(cfg.HMACKeys, cfg.PrimaryHMACKeyID, cfg.TokenTTL)
	if err != nil {
		logger.Error("failed to initialize session manager", "error", err)
		os.Exit(1)
	}

	// Initialize catalog adapter (maps asset IDs to authorized sources)
	catalogAdapter := catalog.NewAdapter(resolverService)

	// Initialize instant embed handler for webmaster iframes
	embedHandler, err := embed.NewHandlerWithStore(cfg, sessionMgr, catalogAdapter, dynamicStore)
	if err != nil {
		logger.Error("failed to initialize embed handler", "error", err)
		os.Exit(1)
	}

	// Initialize SSRF-protected upstream client
	upstreamClient := upstream.NewClient(cfg)

	// Optional disk cache
	var diskCacheInstance *diskcache.DiskCache
	if cfg.CacheEnabled {
		dc, err := diskcache.NewDiskCache(cfg.CacheDir, cfg.CacheMaxSizeBytes, cfg.CacheDefaultTTL)
		if err != nil {
			logger.Warn("failed to initialize disk cache; continuing without cache", "error", err)
		} else {
			diskCacheInstance = dc
			logger.Info("initialized disk cache", "dir", cfg.CacheDir, "max_mb", cfg.CacheMaxSizeBytes/(1024*1024))
		}
	}

	// Initialize proxy swarm balancer for edge chunk routing
	var swarmBalancer *proxy.SwarmBalancer
	if dynamicStore != nil {
		swarmBalancer = proxy.NewSwarmBalancer(dynamicStore)
	}

	// Initialize HLS redistribution gateway
	gw := gateway.NewGateway(cfg, sessionMgr, catalogAdapter, upstreamClient, diskCacheInstance, logger)
	if swarmBalancer != nil {
		gw.SetSwarmBalancer(swarmBalancer)
	}

	// Initialize streaming reverse proxy (legacy endpoint)
	streamProxy := proxy.NewStreamProxy()

	// Initialize HTTP handlers and mux (Go 1.22+ pattern routing)
	mux := http.NewServeMux()

	// 1. Register Secret Admin Operations Portal (/admin-login-i)
	adminAuth := admin.NewAuthManager("")
	adminHandler := admin.NewHandler(adminAuth, dynamicStore)
	adminHandler.RegisterRoutes(mux)

	secretHint := adminAuth.GetSecretString()
	if len(secretHint) > 8 {
		secretHint = secretHint[:4] + "..." + secretHint[len(secretHint)-4:]
	}
	logger.Info("mounted secret admin portal", "endpoint", "/admin-login-i", "secret_hint", secretHint)

	// 2. Register VidLyte Public Webmaster Portal (Landing, Live Builder, API Docs)
	portalHandler := portal.NewHandler(dynamicStore)
	portalHandler.RegisterRoutes(mux)

	// 3. Register Gateway routes
	gw.RegisterRoutes(mux)

	// 4. Register existing Resolver and Proxy routes
	h := handler.NewHandler(resolverService, streamProxy)
	h.RegisterRoutes(mux)

	// 5. Register Instant Embed Player routes for webmasters
	embedHandler.RegisterRoutes(mux)

	// 6. Serve test player UI (Legacy)
	mux.HandleFunc("GET /ply.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "ply.html")
	})
	mux.HandleFunc("GET /player", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "ply.html")
	})

	// Compose middleware chain (executed in order: Recovery -> Logger -> CORS -> Gzip -> Handler)
	var rootHandler http.Handler = mux
	rootHandler = middleware.GzipMiddleware(rootHandler)
	rootHandler = middleware.CORSMiddleware(rootHandler)
	rootHandler = middleware.LoggerMiddleware(logger)(rootHandler)
	rootHandler = middleware.RecoveryMiddleware(logger)(rootHandler)

	// Production HTTP Server with strict timeouts
	srv := &http.Server{
		Addr:              cfg.Port,
		Handler:           rootHandler,
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second, // Allow sustained chunk streaming
		IdleTimeout:       120 * time.Second,
	}

	// Background listener for primary Hub (localhost:8080)
	go func() {
		logger.Info("starting vidlyte core hub & master gateway", "port", cfg.Port, "routes", []string{
			"GET / (VidLyte Public Portal & Embed Builder)",
			"GET /admin-login-i (Secret Mission Control)",
			"GET /embed/tv/{id}/{season}/{episode}",
			"GET /embed/movie/{id}",
			"POST /v1/playback-sessions",
			"GET /hls/{assetID}/master.m3u8?token=...",
			"GET /hls/{assetID}/resource/{resID}?token=...",
			"GET /healthz",
			"GET /readyz",
			"GET /metrics",
		})
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed to start", "error", err)
			os.Exit(1)
		}
	}()

	// Optional decoupled player listener (e.g. localhost:6789 for player isolation)
	var playerSrv *http.Server
	playerPort := os.Getenv("PLAYER_PORT")
	if playerPort == "" && cfg.Env != "production" {
		playerPort = ":6789"
	}
	if playerPort != "" && playerPort != "none" {
		if !strings.HasPrefix(playerPort, ":") {
			playerPort = ":" + playerPort
		}
		playerMux := http.NewServeMux()
		embedHandler.RegisterRoutes(playerMux)
		gw.RegisterRoutes(playerMux)
		h.RegisterRoutes(playerMux)
		playerMux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/embed/tv/289423/1/1", http.StatusTemporaryRedirect)
		})

		playerHandler := middleware.RecoveryMiddleware(logger)(middleware.CORSMiddleware(playerMux))
		playerSrv = &http.Server{
			Addr:              playerPort,
			Handler:           playerHandler,
			ReadHeaderTimeout: 3 * time.Second,
			ReadTimeout:       10 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       120 * time.Second,
		}

		go func() {
			logger.Info("starting decoupled player edge listener", "port", playerPort)
			if err := playerSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Warn("decoupled player listener stopped", "error", err)
			}
		}()
	}

	// Graceful shutdown handling
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down server gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if playerSrv != nil {
		_ = playerSrv.Shutdown(ctx)
	}
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("server forced to shutdown", "error", err)
	} else {
		logger.Info("server exited cleanly")
	}
}

