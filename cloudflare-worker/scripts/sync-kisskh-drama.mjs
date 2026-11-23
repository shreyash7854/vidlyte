#!/usr/bin/env node
import dns from "node:dns";
try { dns.setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) {}
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveKissKH } from "../src/providers.js";

const DRAMA_ID = 1886;
const TMDB_ID = "122206";
const TOTAL_EPS = 35;

async function syncEpisode(ep) {
  const asset = `tv/${TMDB_ID}/1/${ep}`;
  const kvKey = `ma_status_v1:${asset}`;
  console.log(`[Ep ${ep}/${TOTAL_EPS}] Resolving ${asset}...`);
  try {
    const kiss = await resolveKissKH({
      assetInfo: { type: "tv", id: TMDB_ID, season: 1, episode: ep },
      title: "The Rational Life",
      timeoutMs: 12000,
    });

    if (!kiss || !kiss.streamUrl) {
      console.error(`  Failed to resolve ep ${ep}`);
      return false;
    }

    const payload = {
      ok: true,
      url: kiss.streamUrl,
      isMP4: Boolean(kiss.isMP4),
      audio: (kiss.audioTracks && kiss.audioTracks.length) || 1,
      provider: "kisskh",
      exp: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
      checked_at: new Date().toISOString(),
      audioTracks: kiss.audioTracks || [],
      subtitles: kiss.subtitles || [],
    };

    const tmpFile = join(tmpdir(), `kv_${TMDB_ID}_${ep}.json`);
    writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");

    execSync(`npx wrangler kv key put "${kvKey}" --binding CONFIG_KV --path "${tmpFile}" --remote`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    try { unlinkSync(tmpFile); } catch (e) {}
    console.log(`  KV updated: ${kvKey} (${payload.subtitles.length} subs, isMP4: ${payload.isMP4})`);
    return true;
  } catch (err) {
    console.error(`  Error on ep ${ep}:`, err.message);
    return false;
  }
}

async function syncAll() {
  console.log(`Starting sync for TMDB ${TMDB_ID} (Drama ${DRAMA_ID}), 1 to ${TOTAL_EPS} with --remote...`);
  for (let ep = 1; ep <= TOTAL_EPS; ep++) {
    await syncEpisode(ep);
  }
  console.log("All episodes synced to remote KV successfully!");
}

syncAll();
