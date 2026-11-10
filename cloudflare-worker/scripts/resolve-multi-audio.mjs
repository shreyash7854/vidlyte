#!/usr/bin/env node
/**
 * Multi-audio resolver (GitHub Actions)
 * ---------------------------------------------------------------------------
 * Cloudflare Worker egress to vidrift is blocked by an edge challenge, and a
 * viewer's browser/extension can also block the same calls. GitHub Actions
 * runners are not blocked, so the Worker dispatches this workflow and the
 * runner resolves the signed BigBang URL from outside the block.
 *
 * The signed URL is never printed. It is POSTed once to the Worker over an
 * HMAC-signed endpoint and lives only in KV until it expires.
 *
 * Env:
 *   MULTI_AUDIO_ASSETS       comma/space separated assets (tv/1/2/3, movie/550)
 *   MULTI_AUDIO_PUBLISH_URL  default https://vid.lyte.workers.dev
 *   MULTI_AUDIO_PUBLISH_KEY  shared HMAC key (Actions secret)
 *   MULTI_AUDIO_TIMEOUT_MS   per-request timeout, default 12000
 */

import { createHmac } from "node:crypto";

const PUBLISH_URL = (process.env.MULTI_AUDIO_PUBLISH_URL || "https://vid.lyte.workers.dev").replace(/\/+$/, "");
const PUBLISH_KEY = process.env.MULTI_AUDIO_PUBLISH_KEY || "";
const TIMEOUT_MS = Math.max(4000, Number(process.env.MULTI_AUDIO_TIMEOUT_MS) || 12000);

