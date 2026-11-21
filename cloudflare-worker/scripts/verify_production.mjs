const BASE_URL = 'https://vid.lyte.workers.dev';

async function verifyTitle(asset, expectedMinTracks = 1) {
  const embedUrl = `${BASE_URL}/embed/${asset}`;
  const res = await fetch(embedUrl);
  if (!res.ok) {
    return { asset, ok: false, error: `embed_http_${res.status}` };
  }
  const html = await res.text();
  const marker = 'id="embed-bootstrap"';
  const idx = html.indexOf(marker);
  if (idx === -1) {
    return { asset, ok: false, error: 'no_bootstrap_tag' };
  }
  const start = html.indexOf('>', idx) + 1;
  const end = html.indexOf('</script>', start);
  const bootstrap = JSON.parse(html.slice(start, end));

  const audioCount = bootstrap.audioTracks ? bootstrap.audioTracks.length : 0;
  const variantCount = bootstrap.variants ? bootstrap.variants.length : 0;
  const provider = bootstrap.provider || 'unknown';

  // Test master manifest
  let masterOk = false;
  let sampleChunkOk = false;
  if (bootstrap.streamUrl) {
    const mRes = await fetch(bootstrap.streamUrl);
    if (mRes.ok) {
      const mText = await mRes.text();
      masterOk = mText.startsWith('#EXTM3U');

      // Test first variant or sub-resource
      const subMatch = mText.match(/https:\/\/vid\.lyte\.workers\.dev\/[^\s\n"']+/);
      if (subMatch) {
        const subRes = await fetch(subMatch[0]);
        if (subRes.ok) {
          const contentType = subRes.headers.get('content-type') || '';
          if (contentType.includes('video/') || contentType.includes('application/octet-stream')) {
            const buf = await subRes.arrayBuffer();
            sampleChunkOk = buf && buf.byteLength > 200;
          } else {
            const subText = await subRes.text();
            const chunkMatch = subText.match(/https:\/\/vid\.lyte\.workers\.dev\/(?:stream\/chunk|hls\/[^\s\n"']+\/res)\/[^\s\n"']+/);
            if (chunkMatch) {
              const chunkRes = await fetch(chunkMatch[0]);
              const buf = chunkRes.ok ? await chunkRes.arrayBuffer() : null;
              sampleChunkOk = chunkRes.ok && buf && buf.byteLength > 200;
            } else {
              sampleChunkOk = subText.includes('#EXTINF') || subText.includes('#EXTM3U');
            }
          }
        }
      }
    }
  }

  const pass = audioCount >= expectedMinTracks && masterOk;
  return {
    asset,
    title: bootstrap.title || asset,
    pass,
    provider,
    audioCount,
    variantCount,
    masterOk,
    sampleChunkOk,
    audioTracks: (bootstrap.audioTracks || []).map(t => t.name || t.label).join(', ')
  };
}

async function verifyAdmin() {
  const adminRes = await fetch(`${BASE_URL}/vly-ops-7x`);
  const html = await adminRes.text();
  const hasCsrf = html.includes('name="csrf_token"') || html.includes('csrf') || html.includes('password');
  return { status: adminRes.status, hasCsrf };
}

async function main() {
  console.log('--- STARTING PRODUCTION VERIFICATION ---');

  const titles = [
    { asset: 'tv/66732/1/1', minTracks: 20, name: 'Stranger Things' },
    { asset: 'tv/228689/1/3', minTracks: 6, name: 'Genie, Make a Wish' },
    { asset: 'tv/99966/1/1', minTracks: 15, name: 'All of Us Are Dead' },
    { asset: 'tv/250670/1/1', minTracks: 6, name: 'Maxton Hall' },
    { asset: 'tv/314939/1/1', minTracks: 10, name: 'A Love Other Than Yours' },
    { asset: 'tv/93405/1/1', minTracks: 20, name: 'Squid Game' },
    { asset: 'movie/550', minTracks: 4, name: 'Fight Club' }
  ];

  for (const t of titles) {
    console.log(`Testing ${t.name} (${t.asset})...`);
    const r = await verifyTitle(t.asset, t.minTracks);
    console.log(`  Result: ${r.pass ? 'PASS' : 'FAIL'}`);
    console.log(`  Provider: ${r.provider} | Audio Tracks (${r.audioCount}): ${r.audioTracks}`);
    console.log(`  Variants: ${r.variantCount} | Master Manifest: ${r.masterOk ? '200 OK' : 'FAIL'} | Media Chunk: ${r.sampleChunkOk ? '200 OK' : 'FAIL'}`);
    console.log('');
  }

  console.log('Testing Admin Login Route (/vly-ops-7x)...');
  const admin = await verifyAdmin();
  console.log(`  Admin Status: ${admin.status} | CSRF Form Present: ${admin.hasCsrf ? 'YES' : 'NO'}`);
}

main().catch(console.error);
