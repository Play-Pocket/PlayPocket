const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('original-fs');
const fsp = fs.promises;
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const InstallFs = require('./lib/install-fs.js');

const {
  APP_ID,
  PRODUCT_NAME,
  INSTALL_FOLDER_NAME,
  STAGING_PREFIX,
  BACKUP_PREFIX,
  sleep,
  isLockError,
  renameWithRetry,
  existsDir,
  ensureDir,
  readJson,
  writeJsonAtomic,
  removeFileSafe,
  removeDirSafe,
  extractVersionFromText,
  compareVersions,
  formatBytes,
  formatDuration,
  assertEnoughDiskSpace,
  findLatestExe,
  readInstallManifest,
  writeInstallManifest,
  assertInstallDirectoryCanBeReplaced,
  assertManagedInstallDirectory,
  normalizeInstallDir,
  isSameOrNested,
  recoverInterruptedInstall,
  cleanupStaleWorkDirs
} = InstallFs;

const execFileAsync = promisify(execFile);

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Play-Pocket';
const GITHUB_REPO = process.env.GITHUB_REPO || 'PlayPocketRelease';
const GITHUB_ASSET_NAME = process.env.GITHUB_ASSET_NAME || '';
const GITHUB_ASSET_REGEX = process.env.GITHUB_ASSET_REGEX || '^PlayPocket[. ][0-9]+\\.[0-9]+\\.[0-9]+\\.(zip|exe)$';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_API_VERSION = process.env.GITHUB_API_VERSION || '2026-03-10';
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const API_TIMEOUT_MS = 30000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const BLOCKED_REQUEST_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'];

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
let activeDownload = null;
let cancelRequested = false;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const LOCKED_MESSAGE = 'PlayPocket のフォルダが他のプログラムに使用されているため置き換えできません。PlayPocket を完全に終了し、エクスプローラーや他のアプリでインストール先を開いていないか確認してから、もう一度お試しください';

