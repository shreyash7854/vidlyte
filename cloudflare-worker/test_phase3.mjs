/**
 * VidLyte Phase 3 verification harness
 * ---------------------------------------------------------------------------
 * Exercises the observability module (rate limiting, metrics, logs, security
 * headers, config export/import) plus static wiring checks for the worker and
 * admin diagnostics pane.
 *
 *   node test_phase3.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RATE_LIMIT_DEFAULTS,
  isEnabledFlag,
  parseRateLimitConfig,
  classifyRoute,
  FixedWindowRateLimiter,
  RateLimiterSet,
  MetricsRegistry,
  BoundedLog,
  maskIp,
  buildSecurityHeaders,
  applySecurityHeaders,
  buildConfigExport,
  validateConfigImport,
  gradeHealth,
} from "./src/observability.js";

const here = dirname(fileURLToPath(import.meta.url));
const readWorkerFile = (name) => readFileSync(join(here, name), "utf8");

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

console.log("\n[observability] route classification");
await test("classifies media routes", () => {
  for (const path of ["/hls/tv-1-1-1/master.m3u8", "/stream/chunk/abc", "/subtitles/en.vtt", "/proxy", "/tmdb-image/w500/x.jpg"]) {
    assert.equal(classifyRoute(path), "media");
  }
});

await test("classifies admin, api, health, page and portal routes", () => {
  assert.equal(classifyRoute("/vly-ops-7x"), "admin");
  assert.equal(classifyRoute("/vly-ops-7x/api/config"), "admin");
  assert.equal(classifyRoute("/metrics"), "admin");
  assert.equal(classifyRoute("/api/source/tv/1/1/1"), "api");
  assert.equal(classifyRoute("/v1/playback-sessions"), "api");
  assert.equal(classifyRoute("/health"), "health");
  assert.equal(classifyRoute("/embed/tv/1/1/1"), "page");
  assert.equal(classifyRoute("/"), "portal");
  assert.equal(classifyRoute("/unknown"), "other");
});

await test("honours a custom admin route", () => {
  assert.equal(classifyRoute("/secret/api/config", "/secret"), "admin");
  assert.equal(classifyRoute("/vly-ops-7x/api/config", "/secret"), "api");
});

console.log("\n[observability] rate limiting");
await test("allows requests up to the limit then rejects", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 60_000, maxKeys: 100 });
  const now = 1_000_000;
  assert.equal(limiter.hit("1.2.3.4", now).allowed, true);
  assert.equal(limiter.hit("1.2.3.4", now).allowed, true);
  const third = limiter.hit("1.2.3.4", now);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const fourth = limiter.hit("1.2.3.4", now);
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSec >= 1);
  assert.equal(limiter.rejected, 1);
});

await test("resets the counter after the window", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 100 });
  assert.equal(limiter.hit("ip", 1000).allowed, true);
  assert.equal(limiter.hit("ip", 1500).allowed, false);
  assert.equal(limiter.hit("ip", 2100).allowed, true);
});

await test("tracks keys independently", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
  assert.equal(limiter.hit("a", 1).allowed, true);
  assert.equal(limiter.hit("b", 1).allowed, true);
  assert.equal(limiter.hit("a", 1).allowed, false);
});

await test("bounds the number of tracked keys", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 5 });
  for (let i = 0; i < 20; i++) limiter.hit(`ip-${i}`, 1);
  assert.ok(limiter.buckets.size <= 5);
});

await test("RateLimiterSet maps route classes to buckets", () => {
  const set = new RateLimiterSet({ enabled: true, windowMs: 60_000, general: 10, api: 10, media: 10, admin: 10, maxKeys: 100 });
  assert.equal(set.check("media", "ip", 1).bucket, "media");
  assert.equal(set.check("api", "ip", 1).bucket, "api");
  assert.equal(set.check("admin", "ip", 1).bucket, "admin");
  assert.equal(set.check("portal", "ip", 1).bucket, "general");
});

await test("RateLimiterSet can be disabled", () => {
  const set = new RateLimiterSet({ enabled: false, general: 1 });
  for (let i = 0; i < 10; i++) assert.equal(set.check("api", "ip", 1).allowed, true);
});

console.log("\n[observability] metrics");
await test("counts requests, status classes and bytes", () => {
  const metrics = new MetricsRegistry();
  metrics.record({ route: "api", status: 200, durationMs: 12, bytes: 100 });
  metrics.record({ route: "api", status: 404, durationMs: 20, bytes: 0 });
  metrics.record({ route: "media", status: 503, durationMs: 30, bytes: 50 });
  const snap = metrics.snapshot();
  assert.equal(snap.total_requests, 3);
  assert.equal(snap.status["2xx"], 1);
  assert.equal(snap.status["4xx"], 1);
  assert.equal(snap.status["5xx"], 1);
  assert.equal(snap.bytes_total, 150);
  assert.ok(snap.error_rate > 0.6);
});

await test("aggregates per-route counts and errors", () => {
  const metrics = new MetricsRegistry();
  metrics.record({ route: "api", status: 200, durationMs: 10 });
  metrics.record({ route: "api", status: 500, durationMs: 30 });
  metrics.record({ route: "page", status: 200, durationMs: 20 });
  const snap = metrics.snapshot();
  const api = snap.routes.find((route) => route.route === "api");
  assert.equal(api.count, 2);
  assert.equal(api.errors, 1);
  assert.equal(api.avg_ms, 20);
  assert.equal(snap.routes[0].route, "api");
});

await test("reports latency percentiles", () => {
  const metrics = new MetricsRegistry({ latencyBuckets: [10, 50, 100, 500] });
  for (let i = 0; i < 99; i++) metrics.record({ route: "api", status: 200, durationMs: 5 });
  metrics.record({ route: "api", status: 200, durationMs: 400 });
  const snap = metrics.snapshot();
  assert.equal(snap.latency.p95_ms, 10);
  assert.equal(snap.latency.p99_ms, 10);
  assert.equal(snap.latency.max_ms, 400);
});

await test("keeps the route label set bounded", () => {
  const metrics = new MetricsRegistry({ maxRoutes: 5 });
  for (let i = 0; i < 20; i++) metrics.record({ route: `route-${i}`, status: 200, durationMs: 1 });
  assert.ok(metrics.snapshot().routes.length <= 5);
});

await test("records minute buckets", () => {
  const metrics = new MetricsRegistry({ minuteBuckets: 3 });
  metrics.record({ route: "api", status: 200, durationMs: 4 });
  metrics.record({ route: "api", status: 500, durationMs: 8 });
  const snap = metrics.snapshot();
  assert.equal(snap.minutes.length, 1);
  assert.equal(snap.minutes[0].count, 2);
  assert.equal(snap.minutes[0].errors, 1);
});

console.log("\n[observability] logs + privacy");
await test("BoundedLog keeps only the newest entries", () => {
  const log = new BoundedLog({ capacity: 3 });
  for (let i = 0; i < 5; i++) log.push({ n: i });
  assert.equal(log.size, 3);
  assert.deepEqual(log.list(3).map((entry) => entry.n), [4, 3, 2]);
  log.clear();
  assert.equal(log.size, 0);
});

await test("BoundedLog timestamps entries", () => {
  const log = new BoundedLog({ capacity: 2 });
  const entry = log.push({ action: "x" });
  assert.ok(entry.ts);
});

await test("maskIp hides the host portion of IPv4 and IPv6", () => {
  assert.equal(maskIp("203.0.113.42"), "203.0.113.x");
  assert.ok(maskIp("2001:db8:85a3::8a2e:370:7334").endsWith(":…"));
  assert.equal(maskIp(""), "unknown");
});

console.log("\n[observability] security headers");
await test("HTML responses get a CSP and frame-ancestors", () => {
  const headers = buildSecurityHeaders({ isHtml: true, isHttps: true });
  assert.ok(headers["Content-Security-Policy"].includes("frame-ancestors *"));
  assert.ok(headers["Content-Security-Policy"].includes("script-src"));
  assert.ok(headers["Strict-Transport-Security"].includes("max-age"));
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

await test("admin responses are denied framing and indexed", () => {
  const headers = buildSecurityHeaders({ isHtml: true, isAdmin: true });
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.ok(headers["Content-Security-Policy"].includes("frame-ancestors 'none'"));
  assert.ok(headers["X-Robots-Tag"].includes("noindex"));
});

await test("plain HTTP omits HSTS", () => {
  const headers = buildSecurityHeaders({ isHtml: false, isHttps: false });
  assert.equal(headers["Strict-Transport-Security"], undefined);
});

await test("applySecurityHeaders preserves an existing CSP", () => {
  const original = new Response("ok", {
    headers: { "Content-Type": "text/html", "Content-Security-Policy": "frame-ancestors *;" },
  });
  const secured = applySecurityHeaders(original, { isHtml: true });
  assert.equal(secured.headers.get("Content-Security-Policy"), "frame-ancestors *;");
  assert.equal(secured.headers.get("X-Content-Type-Options"), "nosniff");
});

await test("applySecurityHeaders does not add a CSP to JSON", () => {
  const original = new Response("{}", { headers: { "Content-Type": "application/json" } });
  const secured = applySecurityHeaders(original, {});
  assert.equal(secured.headers.get("Content-Security-Policy"), null);
  assert.equal(secured.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
});

console.log("\n[observability] config export / import");
const sampleConfig = {
  config_version: 1,
  updated_at: "2026-01-01T00:00:00.000Z",
  site_config: { brand_name: "VidLyte" },
  upstreams: [{ id: "orion" }],
  proxy_swarm: { workers: [{ url: "https://a.example" }] },
  domain_security: { blacklist: [], whitelist: [] },
  asianflix: { page_overrides: {} },
  unknown_key: "ignored",
};

await test("buildConfigExport wraps and whitelists keys", () => {
  const exported = buildConfigExport(sampleConfig);
  assert.equal(exported.generator, "vidlyte-edge");
  assert.ok(exported.exported_at);
  assert.equal(exported.config.site_config.brand_name, "VidLyte");
  assert.equal(exported.config.unknown_key, undefined);
});

await test("validateConfigImport accepts the export wrapper", () => {
  const exported = buildConfigExport(sampleConfig);
  const result = validateConfigImport(exported);
  assert.equal(result.ok, true);
  assert.equal(result.config.site_config.brand_name, "VidLyte");
  assert.equal(result.config.unknown_key, undefined);
});

await test("validateConfigImport accepts a bare config object", () => {
  const result = validateConfigImport({ site_config: { brand_name: "X" } });
  assert.equal(result.ok, true);
});

await test("validateConfigImport rejects malformed JSON", () => {
  const result = validateConfigImport("{not-json");
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].toLowerCase().includes("json"));
});

await test("validateConfigImport rejects unknown-only payloads", () => {
  const result = validateConfigImport({ nope: true });
  assert.equal(result.ok, false);
});

await test("validateConfigImport caps swarm workers", () => {
  const result = validateConfigImport({
    proxy_swarm: { workers: Array.from({ length: 11 }, (_, i) => ({ url: `https://w${i}.example` })) },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join(" ").includes("10"));
});

await test("validateConfigImport rejects invalid domain lists", () => {
  const result = validateConfigImport({ domain_security: { blacklist: "bad" } });
  assert.equal(result.ok, false);
});

console.log("\n[observability] health grade + env parsing");
await test("gradeHealth handles idle, excellent and poor snapshots", () => {
  assert.equal(gradeHealth({ total_requests: 0 }).grade, "idle");
  assert.equal(gradeHealth({ total_requests: 100, error_rate: 0, latency: { p95_ms: 20 } }).grade, "excellent");
  assert.equal(gradeHealth({ total_requests: 100, error_rate: 0.3, latency: { p95_ms: 4000 } }).grade, "poor");
});

await test("parseRateLimitConfig reads env overrides", () => {
  const config = parseRateLimitConfig({
    RATE_LIMIT_ENABLED: "false",
    RATE_LIMIT_PER_MINUTE: "12",
    RATE_LIMIT_API_PER_MINUTE: "34",
    RATE_LIMIT_MEDIA_PER_MINUTE: "56",
    RATE_LIMIT_ADMIN_PER_MINUTE: "7",
    RATE_LIMIT_MAX_KEYS: "99",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.general, 12);
  assert.equal(config.api, 34);
  assert.equal(config.media, 56);
  assert.equal(config.admin, 7);
  assert.equal(config.maxKeys, 99);
});

await test("parseRateLimitConfig falls back to defaults", () => {
  const config = parseRateLimitConfig({});
  assert.equal(config.enabled, RATE_LIMIT_DEFAULTS.enabled);
  assert.equal(config.general, RATE_LIMIT_DEFAULTS.general);
  assert.equal(config.media, RATE_LIMIT_DEFAULTS.media);
});

await test("isEnabledFlag accepts common truthy/falsey values", () => {
  assert.equal(isEnabledFlag("true"), true);
  assert.equal(isEnabledFlag("1"), true);
  assert.equal(isEnabledFlag("off"), false);
  assert.equal(isEnabledFlag(undefined, true), true);
});

console.log("\n[worker] Phase 3 wiring");
const indexSource = readWorkerFile("src/index.js");
const adminSource = readWorkerFile("src/admin.html");

await test("worker imports the observability module", () => {
  assert.ok(indexSource.includes('from "./observability.js"'));
  assert.ok(indexSource.includes("new RateLimiterSet"));
  assert.ok(indexSource.includes("new MetricsRegistry"));
});

await test("worker applies rate limiting and security headers", () => {
  assert.ok(indexSource.includes("getRateLimiters(env)"));
  assert.ok(indexSource.includes("applySecurityHeaders"));
  assert.ok(indexSource.includes('"X-RateLimit-Limit"'));
  assert.ok(indexSource.includes("429"));
});

await test("worker exposes diagnostics, audit and config export/import", () => {
  assert.ok(indexSource.includes("/api/diagnostics"));
  assert.ok(indexSource.includes("/api/audit"));
  assert.ok(indexSource.includes("/api/config/export"));
  assert.ok(indexSource.includes("/api/config/import"));
  assert.ok(indexSource.includes("recordAudit"));
});

await test("admin UI includes the diagnostics pane and controls", () => {
  assert.ok(adminSource.includes('id="pane-diagnostics"'));
  assert.ok(adminSource.includes("loadDiagnostics"));
  assert.ok(adminSource.includes("exportConfig"));
  assert.ok(adminSource.includes("importConfigFile"));
  assert.ok(adminSource.includes("diagAuditTable"));
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAILED: ${failure.name}`);
    if (failure.error && failure.error.stack) console.error(failure.error.stack);
  }
  process.exit(1);
}
