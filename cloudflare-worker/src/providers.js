/**
 * VidLyte Provider Registry & AsianFlix / Rumble Resolver
 * ---------------------------------------------------------------------------
 * AsianFlix pages expose a `videoPlayerSettings` object containing one or more
 * Blogger blog ids. Each Blogger post for a title contains a playlist in the
 * form:
 *
 *   https://rumble.com/hls-vod/<id>/playlist.m3u8|English|<subtitle-url>;
 *   https://hugh.cdn.rumble.cloud/video/...mp4|English|<subtitle-url>;
 *
 * This module resolves a TMDB title to that playlist without executing any
 * page JavaScript and without depending on the obfuscated theme bundle.
 */

export const PROVIDER_DEFINITIONS = [
  { id: "orion", label: "Orion", priority: 1, hosts: ["embed.vidrift.net", "vidrift.net"] },
  { id: "evion", label: "Evion", priority: 2, hosts: ["img.animecurx.tech", "rousav.tech", "rousav.com", "bigbang.observer"] },
  { id: "framextv", label: "FrameX", priority: 3, hosts: ["api.framextv.xyz", "api.framextv.cc", "api.framextv.tech"] },
  { id: "kisskh", label: "KissKH", priority: 4, hosts: ["kisskh.is", "kisskh.co", "videocdndelivery05.site", "cdnvideo11.shop", "dwish.pro"] },
  { id: "asianflix", label: "AsianFlix", priority: 5, hosts: ["asianflix.one", "rumble.com", "rumble.cloud"] },
  { id: "2vcdn", label: "2Embed", priority: 6, hosts: ["2embed.cc", "2vcdn.skin"] },
];

const PROVIDER_ALIASES = {
  server1: "framextv",
  s1: "framextv",
  framex: "framextv",
  framextv: "framextv",
  server2: "orion",
  s2: "orion",
  orion: "orion",
  vidrift: "orion",
  server3: "asianflix",
  s3: "asianflix",
  asianflix: "asianflix",
  rumble: "asianflix",
  server4: "evion",
  s4: "evion",
  evion: "evion",
  server5: "kisskh",
  s5: "kisskh",
  kisskh: "kisskh",
  kiss: "kisskh",
  "2embed": "2vcdn",
  "2vcdn": "2vcdn",
};

export function normalizeProviderId(value) {
  const key = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  return PROVIDER_ALIASES[key] || key || "framextv";
}

export function providerLabel(provider) {
  const def = PROVIDER_DEFINITIONS.find((item) => item.id === normalizeProviderId(provider));
  return def ? def.label : String(provider || "Unknown");
}

export function providerPriority(provider) {
  const def = PROVIDER_DEFINITIONS.find((item) => item.id === normalizeProviderId(provider));
  return def ? def.priority : 99;
}

export function defaultProviderOrder() {
  return PROVIDER_DEFINITIONS.slice().sort((a, b) => a.priority - b.priority).map((item) => item.id);
}

const LANGUAGE_CODES = {
  english: "eng",
  en: "eng",
  hindi: "hin",
  hi: "hin",
  spanish: "spa",
  es: "spa",
  "latin american spanish": "spa",
  "brazilian portuguese": "por",
  portuguese: "por",
  pt: "por",
  french: "fra",
  fr: "fra",
  german: "deu",
  de: "deu",
  russian: "rus",
  ru: "rus",
  ukrainian: "ukr",
  arabic: "ara",
  japanese: "jpn",
  ja: "jpn",
  korean: "kor",
  ko: "kor",
  indonesian: "ind",
  id: "ind",
  tamil: "tam",
  telugu: "tel",
  kannada: "kan",
  malayalam: "mal",
  chinese: "zho",
  zh: "zho",
  thai: "tha",
  vietnamese: "vie",
};

export function languageToCode(language) {
  const key = String(language || "").trim().toLowerCase();
  return LANGUAGE_CODES[key] || key.slice(0, 3) || "eng";
}

