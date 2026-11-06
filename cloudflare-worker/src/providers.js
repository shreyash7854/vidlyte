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
  { id: "evion", label: "Evion", priority: 2, hosts: ["img.animecurx.tech"] },
  { id: "framextv", label: "FrameX", priority: 3, hosts: ["api.framextv.xyz", "api.framextv.cc", "api.framextv.tech"] },
  { id: "asianflix", label: "AsianFlix", priority: 4, hosts: ["asianflix.one", "rumble.com", "rumble.cloud"] },
  { id: "2vcdn", label: "2Embed", priority: 5, hosts: ["2embed.cc", "2vcdn.skin"] },
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
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleMatches(candidate, target, year) {
  const a = normalizeTitleForMatch(candidate);
  const b = normalizeTitleForMatch(target);
  if (!a || !b) return false;
  const titleOk = a === b || a.includes(b) || b.includes(a);
  if (!titleOk) return false;
  if (!year) return true;
  const yearText = String(year);
  if (!/^\d{4}$/.test(yearText)) return true;
  return String(candidate || "").includes(yearText) || a.includes(yearText);
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
