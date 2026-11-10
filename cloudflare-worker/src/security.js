/**
 * VidLyte Edge Security Primitives
 * ---------------------------------------------------------------------------
 * Shared by the Cloudflare Worker and the Phase 1 Node test harness.
 *
 * Contains:
 *  - constant-time string comparison
 *  - HMAC playback-token issue / verify with key rotation (kid:secret,...)
 *  - AES-256-GCM opaque resource codec with optional max-age
 *  - admin session signing / verification (fail-closed)
 *  - SSRF guards and swarm-node URL normalisation
 *  - URL expiry checks for signed upstream manifests
 */

import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";

export const DEFAULT_KEY_ID = "k1";
export const DEFAULT_HMAC_SECRET = "vidlyte-default-edge-key-32b-secret";

/**
 * Constant-time string comparison. Length differences still perform a
 * comparison so callers do not leak length through timing.
 */
export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  const max = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(max);
  const paddedRight = Buffer.alloc(max);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.length === right.length;
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Parse HMAC_SECRET into a key map.
 *
 * Supported forms:
 *   "plain-secret"                    -> { k1: "plain-secret" }
 *   "k1:secret,k2:rotated-secret"     -> { k1, k2 }
 *
 * The primary key is k1 when present, otherwise the first parsed key.
 */
export function parseSecretKeys(rawSecret) {
  const text = String(rawSecret ?? "").trim();
  const keys = new Map();

  if (!text) {
    keys.set(DEFAULT_KEY_ID, DEFAULT_HMAC_SECRET);
    return { keys, primaryKid: DEFAULT_KEY_ID, primarySecret: DEFAULT_HMAC_SECRET, legacy: true };
  }

  const looksKeyed = text.includes(",") || /^[A-Za-z][A-Za-z0-9_-]{0,31}:/.test(text);
  if (!looksKeyed) {
    keys.set(DEFAULT_KEY_ID, text);
    return { keys, primaryKid: DEFAULT_KEY_ID, primarySecret: text, legacy: true };
  }

  for (const entry of text.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator > 0) {
      const kid = trimmed.slice(0, separator).trim();
      const secret = trimmed.slice(separator + 1);
      if (/^[A-Za-z0-9_-]{1,32}$/.test(kid) && secret) {
        keys.set(kid, secret);
        continue;
      }
    }
    keys.set(DEFAULT_KEY_ID, trimmed);
  }

  if (keys.size === 0) {
    keys.set(DEFAULT_KEY_ID, DEFAULT_HMAC_SECRET);
  }

  const primaryKid = keys.has(DEFAULT_KEY_ID) ? DEFAULT_KEY_ID : keys.keys().next().value;
  return {
    keys,
    primaryKid,
    primarySecret: keys.get(primaryKid),
    legacy: false,
  };
}

function resolveSecret(secretSpec, keyID) {
  if (secretSpec && typeof secretSpec === "object" && secretSpec.keys instanceof Map) {
    const secret = secretSpec.keys.get(keyID) || (keyID === secretSpec.primaryKid ? secretSpec.primarySecret : null);
    return secret || null;
  }
  if (secretSpec && typeof secretSpec === "object" && typeof secretSpec.get === "function") {
    return secretSpec.get(keyID) || null;
  }
  return typeof secretSpec === "string" ? secretSpec : null;
}

function shouldBindClientIP(clientIP) {
  return Boolean(clientIP) && clientIP !== "127.0.0.1" && clientIP !== "::1" && clientIP !== "none";
}

/**
 * Issue a session.Manager-compatible playback token.
 * Format: kid.base64url(asset).expiryHex[.base64url(ip)].hmacHex
 */
export function issuePlaybackToken(assetID, clientIP, ttlSec, secretSpec, keyID) {
  const parsed = typeof secretSpec === "object" && secretSpec.keys ? secretSpec : parseSecretKeys(secretSpec);
  const kid = keyID || parsed.primaryKid;
  const secret = resolveSecret(parsed, kid) || parsed.primarySecret;
  const expiry = Math.floor(Date.now() / 1000) + (Number.isFinite(ttlSec) ? ttlSec : 900);
  const assetEncoded = Buffer.from(String(assetID), "utf8").toString("base64url");
  const expiryHex = expiry.toString(16);

  if (shouldBindClientIP(clientIP)) {
    const ipEncoded = Buffer.from(String(clientIP), "utf8").toString("base64url");
    const message = `${kid}:${assetEncoded}:${expiryHex}:${clientIP}`;
    const sig = createHmac("sha256", secret).update(message).digest("hex");
    return `${kid}.${assetEncoded}.${expiryHex}.${ipEncoded}.${sig}`;
  }

  const message = `${kid}:${assetEncoded}:${expiryHex}`;
  const sig = createHmac("sha256", secret).update(message).digest("hex");
  return `${kid}.${assetEncoded}.${expiryHex}.${sig}`;
}

