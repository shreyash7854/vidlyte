/**
 * VidLyte Phase 7 verification harness
 * ---------------------------------------------------------------------------
 * Covers the external watchdog, strict readiness, Telegram alerting, random
 * TMDB sweep, quota guard, admin test APIs, the AI-development rules files and
 * the free GitHub Actions workflows.
 *
 *   node test_phase7.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (name) => readFileSync(join(here, name), "utf8");
const readRoot = (name) => readFileSync(join(root, name), "utf8");

const indexSource = read("src/index.js");
const observability = read("src/observability.js");
const admin = read("src/admin.html");
const wrangler = read("wrangler.toml");
const watchdog = read("scripts/watchdog.mjs");
const sweep = read("scripts/sweep.mjs");
const quota = read("scripts/quota.mjs");
const opsStatusScript = read("scripts/ops-status.mjs");
const publishStatus = read("scripts/publish-status.mjs");
const envTodo = read("ENV_TODO.md");
const launchChecklist = read("LAUNCH_CHECKLIST.md");
const rootAgents = readRoot("AGENTS.md");
const workerAgents = read("AGENTS.md");
const workflow = readRoot(".github/workflows/uptime-watchdog.yml");
const sweepWorkflow = readRoot(".github/workflows/tmdb-sweep.yml");
const quotaWorkflow = readRoot(".github/workflows/quota-watch.yml");
const multiAudioWorkflow = readRoot(".github/workflows/multi-audio-resolve.yml");
const player = read("src/player.html");
const resolverScript = read("scripts/resolve-multi-audio.mjs");
const pkg = JSON.parse(read("package.json"));

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(` FAIL ${name}`);
    console.log(`      ${error && error.message}`);
  }
}

function hasAll(source, needles, label = "source") {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `${label} missing: ${needle}`);
  }
}

function hasNone(source, needles, label = "source") {
  for (const needle of needles) {
    assert.ok(!source.includes(needle), `${label} should not contain: ${needle}`);
  }
}

console.log("\n[syntax] worker and watchdog parse");
await test("src/index.js parses", () => {
  const result = spawnSync(process.execPath, ["--check", join(here, "src/index.js")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

await test("src/observability.js parses", () => {
  const result = spawnSync(process.execPath, ["--check", join(here, "src/observability.js")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

await test("scripts/watchdog.mjs parses", () => {
  const result = spawnSync(process.execPath, ["--check", join(here, "scripts/watchdog.mjs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

await test("scripts/sweep.mjs parses", () => {
  const result = spawnSync(process.execPath, ["--check", join(here, "scripts/sweep.mjs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

await test("scripts/quota.mjs parses", () => {
  const result = spawnSync(process.execPath, ["--check", join(here, "scripts/quota.mjs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

console.log("\n[rules] AI development system");
await test("root AGENTS.md defines free-only and token rules", () => {
  assert.ok(existsSync(join(root, "AGENTS.md")));
  hasAll(rootAgents, [
    "free only",
    "no billing",
    "GitHub Actions",
    "Telegram",
    "Token-efficiency",
    "Never do",
    "Definition of done",
  ], "root AGENTS.md");
});

await test("worker AGENTS.md defines scoped workflow", () => {
  assert.ok(existsSync(join(here, "AGENTS.md")));
  hasAll(workerAgents, [
    "/health/ready",
    "sendTelegramAlert",
    "scripts/watchdog.mjs",
    "wrangler secret put",
    "test:all",
  ], "worker AGENTS.md");
});

console.log("\n[readiness] strict endpoint");
await test("readiness route exists with 503 fail-closed behaviour", () => {
  hasAll(indexSource, [
    'url.pathname === "/health/ready"',
    'url.pathname === "/readyz"',
    "buildReadinessPayload",
    "payload.ready ? 200 : 503",
    'url.searchParams.get("canary") === "1"',
  ]);
});

await test("readiness checks secrets, KV, config, providers and canary", () => {
  hasAll(indexSource, [
    'add("hmac_secret"',
    'add("admin_secret"',
    'add("config_kv"',
    '"runtime_config"',
    '"providers"',
    'add("playback_canary"',
    "WATCHDOG_CANARY_MAX_AGE_SEC",
    "WATCHDOG_REQUIRE_CANARY",
    "reasons",
  ]);
});

await test("readiness never emits secret values", () => {
  hasNone(indexSource.slice(indexSource.indexOf("async function buildReadinessPayload")), [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "HMAC_SECRET:",
    "ADMIN_SECRET:",
  ], "readiness payload");
});

await test("classifyRoute treats readiness as health (not rate-limited)", () => {
  hasAll(observability, ['path === "/readyz"', 'path.startsWith("/health/")', 'return "health"']);
});

console.log("\n[canary] real playback signal");
await test("canary resolves a real asset and validates the manifest", () => {
  hasAll(indexSource, [
    'const WATCHDOG_CANARY_KV_KEY = "watchdog_canary_v1"',
    "async function runPlaybackCanary(env)",
    "attemptProvider(attempt.provider, attempt.asset, null, env)",
    "WATCHDOG_CANARY_PROVIDER",
    "WATCHDOG_CANARY_ASSET",
    'id: "66732"',
    "await env.CONFIG_KV.put(WATCHDOG_CANARY_KV_KEY",
  ]);
});

await test("canary falls back before reporting provider_miss", () => {
  hasAll(indexSource, [
    "DEFAULT_CANARY_FALLBACK_ASSETS",
    "WATCHDOG_CANARY_FALLBACK_ASSETS",
    "WATCHDOG_CANARY_FALLBACK_PROVIDERS",
    "record.error = sawException ? \"provider_error\" : \"provider_miss\"",
    "attemptsPlan.slice(0, 6)",
    "attempts: Array.isArray(canary.attempts) ? canary.attempts.slice(0, 6) : []",
  ]);
  hasNone(indexSource.slice(indexSource.indexOf("async function runPlaybackCanary")), [
    "if (!result || !result.streamUrl) {\n      record.error = \"provider_miss\";",
  ], "single-attempt canary");
});

await test("scheduled maintenance runs the canary and alerts on the result", () => {
  hasAll(indexSource, [
    "WATCHDOG_CANARY_ENABLED",
    "summary.canary = await runPlaybackCanary(env)",
    "summary.alert_sent = await maybeSendAlert(env, summary)",
  ]);
});

await test("deep health includes the persisted canary", () => {
  hasAll(indexSource, ["payload.canary = await loadCanaryState(env)"]);
});

console.log("\n[telegram] notifier");
await test("Telegram config reads secrets and tuning vars", () => {
  hasAll(indexSource, [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_ALERTS_ENABLED",
    "ALERT_MIN_SEVERITY",
    "ALERT_COOLDOWN_MIN",
    "async function sendTelegramAlert(env, options = {})",
  ]);
});

await test("Telegram supports open + recovery and durable dedupe", () => {
  hasAll(indexSource, [
    'type === "recovery" ? "recovery" : "open"',
    "TELEGRAM_STATE_KV_KEY",
    "await writeTelegramState(env, state)",
    "below_min_severity",
    "cooldown",
    "no_open_incident",
    "formatTelegramMessage",
  ]);
});

await test("scheduled alerts emit recovery messages", () => {
  hasAll(indexSource, [
    'type: incident ? "open" : "recovery"',
    "VidLyte scheduled check recovered",
    "summary.alert_detail",
  ]);
});

await test("a failed canary is its own critical incident", () => {
  hasAll(indexSource, [
    "const canaryFailed = Boolean(canary && canary.ok !== true)",
    "badProviders.length > 0 || canaryFailed",
    'canary: canaryFailed ?',
    "canaryFailed ||",
  ]);
});

await test("Telegram token is never placed in a response payload", () => {
  hasNone(indexSource.slice(indexSource.indexOf("async function sendTelegramAlert")), [
    "token: config.token",
    "TELEGRAM_BOT_TOKEN:",
  ], "sendTelegramAlert");
});

console.log("\n[admin] alert + canary APIs");
await test("admin alert status/test/canary routes exist", () => {
  hasAll(indexSource, [
    '`${adminRoute}/api/alerts/status`',
    '`${adminRoute}/api/alerts/test`',
    '`${adminRoute}/api/watchdog/canary`',
    'recordAudit("alerts.test"',
    'recordAudit("watchdog.canary"',
  ]);
});

await test("admin UI exposes test-alert and canary controls", () => {
  hasAll(admin, [
    "Alerting &amp; Watchdog",
    "loadAlertStatus()",
    "/api/alerts/test",
    "/api/watchdog/canary",
    "testAlert()",
    "runCanary()",
  ]);
});

console.log("\n[watchdog] external end-to-end script");
await test("watchdog checks readiness, source, master, variant and segment", () => {
  hasAll(watchdog, [
    "/health/ready",
    "/api/source/",
    "isTrue(env.WATCHDOG_FORCE_CANARY, true)",
    "payload.stream_url",
    "#EXTM3U",
    "#EXT-X-STREAM-INF",
    "#EXTINF",
    "firstUri(master.body",
    "firstUri(segmentPlaylistBody",
    'Range: "bytes=0-2047"',
  ]);
});

await test("watchdog sends open/recovery alerts with cooldown", () => {
  hasAll(watchdog, [
    "sendMessage",
    "VidLyte watchdog FAILED",
    "VidLyte watchdog RECOVERED",
    "WATCHDOG_COOLDOWN_MIN",
    "state.last_notified_at",
    "recoveryText",
    "process.exitCode = 1",
    "asFailure",
    'asFailure(error, "connect")',
  ]);
});

await test("watchdog annotates raw network failures with a step", () => {
  hasAll(watchdog, [
    "error.cause",
    "wrapped.step = fallbackStep",
    "wrapped.detail = detail",
  ]);
});

await test("watchdog does not leak tokens in output", () => {
  hasNone(watchdog, [
    "console.log(TELEGRAM_TOKEN",
    "console.log(TELEGRAM_CHAT_ID",
    "token: TELEGRAM_TOKEN",
  ], "watchdog");
});

console.log("\n[sweep] random TMDB coverage");
await test("sweep resolves random assets and verifies a real segment", () => {
  hasAll(sweep, [
    "/api/source/",
    "SWEEP_MIN_SUCCESS_RATE",
    "SWEEP_COUNT",
    "TMDB_API_KEY",
    "FALLBACK_MOVIES",
    "pool_source",
    "#EXT-X-STREAM-INF",
    "#EXTINF",
    'Range: "bytes=0-2047"',
    "source_rejected",
    "process.exitCode = 1",
  ]);
});

await test("sweep does not leak tokens or upstream error text", () => {
  hasNone(sweep, [
    "console.log(TELEGRAM_TOKEN",
    "token: TELEGRAM_TOKEN",
    "payload.error",
  ], "sweep");
});

await test("sweep does not embed a TMDB API key", () => {
  assert.ok(
    !/api_key=[a-f0-9]{32}/i.test(sweep),
    "sweep must read TMDB_API_KEY from the environment instead of embedding a key"
  );
});

console.log("\n[quota] Workers Free capacity guard");
await test("quota guard reads account usage and warns before the limit", () => {
  hasAll(quota, [
    "workersInvocationsAdaptive",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
    "cloudflare_not_configured",
    "QUOTA_DAILY_LIMIT",
    "QUOTA_WARN_PCT",
    "QUOTA_CRITICAL_PCT",
    "utcDayStart",
    "process.exitCode = 1",
  ]);
});

await test("quota guard does not log credentials", () => {
  hasNone(quota, [
    "console.log(API_TOKEN",
    "console.log(TELEGRAM_TOKEN",
    "token: API_TOKEN",
  ], "quota");
});

console.log("\n[env] pending configuration tracker");
await test("ENV_TODO tracks unset secrets without values", () => {
  assert.ok(existsSync(join(here, "ENV_TODO.md")));
  hasAll(envTodo, [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
    "PENDING",
    "wrangler secret put",
  ]);
  hasNone(envTodo, ["HMAC_SECRET =", "ADMIN_SECRET =", "TELEGRAM_BOT_TOKEN ="], "ENV_TODO.md");
  assert.ok(!/\b[a-f0-9]{32,}\b/i.test(envTodo), "ENV_TODO.md must not contain secret-like hex values");
});

await test("launch checklist gates alerting and capacity", () => {
  assert.ok(existsSync(join(here, "LAUNCH_CHECKLIST.md")));
  hasAll(launchChecklist, [
    "Gate 1 — Alerting must be proven",
    "Gate 2 — Capacity must be owned",
    "TELEGRAM_BOT_TOKEN",
    "CF_API_TOKEN",
    "npx wrangler rollback",
    "Sign-off",
  ]);
  assert.ok(
    !/\b[a-f0-9]{32,}\b/i.test(launchChecklist),
    "LAUNCH_CHECKLIST.md must not contain secret-like hex values"
  );
});

console.log("\n[workflow] free external monitoring");
await test("GitHub Actions schedule + secrets + state cache", () => {
  hasAll(workflow, [
    'cron: "*/5 * * * *"',
    "workflow_dispatch",
    "actions/cache@v4",
    "node scripts/watchdog.mjs",
    "secrets.TELEGRAM_BOT_TOKEN",
    "secrets.TELEGRAM_CHAT_ID",
    "Verify alert channel is configured",
    "telegram_configured=true",
    "actions/upload-artifact@v4",
  ]);
});

