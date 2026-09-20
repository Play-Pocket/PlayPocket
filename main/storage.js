'use strict';

const fs = require('fs');
const path = require('path');
const { isPlainObject, safeJsonParse } = require('../app/shared/schema.js');

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_QUARANTINED = 3;
const RETRY_DELAY_MS = 3000;

function readJsonObject(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'missing', value: null };
    return { status: 'invalid', value: null, error };
  }
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return { status: 'invalid', value: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = safeJsonParse(raw);
    if (!isPlainObject(parsed)) return { status: 'invalid', value: null };
    return { status: 'ok', value: parsed };
  } catch (error) {
    return { status: 'invalid', value: null, error };
  }
}

function pruneQuarantine(filePath) {
  try {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.corrupt-`;
    const stale = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, -MAX_QUARANTINED);
    for (const name of stale) fs.rmSync(path.join(dir, name), { force: true });
  } catch {}
}

function quarantine(filePath) {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    pruneQuarantine(filePath);
  } catch {
    try { fs.rmSync(filePath, { force: true }); } catch {}
  }
}

function loadJsonWithRecovery(filePath, log) {
  const primary = readJsonObject(filePath);
  if (primary.status === 'ok') return { value: primary.value, source: 'primary' };

  const backupPath = `${filePath}.bak`;
  if (primary.status === 'invalid') {
    if (log) log.warn('storage', `invalid json: ${path.basename(filePath)}`);
    quarantine(filePath);
  }

  const backup = readJsonObject(backupPath);
  if (backup.status === 'ok') {
    if (log) log.warn('storage', `restored from backup: ${path.basename(filePath)}`);
    try { fs.copyFileSync(backupPath, filePath); } catch {}
    return { value: backup.value, source: 'backup' };
  }
  if (backup.status === 'invalid') quarantine(backupPath);

  return { value: null, source: 'default' };
}

function writeJsonAtomicSync(filePath, value, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const data = JSON.stringify(value, null, 2);
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeSync(fd, data, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (backup) {
    try {
      if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {}
  }
  fs.renameSync(tempPath, filePath);
}

function createJsonStore({ filePath, backup = false, normalize, sanitizePatch, debounceMs = 250, log }) {
  let value = normalize(null);
  let dirty = false;
  let timer = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flushSync() {
    clearTimer();
    if (!dirty) return true;
    try {
      writeJsonAtomicSync(filePath, value, { backup });
      dirty = false;
      return true;
    } catch (error) {
      if (log) log.warn('storage', `write failed: ${path.basename(filePath)}`, error);
      return false;
    }
  }

  function schedule(delay = debounceMs) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!flushSync()) schedule(RETRY_DELAY_MS);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    load() {
      const result = loadJsonWithRecovery(filePath, log);
      value = normalize(result.value);
      dirty = result.source === 'backup' ? false : dirty;
      return value;
    },
    get() {
      return value;
    },
    merge(patch, { immediate = false } = {}) {
      value = normalize({ ...value, ...sanitizePatch(patch) });
      dirty = true;
      if (immediate) flushSync();
      else schedule();
      return value;
    },
    flushSync,
    isDirty: () => dirty
  };
}

module.exports = {
  readJsonObject,
  loadJsonWithRecovery,
  writeJsonAtomicSync,
  createJsonStore
};
