#!/usr/bin/env node
/**
 * VidLyte random TMDB playback sweep
 * ---------------------------------------------------------------------------
 * Resolves random popular TMDB ids through the production gateway and verifies
 * that a real media segment is proxied back. Known-good assets are already
 * covered by scripts/watchdog.mjs; this catches provider-coverage regressions
 * on arbitrary correct ids.
 *
 * For each asset:
 *   /api/source/<asset> -> stream_url -> master/media playlist -> first segment
 *
 * Env:
 *   SWEEP_BASE_URL          default https://vid.lyte.workers.dev
 *   SWEEP_COUNT             default 10, capped at 50
 *   SWEEP_ASSETS            comma-separated override, e.g. movie/550,tv/1399/1/1
 *   SWEEP_MIN_SUCCESS_RATE  default 0.6 (exit 1 below this)
 *   SWEEP_CONCURRENCY       default 2
 *   SWEEP_TIMEOUT_MS        default 30000
 *   SWEEP_SEED              optional, makes the random pick reproducible
 *   SWEEP_DRY_RUN           default false; suppresses Telegram delivery
 *   TMDB_API_KEY            optional TMDB v3 key; without it the sweep uses the
 *                           curated fallback corpus
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  optional failure alert
 */

import { randomUUID } from "node:crypto";