await test("workflow has no hardcoded credentials", () => {
  hasNone(workflow, ["bot123", "chat_id: 123", "password", "api_key"], "workflow");
});

await test("daily random sweep workflow is free and report-only", () => {
  hasAll(sweepWorkflow, [
    'cron: "17 3 * * *"',
    "workflow_dispatch",
    "node scripts/sweep.mjs",
    "secrets.TELEGRAM_BOT_TOKEN",
    "secrets.TELEGRAM_CHAT_ID",
    "Verify alert channel is configured",
    "telegram_configured=true",
    "actions/upload-artifact@v4",
  ]);
  hasNone(sweepWorkflow, ["api_key: ", "password"], "sweep workflow");
});

await test("hourly quota workflow uses read-only analytics", () => {
  hasAll(quotaWorkflow, [
    'cron: "7 * * * *"',
    "workflow_dispatch",
    "node scripts/quota.mjs",
    "secrets.CF_API_TOKEN",
    "secrets.CF_ACCOUNT_ID",
    "Check monitoring credentials",
    "cloudflare_configured=false",
    "actions/cache@v4",
    "actions/upload-artifact@v4",
  ]);
  hasNone(quotaWorkflow, ["password"], "quota workflow");
});

console.log("\n[config] free-tier knobs and secrets hygiene");
await test("wrangler exposes watchdog tuning without secrets", () => {
  hasAll(wrangler, [
    'TELEGRAM_ALERTS_ENABLED = "true"',
    'ALERT_MIN_SEVERITY = "warning"',
    'ALERT_COOLDOWN_MIN = "15"',
    'WATCHDOG_CANARY_ENABLED = "true"',
    'WATCHDOG_CANARY_ASSET = "tv/66732/1/1"',
    'WATCHDOG_CANARY_PROVIDER = "framextv"',
    'WATCHDOG_CANARY_MAX_AGE_SEC = "1800"',
  ]);
  hasNone(wrangler, ["TELEGRAM_BOT_TOKEN =", "TELEGRAM_CHAT_ID =", "HMAC_SECRET =", "ADMIN_SECRET ="], "wrangler");
});

