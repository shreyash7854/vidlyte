/**
 * VidLyte Edge Observability & Abuse Control
 * =============================================================================
 * Pure, dependency-free helpers shared by the worker runtime and the Node test
 * harness:
 *   - fixed-window per-IP rate limiting (per route class)
 *   - bounded metrics registry (status classes, route latency, bytes, minutes)
 *   - bounded request / audit logs
 *   - route classification
 *   - security response headers
 *   - config export / import validation
 *
 * Everything here is intentionally synchronous and side-effect free (aside from
 * the in-memory state inside the classes) so it can be exercised without
 * importing the worker or the HTML templates.
 */

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 60 * 1000,
  general: 240,
  api: 120,
  media: 1800,
  admin: 40,
  maxKeys: 5000,
});

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isEnabledFlag(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return TRUTHY.has(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Reads rate-limit knobs from the worker environment.
 */
export function parseRateLimitConfig(env = {}) {
  return {
    enabled: isEnabledFlag(env.RATE_LIMIT_ENABLED, RATE_LIMIT_DEFAULTS.enabled),
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, RATE_LIMIT_DEFAULTS.windowMs),
    general: positiveInt(env.RATE_LIMIT_PER_MINUTE, RATE_LIMIT_DEFAULTS.general),
    api: positiveInt(env.RATE_LIMIT_API_PER_MINUTE, RATE_LIMIT_DEFAULTS.api),
    media: positiveInt(env.RATE_LIMIT_MEDIA_PER_MINUTE, RATE_LIMIT_DEFAULTS.media),
    admin: positiveInt(env.RATE_LIMIT_ADMIN_PER_MINUTE, RATE_LIMIT_DEFAULTS.admin),
    maxKeys: positiveInt(env.RATE_LIMIT_MAX_KEYS, RATE_LIMIT_DEFAULTS.maxKeys),
  };
}

/**
 * Route classes drive both rate-limit buckets and metric labels.
 */
export function classifyRoute(pathname, adminRoute = "/vly-ops-7x") {
  const path = String(pathname || "/");
  const admin = String(adminRoute || "/vly-ops-7x");
  if (path === admin || path.startsWith(`${admin}/`)) return "admin";
  if (path === "/metrics") return "admin";
  if (
    path.startsWith("/hls/") ||
    path.startsWith("/stream/") ||
    path.startsWith("/subtitles/") ||
    path.startsWith("/tmdb-image/") ||
    path === "/proxy"
  ) {
    return "media";
  }
  if (
    path === "/health" ||
    path === "/healthz" ||
    path === "/ping" ||
    path === "/readyz" ||
    path.startsWith("/health/")
  ) {
    return "health";
  }
  if (path.startsWith("/api/") || path.includes("/api/") || path === "/v1/playback-sessions") return "api";
  if (path.startsWith("/embed/")) return "page";
  if (path === "/" || path === "") return "portal";
  return "other";
}

/**
 * Fixed-window counter limiter with lazy eviction and a hard key cap.
 * Not globally consistent across isolates (free tier has no Durable Object),
 * but it cheaply absorbs single-source floods.
 */
export class FixedWindowRateLimiter {
  constructor({ limit = 240, windowMs = 60_000, maxKeys = 5000 } = {}) {
    this.limit = positiveInt(limit, 240);
    this.windowMs = positiveInt(windowMs, 60_000);
    this.maxKeys = positiveInt(maxKeys, 5000);
    this.buckets = new Map();
    this.rejected = 0;
    this.accepted = 0;
  }

  _prune(now) {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(key);
    }
    // Still too large: drop the oldest entries (Map preserves insertion order).
    if (this.buckets.size > this.maxKeys) {
      const overflow = this.buckets.size - this.maxKeys;
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (++removed >= overflow) break;
      }
    }
  }

  hit(key, now = Date.now(), cost = 1) {
    const safeKey = String(key || "unknown");
    const safeCost = Number.isFinite(cost) && cost > 0 ? Math.floor(cost) : 1;
    let entry = this.buckets.get(safeKey);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(safeKey, entry);
    }

    entry.count += safeCost;
    this._prune(now);

    const allowed = entry.count <= this.limit;
    if (allowed) this.accepted++;
    else this.rejected++;

    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  reset(key) {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(String(key));
  }

  snapshot() {
    return {
      limit: this.limit,
      window_ms: this.windowMs,
      tracked_keys: this.buckets.size,
      max_keys: this.maxKeys,
      accepted: this.accepted,
      rejected: this.rejected,
    };
  }
}

