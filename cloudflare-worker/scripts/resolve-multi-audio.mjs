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
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

function mapOrionPlaylist(text) {
  const firstChunkMatch = text.match(/https:\/\/[^\r\n]+\.m4s[^\r\n]*/);
  if (firstChunkMatch) {
    const firstChunk = firstChunkMatch[0];
    return text.replace(/#EXT-X-MAP:URI="init-stream(\d+)\.m4s"/g, (m, streamIdx) => {
      const initUrl = firstChunk.replace(/chunk-stream\d+-\d+\.m4s/, `init-stream${streamIdx}.m4s`);
      return `#EXT-X-MAP:URI="${initUrl}"`;
    });
  }
  return text;
}

const PUBLISH_URL = (process.env.MULTI_AUDIO_PUBLISH_URL || "https://vid.lyte.workers.dev").replace(/\/+$/, "");
const PUBLISH_KEY = process.env.MULTI_AUDIO_PUBLISH_KEY || "";
const TIMEOUT_MS = Math.max(4000, Number(process.env.MULTI_AUDIO_TIMEOUT_MS) || 25000);

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
  return assets.slice(0, 50);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GitHub-hosted runner IPs are challenged by vidrift's Cloudflare edge, and
// Cloudflare Worker egress is blocked too. Jina Reader is a free, no-card
// public reader that fetches the URL from its own network and returns the raw
// body when X-Return-Format is text. It is used only as a fallback, with
// backoff for its anonymous rate limit.
const READER_BASE = "https://r.jina.ai/";

async function readerFetch(url, attempts = 3) {
  let lastStatus = 0;
  for (let index = 0; index < attempts; index++) {
    const res = await fetchWithTimeout(`${READER_BASE}${url}`, {
      headers: {
        "X-Return-Format": "text",
        Accept: "text/plain",
        "User-Agent": "vidlyte-multi-audio-resolver",
      },
    });
    lastStatus = res.status;
    if (res.ok) return await res.text();
    if (res.status !== 429 && res.status < 500) throw new Error(`reader_http_${res.status}`);
    await sleep(1500 * (index + 1));
  }
  throw new Error(`reader_http_${lastStatus}`);
}

function parseLooseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

function extractM3u8(text) {
  const raw = String(text || "");
  const index = raw.indexOf("#EXTM3U");
  return index >= 0 ? raw.slice(index) : "";
}

