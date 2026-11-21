import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseMasterManifest } from '../src/manifest.js';

const KV_NAMESPACE = '1458cc95d50b4ba99b31ea7b736b5e64';

const langMap = {
  original: "en",
  hindi: "hi",
  tamil: "ta",
  telugu: "te",
  arabic: "ar",
  french: "fr",
  spanish: "es",
  german: "de",
  italian: "it",
  japanese: "ja",
  korean: "ko",
  portuguese: "pt",
  russian: "ru",
  turkish: "tr",
  czech: "cs",
  danish: "da",
  filipino: "fil",
  hungarian: "hu",
  indonesian: "id",
  polish: "pol",
  thai: "th",
  ukrainian: "uk",
  vietnamese: "vi"
};

async function fetchBoot(asset) {
  const url = `https://embed.vidrift.net/api/boot/${asset}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': `https://embed.vidrift.net/embed/${asset}`
    }
  });
  if (!res.ok) return null;
  return await res.json();
}

async function extractEvion(boot) {
  if (!boot || !boot.meta || !boot.meta.evionUrl) return null;
  const evionUrl = boot.meta.evionUrl;
  try {
    const res = await fetch(evionUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://embed.vidrift.net/'
      }
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return null;

    const parsed = parseMasterManifest(text, evionUrl);
    const audioTracks = (parsed.audio || []).map((t, idx) => {
      const label = t.label || `Audio Track ${idx + 1}`;
      const cleanLabel = label.replace(/^\d+\.\s*/, '').trim() || label;
      const lang = t.language || langMap[cleanLabel.toLowerCase()] || 'und';
      return {
        id: idx,
        name: cleanLabel,
        label: cleanLabel,
        language: lang,
        default: t.default || idx === 0,
        uri: t.uri,
        proxiedUri: t.uri,
        proxied_uri: t.uri,
        provider: 'evion'
      };
    });

    const variants = (parsed.variants || []).map((v) => ({
      resolution: v.resolution || '1080p',
      bandwidth: v.bandwidth || 1000000,
      playlistUri: v.uri,
      provider: 'evion'
    }));

    const subtitles = (parsed.subtitles || []).map((s) => ({
      language: s.language || 'en',
      label: s.label || 'Subtitles',
      url: s.uri,
      uri: s.uri,
      proxiedUri: s.uri,
      proxied_uri: s.uri
    }));

    return {
      ok: true,
      provider: 'evion',
      url: evionUrl,
      audio: audioTracks.length,
      masterManifest: text,
      audioTracks,
      variants,
      subtitles
    };
  } catch (e) {
    return null;
  }
}