/**
 * A named set of limiters, one per route class.
 */
export class RateLimiterSet {
  constructor(config = {}) {
    const cfg = { ...RATE_LIMIT_DEFAULTS, ...config };
    this.enabled = cfg.enabled !== false;
    this.windowMs = cfg.windowMs;
    this.limiters = {
      general: new FixedWindowRateLimiter({ limit: cfg.general, windowMs: cfg.windowMs, maxKeys: cfg.maxKeys }),
      api: new FixedWindowRateLimiter({ limit: cfg.api, windowMs: cfg.windowMs, maxKeys: cfg.maxKeys }),
      media: new FixedWindowRateLimiter({ limit: cfg.media, windowMs: cfg.windowMs, maxKeys: cfg.maxKeys }),
      admin: new FixedWindowRateLimiter({ limit: cfg.admin, windowMs: cfg.windowMs, maxKeys: cfg.maxKeys }),
    };
  }

  bucketFor(route) {
    if (route === "media") return "media";
    if (route === "admin") return "admin";
    if (route === "api") return "api";
    return "general";
  }

  check(route, key, now = Date.now()) {
    if (!this.enabled) {
      return { allowed: true, limit: 0, remaining: 0, resetAt: now, retryAfterSec: 0, bucket: "disabled" };
    }
    const bucket = this.bucketFor(route);
    const result = this.limiters[bucket].hit(key, now);
    return { ...result, bucket };
  }

  snapshot() {
    const out = { enabled: this.enabled, window_ms: this.windowMs, buckets: {} };
    for (const [name, limiter] of Object.entries(this.limiters)) {
      out.buckets[name] = limiter.snapshot();
    }
    return out;
  }
}

const DEFAULT_LATENCY_BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/**
 * Bounded metrics registry. Counters live per isolate; they are diagnostic,
 * not billing-grade.
 */
export class MetricsRegistry {
  constructor({ latencyBuckets = DEFAULT_LATENCY_BUCKETS, maxRoutes = 40, minuteBuckets = 15 } = {}) {
    this.startedAt = Date.now();
    this.latencyBuckets = [...latencyBuckets].sort((a, b) => a - b);
    this.maxRoutes = maxRoutes;
    this.minuteBuckets = minuteBuckets;
    this.total = 0;
    this.bytes = 0;
    this.status = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
    this.routes = new Map();
    this.latency = {
      count: 0,
      sum_ms: 0,
      max_ms: 0,
      buckets: new Array(this.latencyBuckets.length + 1).fill(0),
    };
    this.minutes = [];
  }

  record({ route = "other", method = "GET", status = 200, durationMs = 0, bytes = 0, requestId = "", cache = "" } = {}) {
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    this.total++;
    this.bytes += size;

    const statusClass = `${Math.floor(status / 100)}xx`;
    if (this.status[statusClass] !== undefined) this.status[statusClass]++;
    else this.status.other++;

    const routeKey = String(route || "other");
    let routeEntry = this.routes.get(routeKey);
    if (!routeEntry) {
      if (this.routes.size >= this.maxRoutes) {
        // Drop the least-used route label to stay bounded.
        let coldestKey = null;
        let coldest = Infinity;
        for (const [key, value] of this.routes) {
          if (value.count < coldest) {
            coldest = value.count;
            coldestKey = key;
          }
        }
        if (coldestKey) this.routes.delete(coldestKey);
      }
      routeEntry = { count: 0, errors: 0, bytes: 0, sum_ms: 0 };
      this.routes.set(routeKey, routeEntry);
    }
    routeEntry.count++;
    routeEntry.bytes += size;
    routeEntry.sum_ms += ms;
    if (status >= 400) routeEntry.errors++;

    this.latency.count++;
    this.latency.sum_ms += ms;
    if (ms > this.latency.max_ms) this.latency.max_ms = ms;
    let bucketIndex = this.latencyBuckets.findIndex((upper) => ms <= upper);
    if (bucketIndex === -1) bucketIndex = this.latencyBuckets.length;
    this.latency.buckets[bucketIndex]++;

