#!/usr/bin/env node
/**
 * VidLyte external watchdog
 * ---------------------------------------------------------------------------
 * Runs outside Cloudflare (GitHub Actions) so it can still alert when the
 * Worker itself is unreachable. It exercises the real playback chain:
 *
 *   /health/ready?canary=1
 *     -> /api/source/<asset>
 *     -> master.m3u8
 *     -> variant.m3u8
 *     -> first media segment
 *
 * Then sends Telegram alerts on open/recovery with a cooldown and persists
 * state to a directory that GitHub Actions restores/saves via actions/cache.
 *
 * Required env for alerts:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional env:
 *   WATCHDOG_BASE_URL        default https://vid.lyte.workers.dev
 *   WATCHDOG_ASSETS          default "tv/66732/1/1,movie/550"
 *   WATCHDOG_FORCE_CANARY    default "true"
 *   WATCHDOG_TIMEOUT_MS      default 25000
 *   WATCHDOG_COOLDOWN_MIN    default 15
 *   WATCHDOG_STATE_DIR       default ".watchdog-state"
 *   WATCHDOG_DRY_RUN         default "false"
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeOpsStatus } from "./ops-status.mjs";

const env = process.env;
const BASE_URL = String(env.WATCHDOG_BASE_URL || "https://vid.lyte.workers.dev").replace(/\/+$/, "");
const ASSETS = String(env.WATCHDOG_ASSETS || "tv/66732/1/1,movie/550")
  .split(",")
  .map((value) => value.trim().replace(/^\/+|\/+$/g, ""))
  .filter(Boolean);
const FORCE_CANARY = isTrue(env.WATCHDOG_FORCE_CANARY, true);
const TIMEOUT_MS = positiveInt(env.WATCHDOG_TIMEOUT_MS, 25000);
const COOLDOWN_MS = positiveInt(env.WATCHDOG_COOLDOWN_MIN, 15) * 60 * 1000;
const STATE_DIR = env.WATCHDOG_STATE_DIR || ".watchdog-state";
const STATE_FILE = join(STATE_DIR, "state.json");
const DRY_RUN = isTrue(env.WATCHDOG_DRY_RUN, false);
const TELEGRAM_TOKEN = String(env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(env.TELEGRAM_CHAT_ID || "").trim();

function isTrue(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (e) {
    return String(value || "").split("?")[0].slice(0, 160);
  }
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function fetchText(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "follow",
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": "VidLyte-Watchdog/1.0 (+https://vid.lyte.workers.dev)",
      Accept: "*/*",
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  return { response, body, latencyMs: Date.now() - started };
}

function firstUri(body, baseUrl) {
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      return new URL(line, baseUrl).toString();
    } catch (e) {
      return "";
    }
  }
  return "";
}

async function readFirstBytes(response, maxBytes = 2048) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    return Math.min(buffer.byteLength, maxBytes);
  }
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    return value ? Math.min(value.byteLength, maxBytes) : 0;
  } finally {
    try {
      await reader.cancel();
    } catch (e) {}
  }
}

function fail(step, detail, extra = {}) {
  const error = new Error(detail);
  error.step = step;
  error.detail = detail;
  error.extra = extra;
  throw error;
}

async function checkReadiness() {
  const url = `${BASE_URL}/health/ready${FORCE_CANARY ? "?canary=1" : ""}`;
  const { response, body, latencyMs } = await fetchText(url, {}, Math.max(TIMEOUT_MS, 30000));
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch (e) {}
  if (response.status !== 200 || !payload || payload.ready !== true) {
    const reasons = payload && Array.isArray(payload.reasons) ? payload.reasons.join(", ") : "";
    fail(
      "readiness",
      `HTTP ${response.status}${reasons ? `: ${reasons}` : ""}`,
      { http: response.status, latencyMs, reasons }
    );
  }
  return {
    step: "readiness",
    latencyMs,
    canary: payload.canary || null,
    version: payload.version || "",
  };
}

