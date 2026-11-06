# Launch Checklist

The gate for promoting VidLyte to webmasters. Status as of **2026-11-07**.
`ENV_TODO.md` tracks unset values; this file tracks whether the launch is safe.

**Current status:** All launch gates are satisfied. Approved for a
**single-account launch**, with 3–4 worker nodes to be added later from the
admin Worker Swarm pane as traffic grows.

## Gate 1 — Alerting must be proven (DONE)

A worker cannot alert when it is down, and a silent outage is worse than a
visible one.

- [x] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set as **Worker secrets**
      (`npx wrangler secret list` shows both).
- [x] The same two values set as **GitHub repository secrets**.
- [x] Telegram bot/chat delivery proven with a direct API message.
- [x] Forced open/recovery test passes (below); both alerts delivered through
      the same `scripts/watchdog.mjs` that GitHub Actions runs.
- [x] Workflows fail loudly with `telegram_configured=false` if the GitHub
      secrets are ever removed.
- [x] GitHub Actions watchdog dispatch on `main` succeeded with
      `telegram_configured=true` (run `42282826670`).
- [ ] Optional owner check: Admin → **Send Test** returns 200. This exercises
      the Worker's own notifier; it is not launch-blocking because the external
      watchdog covers readiness/canary failures and the notifier uses the same
      proven bot/chat.

Forced test (already passed on 2026-11-07; no production change):

```powershell
cd cloudflare-worker
$env:WATCHDOG_STATE_DIR = "$env:TEMP\vid-launch-alert-test"

# 1. Force a failure against an unreachable host -> expect an "INCIDENT" message.
$env:WATCHDOG_BASE_URL = "https://vid.lyte.workers.dev.invalid"
node scripts/watchdog.mjs

# 2. Re-run against production with the same state dir -> expect "RECOVERED".
$env:WATCHDOG_BASE_URL = "https://vid.lyte.workers.dev"
node scripts/watchdog.mjs
```

Pass criteria: exactly one open alert and one recovery alert, no token or
upstream URL in either message.

Why this mattered: `/health`, the canary, the sweep and the watchdog all worked,
but before these secrets existed every alert was discarded as
`telegram_not_configured`. The 2026-11-07 forced run delivered both the open
and recovery messages, so the external path is no longer silent.

## Gate 2 — Capacity must be owned (DONE)

Measured on 2026-11-06: a full HLS episode costs roughly **250–350 requests**
through the gateway. The Workers Free limit of **100k requests/day** therefore
supports about **250–400 full plays/day**, minus monitoring overhead.

**Decision (2026-11-07):** launch with **one free Cloudflare account** for the
first cohort. When usage approaches the guard thresholds, add 3–4 worker node
URLs from **Admin → Worker Swarm**. Nodes are runtime config, so there is no
redeploy and no change to the public embed URL. Do not upgrade to a paid plan.

- [x] Launch cap decided: one account, ~250–400 plays/day, then scale
      horizontally by adding free worker nodes.
- [x] `CF_ACCOUNT_ID` set as a GitHub repository secret.
- [x] `CF_API_TOKEN` (read-only Account Analytics) set as a GitHub repository
      secret. Verified live: **2,465 requests / 2.5% / level `ok`**.
- [x] Hourly quota workflow green on `main` with
      `cloudflare_configured=true` (run `42284302268`).
- [x] Scaling path documented: deploy the same worker code under a new name,
      set the same `HMAC_SECRET`, paste the URL in Admin → Worker Swarm, then
      Ping Swarm. Visitors only ever use the primary URL.

The guard now warns at 70% and goes critical at 90%, so the first traffic spike
cannot silently exhaust the free tier.

## Gate 3 — Playback (DONE)

- [x] Server-side chain: `tv/66732/1/1` and `movie/550` → master → variant →
      segment.
- [x] Strict readiness: `/health/ready` → 200, `ready:true`, canary ok.
- [x] Random TMDB sweep: 6/6 arbitrary ids passed, each with a real segment.
- [x] Multi-audio: `tv/305551/1/4` showed **5 audio tracks** and **7 subtitles**
      in Chromium; English subtitle default; audio switch worked.
- [x] Client-assisted BigBang path confirmed in the network log.

## Gate 4 — Deploy and rollback (DONE / RUNBOOK)

- [x] All 215 tests pass (`npm run test:all`).
- [x] Production deployed: version `4a39467d-c949-4408-a419-a4494587ae2c`.
- [x] `main` fast-forwarded to the tested branch; all three workflows active.
- [x] Post-deploy smoke available: `npm run watchdog` (real playback chain).
- [x] Current version recorded: `4a39467d-c949-4408-a419-a4494587ae2c`.
      Keep `npx wrangler rollback` ready; auto-rollback is not implemented yet.

## Gate 5 — Security and secrets (DONE)

- [x] `HMAC_SECRET` and `ADMIN_SECRET` are Worker secrets, not `[vars]`.
- [x] Admin login requires the secret; mutating routes require CSRF.
- [x] Readiness fails closed on default/missing secrets.
- [x] No secret values in the repo, tests, docs, logs or responses.
- [x] Provider URLs and tokens are not exposed to viewers.

## Gate 6 — Operations (DONE)

- [x] `/health` (liveness) and `/health/ready` (strict) documented and live.
- [x] 5-minute external watchdog, daily random sweep, hourly quota guard.
- [x] Telegram open/recovery logic with dedupe in both Worker and watchdog.
- [x] `ENV_TODO.md` and `WATCHDOG.md` runbooks committed.
- [x] Database-free design; config snapshots and rollback in KV.

## Sign-off

**Approved for production launch on 2026-11-07** with one free Cloudflare
account. Gates 1–6 are satisfied.

Evidence: Telegram open + recovery delivered; GitHub watchdog run `42282826670`
succeeded with `telegram_configured=true`; quota run `42284302268` succeeded with
`cloudflare_configured=true` and real usage `2,465 requests (2.5%)`; 215 tests
pass; multi-audio verified live on `tv/305551/1/4`.

**Scale-up trigger:** when the hourly quota guard reports **70%**, deploy 3–4
additional free worker nodes and register them in Admin → Worker Swarm. Do not
add a paid plan or a billing profile.

Test evidence (without tokens) is recorded in `WATCHDOG.md` §11.
