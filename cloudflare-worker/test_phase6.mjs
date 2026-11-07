/**
 * VidLyte Phase 6 verification harness
 * ---------------------------------------------------------------------------
 * Covers share-with-timestamp, subtitle appearance persistence and anonymous
 * engagement telemetry. It also asserts the removed features stay removed:
 * no post-playback overlay, no TMDB recommendations endpoint, no portal
 * Continue Watching / My List rows and no in-player server switcher.
 *
 *   node test_phase6.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

const player = read("src/player.html");
const portal = read("src/portal.html");
const admin = read("src/admin.html");
const indexSource = read("src/index.js");

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

function hasAll(source, needles) {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `missing: ${needle}`);
  }
}

function hasNone(source, needles) {
  for (const needle of needles) {
    assert.ok(!source.includes(needle), `should be gone: ${needle}`);
  }
}

function inlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    if (/application\/json/i.test(match[1] || "")) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

console.log("\n[syntax] inline scripts");
await test("player inline scripts parse", () => {
  const scripts = inlineScripts(player);
  assert.ok(scripts.length > 0);
  scripts.forEach((script, i) => {
    assert.doesNotThrow(() => new Function(script), `player script #${i + 1}`);
  });
});

await test("portal inline scripts parse", () => {
  inlineScripts(portal).forEach((script, i) => {
    assert.doesNotThrow(() => new Function(script), `portal script #${i + 1}`);
  });
});

console.log("\n[player] no post-playback overlay");
await test("end-screen markup and styles are gone", () => {
  hasNone(player, [
    'id="endScreen"',
    'id="endTitle"',
    'id="endRecs"',
    'id="endReplayBtn"',
    'id="endNextBtn"',
    'id="endShareBtn"',
    ".end-screen",
    ".end-card",
    ".end-rec",
  ]);
});

await test("end-screen functions and timers are gone", () => {
  hasNone(player, [
    "function showEndScreen",
    "function hideEndScreen",
    "function renderEndRecommendations",
    "function goToTitle",
    "endScreenTimer",
    "show-end-screen",
    "/recommendations",
    "recommendation_click",
  ]);
});

await test("finishing playback clears progress and reports completion", () => {
  hasAll(player, [
    "video.addEventListener('ended'",
    "clearWatchProgress();",
    "sendEngagement('complete')",
  ]);
});

await test("TV autoplay-next still advances without an overlay", () => {
  hasAll(player, [
    "mediaType === 'tv' && episodeState.next && initialPrefs.autoplayNext !== false",
    "goToEpisode(episodeState.next.season, episodeState.next.episode)",
  ]);
});

await test("non-autoplay endings show a toast with replay", () => {
  hasAll(player, [
    "showPlayerToast(",
    "'Replay'",
    "video.currentTime = 0;",
  ]);
});

console.log("\n[player] share with timestamp");
await test("share control and helper exist", () => {
  hasAll(player, ['id="shareBtn"', "function shareCurrentMoment", "searchParams.set('t'", "navigator.share"]);
});

await test("share icon is a link-style glyph", () => {
  hasAll(player, ["M14 3h7v7h-2V6.41l-9.29 9.3"]);
});

await test("deep links honour ?t= before saved progress", () => {
  hasAll(player, ["q.get('t')", "deepLinkTime", "Shared moment"]);
});

console.log("\n[player] subtitle appearance persistence");
await test("appearance prefs are restored during init", () => {
  hasAll(player, [
    "initialPrefs.subFontChoice",
    "initialPrefs.subFontSizePercent",
    "initialPrefs.subPosPercent",
    "initialPrefs.subBgEnabled",
    "initialPrefs.subColorHex",
    "initialPrefs.subDelaySeconds",
  ]);
});

await test("appearance changes are persisted", () => {
  hasAll(player, [
    "savePlaybackPrefs({ subFontChoice: subFontChoice })",
    "savePlaybackPrefs({ subFontSizePercent: subFontSizePercent })",
    "savePlaybackPrefs({ subPosPercent: subPosPercent })",
    "savePlaybackPrefs({ subBgEnabled: subBgEnabled })",
    "savePlaybackPrefs({ subColorHex: subColorHex })",
    "savePlaybackPrefs({ subDelaySeconds: subDelaySeconds })",
  ]);
});

await test("appearance UI is re-synced from stored values", () => {
  hasAll(player, ["function syncSubtitleAppearanceUI", "textSizeSliderMob", "customColorCircleMob"]);
});

console.log("\n[player] engagement + progress metadata");
await test("engagement helper posts allowlisted events", () => {
  hasAll(player, [
    "function sendEngagement",
    "/api/telemetry/engagement",
    "navigator.sendBeacon",
    "sendEngagement('play')",
    "sendEngagement('complete')",
    "sendEngagement('share')",
    "sendEngagement('subtitle_change')",
  ]);
});

await test("progress entries carry enough metadata for resume", () => {
  hasAll(player, ["title: String(config.title", "poster: String(config.posterUrl", "season: Number(config.season)", "episode: Number(config.episode)"]);
});

console.log("\n[player] no server switcher");
await test("server switcher markup and logic are gone", () => {
  hasNone(player, [
    'id="serversList"',
    "data-server=",
    "buildServersList",
    "switchServer",
    "serverBranding",
    "getServerDisplayName",
  ]);
});

await test("quality popover still offers quality and speed", () => {
  hasAll(player, ['id="qualityLevelsList"', 'id="speedRowBtn"', ">QUALITY<", ">Speed<"]);
});

console.log("\n[portal] samples only, no personal rows");
await test("Continue Watching and My List are gone", () => {
  hasNone(portal, [
    'id="continueSection"',
    'id="continueRow"',
    'id="watchlistSection"',
    'id="watchlistRow"',
    "continueSection",
    "watchlistSection",
    "personal-card",
    "watchlist-star",
    "PROGRESS_KEY",
    "WATCHLIST_KEY",
    "renderPersonalRows",
    "toggleWatchlist",
    "isInWatchlist",
  ]);
});

await test("discovery is replaced by webmaster samples", () => {
  hasAll(portal, ['id="samples"', "sample-card", "function loadSample", "function copySample"]);
  hasNone(portal, ['id="discover"', "discoveryGrid", "loadDiscoveryTrending", "/api/tmdb/"]);
});

await test("sample embeds target this worker's own URLs", () => {
  hasAll(portal, ["function sampleEmbedUrl", "'/embed/tv/'", "'/embed/movie/'", "origin +"]);
});

console.log("\n[player] default subtitle language");
await test("English subtitles are preferred by default", () => {
  hasAll(player, [
    "function findEnglishSubtitleIndex",
    "lang === 'en'",
    "findEnglishSubtitleIndex(config.subtitles)",
    "config.subtitles[englishIdx >= 0 ? englishIdx : 0]",
  ]);
});

console.log("\n[player] multi-audio upgrade resilience");
await test("client-assisted upgrade retries with backoff", () => {
  hasAll(player, [
    "var CLIENT_RESOLVE_DELAYS = [0, 700, 1600]",
    "function resolveClientStreamOnce",
    "function resolveClientStream(options)",
    "setTimeout(function () { resolve(attemptOnce(index + 1)); }",
    "'boot_http_' + response.status",
    "'source_no_stream'",
    "'gateway_not_master'",
  ]);
});

await test("upgrade prefers a bigbang rendition", () => {
  hasAll(player, [
    "function preferredClientStream(streams)",
    "String(candidate.provider || '').toLowerCase() === 'bigbang'",
    "preferredClientStream(payload && payload.streams)",
  ]);
});

await test("upgrade state is observable without a debug build", () => {
  hasAll(player, [
    "var clientResolveStatus = {",
    "window.__VIDLYTE_MULTI_AUDIO__ = clientResolveStatus",
    "state: 'resolving'",
    "state: 'failed'",
    "audioCount: result.audioCount",
  ]);
});

await test("failed upgrades surface a recovery control and one-time hint", () => {
  hasAll(player, [
    "function retryMultiAudio(manual)",
    "function appendMultiAudioReloadItem",
    "data-action', 'reload-multi-audio'",
    "'Reload multi-audio (retry)'",
    "Use Audio → Reload multi-audio to retry.",
    "var multiAudioNoticeShown = false",
    "window.__vidlyteRetryMultiAudio = retryMultiAudio",
    "'Multi-audio reload failed. Try again in a moment.'",
    "setupAudioTracks();",
  ]);
});

await test("manual reload is offered in both audio menus on single-track fallbacks", () => {
  var setupStart = player.indexOf("function setupAudioTracks()");
  var setupEnd = player.indexOf("function switchAudioTrack(idx)");
  assert.ok(setupStart > 0 && setupEnd > setupStart, "setupAudioTracks not found");
  var setup = player.slice(setupStart, setupEnd);
  var occurrences = setup.split("appendMultiAudioReloadItem();").length - 1;
  assert.ok(occurrences >= 2, `expected the reload item in both fallback branches, found ${occurrences}`);
});

console.log("\n[worker] Phase 6 endpoints");
await test("recommendations endpoint is gone", () => {
  hasNone(indexSource, ["tmdbRecommendationsMatch", "/recommendations"]);
});

await test("engagement telemetry endpoint validates the allowlist", () => {
  hasAll(indexSource, [
    'url.pathname === "/api/telemetry/engagement"',
    "ENGAGEMENT_EVENTS.has(eventName)",
    "recordEngagement(eventName, assetId)",
  ]);
});

await test("engagement allowlist excludes removed features", () => {
  const start = indexSource.indexOf("const ENGAGEMENT_EVENTS = new Set([");
  const end = indexSource.indexOf("]);", start);
  const block = indexSource.slice(start, end);
  hasAll(block, ["play", "resume", "complete", "share", "subtitle_change"]);
  assert.ok(!block.includes("watchlist"), "watchlist events should be gone");
  assert.ok(!block.includes("recommendation_click"), "recommendation_click should be gone");
});

await test("engagement is exposed in metrics and diagnostics", () => {
  hasAll(indexSource, ["engagement: engagementSnapshot()"]);
  assert.ok(indexSource.split("engagement: engagementSnapshot()").length >= 3);
});

await test("admin shows the engagement card", () => {
  hasAll(admin, ['id="diagPlays"', 'id="diagShares"']);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAILED: ${failure.name}`);
    if (failure.error && failure.error.stack) console.error(failure.error.stack);
  }
  process.exit(1);
}