async function checkAsset(asset) {
  const sourceUrl = `${BASE_URL}/api/source/${asset}`;
  const source = await fetchText(sourceUrl, {}, TIMEOUT_MS);
  let payload = null;
  try {
    payload = JSON.parse(source.body);
  } catch (e) {}
  // `/api/source` exposes `stream_url` (and `streams[0].url`); older builds used
  // `masterUrl`, so accept all three shapes.
  const streamEntry = Array.isArray(payload && payload.streams) ? payload.streams[0] : null;
  const streamUrl = String(
    (payload && (payload.masterUrl || payload.stream_url)) ||
      (streamEntry && streamEntry.url) ||
      ""
  );
  if (source.response.status !== 200 || !payload || payload.success !== true || !streamUrl) {
    const reason = payload && payload.error
      ? `: ${payload.error}`
      : streamUrl
        ? ""
        : ": missing stream_url";
    fail(
      `source ${asset}`,
      `HTTP ${source.response.status}${reason}`,
      { http: source.response.status, latencyMs: source.latencyMs }
    );
  }

  const masterUrl = streamUrl;
  const baseOrigin = new URL(BASE_URL).origin;
  if (!masterUrl.startsWith(`${baseOrigin}/`)) {
    fail(`master ${asset}`, "stream URL is not on the watchdog origin");
  }

  const isMp4 = Boolean(streamEntry && streamEntry.is_mp4) || /\.mp4(\?|$)/i.test(masterUrl);
  if (isMp4) {
    const started = Date.now();
    const media = await fetch(masterUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "VidLyte-Watchdog/1.0",
        Range: "bytes=0-2047",
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const bytes = await readFirstBytes(media);
    if (![200, 206].includes(media.status) || bytes === 0) {
      fail(`mp4 ${asset}`, `HTTP ${media.status} with ${bytes} bytes`, {
        http: media.status,
        latencyMs: Date.now() - started,
      });
    }
    return {
      step: `asset ${asset} (mp4)`,
      latencyMs: source.latencyMs + (Date.now() - started),
      audioTracks: Array.isArray(payload.audio_tracks)
        ? payload.audio_tracks.length
        : Array.isArray(payload.audioTracks)
          ? payload.audioTracks.length
          : 0,
      subtitles: Array.isArray(payload.subtitles) ? payload.subtitles.length : 0,
      provider: payload.provider || "",
    };
  }

  const master = await fetchText(masterUrl, {}, TIMEOUT_MS);
  if (master.response.status !== 200 || !/^\s*#EXTM3U/m.test(master.body)) {
    fail(`master ${asset}`, `HTTP ${master.response.status} or invalid playlist`, {
      http: master.response.status,
      latencyMs: master.latencyMs,
    });
  }

  // Some providers return a media playlist directly (no master/variant layer),
  // while others return a true master playlist. Support both shapes.
  let segmentPlaylistBody = master.body;
  let segmentPlaylistUrl = masterUrl;
  let variantLatency = 0;
  const isMasterPlaylist = /#EXT-X-STREAM-INF/i.test(master.body);
  if (isMasterPlaylist) {
    const variantUrl = firstUri(master.body, masterUrl);
    if (!variantUrl) fail(`variant ${asset}`, "no variant playlist in master");
    const variant = await fetchText(variantUrl, {}, TIMEOUT_MS);
    if (variant.response.status !== 200 || !/^\s*#EXTM3U/m.test(variant.body)) {
      fail(`variant ${asset}`, `HTTP ${variant.response.status} or invalid playlist`, {
        http: variant.response.status,
        latencyMs: variant.latencyMs,
      });
    }
    segmentPlaylistBody = variant.body;
    segmentPlaylistUrl = variantUrl;
    variantLatency = variant.latencyMs;
  } else if (!/#EXTINF/i.test(master.body)) {
    fail(`variant ${asset}`, "playlist has no variants or media segments");
  }

  const segmentUrl = firstUri(segmentPlaylistBody, segmentPlaylistUrl);
  if (!segmentUrl) fail(`segment ${asset}`, "no media segment in playlist");
  const segmentStarted = Date.now();
  const segment = await fetch(segmentUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "VidLyte-Watchdog/1.0",
      Range: "bytes=0-2047",
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const segmentBytes = await readFirstBytes(segment);
  if (![200, 206].includes(segment.status) || segmentBytes === 0) {
    fail(`segment ${asset}`, `HTTP ${segment.status} with ${segmentBytes} bytes`, {
      http: segment.status,
      latencyMs: Date.now() - segmentStarted,
    });
  }

  return {
    step: `asset ${asset}`,
    latencyMs: source.latencyMs + master.latencyMs + variantLatency + (Date.now() - segmentStarted),
    audioTracks: Array.isArray(payload.audio_tracks)
      ? payload.audio_tracks.length
      : Array.isArray(payload.audioTracks)
        ? payload.audioTracks.length
        : 0,
    subtitles: Array.isArray(payload.subtitles) ? payload.subtitles.length : 0,
    provider: payload.provider || "",
  };
}

function asFailure(error, fallbackStep) {
  if (error && error.step && error.detail) return error;
  const cause = error && error.cause && (error.cause.code || error.cause.message);
  const detail = `${(error && error.message) || "network error"}${cause ? ` (${cause})` : ""}`.slice(0, 200);
  const wrapped = new Error(detail);
  wrapped.step = fallbackStep;
  wrapped.detail = detail;
  wrapped.extra = {};
  return wrapped;
}

async function runChecks() {
  const checks = [];
  let failure = null;
  try {
    checks.push(await checkReadiness());
  } catch (error) {
    failure = asFailure(error, "connect");
  }
  if (!failure) {
    for (const asset of ASSETS) {
      try {
        checks.push(await checkAsset(asset));
      } catch (error) {
        failure = asFailure(error, `asset ${asset}`);
        break;
      }
    }
  }
  return { ok: !failure, checks, failure };
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

async function writeState(state) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error(`watchdog: could not write state: ${e.message}`);
  }
}

async function sendTelegram(text, silent = false) {
  if (DRY_RUN) return { sent: false, skipped: "dry_run" };
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, skipped: "telegram_not_configured" };
  }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text.slice(0, 3900),
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      return { sent: false, skipped: `telegram_http_${response.status}` };
    }
    return { sent: true, skipped: "" };
  } catch (error) {
    return { sent: false, skipped: String(error.message || error).slice(0, 160) };
  }
}

