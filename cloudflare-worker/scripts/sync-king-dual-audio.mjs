import dns from "node:dns";
try { dns.setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) {}
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveKissKH } from "../src/providers.js";

const KV_NAMESPACE_ID = "1458cc95d50b4ba99b31ea7b736b5e64";

async function resolveFrameXSource(tmdbId, season, episode) {
  const cluster = [
    "https://api.framextv.xyz",
    "https://api.framextv.cc",
    "https://api.framextv.tech",
  ];
  for (const host of cluster) {
    try {
      const endpoint = `${host}/api/stream?type=tv&id=${tmdbId}&season=${season}&episode=${episode}`;
      const resp = await fetch(endpoint, {
        headers: {
          Referer: "https://framextv.cc/",
          Origin: "https://framextv.cc",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (!data.success || !Array.isArray(data.sources) || data.sources.length === 0) continue;
      const hls = data.sources.find((s) => s.type === "hls" || s.url?.includes(".m3u8")) || data.sources[0];
      if (!hls || !hls.url) continue;

      const subtitles = [];
      if (Array.isArray(data.subtitles)) {
        data.subtitles.forEach((sub) => {
          if (!sub || !sub.url) return;
          subtitles.push({
            label: `${sub.label || sub.language || "Subtitles"} Subtitles`,
            language: sub.language || sub.lang || "und",
            url: sub.url,
            provider: "framextv",
          });
        });
      }

      return {
        streamUrl: hls.url,
        isMP4: hls.type === "mp4" || /\.mp4(\?|$)/i.test(hls.url),
        subtitles,
      };
    } catch (e) {}
  }
  return null;
}

async function syncKingEpisode(ep = 1) {
  const asset = `tv/93846/1/${ep}`;
  const kvKey = `ma_status_v1:${asset}`;
  console.log(`Resolving dual-audio for ${asset}...`);

  // 1. Resolve KissKH (Korean Original)
  const kiss = await resolveKissKH({
    assetInfo: { type: "tv", id: "93846", season: 1, episode: ep },
    title: "The King: Eternal Monarch",
    year: "2020",
    originalLanguage: "ko",
    timeoutMs: 12000,
  });

  if (!kiss || !kiss.streamUrl) {
    console.error("Failed to resolve KissKH stream");
    return;
  }
  console.log("KissKH stream resolved:", kiss.streamUrl);

  // 2. Resolve FrameX (Hindi Dub)
  const framex = await resolveFrameXSource("93846", 1, ep);
  if (framex && framex.streamUrl) {
    console.log("FrameX stream resolved (Hindi dub):", framex.streamUrl.slice(0, 80));
  } else {
    console.warn("FrameX stream not found, proceeding with single audio");
  }

  // 3. Assemble audio tracks
  const audioTracks = [
    {
      id: 0,
      name: "Original (Korean)",
      label: "Original (Korean)",
      language: "kor",
      default: true,
      uri: kiss.streamUrl,
      isMP4: Boolean(kiss.isMP4),
      provider: "kisskh",
    },
  ];

  if (framex && framex.streamUrl) {
    audioTracks.push({
      id: 1,
      name: "Hindi",
      label: "Hindi",
      language: "hin",
      default: false,
      uri: framex.streamUrl,
      isMP4: Boolean(framex.isMP4),
      provider: "framextv",
    });
  }

  // 4. Merge Subtitles
  const subtitles = [...(kiss.subtitles || [])];
  if (framex && Array.isArray(framex.subtitles)) {
    framex.subtitles.forEach((fs) => {
      if (!subtitles.some((cs) => cs.label.toLowerCase() === fs.label.toLowerCase())) {
        subtitles.push(fs);
      }
    });
  }

  const payload = {
    ok: true,
    url: kiss.streamUrl,
    isMP4: Boolean(kiss.isMP4),
    audio: audioTracks.length,
    provider: "kisskh",
    exp: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
    checked_at: new Date().toISOString(),
    audioTracks,
    subtitles,
  };

  const tmpFile = join(tmpdir(), `kv_93846_${ep}.json`);
  writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");

  try {
    execSync(
      `npx wrangler kv key put "${kvKey}" --namespace-id ${KV_NAMESPACE_ID} --path "${tmpFile}" --remote`,
      { cwd: process.cwd(), stdio: "inherit" }
    );
    console.log(`Successfully synced ${kvKey} with ${audioTracks.length} audio tracks and ${subtitles.length} subtitles!`);
  } finally {
    try { unlinkSync(tmpFile); } catch (e) {}
  }
}

syncKingEpisode(1);