/**
 * Verify a playback token. Returns false for any malformed/expired/tampered
 * token. `options.bindClientIP` enforces that the embedded IP matches the
 * requester (useful when BIND_CLIENT_IP=true).
 */
export function verifyPlaybackToken(assetID, clientIP, token, secretSpec, options = {}) {
  if (!token || typeof token !== "string") return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 4 && parts.length !== 5) return false;

    const keyID = parts[0];
    const assetEncoded = parts[1];
    const expiryHex = parts[2];
    const signature = parts.length === 5 ? parts[4] : parts[3];

    const secret = resolveSecret(secretSpec, keyID);
    if (!secret) return false;

    const expiry = parseInt(expiryHex, 16);
    if (!Number.isFinite(expiry) || Math.floor(Date.now() / 1000) > expiry) {
      return false;
    }

    const tokenAsset = Buffer.from(assetEncoded, "base64url").toString("utf8");
    if (!constantTimeEqual(tokenAsset, String(assetID))) return false;

    if (parts.length === 5) {
      const tokenIP = Buffer.from(parts[3], "base64url").toString("utf8");
      const message = `${keyID}:${assetEncoded}:${expiryHex}:${tokenIP}`;
      const expected = createHmac("sha256", secret).update(message).digest("hex");
      if (!constantTimeEqual(signature, expected)) return false;

      if (options.bindClientIP && clientIP && shouldBindClientIP(clientIP)) {
        return constantTimeEqual(tokenIP, String(clientIP));
      }
      return true;
    }

    const message = `${keyID}:${assetEncoded}:${expiryHex}`;
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    return constantTimeEqual(signature, expected);
  } catch (e) {
    return false;
  }
}

/**
 * AES-256-GCM opaque resource codec.
 * Payload: { u: upstreamUrl, p: provider, t: issuedAtUnixSeconds }
 */
export function createOpaqueCodec(secret) {
  const key = createHash("sha256").update(String(secret || DEFAULT_HMAC_SECRET)).digest();

  function encode(url, provider) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const payload = JSON.stringify({
      u: url,
      p: provider || "evion",
      t: Math.floor(Date.now() / 1000),
    });
    const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, tag, encrypted]);
    return "vl_" + combined.toString("base64url");
  }

  function decode(token, options = {}) {
    if (!token || typeof token !== "string" || !token.startsWith("vl_")) return null;
    try {
      const combined = Buffer.from(token.slice(3), "base64url");
      if (combined.length < 28) return null;
      const iv = combined.subarray(0, 12);
      const tag = combined.subarray(12, 28);
      const encrypted = combined.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const obj = JSON.parse(decrypted.toString("utf8"));
      if (!obj || typeof obj.u !== "string") return null;

      const issuedAt = Number(obj.t) || 0;
      const maxAgeSec = Number(options.maxAgeSec) || 0;
      if (issuedAt > 0 && maxAgeSec > 0) {
        const age = Math.floor(Date.now() / 1000) - issuedAt;
        if (age > maxAgeSec || age < -300) return null;
      }

      return { targetUrl: obj.u, provider: obj.p || "evion", issuedAt };
    } catch (e) {
      return null;
    }
  }

  return { encode, decode };
}

/**
 * Admin session cookie helpers. Sessions are HMAC-signed and bound to the
 * requesting IP. Fail closed when ADMIN_SECRET is missing.
 *
 * The default lifetime is 12 hours; callers may override it with
 * ADMIN_SESSION_TTL_SEC (bounded to 7 days by the worker).
 */
export const ADMIN_SESSION_DEFAULT_TTL_SEC = 12 * 60 * 60;

export function signAdminSession(adminSecret, clientIP, now = Date.now()) {
  if (!adminSecret) return null;
  const timestamp = String(now);
  const signature = createHmac("sha256", adminSecret).update(`${timestamp}:${clientIP}`).digest("hex");
  return `${timestamp}.${signature}`;
}

export function verifyAdminSession(
  token,
  adminSecret,
  clientIP,
  now = Date.now(),
  ttlSec = ADMIN_SESSION_DEFAULT_TTL_SEC
) {
  if (!token || !adminSecret) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const timestamp = parts[0];
    const signature = parts[1];
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    const ttlMs =
      (Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : ADMIN_SESSION_DEFAULT_TTL_SEC) * 1000;
    if (now - ts > ttlMs || ts > now + 60000) return false;
    const expected = createHmac("sha256", adminSecret).update(`${timestamp}:${clientIP}`).digest("hex");
    return constantTimeEqual(signature, expected);
  } catch (e) {
    return false;
  }
}

/**
 * Derive the CSRF token for an admin session. Stateless: the token is an HMAC
 * of the session cookie, so no extra storage or KV round-trip is required.
 */
export function deriveAdminCsrf(adminSecret, sessionToken) {
  if (!adminSecret || !sessionToken) return "";
  return createHmac("sha256", adminSecret).update(`csrf:${sessionToken}`).digest("hex");
}

