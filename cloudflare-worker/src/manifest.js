/**
 * VidLyte HLS Manifest Utilities
 * ---------------------------------------------------------------------------
 * A complete URI-attribute aware manifest rewriter plus a master-playlist
 * parser used to populate real subtitle/audio/variant metadata.
 *
 * The rewriter is intentionally independent from the worker runtime so it can
 * be unit-tested with plain Node.
 */

const URI_ATTRIBUTE_RE = /URI=("([^"]*)"|'([^']*)')/gi;

const PLAYLIST_EXTENSIONS = [".m3u8", ".m3u"];

const TAG_ROUTES = {
  "EXT-X-KEY": "chunk",
  "EXT-X-SESSION-KEY": "chunk",
  "EXT-X-MAP": "chunk",
  "EXT-X-PART": "chunk",
  "EXT-X-PRELOAD-HINT": "chunk",
  "EXT-X-SESSION-DATA": "chunk",
  "EXT-X-RENDITION-REPORT": "res",
  "EXT-X-I-FRAME-STREAM-INF": "res",
};

export function isPlaylistUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(String(rawUrl));
    const path = parsed.pathname.toLowerCase();
    if (PLAYLIST_EXTENSIONS.some((ext) => path.includes(ext))) return true;
    const search = parsed.search.toLowerCase();
    if (PLAYLIST_EXTENSIONS.some((ext) => search.includes(ext))) return true;
    return false;
  } catch (e) {
    const lower = String(rawUrl).toLowerCase();
    return PLAYLIST_EXTENSIONS.some((ext) => lower.includes(ext));
  }
}

function isProxyableUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch (e) {
    return false;
  }
}