await test("test:all includes phase 7", () => {
  assert.match(pkg.scripts["test:all"], /test_phase7\.mjs/);
  assert.equal(pkg.scripts["test:phase7"], "node test_phase7.mjs");
  assert.equal(pkg.scripts.sweep, "node scripts/sweep.mjs");
  assert.equal(pkg.scripts.quota, "node scripts/quota.mjs");
});

console.log("\n[ops] dashboard feeds (quota, watchdog, sweep)");
await test("worker serves cached ops snapshots behind admin auth", () => {
  hasAll(indexSource, [
    'url.pathname === `${adminRoute}/api/ops`',
    "loadOpsStatus",
    'OPS_STATUS_KV_KEY = "ops_status_v1"',
    'OPS_KINDS = ["quota", "watchdog", "sweep"]',
    '`${getOpsStatusBase(env)}/ops-${kind}/${kind}.json`',
    'url.searchParams.get("refresh") === "1"',
    "expirationTtl: 900",
  ]);
});

await test("ops feed reader never touches secrets or upstream URLs", () => {
  var start = indexSource.indexOf("External ops feeds");
  var end = indexSource.indexOf("function makeRequestId");
  assert.ok(start > 0 && end > start, "ops section not found");
  var section = indexSource.slice(start, end);
  hasNone(section, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "HMAC_SECRET", "ADMIN_SECRET", "streamUrl"], "ops feed reader");
});

