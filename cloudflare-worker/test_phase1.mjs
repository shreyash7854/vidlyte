/**
 * VidLyte Phase 1 verification harness
 * ---------------------------------------------------------------------------
 * Exercises the pure modules added in Phase 1 without needing a Worker runtime.
 *
 *   node test_phase1.mjs
 */

import assert from "node:assert/strict";
import {
  constantTimeEqual,
  parseSecretKeys,
  issuePlaybackToken,
  verifyPlaybackToken,
  createOpaqueCodec,
  signAdminSession,
  verifyAdminSession,
  assertSafeUpstreamUrl,
  normalizeSwarmNodeUrl,
  isStreamUrlUsable,
  isPrivateHostname,
  UpstreamUrlError,
} from "./src/security.js";
import { rewriteManifest, parseMasterManifest, isPlaylistUrl, parseAttributeList } from "./src/manifest.js";
import { decodeSubtitleBytes, srtToVtt, assToVtt, convertSubtitleToVtt, toVttFromBytes, sniffMediaType } from "./src/subtitles.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(` FAIL ${name}`);
    console.log(`      ${error && error.message}`);
  }
}

console.log("\n[security] constant-time + key parsing");
test("constantTimeEqual matches equal strings", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("parseSecretKeys handles plain and rotated secrets", () => {
  const plain = parseSecretKeys("plain-secret");
  assert.equal(plain.primaryKid, "k1");
  assert.equal(plain.primarySecret, "plain-secret");

  const rotated = parseSecretKeys("k1:first-secret,k2:second-secret");
  assert.equal(rotated.primaryKid, "k1");
  assert.equal(rotated.keys.get("k2"), "second-secret");
});

test("parseSecretKeys falls back to a safe default when empty", () => {
  const empty = parseSecretKeys("");
  assert.equal(empty.legacy, true);
  assert.ok(empty.primarySecret.length >= 16);
});

console.log("\n[security] playback tokens");
test("issued token verifies for the same asset", () => {
  const secret = parseSecretKeys("k1:test-secret-abcdefghijklmnop");
  const token = issuePlaybackToken("movie-550", "203.0.113.9", 900, secret);
  assert.equal(verifyPlaybackToken("movie-550", "203.0.113.9", token, secret), true);
  assert.equal(verifyPlaybackToken("movie-551", "203.0.113.9", token, secret), false);
});

test("tampered token fails", () => {
  const secret = parseSecretKeys("k1:test-secret-abcdefghijklmnop");
  const token = issuePlaybackToken("movie-550", "203.0.113.9", 900, secret);
  const tampered = token.slice(0, -2) + (token.endsWith("00") ? "11" : "00");
  assert.equal(verifyPlaybackToken("movie-550", "203.0.113.9", tampered, secret), false);
});

test("expired token fails", () => {
  const secret = parseSecretKeys("k1:test-secret-abcdefghijklmnop");
  const token = issuePlaybackToken("movie-550", "203.0.113.9", -10, secret);
  assert.equal(verifyPlaybackToken("movie-550", "203.0.113.9", token, secret), false);
});

test("key rotation verifies old tokens with the matching kid", () => {
  const oldSecret = parseSecretKeys("k1:old-secret-abcdefghijklmnop");
  const oldToken = issuePlaybackToken("movie-550", "203.0.113.9", 900, oldSecret);

  const rotated = parseSecretKeys("k1:old-secret-abcdefghijklmnop,k2:new-secret-abcdefghijklmnop");
  assert.equal(verifyPlaybackToken("movie-550", "203.0.113.9", oldToken, rotated), true);

  const onlyNew = parseSecretKeys("k2:new-secret-abcdefghijklmnop");
  assert.equal(verifyPlaybackToken("movie-550", "203.0.113.9", oldToken, onlyNew), false);
});

test("BIND_CLIENT_IP enforces the embedded IP when enabled", () => {
  const secret = parseSecretKeys("k1:test-secret-abcdefghijklmnop");
  const token = issuePlaybackToken("movie-550", "203.0.113.9", 900, secret);
  assert.equal(
    verifyPlaybackToken("movie-550", "198.51.100.7", token, secret, { bindClientIP: true }),
    false
  );
  assert.equal(
    verifyPlaybackToken("movie-550", "203.0.113.9", token, secret, { bindClientIP: true }),
    true
  );
});

console.log("\n[security] opaque codec");
test("opaque codec round-trips and rejects tampering", () => {
  const codec = createOpaqueCodec("opaque-test-secret");
  const token = codec.encode("https://cdn.example.com/a/b.ts", "framextv");
  const decoded = codec.decode(token, { maxAgeSec: 3600 });
  assert.equal(decoded.targetUrl, "https://cdn.example.com/a/b.ts");
  assert.equal(decoded.provider, "framextv");

  const tampered = token.slice(0, -4) + "AAAA";
  assert.equal(codec.decode(tampered), null);
  assert.equal(codec.decode("vl_not-a-token"), null);
});

console.log("\n[security] admin sessions");
test("admin session verifies for the same IP and rejects another IP", () => {
  const token = signAdminSession("admin-secret", "203.0.113.9");
  assert.equal(verifyAdminSession(token, "admin-secret", "203.0.113.9"), true);
  assert.equal(verifyAdminSession(token, "admin-secret", "198.51.100.7"), false);
  assert.equal(verifyAdminSession(token, "wrong-secret", "203.0.113.9"), false);
  assert.equal(verifyAdminSession(token, "", "203.0.113.9"), false);
});

console.log("\n[security] SSRF + swarm guards");
test("private and reserved hosts are rejected", () => {
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("127.0.0.1"), true);
  assert.equal(isPrivateHostname("169.254.169.254"), true);
  assert.equal(isPrivateHostname("10.0.0.5"), true);
  assert.equal(isPrivateHostname("192.168.1.1"), true);
  assert.equal(isPrivateHostname("metadata.google.internal"), true);
  assert.equal(isPrivateHostname("cdn.example.com"), false);
});

