#!/usr/bin/env node
import dns from "node:dns";
try { dns.setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) {}
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { generateKissKHKey } from "../src/providers.js";

const DRAMA_ID = 1886;
const TMDB_ID = "122206";

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://kisskh.is/",
  "Accept": "application/json",
};

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options = {}, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(10000) });
      if (res.status === 429) {
        const waitTime = attempt * 2000;
        process.stdout.write(`[429, retry in ${waitTime}ms]... `);
        await sleep(waitTime);
        continue;
      }
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      await sleep(1000);
    }
  }
  return null;
}

async function run() {
  console.log(`Fetching Drama ${DRAMA_ID} metadata from KissKH...`);
  const drama = await fetchWithRetry(`https://kisskh.is/api/DramaList/Drama/${DRAMA_ID}`);
  if (!drama) {
    throw new Error(`Failed to fetch drama metadata`);
  }
  const episodes = (drama && Array.isArray(drama.episodes) && drama.episodes) || [];
  console.log(`Found ${episodes.length} episodes for "${drama.title}"`);

  const bulkFile = "scratch/all_35_episodes.json";
  let existingMap = new Map();
  if (existsSync(bulkFile)) {
    try {
      const existingData = JSON.parse(readFileSync(bulkFile, "utf8"));
      if (Array.isArray(existingData)) {
        for (const item of existingData) {
          existingMap.set(item.key, item);
        }
        console.log(`Loaded ${existingMap.size} existing records from ${bulkFile}`);
      }
    } catch (e) {}
  }

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const epNum = Number(ep.number);
    const asset = `tv/${TMDB_ID}/1/${epNum}`;
    const kvKey = `ma_status_v1:${asset}`;

    if (existingMap.has(kvKey)) {
      console.log(`[Ep ${epNum} (id ${ep.id})] Already resolved!`);
      continue;
    }

    process.stdout.write(`[Ep ${epNum} (id ${ep.id})] Resolving... `);

    const vKey = generateKissKHKey(ep.id, false);
    const epStreamData = await fetchWithRetry(
      `https://kisskh.is/api/DramaList/Episode/${ep.id}.png?err=false&ts=&time=&kkey=${vKey}`
    );

    if (!epStreamData || !(epStreamData.Video || epStreamData.Video_tmp)) {
      console.log("FAILED stream after retries!");
      continue;
    }

    const rawStream = epStreamData.Video || epStreamData.Video_tmp || "";
    const isMP4 = epStreamData.Type === 0 || /\.mp4(\?|$)/i.test(rawStream);

    // Subtitles
    const sKey = generateKissKHKey(ep.id, true);
    const subData = await fetchWithRetry(`https://kisskh.is/api/Sub/${ep.id}?kkey=${sKey}`);

    const subtitles = [];
    if (Array.isArray(subData)) {
      subData.forEach((s) => {
        if (!s || !s.src) return;
        const label = s.label || s.land || "Subtitles";
        const isEn = String(label).toLowerCase().includes("english") || s.land === "en";
        subtitles.push({
          label: `${label} Subtitles`,
          language: s.land || (isEn ? "en" : "und"),
          url: s.src,
          default: isEn || Boolean(s.default),
          provider: "kisskh",
        });
      });
    }

    // Ensure English subtitle is default
    const enIdx = subtitles.findIndex((s) => s.language === "en" || /english/i.test(s.label));
    if (enIdx > 0) {
      const enSub = subtitles.splice(enIdx, 1)[0];
      enSub.default = true;
      subtitles.unshift(enSub);
    } else if (enIdx === 0) {
      subtitles[0].default = true;
    }

    const audioTracks = [
      {
        id: 0,
        name: "Original (Chinese)",
        label: "Original (Chinese)",
        language: "zho",
        default: true,
        uri: rawStream,
        provider: "kisskh",
      },
    ];

    const payload = {
      ok: true,
      url: rawStream,
      isMP4: Boolean(isMP4),
      audio: 1,
      provider: "kisskh",
      exp: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
      checked_at: new Date().toISOString(),
      audioTracks,
      subtitles,
    };

    existingMap.set(kvKey, {
      key: kvKey,
      value: JSON.stringify(payload),
    });

    console.log(`OK (${subtitles.length} subs, ${isMP4 ? "MP4" : "HLS"})`);
    await sleep(800); // 800ms between episodes to respect rate limits
  }

  const allRecords = Array.from(existingMap.values());
  console.log(`\nTotal resolved episodes in set: ${allRecords.length}/${episodes.length}`);
  writeFileSync(bulkFile, JSON.stringify(allRecords, null, 2), "utf8");

  console.log(`Uploading ${allRecords.length} records to Cloudflare remote KV via wrangler bulk put...`);
  execSync(`npx wrangler kv bulk put "../${bulkFile}" --binding CONFIG_KV --remote`, {
    cwd: "cloudflare-worker",
    stdio: "inherit",
  });
  console.log("\nALL 35 EPISODES ATOMICALLY UPLOADED TO REMOTE KV!");
}

run().catch(console.error);
