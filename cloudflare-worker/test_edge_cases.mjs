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

import {
  resolveKissKH,
  resolveKissKHSiblingBatch,
  KISSKH_DOMAINS,
  kisskhTemplateFromUrl,
  kisskhTemplateKeyFromAsset,
  seedKisskhTemplateFromUrl,
} from "./src/providers.js";
import { decryptKisskhSubtitle, convertSubtitleToVtt, toVttFromBytes } from "./src/subtitles.js";
import { assertSafeUpstreamUrl, createOpaqueCodec, issuePlaybackToken, verifyPlaybackToken, parseSecretKeys, isStreamUrlUsable } from "./src/security.js";
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

console.log("\n[edge] KissKH CDN template fast path (API edge-blocked)");

function makeMockKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, type) {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

await test("derives a CDN template from both KissKH URL shapes", () => {
  assert.equal(
    kisskhTemplateFromUrl("https://hls07.cdnvideo11.shop/hls07/8409/Ep5_index.m3u8", 5),
    "https://hls07.cdnvideo11.shop/hls07/8409/Ep{ep}_index.m3u8"
  );
  assert.equal(
    kisskhTemplateFromUrl("https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep4/index.m3u8?v=abc", 4),
    "https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep{ep}/index.m3u8"
  );
  assert.equal(kisskhTemplateFromUrl("https://cdn.example.com/no-episode/index.m3u8", 3), "");
  assert.equal(kisskhTemplateFromUrl("https://tmp.cdnvideo11.shop/tmp/Show-Ep10/index.m3u8", 1), "");
});

await test("maps assets to per-show season templates", () => {
  assert.equal(kisskhTemplateKeyFromAsset("tv/341436/1/4"), "kisskh_tmpl_v1:tv/341436/s1");
  assert.equal(kisskhTemplateKeyFromAsset("tv/341436/2/1"), "kisskh_tmpl_v1:tv/341436/s2");
  assert.equal(kisskhTemplateKeyFromAsset("movie/550"), "kisskh_tmpl_v1:movie/550");
  assert.equal(kisskhTemplateKeyFromAsset("bogus"), "");
});

await test("seeds and reuses the per-asset template without touching the API", async () => {
  const kv = makeMockKv();
  const seeded = await seedKisskhTemplateFromUrl(
    kv,
    "tv/341436/1/4",
    "https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep4/index.m3u8?v=uuid",
    4
  );
  assert.equal(seeded, true);
  assert.equal(
    kv.store.get("kisskh_tmpl_v1:tv/341436/s1"),
    "https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep{ep}/index.m3u8"
  );
  assert.equal(await seedKisskhTemplateFromUrl(kv, "bogus", "https://x/Ep1_index.m3u8", 1), false);
});

await test("cold miss guesses the tmp CDN slug from the TMDB title (API blocked)", async () => {
  const kv = makeMockKv();
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (url === "https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep4/index.m3u8") {
      return new Response("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6,\nseg0.ts\n", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "341436", season: 1, episode: 4 },
    title: "Vow of Autumn (2026)",
    year: "2026",
    originalLanguage: "zh",
    kv,
    fetchImpl,
    timeoutMs: 1500,
  });

  assert.ok(res, "the CDN guess must resolve without the JSON API");
  assert.equal(res.provider, "kisskh");
  assert.equal(res.streamUrl, "https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep4/index.m3u8");
  assert.equal(res.isMP4, false);
  assert.equal(res.audioTracks[0].language, "zho");
  assert.ok(!probed.some((u) => u.includes("kisskh.is")), "no API call should be made when the CDN guess hits");
  assert.equal(
    kv.store.get("kisskh_tmpl_v1:tv/341436/s1"),
    "https://tmp.cdnvideo11.shop/tmp/Vow-of-Autumn-2026-Ep{ep}/index.m3u8",
    "a successful guess must persist the template for the next episode"
  );
});