function failureText(failure, state) {
  const extra = failure.extra || {};
  const lines = [
    `Step: <b>${escapeHtml(failure.step || "unknown")}</b>`,
    `Detail: ${escapeHtml(failure.detail || failure.message || "unknown")}`,
    extra.http ? `HTTP: ${escapeHtml(extra.http)}` : "",
    Number.isFinite(extra.latencyMs) ? `Latency: ${Math.round(extra.latencyMs)}ms` : "",
    `Consecutive failures: ${state.consecutive_failures || 1}`,
    `Base: ${escapeHtml(BASE_URL)}`,
    `Time: ${new Date().toISOString()}`,
  ].filter(Boolean);
  return [
    "🚨 <b>VidLyte watchdog FAILED</b>",
    lines.map((line) => `• ${line}`).join("\n"),
  ].join("\n");
}

function recoveryText(state, checks) {
  const started = state.first_failure_at ? Date.parse(state.first_failure_at) : NaN;
  const durationMin = Number.isFinite(started)
    ? Math.max(0, Math.round((Date.now() - started) / 60000))
    : null;
  const lines = [
    durationMin === null ? "" : `Outage duration: ~${durationMin} min`,
    `Checks passed: ${checks.length}`,
    checks
      .map((check) => `${check.step} (${Math.round(check.latencyMs)}ms)`)
      .join(", "),
    `Base: ${escapeHtml(BASE_URL)}`,
    `Time: ${new Date().toISOString()}`,
  ].filter(Boolean);
  return [
    "✅ <b>VidLyte watchdog RECOVERED</b>",
    lines.map((line) => `• ${line}`).join("\n"),
  ].join("\n");
}

