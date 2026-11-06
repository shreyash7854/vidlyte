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
| Secret | `CF_API_TOKEN` | BLOCKED | Read-only Workers analytics for the quota guard (owner-only creation) |
| Secret | `CF_ACCOUNT_ID` | DONE | Account tag for the quota guard |
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
`ALERT_MIN_SEVERITY`, `ALERT_COOLDOWN_MIN`, and the `WATCHDOG_CANARY_*` group.

## 4. Remaining items

Done on 2026-11-07:

1. Telegram secrets set in **both** places (Worker + GitHub).
2. `main` fast-forwarded so all three scheduled workflows are active.
3. Direct Telegram delivery, plus forced watchdog open **and** recovery, proven.
4. `CF_ACCOUNT_ID` set as a GitHub secret.

Still open:

1. Add `CF_API_TOKEN` (read-only Account Analytics) as a GitHub secret, then run
   `npm run quota` and confirm a real percentage. Only the account owner can
   create the token; no billing profile is required.
2. Decide the launch capacity envelope: ~250–400 full plays/day on Workers Free,
   or pool a second free edge/account via `SWARM_NODES` before promotion.
3. Optional: run Admin → **Send Test** to exercise the Worker's own notifier.
   The external watchdog already covers readiness/canary failures and uses the
   same proven bot/chat.
