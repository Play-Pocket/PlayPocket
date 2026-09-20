'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Schema = require('../app/shared/schema.js');
const { loadJsonWithRecovery, writeJsonAtomicSync, createJsonStore } = require('../main/storage.js');
const Validators = require('../main/validators.js');
const { createLogger } = require('../main/logger.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
}

function silentLog() {
  return { warn() {}, error() {}, info() {}, debug() {} };
}

test('atomic write leaves no temp file and round trips', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.json');
  writeJsonAtomicSync(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('corrupt primary is quarantined and backup is restored', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  writeJsonAtomicSync(file, { v: 1 }, { backup: true });
  writeJsonAtomicSync(file, { v: 2 }, { backup: true });
  fs.writeFileSync(file, '{ broken json');
  const result = loadJsonWithRecovery(file, silentLog());
  assert.equal(result.source, 'backup');
  assert.deepEqual(result.value, { v: 1 });
  assert.ok(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
});

test('corrupt file without backup falls back to default and does not throw', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '\u0000\u0000garbage');
  const result = loadJsonWithRecovery(file, silentLog());
  assert.equal(result.source, 'default');
  assert.equal(result.value, null);
});

test('non-object json and BOM are handled', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, '[1,2,3]');
  assert.equal(loadJsonWithRecovery(file, silentLog()).source, 'default');
  fs.writeFileSync(file, '\uFEFF{"ok":true}');
  assert.deepEqual(loadJsonWithRecovery(file, silentLog()).value, { ok: true });
});

test('missing file yields default silently', () => {
  const dir = tempDir();
  const result = loadJsonWithRecovery(path.join(dir, 'none.json'), silentLog());
  assert.equal(result.source, 'default');
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('quarantine keeps at most three corrupt copies', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.json');
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(file, `bad${i}`);
    loadJsonWithRecovery(file, silentLog());
  }
  assert.ok(fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')).length <= 3);
});

test('settings store: 1.5.1 file loads, patches persist, invalid patch ignored', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ audioPreset: 'low', compactUI: true, crossfadeDuration: 8 }));
  const store = createJsonStore({
    filePath: file, backup: true, debounceMs: 0,
    normalize: (raw) => Schema.normalizeSettings(raw, 'electron'),
    sanitizePatch: (patch) => Schema.sanitizeSettingsPatch(patch, 'electron'),
    log: silentLog()
  });
  const loaded = store.load();
  assert.equal(loaded.audioPreset, 'low');
  assert.equal(loaded.crossfadeDuration, 8);
  store.merge({ compactUI: false, audioPreset: 'bogus' }, { immediate: true });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.compactUI, false);
  assert.equal(onDisk.audioPreset, 'low');
  assert.equal(onDisk.schemaVersion, Schema.SCHEMA_VERSION);
  assert.ok(fs.existsSync(`${file}.bak`));
});

test('state store debounces then flushSync writes latest value once', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  const store = createJsonStore({
    filePath: file, backup: false, debounceMs: 40,
    normalize: Schema.normalizeRuntimeState,
    sanitizePatch: Schema.sanitizeRuntimeStateInput,
    log: silentLog()
  });
  store.load();
  store.merge({ lastTime: 1 });
  store.merge({ lastTime: 2 });
  store.merge({ lastTime: 3 });
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.isDirty(), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastTime, 3);
  assert.equal(store.isDirty(), false);
  store.merge({ lastTime: 9 });
  assert.equal(store.flushSync(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastTime, 9);
});

test('write failure keeps data dirty and does not throw', () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const store = createJsonStore({
    filePath: path.join(blocker, 'state.json'), debounceMs: 0,
    normalize: Schema.normalizeRuntimeState,
    sanitizePatch: Schema.sanitizeRuntimeStateInput,
    log: silentLog()
  });
  store.load();
  store.merge({ lastTime: 5 }, { immediate: true });
  assert.equal(store.isDirty(), true);
  assert.equal(store.get().lastTime, 5);
});

test('rpc payload sanitization', () => {
  assert.equal(Validators.sanitizeRpcPayload('x'), null);
  assert.equal(Validators.sanitizeRpcPayload([]), null);
  assert.deepEqual(Validators.sanitizeRpcPayload({ paused: true, title: 'x' }), { paused: true });
  const now = Date.now();
  const p = Validators.sanitizeRpcPayload({
    title: 'a\u0000b'.repeat(100), playlist: ' ', startTimestamp: now, endTimestamp: now - 5
  });
  assert.equal(p.title.length, 128);
  assert.equal(/[\u0000-\u001F]/.test(p.title), false);
  assert.equal(p.playlist, 'PlayPocketで再生中');
  assert.equal(p.endTimestamp, undefined);
  const q = Validators.sanitizeRpcPayload({ title: 'Song', startTimestamp: 'x', endTimestamp: 1e30 });
  assert.equal(q.title, 'Song');
  assert.ok(Math.abs(q.startTimestamp - Date.now()) < 5000);
  assert.equal(q.endTimestamp, undefined);
});

test('external url only allows the official https site', () => {
  assert.equal(Validators.sanitizeExternalUrl('https://playpocket.f5.si'), 'https://playpocket.f5.si/');
  assert.equal(Validators.sanitizeExternalUrl('https://playpocket.f5.si/a?b=1'), 'https://playpocket.f5.si/a?b=1');
  for (const bad of [
    'http://playpocket.f5.si', 'https://evil.com', 'https://playpocket.f5.si.evil.com', 'file:///C:/Windows/System32/calc.exe',
    'https://user:pw@playpocket.f5.si', 'https://playpocket.f5.si:8443', 'javascript:alert(1)', '', null, 5, 'x'.repeat(3000),
    'https://playpocket.f5.si@evil.com'
  ]) {
    assert.equal(Validators.sanitizeExternalUrl(bad), null, String(bad));
  }
});

test('playback command allowlist', () => {
  assert.equal(Validators.sanitizePlaybackCommand('next-track'), 'next-track');
  assert.equal(Validators.sanitizePlaybackCommand('rm -rf'), null);
  assert.equal(Validators.sanitizePlaybackCommand({}), null);
  assert.deepEqual(Validators.sanitizePlaybackState({ isPlaying: 'yes' }), { isPlaying: false });
  assert.equal(Validators.sanitizePlaybackState(null), null);
});

test('logger hides debug in production and dedupes identical messages', () => {
  const calls = [];
  const sink = { log: (m) => calls.push(['log', m]), warn: (m) => calls.push(['warn', m]), error: (m) => calls.push(['error', m]), info: (m) => calls.push(['info', m]) };
  const prod = createLogger({ isDev: false, sink });
  prod.debug('x', 'hidden');
  prod.info('x', 'hidden');
  for (let i = 0; i < 5; i++) prod.warn('x', 'same');
  prod.error('x', new Error('boom'));
  assert.deepEqual(calls.map((c) => c[0]), ['warn', 'error']);
  const dev = createLogger({ isDev: true, sink });
  calls.length = 0;
  dev.debug('x', 'shown');
  assert.equal(calls.length, 1);
});
