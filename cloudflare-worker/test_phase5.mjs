/**
 * VidLyte Phase 5 verification harness
 * ---------------------------------------------------------------------------
 * Covers admin CSRF + session expiry, CSP nonces, config history / rollback /
 * diff, alerting, engagement counters and MP4 range polish. Module-level tests
 * exercise the pure helpers; static assertions cover the worker/admin wiring.
 *
 *   node test_phase5.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ADMIN_SESSION_DEFAULT_TTL_SEC,
  signAdminSession,
  verifyAdminSession,
  deriveAdminCsrf,
  generateNonce,
} from "./src/security.js";

import {
  buildSecurityHeaders,
  summarizeConfig,
  diffConfigs,
} from "./src/observability.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

const indexSource = read("src/index.js");
const admin = read("src/admin.html");
const player = read("src/player.html");
const portal = read("src/portal.html");
const wrangler = read("wrangler.toml");

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

function hasAll(source, needles) {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `missing: ${needle}`);
  }
}

function inlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    if (/application\/json/i.test(match[1] || "")) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

console.log("\n[security] admin sessions & CSRF");
await test("default admin session TTL is 12 hours", () => {
  assert.equal(ADMIN_SESSION_DEFAULT_TTL_SEC, 43200);
});

await test("session verification honours the configured TTL", () => {
  const now = Date.now();
  const token = signAdminSession("admin-secret", "203.0.113.9", now);
  assert.equal(verifyAdminSession(token, "admin-secret", "203.0.113.9", now + 1000, 60), true);
  assert.equal(verifyAdminSession(token, "admin-secret", "203.0.113.9", now + 120000, 60), false);
});

await test("session tokens are bound to the client IP", () => {
  const token = signAdminSession("admin-secret", "203.0.113.9");
  assert.equal(verifyAdminSession(token, "admin-secret", "198.51.100.7"), false);
});

await test("CSRF tokens are deterministic per session and secret", () => {
  const token = signAdminSession("admin-secret", "203.0.113.9");
  const csrf = deriveAdminCsrf("admin-secret", token);
  assert.ok(csrf.length >= 32);
  assert.equal(deriveAdminCsrf("admin-secret", token), csrf);
  assert.notEqual(deriveAdminCsrf("other-secret", token), csrf);
  assert.equal(deriveAdminCsrf("admin-secret", ""), "");
});

await test("CSP nonces are URL-safe and unique", () => {
  const values = new Set();
  for (let i = 0; i < 50; i++) {
    const nonce = generateNonce(16);
    assert.match(nonce, /^[A-Za-z0-9_-]+$/);
    assert.ok(nonce.length >= 20);
    values.add(nonce);
  }
  assert.equal(values.size, 50);
});

console.log("\n[observability] CSP nonces");
await test("HTML CSP uses a nonce when supplied", () => {
  const headers = buildSecurityHeaders({ isHtml: true, nonce: "abc123_-" });
  const csp = headers["Content-Security-Policy"];
  assert.ok(csp.includes("'nonce-abc123_-'"));
  assert.ok(csp.includes("script-src-elem"));
  assert.ok(csp.includes("script-src-attr 'unsafe-inline'"));
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp.split("script-src-elem")[0]));
  assert.ok(csp.includes("https://cdn.jsdelivr.net"));
});

await test("HTML CSP falls back to unsafe-inline without a nonce", () => {
  const headers = buildSecurityHeaders({ isHtml: true });
  assert.ok(headers["Content-Security-Policy"].includes("'unsafe-inline'"));
});

await test("admin CSP keeps frame-ancestors locked down", () => {
  const headers = buildSecurityHeaders({ isHtml: true, isAdmin: true, nonce: "n1" });
  assert.ok(headers["Content-Security-Policy"].includes("frame-ancestors 'none'"));
  assert.equal(headers["X-Frame-Options"], "DENY");
});

console.log("\n[observability] config history helpers");
const sampleConfig = {
  config_version: 3,
  updated_at: "2026-01-01T00:00:00.000Z",
  site_config: { brand_name: "VidLyte" },
  upstreams: [{ id: "orion", enabled: true }, { id: "evion", enabled: false }],
  proxy_swarm: { workers: [{ url: "https://a.example" }] },
  domain_security: { blacklist: ["bad.example"], whitelist: [] },
};

await test("config summaries are compact and stable", () => {
  const summary = summarizeConfig(sampleConfig);
  assert.equal(summary.config_version, 3);
  assert.equal(summary.brand_name, "VidLyte");
  assert.equal(summary.upstreams, 2);
  assert.equal(summary.enabled_upstreams, 1);
  assert.equal(summary.swarm_workers, 1);
  assert.equal(summary.blacklist, 1);
});

await test("config diffs report changed leaf paths", () => {
  const after = JSON.parse(JSON.stringify(sampleConfig));
  after.site_config.brand_name = "VidLyte Edge";
  after.upstreams.push({ id: "new", enabled: true });
  const changes = diffConfigs(sampleConfig, after);
  const paths = changes.map((change) => change.path);
  assert.ok(paths.includes("site_config.brand_name"));
  assert.ok(paths.includes("upstreams"));
});

await test("identical configs produce an empty diff", () => {
  assert.deepEqual(diffConfigs(sampleConfig, sampleConfig), []);
});

console.log("\n[worker] CSRF, sessions & history wiring");
await test("worker imports CSRF and nonce helpers", () => {
  hasAll(indexSource, ["deriveAdminCsrf", "generateNonce"]);
});

await test("login issues session and CSRF cookies plus a token", () => {
  hasAll(indexSource, [
    "vidlyte_admin_session=",
    "vidlyte_admin_csrf=",
    "csrf_token: csrfToken",
    "expires_in: sessionTtlSec",
  ]);
});

await test("mutating admin routes pass a central CSRF gate", () => {
  hasAll(indexSource, [
    "const isAdminMutation",
    "checkAdminCsrf(request, env)",
    "Invalid or missing CSRF token",
    "X-CSRF-Token",
    "admin.csrf.rejected",
  ]);
});

await test("admin sessions are expiry-aware and bounded", () => {
  hasAll(indexSource, [
    "new Map(); // session token -> expiry timestamp",
    "function getAdminSessionTtlSec",
    "function pruneAdminSessions",
    "activeAdminSessions.set(sessionToken",
  ]);
});

await test("logout clears both cookies", () => {
  hasAll(indexSource, [
    'logoutHeaders.append("Set-Cookie", "vidlyte_admin_session=; Path=/; HttpOnly; Max-Age=0")',
    'logoutHeaders.append("Set-Cookie", "vidlyte_admin_csrf=; Path=/; Max-Age=0")',
  ]);
});

await test("config history is bounded, persisted and snapshot-driven", () => {
  hasAll(indexSource, [
    'const CONFIG_HISTORY_KV_KEY = "runtime_config_history_v1"',
    "const CONFIG_HISTORY_LIMIT = 10",
    "function recordConfigHistory",
    "function replaceRuntimeConfig",
    "const CONFIG_DEFAULTS = cloneValue(runtimeConfig)",
  ]);
});

await test("history, rollback and diff endpoints exist", () => {
  hasAll(indexSource, [
    "`${adminRoute}/api/config/history`",
    "`${adminRoute}/api/config/rollback`",
    "diffConfigs(entry.config, runtimeConfig)",
    "diffConfigs(before, runtimeConfig)",
  ]);
});

await test("updates, imports and rollbacks record history", () => {
  hasAll(indexSource, [
    'recordConfigHistory(env, "update"',
    'recordConfigHistory(env, "import"',
    'recordConfigHistory(env, "rollback"',
  ]);
});

console.log("\n[worker] Phase 5 polish");
await test("optional alert webhook is deduplicated", () => {
  hasAll(indexSource, [
    "ALERT_WEBHOOK_URL",
    "function maybeSendAlert",
    "lastAlertSignature",
    "30 * 60 * 1000",
    "summary.alert_sent",
  ]);
});

await test("engagement counters are bounded and allowlisted", () => {
  hasAll(indexSource, [
    "const ENGAGEMENT_EVENTS",
    "function recordEngagement",
    "function engagementSnapshot",
    "engagementCounters",
    "engagementAssets.size > 500",
  ]);
});

await test("MP4 responses advertise byte ranges", () => {
  hasAll(indexSource, ['resHeaders.set("Accept-Ranges", "bytes")']);
});

await test("CSP nonce is generated per request and injected into renders", () => {
  hasAll(indexSource, [
    "const cspNonce = generateNonce(16)",
    "nonce: cspNonce",
    "function applyCspNonce",
    "renderAdminHTML(cspNonce)",
    "renderPortalHTML(url.origin, cspNonce)",
    "renderFullPlayerHTML(bootstrap, cspNonce)",
  ]);
});

await test("templates carry the nonce placeholder", () => {
  hasAll(player, ['nonce="__CSP_NONCE__"']);
  hasAll(portal, ['nonce="__CSP_NONCE__"']);
  hasAll(admin, ['nonce="__CSP_NONCE__"']);
});

await test("HLS.js is pinned with SRI and crossorigin", () => {
  hasAll(player, [
    "integrity=\"sha384-xLhS5rbIdhv65H3GLX+caQgMSiEK/Hkw8Z6HITolgRxvXs0omcbeYD639tkJ2Wu6\"",
    'crossorigin="anonymous"',
  ]);
});

await test("player no longer sets its own conflicting CSP", () => {
  assert.ok(!indexSource.includes('"Content-Security-Policy": "frame-ancestors *;"'));
});

console.log("\n[admin] CSRF + history UI");
await test("admin fetches send the CSRF header", () => {
  hasAll(admin, [
    "function adminFetch",
    "headers.set('X-CSRF-Token', token)",
    "getCookieValue('vidlyte_admin_csrf')",
    "adminCsrfToken = data.csrf_token",
  ]);
});

await test("admin handles CSRF expiry gracefully", () => {
  hasAll(admin, ["resp.status === 403", "CSRF token expired"]);
});

await test("admin renders history and rollback controls", () => {
  hasAll(admin, [
    'id="diagHistoryTable"',
    "function loadConfigHistory",
    "function rollbackConfig",
    "config/history",
    "config/rollback",
  ]);
});

await test("admin shows engagement metrics", () => {
  hasAll(admin, ['id="diagPlays"', 'id="diagShares"', 'id="diagEngagementBadge"']);
});

await test("admin inline scripts parse", () => {
  inlineScripts(admin).forEach((script, i) => {
    assert.doesNotThrow(() => new Function(script), `admin script #${i + 1}`);
  });
});

console.log("\n[config] wrangler vars");
await test("new Phase 5 vars are declared", () => {
  hasAll(wrangler, ['ADMIN_SESSION_TTL_SEC = "43200"', 'ALERT_WEBHOOK_URL = ""']);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAILED: ${failure.name}`);
    if (failure.error && failure.error.stack) console.error(failure.error.stack);
  }
  process.exit(1);
}
