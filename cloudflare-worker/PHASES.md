# VidLyte Edge Worker — Phase 0 / 2 / 3 / 4 / 5 / 6 Runbook

This document covers the production baseline (Phase 0), the resilience, speed
and provider work (Phase 2), edge observability and abuse control (Phase 3),
the player/portal experience work (Phase 4), admin/security hardening
(Phase 5) and personalisation/engagement features (Phase 6). Phase 1 (security
primitives, manifest rewriting, opaque tokens, subtitle conversion, admin
hardening) is already in place and is assumed by everything below.

---

## 1. What changed

### Phase 0 — production baseline

| Area | Behaviour |
|---|---|
| Config persistence | `CONFIG_KV` stores the runtime config. Without it the admin reports `memory_only` and config resets on cold starts. |
| Static fallback streams | Removed. The old hard-coded `featuredStreams` block contained expired signed URLs and could serve broken playback. |
| Deep health | `GET /health?deep=1` returns config checks, swarm nodes, provider health, breaker state and cache sizes. |
| Request IDs | Every response has `X-Request-Id` and `X-Edge-Time-Ms`. |
| Admin fail-closed | `ADMIN_SECRET` is required; `/admin-login-i` is permanently hidden. |

### Phase 2 — resilience, speed and providers

| Area | Behaviour |
|---|---|
| Circuit breakers | Per-provider (3 failures / 60 s) and per-host (4 failures / 45 s) breakers with half-open retries. |
| Coalescing | Concurrent identical source resolutions share one in-flight promise. |
| Stale-while-revalidate | Sources are fresh for 15 min, usable as stale for 6 h, refreshed through `ctx.waitUntil`. |
| Retries | Manifest fetches retry transient `429/5xx` with jittered exponential backoff. |
| Scheduled probes | Cron `*/15 * * * *` probes swarm nodes and provider endpoints, then persists health. |
| Provider registry | Orion, Evion, FrameX, AsianFlix and 2Embed are normalised through `src/providers.js`. |
| Source validation | Every resolved manifest is fetched and must start with `#EXTM3U` before a provider is accepted. Dead providers fall through at resolve time and are retried once more at playback time if a cached source dies. |
| Vidrift session API | Vidrift now issues a `playbackToken` from `/api/boot` and resolves streams through `/api/source`; the resolver follows that flow (with the legacy `orionStreams`/`bigbangUrl` fields as fallback). |
| Client-assisted BigBang | `embed.vidrift.net` returns `403` to Cloudflare egress, but the browser can obtain a signed BigBang HLS URL from `/api/source?...&provider=bigbang` and BigBang itself is CF-reachable. The player resolves that URL client-side and loads it through `GET /hls/:assetId/client.m3u8?token=...&url=...`, which validates the playback token, enforces the upstream allowlist, and rewrites the master with all 5 audio renditions and 7 subtitle tracks. The server-side stream starts immediately; the player only upgrades when it exposes a single audio track. |
| AsianFlix | Resolves page → Blogger blog ids → Blogger feed → `streamUrl|language|subtitleUrl;` → Rumble HLS/MP4. |

### Phase 3 — observability, abuse control and security headers

| Area | Behaviour |
|---|---|
| Rate limiting | Per-IP fixed 60 s window per route class (general 240, API 120, media 1800, admin 40). Returns `429` with `Retry-After` and `X-RateLimit-*`. |
| Metrics registry | Status classes, per-route counts/errors/average, latency percentiles (p50/p95/p99), minute buckets, bytes. Bounded and per-isolate. |
| Request log | Newest 120 requests (media only logged on errors) with masked IP, route, status, latency, colo and country. |
| Audit log | Auth, config update/import/export and probe actions with masked actor IP. |
| Security headers | `nosniff`, strict referrer policy, permissions policy, CORP and HSTS on HTTPS. HTML gets a CSP; admin pages are `DENY` framed and `noindex`. |
| Admin diagnostics | `GET <admin>/api/diagnostics`, `/api/audit`, `/api/config/export`, `POST /api/config/import`, plus a Diagnostics pane with health grade, traffic, latency, routes, requests and audit. |
| Config portability | Export/import is whitelisted, size-capped (256 KiB) and validated (swarm ≤ 10 nodes, domain lists, upstream list). |

