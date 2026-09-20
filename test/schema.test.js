'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../app/shared/schema.js');

test('defaultSettings returns platform specific defaults', () => {
  const win = Schema.defaultSettings('electron');
  const and = Schema.defaultSettings('android');
  assert.equal(win.rpcEnabled, true);
  assert.equal(and.rpcEnabled, false);
  assert.equal(win.minimizeOnClose, true);
  assert.equal(and.minimizeOnClose, false);
  assert.equal('trayEnabled' in and, false);
  assert.equal('notificationControlsEnabled' in win, false);
  assert.equal(win.schemaVersion, Schema.SCHEMA_VERSION);
});

test('normalizeSettings accepts a v1.5.1 settings.json unchanged', () => {
  const legacy = {
    audioPreset: 'high', rpcEnabled: false, startupLaunch: true, minimizeOnClose: false,
    cacheEnabled: true, hardwareAcceleration: false, restoreLastState: true, trayEnabled: false,
    alwaysOnTop: true, keyboardShortcutsEnabled: false, autoAudioQuality: false, compactUI: true,
    taskbarControlsEnabled: false, videoDisplayEnabled: false, crossfadeEnabled: true, crossfadeDuration: 7,
    gaplessEnabled: false, seamlessPlayback: false, volumeNormalization: true, monoAudio: true
  };
  const out = Schema.normalizeSettings(legacy, 'electron');
  for (const [key, value] of Object.entries(legacy)) assert.equal(out[key], value, key);
});

test('normalizeSettings repairs invalid values and ignores unknown keys', () => {
  const raw = JSON.parse('{"audioPreset":"ultra","rpcEnabled":"yes","crossfadeDuration":99,"gaplessEnabled":null,"monoAudio":1,"evil":true,"__proto__":{"polluted":true}}');
  const out = Schema.normalizeSettings(raw, 'electron');
  assert.equal(out.audioPreset, 'standard');
  assert.equal(out.rpcEnabled, true);
  assert.equal(out.crossfadeDuration, 10);
  assert.equal(out.gaplessEnabled, true);
  assert.equal(out.monoAudio, false);
  assert.equal('evil' in out, false);
  assert.equal({}.polluted, undefined);
});

test('objects with a swapped prototype are rejected as non-plain', () => {
  const tricky = { compactUI: true, __proto__: { polluted: true } };
  assert.deepEqual(Schema.normalizeSettings(tricky, 'electron'), Schema.defaultSettings('electron'));
});

test('normalizeSettings tolerates non-object input', () => {
  for (const input of [null, undefined, 5, 'x', [], true]) {
    const out = Schema.normalizeSettings(input, 'electron');
    assert.deepEqual(out, Schema.defaultSettings('electron'));
  }
});

test('crossfadeDuration is rounded, clamped and never coerces null or booleans', () => {
  assert.equal(Schema.normalizeSettings({ crossfadeDuration: 2.6 }, 'electron').crossfadeDuration, 3);
  assert.equal(Schema.normalizeSettings({ crossfadeDuration: '4' }, 'electron').crossfadeDuration, 4);
  assert.equal(Schema.normalizeSettings({ crossfadeDuration: -5 }, 'electron').crossfadeDuration, 1);
  assert.equal(Schema.normalizeSettings({ crossfadeDuration: null }, 'electron').crossfadeDuration, 3);
  assert.equal(Schema.normalizeSettings({ crossfadeDuration: true }, 'electron').crossfadeDuration, 3);
  assert.equal(Schema.normalizeSettings({ crossfadeDuration: NaN }, 'electron').crossfadeDuration, 3);
});

test('sanitizeSettingsPatch keeps only valid known keys for the platform', () => {
  const patch = Schema.sanitizeSettingsPatch({
    compactUI: true, trayEnabled: 'x', notificationControlsEnabled: true, crossfadeDuration: 2.4, audioPreset: 'nope', other: 1
  }, 'electron');
  assert.deepEqual(patch, { compactUI: true, crossfadeDuration: 2 });
  const android = Schema.sanitizeSettingsPatch({ notificationControlsEnabled: false, trayEnabled: true }, 'android');
  assert.deepEqual(android, { notificationControlsEnabled: false });
  assert.deepEqual(Schema.sanitizeSettingsPatch(null, 'electron'), {});
});