async function resolveAsset(target) {
  const suffix = target.type === "tv" ? `/${target.season}/${target.episode}` : "";
  const started = Date.now();
  const failures = [];
  let boot = null;
  let base = "";
  let headers = null;
  let via = "direct";

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
    try {
      const bootText = await readerFetch(`${BOOT_HOSTS[0]}/api/boot/${target.type}/${target.id}${suffix}`);
      const parsed = parseLooseJson(bootText);
      if (parsed && parsed.meta && parsed.meta.playbackToken) {
        boot = parsed;
        base = BOOT_HOSTS[0];
        headers = HEADER_PROFILES.browser;
        via = "reader";
      } else {
        failures.push("reader:no_token");
      }
    } catch (error) {
      failures.push(`reader:${String((error && error.message) || error).slice(0, 40)}`);
    }
  }

  if (!boot) {
    return { ok: false, error: "boot_http_403", boot_failures: failures.slice(0, 8).join(","), latency_ms: Date.now() - started };
  }

  const langMap = {
    original: "en",
    hindi: "hi",
    tamil: "ta",
    telugu: "te",
    arabic: "ar",
    french: "fr",
    spanish: "es",
    german: "de",
    italian: "it",
    japanese: "ja",
    korean: "ko",
    portuguese: "pt",
    russian: "ru",
    turkish: "tr",
    czech: "cs",
    danish: "da",
    filipino: "fil",
    hungarian: "hu",
    indonesian: "id",
    polish: "pol",
    thai: "th",
    ukrainian: "uk",
    vietnamese: "vi",
  };

  // 1. Check Evion multi-audio candidate
  let evionCandidate = null;
  if (boot && boot.meta && boot.meta.evionUrl) {
    try {
      let evText = "";
      try {
        const evRes = await fetchWithTimeout(boot.meta.evionUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://embed.vidrift.net/",
          },
        });
        if (evRes && evRes.ok) {
          evText = await evRes.text();
        }
      } catch (e) {}

      if (!evText || !evText.includes("#EXTM3U")) {
        try {
          evText = await readerFetch(boot.meta.evionUrl);
        } catch (e) {}
      }

      if (evText && evText.includes("#EXTM3U")) {
        const evAudio = [];
        const evVariants = [];
        const evSubs = [];

        const lines = evText.split(/\r?\n/);
        lines.forEach((l, idx) => {
          if (l.includes("TYPE=AUDIO")) {
            const nameMatch = l.match(/NAME="([^"]+)"/);
            const langMatch = l.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = l.match(/URI="([^"]+)"/);
            const defMatch = l.match(/DEFAULT=([A-Z]+)/);
            const name = nameMatch ? nameMatch[1] : `Audio Track ${idx + 1}`;
            const cleanName = name.replace(/^\d+\.\s*/, "").trim() || name;
            const lang = langMatch ? langMatch[1] : langMap[cleanName.toLowerCase()] || "und";
            const uri = uriMatch ? new URL(uriMatch[1], boot.meta.evionUrl).href : "";
            const isDefault = defMatch ? defMatch[1] === "YES" : idx === 0;
            evAudio.push({
              id: idx,
              name: cleanName,
              label: cleanName,
              language: lang,
              default: isDefault,
              uri,
              proxiedUri: uri,
              proxied_uri: uri,
              provider: "evion",
            });
          } else if (l.includes("TYPE=SUBTITLES")) {
            const nameMatch = l.match(/NAME="([^"]+)"/);
            const langMatch = l.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = l.match(/URI="([^"]+)"/);
            if (uriMatch) {
              const name = nameMatch ? nameMatch[1] : `Subtitles ${idx + 1}`;
              const lang = langMatch ? langMatch[1] : "en";
              const uri = new URL(uriMatch[1], boot.meta.evionUrl).href;
              evSubs.push({
                language: lang,
                label: name,
                url: uri,
                uri,
                proxiedUri: uri,
                proxied_uri: uri,
              });
            }
          }
        });

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.includes("#EXT-X-STREAM-INF")) {
            const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const nextLine = lines[i + 1] ? lines[i + 1].trim() : "";
            if (nextLine && !nextLine.startsWith("#")) {
              const variantUri = new URL(nextLine, boot.meta.evionUrl).href;
              const height = resMatch ? resMatch[1].split("x")[1] : "1080";
              evVariants.push({
                resolution: `${height}p`,
                bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 1000000,
                playlistUri: variantUri,
                provider: "evion",
              });
            }
          }
        }

        if (evAudio.length > 0) {
          evionCandidate = {
            ok: true,
            provider: "evion",
            url: boot.meta.evionUrl,
            audio: evAudio.length,
            exp: Math.floor(Date.now() / 1000) + 86400 * 2,
            masterManifest: evText,
            audioTracks: evAudio,
            variants: evVariants,
            subtitles: evSubs,
            via,
            latency_ms: Date.now() - started,
          };
        }
      }
    } catch (e) {}
  }

  // 2. Check Orion multi-audio candidate
  let orionCandidate = null;
  const orionStreams = (boot && boot.meta && Array.isArray(boot.meta.orionStreams) && boot.meta.orionStreams) || [];
  if (orionStreams.length > 0) {
    const audioTracks = [];
    const variants = [];
    let defaultAudioFilename = "a3.m3u8";

    if (boot.meta.warmManifests) {
      for (const wmPath of Object.keys(boot.meta.warmManifests)) {
        if (/\/a\d+\.m3u8$/i.test(wmPath)) {
          defaultAudioFilename = wmPath.split("/").pop();
          break;
        }
      }
    }

    orionStreams.forEach((s, idx) => {
      const cleanName = s.name ? s.name.replace(/^Orion\s*[·•-]\s*/i, "").trim() : `Audio Track ${idx + 1}`;
      const fullStreamUrl = s.url.startsWith("http") ? s.url : `${base}${s.url}`;
      const audioUri = fullStreamUrl.replace(/master\.m3u8$/i, defaultAudioFilename);
      const langKey = cleanName.toLowerCase();
      const langCode = langMap[langKey] || "und";
      audioTracks.push({
        id: idx,
        name: cleanName,
        label: cleanName,
        language: langCode,
        default: idx === 0,
        uri: audioUri,
        proxiedUri: audioUri,
        proxied_uri: audioUri,
        provider: "orion",
      });
    });

    const primaryBase = (orionStreams[0].url.startsWith("http")
      ? orionStreams[0].url
      : `${base}${orionStreams[0].url}`).replace(/master\.m3u8$/i, "");

    const rungs = orionStreams[0].rungs || [];
    if (rungs.length > 0) {
      rungs.forEach((r, idx) => {
        variants.push({
          resolution: `${r.height || 720}p`,
          bandwidth: r.height >= 1080 ? 2500000 : (r.height >= 720 ? 1200000 : 650000),
          playlistUri: `${primaryBase}v${idx}.m3u8`,
          provider: "orion",
        });
      });
    } else {
      variants.push(
        { resolution: "1080p", bandwidth: 2500000, playlistUri: `${primaryBase}v0.m3u8`, provider: "orion" },
        { resolution: "720p", bandwidth: 1200000, playlistUri: `${primaryBase}v1.m3u8`, provider: "orion" },
        { resolution: "480p", bandwidth: 650000, playlistUri: `${primaryBase}v2.m3u8`, provider: "orion" }
      );
    }

    const audioLines = audioTracks.map((t) => {
      const defStr = t.default ? ',DEFAULT=YES,AUTOSELECT=YES' : ',DEFAULT=NO,AUTOSELECT=YES';
      const langStr = t.language ? `,LANGUAGE="${t.language}"` : '';
      return `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${t.name}"${defStr}${langStr},URI="${t.uri}"`;
    }).join("\n");

    const variantLines = variants.map((v) => {
      const resStr = v.resolution ? `,RESOLUTION=${v.resolution === "1080p" ? "1920x1080" : v.resolution === "720p" ? "1280x720" : "854x480"}` : "";
      return `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 2500000}${resStr},AUDIO="audio"\n${v.playlistUri}`;
    }).join("\n");

    const masterManifest = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n${audioLines}\n${variantLines}\n`;
    const primaryUrl = orionStreams[0].url.startsWith("http") ? orionStreams[0].url : `${base}${orionStreams[0].url}`;

    const subManifests = {};
    const subManifestsGz = {};
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": "https://embed.vidrift.net/",
      "Origin": "https://embed.vidrift.net",
    };

    for (const v of variants) {
      try {
        const m = v.playlistUri.match(/\/api\/orion\/([a-zA-Z0-9]+)\/([a-zA-Z0-9_.-]+)/);
        if (m) {
          const vRes = await fetchWithTimeout(v.playlistUri, { headers: fetchHeaders });
          if (vRes && vRes.ok) {
            const mapped = mapOrionPlaylist(await vRes.text());
            subManifests[`${m[1]}:${m[2]}`] = mapped;
            subManifestsGz[`${m[1]}:${m[2]}`] = gzipSync(Buffer.from(mapped)).toString("base64");
          }
        }
      } catch (e) {}
    }

    for (const a of audioTracks) {
      try {
        const m = a.uri.match(/\/api\/orion\/([a-zA-Z0-9]+)\/([a-zA-Z0-9_.-]+)/);
        if (m) {
          const aRes = await fetchWithTimeout(a.uri, { headers: fetchHeaders });
          if (aRes && aRes.ok) {
            const mapped = mapOrionPlaylist(await aRes.text());
            subManifests[`${m[1]}:${m[2]}`] = mapped;
            subManifestsGz[`${m[1]}:${m[2]}`] = gzipSync(Buffer.from(mapped)).toString("base64");
          }
        }
      } catch (e) {}
    }

    orionCandidate = {
      ok: true,
      provider: "orion",
      url: primaryUrl,
      audio: audioTracks.length,
      exp: Math.floor(Date.now() / 1000) + 86400 * 2,
      masterManifest,
      audioTracks,
      variants,
      subManifests: Object.keys(subManifests).length > 0 ? subManifests : undefined,
      subManifestsGz: Object.keys(subManifestsGz).length > 0 ? subManifestsGz : undefined,
      via,
      latency_ms: Date.now() - started,
    };
  }

  // 3. Multi-server ranking: pick the candidate with the highest audio track count
  const directCandidates = [];
  if (evionCandidate && evionCandidate.ok && evionCandidate.audio > 0) directCandidates.push(evionCandidate);
  if (orionCandidate && orionCandidate.ok && orionCandidate.audio > 0) directCandidates.push(orionCandidate);

  if (directCandidates.length > 0) {
    directCandidates.sort((a, b) => b.audio - a.audio);
    return directCandidates[0];
  }

  const token = boot.meta.playbackToken;
  const candidateProviders = ["bigbang", "atlas", "titan", "default"];
  let source = null;
  let chosenProvider = "bigbang";

  for (const prov of candidateProviders) {
    const provQuery = prov === "default" ? "parent=vidrift.net" : `parent=vidrift.net&provider=${prov}`;
    const sourceUrl = `${base}/api/source/${target.type}/${target.id}${suffix}?token=${encodeURIComponent(token)}&${provQuery}`;
    if (via === "reader") {
      try {
        source = parseLooseJson(await readerFetch(sourceUrl));
        if (source && Array.isArray(source.streams) && source.streams.length > 0) {
          chosenProvider = prov;
          break;
        }
      } catch (error) {
        failures.push(`source_reader_${prov}:${String((error && error.message) || error).slice(0, 40)}`);
      }
    } else {
      try {
        const sourceRes = await fetchWithTimeout(sourceUrl, { headers });
        if (sourceRes.ok) {
          source = await sourceRes.json().catch(() => null);
          if (source && Array.isArray(source.streams) && source.streams.length > 0) {
            chosenProvider = prov;
            break;
          }
        } else {
          failures.push(`source_${prov}:${sourceRes.status}`);
          try {
            source = parseLooseJson(await readerFetch(sourceUrl));
            if (source && Array.isArray(source.streams) && source.streams.length > 0) {
              chosenProvider = prov;
              via = "reader";
              break;
            }
          } catch (error) {
            failures.push(`source_reader_${prov}:${String((error && error.message) || error).slice(0, 40)}`);
          }
        }
      } catch (error) {
        failures.push(`source_${prov}_err:${String((error && error.message) || error).slice(0, 40)}`);
      }
    }
  }

  const streams = (source && Array.isArray(source.streams) && source.streams) || [];
  const stream = streams.find((item) => item && /bigbang\.cymru/i.test(String(item.url || item.proxyUrl || ""))) || streams[0];
  const streamUrl = (stream && (stream.url || stream.proxyUrl)) || "";
  if (!stream || !streamUrl) {
    return { ok: false, error: "no_stream", boot_failures: failures.slice(0, 8).join(","), latency_ms: Date.now() - started };
  }

  let master = "";
  const masterRes = await fetchWithTimeout(streamUrl, {
    headers: { Accept: "*/*", "User-Agent": BROWSER_HEADERS["User-Agent"] },
  }).catch(() => null);
  if (masterRes && masterRes.ok) {
    master = extractM3u8(await masterRes.text());
  }
  if (!master.startsWith("#EXTM3U")) {
    failures.push(`master_direct:${masterRes ? masterRes.status : "error"}`);
    try {
      master = extractM3u8(await readerFetch(streamUrl));
    } catch (error) {
      failures.push(`master_reader:${String((error && error.message) || error).slice(0, 40)}`);
    }
  }
  if (!master.startsWith("#EXTM3U")) {
    return { ok: false, error: "master_not_m3u8", boot_failures: failures.slice(0, 8).join(","), latency_ms: Date.now() - started };
  }
  const audio = (master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
  if (audio < 2) {
    return { ok: false, error: `single_audio_${audio}`, latency_ms: Date.now() - started };
  }

  let exp = 0;
  try {
    const parsed = new URL(streamUrl);
    exp = Number(parsed.searchParams.get("exp")) || 0;
  } catch (error) {}

  return { ok: true, url: streamUrl, provider: chosenProvider, audio, exp, via, latency_ms: Date.now() - started };
}

function buildPublishPayload(asset, result, mode) {
  const gz = result.ok && result.subManifestsGz ? result.subManifestsGz : undefined;
  const raw = result.ok && result.subManifests ? result.subManifests : undefined;
  // Raw sub-manifests for a multi-rung asset can exceed the worker publish cap
  // (HTTP 413). The worker decompresses `subManifestsGz`, so prefer the compact
  // form and only send raw maps when no compressed form exists.
  const includeSubs = mode !== "minimal";
  return JSON.stringify({
    asset,
    ok: Boolean(result.ok),
    url: result.ok ? result.url : "",
    audio: result.ok ? result.audio : 0,
    exp: result.ok ? result.exp : 0,
    provider: result.ok ? (result.provider || "bigbang") : "",
    masterManifest: result.ok && result.masterManifest ? result.masterManifest : undefined,
    audioTracks: result.ok && result.audioTracks ? result.audioTracks : undefined,
    variants: result.ok && result.variants ? result.variants : undefined,
    subtitles: result.ok && result.subtitles ? result.subtitles : undefined,
    subManifests: includeSubs && !gz && raw ? raw : undefined,
    subManifestsGz: includeSubs && gz ? gz : undefined,
    error: result.ok ? "" : String(result.error || "resolver_failed").slice(0, 80),
  });
}

async function postPublish(payload) {
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

async function publish(asset, result) {
  if (!PUBLISH_KEY) return { ok: false, error: "publish_key_missing" };
  const payload = buildPublishPayload(asset, result, "full");
  let published = await postPublish(payload);
  if (published.status === 413) {
    // Never lose the resolution because embedded manifests are too large: the
    // record alone still lets the player use the signed stream + audio tracks.
    const minimal = buildPublishPayload(asset, result, "minimal");
    const retried = await postPublish(minimal);
    published = { ...retried, retried_after_413: true };
  }
  return published;
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
    via: result.ok ? result.via : "",
    latency_ms: result.latency_ms || 0,
    published: Boolean(published.ok),
    publish_status: published.status || 0,
  });

  if (process.env.MULTI_AUDIO_SYNC_KV === "1" && result.ok && result.url) {
    try {
      const { execSync } = await import("node:child_process");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const rec = {
        ok: true,
        url: result.url,
        audio: result.audio,
        provider: result.provider || "bigbang",
        exp: result.exp,
        checked_at: new Date().toISOString(),
        error: "",
        masterManifest: result.masterManifest,
        audioTracks: result.audioTracks,
        variants: result.variants,
        subtitles: result.subtitles || [],
        subManifests: result.subManifests || undefined,
      };
      const tmpFile = path.resolve(`./tmp_ma_${target.id}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(rec));
      execSync(`npx wrangler kv key put --remote --namespace-id 1458cc95d50b4ba99b31ea7b736b5e64 "ma_status_v1:${target.asset}" --path "${tmpFile}" --ttl 86400`, {
        cwd: path.resolve(import.meta.dirname, ".."),
        stdio: "inherit",
      });
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    } catch (e) {
      console.error("KV sync error:", e.message);
    }
  }
}
