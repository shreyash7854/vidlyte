# Watchdog & Telegram Alerts

Production monitoring for `https://vid.lyte.workers.dev`. Everything here uses
free services and requires **no billing information**: Cloudflare Workers Free,
GitHub Actions (public repo) and the Telegram Bot API.

## Why an external watchdog

A Worker cannot send an alert when the Worker itself is down. The in-worker cron
(`*/15 * * * *`) only checks provider/swarm health and the playback canary; it
cannot report its own outage. `.github/workflows/uptime-watchdog.yml` runs
outside Cloudflare and alerts you when the edge is unreachable or playback is
broken.

## What each run checks

`cloudflare-worker/scripts/watchdog.mjs`:

1. `GET /health/ready?canary=1` — strict readiness (secrets, KV, config, canary).
2. `GET /api/source/tv/66732/1/1` — real resolver response with `masterUrl`.
3. `GET <masterUrl>` — valid `#EXTM3U` master playlist.
4. First variant playlist — valid `#EXTM3U`.
5. First media segment — HTTP `200/206` and non-zero bytes (`Range: bytes=0-2047`).
6. Repeats steps 2–5 for `movie/550` (configurable).

It reports the failing step, HTTP status, latency, asset and timestamp. It never
includes tokens, cookies or full upstream URLs.

## 1. Create the Telegram bot (free)

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the bot token.
2. Send any message to the new bot (or add it to the alert group).
3. Get the chat id:
   - DM: talk to **@userinfobot**, or
   - Group: add the bot, send a message, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
     `message.chat.id` (group ids are negative).
4. Keep the token and chat id private.

## 2. Configure the Worker (in-worker alerts)

```powershell
cd cloudflare-worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```

Non-secret knobs already live in `wrangler.toml`:

```toml
TELEGRAM_ALERTS_ENABLED = "true"
ALERT_MIN_SEVERITY = "warning"   # info | warning | critical
ALERT_COOLDOWN_MIN = "15"
```

Verify:

1. Open `/vly-ops-7x` → Upstreams → **Alerting & Watchdog**.
2. Confirm the status line says Telegram is configured and enabled.
3. Click **Send Test**. The API is `POST <admin>/api/alerts/test` (session +
   `X-CSRF-Token`). A `503` means the secrets are missing; `502` means Telegram
   rejected the request.
4. Click **Run Canary** to exercise the real resolver now.

## 3. Configure GitHub Actions (external alerts)

Repository → **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | same bot token |
| Secret | `TELEGRAM_CHAT_ID` | same chat id |
| Secret | `CF_API_TOKEN` | read-only Account Analytics token (quota guard) |
| Secret | `CF_ACCOUNT_ID` | Cloudflare account tag (quota guard) |
| Variable (optional) | `WATCHDOG_BASE_URL` | defaults to `https://vid.lyte.workers.dev` |
| Variable (optional) | `WATCHDOG_ASSETS` | defaults to `tv/66732/1/1,movie/550` |
| Variable (optional) | `SWEEP_COUNT` | random assets per daily sweep, default 10 |
| Variable (optional) | `QUOTA_DAILY_LIMIT` | default `100000` (Workers Free) |
| Variable (optional) | `QUOTA_WARN_PCT` / `QUOTA_CRITICAL_PCT` | default `70` / `90` |

The workflow runs every 5 minutes and can be triggered manually from the
**Actions → Uptime watchdog → Run workflow** button. GitHub's minimum schedule is
5 minutes and runs can be delayed under load; this is a backup to the in-worker
alerts, not a substitute for them.

State (open/recovery dedupe) is persisted with `actions/cache` under
`cloudflare-worker/.watchdog-state` and uploaded as a 7-day artifact. No state is
committed to the repository.

## 4. Run locally

```powershell
cd cloudflare-worker
$env:WATCHDOG_BASE_URL = "https://vid.lyte.workers.dev"
$env:TELEGRAM_BOT_TOKEN = "<token>"
$env:TELEGRAM_CHAT_ID = "<chat id>"
node scripts/watchdog.mjs
```

Useful dry run (no Telegram message):

```powershell
$env:WATCHDOG_DRY_RUN = "true"
node scripts/watchdog.mjs
```

Exit code `1` means at least one check failed; `0` means everything passed.
The JSON report is printed to stdout and appended to the GitHub step summary.

## 5. Alert behaviour

- **Open**: sent on the first failure, when the failure signature changes, or
  after `WATCHDOG_COOLDOWN_MIN` (default 15) while still failing.