await test("known template resolves a new episode with one probe and zero API calls", async () => {
  const kv = makeMockKv({
    "kisskh_tmpl_v1:tv/341707/s1":
      "https://tmp.cdnvideo11.shop/tmp/Rise-of-the-Underdog-2026-Ep{ep}/index.m3u8",
  });
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (url === "https://tmp.cdnvideo11.shop/tmp/Rise-of-the-Underdog-2026-Ep3/index.m3u8") {
      return new Response("#EXTM3U\n#EXTINF:4,\nseg.ts\n", { status: 200 });
    }
    return new Response("blocked", { status: 403 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "341707", season: 1, episode: 3 },
    title: "Rise of the Underdog (2026)",
    year: "2026",
    originalLanguage: "zh",
    kv,
    fetchImpl,
    timeoutMs: 1500,
  });

  assert.equal(res.streamUrl, "https://tmp.cdnvideo11.shop/tmp/Rise-of-the-Underdog-2026-Ep3/index.m3u8");
  assert.equal(probed.length, 1, "a cached template must cost exactly one probe");
  assert.ok(!probed[0].includes("kisskh."), "the template path must not hit the JSON API");
});

await test("stale template that 404s falls back to the API instead of failing", async () => {
  const kv = makeMockKv({
    "kisskh_tmpl_v1:tv/55555/s1": "https://tmp.cdnvideo11.shop/tmp/Dead-Show-2020-Ep{ep}/index.m3u8",
  });
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (url.includes("tmp.cdnvideo11.shop")) return new Response("gone", { status: 404 });
    if (url.includes("/Search")) {
      return new Response(JSON.stringify([{ id: 55555, title: "Dead Show (2020)" }]), { status: 200 });
    }
    if (url.includes("/Drama/")) {
      return new Response(JSON.stringify({
        id: 55555,
        title: "Dead Show",
        episodes: [{ id: 9001, number: 2 }],
      }), { status: 200 });
    }
    if (url.includes("/Episode/9001")) {
      return new Response(JSON.stringify({ Video: "https://hls1.cdnvideo11.shop/hls/55555/Ep2_index.m3u8", Type: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "55555", season: 1, episode: 2 },
    title: "Dead Show (2020)",
    year: "2020",
    originalLanguage: "ko",
    kv,
    fetchImpl,
    timeoutMs: 1500,
  });

  assert.ok(res, "a stale template must not poison resolution");
  assert.equal(res.streamUrl, "https://hls1.cdnvideo11.shop/hls/55555/Ep2_index.m3u8");
});

await test("non-Asian titles never spend probes on the KissKH CDN guess", async () => {
  const kv = makeMockKv();
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (url.includes("/Search")) {
      return new Response(JSON.stringify([{ id: 42, title: "Breaking Bad" }]), { status: 200 });
    }
    if (url.includes("/Drama/")) {
      return new Response(JSON.stringify({ id: 42, title: "Breaking Bad", episodes: [{ id: 7, number: 1 }] }), { status: 200 });
    }
    if (url.includes("/Episode/7")) {
      return new Response(JSON.stringify({ Video: "https://hls1.cdnvideo11.shop/hls/42/Ep1_index.m3u8", Type: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "1396", season: 1, episode: 1 },
    title: "Breaking Bad",
    year: "2008",
    originalLanguage: "en",
    kv,
    fetchImpl,
    timeoutMs: 1500,
  });

  assert.ok(res);
  assert.ok(
    !probed.some((u) => u.includes("tmp.cdnvideo11.shop")),
    "a known non-Asian title must skip CDN slug guessing"
  );
});

await test("template fast path stays safe for movies and bad episode numbers", async () => {
  const kv = makeMockKv({
    "kisskh_tmpl_v1:movie/550": "https://tmp.cdnvideo11.shop/tmp/Movie-Ep{ep}/index.m3u8",
  });
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    return new Response("blocked", { status: 403 });
  };
  const res = await resolveKissKH({
    assetInfo: { type: "movie", id: "550" },
    title: "Fight Club",
    year: "1999",
    originalLanguage: "en",
    kv,
    fetchImpl,
    timeoutMs: 800,
  });
  assert.equal(res, null);
  assert.ok(probed.length > 0);
  assert.ok(!probed.some((u) => u.includes("EpNaN") || u.includes("Ep0/")), "episode numbers must be sane");
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
  assert.ok(idx.includes("salvagedPrimary"), "salvage reachable KissKH/dub tracks when a mixed KV record has an unbacked Orion masterManifest");
  assert.ok(idx.includes("encodeURIComponent(assetHyphenId)}/res/${opaque}?token="), "/api/multi-audio/status must issue token-authenticated hyphenated asset HLS URLs");
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
  assert.ok(player.includes("lvlH && lvlH > 0"), "LEVEL_SWITCHED must not display Quality 0P");
  assert.ok(player.includes("seenHlsAudio"), "HLS internal audio list must deduplicate and skip Unknown");
  const idx = readSrc("src/index.js");
  assert.ok(idx.includes("pruneDeadMasterVariants"), "edge must prune dead/hung HLS variants so player never stalls");
  assert.ok(player.includes("levelFailures"), "player must auto-failover between HLS levels on chunk timeouts");
  assert.ok(player.includes("function setupSubtitleTracks()"), "setupSubtitleTracks must be defined (called on dynamic source & upgrades)");
  assert.ok(!player.includes("changeStreamSource("), "undefined changeStreamSource reference must not exist");
  assert.ok(player.includes("REMOTE_POLL_INTERVAL_MS = 1500"), "remote multi-audio poll interval must be responsive");
  assert.ok(idx.includes("function mapOrionPlaylist("), "index.js must map Orion init-stream URLs for warmManifests");
  assert.ok(idx.includes("hasOrionSubForUri("), "Orion filter must preserve .mp4 dubs while skipping unbacked HLS dubs");
  assert.ok(idx.includes("withRaceBudget"), "resolveUpstreamSource must race providers within a bounded budget");
});

await test("KissKH fast path preserves cached subtitles and probes versionless sibling CDN URLs", async () => {
  const kv = makeMockKv({
    "kisskh_tmpl_v1:tv/305551/s1": "https://hls08.cdnvideo11.shop/hls08/13793/Ep{ep}.v675_index.m3u8",
    "kisskh_subpattern_v1:13793": "https://sub.cdnvideo11.shop/auto-upload/13793/Ep{ep}.en.srt",
  });
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (url === "https://hls08.cdnvideo11.shop/hls08/13793/Ep8_index.m3u8") {
      return new Response("#EXTM3U\n#EXTINF:4,\nseg.ts\n", { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "305551", season: 1, episode: 8 },
    title: "Merry Berry Love",
    year: "2026",
    originalLanguage: "ja",
    kv,
    fetchImpl,
    timeoutMs: 1500,
  });

  assert.ok(res, "versionless CDN fallback must resolve when .vXXX changes across episodes");
  assert.equal(res.streamUrl, "https://hls08.cdnvideo11.shop/hls08/13793/Ep8_index.m3u8");
  assert.ok(res.subtitles && res.subtitles.length > 0, "fast path must preserve KissKH subtitles when dramaId is present");
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

  const pastUnix = Math.floor(Date.now() / 1000) - 600;
  const futureUnix = Math.floor(Date.now() / 1000) + 7200;
  assert.equal(isStreamUrlUsable(`https://img1.fcxmb.com/hls/720/index.m3u8?Expires=${pastUnix}`), false, "expired Expires= must be rejected");
  assert.equal(isStreamUrlUsable(`https://img1.fcxmb.com/hls/720/index.m3u8?Expires=${futureUnix}`), true, "future Expires= must be accepted");
  assert.equal(isStreamUrlUsable(`https://cdn.example.com/a.m3u8?exp=${pastUnix}`), false, "expired exp= must be rejected");
});

await test("resolveKissKH skips duplicate search on edge block and resolver fast-paths hold", async () => {
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/DramaList/Search")) {
      searchCalls++;
      return new Response("Forbidden", { status: 403 });
    }
    return new Response("Not Found", { status: 404 });
  };

  const res = await resolveKissKH({
    assetInfo: { type: "tv", id: "9999999", season: 1, episode: 1 },
    title: "Secret Drama: Special Edition",
    year: "2026",
    originalLanguage: "ko",
    kv: makeMockKv(),
    fetchImpl,
    timeoutMs: 800,
  });

  assert.equal(res, null);
  assert.equal(searchCalls, 5, "blocked primarySearch must query the 5 mirrors once without running a redundant raw-title retry");

  const idx = readSrc("src/index.js");
  assert.ok(idx.includes("PRIORITY_GRACE_MS"), "resolveUpstreamSource must use bounded event-driven priority racing");
  assert.ok(idx.includes("kisskhAlreadyTried"), "resolveUpstreamSource must skip redundant sequential resolveKissKH when fastPool/KV already checked");
  assert.ok(idx.includes("prefetchedMaRecord"), "cold preflight must run TMDB and KV ma_status_v1 lookups in parallel");
  assert.ok(idx.includes("rawManifestCache.set(safeUrl, { body, expiresAt: Date.now() + RAW_MANIFEST_TTL_MS })"), "verifyManifestPlayable must populate rawManifestCache to avoid duplicate fetches");
  assert.ok(idx.includes("fastCached.stale"), "resolveUpstreamSource must check sourceStaleCache before waiting on TMDB");
  const player = readSrc("src/player.html");
  assert.ok(player.includes('<link rel="preconnect" href="https://cdn.jsdelivr.net"'), "player.html must preconnect hls.js CDN");
});

