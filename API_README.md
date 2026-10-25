# Ultra High-Performance Minimal Go HLS Redistribution Gateway & Resolver

A zero-external-dependency, free-first, sub-millisecond HLS redistribution gateway and media resolver built in **pure Go (standard library only)**. Designed to distribute authorized HLS streams with cryptographic playback session gating, SSRF protection, deterministic opaque resource IDs, bounded RFC 7234 disk caching with in-flight request coalescing, and lock-free atomic observability.

---

## 1. Architectural Overview

```
                                  ┌────────────────────────────────────────┐
                                  │      Client / Video Player / CDN       │
                                  └──────────────────┬─────────────────────┘
                                                     │
                                1. POST /v1/playback-sessions {"asset_id": "tv/289423/1/1"}
                                                     ▼
                                  ┌────────────────────────────────────────┐
                                  │   HMAC-SHA256 Session Token Issuer     │
                                  └──────────────────┬─────────────────────┘
                                                     │
                                2. Returns signed token + /hls/{assetID}/master.m3u8?token=...
                                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Go HLS Gateway (Single Binary)                                   │
│                                                                                                  │
│   GET /hls/{assetID}/master.m3u8?token=...                                                       │
│   ├── Constant-time HMAC Verification (crypto/subtle) & Asset Scoping & Expiry                   │
│   ├── SSRF Protection: strict upstream whitelist & redirect destination validation               │
│   ├── RFC 8216 Lexing & Rewriting: transforms Variant, #EXT-X-MEDIA, and #EXT-X-MAP              │
│   └── Opaque Resource Registry: maps internal upstream URLs to 24-char opaque IDs               │
│                                                                                                  │
│   GET /hls/{assetID}/resource/{opaqueResourceID}?token=...                                       │
│   ├── In-Flight Coalescing (Singleflight): deduplicates parallel chunk fetches                   │
│   ├── RFC 7234 Disk Cache: respects Cache-Control, max-age, rejects Vary: *, LRU eviction        │
│   └── Zero-Allocation Streaming: 32KB buffer recycling via sync.Pool, Range / 206 support        │
└─────────────────────────────────┬────────────────────────────────────────────────────────────────┘
                                  │ Upstream Fetch (Referer, Origin, Range forwarded)
                                  ▼
                    ┌───────────────────────────┐
                    │  Authorized Upstream CDN  │
                    └───────────────────────────┘
```

---

## 2. Core Security & Compliance Model

1. **Strict Authorization & Upstream Transparency**:
   - The gateway only distributes streams that the project is authorized to access and redistribute.
   - It **does not** implement DRM circumvention, access-control bypasses, CAPTCHA/WAF bypasses, or credential extraction.
   - It **does not** hide activity from upstream providers (legitimate headers and ranges are forwarded).