Rate limiting is approximate: each isolate keeps its own counters, so a
distributed flood can exceed the nominal limit. It still absorbs single-source
abuse without a Durable Object (not available on the free tier).

### Phase 4 — playback resume, episodes and webmaster samples

| Area | Behaviour |
|---|---|
| Watch progress | `vidlyte_progress_v1` stores per-asset position/duration (60 entries, 90 days). Resume toast offers **Start over**. Cleared near the end. |
| Playback prefs | `vidlyte_playback_prefs_v1` remembers speed, skip interval, volume/mute, volume boost and video fit. |
| Provider surface | The player exposes quality, audio, subtitles and speed only. Providers stay behind the gateway; no server switcher is rendered. |
| Episode navigation | TV embeds expose an episodes browser (`/api/tmdb/tv/:id/seasons`, `/season/:n`), next-episode button that crosses season boundaries, and optional autoplay-next. |
| Webmaster samples | The portal shows sample cards for known TMDB IDs. **Preview** loads the embed in the sandbox; **Copy embed** copies the iframe for that ID. |
| Subtitle default | On load the player prefers the English track (`language`/`srclang` = `en`/`eng` or a label matching *English*), otherwise the first track. |
| Metadata cache | TMDB responses cached 10–30 min fresh with 1–6 h stale windows; no tokens or upstream URLs are exposed. |

### Phase 5 — admin security, config history and observability polish

| Area | Behaviour |
|---|---|
| CSRF | Login returns `csrf_token` and sets a readable `vidlyte_admin_csrf` cookie. Every mutating admin route requires `X-CSRF-Token` (stateless `HMAC(ADMIN_SECRET, "csrf:"+session)`), except `/auth`. Missing/invalid tokens return `403`. |
| Session expiry | Sessions are HMAC-signed, IP-bound and expire after `ADMIN_SESSION_TTL_SEC` (default 12 h, capped at 7 days). The in-memory session map is pruned. |
| CSP nonce | Each HTML response gets a fresh nonce; `script-src`/`script-src-elem` use `'nonce-…'` plus `cdn.jsdelivr.net`. Inline `onclick` handlers remain allowed via `script-src-attr 'unsafe-inline'`; HLS.js keeps `'unsafe-eval'`. |
| SRI | HLS.js is pinned to `1.5.8` with `integrity="sha384-xLhS5rbIdhv65H3GLX+caQgMSiEK/Hkw8Z6HITolgRxvXs0omcbeYD639tkJ2Wu6"` and `crossorigin="anonymous"`. |
| Config history | The last 10 snapshots are stored in `CONFIG_KV` under `runtime_config_history_v1`. Updates, imports and rollbacks snapshot automatically. |
| History API | `GET <admin>/api/config/history[?id=…&refresh=1]` lists snapshots or returns one snapshot plus a diff against the live config. |
| Rollback | `POST <admin>/api/config/rollback { id }` replaces the config exactly (`CONFIG_DEFAULTS` baseline), persists, snapshots the rollback and returns the diff. |
| Alerting | Scheduled maintenance can POST `{ text, summary }` to `ALERT_WEBHOOK_URL` and/or send Telegram open/recovery messages when swarm nodes/providers are unhealthy. Webhook duplicates are suppressed for 30 minutes; Telegram uses `ALERT_COOLDOWN_MIN`. |
| Engagement | `POST /api/telemetry/engagement` accepts allowlisted events (`play`, `resume`, `complete`, `share`, `subtitle_change`). Counters appear in `/metrics` and `/api/diagnostics`. |
| MP4 polish | Media responses always advertise `Accept-Ranges: bytes`, improving seeking when origins omit the header. |

### Phase 6 — embed player polish and engagement

| Area | Behaviour |
|---|---|
| Playback end | Finishing clears progress and reports `complete`. TV with autoplay-next advances; otherwise a toast offers **Replay**. No full-screen overlay or recommendations grid. |
| Share with timestamp | The player share button copy/native-shares a deep link containing `?t=<seconds>`. |
| Subtitle appearance | Font, size, position, background, colour and delay persist in `vidlyte_playback_prefs_v1` and are re-applied on load. |
| Engagement | The player reports allowlisted engagement events; the admin Diagnostics pane shows plays, shares and tracked assets. |
| Portal scope | The portal shows webmaster samples (Preview in sandbox / Copy embed). There is no consumer discovery grid, no Continue Watching and no My List. |

