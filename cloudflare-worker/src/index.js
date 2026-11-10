/**
 * VidLyte Sovereign HLS Gateway & Edge Proxy — Cloudflare Worker
 * Full Parity Edition with Go WebAssembly (WASI) Core Engine,
 * Multi-Server Switching, Multi-Audio Dubs, and Edge Swarm Failover
 * =============================================================================
 */

import playerTemplate from "./player.html";
import adminTemplate from "./admin.html";
import portalTemplate from "./portal.html";
import {
  createOpaqueCodec,
  constantTimeEqual,
  extractClientIP,
  issuePlaybackToken,
  verifyPlaybackToken,
  parseSecretKeys,
  signAdminSession,
  verifyAdminSession,
  deriveAdminCsrf,
  generateNonce,
  assertSafeUpstreamUrl,
  normalizeSwarmNodeUrl,
  isStreamUrlUsable,
  UpstreamUrlError,
  DEFAULT_HMAC_SECRET,
} from "./security.js";
import { rewriteManifest, isPlaylistUrl } from "./manifest.js";
import { toVttFromBytes } from "./subtitles.js";
import {
  TTLCache,
  createCoalescer,
  CircuitBreakerRegistry,
  retryWithJitter,
  staleWhileRevalidate,
} from "./resilience.js";
import {
  normalizeProviderId,
  defaultProviderOrder,
  providerPriority,
  providerLabel,
  resolveAsianFlix,
} from "./providers.js";
import {
  MetricsRegistry,
  RateLimiterSet,
  BoundedLog,
  classifyRoute,
  maskIp,
  parseRateLimitConfig,
  applySecurityHeaders,
  buildConfigExport,
  validateConfigImport,
  gradeHealth,
  summarizeConfig,
  diffConfigs,
} from "./observability.js";

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function wasmIssueToken(assetID, clientIP, ttlSec, secretSpec, keyID) {
  try {
    return issuePlaybackToken(assetID, clientIP, ttlSec, secretSpec, keyID);
  } catch (e) {
    return issuePlaybackToken(assetID, "127.0.0.1", ttlSec || 900, secretSpec, keyID);
  }
}

async function wasmVerifyToken(assetID, clientIP, token, secretSpec, options) {
  try {
    return verifyPlaybackToken(assetID, clientIP, token, secretSpec, options);
  } catch (e) {
    return false;
  }
}

/**
 * Universal Asset Parser for both hyphenated and slash styles
 */
function parseAssetInfo(assetID) {
  const clean = assetID.replace(/^\/+|\/+$/g, "");

  // 1. TV pattern: tv-id-s-e or tv/id/s/e
  const tvSlash = clean.match(/^tv\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (tvSlash) {
    return { type: "tv", id: tvSlash[1], season: parseInt(tvSlash[2], 10), episode: parseInt(tvSlash[3], 10) };
  }
  const tvHyphen = clean.match(/^tv-([^-]+)-([^-]+)-([^-]+)$/i);
  if (tvHyphen) {
    return { type: "tv", id: tvHyphen[1], season: parseInt(tvHyphen[2], 10), episode: parseInt(tvHyphen[3], 10) };
  }

  // 2. Movie pattern: movie-id or movie/id
  const movieSlash = clean.match(/^movie\/([^/]+)$/i);
  if (movieSlash) {
    return { type: "movie", id: movieSlash[1], season: 0, episode: 0 };
  }
  const movieHyphen = clean.match(/^movie-([^-]+)$/i);
  if (movieHyphen) {
    return { type: "movie", id: movieHyphen[1], season: 0, episode: 0 };
  }

  // 3. Raw numeric ID
  if (/^\d+$/.test(clean)) {
    return { type: "movie", id: clean, season: 0, episode: 0 };
  }

  return { type: "movie", id: clean, season: 0, episode: 0 };
}

// Fast in-memory metadata cache across isolate invocations
const metadataCache = new Map();
const METADATA_TTL_MS = 3 * 3600 * 1000; // 3 hours

// Last known-good resolved sources, used when every live resolver fails.
const lastGoodSourceCache = new Map();
const LAST_GOOD_TTL_MS = 6 * 3600 * 1000; // 6 hours

// Raw (un-rewritten) manifests are cached by upstream URL, never by token.
const rawManifestCache = new Map();
const RAW_MANIFEST_TTL_MS = 30 * 1000; // 30 seconds

const subtitleMemoryCache = new Map();
const SUB_MANIFEST_TTL_MS = 60 * 1000; // 60 seconds
const OPAQUE_MAX_AGE_SEC = 7 * 24 * 3600; // 7 days

// TMDB discovery/search responses (Phase 4 portal + player episode browser).
const tmdbCache = new TTLCache({ maxEntries: 300, defaultTtlMs: 10 * 60 * 1000, defaultStaleMs: 60 * 60 * 1000 });

// Per-isolate swarm health/latency state.
const swarmState = new Map();
let swarmRoundRobinIndex = 0;

// Provider health, request coalescing and source-level stale-while-revalidate.
const providerBreakers = new CircuitBreakerRegistry({
  failureThreshold: 3,
  cooldownMs: 60 * 1000,
  halfOpenMaxAttempts: 1,
});
const hostBreakers = new CircuitBreakerRegistry({
  failureThreshold: 4,
  cooldownMs: 45 * 1000,
  halfOpenMaxAttempts: 1,
});
const coalesceSource = createCoalescer();
const sourceStaleCache = new TTLCache({
  maxEntries: 1000,
  defaultTtlMs: 15 * 60 * 1000,
  defaultStaleMs: 6 * 60 * 60 * 1000,
});
const providerHealth = new Map(); // provider -> { checkedAt, status, latency_ms, error }

function normalizeProvider(value) {
  return normalizeProviderId(value);
}

function sanitizeSubtitleLabel(rawLabel) {
  return String(rawLabel || "Subtitles")
    .replace(/^Subtitles\s*[•·\-–—]\s*/i, "")
    .replace(/\s*[-·]\s*Server\s*\d+.*/gi, "")
    .replace(/\s*\([^)]*Server[^)]*\)/gi, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim() || "Subtitles";
}

function cloneValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return value;
  }
}

function cacheResolvedResult(cacheKey, baseCacheKey, result) {
  if (!result || !result.streamUrl || !isStreamUrlUsable(result.streamUrl)) return;
  metadataCache.set(cacheKey, { data: result, expiresAt: Date.now() + METADATA_TTL_MS });
  lastGoodSourceCache.set(baseCacheKey, {
    data: cloneValue(result),
    expiresAt: Date.now() + LAST_GOOD_TTL_MS,
  });
}


/**
 * Multi-tiered Upstream Source Resolver
 * Fetches stream URLs, multiple audio tracks, subtitles, and quality variants dynamically for all titles
 */

const TMDB_API_KEY = "844dba0bfd8f3a4f3799f6130ef9e335";

function sanitizeText(value, max = 400) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, max);
}