function resolveAgainstBase(rawUri, baseUrl) {
  const uri = String(rawUri || "").trim();
  if (!uri) return null;
  if (uri.startsWith("data:") || uri.startsWith("blob:")) return null;
  try {
    return new URL(uri, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Parse an HLS attribute list such as:
 *   TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,URI="en.m3u8"
 */
export function parseAttributeList(input) {
  const attrs = {};
  const text = String(input || "");
  let index = 0;

  while (index < text.length) {
    while (index < text.length && (text[index] === "," || text[index] === " " || text[index] === "\t")) index++;
    if (index >= text.length) break;

    const keyStart = index;
    while (index < text.length && text[index] !== "=" && text[index] !== ",") index++;
    if (index >= text.length || text[index] !== "=") {
      while (index < text.length && text[index] !== ",") index++;
      continue;
    }

    const key = text.slice(keyStart, index).trim().toUpperCase();
    index++; // skip '='

    let value = "";
    if (text[index] === '"') {
      index++;
      const valueStart = index;
      while (index < text.length && text[index] !== '"') index++;
      value = text.slice(valueStart, index);
      index++; // skip closing quote
    } else {
      const valueStart = index;
      while (index < text.length && text[index] !== ",") index++;
      value = text.slice(valueStart, index).trim();
    }

    if (key) attrs[key] = value;
    while (index < text.length && text[index] !== ",") index++;
  }

  return attrs;
}

function resolutionLabel(attrs) {
  const raw = attrs.RESOLUTION || "";
  const match = String(raw).match(/(\d{2,5})\s*[xX]\s*(\d{2,5})/);
  if (match) return `${match[2]}p`;
  if (attrs.NAME) return attrs.NAME;
  if (attrs["FRAME-RATE"]) return `${Math.round(Number(attrs["FRAME-RATE"]))}fps`;
  return "Auto";
}

function bandwidthValue(attrs) {
  const raw = attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH || "0";
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse a master manifest into concrete variants, audio renditions and
 * subtitle renditions. Relative URIs are resolved against `baseUrl`.
 */
export function parseMasterManifest(rawManifest, baseUrl) {
  const lines = String(rawManifest || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const variants = [];
  const audio = [];
  const subtitles = [];
  const seenVariants = new Set();
  const seenAudio = new Set();
  const seenSubtitles = new Set();

  let pendingVariant = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-MEDIA:".length));
      const resolvedUri = attrs.URI ? resolveAgainstBase(attrs.URI, baseUrl) : "";
      const type = (attrs.TYPE || "").toUpperCase();
      const entry = {
        uri: resolvedUri,
        label: attrs.NAME || attrs.LANGUAGE || "",
        language: attrs.LANGUAGE || "",
        default: (attrs.DEFAULT || "").toUpperCase() === "YES",
        autoselect: (attrs.AUTOSELECT || "").toUpperCase() === "YES",
        forced: (attrs.FORCED || "").toUpperCase() === "YES",
        groupId: attrs["GROUP-ID"] || "",
        type,
      };

      if (type === "AUDIO") {
        const key = `${entry.language}|${entry.label}|${entry.uri}`;
        if (!seenAudio.has(key)) {
          seenAudio.add(key);
          audio.push(entry);
        }
      } else if (type === "SUBTITLES" || type === "CLOSED-CAPTIONS") {
        const key = `${entry.language}|${entry.label}|${entry.uri}`;
        if (!seenSubtitles.has(key)) {
          seenSubtitles.add(key);
          subtitles.push(entry);
        }
      }
      continue;
    }

    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-I-FRAME-STREAM-INF:".length));
      const resolvedUri = attrs.URI ? resolveAgainstBase(attrs.URI, baseUrl) : "";
      if (resolvedUri && !seenVariants.has(resolvedUri)) {
        seenVariants.add(resolvedUri);
        variants.push({
          uri: resolvedUri,
          resolution: resolutionLabel(attrs),
          bandwidth: bandwidthValue(attrs),
          codecs: attrs.CODECS || "",
          iframe: true,
        });
      }
      continue;
    }

    if (line.startsWith("#")) continue;

    if (pendingVariant) {
      const resolvedUri = resolveAgainstBase(line, baseUrl);
      if (resolvedUri && !seenVariants.has(resolvedUri)) {
        seenVariants.add(resolvedUri);
        variants.push({
          uri: resolvedUri,
          resolution: resolutionLabel(pendingVariant),
          bandwidth: bandwidthValue(pendingVariant),
          codecs: pendingVariant.CODECS || "",
          audioGroup: pendingVariant.AUDIO || "",
          subtitleGroup: pendingVariant.SUBTITLES || "",
          iframe: false,
        });
      }
      pendingVariant = null;
    }
  }

  return { variants, audio, subtitles };
}

function tagNameFromLine(line) {
  if (!line.startsWith("#EXT")) return "";
  const colon = line.indexOf(":");
  const tag = colon === -1 ? line.slice(1) : line.slice(1, colon);
  return tag.trim().toUpperCase();
}

function routeFor(tagName, absoluteUrl, mediaType) {
  const forced = TAG_ROUTES[tagName];
  if (forced) return forced;
  if (mediaType === "SUBTITLES" && !isPlaylistUrl(absoluteUrl)) return "chunk";
  return isPlaylistUrl(absoluteUrl) ? "res" : "chunk";
}

/**
 * Rewrite every URI in a manifest into an opaque gateway URL.
 *
 * @param {string} rawManifest
 * @param {object} options
 * @param {string} options.baseUrl      Absolute URL used to resolve relative URIs
 * @param {string} options.assetId      Playback asset identifier
 * @param {string} options.token        Playback token (optional for chunks)
 * @param {string} options.origin       Worker origin
 * @param {string} options.provider     Provider tag
 * @param {{encode: Function}} options.codec Opaque codec
 * @returns {string}
 */
export function rewriteManifest(rawManifest, options) {
  const {
    baseUrl,
    assetId,
    token,
    origin,
    provider,
    codec,
  } = options;

  if (!codec || typeof codec.encode !== "function") {
    throw new Error("rewriteManifest requires an opaque codec");
  }

  const lines = String(rawManifest || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const output = [];
  const encodedAsset = encodeURIComponent(assetId || "stream");
  const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : "";

  const buildRes = (absoluteUrl) =>
    `${origin}/hls/${encodedAsset}/res/${codec.encode(absoluteUrl, provider)}${tokenSuffix}`;
  const buildChunk = (absoluteUrl) =>
    `${origin}/stream/chunk/${codec.encode(absoluteUrl, provider)}`;

  let lastTag = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    if (trimmed.startsWith("#")) {
      lastTag = tagNameFromLine(trimmed);
      if (!trimmed.includes("URI=")) {
        output.push(line);
        continue;
      }

      const tagName = lastTag;
      const mediaMatch = trimmed.match(/TYPE=([^,\s]+)/i);
      const mediaType = mediaMatch ? mediaMatch[1].toUpperCase() : "";

      const rewritten = trimmed.replace(URI_ATTRIBUTE_RE, (match, quoted, doubleQuoted, singleQuoted) => {
        const rawUri = doubleQuoted !== undefined ? doubleQuoted : singleQuoted;
        if (!rawUri) return match;
        const absoluteUrl = resolveAgainstBase(rawUri, baseUrl);
        if (!absoluteUrl || !isProxyableUrl(absoluteUrl)) return match;

        const route = routeFor(tagName, absoluteUrl, mediaType);
        const replacement = route === "res" ? buildRes(absoluteUrl) : buildChunk(absoluteUrl);
        return `URI="${replacement}"`;
      });

      output.push(rewritten);
      continue;
    }

    const isVariantStream = lastTag === "EXT-X-STREAM-INF" || lastTag === "EXT-X-I-FRAME-STREAM-INF";
    lastTag = "";
    const absoluteUrl = resolveAgainstBase(trimmed, baseUrl);
    if (!absoluteUrl || !isProxyableUrl(absoluteUrl)) {
      output.push(line);
      continue;
    }

    output.push((isVariantStream || isPlaylistUrl(absoluteUrl)) ? buildRes(absoluteUrl) : buildChunk(absoluteUrl));
  }

  return output.join("\n");
}
