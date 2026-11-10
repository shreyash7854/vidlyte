# AGENTS.md — VidLyte Engineering Rules

These rules apply to every AI/human change in this repository. Read this file
before touching code. The deployable product is **`cloudflare-worker/`**; the Go
code and docs are reference/parity material unless a task explicitly targets them.

## 1. Product contract

- **Audience:** webmasters embed players by TMDB id. The public portal is a
  distribution/samples surface, not a consumer discovery grid.
- **Admin:** the owner only, under `ADMIN_ROUTE` (`/vly-ops-7x`). Never expose
  admin controls to viewers or embed pages.
- **Playback:** multi-audio is a hard requirement. A source with one audio track
  is acceptable only as an instant-start fallback while the client upgrades to a
  multi-audio source. Never ship single-audio-only as the final behaviour.
  When the viewer's browser cannot reach vidrift, the player upgrades through
  the external GitHub Actions resolver (`/api/multi-audio/*`); results live in
  KV only, never in logs or public status documents.
- **Providers:** server/provider switching is internal. Viewers see neutral
  quality/audio/subtitle controls, never upstream names or URLs.
- **Subtitles:** English is the default when present.
- **Player:** Skip Intro at `bottom: 96px`; external-link share; no post-playback
  full-screen overlay.

## 2. Cost rule — free only, no billing details

- Every external service must have a free tier that does **not** require a card
  or billing profile. If a feature needs billing, stop and ask the owner.
- Prefer pooling free services instead of adding paid infrastructure.
- Before adding a service, record: free quota, failure mode, and fallback.
- Current approved pool:
  | Need | Service | Notes |
  |---|---|---|
  | Edge compute/KV/cron | Cloudflare Workers Free | ~100k req/day; watch quota |
  | External watchdog/CI | GitHub Actions (public repo) | Free minutes; 5-min schedule |
  | Alerts | Telegram Bot API | Free; bot token + chat id |
  | Optional uptime | UptimeRobot / Better Stack free | No card; secondary signal |
- Never enable a paid plan, add a card, or "just upgrade" to fix a limit.
- Track daily Workers usage with `cloudflare-worker/scripts/quota.mjs` (read-only
  Cloudflare Analytics token, hourly GitHub Actions). Warn at 70%, critical at
  90% of the free daily limit; reduce traffic instead of upgrading.
- Keep the 5-minute watchdog small and the random sweep daily; both consume the
  same free request budget as real playback.

## 3. Token-efficiency rules

1. Read this file + the nearest scoped `AGENTS.md` first.
2. Use `grep`/`glob` to locate code, then read only the needed range.
3. Batch independent reads/searches in one turn. Avoid re-reading unchanged files.
4. Never paste an entire large file into a response or a prompt.
5. Prefer `edit` with a unique anchor over rewriting a whole file.
6. Delegate broad exploration to the `explore` subagent; keep the main thread for
   decisions and edits.
7. Summarise findings as file:line references, not raw dumps.
8. Stop and report when the same fix fails twice. Do not loop blindly.

## 4. Secrets and configuration

- Secrets live **only** in Cloudflare: `npx wrangler secret put NAME`.
- Never put secrets in `wrangler.toml`, `[vars]`, source, tests, docs, or logs.
- Never print secret values in responses or tool output.
- Current secret names: `HMAC_SECRET`, `ADMIN_SECRET`, and (when enabled)
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Non-secret knobs belong in `wrangler.toml` `[vars]`.
- Keep `ALERT_WEBHOOK_URL` empty when Telegram is the alert channel.

## 5. Change workflow (deployable worker)

1. Inspect the nearest code and tests before editing.
2. Make the smallest coherent change; preserve existing naming/style.
3. Run `cd cloudflare-worker && npm run test:all`.
4. Deploy: `npx wrangler deploy`.
5. Verify live:
   - `GET /health` → 200
   - `GET /health/ready` → 200 with `ready: true` (once canary exists)
   - a real embed page and a real asset play
   - admin login still returns 200 + CSRF
6. Update `README.md` / `PHASES.md` when behaviour, env vars, or routes change.
7. Report the live version id and exactly what was verified.

## 6. Self-healing and alerting rules

- A worker cannot alert when it is down. **External** monitoring is mandatory.
- `/health` is liveness only. `/health/ready` is strict readiness (secrets, KV,
  runtime config, optional canary).
- `scripts/watchdog.mjs` must exercise the real chain:
  readiness → `/api/source` → master manifest → variant → segment.
- Alert on **open** and **recovery**. Deduplicate with KV (worker) and cache
  state (GitHub Actions); never spam every 5 minutes.
- The playback canary must try a fallback asset and provider before reporting
  `provider_miss`; one upstream flake must not page the owner.
- Include: failing step, HTTP status, latency, asset, timestamp. Never include
  tokens, cookies, or full upstream URLs.
- New failure modes must get a canary or a readiness check, not just a log line.

## 7. Verification and evidence

- "Tests pass" is not proof of playback. Verify a real embed with a real TMDB id.
- Known-good server-side assets: `tv/66732/1/1`, `movie/550`.
- Known multi-audio asset: `tv/305551/1/4` (client-assisted BigBang path).
- Report what was tested, where, and the observed result. Never claim a feature
  works because code exists.
- If a limitation is environmental (egress blocked, browser-only), state it and
  document the fallback.

## 8. Never do

- Never add billing, paid tiers, or card-required services.
- Never commit secrets, `.dev.vars`, `.env`, or `wrangler.toml` secrets.
- Never weaken auth/CSRF/allowlists to make a test pass.
- Never replace a real playback check with a homepage ping.
- Never remove multi-audio upgrade logic without an explicit owner decision.
- Never rewrite unrelated user changes.

## 9. Definition of done

- Code + tests + docs updated.
- Live deployment verified on the production worker.
- Failure path (not just success path) exercised.
- Alerting/watchdog coverage considered.
- No new paid dependency and no secret leakage.