### Phase 7 — external watchdog, strict readiness and Telegram alerts

| Area | Behaviour |
|---|---|
| External watchdog | `.github/workflows/uptime-watchdog.yml` runs every 5 minutes on free GitHub Actions. It checks `/health/ready?canary=1`, resolves `tv/66732/1/1` and `movie/550`, then fetches master → variant → first segment. |
| Strict readiness | `GET /health/ready` (alias `/readyz`) fails closed with `503` and `reasons[]` on missing/default secrets, missing `CONFIG_KV`, unhydrated config, or a failed/stale canary. `?canary=1` forces a live resolver check. |
| Playback canary | Cron resolves `WATCHDOG_CANARY_ASSET` via `WATCHDOG_CANARY_PROVIDER`, validates the manifest and stores `watchdog_canary_v1` in KV. |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` secrets; `TELEGRAM_ALERTS_ENABLED`, `ALERT_MIN_SEVERITY`, `ALERT_COOLDOWN_MIN`. Open and recovery messages, KV-backed dedupe, no token leakage. |
| Admin | Upstreams pane shows alert status, **Send Test** and **Run Canary**. APIs: `GET <admin>/api/alerts/status`, `POST <admin>/api/alerts/test`, `POST <admin>/api/watchdog/canary`. |
| Rules | Root `AGENTS.md` + `cloudflare-worker/AGENTS.md` define free-only, secrets, token-efficiency, verification and definition-of-done rules. |
| Limits | GitHub cron is best-effort (5-minute minimum). The watchdog validates the server-side chain, not the browser-only BigBang upgrade; check `tv/305551/1/4` manually. |

---

## 2. Deploy checklist

1. Confirm tests pass:
   ```powershell
   cd cloudflare-worker
   node test_phase1.mjs
   node test_phase2.mjs
   node test_phase3.mjs
   node test_phase4.mjs
   node test_phase5.mjs
   node test_phase6.mjs
   node test_phase7.mjs
   npx wrangler deploy --dry-run
   ```
2. Set production secrets:
   ```powershell
   npx wrangler secret put ADMIN_SECRET
   npx wrangler secret put HMAC_SECRET
   # Required for Telegram alerting:
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
3. Optional but recommended — persistent config and provider health:
   ```powershell
   npx wrangler kv namespace create CONFIG_KV
   ```
   Paste the id into `wrangler.toml` and uncomment `[[kv_namespaces]]`.
4. Optional — extra upstream hosts:
   ```toml
   UPSTREAM_ALLOWLIST = "example-cdn.com,another-cdn.net"
   ```
5. Optional — tune Phase 3 rate limits (defaults shown):
   ```toml
   RATE_LIMIT_ENABLED = "true"
   RATE_LIMIT_PER_MINUTE = "240"
   RATE_LIMIT_API_PER_MINUTE = "120"
   RATE_LIMIT_MEDIA_PER_MINUTE = "1800"
   RATE_LIMIT_ADMIN_PER_MINUTE = "40"
   ```
6. Optional — Phase 5/7 admin, alerting and watchdog settings:
   ```toml
   ADMIN_SESSION_TTL_SEC = "43200"
   ALERT_WEBHOOK_URL = ""
   TELEGRAM_ALERTS_ENABLED = "true"
   ALERT_MIN_SEVERITY = "warning"
   ALERT_COOLDOWN_MIN = "15"
   WATCHDOG_CANARY_ENABLED = "true"
   WATCHDOG_CANARY_ASSET = "tv/66732/1/1"
   WATCHDOG_CANARY_PROVIDER = "framextv"
   WATCHDOG_CANARY_MAX_AGE_SEC = "1800"
   WATCHDOG_REQUIRE_CANARY = "false"
   ```
   Also add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as GitHub repository
   secrets so the external workflow can alert when the Worker is down. See
   `WATCHDOG.md`.
7. Deploy only when explicitly approved:
   ```powershell
   npx wrangler deploy
   ```
8. Verify after deploy:
   ```powershell
   curl https://<worker>/health
   curl https://<worker>/health?deep=1
   curl https://<worker>/health/ready
   curl "https://<worker>/health/ready?canary=1"
   curl "https://<worker>/api/source/movie/550"
   curl "https://<worker>/api/tmdb/trending?type=all"
   ```

---

## 2a. Multi-account swarm nodes

