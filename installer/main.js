const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const APP_ID = 'io.github.takkunlego0916.playpocket.installer';
const PRODUCT_NAME = 'PlayPocket';
const INSTALL_FOLDER_NAME = 'PlayPocket';

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Play-Pocket';
const GITHUB_REPO = process.env.GITHUB_REPO || 'PlayPocketRelease';
const GITHUB_ASSET_NAME = process.env.GITHUB_ASSET_NAME || '';
const GITHUB_ASSET_REGEX = process.env.GITHUB_ASSET_REGEX || '^PlayPocket\\.[0-9]+\\.[0-9]+\\.[0-9]+\\.exe$';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_API_VERSION = process.env.GITHUB_API_VERSION || '2026-03-10';
const INSTALL_MANIFEST_FILE = '.playpocket-install.json';
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(APP_ID);
  } catch {}
}

let mainWindow = null;
let state = {
  installDir: ''
};
let activeAction = null;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getUserDataDir() {
  return path.join(app.getPath('userData'), 'installer');
}

function getStatePath() {
  return path.join(getUserDataDir(), 'state.json');
}

function getDefaultInstallDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', INSTALL_FOLDER_NAME);
}

function getDesktopShortcutPath() {
  return path.join(app.getPath('desktop'), `${PRODUCT_NAME}.lnk`);
}

function getStartMenuShortcutDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', PRODUCT_NAME);
}

function getStartMenuShortcutPath() {
  return path.join(getStartMenuShortcutDir(), `${PRODUCT_NAME}.lnk`);
}

function getUninstallShortcutPath() {
  return path.join(getStartMenuShortcutDir(), `${PRODUCT_NAME} アンインストール.lnk`);
}

function getInstallManifestPath(installDir) {
  return path.join(installDir, INSTALL_MANIFEST_FILE);
}

function isMainWindowSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function requireMainWindowSender(event) {
  if (!isMainWindowSender(event)) {
    throw new Error('Unauthorized IPC sender');
  }
}

function getInstallerIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.ico');
  }
  return path.resolve(__dirname, 'build', 'icon.ico');
}

