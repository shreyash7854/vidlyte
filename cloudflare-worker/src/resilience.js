/**
 * VidLyte Edge Resilience Utilities
 * ---------------------------------------------------------------------------
 * Small, dependency-free building blocks used by the gateway:
 *
 *  - TTLCache: fresh + stale windows with bounded size
 *  - createCoalescer: collapse concurrent identical upstream work
 *  - CircuitBreakerRegistry: per-host/provider failure isolation
 *  - retryWithJitter: bounded exponential backoff
 *  - staleWhileRevalidate: serve stale immediately, refresh in background
 */

export class TTLCache {
  constructor({ maxEntries = 500, defaultTtlMs = 60_000, defaultStaleMs = 0 } = {}) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 1);
    this.defaultTtlMs = Math.max(0, Number(defaultTtlMs) || 0);
    this.defaultStaleMs = Math.max(0, Number(defaultStaleMs) || 0);
    this.map = new Map();
  }

  set(key, value, ttlMs, staleMs) {
    if (!key) return value;
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : this.defaultTtlMs;
    const stale = Number.isFinite(staleMs) ? Math.max(0, staleMs) : this.defaultStaleMs;
    const now = Date.now();
    this.map.delete(key);
    this.map.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttl,
      staleUntil: now + ttl + stale,
    });
    this.prune(now);
    return value;
  }

  get(key) {
    if (!key) return null;
    const entry = this.map.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now > entry.staleUntil) {
      this.map.delete(key);
      return null;
    }
    return {
      value: entry.value,
      fresh: now <= entry.expiresAt,
      stale: now > entry.expiresAt,
      ageMs: Math.max(0, now - entry.createdAt),
    };
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.map) {
      if (now > entry.staleUntil) this.map.delete(key);
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

export function createCoalescer() {
  const inflight = new Map();
  return function coalesce(key, loader) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve()
      .then(loader)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  };
}

export class CircuitBreakerRegistry {
  constructor({ failureThreshold = 3, cooldownMs = 60_000, halfOpenMaxAttempts = 1 } = {}) {
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 3);
    this.cooldownMs = Math.max(1000, Number(cooldownMs) || 60_000);
    this.halfOpenMaxAttempts = Math.max(1, Number(halfOpenMaxAttempts) || 1);
    this.states = new Map();
  }

  state(key) {
    if (!this.states.has(key)) {
      this.states.set(key, {
        failures: 0,
        successes: 0,
        openedAt: 0,
        halfOpenAttempts: 0,
        lastLatencyMs: 0,
        lastErrorAt: 0,
      });
    }
    return this.states.get(key);
  }

  canAttempt(key, now = Date.now()) {
    const state = this.state(key);
    if (state.openedAt === 0) return true;
    if (now - state.openedAt >= this.cooldownMs) {
      if (state.halfOpenAttempts < this.halfOpenMaxAttempts) {
        state.halfOpenAttempts++;
        return true;
      }
      return false;
    }
    return false;
  }

  recordSuccess(key, latencyMs = 0) {
    const state = this.state(key);
    state.failures = 0;
    state.successes++;
    state.openedAt = 0;
    state.halfOpenAttempts = 0;
    state.lastLatencyMs = Math.max(0, Number(latencyMs) || 0);
    return state;
  }

  recordFailure(key, error) {
    const state = this.state(key);
    state.failures++;
    state.lastErrorAt = Date.now();
    if (error && error.message) state.lastError = String(error.message).slice(0, 120);
    if (state.failures >= this.failureThreshold) {
      state.openedAt = Date.now();
      state.halfOpenAttempts = 0;
    }
    return state;
  }

  isOpen(key, now = Date.now()) {
    const state = this.state(key);
    return state.openedAt !== 0 && now - state.openedAt < this.cooldownMs;
  }

  snapshot() {
    const now = Date.now();
    const out = {};
    for (const [key, state] of this.states) {
      out[key] = {
        failures: state.failures,
        successes: state.successes,
        open: state.openedAt !== 0 && now - state.openedAt < this.cooldownMs,
        cooldown_remaining_ms:
          state.openedAt !== 0 ? Math.max(0, this.cooldownMs - (now - state.openedAt)) : 0,
        last_latency_ms: state.lastLatencyMs,
        last_error: state.lastError || "",
      };
    }
    return out;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function backoffDelay(attempt, baseMs = 120, maxMs = 1500, random = Math.random) {
  const exponent = Math.max(0, Number(attempt) || 0);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = 0.5 + random() * 0.5;
  return Math.max(0, Math.round(ceiling * jitter));
}

/**
 * Run `fn` up to `attempts` times with jittered exponential backoff.
 * `shouldRetry` can veto retries for deterministic failures.
 */
export async function retryWithJitter(fn, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const baseMs = Number(options.baseMs) || 120;
  const maxMs = Number(options.maxMs) || 1500;
  const shouldRetry = typeof options.shouldRetry === "function" ? options.shouldRetry : () => true;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !shouldRetry(error, attempt)) break;
      await sleep(backoffDelay(attempt, baseMs, maxMs, options.random));
    }
  }
  throw lastError;
}

/**
 * Serve a fresh value when available, serve stale while refreshing, and only
 * block on the loader for a cold miss.
 *
 * `waitUntil` is the Worker execution context's waitUntil (optional in tests).
 */
export async function staleWhileRevalidate(cache, key, options = {}) {
  const ttlMs = Number(options.ttlMs) || 0;
  const staleMs = Number(options.staleMs) || 0;
  const loader = options.loader;
  if (typeof loader !== "function") throw new Error("staleWhileRevalidate requires a loader");

  const hit = cache.get(key);
  if (hit && hit.fresh) {
    return { value: hit.value, stale: false, hit: true };
  }

  if (hit && hit.stale) {
    const refresh = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (value !== undefined && value !== null) cache.set(key, value, ttlMs, staleMs);
        return value;
      })
      .catch(() => null);
    if (typeof options.waitUntil === "function") options.waitUntil(refresh);
    else refresh.catch(() => {});
    return { value: hit.value, stale: true, hit: true, refresh };
  }

  const value = await loader();
  if (value !== undefined && value !== null) cache.set(key, value, ttlMs, staleMs);
  return { value, stale: false, hit: false };
}
