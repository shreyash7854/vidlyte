import fs from 'fs';
import { WASI } from './src/wasi.js';

console.log('--- Testing VidLyte Cloudflare Worker Wasm Core ---');

async function runTests() {
  const wasi = new WASI();
  const wasmBuffer = fs.readFileSync('./src/vidlyte.wasm');
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  const instance = new WebAssembly.Instance(wasmModule, wasi.getImportObject());
  wasi.initialize(instance);

  const exp = instance.exports;
  const mem = exp.memory;
  const arenaPtr = exp.get_arena_ptr();

  function write(str, offset) {
    const bytes = new TextEncoder().encode(str);
    new Uint8Array(mem.buffer, arenaPtr + offset, bytes.length).set(bytes);
    return { offset, len: bytes.length };
  }
  function read(offset, len) {
    return new TextDecoder().decode(new Uint8Array(mem.buffer, arenaPtr + offset, len));
  }

  // 1. Issue Token Test
  const asset = write('movie-fight-club', 0);
  const ip = write('203.0.113.195', 64);
  const key = write('vidlyte-test-key-12345678901234', 128);

  const tokLen = exp.issue_token(asset.offset, asset.len, ip.offset, ip.len, 1800, key.offset, key.len);
  if (tokLen <= 0) throw new Error('Token issue failed');
  const token = read(exp.get_output_offset(), tokLen);
  console.log('✔ Token Issued successfully:');
  console.log('  ->', token);

  // 2. Verify Valid Token
  const tokW = write(token, 256);
  const valid = exp.verify_token(asset.offset, asset.len, ip.offset, ip.len, tokW.offset, tokW.len, key.offset, key.len);
  console.log('✔ Token Verification (Expected 1):', valid);
  if (valid !== 1) throw new Error('Token verification failed for valid token');

  // 3. Verify Tampered / Wrong IP Token
  const badIP = write('198.51.100.1', 512);
  const invalid = exp.verify_token(asset.offset, asset.len, badIP.offset, badIP.len, tokW.offset, tokW.len, key.offset, key.len);
  console.log('✔ Tampered IP Verification (Expected 0):', invalid);
  if (invalid !== 0) throw new Error('Security flaw: invalid IP was accepted');

  // 4. M3U8 Manifest Rewriting Test
  const sampleM3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment_1001.ts
#EXTINF:9.8,
segment_1002.ts
#EXT-X-ENDLIST`;

  const m3u8W = write(sampleM3U8, 1024);
  const baseW = write('https://cdn.upstream-cluster.net/hls/movies/550/', 2048);
  const proxyBaseW = write('https://my-worker.workers.dev/proxy?url=', 3072);
  const provW = write('orion', 4096);

  const rewLen = exp.rewrite_manifest(
    m3u8W.offset, m3u8W.len,
    baseW.offset, baseW.len,
    asset.offset, asset.len,
    tokW.offset, tokW.len,
    proxyBaseW.offset, proxyBaseW.len,
    provW.offset, provW.len
  );
  if (rewLen <= 0) throw new Error('M3U8 rewrite failed');

  const rewritten = read(exp.get_output_offset(), rewLen);
  console.log('✔ M3U8 Rewritten successfully:');
  console.log(rewritten.trim());

  console.log('\nAll Cloudflare Worker Wasm integration tests PASSED! 🚀');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
