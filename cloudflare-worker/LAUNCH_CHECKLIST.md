# Launch Checklist

The gate for promoting VidLyte to webmasters. Status as of **2026-11-06**.
`ENV_TODO.md` tracks unset values; this file tracks whether the launch is safe.

## Gate 1 — Alerting must be proven (BLOCKER)

A worker cannot alert when it is down, and a silent outage is worse than a
visible one. Do not launch until all three are true.

- [ ] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set as **Worker secrets**
      (`npx wrangler secret put ...`).
- [ ] The same two values set as **GitHub repository secrets**.
- [ ] Admin → **Send Test** returns 200 and the message arrives.
- [ ] Forced open/recovery test passes (below).

Forced test (after secrets are set; no production change):

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

Why this is the blocker: `/health`, the canary, the sweep and the watchdog all
work, but their alerts are currently discarded as
`telegram_not_configured` (correctly reported by `GET /health/ready` and the
admin status API).

## Gate 2 — Capacity must be owned (BLOCKER)

Measured on 2026-11-06: a full HLS episode costs roughly **250–350 requests**
through the gateway. The Workers Free limit of **100k requests/day** therefore
supports about **250–400 full plays/day**, minus monitoring overhead.

- [ ] Decide the launch cap: is 250–400 plays/day acceptable for the first
      webmaster cohort?
- [ ] If not, pool a second free edge/account (`SWARM_NODES`) **before**
      promotion. Do not upgrade to a paid plan.
- [ ] Add `CF_API_TOKEN` (read-only Account Analytics) and `CF_ACCOUNT_ID`, then
      run `npm run quota` and confirm it reports a real percentage (not
      `cloudflare_not_configured`).
- [ ] Confirm the hourly quota workflow is green on `main`.

Without this, the first traffic spike can exhaust the free tier and the Worker
goes dark with no warning.

## Gate 3 — Playback (DONE)

- [x] Server-side chain: `tv/66732/1/1` and `movie/550` → master → variant →
      segment.
- [x] Strict readiness: `/health/ready` → 200, `ready:true`, canary ok.
- [x] Random TMDB sweep: 6/6 arbitrary ids passed, each with a real segment.
- [x] Multi-audio: `tv/305551/1/4` showed **5 audio tracks** and **7 subtitles**
      in Chromium; English subtitle default; audio switch worked.
- [x] Client-assisted BigBang path confirmed in the network log.

## Gate 4 — Deploy and rollback (DONE / RUNBOOK)

- [x] All 212 tests pass (`npm run test:all`).
- [x] Production deployed: version `4a39467d-c949-4408-a419-a4494587ae2c`.
- [x] `main` fast-forwarded to the tested branch; all three workflows active.
- [x] Post-deploy smoke available: `npm run watchdog` (real playback chain).
- [ ] Record the current version id before each future deploy and keep
      `npx wrangler rollback` ready. Auto-rollback is not implemented yet.

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

Launch is approved only when Gates 1 and 2 are fully checked. Gates 3–6 are
already satisfied. After the alert test, record the date and the observed
message text (without tokens) in `WATCHDOG.md` §11.