There is no separate "node" build — swarm nodes run **the same worker code**:

1. Deploy again under a different name (ideally on a second free Cloudflare account):
   ```powershell
   npx wrangler deploy --name vidlyte-node-1
   ```
2. Create the required secrets on that node:
   ```powershell
   npx wrangler secret put ADMIN_SECRET
   npx wrangler secret put HMAC_SECRET
   ```
   Copy the same values as the primary; `ADMIN_SECRET` is needed only if you want to manage the node, while `HMAC_SECRET` and `UPSTREAM_ALLOWLIST` (if customised) must match the primary.
3. In the admin **Worker Swarm** pane, paste `https://vidlyte-node-1.<account>.workers.dev` and click **Add Node**, then **Probe All Nodes** (uses `GET /ping`).

Switching is automatic: with nodes registered, every upstream fetch (`fetchWithSwarmFallback`) tries up to 5 nodes ordered by the selected strategy, on the first successful node; failures move to the next node and 3 consecutive failures cool the node down for 60 seconds. Embed URLs never change — webmasters only ever use the primary worker URL.

---

## 3. Health triage

### `GET /health`

Returns `200` with `{ status: "healthy", service, engine, timestamp, colo, country }`.
Use this for uptime monitors and swarm `/ping` probes.

### `GET /health?deep=1`

Inspect these fields:

| Field | Meaning | Action |
|---|---|---|
| `checks.hmac_secret` | `default` means `HMAC_SECRET` is unset. | Set the secret before production. |
| `checks.admin_secret` | `missing` means admin is disabled (fail-closed). | Set `ADMIN_SECRET`. |
| `checks.config_kv` | `memory_only` means no KV binding. | Bind `CONFIG_KV` if config must survive cold starts. |
| `providers[].status` | `healthy`, `degraded`, `offline`, `unknown`. | Use the admin probe to refresh. |
| `providers[].breaker.open` | `true` means the provider is isolated. | Wait for cooldown or fix the provider. |
| `breakers.hosts` | Per-host failure state. | Investigate the failing CDN host. |
| `caches.*` | Per-isolate cache sizes. | Large values are normal; they are bounded. |

### Interpreting provider states

* **healthy** — last probe or resolution succeeded.
* **degraded** — endpoint reachable but resolution returned no usable stream.
* **offline** — network error, timeout, or repeated failures.
* **unknown** — no probe has run in this isolate yet.

---

## 4. Circuit breaker recovery

Breakers are per-isolate and in-memory. They recover automatically:

1. After `cooldownMs` (60 s providers, 45 s hosts) the next request is allowed
   as a half-open attempt.
2. A success closes the breaker and resets failure counters.
3. A failure re-opens it for another cooldown.

Manual recovery:

* Run **Probe All Providers** in the admin upstream pane, or
  `POST <admin>/api/providers/probe`.
* For a single provider, run a resolve test:
  `POST <admin>/api/providers/test` with
  `{ "provider": "asianflix", "type": "movie", "id": "550" }`.

---

## 5. AsianFlix troubleshooting

The resolver needs the title to match a page and a Blogger post.

1. Check the page exists and contains `videoPlayerSettings`:
   ```powershell
   curl "https://asianflix.one/wp-json/wp/v2/search?search=Final%20Table&per_page=5&_fields=title,url" `
     -H "User-Agent: Mozilla/5.0" -H "Accept: application/json"
   ```
   AsianFlix returns `406` without browser-like `Accept`/`User-Agent` headers.
2. If the page is not found by slug, add an override in admin config:
   ```json
   { "asianflix": { "page_overrides": { "tv:250670": "https://asianflix.one/<page>/" } } }
   ```
3. If the page exists but no episode resolves, inspect the Blogger feed:
   ```powershell
   curl "https://www.blogger.com/feeds/<blogId>/posts/default?alt=json&max-results=10&q=Final%20Table"
   ```
4. Confirm the post content lines look like:
   ```
   https://rumble.com/hls-vod/<id>/playlist.m3u8|English|https://res.cloudinary.com/...vtt;
   ```
5. Use the admin resolve test and check `stream.host`, `subtitles` and
   `audio_tracks` counts. The response never includes the full upstream URL.

---

## 6. Scheduled maintenance

`wrangler.toml` registers one cron trigger:

```toml
[triggers]
crons = ["*/15 * * * *"]
```

Each run:

1. Reloads config from KV.
2. Prunes expired memory caches.
3. Probes every enabled swarm node (`/ping`).
4. Probes every provider endpoint.
5. Persists swarm config and provider health to KV.

Free accounts support up to 5 cron triggers; this uses one.

To test the handler locally:

```powershell
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