    this._recordMinute(status, ms);
    return { route: routeKey, method, status, durationMs: ms, bytes: size, requestId, cache };
  }

  _recordMinute(status, ms) {
    const minute = Math.floor(Date.now() / 60_000);
    let current = this.minutes[this.minutes.length - 1];
    if (!current || current.minute !== minute) {
      current = { minute, count: 0, errors: 0, sum_ms: 0, max_ms: 0 };
      this.minutes.push(current);
      while (this.minutes.length > this.minuteBuckets) this.minutes.shift();
    }
    current.count++;
    current.sum_ms += ms;
    if (ms > current.max_ms) current.max_ms = ms;
    if (status >= 400) current.errors++;
  }

  _percentile(p) {
    if (!this.latency.count) return 0;
    const target = Math.ceil((p / 100) * this.latency.count);
    let seen = 0;
    for (let i = 0; i < this.latency.buckets.length; i++) {
      seen += this.latency.buckets[i];
      if (seen >= target) {
        return i < this.latencyBuckets.length ? this.latencyBuckets[i] : this.latencyBuckets[this.latencyBuckets.length - 1];
      }
    }
    return this.latencyBuckets[this.latencyBuckets.length - 1];
  }

  snapshot() {
    const routes = Array.from(this.routes.entries())
      .map(([route, value]) => ({
        route,
        count: value.count,
        errors: value.errors,
        bytes: value.bytes,
        avg_ms: value.count ? Math.round(value.sum_ms / value.count) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      uptime_ms: Math.max(0, Date.now() - this.startedAt),
      started_at: new Date(this.startedAt).toISOString(),
      total_requests: this.total,
      bytes_total: this.bytes,
      status: { ...this.status },
      error_rate: this.total ? Number(((this.status["4xx"] + this.status["5xx"]) / this.total).toFixed(4)) : 0,
      latency: {
        count: this.latency.count,
        avg_ms: this.latency.count ? Math.round(this.latency.sum_ms / this.latency.count) : 0,
        max_ms: this.latency.max_ms,
        p50_ms: this._percentile(50),
        p95_ms: this._percentile(95),
        p99_ms: this._percentile(99),
        buckets: this.latencyBuckets.map((upper, index) => ({
          le_ms: upper,
          count: this.latency.buckets[index],
        })).concat([{ le_ms: "inf", count: this.latency.buckets[this.latencyBuckets.length] }]),
      },
      routes,
      minutes: this.minutes.map((entry) => ({
        minute: entry.minute,
        at: new Date(entry.minute * 60_000).toISOString(),
        count: entry.count,
        errors: entry.errors,
        avg_ms: entry.count ? Math.round(entry.sum_ms / entry.count) : 0,
        max_ms: entry.max_ms,
      })),
    };
  }
}

/**
 * Bounded FIFO-ish log used for recent requests and admin audit entries.
 */
export class BoundedLog {
  constructor({ capacity = 100 } = {}) {
    this.capacity = positiveInt(capacity, 100);
    this.entries = [];
  }

  push(entry) {
    if (!entry || typeof entry !== "object") return null;
    const record = { ...entry, ts: entry.ts || new Date().toISOString() };
    this.entries.push(record);
    while (this.entries.length > this.capacity) this.entries.shift();
    return record;
  }

  list(limit = 50) {
    const count = Math.min(positiveInt(limit, 50), this.capacity);
    return this.entries.slice(-count).reverse();
  }

  clear() {
    this.entries.length = 0;
  }

  get size() {
    return this.entries.length;
  }
}

/**
 * Masks an IP so logs stay useful without retaining full client addresses.
 */
export function maskIp(ip) {
  const value = String(ip || "").trim();
  if (!value) return "unknown";
  if (value.includes(":")) {
    const parts = value.split(":");
    return `${parts.slice(0, 3).join(":")}:…`;
  }
  const parts = value.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return value.slice(0, 24);
}

/**
 * Security headers applied to every response. HTML pages get a permissive but
 * explicit CSP; admin pages are locked to same-origin framing.
 */
export function buildSecurityHeaders({
  isHtml = false,
  isAdmin = false,
  isHttps = true,
  frameAncestors = "*",
  existingCsp = "",
  nonce = "",
} = {}) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-DNS-Prefetch-Control": "off",
  };