await test("readiness reports quota level as a non-fatal warning", () => {
  hasAll(indexSource, [
    '"quota_budget"',
    'quotaLevel !== "critical"',
    'quotaLevel === "unknown"',
  ]);
  var readiness = indexSource.slice(indexSource.indexOf("async function buildReadinessPayload"), indexSource.indexOf("External ops feeds"));
  assert.match(readiness, /add\(\s*"quota_budget",\s*quotaLevel !== "critical",/);
  assert.match(readiness, /quotaLevel === "unknown"[\s\S]{0,120}false\s*\)/);
});

await test("scheduled maintenance refreshes the ops cache for readiness", () => {
  var maintenance = indexSource.slice(
    indexSource.indexOf("async function runScheduledMaintenance"),
    indexSource.indexOf("function buildDeepHealthPayload")
  );
  hasAll(maintenance, ["await loadOpsStatus(env)", "summary.ops = ops.sources"], "scheduled maintenance");
});

await test("admin dashboard renders an Ops & Quota pane", () => {
  hasAll(admin, [
    'data-pane="pane-ops"',
    'id="pane-ops"',
    "function loadOps(",
    "function renderOps(",
    "adminFetch('/api/ops'",
    "opsQuotaPercent",
    "opsWatchdogLevel",
    "opsSweepLevel",
    "opsResolverState",
    "function loadResolverStatus(",
    "multi_audio_resolver",
  ]);
});