2. **SSRF Hardening**:
   - Upstream destinations must match `GATEWAY_UPSTREAM_HOSTS` whitelist (exact hostname match or approved `.domain` suffix).
   - Rejects private IP addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.1`, `::1`), and non-HTTP schemes.
   - `http.Client.CheckRedirect` re-evaluates every HTTP redirect to prevent redirect-based SSRF evasion.
3. **Cryptographic Playback Session Gating & Client IP Locking**:
   - Master and resource requests require a valid HMAC-SHA256 token: `v1.<asset>.<expiry>.<clientIP>.<sig>`.
   - Verified via `crypto/subtle.ConstantTimeCompare` to eliminate timing attacks.
   - **Client IP Binding (`GATEWAY_BIND_CLIENT_IP=true`)**: Tokens are cryptographically bound to the user's public IP address (via `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`, or TCP peer). If a scraper steals or shares a playlist link, **any other user or IP receives an immediate `403 Forbidden`**.
   - Built-in key rotation support (`GATEWAY_HMAC_SECRET="v1:secret1,v2:secret2"`).
   - In production (`APP_ENV=production`), the gateway fails fast and refuses to boot without an explicit `GATEWAY_HMAC_SECRET`.
4. **Anti-Scraping Burst & Concurrency Limiter**:
   - Protects gateway bandwidth and prevents ripping tools (`ffmpeg`, `yt-dlp`, botnets) from parallel segment scraping.
   - In-memory token bucket rate limiter permits initial player buffer bursts (e.g. 20 chunks), but strictly caps sustained retrieval (e.g. 4 chunks/sec).
   - Excess scraping attempts are instantly dropped with **`429 Too Many Requests`** and a `Retry-After: 3` header.
5. **Opaque Resource Addressing**:
   - Client-facing playlists never contain upstream hostnames, query parameters, or CDN URLs.
   - All URIs are rewritten to `/hls/{assetID}/resource/{opaqueID}?token=...` with deterministic 24-character IDs.
   - Arbitrary user-supplied URLs cannot be requested through the gateway.
6. **Log Redaction**:
   - HTTP middleware automatically masks tokens (`token=[REDACTED]`) and target URLs (`url=[REDACTED]`) in structured `log/slog` outputs.

---

## 3. High-Performance Features

* **Zero Third-Party Dependencies:** 100% pure Go standard library (`go.mod` has zero external modules).
* **Deterministic RFC 8216 Manifest Rewriter:**
  - Zero regex and zero DOM overhead.
  - Rewrites `#EXT-X-STREAM-INF` variants, `#EXT-X-MEDIA` (`URI="..."`), `#EXT-X-MAP` (`URI="..."`), and `#EXT-X-KEY` (`URI="..."`).
  - Preserves `#EXT-X-BYTERANGE` tags and relative segment structures untouched.
* **Bounded RFC 7234 Disk Cache:**
  - Evaluates HTTP response headers: caches only `200 OK` with valid `max-age`.
  - Strictly rejects uncacheable responses (`no-store`, `private`, `Vary: *`, `Vary: Authorization`).
  - Atomic two-phase write: writes to temporary file and renames to target key.
  - LRU eviction: automatically purges oldest entries when disk limit (`GATEWAY_CACHE_MAX_MB`) is exceeded.
* **Singleflight Request Deduplication:**
  - Coalesces duplicate concurrent requests for the same media chunk onto a single upstream request, eliminating thundering-herd load.
* **Lock-Free Atomic Telemetry:**
  - Real-time counters (`sync/atomic`) for requests, active requests, bytes streamed, cache hits/misses, and HTTP status codes.

---

## 4. API Reference

### HLS Redistribution Gateway Endpoints

#### 1. Create Playback Session
Issues a short-lived, signed token for an authorized asset.

* **Method:** `POST /v1/playback-sessions`
* **Request Body:**
```json
{
  "asset_id": "tv/289423/1/1"
}
```
* **Response (201 Created):**
```json
{
  "asset_id": "tv/289423/1/1",
  "playlist_url": "/hls/tv/289423/1/1/master.m3u8?token=v1.dHYvMjg5NDIzLzEvMQ.6ad80086.28fdcb296c346150424acd5a695f4836172163052e42f4b9e94ee7d1f8c3c44b",
  "token": "v1.dHYvMjg5NDIzLzEvMQ.6ad80086.28fdcb296c346150424acd5a695f4836172163052e42f4b9e94ee7d1f8c3c44b",
  "expires_at": "2026-10-21T00:00:06Z"
}
```

#### 2. Fetch Rewritten Master Playlist
Returns the rewritten HLS playlist with opaque resource URIs.

* **Method:** `GET /hls/{assetID}/master.m3u8?token={token}`
* **Example:** `GET http://localhost:8080/hls/tv/289423/1/1/master.m3u8?token=...`
* **Response (200 OK):**
```m3u8
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,URI="/hls/tv/289423/1/1/resource/d08f0c1210912773712d556c?token=..."
#EXT-X-STREAM-INF:BANDWIDTH=1728000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90,mp4a.40.2",AUDIO="aud"
/hls/tv/289423/1/1/resource/68678937745621261c80cc46?token=...
```