async function tmdbRequest(path, params = {}, timeoutMs = 5000) {
  const query = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const response = await fetch(`https://api.tmdb.org/3/${path}?${query.toString()}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`tmdb_http_${response.status}`);
  return response.json();
}

function mapTmdbSearchResult(item, fallbackType = "movie") {
  if (!item) return null;
  const mediaType = item.media_type === "tv" || item.media_type === "movie"
    ? item.media_type
    : (item.first_air_date !== undefined ? "tv" : fallbackType);
  const title = item.title || item.name || item.original_title || item.original_name || "";
  if (!title || !item.id) return null;
  return {
    id: String(item.id),
    type: mediaType,
    title: sanitizeText(title, 160),
    year: String(item.release_date || item.first_air_date || "").slice(0, 4),
    rating: item.vote_average ? Number(item.vote_average).toFixed(1) : "",
    overview: sanitizeText(item.overview, 600),
    poster: item.poster_path ? `/tmdb-image/w342${item.poster_path}` : "",
    backdrop: item.backdrop_path ? `/tmdb-image/w780${item.backdrop_path}` : "",
    popularity: Number(item.popularity) || 0,
  };
}

/**
 * Canonical TMDB Live Metadata Fetcher with Transparent Logo Detection
 */
async function fetchTMDBMetadata(type, id, season = 1, episode = 1) {
  const isTv = type === "tv" || type === "series";
  const apiKey = TMDB_API_KEY;
  const url = isTv
    ? `https://api.tmdb.org/3/tv/${encodeURIComponent(id)}?api_key=${apiKey}&append_to_response=images&include_image_language=en,null,de,fr,es,it,pt,ja,ko,hi`
    : `https://api.tmdb.org/3/movie/${encodeURIComponent(id)}?api_key=${apiKey}&append_to_response=images&include_image_language=en,null,de,fr,es,it,pt,ja,ko,hi`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();

    let epData = null;
    if (isTv && season && episode) {
      try {
        const epRes = await fetch(
          `https://api.tmdb.org/3/tv/${encodeURIComponent(id)}/season/${season}/episode/${episode}?api_key=${apiKey}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (epRes.ok) epData = await epRes.json();
      } catch (e) {}
    }

    const title = isTv
      ? (epData && epData.name ? `${data.name}: ${epData.name}` : (data.name || `TV Show #${id}`))
      : (data.title || data.original_title || `Movie #${id}`);

    const year = (data.release_date || data.first_air_date || "").slice(0, 4);
    const rating = data.vote_average ? data.vote_average.toFixed(1) : "8.0";
    const genres = (data.genres && data.genres.length > 0) ? data.genres.map((g) => g.name) : ["Drama"];
    const overview = (epData && epData.overview) ? epData.overview : (data.overview || "High-definition streaming provided through VidLyte Sovereign Edge.");
    const backdropUrl = (epData && epData.still_path)
      ? `/tmdb-image/w1280${epData.still_path}`
      : (data.backdrop_path ? `/tmdb-image/w1280${data.backdrop_path}` : "");
    const posterUrl = data.poster_path ? `/tmdb-image/w500${data.poster_path}` : "";

    // Official transparent title logo (priority: English -> language-agnostic -> original show language -> any first logo)
    const logos = (data.images && data.images.logos) ? data.images.logos : [];
    const logoObj = logos.find((l) => l.iso_639_1 === "en" || !l.iso_639_1) ||
                    (data.original_language ? logos.find((l) => l.iso_639_1 === data.original_language) : null) ||
                    logos[0];
    const logoUrl = logoObj && logoObj.file_path ? `/tmdb-image/w500${logoObj.file_path}` : "";

    return { title, seriesTitle: isTv ? data.name || "" : "", year, rating, genres, overview, backdropUrl, posterUrl, logoUrl };
  } catch (e) {
    return null;
  }
}

/**
 * Map an audio-dub label to a short ISO language code.
 */
function languageCodeForLabel(label) {
  const lower = String(label || "").toLowerCase();
  if (lower.includes("hindi")) return "hin";
  if (lower.includes("french") || lower.includes("français")) return "fra";
  if (lower.includes("spanish") || lower.includes("español")) return "spa";
  if (lower.includes("portuguese")) return "por";
  if (lower.includes("german") || lower.includes("deutsch")) return "deu";
  if (lower.includes("italian")) return "ita";
  if (lower.includes("tamil")) return "tam";
  if (lower.includes("telugu")) return "tel";
  if (lower.includes("bengali") || lower.includes("bangla")) return "ben";
  if (lower.includes("malayalam")) return "mal";
  if (lower.includes("korean")) return "kor";
  if (lower.includes("japanese")) return "jpn";
  if (lower.includes("original")) return "orig";
  return "eng";
}

/**
 * Vidrift & Orion Multi-Audio Stream & Subtitle Master Resolver
 */
async function resolveVidrift(type, id, season = 1, episode = 1, env = null) {
  try {
    const isTv = type === "tv" || type === "series";
    const kvKey = `orion_resolved_v4:${type}:${id}:${season}:${episode}`;
    if (env && env.CONFIG_KV) {
      try {
        const cached = await env.CONFIG_KV.get(kvKey, "json");
        if (cached && cached.streamUrl) {
          return cached;
        }
      } catch (e) {}
    }

    const bootPath = isTv
      ? `/api/boot/tv/${encodeURIComponent(id)}/${season}/${episode}`
      : `/api/boot/movie/${encodeURIComponent(id)}`;
    const bootUrl = `https://embed.vidrift.net${bootPath}`;

    let meta = null;
    let vidriftLogo = "";
    let parsedSubtitles = null;

    try {
      const bootRes = await fetchWithSwarmFallback(bootUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://vidrift.net/",
          "Origin": "https://vidrift.net",
          "Accept": "application/json, text/plain, */*",
        },
        signal: AbortSignal.timeout(8500),
      }, env);
      if (bootRes && bootRes.ok) {
        const bootData = await bootRes.json();
        if (bootData && bootData.meta) {
          meta = bootData.meta;
        }
      }
    } catch (e) {}

    // Fallback to HTML scrape if boot API was unavailable
    if (!meta || (!meta.orionStreams && !meta.bigbangUrl && !meta.evionUrl)) {
      const path = isTv
        ? `/embed/tv/${encodeURIComponent(id)}/${season}/${episode}`
        : `/embed/movie/${encodeURIComponent(id)}`;
      const pageUrl = `https://embed.vidrift.net${path}`;

      const vidriftHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://vidrift.net/",
        "Origin": "https://vidrift.net",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-site",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };

      let res = await fetchWithSwarmFallback(pageUrl, {
        headers: vidriftHeaders,
        signal: AbortSignal.timeout(5000),
      }, env).catch(() => null);

      if (res && res.ok) {
        const html = await res.text();
        const match = html.match(/(?:var\s+embedMeta\s*=\s*|embedMeta\s*=\s*)({[\s\S]*?});/) ||
                      html.match(/data-meta=["']([^"']+)["']/i) ||
                      html.match(/window\.__VIDRIFT_DATA__\s*=\s*({[\s\S]*?});/i);
        if (match) {
          try {
            const raw = match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'");
            meta = JSON.parse(raw);
          } catch (e) {}
        }
        const subMatch = html.match(/(?:var\s+subtitleTracks\s*=\s*|subtitleTracks\s*=\s*)(\[[\s\S]*?\]);/);
        if (subMatch) {
          try {
            parsedSubtitles = JSON.parse(subMatch[1]);
          } catch (e) {}
        }
        const logoMatch = html.match(/class=["']pause-logo["'][^>]+(?:data-src|src)=["']([^"']+)["']/i);
        if (logoMatch && logoMatch[1]) {
          vidriftLogo = logoMatch[1];
        }
      }
    }

    if (!meta) {
      return null;
    }

    // Vidrift moved stream resolution behind a per-session endpoint. The boot
    // payload now carries a `playbackToken` instead of pre-resolved
    // orionStreams/bigbangUrl, so resolve through the same /api/source call the
    // first-party player uses. Without this every title without a legacy field
    // fell through to 2Embed and failed at manifest time.
    let apiStreams = null;
    let apiSubtitles = null;
    let apiProvider = "";
    if (meta.playbackToken) {
      const sourcePath = isTv
        ? `/api/source/tv/${encodeURIComponent(id)}/${season}/${episode}`
        : `/api/source/movie/${encodeURIComponent(id)}`;
      const sourceUrl = `https://embed.vidrift.net${sourcePath}?token=${encodeURIComponent(meta.playbackToken)}&parent=vidrift.net`;
      try {
        const srcRes = await fetchWithSwarmFallback(sourceUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": `https://embed.vidrift.net/embed/${isTv ? `tv/${encodeURIComponent(id)}/${season}/${episode}` : `movie/${encodeURIComponent(id)}`}`,
            "Origin": "https://embed.vidrift.net",
            "Accept": "application/json, text/plain, */*",
          },
          signal: AbortSignal.timeout(9000),
        }, env);
        if (srcRes && srcRes.ok) {
          const sourceData = await srcRes.json();
          if (sourceData && Array.isArray(sourceData.streams) && sourceData.streams.length > 0) {
            apiStreams = sourceData.streams;
            apiSubtitles = Array.isArray(sourceData.subtitles) ? sourceData.subtitles : null;
            apiProvider = String(sourceData.provider || "");
          }
        }
      } catch (e) {}
    }

    const audioTracks = [];
    const variants = [];
    let masterUrl = "";
    let provider = "orion";
    let usedApiStreams = false;

    // 1. Parse all multi-audio dubbed streams and qualities from Orion
    if (meta.orionStreams && Array.isArray(meta.orionStreams) && meta.orionStreams.length > 0) {
      // Find default audio filename from warmManifests if available (e.g. a1.m3u8 vs a3.m3u8)
      let defaultAudioFilename = "a3.m3u8";
      if (meta.warmManifests) {
        for (const [wmPath, wmVal] of Object.entries(meta.warmManifests)) {
          if (wmPath.endsWith("master.m3u8") && typeof wmVal === "string") {
            const m = wmVal.match(/TYPE=AUDIO[^\n]+URI="([^"]+)"/i);
            if (m && m[1]) {
              defaultAudioFilename = m[1];
              break;
            }
          }
          if (/\/a\d+\.m3u8$/i.test(wmPath)) {
            defaultAudioFilename = wmPath.split("/").pop();
          }
        }
      }

      meta.orionStreams.forEach((s, idx) => {
        const cleanName = s.name ? s.name.replace(/^Orion\s*[·•-]\s*/i, "").trim() : `Audio Track ${idx + 1}`;
        const fullStreamUrl = s.url.startsWith("http") ? s.url : `https://embed.vidrift.net${s.url}`;
        const audioUri = fullStreamUrl.replace(/master\.m3u8$/i, defaultAudioFilename);
        const langLower = (cleanName || "Original").toLowerCase();
        let langCode = "eng";
        if (langLower.includes("hindi")) langCode = "hin";
        else if (langLower.includes("french") || langLower.includes("français")) langCode = "fra";
        else if (langLower.includes("spanish") || langLower.includes("español")) langCode = "spa";
        else if (langLower.includes("portuguese")) langCode = "por";
        else if (langLower.includes("german") || langLower.includes("deutsch")) langCode = "deu";
        else if (langLower.includes("italian")) langCode = "ita";
        else if (langLower.includes("original")) langCode = "orig";

        audioTracks.push({
          id: idx,
          name: cleanName || "Original",
          label: cleanName || "Original",
          language: langCode,
          default: idx === 0,
          uri: audioUri,
          proxied_uri: audioUri,
          proxiedUri: audioUri,
          provider: "orion",
        });
      });
      masterUrl = meta.orionStreams[0].url.startsWith("http")
        ? meta.orionStreams[0].url
        : `https://embed.vidrift.net${meta.orionStreams[0].url}`;

      const primaryBase = masterUrl.replace(/master\.m3u8$/i, "");
      const primaryRungs = meta.orionStreams[0].rungs;
      if (Array.isArray(primaryRungs) && primaryRungs.length > 0) {
        primaryRungs.forEach((r, rIdx) => {
          const height = r.height || 720;
          const bw = height >= 1080 ? 2500000 : (height >= 720 ? 1200000 : 650000);
          variants.push({
            resolution: `${height}p`,
            bandwidth: bw,
            playlistUri: `${primaryBase}v${rIdx}.m3u8`,
            provider: "orion"
          });
        });
      } else {
        variants.push(
          { resolution: "1080p", bandwidth: 2500000, playlistUri: `${primaryBase}v0.m3u8`, provider: "orion" },
          { resolution: "720p", bandwidth: 1200000, playlistUri: `${primaryBase}v1.m3u8`, provider: "orion" },
          { resolution: "480p", bandwidth: 650000, playlistUri: `${primaryBase}v2.m3u8`, provider: "orion" }
        );
      }
    }

    // 2. Only use BigBang if Orion streams were absent
    if (!masterUrl && meta.bigbangUrl) {
      masterUrl = meta.bigbangUrl;
      provider = "orion";
    } else if (!masterUrl && meta.evionUrl) {
      masterUrl = meta.evionUrl;
      provider = "evion";
    }

    // 2b. New-style Vidrift streams: the per-session /api/source response is
    // authoritative when the legacy boot fields are empty.
    if (!masterUrl && apiStreams) {
      const playable = apiStreams
        .map((s) => {
          const raw = s && (s.proxyUrl || s.url);
          if (!raw) return null;
          const absUrl = String(raw).startsWith("http") ? String(raw) : `https://embed.vidrift.net${raw}`;
          return { ...s, absUrl };
        })
        .filter((s) => s && isStreamUrlUsable(s.absUrl));

      if (playable.length > 0) {
        masterUrl = playable[0].absUrl;
        provider = "orion";
        usedApiStreams = true;

        // Multi-dub streams are labelled "<quality> · <language>".
        playable.forEach((s) => {
          const label = String(s.label || "");
          if (!label.includes(" · ")) return;
          const dub = label.split(" · ").pop().trim();
          if (!dub) return;
          audioTracks.push({
            id: audioTracks.length,
            name: dub,
            label: dub,
            language: languageCodeForLabel(dub),
            default: audioTracks.length === 0,
            uri: s.absUrl,
            proxied_uri: s.absUrl,
            proxiedUri: s.absUrl,
            provider: "orion",
          });
        });
      }
    }

    if (!masterUrl) {
      return null;
    }

    // 3. Subtitles (BigBang multi-subtitles or Orion JSON subtitles)
    const subtitles = [];
    if (meta.bigbangSubtitles && Array.isArray(meta.bigbangSubtitles) && meta.bigbangSubtitles.length > 0) {
      meta.bigbangSubtitles.forEach((s) => {
        if (s.url) {
          const cleanLabel = (s.label || s.lang || "Subtitles").replace(/\s*[·•-]\s*BigBang/i, "").trim();
          subtitles.push({
            language: s.lang || "en",
            label: cleanLabel || "Subtitles",
            url: s.url,
            uri: s.url,
            proxiedUri: s.url,
            proxied_uri: s.url,
          });
        }
      });
    } else if (parsedSubtitles && Array.isArray(parsedSubtitles) && parsedSubtitles.length > 0) {
      parsedSubtitles.forEach((s) => {
        if (s.url) {
          const fullSubUrl = s.url.startsWith("http") ? s.url : `https://embed.vidrift.net${s.url}`;
          const cleanLabel = (s.label || s.lang || "Subtitles").replace(/\s*[·•-]\s*(?:Orion|BigBang|Vidrift)/i, "").trim();
          subtitles.push({
            language: s.lang || s.code || "en",
            label: cleanLabel || "Subtitles",
            url: fullSubUrl,
            uri: fullSubUrl,
            proxiedUri: fullSubUrl,
            proxied_uri: fullSubUrl,
          });
        }
      });
    } else if (meta.orionStreams && meta.orionStreams[0] && meta.orionStreams[0].subtitleListUrl) {
      const primaryStream = meta.orionStreams[0];
      try {
        const subListUrl = primaryStream.subtitleListUrl.startsWith("http")
          ? primaryStream.subtitleListUrl
          : `https://embed.vidrift.net${primaryStream.subtitleListUrl}`;
        const subRes = await fetch(subListUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://embed.vidrift.net/",
          },
          signal: AbortSignal.timeout(3000),
        });
        if (subRes.ok) {
          const subData = await subRes.json();
          if (subData.tracks && Array.isArray(subData.tracks)) {
            subData.tracks.forEach((t) => {
              const fullSubUrl = t.url.startsWith("http") ? t.url : `https://embed.vidrift.net${t.url}`;
              const cleanLabel = (t.label || t.lang || "Subtitles").replace(/\s*[·•-]\s*Orion/i, "").trim();
              subtitles.push({
                language: t.lang || "en",
                label: cleanLabel,
                url: fullSubUrl,
                uri: fullSubUrl,
                proxiedUri: fullSubUrl,
                proxied_uri: fullSubUrl,
              });
            });
          }
        }
      } catch (e) {}
    } else if (apiSubtitles && apiSubtitles.length > 0) {
      apiSubtitles.forEach((s) => {
        const raw = s && (s.url || s.file);
        if (!raw) return;
        const fullSubUrl = String(raw).startsWith("http") ? String(raw) : `https://embed.vidrift.net${raw}`;
        const cleanLabel = String(s.label || s.lang || "Subtitles").replace(/\s*[·•-]\s*(?:Orion|BigBang|Vidrift|Vela)/i, "").trim();
        subtitles.push({
          language: s.lang || s.language || s.code || "en",
          label: cleanLabel || "Subtitles",
          url: fullSubUrl,
          uri: fullSubUrl,
          proxiedUri: fullSubUrl,
          proxied_uri: fullSubUrl,
        });
      });
    }

    // Quality variants fallback if not already populated. New-style Vidrift
    // streams carry their own per-dub playlists, so don't invent three
    // identical quality rungs for them.
    if (variants.length === 0 && !usedApiStreams) {
      variants.push(
        { resolution: "1080p", bandwidth: 2500000, playlistUri: masterUrl, provider: provider },
        { resolution: "720p", bandwidth: 1200000, playlistUri: masterUrl, provider: provider },
        { resolution: "480p", bandwidth: 650000, playlistUri: masterUrl, provider: provider }
      );
    }

    let masterManifest = "";
    if (meta.orionStreams && Array.isArray(meta.orionStreams) && meta.orionStreams.length > 0) {
      const audioLines = audioTracks.map((t) => {
        const defStr = t.default ? ',DEFAULT=YES,AUTOSELECT=YES' : ',DEFAULT=NO,AUTOSELECT=YES';
        const langStr = t.language ? `,LANGUAGE="${t.language}"` : '';
        return `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${t.name}"${defStr}${langStr},URI="${t.uri}"`;
      }).join("\n");
      const subLines = subtitles.map((s) => {
        return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${s.label}",LANGUAGE="${s.language}",DEFAULT=NO,AUTOSELECT=YES,URI="${s.uri || s.url}"`;
      }).join("\n");
      const variantLines = variants.map((v) => {
        const resStr = v.resolution ? `,RESOLUTION=${v.resolution === "1080p" ? "1920x1080" : v.resolution === "720p" ? "1280x720" : "854x480"}` : "";
        const audioGroup = audioLines ? ',AUDIO="audio"' : '';
        const subGroup = subLines ? ',SUBTITLES="subs"' : '';
        return `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 2500000}${resStr}${audioGroup}${subGroup}\n${v.playlistUri}`;
      }).join("\n");
      masterManifest = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n${audioLines ? audioLines + "\n" : ""}${subLines ? subLines + "\n" : ""}${variantLines}\n`;
    }

    const resolvedResult = {
      streamUrl: masterUrl,
      backupStreamUrl: (meta && meta.bigbangUrl) || "",
      masterManifest: masterManifest,
      provider: provider,
      isMP4: false,
      logoUrl: vidriftLogo,
      audioTracks: audioTracks,
      subtitles: subtitles,
      variants: variants,
    };

    if (env && env.CONFIG_KV && masterUrl) {
      try {
        await env.CONFIG_KV.put(kvKey, JSON.stringify(resolvedResult), { expirationTtl: 14400 });
      } catch (e) {}
    }

    return resolvedResult;
  } catch (e) {
    return null;
  }
}

/**
 * 2Embed & 2vcdn High-Availability Stream & Subtitle Fallback Resolver
 */
async function resolve2Embed(type, id, season = 1, episode = 1) {
  try {
    const isTv = type === "tv" || type === "series";
    const embedUrl = isTv
      ? `https://www.2embed.cc/embedtv/${encodeURIComponent(id)}&s=${season}&e=${episode}`
      : `https://www.2embed.cc/embed/${encodeURIComponent(id)}`;

    const res1 = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://google.com",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res1.ok) return null;
    const html1 = await res1.text();

    const swishMatch = html1.match(/data-src=["'](https:\/\/streamsrcs\.2embed\.cc\/swish\?id=[\w\-]+[^"']*)["']/i);
    if (!swishMatch) return null;

    const res2 = await fetch(swishMatch[1], {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.2embed.cc/",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res2.ok) return null;
    const html2 = await res2.text();

    const frameMatch = html2.match(/<iframe[^>]+src=["']([\w\-]+)["']/i);
    if (!frameMatch) return null;
    const vcdnUrl = `https://2vcdn.skin/e/${frameMatch[1]}`;

    const res3 = await fetch(vcdnUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://streamsrcs.2embed.cc/",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res3.ok) return null;
    const html3 = await res3.text();

    const scriptMatch = html3.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\)/);
    if (!scriptMatch) return null;

    const match = scriptMatch[0].match(/}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
    if (!match) return null;
    let [_, p, a, c, k] = match;
    a = parseInt(a, 10);
    c = parseInt(c, 10);
    k = k.split("|");
    while (c--) {
      if (k[c]) p = p.replace(new RegExp("\\b" + c.toString(a) + "\\b", "g"), k[c]);
    }

    const lm = p.match(/var links\s*=\s*({[\s\S]*?});/);
    if (!lm) return null;
    const links = JSON.parse(lm[1]);

    let masterUrl = "";
    if (links.hls4) {
      masterUrl = links.hls4.startsWith("http") ? links.hls4 : `https://2vcdn.skin${links.hls4}`;
    } else if (links.hls2) {
      masterUrl = links.hls2;
    } else if (links.hls3) {
      masterUrl = links.hls3;
    }

    if (!masterUrl) return null;

    const subs = [];
    const tracksMatch = p.match(/tracks\s*:\s*(\[[\s\S]*?\])\s*,\s*captions/);
    if (tracksMatch) {
      try {
        const rawTracks = new Function("return " + tracksMatch[1])();
        for (const trk of rawTracks) {
          if (trk.kind === "captions" || trk.file) {
            const subFile = trk.file?.startsWith("http") ? trk.file : `https://2vcdn.skin${trk.file}`;
            subs.push({
              label: trk.label || "Subtitles",
              language: trk.language || "en",
              url: subFile,
            });
          }
        }
      } catch (e) {}
    }

    return { masterUrl, subs, provider: "2vcdn" };
  } catch (e) {
    return null;
  }
}

function createBaseResult(assetInfo, requestedProvider) {
  const isTv = assetInfo.type === "tv" || assetInfo.type === "series";
  return {
    title: isTv
      ? `TV Show #${assetInfo.id} S${String(assetInfo.season || 1).padStart(2, "0")}E${String(assetInfo.episode || 1).padStart(2, "0")}`
      : `Movie #${assetInfo.id}`,
    streamUrl: "",
    provider: requestedProvider || "framextv",
    isMP4: false,
    audioTracks: [],
    subtitles: [],
    variants: [],
    sources: [],
    year: "",
    rating: "8.5",
    genres: ["Drama"],
    overview: "High-definition streaming provided through VidLyte Sovereign Edge.",
    logoUrl: "",
    backdropUrl: "",
    posterUrl: "",
  };
}

function applyResolvedProvider(result, providerResult) {
  if (!providerResult || !providerResult.streamUrl) return result;
  result.streamUrl = providerResult.streamUrl;
  if (providerResult.backupStreamUrl) result.backupStreamUrl = providerResult.backupStreamUrl;
  if (providerResult.masterManifest) result.masterManifest = providerResult.masterManifest;
  result.provider = providerResult.provider || result.provider;
  result.isMP4 = Boolean(providerResult.isMP4);
  if (providerResult.title) result.title = providerResult.title;
  if (providerResult.logoUrl && !result.logoUrl) result.logoUrl = providerResult.logoUrl;
  if (providerResult.posterUrl && !result.posterUrl) result.posterUrl = providerResult.posterUrl;
  if (Array.isArray(providerResult.audioTracks) && providerResult.audioTracks.length > 0) {
    result.audioTracks = providerResult.audioTracks;
  } else {
    result.audioTracks = [
      {
        name: "Original Audio",
        label: "Original Audio",
        language: "eng",
        default: true,
        uri: providerResult.streamUrl,
        provider: result.provider,
      },
    ];
  }
  if (Array.isArray(providerResult.subtitles)) result.subtitles = providerResult.subtitles;
  if (Array.isArray(providerResult.variants)) result.variants = providerResult.variants;
  if (Array.isArray(providerResult.sources)) result.sources = providerResult.sources;
  return result;
}

/**
 * FrameX failover cluster. Each host is attempted once with a hard 2.6s cap.
 */
async function resolveFrameX(assetInfo) {
  const cluster = [
    "https://api.framextv.xyz",
    "https://api.framextv.cc",
    "https://api.framextv.tech",
  ];

  for (const host of cluster) {
    try {
      let endpoint = `${host}/api/stream?type=movie&id=${encodeURIComponent(assetInfo.id)}`;
      if (assetInfo.type === "series" || assetInfo.type === "tv") {
        endpoint = `${host}/api/stream?type=tv&id=${encodeURIComponent(assetInfo.id)}&season=${assetInfo.season || 1}&episode=${assetInfo.episode || 1}`;
      }

      const resp = await fetch(endpoint, {
        signal: AbortSignal.timeout(2600),
        headers: {
          Referer: "https://framextv.cc/",
          Origin: "https://framextv.cc",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });
      if (!resp.ok) continue;

      const data = await resp.json();
      if (!data.success || !Array.isArray(data.sources) || data.sources.length === 0) continue;

      const hlsSource = data.sources.find(
        (source) => source.type === "hls" || (source.url && source.url.toLowerCase().includes(".m3u8"))
      );
      const bestSource = hlsSource || data.sources[0];
      if (!bestSource || !bestSource.url) continue;

      // Reject mismatched media type (e.g. FrameX returning a movie when TV series was requested)
      const decodedUrl = (() => { try { return decodeURIComponent(bestSource.url).toLowerCase(); } catch (e) { return bestSource.url.toLowerCase(); } })();
      if ((assetInfo.type === "series" || assetInfo.type === "tv") && (decodedUrl.includes("/movie/") || decodedUrl.includes("%2fmovie%2f"))) {
        continue;
      }
      if (assetInfo.type === "movie" && (decodedUrl.includes("/series/") || decodedUrl.includes("/tv/"))) {
        continue;
      }

      const subtitles = [];
      if (Array.isArray(data.subtitles)) {
        const seen = new Set();
        data.subtitles.forEach((sub) => {
          if (!sub || !sub.url) return;
          const label = sanitizeSubtitleLabel(sub.label || sub.language || "English");
          const key = label.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          subtitles.push({
            language: sub.language || sub.lang || "en",
            label,
            url: sub.url,
          });
        });
      }

      const variants = [];
      const seenRes = new Set();
      data.sources.forEach((source) => {
        if (!source || !source.url) return;
        let resolution = String(source.quality || "").trim();
        if (!resolution || resolution.toLowerCase() === "auto") {
          if (variants.length > 0) return;
          resolution = "Auto";
        }
        const key = resolution.toLowerCase();
        if (seenRes.has(key)) return;
        seenRes.add(key);
        variants.push({
          resolution,
          playlistUri: source.url,
          bandwidth: resolution.includes("1080")
            ? 3200000
            : resolution.includes("720")
              ? 1800000
              : 1000000,
          provider: "framextv",
        });
      });

      return {
        streamUrl: bestSource.url,
        provider: "framextv",
        isMP4: bestSource.type === "mp4" || /\.mp4(\?|$)/i.test(bestSource.url),
        subtitles,
        variants,
        audioTracks: [
          {
            name: "Original Audio",
            label: "Original Audio",
            language: "eng",
            default: true,
            uri: bestSource.url,
            provider: "framextv",
          },
        ],
      };
    } catch (e) {
      // Try the next cluster host.
    }
  }

  return null;
}

async function resolve2EmbedSource(assetInfo) {
  const embed2 = await resolve2Embed(
    assetInfo.type,
    assetInfo.id,
    assetInfo.season || 1,
    assetInfo.episode || 1
  );
  if (!embed2 || !embed2.masterUrl) return null;

  const subtitles = (embed2.subs || [])
    .filter((sub) => sub && (sub.url || sub.uri))
    .map((sub) => ({
      language: sub.language || sub.lang || "en",
      label: sanitizeSubtitleLabel(sub.label || sub.language || "Subtitles"),
      url: sub.url || sub.uri,
    }));

  return {
    streamUrl: embed2.masterUrl,
    provider: "2vcdn",
    isMP4: /\.mp4(\?|$)/i.test(embed2.masterUrl),
    subtitles,
    variants: [],
    audioTracks: [
      {
        name: "Original / Dual Audio",
        label: "Original / Dual Audio",
        language: "orig",
        default: true,
        uri: embed2.masterUrl,
        provider: "2vcdn",
      },
    ],
  };
}

function getAsianFlixOverrides(assetInfo) {
  const config = runtimeConfig.asianflix || {};
  const overrides = [];
  const keys = [
    `${assetInfo.type}:${assetInfo.id}:${assetInfo.season || 0}:${assetInfo.episode || 0}`,
    `${assetInfo.type}:${assetInfo.id}`,
  ];
  for (const key of keys) {
    const value = config.page_overrides && config.page_overrides[key];
    if (value) overrides.push(String(value));
  }
  if (config.page_url_template) {
    overrides.push(
      String(config.page_url_template)
        .replace(/\{id\}/g, encodeURIComponent(assetInfo.id))
        .replace(/\{season\}/g, String(assetInfo.season || 1))
        .replace(/\{episode\}/g, String(assetInfo.episode || 1))
    );
  }
  return overrides;
}

async function resolveProviderSource(provider, assetInfo, tmdbMeta, env = null) {
  const id = normalizeProvider(provider);

  if (id === "orion" || id === "evion") {
    const vidrift = await resolveVidrift(
      assetInfo.type,
      assetInfo.id,
      assetInfo.season || 1,
      assetInfo.episode || 1,
      env
    );
    return vidrift || null;
  }

  if (id === "framextv") {
    return resolveFrameX(assetInfo);
  }

  if (id === "asianflix") {
    return resolveAsianFlix({
      assetInfo,
      title: (tmdbMeta && (tmdbMeta.seriesTitle || tmdbMeta.title)) || "",
      year: (tmdbMeta && tmdbMeta.year) || "",
      pageOverrides: getAsianFlixOverrides(assetInfo),
      timeoutMs: 6000,
    });
  }

  if (id === "2vcdn") {
    return resolve2EmbedSource(assetInfo);
  }

  return null;
}

function getProviderOrder(requestedProvider) {
  if (requestedProvider) return [normalizeProvider(requestedProvider)];

  const configured = (runtimeConfig.upstreams || [])
    .filter((upstream) => upstream && upstream.enabled !== false)
    .slice()
    .sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99))
    .map((upstream) => normalizeProvider(upstream.id));

  const seen = new Set();
  const order = [];
  for (const provider of [...configured, ...defaultProviderOrder()]) {
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    order.push(provider);
  }
  return order.sort((a, b) => {
    const aConfigured = configured.indexOf(a);
    const bConfigured = configured.indexOf(b);
    if (aConfigured >= 0 && bConfigured >= 0) return aConfigured - bConfigured;
    if (aConfigured >= 0) return -1;
    if (bConfigured >= 0) return 1;
    return providerPriority(a) - providerPriority(b);
  });
}

async function verifyManifestPlayable(result, provider, env) {
  if (!result || !result.streamUrl) return false;
  if (result.isMP4 || /\.mp4(\?|$)/i.test(result.streamUrl)) return true;
  if (result.masterManifest) return true;
  try {
    const safeUrl = assertSafeUpstreamUrl(result.streamUrl, {
      extraAllowlist: env && env.UPSTREAM_ALLOWLIST,
    }).toString();
    const target = new URL(safeUrl);
    const headers = getUpstreamHeaders(provider, target, null);
    const res = await fetchWithSwarmFallback(
      safeUrl,
      { headers, signal: AbortSignal.timeout(4500) },
      env
    );
    if (!res || !res.ok) return false;
    const body = await res.text();
    return /^\s*#EXTM3U/.test(body);
  } catch (e) {
    return false;
  }
}

async function attemptProvider(provider, assetInfo, tmdbMeta, env = null) {
  const breakerKey = `provider:${provider}`;
  if (!providerBreakers.canAttempt(breakerKey)) return null;

  const started = Date.now();
  try {
    const result = await resolveProviderSource(provider, assetInfo, tmdbMeta, env);
    const latency = Date.now() - started;

    if (result && result.streamUrl && isStreamUrlUsable(result.streamUrl)) {
      // Never commit a source we cannot actually fetch: a provider that hands
      // back a 403/404 manifest (2Embed did this for whole catalogues) must
      // fall through to the next provider instead of surfacing a 502.
      const playable = await verifyManifestPlayable(result, provider, env);
      if (playable) {
        providerBreakers.recordSuccess(breakerKey, latency);
        providerHealth.set(provider, {
          checkedAt: new Date().toISOString(),
          status: "healthy",
          latency_ms: latency,
          error: "",
        });
        return result;
      }
      providerBreakers.recordFailure(breakerKey, new Error("manifest not playable"));
      providerHealth.set(provider, {
        checkedAt: new Date().toISOString(),
        status: "degraded",
        latency_ms: Date.now() - started,
        error: "manifest not playable",
      });
      return null;
    }

    providerBreakers.recordFailure(breakerKey, new Error("no usable stream"));
    providerHealth.set(provider, {
      checkedAt: new Date().toISOString(),
      status: "degraded",
      latency_ms: latency,
      error: "no usable stream",
    });
    return null;
  } catch (error) {
    providerBreakers.recordFailure(breakerKey, error);
    providerHealth.set(provider, {
      checkedAt: new Date().toISOString(),
      status: "offline",
      latency_ms: Date.now() - started,
      error: String((error && error.message) || error).slice(0, 160),
    });
    return null;
  }
}

async function raceFirstProvider(providers, assetInfo, tmdbMeta) {
  if (providers.length === 0) return null;
  const attempts = providers.map((provider) =>
    attemptProvider(provider, assetInfo, tmdbMeta).then((result) => {
      if (!result) throw new Error("provider miss");
      return { provider, result };
    })
  );
  try {
    return await Promise.any(attempts);
  } catch (e) {
    return null;
  }
}

async function resolveUpstreamSource(assetInfo, requestedProvider, options = {}) {
  const requested = requestedProvider ? normalizeProvider(requestedProvider) : "";
  const baseCacheKey = `${assetInfo.type}:${assetInfo.id}:${assetInfo.season || 0}:${assetInfo.episode || 0}`;
  const cacheKey = `${baseCacheKey}:${requested || "auto"}`;

  if (!options.forceRefresh) {
    const cached = sourceStaleCache.get(cacheKey);
    if (cached && cached.fresh) {
      return cloneValue(cached.value);
    }
    if (cached && cached.stale) {
      const refresh = resolveUpstreamSource(assetInfo, requestedProvider, {
        forceRefresh: true,
        waitUntil: null,
      })
        .then((value) => {
          if (value && value.streamUrl) {
            sourceStaleCache.set(cacheKey, cloneValue(value), 15 * 60 * 1000, 6 * 60 * 60 * 1000);
          }
          return value;
        })
        .catch(() => null);
      if (typeof options.waitUntil === "function") options.waitUntil(refresh);
      return cloneValue(cached.value);
    }
  }

  return coalesceSource(cacheKey, async () => {
    const result = createBaseResult(assetInfo, requested);

    const tmdbMeta = await fetchTMDBMetadata(
      assetInfo.type,
      assetInfo.id,
      assetInfo.season || 1,
      assetInfo.episode || 1
    );
    if (tmdbMeta) {
      result.title = tmdbMeta.title;
      result.year = tmdbMeta.year;
      result.rating = tmdbMeta.rating;
      result.genres = tmdbMeta.genres;
      result.overview = tmdbMeta.overview;
      result.backdropUrl = tmdbMeta.backdropUrl;
      result.posterUrl = tmdbMeta.posterUrl;
      result.logoUrl = tmdbMeta.logoUrl || "";
    }

    const order = getProviderOrder(requested);
    let chosen = null;

    if (requested) {
      const providerResult = await attemptProvider(requested, assetInfo, tmdbMeta, options.env);
      if (providerResult) chosen = { provider: requested, result: providerResult };
    } else {
      // Attempt providers sequentially according to configured priority order
      for (const provider of order) {
        const providerResult = await attemptProvider(provider, assetInfo, tmdbMeta, options.env);
        if (providerResult && providerResult.streamUrl && isStreamUrlUsable(providerResult.streamUrl)) {
          chosen = { provider, result: providerResult };
          break;
        }
      }
    }

    if (chosen && chosen.result) {
      applyResolvedProvider(result, chosen.result);
      if (result.streamUrl && isStreamUrlUsable(result.streamUrl)) {
        sourceStaleCache.set(cacheKey, cloneValue(result), 15 * 60 * 1000, 6 * 60 * 60 * 1000);
        cacheResolvedResult(cacheKey, baseCacheKey, result);
        return result;
      }
    }

    // Every live resolver failed: serve the last known-good source when usable.
    const lastGood = lastGoodSourceCache.get(baseCacheKey) || lastGoodSourceCache.get(cacheKey);
    if (
      lastGood &&
      Date.now() < lastGood.expiresAt &&
      lastGood.data &&
      isStreamUrlUsable(lastGood.data.streamUrl)
    ) {
      const merged = cloneValue(lastGood.data);
      if (result.title) merged.title = result.title;
      if (result.year) merged.year = result.year;
      if (result.rating) merged.rating = result.rating;
      if (result.genres) merged.genres = result.genres;
      if (result.overview) merged.overview = result.overview;
      if (result.backdropUrl) merged.backdropUrl = result.backdropUrl;
      if (result.posterUrl) merged.posterUrl = result.posterUrl;
      if (result.logoUrl) merged.logoUrl = result.logoUrl;
      return merged;
    }

    return result;
  });
}

/**
 * Last-resort provider walk used when a cached/last-good stream's manifest
 * stops working. Skips the provider that just failed and validates each
 * candidate before returning it.
 */
async function resolveFallbackSource(assetInfo, excludeProvider, env = null) {
  const exclude = normalizeProvider(excludeProvider || "");
  for (const provider of getProviderOrder()) {
    if (provider === exclude) continue;
    const result = await attemptProvider(provider, assetInfo, null, env);
    if (result && result.streamUrl && isStreamUrlUsable(result.streamUrl)) {
      return result;
    }
  }
  return null;
}

/**
 * Spoofs upstream security headers based on provider and target domain
 * HOSTNAME ALWAYS TAKES PRECEDENCE OVER PROVIDER PARAMETER
 */
function getUpstreamHeaders(provider, targetUrl, incomingHeaders) {
  let origin = "https://embed.vidrift.net";
  let referer = "https://embed.vidrift.net/";

  const hostname = targetUrl.hostname.toLowerCase();
  const pathname = targetUrl.pathname.toLowerCase();

  // 1. Hostname-based matching ALWAYS takes precedence over provider query param
  if (
    hostname.includes("cno.to") ||
    hostname.includes("lumenbox.top") ||
    hostname.includes("lumenbox")
  ) {
    origin = "https://cno.to";
    referer = "https://cno.to/";
  } else if (
    hostname.includes("hybrows") ||
    hostname.includes("armadilloscp") ||
    hostname.includes("vidrock")
  ) {
    origin = "https://vidrock.to";
    referer = "https://vidrock.to/";
  } else if (
    hostname.includes("animecurx") ||
    hostname.includes("vidrift") ||
    hostname.includes("reelvault") ||
    hostname.includes("hakunaymatata") ||
    hostname.includes("rousav") ||
    hostname.includes("bigbang") ||
    hostname.includes("cymru")
  ) {
    origin = "https://embed.vidrift.net";
    referer = "https://embed.vidrift.net/";
  } else if (
    hostname.includes("asianflix") ||
    hostname.includes("rumble") ||
    hostname.includes("cloudinary") ||
    hostname.includes("blogger")
  ) {
    origin = "https://asianflix.one";
    referer = "https://asianflix.one/";
  } else if (
    hostname.includes("cinejoy") ||
    hostname.includes("wing.st")
  ) {
    origin = "https://cinejoy.pk";
    referer = "https://cinejoy.pk/";
  } else if (
    hostname.includes("framextv") ||
    hostname.includes("films365") ||
    hostname.includes("dragonballzfans")
  ) {
    origin = "https://framextv.cc";
    referer = "https://framextv.cc/";
  } else if (provider === "framextv" || provider === "framex") {
    origin = "https://framextv.cc";
    referer = "https://framextv.cc/";
  } else if (provider === "asianflix" || provider === "rumble") {
    origin = "https://asianflix.one";
    referer = "https://asianflix.one/";
  } else if (provider === "orion" || provider === "evion") {
    origin = "https://embed.vidrift.net";
    referer = "https://embed.vidrift.net/";
  } else if (
    hostname.includes("2vcdn") ||
    hostname.includes("premilkyway") ||
    hostname.includes("astronomyfactsnow") ||
    hostname.includes("2embed") ||
    hostname.includes("streamsrcs") ||
    hostname.includes("tiktokcdn") ||
    provider === "2vcdn"
  ) {
    origin = "https://2vcdn.skin";
    referer = "https://2vcdn.skin/";
  } else {
    origin = targetUrl.origin;
    referer = targetUrl.origin + "/";
  }

  // Subtitle API forged referer
  if (pathname.includes("/subtitles/") || pathname.includes("/api/orion/")) {
    origin = "https://embed.vidrift.net";
    referer = `https://embed.vidrift.net/`;
  }

  const reqHeaders = new Headers();
  reqHeaders.set("Origin", origin);
  reqHeaders.set("Referer", referer);
  reqHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  reqHeaders.set("Accept", "*/*");

  if (hostname.includes("vidrift") && pathname.includes("/embed/")) {
    reqHeaders.set("Origin", "https://vidrift.net");
    reqHeaders.set("Referer", "https://vidrift.net/");
    reqHeaders.set("Sec-Fetch-Dest", "iframe");
    reqHeaders.set("Sec-Fetch-Mode", "navigate");
    reqHeaders.set("Sec-Fetch-Site", "same-site");
    reqHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }

  // Forward Range header for video seeking if present
  if (incomingHeaders) {
    const range = incomingHeaders.get ? incomingHeaders.get("Range") : incomingHeaders["range"];
    if (range) {
      reqHeaders.set("Range", range);
    }
    const swarmRelay = incomingHeaders.get
      ? incomingHeaders.get("X-VidLyte-Swarm")
      : incomingHeaders["X-VidLyte-Swarm"];
    if (swarmRelay) {
      reqHeaders.set("X-VidLyte-Swarm", swarmRelay);
    }
  }

  return reqHeaders;
}

// Runtime dynamic configuration (modifiable in real time via /admin-login-i)
const CONFIG_VERSION = 1;
const runtimeConfig = {
  config_version: CONFIG_VERSION,
  updated_at: "",
  site_config: {
    brand_name: "VidLyte",
    tagline: "High-Performance Sovereign HLS Streaming",
    hero_title: "Decentralized Video Streaming Edge",
    hero_subtitle: "Enterprise-grade embeddable video player powered by WebAssembly.",
    discord_url: "https://discord.gg/vidlyte",
    telegram_url: "https://t.me/vidlyte",
    announcement_banner: { enabled: false, message: "", link: "" },
    featured_picks: [
      { id: "1399", type: "tv", title: "Game of Thrones", year: "2011", season: 1, episode: 1 },
      { id: "550", type: "movie", title: "Fight Club", year: "1999" },
    ],
  },
  player_fleet: {
    primary_domain: "",
    fallback_domains: [],
  },
  upstreams: [
    { id: "orion", name: "Server 2 (Orion)", endpoint: "https://embed.vidrift.net", enabled: true, priority: 1, timeout_ms: 8000 },
    { id: "evion", name: "Server 4 (Evion)", endpoint: "https://img.animecurx.tech", enabled: true, priority: 2, timeout_ms: 8000 },
    { id: "framextv", name: "Server 1 (FrameX)", endpoint: "https://api.framextv.xyz", enabled: true, priority: 3, timeout_ms: 8000 },
    { id: "asianflix", name: "Server 3 (AsianFlix)", endpoint: "https://asianflix.one", enabled: true, priority: 4, timeout_ms: 8000 },
  ],
  proxy_swarm: {
    enabled: true,
    strategy: "latency",
    fallback_local: true,
    workers: [],
  },
  server_branding: {
    show_server_names: true,
    default_server: "orion",
    server_aliases: {
      framextv: "Server 1",
      orion: "Server 2",
      asianflix: "Server 3",
      evion: "Server 4",
    },
  },
  monetization: {
    popunders_enabled: false,
    smartlink_url: "",
    max_popunders_per_session: 1,
    cooldown_minutes: 15,
    trigger_event: "play_click",
    anti_adblock_enabled: true,
    anti_adblock_strict_brave: true,
    anti_adblock_message: "Ad blocker detected. Please disable your ad blocker or allow popups to continue watching.",
  },
  domain_security: {
    blacklist: [],
    whitelist: [],
    strict_mode: false,
  },
  asianflix: {
    // Optional explicit page overrides, keyed by "<type>:<id>" or
    // "<type>:<id>:<season>:<episode>". Example:
    //   { "tv:250670": "https://asianflix.one/some-title-2026/" }
    page_overrides: {},
    // Optional URL template, e.g. "https://asianflix.one/{id}/"
    page_url_template: "",
  },
};

// Immutable baseline used by exact config rollback.
const CONFIG_DEFAULTS = cloneValue(runtimeConfig);

/* ---------------------------------------------------------------------------
 * Runtime configuration persistence (optional KV binding)
 * ------------------------------------------------------------------------ */

const CONFIG_KV_KEY = "runtime_config_v1";
let runtimeConfigHydratedAt = 0;
let runtimeConfigHydrationPromise = null;

function normalizeSwarmWorkers(rawWorkers) {
  if (!Array.isArray(rawWorkers)) return [];
  const seen = new Set();
  const workers = [];
  rawWorkers.slice(0, 10).forEach((worker, index) => {
    const url = normalizeSwarmNodeUrl(worker && (worker.url || worker.endpoint || worker));
    if (!url || seen.has(url)) return;
    seen.add(url);
    workers.push({
      id: String((worker && worker.id) || `w_${index + 1}`),
      name: String((worker && worker.name) || `Node ${index + 1}`),
      url,
      enabled: !(worker && worker.enabled === false),
      latency_ms: Number(worker && worker.latency_ms) || 0,
      status: String((worker && worker.status) || "unknown"),
    });
  });
  return workers;
}

function applyRuntimeConfig(config) {
  if (!config || typeof config !== "object") return false;
  if (config.config_version !== undefined) {
    runtimeConfig.config_version = Number(config.config_version) || CONFIG_VERSION;
  }
  if (config.updated_at) runtimeConfig.updated_at = String(config.updated_at);
  for (const key of [
    "site_config",
    "player_fleet",
    "upstreams",
    "server_branding",
    "monetization",
    "domain_security",
    "asianflix",
  ]) {
    if (config[key] && typeof config[key] === "object" && !Array.isArray(config[key])) {
      runtimeConfig[key] = { ...runtimeConfig[key], ...config[key] };
    }
  }
  if (config.asianflix && typeof config.asianflix === "object") {
    if (config.asianflix.page_overrides && typeof config.asianflix.page_overrides === "object") {
      runtimeConfig.asianflix.page_overrides = {
        ...runtimeConfig.asianflix.page_overrides,
        ...config.asianflix.page_overrides,
      };
    }
    if (typeof config.asianflix.page_url_template === "string") {
      runtimeConfig.asianflix.page_url_template = config.asianflix.page_url_template;
    }
  }
  if (config.proxy_swarm && typeof config.proxy_swarm === "object") {
    const merged = {
      ...runtimeConfig.proxy_swarm,
      ...config.proxy_swarm,
    };
    if (Array.isArray(config.proxy_swarm.workers)) {
      merged.workers = normalizeSwarmWorkers(config.proxy_swarm.workers);
    } else if (!Array.isArray(merged.workers)) {
      merged.workers = [];
    }
    runtimeConfig.proxy_swarm = merged;
  }
  return true;
}

/**
 * Exact replacement used by config rollback. Resets every top-level key to the
 * shipped defaults before applying the snapshot so keys added after the
 * snapshot are removed.
 */
function replaceRuntimeConfig(config) {
  const defaults = cloneValue(CONFIG_DEFAULTS) || {};
  for (const key of Object.keys(runtimeConfig)) delete runtimeConfig[key];
  Object.assign(runtimeConfig, defaults);
  return applyRuntimeConfig(config);
}

async function ensureRuntimeConfig(env, options = {}) {
  if (!env || !env.CONFIG_KV) return false;
  const force = Boolean(options.force);
  if (!force && Date.now() - runtimeConfigHydratedAt < 60 * 1000) return true;
  if (runtimeConfigHydrationPromise) return runtimeConfigHydrationPromise;

  runtimeConfigHydrationPromise = (async () => {
    try {
      const stored = await env.CONFIG_KV.get(CONFIG_KV_KEY, { type: "json" });
      if (stored) applyRuntimeConfig(stored);
      runtimeConfigHydratedAt = Date.now();
      return true;
    } catch (e) {
      return false;
    } finally {
      runtimeConfigHydrationPromise = null;
    }
  })();

  return runtimeConfigHydrationPromise;
}

async function persistRuntimeConfig(env) {
  if (!env || !env.CONFIG_KV) return false;
  try {
    runtimeConfig.config_version = CONFIG_VERSION;
    runtimeConfig.updated_at = new Date().toISOString();
    await env.CONFIG_KV.put(CONFIG_KV_KEY, JSON.stringify(runtimeConfig));
    runtimeConfigHydratedAt = Date.now();
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Phase 5: bounded config history, rollback and diff
 * ------------------------------------------------------------------------ */

const CONFIG_HISTORY_KV_KEY = "runtime_config_history_v1";
const CONFIG_HISTORY_LIMIT = 10;
let configHistoryCache = null;
let configHistoryLoadedAt = 0;

function snapshotRuntimeConfig() {
  return cloneValue(runtimeConfig) || null;
}

async function loadConfigHistory(env, options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && configHistoryCache && now - configHistoryLoadedAt < 60 * 1000) {
    return configHistoryCache;
  }
  if (!env || !env.CONFIG_KV) {
    configHistoryCache = Array.isArray(configHistoryCache) ? configHistoryCache : [];
    configHistoryLoadedAt = now;
    return configHistoryCache;
  }
  try {
    const stored = await env.CONFIG_KV.get(CONFIG_HISTORY_KV_KEY, { type: "json" });
    configHistoryCache = Array.isArray(stored)
      ? stored
          .filter((entry) => entry && typeof entry === "object" && entry.id)
          .slice(0, CONFIG_HISTORY_LIMIT)
      : [];
  } catch (e) {
    configHistoryCache = Array.isArray(configHistoryCache) ? configHistoryCache : [];
  }
  configHistoryLoadedAt = now;
  return configHistoryCache;
}

async function recordConfigHistory(env, action, detail = {}) {
  const snapshot = snapshotRuntimeConfig();
  if (!snapshot) return null;
  const list = (await loadConfigHistory(env, { force: true })).slice();
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    action: String(action || "update").slice(0, 40),
    config_version: Number(snapshot.config_version) || CONFIG_VERSION,
    note: String(detail.note || "").slice(0, 200),
    summary: summarizeConfig(snapshot),
    config: snapshot,
  };
  list.unshift(entry);
  while (list.length > CONFIG_HISTORY_LIMIT) list.pop();
  configHistoryCache = list;
  configHistoryLoadedAt = Date.now();
  if (env && env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(CONFIG_HISTORY_KV_KEY, JSON.stringify(list));
    } catch (e) {
      // History is best-effort; never fail the config change because of it.
    }
  }
  return entry;
}

async function probeSwarmNode(worker, timeoutMs = 2500) {
  const origin = normalizeSwarmNodeUrl(worker && (worker.url || worker));
  if (!origin) {
    return { id: worker && worker.id, name: worker && worker.name, url: worker && worker.url, status: "invalid", latency_ms: -1 };
  }

  const started = Date.now();
  try {
    const response = await fetch(`${origin}/ping`, {
      method: "GET",
      headers: { "User-Agent": "VidLyte-Swarm-Probe/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - started;
    try {
      await response.arrayBuffer();
    } catch (e) {}
    if (response.ok) {
      swarmState.set(origin, { latencyMs: latency, failures: 0, blockedUntil: 0 });
    } else {
      const previous = swarmState.get(origin) || { latencyMs: 0, failures: 0 };
      const failures = (previous.failures || 0) + 1;
      swarmState.set(origin, {
        latencyMs: previous.latencyMs || 0,
        failures,
        blockedUntil: failures >= 3 ? Date.now() + 60_000 : 0,
      });
    }
    return {
      id: worker.id,
      name: worker.name,
      url: origin,
      status: response.ok ? "healthy" : "failing",
      latency_ms: response.ok ? latency : -1,
    };
  } catch (e) {
    const previous = swarmState.get(origin) || { latencyMs: 0, failures: 0 };
    const failures = (previous.failures || 0) + 1;
    swarmState.set(origin, {
      latencyMs: previous.latencyMs || 0,
      failures,
      blockedUntil: failures >= 3 ? Date.now() + 60_000 : 0,
    });
    return { id: worker.id, name: worker.name, url: origin, status: "offline", latency_ms: -1 };
  }
}

function collectSwarmNodes(env) {
  const nodes = [];
  const seen = new Set();
  const push = (raw) => {
    const url = normalizeSwarmNodeUrl(raw && (raw.url || raw));
    if (!url || seen.has(url)) return;
    seen.add(url);
    nodes.push(url);
  };

  String((env && env.SWARM_NODES) || "")
    .split(",")
    .forEach(push);

  if (runtimeConfig.proxy_swarm && runtimeConfig.proxy_swarm.enabled !== false) {
    (runtimeConfig.proxy_swarm.workers || []).forEach((worker) => {
      if (worker.enabled !== false) push(worker);
    });
  }

  return nodes.slice(0, 10);
}

function orderSwarmNodes(nodes) {
  const strategy = (runtimeConfig.proxy_swarm && runtimeConfig.proxy_swarm.strategy) || "latency";
  if (strategy === "random") {
    return [...nodes].sort(() => Math.random() - 0.5);
  }
  if (strategy === "round_robin" && nodes.length > 0) {
    const start = swarmRoundRobinIndex % nodes.length;
    swarmRoundRobinIndex = (swarmRoundRobinIndex + 1) % nodes.length;
    return [...nodes.slice(start), ...nodes.slice(0, start)];
  }

  const now = Date.now();
  const score = (node) => {
    const state = swarmState.get(node);
    if (!state) return 0;
    const cooldownPenalty = state.blockedUntil && state.blockedUntil > now ? 100000 : 0;
    return cooldownPenalty + (state.latencyMs || 0) + (state.failures || 0) * 500;
  };
  return [...nodes].sort((a, b) => score(a) - score(b));
}


// In-memory telemetry & embedding domain tracking
const domainTelemetry = new Map();
const metricsData = {
  totalRequests: 0,
  activeRequests: 0,
  bytesStreamed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  status2xx: 0,
  status4xx: 0,
  status5xx: 0,
  rateLimitRejections: 0,
};

// Phase 6: privacy-preserving engagement counters. Events are allowlisted and
// asset keys are bounded so a hostile client cannot grow isolate memory.
const ENGAGEMENT_EVENTS = new Set([
  "play",
  "resume",
  "complete",
  "share",
  "subtitle_change",
]);
const engagementCounters = {
  play: 0,
  resume: 0,
  complete: 0,
  share: 0,
  subtitle_change: 0,
  total: 0,
  updated_at: "",
};
const engagementAssets = new Map(); // asset key -> count (bounded)

function recordEngagement(eventName, assetId) {
  if (!ENGAGEMENT_EVENTS.has(eventName)) return false;
  engagementCounters[eventName] = (engagementCounters[eventName] || 0) + 1;
  engagementCounters.total++;
  engagementCounters.updated_at = new Date().toISOString();
  const key = String(assetId || "unknown").slice(0, 80);
  engagementAssets.set(key, (engagementAssets.get(key) || 0) + 1);
  if (engagementAssets.size > 500) {
    const oldest = engagementAssets.keys().next().value;
    if (oldest !== undefined) engagementAssets.delete(oldest);
  }
  return true;
}

function engagementSnapshot() {
  const topAssets = Array.from(engagementAssets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([asset, count]) => ({ asset, count }));
  return {
    counters: { ...engagementCounters },
    top_assets: topAssets,
    tracked_assets: engagementAssets.size,
  };
}

// Phase 3: structured, bounded observability. Per-isolate only.
const metricsRegistry = new MetricsRegistry({ maxRoutes: 48, minuteBuckets: 15 });
const requestLog = new BoundedLog({ capacity: 120 });
const auditLog = new BoundedLog({ capacity: 120 });
let rateLimiterSet = null;
let rateLimiterSignature = "";

function getRateLimiters(env) {
  const config = parseRateLimitConfig(env || {});
  const signature = [
    config.enabled,
    config.windowMs,
    config.general,
    config.api,
    config.media,
    config.admin,
    config.maxKeys,
  ].join(":");
  if (!rateLimiterSet || signature !== rateLimiterSignature) {
    rateLimiterSet = new RateLimiterSet(config);
    rateLimiterSignature = signature;
  }
  return rateLimiterSet;
}

function recordAudit(action, request, detail = {}) {
  return auditLog.push({
    action: String(action || "unknown").slice(0, 80),
    actor_ip: maskIp(extractClientIP(request)),
    path: String((request && request.url ? new URL(request.url).pathname : "") || "").slice(0, 160),
    ...detail,
  });
}

function recordRequestMetric({ request, response, startedAt, requestId, route, extra = {} }) {
  const durationMs = Math.max(0, Date.now() - startedAt);
  const status = response ? response.status : 500;
  let bytes = 0;
  try {
    const length = response && response.headers ? response.headers.get("Content-Length") : null;
    if (length) bytes = parseInt(length, 10) || 0;
  } catch (e) {}

  metricsRegistry.record({
    route,
    method: request ? request.method : "GET",
    status,
    durationMs,
    bytes,
    requestId,
    cache: extra.cache || "",
  });

  // Mirror into the legacy counters still exposed by /metrics.
  metricsData.totalRequests++;
  metricsData.bytesStreamed += bytes;
  if (status >= 200 && status < 300) metricsData.status2xx++;
  else if (status >= 400 && status < 500) metricsData.status4xx++;
  else if (status >= 500) metricsData.status5xx++;

  const shouldLog = route !== "media" || status >= 400;
  if (shouldLog) {
    let pathname = "";
    try {
      pathname = new URL(request.url).pathname;
    } catch (e) {}
    requestLog.push({
      request_id: requestId,
      method: request ? request.method : "GET",
      path: pathname.slice(0, 160),
      route,
      status,
      ms: durationMs,
      bytes,
      ip: maskIp(extractClientIP(request)),
      colo: request && request.cf ? request.cf.colo || "" : "",
      country: request && request.cf ? request.cf.country || "" : "",
      cache: extra.cache || "",
    });
  }

  return { durationMs, bytes, status };
}

// Admin authentication rate limiter & session state
const failedLogins = new Map(); // IP -> { attempts: count, lockedUntil: timestamp }
const activeAdminSessions = new Map(); // session token -> expiry timestamp

function recordDomainImpression(request, assetID) {
  metricsData.totalRequests++;
  const rawRef = request.headers.get("Referer") || request.headers.get("Origin") || "direct_embed";
  let host = "direct";
  try {
    if (rawRef.startsWith("http")) {
      host = new URL(rawRef).hostname.toLowerCase();
    } else {
      host = rawRef.toLowerCase();
    }
  } catch (e) {
    host = rawRef.slice(0, 50);
  }

  const existing = domainTelemetry.get(host) || {
    domain: host,
    impressions: 0,
    chunks: 0,
    bytes: 0,
    lastSeen: new Date().toISOString(),
    blocked: runtimeConfig.domain_security.blacklist.includes(host),
  };
  existing.impressions++;
  existing.lastSeen = new Date().toISOString();
  domainTelemetry.set(host, existing);
  return { host, blocked: existing.blocked };
}

function getAdminSecret(env) {
  return env && env.ADMIN_SECRET ? String(env.ADMIN_SECRET) : "";
}

function getAdminSessionTtlSec(env) {
  const raw = parseInt(env && env.ADMIN_SESSION_TTL_SEC, 10);
  if (!Number.isFinite(raw) || raw < 300) return 12 * 60 * 60;
  return Math.min(raw, 7 * 24 * 60 * 60);
}

function getAdminSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/vidlyte_admin_session=([^;]+)/);
  return match ? match[1] : "";
}

function pruneAdminSessions(now = Date.now()) {
  if (activeAdminSessions.size < 64) return;
  for (const [token, expiresAt] of activeAdminSessions) {
    if (!expiresAt || expiresAt <= now) activeAdminSessions.delete(token);
  }
}

function checkAdminAuth(request, env) {
  const adminSecret = getAdminSecret(env);
  if (!adminSecret) return false; // fail closed when no secret is configured

  const token = getAdminSessionToken(request);
  if (!token) return false;

  const now = Date.now();
  const expiresAt = activeAdminSessions.get(token);
  if (expiresAt && expiresAt > now) return true;
  if (expiresAt) activeAdminSessions.delete(token);

  return verifyAdminSession(
    token,
    adminSecret,
    extractClientIP(request),
    now,
    getAdminSessionTtlSec(env)
  );
}

function checkAdminCsrf(request, env) {
  const adminSecret = getAdminSecret(env);
  if (!adminSecret) return false;
  const token = getAdminSessionToken(request);
  if (!token) return false;
  const supplied = request.headers.get("X-CSRF-Token") || "";
  if (!supplied) return false;
  const expected = deriveAdminCsrf(adminSecret, token);
  return constantTimeEqual(supplied, expected);
}

/* ---------------------------------------------------------------------------
 * Provider health, deep readiness and scheduled maintenance
 * ------------------------------------------------------------------------ */

const PROVIDER_HEALTH_KV_KEY = "provider_health_v1";

function providerEnabled(providerId) {
  const id = normalizeProvider(providerId);
  const entry = (runtimeConfig.upstreams || []).find((upstream) => normalizeProvider(upstream && upstream.id) === id);
  if (!entry) return true;
  return entry.enabled !== false;
}

function snapshotProviderHealth() {
  const breakers = providerBreakers.snapshot();
  return defaultProviderOrder().map((id) => {
    const health = providerHealth.get(id) || null;
    const breaker = breakers[`provider:${id}`] || null;
    return {
      id,
      label: providerLabel(id),
      enabled: providerEnabled(id),
      status: health ? health.status : breaker && breaker.open ? "offline" : "unknown",
      checked_at: health ? health.checkedAt : "",
      latency_ms: health ? health.latency_ms : breaker ? breaker.last_latency_ms : 0,
      error: health ? health.error : breaker ? breaker.last_error : "",
      breaker: breaker || null,
    };
  });
}

async function loadPersistedProviderHealth(env) {
  if (!env || !env.CONFIG_KV) return;
  try {
    const stored = await env.CONFIG_KV.get(PROVIDER_HEALTH_KV_KEY, { type: "json" });
    if (!stored || typeof stored !== "object") return;
    for (const [id, value] of Object.entries(stored)) {
      if (!value || typeof value !== "object") continue;
      if (!providerHealth.has(id)) {
        providerHealth.set(id, {
          checkedAt: String(value.checked_at || value.checkedAt || ""),
          status: String(value.status || "unknown"),
          latency_ms: Number(value.latency_ms) || 0,
          error: String(value.error || ""),
        });
      }
    }
  } catch (e) {}
}

async function persistProviderHealth(env) {
  if (!env || !env.CONFIG_KV) return false;
  try {
    const snapshot = {};
    for (const [id, value] of providerHealth) {
      snapshot[id] = {
        status: value.status,
        checked_at: value.checkedAt,
        latency_ms: value.latency_ms,
        error: value.error,
      };
    }
    await env.CONFIG_KV.put(PROVIDER_HEALTH_KV_KEY, JSON.stringify(snapshot));
    return true;
  } catch (e) {
    return false;
  }
}

async function probeProviderReachability(providerId) {
  const id = normalizeProvider(providerId);
  const endpoints = {
    orion: "https://embed.vidrift.net/",
    evion: "https://img.animecurx.tech/",
    framextv: "https://api.framextv.xyz/",
    asianflix: "https://asianflix.one/",
    "2vcdn": "https://2vcdn.skin/",
  };
  const endpoint = endpoints[id];
  if (!endpoint) {
    const record = { checkedAt: new Date().toISOString(), status: "unknown", latency_ms: 0, error: "no probe endpoint" };
    providerHealth.set(id, record);
    return { id, label: providerLabel(id), ...record };
  }

  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - started;
    try {
      await response.arrayBuffer();
    } catch (e) {}
    const healthy = response.status > 0 && response.status < 500;
    const record = {
      checkedAt: new Date().toISOString(),
      status: healthy ? "healthy" : "degraded",
      latency_ms: latency,
      error: healthy ? "" : `http_${response.status}`,
    };
    providerHealth.set(id, record);
    if (healthy) providerBreakers.recordSuccess(`provider:${id}`, latency);
    else providerBreakers.recordFailure(`provider:${id}`, new Error(`http_${response.status}`));
    return { id, label: providerLabel(id), ...record };
  } catch (error) {
    const latency = Date.now() - started;
    const record = {
      checkedAt: new Date().toISOString(),
      status: "offline",
      latency_ms: latency,
      error: String((error && error.message) || error).slice(0, 160),
    };
    providerHealth.set(id, record);
    providerBreakers.recordFailure(`provider:${id}`, error);
    return { id, label: providerLabel(id), ...record };
  }
}

let lastAlertSignature = "";
let lastAlertAt = 0;

const TELEGRAM_STATE_KV_KEY = "telegram_alert_state_v1";
const telegramStateMemory = new Map();
const ALERT_SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function envInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (Number.isFinite(min) && parsed < min) return min;
  if (Number.isFinite(max) && parsed > max) return max;
  return parsed;
}