async function main() {
  const state = await readState();
  const startedAt = new Date().toISOString();
  const result = await runChecks();
  const now = Date.now();

  const summary = {
    checked_at: startedAt,
    base_url: BASE_URL,
    assets: ASSETS,
    ok: result.ok,
    checks: result.checks,
    failure: result.failure
      ? {
          step: result.failure.step || "unknown",
          detail: result.failure.detail || result.failure.message || "unknown",
          extra: result.failure.extra || {},
        }
      : null,
    alert: { sent: false, skipped: "" },
  };

  if (!result.ok) {
    state.status = "failing";
    state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
    state.last_checked_at = startedAt;
    state.last_failure_at = startedAt;
    state.first_failure_at = state.first_failure_at || startedAt;
    state.signature = `${result.failure.step}:${result.failure.detail}`;

    const cooledDown = now - Number(state.last_notified_at || 0) >= COOLDOWN_MS;
    const isNewSignature = state.notified_signature !== state.signature;
    const shouldNotify = state.status_before !== "failing" || cooledDown || isNewSignature;
    if (shouldNotify) {
      summary.alert = await sendTelegram(failureText(result.failure, state));
      if (summary.alert.sent) {
        state.last_notified_at = now;
        state.notified_signature = state.signature;
      }
    } else {
      summary.alert = { sent: false, skipped: "cooldown" };
    }
    state.status_before = "failing";
    await writeState(state);
    console.error(`watchdog: FAILED at ${result.failure.step}: ${result.failure.detail}`);
  } else {
    const wasFailing = state.status === "failing" || Number(state.consecutive_failures || 0) > 0;
    state.status = "healthy";
    state.consecutive_failures = 0;
    state.last_checked_at = startedAt;
    state.last_success_at = startedAt;
    state.last_recovery_at = wasFailing ? startedAt : state.last_recovery_at || "";
    if (wasFailing) {
      summary.alert = await sendTelegram(recoveryText(state, result.checks));
      state.first_failure_at = "";
      state.signature = "";
      state.notified_signature = "";
    }
    state.status_before = "healthy";
    await writeState(state);
  }

  await writeOpsStatus("watchdog", {
    ok: result.ok,
    checked_at: startedAt,
    base_url: BASE_URL,
    assets: ASSETS,
    checks: result.checks.slice(0, 20),
    failure: summary.failure,
    alert: summary.alert,
    consecutive_failures: Number(state.consecutive_failures || 0),
    last_success_at: state.last_success_at || "",
    last_failure_at: state.last_failure_at || "",
  });

  const output = JSON.stringify(summary, null, 2);
  console.log(output);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      const lines = [
        `## VidLyte watchdog: ${result.ok ? "OK" : "FAILED"}`,
        "",
        `- Base: \`${BASE_URL}\``,
        `- Assets: \`${ASSETS.join(", ")}\``,
        `- Alert: \`${summary.alert.sent ? "sent" : summary.alert.skipped || "none"}\``,
        result.failure
          ? `- Failure: \`${result.failure.step}\` — ${result.failure.detail}`
          : `- Checks: ${result.checks.length} passed`,
        "",
      ];
      await writeFile(env.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
    } catch (e) {}
  }

  if (!result.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  const message = `${error && error.stack ? error.stack : error}`.slice(0, 2000);
  console.error(`watchdog: fatal error: ${message}`);
  const alert = await sendTelegram(
    `🚨 <b>VidLyte watchdog CRASHED</b>\n• ${escapeHtml(error.message || error)}\n• Time: ${new Date().toISOString()}`
  );

  await writeOpsStatus("watchdog", {
    ok: false,
    fatal: true,
    checked_at: new Date().toISOString(),
    base_url: BASE_URL,
    assets: ASSETS,
    checks: [],
    failure: { step: "fatal", detail: String(error.message || error).slice(0, 300), extra: {} },
    alert,
  });

  console.log(JSON.stringify({ ok: false, fatal: true, error: error.message || String(error), alert }, null, 2));
  process.exitCode = 1;
});