async function getInstallerIconDataUrl() {
  const iconPath = getInstallerIconPath();
  try {
    const buf = await fsp.readFile(iconPath);
    return `data:image/x-icon;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
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

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:progress', payload);
  }
}

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:status', payload);
  }
}

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
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function loadState() {
  const saved = await readJson(getStatePath(), {});
  let installDir = getDefaultInstallDir();
  try {
    installDir = normalizeInstallDir(saved.installDir, installDir);
  } catch {}
  state = {
    installDir
  };
  return state;
}

async function saveState(next = {}) {
  state = {
    ...state,
    ...next
  };
  await writeJson(getStatePath(), state);
  return state;
}

function normalizeInstallDir(value, fallback = '') {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!candidate) {
    throw new Error('インストール先を指定してください');
  }

  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new Error('ドライブ直下はインストール先に指定できません');
  }

  return resolved;
}

async function getDirectoryEntries(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readInstallManifest(installDir) {
  const manifest = await readJson(getInstallManifestPath(installDir), null);
  if (!manifest || manifest.appId !== APP_ID || manifest.productName !== PRODUCT_NAME) {
    return null;
  }
  return manifest;
}

async function assertInstallDirectoryCanBeReplaced(installDir) {
  const entries = await getDirectoryEntries(installDir);
  if (entries === null || entries.length === 0) return;

  const manifest = await readInstallManifest(installDir);
  if (!manifest) {
    throw new Error('インストール先は空のフォルダ、または PlayPocket が管理しているフォルダを指定してください');
  }
}

async function assertManagedInstallDirectory(installDir) {
  if (!(await existsDir(installDir)) || !(await readInstallManifest(installDir))) {
    throw new Error('このフォルダは PlayPocket Installer で管理されていないため削除できません');
  }
}

async function writeInstallManifest(installDir, version) {
  await writeJson(getInstallManifestPath(installDir), {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    version: version || null,
    installedAt: new Date().toISOString()
  });
}

async function walkFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function isExecutableNameAllowed(fileName) {
  const lower = fileName.toLowerCase();
  return !lower.includes('uninstall');
}

async function findLatestExe(dir) {
  if (!dir) return null;
  if (!(await existsDir(dir))) return null;

  const files = await walkFiles(dir);
  const exes = files.filter((f) => f.toLowerCase().endsWith('.exe'));
  const filtered = exes.filter((f) => isExecutableNameAllowed(path.basename(f)));

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

function isSameOrNested(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function createShortcut(shortcutPath, targetPath, workingDir, iconPath, argumentsText = '') {
  await ensureDir(path.dirname(shortcutPath));
  const script = [
    `$w = New-Object -ComObject WScript.Shell`,
    `$s = $w.CreateShortcut(${psQuote(shortcutPath)})`,
    `$s.TargetPath = ${psQuote(targetPath)}`,
    `$s.WorkingDirectory = ${psQuote(workingDir)}`,
    `$s.IconLocation = ${psQuote(`${iconPath},0`)}`,
    argumentsText ? `$s.Arguments = ${psQuote(argumentsText)}` : null,
    `$s.Save()`
  ].filter(Boolean).join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true
  });
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

function getGitHubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'PlayPocket-Installer'
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return headers;
}

function isGitHubConfigured() {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(GITHUB_OWNER) &&
    /^[A-Za-z0-9_.-]+$/.test(GITHUB_REPO) &&
    GITHUB_OWNER !== 'YOUR_OWNER' &&
    GITHUB_REPO !== 'YOUR_REPO';
}

function isReleaseAssetAllowed(asset) {
  if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') return false;
  if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_RELEASE_ASSET_BYTES) return false;
  if (path.basename(asset.name) !== asset.name || /[\\/]/.test(asset.name)) return false;
  return /\.(exe|zip)$/i.test(asset.name);
}

function selectReleaseAsset(assets) {
  if (!Array.isArray(assets) || !assets.length) return null;
  const candidates = assets.filter(isReleaseAssetAllowed);
  if (!candidates.length) return null;

  if (GITHUB_ASSET_NAME) {
    const exact = candidates.find((asset) => asset.name === GITHUB_ASSET_NAME);
    if (exact) return exact;
  }

  if (GITHUB_ASSET_REGEX) {
    try {
      const regex = new RegExp(GITHUB_ASSET_REGEX, 'i');
      const matched = candidates.find((asset) => regex.test(asset.name));
      if (matched) return matched;
    } catch {}
  }

  const exeAsset = candidates.find((asset) => asset.name.toLowerCase().endsWith('.exe'));
  if (exeAsset) return exeAsset;

  const zipAsset = candidates.find((asset) => asset.name.toLowerCase().endsWith('.zip'));
  if (zipAsset) return zipAsset;

  return null;
}

function getReleaseVersion(release, asset) {
  return (
    extractVersionFromText(release?.tag_name) ||
    extractVersionFromText(release?.name) ||
    extractVersionFromText(asset?.name) ||
    null
  );
}

async function fetchLatestRelease() {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub Releases の設定がありません');
  }

  const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
    headers: getGitHubHeaders()
  });

  if (!response.ok) {
    throw new Error(`GitHub API エラー: ${response.status} ${response.statusText}`);
  }

  const release = await response.json();
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) {
    throw new Error('利用可能な安定版リリースが見つかりません');
  }
  return release;
}

function assertTrustedReleaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('無効なリリースダウンロード URL です');
  }

  const trustedHost = parsed.hostname === 'github.com' || parsed.hostname.endsWith('.githubusercontent.com');
  if (parsed.protocol !== 'https:' || !trustedHost || parsed.username || parsed.password) {
    throw new Error('信頼できないリリースダウンロード URL です');
  }
}

function parseSha256Digest(digest) {
  const match = typeof digest === 'string' && digest.match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) {
    throw new Error('リリースアセットに SHA-256 ダイジェストがありません');
  }
  return match[1].toLowerCase();
}

async function downloadToFile(url, destPath, expectedSize, expectedDigest, onProgress) {
  assertTrustedReleaseUrl(url);
  const response = await fetch(url, {
    headers: {
      ...getGitHubHeaders(),
      Accept: 'application/octet-stream'
    }
  });

  if (!response.ok) {
    throw new Error(`ダウンロード失敗: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('ダウンロードデータを取得できませんでした');
  }

  assertTrustedReleaseUrl(response.url);
  const total = Number(response.headers.get('content-length') || 0);
  if (total > 0 && total !== expectedSize) {
    throw new Error('ダウンロードサイズがリリース情報と一致しません');
  }

  let received = 0;
  const hash = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      received += buffer.length;
      hash.update(buffer);
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'download',
          percent: expectedSize > 0 ? Math.min(100, Math.round((received / expectedSize) * 100)) : null,
          loaded: received,
          total: expectedSize
        });
      }
      callback(null, buffer);
    }
  });

  await ensureDir(path.dirname(destPath));

  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destPath, { flags: 'wx' }));
  } catch (error) {
    await removeFileSafe(destPath);
    throw error;
  }

  if (received !== expectedSize) {
    await removeFileSafe(destPath);
    throw new Error('ダウンロードサイズがリリース情報と一致しません');
  }
  if (hash.digest('hex').toLowerCase() !== expectedDigest) {
    await removeFileSafe(destPath);
    throw new Error('ダウンロードしたファイルの SHA-256 検証に失敗しました');
  }
}