function normalizeAlertSeverity(value, fallback = "warning") {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALERT_SEVERITY_RANK, normalized) ? normalized : fallback;
}

function getTelegramConfig(env) {
  const token = env && env.TELEGRAM_BOT_TOKEN ? String(env.TELEGRAM_BOT_TOKEN).trim() : "";
  const chatId = env && env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID).trim() : "";
  return {
    token,
    chatId,
    configured: Boolean(token && chatId),
    enabled: envFlag(env && env.TELEGRAM_ALERTS_ENABLED, true) && Boolean(token && chatId),
    minSeverity: normalizeAlertSeverity(env && env.ALERT_MIN_SEVERITY, "warning"),
    cooldownMs: envInt(env && env.ALERT_COOLDOWN_MIN, 15, 0, 1440) * 60 * 1000,
  };
}

function escapeTelegramHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramMessage({ title, type = "open", severity = "warning", lines = [] }) {
  const recovery = type === "recovery";
  const icon = recovery ? "✅" : severity === "critical" ? "🚨" : "⚠️";
  const heading = recovery ? "RECOVERED" : "INCIDENT";
  const body = (Array.isArray(lines) ? lines : [])
    .filter(Boolean)
    .map((line) => `• ${escapeTelegramHtml(line)}`)
    .join("\n");
  return [
    `${icon} <b>${escapeTelegramHtml(title || "VidLyte alert")}</b>`,
    `<b>${heading}</b> · ${escapeTelegramHtml(severity)}`,
    body,
    `<i>${escapeTelegramHtml(new Date().toISOString())}</i>`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 3900);
}

