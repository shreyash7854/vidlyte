# VidLyte Cloudflare Edge Worker

> **High-Performance Sovereign HLS Streaming Gateway & Proxy Swarm Node running on Cloudflare Workers powered by Go WebAssembly.**

The **VidLyte Edge Worker** ([cloudflare-worker/src/index.js](file:///d:/@1/byse-norm/cloudflare-worker/src/index.js)) is a globally distributed, zero-leak streaming gateway and sovereign embed player deployed on Cloudflare Workers. It dynamically resolves media streams, decrypts upstream manifests, proxies media chunks via encrypted tokens, and serves a full-featured video player with multi-audio dubs and transparent pause card logos.

---

## 1. Directory Structure

```
cloudflare-worker/
├── wrangler.toml              # Cloudflare Worker deployment configuration
├── package.json               # NPM scripts (dev, deploy, tests, watchdog)
├── AGENTS.md                  # Scoped AI/human development rules
├── ENV_TODO.md                # Pending secrets/variables checklist (no values)
├── LAUNCH_CHECKLIST.md        # Must-pass launch gates and sign-off
├── WATCHDOG.md                # External monitoring + Telegram runbook
├── scripts/watchdog.mjs       # Real-playback-chain uptime watchdog
├── scripts/sweep.mjs          # Random TMDB playback coverage sweep
├── scripts/quota.mjs          # Workers Free daily-quota guard
├── test_phase1..7.mjs         # Contract/static test harnesses
└── src/
    ├── index.js               # Core edge worker gateway & request router
    ├── player.html            # Sovereign video player with Hls.js & custom controls
    ├── portal.html            # Public landing page with interactive sandbox
    ├── admin.html             # Mission Control Admin Vault UI
    ├── wasi.js                # Zero-dependency WASI Preview 1 shim
    └── vidlyte.wasm           # Compiled Go WASM binary (optional dual-engine)
```

Repo-level monitoring lives in `.github/workflows/uptime-watchdog.yml`,
`.github/workflows/tmdb-sweep.yml` and `.github/workflows/quota-watch.yml`;
repository rules live in the root `AGENTS.md`.

---

## 2. API & Route Map

### 🎬 Player & Embed Routes
* **`GET /`**
  Public landing portal with interactive sandbox, preset selectors (Game of Thrones, Maxton Hall, Fight Club, Severance), and dynamic code generator (HTML `<iframe>`, React component, API endpoint).
* **`GET /embed/tv/:id/:season/:episode`**
  Embedded player for TV episodes (e.g. `/embed/tv/250670/1/1` for Maxton Hall, `/embed/tv/1399/1/2` for Game of Thrones).
* **`GET /embed/movie/:id`**
  Embedded player for movies (e.g. `/embed/movie/550` for Fight Club).

### 📡 HLS Manifest & Streaming Gateway
* **`GET /hls/:assetId/master.m3u8?token=...`**
  RFC 8216 master playlist endpoint. Validates HMAC token, retrieves canonical upstream stream, and rewrites all video rungs and audio dub tags into authenticated edge routes.
* **`GET /hls/:assetId/res/:opaqueId?token=...`**
  Sub-manifest gateway for video variant playlists and regional audio tracks (e.g., German, Hindi, Spanish, Tamil, Telugu, Portuguese).
* **`GET /hls/:assetId/client.m3u8?token=...&url=...`**
  Client-assisted master gateway. Some providers (currently BigBang) gate their resolver API to a browser origin that Cloudflare egress cannot impersonate. The player resolves the signed upstream HLS URL in the browser and hands it to this token-validated, allowlist-enforced route, which rewrites every sub-resource back through `/hls/.../res/` and `/stream/chunk/`. The player only upgrades to it when the server-side stream exposes a single audio track.
* **`GET /stream/chunk/:opaqueId`**
  AES-256-GCM encrypted media chunk proxy. Decodes target upstream CDN URL and streams video/audio segments (`.m4s`, `.mp4`, `.ts`, `.aac`) directly to the client with edge caching (`Cache-Control: public, max-age=31536000, immutable`).
* **`GET /tmdb-image/*`**
  Edge-cached TMDB image and logo proxy that bypasses regional ISP/DNS blockades (e.g. in India).

### 🔎 Metadata & Discovery
* **`GET /api/tmdb/search?q=...&type=multi|movie|tv`**: Sanitised TMDB search results (cached per isolate).
* **`GET /api/tmdb/trending?type=all|movie|tv&window=day|week`**: Trending titles for integrations and ID lookup.
* **`GET /api/tmdb/tv/:id/seasons`**: Season list for the player episode browser.
* **`GET /api/tmdb/tv/:id/season/:season`**: Episodes for one season.
* **`POST /api/telemetry/engagement`**: Allowlisted, PII-free engagement events (`play`, `resume`, `complete`, `share`, `subtitle_change`).

### 🔒 Administration & Swarm Probe
* **`GET /vly-ops-7x`** (or configured `ADMIN_ROUTE`): Mission Control Operations Vault.
* **`POST /vly-ops-7x/auth`**: Admin password authentication with signed cookie session.
* **`GET /health`** or **`GET /ping`**: Lightweight liveness probe and telemetry reporting.
* **`GET /health?deep=1`**: Readiness report with config checks, swarm state, provider health, circuit-breaker state, cache sizes and the persisted playback canary.
* **`GET /health/ready`** (alias **`/readyz`**): Strict readiness for the external watchdog. Returns `200` only when secrets, KV, runtime config and the playback canary pass; otherwise `503` with `reasons[]`. Add `?canary=1` to force a live resolver check.
* **`GET /metrics`**: Legacy counters plus the Phase 3 metrics registry, health grade and rate-limiter state (admin session required).
* **`GET /vly-ops-7x/api/diagnostics`**: Full diagnostics snapshot, including recent requests and audit entries (admin session required).
* **`GET /vly-ops-7x/api/audit`**: Admin audit trail (admin session required).
* **`GET /vly-ops-7x/api/config/export`**: Download the whitelisted runtime config (admin session required).
* **`POST /vly-ops-7x/api/config/import`**: Validate, apply and persist a config document (admin session + CSRF required).
* **`GET /vly-ops-7x/api/config/history`**: List the last 10 config snapshots; `?id=<id>` returns one snapshot plus a diff (admin session required).
* **`POST /vly-ops-7x/api/config/rollback`**: Restore a snapshot exactly, persist it and record the rollback (admin session + CSRF required).
* **`GET /vly-ops-7x/api/providers/health`**: Provider health, latency and breaker state (admin session required).
* **`POST /vly-ops-7x/api/providers/probe`**: Actively probe every provider and persist the result (admin session required).
* **`POST /vly-ops-7x/api/providers/test`**: Resolve one asset through one provider without leaking the upstream URL (admin session required).
* **`GET /vly-ops-7x/api/alerts/status`**: Telegram/webhook configuration state without leaking secrets (admin session required).
* **`POST /vly-ops-7x/api/alerts/test`**: Send a forced Telegram test alert (admin session + CSRF required).
* **`POST /vly-ops-7x/api/watchdog/canary`**: Run the real playback canary now and persist the result (admin session + CSRF required).

---

## 3. Deployment

### Quick Deploy:
```powershell
npx wrangler deploy -c cloudflare-worker\wrangler.toml
```

Then set the two secrets (never put them in `[vars]`, or a later deploy will overwrite them):

```powershell
npx wrangler secret put HMAC_SECRET
npx wrangler secret put ADMIN_SECRET
# Optional but required for alerting:
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

The external watchdog also needs the same Telegram values as **GitHub repository
secrets** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). See
[WATCHDOG.md](WATCHDOG.md) for the full setup and runbook.

Once deployed, your Worker will be live globally at:
`https://vid.lyte.workers.dev`

---

## 4. Environment Variables (`wrangler.toml`)

| Variable | Type | Default | Description |
|---|---|---|---|
| `DEFAULT_TTL_SEC` | Integer | `900` (15 min) | Playback session token lifetime |
| `SWARM_NODES` | String | `""` | Comma-separated list of secondary edge worker origins for multi-account load distribution |
| `BIND_CLIENT_IP` | String | `"false"` | When `"true"`, playback tokens are bound to the requesting client IP |
| `UPSTREAM_ALLOWLIST` | String | `""` | Extra comma-separated upstream host suffixes allowed by `/proxy` and resolver guards |
| `ADMIN_SECRET` | Secret | **required** | Secret password for Admin Mission Control (`/vly-ops-7x`). Admin access fails closed when unset. |
| `ADMIN_ROUTE` | Variable | `/vly-ops-7x` | Custom obfuscated URL path for the admin vault |
| `HMAC_SECRET` | Secret | Built-in fallback | Cryptographic key used for HMAC tokens and AES-256-GCM chunk tokens. Supports rotation: `k1:old,k2:new`. |
| `CONFIG_KV` | KV binding | unset | Optional KV namespace that persists admin configuration (swarm nodes, branding, monetization) across isolates. |
| `RATE_LIMIT_ENABLED` | String | `"true"` | Enables per-IP fixed-window rate limiting. |
| `RATE_LIMIT_PER_MINUTE` | Integer | `240` | General bucket (portal and page routes). |
| `RATE_LIMIT_API_PER_MINUTE` | Integer | `120` | `/api/*` bucket. |
| `RATE_LIMIT_MEDIA_PER_MINUTE` | Integer | `1800` | HLS, segments, subtitles, images and `/proxy`. |
| `RATE_LIMIT_ADMIN_PER_MINUTE` | Integer | `40` | Admin routes and `/metrics`. |
| `ADMIN_SESSION_TTL_SEC` | Integer | `43200` (12 h) | Admin session lifetime in seconds; capped at 7 days. |
| `ALERT_WEBHOOK_URL` | String | `""` | Optional Slack/Discord/JSON webhook notified when scheduled maintenance finds unhealthy swarm nodes or providers. |
| `TELEGRAM_BOT_TOKEN` | Secret | unset | Telegram bot token used for open/recovery alerts. Never put it in `[vars]`. |
| `TELEGRAM_CHAT_ID` | Secret | unset | Telegram chat/group id that receives alerts. |
| `TELEGRAM_ALERTS_ENABLED` | String | `"true"` | Enables Telegram delivery when the token and chat id are present. |
| `ALERT_MIN_SEVERITY` | String | `"warning"` | Minimum severity to notify: `info`, `warning` or `critical`. |
| `ALERT_COOLDOWN_MIN` | Integer | `15` | Duplicate-incident suppression window in minutes. |
| `WATCHDOG_CANARY_ENABLED` | String | `"true"` | Runs the playback canary during scheduled maintenance. |
| `WATCHDOG_CANARY_ASSET` | String | `"tv/66732/1/1"` | Asset used for the canary (`tv/<id>/<season>/<episode>` or `movie/<id>`). |
| `WATCHDOG_CANARY_PROVIDER` | String | `"framextv"` | Worker-reachable provider used by the canary. |
| `WATCHDOG_CANARY_MAX_AGE_SEC` | Integer | `1800` | Canary older than this makes `/health/ready` report not ready. |
| `WATCHDOG_REQUIRE_CANARY` | String | `"false"` | When `"true"`, a missing canary also fails readiness. |

### Optional persistent config (KV)

Create a KV namespace and bind it as `CONFIG_KV`:

```powershell
npx wrangler kv namespace create CONFIG_KV
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the returned id. Without it the admin panel still works, but configuration is per-isolate and resets on cold starts.

---

## 5. Admin Panel FAQ: Do I Only Have to Submit the Worker URL?

### ❓ Question: In the Admin Panel, do I only have to submit the worker URL?

### ✅ Answer:
**For standard single-worker operation, you do NOT have to submit anything in the Admin Panel.**
Your deployed worker (`https://vid.lyte.workers.dev`) is **100% autonomous and fully functional out of the box**. It resolves TMDB titles, parses streams, rewrites manifests, and streams chunks without requiring any setup in the Admin Panel.

### When should you submit a URL in the Admin Panel?
The Admin Panel ([https://vid.lyte.workers.dev/vly-ops-7x](https://vid.lyte.workers.dev/vly-ops-7x)) has two specific URL inputs depending on what you want to do:

1. **Worker Swarm (`pane-swarm`)**:
   * **Purpose**: Distribute bandwidth and bypass Cloudflare free-tier limits across *multiple* free Cloudflare accounts.
   * **Worker code**: There is no separate "node" build. Deploy **the same worker in this folder** on the second account (`npx wrangler deploy --name vidlyte-node-1`) and set the same `HMAC_SECRET` (plus `UPSTREAM_ALLOWLIST` if customised).
   * **Action**: Paste that node's base URL (e.g. `https://vidlyte-node-1.myaccount.workers.dev`) and click **Add Node**.
   * **Automatic switching**: Yes. The primary gateway orders registered nodes by the selected strategy (latency / random / round-robin), tries the next node on failure, and cools a node down for 60s after 3 failures. No DNS or viewer-side changes are needed.
   * **If you only have one worker**: Leave this empty. The primary worker streams directly.

2. **Player Fleet / Custom Domains (`pane-fleet`)**:
   * **Purpose**: Brand your embed player with your own domain (e.g. `https://embed.mywebsite.com`) rather than `vid.lyte.workers.dev`.
   * **Action**: Enter your custom domain here and click **Register Domain**. Embed iframe generator snippets will automatically use your custom domain.
   * **If you don't use a custom domain**: Leave this empty. The default `*.workers.dev` domain is used automatically.

---

## 6. Phase 0 — Production Baseline

Phase 0 hardens the gateway for real traffic without adding paid services:

* **Persistent config**: `CONFIG_KV` stores the runtime config (branding, swarm nodes, providers, monetization, AsianFlix overrides). Without it, config is per-isolate and reported as `memory_only`.
* **No static fallback streams**: expired hard-coded featured streams were removed. A resolver failure now returns an honest `404/503` instead of a broken playback URL.
* **Deep readiness**: `GET /health?deep=1` reports HMAC/admin secret state, KV binding, swarm nodes, provider health, breaker state and cache sizes.
* **Request IDs**: every response carries `X-Request-Id` and `X-Edge-Time-Ms`; 500 responses include the request id in JSON.
* **Fail-closed admin**: admin routes require `ADMIN_SECRET`; `/admin-login-i` is permanently hidden.

## 7. Phase 2 — Resilience, Speed & Providers

* **Circuit breakers**: per-provider and per-host breakers open after repeated failures and half-open automatically after cooldown.
* **Request coalescing**: concurrent identical `/api/source` resolutions share one upstream attempt.
* **Stale-while-revalidate**: resolved sources stay fresh for 15 minutes and remain usable as stale for 6 hours while a background refresh runs via `ctx.waitUntil`.
* **Jittered retries**: manifest fetches retry transient `429/5xx` responses with exponential backoff and jitter.
* **Scheduled self-healing**: the `*/15 * * * *` cron probes every swarm node and provider, updates health, and persists it to KV.
* **Provider registry**: Orion, Evion, FrameX, AsianFlix and 2Embed share one normalisation layer (`src/providers.js`).
* **AsianFlix + Rumble resolver**: reads `videoPlayerSettings.bloggerAPI.blogId`, queries the Blogger feed for the title, parses the `streamUrl|language|subtitleUrl;` playlist, and returns the matching episode. No page JavaScript or obfuscated theme bundle is executed.

### AsianFlix page overrides

Some titles do not follow the `/<slug>-<year>/` convention. Add an override through the admin config (`asianflix.page_overrides`) keyed by asset:

```json
{
  "asianflix": {
    "page_overrides": {
      "tv:250670": "https://asianflix.one/some-title-2026/",
      "movie:550": "https://asianflix.one/fight-club-1999/"
    },
    "page_url_template": ""
  }
}
```

`page_url_template` supports `{id}`, `{season}` and `{episode}` placeholders.

## 8. Phase 3 — Observability, Abuse Control & Security Headers

* **Rate limiting**: per-IP fixed-window limits per route class (`admin`, `api`, `media`, `general`). Rejections return `429` with `Retry-After` and `X-RateLimit-*`. Approximate per isolate, which is sufficient for single-source floods without a Durable Object.
* **Metrics registry**: status classes, per-route counts/errors/average latency, p50/p95/p99, minute buckets and bytes, all bounded.
* **Logs**: newest 120 requests (media only on errors) and an admin audit trail with masked IPs.
* **Security headers**: `nosniff`, referrer policy, permissions policy, CORP, HSTS on HTTPS, CSP for HTML, and `DENY`/`noindex` for admin pages.
* **Admin diagnostics**: `GET <admin>/api/diagnostics`, `GET <admin>/api/audit`, `GET <admin>/api/config/export`, `POST <admin>/api/config/import`, surfaced in a Diagnostics pane with health grade, traffic, latency, routes, recent requests and audit.
* **Portable config**: export/import is whitelisted, size-capped (256 KiB) and validated (swarm ≤ 10 nodes, domain lists, upstream list).

## 9. Phase 4 — Resume, Episodes & Samples

* **Watch progress**: per-asset resume stored in `vidlyte_progress_v1` (60 entries / 90 days) with a **Start over** action; cleared near the end.
* **Playback preferences**: speed, skip interval, volume/mute, boost and video fit stored in `vidlyte_playback_prefs_v1`.
* **Single provider surface**: the player exposes quality, audio, subtitles and speed only. Providers stay behind the gateway; webmasters and viewers never see a server switcher.
* **Episode navigation**: TV embeds get an episodes browser, next-episode button across seasons, and optional autoplay-next.
* **Default subtitles**: the English track is selected on load when a provider offers one (`language`/`srclang` = `en`/`eng` or an *English* label), otherwise the first available track.
* **Webmaster samples**: the portal shows six live sample cards (movies and TV). **Preview** loads one into the sandbox; **Copy embed** copies a ready-to-paste iframe for that exact TMDB ID.

## 10. Phase 5 — Admin Security, Config History & Alerting

* **CSRF protection**: login returns `csrf_token` and sets `vidlyte_admin_csrf`; every mutating admin request must send `X-CSRF-Token`. Missing/invalid tokens return `403` and are audited.
* **Session expiry**: `ADMIN_SESSION_TTL_SEC` (default 12 h, max 7 days) bounds signed, IP-bound admin sessions; the in-memory session map is pruned.
* **CSP nonce + SRI**: every HTML response gets a fresh nonce used by `script-src`/`script-src-elem`; HLS.js is pinned with a SHA-384 `integrity` hash and `crossorigin="anonymous"`.
* **Config history**: the last 10 snapshots are kept in `CONFIG_KV` under `runtime_config_history_v1`; updates, imports and rollbacks snapshot automatically.
* **History & rollback**: `GET <admin>/api/config/history` lists snapshots or returns one with a diff; `POST <admin>/api/config/rollback` restores a snapshot exactly and records the rollback.
* **Alerting**: `ALERT_WEBHOOK_URL` receives `{ text, summary }` and/or Telegram receives an open/recovery message when scheduled maintenance finds unhealthy swarm nodes/providers. Duplicates are suppressed for 30 minutes (webhook) or `ALERT_COOLDOWN_MIN` (Telegram).
* **Engagement counters**: allowlisted events appear in `/metrics` and `/api/diagnostics`; the admin Diagnostics pane shows plays, shares and tracked assets.
* **MP4 polish**: media responses advertise `Accept-Ranges: bytes` so seeking works even when origins omit the header.

## 11. Phase 6 — Embed Player Polish & Engagement

* **No post-playback overlay**: finishing a title clears its progress and reports `complete`. TV with autoplay-next enabled advances to the next episode; otherwise a small toast offers **Replay**. There is no full-screen end card or recommendations grid.
* **Share with timestamp**: the player share button creates a deep link containing `?t=<seconds>`; shared links take precedence over saved progress.
* **Subtitle appearance**: font, size, position, background, colour and delay persist in `vidlyte_playback_prefs_v1` and are re-applied on load.
* **Engagement telemetry**: player and portal report allowlisted events (`play`, `resume`, `complete`, `share`, `subtitle_change`); no PII or IP addresses are sent.
* **Webmaster-first portal**: six live sample embeds show exactly what webmasters paste into their own sites. There are no Continue Watching or My List rows and no consumer discovery grid.

## 12. Phase 7 — External Watchdog, Readiness & Telegram Alerts

* **External watchdog**: `.github/workflows/uptime-watchdog.yml` runs every 5 minutes on free GitHub Actions. It does not just ping: it checks `/health/ready?canary=1`, resolves `tv/66732/1/1` and `movie/550` through `/api/source`, then fetches the master, variant and first media segment.
* **Strict readiness**: `GET /health/ready` (`/readyz`) returns `503` with `reasons[]` when HMAC/admin secrets, `CONFIG_KV`, runtime config or the persisted playback canary fail. The scheduled canary resolves a real asset and validates the manifest through `WATCHDOG_CANARY_PROVIDER`.
* **Telegram open/recovery alerts**: the worker and the external watchdog both support Telegram. Duplicates are suppressed for `ALERT_COOLDOWN_MIN`; a recovery message is sent only after a previously notified incident. Tokens never appear in responses or logs.
* **Admin controls**: the Upstreams pane shows alert status, a **Send Test** button and a **Run Canary** button. Matching APIs are `GET <admin>/api/alerts/status`, `POST <admin>/api/alerts/test` and `POST <admin>/api/watchdog/canary`.
* **Random TMDB sweep**: `.github/workflows/tmdb-sweep.yml` runs daily (and on demand). `scripts/sweep.mjs` picks random popular TMDB ids (or a curated fallback pool when TMDB is unreachable), resolves each through `/api/source`, and verifies a real media segment. It exits non-zero below `SWEEP_MIN_SUCCESS_RATE` (default 60%) and alerts through Telegram. Assets are reported by id only — never upstream URLs or tokens.
* **Workers quota guard**: `.github/workflows/quota-watch.yml` runs hourly. `scripts/quota.mjs` reads today's (UTC) Workers request count with a read-only Cloudflare Analytics token and warns at `QUOTA_WARN_PCT` (70%) / `QUOTA_CRITICAL_PCT` (90%) of `QUOTA_DAILY_LIMIT` (100000), with recovery notices and a 6-hour dedupe. It reports `cloudflare_not_configured` and exits 0 until `CF_API_TOKEN` / `CF_ACCOUNT_ID` are set.
* **Pending configuration**: [ENV_TODO.md](ENV_TODO.md) tracks every unset secret/variable, where it belongs, and how to verify it. Values are never stored there.
* **Launch gate**: [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) blocks launch until alert delivery is proven and the free-tier capacity decision is made.
* **Free-only**: GitHub Actions + Telegram Bot API + Cloudflare free tier; no billing profile is required. See [WATCHDOG.md](WATCHDOG.md).

## 13. Verification

```powershell
cd cloudflare-worker
node test_phase1.mjs      # security, manifest, subtitles
node test_phase2.mjs      # resilience, providers, Phase 0/2 wiring
node test_phase3.mjs      # rate limits, metrics, logs, headers, config import/export
node test_phase4.mjs      # player resume/prefs/episodes, portal samples
node test_phase5.mjs      # CSRF, session TTL, CSP nonce/SRI, config history/rollback
node test_phase6.mjs      # share timestamps, subtitle prefs, engagement, removals
node test_phase7.mjs      # readiness, canary, Telegram, watchdog, sweep, quota, AGENTS/workflow
npx wrangler deploy --dry-run
```

Expected: `25`, `32`, `37`, `25`, `32`, `26` and `38` tests passing (215 total), and a bundle well below the 3 MiB free-tier limit (~136 KiB gzip).

## 14. Operations Runbook

See [PHASES.md](./PHASES.md) for the deployment checklist, health triage, breaker recovery and rollback steps.
