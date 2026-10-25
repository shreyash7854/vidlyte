# VidLyte API & Embed Integration Reference

This document provides complete reference specifications for webmasters embedding VidLyte players, developers consuming REST APIs, and administrators automating configuration.

---

## 1. Webmaster Embed URLs

Webmasters integrate VidLyte using standard responsive HTML `<iframe>` tags.

### Movie Embed Endpoint
```
GET /embed/movie/{tmdb_or_imdb_id}
```
**Example**:
```html
<iframe src="https://your-domain.com/embed/movie/550" 
        width="100%" height="100%" frameborder="0" allowfullscreen
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation">
</iframe>
```

### TV Series Embed Endpoint
```
GET /embed/tv/{tmdb_or_imdb_id}/{season_number}/{episode_number}
```
**Example**:
```html
<iframe src="https://your-domain.com/embed/tv/1399/1/1" 
        width="100%" height="100%" frameborder="0" allowfullscreen
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation">
</iframe>
```

---

## 2. Embed Query Parameters

Customize player behavior by appending query parameters:

| Parameter | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `autoplay` | `0` or `1` | `0` | Auto-starts playback on load (subject to browser autoplay policies). |
| `server` | `string` | *(Primary)* | Pre-selects server by name or slug (e.g. `orion`, `vela`, `atlas`). |
| `title` | `string` | *(Auto)* | Overrides media display title shown in header and pause screen. |
| `kicker` | `string` | *(Auto)* | Overrides series episode kicker (e.g. `S1 · E2`). |
| `overview` | `string` | *(Auto)* | Overrides synopsis displayed in the pause screen. |
| `poster` | `url` | *(Auto)* | Custom backdrop poster image displayed when paused. |
| `color` | `hex` | `#f43f5e` | Custom brand accent color used for progress bars and active toggles. |

**Full Parameter Example**:
```
https://your-domain.com/embed/tv/1399/1/1?autoplay=1&server=orion&color=6366f1
```

---

## 3. Streaming Gateway & Tokenized Proxy Endpoints

### A. Signed HLS Stream Proxy
```
GET /api/proxy?url={target_url}&exp={unix_timestamp}&sig={hmac_sha256}
```
Streams M3U8 playlists or media chunks (`.ts` / `.m4s`).
- **Headers Verified**: `Range`, `If-Modified-Since`.
- **Response**: Rewritten M3U8 with signed child URLs, or raw binary video stream.
- **Errors**:
  - `400 Bad Request`: Missing `url`, `exp`, or `sig`.
  - `403 Forbidden`: Token expired or signature mismatch.
  - `502 Bad Gateway`: Upstream source unreachable or rejected connection.

### B. Timed Session Distributor (Enterprise Mode)
```
POST /v1/playback-sessions
Content-Type: application/json

{
  "asset_id": "movie-550",
  "client_ip": "203.0.113.195",
  "source_url": "https://upstream.cdn/hls/master.m3u8"
}
```
**Response**:
```json
{
  "session_id": "sess_89f0a1c2",
  "stream_url": "/hls/movie-550/master.m3u8?token=eyJhbGciOi...",
  "expires_at": 1792982400
}
```

---

## 4. Admin API Reference (`/admin/api/*`)

All administrative endpoints require an authorized session cookie issued via `/admin-login-i`.

### Get Active Configuration
```
GET /admin/api/config
```
**Response**:
```json
{
  "brand": {
    "name": "VidLyte",
    "accent_color": "#f43f5e",
    "logo_url": ""
  },
  "servers": [
    { "name": "Orion", "endpoint": "https://embed.vidrift.net", "enabled": true, "priority": 1 }
  ],
  "proxy_workers": [
    { "url": "https://worker1.yoursubdomain.workers.dev/proxy?url=", "enabled": true }
  ],
  "monetization": {
    "enabled": true,
    "provider": "adsterra",
    "adsterra_tag": "//pl12345678.highratecpm.com/a1/b2/c3.js",
    "anti_adblock_enabled": true,
    "anti_adblock_message": "Ad blocker detected. Please turn off to continue."
  }
}
```

### Update Configuration (Live Hot-Reload)
```
POST /admin/api/config
Content-Type: application/json

{
  "brand": { ... },
  "servers": [ ... ],
  "proxy_workers": [ ... ],
  "monetization": { ... }
}
```
**Response**:
```json
{
  "status": "ok",
  "message": "Configuration saved and dynamically reloaded"
}
```

### Test Cloudflare Worker Latency
```
POST /admin/api/proxy-test
Content-Type: application/json

{
  "worker_url": "https://worker1.yoursubdomain.workers.dev/proxy?url="
}
```
**Response**:
```json
{
  "status": "ok",
  "latency_ms": 42,
  "http_code": 200
}
```

---

## 5. Health & Observability Endpoints

| Endpoint | Method | Output | Description |
| :--- | :---: | :---: | :--- |
| `/healthz` | `GET` | `ok` (200) | Liveness probe for Docker, Render, Koyeb orchestrators. |
| `/readyz` | `GET` | `ready` (200) | Readiness probe indicating all internal caches and handlers are mounted. |
| `/metrics` | `GET` | Prometheus Text | Internal telemetry metrics (requests, latency, cache hits). |