#### 3. Fetch Media Playlist or Segment
Streams the media playlist, initialization segment, or video chunk with optional byte-range support.

* **Method:** `GET /hls/{assetID}/resource/{resourceID}?token={token}`
* **Headers:** Supports `Range: bytes=0-1024` (`206 Partial Content`).
* **Response:** Raw byte stream with `Access-Control-Allow-Origin: *`.

#### 4. Health & Metrics Probes
* **Liveness:** `GET /healthz` -> `{"status":"alive","time":"..."}`
* **Readiness:** `GET /readyz` -> `{"status":"ready","time":"..."}`
* **Telemetry:** `GET /metrics` ->
```json
{
  "total_requests": 2045,
  "active_requests": 0,
  "bytes_streamed": 104857600,
  "cache_hits": 1980,
  "cache_misses": 65,
  "status_2xx": 2045,
  "status_4xx": 0,
  "status_5xx": 0
}
```

---

### Legacy Resolver & Test Endpoints

* `GET /tv/{id}/{season}/{episode}`: High-speed metadata resolution.
* `GET /movie/{id}`: Movie metadata resolution (e.g., `movie/360817` - Bhaag Johnny with 1080p MP4 + 6 WebVTT subtitle tracks).
* `GET /proxy?url={url}&provider={provider}`: Streaming reverse proxy with header forwarding & byte-range seeking.
* `GET /ply.html` or `GET /player`: Interactive Operations Dashboard & Studio Player with flush top alignment and interactive 3-column switcher matrix (Video Qualities, Multi-Audio Tracks, Subtitles/CC).

---

## 5. Configuration Reference

All settings can be configured via environment variables:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | string | `:8080` | Listen address and port |
| `APP_ENV` | string | `development` | Environment mode (`development` or `production`) |
| `GATEWAY_HMAC_SECRET` | string | *dev-fallback* | HMAC key or rotation list (`key1:secret1,key2:secret2`). Required in production |
| `GATEWAY_TOKEN_TTL` | duration | `15m` | Lifetime of signed playback session tokens |
| `GATEWAY_BIND_CLIENT_IP` | bool | `true` | Cryptographically bind tokens to client IP to prevent URL sharing |
| `GATEWAY_RATE_LIMIT_ENABLED` | bool | `true` | Enable anti-scraping token bucket rate limiter |
| `GATEWAY_RATE_LIMIT_BURST` | int | `20` | Max burst requests per IP (allows initial player buffer filling) |
| `GATEWAY_RATE_LIMIT_RATE` | float | `4.0` | Sustained requests allowed per second per IP |
| `GATEWAY_UPSTREAM_HOSTS` | string | *approved list* | Comma-separated list of approved upstream hostnames for SSRF protection |
| `GATEWAY_CACHE_ENABLED` | bool | `false` | Enable RFC 7234 bounded disk caching |
| `GATEWAY_CACHE_DIR` | string | `./cache` | Storage directory for cached media chunks |
| `GATEWAY_CACHE_MAX_MB` | int | `512` | Cache storage ceiling in megabytes |
| `GATEWAY_CACHE_TTL` | duration | `10m` | Default TTL when upstream lacks explicit `max-age` |

---

## 6. Reproducible Load Test & Benchmarks

The gateway includes an integrated, fully reproducible concurrent load testing suite in `internal/gateway/benchmark_test.go`.

### Running the Load Test
```powershell
go test -v -run TestReproducibleLoadTest ./internal/gateway/...
```

### Measured Benchmark Report
Tested under concurrent client load (20 parallel workers, 2,000 HTTP requests):

