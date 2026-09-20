'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const MEDIA = process.env.PP_E2E_MEDIA || path.join(os.tmpdir(), 'pp-e2e', 'media');
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-run-'));
const APPDATA = path.join(RUN_DIR, 'appdata');
const USER_DATA = path.join(RUN_DIR, 'userdata');
const T0 = Date.now();
const PORT = 9300 + Math.floor(Math.random() * 500);

const results = [];
const consoleIssues = [];
const dialogs = [];
const mainLogs = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('cdp connect failed'));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener) {
    this.listeners.push(listener);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function launch(label) {
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, APPDATA, PLAYPOCKET_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdout.on('data', (d) => mainLogs.push(`[${label}:out] ${String(d).trim()}`));
  child.stderr.on('data', (d) => mainLogs.push(`[${label}:err] ${String(d).trim()}`));

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('electron page target not found');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on((message) => {
    if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(`[${label}] ${message.params.type}: ${message.params.message}`);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      if (type === 'error' || type === 'warning') {
        const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        const frame = message.params.stackTrace?.callFrames?.[0];
        const where = frame ? ` @${(frame.url || '').split('/').slice(-2).join('/')}:${frame.lineNumber}` : '';
        consoleIssues.push(`[${label}] +${Math.round((Date.now() - T0) / 1000)}s console.${type}: ${text}${where}`);
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails;
      consoleIssues.push(`[${label}] EXCEPTION: ${d.exception?.description || d.text}`);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');

  async function evaluate(fn, arg) {
    const expression = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
    const run = cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 90000));
    const result = await Promise.race([run, timeout]);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async function setFiles(selector, files) {
    const doc = await cdp.send('DOM.getDocument', { depth: 1 });
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    await cdp.send('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
  }

  async function waitReady() {
    for (let i = 0; i < 120; i++) {
      try {
        const ok = await evaluate(() => typeof PP !== 'undefined' && !!PP.ready);
        if (ok) break;
      } catch {}
      await sleep(250);
    }
    return evaluate(async () => PP.ready);
  }

  async function installHelpers() {
    await evaluate(() => {
      window.__alerts = [];
      window.__swaps = [];
      PP.ui.alert = (message) => { window.__alerts.push(String(message)); };
      PP.ui.confirm = () => true;
      PP.bus.on('engine:swapped', (event) => window.__swaps.push({ ...event, at: performance.now() }));
      window.__t = {
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        async waitFor(predicate, timeout = 8000, stepMs = 50) {
          const start = performance.now();
          while (performance.now() - start < timeout) {
            try {
              const value = await predicate();
              if (value) return value;
            } catch {}
            await new Promise((r) => setTimeout(r, stepMs));
          }
          throw new Error(`waitFor timeout: ${predicate.toString().slice(0, 140)}`);
        },
        snap: () => PP.engine.debugSnapshot(),
        active: () => {
          const s = PP.engine.debugSnapshot();
          return s.decks[s.activeIndex];
        },
        standby: () => {
          const s = PP.engine.debugSnapshot();
          return s.decks[1 - s.activeIndex];
        }
      };
      return true;
    });
  }

  async function quit() {
    try {
      const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      const browser = new CDP(version.webSocketDebuggerUrl);
      await browser.connect();
      browser.send('Browser.close').catch(() => {});
      browser.close();
    } catch {}
    const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
    cdp.close();
    if (code === 'timeout') {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
    return code;
  }

  function kill() {
    cdp.close();
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }

  return { child, cdp, evaluate, setFiles, waitReady, installHelpers, quit, kill };
}

function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail: condition ? '' : detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

async function step(name, fn) {
  const only = process.env.PP_E2E_ONLY ? process.env.PP_E2E_ONLY.split(',') : null;
  const always = ['startup', 'add files'];
  if (only && !always.includes(name) && !only.some((s) => name.includes(s))) return;
  try {
    await fn();
  } catch (error) {
    check(`${name} (scenario error)`, false, String(error && error.message || error));
  }
}

async function main() {
  const files = {
    a: path.join(MEDIA, 'a.webm'),
    b: path.join(MEDIA, 'b.webm'),
    c: path.join(MEDIA, 'c.webm'),
    bad: path.join(MEDIA, 'bad.webm')
  };
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) throw new Error(`missing media: ${file}`);
  }

  console.log(`run dir: ${RUN_DIR}`);
  let app = await launch('run1');
  const ready = await app.waitReady();
  await app.installHelpers();
  const ev = app.evaluate;

  await step('startup', async () => {
    const info = await ev(() => ({
      ready: true,
      version: document.querySelector('.search').textContent,
      schema: PP.settings.get().schemaVersion,
      snap: PP.engine.debugSnapshot(),
      dev: PP.env.dev
    }));
    check('startup: init resolved true', ready === true, ready);
    check('startup: version label is 1.5.2', info.version.includes('1.5.2'), info.version);
    check('startup: settings schema version', info.schema === 2, info.schema);
    check('startup: deck B is not muted', info.snap.decks[1].muted === false, info.snap.decks[1]);
    check('startup: audio context running', info.snap.ctxState === 'running', info.snap.ctxState);
    check('startup: deck B hidden as standby', info.snap.decks[1].standbyClass === true && info.snap.decks[0].standbyClass === false, info.snap.decks);
  });

  await step('prompt dialog', async () => {
    const r = await ev(async () => {
      const out = {};
      let p = PP.dialogs.promptText({ title: 't', label: 'l', value: 'abc' });
      let modal = document.querySelector('.prompt-modal');
      out.opened = !!modal;
      const input = modal.querySelector('input');
      out.initial = input.value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      out.stillOpenDuringIme = !!document.querySelector('.prompt-modal');
      input.value = 'xyz';
      modal.querySelector('.share-primary').click();
      out.ok = await p;
      out.removed = !document.querySelector('.prompt-modal');
      p = PP.dialogs.promptText({ title: 't', label: 'l', value: 'abc' });
      document.querySelector('.prompt-modal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.esc = await p;
      p = PP.dialogs.promptText({ title: 't', label: 'l', value: 'q' });
      document.querySelector('.prompt-modal input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      out.enter = await p;
      return out;
    });
    check('prompt: opens with initial value', r.opened && r.initial === 'abc', r);
    check('prompt: Enter during IME composition does not submit', r.stillOpenDuringIme === true, r);
    check('prompt: OK returns typed value and closes', r.ok === 'xyz' && r.removed, r);
    check('prompt: Escape returns null', r.esc === null, r);
    check('prompt: Enter submits', r.enter === 'q', r);
    const native = await ev(() => { try { window.prompt('x'); return 'ok'; } catch (e) { return `throws:${e.message}`; } });
    check('electron native prompt() is unsupported (why the dialog is needed)', String(native).startsWith('throws'), native);
  });

  await step('add files', async () => {
    await app.setFiles('#fileInput', [files.a, files.b, files.c]);
    const r = await ev(async () => {
      await __t.waitFor(() => PP.state.items.length === 3, 30000);
      await __t.waitFor(() => document.querySelectorAll('.track-item').length === 3, 5000);
      const infos = await PP.db.getVideoInfos(PP.state.items);
      return {
        infos: infos.map((i) => ({ d: Math.round(i.duration), thumb: !!i.thumbnail, blob: i.hasBlob, mime: i.mimeType, size: i.size })),
        urls: PP.media.urls.count(),
        total: document.getElementById('totalDuration').textContent,
        playlist: PP.state.currentPlaylist
      };
    });
    check('add: 3 files stored with blobs', r.infos.length === 3 && r.infos.every((i) => i.blob), r);
    check('add: durations detected (6,6,7)', r.infos.map((i) => i.d).join(',') === '6,6,7', r.infos);
    check('add: thumbnails generated', r.infos.every((i) => i.thumb), r.infos);
    check('add: no leaked object URLs after probing', r.urls === 0, r.urls);
    check('add: total duration displayed', r.total === '00:00:19', r.total);
    check('add: auto-created default playlist', r.playlist === 'Default', r.playlist);
  });

  await step('rename via context menu', async () => {
    await ev(async () => {
      document.getElementById('newPlaylistName').value = 'Other';
      document.getElementById('createPlaylistBtn').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Other', 5000);
      document.getElementById('newPlaylistName').value = 'Other';
      document.getElementById('createPlaylistBtn').click();
      await __t.waitFor(() => window.__alerts.some((m) => m.includes('同名')), 5000);
      const names = [...document.querySelectorAll('.playlist-name')];
      names.find((n) => n.textContent === 'Default').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Default' && PP.state.items.length === 3, 5000);
    });
    const r = await ev(async () => {
      const name = [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Default');
      name.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await __t.waitFor(() => document.querySelector('.prompt-modal'), 3000);
      document.querySelector('.prompt-modal input').value = 'Renamed';
      document.querySelector('.prompt-modal .share-primary').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Renamed', 5000);
      const lists = (await PP.db.listPlaylists()).map((p) => `${p.name}:${p.items.length}`);
      const dup = [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Other');
      dup.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await __t.waitFor(() => document.querySelector('.prompt-modal'), 3000);
      document.querySelector('.prompt-modal input').value = 'Renamed';
      document.querySelector('.prompt-modal .share-primary').click();
      await __t.waitFor(() => window.__alerts.filter((m) => m.includes('同名')).length >= 2, 5000);
      return { lists, items: PP.state.items.length, labels: [...document.querySelectorAll('.playlist-name')].map((n) => n.textContent) };
    });
    check('rename: playlist renamed, items preserved', r.lists.includes('Renamed:3') && !r.lists.some((l) => l.startsWith('Default')), r);
    check('rename: duplicate name rejected with alert', r.labels.includes('Other'), r);
  });

  await step('basic playback', async () => {
    const r = await ev(async () => {
      const id = PP.state.items[0];
      await PP.player.playTrackById(id);
      await __t.waitFor(() => __t.active().time > 0.4 && !__t.active().paused, 8000);
      const a = __t.active();
      return { trackId: a.trackId === id, urls: PP.media.urls.count(), hasUrl: a.hasUrl, vol: a.volume, cur: PP.state.currentTrackId === id, ui: document.getElementById('playPauseBtn').textContent };
    });
    check('playback: track loads and plays', r.trackId && r.cur && r.hasUrl, r);
    check('playback: exactly one object URL alive', r.urls === 1, r.urls);
    check('playback: UI shows pause icon while playing', r.ui === 'Ⅱ', r.ui);
  });

  await step('rapid next spam', async () => {
    const r = await ev(async () => {
      const first = document.getElementById('trackList').firstElementChild;
      const start = PP.state.currentTrackId;
      const items = PP.state.items.slice();
      for (let i = 0; i < 10; i++) PP.player.step(1);
      await __t.waitFor(() => !PP.player.isBusy() && !__t.active().paused && __t.active().time > 0.2, 15000);
      const expected = items[(items.indexOf(start) + 10) % items.length];
      const a = __t.active();
      return {
        expected: a.trackId === expected && PP.state.currentTrackId === expected,
        urls: PP.media.urls.count(),
        alerts: window.__alerts.length,
        sameDom: first === document.getElementById('trackList').firstElementChild,
        highlighted: document.querySelector('.track-item.playing')?.dataset.id === expected,
        got: a.trackId, want: expected
      };
    });
    check('spam: 10 rapid Next clicks land on the correct track', r.expected, r);
    check('spam: no object URL leak (<=2)', r.urls <= 2, r.urls);
    check('spam: track list DOM is not rebuilt on track change', r.sameDom, r);
    check('spam: highlight follows the current track', r.highlighted, r);
  });

  await step('shuffle and random', async () => {
    const r = await ev(async () => {
      const items = PP.state.items.slice();
      PP.player.setMode('shuffle');
      await PP.player.playTrackById(items[2]);
      await __t.waitFor(() => __t.active().time > 0.2, 8000);
      const out = {};
      out.shufflePlaysClicked = PP.state.currentTrackId === items[2] && __t.active().trackId === items[2];
      out.highlightOk = document.querySelector('.track-item.playing')?.dataset.id === items[2];
      const seen = new Set([items[2]]);
      for (let i = 0; i < 2; i++) {
        await PP.player.step(1);
        await __t.waitFor(() => __t.active().time > 0.1, 8000);
        seen.add(PP.state.currentTrackId);
      }
      out.noRepeatInCycle = seen.size === 3;
      PP.player.setMode('random');
      await PP.player.playTrackById(items[1]);
      await __t.waitFor(() => __t.active().time > 0.1, 8000);
      out.randomPlaysClicked = PP.state.currentTrackId === items[1] && __t.active().trackId === items[1];
      PP.player.setMode('order');
      out.aria = document.getElementById('orderBtn').getAttribute('aria-selected') === 'true' && document.getElementById('shuffleBtn').getAttribute('aria-selected') === 'false';
      return out;
    });
    check('shuffle: clicking a track plays that exact track', r.shufflePlaysClicked, r);
    check('shuffle: highlighted row is the playing track', r.highlightOk, r);
    check('shuffle: a full cycle visits every track once', r.noRepeatInCycle, r);
    check('random: clicking a track plays that exact track', r.randomPlaysClicked, r);
    check('mode buttons keep aria-selected in sync', r.aria, r);
  });

  await step('volume applies to both decks', async () => {
    const r = await ev(() => {
      PP.engine.setVolume(0.4);
      const s = PP.engine.debugSnapshot();
      const out = { v0: s.decks[0].volume, v1: s.decks[1].volume, m0: s.decks[0].muted, m1: s.decks[1].muted };
      PP.engine.setVolume(1);
      return out;
    });
    check('volume: both decks share master volume and none is muted', r.v0 === 0.4 && r.v1 === 0.4 && !r.m0 && !r.m1, r);
  });

  await step('gapless handoff', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ gaplessEnabled: true, crossfadeEnabled: false, seamlessPlayback: true });
      const items = PP.state.items.slice();
      await PP.player.playTrackById(items[0]);
      await __t.waitFor(() => __t.active().time > 0.4, 8000);
      const el = PP.engine.activeEl();
      el.currentTime = el.duration - 3.4;
      const swapsBefore = window.__swaps.length;
      await __t.waitFor(() => __t.standby().ready, 8000);
      const standbyId = __t.standby().trackId;
      await __t.waitFor(() => window.__swaps.length > swapsBefore, 10000);
      await __t.sleep(300);
      const a = __t.active();
      const swap = window.__swaps[window.__swaps.length - 1];
      return {
        kind: swap.kind, trackIsNext: PP.state.currentTrackId === items[1] && standbyId === items[1],
        playing: !a.paused && a.time > 0 && a.time < 1.5, urls: PP.media.urls.count(), muted: a.muted,
        fade: a.fade, oldCleared: !__t.standby().hasUrl, activeTrack: a.trackId === items[1]
      };
    });
    check('gapless: handoff kind', r.kind === 'gapless', r);
    check('gapless: next track became current without reload', r.trackIsNext && r.activeTrack, r);
    check('gapless: new active deck is audible and playing from the start', r.playing && r.muted === false && r.fade === 1, r);
    check('gapless: old deck released, only one URL alive', r.oldCleared && r.urls === 1, r);
  });

  await step('crossfade', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ crossfadeEnabled: true, crossfadeDuration: 2 });
      const items = PP.state.items.slice();
      await PP.player.playTrackById(items[1]);
      await __t.waitFor(() => __t.active().time > 0.4, 8000);
      const el = PP.engine.activeEl();
      el.currentTime = el.duration - 4.5;
      const swapsBefore = window.__swaps.length;
      const samples = [];
      const start = performance.now();
      while (window.__swaps.length === swapsBefore && performance.now() - start < 14000) {
        const s = PP.engine.debugSnapshot();
        if (s.transition && s.transition.phase === 'fading') {
          const from = s.decks[s.activeIndex];
          const to = s.decks[1 - s.activeIndex];
          samples.push({ from: from.fade, to: to.fade, toPlaying: !to.paused, toMuted: to.muted, toVol: to.volume, fromPlaying: !from.paused });
        }
        await __t.sleep(80);
      }
      await __t.sleep(300);
      const swap = window.__swaps[window.__swaps.length - 1];
      const a = __t.active();
      const mid = samples.filter((x) => x.from > 0.03 && x.from < 0.97 && x.to > 0.03 && x.to < 0.97);
      return {
        kind: swap && swap.kind, samples: samples.length, mid: mid.length,
        allAudible: samples.length > 0 && samples.every((x) => x.toPlaying && !x.toMuted && x.toVol === 1),
        fromDecreasing: samples.every((x, i) => i === 0 || x.from <= samples[i - 1].from + 0.02),
        toIncreasing: samples.every((x, i) => i === 0 || x.to >= samples[i - 1].to - 0.02),
        current: PP.state.currentTrackId === items[2], playing: !a.paused, urls: PP.media.urls.count(), oldCleared: !__t.standby().hasUrl,
        final: { fade: a.fade }
      };
    });
    check('crossfade: transition completed as crossfade', r.kind === 'crossfade', r);
    check('crossfade: incoming deck is unmuted and playing during the fade', r.allAudible, r);
    check('crossfade: gains cross over smoothly (both between 0 and 1)', r.mid >= 2 && r.fromDecreasing && r.toIncreasing, r);
    check('crossfade: next track is current, old deck released, one URL', r.current && r.playing && r.oldCleared && r.urls === 1, r);
  });

  await step('pause during crossfade', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ crossfadeEnabled: true, crossfadeDuration: 3 });
      const items = PP.state.items.slice();
      await PP.player.playTrackById(items[0]);
      await __t.waitFor(() => __t.active().time > 0.4, 8000);
      const el = PP.engine.activeEl();
      el.currentTime = el.duration - 5;
      await __t.waitFor(() => (PP.engine.debugSnapshot().transition || {}).phase === 'fading', 12000);
      await __t.sleep(400);
      await PP.player.togglePlayPause();
      await __t.sleep(400);
      const s = PP.engine.debugSnapshot();
      const out = {
        noTransition: s.transition === null, bothPaused: s.decks.every((d) => d.paused), current: PP.state.currentTrackId === items[1],
        wantPlaying: PP.state.wantPlaying
      };
      await PP.player.togglePlayPause();
      await __t.waitFor(() => !__t.active().paused, 5000);
      out.resumed = true;
      return out;
    });
    check('pause mid-crossfade: transition settled and everything paused', r.noTransition && r.bothPaused && r.wantPlaying === false, r);
    check('pause mid-crossfade: next track is the current one and can resume', r.current && r.resumed, r);
  });

  await step('manual next uses prebuffered deck', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ crossfadeEnabled: false, gaplessEnabled: true });
      const items = PP.state.items.slice();
      await PP.player.playTrackById(items[0]);
      await __t.waitFor(() => __t.active().time > 0.4, 8000);
      const el = PP.engine.activeEl();
      el.currentTime = el.duration - 4;
      await __t.waitFor(() => __t.standby().ready && __t.standby().trackId === items[1], 8000);
      const indexBefore = PP.engine.debugSnapshot().activeIndex;
      const t0 = performance.now();
      await PP.player.step(1);
      const elapsed = performance.now() - t0;
      const s = PP.engine.debugSnapshot();
      return { flipped: s.activeIndex !== indexBefore, elapsed: Math.round(elapsed), playing: !s.decks[s.activeIndex].paused, urls: PP.media.urls.count(), cur: PP.state.currentTrackId === items[1] };
    });
    check('manual next: promotes the prebuffered deck instantly (no reload)', r.flipped && r.cur && r.playing && r.urls === 1, r);
    check('manual next: switch latency is small', r.elapsed < 400, r);
  });

  await step('add second playlist with a broken file', async () => {
    await ev(async () => {
      document.getElementById('newPlaylistName').value = 'BadList';
      document.getElementById('createPlaylistBtn').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'BadList', 5000);
    });
    await app.setFiles('#fileInput', [files.a]);
    await ev(() => __t.waitFor(() => PP.state.items.length === 1, 20000));
    await app.setFiles('#fileInput', [files.bad]);
    await ev(() => __t.waitFor(() => PP.state.items.length === 2, 20000));
    await app.setFiles('#fileInput', [files.b]);
    const r = await ev(async () => {
      await __t.waitFor(() => PP.state.items.length === 3, 20000);
      const infos = await PP.db.getVideoInfos(PP.state.items);
      return infos.map((i) => ({ name: i.name, d: Math.round(i.duration), thumb: !!i.thumbnail }));
    });
    check('broken file is stored without crashing the import', r.length === 3 && r[1].d === 0 && r[1].thumb === false, r);
  });

  await step('auto-skip broken file', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ crossfadeEnabled: false, gaplessEnabled: true });
      const items = PP.state.items.slice();
      const alertsBefore = window.__alerts.length;
      await PP.player.playTrackById(items[0]);
      await __t.waitFor(() => __t.active().time > 0.4, 8000);
      const el = PP.engine.activeEl();
      el.currentTime = el.duration - 1.6;
      await __t.waitFor(() => PP.state.currentTrackId === items[2] && !__t.active().paused && __t.active().time > 0.2, 20000);
      const autoAlerts = window.__alerts.length - alertsBefore;
      const before = window.__alerts.length;
      await PP.player.playTrackById(items[1]);
      await __t.sleep(1500);
      return { autoAlerts, userAlerts: window.__alerts.length - before, wantPlaying: PP.state.wantPlaying, urls: PP.media.urls.count() };
    });
    check('auto-skip: unplayable track is skipped silently during auto advance', r.autoAlerts === 0, r);
    check('auto-skip: explicit click on a broken track informs the user once', r.userAlerts === 1 && r.wantPlaying === false, r);
    check('auto-skip: no object URL leak after failures', r.urls <= 2, r);
  });

  await step('reorder by drag and drop', async () => {
    const r = await ev(async () => {
      const names = [...document.querySelectorAll('.playlist-name')];
      names.find((n) => n.textContent === 'Renamed').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Renamed' && PP.state.items.length === 3 && [...document.querySelectorAll('.track-item')].map((l) => l.dataset.id).join() === PP.state.items.join(), 5000);
      const before = PP.state.items.slice();
      const currentId = PP.state.currentTrackId;
      const lis = [...document.querySelectorAll('.track-item')];
      const dt = new DataTransfer();
      dt.setData('text/plain', '0');
      lis[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      lis[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      lis[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await __t.waitFor(() => PP.state.items[2] === before[0], 5000);
      const pl = await PP.db.getPlaylist('Renamed');
      return {
        order: pl.items.join() === [before[1], before[2], before[0]].join(),
        domOrder: [...document.querySelectorAll('.track-item')].map((l) => l.dataset.id).join() === pl.items.join(),
        dragClassCleared: !document.querySelector('.drag-over'),
        idxSynced: currentId === null || PP.state.items.indexOf(currentId) === -1 || PP.state.currentIndex === PP.state.items.indexOf(currentId)
      };
    });
    check('reorder: DB and DOM order updated atomically', r.order && r.domOrder, r);
    check('reorder: drag classes cleared and playback index stays consistent', r.dragClassCleared && r.idxSynced, r);
  });

  await step('export and import round trip', async () => {
    const r = await ev(async () => {
      const header = '"format":"playpocket-share","version":1,"mediaIncluded":true,';
      const { name, blob } = await PP.library.buildExportBlob({ includeBlobs: true, header });
      const text = await blob.text();
      const obj = PPSchema.safeJsonParse(text);
      const meta = await PP.library.buildExportBlob({ includeBlobs: false });
      const metaObj = PPSchema.safeJsonParse(await meta.blob.text());
      const out = {
        name, format: obj.format, items: obj.items.length, hasBlobs: obj.items.every((i) => typeof i.blobBase64 === 'string' && i.blobBase64.length > 100),
        metaNoBlobs: metaObj.items.every((i) => !('blobBase64' in i)) && metaObj.items.length === 3, keys: Object.keys(obj).join()
      };
      const originals = obj.items.map((i) => i.size);
      const imported = await PP.library.importPlaylistPayload(obj, ' (import)');
      out.importedName = imported.name;
      const pl = await PP.db.getPlaylist(imported.name);
      const records = await Promise.all(pl.items.map((id) => PP.db.getVideo(id)));
      out.blobSizes = records.map((rec) => rec.blob.size);
      out.sizesMatch = records.every((rec, i) => rec.blob.size === originals[i]);
      out.stateSwitched = PP.state.currentPlaylist === imported.name;
      const playable = await PP.player.playTrackById(pl.items[0]);
      await __t.waitFor(() => __t.active().time > 0.3, 8000);
      out.importedPlays = playable === true;
      return out;
    });
    check('export: share package header and items', r.format === 'playpocket-share' && r.items === 3 && r.hasBlobs, r);
    check('export: metadata export has no blobs', r.metaNoBlobs, r);
    check('import: blobs restored bit-exact by size and playable', r.sizesMatch && r.importedPlays && r.stateSwitched, r);
  });

  await step('import failure rolls back', async () => {
    const r = await ev(async () => {
      const good = await PP.library.buildExportBlob({ includeBlobs: true });
      const obj = PPSchema.safeJsonParse(await good.blob.text());
      obj.items[2].blobBase64 = '!!!not-base64!!!';
      const namesBefore = (await PP.db.listPlaylists()).map((p) => p.name).sort().join();
      let threw = false;
      try { await PP.library.importPlaylistPayload(obj, ' (broken)'); } catch { threw = true; }
      const namesAfter = (await PP.db.listPlaylists()).map((p) => p.name).sort().join();
      const orphans = await PP.db.pruneOrphanVideos();
      return { threw, unchanged: namesBefore === namesAfter, orphans };
    });
    check('import failure: throws, creates no playlist, leaves no orphan video records', r.threw && r.unchanged && r.orphans === 0, r);
  });

  await step('db atomicity and orphan sweep', async () => {
    const r = await ev(async () => {
      const before = (await PP.db.getPlaylist('Renamed')).items.slice();
      let rejected = false;
      try {
        await PP.db.addVideoToPlaylist({ id: 'atomic-x', name: 'x', blob: () => {} }, 'Renamed');
      } catch { rejected = true; }
      const after = (await PP.db.getPlaylist('Renamed')).items.slice();
      const ghost = await PP.db.getVideo('atomic-x');
      await PP.db.putVideo({ id: 'orphan-1', name: 'o', duration: 1, mimeType: 'video/mp4', size: 1, blob: new Blob(['x']) });
      await PP.db.putVideo({ id: 'orphan-2', name: 'o', duration: 1, mimeType: 'video/mp4', size: 1, blob: new Blob(['x']) });
      const removed = await PP.db.pruneOrphanVideos();
      const survivors = await PP.db.getVideoInfos(after);
      return { rejected, unchanged: before.join() === after.join(), noGhost: !ghost, removed, survivors: survivors.length === after.length };
    });
    check('atomic: failed add rolls back both stores', r.rejected && r.unchanged && r.noGhost, r);
    check('orphan sweep: removes unreferenced videos only', r.removed === 2 && r.survivors, r);
  });

  await step('remove track and delete playlist cleanup', async () => {
    const r = await ev(async () => {
      const removedId = PP.state.items[PP.state.items.length - 1];
      const lis = [...document.querySelectorAll('.track-item')];
      lis[lis.length - 1].querySelector('.remove').click();
      await __t.waitFor(() => !PP.state.items.includes(removedId), 5000);
      const gone = (await PP.db.getVideoInfos([removedId])).length === 0;
      const names = [...document.querySelectorAll('.playlist-item')];
      const target = names.find((li) => li.dataset.name.includes('(import)'));
      const importedItems = (await PP.db.getPlaylist(target.dataset.name)).items.slice();
      target.querySelector('button').click();
      await __t.waitFor(async () => !(await PP.db.getPlaylist(target.dataset.name)), 5000);
      const infos = await PP.db.getVideoInfos(importedItems);
      const orphans = await PP.db.pruneOrphanVideos();
      return { gone, importedGone: infos.length === 0, orphans, playlistCount: (await PP.db.listPlaylists()).length };
    });
    check('remove track: unreferenced video record deleted from DB', r.gone, r);
    check('delete playlist: its videos are deleted, nothing orphaned', r.importedGone && r.orphans === 0, r);
  });

  await step('ipc validation from renderer', async () => {
    const r = await ev(async () => {
      const api = window.electronAPI;
      const out = {};
      out.evil = await api.openExternal('https://evil.example.com');
      out.file = await api.openExternal('file:///C:/Windows/System32/calc.exe');
      out.notString = await api.openExternal({ toString: () => 'https://playpocket.f5.si' });
      const s = await api.setSettings({ crossfadeDuration: 999, bogus: 1, audioPreset: 'x', compactUI: 'yes' });
      out.settings = { cf: s.crossfadeDuration, bogus: 'bogus' in s, preset: s.audioPreset, compact: s.compactUI };
      out.state = await api.saveRuntimeState({ lastVolume: 'x', evil: 1, lastPlayMode: 'random' });
      api.setRPC('not an object');
      api.updatePlaybackState(null);
      const restored = await api.setSettings({ crossfadeDuration: 2 });
      out.restored = restored.crossfadeDuration;
      return out;
    });
    check('ipc: external url outside the official site is rejected', r.evil === false && r.file === false && r.notString === false, r);
    check('ipc: invalid settings are sanitized by main', r.settings.cf === 10 && !r.settings.bogus && r.settings.preset === 'standard' && r.settings.compact === false, r);
    check('ipc: malformed payloads never throw', r.state === true && r.restored === 2, r);
  });

  await step('settings ui binding', async () => {
    const r = await ev(async () => {
      const box = document.getElementById('compactUI');
      box.click();
      await __t.waitFor(() => PP.settings.get().compactUI === true, 5000);
      const out = { appClass: document.getElementById('app').classList.contains('compact-ui'), checked: box.checked };
      const select = document.getElementById('audioPreset');
      select.value = 'high';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await __t.waitFor(() => PP.settings.get().audioPreset === 'high', 5000);
      out.preload = PP.engine.activeEl().preload;
      const c = navigator.connection;
      out.net = { has: !!c, type: c && c.effectiveType, downlink: c && c.downlink, saveData: c && c.saveData, downgraded: !!c && (c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType) || (c.downlink > 0 && c.downlink < 1.5)) };
      const hw = document.getElementById('cacheEnabled');
      const alertsBefore = window.__alerts.length;
      hw.click();
      await __t.waitFor(() => window.__alerts.length > alertsBefore, 5000);
      hw.click();
      await __t.sleep(200);
      return out;
    });
    check('settings: checkbox toggles setting and applies class', r.appClass && r.checked, r);
    console.log('NETINFO', JSON.stringify(r.net));
    check('settings: audio preset applied to the media element', r.preload === 'auto' || r.net.downgraded, r);
  });

  await step('large playlist render', async () => {
    const r = await ev(async () => {
      const ids = [];
      for (let i = 0; i < 400; i++) {
        const id = `bulk-${i}`;
        ids.push(id);
        await PP.db.putVideo({ id, name: `bulk ${i}.mp4`, duration: 60, mimeType: 'video/mp4', size: 1048576, blob: null, thumbnail: null });
      }
      await PP.db.putPlaylist({ name: 'Bulk', items: ids });
      await PP.library.refreshAll();
      const t0 = performance.now();
      [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Bulk').click();
      await __t.waitFor(() => document.querySelectorAll('.track-item').length === 400, 15000);
      const renderMs = Math.round(performance.now() - t0);
      const first = document.getElementById('trackList').firstElementChild;
      const t1 = performance.now();
      PP.state.currentTrackId = ids[300];
      PP.bus.emit('player:track-changed', {});
      const highlightMs = performance.now() - t1;
      const same = first === document.getElementById('trackList').firstElementChild;
      const total = document.getElementById('totalDuration').textContent;
      return { renderMs, highlightMs: Math.round(highlightMs * 10) / 10, same, total, cacheSize: PP.cache.videoInfo.size };
    });
    check('large playlist: 400 tracks render quickly', r.renderMs < 2500, r);
    check('large playlist: highlight update is cheap and keeps DOM', r.highlightMs < 30 && r.same, r);
    check('large playlist: total duration correct (400 min = 06:40:00)', r.total === '06:40:00', r);
    await ev(async () => {
      const pl = (await PP.db.getPlaylist('Bulk')).items;
      const target = [...document.querySelectorAll('.playlist-item')].find((li) => li.dataset.name === 'Bulk');
      target.querySelector('button').click();
      await __t.waitFor(async () => !(await PP.db.getPlaylist('Bulk')), 8000);
      PP.state.currentTrackId = null;
      return pl.length;
    });
  });

  await step('object url accounting', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ crossfadeEnabled: false, gaplessEnabled: false, seamlessPlayback: false });
      PP.player.setMode('order');
      const first = PP.state.items[0];
      await PP.player.playTrackById(first);
      for (let i = 0; i < 12; i++) {
        await PP.player.step(1);
        await __t.sleep(60);
      }
      await __t.waitFor(() => !PP.player.isBusy(), 8000);
      return PP.media.urls.count();
    });
    check('url accounting: 12 more track switches keep at most 2 URLs', r <= 2, r);
  });

  await step('media formats', async () => {
    const extra = ['d.mp4', 'e.ogv', 'f.mp4'].map((n) => path.join(MEDIA, n));
    for (const file of extra) {
      if (!fs.existsSync(file)) throw new Error(`missing media: ${file}`);
    }
    await ev(async () => {
      document.getElementById('newPlaylistName').value = 'Formats';
      document.getElementById('createPlaylistBtn').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Formats', 5000);
    });
    await app.setFiles('#fileInput', extra);
    const r = await ev(async () => {
      await __t.waitFor(() => PP.state.items.length === 3, 30000);
      const infos = await PP.db.getVideoInfos(PP.state.items);
      const out = [];
      for (const id of PP.state.items) {
        await PP.player.playTrackById(id);
        await __t.waitFor(() => __t.active().trackId === id && __t.active().time > 0.4 && !__t.active().paused, 10000);
        const el = PP.engine.activeEl();
        out.push({ id, mime: infos.find((i) => i.id === id).mimeType, duration: Math.round(el.duration), videoWidth: el.videoWidth });
      }
      return out;
    });
    check('formats: MP4 (H.264/AAC) plays', r[0].mime === 'video/mp4' && r[0].duration === 5 && r[0].videoWidth === 160, r[0]);
    check('formats: OGG plays (Vorbis audio; Chromium no longer decodes Theora video)', r[1].mime === 'video/ogg' && r[1].duration === 5, r[1]);
    check('formats: audio-only MP4 plays', r[2].duration === 5 && r[2].videoWidth === 0, r[2]);
  });

  await step('second instance', async () => {
    const second = spawn(ELECTRON, ['.', `--user-data-dir=${USER_DATA}`], {
      cwd: ROOT,
      env: { ...process.env, APPDATA, PLAYPOCKET_TEST_MODE: '1' },
      stdio: 'ignore'
    });
    const code = await Promise.race([new Promise((resolve) => second.on('exit', resolve)), sleep(15000).then(() => 'timeout')]);
    if (code === 'timeout') second.kill();
    const alive = await ev(() => document.querySelectorAll('.playlist-item').length > 0);
    check('second instance: exits immediately and the first keeps running', code === 0 && alive === true, { code, alive });
  });

  await step('persistence setup', async () => {
    const r = await ev(async () => {
      await window.electronAPI.setSettings({ trayEnabled: false, minimizeOnClose: false });
      await PP.settings.set({ crossfadeEnabled: false, gaplessEnabled: true, seamlessPlayback: true });
      const names = [...document.querySelectorAll('.playlist-name')];
      const target = names.find((n) => n.textContent === 'Renamed');
      target.click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Renamed' && PP.state.items.length === 3, 5000);
      PP.player.setMode('shuffle');
      const speed = document.getElementById('speedSelect');
      speed.value = '1.5';
      speed.dispatchEvent(new Event('change', { bubbles: true }));
      PP.engine.setVolume(0.35);
      const id = PP.state.items[1];
      await PP.player.playTrackById(id);
      await __t.waitFor(() => __t.active().time > 0.5, 8000);
      const el = PP.engine.activeEl();
      el.currentTime = 2.0;
      await __t.sleep(400);
      el.pause();
      await __t.sleep(700);
      return { id, time: el.currentTime, vol: PP.engine.getVolume() };
    });
    global.__saved = r;
    check('persistence setup: paused near 2s at volume 0.35', r.time > 1.5 && r.time < 3.5 && r.vol === 0.35, r);
  });

  const exitCode = await app.quit();
  check('clean quit: process exits with code 0', exitCode === 0, exitCode);

  const statePath = path.join(APPDATA, 'PlayPocket', 'state.json');
  const settingsPath = path.join(APPDATA, 'PlayPocket', 'settings.json');
  await step('state file after quit', async () => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const saved = global.__saved;
    check('state.json saved at quit: track, volume, mode, speed', state.lastTrackId === saved.id && state.lastVolume === 0.35 && state.lastPlayMode === 'shuffle' && state.lastSpeed === 1.5, state);
    check('state.json saved at quit: position and paused flag', Math.abs(state.lastTime - saved.time) < 0.8 && state.isPlaying === false && state.lastPlaylist === 'Renamed', state);
    check('settings.json persisted with schema version', settings.compactUI === true && settings.audioPreset === 'high' && settings.schemaVersion === 2, settings);
    check('no temp files left behind', !fs.readdirSync(path.join(APPDATA, 'PlayPocket')).some((n) => n.endsWith('.tmp')), fs.readdirSync(path.join(APPDATA, 'PlayPocket')));
  });

  fs.writeFileSync(settingsPath, '{ "compactUI": tru');
  app = await launch('run2');
  await app.waitReady();
  await app.installHelpers();

  await step('restart restore', async () => {
    const saved = global.__saved;
    const r = await app.evaluate(async () => {
      await __t.waitFor(() => PP.state.currentTrackId !== null, 15000);
      await __t.sleep(600);
      const a = __t.active();
      return {
        track: PP.state.currentTrackId, playlist: PP.state.currentPlaylist, mode: PP.state.playMode,
        vol: PP.engine.getVolume(), speed: document.getElementById('speedSelect').value,
        time: a.time, paused: a.paused, tracks: document.querySelectorAll('.track-item').length,
        settings: PP.settings.get(), urls: PP.media.urls.count(), playing: document.querySelector('.track-item.playing')?.dataset.id
      };
    });
    check('restore: same track, playlist, mode, volume and speed', r.track === saved.id && r.playlist === 'Renamed' && r.mode === 'shuffle' && r.vol === 0.35 && r.speed === '1.5', r);
    check('restore: playback position restored and stays paused', Math.abs(r.time - saved.time) < 1 && r.paused === true, r);
    check('restore: IndexedDB data survived restart', r.tracks === 2 || r.tracks === 3, r);
    check('restore: highlight matches restored track', r.playing === saved.id, r);
    const files = fs.readdirSync(path.join(APPDATA, 'PlayPocket'));
    check('corrupt settings.json is quarantined and app still starts with valid settings', files.some((n) => n.includes('settings.json.corrupt-')) && r.settings.schemaVersion === 2, files);
    check('restore: only the restored deck holds an object URL', r.urls === 1, r.urls);
  });

  await step('orphan sweep after startup keeps referenced data', async () => {
    await sleep(6500);
    const r = await app.evaluate(async () => {
      const pls = await PP.db.listPlaylists();
      const ids = pls.flatMap((p) => p.items);
      const infos = await PP.db.getVideoInfos(ids);
      return { playlists: pls.length, referenced: ids.length, present: infos.length };
    });
    check('startup sweep: every referenced video still present', r.referenced === r.present, r);
  });

  const diag = await app.evaluate(() => ({
    nav: performance.getEntriesByType('navigation').map((n) => ({ type: n.type, url: n.name.split('/').slice(-2).join('/') })),
    frames: window.frames.length,
    api: !!window.electronAPI
  }));
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  console.log('DIAG-RUN2', JSON.stringify({ diag, targets: targets.map((t) => `${t.type}:${t.url.split('/').slice(-2).join('/')}`) }));

  await app.quit();
  const unique = Array.from(new Set(consoleIssues));
  for (const line of unique.slice(0, 40)) console.log(line);
  console.log(`(${consoleIssues.length} total, ${unique.length} unique)`);
  console.log('--- native dialogs auto-dismissed ---');
  for (const line of dialogs) console.log(line);
  console.log('--- main process output ---');
  for (const line of mainLogs.filter((l) => !/DevTools listening/.test(l)).slice(0, 30)) console.log(line);

  const failed = results.filter((r) => !r.ok);
  const exceptions = unique.filter((l) => l.includes('EXCEPTION'));
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} passed, ${exceptions.length} exception(s)`);
  process.exit(failed.length === 0 && exceptions.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('RUNNER ERROR', error);
    process.exit(2);
  });
}

module.exports = { launch, sleep, check, results, RUN_DIR, APPDATA, consoleIssues, mainLogs };
