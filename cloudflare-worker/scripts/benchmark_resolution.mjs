import { resolveAsset } from "./resolve-multi-audio.mjs";
import { resolveKissKH } from "../src/providers.js";

const BENCHMARK_TITLES = [
  { type: "tv", id: "74682", season: 1, episode: 1, title: "I Am Not a Robot" },
  { type: "tv", id: "305551", season: 1, episode: 7, title: "Merry Berry Love" },
  { type: "tv", id: "228689", season: 1, episode: 3, title: "Genie, Make a Wish" },
  { type: "tv", id: "66732", season: 1, episode: 1, title: "Stranger Things" },
  { type: "movie", id: "550", title: "Fight Club" },
  { type: "tv", id: "250670", season: 1, episode: 1, title: "Maxton Hall" },
  { type: "tv", id: "99966", season: 1, episode: 1, title: "All of Us Are Dead" },
];

async function runBenchmark() {
  console.log("==========================================================================================");
  console.log("                VIDLYTE MULTI-AUDIO RESOLUTION & LATENCY BENCHMARK");
  console.log("==========================================================================================\n");

  const results = [];

  for (const item of BENCHMARK_TITLES) {
    const assetKey = item.type === "tv" ? `${item.type}/${item.id}/${item.season}/${item.episode}` : `${item.type}/${item.id}`;
    console.log(`>>> Benchmarking [${item.title}] (${assetKey})...`);

    // 1. Measure TMDB Metadata Fetch
    const tmdbStart = Date.now();
    let tmdbData = null;
    try {
      const tmdbRes = await fetch(`https://api.tmdb.org/3/${item.type}/${item.id}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`, {
        signal: AbortSignal.timeout(4000),
      });
      if (tmdbRes.ok) tmdbData = await tmdbRes.json();
    } catch (e) {}
    const tmdbLatency = Date.now() - tmdbStart;

    // 2. Measure KissKH Direct Latency
    const kissStart = Date.now();
    let kissResult = null;
    try {
      kissResult = await resolveKissKH({
        assetInfo: item,
        title: item.title,
        year: (tmdbData && (tmdbData.first_air_date || tmdbData.release_date || "")).slice(0, 4),
        originalLanguage: (tmdbData && tmdbData.original_language) || "",
        timeoutMs: 6000,
      });
    } catch (e) {}
    const kissLatency = Date.now() - kissStart;

    // 3. Measure End-to-End Multi-Audio Resolution
    const totalStart = Date.now();
    const resolution = await resolveAsset(item);
    const totalLatency = Date.now() - totalStart;

    const summary = {
      asset: assetKey,
      title: item.title,
      tmdbLatency,
      origLanguage: tmdbData?.original_language || "unknown",
      kissLatency,
      kissSuccess: Boolean(kissResult && kissResult.streamUrl),
      kissTracks: kissResult?.audioTracks?.map(t => t.name) || [],
      kissSubsCount: kissResult?.subtitles?.length || 0,
      totalLatency,
      resolutionOk: Boolean(resolution && resolution.ok),
      provider: resolution?.provider || "none",
      audioCount: resolution?.audio || 0,
      audioTracks: resolution?.audioTracks?.map(t => t.name) || [],
      subtitlesCount: resolution?.subtitles?.length || 0,
      streamUrlSample: resolution?.url ? (resolution.url.slice(0, 45) + "...") : "none",
    };

    results.push(summary);

    console.log(`    TMDB Latency:     ${tmdbLatency}ms (Orig Lang: ${summary.origLanguage})`);
    console.log(`    KissKH Latency:   ${kissLatency}ms (Found: ${summary.kissSuccess ? 'Yes' : 'No'}, Subs: ${summary.kissSubsCount})`);
    console.log(`    Resolution Time:  ${totalLatency}ms`);
    console.log(`    Server / Engine:  ${summary.provider.toUpperCase()}`);
    console.log(`    Audio Dubs (${summary.audioCount}):   [${summary.audioTracks.join(", ")}]`);
    console.log(`    Subtitles Count:  ${summary.subtitlesCount}`);
    console.log("------------------------------------------------------------------------------------------\n");
  }

  console.log("\n================================== SUMMARY MATRIX ==================================");
  console.log(JSON.stringify(results, null, 2));
}

runBenchmark().catch(console.error);
