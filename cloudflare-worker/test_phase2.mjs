/**
 * VidLyte Phase 2 verification harness
 * ---------------------------------------------------------------------------
 * Exercises resilience primitives, the AsianFlix/Blogger resolver and the
 * Phase 0/2 wiring that lives in index.js (static checks, no Worker runtime).
 *
 *   node test_phase2.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  TTLCache,
  createCoalescer,
  CircuitBreakerRegistry,
  retryWithJitter,
  backoffDelay,
  staleWhileRevalidate,
} from "./src/resilience.js";
import {
  PROVIDER_DEFINITIONS,
  normalizeProviderId,
  providerLabel,
  providerPriority,
  defaultProviderOrder,
  slugifyTitle,
  normalizeTitleForMatch,
  titleMatches,
  extractBalancedJson,
  extractAsianFlixConfig,
  parseAsianFlixPlaylist,
  pickEpisodeEntry,
  inferEpisodeNumber,
  findAsianFlixPage,
  findBloggerPost,
  resolveAsianFlix,
} from "./src/providers.js";
import { assertSafeUpstreamUrl } from "./src/security.js";

const here = dirname(fileURLToPath(import.meta.url));
const readWorkerFile = (name) => readFileSync(join(here, name), "utf8");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(` FAIL ${name}`);
    console.log(`      ${error && error.message}`);
  }
}

console.log("\n[resilience] TTL cache");
await test("TTLCache reports fresh, stale and expired entries", () => {
  const cache = new TTLCache({ maxEntries: 10, defaultTtlMs: 30, defaultStaleMs: 30 });
  cache.set("k", { value: 1 }, 20, 20);
  const fresh = cache.get("k");
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.value.value, 1);
  assert.ok(fresh.ageMs >= 0);
  cache.delete("k");
  assert.equal(cache.get("k"), null);
});

await test("TTLCache bounds its size", () => {
  const cache = new TTLCache({ maxEntries: 3, defaultTtlMs: 1000, defaultStaleMs: 1000 });
  for (let i = 0; i < 6; i++) cache.set(`k${i}`, i, 1000, 1000);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("k0"), null);
  assert.ok(cache.get("k5"));
});

console.log("\n[resilience] coalescing + retries");
await test("createCoalescer collapses concurrent identical loads", async () => {
  const coalesce = createCoalescer();
  let calls = 0;
  const loader = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return calls;
  };
  const [a, b, c] = await Promise.all([
    coalesce("same", loader),
    coalesce("same", loader),
    coalesce("same", loader),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
  await coalesce("same", loader);
  assert.equal(calls, 2);
});

await test("backoffDelay grows and stays bounded", () => {
  const a = backoffDelay(0, 100, 1000, () => 1);
  const b = backoffDelay(3, 100, 1000, () => 1);
  assert.equal(a, 100);
  assert.equal(b, 800);
  const capped = backoffDelay(20, 100, 1000, () => 1);
  assert.equal(capped, 1000);
});

await test("retryWithJitter retries transient failures", async () => {
  let attempts = 0;
  const value = await retryWithJitter(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    },
    { attempts: 4, baseMs: 1, maxMs: 2 }
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

await test("retryWithJitter respects shouldRetry", async () => {
  let attempts = 0;
  await assert.rejects(
    retryWithJitter(
      async () => {
        attempts++;
        throw new Error("permanent");
      },
      { attempts: 5, baseMs: 1, maxMs: 2, shouldRetry: () => false }
    )
  );
  assert.equal(attempts, 1);
});

console.log("\n[resilience] circuit breaker + SWR");
await test("circuit breaker opens, cools down and half-opens", () => {
  const registry = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 1000, halfOpenMaxAttempts: 1 });
  assert.equal(registry.canAttempt("p"), true);
  registry.recordFailure("p", new Error("boom"));
  assert.equal(registry.isOpen("p"), false);
  registry.recordFailure("p", new Error("boom"));
  assert.equal(registry.isOpen("p"), true);
  assert.equal(registry.canAttempt("p"), false);

  const openedAt = registry.state("p").openedAt;
  assert.equal(registry.canAttempt("p", openedAt + 1001), true);
  assert.equal(registry.canAttempt("p", openedAt + 1001), false);
  registry.recordSuccess("p", 42);
  assert.equal(registry.isOpen("p"), false);
  assert.equal(registry.state("p").lastLatencyMs, 42);
});

await test("staleWhileRevalidate serves stale and refreshes in background", async () => {
  const cache = new TTLCache({ maxEntries: 10 });
  cache.set("k", "old", 0, 60_000);
  await new Promise((resolve) => setTimeout(resolve, 3));
  let loads = 0;
  const pending = [];
  const result = await staleWhileRevalidate(cache, "k", {
    ttlMs: 50,
    staleMs: 60_000,
    loader: async () => {
      loads++;
      return "new";
    },
    waitUntil: (promise) => pending.push(promise),
  });
  assert.equal(result.stale, true);
  assert.equal(result.value, "old");
  assert.equal(loads, 1);
  await Promise.all(pending);
  assert.equal(cache.get("k").value, "new");
});

await test("staleWhileRevalidate blocks only on a cold miss", async () => {
  const cache = new TTLCache({ maxEntries: 10 });
  const result = await staleWhileRevalidate(cache, "cold", {
    ttlMs: 50,
    staleMs: 0,
    loader: async () => "value",
  });
  assert.equal(result.hit, false);
  assert.equal(result.value, "value");
});

console.log("\n[providers] registry + matching helpers");
await test("provider aliases normalise to canonical ids", () => {
  assert.equal(normalizeProviderId("Server 1"), "framextv");
  assert.equal(normalizeProviderId("s2"), "orion");
  assert.equal(normalizeProviderId("vidrift"), "orion");
  assert.equal(normalizeProviderId("rumble"), "asianflix");
  assert.equal(normalizeProviderId("2embed"), "2vcdn");
  assert.equal(normalizeProviderId(""), "framextv");
});

await test("provider definitions are ordered by priority", () => {
  assert.equal(PROVIDER_DEFINITIONS.length, 5);
  assert.deepEqual(defaultProviderOrder(), ["orion", "evion", "framextv", "asianflix", "2vcdn"]);
  assert.equal(providerPriority("asianflix"), 4);
  assert.equal(providerLabel("asianflix"), "AsianFlix");
});

await test("title slug and match helpers normalise punctuation and years", () => {
  assert.equal(slugifyTitle("Final Table (2026)"), "final-table-2026");
  assert.equal(slugifyTitle("Tom & Jerry"), "tom-and-jerry");
  assert.equal(normalizeTitleForMatch("Final Table (2026)"), "final table");
  assert.equal(titleMatches("Final Table (2026)", "Final Table", "2026"), true);
  assert.equal(titleMatches("Final Table (2026)", "Final Table", "2025"), false);
  assert.equal(titleMatches("Another Show (2026)", "Final Table", "2026"), false);
});

await test("extractBalancedJson handles nested braces and strings", () => {
  const text = 'prefix {"a":{"b":"}"},"c":[1,2]} suffix';
  const parsed = extractBalancedJson(text, text.indexOf("{"));
  assert.deepEqual(parsed, { a: { b: "}" }, c: [1, 2] });
});

console.log("\n[providers] AsianFlix parsing");
const pageHtml = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Final Table (2026)">
<meta property="og:image" content="https://asianflix.one/poster.jpg">
</head><body>
<script id="playlist-js-before">
const videoPlayerSettings = {"license":"abc","playerContainer":"x","bloggerAPI":{"blogId":["3941195089360643692"]}};
</script>
</body></html>`;

await test("extractAsianFlixConfig reads blog ids and page metadata", () => {
  const config = extractAsianFlixConfig(pageHtml);
  assert.deepEqual(config.blogIds, ["3941195089360643692"]);
  assert.equal(config.title, "Final Table (2026)");
  assert.equal(config.posterUrl, "https://asianflix.one/poster.jpg");
});

await test("parseAsianFlixPlaylist parses pipe-delimited episodes", () => {
  const content = [
    "https://rumble.com/hls-vod/AAA/playlist.m3u8|English|https://res.cloudinary.com/a.vtt;",
    "https://hugh.cdn.rumble.cloud/video/BBB.mp4|Hindi|https://res.cloudinary.com/b.vtt;",
    "",
    "<img src=\"https://blogger.googleusercontent.com/x.jpg\"/>",
  ].join("\n");
  const entries = parseAsianFlixPlaylist(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].streamUrl, "https://rumble.com/hls-vod/AAA/playlist.m3u8");
  assert.equal(entries[0].language, "English");
  assert.equal(entries[0].subtitleUrl, "https://res.cloudinary.com/a.vtt");
  assert.equal(entries[1].isMP4, true);
});

await test("parseAsianFlixPlaylist infers episode numbers from subtitle filenames", () => {
  const content = [
    "https://rumble.com/hls-vod/AAA/playlist.m3u8|English|https://res.cloudinary.com/Final_Table_2026_Ep1_x.vtt;",
    "https://rumble.com/hls-vod/BBB/playlist.m3u8|English|https://res.cloudinary.com/Final_Table_2026_Ep2_x.vtt;",
  ].join("\n");
  const entries = parseAsianFlixPlaylist(content);
  assert.equal(entries[0].episodeNumber, 1);
  assert.equal(entries[1].episodeNumber, 2);
  assert.equal(inferEpisodeNumber("https://x/E07.mp4"), 7);
  assert.equal(inferEpisodeNumber("https://x/playlist.m3u8"), 0);
});

await test("pickEpisodeEntry prefers explicit episode numbers when available", () => {
  const entries = [
    { streamUrl: "trailer", episodeNumber: 0 },
    { streamUrl: "ep1", episodeNumber: 1 },
    { streamUrl: "ep2", episodeNumber: 2 },
  ];
  assert.equal(pickEpisodeEntry(entries, { type: "tv", episode: 2 }).streamUrl, "ep2");
  assert.equal(pickEpisodeEntry(entries, { type: "tv", episode: 3 }), null);
});

await test("parseAsianFlixPlaylist decodes HTML entities and deduplicates", () => {
  const content =
    "https://rumble.com/hls-vod/A&amp;b/playlist.m3u8|English|;<br>https://rumble.com/hls-vod/A&amp;b/playlist.m3u8|English|;";
  const entries = parseAsianFlixPlaylist(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].streamUrl, "https://rumble.com/hls-vod/A&b/playlist.m3u8");
});

await test("pickEpisodeEntry selects by episode and handles movies", () => {
  const entries = [{ streamUrl: "a" }, { streamUrl: "b" }, { streamUrl: "c" }];
  assert.equal(pickEpisodeEntry(entries, { type: "tv", episode: 2 }).streamUrl, "b");
  assert.equal(pickEpisodeEntry(entries, { type: "tv", episode: 99 }), null);
  assert.equal(pickEpisodeEntry(entries, { type: "movie" }).streamUrl, "a");
  assert.equal(pickEpisodeEntry([], { type: "movie" }), null);
});

console.log("\n[providers] AsianFlix resolution pipeline");
const feedJson = {
  feed: {
    entry: [
      {
        title: { $t: "Final Table (2026)" },
        content: {
          $t:
            "https://rumble.com/hls-vod/AAA/playlist.m3u8|English|https://res.cloudinary.com/a.vtt;\n" +
            "https://rumble.com/hls-vod/BBB/playlist.m3u8|English|https://res.cloudinary.com/b.vtt;",
        },
      },
    ],
  },
};

await test("findBloggerPost ranks the matching title", async () => {
  const fetchImpl = async (url) => {
    assert.ok(String(url).includes("www.blogger.com/feeds/3941195089360643692/posts/default"));
    return { ok: true, status: 200, text: async () => JSON.stringify(feedJson) };
  };
  const post = await findBloggerPost({
    blogId: "3941195089360643692",
    query: "Final Table",
    year: "2026",
    fetchImpl,
  });
  assert.equal(post.title, "Final Table (2026)");
  assert.ok(post.content.includes("AAA"));
});

await test("resolveAsianFlix resolves movie and per-episode TV entries", async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("blogger.com/feeds")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(feedJson) };
    }
    if (target.includes("asianflix.one/final-table-2026/")) {
      return { ok: true, status: 200, text: async () => pageHtml };
    }
    return { ok: false, status: 404, text: async () => "" };
  };

  const movie = await resolveAsianFlix({
    assetInfo: { type: "movie", id: "550" },
    title: "Final Table",
    year: "2026",
    pageOverrides: ["https://asianflix.one/final-table-2026/"],
    fetchImpl,
  });
  assert.ok(movie);
  assert.equal(movie.streamUrl, "https://rumble.com/hls-vod/AAA/playlist.m3u8");
  assert.equal(movie.provider, "asianflix");
  assert.equal(movie.subtitles.length, 1);
  assert.equal(movie.subtitles[0].language, "eng");
  assert.equal(movie.pageUrl, "https://asianflix.one/final-table-2026/");

  const tv = await resolveAsianFlix({
    assetInfo: { type: "tv", id: "1", season: 1, episode: 2 },
    title: "Final Table",
    year: "2026",
    pageOverrides: ["https://asianflix.one/final-table-2026/"],
    fetchImpl,
  });
  assert.ok(tv);
  assert.equal(tv.streamUrl, "https://rumble.com/hls-vod/BBB/playlist.m3u8");
});

await test("findAsianFlixPage falls back to the WordPress search endpoint", async () => {
  const searchResult = [
    { title: "Unknown Show (2026)", url: "https://asianflix.one/unknown-show-2026b/" },
  ];
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/wp-json/wp/v2/search")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(searchResult) };
    }
    if (target === "https://asianflix.one/unknown-show-2026b/") {
      return { ok: true, status: 200, text: async () => pageHtml };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
  const page = await findAsianFlixPage({
    title: "Unknown Show",
    year: "2026",
    fetchImpl,
  });
  assert.ok(page);
  assert.equal(page.url, "https://asianflix.one/unknown-show-2026b/");
  assert.deepEqual(page.config.blogIds, ["3941195089360643692"]);
});

await test("resolveAsianFlix returns null when nothing matches", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "" });
  const result = await resolveAsianFlix({
    assetInfo: { type: "movie", id: "1" },
    title: "Does Not Exist",
    year: "2026",
    fetchImpl,
  });
  assert.equal(result, null);
});

console.log("\n[security] expanded upstream allowlist");
await test("Rumble and Blogger media hosts are allowlisted", () => {
  for (const url of [
    "https://rumble.com/hls-vod/A7DRpoztxFk/playlist.m3u8",
    "https://hugh.cdn.rumble.cloud/video/x.mp4",
    "https://blogger.googleusercontent.com/img/x.jpg",
    "https://res.cloudinary.com/demo/raw/upload/x.vtt",
  ]) {
    assert.doesNotThrow(() => assertSafeUpstreamUrl(url, { requireAllowlist: true }));
  }
});

console.log("\n[worker] Phase 0 + 2 wiring");
const indexSource = readWorkerFile("src/index.js");

await test("static featured-stream fallback is removed", () => {
  assert.equal(indexSource.includes("featuredStreams"), false);
  assert.equal(indexSource.includes("exp=1793658600"), false);
});

await test("worker exposes scheduled maintenance and deep health", () => {
  assert.ok(indexSource.includes("async scheduled(event, env, ctx)"));
  assert.ok(indexSource.includes("runScheduledMaintenance"));
  assert.ok(indexSource.includes("buildDeepHealthPayload"));
  assert.ok(indexSource.includes('url.pathname === "/health"'));
});

await test("worker exposes provider admin endpoints", () => {
  assert.ok(indexSource.includes("/api/providers/health"));
  assert.ok(indexSource.includes("/api/providers/probe"));
  assert.ok(indexSource.includes("/api/providers/test"));
});

await test("worker wires request IDs and edge timing headers", () => {
  assert.ok(indexSource.includes("X-Request-Id"));
  assert.ok(indexSource.includes("X-Edge-Time-Ms"));
  assert.ok(indexSource.includes("makeRequestId"));
});

await test("worker wires stale-while-revalidate through resolver call sites", () => {
  const matches = indexSource.match(/resolveUpstreamSource\(assetInfo[^;]*?waitUntil/g) || [];
  assert.ok(matches.length >= 3, `expected >=3 SWR call sites, got ${matches.length}`);
});

await test("worker persists provider health and supports AsianFlix overrides", () => {
  assert.ok(indexSource.includes("PROVIDER_HEALTH_KV_KEY"));
  assert.ok(indexSource.includes("page_overrides"));
  assert.ok(indexSource.includes("resolveAsianFlix"));
});

await test("runtime config carries an explicit version", () => {
  assert.ok(indexSource.includes("CONFIG_VERSION"));
  assert.ok(indexSource.includes("config_version"));
  assert.ok(indexSource.includes("updated_at"));
});

await test("cron trigger and admin provider UI are configured", () => {
  const wrangler = readWorkerFile("wrangler.toml");
  const admin = readWorkerFile("src/admin.html");
  assert.ok(wrangler.includes("[triggers]"));
  assert.ok(wrangler.includes("*/15 * * * *"));
  assert.ok(admin.includes("providerHealthContainer"));
  assert.ok(admin.includes("probeProviders"));
  assert.ok(admin.includes("testProvider"));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
