# Pending Environment Configuration

Checklist of configuration that is **not yet set** in production. Values are
never recorded here — only names, where they belong, and how to verify them.
See `WATCHDOG.md` for the alerting runbook and the root `AGENTS.md` for the
secrets policy.

Status: `DONE` = configured and verified, `PENDING` = required before launch,
`OPTIONAL` = enables an extra capability, `BLOCKED` = waiting on the owner.

## 1. Cloudflare Worker secrets

Set with `npx wrangler secret put <NAME>` from `cloudflare-worker/`. Never put
these in `wrangler.toml` `[vars]`.

| Name | Status | Purpose | Verify |
|---|---|---|---|
| `HMAC_SECRET` | DONE | Playback token signing; readiness fails on the built-in default | `/health/ready` → `hmac_secret.ok=true` |
| `ADMIN_SECRET` | DONE | Owner login for `/vly-ops-7x` | `POST /vly-ops-7x/auth` → 200 + CSRF |
| `TELEGRAM_BOT_TOKEN` | DONE | Open/recovery alerts from cron and admin tests | Direct API test delivered; `wrangler secret list` shows it |
| `TELEGRAM_CHAT_ID` | DONE | Destination chat/group for alerts | Same test message arrived (2026-11-07) |

## 2. GitHub Actions secrets and variables

Repository → Settings → Secrets and variables → Actions. The repository is
public, so Actions minutes are free and no billing profile is required.

| Kind | Name | Status | Purpose |
|---|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | DONE | External watchdog + sweep + quota alerts |
| Secret | `TELEGRAM_CHAT_ID` | DONE | Same destination as the Worker |
| Secret | `CF_API_TOKEN` | DONE | Read-only Workers analytics for the quota guard; verified at 2.5% |
| Secret | `CF_ACCOUNT_ID` | DONE | Account tag for the quota guard |
| Secret | `TMDB_API_KEY` | OPTIONAL | Random popular TMDB picks; without it the sweep uses the curated corpus |
| Variable | `WATCHDOG_BASE_URL` | OPTIONAL | Defaults to `https://vid.lyte.workers.dev` |
| Variable | `WATCHDOG_ASSETS` | OPTIONAL | Defaults to `tv/66732/1/1,movie/550` |
| Variable | `SWEEP_COUNT` | OPTIONAL | Number of random TMDB assets per daily sweep (default 10) |
| Variable | `QUOTA_DAILY_LIMIT` | OPTIONAL | Defaults to `100000` (Workers Free) |
| Variable | `QUOTA_WARN_PCT` | OPTIONAL | Defaults to `70` |
| Variable | `QUOTA_CRITICAL_PCT` | OPTIONAL | Defaults to `90` |

`CF_API_TOKEN` must be a **read-only** token with `Account → Account Analytics:
Read`. Do not add a billing profile or a paid plan.

## 3. Non-secret worker variables already deployed

Configured in `wrangler.toml` and verified live: `ADMIN_ROUTE`,
`DEFAULT_TTL_SEC`, `BIND_CLIENT_IP`, `UPSTREAM_ALLOWLIST`, rate limits,
`ADMIN_SESSION_TTL_SEC`, `ALERT_WEBHOOK_URL` (empty), `TELEGRAM_ALERTS_ENABLED`,
`ALERT_MIN_SEVERITY`, `ALERT_COOLDOWN_MIN`, the `WATCHDOG_CANARY_*` group, and
`OPS_STATUS_BASE` (public raw.githubusercontent base for the dashboard feeds).

`OPS_STATUS_BASE` is not a secret and needs no setup: each monitor workflow
force-pushes its snapshot to an `ops-<kind>` branch using the automatic
`GITHUB_TOKEN` (workflows declare `permissions: contents: write`). No new
repository secret is required.

## 4. Remaining items

Done on 2026-11-07:

1. Telegram secrets set in **both** places (Worker + GitHub).
2. `main` fast-forwarded so all three scheduled workflows are active.
3. Direct Telegram delivery, plus forced watchdog open **and** recovery, proven.
4. `CF_ACCOUNT_ID` and `CF_API_TOKEN` set as GitHub secrets.
5. Quota guard verified live: 2,465 requests, 2.5%, level `ok`.
6. Capacity decision: one free Cloudflare account for launch; add 3–4 worker
   node URLs later from Admin → Worker Swarm when usage grows.

Still open (non-blocking):

1. Optional: run Admin → **Send Test** to exercise the Worker's own notifier.
   The external watchdog already covers readiness/canary failures and uses the
   same proven bot/chat.
2. Optional: add `TMDB_API_KEY` as a GitHub secret for live popular-TMDB picks;
   without it the daily sweep uses the curated corpus.
3. Scale-up: when the quota guard reaches 70%, deploy 3–4 additional free
   workers **on separate free Cloudflare accounts** (same-account workers share
   the 100k/day limit), set the same `HMAC_SECRET`, and register them in
   Admin → Worker Swarm. Extend `scripts/quota.mjs` to sum each account's usage
   at that point. Do not add a paid plan.