async function readTelegramState(env) {
  const state = {};
  if (env && env.CONFIG_KV) {
    try {
      const raw = await env.CONFIG_KV.get(TELEGRAM_STATE_KV_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          Object.entries(parsed).forEach(([key, value]) => {
            if (value && typeof value === "object") state[key] = value;
          });
          return state;
        }
      }
    } catch (e) {}
  }
  for (const [key, value] of telegramStateMemory) {
    if (value && typeof value === "object") state[key] = value;
  }
  return state;
}

async function writeTelegramState(env, state) {
  const keys = Object.keys(state);
  if (keys.length > 40) {
    keys
      .sort((a, b) => Number(state[a].last_sent_at || 0) - Number(state[b].last_sent_at || 0))
      .slice(0, keys.length - 40)
      .forEach((key) => delete state[key]);
  }
  telegramStateMemory.clear();
  Object.entries(state).forEach(([key, value]) => telegramStateMemory.set(key, value));
  if (env && env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(TELEGRAM_STATE_KV_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * Sends an incident/recovery notification to Telegram when configured.
 * De-duplicates identical open incidents with a KV-backed cooldown, filters by
 * minimum severity, and never throws into the request path.
 */
async function sendTelegramAlert(env, options = {}) {
  const config = getTelegramConfig(env);
  const severity = normalizeAlertSeverity(options.severity, "warning");
  const type = options.type === "recovery" ? "recovery" : "open";
  const key = String(options.key || "watchdog").slice(0, 80);
  const signature = String(options.signature || options.text || "").slice(0, 400);
  const force = Boolean(options.force);
  const result = {
    configured: config.configured,
    enabled: config.enabled,
    sent: false,
    skipped: "",
    severity,
    type,
  };

  if (!config.configured) {
    result.skipped = "telegram_not_configured";
    return result;
  }
  if (!config.enabled && !force) {
    result.skipped = "telegram_disabled";
    return result;
  }
  if (!force && ALERT_SEVERITY_RANK[severity] < ALERT_SEVERITY_RANK[config.minSeverity]) {
    result.skipped = "below_min_severity";
    return result;
  }

  const now = Date.now();
  const state = await readTelegramState(env);
  const previous = state[key] || {};
  if (!force) {
    if (
      type === "open" &&
      previous.last_type === "open" &&
      previous.signature === signature &&
      now - Number(previous.last_sent_at || 0) < config.cooldownMs
    ) {
      result.skipped = "cooldown";
      return result;
    }
    if (type === "recovery" && previous.last_type !== "open") {
      result.skipped = "no_open_incident";
      return result;
    }
  }

  const text = options.text || formatTelegramMessage({
    title: options.title || "VidLyte alert",
    type,
    severity,
    lines: options.lines || [],
  });

  try {
    const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: options.silent === true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true) {
      result.error = `telegram_http_${response.status}`;
      return result;
    }
  } catch (error) {
    result.error = String((error && error.message) || error).slice(0, 160);
    return result;
  }

  result.sent = true;
  state[key] = {
    last_sent_at: now,
    last_type: type,
    signature,
    severity,
  };
  await writeTelegramState(env, state);
  return result;
}

/**
 * Optional scheduled-maintenance alerting. Posts to ALERT_WEBHOOK_URL (Slack,
 * Discord, or any JSON endpoint) and/or Telegram when a node/provider is
 * unhealthy, de-duplicates identical incident sets for 30 minutes, and emits a
 * recovery message when the incident clears.
 */
async function maybeSendAlert(env, summary) {
  const webhook = env && env.ALERT_WEBHOOK_URL ? String(env.ALERT_WEBHOOK_URL).trim() : "";
  const badSwarm = (summary.swarm || []).filter(
    (worker) => worker && worker.status && worker.status !== "healthy"
  );
  const badProviders = (summary.providers || []).filter(
    (provider) =>
      provider && provider.status && provider.status !== "healthy" && provider.status !== "unknown"
  );
  const canary = summary.canary || null;
  const canaryFailed = Boolean(canary && canary.ok !== true);
  const incident = badSwarm.length > 0 || badProviders.length > 0 || canaryFailed;
  const signature = incident
    ? JSON.stringify({
        swarm: badSwarm.map((worker) => `${worker.id}:${worker.status}`).sort(),
        providers: badProviders.map((provider) => `${provider.id}:${provider.status}`).sort(),
        canary: canaryFailed ? `${canary.provider || "canary"}:${canary.error || "failed"}` : "",
      })
    : "healthy";
  const now = Date.now();
  let webhookSent = false;

  if (incident && webhook) {
    if (!(signature === lastAlertSignature && now - lastAlertAt < 30 * 60 * 1000)) {
      lastAlertSignature = signature;
      lastAlertAt = now;
      const text = [
        "VidLyte edge alert",
        badSwarm.length ? `swarm: ${badSwarm.map((w) => `${w.id}=${w.status}`).join(", ")}` : "",
        badProviders.length
          ? `providers: ${badProviders.map((p) => `${p.id}=${p.status}`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" | ");
      try {
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, summary }),
          signal: AbortSignal.timeout(5000),
        });
        webhookSent = Boolean(response && response.ok);
      } catch (e) {}
    }
  }

  const severity =
    canaryFailed ||
    badSwarm.some((worker) => worker.status === "offline") ||
    badProviders.some((provider) => provider.status === "offline")
      ? "critical"
      : "warning";
  const lines = incident
    ? [
        badSwarm.length
          ? `Swarm: ${badSwarm.map((w) => `${w.id}=${w.status}`).join(", ")}`
          : "",
        badProviders.length
          ? `Providers: ${badProviders.map((p) => `${p.id}=${p.status}`).join(", ")}`
          : "",
        canary
          ? `Canary: ${canary.ok ? "ok" : "failed"} (${canary.error || canary.provider || "n/a"})`
          : "",
        `Window: ${summary.trigger || "manual"}`,
      ]
    : ["Scheduled maintenance is healthy again.", canary ? `Canary: ${canary.ok ? "ok" : "failed"}` : ""];

  let telegram = { sent: false, skipped: "not_attempted" };
  try {
    telegram = await sendTelegramAlert(env, {
      key: "scheduled-maintenance",
      type: incident ? "open" : "recovery",
      severity: incident ? severity : "info",
      signature,
      text: formatTelegramMessage({
        title: incident ? "VidLyte scheduled check failed" : "VidLyte scheduled check recovered",
        type: incident ? "open" : "recovery",
        severity: incident ? severity : "info",
        lines,
      }),
    });
  } catch (e) {}

  summary.alert_detail = { webhook: webhookSent, telegram };
  return Boolean(webhookSent || (telegram && telegram.sent));
}

const WATCHDOG_CANARY_KV_KEY = "watchdog_canary_v1";
const DEFAULT_CANARY_FALLBACK_ASSETS = ["movie/550"];

function parseCanaryAsset(value) {
  const parts = String(value || "").replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] === "movie" && /^\d{1,9}$/.test(parts[1] || "")) {
    return { type: "movie", id: parts[1], season: 0, episode: 0 };
  }
  if (
    parts[0] === "tv" &&
    /^\d{1,9}$/.test(parts[1] || "") &&
    Number(parts[2]) > 0 &&
    Number(parts[3]) > 0
  ) {
    return {
      type: "tv",
      id: parts[1],
      season: parseInt(parts[2], 10) || 1,
      episode: parseInt(parts[3], 10) || 1,
    };
  }
  return null;
}

function getCanaryAsset(env) {
  return parseCanaryAsset(env && env.WATCHDOG_CANARY_ASSET) || {
    type: "tv",
    id: "66732",
    season: 1,
    episode: 1,
  };
}

function getCanaryFallbackAssets(env) {
  const configured = env && env.WATCHDOG_CANARY_FALLBACK_ASSETS;
  const source = configured ? String(configured) : DEFAULT_CANARY_FALLBACK_ASSETS.join(",");
  const assets = source
    .split(/[,\s]+/)
    .map((value) => parseCanaryAsset(value))
    .filter(Boolean)
    .slice(0, 2);
  return assets.length > 0 ? assets : DEFAULT_CANARY_FALLBACK_ASSETS.map((value) => parseCanaryAsset(value));
}

function canaryAssetLabel(asset) {
  return `${asset.type}/${asset.id}${asset.type === "tv" ? `/${asset.season}/${asset.episode}` : ""}`;
}

async function loadCanaryState(env) {
  if (!env || !env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(WATCHDOG_CANARY_KV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolves a known-good asset through a provider that the Worker can reach and
 * validates the manifest. The record is persisted in KV so readiness checks and
 * the dashboard can report a real playback signal, not just a homepage ping.
 */
async function runPlaybackCanary(env) {
  const asset = getCanaryAsset(env);
  const provider = normalizeProvider(
    (env && env.WATCHDOG_CANARY_PROVIDER) || "framextv"
  );
  const fallbackAssets = getCanaryFallbackAssets(env);
  const fallbackProviders = String(
    (env && env.WATCHDOG_CANARY_FALLBACK_PROVIDERS) || "2vcdn"
  )
    .split(/[,\s]+/)
    .map((value) => normalizeProvider(value))
    .filter((value) => value && value !== provider)
    .slice(0, 2);

  // A single provider miss on a single asset must not page the owner. Try the
  // configured asset, then known-good fallback assets, then a fallback
  // provider. Only report provider_miss when every attempt returns nothing.
  const attemptsPlan = [];
  const providersToTry = [provider, ...fallbackProviders];
  for (const candidateProvider of providersToTry) {
    for (const candidateAsset of [asset, ...fallbackAssets]) {
      attemptsPlan.push({ provider: candidateProvider, asset: candidateAsset });
    }
  }

  const assetLabel = canaryAssetLabel(asset);
  const started = Date.now();
  const record = {
    ok: false,
    checked_at: new Date().toISOString(),
    latency_ms: 0,
    asset: assetLabel,
    provider,
    audio_tracks: 0,
    error: "",
    attempts: [],
  };

  let sawException = false;
  for (const attempt of attemptsPlan.slice(0, 6)) {
    const attemptStarted = Date.now();
    const entry = {
      provider: attempt.provider,
      asset: canaryAssetLabel(attempt.asset),
      ok: false,
      latency_ms: 0,
      error: "",
    };
    try {
      const result = await attemptProvider(attempt.provider, attempt.asset, null, env);
      if (result && result.streamUrl && isStreamUrlUsable(result.streamUrl)) {
        entry.ok = true;
        entry.latency_ms = Date.now() - attemptStarted;
        record.ok = true;
        record.asset = canaryAssetLabel(attempt.asset);
        record.provider = result.provider || attempt.provider;
        record.audio_tracks = Array.isArray(result.audioTracks) ? result.audioTracks.length : 0;
        record.error = "";
        record.attempts.push(entry);
        break;
      }
      entry.error = "provider_miss";
    } catch (error) {
      sawException = true;
      entry.error = String((error && error.message) || error).slice(0, 120);
    }
    entry.latency_ms = Date.now() - attemptStarted;
    record.attempts.push(entry);
  }

  if (!record.ok) {
    record.error = sawException ? "provider_error" : "provider_miss";
  }

  record.latency_ms = Date.now() - started;
  if (env && env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(WATCHDOG_CANARY_KV_KEY, JSON.stringify(record));
    } catch (e) {}
  }
  return record;
}

async function runScheduledMaintenance(env, event) {
  const startedAt = Date.now();
  const summary = {
    started_at: new Date(startedAt).toISOString(),
    trigger: event && event.cron ? event.cron : "manual",
    swarm: [],
    providers: [],
    persisted: false,
  };

  try {
    await ensureRuntimeConfig(env, { force: true });
  } catch (e) {}

  try {
    sourceStaleCache.prune();
    const now = Date.now();
    for (const [key, entry] of metadataCache) {
      if (!entry || now >= entry.expiresAt) metadataCache.delete(key);
    }
    for (const [key, entry] of rawManifestCache) {
      if (!entry || now >= entry.expiresAt) rawManifestCache.delete(key);
    }
    for (const [key, entry] of lastGoodSourceCache) {
      if (!entry || now >= entry.expiresAt) lastGoodSourceCache.delete(key);
    }
  } catch (e) {}

  try {
    const workers = normalizeSwarmWorkers(runtimeConfig.proxy_swarm.workers || []);
    const results = await Promise.all(workers.map((worker) => probeSwarmNode(worker).catch(() => null)));
    summary.swarm = results.filter(Boolean);
    runtimeConfig.proxy_swarm.workers = workers.map((worker) => {
      const probed = summary.swarm.find((item) => item.id === worker.id);
      return probed
        ? { ...worker, url: probed.url || worker.url, status: probed.status, latency_ms: probed.latency_ms }
        : worker;
    });
    runtimeConfig.proxy_swarm.last_probe_at = new Date().toISOString();
  } catch (e) {
    summary.swarm_error = String((e && e.message) || e);
  }

  try {
    const providerIds = defaultProviderOrder();
    summary.providers = await Promise.all(providerIds.map((id) => probeProviderReachability(id).catch(() => null)));
    summary.providers = summary.providers.filter(Boolean);
  } catch (e) {
    summary.providers_error = String((e && e.message) || e);
  }

  if (envFlag(env && env.WATCHDOG_CANARY_ENABLED, true)) {
    try {
      summary.canary = await runPlaybackCanary(env);
    } catch (e) {
      summary.canary = {
        ok: false,
        checked_at: new Date().toISOString(),
        latency_ms: 0,
        asset: "",
        provider: "",
        audio_tracks: 0,
        error: String((e && e.message) || e).slice(0, 160),
      };
    }
  }

  // Refresh the external ops snapshots so readiness can report the quota level
  // even when nobody has the admin dashboard open. Three small public files.
  try {
    const ops = await loadOpsStatus(env);
    summary.ops = ops.sources;
  } catch (e) {
    summary.ops_error = String((e && e.message) || e).slice(0, 120);
  }

  try {
    summary.persisted = await persistRuntimeConfig(env);
    await persistProviderHealth(env);
  } catch (e) {}

  summary.duration_ms = Date.now() - startedAt;
  try {
    summary.alert_sent = await maybeSendAlert(env, summary);
  } catch (e) {
    summary.alert_sent = false;
  }
  return summary;
}

function buildDeepHealthPayload(request, env) {
  const secretSpec = parseSecretKeys(env && env.HMAC_SECRET);
  const usingDefaultSecret =
    !env || !env.HMAC_SECRET || secretSpec.primarySecret === DEFAULT_HMAC_SECRET;
  const adminConfigured = Boolean(getAdminSecret(env));
  const ready = !usingDefaultSecret && adminConfigured;
  const swarmNodes = collectSwarmNodes(env);
  return {
    status: ready ? "healthy" : "degraded",
    ready,
    service: "vidlyte-edge-proxy",
    engine: "Native Edge Crypto Engine (Go WASM parity core available)",
    timestamp: Date.now(),
    colo: request.cf ? request.cf.colo : "LOCAL_EDGE",
    country: request.cf ? request.cf.country : "N/A",
    checks: {
      hmac_secret: usingDefaultSecret ? "default" : "configured",
      admin_secret: adminConfigured ? "configured" : "missing",
      config_kv: env && env.CONFIG_KV ? "bound" : "memory_only",
      config_version: runtimeConfig.config_version || CONFIG_VERSION,
      config_updated_at: runtimeConfig.updated_at || "",
      bind_client_ip: env && (env.BIND_CLIENT_IP === "true" || env.BIND_CLIENT_IP === "1"),
      upstream_allowlist_extra: env && env.UPSTREAM_ALLOWLIST ? "configured" : "none",
    },
    swarm: {
      total: swarmNodes.length,
      workers: (runtimeConfig.proxy_swarm.workers || []).map((worker) => ({
        id: worker.id,
        name: worker.name,
        status: worker.status,
        latency_ms: worker.latency_ms,
      })),
      last_probe_at: runtimeConfig.proxy_swarm.last_probe_at || "",
    },
    providers: snapshotProviderHealth(),
    breakers: {
      providers: providerBreakers.snapshot(),
      hosts: hostBreakers.snapshot(),
    },
    caches: {
      sources: sourceStaleCache.size,
      metadata: metadataCache.size,
      manifests: rawManifestCache.size,
      last_good: lastGoodSourceCache.size,
    },
  };
}

/**
 * Strict readiness for the external watchdog. Liveness (/health) intentionally
 * stays trivial; this endpoint fails closed on missing secrets, missing KV,
 * unhydrated config and a failed/stale playback canary.
 */
async function buildReadinessPayload(request, env, canary = undefined) {
  const checks = {};
  const reasons = [];
  const add = (name, ok, detail, fatal = true) => {
    checks[name] = { ok: Boolean(ok), fatal: Boolean(fatal), detail: String(detail || "") };
    if (!ok && fatal) reasons.push(`${name}:${detail}`);
  };

  const secretSpec = parseSecretKeys(env && env.HMAC_SECRET);
  const usingDefaultSecret = !env || !env.HMAC_SECRET || secretSpec.primarySecret === DEFAULT_HMAC_SECRET;
  add("hmac_secret", !usingDefaultSecret, usingDefaultSecret ? "missing_or_default" : "configured");
  add("admin_secret", Boolean(getAdminSecret(env)), getAdminSecret(env) ? "configured" : "missing");
  add("config_kv", Boolean(env && env.CONFIG_KV), env && env.CONFIG_KV ? "bound" : "missing");

  if (env && env.CONFIG_KV) {
    try {
      await ensureRuntimeConfig(env);
      await loadPersistedProviderHealth(env);
    } catch (e) {}
  }
  add(
    "runtime_config",
    Boolean(runtimeConfig.config_version),
    runtimeConfig.config_version || "not_loaded"
  );

  const providers = snapshotProviderHealth().filter((provider) => provider.enabled !== false);
  const healthyProviders = providers.filter((provider) => provider.status === "healthy");
  const allUnknown = providers.length > 0 && providers.every((provider) => provider.status === "unknown");
  add(
    "providers",
    healthyProviders.length > 0 || allUnknown,
    `${healthyProviders.length}/${providers.length} healthy`,
    false
  );

  // Quota is reported by the external hourly guard. Only the KV snapshot is
  // read here (no network call) so readiness stays fast. Critical quota is a
  // warning, not a readiness failure: at 100% Cloudflare throttles before the
  // Worker can answer, and the watchdog reports that separately.
  const cachedOps = await readCachedOpsStatus(env);
  const quotaSnapshot = cachedOps && cachedOps.quota && cachedOps.quota.available !== false ? cachedOps.quota : null;
  const quotaLevel = quotaSnapshot ? normalizeOpsLevel(quotaSnapshot.level, quotaSnapshot.percent) : "unknown";
  add(
    "quota_budget",
    quotaLevel !== "critical",
    quotaLevel === "unknown" ? "unknown" : `${quotaLevel}:${quotaSnapshot.percent}%`,
    false
  );

  if (canary === undefined) canary = await loadCanaryState(env);
  const requireCanary = envFlag(env && env.WATCHDOG_REQUIRE_CANARY, false);
  const maxAgeSec = envInt(env && env.WATCHDOG_CANARY_MAX_AGE_SEC, 1800, 60, 604800);
  let canaryOk = !requireCanary;
  let canaryDetail = "not_run";
  let canaryFatal = requireCanary;
  if (canary && canary.checked_at) {
    canaryFatal = true;
    const checkedAt = Date.parse(canary.checked_at);
    const ageSec = Number.isFinite(checkedAt) ? Math.max(0, Math.round((Date.now() - checkedAt) / 1000)) : Infinity;
    if (canary.ok !== true) {
      canaryOk = false;
      canaryDetail = `failed:${canary.error || "unknown"}`;
    } else if (!Number.isFinite(ageSec) || ageSec > maxAgeSec) {
      canaryOk = false;
      canaryDetail = Number.isFinite(ageSec) ? `stale:${ageSec}s` : "invalid_timestamp";
    } else {
      canaryOk = true;
      canaryDetail = `ok:${ageSec}s_ago`;
    }
  } else if (requireCanary) {
    canaryOk = false;
    canaryDetail = "missing";
  }
  add("playback_canary", canaryOk, canaryDetail, canaryFatal);

  // The external multi-audio resolver is the fallback for blocked viewers. It
  // is not fatal: server-side playback still works without it, but a missing
  // token/key means the dub upgrade will silently fall back to single audio.
  const resolverConfigured = Boolean(
    env && env.GITHUB_DISPATCH_TOKEN && env.MULTI_AUDIO_PUBLISH_KEY
  );
  add(
    "multi_audio_resolver",
    resolverConfigured,
    resolverConfigured ? "configured" : "missing",
    false
  );

  return {
    status: reasons.length === 0 ? "ready" : "not_ready",
    ready: reasons.length === 0,
    service: "vidlyte-edge-proxy",
    timestamp: Date.now(),
    colo: request && request.cf ? request.cf.colo : "LOCAL_EDGE",
    country: request && request.cf ? request.cf.country : "N/A",
    version: runtimeConfig.config_version || CONFIG_VERSION,
    checks,
    reasons,
    canary: canary
      ? {
          ok: canary.ok === true,
          checked_at: canary.checked_at || "",
          latency_ms: Number(canary.latency_ms) || 0,
          asset: String(canary.asset || ""),
          provider: String(canary.provider || ""),
          audio_tracks: Number(canary.audio_tracks) || 0,
          error: String(canary.error || ""),
          attempts: Array.isArray(canary.attempts) ? canary.attempts.slice(0, 6) : [],
        }
      : null,
  };
}

/* ---------------------------------------------------------------------------
 * External ops feeds (quota, watchdog, sweep)
 * ---------------------------------------------------------------------------
 * GitHub Actions publishes one small JSON document per monitor to an
 * `ops-<kind>` branch. The Worker reads those public documents (raw.github)
 * and caches them in KV so the admin panel can render a single pane without
 * being able to call GitHub on every page load.
 * ------------------------------------------------------------------------ */

const OPS_STATUS_KV_KEY = "ops_status_v1";
const OPS_STATUS_CACHE_MS = 120000;
const OPS_STATUS_TIMEOUT_MS = 4000;
const OPS_STATUS_BASE_DEFAULT = "https://raw.githubusercontent.com/shreyash7854/vidlyte";
const OPS_KINDS = ["quota", "watchdog", "sweep"];
const OPS_QUOTA_WARN_PCT = 70;
const OPS_QUOTA_CRITICAL_PCT = 90;

function getOpsStatusBase(env) {
  const raw = (env && env.OPS_STATUS_BASE) || OPS_STATUS_BASE_DEFAULT;
  return String(raw).trim().replace(/\/+$/, "");
}

function opsStatusUrl(env, kind) {
  return `${getOpsStatusBase(env)}/ops-${kind}/${kind}.json`;
}

function normalizeOpsLevel(level, percent) {
  const value = String(level || "").toLowerCase();
  if (value === "ok" || value === "warning" || value === "critical") return value;
  const pct = Number(percent);
  if (!Number.isFinite(pct)) return "unknown";
  if (pct >= OPS_QUOTA_CRITICAL_PCT) return "critical";
  if (pct >= OPS_QUOTA_WARN_PCT) return "warning";
  return "ok";
}

function opsAgeSec(iso) {
  const parsed = Date.parse(String(iso || ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

async function readCachedOpsStatus(env) {
  if (!env || !env.CONFIG_KV) return null;
  try {
    const cached = await env.CONFIG_KV.get(OPS_STATUS_KV_KEY, { type: "json" });
    return cached && typeof cached === "object" ? cached : null;
  } catch (error) {
    return null;
  }
}

async function fetchOpsStatusFile(env, kind) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), OPS_STATUS_TIMEOUT_MS) : null;
  try {
    const response = await fetch(opsStatusUrl(env, kind), {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true },
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const data = await response.json();
    if (!data || typeof data !== "object") return { ok: false, error: "invalid_json" };
    return { ok: true, data };
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 120);
    return { ok: false, error: message || "fetch_failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadOpsStatus(env, options = {}) {
  const cached = await readCachedOpsStatus(env);
  const cachedAt = cached ? Number(cached.generated_at_ms) || 0 : 0;
  const fresh = cachedAt > 0 && Date.now() - cachedAt < OPS_STATUS_CACHE_MS;
  if (cached && fresh && !options.force) return { ...cached, cached: true };

  const results = await Promise.all(OPS_KINDS.map((kind) => fetchOpsStatusFile(env, kind)));
  const payload = {
    generated_at: new Date().toISOString(),
    generated_at_ms: Date.now(),
    cached: false,
    base: getOpsStatusBase(env),
    sources: {},
  };

  OPS_KINDS.forEach((kind, index) => {
    const result = results[index] || { ok: false, error: "unavailable" };
    if (!result.ok) {
      payload[kind] = { available: false, error: result.error || "unavailable" };
      payload.sources[kind] = { ok: false, error: result.error || "unavailable" };
      return;
    }
    const entry = { available: true, ...result.data };
    if (kind === "quota") entry.level = normalizeOpsLevel(entry.level, entry.percent);
    payload[kind] = entry;
    payload.sources[kind] = { ok: true, age_sec: opsAgeSec(entry.checked_at) };
  });

  if (env && env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(OPS_STATUS_KV_KEY, JSON.stringify(payload), { expirationTtl: 900 });
    } catch (error) {}
  }
  return payload;
}

/* ---------------------------------------------------------------------------
 * Multi-audio resolver (GitHub Actions fallback)
 * ---------------------------------------------------------------------------
 * Cloudflare egress to vidrift is blocked, and some viewer browsers/extensions
 * block the direct vidrift calls the player normally makes. A dispatched
 * GitHub Actions run resolves the signed BigBang URL from outside Cloudflare
 * and POSTs it back here, signed with MULTI_AUDIO_PUBLISH_KEY. The result lives
 * in KV only; signed upstream URLs never appear in a public status document.
 * ------------------------------------------------------------------------ */

const MULTI_AUDIO_STATUS_PREFIX = "ma_status_v1:";
const MULTI_AUDIO_DISPATCH_PREFIX = "ma_dispatch_v1:";
const MULTI_AUDIO_DISPATCH_TTL_SEC = 120;
const MULTI_AUDIO_STATUS_MIN_TTL_SEC = 300;
const MULTI_AUDIO_STATUS_MAX_TTL_SEC = 172800;
const MULTI_AUDIO_PUBLISH_MAX_BYTES = 4096;
const GITHUB_API_VERSION = "2022-11-28";

function normalizeMultiAudioAsset(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 48) return "";
  const info = parseAssetInfo(raw.replace(/^\/+|\/+$/g, ""));
  if (!info || !/^\d{1,9}$/.test(String(info.id))) return "";
  if (info.type === "tv") {
    if (!(info.season > 0 && info.season < 100) || !(info.episode > 0 && info.episode < 2000)) return "";
    return `tv/${info.id}/${info.season}/${info.episode}`;
  }
  return `movie/${info.id}`;
}

function multiAudioStatusKey(asset) {
  return `${MULTI_AUDIO_STATUS_PREFIX}${asset}`;
}

function multiAudioDispatchKey(asset) {
  return `${MULTI_AUDIO_DISPATCH_PREFIX}${asset}`;
}

async function readMultiAudioRecord(env, asset) {
  if (!env || !env.CONFIG_KV) return null;
  try {
    const record = await env.CONFIG_KV.get(multiAudioStatusKey(asset), { type: "json" });
    return record && typeof record === "object" ? record : null;
  } catch (error) {
    return null;
  }
}

async function writeMultiAudioRecord(env, asset, record) {
  if (!env || !env.CONFIG_KV) return false;
  const exp = Number(record && record.exp) || 0;
  const expiresAt = exp > 0 ? exp * 1000 : Date.now() + 1800000;
  const ttl = Math.min(
    MULTI_AUDIO_STATUS_MAX_TTL_SEC,
    Math.max(MULTI_AUDIO_STATUS_MIN_TTL_SEC, Math.round((expiresAt - Date.now()) / 1000) + 600)
  );
  try {
    await env.CONFIG_KV.put(multiAudioStatusKey(asset), JSON.stringify(record), { expirationTtl: ttl });
    return true;
  } catch (error) {
    return false;
  }
}

function multiAudioRecordUsable(record) {
  if (!record || record.ok !== true || !record.url) return false;
  const exp = Number(record.exp) || 0;
  if (exp > 0 && exp * 1000 < Date.now() + 60000) return false;
  return true;
}

async function verifyMultiAudioPublishSignature(request, env, rawBody) {
  const key = env && env.MULTI_AUDIO_PUBLISH_KEY;
  if (!key) return false;
  const supplied = String(request.headers.get("X-Multi-Audio-Signature") || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(rawBody));
    const expected = Array.from(new Uint8Array(mac))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEqual(expected, supplied);
  } catch (error) {
    return false;
  }
}

function isBigBangStreamUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:") return false;
    return /(^|\.)bigbang\.cymru$/i.test(parsed.hostname);
  } catch (error) {
    return false;
  }
}

async function dispatchMultiAudioResolution(env, asset) {
  const token = env && env.GITHUB_DISPATCH_TOKEN;
  if (!token) return { ok: false, error: "resolver_not_configured" };
  if (env && env.CONFIG_KV) {
    try {
      const existing = await env.CONFIG_KV.get(multiAudioDispatchKey(asset));
      if (existing) return { ok: true, state: "resolving", deduped: true };
      await env.CONFIG_KV.put(multiAudioDispatchKey(asset), "1", {
        expirationTtl: MULTI_AUDIO_DISPATCH_TTL_SEC,
      });
    } catch (error) {}
  }
  const repo = (env && env.GITHUB_REPO) || "shreyash7854/vidlyte";
  const workflow = (env && env.MULTI_AUDIO_WORKFLOW) || "multi-audio-resolve.yml";
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "Content-Type": "application/json",
          "User-Agent": "vidlyte-worker",
        },
        body: JSON.stringify({
          ref: (env && env.GITHUB_DISPATCH_REF) || "main",
          inputs: { assets: asset },
        }),
      }
    );
    if (response.status !== 204) {
      if (env && env.CONFIG_KV) {
        try {
          await env.CONFIG_KV.delete(multiAudioDispatchKey(asset));
        } catch (error) {}
      }
      return { ok: false, error: `dispatch_http_${response.status}` };
    }
    return { ok: true, state: "resolving" };
  } catch (error) {
    return { ok: false, error: "dispatch_failed" };
  }
}

function makeRequestId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (e) {}
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function withEdgeHeaders(response, requestId, startedAt) {
  if (!response) return response;
  try {
    const headers = new Headers(response.headers);
    headers.set("X-Request-Id", requestId);
    headers.set("X-Edge-Time-Ms", String(Math.max(0, Date.now() - startedAt)));
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const requestId = makeRequestId();
    const cspNonce = generateNonce(16);
    let route = "other";
    let clientIP = "unknown";
    try {
      const url = new URL(request.url);
      clientIP = extractClientIP(request);
      route = classifyRoute(url.pathname, env && env.ADMIN_ROUTE);
    } catch (e) {}

    // Phase 3 abuse control: fixed-window per-IP limiting by route class.
    // Preflight and health probes are never limited (swarm/cron depend on them).
    if (request.method !== "OPTIONS" && route !== "health") {
      try {
        const limiter = getRateLimiters(env);
        const verdict = limiter.check(route, clientIP);
        if (!verdict.allowed) {
          metricsData.rateLimitRejections++;
          const limited = new Response(
            JSON.stringify({
              error: "rate_limited",
              message: "Too many requests. Please slow down.",
              retry_after: verdict.retryAfterSec,
              request_id: requestId,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
                "Retry-After": String(verdict.retryAfterSec),
                "X-RateLimit-Limit": String(verdict.limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(Math.ceil(verdict.resetAt / 1000)),
                "X-Request-Id": requestId,
              },
            }
          );
          recordRequestMetric({
            request,
            response: limited,
            startedAt,
            requestId,
            route,
            extra: { cache: "rate_limited" },
          });
          return applySecurityHeaders(limited, {
            isHtml: false,
            isAdmin: route === "admin",
            isHttps: (() => {
              try {
                return new URL(request.url).protocol === "https:";
              } catch (e) {
                return true;
              }
            })(),
          });
        }
      } catch (e) {
        // Limiter failures must never take the gateway down.
      }
    }

    try {
      const response = await handleRequest(request, env, ctx, cspNonce);
      const edged = withEdgeHeaders(response, requestId, startedAt);
      recordRequestMetric({ request, response: edged, startedAt, requestId, route });
      return applySecurityHeaders(edged, {
        isHtml: true,
        isAdmin: route === "admin",
        nonce: cspNonce,
        isHttps: (() => {
          try {
            return new URL(request.url).protocol === "https:";
          } catch (e) {
            return true;
          }
        })(),
      });
    } catch (err) {
      const failure = new Response(
        JSON.stringify({ error: "edge_gateway_error", request_id: requestId }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "X-Request-Id": requestId,
            "X-Edge-Time-Ms": String(Math.max(0, Date.now() - startedAt)),
          },
        }
      );
      recordRequestMetric({ request, response: failure, startedAt, requestId, route, extra: { cache: "error" } });
      return applySecurityHeaders(failure, {
        isHtml: false,
        isAdmin: route === "admin",
        isHttps: (() => {
          try {
            return new URL(request.url).protocol === "https:";
          } catch (e) {
            return true;
          }
        })(),
      });
    }
  },

  async scheduled(event, env, ctx) {
    const task = runScheduledMaintenance(env, event);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    } else {
      await task;
    }
  },
};

async function handleRequest(request, env, ctx, cspNonce = "") {
    const url = new URL(request.url);
    const secretSpec = parseSecretKeys(env.HMAC_SECRET);
    const secretKey = secretSpec.primarySecret;
    const clientIP = extractClientIP(request);
    const codec = createOpaqueCodec(secretKey);
    const adminRoute = env.ADMIN_ROUTE || "/vly-ops-7x";
    const bindClientIP = env.BIND_CLIENT_IP === "true" || env.BIND_CLIENT_IP === "1";

    // Hydrate persisted runtime configuration without blocking normal traffic.
    if (env.CONFIG_KV && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(ensureRuntimeConfig(env));
    }

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type, Authorization, Accept, Referer, User-Agent, X-Playback-Token",
          "Access-Control-Max-Age": "86400",
        },
      });
    }


    // TMDB Image Proxy Handler (Bypasses ISP/DNS blocking of image.tmdb.org)
    const tmdbImgMatch = url.pathname.match(/^\/tmdb-image\/(.+)$/);
    if (tmdbImgMatch) {
      const imgPath = tmdbImgMatch[1];
      const targetUrl = `https://image.tmdb.org/t/p/${imgPath}`;
      try {
        const imgResp = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });
        if (imgResp.ok) {
          const respHeaders = new Headers(imgResp.headers);
          respHeaders.set("Access-Control-Allow-Origin", "*");
          respHeaders.set("Cache-Control", "public, max-age=604800, immutable");
          return new Response(imgResp.body, {
            status: 200,
            headers: respHeaders,
          });
        }
      } catch (e) {}
      return new Response("Image not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // Cache Source Endpoint for authenticated client-assisted resolution.
    // Requires either an admin session or a valid playback token for the asset.
    if (url.pathname === "/api/cache-source" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        if (!body || !body.id || !body.streamUrl) {
          return new Response(JSON.stringify({ error: "Missing id or streamUrl" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        const type = String(body.type || "tv");
        const id = String(body.id);
        const season = Number(body.season) || 0;
        const episode = Number(body.episode) || 0;
        const provider = normalizeProvider(body.provider || "orion");
        const assetID = season > 0 ? `tv-${id}-${season}-${episode}` : `movie-${id}`;

        const suppliedToken =
          body.token ||
          url.searchParams.get("token") ||
          request.headers.get("X-Playback-Token") ||
          "";
        const authorized =
          checkAdminAuth(request, env) ||
          (suppliedToken && (await wasmVerifyToken(assetID, clientIP, suppliedToken, secretSpec, { bindClientIP })));

        if (!authorized) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        const safeStreamUrl = assertSafeUpstreamUrl(body.streamUrl, {
          requireAllowlist: true,
          extraAllowlist: env.UPSTREAM_ALLOWLIST,
        }).toString();

        const baseKey = `${type}:${id}:${season}:${episode}`;
        const cacheKey = `${baseKey}:${provider}`;
        const existing = metadataCache.get(cacheKey)?.data || {};
        existing.streamUrl = safeStreamUrl;
        existing.provider = provider;
        existing.isMP4 = safeStreamUrl.toLowerCase().includes(".mp4");

        if (Array.isArray(body.audioTracks) && body.audioTracks.length > 0 && body.audioTracks.length <= 32) {
          existing.audioTracks = body.audioTracks
            .map((track, index) => {
              const rawUri = track && (track.uri || track.url || track.proxiedUri || track.proxied_uri);
              let safeUri = "";
              if (rawUri) {
                try {
                  safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
                } catch (e) {
                  safeUri = "";
                }
              }
              return {
                id: Number(track && track.id) || index,
                name: String((track && (track.name || track.label)) || `Audio ${index + 1}`).slice(0, 120),
                language: String((track && track.language) || "eng").slice(0, 16),
                default: Boolean(track && track.default),
                uri: safeUri,
                provider,
              };
            })
            .filter((track) => track.uri);
        }

        if (Array.isArray(body.subtitles) && body.subtitles.length > 0 && body.subtitles.length <= 64) {
          existing.subtitles = body.subtitles
            .map((subtitle) => {
              const rawUri = subtitle && (subtitle.url || subtitle.uri || subtitle.proxiedUri || subtitle.proxied_uri);
              if (!rawUri) return null;
              try {
                const safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
                return {
                  language: String((subtitle && subtitle.language) || "en").slice(0, 16),
                  label: sanitizeSubtitleLabel(subtitle && (subtitle.label || subtitle.language)),
                  url: safeUri,
                  uri: safeUri,
                };
              } catch (e) {
                return null;
              }
            })
            .filter(Boolean);
        }

        if (Array.isArray(body.variants) && body.variants.length > 0 && body.variants.length <= 32) {
          existing.variants = body.variants
            .map((variant) => {
              const rawUri = variant && (variant.playlistUri || variant.uri || variant.url);
              if (!rawUri) return null;
              try {
                const safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
                return {
                  resolution: String((variant && variant.resolution) || "Auto").slice(0, 24),
                  bandwidth: Number(variant && variant.bandwidth) || 0,
                  playlistUri: safeUri,
                  provider,
                };
              } catch (e) {
                return null;
              }
            })
            .filter(Boolean);
        }

        cacheResolvedResult(cacheKey, baseKey, existing);
        return new Response(JSON.stringify({ success: true, cacheKey }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      } catch (e) {
        const status = e instanceof UpstreamUrlError ? 403 : 400;
        return new Response(JSON.stringify({ error: status === 403 ? "Upstream URL rejected" : "Invalid request" }), {
          status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // Multi-audio resolver: request a GitHub Actions resolution, read its
    // result, and accept the signed result from the workflow. The player uses
    // these when the browser cannot reach vidrift directly.
    if (url.pathname === "/api/multi-audio/resolve" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const asset = normalizeMultiAudioAsset(body && body.asset);
      if (!asset) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_asset" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const existing = await readMultiAudioRecord(env, asset);
      if (multiAudioRecordUsable(existing)) {
        return new Response(JSON.stringify({
          ok: true,
          state: "ready",
          ready: true,
          asset,
          audio: Number(existing.audio) || 0,
          exp: Number(existing.exp) || 0,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const dispatched = await dispatchMultiAudioResolution(env, asset);
      return new Response(JSON.stringify({ ...dispatched, asset }), {
        status: dispatched.ok ? 202 : 503,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/api/multi-audio/status" && request.method === "GET") {
      const asset = normalizeMultiAudioAsset(url.searchParams.get("asset"));
      if (!asset) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_asset" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const record = await readMultiAudioRecord(env, asset);
      if (multiAudioRecordUsable(record)) {
        return new Response(JSON.stringify({
          ok: true,
          state: "ready",
          ready: true,
          asset,
          audio: Number(record.audio) || 0,
          exp: Number(record.exp) || 0,
          checked_at: record.checked_at || "",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      let pending = false;
      if (env && env.CONFIG_KV) {
        try {
          pending = Boolean(await env.CONFIG_KV.get(multiAudioDispatchKey(asset)));
        } catch (error) {}
      }
      // A fresh dispatch must not be masked by an older failed record: the
      // player should keep polling while the resolver is working.
      if (pending) {
        return new Response(JSON.stringify({ ok: true, state: "resolving", asset }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      if (record && record.ok === false && record.error) {
        return new Response(JSON.stringify({
          ok: true,
          state: "failed",
          asset,
          error: record.error,
          checked_at: record.checked_at || "",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true, state: "unknown", asset }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/api/multi-audio/publish" && request.method === "POST") {
      const rawBody = await request.text();
      if (!rawBody || rawBody.length > MULTI_AUDIO_PUBLISH_MAX_BYTES) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_body" }), {
          status: 413,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (!(await verifyMultiAudioPublishSignature(request, env, rawBody))) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      let body = null;
      try {
        body = JSON.parse(rawBody);
      } catch (error) {}
      const asset = normalizeMultiAudioAsset(body && body.asset);
      if (!asset) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_asset" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const ok = Boolean(body && body.ok) && isBigBangStreamUrl(body && body.url);
      const record = {
        ok,
        url: ok ? String(body.url) : "",
        audio: ok ? Math.max(0, Math.min(32, Number(body.audio) || 0)) : 0,
        provider: "bigbang",
        exp: ok ? Number(body.exp) || 0 : 0,
        checked_at: new Date().toISOString(),
        error: ok ? "" : String((body && body.error) || "no_multi_audio").slice(0, 80),
      };
      const persisted = await writeMultiAudioRecord(env, asset, record);
      return new Response(JSON.stringify({ ok: persisted, asset, stored: record.ok }), {
        status: persisted ? 200 : 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Diagnostic probe for upstream stream resolution (admin only).
    if (url.pathname === "/api/test-vidrift") {
      if (!checkAdminAuth(request, env)) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
        });
      }
      const type = url.searchParams.get("type") === "tv" ? "tv" : "movie";
      const id = String(url.searchParams.get("id") || "100088").slice(0, 32);
      const s = parseInt(url.searchParams.get("s") || "1", 10);
      const e = parseInt(url.searchParams.get("e") || "1", 10);
      const customUrl = url.searchParams.get("url");
      const bootPath = type === "tv" ? `/api/boot/tv/${encodeURIComponent(id)}/${s}/${e}` : `/api/boot/movie/${encodeURIComponent(id)}`;
      const targetUrl = customUrl || `https://embed.vidrift.net${bootPath}`;
      
      const tests = [
        { name: "default", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Referer": "https://vidrift.net/", "Origin": "https://vidrift.net", "Accept": "application/json, text/plain, */*" } },
        { name: "no-origin-referer", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Accept": "*/*" } },
        { name: "embed-referer", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Referer": "https://embed.vidrift.net/", "Origin": "https://embed.vidrift.net", "Accept": "*/*" } },
        { name: "mobile-ua", headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1", "Referer": "https://vidrift.net/", "Accept": "*/*" } },
        { name: "curl-ua", headers: { "User-Agent": "curl/8.4.0", "Accept": "*/*" } }
      ];

      const results = [];
      for (const t of tests) {
        try {
          const resp = await fetch(targetUrl, { headers: t.headers, signal: AbortSignal.timeout(4000) });
          const text = await resp.text();
          const respHeaders = {};
          resp.headers.forEach((v, k) => { respHeaders[k] = v; });
          results.push({ name: t.name, status: resp.status, headers: respHeaders, bodySnippet: text.slice(0, 150) });
        } catch (err) {
          results.push({ name: t.name, error: err.message });
        }
      }

      return new Response(JSON.stringify({ targetUrl, results }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      });
    }

    // 2. Hide Legacy Admin Route (/admin-login-i)
    if (url.pathname === "/admin-login-i" || url.pathname.startsWith("/admin-login-i/")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    // 2a. Admin Operations Vault (Configurable, default /vly-ops-7x)
    if (url.pathname === adminRoute || url.pathname === `${adminRoute}/docs`) {
      return new Response(renderAdminHTML(cspNonce), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }

    // 3. Admin Authentication (${adminRoute}/auth)
    if (url.pathname === `${adminRoute}/auth` && request.method === "POST") {
      const lockState = failedLogins.get(clientIP);
      if (lockState && lockState.lockedUntil > Date.now()) {
        const remainingMins = Math.ceil((lockState.lockedUntil - Date.now()) / 60000);
        recordAudit("admin.auth.locked", request, { remaining_minutes: remainingMins });
        return new Response(JSON.stringify({
          success: false,
          error: `Too many failed attempts. Locked out for ${remainingMins} minutes.`,
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = await request.json().catch(() => ({}));
      const secret = body.secret || "";
      const validSecret = getAdminSecret(env);

      if (!validSecret) {
        return new Response(JSON.stringify({
          success: false,
          error: "Admin access is disabled: ADMIN_SECRET is not configured.",
        }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      if (!constantTimeEqual(secret, validSecret)) {
        const attempts = (lockState ? lockState.attempts : 0) + 1;
        const locked = attempts >= 5;
        failedLogins.set(clientIP, {
          attempts,
          lockedUntil: locked ? Date.now() + 15 * 60 * 1000 : 0,
        });
        recordAudit("admin.auth.failed", request, { attempts, locked });
        const msg = locked
          ? "Invalid secret. Account locked for 15 minutes."
          : `Invalid secret. ${5 - attempts} attempts remaining.`;
        return new Response(JSON.stringify({ success: false, error: msg }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      failedLogins.delete(clientIP);
      pruneAdminSessions();
      const sessionToken = signAdminSession(validSecret, clientIP);
      if (!sessionToken) {
        return new Response(JSON.stringify({ success: false, error: "Session issuance failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const sessionTtlSec = getAdminSessionTtlSec(env);
      const csrfToken = deriveAdminCsrf(validSecret, sessionToken);
      activeAdminSessions.set(sessionToken, Date.now() + sessionTtlSec * 1000);
      recordAudit("admin.auth.success", request, {});
      const secureFlag = url.protocol === "https:" ? "; Secure" : "";
      const responseHeaders = new Headers({
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      responseHeaders.append(
        "Set-Cookie",
        `vidlyte_admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtlSec}${secureFlag}`
      );
      responseHeaders.append(
        "Set-Cookie",
        `vidlyte_admin_csrf=${csrfToken}; Path=/; SameSite=Strict; Max-Age=${sessionTtlSec}${secureFlag}`
      );

      return new Response(
        JSON.stringify({ success: true, csrf_token: csrfToken, expires_in: sessionTtlSec }),
        { status: 200, headers: responseHeaders }
      );
    }

    // 3b. Central CSRF gate for every mutating admin route (auth is exempt).
    // Each route still checks authentication, but this ensures a cookie alone
    // can never authorise a state-changing request.
    const isAdminMutation =
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS" &&
      (url.pathname === adminRoute || url.pathname.startsWith(`${adminRoute}/`)) &&
      url.pathname !== `${adminRoute}/auth`;
    if (isAdminMutation) {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (!checkAdminCsrf(request, env)) {
        recordAudit("admin.csrf.rejected", request, { path: url.pathname });
        return new Response(JSON.stringify({ error: "Invalid or missing CSRF token" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
    }

    // 4. Admin Logout (${adminRoute}/logout)
    if (url.pathname === `${adminRoute}/logout` && request.method === "POST") {
      const sessionToken = getAdminSessionToken(request);
      if (sessionToken) activeAdminSessions.delete(sessionToken);
      recordAudit("admin.logout", request, {});
      const logoutHeaders = new Headers({
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      logoutHeaders.append("Set-Cookie", "vidlyte_admin_session=; Path=/; HttpOnly; Max-Age=0");
      logoutHeaders.append("Set-Cookie", "vidlyte_admin_csrf=; Path=/; Max-Age=0");
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: logoutHeaders,
      });
    }

    // 5. Admin Dynamic Config API (${adminRoute}/api/config)
    if (url.pathname === `${adminRoute}/api/config`) {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      await ensureRuntimeConfig(env);
      if (request.method === "POST") {
        const newCfg = await request.json().catch(() => null);
        if (!newCfg || typeof newCfg !== "object") {
          return new Response(JSON.stringify({ error: "Invalid JSON configuration" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const applied = applyRuntimeConfig(newCfg);

        // Re-probe every swarm node after a config change so the admin UI and
        // the runtime ordering see fresh health/latency data immediately.
        const workers = runtimeConfig.proxy_swarm.workers || [];
        const probeResults = await Promise.all(
          workers.map((worker) => probeSwarmNode(worker).catch(() => null))
        );
        const probedById = new Map();
        probeResults.forEach((result) => {
          if (!result) return;
          probedById.set(result.id, result);
        });
        runtimeConfig.proxy_swarm.workers = workers.map((worker) => {
          const probed = probedById.get(worker.id);
          if (!probed) return worker;
          return {
            ...worker,
            url: probed.url || worker.url,
            status: probed.status,
            latency_ms: probed.latency_ms,
          };
        });
        runtimeConfig.proxy_swarm.last_probe_at = new Date().toISOString();

        const persisted = await persistRuntimeConfig(env);
        const historyEntry = await recordConfigHistory(env, "update", {
          note: `admin update from ${clientIP}`,
        });
        recordAudit("config.update", request, {
          applied,
          persisted,
          config_version: runtimeConfig.config_version || CONFIG_VERSION,
          history_id: historyEntry ? historyEntry.id : "",
        });
        return new Response(JSON.stringify({
          success: true,
          applied,
          persisted,
          persistence: env.CONFIG_KV ? (persisted ? "kv" : "kv_error") : "memory_only",
          history_id: historyEntry ? historyEntry.id : "",
          config: runtimeConfig,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify(runtimeConfig), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 6. Admin Swarm Prober API (${adminRoute}/api/swarm/test)
    if (url.pathname === `${adminRoute}/api/swarm/test` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const workers = normalizeSwarmWorkers(runtimeConfig.proxy_swarm.workers || []);
      const results = await Promise.all(workers.map((worker) => probeSwarmNode(worker)));

      runtimeConfig.proxy_swarm.workers = workers.map((worker) => {
        const probed = results.find((result) => result.id === worker.id);
        return probed
          ? { ...worker, status: probed.status, latency_ms: probed.latency_ms }
          : worker;
      });
      runtimeConfig.proxy_swarm.last_probe_at = new Date().toISOString();
      await persistRuntimeConfig(env);

      return new Response(JSON.stringify({ success: true, results }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 6b. Admin Provider Health & Resolution Tester
    if (url.pathname === `${adminRoute}/api/providers/probe` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const results = await Promise.all(
        defaultProviderOrder().map((id) => probeProviderReachability(id).catch(() => null))
      );
      await persistProviderHealth(env);
      return new Response(JSON.stringify({
        success: true,
        results: results.filter(Boolean),
        providers: snapshotProviderHealth(),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === `${adminRoute}/api/providers/health`) {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      await loadPersistedProviderHealth(env);
      return new Response(JSON.stringify({
        success: true,
        providers: snapshotProviderHealth(),
        breakers: providerBreakers.snapshot(),
        last_probe_at: runtimeConfig.proxy_swarm.last_probe_at || "",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Alerting status/test. Mutations are already protected by the central CSRF
    // gate; authentication is re-checked here to keep the route self-contained.
    if (url.pathname === `${adminRoute}/api/alerts/status`) {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const config = getTelegramConfig(env);
      return new Response(JSON.stringify({
        success: true,
        telegram: {
          configured: config.configured,
          enabled: config.enabled,
          min_severity: config.minSeverity,
          cooldown_min: Math.round(config.cooldownMs / 60000),
        },
        webhook_configured: Boolean(env && env.ALERT_WEBHOOK_URL),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === `${adminRoute}/api/alerts/test` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const body = await request.json().catch(() => ({}));
      const severity = normalizeAlertSeverity(body.severity, "critical");
      const note = String(body.text || "Manual test from the VidLyte admin panel.").slice(0, 500);
      const result = await sendTelegramAlert(env, {
        key: "admin-test",
        type: "open",
        severity,
        signature: `admin-test:${Date.now()}`,
        force: true,
        text: formatTelegramMessage({
          title: "VidLyte test alert",
          type: "open",
          severity,
          lines: [note],
        }),
      });
      recordAudit("alerts.test", request, {
        sent: result.sent,
        configured: result.configured,
        skipped: result.skipped,
        severity,
      });
      const status = result.sent ? 200 : result.configured ? 502 : 503;
      return new Response(JSON.stringify({
        success: result.sent,
        configured: result.configured,
        enabled: result.enabled,
        severity,
        skipped: result.skipped,
        error: result.error || "",
      }), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === `${adminRoute}/api/watchdog/canary` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const canary = await runPlaybackCanary(env);
      recordAudit("watchdog.canary", request, {
        ok: canary.ok,
        provider: canary.provider,
        latency_ms: canary.latency_ms,
      });
      return new Response(JSON.stringify({ success: canary.ok, canary }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === `${adminRoute}/api/providers/test` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const body = await request.json().catch(() => ({}));
      const provider = normalizeProvider(body.provider || "asianflix");
      const type = body.type === "tv" || body.type === "series" ? "tv" : "movie";
      const id = String(body.id || "550").slice(0, 32);
      const season = Number(body.season) || 1;
      const episode = Number(body.episode) || 1;
      const assetInfo = { type, id, season, episode };
      const started = Date.now();
      let result = null;
      let error = "";
      try {
        const metaOverride = body.title
          ? { title: String(body.title).slice(0, 160), seriesTitle: String(body.title).slice(0, 160), year: String(body.year || "") }
          : null;
        result = await attemptProvider(provider, assetInfo, metaOverride);
      } catch (e) {
        error = String((e && e.message) || e).slice(0, 160);
      }
      const latency = Date.now() - started;
      let host = "";
      if (result && result.streamUrl) {
        try {
          host = new URL(result.streamUrl).hostname;
        } catch (e) {}
      }
      return new Response(JSON.stringify({
        success: Boolean(result && result.streamUrl),
        provider,
        asset: `${type}:${id}${type === "tv" ? `:${season}:${episode}` : ""}`,
        latency_ms: latency,
        error,
        stream: result && result.streamUrl
          ? {
              host,
              is_mp4: Boolean(result.isMP4),
              title: result.title || "",
              audio_tracks: Array.isArray(result.audioTracks) ? result.audioTracks.length : 0,
              subtitles: Array.isArray(result.subtitles) ? result.subtitles.length : 0,
              variants: Array.isArray(result.variants) ? result.variants.length : 0,
            }
          : null,
        health: snapshotProviderHealth().find((item) => item.id === provider) || null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 7. System Metrics & Telemetry (Protected behind Admin Auth)
    if (url.pathname === "/metrics" || url.pathname === `${adminRoute}/metrics`) {
      if (!checkAdminAuth(request, env)) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
        });
      }
      const metricsSnapshot = metricsRegistry.snapshot();
      return new Response(JSON.stringify({
        total_requests: metricsData.totalRequests,
        active_requests: metricsData.activeRequests,
        bytes_streamed: metricsData.bytesStreamed,
        cache_hits: metricsData.cacheHits,
        cache_misses: metricsData.cacheMisses,
        status_2xx: metricsData.status2xx,
        status_4xx: metricsData.status4xx,
        status_5xx: metricsData.status5xx,
        rate_limit_rejections: metricsData.rateLimitRejections,
        top_domains: Array.from(domainTelemetry.values()),
        registry: metricsSnapshot,
        health: gradeHealth(metricsSnapshot),
        rate_limits: getRateLimiters(env).snapshot(),
        engagement: engagementSnapshot(),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 7.1 Admin Diagnostics Snapshot (Phase 3)
    if (url.pathname === `${adminRoute}/api/diagnostics`) {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      await loadPersistedProviderHealth(env);
      const metricsSnapshot = metricsRegistry.snapshot();
      const limiters = getRateLimiters(env);
      const sampleLimit = Math.max(1, Math.min(120, parseInt(url.searchParams.get("logs") || "40", 10) || 40));
      const payload = {
        ok: true,
        generated_at: new Date().toISOString(),
        version: {
          config_version: runtimeConfig.config_version || CONFIG_VERSION,
          updated_at: runtimeConfig.updated_at || "",
          bundle: "edge-native",
        },
        runtime: {
          colo: request.cf ? request.cf.colo || "" : "LOCAL_EDGE",
          country: request.cf ? request.cf.country || "" : "",
          persisted_config: Boolean(env.CONFIG_KV),
          persisted_provider_health: Boolean(env.CONFIG_KV),
          admin_secret_configured: Boolean(getAdminSecret(env)),
          hmac_secret_configured: Boolean(env.HMAC_SECRET),
          bind_client_ip: bindClientIP,
          rate_limit_enabled: limiters.enabled,
        },
        health: gradeHealth(metricsSnapshot),
        metrics: metricsSnapshot,
        rate_limits: limiters.snapshot(),
        providers: snapshotProviderHealth(),
        breakers: {
          providers: providerBreakers.snapshot(),
          hosts: hostBreakers.snapshot(),
        },
        caches: {
          sources: sourceStaleCache.size,
          metadata: metadataCache.size,
          manifests: rawManifestCache.size,
          last_good: lastGoodSourceCache.size,
          subtitles: subtitleMemoryCache.size,
        },
        swarm: {
          nodes: (runtimeConfig.proxy_swarm.workers || []).map((worker) => ({
            id: worker.id,
            name: worker.name,
            url: worker.url,
            enabled: worker.enabled !== false,
            status: worker.status || "unknown",
            latency_ms: Number(worker.latency_ms) || 0,
          })),
          strategy: runtimeConfig.proxy_swarm.strategy || "latency",
          last_probe_at: runtimeConfig.proxy_swarm.last_probe_at || "",
        },
        engagement: engagementSnapshot(),
        requests: requestLog.list(sampleLimit),
        audit: auditLog.list(sampleLimit),
      };
      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 7.2 Admin Audit Log (Phase 3)
    if (url.pathname === `${adminRoute}/api/audit`) {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const limit = Math.max(1, Math.min(120, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      return new Response(JSON.stringify({
        success: true,
        entries: auditLog.list(limit),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 7.3 Admin Config Export / Import (Phase 3)
    if (url.pathname === `${adminRoute}/api/config/export` && request.method === "GET") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      await ensureRuntimeConfig(env);
      const document = buildConfigExport(runtimeConfig);
      recordAudit("config.export", request, { config_version: document.config_version });
      return new Response(JSON.stringify(document, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="vidlyte-config-v${document.config_version}.json"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === `${adminRoute}/api/config/import` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      let payload = null;
      try {
        payload = await request.json();
      } catch (e) {
        payload = null;
      }
      const validation = validateConfigImport(payload);
      if (!validation.ok) {
        recordAudit("config.import.rejected", request, { errors: validation.errors.slice(0, 4) });
        return new Response(JSON.stringify({
          success: false,
          error: "Invalid configuration import",
          errors: validation.errors,
        }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      const applied = applyRuntimeConfig(validation.config);
      const persisted = await persistRuntimeConfig(env);
      const historyEntry = await recordConfigHistory(env, "import", {
        note: `admin import from ${clientIP}`,
      });
      recordAudit("config.import", request, {
        applied,
        persisted,
        config_version: runtimeConfig.config_version || CONFIG_VERSION,
        history_id: historyEntry ? historyEntry.id : "",
      });
      return new Response(JSON.stringify({
        success: true,
        applied,
        persisted,
        persistence: env.CONFIG_KV ? "kv" : "memory_only",
        config_version: runtimeConfig.config_version || CONFIG_VERSION,
        history_id: historyEntry ? historyEntry.id : "",
        config: runtimeConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 7.3 Admin Ops Feeds (quota / watchdog / sweep snapshots)
    if (url.pathname === `${adminRoute}/api/ops` && request.method === "GET") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const force = url.searchParams.get("refresh") === "1";
      let ops;
      try {
        ops = await loadOpsStatus(env, { force });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: "ops_feeds_unavailable",
          detail: String((error && error.message) || error).slice(0, 160),
        }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ success: true, ...ops }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 7.4 Admin Config History & Rollback (Phase 5)
    if (url.pathname === `${adminRoute}/api/config/history` && request.method === "GET") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const force = url.searchParams.get("refresh") === "1";
      const list = await loadConfigHistory(env, { force });
      const requestedId = url.searchParams.get("id");
      if (requestedId) {
        const entry = list.find((item) => item.id === requestedId);
        if (!entry) {
          return new Response(JSON.stringify({ error: "History entry not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }
        return new Response(JSON.stringify({
          success: true,
          entry,
          diff: diffConfigs(entry.config, runtimeConfig),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const entries = list.map((entry) => ({
        id: entry.id,
        at: entry.at,
        action: entry.action,
        config_version: entry.config_version,
        note: entry.note || "",
        summary: entry.summary || summarizeConfig(entry.config),
        config_bytes: (() => {
          try {
            return JSON.stringify(entry.config || {}).length;
          } catch (e) {
            return 0;
          }
        })(),
      }));
      return new Response(JSON.stringify({
        success: true,
        limit: CONFIG_HISTORY_LIMIT,
        entries,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === `${adminRoute}/api/config/rollback` && request.method === "POST") {
      if (!checkAdminAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const body = await request.json().catch(() => ({}));
      const id = String(body && body.id ? body.id : "").slice(0, 80);
      if (!id) {
        return new Response(JSON.stringify({ error: "Missing history id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const list = await loadConfigHistory(env, { force: true });
      const entry = list.find((item) => item.id === id);
      if (!entry || !entry.config || typeof entry.config !== "object") {
        return new Response(JSON.stringify({ error: "History entry not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const before = snapshotRuntimeConfig();
      const applied = replaceRuntimeConfig(entry.config);
      const persisted = await persistRuntimeConfig(env);
      const rollbackEntry = await recordConfigHistory(env, "rollback", {
        note: `rolled back to ${id}`,
      });
      const diff = diffConfigs(before, runtimeConfig);
      recordAudit("config.rollback", request, {
        source_id: id,
        applied,
        persisted,
        history_id: rollbackEntry ? rollbackEntry.id : "",
      });
      return new Response(JSON.stringify({
        success: true,
        source_id: id,
        applied,
        persisted,
        persistence: env.CONFIG_KV ? (persisted ? "kv" : "kv_error") : "memory_only",
        history_id: rollbackEntry ? rollbackEntry.id : "",
        diff,
        config: runtimeConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 7a. Zero-Leak Opaque Media Chunk Delivery (/stream/chunk/:opaqueId)
    const chunkMatch = url.pathname.match(/^\/stream\/chunk\/([a-zA-Z0-9_\-]+)$/);
    if (chunkMatch) {
      const opaqueToken = chunkMatch[1];
      const decoded = codec.decode(opaqueToken, { maxAgeSec: OPAQUE_MAX_AGE_SEC });
      if (!decoded || !decoded.targetUrl) {
        return new Response("Invalid chunk identifier", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      let targetUrl;
      try {
        targetUrl = assertSafeUpstreamUrl(decoded.targetUrl, { extraAllowlist: env.UPSTREAM_ALLOWLIST });
      } catch (e) {
        return new Response("Chunk target rejected", { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      if (!isStreamUrlUsable(targetUrl.toString(), 0)) {
        return new Response("Chunk target expired", { status: 410, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      return proxyUpstream(request, targetUrl, decoded.provider || "evion", env, codec);
    }

    // 7b. Zero-Leak Opaque Sub-Resource / Sub-Manifest Gateway (/hls/:assetID/res/:opaqueId)
    const hlsResMatch = url.pathname.match(/^\/hls\/([^/]+)\/res\/([a-zA-Z0-9_\-]+)$/);
    if (hlsResMatch) {
      const assetID = decodeURIComponent(hlsResMatch[1]);
      const opaqueToken = hlsResMatch[2];
      const token = url.searchParams.get("token") || request.headers.get("X-Playback-Token");

      if (!token) {
        return new Response("Unauthorized: missing playback token", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const isValid = await wasmVerifyToken(assetID, clientIP, token, secretSpec, { bindClientIP });
      if (!isValid) {
        return new Response("Unauthorized: invalid or expired playback token", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const decoded = codec.decode(opaqueToken, { maxAgeSec: OPAQUE_MAX_AGE_SEC });
      if (!decoded || !decoded.targetUrl) {
        return new Response("Invalid resource identifier", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      let targetUrl;
      try {
        targetUrl = assertSafeUpstreamUrl(decoded.targetUrl, { extraAllowlist: env.UPSTREAM_ALLOWLIST });
      } catch (e) {
        return new Response("Resource target rejected", { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      const provider = decoded.provider || "evion";
      try {
        const rawSubM3U8 = await fetchRawManifest(targetUrl.toString(), provider, request, env);
        if (rawSubM3U8.startsWith("#EXTM3U") || rawSubM3U8.includes("#EXTINF") || isPlaylistUrl(targetUrl.toString())) {
          const rewritten = rewriteManifest(rawSubM3U8, {
            baseUrl: targetUrl.toString(),
            assetId: assetID,
            token,
            origin: url.origin,
            provider,
            codec,
          });

          return new Response(rewritten, {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "private, max-age=5, must-revalidate",
            },
          });
        }
      } catch (err) {
        if (err instanceof UpstreamUrlError) {
          return new Response("Resource target rejected", { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
        }
      }

      return proxyUpstream(request, targetUrl, provider, env, codec);
    }

    // 7c. Client-Assisted HLS Manifest Gateway (/hls/:assetID/client.m3u8)
    // Some providers gate their resolver APIs to a specific browser origin that
    // Cloudflare egress cannot impersonate. The browser resolves the signed
    // upstream URL and hands it back here; the URL is strictly allowlisted and
    // the manifest is rewritten so every sub-resource keeps flowing through the
    // opaque /res and /stream/chunk gateways.
    const hlsClientMatch = url.pathname.match(/^\/hls\/([^/]+)\/client\.m3u8$/);
    if (hlsClientMatch) {
      const assetID = decodeURIComponent(hlsClientMatch[1]);
      const token = url.searchParams.get("token") || request.headers.get("X-Playback-Token");
      const rawUpstream = url.searchParams.get("url");

      if (!token) {
        return new Response("Unauthorized: missing playback token", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const isValid = await wasmVerifyToken(assetID, clientIP, token, secretSpec, { bindClientIP });
      if (!isValid) {
        return new Response("Unauthorized: invalid or expired playback token", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (!rawUpstream) {
        return new Response("Missing 'url' parameter", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      let targetUrl;
      try {
        targetUrl = assertSafeUpstreamUrl(rawUpstream, {
          requireAllowlist: true,
          extraAllowlist: env.UPSTREAM_ALLOWLIST,
        });
      } catch (e) {
        return new Response("Upstream URL rejected", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (!isStreamUrlUsable(targetUrl.toString(), 0)) {
        return new Response("Upstream URL expired", {
          status: 410,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const provider = normalizeProvider(url.searchParams.get("provider") || "bigbang");
      try {
        const raw = await fetchRawManifest(targetUrl.toString(), provider, request, env);
        if (!raw || !(raw.startsWith("#EXTM3U") || raw.includes("#EXTINF") || isPlaylistUrl(targetUrl.toString()))) {
          return new Response("Upstream did not return a valid playlist", {
            status: 502,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }

        const rewritten = rewriteManifest(raw, {
          baseUrl: targetUrl.toString(),
          assetId: assetID,
          token,
          origin: url.origin,
          provider,
          codec,
        });

        return new Response(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, max-age=5, must-revalidate",
          },
        });
      } catch (err) {
        if (err instanceof UpstreamUrlError) {
          return new Response("Upstream URL rejected", {
            status: 403,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
        return new Response("Upstream manifest unavailable", {
          status: 502,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }


    // 7d. Remote multi-audio gateway (/hls/:assetID/remote.m3u8)
    // The external resolver stores the signed upstream URL in KV. The player
    // requests this route instead of receiving the URL, so viewers never see an
    // upstream host or signature in their network tab.
    const hlsRemoteMatch = url.pathname.match(/^\/hls\/([^/]+)\/remote\.m3u8$/);
    if (hlsRemoteMatch) {
      const assetID = decodeURIComponent(hlsRemoteMatch[1]);
      const token = url.searchParams.get("token") || request.headers.get("X-Playback-Token");
      const corsHeaders = { "Access-Control-Allow-Origin": "*" };

      if (!token) {
        return new Response("Unauthorized: missing playback token", { status: 401, headers: corsHeaders });
      }
      const isValid = await wasmVerifyToken(assetID, clientIP, token, secretSpec, { bindClientIP });
      if (!isValid) {
        return new Response("Unauthorized: invalid or expired playback token", { status: 403, headers: corsHeaders });
      }

      const asset = normalizeMultiAudioAsset(assetID);
      const record = asset ? await readMultiAudioRecord(env, asset) : null;
      if (!multiAudioRecordUsable(record)) {
        return new Response("Multi-audio source not ready", { status: 404, headers: corsHeaders });
      }

      let targetUrl;
      try {
        targetUrl = assertSafeUpstreamUrl(record.url, {
          requireAllowlist: true,
          extraAllowlist: env.UPSTREAM_ALLOWLIST,
        });
      } catch (e) {
        return new Response("Upstream URL rejected", { status: 403, headers: corsHeaders });
      }
      if (!isStreamUrlUsable(targetUrl.toString(), 0)) {
        return new Response("Upstream URL expired", { status: 410, headers: corsHeaders });
      }

      const provider = normalizeProvider(url.searchParams.get("provider") || "bigbang");
      try {
        const raw = await fetchRawManifest(targetUrl.toString(), provider, request, env);
        if (!raw || !(raw.startsWith("#EXTM3U") || raw.includes("#EXTINF") || isPlaylistUrl(targetUrl.toString()))) {
          return new Response("Upstream did not return a valid playlist", { status: 502, headers: corsHeaders });
        }
        const rewritten = rewriteManifest(raw, {
          baseUrl: targetUrl.toString(),
          assetId: assetID,
          token,
          origin: url.origin,
          provider,
          codec,
        });
        return new Response(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, max-age=5, must-revalidate",
          },
        });
      } catch (err) {
        if (err instanceof UpstreamUrlError) {
          return new Response("Upstream URL rejected", { status: 403, headers: corsHeaders });
        }
        return new Response("Upstream manifest unavailable", { status: 502, headers: corsHeaders });
      }
    }


    // 8a. Strict readiness for the external watchdog. Unlike /health this
    // fails closed (503) when secrets, KV, config or the playback canary are
    // unhealthy. `?canary=1` runs a real resolver check immediately.
    if (url.pathname === "/health/ready" || url.pathname === "/readyz") {
      const forceCanary =
        url.searchParams.get("canary") === "1" || url.searchParams.get("canary") === "true";
      const canary = forceCanary ? await runPlaybackCanary(env) : undefined;
      const payload = await buildReadinessPayload(request, env, canary);
      return new Response(JSON.stringify(payload, null, 2), {
        status: payload.ready ? 200 : 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }

    // 8. Health & Telemetry Probe (for Swarm Balancer)
    if (url.pathname === "/health" || url.pathname === "/healthz" || url.pathname === "/ping") {
      const deep = url.searchParams.get("deep") === "1" || url.searchParams.get("deep") === "true";
      if (deep) {
        await loadPersistedProviderHealth(env);
        const payload = buildDeepHealthPayload(request, env);
        payload.canary = await loadCanaryState(env);
        return new Response(JSON.stringify(payload, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-store",
          },
        });
      }
      return new Response(JSON.stringify({
        status: "healthy",
        service: "vidlyte-edge-proxy",
        engine: "Native Edge Crypto Engine (Go WASM parity core available)",
        timestamp: Date.now(),
        colo: request.cf ? request.cf.colo : "LOCAL_EDGE",
        country: request.cf ? request.cf.country : "N/A",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }

    // 8b. TMDB Search / Discovery / Episode Browser (Phase 4)
    // Public metadata only: no tokens, no upstream URLs. Cached per isolate.
    if (url.pathname === "/api/tmdb/search") {
      const q = sanitizeText(url.searchParams.get("q") || "", 120).trim();
      if (!q) {
        return new Response(JSON.stringify({ success: false, error: "Missing search query" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const requestedType = String(url.searchParams.get("type") || "multi").toLowerCase();
      const type = requestedType === "movie" || requestedType === "tv" ? requestedType : "multi";
      const page = Math.max(1, Math.min(10, parseInt(url.searchParams.get("page") || "1", 10) || 1));
      const cacheKey = `search:${type}:${page}:${q.toLowerCase()}`;
      const hit = tmdbCache.get(cacheKey);
      let payload = hit && hit.fresh ? hit.value : null;
      if (!payload) {
        try {
          const data = await tmdbRequest(`search/${type}`, {
            query: q,
            page: String(page),
            include_adult: "false",
          });
          payload = {
            success: true,
            query: q,
            type,
            page,
            total_pages: Math.min(Number(data.total_pages) || 1, 20),
            total_results: Number(data.total_results) || 0,
            results: (data.results || [])
              .map((item) => mapTmdbSearchResult(item, type === "tv" ? "tv" : "movie"))
              .filter(Boolean),
          };
          tmdbCache.set(cacheKey, payload, 10 * 60 * 1000, 60 * 60 * 1000);
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "TMDB search unavailable" }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
          });
        }
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
        },
      });
    }

    if (url.pathname === "/api/tmdb/trending") {
      const requestedType = String(url.searchParams.get("type") || "all").toLowerCase();
      const type = requestedType === "movie" || requestedType === "tv" ? requestedType : "all";
      const window = String(url.searchParams.get("window") || "week").toLowerCase() === "day" ? "day" : "week";
      const cacheKey = `trending:${type}:${window}`;
      const hit = tmdbCache.get(cacheKey);
      let payload = hit && hit.fresh ? hit.value : null;
      if (!payload) {
        try {
          const data = await tmdbRequest(`trending/${type}/${window}`, {});
          payload = {
            success: true,
            type,
            window,
            results: (data.results || [])
              .map((item) => mapTmdbSearchResult(item, "movie"))
              .filter((item) => item && item.type)
              .slice(0, 20),
          };
          tmdbCache.set(cacheKey, payload, 15 * 60 * 1000, 2 * 60 * 60 * 1000);
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "TMDB trending unavailable" }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
          });
        }
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=900, stale-while-revalidate=3600",
        },
      });
    }

    const tmdbSeasonsMatch = url.pathname.match(/^\/api\/tmdb\/tv\/([^/]+)\/seasons$/);
    if (tmdbSeasonsMatch) {
      const tvId = sanitizeText(decodeURIComponent(tmdbSeasonsMatch[1]), 24);
      if (!/^\d+$/.test(tvId)) {
        return new Response(JSON.stringify({ success: false, error: "Invalid TV id" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const cacheKey = `tv-seasons:${tvId}`;
      const hit = tmdbCache.get(cacheKey);
      let payload = hit && hit.fresh ? hit.value : null;
      if (!payload) {
        try {
          const data = await tmdbRequest(`tv/${tvId}`, {});
          payload = {
            success: true,
            id: tvId,
            title: sanitizeText(data.name || "", 160),
            number_of_seasons: Number(data.number_of_seasons) || 0,
            number_of_episodes: Number(data.number_of_episodes) || 0,
            seasons: (data.seasons || [])
              .filter((season) => season && Number(season.season_number) > 0)
              .map((season) => ({
                season_number: Number(season.season_number) || 0,
                name: sanitizeText(season.name || `Season ${season.season_number}`, 120),
                episode_count: Number(season.episode_count) || 0,
                air_date: String(season.air_date || "").slice(0, 10),
                poster: season.poster_path ? `/tmdb-image/w342${season.poster_path}` : "",
              })),
          };
          tmdbCache.set(cacheKey, payload, 30 * 60 * 1000, 6 * 60 * 60 * 1000);
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "TMDB season list unavailable" }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
          });
        }
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=1800, stale-while-revalidate=7200",
        },
      });
    }

    const tmdbSeasonMatch = url.pathname.match(/^\/api\/tmdb\/tv\/([^/]+)\/season\/([^/]+)$/);
    if (tmdbSeasonMatch) {
      const tvId = sanitizeText(decodeURIComponent(tmdbSeasonMatch[1]), 24);
      const seasonNumber = parseInt(decodeURIComponent(tmdbSeasonMatch[2]), 10);
      if (!/^\d+$/.test(tvId) || !Number.isFinite(seasonNumber) || seasonNumber < 0) {
        return new Response(JSON.stringify({ success: false, error: "Invalid season request" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const cacheKey = `tv-season:${tvId}:${seasonNumber}`;
      const hit = tmdbCache.get(cacheKey);
      let payload = hit && hit.fresh ? hit.value : null;
      if (!payload) {
        try {
          const data = await tmdbRequest(`tv/${tvId}/season/${seasonNumber}`, {});
          payload = {
            success: true,
            id: tvId,
            season_number: seasonNumber,
            name: sanitizeText(data.name || `Season ${seasonNumber}`, 120),
            episodes: (data.episodes || []).map((episode) => ({
              episode_number: Number(episode.episode_number) || 0,
              season_number: Number(episode.season_number) || seasonNumber,
              name: sanitizeText(episode.name || "", 160),
              overview: sanitizeText(episode.overview, 600),
              air_date: String(episode.air_date || "").slice(0, 10),
              runtime: Number(episode.runtime) || 0,
              rating: episode.vote_average ? Number(episode.vote_average).toFixed(1) : "",
              still: episode.still_path ? `/tmdb-image/w300${episode.still_path}` : "",
            })),
          };
          tmdbCache.set(cacheKey, payload, 30 * 60 * 1000, 6 * 60 * 60 * 1000);
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "TMDB season unavailable" }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
          });
        }
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=1800, stale-while-revalidate=7200",
        },
      });
    }

    // 8d. Lightweight engagement telemetry (Phase 6). No PII, bounded counters.
    if (url.pathname === "/api/telemetry/engagement" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const eventName = String((body && body.event) || "").toLowerCase();
      if (!ENGAGEMENT_EVENTS.has(eventName)) {
        return new Response(JSON.stringify({ success: false, error: "Unknown engagement event" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }
      const assetId = sanitizeText((body && (body.assetId || body.asset_id)) || "", 80);
      recordEngagement(eventName, assetId);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      });
    }

    // 3. Playback Session Token Issuance
    if (url.pathname === "/v1/playback-sessions" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const assetID = body.asset_id || url.searchParams.get("asset_id");
        if (!assetID) {
          return new Response(JSON.stringify({ error: "missing required asset_id" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        const ttlSec = parseInt(body.ttl || "900", 10);
        const token = await wasmIssueToken(assetID, clientIP, ttlSec, secretSpec);

        return new Response(JSON.stringify({
          token,
          asset_id: assetID,
          client_ip: clientIP,
          expires_in: ttlSec,
          stream_url: `${url.origin}/hls/${encodeURIComponent(assetID)}/master.m3u8?token=${token}`,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // 4. Dynamic Server Switching Source API (/api/source/:type/:id)
    const apiSourceMovie = url.pathname.match(/^\/api\/source\/([^/]+)\/([^/]+)$/);
    const apiSourceTV = url.pathname.match(/^\/api\/source\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);

    if (apiSourceMovie || apiSourceTV) {
      const type = apiSourceMovie ? apiSourceMovie[1] : apiSourceTV[1];
      const id = apiSourceMovie ? apiSourceMovie[2] : apiSourceTV[2];
      const season = apiSourceTV ? parseInt(apiSourceTV[3], 10) : 0;
      const episode = apiSourceTV ? parseInt(apiSourceTV[4], 10) : 0;
      const providerParam = String(url.searchParams.get("provider") || "").trim();
      const provider = providerParam ? normalizeProvider(providerParam) : "";
      const assetInfo = { type, id, season, episode };
      const assetID = season > 0 ? `tv-${id}-${season}-${episode}` : `movie-${id}`;

      // Optional token verification: when a token is supplied it must be valid
      // for this exact asset, otherwise we issue a fresh one.
      let token = url.searchParams.get("token") || request.headers.get("X-Playback-Token") || "";
      if (token) {
        const valid = await wasmVerifyToken(assetID, clientIP, token, secretSpec, { bindClientIP });
        if (!valid) token = "";
      }
      if (!token) {
        token = await wasmIssueToken(assetID, clientIP, 10800, secretSpec);
      }

      const resolved = await resolveUpstreamSource(assetInfo, provider, {
        env,
        waitUntil: ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : null,
      });
      if (!resolved || !resolved.streamUrl || !isStreamUrlUsable(resolved.streamUrl)) {
        return new Response(JSON.stringify({
          success: false,
          error: "No usable stream source is currently available for this title.",
        }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        });
      }

      const encodedAsset = encodeURIComponent(assetID);
      const encodedToken = encodeURIComponent(token);
      const masterUrl = `${url.origin}/hls/${encodedAsset}/master.m3u8?token=${encodedToken}`;

      const sanitizeAudio = (tracks) =>
        (Array.isArray(tracks) ? tracks : [])
          .map((track, index) => {
            if (!track) return null;
            const rawUri = track.uri || track.url || "";
            let safeUri = "";
            if (rawUri) {
              try {
                safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
              } catch (e) {
                safeUri = "";
              }
            }
            const gatewayUri = safeUri
              ? `${url.origin}/hls/${encodedAsset}/res/${codec.encode(safeUri, track.provider || resolved.provider)}?token=${encodedToken}`
              : masterUrl;
            return {
              id: Number(track.id) || index,
              name: sanitizeSubtitleLabel(track.name || track.label || `Audio ${index + 1}`),
              label: sanitizeSubtitleLabel(track.label || track.name || `Audio ${index + 1}`),
              language: String(track.language || "eng").slice(0, 16),
              default: Boolean(track.default) || index === 0,
              uri: gatewayUri,
              proxied_uri: gatewayUri,
              proxiedUri: gatewayUri,
              provider: "vidlyte",
            };
          })
          .filter(Boolean);

      const sanitizeSubtitles = (subs) => {
        const seen = new Set();
        const out = [];
        (Array.isArray(subs) ? subs : []).forEach((sub) => {
          if (!sub) return;
          const rawUri = sub.url || sub.uri || "";
          if (!rawUri) return;
          let safeUri = "";
          try {
            safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
          } catch (e) {
            return;
          }
          const label = sanitizeSubtitleLabel(sub.label || sub.language || "Subtitles");
          const key = label.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          const playlist = isPlaylistUrl(safeUri);
          const gatewayUri = playlist
            ? `${url.origin}/hls/${encodedAsset}/res/${codec.encode(safeUri, sub.provider || resolved.provider)}?token=${encodedToken}`
            : `${url.origin}/stream/chunk/${codec.encode(safeUri, sub.provider || resolved.provider)}`;
          out.push({
            label,
            language: String(sub.language || "en").slice(0, 16),
            uri: gatewayUri,
            proxied_uri: gatewayUri,
            proxiedUri: gatewayUri,
            provider: "vidlyte",
          });
        });
        return out;
      };

      const sanitizeVariants = (variants) =>
        (Array.isArray(variants) ? variants : [])
          .map((variant) => {
            if (!variant) return null;
            const rawUri = variant.playlistUri || variant.uri || variant.url || "";
            if (!rawUri) return null;
            let safeUri = "";
            try {
              safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
            } catch (e) {
              return null;
            }
            const gatewayUri = `${url.origin}/hls/${encodedAsset}/res/${codec.encode(safeUri, variant.provider || resolved.provider)}?token=${encodedToken}`;
            return {
              resolution: String(variant.resolution || "Auto").slice(0, 24),
              bandwidth: Number(variant.bandwidth) || 0,
              playlistUri: gatewayUri,
              proxied_uri: gatewayUri,
              provider: "vidlyte",
            };
          })
          .filter(Boolean);

      const audioTracks = sanitizeAudio(resolved.audioTracks);
      const subtitles = sanitizeSubtitles(resolved.subtitles);
      const variants = sanitizeVariants(resolved.variants);

      let streamUrl;
      if (resolved.isMP4 || /\.mp4(\?|$)/i.test(resolved.streamUrl)) {
        try {
          const safeMp4 = assertSafeUpstreamUrl(resolved.streamUrl, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
          streamUrl = `${url.origin}/stream/chunk/${codec.encode(safeMp4, resolved.provider)}`;
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: "Resolved stream URL was rejected." }), {
            status: 403,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
          });
        }
      } else {
        streamUrl = masterUrl;
      }

      return new Response(JSON.stringify({
        success: true,
        stream_url: streamUrl,
        streams: [{
          url: streamUrl,
          provider: resolved.provider,
          label: providerLabel(resolved.provider),
          is_mp4: Boolean(resolved.isMP4),
        }],
        provider: resolved.provider,
        title: resolved.title,
        audio_tracks: audioTracks,
        subtitles,
        variants,
        token,
        asset_id: assetID,
        expires_in: 10800,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      });
    }

    // 5. HLS Master Manifest Gateway
    // The upstream URL is never accepted from the client: it is always resolved
    // server-side from the signed asset identifier.
    const hlsMasterMatch = url.pathname.match(/^\/hls\/([^/]+)\/master\.m3u8$/);
    if (hlsMasterMatch) {
      const assetID = decodeURIComponent(hlsMasterMatch[1]);
      const token = url.searchParams.get("token") || request.headers.get("X-Playback-Token");

      if (!token) {
        return new Response("Unauthorized: missing playback token", {
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const isValid = await wasmVerifyToken(assetID, clientIP, token, secretSpec, { bindClientIP });
      if (!isValid) {
        return new Response("Unauthorized: invalid or expired playback token", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const assetInfo = parseAssetInfo(assetID);
      const resolved = await resolveUpstreamSource(assetInfo, url.searchParams.get("provider") || undefined, {
        env,
        waitUntil: ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : null,
      });

      if (!resolved || !resolved.streamUrl || !isStreamUrlUsable(resolved.streamUrl)) {
        return new Response("Stream not available or upstream resolving failed.", {
          status: 404,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/plain",
          },
        });
      }

      // 5a. Direct MP4 Single-Chunk RFC 8216 HLS Manifest
      if (resolved.isMP4 || /\.mp4(\?|$)/i.test(resolved.streamUrl)) {
        let safeMp4;
        try {
          safeMp4 = assertSafeUpstreamUrl(resolved.streamUrl, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
        } catch (e) {
          return new Response("Upstream source rejected", {
            status: 403,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
        const proxiedMP4 = `${url.origin}/stream/chunk/${codec.encode(safeMp4, resolved.provider)}`;
        const syntheticM3U8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7200\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:7200.0,\n${proxiedMP4}\n#EXT-X-ENDLIST\n`;

        return new Response(syntheticM3U8, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, no-cache, no-store",
          },
        });
      }

      // 5b. Fetch raw manifest (cached by upstream URL only) or use synthesized manifest,
      // and rewrite it per request with the requester's own token.
      try {
        let rawM3U8 = resolved.masterManifest || "";
        let effectiveBaseUrl = resolved.streamUrl;
        if (!rawM3U8) {
          try {
            rawM3U8 = await fetchRawManifest(resolved.streamUrl, resolved.provider, request, env);
          } catch (fetchErr) {
            if (resolved.backupStreamUrl && resolved.backupStreamUrl !== resolved.streamUrl) {
              rawM3U8 = await fetchRawManifest(resolved.backupStreamUrl, resolved.provider, request, env);
              effectiveBaseUrl = resolved.backupStreamUrl;
            } else {
              throw fetchErr;
            }
          }
        }
        const rewrittenM3U8 = rewriteManifest(rawM3U8, {
          baseUrl: effectiveBaseUrl,
          assetId: assetID,
          token,
          origin: url.origin,
          provider: resolved.provider,
          codec,
        });

        return new Response(rewrittenM3U8, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, max-age=5, must-revalidate",
          },
        });
      } catch (err) {
        // The cached or last-good source may point at a provider whose manifest
        // just died. Walk the remaining providers once before returning an
        // error, so a stale cache entry cannot take the title down.
        try {
          const fallback = await resolveFallbackSource(assetInfo, resolved.provider, env);
          if (fallback && fallback.streamUrl && isStreamUrlUsable(fallback.streamUrl)) {
            let fallbackManifest = fallback.masterManifest || "";
            if (!fallbackManifest) {
              fallbackManifest = await fetchRawManifest(fallback.streamUrl, fallback.provider, request, env);
            }
            const rewrittenFallback = rewriteManifest(fallbackManifest, {
              baseUrl: fallback.streamUrl,
              assetId: assetID,
              token,
              origin: url.origin,
              provider: fallback.provider,
              codec,
            });
            return new Response(rewrittenFallback, {
              status: 200,
              headers: {
                "Content-Type": "application/vnd.apple.mpegurl",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "private, max-age=5, must-revalidate",
              },
            });
          }
        } catch (fallbackErr) {}

        const status = err instanceof UpstreamUrlError ? 403 : 502;
        return new Response(`Gateway error: ${status === 403 ? "upstream rejected" : "manifest fetch failed"} (${err.message})`, {
          status,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // 6. Legacy raw-resource gateway removed: it exposed upstream URLs in the
    // request path. All sub-resources now use opaque /res/:token routes.

    // 7. Edge Segment & Stream Proxy with Swarm Failover & Byte-Range Streaming
    // Legacy open-proxy surface: restricted to safe, allowlisted upstream hosts.
    if (url.pathname === "/proxy") {
      const rawTarget = url.searchParams.get("url");
      if (!rawTarget) {
        return new Response("Missing target 'url' parameter.", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      let targetUrl;
      try {
        targetUrl = assertSafeUpstreamUrl(rawTarget, {
          requireAllowlist: true,
          extraAllowlist: env.UPSTREAM_ALLOWLIST,
        });
      } catch (e) {
        return new Response("Target URL rejected.", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      const provider = normalizeProvider(url.searchParams.get("provider") || "framextv");
      return proxyUpstream(request, targetUrl, provider, env, codec);
    }

    // 8. Universal Embed Player with Full Go Feature Parity
    const embedMovieMatch = url.pathname.match(/^\/embed\/movie\/([^/]+)/);
    const embedTvMatch = url.pathname.match(/^\/embed\/tv\/([^/]+)\/([^/]+)\/([^/]+)/);
    const embedGenericMatch = url.pathname.match(/^\/embed\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);

    if (embedMovieMatch || embedTvMatch || embedGenericMatch) {
      let type = "movie";
      let id = "";
      let season = 0;
      let episode = 0;

      if (embedTvMatch) {
        type = "tv";
        id = embedTvMatch[1];
        season = parseInt(embedTvMatch[2], 10);
        episode = parseInt(embedTvMatch[3], 10);
      } else if (embedGenericMatch) {
        type = embedGenericMatch[1];
        id = embedGenericMatch[2];
        season = parseInt(embedGenericMatch[3], 10);
        episode = parseInt(embedGenericMatch[4], 10);
      } else {
        id = embedMovieMatch[1];
      }

      const assetInfo = { type, id, season, episode };
      const assetID = season > 0 ? `tv-${id}-${season}-${episode}` : `movie-${id}`;

      // Automatically issue token via Go Wasm engine
      const token = await wasmIssueToken(assetID, clientIP, 10800, secretSpec);

      // Resolve rich stream metadata (audio tracks, servers, subtitles).
      // Server-side resolution can legitimately fail for providers whose APIs
      // are origin-gated. In that case we still render the player and let the
      // browser resolve the signed upstream URL (see clientResolve below).
      let resolved = null;
      try {
        resolved = await resolveUpstreamSource(assetInfo, undefined, {
          env,
          waitUntil: ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : null,
        });
      } catch (e) {
        resolved = null;
      }

      const serverStreamUsable = Boolean(
        resolved && resolved.streamUrl && isStreamUrlUsable(resolved.streamUrl)
      );

      // Sanitize audio tracks for player popover menu
      const sanitizedAudio = ((resolved && resolved.audioTracks) || [])
        .map((trk, index) => {
          if (!trk) return null;
          let trackUri = "";
          if (trk.uri) {
            try {
              const safeUri = assertSafeUpstreamUrl(trk.uri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
              trackUri = `${url.origin}/hls/${encodeURIComponent(assetID)}/res/${codec.encode(safeUri, trk.provider || (resolved && resolved.provider) || "bigbang")}?token=${encodeURIComponent(token)}`;
            } catch (e) {
              trackUri = "";
            }
          }
          if (!trackUri && resolved && resolved.isMP4 && resolved.streamUrl) {
            trackUri = `${url.origin}/stream/chunk/${codec.encode(resolved.streamUrl, resolved.provider)}`;
          }
          return {
            name: sanitizeSubtitleLabel(trk.name || trk.label || `Audio ${index + 1}`),
            label: sanitizeSubtitleLabel(trk.label || trk.name || `Audio ${index + 1}`),
            language: String(trk.language || "eng").slice(0, 16),
            default: trk.default || false,
            uri: trackUri,
            proxiedUri: trackUri,
            proxied_uri: trackUri,
            provider: "vidlyte",
          };
        })
        .filter((track) => track && track.uri);

      // Sanitize subtitle tracks (strip "Subtitles •", server branding, and deduplicate)
      const seenSubLabels = new Set();
      const sanitizedSubs = [];
      ((resolved && resolved.subtitles) || []).forEach((sub) => {
        if (!sub) return;
        const rawSubUrl = sub.url || sub.uri || "";
        if (!rawSubUrl) return;
        let safeSubUrl = "";
        try {
          safeSubUrl = assertSafeUpstreamUrl(rawSubUrl, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
        } catch (e) {
          return;
        }
        const opaque = codec.encode(safeSubUrl, (resolved && resolved.provider) || "bigbang");
        const proxiedSub = isPlaylistUrl(safeSubUrl)
          ? `${url.origin}/hls/${encodeURIComponent(assetID)}/res/${opaque}?token=${encodeURIComponent(token)}`
          : `${url.origin}/stream/chunk/${opaque}`;
        const cleanLabel = sanitizeSubtitleLabel(sub.label || sub.language || "Subtitles");
        const labelKey = cleanLabel.toLowerCase();
        if (!seenSubLabels.has(labelKey)) {
          seenSubLabels.add(labelKey);
          sanitizedSubs.push({
            label: cleanLabel,
            language: String(sub.language || "en").slice(0, 16),
            uri: proxiedSub,
            proxiedUri: proxiedSub,
            provider: "vidlyte",
          });
        }
      });

      // Sanitize quality variants
      const sanitizedVariants = ((resolved && resolved.variants) || [])
        .map((v) => {
          if (!v) return null;
          const rawUri = v.playlistUri || v.uri || v.url || "";
          if (!rawUri) return null;
          let safeUri = "";
          try {
            safeUri = assertSafeUpstreamUrl(rawUri, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
          } catch (e) {
            return null;
          }
          const opaque = codec.encode(safeUri, v.provider || (resolved && resolved.provider) || "bigbang");
          const proxiedVar = `${url.origin}/hls/${encodeURIComponent(assetID)}/res/${opaque}?token=${encodeURIComponent(token)}`;
          return {
            resolution: String(v.resolution || "Auto").slice(0, 24),
            bandwidth: Number(v.bandwidth) || 0,
            playlistUri: proxiedVar,
            proxiedUri: proxiedVar,
            provider: "vidlyte",
          };
        })
        .filter(Boolean);

      const isMP4 = Boolean(
        resolved && (resolved.isMP4 || /\.mp4(\?|$)/i.test(resolved.streamUrl || ""))
      );
      let streamUrl = "";
      if (serverStreamUsable) {
        if (isMP4) {
          let safeMp4;
          try {
            safeMp4 = assertSafeUpstreamUrl(resolved.streamUrl, { extraAllowlist: env.UPSTREAM_ALLOWLIST }).toString();
          } catch (e) {
            safeMp4 = resolved.streamUrl;
          }
          streamUrl = `${url.origin}/stream/chunk/${codec.encode(safeMp4, resolved.provider)}`;
        } else {
          streamUrl = `${url.origin}/hls/${encodeURIComponent(assetID)}/master.m3u8?token=${encodeURIComponent(token)}`;
        }
      }

      const domainCheck = recordDomainImpression(request, assetID);
      if (domainCheck.blocked) {
        return new Response(`<!DOCTYPE html><html><body style="background:#0b0b0d;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;padding:20px;"><h2>Access Suspended</h2><p style="color:#94a3b8;">Embedding on domain <b>${escapeHTML(domainCheck.host)}</b> has been blocked by administrator.</p></div></body></html>`, {
          status: 403,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const bootstrap = {
        assetId: assetID,
        streamUrl: streamUrl,
        mediaType: type === "tv" ? "tv" : "movie",
        tmdbId: id,
        season: season,
        episode: episode,
        title: (resolved && resolved.title) || "",
        kicker: type === "tv" ? `Season ${season} · Episode ${episode}` : "",
        year: (resolved && resolved.year) || "",
        rating: (resolved && resolved.rating) || "",
        genres: (resolved && resolved.genres) || [],
        overview: (resolved && resolved.overview) || "",
        logoUrl: (resolved && resolved.logoUrl) || "",
        poster: (resolved && (resolved.posterUrl || resolved.backdropUrl)) || "",
        backdropUrl: (resolved && resolved.backdropUrl) || "",
        posterUrl: (resolved && resolved.posterUrl) || "",
        autoplay: true,
        muted: false,
        token: token,
        playbackToken: token,
        provider: (resolved && resolved.provider) || "",
        currentServer: (resolved && resolved.provider) || "",
        isMP4: isMP4,
        clientResolve: {
          enabled: true,
          bootUrl: `https://embed.vidrift.net/api/boot/${type}/${encodeURIComponent(id)}${type === "tv" ? `/${season}/${episode}` : ""}`,
          sourceUrl: `https://embed.vidrift.net/api/source/${type}/${encodeURIComponent(id)}${type === "tv" ? `/${season}/${episode}` : ""}`,
          parent: "vidrift.net",
          gateway: `${url.origin}/hls/${encodeURIComponent(assetID)}/client.m3u8`,
          token: token,
          provider: "bigbang",
          // External resolver (GitHub Actions) for viewers whose browser or
          // network blocks vidrift. Disabled when the dispatch token is absent.
          remote: {
            enabled: Boolean(env && env.GITHUB_DISPATCH_TOKEN),
            resolve: `${url.origin}/api/multi-audio/resolve`,
            status: `${url.origin}/api/multi-audio/status`,
            gateway: `${url.origin}/hls/${encodeURIComponent(assetID)}/remote.m3u8`,
            asset: normalizeMultiAudioAsset(
              type === "tv" ? `tv/${id}/${season}/${episode}` : `movie/${id}`
            ),
          },
        },
        servers: (runtimeConfig.upstreams || [])
          .filter((upstream) => upstream && upstream.enabled !== false)
          .sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99))
          .map((upstream) => ({
            id: normalizeProvider(upstream.id),
            label: providerLabel(normalizeProvider(upstream.id)),
          })),
        subtitles: sanitizedSubs,
        audioTracks: sanitizedAudio,
        variants: sanitizedVariants,
        adConfig: {
          enabled: runtimeConfig.monetization.popunders_enabled,
          smartlinkUrl: runtimeConfig.monetization.smartlink_url,
          maxPopunders: runtimeConfig.monetization.max_popunders_per_session,
          cooldownMins: runtimeConfig.monetization.cooldown_minutes,
          triggerEvent: runtimeConfig.monetization.trigger_event,
          antiAdblockEnabled: runtimeConfig.monetization.anti_adblock_enabled,
          antiAdblockStrictBrave: runtimeConfig.monetization.anti_adblock_strict_brave,
          antiAdblockMessage: runtimeConfig.monetization.anti_adblock_message,
        },
        serverBranding: runtimeConfig.server_branding,
      };

      const renderedHTML = renderFullPlayerHTML(bootstrap, cspNonce);

      return new Response(renderedHTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 8e. Unknown API routes return JSON, never the portal HTML.
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ success: false, error: "Not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }

    // 9. Root Portal / Landing / Live Tester
    return new Response(renderPortalHTML(url.origin, cspNonce), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
}

/**
 * Fetch a raw (un-rewritten) HLS manifest with two cache layers:
 *  - per-isolate memory keyed by upstream URL
 *  - Cache API keyed by upstream URL + Range (shared across isolates/colos)
 *
 * Manifests are never cached after rewriting, so one requester's token can
 * never leak into another requester's playlist.
 */
async function fetchRawManifest(upstreamUrl, provider, request, env) {
  const safeUrl = assertSafeUpstreamUrl(upstreamUrl, { extraAllowlist: env && env.UPSTREAM_ALLOWLIST }).toString();
  const now = Date.now();

  const memoryHit = rawManifestCache.get(safeUrl);
  if (memoryHit && now < memoryHit.expiresAt) {
    return memoryHit.body;
  }

  const cacheKeyUrl = `${safeUrl}::manifest`;
  let cache = null;
  try {
    cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch (e) {
    cache = null;
  }

  if (cache) {
    try {
      const cachedResponse = await cache.match(cacheKeyUrl);
      if (cachedResponse && cachedResponse.ok) {
        const body = await cachedResponse.text();
        rawManifestCache.set(safeUrl, { body, expiresAt: now + RAW_MANIFEST_TTL_MS });
        return body;
      }
    } catch (e) {
      // Cache API failures must never break playback.
    }
  }

  const targetUrl = new URL(safeUrl);
  const reqHeaders = getUpstreamHeaders(provider, targetUrl, request.headers);
  const hostKey = `host:${targetUrl.hostname}`;
  const startedAt = Date.now();

  if (hostBreakers.isOpen(hostKey)) {
    throw new Error(`Upstream host circuit open: ${targetUrl.hostname}`);
  }

  let response;
  try {
    response = await retryWithJitter(
      async () => {
        let res = await fetchWithSwarmFallback(
          safeUrl,
          { headers: reqHeaders, cf: { cacheEverything: true, cacheTtl: 30 } },
          env
        );

        if (!res.ok && !reqHeaders.get("Referer")?.includes("embed.vidrift.net")) {
          const retryHeaders = new Headers(reqHeaders);
          retryHeaders.set("Origin", "https://embed.vidrift.net");
          retryHeaders.set("Referer", "https://embed.vidrift.net/");
          const retryResponse = await fetchWithSwarmFallback(
            safeUrl,
            { headers: retryHeaders, cf: { cacheEverything: true, cacheTtl: 30 } },
            env
          );
          if (retryResponse.ok) res = retryResponse;
        }

        // Retry only transient failures; deterministic 4xx responses are final.
        if (!res.ok && (res.status === 429 || res.status >= 500)) {
          throw new Error(`Upstream manifest returned ${res.status}`);
        }
        return res;
      },
      { attempts: 2, baseMs: 150, maxMs: 600 }
    );
  } catch (error) {
    hostBreakers.recordFailure(hostKey, error);
    throw error;
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      hostBreakers.recordFailure(hostKey, new Error(`http_${response.status}`));
    }
    throw new Error(`Upstream manifest returned ${response.status}`);
  }

  hostBreakers.recordSuccess(hostKey, Date.now() - startedAt);

  const body = await response.text();
  rawManifestCache.set(safeUrl, { body, expiresAt: now + RAW_MANIFEST_TTL_MS });

  if (cache) {
    try {
      const cacheHeaders = new Headers({
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "public, max-age=30",
      });
      const cacheable = new Response(body, { status: 200, headers: cacheHeaders });
      await cache.put(cacheKeyUrl, cacheable);
    } catch (e) {
      // ignore cache write failures
    }
  }

  return body;
}

/**
 * High-speed Edge Proxy Streaming Pipeline with Multi-Worker Swarm Failover
 */
async function proxyUpstream(request, targetUrl, provider, env, codec = null) {
  const safeTarget = assertSafeUpstreamUrl(targetUrl.toString(), {
    extraAllowlist: env && env.UPSTREAM_ALLOWLIST,
  });
  const targetString = safeTarget.toString();
  const reqHeaders = getUpstreamHeaders(provider, safeTarget, request.headers);

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    reqHeaders.set("Range", rangeHeader);
  }

  const p = safeTarget.pathname.toLowerCase();
  const isSubtitle =
    safeTarget.hostname.includes("strem.io") ||
    p.includes("/subtitles/") ||
    p.includes("/subtitle/") ||
    p.endsWith(".srt") ||
    p.endsWith(".vtt") ||
    p.endsWith(".ass") ||
    p.endsWith(".ssa");

  const cache = (() => {
    try {
      return typeof caches !== "undefined" && caches.default ? caches.default : null;
    } catch (e) {
      return null;
    }
  })();

  /* ---------------------------- Subtitles ---------------------------- */
  if (isSubtitle) {
    const memoryKey = targetString;
    const cached = subtitleMemoryCache.get(memoryKey);
    if (cached && Date.now() < cached.expiresAt) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          "Content-Type": cached.contentType || "text/vtt; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    }

    try {
      let response = await fetchWithSwarmFallback(targetString, {
        method: "GET",
        headers: reqHeaders,
        redirect: "follow",
        cf: { cacheEverything: true, cacheTtl: 86400 },
      }, env);

      if (!response.ok && !reqHeaders.get("Referer")?.includes("embed.vidrift.net")) {
        const retryHeaders = new Headers(reqHeaders);
        retryHeaders.set("Origin", "https://embed.vidrift.net");
        retryHeaders.set("Referer", "https://embed.vidrift.net/");
        const retryResponse = await fetchWithSwarmFallback(targetString, {
          method: "GET",
          headers: retryHeaders,
          redirect: "follow",
          cf: { cacheEverything: true, cacheTtl: 86400 },
        }, env);
        if (retryResponse.ok) response = retryResponse;
      }

      if (!response.ok) {
        return new Response("WEBVTT\n\n", {
          status: 200,
          headers: {
            "Content-Type": "text/vtt; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Cache-Control": "public, max-age=60",
          },
        });
      }

      const buffer = await response.arrayBuffer();
      const converted = toVttFromBytes(new Uint8Array(buffer));

      subtitleMemoryCache.set(memoryKey, {
        body: converted.text,
        contentType: converted.contentType,
        expiresAt: Date.now() + 86400 * 1000,
      });

      return new Response(converted.text, {
        status: 200,
        headers: {
          "Content-Type": converted.contentType,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    } catch (e) {
      return new Response("WEBVTT\n\n", {
        status: 200,
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Cache-Control": "public, max-age=60",
        },
      });
    }
  }

  /* --------------------------- Media chunks -------------------------- */
  const isMediaChunk = !isPlaylistUrl(targetString);
  const cacheKey = `${targetString}::${rangeHeader || "full"}`;

  if (cache && isMediaChunk && !rangeHeader && request.method === "GET") {
    try {
      const cachedChunk = await cache.match(cacheKey);
      if (cachedChunk && cachedChunk.ok) {
        return cachedChunk;
      }
    } catch (e) {
      // ignore cache read failures
    }
  }

  try {
    const fetchInit = {
      method: request.method,
      headers: reqHeaders,
      redirect: "follow",
    };
    if (isMediaChunk) {
      fetchInit.cf = { cacheEverything: true, cacheTtl: 86400 };
    }

    let upstreamResp = await fetchWithSwarmFallback(targetString, fetchInit, env);

    if ((upstreamResp.status === 403 || upstreamResp.status === 401) && !reqHeaders.get("Referer")?.includes("embed.vidrift.net")) {
      const retryHeaders = new Headers(reqHeaders);
      retryHeaders.set("Origin", "https://embed.vidrift.net");
      retryHeaders.set("Referer", "https://embed.vidrift.net/");
      const retryInit = {
        method: request.method,
        headers: retryHeaders,
        redirect: "follow",
      };
      if (isMediaChunk) {
        retryInit.cf = { cacheEverything: true, cacheTtl: 86400 };
      }
      const retryResp = await fetchWithSwarmFallback(targetString, retryInit, env);
      if (retryResp.ok) {
        upstreamResp = retryResp;
      }
    }

    const resHeaders = new Headers(upstreamResp.headers);
    resHeaders.set("Access-Control-Allow-Origin", "*");
    resHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    resHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
    resHeaders.delete("Set-Cookie");

    const upstreamType = (resHeaders.get("Content-Type") || "").toLowerCase();
    const isActualPlaylist = !isMediaChunk || upstreamType.includes("mpegurl");

    if (!isActualPlaylist) {
      resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      // Some MP4 origins omit Accept-Ranges even though they honour Range.
      // Advertising it keeps browser seeking/scrubbing reliable.
      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }
      const fullTargetLower = targetString.toLowerCase();
      if (
        !upstreamType ||
        upstreamType.includes("octet-stream") ||
        upstreamType.includes("binary") ||
        upstreamType.includes("image/") ||
        upstreamType.includes("text/html") ||
        upstreamType.includes("text/plain")
      ) {
        if (fullTargetLower.includes(".m4s") || fullTargetLower.includes(".mp4") || fullTargetLower.includes("init-")) {
          resHeaders.set("Content-Type", "video/mp4");
        } else if (fullTargetLower.includes(".aac")) {
          resHeaders.set("Content-Type", "audio/aac");
        } else {
          resHeaders.set("Content-Type", "video/mp2t");
        }
      }
    } else {
      resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      resHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
      const text = await upstreamResp.text();
      if (text.trim().startsWith("#EXTM3U") || text.includes("#EXTINF") || text.includes("#EXTM3U")) {
        const activeCodec = codec || createOpaqueCodec(parseSecretKeys(env && env.HMAC_SECRET).primarySecret);
        const reqOrigin = new URL(request.url).origin;
        const rewritten = rewriteManifest(text, {
          baseUrl: targetString,
          origin: reqOrigin,
          provider,
          codec: activeCodec,
        });
        return new Response(rewritten, {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: resHeaders,
        });
      }
      return new Response(text, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: resHeaders,
      });
    }

    if (cache && isMediaChunk && !rangeHeader && request.method === "GET" && upstreamResp.ok) {
      try {
        const cacheable = new Response(upstreamResp.clone().body, {
          status: 200,
          headers: resHeaders,
        });
        await cache.put(cacheKey, cacheable);
      } catch (e) {
        // ignore cache write failures
      }
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Edge fetch failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });
  }
}

/**
 * Multi-worker Swarm Failover Pipeline
 */
async function fetchWithSwarmFallback(targetURL, init = {}, env) {
  const requestHeaders = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
  const directHeaders = new Headers(requestHeaders);
  directHeaders.delete("X-VidLyte-Swarm");
  const directInit = { ...init, headers: directHeaders };

  // Never re-swarm a request that is already being relayed by another node.
  if (init.swarmRelay || requestHeaders.get("X-VidLyte-Swarm") === "1") {
    return fetch(targetURL, directInit);
  }

  try {
    await ensureRuntimeConfig(env);
  } catch (e) {}

  const nodes = orderSwarmNodes(collectSwarmNodes(env)).slice(0, 5);
  if (nodes.length === 0) {
    return fetch(targetURL, directInit);
  }

  const isMediaChunk = !/\.m3u8(\?|$)/i.test(targetURL) && !/\.(vtt|srt)(\?|$)/i.test(targetURL);
  const timeoutMs = Number(init.swarmTimeoutMs) || (isMediaChunk ? 2500 : 1800);

  for (const node of nodes) {
    const started = Date.now();
    try {
      const relayHeaders = new Headers(requestHeaders);
      relayHeaders.set("X-VidLyte-Swarm", "1");
      const relayInit = {
        ...init,
        headers: relayHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      };
      const response = await fetch(`${node}/proxy?url=${encodeURIComponent(targetURL)}`, relayInit);
      const latency = Date.now() - started;

      if (response.ok) {
        swarmState.set(node, { latencyMs: latency, failures: 0, blockedUntil: 0 });
        return response;
      }

      const previous = swarmState.get(node) || { failures: 0, latencyMs: 0 };
      const failures = (previous.failures || 0) + 1;
      swarmState.set(node, {
        latencyMs: latency,
        failures,
        blockedUntil: failures >= 3 ? Date.now() + 60 * 1000 : 0,
      });
      try {
        await response.arrayBuffer();
      } catch (e) {}
    } catch (e) {
      const previous = swarmState.get(node) || { failures: 0, latencyMs: 0 };
      const failures = (previous.failures || 0) + 1;
      swarmState.set(node, {
        latencyMs: previous.latencyMs || 0,
        failures,
        blockedUntil: failures >= 3 ? Date.now() + 60 * 1000 : 0,
      });
    }
  }

  // Final fallback to direct fetch.
  return fetch(targetURL, directInit);
}

/**
 * Builds a unified RFC 8216 HLS Master Manifest combining all quality variants & regional dubs
 */
function buildUnifiedMasterManifest(assetID, token, resolved, codec, origin) {
  let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n\n";

  // 1. Subtitles (deduplicated & cleaned)
  if (resolved.subtitles && resolved.subtitles.length > 0) {
    const seenSubs = new Set();
    let hasDefaultSub = false;
    resolved.subtitles.forEach((s) => {
      const cleanLabel = (s.label || s.language || "English")
        .replace(/^Subtitles\s*[•·\-–—]\s*/i, "")
        .replace(/\s*[-·]\s*Server\s*\d+.*/gi, "")
        .replace(/\s*\([^)]*Server[^)]*\)/gi, "")
        .replace(/\s*\(\d+\)$/, "")
        .trim();
      const key = (cleanLabel || s.language || "en").toLowerCase();
      if (!seenSubs.has(key)) {
        seenSubs.add(key);
        const opaque = codec.encode(s.url, resolved.provider);
        const subUri = `${origin}/hls/${encodeURIComponent(assetID)}/res/${opaque}?token=${encodeURIComponent(token)}`;
        const isDef = (!hasDefaultSub && (s.language === "en" || cleanLabel.toLowerCase() === "english")) ? "YES" : "NO";
        if (isDef === "YES") hasDefaultSub = true;
        m3u8 += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${cleanLabel}",DEFAULT=${isDef},AUTOSELECT=YES,FORCED=NO,LANGUAGE="${s.language}",URI="${subUri}"\n`;
      }
    });
    m3u8 += "\n";
  }

  // 2. Audio Tracks (English 5.1, Hindi, Telugu, Tamil, Kannada)
  if (resolved.audioTracks && resolved.audioTracks.length > 0) {
    resolved.audioTracks.forEach((trk) => {
      const trkUri = trk.uri;
      if (trkUri) {
        const opaque = codec.encode(trkUri, trk.provider || resolved.provider);
        const audioResUri = `${origin}/hls/${encodeURIComponent(assetID)}/res/${opaque}?token=${encodeURIComponent(token)}`;
        const isDef = trk.default ? "YES" : "NO";
        m3u8 += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${trk.language || "eng"}",NAME="${trk.name}",DEFAULT=${isDef},AUTOSELECT=YES,URI="${audioResUri}"\n`;
      }
    });
    m3u8 += "\n";
  }

  // 3. Video Qualities (Guaranteed 1080p, 720p, 480p, 360p)
  const variants = (resolved.variants && resolved.variants.length > 0) ? resolved.variants : [];
  const p1080 = variants.find(v => (v.resolution || "").toLowerCase().includes("1080")) || variants[0];
  const p720 = variants.find(v => (v.resolution || "").toLowerCase().includes("720")) || p1080;
  const p480 = variants.find(v => (v.resolution || "").toLowerCase().includes("480")) || p720;
  const p360 = variants.find(v => (v.resolution || "").toLowerCase().includes("360")) || p480;

  const defaultUri = resolved.streamUrl || (p1080 ? p1080.playlistUri : "");

  const fullTierQualities = [
    { name: "1080p", res: "1920x1080", bw: 2500000, uri: p1080 ? p1080.playlistUri : defaultUri },
    { name: "720p", res: "1280x720", bw: 1200000, uri: p720 ? p720.playlistUri : defaultUri },
    { name: "480p", res: "854x480", bw: 650000, uri: p480 ? p480.playlistUri : defaultUri },
    { name: "360p", res: "640x360", bw: 350000, uri: p360 ? p360.playlistUri : defaultUri },
  ];

  fullTierQualities.forEach((q) => {
    if (!q.uri) return;
    const opaque = codec.encode(q.uri, resolved.provider);
    const varUri = `${origin}/hls/${encodeURIComponent(assetID)}/res/${opaque}?token=${encodeURIComponent(token)}`;
    let subAttr = (resolved.subtitles && resolved.subtitles.length > 0) ? ',SUBTITLES="subs"' : '';
    let audAttr = (resolved.audioTracks && resolved.audioTracks.length > 0) ? ',AUDIO="audio"' : '';
    m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${q.bw},RESOLUTION=${q.res}${audAttr}${subAttr},NAME="${q.name}"\n${varUri}\n`;
  });

  return m3u8;
}

/**
 * Injects bootstrap payload into the Sovereign Player UI
 */
function applyCspNonce(html, nonce) {
  const safeNonce = String(nonce || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeNonce) return String(html || "").replace(/__CSP_NONCE__/g, "");
  return String(html || "").replace(/__CSP_NONCE__/g, safeNonce);
}

function renderFullPlayerHTML(bootstrap, nonce = "") {
  const jsonConfig = JSON.stringify(bootstrap);
  return applyCspNonce(
    playerTemplate
      .replace("<title>{{.Title}}</title>", `<title>${escapeHTML(bootstrap.title)}</title>`)
      .replace(
        '<script id="embed-bootstrap" type="application/json" nonce="__CSP_NONCE__">{{.ConfigJSON}}</script>',
        `<script id="embed-bootstrap" type="application/json" nonce="${nonce}">${jsonConfig}</script>`
      ),
    nonce
  );
}

/**
 * Public Portal & Embed Documentation Dashboard
 */
function renderPortalHTML(origin, nonce = "") {
  return applyCspNonce(portalTemplate, nonce);
}

function renderAdminHTML(nonce = "") {
  return applyCspNonce(adminTemplate, nonce);
}
