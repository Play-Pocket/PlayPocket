'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, sleep } = require('./run.js');

const SIZE_MB = Number(process.env.PP_BIG_MB || 300);

function buildBigPackage(file, rawMb) {
  const chunkRaw = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < chunkRaw.length; i += 4096) chunkRaw[i] = (i / 4096) & 0xff;
  const chunkB64 = chunkRaw.toString('base64');
  const chunks = Math.ceil(rawMb / 3);
  const fd = fs.openSync(file, 'w');
  const totalBytes = chunks * chunkRaw.length;
  fs.writeSync(fd, `{"format":"playpocket-share","version":1,"mediaIncluded":true,"name":"Big","items":[{"id":"big1","name":"big.mp4","duration":10,"mimeType":"video/mp4","size":${totalBytes},"thumbnail":null,"blobBase64":"`);
  for (let i = 0; i < chunks; i++) fs.writeSync(fd, chunkB64);
  fs.writeSync(fd, '"}]}');
  fs.closeSync(fd);
  return fs.statSync(file).size;
}

function electronWorkingSetMb() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"], { encoding: 'utf8' });
    return Math.round(Number(out.trim()) / 1048576);
  } catch {
    return 0;
  }
}

async function main() {
  const file = path.join(os.tmpdir(), 'pp-e2e', 'big.playpocket.json');
  const bytes = buildBigPackage(file, SIZE_MB);
  console.log(`package: ${(bytes / 1048576).toFixed(0)} MB`);

  let app = await launch('big');
  await app.waitReady();
  await app.installHelpers();

  let peakHeap = 0;
  let peakWs = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const heap = await app.cdp.send('Runtime.getHeapUsage');
        peakHeap = Math.max(peakHeap, Math.round(heap.usedSize / 1048576));
      } catch {}
      await sleep(200);
    }
  })();
  const wsSampler = (async () => {
    while (sampling) {
      peakWs = Math.max(peakWs, electronWorkingSetMb());
      await sleep(700);
    }
  })();

  const t0 = Date.now();
  await app.setFiles('#importFile', [file]);
  let outcome = 'timeout';
  for (let i = 0; i < 240; i++) {
    const state = await app.evaluate(async () => ({
      names: (await PP.db.listPlaylists()).map((p) => p.name),
      alerts: window.__alerts.slice(),
      current: PP.state.currentPlaylist
    })).catch(() => null);
    if (state && state.names.some((n) => n.startsWith('Big'))) { outcome = 'imported'; break; }
    if (state && state.alerts.length > 0) { outcome = `alert: ${state.alerts.join('|')}`; break; }
    await sleep(500);
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  sampling = false;
  await Promise.all([sampler, wsSampler]);
  const peakHeapImport = peakHeap;
  const peakWsImport = peakWs;

  let verify = null;
  let exportInfo = null;
  if (outcome === 'imported') {
    verify = await app.evaluate(async () => {
      const pls = await PP.db.listPlaylists();
      const big = pls.find((p) => p.name.startsWith('Big'));
      const rec = await PP.db.getVideo(big.items[0]);
      return { size: rec.blob.size, itemSize: rec.size };
    });
    await app.quit();
    app = await launch('big-export');
    await app.waitReady();
    await app.installHelpers();
    await app.evaluate(async () => {
      [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent.startsWith('Big')).click();
      await __t.waitFor(() => PP.state.currentPlaylist.startsWith('Big') && PP.state.items.length === 1, 10000);
    });
    await sleep(1500);
    peakHeap = 0;
    peakWs = 0;
    sampling = true;
    const heapLoop = (async () => {
      while (sampling) {
        try {
          const heap = await app.cdp.send('Runtime.getHeapUsage');
          peakHeap = Math.max(peakHeap, Math.round(heap.usedSize / 1048576));
        } catch {}
        await sleep(100);
      }
    })();
    const wsLoop = (async () => {
      while (sampling) {
        peakWs = Math.max(peakWs, electronWorkingSetMb());
        await sleep(500);
      }
    })();
    const e0 = Date.now();
    const exported = await app.evaluate(async () => {
      const { blob } = await PP.library.buildExportBlob({ includeBlobs: true });
      return { bytes: blob.size };
    });
    sampling = false;
    await Promise.all([heapLoop, wsLoop]);
    exportInfo = { ...exported, seconds: ((Date.now() - e0) / 1000).toFixed(1), peakRendererHeapMb: peakHeap, peakElectronWorkingSetMb: peakWs };
  }
  console.log(JSON.stringify({ outcome, seconds, peakRendererHeapMb: peakHeapImport, peakElectronWorkingSetMb: peakWsImport, verify, exportInfo }));
  app.kill();
  try { fs.rmSync(file, { force: true }); } catch {}
  process.exit(0);
}

main().catch((error) => {
  console.error('BIG ERROR', error);
  process.exit(2);
});