async function expandZip(zipPath, destDir) {
  await ensureDir(destDir);
  const script = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true
  });
}

function getCacheRoot() {
  return path.join(getUserDataDir(), 'github-cache');
}

function safeSegment(text) {
  return String(text || 'unknown')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function prepareGithubSource() {
  const release = await fetchLatestRelease();
  const asset = selectReleaseAsset(release.assets || []);
  if (!asset) {
    throw new Error('GitHub Releases に使えるアセットが見つかりません');
  }

  const version = getReleaseVersion(release, asset);
  const workDir = path.join(getCacheRoot(), safeSegment(release.tag_name || release.id || 'latest'));
  await removeDirSafe(workDir);
  await ensureDir(workDir);

  const downloadedPath = path.join(workDir, asset.name);
  const expectedDigest = parseSha256Digest(asset.digest);
  sendProgress({
    phase: 'download',
    percent: 0,
    title: 'ダウンロード中...',
    detail: asset.name
  });

  await downloadToFile(asset.browser_download_url, downloadedPath, asset.size, expectedDigest, (info) => {
    sendProgress({
      phase: 'download',
      percent: info.percent,
      title: 'ダウンロード中...',
      detail: asset.name
    });
  });

  let sourceDir = workDir;
  if (asset.name.toLowerCase().endsWith('.zip')) {
    sendProgress({
      phase: 'extract',
      percent: 100,
      title: '展開中...',
      detail: asset.name
    });
    const extractedDir = path.join(workDir, 'extracted');
    await removeDirSafe(extractedDir);
    await expandZip(downloadedPath, extractedDir);
    sourceDir = extractedDir;
  }

  return {
    release,
    asset,
    version,
    sourceDir
  };
}

async function copyReleaseToInstall(sourceDir, installDir, version) {
  const sourceStat = await fsp.stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    throw new Error('sourceDir is not a directory');
  }

  const resolvedSource = path.resolve(sourceDir);
  const resolvedInstall = path.resolve(installDir);

  if (isSameOrNested(resolvedSource, resolvedInstall)) {
    throw new Error('installDir must not be inside sourceDir');
  }

  sendProgress({
    phase: 'copy',
    percent: 100,
    title: 'インストール中...',
    detail: 'ファイルを配置しています'
  });

  await assertInstallDirectoryCanBeReplaced(installDir);
  const parentDir = path.dirname(resolvedInstall);
  const operationId = crypto.randomUUID();
  const stagingDir = path.join(parentDir, `.${INSTALL_FOLDER_NAME}-staging-${operationId}`);
  const backupDir = path.join(parentDir, `.${INSTALL_FOLDER_NAME}-backup-${operationId}`);
  const installExists = await existsDir(installDir);

  await ensureDir(parentDir);
  try {
    await fsp.cp(sourceDir, stagingDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    });
    await writeInstallManifest(stagingDir, version);
    if (installExists) {
      await fsp.rename(installDir, backupDir);
    }
    await fsp.rename(stagingDir, installDir);
  } catch (error) {
    if (installExists && !(await existsDir(installDir)) && await existsDir(backupDir)) {
      await fsp.rename(backupDir, installDir).catch(() => {});
    }
    throw error;
  } finally {
    await removeDirSafe(stagingDir);
  }
  await removeDirSafe(backupDir);
}