export function slugifyTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeTitleForMatch(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\((?:19|20)\d{2}\)/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:i['’]?m)\b/g, "i am")
    .replace(/\b(?:it['’]?s)\b/g, "it is")
    .replace(/\b(?:don['’]?t)\b/g, "do not")
    .replace(/\b(?:doesn['’]?t)\b/g, "does not")
    .replace(/\b(?:can['’]?t)\b/g, "cannot")
    .replace(/\b(?:won['’]?t)\b/g, "will not")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:i\s+m)\b/g, "i am")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleMatches(candidate, target, year) {
  const a = normalizeTitleForMatch(candidate);
  const b = normalizeTitleForMatch(target);
  if (!a || !b) return false;
  let titleOk = a === b || a.includes(b) || b.includes(a);
  if (!titleOk) {
    const aParts = String(candidate).split(/[-:]+/).map(normalizeTitleForMatch).filter(Boolean);
    const bParts = String(target).split(/[-:]+/).map(normalizeTitleForMatch).filter(Boolean);
    for (const ap of aParts) {
      for (const bp of bParts) {
        if (ap === bp || (ap.length > 3 && bp.includes(ap)) || (bp.length > 3 && ap.includes(bp))) {
          titleOk = true;
          break;
        }
      }
      if (titleOk) break;
    }
  }
  if (!titleOk) return false;
  if (!year) return true;
  const yearText = String(year);
  if (!/^\d{4}$/.test(yearText)) return true;
  const candidateYearMatch = String(candidate || "").match(/\b(?:19|20)\d{2}\b/);
  if (candidateYearMatch) {
    return candidateYearMatch[0] === yearText;
  }
  return true;
}

/**
 * Extract a balanced JSON object beginning at `start` (the index of `{`).
 * Returns the parsed object or null.
 */
export function extractBalancedJson(text, start) {
  if (typeof text !== "string" || start < 0 || text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractAsianFlixConfig(html) {
  const source = String(html || "");
  const marker = source.search(/videoPlayerSettings\s*=\s*\{/);
  if (marker < 0) return null;
  const brace = source.indexOf("{", marker);
  const settings = extractBalancedJson(source, brace);
  if (!settings) return null;

  const blogIds = [];
  const rawBlogIds = settings.bloggerAPI && settings.bloggerAPI.blogId;
  if (Array.isArray(rawBlogIds)) {
    rawBlogIds.forEach((id) => {
      const value = String(id || "").trim();
      if (/^\d{6,}$/.test(value) && !blogIds.includes(value)) blogIds.push(value);
    });
  } else if (rawBlogIds) {
    const value = String(rawBlogIds).trim();
    if (/^\d{6,}$/.test(value)) blogIds.push(value);
  }

  const ogTitle = source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const titleTag = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogImage = source.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);

  return {
    blogIds,
    title: decodeHtmlEntities((ogTitle && ogTitle[1]) || (titleTag && titleTag[1]) || "").trim(),
    posterUrl: ogImage ? decodeHtmlEntities(ogImage[1]) : "",
    license: settings.license || "",
  };
}

export function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/");
}

/**
 * Infer an episode number from a URL or filename. AsianFlix subtitle files
 * usually look like `Final_Table_2026_Ep2_xxxx.vtt`.
 */
export function inferEpisodeNumber(...values) {
  for (const value of values) {
    const text = String(value || "");
    if (!text) continue;
    const match = text.match(/(?:^|[._\-/])(?:ep|e)(\d{1,3})(?=[._\-/]|$)/i);
    if (match) {
      const number = Number(match[1]);
      if (number > 0 && number < 1000) return number;
    }
  }
  return 0;
}

/**
 * Parse the Blogger post content into ordered episode entries.
 * Content example: "https://...m3u8|English|https://...vtt;\n..."
 */
export function parseAsianFlixPlaylist(content) {
  const text = decodeHtmlEntities(String(content || ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");

  const entries = [];
  const seen = new Set();
  for (const rawLine of text.split(/[;\n]+/)) {
    const line = rawLine.trim();
    if (!line || !line.includes("|")) continue;
    const parts = line.split("|").map((part) => part.trim());
    const streamUrl = parts[0];
    if (!/^https?:\/\//i.test(streamUrl)) continue;
    if (seen.has(streamUrl)) continue;
    seen.add(streamUrl);

    const language = parts[1] || "Original";
    const subtitleUrl = /^https?:\/\//i.test(parts[2] || "") ? parts[2] : "";
    entries.push({
      streamUrl,
      language,
      subtitleUrl,
      isMP4: /\.mp4(\?|$)/i.test(streamUrl),
      episodeNumber: inferEpisodeNumber(subtitleUrl, streamUrl),
    });
  }
  return entries;
}

export function pickEpisodeEntry(entries, assetInfo = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const isTv = assetInfo.type === "tv" || assetInfo.type === "series";
  if (!isTv) return entries[0];
  const episode = Number(assetInfo.episode) || 1;

  // Prefer explicit episode numbers when the playlist exposes at least two of
  // them. This avoids off-by-one picks when a post contains trailers or
  // specials interleaved with episodes.
  const numbered = entries.filter((entry) => Number(entry && entry.episodeNumber) > 0);
  if (numbered.length >= 2) {
    return numbered.find((entry) => Number(entry.episodeNumber) === episode) || null;
  }

  const index = Math.max(0, episode - 1);
  if (entries.length === 1) return entries[0];
  return entries[index] || null;
}

function buildHeaders(extra = {}) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...extra,
  };
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 6000, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    headers: buildHeaders(headers),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  return response.text();
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * Resolve a title to an AsianFlix page. Tries an explicit override first,
 * then deterministic slug candidates, then the WordPress search endpoint.
 */
export async function findAsianFlixPage({ title, year, pageOverrides = [], fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const candidates = [];
  const push = (url) => {
    const value = String(url || "").trim();
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  pageOverrides.forEach(push);

  if (title) {
    const base = slugifyTitle(title);
    if (base) {
      if (year) push(`https://asianflix.one/${base}-${year}/`);
      push(`https://asianflix.one/${base}/`);
    }
  }

  for (const url of candidates) {
    const html = await fetchText(url, { fetchImpl, timeoutMs });
    if (!html) continue;
    const config = extractAsianFlixConfig(html);
    if (config && config.blogIds.length > 0) {
      return { url, html, config };
    }
  }

  if (!title) return null;

  const searchUrl =
    `https://asianflix.one/wp-json/wp/v2/search?search=${encodeURIComponent(title)}` +
    `&per_page=5&_fields=title,url`;
  const results = await fetchJson(searchUrl, { fetchImpl, timeoutMs, headers: { Accept: "application/json" } });
  if (!Array.isArray(results)) return null;

  const ranked = results
    .filter((item) => item && item.url && titleMatches(item.title, title, year))
    .sort((a, b) => (titleMatches(b.title, title, year) ? 1 : 0) - (titleMatches(a.title, title, year) ? 1 : 0));

  for (const item of ranked) {
    const html = await fetchText(item.url, { fetchImpl, timeoutMs });
    if (!html) continue;
    const config = extractAsianFlixConfig(html);
    if (config && config.blogIds.length > 0) {
      return { url: item.url, html, config };
    }
  }
  return null;
}

/**
 * Query a Blogger blog for a title and return the best matching post.
 */
export async function findBloggerPost({ blogId, query, year, fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const feedUrl =
    `https://www.blogger.com/feeds/${encodeURIComponent(blogId)}/posts/default` +
    `?alt=json&max-results=10&q=${encodeURIComponent(query)}`;
  const feed = await fetchJson(feedUrl, { fetchImpl, timeoutMs, headers: { Accept: "application/json" } });
  const entries = (feed && feed.feed && feed.feed.entry) || [];
  if (entries.length === 0) return null;

  const ranked = entries
    .map((entry) => {
      const title = entry && entry.title && entry.title.$t ? entry.title.$t : "";
      return { entry, title, match: titleMatches(title, query, year) };
    })
    .filter((item) => item.match)
    .sort((a, b) => {
      const aExact = normalizeTitleForMatch(a.title) === normalizeTitleForMatch(query) ? 1 : 0;
      const bExact = normalizeTitleForMatch(b.title) === normalizeTitleForMatch(query) ? 1 : 0;
      return bExact - aExact;
    });

  if (ranked.length === 0) return null;
  const content = ranked[0].entry.content && ranked[0].entry.content.$t;
  return { title: ranked[0].title, content: content || "" };
}

/**
 * Full AsianFlix resolution pipeline.
 *
 * @returns {Promise<null|{
 *   streamUrl: string, provider: string, isMP4: boolean,
 *   audioTracks: Array, subtitles: Array, pageUrl: string, title: string
 * }>}
 */
export async function resolveAsianFlix({
  assetInfo = {},
  title = "",
  year = "",
  pageOverrides = [],
  fetchImpl = fetch,
  timeoutMs = 6000,
} = {}) {
  const page = await findAsianFlixPage({ title, year, pageOverrides, fetchImpl, timeoutMs });
  if (!page) return null;

  const pageTitle = page.config.title || title;
  const query = String(pageTitle || title || "").replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
  if (!query) return null;

  const posts = await Promise.all(
    page.config.blogIds.slice(0, 4).map((blogId) =>
      findBloggerPost({ blogId, query, year, fetchImpl, timeoutMs }).catch(() => null)
    )
  );

  for (const post of posts) {
    if (!post || !post.content) continue;
    const entries = parseAsianFlixPlaylist(post.content);
    const entry = pickEpisodeEntry(entries, assetInfo);
    if (!entry) continue;

    const languageCode = languageToCode(entry.language);
    const audioTracks = [
      {
        name: entry.language || "Original",
        label: entry.language || "Original",
        language: languageCode,
        default: true,
        uri: entry.streamUrl,
        provider: "asianflix",
      },
    ];

    const subtitles = entry.subtitleUrl
      ? [
          {
            label: `${entry.language || "English"} Subtitles`,
            language: languageCode,
            url: entry.subtitleUrl,
            provider: "asianflix",
          },
        ]
      : [];

    return {
      streamUrl: entry.streamUrl,
      provider: "asianflix",
      isMP4: entry.isMP4,
      audioTracks,
      subtitles,
      variants: [],
      pageUrl: page.url,
      title: post.title || pageTitle,
      logoUrl: page.config.posterUrl || "",
      posterUrl: page.config.posterUrl || "",
    };
  }

  return null;
}

/**
 * KissKH Deterministic Crypto Engine
 * Encrypts episode request tokens without external dependencies.
 */
function createKissKHCipher() {
  function _0x1b25b9(_0x3378d3) {
    const _0x186fc8 = _0x3378d3.length;
    const _0x5ac8cf = [];
    for (let _0x2ccc5f = 0; _0x2ccc5f < _0x186fc8; _0x2ccc5f++) {
      _0x5ac8cf[_0x2ccc5f >>> 2] |= (0xff & _0x3378d3.charCodeAt(_0x2ccc5f)) << (0x18 - (_0x2ccc5f % 4) * 8);
    }
    return [_0x5ac8cf, _0x186fc8];
  }

  function _0x1c779c(_0x3ff981, _0x459037) {
    const _0x220b47 = [];
    for (let _0x44ccb3 = 0; _0x44ccb3 < _0x459037; _0x44ccb3++) {
      _0x220b47.push(((_0x3ff981[_0x44ccb3 >>> 2] >>> (0x18 - (_0x44ccb3 % 4) * 8)) & 0xff).toString(16).padStart(2, '0'));
    }
    return _0x220b47.join('');
  }

  function _0x12af79(_0x4dcec4) {
    return (_0x4dcec4 || '').substr(0, 0x30);
  }

  function _0x70dbf4(_0x524c4a) {
    let _0x109c6f = 0;
    const _0x5ebb16 = _0x524c4a.length;
    for (let _0x419dc5 = 0; _0x419dc5 < _0x5ebb16; _0x419dc5++) {
      _0x109c6f = (_0x109c6f << 5) - _0x109c6f + _0x524c4a.charCodeAt(_0x419dc5);
    }
    return _0x109c6f;
  }

  function _0x29e11d(_0x4440b3) {
    const _0x384f5f = 0x10 - (_0x4440b3.length % 0x10);
    for (let _0x120ea8 = 0; _0x120ea8 < _0x384f5f; ++_0x120ea8) {
      _0x4440b3 += String.fromCharCode(_0x384f5f);
    }
    return _0x4440b3;
  }

  function _0xaf4f42(_0x1493a6) {
    const _0x5c4ece = _0x1493a6.length;
    for (let _0x3835b2 = 0; _0x3835b2 < _0x5c4ece; _0x3835b2 += 4) {
      _0x3505d7(_0x1493a6, _0x3835b2);
    }
  }

  const _0x6b7b62 = [[0x4f6bdaa3,-0x61d07350,0x7f5e722d,-0x61210cec,0x536620a8,-0x32b653e8,-0x4de821cb,0x2cc92d21,-0x73412227,0x41f771c1,-0xc1f500c,-0x20d67d2b,0x2dadde47,0x6c5aaf86,-0x6045ff8e,0x409382a7,-0x6417db2,-0x6a1bd238,0xa5e2dba,0x4acdaf1d,0x54c72698,-0x3edcf4b0,-0x3482d916,-0x7e4f7609,-0x6c9fb16c,0x524345c4,-0x66c19cd2,0x188eead9,-0x351884c7,-0x675bc103,0x19a5dd3,0x1914b70a,-0x4fb1e313,0x28ea2210,0x29707fc3,0x3064c8c9,-0x17593e17,-0x3fb31c07,-0x16c363c6,-0x26a7ab0d,-0x4b793324,0x74ca2f25,-0x62094ce1,0x44aee7ec]];

  (function() {
    var _0x43be17 = [], _0x42a74d = [], _0xb4bd43 = [], _0x25f5e6 = [], _0x5d5f77 = [], _0x2de806 = [];
    for (let _0x21abca = 0; _0x21abca < 0x100; _0x21abca++) {
      _0x2de806[_0x21abca] = _0x21abca < 0x80 ? _0x21abca << 1 : (_0x21abca << 1) ^ 0x11b;
    }
    var _0x2119ec = 0, _0x1a0508 = 0;
    for (let _0x11eabb = 0; _0x11eabb < 0x100; _0x11eabb++) {
      var _0x5034cc = _0x1a0508 ^ (_0x1a0508 << 1) ^ (_0x1a0508 << 2) ^ (_0x1a0508 << 3) ^ (_0x1a0508 << 4);
      _0x5034cc = (_0x5034cc >>> 8) ^ (0xff & _0x5034cc) ^ 0x63;
      _0x43be17[_0x2119ec] = _0x5034cc;
      var _0x580af8 = _0x2de806[_0x2119ec];
      var _0x354320 = _0x2de806[_0x2de806[_0x580af8]];
      var _0x410b1f = 0x101 * _0x2de806[_0x5034cc] ^ (0x1010100 * _0x5034cc);
      _0x42a74d[_0x2119ec] = (_0x410b1f << 24) | (_0x410b1f >>> 8);
      _0xb4bd43[_0x2119ec] = (_0x410b1f << 16) | (_0x410b1f >>> 16);
      _0x25f5e6[_0x2119ec] = (_0x410b1f << 8) | (_0x410b1f >>> 24);
      _0x5d5f77[_0x2119ec] = _0x410b1f;
      _0x2119ec ? (_0x2119ec = _0x580af8 ^ _0x2de806[_0x2de806[_0x2de806[_0x354320 ^ _0x580af8]]], _0x1a0508 ^= _0x2de806[_0x2de806[_0x1a0508]]) : (_0x2119ec = _0x1a0508 = 1);
    }
    _0x6b7b62.push(_0x42a74d);
    _0x6b7b62.push(_0xb4bd43);
    _0x6b7b62.push(_0x25f5e6);
    _0x6b7b62.push(_0x5d5f77);
    _0x6b7b62.push(_0x43be17);
  }());

  function _0x3505d7(_0x13a508, _0x5baaa1) {
    const [_0x458390, _0x32aa26, _0x53dadc, _0x4810d1, _0x3c0f1b, _0x128bff] = _0x6b7b62;
    let _0x21ba3f;
    _0x5baaa1 === 0 ? _0x21ba3f = [0x1504af3, 0x56e619cf, 0x2e42bba6, -0x73c08f07] : _0x21ba3f = _0x13a508.slice(_0x5baaa1 - 4, _0x5baaa1);
    for (let _0x5b9637 = 0; _0x5b9637 < 4; _0x5b9637++) {
      _0x13a508[_0x5baaa1 + _0x5b9637] ^= _0x21ba3f[_0x5b9637];
    }
    for (var _0x116405 = 10,
         _0x4d3231 = _0x13a508[_0x5baaa1] ^ _0x458390[0],
         _0x1f3a4f = _0x13a508[_0x5baaa1 + 1] ^ _0x458390[1],
         _0x598b52 = _0x13a508[_0x5baaa1 + 2] ^ _0x458390[2],
         _0x2265d4 = _0x13a508[_0x5baaa1 + 3] ^ _0x458390[3],
         _0xcb5ec5 = 4,
         _0x5e2dc7 = 1; _0x5e2dc7 < _0x116405; _0x5e2dc7++) {
      var _0x34de78 = _0x32aa26[_0x4d3231 >>> 24] ^ _0x53dadc[(_0x1f3a4f >>> 16) & 0xff] ^ _0x4810d1[(_0x598b52 >>> 8) & 0xff] ^ _0x3c0f1b[0xff & _0x2265d4] ^ _0x458390[_0xcb5ec5++];
      var _0x42d7a0 = _0x32aa26[_0x1f3a4f >>> 24] ^ _0x53dadc[(_0x598b52 >>> 16) & 0xff] ^ _0x4810d1[(_0x2265d4 >>> 8) & 0xff] ^ _0x3c0f1b[0xff & _0x4d3231] ^ _0x458390[_0xcb5ec5++];
      var _0x4a8c71 = _0x32aa26[_0x598b52 >>> 24] ^ _0x53dadc[(_0x2265d4 >>> 16) & 0xff] ^ _0x4810d1[(_0x4d3231 >>> 8) & 0xff] ^ _0x3c0f1b[0xff & _0x1f3a4f] ^ _0x458390[_0xcb5ec5++];
      _0x2265d4 = _0x32aa26[_0x2265d4 >>> 24] ^ _0x53dadc[(_0x4d3231 >>> 16) & 0xff] ^ _0x4810d1[(_0x1f3a4f >>> 8) & 0xff] ^ _0x3c0f1b[0xff & _0x598b52] ^ _0x458390[_0xcb5ec5++];
      _0x4d3231 = _0x34de78; _0x1f3a4f = _0x42d7a0; _0x598b52 = _0x4a8c71;
    }
    _0x34de78 = ((_0x128bff[_0x4d3231 >>> 24] << 24) | (_0x128bff[(_0x1f3a4f >>> 16) & 0xff] << 16) | (_0x128bff[(_0x598b52 >>> 8) & 0xff] << 8) | _0x128bff[0xff & _0x2265d4]) ^ _0x458390[_0xcb5ec5++];
    _0x42d7a0 = ((_0x128bff[_0x1f3a4f >>> 24] << 24) | (_0x128bff[(_0x598b52 >>> 16) & 0xff] << 16) | (_0x128bff[(_0x2265d4 >>> 8) & 0xff] << 8) | _0x128bff[0xff & _0x4d3231]) ^ _0x458390[_0xcb5ec5++];
    _0x4a8c71 = ((_0x128bff[_0x598b52 >>> 24] << 24) | (_0x128bff[(_0x2265d4 >>> 16) & 0xff] << 16) | (_0x128bff[(_0x4d3231 >>> 8) & 0xff] << 8) | _0x128bff[0xff & _0x1f3a4f]) ^ _0x458390[_0xcb5ec5++];
    _0x2265d4 = ((_0x128bff[_0x2265d4 >>> 24] << 24) | (_0x128bff[(_0x4d3231 >>> 16) & 0xff] << 16) | (_0x128bff[(_0x1f3a4f >>> 8) & 0xff] << 8) | _0x128bff[0xff & _0x598b52]) ^ _0x458390[_0xcb5ec5++];
    _0x13a508[_0x5baaa1] = _0x34de78; _0x13a508[_0x5baaa1 + 1] = _0x42d7a0; _0x13a508[_0x5baaa1 + 2] = _0x4a8c71; _0x13a508[_0x5baaa1 + 3] = _0x2265d4;
  }

  return function(_0x3be93d, _0x3e48ea, _0xbf2c16, _0x576527, _0x454b79, _0x361753, _0x3cdffa, _0x2fa7de, _0xdaf7bd, _0x59e242, _0x5674ce) {
    const _0x5989e7 = ['', _0x3be93d, _0x3e48ea, 'mg3c3b04ba', _0xbf2c16, _0x576527, _0x454b79, _0x12af79(_0x361753), _0x12af79((_0x3cdffa || '').toLowerCase()), _0x12af79(_0x2fa7de), _0xdaf7bd, _0x59e242, _0x5674ce, '00', ''];
    _0x5989e7.splice(1, 0, _0x70dbf4(_0x5989e7.join('|')));
    const _0x278f64 = _0x29e11d(_0x5989e7.join('|'));
    const [_0x3db385, _0x2f9d88] = _0x1b25b9(_0x278f64);
    _0xaf4f42(_0x3db385);
    return _0x1c779c(_0x3db385, _0x2f9d88).toUpperCase();
  };
}

const kisskhCipher = createKissKHCipher();

export function generateKissKHKey(episodeId, isSub = false) {
  const appVer = "2.8.10";
  const guid = isSub ? "VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp" : "62f176f3bb1b5b8e70e39932ad34a0c7";
  const platformVer = 4830201;
  const appName = "kisskh";
  return kisskhCipher(episodeId, null, appVer, guid, platformVer, appName, appName, appName, appName, appName, appName);
}

const kisskhDramaCache = new Map();
const KISSKH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export const KISSKH_DRAMA_OVERRIDES = {
  "122206": { id: 1886, title: "The Rational Life" },
};

/**
 * KissKH Provider Resolver
 * Resolves Asian drama & movie streams and subtitles.
 * Korean titles are automatically tagged with original Korean soundtrack.
 */
export async function resolveKissKH({
  assetInfo = {},
  title = "",
  year = "",
  originalLanguage = "",
  fetchImpl = fetch,
  timeoutMs = 8000,
} = {}) {
  const override = assetInfo && assetInfo.id && KISSKH_DRAMA_OVERRIDES[String(assetInfo.id)];
  let cleanTitle = String(title || "")
    .replace(/\s*:\s*.*$/, "")
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, "")
    .trim();
  if (!cleanTitle && override) {
    cleanTitle = override.title;
  }
  if (!cleanTitle) return null;

  const isTv = assetInfo.type === "tv" || assetInfo.type === "series";
  const reqEpNum = isTv ? (Number(assetInfo.episode) || 1) : 1;
  const cacheKey = override ? `override_${override.id}` : cleanTitle.toLowerCase();

  let drama = null;
  let matchedDrama = override ? { id: override.id, title: override.title } : null;

  const cached = kisskhDramaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const hasEp = cached.drama?.episodes?.some((e) => Number(e.number) === reqEpNum);
    if (hasEp || reqEpNum === 1) {
      drama = cached.drama;
      matchedDrama = cached.matchedDrama;
    }
  }

  if (!drama) {
    if (!matchedDrama) {
      let searchData = [];
      const searchUrl = `https://kisskh.is/api/DramaList/Search?q=${encodeURIComponent(cleanTitle)}&page=1&pageSize=50`;
      const searchRes = await fetchImpl(searchUrl, {
        headers: buildHeaders({ Accept: "application/json", Referer: "https://kisskh.is/" }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        console.error("[KissKH] search fetch error:", err?.message);
        return null;
      });
      if (searchRes && searchRes.ok) {
        searchData = (await searchRes.json().catch(() => [])) || [];
      } else {
        console.error("[KissKH] search non-ok status:", searchRes?.status);
      }

      if ((!Array.isArray(searchData) || searchData.length === 0) && title && title !== cleanTitle) {
        const fullRes = await fetchImpl(`https://kisskh.is/api/DramaList/Search?q=${encodeURIComponent(title)}&page=1&pageSize=50`, {
          headers: buildHeaders({ Accept: "application/json", Referer: "https://kisskh.is/" }),
          signal: AbortSignal.timeout(timeoutMs),
        }).catch(() => null);
        if (fullRes && fullRes.ok) {
          searchData = (await fullRes.json().catch(() => [])) || [];
        }
      }

      if (!Array.isArray(searchData) || searchData.length === 0) {
        console.error("[KissKH] searchData empty for cleanTitle:", cleanTitle, "title:", title);
        return null;
      }

      const normClean = normalizeTitleForMatch(cleanTitle);
      matchedDrama = searchData.find((item) => item && normalizeTitleForMatch(item.title) === normClean);
      if (!matchedDrama) {
        matchedDrama = searchData.find((item) => item && titleMatches(item.title, cleanTitle, year));
      }
      if (!matchedDrama && title && title !== cleanTitle) {
        const normTitle = normalizeTitleForMatch(title);
        matchedDrama = searchData.find((item) => item && normalizeTitleForMatch(item.title) === normTitle) ||
                       searchData.find((item) => item && titleMatches(item.title, title, year));
      }
    }

    if (!matchedDrama || !matchedDrama.id) {
      console.error("[KissKH] no matchedDrama for cleanTitle:", cleanTitle);
      return null;
    }

    const dramaUrl = `https://kisskh.is/api/DramaList/Drama/${matchedDrama.id}`;
    let dramaRes = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      dramaRes = await fetchImpl(dramaUrl, {
        headers: buildHeaders({ Accept: "application/json", Referer: "https://kisskh.is/" }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        console.error("[KissKH] drama fetch error:", err?.message);
        return null;
      });
      if (dramaRes && dramaRes.ok) break;
      if (dramaRes && dramaRes.status === 429) {
        await new Promise((r) => setTimeout(r, attempt * 1200));
      }
    }
    if (!dramaRes || !dramaRes.ok) {
      console.error("[KissKH] drama non-ok status:", dramaRes?.status);
      return null;
    }

    drama = await dramaRes.json().catch(() => null);
    if (!drama || !Array.isArray(drama.episodes) || drama.episodes.length === 0) return null;

    if (kisskhDramaCache.size > 200) {
      const oldestKey = kisskhDramaCache.keys().next().value;
      kisskhDramaCache.delete(oldestKey);
    }
    kisskhDramaCache.set(cacheKey, {
      drama,
      matchedDrama,
      expiresAt: Date.now() + KISSKH_CACHE_TTL_MS,
    });
  }

  const episode = drama.episodes.find((e) => Number(e.number) === reqEpNum) ||
                  (reqEpNum === 1 ? (drama.episodes.find((e) => Number(e.number) === 1) || drama.episodes[drama.episodes.length - 1]) : null);
  if (!episode || !episode.id) return null;

  const videoKey = generateKissKHKey(episode.id, false);
  const epStreamUrl = `https://kisskh.is/api/DramaList/Episode/${episode.id}.png?err=false&ts=&time=&kkey=${videoKey}`;
  let epStreamRes = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    epStreamRes = await fetchImpl(epStreamUrl, {
      headers: buildHeaders({ Accept: "application/json", Referer: "https://kisskh.is/" }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    if (epStreamRes && epStreamRes.ok) break;
    if (epStreamRes && epStreamRes.status === 429) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  if (!epStreamRes || !epStreamRes.ok) return null;

  const epStreamData = await epStreamRes.json().catch(() => null);
  if (!epStreamData) return null;

  const rawStream = epStreamData.Video || epStreamData.Video_tmp || "";
  if (!rawStream) return null;

  const isMP4 = epStreamData.Type === 0 || /\.mp4(\?|$)/i.test(rawStream);

  // Subtitles
  const subKey = generateKissKHKey(episode.id, true);
  const subApiUrl = `https://kisskh.is/api/Sub/${episode.id}?kkey=${subKey}`;
  let subRes = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    subRes = await fetchImpl(subApiUrl, {
      headers: buildHeaders({ Accept: "application/json", Referer: "https://kisskh.is/" }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    if (subRes && subRes.ok) break;
    if (subRes && subRes.status === 429) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  const subData = (subRes && subRes.ok) ? await subRes.json().catch(() => []) : [];

  const subtitles = [];
  if (Array.isArray(subData)) {
    subData.forEach((s) => {
      if (!s || !s.src) return;
      const label = s.label || s.land || "Subtitles";
      const isEn = String(label).toLowerCase().includes("english") || s.land === "en";
      subtitles.push({
        label: `${label} Subtitles`,
        language: s.land || (isEn ? "en" : "und"),
        url: s.src,
        default: isEn || Boolean(s.default),
        provider: "kisskh",
      });
    });
  }

  // Audio track labeling
  const country = String(drama.country || "").toLowerCase();
  const origLangInput = String(originalLanguage || (assetInfo && assetInfo.original_language) || "").toLowerCase();
  let origLabel = "Original";
  let origLang = "kor";
  if (origLangInput === "ko" || origLangInput === "kor" || country.includes("korea") || country.includes("korean")) {
    origLabel = "Original (Korean)";
    origLang = "kor";
  } else if (origLangInput === "ja" || origLangInput === "jpn" || country.includes("japan")) {
    origLabel = "Original (Japanese)";
    origLang = "jpn";
  } else if (origLangInput === "zh" || origLangInput === "zho" || country.includes("china")) {
    origLabel = "Original (Chinese)";
    origLang = "zho";
  } else if (origLangInput === "th" || origLangInput === "tha" || country.includes("thai")) {
    origLabel = "Original (Thai)";
    origLang = "tha";
  } else if (origLangInput === "hi" || origLangInput === "hin" || country.includes("india")) {
    origLabel = "Original (Hindi)";
    origLang = "hin";
  } else {
    origLabel = "Original (Korean)";
    origLang = "kor";
  }

  const audioTracks = [
    {
      id: 0,
      name: origLabel,
      label: origLabel,
      language: origLang,
      default: true,
      uri: rawStream,
      provider: "kisskh",
    },
  ];

  return {
    streamUrl: rawStream,
    backupStreamUrl: rawStream,
    provider: "kisskh",
    isMP4,
    audioTracks,
    subtitles,
    variants: [],
    pageUrl: `https://kisskh.is/Drama/${encodeURIComponent(cleanTitle)}/Episode-${reqEpNum}`,
    title: drama.title || cleanTitle,
    posterUrl: drama.thumbnail || "",
    logoUrl: "",
  };
}