async function extractOrion(boot) {
  const orionStreams = (boot && boot.meta && Array.isArray(boot.meta.orionStreams) && boot.meta.orionStreams) || [];
  if (orionStreams.length === 0) return null;

  let defaultAudioFilename = 'a3.m3u8';
  if (boot.meta.warmManifests) {
    for (const wmPath of Object.keys(boot.meta.warmManifests)) {
      if (/\/a\d+\.m3u8$/i.test(wmPath)) {
        defaultAudioFilename = wmPath.split('/').pop();
        break;
      }
    }
  }

  const audioTracks = [];
  const variants = [];
  const base = 'https://embed.vidrift.net';

  orionStreams.forEach((s, idx) => {
    const cleanName = s.name ? s.name.replace(/^Orion\s*[·•-]\s*/i, '').trim() : `Audio Track ${idx + 1}`;
    const fullStreamUrl = s.url.startsWith('http') ? s.url : `${base}${s.url}`;
    const audioUri = fullStreamUrl.replace(/master\.m3u8$/i, defaultAudioFilename);
    const langKey = cleanName.toLowerCase();
    const langCode = langMap[langKey] || 'und';
    audioTracks.push({
      id: idx,
      name: cleanName,
      label: cleanName,
      language: langCode,
      default: idx === 0,
      uri: audioUri,
      proxiedUri: audioUri,
      proxied_uri: audioUri,
      provider: 'orion',
    });
  });

  const primaryBase = (orionStreams[0].url.startsWith('http')
    ? orionStreams[0].url
    : `${base}${orionStreams[0].url}`).replace(/master\.m3u8$/i, '');

  const rungs = orionStreams[0].rungs || [];
  if (rungs.length > 0) {
    rungs.forEach((r, idx) => {
      variants.push({
        resolution: `${r.height || 720}p`,
        bandwidth: r.height >= 1080 ? 2500000 : (r.height >= 720 ? 1200000 : 650000),
        playlistUri: `${primaryBase}v${idx}.m3u8`,
        provider: 'orion',
      });
    });
  } else {
    variants.push(
      { resolution: '1080p', bandwidth: 2500000, playlistUri: `${primaryBase}v0.m3u8`, provider: 'orion' },
      { resolution: '720p', bandwidth: 1200000, playlistUri: `${primaryBase}v1.m3u8`, provider: 'orion' },
      { resolution: '480p', bandwidth: 650000, playlistUri: `${primaryBase}v2.m3u8`, provider: 'orion' }
    );
  }

  const audioLines = audioTracks.map((t) => {
    const defStr = t.default ? ',DEFAULT=YES,AUTOSELECT=YES' : ',DEFAULT=NO,AUTOSELECT=YES';
    const langStr = t.language ? `,LANGUAGE="${t.language}"` : '';
    return `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${t.name}"${defStr}${langStr},URI="${t.uri}"`;
  }).join('\n');

  const variantLines = variants.map((v) => {
    const resStr = v.resolution ? `,RESOLUTION=${v.resolution === '1080p' ? '1920x1080' : v.resolution === '720p' ? '1280x720' : '854x480'}` : '';
    return `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 2500000}${resStr},AUDIO="audio"\n${v.playlistUri}`;
  }).join('\n');

  const masterManifest = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n${audioLines}\n${variantLines}\n`;
  const primaryUrl = orionStreams[0].url.startsWith('http') ? orionStreams[0].url : `${base}${orionStreams[0].url}`;

  return {
    ok: true,
    provider: 'orion',
    url: primaryUrl,
    audio: audioTracks.length,
    masterManifest,
    audioTracks,
    variants,
  };
}

async function resolveAndSave(asset) {
  console.log(`Processing ${asset}...`);
  const boot = await fetchBoot(asset);
  if (!boot) {
    console.log(`  Failed to get boot for ${asset}`);
    return;
  }

  const evion = await extractEvion(boot);
  const orion = await extractOrion(boot);

  const candidates = [evion, orion].filter(c => c && c.ok && c.audio > 0);
  candidates.sort((a, b) => b.audio - a.audio);

  const winner = candidates[0];
  if (!winner) {
    console.log(`  No candidate with multi-audio for ${asset}`);
    return;
  }

  console.log(`  Selected provider: ${winner.provider} with ${winner.audio} tracks`);

  const record = {
    ok: true,
    url: winner.url,
    audio: winner.audio,
    provider: winner.provider,
    exp: Math.floor(Date.now() / 1000) + 86400 * 2,
    checked_at: new Date().toISOString(),
    error: '',
    masterManifest: winner.masterManifest,
    audioTracks: winner.audioTracks,
    variants: winner.variants,
    subtitles: winner.subtitles || []
  };

  const tmpPath = path.resolve(`./tmp_${asset.replace(/\//g, '_')}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(record));

  try {
    const kvKey = `ma_status_v1:${asset}`;
    execSync(`npx wrangler kv key put --namespace-id=${KV_NAMESPACE} "${kvKey}" --path="${tmpPath}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(`  Successfully synced KV key ${kvKey}`);
  } catch (err) {
    console.log(`  Failed to sync KV for ${asset}:`, err.message);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

async function main() {
  const assets = [
    'tv/66732/1/1',    // Stranger Things (Evion 22 tracks)
    'tv/228689/1/3',   // Genie, Make a Wish (Orion 6 tracks)
    'tv/99966/1/1',    // All of Us Are Dead (Evion 16 tracks)
    'tv/250670/1/1',   // Maxton Hall (Orion 8 tracks)
    'tv/314939/1/1',   // A Love Other Than Yours (Evion 12 tracks)
    'tv/93405/1/1',    // Squid Game (Evion 25 tracks)
    'movie/550',       // Fight Club (Orion 8 tracks)
  ];

  for (const a of assets) {
    await resolveAndSave(a);
  }
  console.log('All assets processed.');
}

main().catch(console.error);