async function getInstalledExe(installDir) {
  return findLatestExe(installDir);
}

async function syncShortcuts(installDir) {
  const installedExe = await getInstalledExe(installDir);
  if (!installedExe) return;

  const targetPath = installedExe.file;
  const workingDir = path.dirname(targetPath);
  const iconPath = targetPath;

  sendProgress({
    phase: 'shortcut',
    percent: 100,
    title: 'ショートカット作成中...',
    detail: 'デスクトップとスタートメニューを更新しています'
  });

  await createShortcut(getDesktopShortcutPath(), targetPath, workingDir, iconPath);
  await createShortcut(getStartMenuShortcutPath(), targetPath, workingDir, iconPath);
  await createShortcut(
    getUninstallShortcutPath(),
    process.execPath,
    path.dirname(process.execPath),
    getInstallerIconPath(),
    '--uninstall'
  );
}

async function removeShortcuts() {
  await removeFileSafe(getDesktopShortcutPath());
  await removeFileSafe(getStartMenuShortcutPath());
  await removeFileSafe(getUninstallShortcutPath());
  await removeDirSafe(getStartMenuShortcutDir());
}

async function buildStatus() {
  const installDir = state.installDir || getDefaultInstallDir();
  const installedLatest = await getInstalledExe(installDir);

  return {
    installDir,
    installExists: await existsDir(installDir),
    installedExe: installedLatest ? installedLatest.file : null,
    installedName: installedLatest ? installedLatest.name : null,
    installedVersion: installedLatest ? installedLatest.version : null,
    installedTime: installedLatest ? installedLatest.mtimeMs : null,
    installedSize: installedLatest ? installedLatest.size : null
  };
}

async function performInstallLike(action, payload = {}) {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub_OWNER と GITHUB_REPO を設定してください');
  }

  const installDir = normalizeInstallDir(payload?.installDir, state.installDir || getDefaultInstallDir());
  await assertInstallDirectoryCanBeReplaced(installDir);
  await saveState({ installDir });

  const source = await prepareGithubSource();
  const latest = await findLatestExe(source.sourceDir);
  if (!latest) {
    throw new Error('ダウンロードしたアセット内に exe が見つかりません');
  }

  sendProgress({
    phase: 'install',
    percent: 100,
    title: 'インストール中...',
    detail: latest.name
  });

  await copyReleaseToInstall(source.sourceDir, installDir, source.version);
  await syncShortcuts(installDir);

  return {
    action,
    message:
      action === 'repair' ? '修復が完了しました' :
      action === 'update' ? 'アップデートが完了しました' :
      'インストールが完了しました'
  };
}

