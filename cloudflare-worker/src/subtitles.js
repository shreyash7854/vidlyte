/**
 * VidLyte Subtitle & Media Sniffing Utilities
 * ---------------------------------------------------------------------------
 * Handles encoding detection, SRT/ASS -> WebVTT conversion and lightweight
 * media type sniffing for the edge proxy.
 */

const WINDOWS_1252_HIGH = {
  0x80: "\u20AC", 0x82: "\u201A", 0x83: "\u0192", 0x84: "\u201E",
  0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02C6",
  0x89: "\u2030", 0x8A: "\u0160", 0x8B: "\u2039", 0x8C: "\u0152",
  0x8E: "\u017D", 0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201C",
  0x94: "\u201D", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02DC", 0x99: "\u2122", 0x9A: "\u0161", 0x9B: "\u203A",
  0x9C: "\u0153", 0x9E: "\u017E", 0x9F: "\u0178",
};

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(0);
}

function decodeUtf8(bytes, fatal) {
  return new TextDecoder("utf-8", { fatal: Boolean(fatal) }).decode(bytes);
}

function decodeWindows1252(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte >= 0x80 && byte <= 0x9f && WINDOWS_1252_HIGH[byte]) {
      out += WINDOWS_1252_HIGH[byte];
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/**
 * Decode subtitle bytes using BOM detection, UTF-8 validation, and a
 * Windows-1252 fallback for legacy SRT files.
 */
export function decodeSubtitleBytes(input) {
  const bytes = toUint8Array(input);
  if (bytes.length === 0) return "";

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3), false);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    } catch (e) {
      // fall through
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    } catch (e) {
      // fall through
    }
  }

  // Heuristic UTF-16 without BOM: many NUL bytes in alternating positions.
  let evenNuls = 0;
  let oddNuls = 0;
  const sample = Math.min(bytes.length, 512);
  for (let i = 0; i < sample; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) evenNuls++;
      else oddNuls++;
    }
  }
  if (sample > 32 && (evenNuls > sample / 4 || oddNuls > sample / 4)) {
    try {
      return new TextDecoder(oddNuls > evenNuls ? "utf-16le" : "utf-16be").decode(bytes);
    } catch (e) {
      // fall through
    }
  }

  try {
    return decodeUtf8(bytes, true);
  } catch (e) {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch (e2) {
      return decodeWindows1252(bytes);
    }
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function normalizeTimestamp(match, hours, minutes, seconds, millis) {
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(millis).padEnd(3, "0").slice(0, 3)}`;
}

function normalizeSrtTimestamps(text) {
  return text.replace(
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g,
    (match, hours, minutes, seconds, millis) => normalizeTimestamp(match, hours, minutes, seconds, millis)
  );
}

/**
 * Convert SubRip (SRT) to WebVTT.
 */
export function srtToVtt(input) {
  let text = String(input || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  text = normalizeSrtTimestamps(text);

  if (/^WEBVTT/i.test(text.trimStart())) {
    return text.trimStart();
  }

  // Drop common SRT numeric cue counters only when followed by a timestamp.
  text = text.replace(/(^|\n)\d+\s*\n(?=\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->)/g, "$1");

  return `WEBVTT\n\n${text.trim()}\n`;
}

function assTimeToVtt(raw) {
  const match = String(raw || "").trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  return `${pad(match[1])}:${pad(match[2])}:${pad(match[3])}.${match[4].padEnd(3, "0").slice(0, 3)}`;
}

function stripAssTags(text) {
  return String(text || "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

/**
 * Convert a basic ASS/SSA dialogue track to WebVTT.
 */
export function assToVtt(input) {
  const text = String(input || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const cues = [];

  let inEvents = false;
  let fields = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[Events\]$/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim());
      continue;
    }

    if (!/^Dialogue\s*:/i.test(trimmed)) continue;

    const payload = trimmed.slice(trimmed.indexOf(":") + 1);
    const parts = payload.split(",");
    const textIndex = fields ? fields.findIndex((field) => field.toLowerCase() === "text") : 9;
    const startIndex = fields ? fields.findIndex((field) => field.toLowerCase() === "start") : 1;
    const endIndex = fields ? fields.findIndex((field) => field.toLowerCase() === "end") : 2;
    const effectiveTextIndex = textIndex >= 0 ? textIndex : 9;

    if (parts.length <= effectiveTextIndex) continue;

    const start = assTimeToVtt(parts[startIndex >= 0 ? startIndex : 1]);
    const end = assTimeToVtt(parts[endIndex >= 0 ? endIndex : 2]);
    const cueText = stripAssTags(parts.slice(effectiveTextIndex).join(","));
    if (!start || !end || !cueText) continue;

    cues.push(`${start} --> ${end}\n${cueText}`);
  }

  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/**
 * Convert any supported subtitle text to WebVTT. HLS subtitle playlists are
 * passed through untouched.
 */
export function convertSubtitleToVtt(input) {
  const text = String(input || "").replace(/^\uFEFF/, "");
  const trimmed = text.trimStart();

  if (/^WEBVTT/i.test(trimmed)) return { text: trimmed, format: "vtt" };
  if (/^#EXTM3U/i.test(trimmed)) return { text: trimmed, format: "hls" };
  if (/\[Script Info\]/i.test(text) || /^Dialogue\s*:/im.test(text)) {
    return { text: assToVtt(text), format: "ass" };
  }
  if (/-->/.test(text)) {
    return { text: srtToVtt(text), format: "srt" };
  }

  return { text: `WEBVTT\n\n${trimmed.trim()}\n`, format: "text" };
}

export function subtitleContentType(format) {
  if (format === "hls") return "application/vnd.apple.mpegurl";
  return "text/vtt; charset=utf-8";
}

/**
 * Decode + convert a subtitle response body.
 */
export function toVttFromBytes(input) {
  const decoded = decodeSubtitleBytes(input);
  const converted = convertSubtitleToVtt(decoded);
  return {
    text: converted.text,
    format: converted.format,
    contentType: subtitleContentType(converted.format),
  };
}

/**
 * Lightweight magic-byte media sniffing.
 */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length === 0) return null;

  if (bytes[0] === 0x47) return "video/mp2t";

  if (bytes.length >= 8) {
    const ftyp = String.fromCharCode(...bytes.slice(4, 8));
    if (ftyp === "ftyp") return "video/mp4";
  }

  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";

  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6));
    if (head === "WEBVTT") return "text/vtt; charset=utf-8";
  }

  if (bytes.length >= 7) {
    const head = String.fromCharCode(...bytes.slice(0, 7));
    if (head === "#EXTM3U") return "application/vnd.apple.mpegurl";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";

  return null;
}
