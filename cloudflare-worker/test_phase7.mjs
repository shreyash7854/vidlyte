/**
 * VidLyte Phase 7 verification harness
 * ---------------------------------------------------------------------------
 * Covers the external watchdog, strict readiness, Telegram alerting, admin
 * test APIs, the AI-development rules files, and the GitHub Actions workflow.
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
const rootAgents = readRoot("AGENTS.md");
const workerAgents = read("AGENTS.md");
const workflow = readRoot(".github/workflows/uptime-watchdog.yml");
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
    "await attemptProvider(provider, asset, null, env)",
    "WATCHDOG_CANARY_PROVIDER",
    "WATCHDOG_CANARY_ASSET",
    'return { type: "tv", id: "66732", season: 1, episode: 1 }',
    "await env.CONFIG_KV.put(WATCHDOG_CANARY_KV_KEY",
  ]);
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
  ]);
});

await test("watchdog does not leak tokens in output", () => {
  hasNone(watchdog, [
    "console.log(TELEGRAM_TOKEN",
    "console.log(TELEGRAM_CHAT_ID",
    "token: TELEGRAM_TOKEN",
  ], "watchdog");
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
    "actions/upload-artifact@v4",
  ]);
});

await test("workflow has no hardcoded credentials", () => {
  hasNone(workflow, ["bot123", "chat_id: 123", "password", "api_key"], "workflow");
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
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.name}\n${failure.error && failure.error.stack}`);
  }
  process.exit(1);
}