async function performUpdate(payload = {}) {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub_OWNER と GITHUB_REPO を設定してください');
  }

  const installDir = normalizeInstallDir(payload?.installDir, state.installDir || getDefaultInstallDir());
  await assertInstallDirectoryCanBeReplaced(installDir);
  await saveState({ installDir });

  const release = await fetchLatestRelease();
  const asset = selectReleaseAsset(release.assets || []);
  if (!asset) {
    throw new Error('GitHub Releases に使えるアセットが見つかりません');
  }

  const sourceVersion = getReleaseVersion(release, asset);
  const installedLatest = await getInstalledExe(installDir);

  if (installedLatest && sourceVersion && installedLatest.version) {
    if (compareVersions(installedLatest.version, sourceVersion) <= 0) {
      return { action: 'update', message: 'すでに最新です' };
    }
  }

  const source = await prepareGithubSource();
  const latest = await findLatestExe(source.sourceDir);
  if (!latest) {
    throw new Error('ダウンロードしたアセット内に exe が見つかりません');
  }

  await copyReleaseToInstall(source.sourceDir, installDir, source.version);
  await syncShortcuts(installDir);

  return { action: 'update', message: 'アップデートが完了しました' };
}

async function performUninstall(payload = {}) {
  const installDir = normalizeInstallDir(payload?.installDir, state.installDir || getDefaultInstallDir());
  await assertManagedInstallDirectory(installDir);

  sendProgress({
    phase: 'uninstall',
    percent: 100,
    title: 'アンインストール中...',
    detail: 'ショートカットとフォルダを削除しています'
  });

  await removeShortcuts();
  await removeDirSafe(installDir);
  await saveState({ installDir });

  return { action: 'uninstall', message: 'アンインストールが完了しました' };
}

async function chooseInstallDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'インストール先を選択',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 840,
    height: 560,
    minWidth: 760,
    minHeight: 520,
    autoHideMenuBar: true,
    title: 'PlayPocket Installer',
    backgroundColor: '#0b1020',
    icon: getInstallerIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function runInstallerAction(action, callback) {
  if (activeAction) {
    throw new Error(`${activeAction} の処理中です`);
  }
  activeAction = action;
  try {
    return await callback();
  } finally {
    activeAction = null;
  }
}

ipcMain.handle('installer:get-status', async (event) => {
  requireMainWindowSender(event);
  return buildStatus();
});

ipcMain.handle('installer:get-icon-path', async (event) => {
  requireMainWindowSender(event);
  return getInstallerIconDataUrl();
});

ipcMain.handle('installer:choose-install-dir', async (event) => {
  requireMainWindowSender(event);
  return chooseInstallDir();
});

ipcMain.handle('installer:set-install-dir', async (event, installDir) => {
  requireMainWindowSender(event);
  await saveState({ installDir: normalizeInstallDir(installDir) });
  return true;
});

ipcMain.handle('installer:install', async (event, payload) => {
  requireMainWindowSender(event);
  return runInstallerAction('インストール', () => performInstallLike('install', payload));
});
ipcMain.handle('installer:repair', async (event, payload) => {
  requireMainWindowSender(event);
  return runInstallerAction('修復', () => performInstallLike('repair', payload));
});
ipcMain.handle('installer:update', async (event, payload) => {
  requireMainWindowSender(event);
  return runInstallerAction('アップデート', () => performUpdate(payload));
});
ipcMain.handle('installer:uninstall', async (event, payload) => {
  requireMainWindowSender(event);
  return runInstallerAction('アンインストール', () => performUninstall(payload));
});
ipcMain.handle('installer:open-install-dir', async (event, installDir) => {
  requireMainWindowSender(event);
  const normalizedDir = normalizeInstallDir(installDir, state.installDir || getDefaultInstallDir());
  if (!(await existsDir(normalizedDir))) {
    throw new Error('インストール先フォルダが見つかりません');
  }
  const errorMessage = await shell.openPath(normalizedDir);
  if (errorMessage) throw new Error(errorMessage);
  return true;
});

app.whenReady().then(async () => {
  await loadState();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