test("assertSafeUpstreamUrl blocks private/file/credential URLs", () => {
  assert.throws(() => assertSafeUpstreamUrl("file:///etc/passwd"), UpstreamUrlError);
  assert.throws(() => assertSafeUpstreamUrl("http://127.0.0.1/a"), UpstreamUrlError);
  assert.throws(() => assertSafeUpstreamUrl("http://169.254.169.254/latest"), UpstreamUrlError);
  assert.throws(() => assertSafeUpstreamUrl("https://user:pass@cdn.example.com/a"), UpstreamUrlError);
});

test("assertSafeUpstreamUrl enforces the allowlist when requested", () => {
  const allowed = assertSafeUpstreamUrl("https://embed.vidrift.net/a.m3u8", { requireAllowlist: true });
  assert.equal(allowed.hostname, "embed.vidrift.net");

  assert.throws(
    () => assertSafeUpstreamUrl("https://evil.example.com/a.m3u8", { requireAllowlist: true }),
    UpstreamUrlError
  );

  const extra = assertSafeUpstreamUrl("https://cdn.myprovider.test/a.m3u8", {
    requireAllowlist: true,
    extraAllowlist: "myprovider.test",
  });
  assert.equal(extra.hostname, "cdn.myprovider.test");
});

test("normalizeSwarmNodeUrl accepts origins and rejects paths/credentials", () => {
  assert.equal(normalizeSwarmNodeUrl("edge.example.com"), "https://edge.example.com");
  assert.equal(normalizeSwarmNodeUrl("https://edge.example.com/"), "https://edge.example.com");
  assert.equal(normalizeSwarmNodeUrl("https://edge.example.com/proxy?url=x"), null);
  assert.equal(normalizeSwarmNodeUrl("https://user:pass@edge.example.com"), null);
  assert.equal(normalizeSwarmNodeUrl("http://127.0.0.1:8787"), null);
});

test("isStreamUrlUsable detects expired signed URLs", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isStreamUrlUsable(`https://cdn.example.com/a.m3u8?exp=${now + 3600}`), true);
  assert.equal(isStreamUrlUsable(`https://cdn.example.com/a.m3u8?exp=${now - 10}`), false);
  assert.equal(isStreamUrlUsable("https://cdn.example.com/a.m3u8"), true);
  assert.equal(isStreamUrlUsable("not a url"), false);
});

console.log("\n[manifest] attribute parsing + rewriting");
test("parseAttributeList handles quoted and unquoted values", () => {
  const attrs = parseAttributeList('TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,URI="en.m3u8"');
  assert.equal(attrs.TYPE, "SUBTITLES");
  assert.equal(attrs["GROUP-ID"], "subs");
  assert.equal(attrs.NAME, "English");
  assert.equal(attrs.DEFAULT, "YES");
  assert.equal(attrs.URI, "en.m3u8");
});

