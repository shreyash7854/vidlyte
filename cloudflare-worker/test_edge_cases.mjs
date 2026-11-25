/**
 * VidLyte Extreme Edge-Case & Architecture Verification Suite
 * ---------------------------------------------------------------------------
 * Tests best-to-worst failure modes:
 *  - TMDB TTLCache unwrapping & dual-host failover
 *  - KissKH multi-domain failover (.is -> .cx -> .ovh -> .do), MP4 vs HLS,
 *    KV sibling/pattern recovery, AES-128 subtitle decryption & malformed input
 *  - Media vs subtitle routing guards (no MP4/TS intercepted as WebVTT)
 *  - Player audio switching, dynamic source fallback & retry state machine
 *  - SSRF/opaque token boundary adversarial inputs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveKissKH, KISSKH_DOMAINS } from "./src/providers.js";
import { decryptKisskhSubtitle, convertSubtitleToVtt, toVttFromBytes } from "./src/subtitles.js";
import { assertSafeUpstreamUrl, createOpaqueCodec, issuePlaybackToken, verifyPlaybackToken, parseSecretKeys } from "./src/security.js";
import { TTLCache } from "./src/resilience.js";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (p) => readFileSync(join(here, p), "utf8");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}:`, err && err.stack ? err.stack : err);
    failed++;
  }
}

console.log("\n[edge] KissKH domain failover & extreme API failures");
await test("fails over from blocked kisskh.is/.cx to kisskh.ovh", async () => {
  const seenHosts = [];
  const kvStore = new Map();
  const mockKv = {
    async get(k, type) {
      const v = kvStore.get(k);
      if (!v) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { kvStore.set(k, String(v)); },
  };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seenHosts.push(u.hostname);
    if (u.hostname === "kisskh.is") return new Response("forbidden", { status: 403 });
    if (u.hostname === "kisskh.cx") throw new Error("ETIMEDOUT");
    if (u.pathname.includes("/Search")) {
      return new Response(JSON.stringify([{ id: 9999, title: "Test Edge Drama (2026)" }]), { status: 200 });
    }
    if (u.pathname.includes("/Drama/9999")) {
      return new Response(JSON.stringify({
        id: 9999,
        title: "Test Edge Drama",
        country: "South Korea",
        episodes: [{ id: 55501, number: 1 }, { id: 55502, number: 2 }],
      }), { status: 200 });
    }
    if (u.pathname.includes("/Episode/55502")) {
      return new Response(JSON.stringify({ Video: "https://hls1.cdnvideo11.shop/hls/9999/Ep2_index.m3u8", Type: 1 }), { status: 200 });
    }
    if (u.pathname.includes("/Sub/55502")) {
      return new Response(JSON.stringify([{ src: "https://sub.cdnvideo11.shop/9999/Ep2.en.srt", land: "en", label: "English" }]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "99999", season: 1, episode: 2 },
    title: "Test Edge Drama: Chapter Two (2026)",
    year: "2026",
    originalLanguage: "ko",
    kv: mockKv,
    fetchImpl,
    timeoutMs: 3000,
  });

  assert.ok(KISSKH_DOMAINS.includes("kisskh.is") && KISSKH_DOMAINS.includes("kisskh.cx") && KISSKH_DOMAINS.includes("kisskh.ovh") && KISSKH_DOMAINS.includes("kisskh.do"));
  assert.ok(seenHosts.includes("kisskh.is") && seenHosts.includes("kisskh.cx") && seenHosts.includes("kisskh.ovh"));
  assert.equal(res.provider, "kisskh");
  assert.equal(res.isMP4, false);
  assert.equal(res.streamUrl, "https://hls1.cdnvideo11.shop/hls/9999/Ep2_index.m3u8");
  assert.equal(res.audioTracks[0].language, "kor");
  assert.equal(res.subtitles.length, 1);
  assert.ok(kvStore.has("kisskh_pattern_v1:9999"));
});

await test("recovers via deterministic pattern + subtitle pattern when Drama API dies mid-flight", async () => {
  const kvStore = new Map([
    ["kisskh_pattern_v1:7777", "https://hls08.cdnvideo11.shop/hls08/7777/Ep{ep}_index.m3u8"],
    ["kisskh_subpattern_v1:7777", "https://sub.cdnvideo11.shop/7777/Ep{ep}.en.srt"],
  ]);
  const mockKv = {
    async get(k, type) {
      const v = kvStore.get(k);
      if (!v) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { kvStore.set(k, String(v)); },
  };
  const fetchImpl = async (url) => {
    if (url.includes("/Search")) {
      return new Response(JSON.stringify([{ id: 7777, title: "Pattern Recovery" }]), { status: 200 });
    }
    if (url.includes("/Drama/")) {
      return new Response("blocked", { status: 503 });
    }
    if (url.includes("Ep5_index.m3u8")) {
      return new Response("#EXTM3U\n#EXTINF:6,\nseg0.ts\n", { status: 200 });
    }
    return new Response("err", { status: 500 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "88888", season: 1, episode: 5 },
    title: "Pattern Recovery",
    originalLanguage: "zh",
    kv: mockKv,
    fetchImpl,
    timeoutMs: 2500,
  });

  assert.ok(res);
  assert.equal(res.streamUrl, "https://hls08.cdnvideo11.shop/hls08/7777/Ep5_index.m3u8");
  assert.equal(res.subtitles[0].url, "https://sub.cdnvideo11.shop/7777/Ep5.en.srt");
  assert.equal(res.audioTracks[0].language, "zho");
});

await test("MP4 KissKH result sets isMP4=true properly", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/Search")) return new Response(JSON.stringify([{ id: 4444, title: "MP4 Show" }]), { status: 200 });
    if (url.includes("/Drama/")) return new Response(JSON.stringify({ id: 4444, title: "MP4 Show", episodes: [{ id: 101, number: 1 }] }), { status: 200 });
    if (url.includes("/Episode/")) return new Response(JSON.stringify({ Video: "https://cdnvideo11.shop/mp4/4444/Ep1.mp4", Type: 0 }), { status: 200 });
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "44444", season: 1, episode: 1 },
    title: "MP4 Show",
    originalLanguage: "th",
    fetchImpl,
  });
  assert.equal(res.isMP4, true);
  assert.equal(res.audioTracks[0].language, "tha");
});

console.log("\n[edge] Subtitles decryption & malformed inputs");
await test("handles mixed KissKH ciphertext, SRT commas, ASS tags, and garbage base64 safely", () => {
  const sample = [
    "1",
    "00:00:07,020 --> 00:00:11,220",
    "ZB1BD1inpCiSEKvwAj2wZs4uG1pKyfmAL1PCvJMldpaCWEgPo/rxoJKPBGiVMaUW0rWoTVwqh4W0EYuEBrsMAA==",
    "",
    "2",
    "00:00:12,000 --> 00:00:15,500",
    "{\\an8}Plain dialogue AAAAAAAAAAAAAAAA",
    "",
  ].join("\n");

  const dec = decryptKisskhSubtitle(sample);
  assert.ok(dec.includes("I've braved the storms"), "should decrypt valid AES block");
  assert.ok(dec.includes("Plain dialogue AAAAAAAAAAAAAAAA"), "must not mangle invalid/plain lines");

  const vtt = convertSubtitleToVtt(sample);
  assert.ok(vtt.text.startsWith("WEBVTT\n\n"));
  assert.ok(vtt.text.includes("00:00:07.020 --> 00:00:11.220"));
  assert.ok(!vtt.text.includes("{\\an8}"));
});

await test("toVttFromBytes passes HLS subtitle playlists through and enforces WEBVTT on raw bytes", () => {
  const hlsSubs = toVttFromBytes(new TextEncoder().encode("#EXTM3U\n#EXTINF:10,\nsub.vtt\n"));
  assert.equal(hlsSubs.format, "hls");
  const rawSrt = toVttFromBytes(new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHello\n"));
  assert.ok(rawSrt.text.startsWith("WEBVTT\n\n"));
  assert.ok(rawSrt.text.includes("00:00:01.000 --> 00:00:02.000"));
});

console.log("\n[edge] Codebase architecture contracts (cache unwrapping, proxy guards, player UX)");
await test("index.js unwraps all TTLCache.get() entries in fetchTMDBMetadata and isAsianContent", () => {
  const idx = readSrc("src/index.js");
  // Verify TTLCache returns { value, fresh, stale }
  const cache = new TTLCache({ defaultTtlMs: 1000 });
  cache.set("k", { title: "Vincenzo" });
  const raw = cache.get("k");
  assert.equal(raw.title, undefined);
  assert.equal(raw.value.title, "Vincenzo");

  const fetchMetaSlice = idx.slice(idx.indexOf("async function fetchTMDBMetadata"), idx.indexOf("function languageCodeForLabel"));
  assert.ok(fetchMetaSlice.includes("if (hit && hit.value) return hit.value;"), "fetchTMDBMetadata must return hit.value");
  assert.ok(fetchMetaSlice.includes("showHit && showHit.value"), "showCacheKey must unwrap .value");
  assert.ok(fetchMetaSlice.includes("Promise.allSettled(["), "fetchTMDBMetadata must parallelize show + episode fetches");
  assert.ok(idx.includes("const cachedShow = showHit && showHit.value ? showHit.value : null;"), "isAsianContent must unwrap .value");
  assert.ok(idx.includes("TMDB_API_HOSTS"), "TMDB fetcher must have api.themoviedb.org fallback host");
});

await test("index.js proxyUpstream never treats KissKH .mp4/.ts/.m3u8 media chunks as subtitles", () => {
  const idx = readSrc("src/index.js");
  const proxySlice = idx.slice(idx.indexOf("async function proxyUpstream"), idx.indexOf("/* --------------------------- Media chunks"));
  assert.ok(proxySlice.includes("const isKnownMediaExt ="), "must explicitly guard known video/audio extensions");
  assert.ok(proxySlice.includes("!isKnownMediaExt &&"), "isSubtitle must exclude known media extensions");
});

await test("index.js enables remote multi-audio polling when KV or dispatch token is present", () => {
  const idx = readSrc("src/index.js");
  assert.ok(idx.includes("enabled: Boolean(env && (env.GITHUB_DISPATCH_TOKEN || env.CONFIG_KV))"));
  assert.ok(idx.includes("upstreamType.includes(\"trolltech\")"), ".ts Qt MIME must normalize to video/mp2t");
  assert.ok(idx.includes("recordNeedsBlockedOrion"), "unreachable Orion KV manifests without subManifests must not win over live KissKH");
  assert.ok(idx.includes("seenEmbedAudioNames") && idx.includes("normalizeAudioLang"), "embed audio tracks must deduplicate by canonical language and name");
  const prov = readSrc("src/providers.js");
  assert.ok(prov.includes("Promise.any("), "KissKH fallback mirrors must race in parallel");
});

await test("player.html has zero pendingUpgradedStream refs, syncs audio state, and shows stream-ready overlay", () => {
  const player = readSrc("src/player.html");
  assert.ok(!player.includes("pendingUpgradedStream"), "pendingUpgradedStream reference must not exist");
  assert.ok(player.includes("Getting your stream ready"), "animated ready overlay message must exist");
  assert.ok(player.includes("currentStreamUrl = '';") && player.includes("fetchDynamicSourceAndPlay();"), "retry must clear stalled streamUrl");

  const loadNewSlice = player.slice(player.indexOf("function loadNewStream("), player.indexOf("function initHlsPlayer("));
  assert.ok(loadNewSlice.includes("setupAudioTracks();"), "loadNewStream MANIFEST_PARSED must call setupAudioTracks()");
  assert.ok(loadNewSlice.includes("window.__PENDING_AUDIO_TRACK_LANG__"), "loadNewStream must match by language rather than blind index");
});

console.log("\n[edge] Security adversarial inputs");
await test("assertSafeUpstreamUrl blocks SSRF vectors and opaque codec rejects tampered tokens", async () => {
  for (const bad of [
    "http://127.0.0.1/secret",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:8080/",
    "https://user:pass@cdnvideo11.shop/Ep1.m3u8",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => assertSafeUpstreamUrl(bad), `expected reject for ${bad}`);
  }
  const codec = createOpaqueCodec("test-hmac-secret-32chars-long-ok!");
  const tok = codec.encode("https://hls1.cdnvideo11.shop/Ep1.m3u8", "kisskh");
  assert.equal(codec.decode(tok).targetUrl, "https://hls1.cdnvideo11.shop/Ep1.m3u8");
  const tampered = tok.slice(0, -2) + (tok.endsWith("AA") ? "BB" : "AA");
  assert.equal(codec.decode(tampered), null);

  const secretSpec = parseSecretKeys("k1:test-secret-abcdefghijklmnop");
  const pbTok = await issuePlaybackToken("tv-303745-1-7", "1.2.3.4", 60, secretSpec);
  assert.equal(await verifyPlaybackToken("tv-303745-1-7", "1.2.3.4", pbTok, secretSpec), true);
  assert.equal(await verifyPlaybackToken("tv-303745-1-10", "1.2.3.4", pbTok, secretSpec), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
