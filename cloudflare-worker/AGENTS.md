# AGENTS.md — Cloudflare Worker

Scoped rules for the deployable worker. Read the root `../AGENTS.md` first.

## Layout

| Path | Purpose |
|---|---|
| `src/index.js` | Router, admin API, health, resolver orchestration, scheduled jobs |
| `src/player.html` | Embed player (multi-audio/subtitles/client-assisted upgrade) |
| `src/admin.html` | Owner-only dashboard |
| `src/portal.html` | Public distribution/samples portal |
| `src/security.js` | HMAC tokens, opaque codec, URL allowlist, client IP |
| `src/manifest.js` | HLS manifest parsing/rewriting |
| `src/providers.js` | Provider ids, priority, AsianFlix resolver |
| `src/observability.js` | CSP, metrics, route classes, health grade, rate limits |
| `src/resilience.js` | TTL cache, coalescer, circuit breaker, retry |
| `scripts/watchdog.mjs` | External end-to-end watchdog |
| `scripts/sweep.mjs` | Random TMDB playback coverage sweep |
| `scripts/quota.mjs` | Workers Free daily-quota guard |
| `scripts/resolve-multi-audio.mjs` | External (GitHub Actions) signed BigBang resolver |
| `ENV_TODO.md` | Pending secrets/variables checklist (no values) |
| `test_phase*.mjs` | Static/contract test harness (`npm run test:all`) |

## Runtime facts

- Production: `https://vid.lyte.workers.dev`, admin `/vly-ops-7x`.
- Worker name: `vid`. Cron: `*/15 * * * *`. KV binding: `CONFIG_KV`.
- `wrangler.toml` must contain no secrets.
- Cloudflare egress to `embed.vidrift.net`, `mb.vidrift.net`,
  `relay.vidrift.net`, `edge.milkyway.cymru` is blocked. Do not "fix" this with
  Cloudflare server-side fetches; use the client-assisted path or the external
  GitHub Actions resolver (`scripts/resolve-multi-audio.mjs` +
  `.github/workflows/multi-audio-resolve.yml`).
- BigBang multi-audio path: browser resolves `/api/source?...&provider=bigbang`
  on vidrift, then loads through `/hls/:assetID/client.m3u8?token=&url=`.
- Server-side resolution may return a 1-audio stream; the player upgrades when
  the server stream has `<= 1` audio and the client stream has `> 1`.
- Admin auth: `POST ${ADMIN_ROUTE}/auth` JSON `{secret}` → session cookie + CSRF.
  All mutating admin routes require `X-CSRF-Token`.

## Health and watchdog

- `GET /health`, `/healthz`, `/ping` — liveness, always 200 if the isolate runs.
- `GET /health/ready` — strict readiness. 200 only when fatal checks pass:
  non-default `HMAC_SECRET`, `ADMIN_SECRET`, `CONFIG_KV`, runtime config, and a
  non-failed/non-stale playback canary. Add `?canary=1` to run the canary now.
- `GET /health/ready?deep=1` is not a thing; use `/health?deep=1` for telemetry.
- Canary asset: `tv/66732/1/1` via `WATCHDOG_CANARY_PROVIDER` (default
  `framextv`). It falls back through `WATCHDOG_CANARY_FALLBACK_ASSETS`
  (`movie/550`) and `WATCHDOG_CANARY_FALLBACK_PROVIDERS` (`2vcdn`) before
  reporting `provider_miss`. The external watchdog also exercises
  `tv/66732/1/1` + `movie/550`.
- Readiness returns 503 with `reasons[]`. Never leak secret values or raw
  upstream URLs in the payload.
- Scheduled maintenance stores canary state in KV `watchdog_canary_v1`.
- Coverage beyond known-good ids: `npm run sweep` (random TMDB, daily workflow).
- Daily budget: `npm run quota` reads Workers requests with a read-only
  Cloudflare token; it reports `cloudflare_not_configured` until set. Never
  raise the free limit with billing.
- Dashboard ops feeds: each monitor writes `.ops-status/<kind>.json`, and
  `scripts/publish-status.mjs <kind>` force-pushes it to the `ops-<kind>`
  branch. `GET ${ADMIN_ROUTE}/api/ops` reads those public documents through
  `OPS_STATUS_BASE` and caches them in `CONFIG_KV` (`ops_status_v1`, 2 min).
  Never add secrets or upstream URLs to those documents.

## Telegram alerting

- Worker vars/secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `TELEGRAM_ALERTS_ENABLED`, `ALERT_MIN_SEVERITY`, `ALERT_COOLDOWN_MIN`.
- Set the two secrets with `npx wrangler secret put TELEGRAM_BOT_TOKEN` and
  `npx wrangler secret put TELEGRAM_CHAT_ID`; never put them in `[vars]`.
- `sendTelegramAlert()` supports `open` and `recovery`, severity filtering,
  KV-backed dedupe, and `force` (admin test).
- Admin test endpoint: `POST ${ADMIN_ROUTE}/api/alerts/test` with CSRF, body
  `{ "severity": "critical", "text": "..." }`.

## Commands

```bash
npm run test:all
npx wrangler deploy
npx wrangler secret list
npx wrangler tail
npm run watchdog
npm run sweep
npm run quota
```

Live smoke (PowerShell-safe):

```bash
curl.exe -sS https://vid.lyte.workers.dev/health
curl.exe -sS https://vid.lyte.workers.dev/health/ready
curl.exe -sS "https://vid.lyte.workers.dev/api/source/tv/66732/1/1"
```

## Change rules

1. Add/extend a `test_phase*.mjs` contract test for every route/env change.
2. Keep unknown `/api/*` routes returning JSON 404.
3. Preserve CORS + `Cache-Control: no-store` on health/admin JSON.
4. Never log `Authorization`, cookies, tokens, or full upstream URLs.
5. Never put a secret in `[vars]`; verify with `wrangler secret list`.
6. After deploy, check `/health/ready` and one real asset. Report the version id.
7. Update `README.md` route/env tables and `PHASES.md` runbook in the same change.