test('unknown platform throws', () => {
  assert.throws(() => Schema.defaultSettings('ios'));
});

test('normalizeRuntimeState is compatible with v1.5.1 state.json', () => {
  const legacy = {
    windowBounds: { x: 10, y: 20, width: 1280, height: 720, maximized: true },
    lastPlaylist: 'My List', lastCurrentIndex: 4, lastPlayMode: 'shuffle', lastVolume: 0.4, lastSpeed: 1.5,
    lastTrackId: 'id-abc', lastTime: 123.4, isPlaying: true
  };
  assert.deepEqual(Schema.normalizeRuntimeState(legacy), legacy);
});

test('normalizeRuntimeState repairs invalid data', () => {
  const out = Schema.normalizeRuntimeState({
    windowBounds: { width: 'x', height: 5 }, lastPlaylist: 5, lastCurrentIndex: -3.7, lastPlayMode: 'weird',
    lastVolume: 9, lastSpeed: 0, lastTrackId: '', lastTime: -1, isPlaying: 'true'
  });
  assert.equal(out.windowBounds, null);
  assert.equal(out.lastPlaylist, null);
  assert.equal(out.lastCurrentIndex, 0);
  assert.equal(out.lastPlayMode, 'order');
  assert.equal(out.lastVolume, 1);
  assert.equal(out.lastSpeed, 1);
  assert.equal(out.lastTrackId, null);
  assert.equal(out.lastTime, 0);
  assert.equal(out.isPlaying, false);
});

test('null volume no longer silences playback', () => {
  assert.equal(Schema.normalizeRuntimeState({ lastVolume: null }).lastVolume, 1);
});

test('window bounds enforce minimums and finite coordinates', () => {
  const b = Schema.sanitizeWindowBounds({ x: 'abc', y: 5.6, width: 100, height: 100, maximized: 1 });
  assert.deepEqual(b, { x: undefined, y: 6, width: 900, height: 600, maximized: true });
  assert.equal(Schema.sanitizeWindowBounds(null), null);
  assert.equal(Schema.sanitizeWindowBounds([]), null);
});

test('sanitizeRuntimeStateInput only emits valid fields', () => {
  const out = Schema.sanitizeRuntimeStateInput({
    lastVolume: 0.5, lastSpeed: -1, lastTrackId: 'x'.repeat(500), isPlaying: 'no', lastPlayMode: 'random', junk: 1
  });
  assert.deepEqual(out, { lastVolume: 0.5, lastPlayMode: 'random' });
});

test('normalizeSessionState validates android session data', () => {
  const out = Schema.normalizeSessionState({
    playlist: 'A', index: 2, trackId: 'id-1', playMode: 'shuffle', shuffleOrder: ['a', 5, 'b'],
    time: 12, speed: 9, volume: 0.3, wasPlaying: true, sidebarOpen: 'x', settingsOpen: false
  });
  assert.deepEqual(out, {
    playlist: 'A', index: 2, trackId: 'id-1', playMode: 'shuffle', shuffleOrder: ['a', 'b'],
    time: 12, speed: 2, volume: 0.3, wasPlaying: true, settingsOpen: false
  });
  assert.equal(Schema.normalizeSessionState('x'), null);
});

test('safeJsonParse strips prototype pollution keys', () => {
  const parsed = Schema.safeJsonParse('{"a":1,"__proto__":{"x":1},"n":{"constructor":{"y":2},"ok":3}}');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), false);
  assert.equal(parsed.n.ok, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.n, 'constructor'), false);
  assert.equal({}.x, undefined);
});

test('settings aliases and migrations infrastructure', () => {
  const defs = Schema.defsFor('electron');
  assert.ok(defs.length > 10);
  assert.ok(defs.every((d) => Array.isArray(d.aliases)));
  const v1 = Schema.normalizeSettings({ schemaVersion: 1, compactUI: true }, 'electron');
  assert.equal(v1.schemaVersion, Schema.SCHEMA_VERSION);
  assert.equal(v1.compactUI, true);
});