---

## 7. Rollback

The worker is stateless except for KV. To roll back:

1. `npx wrangler deployments list`
2. `npx wrangler rollback <deployment-id>`
3. If a bad config was persisted, delete or overwrite the KV keys:
   ```powershell
   npx wrangler kv key delete runtime_config_v1 --namespace-id <id>
   npx wrangler kv key delete provider_health_v1 --namespace-id <id>
   ```
4. Re-run `/health?deep=1` and one `/api/source` smoke test.

---

## 8. Free-tier guardrails

| Limit | Value | Mitigation |
|---|---|---|
| Requests/day | 100,000 | Source and manifest caches absorb repeat work. |
| CPU/request | 10 ms | No WASM bundle; resolution is network-bound. |
| Memory | 128 MB | Caches are bounded (`TTLCache`, manifest map). |
| Subrequests/request | 50 | Provider racing is capped; swarm tries at most 5 nodes. |
| Simultaneous outbound | 6 | Provider races use at most 2 in the first batch. |
| Worker size | 3 MiB compressed | Current dry-run bundle is ~136 KiB gzip. |
| Cron triggers | 5/account | One trigger is used. |

---

## 9. Observability & abuse control

All telemetry is **per isolate** and resets on cold starts. Treat it as
diagnostic, not billing-grade.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /metrics` | admin session | Legacy counters plus registry snapshot, health grade and limiter state. |
| `GET <admin>/api/diagnostics` | admin session | Health grade, runtime flags, metrics, breakers, caches, swarm, recent requests, audit. `?logs=N` caps samples (max 120). |
| `GET <admin>/api/audit` | admin session | Audit entries only. `?limit=N` (max 120). |
| `GET <admin>/api/config/export` | admin session | Downloads the whitelisted runtime config as JSON. |
| `POST <admin>/api/config/import` | admin session | Validates and applies an exported config, then persists when KV is bound. |
| `GET <admin>/api/config/history` | admin session | Lists the last 10 snapshots. `?id=<id>` returns one snapshot plus a diff; `?refresh=1` bypasses the 60 s cache. |
| `POST <admin>/api/config/rollback` | admin session + CSRF | Restores a snapshot exactly, persists it, records the rollback and returns the diff. |
| `POST /api/telemetry/engagement` | public | Allowlisted engagement events; bounded per-isolate counters. |

Rate-limit classes: `admin`, `api`, `media` (`/hls/`, `/stream/`, `/subtitles/`,
`/tmdb-image/`, `/proxy`) and `general` (pages/portal). Health probes are never
limited because swarm and cron depend on them. A `429` includes
`Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`.

Security headers are applied to every response. HTML gets a CSP with a
per-request nonce and `frame-ancestors *` so third-party sites can embed the
player; admin responses use `frame-ancestors 'none'`, `X-Frame-Options: DENY`
and `noindex`. Mutating admin requests must send `X-CSRF-Token`, which the admin
UI reads from the `vidlyte_admin_csrf` cookie (or the login response).

## 10. Player features and browser storage

Phases 4–6 store only local playback state; engagement events are the only
telemetry sent to the edge (no PII, no IPs).

| Key | Contents | Bound |
|---|---|---|
| `vidlyte_progress_v1` | Per-asset `{ t, d, at, title, type, id, season, episode, poster, year }`. | 60 newest entries, 90 days. |
| `vidlyte_playback_prefs_v1` | `speed`, `skip`, `volume`, `muted`, `boost`, `fit`, `autoplayNext`, subtitle font/size/position/background/colour/delay. | Single object. |

Resume triggers at ≥ 15 s and is skipped within 15 s of the end. Finishing an
episode clears its entry and reports completion; for TV it can auto-advance to
the next episode when `autoplayNext` is not `false`, otherwise a toast offers
**Replay**. Shared links carrying `?t=<seconds>` take precedence over saved
progress.

Providers stay internal to the gateway. The player never renders a server
switcher; `/api/source` picks the provider server-side and the bootstrap
payload's `servers`/`provider` fields are for diagnostics only.
