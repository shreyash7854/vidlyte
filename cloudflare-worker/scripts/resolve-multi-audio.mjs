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
import dns from "node:dns";
try { dns.setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) {}
import { resolveKissKH, KISSKH_DRAMA_OVERRIDES } from "../src/providers.js";

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
const TIMEOUT_MS = Math.max(3000, Number(process.env.MULTI_AUDIO_TIMEOUT_MS) || 6000);

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
  const signal = options.signal || AbortSignal.timeout(TIMEOUT_MS);
  return await fetch(url, { ...options, signal, redirect: "follow" });
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

async function enrichWithKissKH(candidate, target, started) {
  if (!candidate || !candidate.ok) return candidate;
  try {
    let title = "";
    let year = "";
    let origLang = "";
    const tmdbRes = await fetchWithTimeout(
      `https://api.tmdb.org/3/${target.type}/${target.id}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`,
      { signal: AbortSignal.timeout(4000) }
    ).catch(() => null);
    if (tmdbRes && tmdbRes.ok) {
      const tmdbData = await tmdbRes.json().catch(() => null);
      if (tmdbData) {
        title = tmdbData.name || tmdbData.title || "";
        year = (tmdbData.first_air_date || tmdbData.release_date || "").slice(0, 4);
        origLang = tmdbData.original_language || "";
      }
    }
    if (!title) return candidate;

    const isAsian = ["ko", "ja", "zh", "th"].includes(origLang);
    const hasAuthenticAsian = (candidate.audioTracks || []).some((t) =>
      /korean|japanese|chinese|thai|^ko$|^zh$|^ja$|^th$/i.test(t.name || t.label || t.language || "")
    );
    const needsAudio =
      !candidate.audioTracks || candidate.audioTracks.length <= 1 || (isAsian && !hasAuthenticAsian);
    const needsSubs = !candidate.subtitles || candidate.subtitles.length === 0;

    if (needsSubs || needsAudio) {
      const kiss = await resolveKissKH({
        assetInfo: target,
        title,
        year,
        originalLanguage: origLang,
        timeoutMs: 8000,
      }).catch(() => null);
      if (kiss) {
        if (needsSubs && Array.isArray(kiss.subtitles) && kiss.subtitles.length > 0) {
          candidate.subtitles = kiss.subtitles;
        }
        if (needsAudio && Array.isArray(kiss.audioTracks) && kiss.audioTracks.length > 0) {
          const kissTrack = {
            id: candidate.audioTracks.length,
            name: kiss.audioTracks[0].name,
            label: kiss.audioTracks[0].label,
            language: kiss.audioTracks[0].language,
            default: true,
            uri: kiss.streamUrl,
            proxiedUri: kiss.streamUrl,
            proxied_uri: kiss.streamUrl,
            provider: "kisskh",
            isMP4: kiss.isMP4,
          };
          (candidate.audioTracks || []).forEach((t) => {
            t.default = false;
            if (isAsian && /^original$/i.test(t.name || t.label || "")) {
              t.name = "English (Dub)";
              t.label = t.name;
              t.language = "eng";
            }
          });
          candidate.audioTracks = [kissTrack, ...(candidate.audioTracks || [])];
          candidate.audio = candidate.audioTracks.length;
          if (candidate.masterManifest) {
            const defStr = ",DEFAULT=YES,AUTOSELECT=YES";
            const langStr = kissTrack.language ? `,LANGUAGE="${kissTrack.language}"` : "";
            const kissLine = `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${kissTrack.name}"${defStr}${langStr},URI="${kissTrack.uri}"`;
            candidate.masterManifest = candidate.masterManifest.replace(/#EXTM3U\n/, `#EXTM3U\n${kissLine}\n`);
          }
        }
      }
    }
  } catch (err) {}
  if (started) candidate.latency_ms = Date.now() - started;
  return candidate;
}

const AUDIO_LANG_DISPLAY = {
  eng: "English", hin: "Hindi", kor: "Korean", zho: "Chinese", jpn: "Japanese",
  tha: "Thai", tam: "Tamil", tel: "Telugu", spa: "Spanish", fra: "French",
  deu: "German", ita: "Italian", por: "Portuguese", rus: "Russian",
  tur: "Turkish", ara: "Arabic", ind: "Indonesian", vie: "Vietnamese",
  fil: "Filipino", may: "Malay", msa: "Malay", khm: "Khmer", mya: "Burmese",
  nep: "Nepali", sin: "Sinhala", ben: "Bengali", urd: "Urdu", mal: "Malayalam",
  kan: "Kannada", mar: "Marathi", pan: "Punjabi", guj: "Gujarati",
};

const AUDIO_LANG_ALIASES = {
  en: "eng", english: "eng",
  hi: "hin", hindi: "hin",
  fr: "fra", fre: "fra", french: "fra",
  es: "spa", spanish: "spa",
  pt: "por", portuguese: "por",
  de: "deu", ger: "deu", german: "deu",
  it: "ita", italian: "ita",
  ja: "jpn", japanese: "jpn",
  ko: "kor", korean: "kor",
  zh: "zho", chi: "zho", chinese: "zho", mandarin: "zho", cantonese: "zho",
  th: "tha", thai: "tha",
  ta: "tam", tamil: "tam",
  te: "tel", telugu: "tel",
  ru: "rus", russian: "rus",
  tr: "tur", turkish: "tur",
  ar: "ara", arabic: "ara",
  id: "ind", indonesian: "ind",
  vi: "vie", vietnamese: "vie",
  tl: "fil", filipino: "fil", tagalog: "fil",
  ms: "msa", may: "msa", malay: "msa",
  km: "khm", khmer: "khm",
  my: "mya", burmese: "mya",
  ne: "nep", nepali: "nep",
  si: "sin", sinhala: "sin",
  bn: "ben", bengali: "ben",
  ur: "urd", urdu: "urd",
  ml: "mal", malayalam: "mal",
  kn: "kan", kannada: "kan",
  mr: "mar", marathi: "mar",
  pa: "pan", punjabi: "pan",
  gu: "guj", gujarati: "guj",
};

function normalizeAudioLang(lang, name = "") {
  const raw = String(lang || "").toLowerCase().trim();
  if (AUDIO_LANG_ALIASES[raw]) return AUDIO_LANG_ALIASES[raw];
  if (raw) return raw;
  const n = String(name || "").toLowerCase().trim();
  return AUDIO_LANG_ALIASES[n] || "";
}

/**
 * FrameX mixes metadata shapes: structured `audioTracks`, a parenthetical
 * language on `server` ("Bowler XVIII · Citadel (Korean)"), and a coarse
 * `audio` flag ("sub"/"dub"/"multi"). Never assume Hindi — a source is only a
 * dub when its language is explicit and differs from the title's original.
 */
function framexAudioInfo(source, originalIso) {
  const src = source && typeof source === "object" ? source : {};
  const track = Array.isArray(src.audioTracks)
    ? src.audioTracks.find((t) => t && (t.language || t.name || t.label))
    : null;
  const paren = String(src.server || "").match(/\(([^)]{2,40})\)\s*$/);
  const raw = [
    track && (track.language || track.label || track.name),
    paren && paren[1],
    typeof src.audio === "string" && !/^(sub|subbed|dub|dubbed|multi|original|orig|default)$/i.test(src.audio)
      ? src.audio
      : "",
    src.language,
  ].map((v) => String(v || "").trim()).find(Boolean) || "";
  const iso = normalizeAudioLang(raw, raw);
  const display = AUDIO_LANG_DISPLAY[iso] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "");
  const audioFlag = String(src.audio || "").toLowerCase();
  const isDub = Boolean(
    display &&
    audioFlag !== "sub" &&
    !/^(original(\s+audio)?|orig|multi[\s-]?audio|default)$/i.test(display) &&
    (originalIso ? iso !== originalIso : false)
  );
  return { language: iso || "und", label: display, isDub };
}

