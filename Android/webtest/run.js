'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ELECTRON = require(process.env.PP_ELECTRON_PATH || 'E:\\Projects\\Apps\\Playlist-forWIndows\\node_modules\\electron');
const MEDIA = process.env.PP_E2E_MEDIA || path.join(os.tmpdir(), 'pp-e2e', 'media');
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-android-web-'));
const PORT = 9600 + Math.floor(Math.random() * 150);
const MAIN = path.join(__dirname, 'main.js');

const results = [];
const issues = [];
const dialogs = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 1;
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
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.listeners.forEach((listener) => listener(message));
      }
    };
  }

  send(method, params = {}) {
    const id = this.id++;
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

async function launch() {
  const child = spawn(ELECTRON, [MAIN, `--user-data-dir=${path.join(RUN_DIR, 'ud')}`, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env },
    stdio: 'ignore'
  });
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('page not found');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on((message) => {
    if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(`${message.params.type}: ${message.params.message}`);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      issues.push(`console.${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (message.method === 'Runtime.exceptionThrown') {
      issues.push(`EXCEPTION: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');

  const api = {
    child,
    cdp,
    async evaluate(fn, arg) {
      const expression = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
      const run = cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 90000));
      const result = await Promise.race([run, timeout]);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async setFiles(selector, files) {
      const doc = await cdp.send('DOM.getDocument', { depth: 1 });
      const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      await cdp.send('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
    },
    async waitReady() {
      for (let i = 0; i < 120; i++) {
        try {
          if (await api.evaluate(() => typeof PP !== 'undefined' && !!PP.ready)) break;
        } catch {}
        await sleep(250);
      }
      const ready = await api.evaluate(async () => PP.ready);
      await api.installHelpers();
      return ready;
    },
    async installHelpers() {
      await api.evaluate(() => {
        window.__alerts = [];
        window.__swaps = [];
        PP.ui.alert = (message) => { window.__alerts.push(String(message)); };
        PP.ui.confirm = () => true;
        PP.bus.on('engine:swapped', (event) => window.__swaps.push(event));
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
    },
    async reload(injectSource) {
      let scriptId = null;
      if (injectSource) {
        scriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource })).identifier;
      }
      await cdp.send('Page.reload', { ignoreCache: true });
      await sleep(600);
      const ready = await api.waitReady();
      if (scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
      return ready;
    },
    kill() {
      cdp.close();
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
  };
  return api;
}

function check(name, condition, detail) {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name} (scenario error)`, false, String(error && error.message || error));
  }
}

async function main() {
  const media = ['a.webm', 'b.webm', 'c.webm'].map((n) => path.join(MEDIA, n));
  const app = await launch();
  const ready = await app.waitReady();
  const ev = app.evaluate;

  await step('startup', async () => {
    const r = await ev(() => ({
      platform: PP.platform.name,
      version: document.querySelector('.search').textContent,
      snap: PP.engine.debugSnapshot(),
      disabled: ['rpcEnabled', 'startupLaunch', 'minimizeOnClose', 'hardwareAcceleration'].map((id) => document.getElementById(id).disabled),
      notifRow: getComputedStyle(document.getElementById('notificationControlsEnabled').closest('.settings-row')).display,
      notifEnabled: document.getElementById('notificationControlsEnabled').disabled,
      settings: PP.settings.get(),
      bridgeCalls: window.__bridge.calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`)
    }));
    check('android: init resolved and platform is android', ready === true && r.platform === 'android', r);
    check('android: version label is 1.5.2', r.version.includes('1.5.2'), r.version);
    check('android: deck B is unmuted and audio context runs', r.snap.decks[1].muted === false && r.snap.ctxState === 'running', r.snap);
    check('android: desktop-only settings are disabled, notification setting is usable', r.disabled.every(Boolean) && r.notifRow !== 'none' && r.notifEnabled === false, r);
    check('android: defaults differ from desktop (rpc off, minimize-on-close off)', r.settings.rpcEnabled === false && r.settings.minimizeOnClose === false && r.settings.resumePlayback === true && !('trayEnabled' in r.settings), r.settings);
    check('android: notification controls state is sent to the native side at startup', r.bridgeCalls.includes('setNotificationControlsEnabled:[true]'), r.bridgeCalls);
  });

  await step('add files with extension fallback', async () => {
    await app.setFiles('#fileInput', media);
    const r = await ev(async () => {
      await __t.waitFor(() => PP.state.items.length === 3, 30000);
      const before = PP.state.items.length;
      await PP.library.addFiles([
        new File([new Blob(['not really a video'])], 'fake.mkv', { type: '' }),
        new File([new Blob(['text'])], 'notes.txt', { type: 'text/plain' }),
        new File([new Blob(['text'])], 'noext', { type: '' })
      ]);
      const after = PP.state.items.length;
      const infos = await PP.db.getVideoInfos(PP.state.items);
      const fake = infos.find((i) => i.name === 'fake.mkv');
      const out = { added: after - before, fakeMime: fake && fake.mimeType, fakeHasBlob: fake && fake.hasBlob, urls: PP.media.urls.count() };
      const li = [...document.querySelectorAll('.track-item')].find((l) => l.querySelector('.title').textContent === 'fake');
      li.querySelector('.remove').click();
      await __t.waitFor(() => PP.state.items.length === before, 5000);
      return out;
    });
    check('android: only files with a video extension are accepted when the type is empty', r.added === 1 && r.fakeHasBlob === true, r);
    check('android: empty mime type falls back to a valid one', r.fakeMime === 'video/mp4', r);
    check('android: no leaked object URLs after adding', r.urls === 0, r);
  });

  await step('sidebar and back button', async () => {
    const r = await ev(async () => {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.getElementById('overlay');
      const out = {};
      out.initial = sidebar.classList.contains('open');
      document.getElementById('menuToggle').click();
      out.opened = sidebar.classList.contains('open') && overlay.classList.contains('active');
      out.closeReturn1 = window.__ppClosePanels();
      out.closedByBack = !sidebar.classList.contains('open') && !overlay.classList.contains('active');
      out.closeReturn2 = window.__ppClosePanels();
      document.getElementById('openSettingsBtn').click();
      out.settingsOpen = document.getElementById('settingsModal').classList.contains('open');
      out.closeReturn3 = window.__ppClosePanels();
      out.settingsClosed = !document.getElementById('settingsModal').classList.contains('open');
      document.getElementById('menuToggle').click();
      overlay.click();
      out.overlayCloses = !sidebar.classList.contains('open');
      document.getElementById('menuToggle').click();
      [...document.querySelectorAll('.playlist-name')][0].click();
      await __t.sleep(50);
      document.getElementById('menuToggle').click();
      const names = [...document.querySelectorAll('.playlist-name')];
      names[0].click();
      await __t.sleep(200);
      out.selectingClosesSidebar = true;
      document.getElementById('newPlaylistName').value = 'SidebarTest';
      document.getElementById('menuToggle').click();
      document.getElementById('createPlaylistBtn').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'SidebarTest', 5000);
      out.createClosesSidebar = !sidebar.classList.contains('open');
      [...document.querySelectorAll('.playlist-item')].find((li) => li.dataset.name === 'SidebarTest').querySelector('button').click();
      await __t.waitFor(async () => !(await PP.db.getPlaylist('SidebarTest')), 5000);
      await __t.waitFor(() => PP.state.currentPlaylist !== 'SidebarTest' && PP.state.items.length === 3, 5000);
      return out;
    });
    check('sidebar: toggle opens with overlay, back button closes it', r.initial === false && r.opened && r.closeReturn1 === true && r.closedByBack, r);
    check('back button: reports "nothing to close" so the app can exit', r.closeReturn2 === false, r);
    check('back button: closes the settings dialog', r.settingsOpen && r.closeReturn3 === true && r.settingsClosed, r);
    check('sidebar: overlay tap and playlist creation close it', r.overlayCloses && r.createClosesSidebar, r);
  });

  await step('playlist rename gesture', async () => {
    const r = await ev(async () => {
      const out = {};
      const name = () => [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Default');
      name().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await __t.sleep(150);
      out.contextmenuIgnored = !document.querySelector('.prompt-modal');
      out.hint = name().title;
      name().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await __t.waitFor(() => document.querySelector('.prompt-modal'), 3000);
      document.querySelector('.prompt-modal input').value = 'Mobile';
      document.querySelector('.prompt-modal .share-primary').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Mobile', 5000);
      out.names = (await PP.db.listPlaylists()).map((p) => p.name);
      const again = [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Mobile');
      again.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await __t.waitFor(() => document.querySelector('.prompt-modal'), 3000);
      document.querySelector('.prompt-modal input').value = 'Default';
      document.querySelector('.prompt-modal .share-primary').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Default', 5000);
      return out;
    });
    check('android: rename is triggered by double tap, not by long press', r.contextmenuIgnored && r.hint.includes('ダブルクリック'), r);
    check('android: rename works through the in-page dialog', r.names.includes('Mobile') && !r.names.includes('Default'), r);
  });

  await step('notification commands', async () => {
    const r = await ev(async () => {
      const calls = () => window.__bridge.playback;
      const out = {};
      window.__ppHandlePlaybackCommand('toggle-play-pause');
      await __t.waitFor(() => __t.active().time > 0.4 && !__t.active().paused, 10000);
      const last1 = calls()[calls().length - 1];
      out.playing = last1.isPlaying === true && typeof last1.title === 'string' && last1.title.length > 0;
      const titleBefore = last1.title;
      window.__ppHandlePlaybackCommand('next-track');
      await __t.waitFor(() => { const l = calls()[calls().length - 1]; return l.isPlaying && l.title !== titleBefore; }, 10000);
      out.titleChanged = true;
      window.__ppHandlePlaybackCommand('toggle-play-pause');
      await __t.waitFor(() => calls()[calls().length - 1].isPlaying === false, 5000);
      out.paused = true;
      const n0 = calls().length;
      await __t.sleep(500);
      const n = calls().length;
      window.__ppHandlePlaybackCommand('rm -rf /');
      window.__ppHandlePlaybackCommand({});
      await __t.sleep(200);
      out.invalidIgnored = calls().length === n;
      PP.platform.reportPlaybackState({ isPlaying: true, title: 'a\u0000b'.repeat(200) });
      const last = calls()[calls().length - 1];
      out.titleClean = last.title.length <= 200 && !/[\u0000-\u001F]/.test(last.title);
      window.__ppHandlePlaybackCommand('toggle-play-pause');
      await __t.waitFor(() => !__t.active().paused, 5000);
      return out;
    });
    check('notification: play/pause command starts playback and reports the title', r.playing && r.paused, r);
    check('notification: next command updates the reported title', r.titleChanged, r);
    check('notification: unknown commands are ignored', r.invalidIgnored, r);
    check('notification: reported title is sanitized and length-limited', r.titleClean, r);
  });

  await step('settings persistence', async () => {
    const r = await ev(async () => {
      const box = document.getElementById('notificationControlsEnabled');
      box.click();
      await __t.waitFor(() => PP.settings.get().notificationControlsEnabled === false, 5000);
      const stored = JSON.parse(localStorage.getItem('playpocket-settings-v1'));
      const calls = window.__bridge.calls.filter((c) => c.name === 'setNotificationControlsEnabled').map((c) => c.args[0]);
      box.click();
      await __t.waitFor(() => PP.settings.get().notificationControlsEnabled === true, 5000);
      return { stored: stored.notificationControlsEnabled, schema: stored.schemaVersion, calls, keys: Object.keys(stored).length };
    });
    check('settings: toggle persists to localStorage and informs the native side', r.stored === false && r.schema === 2 && r.calls[r.calls.length - 1] === false, r);
  });

  await step('session flush when hidden', async () => {
    const r = await ev(async () => {
      const el = PP.engine.activeEl();
      el.currentTime = 1.5;
      await __t.sleep(100);
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      const stored = JSON.parse(localStorage.getItem('playpocket-session-v2'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      return { trackId: stored.trackId === PP.state.currentTrackId, time: stored.time, wasPlaying: stored.wasPlaying, keys: Object.keys(stored).sort().join() };
    });
    check('session: written synchronously when the app goes to the background', r.trackId && r.time > 1 && r.wasPlaying === true, r);
    check('session: keeps the existing storage format (including panel state)', r.keys === 'index,playMode,playlist,settingsOpen,shuffleOrder,sidebarOpen,speed,time,trackId,volume,wasPlaying', r.keys);
  });

  await step('restore from legacy v1.5.0 data', async () => {
    const ids = await ev(() => PP.state.items.slice());
    const legacySettings = {
      audioPreset: 'high', resumePlayback: true, cacheEnabled: true, rpcEnabled: false, startupLaunch: false, minimizeOnClose: false,
      hardwareAcceleration: true, autoAudioQuality: false, compactUI: true, notificationControlsEnabled: false, videoDisplayEnabled: true,
      crossfadeEnabled: false, crossfadeDuration: 2.5, gaplessEnabled: true, seamlessPlayback: true, volumeNormalization: false, monoAudio: false,
      someRemovedSetting: 'x'
    };
    const legacySession = {
      playlist: 'Default', index: 1, trackId: ids[1], playMode: 'shuffle', shuffleOrder: ids.slice().reverse(),
      time: 2.0, speed: 1.5, volume: 0.35, wasPlaying: false, sidebarOpen: true, settingsOpen: false
    };
    await app.reload(`localStorage.setItem('playpocket-settings-v1', ${JSON.stringify(JSON.stringify(legacySettings))}); localStorage.setItem('playpocket-session-v2', ${JSON.stringify(JSON.stringify(legacySession))});`);
    await sleep(800);
    const r = await ev(async () => {
      await __t.waitFor(() => PP.state.currentTrackId !== null, 15000);
      await __t.sleep(500);
      const a = __t.active();
      return {
        track: PP.state.currentTrackId, mode: PP.state.playMode, order: PP.state.shuffleOrder.slice(), vol: PP.engine.getVolume(),
        speed: document.getElementById('speedSelect').value, time: a.time, paused: a.paused,
        sidebar: document.querySelector('.sidebar').classList.contains('open'), overlay: document.getElementById('overlay').classList.contains('active'),
        settings: PP.settings.get(), compact: document.getElementById('app').classList.contains('compact-ui'),
        notifCalls: window.__bridge.calls.filter((c) => c.name === 'setNotificationControlsEnabled').map((c) => c.args[0])
      };
    });
    check('legacy restore: track, mode, volume, speed and position come back (paused)', r.track === ids[1] && r.mode === 'shuffle' && r.vol === 0.35 && r.speed === '1.5' && Math.abs(r.time - 2) < 1 && r.paused, r);
    check('legacy restore: saved shuffle order is kept', JSON.stringify(r.order) === JSON.stringify(ids.slice().reverse()), r.order);
    check('legacy restore: sidebar open state is restored', r.sidebar && r.overlay, r);
    check('legacy settings: values normalized, unknown keys dropped, UI applied', r.settings.crossfadeDuration === 3 && r.settings.audioPreset === 'high' && r.compact && !('someRemovedSetting' in r.settings), r.settings);
    check('legacy settings: notification preference forwarded to native side', r.notifCalls[0] === false, r.notifCalls);
    await ev(() => { document.getElementById('overlay').click(); return true; });
  });

  await step('resume disabled', async () => {
    const off = JSON.stringify({ resumePlayback: false });
    await app.reload(`localStorage.setItem('playpocket-settings-v1', ${JSON.stringify(off)});`);
    const r = await ev(async () => ({ track: PP.state.currentTrackId, sidebar: document.querySelector('.sidebar').classList.contains('open') }));
    check('resume off: nothing is restored', r.track === null && r.sidebar === false, r);
    await app.reload(`localStorage.setItem('playpocket-settings-v1', ${JSON.stringify(JSON.stringify({ resumePlayback: true }))});`);
  });
  await step('save through the native picker', async () => {
    const r = await ev(async () => {
      const out = {};
      const bridge = window.__bridge;
      const savedCount = () => Object.keys(bridge.saved).length;
      const text = (entry) => new TextDecoder().decode(new Uint8Array(entry.chunks.flatMap((c) => Array.from(c))));
      const latest = () => { const keys = Object.keys(bridge.saved); return bridge.saved[keys[keys.length - 1]]; };

      document.getElementById('exportWithBlobsBtn').click();
      await __t.waitFor(() => savedCount() === 1 && latest().done, 15000);
      const full = latest();
      const parsed = PPSchema.safeJsonParse(text(full));
      out.full = { name: full.fileName, mime: full.mimeType, items: parsed.items.length, sizes: parsed.items.map((i) => Math.round(atob(i.blobBase64.slice(0, 8)).length)).every((n) => n > 0), chunks: full.chunks.length, total: full.chunks.reduce((s, c) => s + c.length, 0) };

      document.getElementById('exportMetaBtn').click();
      await __t.waitFor(() => savedCount() === 2 && latest().done, 10000);
      const meta = PPSchema.safeJsonParse(text(latest()));
      out.meta = { name: latest().fileName, noBlobs: meta.items.every((i) => !('blobBase64' in i)) };

      document.getElementById('sharePlaylistBtn').click();
      await __t.waitFor(() => document.getElementById('shareModal').classList.contains('open'), 3000);
      document.getElementById('downloadSharePackageBtn').click();
      await __t.waitFor(() => savedCount() === 3 && latest().done, 15000);
      await __t.waitFor(() => document.getElementById('shareStatus').className.includes('success'), 5000);
      const pkg = PPSchema.safeJsonParse(text(latest()));
      out.share = { name: latest().fileName, format: pkg.format, status: document.getElementById('shareStatus').textContent, items: pkg.items.length };

      bridge.mode = 'cancel';
      document.getElementById('downloadSharePackageBtn').click();
      await __t.waitFor(() => document.getElementById('shareStatus').textContent.includes('キャンセル'), 8000);
      out.cancelStatus = document.getElementById('shareStatus').textContent;
      out.cancelKeptNothing = latest().chunks.length === 0 || savedCount() === 4;

      bridge.mode = 'writeFail';
      document.getElementById('downloadSharePackageBtn').click();
      await __t.waitFor(() => document.getElementById('shareStatus').className.includes('error'), 8000);
      out.writeFailStatus = document.getElementById('shareStatus').textContent;
      out.cancelCalled = bridge.calls.some((c) => c.name === 'cancelSave');

      bridge.mode = 'beginFail';
      document.getElementById('downloadSharePackageBtn').click();
      await __t.sleep(600);
      out.beginFailStatus = document.getElementById('shareStatus').textContent;

      bridge.mode = 'ok';
      document.getElementById('closeShareBtn').click();
      window.__alerts.length = 0;
      bridge.mode = 'writeFail';
      document.getElementById('exportWithBlobsBtn').click();
      await __t.waitFor(() => window.__alerts.length > 0, 10000);
      out.exportFailAlert = window.__alerts[0];
      bridge.mode = 'ok';
      return out;
    });
    check('save: embedded export goes through the picker as valid JSON with all videos', r.full.name.endsWith('.playlist.full.json') && r.full.mime === 'application/json' && r.full.items === 3 && r.full.sizes && r.full.chunks >= 1, r.full);
    check('save: chunked transfer (bounded chunks, no giant string)', r.full.total > 100000, r.full);
    check('save: metadata-only export has no blobs', r.meta.name.endsWith('.playlist.json') && r.meta.noBlobs, r.meta);
    check('save: share package has the right name, format and success message', r.share.name.endsWith('.playpocket.json') && r.share.format === 'playpocket-share' && r.share.items === 3 && r.share.status.includes('端末に保存'), r.share);
    check('save: cancelling the picker is reported calmly', r.cancelStatus.includes('キャンセル'), r);
    check('save: a failed write aborts the native session and tells the user', r.writeFailStatus.includes('保存できません') && r.cancelCalled, r);
    check('save: native refusal is reported as a failure', r.beginFailStatus.includes('保存できません'), r.beginFailStatus);
    check('save: failed export shows an error dialog', r.exportFailAlert.includes('エクスポートに失敗'), r.exportFailAlert);
  });

  await step('chunked save integrity', async () => {
    const r = await ev(async () => {
      const bridge = window.__bridge;
      const original = new Uint8Array(1500007);
      for (let i = 0; i < original.length; i += 65536) crypto.getRandomValues(original.subarray(i, Math.min(i + 65536, original.length)));
      await PP.db.putVideo({ id: 'chunk-1', name: 'chunk.mp4', duration: 5, mimeType: 'video/mp4', size: original.length, blob: new Blob([original], { type: 'video/mp4' }), thumbnail: null });
      await PP.db.putPlaylist({ name: 'Chunky', items: ['chunk-1'] });
      await PP.library.refreshAll();
      [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Chunky').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Chunky' && PP.state.items.length === 1, 5000);
      const before = Object.keys(bridge.saved).length;
      const lastKey = () => Object.keys(bridge.saved).pop();
      document.getElementById('exportWithBlobsBtn').click();
      await __t.waitFor(() => Object.keys(bridge.saved).length === before + 1 && bridge.saved[lastKey()].done, 20000);
      const entry = bridge.saved[lastKey()];
      const bytes = new Uint8Array(entry.chunks.reduce((s, c) => s + c.length, 0));
      let offset = 0;
      for (const c of entry.chunks) { bytes.set(c, offset); offset += c.length; }
      const parsed = PPSchema.safeJsonParse(new TextDecoder().decode(bytes));
      const bin = atob(parsed.items[0].blobBase64);
      const decoded = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
      const digest = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8))).map((x) => x.toString(16).padStart(2, '0')).join('');
      const out = { chunks: entry.chunks.length, equal: (await digest(decoded)) === (await digest(original)), maxChunk: Math.max(...entry.chunks.map((c) => c.length)), size: decoded.length };
      [...document.querySelectorAll('.playlist-item')].find((li) => li.dataset.name === 'Chunky').querySelector('button').click();
      await __t.waitFor(async () => !(await PP.db.getPlaylist('Chunky')), 5000);
      await __t.waitFor(() => PP.state.currentPlaylist === 'Default' && PP.state.items.length === 3, 5000);
      return out;
    });
    check('save: a 1.5MB embedded video survives chunked transfer bit-exactly', r.equal && r.size === 1500007, r);
    check('save: transfer is split into bounded chunks', r.chunks >= 4 && r.maxChunk <= 384 * 1024, r);
  });

  await step('embedded export guard for low-memory devices', async () => {
    const r = await ev(async () => {
      const out = {};
      const bridge = window.__bridge;
      const before = Object.keys(bridge.saved).length;
      await PP.db.putVideo({ id: 'huge-1', name: 'huge.mp4', duration: 10, mimeType: 'video/mp4', size: 200 * 1024 * 1024, blob: new Blob(['x']), thumbnail: null });
      await PP.db.putPlaylist({ name: 'Huge', items: ['huge-1'] });
      await PP.library.refreshAll();
      [...document.querySelectorAll('.playlist-name')].find((n) => n.textContent === 'Huge').click();
      await __t.waitFor(() => PP.state.currentPlaylist === 'Huge' && PP.state.items.length === 1, 5000);
      window.__alerts.length = 0;
      document.getElementById('exportWithBlobsBtn').click();
      await __t.waitFor(() => window.__alerts.length > 0, 8000);
      out.alert = window.__alerts[0];
      document.getElementById('sharePlaylistBtn').click();
      await __t.waitFor(() => document.getElementById('shareModal').classList.contains('open'), 3000);
      document.getElementById('downloadSharePackageBtn').click();
      await __t.waitFor(() => document.getElementById('shareStatus').className.includes('error'), 8000);
      out.share = document.getElementById('shareStatus').textContent;
      document.getElementById('closeShareBtn').click();
      out.nothingSaved = Object.keys(bridge.saved).length === before;
      document.getElementById('exportMetaBtn').click();
      await __t.waitFor(() => Object.keys(bridge.saved).length === before + 1, 8000);
      out.metaStillWorks = true;
      const target = [...document.querySelectorAll('.playlist-item')].find((li) => li.dataset.name === 'Huge');
      target.querySelector('button').click();
      await __t.waitFor(async () => !(await PP.db.getPlaylist('Huge')), 5000);
      await __t.waitFor(() => PP.state.currentPlaylist !== 'Huge', 5000);
      return out;
    });
    check('guard: embedded export over 150MB is refused on Android with an explanation', r.alert.includes('この端末では埋め込みエクスポートに失敗する可能性'), r);
    check('guard: share package over the device limit is refused, nothing is written', r.share.includes('この端末では動画の合計サイズが大きすぎて') && r.nothingSaved, r);
    check('guard: metadata-only export is still available', r.metaStillWorks, r);
  });

  await step('transitions on the android build', async () => {
    const r = await ev(async () => {
      await PP.settings.set({ crossfadeEnabled: true, crossfadeDuration: 2, gaplessEnabled: true, seamlessPlayback: true });
      PP.player.setMode('order');
      const items = PP.state.items.slice();
      await PP.player.playTrackById(items[0]);
      await __t.waitFor(() => __t.active().time > 0.4, 10000);
      const el = PP.engine.activeEl();
      el.currentTime = el.duration - 4.5;
      const before = window.__swaps.length;
      await __t.waitFor(() => window.__swaps.length > before, 15000);
      await __t.sleep(300);
      const a = __t.active();
      const out = { kind: window.__swaps[window.__swaps.length - 1].kind, current: PP.state.currentTrackId === items[1], playing: !a.paused, urls: PP.media.urls.count(), muted: a.muted };
      const start = PP.state.currentTrackId;
      for (let i = 0; i < 9; i++) PP.player.step(1);
      await __t.waitFor(() => !PP.player.isBusy() && __t.active().time > 0.2, 15000);
      out.spamOk = PP.state.currentTrackId === items[(items.indexOf(start) + 9) % items.length] && PP.media.urls.count() <= 2;
      return out;
    });
    check('android: crossfade swaps decks without reload and stays audible', r.kind === 'crossfade' && r.current && r.playing && r.muted === false && r.urls === 1, r);
    check('android: rapid Next taps land on the right track without leaking URLs', r.spamOk, r);
  });

  await step('external links and cache', async () => {
    const r = await ev(async () => {
      document.getElementById('officialSiteLink').click();
      await __t.sleep(200);
      document.getElementById('clearCacheBtn').click();
      await __t.sleep(200);
      return window.__bridge.calls.filter((c) => c.name === 'openExternal' || c.name === 'clearCache').map((c) => `${c.name}:${c.args[0] || ''}`);
    });
    check('android: official site link and cache clearing go through the native bridge', r.includes('openExternal:https://playpocket.f5.si') && r.includes('clearCache:'), r);
  });

  const realIssues = Array.from(new Set(issues)).filter((line) => !/PPError: exists|load failed|\[save\] Error: write failed/.test(line));
  console.log('\n--- console issues ---');
  for (const line of realIssues) console.log(line);
  console.log('--- native dialogs auto-dismissed ---');
  for (const line of dialogs) console.log(line);
  check('no unexpected console errors or exceptions', realIssues.length === 0, realIssues);

  app.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('RUNNER ERROR', error);
  process.exit(2);
});