  if (isHttps) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  if (isAdmin) {
    headers["X-Frame-Options"] = "DENY";
    headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
  }

  if (isHtml) {
    const safeNonce = String(nonce || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const scriptNonce = safeNonce ? ` 'nonce-${safeNonce}'` : " 'unsafe-inline'";
    const csp = existingCsp || [
      "default-src 'self'",
      `script-src 'self'${scriptNonce} 'unsafe-eval' https://cdn.jsdelivr.net`,
      `script-src-elem 'self'${scriptNonce} https://cdn.jsdelivr.net`,
      "script-src-attr 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: data: https:",
      "connect-src 'self' https:",
      "worker-src 'self' blob:",
      `frame-ancestors ${isAdmin ? "'none'" : frameAncestors}`,
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    headers["Content-Security-Policy"] = csp;
  }

  return headers;
}

/**
 * Returns a new Response with security headers merged in. Existing headers win
 * for content types; CSP is preserved when the handler already set one.
 */
export function applySecurityHeaders(response, options = {}) {
  if (!response) return response;
  try {
    const headers = new Headers(response.headers);
    const contentType = headers.get("Content-Type") || "";
    const isHtml = /text\/html/i.test(contentType);
    const existingCsp = headers.get("Content-Security-Policy") || "";
    const security = buildSecurityHeaders({
      ...options,
      isHtml: options.isHtml === true || (options.isHtml !== false && isHtml),
      existingCsp,
    });
    for (const [name, value] of Object.entries(security)) {
      if (name === "Content-Security-Policy" && existingCsp) continue;
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    return response;
  }
}

/* ---------------------------------------------------------------------------
 * Config export / import
 * ------------------------------------------------------------------------ */

export const CONFIG_IMPORT_MAX_BYTES = 256 * 1024;
export const CONFIG_ALLOWED_KEYS = Object.freeze([
  "config_version",
  "updated_at",
  "site_config",
  "player_fleet",
  "upstreams",
  "proxy_swarm",
  "server_branding",
  "monetization",
  "domain_security",
  "asianflix",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return null;
  }
}

/**
 * Builds a portable config document for the admin export endpoint.
 */
export function buildConfigExport(config, { generator = "vidlyte-edge" } = {}) {
  const cloned = deepClone(config) || {};
  const exported = {};
  for (const key of CONFIG_ALLOWED_KEYS) {
    if (cloned[key] !== undefined) exported[key] = cloned[key];
  }
  return {
    generator,
    exported_at: new Date().toISOString(),
    config_version: Number(exported.config_version) || 1,
    config: exported,
  };
}

/**
 * Validates an imported config document. Accepts either the wrapper produced by
 * buildConfigExport or a bare config object. Returns a sanitized config subset.
 */
export function validateConfigImport(payload, { maxBytes = CONFIG_IMPORT_MAX_BYTES } = {}) {
  const errors = [];
  let raw = payload;

  if (typeof raw === "string") {
    if (raw.length > maxBytes) {
      return { ok: false, errors: ["Configuration payload is too large."], config: null };
    }
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: ["Configuration payload is not valid JSON."], config: null };
    }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["Configuration payload must be a JSON object."], config: null };
  }

  const candidate = isPlainObject(raw.config) ? raw.config : raw;

  try {
    const size = JSON.stringify(candidate).length;
    if (size > maxBytes) errors.push("Configuration payload is too large.");
  } catch (e) {
    return { ok: false, errors: ["Configuration payload is not serializable."], config: null };
  }

  const config = {};
  for (const key of CONFIG_ALLOWED_KEYS) {
    if (candidate[key] === undefined) continue;
    if (key === "config_version") {
      const version = Number(candidate[key]);
      if (!Number.isFinite(version) || version < 1 || version > 1000) {
        errors.push("config_version must be a positive integer.");
        continue;
      }
      config.config_version = Math.floor(version);
      continue;
    }
    if (key === "updated_at") {
      if (typeof candidate[key] !== "string") errors.push("updated_at must be a string.");
      else config.updated_at = candidate[key].slice(0, 40);
      continue;
    }
    if (key === "upstreams") {
      if (!Array.isArray(candidate[key])) {
        errors.push("upstreams must be an array.");
      } else if (candidate[key].length > 20) {
        errors.push("upstreams is limited to 20 entries.");
      } else {
        config.upstreams = candidate[key];
      }
      continue;
    }
    if (!isPlainObject(candidate[key])) {
      errors.push(`${key} must be an object.`);
      continue;
    }
    config[key] = candidate[key];
  }