await test("resolveKissKHSiblingBatch resolves remaining season episodes without extra Search/Drama calls", async () => {
  let episodeCalls = 0;
  let searchOrDramaCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/api/DramaList/Search") || u.includes("/api/DramaList/Drama/")) {
      searchOrDramaCalls++;
      return new Response("unexpected", { status: 500 });
    }
    if (u.includes("/api/DramaList/Episode/")) {
      episodeCalls++;
      const m = u.match(/Episode\/(\d+)\.png/);
      const epId = m ? m[1] : "0";
      return new Response(JSON.stringify({ Video: `https://hls08.cdnvideo11.shop/hls08/13133/Ep${epId}.v999_index.m3u8`, Type: 1 }), { status: 200 });
    }
    if (u.includes("/api/Sub/")) {
      return new Response(JSON.stringify([{ src: "https://sub.cdnvideo11.shop/en.srt", label: "English", land: "en", default: true }]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const siblings = await resolveKissKHSiblingBatch({
    assetInfo: { type: "tv", id: "314936", season: 1, episode: 10 },
    dramaContext: {
      dramaId: 13133,
      cleanTitle: "Don't Be Too Emotional",
      originalLanguage: "th",
      title: "Don't Be Too Emotional (2026)",
      posterUrl: "",
      drama: {
        title: "Don't Be Too Emotional (2026)",
        country: "Thailand",
        episodes: [
          { id: 223043, number: 10 },
          { id: 223253, number: 11 },
          { id: 223877, number: 12 },
          { id: 218474, number: 4 },
        ],
      },
    },
    excludeEpisodes: [10],
    fetchImpl,
    timeoutMs: 1000,
    concurrency: 2,
  });

  assert.equal(searchOrDramaCalls, 0);
  assert.equal(episodeCalls, 3);
  assert.deepEqual(siblings.map((s) => s.asset), [
    "tv/314936/1/11",
    "tv/314936/1/12",
    "tv/314936/1/4",
  ]);
  assert.equal(siblings[0].result.audioTracks[0].name, "Original (Thai)");
  assert.equal(siblings[0].result.subtitles[0].default, true);

  const idx = readSrc("src/index.js");
  assert.ok(idx.includes("isKissPlayable"), "status route must not stall playable KissKH streams behind 120s resolving grace");
  assert.ok(idx.includes("body.batch === true && Array.isArray(body.items)"), "publish route must support sibling batch publish");
  assert.ok(idx.includes("seenSubKeys"), "multi-audio payload sanitizer must deduplicate duplicate subtitle entries");
  const player = readSrc("src/player.html");
  assert.ok(player.includes("hydrateStreamMetadata("), "cold recovery must hydrate subtitles & audio before initial playback");
  assert.ok(player.includes("Promise.all([clientJob, remoteJob])"), "cold recovery must run remote & client resolvers in parallel");
  assert.ok(!/startResolvingCountdown\([^)]*KissKH/i.test(player), "player countdown UI must never display upstream provider names");
  assert.ok(player.includes("8056483646328763") && player.includes("sWODXX04QRTkHdlZ"), "player client subtitle decryptor must support all KissKH keys");
  const resolver = readSrc("scripts/resolve-multi-audio.mjs");
  assert.ok(resolver.includes("launchSiblingBatch(") && resolver.includes("onEarlyPublish"), "GH resolver must early-publish KissKH and batch season siblings");
  assert.ok(resolver.includes("discoveredSubUrls"), "Orion resolver must harvest audio/variant sub-manifests referenced inside masters");

  // Regression test for legacy KissKH (a1/a3) subtitle ciphertexts (e.g. Hidden Love 2023)
  const legacySrt = [
    "1",
    "00:00:29,820 --> 00:00:33,980",
    "8SDXM2phcW+GaQEKsHBS27mj06iChhZpsf30cM3i3UR+KjvMrpyCfKZLhlnXD2Ta",
    "",
  ].join("\n");
  const decLegacy = decryptKisskhSubtitle(legacySrt);
  assert.ok(decLegacy.includes("A beautiful place full of smiles"), `expected legacy a1 cipher to decrypt cleanly, got: ${decLegacy}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