const tmdbLangCache = new Map();
async function fetchOriginalLanguage(target) {
  const key = `${target.type}:${target.id}`;
  if (tmdbLangCache.has(key)) return tmdbLangCache.get(key);
  let lang = "";
  try {
    const res = await fetchWithTimeout(
      `https://api.tmdb.org/3/${target.type}/${target.id}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`,
      { signal: AbortSignal.timeout(3000) }
    ).catch(() => null);
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data) lang = normalizeAudioLang(String(data.original_language || "").toLowerCase(), "");
    }
  } catch (e) {}
  tmdbLangCache.set(key, lang);
  return lang;
}

async function enrichWithFrameX(candidate, target) {
  if (!candidate || !candidate.ok) return candidate;
  try {
    const originalIso = await fetchOriginalLanguage(target);
    const cluster = [
      "https://api.framextv.xyz",
      "https://api.framextv.cc",
      "https://api.framextv.tech",
    ];
    for (const host of cluster) {
      try {
        const endpoint = target.type === "tv"
          ? `${host}/api/stream?type=tv&id=${target.id}&season=${target.season}&episode=${target.episode}`
          : `${host}/api/stream?type=movie&id=${target.id}`;
        const resp = await fetchWithTimeout(endpoint, {
          headers: {
            Referer: "https://framextv.cc/",
            Origin: "https://framextv.cc",
            "User-Agent": BROWSER_HEADERS["User-Agent"],
          },
          signal: AbortSignal.timeout(4000),
        }).catch(() => null);
        if (!resp || !resp.ok) continue;
        const data = await resp.json().catch(() => null);
        if (!data || !data.success || !Array.isArray(data.sources) || data.sources.length === 0) continue;

        // Add one real track per distinct language. Only explicit, different
        // languages count as dubs; never append a mislabeled stream.
        const tracks = candidate.audioTracks || [];
        const knownLang = new Set(
          tracks.map((t) => normalizeAudioLang(t.language, t.name || t.label)).filter(Boolean)
        );
        let added = 0;
        for (const source of data.sources) {
          if (!source || !source.url) continue;
          const info = framexAudioInfo(source, originalIso);
          if (!info.isDub || !info.label) continue;
          if (knownLang.has(info.language)) continue;
          const track = {
            id: tracks.length,
            name: info.label,
            label: info.label,
            language: info.language,
            default: false,
            uri: source.url,
            proxiedUri: source.url,
            proxied_uri: source.url,
            provider: "framextv",
            isMP4: source.type === "mp4" || /\.mp4(\?|$)/i.test(source.url),
          };
          tracks.push(track);
          knownLang.add(info.language);
          added++;
        }
        if (added > 0) {
          candidate.audioTracks = tracks;
          candidate.audio = tracks.length;
        }

        if (Array.isArray(data.subtitles) && data.subtitles.length > 0) {
          const currentSubs = candidate.subtitles || [];
          data.subtitles.forEach((sub) => {
            if (!sub || !sub.url) return;
            const subLang = sub.language || sub.lang || "und";
            const subLabel = `${sub.label || subLang || "Subtitles"} Subtitles`;
            if (!currentSubs.some((cs) => cs.language === subLang || cs.label === subLabel)) {
              currentSubs.push({
                language: subLang,
                label: subLabel,
                url: sub.url,
                uri: sub.url,
                provider: "framextv",
              });
            }
          });
          candidate.subtitles = currentSubs;
        }
        break;
      } catch (e) {}
    }
  } catch (e) {}
  return candidate;
}