/**
 * CSP nonce generator. base64url keeps the value safe inside an attribute and
 * a CSP source expression.
 */
export function generateNonce(byteLength = 16) {
  const size = Number.isFinite(byteLength) && byteLength > 0 ? byteLength : 16;
  return randomBytes(size).toString("base64url");
}

export function extractClientIP(request) {
  const cfIP = request.headers.get("CF-Connecting-IP");
  if (cfIP) return cfIP.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "127.0.0.1";
}

/* ---------------------------------------------------------------------------
 * SSRF / upstream URL guards
 * ------------------------------------------------------------------------ */

const PRIVATE_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of PRIVATE_IPV4_RANGES) {
    const baseValue = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

function isPrivateIPv6(host) {
  const value = host.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // fc00::/7
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  if (value.startsWith("ff")) return true; // multicast
  if (value.startsWith("::ffff:")) return isPrivateIPv4(value.slice(7));
  return false;
}

export function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host === "metadata" || host === "instance-data") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;

  if (host.includes(":")) return isPrivateIPv6(host);

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIPv4(host);

  return false;
}

const DEFAULT_ALLOWED_SUFFIXES = [
  "vidrift.net",
  "animecurx.tech",
  "bigbang.cymru",
  "framextv.xyz",
  "framextv.cc",
  "framextv.tech",
  "2embed.cc",
  "2vcdn.skin",
  "asianflix.one",
  "rumble.com",
  "rumble.cloud",
  "1a-1791.com",
  "cloudinary.com",
  "blogger.com",
  "blogspot.com",
  "blogger.googleusercontent.com",
  "cinejoy.pk",
  "wing.st",
  "strem.io",
  "tmdb.org",
  "image.tmdb.org",
  "googlevideo.com",
  "akamaized.net",
  "cloudfront.net",
  "mux.dev",
  "akamaihd.net",
  "jwplatform.com",
  "jwplayer.com",
  "cloudflarestream.com",
  "b-cdn.net",
  "bunnycdn.com",
  "fastly.net",
  "dragonballzfans.xyz",
  "milkyway.cymru",
  "premilkyway.com",
  "astronomyfactsnow.com",
  "tiktokcdn.com",
  "cno.to",
  "lumenbox.top",
  "hakunaymatata.com",
  "reelvault.net",
  "rousav.com",
  "rousav.tech",
  "bigbang.observer",
  "salov447hev.com",
  "hscow.com",
  "streamsrcs.com",
  "vidrock.to",
  "hybrows.workers.dev",
  "armadilloscp.workers.dev",
];

function hostMatchesSuffix(host, suffix) {
  return host === suffix || host.endsWith("." + suffix);
}

export function parseAllowlist(raw) {
  const extra = String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_SUFFIXES, ...extra])];
}

export class UpstreamUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamUrlError";
  }
}

/**
 * Validate an upstream URL. Always rejects private/reserved destinations.
 * When `requireAllowlist` is true, the host must match a known provider suffix
 * or an entry in `UPSTREAM_ALLOWLIST`.
 */
export function assertSafeUpstreamUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (e) {
    throw new UpstreamUrlError("Malformed upstream URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UpstreamUrlError("Unsupported upstream protocol");
  }
  if (parsed.username || parsed.password) {
    throw new UpstreamUrlError("Credentials in upstream URL are not allowed");
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new UpstreamUrlError("Private/reserved upstream host blocked");
  }

  const allowedPorts = new Set(["", "80", "443", "8080", "8443"]);
  if (!allowedPorts.has(parsed.port)) {
    throw new UpstreamUrlError("Upstream port is not allowed");
  }

  if (options.requireAllowlist) {
    const allowlist = options.allowlist || parseAllowlist(options.extraAllowlist);
    const host = parsed.hostname.toLowerCase();
    if (!allowlist.some((suffix) => hostMatchesSuffix(host, suffix))) {
      throw new UpstreamUrlError("Upstream host is not in the allowlist");
    }
  }

  return parsed;
}

/**
 * Normalise a swarm worker URL to an origin. Returns null for invalid nodes.
 */
export function normalizeSwarmNodeUrl(rawUrl, options = {}) {
  let text = String(rawUrl || "").trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = "https://" + text;

  let parsed;
  try {
    parsed = new URL(text);
  } catch (e) {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  if (isPrivateHostname(parsed.hostname) && !options.allowPrivate) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search || parsed.hash) return null;

  return parsed.origin;
}

/**
 * True when a signed upstream URL has a usable `exp` query parameter.
 * A five-minute safety margin avoids handing out URLs that expire mid-play.
 */
export function isStreamUrlUsable(rawUrl, marginSec = 300) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const expRaw = parsed.searchParams.get("exp");
    if (!expRaw) return true;
    const exp = parseInt(expRaw, 10);
    if (!Number.isFinite(exp) || exp <= 0) return true;
    return Math.floor(Date.now() / 1000) + marginSec < exp;
  } catch (e) {
    return false;
  }
}
