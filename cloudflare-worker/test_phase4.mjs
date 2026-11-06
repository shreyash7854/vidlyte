/**
 * VidLyte Phase 4 verification harness
 * ---------------------------------------------------------------------------
 * Phase 4 is primarily player/portal UX, so this harness combines static
 * wiring assertions with inline-script syntax validation and lightweight
 * behavioural checks of the shipped markup/JS contracts.
 *
 *   node test_phase4.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

const player = read("src/player.html");
const portal = read("src/portal.html");
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

function inlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1] || "";
    if (/application\/json/i.test(attrs)) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

function hasAll(source, needles) {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `missing: ${needle}`);
  }
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

console.log("\n[player] watch progress & resume");
await test("progress store uses a versioned localStorage key", () => {
  hasAll(player, ["vidlyte_progress_v1", "localStorage.getItem", "localStorage.setItem"]);
});

await test("progress is keyed per asset", () => {
  hasAll(player, ["function currentAssetKey", "config.assetId", "config.mediaType", "config.season", "config.episode"]);
});

await test("progress saves are throttled and cleared on completion", () => {
  hasAll(player, ["function saveWatchProgress", "progressSaveAt", "clearWatchProgress", "video.addEventListener('ended'"]);
});

await test("resume offers a start-over action", () => {
  hasAll(player, ["function maybeResumePlayback", "Resumed from", "Start over", "resumeApplied"]);
});

await test("progress persists on pause and page hide", () => {
  hasAll(player, ["video.addEventListener('pause'", "addEventListener('pagehide'", "visibilitychange"]);
});

console.log("\n[player] playback preferences");
await test("preferences use a versioned store", () => {
  hasAll(player, ["vidlyte_playback_prefs_v1", "function loadPlaybackPrefs", "function savePlaybackPrefs"]);
});

await test("speed, skip, volume, boost and fit are persisted", () => {
  hasAll(player, [
    "savePlaybackPrefs({ speed: chosen.val })",
    "savePlaybackPrefs({ skip: skipIntervalSeconds })",
    "savePlaybackPrefs({ boost: currentBoostIdx })",
    "savePlaybackPrefs({ fit: currentFitIdx })",
    "savePlaybackPrefs({ volume: video.volume, muted: video.muted })",
  ]);
});

await test("saved preferences are restored during init", () => {
  hasAll(player, ["initialPrefs.speed", "initialPrefs.skip", "initialPrefs.volume", "initialPrefs.fit", "initialPrefs.boost"]);
});

console.log("\n[player] no server switcher");
await test("quality popover has no server switcher UI", () => {
  assert.ok(!player.includes('id="serversList"'), "serversList markup should be gone");
  assert.ok(!player.includes("data-server="), "server items should be gone");
  assert.ok(!player.includes("function buildServersList"), "buildServersList should be gone");
  assert.ok(!player.includes("function switchServer"), "switchServer should be gone");
});

await test("quality pill shows only the quality label", () => {
  hasAll(player, ["function updateQualityPillText", "qualityPillValue.textContent = currentQualityName.toUpperCase();"]);
  assert.ok(!player.includes("serverBranding"), "server branding should be gone");
  assert.ok(!player.includes("getServerDisplayName"), "server display names should be gone");
});

console.log("\n[player] episode navigation");
await test("next episode and episodes controls exist", () => {
  hasAll(player, ['id="nextEpBtn"', 'id="episodesBtn"', 'id="episodesPanel"', 'id="episodesGrid"', 'id="seasonSelect"']);
});

await test("episode browser loads TMDB season data lazily", () => {
  hasAll(player, ["function initEpisodeNavigation", "/api/tmdb/tv/", "/seasons", "/season/", "loadSeasonEpisodes"]);
});

await test("next episode crosses season boundaries", () => {
  hasAll(player, ["function computeNextEpisode", "episodeState.next", "season_number", "currentEpisode + 1"]);
});

await test("episode navigation preserves safe query parameters", () => {
  hasAll(player, ["function goToEpisode", "new URLSearchParams(location.search)", "['token', 'asset_id', 'provider']"]);
});

await test("episode panel closes on Escape and backdrop click", () => {
  hasAll(player, ["Escape", "episodesPanel.classList.contains('open')", "e.target === episodesPanel"]);
});

await test("autoplay-next honours the stored preference", () => {
  hasAll(player, ["initialPrefs.autoplayNext", "goToEpisode(episodeState.next.season, episodeState.next.episode)"]);
});

console.log("\n[portal] webmaster samples");
await test("samples section replaces the discovery grid", () => {
  hasAll(portal, ['id="samples"', "sample-card", "loadSample", "copySample"]);
  assert.ok(!portal.includes('id="discover"'), "discovery section should be gone");
  assert.ok(!portal.includes("discoveryGrid"), "discovery grid should be gone");
  assert.ok(!portal.includes("/api/tmdb/"), "portal should not call TMDB directly");
});

await test("sample cards preview in the sandbox", () => {
  hasAll(portal, ["function loadSample", "applyPreset(type, id, season, episode)", "updatePlayer"]);
});

await test("sample cards copy a ready-to-paste iframe", () => {
  hasAll(portal, ["function copySample", "function sampleEmbedUrl", "<iframe src=", "navigator.clipboard.writeText"]);
});

console.log("\n[worker] Phase 4 endpoints & bootstrap");
await test("TMDB search, trending and season endpoints exist", () => {
  hasAll(indexSource, [
    'url.pathname === "/api/tmdb/search"',
    'url.pathname === "/api/tmdb/trending"',
    "tmdbSeasonsMatch",
    "tmdbSeasonMatch",
  ]);
});

await test("TMDB responses are cached and sanitized", () => {
  hasAll(indexSource, ["tmdbCache", "mapTmdbSearchResult", "sanitizeText", "Cache-Control"]);
});

await test("player bootstrap carries servers, provider and MP4 flag", () => {
  const start = indexSource.indexOf("const bootstrap = {");
  const bootstrap = indexSource.slice(start, indexSource.indexOf("const renderedHTML", start));
  hasAll(bootstrap, ["servers:", "provider:", "currentServer:", "isMP4:"]);
});

await test("TMDB search rejects empty queries", () => {
  const start = indexSource.indexOf('url.pathname === "/api/tmdb/search"');
  const block = indexSource.slice(start, start + 1200);
  hasAll(block, ["Missing search query", "status: 400"]);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAILED: ${failure.name}`);
    if (failure.error && failure.error.stack) console.error(failure.error.stack);
  }
  process.exit(1);
}