const env = process.env;
const BASE_URL = String(env.SWEEP_BASE_URL || env.WATCHDOG_BASE_URL || "https://vid.lyte.workers.dev").replace(/\/+$/, "");
const COUNT = clampInt(env.SWEEP_COUNT, 10, 1, 50);
const MIN_SUCCESS_RATE = clampFloat(env.SWEEP_MIN_SUCCESS_RATE, 0.6, 0, 1);
const CONCURRENCY = clampInt(env.SWEEP_CONCURRENCY, 2, 1, 5);
const TIMEOUT_MS = clampInt(env.SWEEP_TIMEOUT_MS, 30000, 5000, 120000);
const SEED = env.SWEEP_SEED ? String(env.SWEEP_SEED) : randomUUID();
const DRY_RUN = isTrue(env.SWEEP_DRY_RUN, false);
const TMDB_API_KEY = String(env.TMDB_API_KEY || "").trim();
const TELEGRAM_TOKEN = String(env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(env.TELEGRAM_CHAT_ID || "").trim();

// Used when TMDB is unreachable (for example, blocked from a CI runner or from
// Cloudflare's egress). These are well-known, valid TMDB ids; the sweep still
// randomizes which ones run, so it remains a coverage probe rather than a fixed
// smoke test.
const FALLBACK_MOVIES = [
  550, 27205, 157336, 680, 155, 13, 238, 424, 603, 19995, 597, 8587, 862, 12,
  76341, 293660, 299534, 299536, 118340, 361743, 438631, 872585, 346698,
  634649, 76600,
];
const FALLBACK_TV = [
  1396, 1399, 66732, 1668, 2316, 456, 82856, 71446, 60625, 1416, 1418, 60059,
  87108, 94605, 100088, 94997, 76479, 71912, 85271, 1429,
];

function isTrue(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(value, fallback, min, max) {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Deterministic PRNG so a failing sweep can be replayed with SWEEP_SEED.
function mulberry32(seedText) {
  let state = 2166136261;
  for (const char of String(seedText)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function assetLabel(asset) {
  return asset;
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

async function fetchText(url) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "VidLyte-Sweep/1.0 (+https://vid.lyte.workers.dev)",
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  return { status: response.status, body, latencyMs: Date.now() - started };
}

class SweepFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function fail(reason) {
  throw new SweepFailure(reason);
}

/**
 * Probes one asset and returns only non-sensitive metadata. Never returns the
 * upstream or proxied URL, token, or response body.
 */
async function probeAsset(asset) {
  const started = Date.now();
  const result = {
    asset,
    ok: false,
    provider: "",
    audio_tracks: 0,
    subtitles: 0,
    latency_ms: 0,
    error: "",
  };

  try {
    const source = await fetchText(`${BASE_URL}/api/source/${asset}`);
    if (source.status !== 200) fail(`source_http_${source.status}`);

    let payload = null;
    try {
      payload = JSON.parse(source.body);
    } catch (e) {
      fail("source_invalid_json");
    }
    if (!payload || payload.success !== true) {
      // Never echo upstream error text: it can contain provider URLs.
      fail("source_rejected");
    }

    const streamEntry = Array.isArray(payload.streams) ? payload.streams[0] : null;
    const streamUrl = String(
      payload.masterUrl || payload.stream_url || (streamEntry && streamEntry.url) || ""
    );
    if (!streamUrl) fail("missing_stream_url");
    if (!streamUrl.startsWith(`${new URL(BASE_URL).origin}/`)) fail("stream_off_origin");

    result.provider = String(payload.provider || "");
    result.audio_tracks = Array.isArray(payload.audio_tracks)
      ? payload.audio_tracks.length
      : Array.isArray(payload.audioTracks)
        ? payload.audioTracks.length
        : 0;
    result.subtitles = Array.isArray(payload.subtitles) ? payload.subtitles.length : 0;

    const isMp4 = Boolean(streamEntry && streamEntry.is_mp4) || /\.mp4(\?|$)/i.test(streamUrl);
    if (isMp4) {
      const media = await fetch(streamUrl, {
        redirect: "follow",
        headers: {
          "User-Agent": "VidLyte-Sweep/1.0",
          Range: "bytes=0-2047",
          Accept: "*/*",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const bytes = await readFirstBytes(media);
      if (![200, 206].includes(media.status)) fail(`segment_http_${media.status}`);
      if (bytes === 0) fail("segment_empty");
      result.ok = true;
      result.latency_ms = Date.now() - started;
      return result;
    }

    const playlist = await fetchText(streamUrl);
    if (playlist.status !== 200) fail(`playlist_http_${playlist.status}`);
    if (!/^\s*#EXTM3U/m.test(playlist.body)) fail("playlist_invalid");

    let segmentPlaylistBody = playlist.body;
    let segmentPlaylistUrl = streamUrl;
    if (/#EXT-X-STREAM-INF/i.test(playlist.body)) {
      const variantUrl = firstUri(playlist.body, streamUrl);
      if (!variantUrl) fail("variant_missing");
      const variant = await fetchText(variantUrl);
      if (variant.status !== 200) fail(`variant_http_${variant.status}`);
      if (!/^\s*#EXTM3U/m.test(variant.body)) fail("variant_invalid");
      segmentPlaylistBody = variant.body;
      segmentPlaylistUrl = variantUrl;
    } else if (!/#EXTINF/i.test(playlist.body)) {
      fail("playlist_no_media");
    }

    const segmentUrl = firstUri(segmentPlaylistBody, segmentPlaylistUrl);
    if (!segmentUrl) fail("segment_missing");
    const segment = await fetch(segmentUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "VidLyte-Sweep/1.0",
        Range: "bytes=0-2047",
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const bytes = await readFirstBytes(segment);
    if (![200, 206].includes(segment.status)) fail(`segment_http_${segment.status}`);
    if (bytes === 0) fail("segment_empty");

    result.ok = true;
  } catch (error) {
    result.error = error instanceof SweepFailure ? error.reason : `fetch_${String(error && error.name || "error").slice(0, 40)}`;
  }

  result.latency_ms = Date.now() - started;
  return result;
}

async function fetchPopular(kind, page) {
  const url = `https://api.themoviedb.org/3/${kind}/popular?api_key=${encodeURIComponent(TMDB_API_KEY)}&page=${page}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "VidLyte-Sweep/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`tmdb_${kind}_http_${response.status}`);
  }
  const payload = await response.json();
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  return results
    .filter((entry) => entry && entry.id)
    .map((entry) =>
      kind === "movie" ? `movie/${entry.id}` : `tv/${entry.id}/1/1`
    );
}

async function pickAssets(random) {
  const override = String(env.SWEEP_ASSETS || "")
    .split(",")
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  if (override.length > 0) return { assets: override.slice(0, COUNT), poolSource: "override" };

  let poolSource = "fallback_corpus";
  let movies = [];
  let shows = [];
  if (TMDB_API_KEY) {
    const pages = [1 + Math.floor(random() * 5), 1 + Math.floor(random() * 5)];
    const [movieResult, tvResult] = await Promise.allSettled([
      fetchPopular("movie", pages[0]),
      fetchPopular("tv", pages[1]),
    ]);
    movies = movieResult.status === "fulfilled" ? movieResult.value : [];
    shows = tvResult.status === "fulfilled" ? tvResult.value : [];
    if (movies.length > 0 && shows.length > 0) poolSource = "tmdb";
  }
  if (movies.length === 0) movies = FALLBACK_MOVIES.map((id) => `movie/${id}`);
  if (shows.length === 0) shows = FALLBACK_TV.map((id) => `tv/${id}/1/1`);

  const half = Math.ceil(COUNT / 2);
  const picked = [
    ...shuffle(movies, random).slice(0, half),
    ...shuffle(shows, random).slice(0, COUNT - half),
  ];
  return { assets: picked.slice(0, COUNT), poolSource };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(text) {
  if (DRY_RUN) return { sent: false, skipped: "dry_run" };
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, skipped: "telegram_not_configured" };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 3900),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      return { sent: false, skipped: `telegram_http_${response.status}` };
    }
    return { sent: true, skipped: "" };
  } catch (error) {
    return { sent: false, skipped: String(error && error.name || "error").slice(0, 60) };
  }
}

async function main() {
  const random = mulberry32(SEED);
  const startedAt = new Date().toISOString();
  const { assets, poolSource } = await pickAssets(random);
  const results = await mapLimit(assets, CONCURRENCY, probeAsset);
  const passed = results.filter((result) => result.ok).length;
  const successRate = results.length > 0 ? passed / results.length : 0;
  const healthOk = successRate >= MIN_SUCCESS_RATE;

  const summary = {
    checked_at: startedAt,
    base_url: BASE_URL,
    pool_source: poolSource,
    seed: SEED,
    count: results.length,
    passed,
    failed: results.length - passed,
    success_rate: Number(successRate.toFixed(3)),
    min_success_rate: MIN_SUCCESS_RATE,
    ok: healthOk,
    results,
    alert: { sent: false, skipped: "not_needed" },
  };

  if (!healthOk && results.length > 0) {
    const failures = results.filter((result) => !result.ok);
    summary.alert = await sendTelegram(
      [
        "⚠️ <b>VidLyte random TMDB sweep failed</b>",
        `• Passed: ${passed}/${results.length} (${Math.round(successRate * 100)}%)`,
        `• Minimum: ${Math.round(MIN_SUCCESS_RATE * 100)}%`,
        ...failures.slice(0, 12).map(
          (result) => `• ${escapeHtml(assetLabel(result.asset))}: ${escapeHtml(result.error)}`
        ),
        `• Seed: ${escapeHtml(SEED)}`,
        `• Time: ${new Date().toISOString()}`,
      ].join("\n")
    );
  }

  console.log(JSON.stringify(summary, null, 2));

  if (env.GITHUB_STEP_SUMMARY) {
    try {
      const { writeFile } = await import("node:fs/promises");
      const rows = results
        .map(
          (result) =>
            `| ${assetLabel(result.asset)} | ${result.ok ? "✅" : "❌"} | ${result.provider || "-"} | ${result.audio_tracks} | ${result.latency_ms}ms | ${result.error || "-"} |`
        )
        .join("\n");
      const lines = [
        `## Random TMDB sweep: ${healthOk ? "OK" : "FAILED"}`,
        "",
        `- Passed: **${passed}/${results.length}** (${Math.round(successRate * 100)}%, minimum ${Math.round(MIN_SUCCESS_RATE * 100)}%)`,
        `- Seed: \`${SEED}\``,
        "",
        "| Asset | OK | Provider | Audio | Latency | Error |",
        "|---|---|---|---|---|---|",
        rows,
        "",
      ];
      await writeFile(env.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
    } catch (e) {}
  }

  if (!healthOk) process.exitCode = 1;
}

main().catch(async (error) => {
  const message = String((error && error.stack) || error).slice(0, 1500);
  console.error(`sweep: fatal error: ${message}`);
  await sendTelegram(
    `🚨 <b>VidLyte sweep crashed</b>\n• ${escapeHtml(error && error.message || error)}\n• Time: ${new Date().toISOString()}`
  );
  process.exitCode = 1;
});
