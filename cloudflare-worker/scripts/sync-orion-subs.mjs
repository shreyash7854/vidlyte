import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function syncOrion() {
  const bootRes = await fetch('https://embed.vidrift.net/api/boot/tv/228689/1/3', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://embed.vidrift.net/embed/tv/228689/1/3' }
  });
  const data = await bootRes.json();
  const orion = data.meta.orionStreams;

  const itemsToSync = [];

  // Primary stream (video rungs v0, v1, v2 + init0 + a3 + init3)
  const pStream = orion[0];
  const pMatch = pStream.url.match(/\/api\/orion\/([a-zA-Z0-9]+)\//);
  const pHash = pMatch[1];
  const pBase = 'https://embed.vidrift.net/api/orion/' + pHash + '/';

  itemsToSync.push({ hash: pHash, file: 'v0.m3u8', url: pBase + 'v0.m3u8', isBin: false });
  itemsToSync.push({ hash: pHash, file: 'v1.m3u8', url: pBase + 'v1.m3u8', isBin: false });
  itemsToSync.push({ hash: pHash, file: 'v2.m3u8', url: pBase + 'v2.m3u8', isBin: false });
  itemsToSync.push({ hash: pHash, file: 'init-stream0.m4s', url: pBase + 'init-stream0.m4s', isBin: true });
  itemsToSync.push({ hash: pHash, file: 'init-stream3.m4s', url: pBase + 'init-stream3.m4s', isBin: true });

  // Each audio stream
  for (const s of orion) {
    const sMatch = s.url.match(/\/api\/orion\/([a-zA-Z0-9]+)\//);
    const sHash = sMatch[1];
    const sBase = 'https://embed.vidrift.net/api/orion/' + sHash + '/';
    itemsToSync.push({ hash: sHash, file: 'a3.m3u8', url: sBase + 'a3.m3u8', isBin: false });
    itemsToSync.push({ hash: sHash, file: 'init-stream3.m4s', url: sBase + 'init-stream3.m4s', isBin: true });
  }

  // Deduplicate
  const seen = new Set();
  const uniqueItems = itemsToSync.filter(item => {
    const k = `${item.hash}:${item.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log('Total unique items to sync:', uniqueItems.length);
  for (const item of uniqueItems) {
    const key = `orion_sub:${item.hash}:${item.file}`;
    console.log('Fetching', item.url, 'for key', key);
    const res = await fetch(item.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://embed.vidrift.net/' }
    });
    if (!res.ok) {
      console.error('Failed to fetch', item.url, res.status);
      continue;
    }
    const tmp = path.resolve(`./tmp_sync_item.bin`);
    if (item.isBin) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmp, buf);
    } else {
      const text = await res.text();
      fs.writeFileSync(tmp, text, 'utf8');
    }
    execSync(`npx wrangler kv key put --remote --namespace-id 1458cc95d50b4ba99b31ea7b736b5e64 "${key}" --path "${tmp}" --ttl 86400`, {
      cwd: path.resolve('./cloudflare-worker'),
      stdio: 'ignore'
    });
    try { fs.unlinkSync(tmp); } catch (e) {}
    console.log('Synced', key);
  }
  console.log('Done syncing all Orion sub-manifests and inits!');
}

syncOrion().catch(console.error);