- **Recovery**: sent only if a previous open alert was recorded.
- **Worker**: scheduled-maintenance alerts use the same open/recovery semantics
  and are deduplicated in KV (`telegram_alert_state_v1`).
- **Severity**: `critical` when a provider/swarm node is offline;
  `warning` for degraded states; `info` for recovery unless configured higher.
- Failed Telegram delivery never breaks playback, cron or the watchdog exit code.

## 6. Readiness flags

`GET /health/ready` is fast and reads the canary stored by cron. `?canary=1`
forces a live resolver check (the external watchdog always uses it).

| Check | Fatal | Notes |
|---|---|---|
| `hmac_secret` | yes | must be set and not the built-in default |
| `admin_secret` | yes | admin auth fails closed without it |
| `config_kv` | yes | production persistence |
| `runtime_config` | yes | must hydrate from KV |
| `providers` | no | informational; provider probes run every 15 min |
| `playback_canary` | yes once present | fails when failed or older than `WATCHDOG_CANARY_MAX_AGE_SEC`; missing is allowed unless `WATCHDOG_REQUIRE_CANARY=true` |

## 7. Runbook

| Symptom | Action |
|---|---|
| `503 readiness: hmac_secret:missing_or_default` | `npx wrangler secret put HMAC_SECRET` |
| `503 readiness: admin_secret:missing` | `npx wrangler secret put ADMIN_SECRET` |
| `503 readiness: playback_canary:failed:provider_miss` | Run **Run Canary**; check provider health; try another `WATCHDOG_CANARY_PROVIDER` |
| `503 readiness: playback_canary:stale` | Check the cron trigger; run **Run Canary** |
| `source tv/...: HTTP 404` | No provider resolved the canary asset; probe providers in admin |
| `master/variant/segment HTTP 5xx` | Upstream CDN or gateway issue; check `wrangler tail`, then re-run |
| Worker completely unreachable | GitHub Actions still alerts; check Cloudflare dashboard/status |
| No Telegram message | Verify both secrets, `TELEGRAM_ALERTS_ENABLED`, and chat id; use **Send Test** |
| Alert spam | Increase `ALERT_COOLDOWN_MIN` / `WATCHDOG_COOLDOWN_MIN` |

## 8. Known limitations

- The external watchdog validates the **server-side** playback chain. It cannot
  execute the browser-only client-assisted BigBang upgrade, so a BigBang-only
  regression needs a manual browser check of `tv/305551/1/4`.
- GitHub Actions cron can be delayed; pair with UptimeRobot/Better Stack free
  (optional) for a second independent liveness signal.
- Cloudflare Workers Free has a ~100k request/day quota. At one run per 5
  minutes, the watchdog consumes roughly 2–3k requests/day; leave headroom for
  real traffic.

## 9. Random TMDB sweep

Known-good assets only prove the gateway works for those ids. The daily sweep
checks arbitrary correct TMDB ids:

```powershell
cd cloudflare-worker
$env:SWEEP_DRY_RUN = "true"
$env:SWEEP_COUNT = "10"
node scripts/sweep.mjs
```

- The workflow (`.github/workflows/tmdb-sweep.yml`) runs at **03:17 UTC** and
  can be dispatched manually. It uses free Actions minutes on the public repo.
- It fetches TMDB popular movies/shows, takes a random sample, then verifies
  `/api/source` → playlist → first segment for each. Set `TMDB_API_KEY` as a
  GitHub secret for live popular picks; without it (or when TMDB is
  unreachable) the sweep uses a curated corpus of valid ids, so the probe still
  runs. No TMDB key is embedded in the repository.
- `SWEEP_ASSETS=movie/550,tv/1399/1/1` skips randomization for a targeted run.
- Exit code `1` when the pass rate is below `SWEEP_MIN_SUCCESS_RATE` (default
  `0.6`). Failures send one Telegram message with asset ids and reason codes
  only — never tokens or upstream URLs.
- Reports stay free of secrets; the JSON is uploaded as a 14-day artifact.

A low pass rate usually means provider coverage changed, not that the ids are
wrong. Compare the failing ids with the admin provider probe before changing the
threshold.

## 10. Workers quota guard

`scripts/quota.mjs` reads today's (UTC) Workers request count from the
Cloudflare GraphQL Analytics API using a **read-only** token. It never needs a
billing profile.

```powershell
cd cloudflare-worker
$env:CF_API_TOKEN = "<read-only token>"
$env:CF_ACCOUNT_ID = "<account tag>"
$env:QUOTA_DRY_RUN = "true"
node scripts/quota.mjs
```

