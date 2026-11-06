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
| `TELEGRAM_BOT_TOKEN` | PENDING | Open/recovery alerts from cron and admin tests | Admin → Send Test returns 200 |
| `TELEGRAM_CHAT_ID` | PENDING | Destination chat/group for alerts | Same test message arrives |

## 2. GitHub Actions secrets and variables

Repository → Settings → Secrets and variables → Actions. The repository is
public, so Actions minutes are free and no billing profile is required.

| Kind | Name | Status | Purpose |
|---|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | PENDING | External watchdog + sweep + quota alerts |
| Secret | `TELEGRAM_CHAT_ID` | PENDING | Same destination as the Worker |
| Secret | `CF_API_TOKEN` | PENDING | Read-only Workers analytics for the quota guard |
| Secret | `CF_ACCOUNT_ID` | PENDING | Account tag for the quota guard |
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

## 4. Launch blockers

1. Set the two Telegram secrets in **both** places (Worker + GitHub).
2. Merge `feat/edge-watchdog-alerting` to `main` so scheduled workflows run.
3. Confirm a test alert arrives, then force a canary failure/recovery in a dry
   run to verify open **and** recovery delivery.
4. Add `CF_API_TOKEN` / `CF_ACCOUNT_ID` before public traffic so the quota guard
   can warn before the 100k/day Workers Free limit.
