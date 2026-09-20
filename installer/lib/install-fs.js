'use strict';

const path = require('path');

let nodeFs;
try {
  nodeFs = require('original-fs');
} catch {
  nodeFs = require('fs');
}
const fsp = nodeFs.promises;

const APP_ID = 'io.github.takkunlego0916.playpocket.installer';
const PRODUCT_NAME = 'PlayPocket';
const INSTALL_FOLDER_NAME = 'PlayPocket';
const INSTALL_MANIFEST_FILE = '.playpocket-install.json';
const STAGING_PREFIX = `.${INSTALL_FOLDER_NAME}-staging-`;
const BACKUP_PREFIX = `.${INSTALL_FOLDER_NAME}-backup-`;
const WALK_MAX_DEPTH = 8;
const WALK_MAX_ENTRIES = 20000;

async function existsDir(dir) {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = (await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw, (key, value) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tempPath, filePath);
}

async function removeFileSafe(filePath) {
  try {
    await fsp.rm(filePath, { force: true });
  } catch {}
}

async function removeDirSafe(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {}
}

async function getDirectoryEntries(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function walkFiles(dir, options = {}) {
  const maxDepth = options.maxDepth ?? WALK_MAX_DEPTH;
  const budget = options.budget || { left: options.maxEntries ?? WALK_MAX_ENTRIES };
  const depth = options.depth ?? 0;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) throw error;
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) out.push(...await walkFiles(full, { maxDepth, budget, depth: depth + 1 }));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function normalizeVersionText(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function extractVersionFromText(value) {
  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)+)/);
  return match ? match[1] : null;
}

function compareVersions(a, b) {
  const pa = normalizeVersionText(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = normalizeVersionText(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isExecutableNameAllowed(fileName) {
  return !fileName.toLowerCase().includes('uninstall');
}

function isLikelyProductExeName(fileName) {
  return String(fileName || '').toLowerCase().includes(PRODUCT_NAME.toLowerCase());
}

async function findLatestExe(dir) {
  if (!dir) return null;
  if (!(await existsDir(dir))) return null;

  const files = await walkFiles(dir);
  const filtered = files.filter((f) => f.toLowerCase().endsWith('.exe') && isExecutableNameAllowed(path.basename(f)));
  if (!filtered.length) return null;

  const stats = await Promise.all(filtered.map(async (file) => {
    const st = await fsp.stat(file);
    return {
      file,
      name: path.basename(file),
      mtimeMs: st.mtimeMs,
      size: st.size,
      version: extractVersionFromText(file)
    };
  }));

  stats.sort((a, b) => {
    const aHasVer = a.version ? 1 : 0;
    const bHasVer = b.version ? 1 : 0;
    if (aHasVer !== bHasVer) return bHasVer - aHasVer;
    if (a.version && b.version) {
      const vCmp = compareVersions(a.version, b.version);
      if (vCmp !== 0) return vCmp;
    }
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.size - a.size;
  });

  return stats[0];
}

function getInstallManifestPath(installDir) {
  return path.join(installDir, INSTALL_MANIFEST_FILE);
}

async function readInstallManifest(installDir) {
  const manifest = await readJson(getInstallManifestPath(installDir), null);
  if (!manifest || manifest.appId !== APP_ID || manifest.productName !== PRODUCT_NAME) return null;
  return manifest;
}

async function writeInstallManifest(installDir, version) {
  await writeJsonAtomic(getInstallManifestPath(installDir), {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    version: version || null,
    installedAt: new Date().toISOString()
  });
}

async function looksLikeExistingProductInstall(installDir) {
  const installedExe = await findLatestExe(installDir);
  return Boolean(installedExe && isLikelyProductExeName(installedExe.name));
}

async function isManagedInstall(installDir) {
  if (await readInstallManifest(installDir)) return true;
  return looksLikeExistingProductInstall(installDir);
}

async function isDirectoryReplaceable(installDir) {
  const entries = await getDirectoryEntries(installDir);
  if (entries === null || entries.length === 0) return true;
  return isManagedInstall(installDir);
}

async function assertInstallDirectoryCanBeReplaced(installDir) {
  if (!(await isDirectoryReplaceable(installDir))) {
    throw new Error('インストール先は空のフォルダ、または PlayPocket が管理しているフォルダを指定してください');
  }
}

async function assertManagedInstallDirectory(installDir) {
  if (!(await existsDir(installDir)) || !(await isManagedInstall(installDir))) {
    throw new Error('このフォルダは PlayPocket Installer で管理されていないため削除できません');
  }
}

function normalizeInstallDir(value, fallback = '') {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!candidate) throw new Error('インストール先を指定してください');
  if (candidate.length > 1024 || candidate.includes('\u0000')) throw new Error('インストール先が正しくありません');

  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new Error('ドライブ直下はインストール先に指定できません');
  }
  return resolved;
}

function isSameOrNested(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function recoverInterruptedInstall(installDir) {
  try {
    if (await existsDir(installDir)) return false;
    const parentDir = path.dirname(installDir);
    const entries = await getDirectoryEntries(parentDir);
    if (!entries) return false;

    const candidates = [];
    for (const entry of entries) {
      if (!entry.startsWith(BACKUP_PREFIX)) continue;
      const full = path.join(parentDir, entry);
      if (!(await existsDir(full)) || !(await isManagedInstall(full))) continue;
      const st = await fsp.stat(full);
      candidates.push({ full, mtimeMs: st.mtimeMs });
    }
    if (candidates.length === 0) return false;

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await fsp.rename(candidates[0].full, installDir);
    return true;
  } catch {
    return false;
  }
}

async function cleanupStaleWorkDirs(parentDir) {
  const entries = await getDirectoryEntries(parentDir);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.startsWith(STAGING_PREFIX) || entry.startsWith(BACKUP_PREFIX)) {
      await removeDirSafe(path.join(parentDir, entry));
    }
  }
}

module.exports = {
  APP_ID,
  PRODUCT_NAME,
  INSTALL_FOLDER_NAME,
  INSTALL_MANIFEST_FILE,
  STAGING_PREFIX,
  BACKUP_PREFIX,
  existsDir,
  ensureDir,
  readJson,
  writeJsonAtomic,
  removeFileSafe,
  removeDirSafe,
  getDirectoryEntries,
  walkFiles,
  extractVersionFromText,
  compareVersions,
  findLatestExe,
  readInstallManifest,
  writeInstallManifest,
  isManagedInstall,
  assertInstallDirectoryCanBeReplaced,
  assertManagedInstallDirectory,
  normalizeInstallDir,
  isSameOrNested,
  recoverInterruptedInstall,
  cleanupStaleWorkDirs
};
