# VidLyte Deployment & Environment Guide

This guide provides instructions for deploying VidLyte to cloud platforms (Render, Koyeb, Railway, VPS, Docker) and lists the exact files required in your GitHub repository.

---

## 1. What Files to Put on GitHub

When pushing your repository to GitHub for deployment platform integration, **only commit source code and persistent configuration**. Never commit local binaries, temporary cache files, or private `.env` files.

### Files That MUST Be on GitHub

```
byse-norm/
├── .env.example                      # Template for platform environment variables
├── .gitignore                        # Git exclusion rules
├── go.mod                            # Go module definition (zero external dependencies)
├── main.go                           # Application entrypoint & HTTP server
├── main_test.go                      # Core gateway unit test suite
├── Dockerfile                        # Multi-stage lightweight production Docker build
├── README.md                         # Project overview
├── docs/                             # System design & operations documentation
│   ├── ARCHITECTURE.md
│   ├── SECURITY_AND_M3U8.md
│   ├── MONETIZATION_AND_ANTI_ADBLOCK.md
│   ├── DEPLOYMENT_AND_ENV.md
│   └── API_AND_EMBED.md
├── data/
│   └── vidlyte_config.json           # Default dynamic configuration (safe defaults)
└── internal/                         # Core system packages
    ├── admin/                        # Admin operations & /admin-login-i UI
    ├── cache/                        # High-speed memory caching
    ├── catalog/                      # Asset ID source mapping
    ├── config/                       # Config loaders & dynamic file store
    ├── diskcache/                    # High-speed chunk disk cache
    ├── embed/                        # Player UI, CSS, JS, and embed handler
    ├── gateway/                      # Session-based HLS distributor
    ├── handler/                      # Legacy resolver API handlers
    ├── hls/                          # M3U8 parser & playlist rewriter
    ├── limiter/                      # Rate limiting
    ├── middleware/                   # Recovery, logging, CORS, Gzip
    ├── observability/                # Prometheus metrics & health checks
    ├── parser/                       # Upstream stream parsers
    ├── portal/                       # Webmaster portal & embed builder
    ├── proxy/                        # HMAC stream signing & proxy engine
    ├── service/                      # Multi-source resolver service
    ├── session/                      # Cryptographic session manager
    ├── tmdb/                         # TMDB metadata adapter
    └── upstream/                     # SSRF-protected HTTP client
```

### Files That MUST NOT Be on GitHub (Ignored by `.gitignore`)

- `resolver.exe` and `*.exe~` (Compiled local Windows executables).
- `.env` (Your private production secrets).
- `scratch/` (Temporary testing scripts and local cache).
- `archive/` (Old backup files).
- `*.log` (Runtime log files).

---

## 2. Environment Variables Reference

Configure these environment variables in your deployment platform's **Environment** or **Variables** settings tab:

| Variable Name | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `PORT` | **Yes** | `8080` | Port for the HTTP server. Auto-assigned by Render/Koyeb/Railway. |
| `ENV` | **Yes** | `production` | Set to `production` in live environments. |
| `VIDLYTE_ADMIN_SECRET` | **Yes** | *(Auto-generated)* | 32+ character secret to access `/admin-login-i`. |
| `STREAM_SECRET` | **Yes** | *(Default fallback)* | 32+ byte hex key for HMAC-SHA256 M3U8 token signing. |
| `GATEWAY_HMAC_SECRET` | **Yes** | *(Required in prod)* | Secret key for `/v1/playback-sessions` tokens. |
| `PLAYER_PORT` | No | `none` | Decoupled player port (`none` for single-port hosts). |
| `LOG_LEVEL` | No | `info` | Logging verbosity (`info`, `debug`, `warn`, `error`). |
| `GATEWAY_TOKEN_TTL` | No | `4h` | Validity duration for playback tokens (`4h`, `1h`, `15m`). |
| `GATEWAY_UPSTREAM_HOSTS` | No | *(Comprehensive)* | Comma-separated whitelist of allowed upstream hostnames. |
| `GATEWAY_BIND_CLIENT_IP` | No | `false` | Bind tokens to visitor IP. Keep `false` for mobile networks. |
| `GATEWAY_RATE_LIMIT_ENABLED`| No | `true` | Token bucket rate limiting against abusive scrapers. |
| `TMDB_API_KEY` | No | `""` | Optional TMDB key for automatic poster & overview enrichment. |