- `.github/workflows/quota-watch.yml` runs hourly at **:07** and on demand.
- Warns at `QUOTA_WARN_PCT` (70%) and goes critical at `QUOTA_CRITICAL_PCT`
  (90%) of `QUOTA_DAILY_LIMIT` (100000). It sends a recovery notice when usage
  drops back below the warn threshold and deduplicates for
  `QUOTA_COOLDOWN_HOURS` (6h).
- `CF_API_TOKEN` and `CF_ACCOUNT_ID` are configured as GitHub secrets. The first
  live run on 2026-11-07 read **2,465 requests (2.5%, level `ok`)** for the
  current UTC day. If the credentials are ever removed it prints
  `skipped: "cloudflare_not_configured"` and exits `0`, so the workflow stays
  green; the preflight step adds a warning. See `ENV_TODO.md`.
- The token only needs **Account → Account Analytics: Read**. Never add a paid
  plan or billing profile to raise the limit.

### Capacity math (why the guard matters)

Measured on 2026-11-06 through the gateway:

| Asset | Media segments | Avg segment | Duration |
|---|---|---|---|
| `tv/305551/1/4` (server-side) | 334 | ~10.0 s | 55.7 min |
| `tv/66732/1/1` | 238 | ~12.0 s | 47.5 min |

That is roughly **250–350 requests per full play** (segments plus manifests and
subtitle fetches). At 100k requests/day the free tier therefore supports about
**250–400 full plays/day** across all webmasters, before the watchdog/sweep
overhead (~3k/day) and before browser-side BigBang audio switching, which
re-buffers additional segments. MP4 assets are cheaper (ranged requests), HLS
episodes dominate.

Treat this as an upper bound: provider segment lengths vary, and a viewer who
seeks or switches audio consumes more. Watch the quota guard, keep the 5-minute
watchdog to a small number of assets, run the random sweep at most daily, and
decide the launch traffic cap (or pool a second free edge/account) before
promoting the service.

## 11. Live verification log

| Date | Check | Result |
|---|---|---|
| 2026-11-05 | `GET /health`, `/health/ready?canary=1` | 200, `ready:true`, canary `framextv` ok |
| 2026-11-05 | Watchdog dry run (`tv/66732/1/1`, `movie/550`) | readiness → source → playlist → segment passed |
| 2026-11-05 | Admin login + alert/canary APIs | 200 + CSRF; test alert 503 `telegram_not_configured` (expected until secrets are set) |
| 2026-11-06 | Random sweep, 6 arbitrary TMDB ids (fallback corpus) | 6/6 passed, each with a real segment |
| 2026-11-06 | `tv/305551/1/4` in Chromium | **5 audio tracks** (English, Spanish, Portuguese, French, English), **7 subtitles** (English active by default), playback advancing, audio switch English → Spanish worked |
| 2026-11-06 | Client-assisted path | Network log shows `embed.vidrift.net/api/source/tv/305551/1/4` → `/hls/tv-305551-1-4/client.m3u8`, confirming the BigBang upgrade |
| 2026-11-07 | Worker Telegram secrets | `wrangler secret list` shows `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |
| 2026-11-07 | Telegram delivery | Direct Bot API message delivered (`ok:true`, message id 4) to the configured chat |
| 2026-11-07 | GitHub repository secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `CF_ACCOUNT_ID` present |
| 2026-11-07 | Forced watchdog open | Invalid host produced `ok:false`, `step:connect`, `fetch failed (ENOTFOUND)`; Telegram alert `sent:true` |
| 2026-11-07 | Forced watchdog recovery | Production run passed readiness, `tv/66732/1/1` and `movie/550`; recovery alert `sent:true` |
| 2026-11-07 | GitHub watchdog dispatch | Run `42282826670` succeeded; `telegram_configured=true`; readiness, `tv/66732/1/1` and `movie/550` passed |
| 2026-11-07 | GitHub quota dispatch (pre-token) | Run `42282946673` succeeded; `telegram_configured=true`, `cloudflare_configured=false`, `skipped:cloudflare_not_configured` (expected before the token existed) |
| 2026-11-07 | Quota guard with real token | `2,465` requests today, **2.5%** of 100k, level `ok` |
| 2026-11-07 | GitHub quota dispatch (configured) | Run `42284302268` succeeded; `cloudflare_configured=true`, `requests:2465`, `percent:2.5`, `level:ok` |

The 2026-11-06 browser check is the manual evidence the server-side canary
cannot produce. Re-run it after any change to the player upgrade logic or the
vidrift allowlist.