async function enrichWithVidrift(candidate, target) {
  if (!candidate || !candidate.ok) return candidate;
  try {
    const suffix = target.type === "tv" ? `/${target.season}/${target.episode}` : "";
    for (const host of BOOT_HOSTS) {
      try {
        const bootRes = await fetchWithTimeout(`${host}/api/boot/${target.type}/${target.id}${suffix}`, {
          headers: HEADER_PROFILES.browser,
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        if (!bootRes || !bootRes.ok) continue;
        const boot = await bootRes.json().catch(() => null);
        if (boot && boot.meta && Array.isArray(boot.meta.orionStreams)) {
          const currentTracks = candidate.audioTracks || [];
          boot.meta.orionStreams.forEach((s) => {
            if (!s || !s.url) return;
            const cleanName = s.name ? s.name.replace(/^Orion\s*[·•-]\s*/i, "").trim() : "";
            if (!cleanName || /^original$/i.test(cleanName)) return;
            const langCode = langMap[cleanName.toLowerCase()] || "und";
            const alreadyHas = currentTracks.some((t) => {
              const tLang = String(t.language || "").toLowerCase();
              const tName = String(t.name || t.label || "").toLowerCase();
              return (langCode && tLang && langCode === tLang) || (tName && tName === cleanName.toLowerCase());
            });
            if (!alreadyHas) {
              const fullStreamUrl = s.url.startsWith("http") ? s.url : `${host}${s.url}`;
              const isMp4Track = s.type === "mp4" || /\.mp4(\?|$)/i.test(fullStreamUrl);
              currentTracks.push({
                id: currentTracks.length,
                name: cleanName,
                label: cleanName,
                language: langCode,
                default: false,
                isMP4: isMp4Track,
                uri: fullStreamUrl,
                proxiedUri: fullStreamUrl,
                proxied_uri: fullStreamUrl,
                provider: "orion",
              });
            }
          });
          candidate.audioTracks = currentTracks;
          candidate.audio = currentTracks.length;
          break;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return candidate;
}

async function fallbackToKissKH(target, started, failures = []) {
  try {
    let title = "";
    let year = "";
    let origLang = "";
    const tmdbRes = await fetchWithTimeout(
      `https://api.tmdb.org/3/${target.type}/${target.id}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`,
      { signal: AbortSignal.timeout(4000) }
    ).catch(() => null);
    if (tmdbRes && tmdbRes.ok) {
      const tmdbData = await tmdbRes.json().catch(() => null);
      if (tmdbData) {
        title = tmdbData.name || tmdbData.title || "";
        year = (tmdbData.first_air_date || tmdbData.release_date || "").slice(0, 4);
        origLang = tmdbData.original_language || "";
      }
    }
    if (title) {
      const kiss = await resolveKissKH({
        assetInfo: target,
        title,
        year,
        originalLanguage: origLang,
        timeoutMs: 8000,
      }).catch(() => null);
      if (kiss && kiss.streamUrl) {
        return {
          ok: true,
          url: kiss.streamUrl,
          provider: "kisskh",
          isMP4: Boolean(kiss.isMP4),
          audio: (kiss.audioTracks && kiss.audioTracks.length) || 1,
          exp: Math.floor(Date.now() / 1000) + 86400 * 2,
          via: "kisskh",
          masterManifest: kiss.masterManifest || "",
          audioTracks: kiss.audioTracks || [],
          variants: kiss.variants || [],
          subtitles: kiss.subtitles || [],
          latency_ms: Date.now() - started,
        };
      }
    }
  } catch (e) {}
  return null;
}

export async function resolveAsset(target) {
  const suffix = target.type === "tv" ? `/${target.season}/${target.episode}` : "";
  const started = Date.now();
  const failures = [];

  // For known Asian drama / target 122206 or 93846, or Asian content, fast-path resolve through KissKH directly and enrich with FrameX & Vidrift
  let isAsianTitle = String(target.id) === "122206" || String(target.id) === "93846" || String(target.id) === "221851" || Boolean(KISSKH_DRAMA_OVERRIDES && KISSKH_DRAMA_OVERRIDES[String(target.id)]);
  if (!isAsianTitle) {
    try {
      const tmdbRes = await fetchWithTimeout(
        `https://api.themoviedb.org/3/${target.type}/${target.id}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`,
        { signal: AbortSignal.timeout(3000) }
      ).catch(() => null);
      if (tmdbRes && tmdbRes.ok) {
        const tmdbData = await tmdbRes.json().catch(() => null);
        if (tmdbData) {
          const l = String(tmdbData.original_language || "").toLowerCase();
          const countries = Array.isArray(tmdbData.origin_country) ? tmdbData.origin_country.map((c) => String(c).toUpperCase()) : [];
          if (["zh", "ko", "ja", "th", "vi", "tl", "cn", "tw", "hk", "kr", "jp"].includes(l) || countries.some((c) => ["CN", "KR", "JP", "TW", "TH", "HK", "VN"].includes(c))) {
            isAsianTitle = true;
          }
        }
      }
    } catch (e) {}
  }

  let directKiss = null;
  if (isAsianTitle) {
    directKiss = await fallbackToKissKH(target, started, failures);
    if (directKiss && directKiss.url) {
      await enrichWithFrameX(directKiss, target);
      await enrichWithVidrift(directKiss, target);
    }
  }

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
    if (directKiss) return directKiss;
    const kissFallback = await fallbackToKissKH(target, started, failures);
    if (kissFallback) return kissFallback;
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
      const isMp4Track = s.type === "mp4" || /\.mp4(\?|$)/i.test(fullStreamUrl);
      const trackUri = fullStreamUrl;
      const langKey = cleanName.toLowerCase();
      const langCode = langMap[langKey] || "und";
      audioTracks.push({
        id: idx,
        name: cleanName,
        label: cleanName,
        language: langCode,
        default: idx === 0,
        isMP4: isMp4Track,
        uri: trackUri,
        proxiedUri: trackUri,
        proxied_uri: trackUri,
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

    const warmUrls = new Set();
    variants.forEach((v) => warmUrls.add(v.playlistUri));
    orionStreams.forEach((s) => {
      if (!s || !s.url) return;
      const fullUrl = s.url.startsWith("http") ? s.url : `${base}${s.url}`;
      if (s.type === "mp4" || /\.mp4(\?|$)/i.test(fullUrl)) return;
      warmUrls.add(fullUrl);
      warmUrls.add(fullUrl.replace(/master\.m3u8$/i, defaultAudioFilename));
      warmUrls.add(fullUrl.replace(/master\.m3u8$/i, "v0.m3u8"));
      warmUrls.add(fullUrl.replace(/master\.m3u8$/i, "v1.m3u8"));
      warmUrls.add(fullUrl.replace(/master\.m3u8$/i, "v2.m3u8"));
    });

    const warmItems = Array.from(warmUrls)
      .map((uri) => ({ uri, m: uri.match(/\/api\/orion\/([a-zA-Z0-9]+)\/([a-zA-Z0-9_.-]+)/) }))
      .filter((item) => item.m);

    await Promise.allSettled(
      warmItems.map(async (item) => {
        try {
          const res = await fetchWithTimeout(item.uri, {
            headers: fetchHeaders,
            signal: AbortSignal.timeout(2200),
          });
          if (res && res.ok) {
            const text = await res.text();
            if (!text || !text.includes("#EXTM3U")) return;
            const mapped = mapOrionPlaylist(text);
            subManifests[`${item.m[1]}:${item.m[2]}`] = mapped;
            subManifestsGz[`${item.m[1]}:${item.m[2]}`] = gzipSync(Buffer.from(mapped)).toString("base64");
          }
        } catch (e) {}
      })
    );

    const orionSubtitles = [];
    if (orionStreams[0] && orionStreams[0].subtitleListUrl) {
      try {
        const subListUrl = orionStreams[0].subtitleListUrl.startsWith("http")
          ? orionStreams[0].subtitleListUrl
          : `${base}${orionStreams[0].subtitleListUrl}`;
        const subRes = await fetchWithTimeout(subListUrl, {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(2200),
        });
        if (subRes && subRes.ok) {
          const subJson = await subRes.json().catch(() => null);
          if (subJson && Array.isArray(subJson.tracks)) {
            for (const t of subJson.tracks) {
              if (!t || !t.url) continue;
              const u = t.url.startsWith("http") ? t.url : `${base}${t.url}`;
              orionSubtitles.push({
                label: String(t.label || t.lang || "Subtitles").replace(/\s*[·•-]\s*Orion/i, "").trim(),
                language: t.lang || "en",
                url: u,
                uri: u,
                provider: "orion",
              });
            }
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
      subtitles: orionSubtitles.length > 0 ? orionSubtitles : undefined,
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
    let chosen = directCandidates[0];
    if (directKiss) {
      const merged = Array.isArray(directKiss.audioTracks) ? directKiss.audioTracks.slice() : [];
      for (const tr of chosen.audioTracks || []) {
        if (!tr || !tr.uri) continue;
        const trName = String(tr.name || tr.label || "").toLowerCase().trim();
        const trLang = String(tr.language || "").toLowerCase().trim();
        if (/^original/i.test(trName) && merged.some((m) => /original/i.test(m.name || m.label || ""))) continue;
        const dup = merged.some((m) => {
          const mName = String(m.name || m.label || "").toLowerCase().trim();
          const mLang = String(m.language || "").toLowerCase().trim();
          return (trName && mName === trName) || (trLang && trLang !== "und" && mLang === trLang);
        });
        if (!dup) merged.push({ ...tr, id: merged.length, default: false });
      }
      directKiss.audioTracks = merged;
      directKiss.audio = merged.length;
      if (chosen.subManifests) directKiss.subManifests = chosen.subManifests;
      if (chosen.subManifestsGz) directKiss.subManifestsGz = chosen.subManifestsGz;
      if ((!directKiss.variants || directKiss.variants.length === 0) && Array.isArray(chosen.variants) && chosen.variants.length > 0) {
        directKiss.variants = chosen.variants;
      }
      if ((!directKiss.subtitles || directKiss.subtitles.length === 0) && Array.isArray(chosen.subtitles) && chosen.subtitles.length > 0) {
        directKiss.subtitles = chosen.subtitles;
      }
      return directKiss;
    }
    chosen = await enrichWithKissKH(chosen, target, started);
    chosen = await enrichWithFrameX(chosen, target);
    return chosen;
  }

  const token = boot.meta.playbackToken;
  const candidateProviders = ["bigbang", "vexon", "orion", "vela", "titan", "atlas", "lyra", "default"];
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
          if (via === "reader" || sourceRes.status >= 500) {
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
        }
      } catch (error) {
        failures.push(`source_${prov}_err:${String((error && error.message) || error).slice(0, 40)}`);
      }
    }
  }

  const streams = (source && Array.isArray(source.streams) && source.streams) || [];
  if (streams.length === 0) {
    if (directKiss) return directKiss;
    const kissFallback = await fallbackToKissKH(target, started, failures);
    if (kissFallback) return kissFallback;
    return { ok: false, error: "no_stream", boot_failures: failures.slice(0, 8).join(","), latency_ms: Date.now() - started };
  }

  const mergeIntoDirectKiss = (extraTracks = [], extraSubs = []) => {
    if (!directKiss) return null;
    const merged = Array.isArray(directKiss.audioTracks) ? directKiss.audioTracks.slice() : [];
    for (const tr of extraTracks) {
      if (!tr || !tr.uri) continue;
      const trName = String(tr.name || tr.label || "").toLowerCase().trim();
      const trLang = String(tr.language || "").toLowerCase().trim();
      if (/^original/i.test(trName) && merged.some((m) => /original/i.test(m.name || m.label || ""))) continue;
      const dup = merged.some((m) => {
        const mName = String(m.name || m.label || "").toLowerCase().trim();
        const mLang = String(m.language || "").toLowerCase().trim();
        return (trName && mName === trName) || (trLang && trLang !== "und" && mLang === trLang);
      });
      if (!dup) {
        merged.push({ ...tr, id: merged.length, default: false });
      }
    }
    directKiss.audioTracks = merged;
    directKiss.audio = merged.length;
    if (Array.isArray(extraSubs) && extraSubs.length > 0) {
      const subs = Array.isArray(directKiss.subtitles) ? directKiss.subtitles.slice() : [];
      for (const s of extraSubs) {
        if (!s || !(s.url || s.uri)) continue;
        const sLbl = String(s.label || s.language || "").toLowerCase();
        if (!subs.some((e) => String(e.label || e.language || "").toLowerCase() === sLbl)) {
          subs.push(s);
        }
      }
      directKiss.subtitles = subs;
    }
    return directKiss;
  };

  // Check if provider returned multiple streams representing different audio dubs (e.g. Titan, FrameX multi-stream)
  const hasMultipleNamedStreams = streams.length >= 2 && streams.some((s) => s && (s.name || (s.label && s.label.includes(" · "))));
  if (hasMultipleNamedStreams) {
    const origLang = (boot && boot.meta && boot.meta.lang) || "ko";
    const audioTracks = [];
    const variants = [];
    streams.forEach((s, idx) => {
      const rawName = s.name || (s.label && s.label.includes(" · ") ? s.label.split(" · ").pop().trim() : s.label) || `Track ${idx + 1}`;
      let name = rawName;
      let lang = "eng";
      if (/hindi/i.test(rawName)) {
        name = "Hindi";
        lang = "hin";
      } else if (/multi[- ]?audio/i.test(rawName) || /original/i.test(rawName)) {
        if (origLang === "ko") {
          name = "Original (Korean)";
          lang = "kor";
        } else if (origLang === "ja") {
          name = "Original (Japanese)";
          lang = "jpn";
        } else if (origLang === "zh") {
          name = "Original (Chinese)";
          lang = "zho";
        } else {
          name = "Original";
          lang = origLang.slice(0, 3).toLowerCase();
        }
      } else {
        name = rawName;
        lang = rawName.slice(0, 3).toLowerCase();
      }

      const sUrl = s.url || s.proxyUrl || "";
      if (!sUrl) return;

      const isOrig = /original/i.test(name) || /multi[- ]?audio/i.test(rawName);
      audioTracks.push({
        id: audioTracks.length,
        name,
        label: name,
        language: lang,
        default: isOrig || audioTracks.length === 0,
        uri: sUrl,
        provider: chosenProvider || "titan",
      });
      variants.push({
        resolution: s.resolution || "720p",
        bandwidth: 1500000,
        playlistUri: sUrl,
        provider: chosenProvider || "titan",
      });
    });

    if (audioTracks.length >= 2) {
      const origIdx = audioTracks.findIndex((t) => /original/i.test(t.name));
      if (origIdx >= 0) {
        audioTracks.forEach((t, i) => { t.default = (i === origIdx); });
      }
      const defaultTrack = audioTracks.find((t) => t.default) || audioTracks[0];

      const masterManifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
        audioTracks.map((t) => `#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,NAME="${t.name}"\n${t.uri}`).join("\n") + "\n";

      let exp = 0;
      try {
        const parsed = new URL(defaultTrack.uri);
        exp = Number(parsed.searchParams.get("Expires") || parsed.searchParams.get("exp")) || 0;
      } catch (error) {}

      let subs = [];
      try {
        const tmdbRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${target.type}/${target.id}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`).catch(() => null);
        const tmdbData = (tmdbRes && tmdbRes.ok) ? await tmdbRes.json().catch(() => null) : null;
        const title = (tmdbData && (tmdbData.name || tmdbData.title)) || "";
        const year = (tmdbData && (tmdbData.first_air_date || tmdbData.release_date || "")).slice(0, 4);
        if (title) {
          const kiss = await resolveKissKH({ assetInfo: target, title, year, timeoutMs: 5000 }).catch(() => null);
          if (kiss && Array.isArray(kiss.subtitles) && kiss.subtitles.length > 0) {
            subs = kiss.subtitles;
          }
        }
      } catch (error) {}

      if (directKiss) {
        return mergeIntoDirectKiss(audioTracks, subs);
      }

      return await enrichWithKissKH({
        ok: true,
        url: defaultTrack.uri,
        provider: chosenProvider || "titan",
        audio: audioTracks.length,
        exp,
        via,
        masterManifest,
        audioTracks,
        variants,
        subtitles: subs,
        latency_ms: Date.now() - started,
      }, target, started);
    }
  }

  const stream = streams.find((item) => item && /bigbang\.cymru/i.test(String(item.url || item.proxyUrl || ""))) || streams[0];
  const streamUrl = (stream && (stream.url || stream.proxyUrl)) || "";
  if (!stream || !streamUrl) {
    if (directKiss) return directKiss;
    const kissFallback = await fallbackToKissKH(target, started, failures);
    if (kissFallback) return kissFallback;
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
    if (directKiss) return directKiss;
    const kissFallback = await fallbackToKissKH(target, started, failures);
    if (kissFallback) return kissFallback;
    return { ok: false, error: "master_not_m3u8", boot_failures: failures.slice(0, 8).join(","), latency_ms: Date.now() - started };
  }
  const audio = (master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
  if (audio < 2) {
    if (directKiss) return directKiss;
    const kissFallback = await fallbackToKissKH(target, started, failures);
    if (kissFallback) {
      await enrichWithFrameX(kissFallback, target);
      await enrichWithVidrift(kissFallback, target);
      return kissFallback;
    }
    return { ok: false, error: `single_audio_${audio}`, latency_ms: Date.now() - started };
  }

  if (directKiss) {
    const bbTracks = [];
    for (const line of master.split(/\r?\n/)) {
      if (!line.includes("TYPE=AUDIO")) continue;
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const langMatch = line.match(/LANGUAGE="([^"]+)"/);
      const uriMatch = line.match(/URI="([^"]+)"/);
      const name = (nameMatch ? nameMatch[1] : "").replace(/^\d+\.\s*/, "").trim();
      const uri = uriMatch ? new URL(uriMatch[1], streamUrl).href : streamUrl;
      if (!name) continue;
      bbTracks.push({
        name,
        label: name,
        language: (langMatch ? langMatch[1] : langMap[name.toLowerCase()] || "und").toLowerCase(),
        uri,
        proxiedUri: uri,
        proxied_uri: uri,
        provider: chosenProvider || "evion",
        isMP4: false,
      });
    }
    return mergeIntoDirectKiss(bbTracks, []);
  }

  let exp = 0;
  try {
    const parsed = new URL(streamUrl);
    exp = Number(parsed.searchParams.get("exp")) || 0;
  } catch (error) {}

  return await enrichWithKissKH({ ok: true, url: streamUrl, provider: chosenProvider, audio, exp, via, latency_ms: Date.now() - started }, target, started);
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
    isMP4: result.ok ? Boolean(result.isMP4) : undefined,
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

import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && (fileURLToPath(import.meta.url) === process.argv[1] || import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")));

if (isMain) {
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
}