---

## 3. Deployment Guides by Platform

### Option A: Render (render.com) — Free Tier

1. Sign in to [Render Dashboard](https://dashboard.render.com/) and click **New +** ➔ **Web Service**.
2. Connect your GitHub repository (`byse-norm`).
3. Set the following build and run settings:
   - **Name**: `vidlyte` (or your preferred name)
   - **Language**: `Go` (or `Docker`)
   - **Build Command**: `go build -o server .`
   - **Start Command**: `./server`
   - **Instance Type**: `Free`
4. In the **Environment Variables** section, add:
   - `ENV`: `production`
   - `VIDLYTE_ADMIN_SECRET`: `<your-random-32-character-secret>`
   - `STREAM_SECRET`: `<your-random-32-character-secret>`
   - `GATEWAY_HMAC_SECRET`: `<your-random-32-character-secret>`
   - `PLAYER_PORT`: `none`
5. Click **Create Web Service**. Your service will build and be live at `https://vidlyte.onrender.com`.

---

### Option B: Koyeb (koyeb.com) — Free Tier

1. Sign in to [Koyeb Dashboard](https://app.koyeb.com/) and click **Create Service**.
2. Select **GitHub** as the deployment method and pick your repository.
3. Choose **Dockerfile** or **Buildpack** (Go).
4. Set the internal port to `8080`.
5. Under **Environment Variables**, define:
   - `ENV=production`
   - `VIDLYTE_ADMIN_SECRET=...`
   - `STREAM_SECRET=...`
   - `GATEWAY_HMAC_SECRET=...`
   - `PLAYER_PORT=none`
6. Click **Deploy**. Koyeb will deploy globally on their edge network with automatic SSL.

---

### Option C: Railway (railway.app)

1. Click **New Project** ➔ **Deploy from GitHub repo**.
2. Select your repository. Railway automatically detects the Go application.
3. Under **Variables**, add the variables from `.env.example`.
4. Under **Settings** ➔ **Networking**, click **Generate Domain** to get your public HTTPS URL.

---

### Option D: Ubuntu VPS / Bare-Metal with Systemd

1. SSH into your VPS and install Go:
   ```bash
   sudo apt update && sudo apt install -y golang git
   ```
2. Clone your repository:
   ```bash
   git clone https://github.com/yourusername/vidlyte.git /opt/vidlyte
   cd /opt/vidlyte
   go build -o vidlyte-server .
   ```
3. Create a systemd service file `/etc/systemd/system/vidlyte.service`:
   ```ini
   [Unit]
   Description=VidLyte Sovereign Streaming Engine
   After=network.target

   [Service]
   Type=simple
   User=www-data
   WorkingDirectory=/opt/vidlyte
   ExecStart=/opt/vidlyte/vidlyte-server
   Restart=always
   RestartSec=3
   EnvironmentFile=/opt/vidlyte/.env

   [Install]
   WantedBy=multi-user.target
   ```
4. Start and enable the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now vidlyte
   ```

---

## 4. Cloudflare DNS & SSL Configuration

When pointing custom domains to your VidLyte deployment:
1. **SSL/TLS Mode**: Set to **Full** or **Full (Strict)** in Cloudflare SSL settings.
2. **Proxy Status**: Keep the orange cloud (**Proxied**) enabled for CDN caching, DDoS mitigation, and origin IP concealment.
3. **WebSockets**: Enable WebSockets under Network settings if real-time admin telemetry is desired.