  if (config.upstreams !== undefined && !Array.isArray(config.upstreams)) {
    errors.push("upstreams must be an array.");
  }
  if (config.proxy_swarm !== undefined) {
    if (config.proxy_swarm.workers !== undefined) {
      if (!Array.isArray(config.proxy_swarm.workers)) errors.push("proxy_swarm.workers must be an array.");
      else if (config.proxy_swarm.workers.length > 10) errors.push("proxy_swarm.workers is limited to 10 nodes.");
    }
  }
  if (config.domain_security !== undefined) {
    for (const field of ["blacklist", "whitelist"]) {
      if (config.domain_security[field] !== undefined && !Array.isArray(config.domain_security[field])) {
        errors.push(`domain_security.${field} must be an array.`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, config: null };
  if (Object.keys(config).length === 0) {
    return { ok: false, errors: ["Configuration payload contains no recognized keys."], config: null };
  }
  return { ok: true, errors: [], config };
}

/* ---------------------------------------------------------------------------
 * Config history: compact summaries and bounded structural diffs
 * ------------------------------------------------------------------------ */

function countEntries(value) {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return 0;
}

function describeValue(value) {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (isPlainObject(value)) return `{${Object.keys(value).length} keys}`;
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  return value === undefined ? null : value;
}

/**
 * A small, stable summary of a config document. Used by the admin history
 * table so snapshots can be listed without shipping every full config.
 */
export function summarizeConfig(config) {
  const cfg = isPlainObject(config) ? config : {};
  const upstreams = Array.isArray(cfg.upstreams) ? cfg.upstreams : [];
  const swarm = isPlainObject(cfg.proxy_swarm) ? cfg.proxy_swarm : {};
  const domains = isPlainObject(cfg.domain_security) ? cfg.domain_security : {};
  const site = isPlainObject(cfg.site_config) ? cfg.site_config : {};
  return {
    config_version: Number(cfg.config_version) || 1,
    updated_at: String(cfg.updated_at || "").slice(0, 40),
    brand_name: String(site.brand_name || "").slice(0, 80),
    upstreams: upstreams.length,
    enabled_upstreams: upstreams.filter((entry) => entry && entry.enabled !== false).length,
    swarm_workers: Array.isArray(swarm.workers) ? swarm.workers.length : 0,
    blacklist: countEntries(domains.blacklist),
    whitelist: countEntries(domains.whitelist),
    keys: Object.keys(cfg).length,
  };
}

/**
 * Bounded structural diff between two config documents. Arrays are compared as
 * whole values (with compact descriptors) to keep output small and stable.
 */
export function diffConfigs(before, after, { maxEntries = 80 } = {}) {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 80;
  const changes = [];

  const walk = (a, b, path) => {
    if (changes.length >= limit) return;
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        if (changes.length >= limit) return;
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ path, before: describeValue(a), after: describeValue(b) });
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ path, before: describeValue(a), after: describeValue(b) });
    }
  };

  walk(before, after, "");
  return changes;
}

/**
 * Cheap health grade from a metrics snapshot, used by /api/diagnostics.
 */
export function gradeHealth(metrics) {
  if (!metrics || !metrics.total_requests) return { grade: "idle", score: 100 };
  const errorRate = metrics.error_rate || 0;
  const p95 = (metrics.latency && metrics.latency.p95_ms) || 0;
  let score = 100;
  score -= Math.min(60, Math.round(errorRate * 200));
  if (p95 > 1000) score -= Math.min(30, Math.round((p95 - 1000) / 100));
  if (score >= 90) return { grade: "excellent", score };
  if (score >= 75) return { grade: "good", score };
  if (score >= 50) return { grade: "degraded", score };
  return { grade: "poor", score };
}