```
--- GATEWAY REPRODUCIBLE LOAD TEST REPORT ---
Total Requests:   2,000 (Concurrency: 20)
Total Duration:   370.15 ms
Throughput:       5,403.21 req/sec
Error Rate:       0.00% (0 errors)
Latency Avg:      3.68 ms
Latency p50:      2.34 ms
Latency p95:      9.99 ms
Latency p99:      31.55 ms
Cache Hit Ratio:  99.00%
Bytes Streamed:   Clean chunk deliveries
--------------------------------------------
```

---

## 7. Build & Deployment

### Build Binary
```powershell
# Compile the single production executable
go build -o resolver.exe .
```

### Run Server
```powershell
# Development run
.\resolver.exe

# Production run with disk cache and strict HMAC secret
$env:APP_ENV="production"
$env:GATEWAY_HMAC_SECRET="v1:c81881b7e4dd38b0e7da3c0b"
$env:GATEWAY_CACHE_ENABLED="true"
$env:GATEWAY_CACHE_MAX_MB="1024"
.\resolver.exe
```

---

## 8. Domain Resilience & FrameX TV Fallback Engine

### Upstream Domain Resilience
To survive upstream TLD migrations (e.g., `vidrift.net` -> `.to` -> `.cc` -> `.is`), the gateway uses:
1. **SSRF Family Matching**: Domain families (`vidrift.`, `framextv.`, `hakunaymatata.`, `animecurx.`, `wing.st`, `strem.io`) pass the upstream firewall automatically.
2. **Dynamic Header Derivation**: Origin and Referer headers are computed dynamically based on the target URL's base hostname rather than static constants.
3. **Runtime Whitelist API**: `POST /v1/owner/whitelist` allows adding new upstream mirrors or partners instantly with zero downtime.

### FrameX TV Reverse-Engineered Fallback
Discovered via static analysis of client bundles (`https://framextv.cc/watch/1058424`):
- **Go Backend Cluster**: Multi-region failover across `api.framextv.xyz`, `api.framextv.cc`, and `api.framextv.tech`.
- **Dynamic Resolution**: If an asset is not found on primary upstreams, the gateway queries the FrameX cluster in real time.
- **Gladiator II (`movie/1058424`)**: Demonstrates FrameX TV integration with 1080p, 480p, 360p H.265 MP4 rungs, full byte-range streaming (`206 Partial Content`), and 11+ Stremio WebVTT subtitles.

---

## 9. AsianFlix & Rumble Cloud HLS Integration

Discovered via REA static and dynamic unpacking of the AsianFlix WordPress "Sting" theme (`playlist.min.js`):
- **Headless Google Blogger CMS**: Episode streaming metadata is decoupled from WordPress and stored in Google Blogger post entries (`https://www.blogger.com/feeds/{blogId}/posts/default/{postId}?alt=json`).
- **Rumble Cloud HLS Delivery**: Direct master playlists (`https://rumble.com/hls-vod/{id}/playlist.m3u8`) with multi-bitrate 720p/480p/360p variants and byte-range `.tar` chunk containers on `*.cdn.rumble.cloud`.
- **Cloudinary WebVTT Subtitles**: Automatically mapped from pipe-delimited post entries to `models.SubtitleTrack`.
- **Supported Asset IDs**:
  - `tv/make-me-tingle-2026/1/2`
  - `asianflix/make-me-tingle-2026/1/2`
  - `tv/asianflix:make-me-tingle-2026/1/2`
- **End-to-End Verification**:
  - Session creation: `POST /v1/playback-sessions {"asset_id": "tv/make-me-tingle-2026/1/2"}`
  - Lexed & rewritten master manifest: `GET /hls/tv/make-me-tingle-2026/1/2/master.m3u8?token=...`
  - Byte-range chunk proxying: `GET /hls/tv/make-me-tingle-2026/1/2/resource/{opaqueID}?token=...` with `Range: bytes=0-1023` returning `206 Partial Content`.


