'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

function loadCore() {
  const win = { location: { search: '' }, crypto: webcrypto };
  win.window = win;
  const context = vm.createContext({
    window: win,
    navigator: { userAgent: 'test' },
    document: {},
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'core.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'core.js' });
  return win.PP;
}

const PP = loadCore();
const { util, C } = PP;

test('fileExtension is lower-cased and tolerates odd input', () => {
  assert.equal(util.fileExtension('Song.MP3'), 'mp3');
  assert.equal(util.fileExtension('archive.tar.gz'), 'gz');
  assert.equal(util.fileExtension('noext'), '');
  assert.equal(util.fileExtension(null), '');
});

test('audio files are detected by type or extension', () => {
  assert.equal(util.isAudioFile({ name: 'a.mp3', type: '' }), true);
  assert.equal(util.isAudioFile({ name: 'a.bin', type: 'audio/flac' }), true);
  assert.equal(util.isAudioFile({ name: 'a.mp4', type: 'video/mp4' }), false);
  assert.equal(util.isAudioFile(null), false);
  assert.equal(util.isAudioMime('audio/mpeg'), true);
  assert.equal(util.isAudioMime('video/mp4'), false);
});

test('resolveMimeType prefers a known type and falls back to the extension', () => {
  assert.equal(util.resolveMimeType({ name: 'a.mkv', type: '' }), 'video/x-matroska');
  assert.equal(util.resolveMimeType({ name: 'a.mp3', type: '' }), 'audio/mpeg');
  assert.equal(util.resolveMimeType({ name: 'a.webm', type: 'video/webm' }), 'video/webm');
  assert.equal(util.resolveMimeType({ name: 'a.xyz', type: 'application/x-foo' }), 'video/mp4');
  assert.equal(util.resolveMimeType(null), 'video/mp4');
});

test('audio mime types survive sanitizeMimeType', () => {
  for (const type of ['audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/mp4']) {
    assert.equal(util.sanitizeMimeType(type), type);
  }
  assert.equal(util.sanitizeMimeType('text/html'), 'video/mp4');
});

test('formatSize picks readable units', () => {
  assert.equal(util.formatSize(0), '0 KB');
  assert.equal(util.formatSize(NaN), '0 KB');
  assert.equal(util.formatSize(512), '1 KB');
  assert.equal(util.formatSize(300 * 1024), '300 KB');
  assert.equal(util.formatSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(util.formatSize(40 * 1024 * 1024), '40 MB');
  assert.equal(util.formatSize(2 * 1024 * 1024 * 1024), '2.00 GB');
});

test('extension tables are consistent', () => {
  for (const ext of [...C.VIDEO_EXTENSIONS, ...C.AUDIO_EXTENSIONS]) assert.equal(typeof ext, 'string');
  for (const mime of Object.values(C.EXTENSION_MIME)) assert.ok(C.ALLOWED_VIDEO_TYPES.has(mime), mime);
  assert.ok(C.PLACEHOLDER_THUMB.startsWith('data:image/svg+xml'));
});