await test("wrangler points ops feeds at the public status branches", () => {
  hasAll(wrangler, [
    'OPS_STATUS_BASE = "https://raw.githubusercontent.com/shreyash7854/vidlyte"',
  ]);
});

await test("monitor scripts write compact ops snapshots", () => {
  hasAll(quota, ['writeOpsStatus("quota"'], "quota script");
  hasAll(watchdog, ['writeOpsStatus("watchdog"'], "watchdog script");
  hasAll(sweep, ['writeOpsStatus("sweep"'], "sweep script");
  hasAll(opsStatusScript, [
    "export async function writeOpsStatus",
    'OPS_KINDS = ["quota", "watchdog", "sweep"]',
    "OPS_STATUS_DIR",
  ]);
});

await test("publish script force-pushes one branch and masks the token", () => {
  hasAll(publishStatus, [
    'refs/heads/${branch}',
    '"--force"',
    'OPS_STATUS_BRANCH_PREFIX',
    'split(token).join("***")',
    "process.exit(0)",
  ]);
});

await test("each monitor workflow publishes its status branch", () => {
  [
    [workflow, "watchdog"],
    [sweepWorkflow, "sweep"],
    [quotaWorkflow, "quota"],
  ].forEach(function(entry) {
    assert.ok(entry[0].includes("contents: write"), `${entry[1]} workflow needs contents: write`);
    assert.ok(entry[0].includes("continue-on-error: true"), `${entry[1]} publish step must not fail the run`);
    assert.ok(
      entry[0].includes(`node scripts/publish-status.mjs ${entry[1]}`),
      `${entry[1]} workflow missing publish step`
    );
  });
});