test("parseMasterManifest extracts variants, audio and subtitles", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,AUDIO="aud",SUBTITLES="sub"',
    "video/1080.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720',
    "https://cdn.example.com/video/720.m3u8",
  ].join("\n");

  const parsed = parseMasterManifest(master, "https://cdn.example.com/path/master.m3u8");
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].resolution, "1080p");
  assert.equal(parsed.variants[0].uri, "https://cdn.example.com/path/video/1080.m3u8");
  assert.equal(parsed.variants[1].uri, "https://cdn.example.com/video/720.m3u8");
  assert.equal(parsed.audio.length, 1);
  assert.equal(parsed.audio[0].uri, "https://cdn.example.com/path/audio/en.m3u8");
  assert.equal(parsed.subtitles.length, 1);
  assert.equal(parsed.subtitles[0].uri, "https://cdn.example.com/path/subs/en.m3u8");
});

test("rewriteManifest rewrites segment, playlist and URI attributes", () => {
  const codec = {
    encode: (url, provider) => `enc(${provider}:${url})`,
  };
  const raw = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",URI="subs/en.m3u8"',
    "#EXTINF:4.0,",
    "segments/1.ts",
    "#EXTINF:4.0,",
    "segments/2.ts",
  ].join("\n");

  const rewritten = rewriteManifest(raw, {
    baseUrl: "https://cdn.example.com/path/master.m3u8",
    assetId: "movie-550",
    token: "tok+en",
    origin: "https://edge.example.com",
    provider: "framextv",
    codec,
  });

  assert.ok(rewritten.includes("https://edge.example.com/stream/chunk/enc(framextv:https://cdn.example.com/path/keys/key.bin)"));
  assert.ok(rewritten.includes("https://edge.example.com/stream/chunk/enc(framextv:https://cdn.example.com/path/init.mp4)"));
  assert.ok(rewritten.includes("https://edge.example.com/hls/movie-550/res/enc(framextv:https://cdn.example.com/path/subs/en.m3u8)?token=tok%2Ben"));
  assert.ok(rewritten.includes("https://edge.example.com/stream/chunk/enc(framextv:https://cdn.example.com/path/segments/1.ts)"));
  assert.ok(!rewritten.split("\n").includes("segments/1.ts"));
});

test("isPlaylistUrl recognises query-string playlists", () => {
  assert.equal(isPlaylistUrl("https://cdn.example.com/a/index.m3u8?token=1"), true);
  assert.equal(isPlaylistUrl("https://cdn.example.com/a/segment.ts"), false);
});

console.log("\n[subtitles] conversion + sniffing");
test("SRT converts to WebVTT", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n";
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:01.000 --> 00:00:02.500"));
  assert.ok(vtt.includes("Hello"));
  assert.ok(!/\r/.test(vtt));
});

test("ASS converts to WebVTT", () => {
  const ass = [
    "[Script Info]",
    "Title: Test",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello\\Nworld{\\i0}",
  ].join("\n");
  const vtt = assToVtt(ass);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:01.000 --> 00:00:02.500"));
  assert.ok(vtt.includes("Hello\nworld"));
  assert.ok(!vtt.includes("{\\i1}"));
});

test("UTF-16LE subtitles decode correctly", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nHéllo\n";
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  const decoded = decodeSubtitleBytes(bytes);
  assert.ok(decoded.includes("Héllo"));
});

test("toVttFromBytes reports format and content type", () => {
  const srt = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHi\n");
  const result = toVttFromBytes(srt);
  assert.equal(result.format, "srt");
  assert.ok(result.contentType.startsWith("text/vtt"));
  assert.ok(result.text.startsWith("WEBVTT"));
});

test("HLS subtitle playlists pass through untouched", () => {
  const playlist = "#EXTM3U\n#EXTINF:4.0,\nseg.ts\n";
  const result = convertSubtitleToVtt(playlist);
  assert.equal(result.format, "hls");
  assert.equal(result.text, playlist);
});

test("sniffMediaType detects common containers", () => {
  assert.equal(sniffMediaType(new Uint8Array([0x47, 0, 0, 0])), "video/mp2t");
  assert.equal(sniffMediaType(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), "video/mp4");
  assert.equal(sniffMediaType(new TextEncoder().encode("WEBVTT\n\n")), "text/vtt; charset=utf-8");
  assert.equal(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), "video/webm");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