async function findRunningProcesses(installDir) {
  if (process.platform !== 'win32') return [];
  const prefix = installDir.endsWith(path.sep) ? installDir : `${installDir}${path.sep}`;
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$prefix = ${psQuote(prefix)}`,
    '$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId, Name)',
    'if ($items.Count -gt 0) { ConvertTo-Json -InputObject $items -Compress }'
  ].join('; ');

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item) => item && Number.isInteger(item.ProcessId) && item.ProcessId !== process.pid)
      .map((item) => ({ pid: item.ProcessId, name: String(item.Name || '') }));
  } catch {
    return [];
  }
}

async function waitForProcessesExit(installDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const running = await findRunningProcesses(installDir);
    if (running.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

async function runTaskkill(pid, force) {
  const args = ['/PID', String(pid)];
  if (force) args.push('/T', '/F');
  try {
    await execFileAsync('taskkill', args, { windowsHide: true });
  } catch {}
}

async function stopProcesses(installDir, processes) {
  for (const item of processes) {
    await runTaskkill(item.pid, false);
  }
  if (await waitForProcessesExit(installDir, 6000)) {
    await sleep(500);
    return;
  }

  const remaining = await findRunningProcesses(installDir);
  for (const item of remaining) {
    await runTaskkill(item.pid, true);
  }
  if (!(await waitForProcessesExit(installDir, 8000))) {
    throw new Error('PlayPocket を終了できませんでした。手動で終了してから、もう一度お試しください');
  }
  await sleep(500);
}

async function ensureInstallDirUnlocked(installDir) {
  if (!(await existsDir(installDir))) return;

  const running = await findRunningProcesses(installDir);
  if (running.length === 0) return;

  const names = [...new Set(running.map((item) => item.name).filter(Boolean))].join('、');
  const options = {
    type: 'question',
    buttons: ['終了して続行', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'PlayPocket Installer',
    message: 'PlayPocket が実行中です。',
    detail: `続行するには、次のプロセスを終了する必要があります。\n\n${names}\n\n保存していない作業がある場合は、先に PlayPocket 側で保存してください。`
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (result.response !== 0) {
    throw new Error('PlayPocket が実行中のため、処理を中止しました');
  }

  sendProgress({
    phase: 'close',
    percent: null,
    title: 'PlayPocket を終了しています...',
    detail: names
  });
  await stopProcesses(installDir, running);
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

function getPersistedInstallerDir(installDir) {
  return path.join(path.dirname(installDir), 'PlayPocket-Installer');
}

function getInstallerSourcePath() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (typeof portable === 'string' && portable && path.isAbsolute(portable)) {
    try {
      if (fs.statSync(portable).isFile()) return portable;
    } catch {}
  }
  return process.execPath;
}

function getPersistedInstallerPath(installDir) {
  return path.join(getPersistedInstallerDir(installDir), path.basename(getInstallerSourcePath()));
}

async function persistInstallerExecutable(installDir) {
  const sourcePath = getInstallerSourcePath();
  if (!app.isPackaged) return sourcePath;

  const persistPath = getPersistedInstallerPath(installDir);
  if (path.resolve(persistPath).toLowerCase() === path.resolve(sourcePath).toLowerCase()) {
    return sourcePath;
  }

  try {
    const currentStat = await fsp.stat(sourcePath);
    let upToDate = false;
    try {
      const existingStat = await fsp.stat(persistPath);
      upToDate = existingStat.size === currentStat.size;
    } catch {}

    if (!upToDate) {
      await ensureDir(path.dirname(persistPath));
      const tempPath = `${persistPath}.tmp-${crypto.randomUUID()}`;
      await fsp.copyFile(sourcePath, tempPath);
      await removeFileSafe(persistPath);
      await fsp.rename(tempPath, persistPath);
    }

    return persistPath;
  } catch {
    return sourcePath;
  }
}

function scheduleSelfCleanup(installDir) {
  const persistedDir = getPersistedInstallerDir(installDir);
  const sourcePath = path.resolve(getInstallerSourcePath()).toLowerCase();
  if (!sourcePath.startsWith(`${path.resolve(persistedDir).toLowerCase()}${path.sep}`)) return;
  const script = `Start-Sleep -Seconds 6; Remove-Item -LiteralPath ${psQuote(persistedDir)} -Recurse -Force -ErrorAction SilentlyContinue`;
  app.once('quit', () => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch {}
  });
}

function shouldAutoUninstall() {
  return process.argv.includes('--uninstall');
}

function isMainWindowSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = mainWindow.webContents;
  if (event.sender !== contents) return false;
  const frame = event.senderFrame;
  return Boolean(frame) && frame === contents.mainFrame && typeof frame.url === 'string' && frame.url.startsWith('file:');
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

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:progress', payload);
  }
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
  await writeJsonAtomic(getStatePath(), state);
  return state;
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

  const zipAsset = candidates.find((asset) => asset.name.toLowerCase().endsWith('.zip'));
  if (zipAsset) return zipAsset;

  const exeAsset = candidates.find((asset) => asset.name.toLowerCase().endsWith('.exe'));
  if (exeAsset) return exeAsset;

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

function isAbortLike(error) {
  return Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function fetchLatestRelease() {
  if (!isGitHubConfigured()) {
    throw new Error('GitHub Releases の設定がありません');
  }

  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
      headers: getGitHubHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(isAbortLike(error)
      ? 'GitHub に接続できませんでした（タイムアウト）。ネットワーク接続を確認してください'
      : 'GitHub に接続できませんでした。ネットワーク接続を確認してください');
  }

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

  const controller = new AbortController();
  activeDownload = controller;
  let idleTimer = null;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const timeoutError = () => new Error('ダウンロードがタイムアウトしました。ネットワーク接続を確認してください');
  const abortError = () => (cancelRequested ? new Error('ダウンロードをキャンセルしました') : timeoutError());

  armIdleTimer();
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          ...getGitHubHeaders(),
          Accept: 'application/octet-stream'
        },
        signal: controller.signal
      });
    } catch (error) {
      throw isAbortLike(error) ? abortError() : new Error('ダウンロードに失敗しました。ネットワーク接続を確認してください');
    }

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
    let lastEmit = 0;
    const startedAt = Date.now();
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        received += buffer.length;
        if (received > expectedSize) {
          callback(new Error('ダウンロードサイズがリリース情報と一致しません'));
          return;
        }
        armIdleTimer();
        hash.update(buffer);
        const now = Date.now();
        if (typeof onProgress === 'function' && (now - lastEmit >= 120 || received === expectedSize)) {
          lastEmit = now;
          const elapsed = Math.max((now - startedAt) / 1000, 0.001);
          const speed = received / elapsed;
          onProgress({
            phase: 'download',
            percent: expectedSize > 0 ? Math.min(100, Math.round((received / expectedSize) * 100)) : null,
            loaded: received,
            total: expectedSize,
            speed,
            eta: speed > 0 ? (expectedSize - received) / speed : null
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
      throw isAbortLike(error) || controller.signal.aborted ? abortError() : error;
    }

    if (received !== expectedSize) {
      await removeFileSafe(destPath);
      throw new Error('ダウンロードサイズがリリース情報と一致しません');
    }
    if (hash.digest('hex').toLowerCase() !== expectedDigest) {
      await removeFileSafe(destPath);
      throw new Error('ダウンロードしたファイルの SHA-256 検証に失敗しました');
    }
  } finally {
    clearTimeout(idleTimer);
    if (activeDownload === controller) activeDownload = null;
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

async function prepareGithubSource(installDir) {
  const release = await fetchLatestRelease();
  const asset = selectReleaseAsset(release.assets || []);
  if (!asset) {
    throw new Error('GitHub Releases に使えるアセットが見つかりません');
  }

  const requiredBytes = asset.size * 3;
  await assertEnoughDiskSpace(getCacheRoot(), requiredBytes, 'ダウンロード用ドライブ');
  if (installDir) {
    await assertEnoughDiskSpace(path.dirname(installDir), requiredBytes, 'インストール先ドライブ');
  }

  const version = getReleaseVersion(release, asset);
  const workDir = path.join(getCacheRoot(), safeSegment(release.tag_name || release.id || 'latest'));
  await removeDirSafe(workDir);
  await ensureDir(workDir);

  try {
    const downloadedPath = path.join(workDir, asset.name);
    const expectedDigest = parseSha256Digest(asset.digest);
    sendProgress({
      phase: 'download',
      percent: 0,
      title: 'ダウンロード中...',
      detail: `${asset.name}（${formatBytes(asset.size)}）`,
      cancellable: true
    });

    await downloadToFile(asset.browser_download_url, downloadedPath, asset.size, expectedDigest, (info) => {
      const eta = Number.isFinite(info.eta) ? `・残り約 ${formatDuration(info.eta)}` : '';
      sendProgress({
        phase: 'download',
        percent: info.percent,
        title: 'ダウンロード中...',
        detail: `${formatBytes(info.loaded)} / ${formatBytes(info.total)}・${formatBytes(info.speed)}/秒${eta}`,
        cancellable: true
      });
    });

    let sourceDir = workDir;
    if (asset.name.toLowerCase().endsWith('.zip')) {
      sendProgress({
        phase: 'extract',
        percent: null,
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
      workDir,
      sourceDir
    };
  } catch (error) {
    await removeDirSafe(workDir);
    throw error;
  }
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

  const parentDir = path.dirname(resolvedInstall);
  await recoverInterruptedInstall(resolvedInstall);
  await assertInstallDirectoryCanBeReplaced(installDir);
  await cleanupStaleWorkDirs(parentDir);
  const operationId = crypto.randomUUID();
  const stagingDir = path.join(parentDir, `${STAGING_PREFIX}${operationId}`);
  const backupDir = path.join(parentDir, `${BACKUP_PREFIX}${operationId}`);
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
      await ensureInstallDirUnlocked(resolvedInstall);
      try {
        await renameWithRetry(installDir, backupDir);
      } catch (error) {
        throw isLockError(error) ? new Error(LOCKED_MESSAGE) : error;
      }
    }
    try {
      await renameWithRetry(stagingDir, installDir);
    } catch (error) {
      throw isLockError(error) ? new Error(LOCKED_MESSAGE) : error;
    }
  } catch (error) {
    if (installExists && !(await existsDir(installDir)) && await existsDir(backupDir)) {
      await renameWithRetry(backupDir, installDir).catch(() => {});
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

async function getInstalledVersion(installDir, installedExe) {
  const manifest = await readInstallManifest(installDir);
  if (manifest?.version) return manifest.version;
  return installedExe?.version || null;
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

  const uninstallerExePath = await persistInstallerExecutable(installDir);

  await createShortcut(getDesktopShortcutPath(), targetPath, workingDir, iconPath);
  await createShortcut(getStartMenuShortcutPath(), targetPath, workingDir, iconPath);
  await createShortcut(
    getUninstallShortcutPath(),
    uninstallerExePath,
    path.dirname(uninstallerExePath),
    getInstallerIconPath(),
    '--uninstall'
  );
}

async function removeShortcuts(installDir) {
  await removeFileSafe(getDesktopShortcutPath());
  await removeFileSafe(getStartMenuShortcutPath());
  await removeFileSafe(getUninstallShortcutPath());
  await removeDirSafe(getStartMenuShortcutDir());
  if (installDir) {
    await removeDirSafe(getPersistedInstallerDir(installDir));
  }
}

async function buildStatus() {
  const installDir = state.installDir || getDefaultInstallDir();
  const installedLatest = await getInstalledExe(installDir);
  const installedVersion = await getInstalledVersion(installDir, installedLatest);

  return {
    installDir,
    installExists: await existsDir(installDir),
    installedExe: installedLatest ? installedLatest.file : null,
    installedName: installedLatest ? installedLatest.name : null,
    installedVersion,
    installedTime: installedLatest ? installedLatest.mtimeMs : null,
    installedSize: installedLatest ? installedLatest.size : null
  };
}

async function performInstallLike(action, payload = {}) {
  if (!isGitHubConfigured()) {
    throw new Error('GITHUB_OWNER と GITHUB_REPO を設定してください');
  }

  const installDir = normalizeInstallDir(payload?.installDir, state.installDir || getDefaultInstallDir());
  await assertInstallDirectoryCanBeReplaced(installDir);
  await saveState({ installDir });

  const source = await prepareGithubSource(installDir);
  try {
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
  } finally {
    await removeDirSafe(source.workDir);
  }

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
    throw new Error('GITHUB_OWNER と GITHUB_REPO を設定してください');
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
  const installedVersion = await getInstalledVersion(installDir, installedLatest);

  if (installedLatest && sourceVersion && installedVersion) {
    if (compareVersions(installedVersion, sourceVersion) <= 0) {
      return { action: 'update', message: 'すでに最新です' };
    }
  }

  const source = await prepareGithubSource(installDir);
  try {
    const latest = await findLatestExe(source.sourceDir);
    if (!latest) {
      throw new Error('ダウンロードしたアセット内に exe が見つかりません');
    }

    await copyReleaseToInstall(source.sourceDir, installDir, source.version);
    await syncShortcuts(installDir);
  } finally {
    await removeDirSafe(source.workDir);
  }

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

  await ensureInstallDirUnlocked(installDir);
  await removeDirSafe(installDir);
  if (await existsDir(installDir)) {
    throw new Error(LOCKED_MESSAGE);
  }
  await removeShortcuts(installDir);
  scheduleSelfCleanup(installDir);
  await saveState({ installDir });

  return { action: 'uninstall', message: 'アンインストールが完了しました' };
}

async function checkLatestVersion() {
  if (!isGitHubConfigured()) {
    return { ok: false, message: 'GitHub Releases の設定がありません' };
  }
  try {
    const release = await fetchLatestRelease();
    const asset = selectReleaseAsset(release.assets || []);
    if (!asset) {
      return { ok: false, message: 'GitHub Releases に使えるアセットが見つかりません' };
    }
    const latestVersion = getReleaseVersion(release, asset);
    const installDir = state.installDir || getDefaultInstallDir();
    const installedExe = await getInstalledExe(installDir);
    const installedVersion = await getInstalledVersion(installDir, installedExe);
    const updateAvailable = Boolean(
      latestVersion && (!installedExe || !installedVersion || compareVersions(installedVersion, latestVersion) > 0)
    );
    return {
      ok: true,
      latestVersion,
      assetName: asset.name,
      assetSize: asset.size,
      publishedAt: release.published_at || null,
      installedVersion,
      installed: Boolean(installedExe),
      updateAvailable
    };
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : '最新バージョンを確認できませんでした' };
  }
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
    width: 860,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    autoHideMenuBar: true,
    title: 'PlayPocket Installer',
    backgroundColor: '#0b1020',
    icon: getInstallerIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!activeAction || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['続ける', '終了する'],
      defaultId: 0,
      cancelId: 0,
      title: 'PlayPocket Installer',
      message: `${activeAction}の処理中です。`,
      detail: '今終了すると処理が中断されます。次回の起動時に、可能な範囲で元の状態へ自動的に復旧します。'
    });
    if (choice === 0) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function runInstallerAction(action, callback) {
  if (activeAction) {
    throw new Error(`${activeAction} の処理中です`);
  }
  activeAction = action;
  cancelRequested = false;
  try {
    return await callback();
  } finally {
    activeAction = null;
    activeDownload = null;
    cancelRequested = false;
  }
}

ipcMain.handle('installer:get-version', (event) => {
  requireMainWindowSender(event);
  return app.getVersion();
});

ipcMain.handle('installer:get-status', async (event) => {
  requireMainWindowSender(event);
  return buildStatus();
});

ipcMain.handle('installer:get-launch-intent', (event) => {
  requireMainWindowSender(event);
  return { autoUninstall: shouldAutoUninstall() };
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
ipcMain.handle('installer:check-latest', async (event) => {
  requireMainWindowSender(event);
  return checkLatestVersion();
});
ipcMain.handle('installer:cancel', async (event) => {
  requireMainWindowSender(event);
  if (!activeDownload) return false;
  cancelRequested = true;
  activeDownload.abort();
  return true;
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

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (navEvent) => navEvent.preventDefault());
  contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
});

app.whenReady().then(async () => {
  await loadState();
  await recoverInterruptedInstall(state.installDir);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: BLOCKED_REQUEST_URLS }, (_details, callback) => callback({ cancel: true }));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
