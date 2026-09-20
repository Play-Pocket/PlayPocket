'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { launch, sleep, MEDIA_DIR } = require('./run.js');

const MINUTES = Number(process.env.PP_SOAK_MINUTES || 3);
const MEDIA = process.env.PP_E2E_MEDIA || path.join(require('os').tmpdir(), 'pp-e2e', 'media');

function electronWorkingSetMb() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"], { encoding: 'utf8' });
    return Math.round(Number(out.trim()) / 1048576);
  } catch {
    return 0;
  }
}

async function main() {
  const app = await launch('soak');
  await app.waitReady();
  await app.installHelpers();
  await app.cdp.send('Performance.enable');
  await app.cdp.send('HeapProfiler.enable');

  await app.setFiles('#fileInput', [path.join(MEDIA, 'a.webm'), path.join(MEDIA, 'b.webm'), path.join(MEDIA, 'c.webm')]);
  await app.evaluate(async () => {
    await __t.waitFor(() => PP.state.items.length === 3, 30000);
    await PP.settings.set({ crossfadeEnabled: true, crossfadeDuration: 1, gaplessEnabled: true, seamlessPlayback: true });
    await PP.player.playTrackById(PP.state.items[0]);
    await __t.waitFor(() => __t.active().time > 0.5, 10000);
    return true;
  });

  const samples = [];
  const started = Date.now();
  let lastTask = null;
  let maxUrls = 0;
  while (Date.now() - started < MINUTES * 60 * 1000) {
    await sleep(10000);
    await app.cdp.send('HeapProfiler.collectGarbage');
    const heap = await app.cdp.send('Runtime.getHeapUsage');
    const metrics = await app.cdp.send('Performance.getMetrics');
    const task = metrics.metrics.find((m) => m.name === 'TaskDuration').value;
    const now = Date.now();
    const cpuPct = lastTask ? Math.round(((task - lastTask.task) / ((now - lastTask.at) / 1000)) * 1000) / 10 : 0;
    lastTask = { task, at: now };
    const info = await app.evaluate(() => {
      const s = PP.engine.debugSnapshot();
      const a = s.decks[s.activeIndex];
      return { urls: PP.media.urls.count(), swaps: window.__swaps.length, playing: !a.paused, ctx: s.ctxState, track: PP.state.currentTrackId === a.trackId, busy: PP.player.isBusy() };
    });
    maxUrls = Math.max(maxUrls, info.urls);
    const sample = { min: ((now - started) / 60000).toFixed(1), heapMb: Math.round(heap.usedSize / 1048576 * 10) / 10, wsMb: electronWorkingSetMb(), cpuPct, ...info };
    samples.push(sample);
    console.log(JSON.stringify(sample));
  }

  const first = samples[1] || samples[0];
  const last = samples[samples.length - 1];
  const summary = {
    minutes: MINUTES,
    transitions: last.swaps,
    maxObjectUrls: maxUrls,
    heapGrowthMb: Math.round((last.heapMb - first.heapMb) * 10) / 10,
    workingSetGrowthMb: last.wsMb - first.wsMb,
    stillPlaying: last.playing,
    avgCpuPct: Math.round(samples.slice(1).reduce((s, x) => s + x.cpuPct, 0) / Math.max(1, samples.length - 1) * 10) / 10
  };
  console.log('SOAK-SUMMARY ' + JSON.stringify(summary));
  const ok = summary.maxObjectUrls <= 2 && summary.stillPlaying && summary.transitions >= MINUTES * 5 && summary.heapGrowthMb < 20;
  console.log(ok ? 'SOAK RESULT: pass' : 'SOAK RESULT: FAIL');
  app.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SOAK ERROR', error);
  process.exit(2);
});