const BROWSER_HEADERS = {
  Accept: "application/json",
  Origin: "https://vid.lyte.workers.dev",
  Referer: "https://vid.lyte.workers.dev/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// vidrift sits behind a Cloudflare edge rule that challenges some networks and
// HTTP clients. Try several header profiles and edge hosts so one blocked path
// does not fail the whole resolution.
const HEADER_PROFILES = {
  browser: {
    Accept: "application/json",
    Origin: "https://vid.lyte.workers.dev",
    Referer: "https://vid.lyte.workers.dev/",
    "User-Agent": BROWSER_HEADERS["User-Agent"],
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Not:A-Brand";v="99", "Chromium";v="157"',
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  },
  minimal: {
    Accept: "application/json",
    "User-Agent": BROWSER_HEADERS["User-Agent"],
  },
  vidrift: {
    Accept: "application/json, text/plain, */*",
    Origin: "https://vidrift.net",
    Referer: "https://vidrift.net/",
    "User-Agent": BROWSER_HEADERS["User-Agent"],
  },
};

const BOOT_HOSTS = ["https://embed.vidrift.net", "https://vidrift.net", "https://mb.vidrift.net"];

function log(message, extra = {}) {
  // Only non-secret facts: asset, counts, status, timings.
  console.log(JSON.stringify({ msg: message, ...extra }));
}

function parseAsset(value) {
  const clean = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  let match = clean.match(/^tv[/-](\d{1,9})[/-](\d{1,3})[/-](\d{1,4})$/i);
  if (match) {
    return { asset: `tv/${match[1]}/${Number(match[2])}/${Number(match[3])}`, type: "tv", id: match[1], season: Number(match[2]), episode: Number(match[3]) };
  }
  match = clean.match(/^movie[/-](\d{1,9})$/i);
  if (match) {
    return { asset: `movie/${match[1]}`, type: "movie", id: match[1], season: 0, episode: 0 };
  }
  return null;
}

function requestedAssets() {
  const raw = process.env.MULTI_AUDIO_ASSETS || "";
  const seen = new Set();
  const assets = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const parsed = parseAsset(piece);
    if (!parsed || seen.has(parsed.asset)) continue;
    seen.add(parsed.asset);
    assets.push(parsed);
  }
  return assets.slice(0, 5);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAsset(target) {
  const suffix = target.type === "tv" ? `/${target.season}/${target.episode}` : "";
  const started = Date.now();
  const failures = [];
  let boot = null;
  let base = "";
  let headers = null;

  for (const candidateBase of BOOT_HOSTS) {
    for (const [profileName, profileHeaders] of Object.entries(HEADER_PROFILES)) {
      const bootUrl = `${candidateBase}/api/boot/${target.type}/${target.id}${suffix}`;
      try {
        const res = await fetchWithTimeout(bootUrl, { headers: profileHeaders });
        if (!res.ok) {
          failures.push(`${new URL(candidateBase).hostname}/${profileName}:${res.status}`);
          continue;
        }
        const parsed = await res.json().catch(() => null);
        if (!parsed || !parsed.meta || !parsed.meta.playbackToken) {
          failures.push(`${new URL(candidateBase).hostname}/${profileName}:no_token`);
          continue;
        }
        boot = parsed;
        base = candidateBase;
        headers = profileHeaders;
        break;
      } catch (error) {
        failures.push(`${new URL(candidateBase).hostname}/${profileName}:${String((error && error.name) || "error")}`);
      }
    }
    if (boot) break;
  }

  if (!boot) {
    return { ok: false, error: "boot_http_403", boot_failures: failures.slice(0, 6).join(","), latency_ms: Date.now() - started };
  }

  const token = boot.meta.playbackToken;
  const sourceUrl =
    `${base}/api/source/${target.type}/${target.id}${suffix}` +
    `?token=${encodeURIComponent(token)}&parent=vidrift.net&provider=bigbang`;
  const sourceRes = await fetchWithTimeout(sourceUrl, { headers });
  if (!sourceRes.ok) {
    return { ok: false, error: `source_http_${sourceRes.status}`, latency_ms: Date.now() - started };
  }
  const source = await sourceRes.json().catch(() => null);
  const streams = (source && Array.isArray(source.streams) && source.streams) || [];
  const stream = streams.find((item) => item && /bigbang\.cymru/i.test(String(item.url || ""))) || streams[0];
  if (!stream || !stream.url) {
    return { ok: false, error: "no_stream", latency_ms: Date.now() - started };
  }

  const masterRes = await fetchWithTimeout(stream.url, {
    headers: { Accept: "*/*", "User-Agent": BROWSER_HEADERS["User-Agent"] },
  });
  if (!masterRes.ok) {
    return { ok: false, error: `master_http_${masterRes.status}`, latency_ms: Date.now() - started };
  }
  const master = await masterRes.text();
  if (!/^#EXTM3U/.test(master.trimStart())) {
    return { ok: false, error: "master_not_m3u8", latency_ms: Date.now() - started };
  }
  const audio = (master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
  if (audio < 2) {
    return { ok: false, error: `single_audio_${audio}`, latency_ms: Date.now() - started };
  }

  let exp = 0;
  try {
    const parsed = new URL(stream.url);
    exp = Number(parsed.searchParams.get("exp")) || 0;
  } catch (error) {}

  return { ok: true, url: stream.url, audio, exp, latency_ms: Date.now() - started };
}

async function publish(asset, result) {
  if (!PUBLISH_KEY) return { ok: false, error: "publish_key_missing" };
  const payload = JSON.stringify({
    asset,
    ok: Boolean(result.ok),
    url: result.ok ? result.url : "",
    audio: result.ok ? result.audio : 0,
    exp: result.ok ? result.exp : 0,
    error: result.ok ? "" : String(result.error || "resolver_failed").slice(0, 80),
  });
  const signature = createHmac("sha256", PUBLISH_KEY).update(payload).digest("hex");
  const res = await fetchWithTimeout(`${PUBLISH_URL}/api/multi-audio/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Multi-Audio-Signature": signature,
      "User-Agent": "vidlyte-multi-audio-resolver",
    },
    body: payload,
  });
  return { ok: res.ok, status: res.status };
}

const assets = requestedAssets();
if (assets.length === 0) {
  log("no_assets");
  process.exit(0);
}

for (const target of assets) {
  let result;
  try {
    result = await resolveAsset(target);
  } catch (error) {
    result = { ok: false, error: String((error && error.message) || error).slice(0, 80) };
  }
  let published;
  try {
    published = await publish(target.asset, result);
  } catch (error) {
    published = { ok: false, status: 0, error: String((error && error.message) || error).slice(0, 80) };
  }
  log("resolved", {
    asset: target.asset,
    ok: Boolean(result.ok),
    audio: result.ok ? result.audio : 0,
    error: result.ok ? "" : result.error,
    boot_failures: result.ok ? "" : result.boot_failures || "",
    latency_ms: result.latency_ms || 0,
    published: Boolean(published.ok),
    publish_status: published.status || 0,
  });
}