console.log("\n[multi-audio] external resolver");
await test("multi-audio routes are HMAC-gated and KV-only", () => {
  hasAll(indexSource, [
    'url.pathname === "/api/multi-audio/resolve"',
    'url.pathname === "/api/multi-audio/status"',
    'url.pathname === "/api/multi-audio/publish"',
    'remote\\.m3u8$',
    "verifyMultiAudioPublishSignature",
    "dispatchMultiAudioResolution",
    'const MULTI_AUDIO_STATUS_PREFIX = "ma_status_v1:"',
    "isBigBangStreamUrl",
    "MULTI_AUDIO_PUBLISH_KEY",
  ]);
  var publish = indexSource.slice(
    indexSource.indexOf('url.pathname === "/api/multi-audio/publish"'),
    indexSource.indexOf("// Diagnostic probe for upstream stream resolution")
  );
  assert.ok(publish.includes("await verifyMultiAudioPublishSignature(request, env, rawBody)"));
  assert.ok(publish.indexOf("verifyMultiAudioPublishSignature") < publish.indexOf("JSON.parse(rawBody)"));
  hasNone(publish, ["url: record.url", "url: body.url"], "publish response");

  var statusRoute = indexSource.slice(
    indexSource.indexOf('url.pathname === "/api/multi-audio/status"'),
    indexSource.indexOf('url.pathname === "/api/multi-audio/publish"')
  );
  hasNone(statusRoute, ["url: record.url"], "status response");
  hasAll(statusRoute, ['state: "ready"', "ready: true"], "status response");
  assert.ok(
    statusRoute.indexOf('state: "resolving"') < statusRoute.indexOf('state: "failed"'),
    "status must report a pending dispatch before an older failed record"
  );
});

await test("resolver signs its payload and never logs the signed URL", () => {
  hasAll(resolverScript, [
    'createHmac("sha256", PUBLISH_KEY)',
    '"X-Multi-Audio-Signature"',
    "MULTI_AUDIO_ASSETS",
    "/api/multi-audio/publish",
    "published: Boolean(published.ok)",
  ]);
  hasNone(resolverScript, ["console.log(result.url", "console.log(stream.url", "log(\"resolved\", { url"], "resolver logs");
});

await test("resolver workflow is a bounded manual dispatch", () => {
  hasAll(multiAudioWorkflow, [
    "workflow_dispatch:",
    "assets:",
    "contents: read",
    "MULTI_AUDIO_PUBLISH_KEY",
    "node scripts/resolve-multi-audio.mjs",
    "timeout-minutes: 5",
  ]);
  hasNone(multiAudioWorkflow, ["contents: write", "pull_request:"], "resolver workflow");
});

await test("player falls back to the remote resolver behind the gateway", () => {
  hasAll(player, [
    "function resolveRemoteMultiAudio",
    "function pollRemoteMultiAudio",
    "REMOTE_POLL_MAX",
    "remoteState",
    "buildClientGatewayUrl",
    "buildRemoteGatewayUrl",
    "verifyClientGateway",
    "window.__vidlyteRetryMultiAudio = retryMultiAudio",
  ]);
  var remote = player.slice(
    player.indexOf("function resolveRemoteMultiAudio"),
    player.indexOf("function applyClientUpgrade")
  );
  hasNone(remote, ["norway-canary", "bigbang.cymru", "payload.url"], "remote resolver section");
});

await test("wrangler configures the resolver without secrets", () => {
  hasAll(wrangler, [
    'GITHUB_REPO = "shreyash7854/vidlyte"',
    'MULTI_AUDIO_WORKFLOW = "multi-audio-resolve.yml"',
    'WATCHDOG_CANARY_FALLBACK_ASSETS = "movie/550"',
    'WATCHDOG_CANARY_FALLBACK_PROVIDERS = "2vcdn"',
  ]);
  hasNone(wrangler, ["GITHUB_DISPATCH_TOKEN =", "MULTI_AUDIO_PUBLISH_KEY ="], "wrangler [vars]");
});

await test("readiness reports the multi-audio resolver as a non-fatal check", () => {
  var readiness = indexSource.slice(
    indexSource.indexOf("async function buildReadinessPayload"),
    indexSource.indexOf("External ops feeds")
  );
  hasAll(readiness, [
    '"multi_audio_resolver"',
    "GITHUB_DISPATCH_TOKEN",
    "MULTI_AUDIO_PUBLISH_KEY",
  ], "readiness");
  assert.match(readiness, /add\(\s*"multi_audio_resolver",[\s\S]{0,120}false\s*\)/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.name}\n${failure.error && failure.error.stack}`);
  }
  process.exit(1);
}
