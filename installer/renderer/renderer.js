const installDirEl = document.getElementById('installDir');
const statusTextEl = document.getElementById('statusText');
const heroIconEl = document.getElementById('heroIcon');

const progressTitleEl = document.getElementById('progressTitle');
const progressPercentEl = document.getElementById('progressPercent');
const progressDetailEl = document.getElementById('progressDetail');
const progressBarEl = document.getElementById('progressBar');

const installBtn = document.getElementById('installBtn');
const repairBtn = document.getElementById('repairBtn');
const updateBtn = document.getElementById('updateBtn');
const uninstallBtn = document.getElementById('uninstallBtn');
const browseInstallBtn = document.getElementById('browseInstall');
const openInstallBtn = document.getElementById('openInstall');
const versionEl = document.getElementById('installerVersion');
const installedVersionEl = document.getElementById('installedVersion');
const latestVersionEl = document.getElementById('latestVersion');
const installedTimeEl = document.getElementById('installedTime');
const installedSizeEl = document.getElementById('installedSize');
const updateBadgeEl = document.getElementById('updateBadge');
const checkLatestBtn = document.getElementById('checkLatestBtn');
const cancelBtn = document.getElementById('cancelBtn');

let busy = false;
let checking = false;

function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '--';
  return new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function setBadge(text, kind) {
  if (!text) {
    updateBadgeEl.hidden = true;
    updateBadgeEl.textContent = '';
    updateBadgeEl.className = 'update-badge';
    return;
  }
  updateBadgeEl.hidden = false;
  updateBadgeEl.textContent = text;
  updateBadgeEl.className = `update-badge${kind ? ` ${kind}` : ''}`;
}

function messageOf(error) {
  const raw = error && error.message ? String(error.message) : String(error || '');
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function setBusy(nextBusy) {
  busy = nextBusy;
  const buttons = [
    installBtn,
    repairBtn,
    updateBtn,
    uninstallBtn,
    browseInstallBtn,
    openInstallBtn,
    checkLatestBtn
  ];

  for (const button of buttons) {
    button.disabled = nextBusy || (button === checkLatestBtn && checking);
  }
  installDirEl.disabled = nextBusy;
  if (!nextBusy) cancelBtn.hidden = true;
}

function setProgress(payload = {}) {
  const percent = typeof payload.percent === 'number' && Number.isFinite(payload.percent)
    ? Math.max(0, Math.min(100, payload.percent))
    : null;

  progressTitleEl.textContent = payload.title || '待機中';
  progressDetailEl.textContent = payload.detail || '';
  cancelBtn.hidden = !(busy && payload.cancellable === true);
  cancelBtn.disabled = false;

  if (percent === null) {
    progressPercentEl.textContent = '--%';
    progressBarEl.style.width = '18%';
    progressBarEl.classList.add('indeterminate');
  } else {
    progressPercentEl.textContent = `${percent}%`;
    progressBarEl.style.width = `${percent}%`;
    progressBarEl.classList.remove('indeterminate');
  }
}

function setStatus(status) {
  installDirEl.value = status.installDir || '';
  const hasExe = Boolean(status.installedExe);
  if (hasExe) {
    statusTextEl.textContent = status.installedVersion ? `インストール済み v${status.installedVersion}` : 'インストール済み';
  } else {
    statusTextEl.textContent = status.installExists ? 'フォルダー作成済み' : '未インストール';
  }
  installedVersionEl.textContent = hasExe && status.installedVersion ? `v${status.installedVersion}` : (hasExe ? '不明' : '未インストール');
  installedTimeEl.textContent = hasExe ? formatTime(status.installedTime) : '--';
  installedSizeEl.textContent = hasExe ? formatSize(status.installedSize) : '--';
}

function applyLatest(info) {
  installBtn.classList.remove('btn-attention');
  updateBtn.classList.remove('btn-attention');
  if (!info || info.ok !== true) {
    latestVersionEl.textContent = '--';
    setBadge(info && info.message ? `確認失敗: ${info.message}` : '', 'error');
    return;
  }
  latestVersionEl.textContent = info.latestVersion ? `v${info.latestVersion}` : '不明';
  if (!info.installed) {
    setBadge(info.assetSize ? `インストールできます（${formatSize(info.assetSize)}）` : 'インストールできます', 'available');
    installBtn.classList.add('btn-attention');
  } else if (info.updateAvailable) {
    setBadge(`新しいバージョン v${info.latestVersion} を利用できます`, 'available');
    updateBtn.classList.add('btn-attention');
  } else {
    setBadge('最新です', '');
  }
}

async function checkLatest(silent) {
  if (checking) return;
  checking = true;
  checkLatestBtn.disabled = true;
  checkLatestBtn.textContent = '確認中...';
  try {
    applyLatest(await window.installer.checkLatest());
  } catch (error) {
    if (!silent) setBadge(`確認失敗: ${messageOf(error)}`, 'error');
  } finally {
    checking = false;
    checkLatestBtn.textContent = '最新版を確認';
    checkLatestBtn.disabled = busy;
  }
}

async function setIcon() {
  try {
    const iconUrl = await window.installer.getIconPath();
    if (iconUrl) {
      heroIconEl.src = iconUrl;
    }
  } catch {}
}

async function setVersion() {
  try {
    const version = await window.installer.getVersion();
    if (versionEl && typeof version === 'string' && version) {
      versionEl.textContent = `PlayPocket Installer v${version}`;
    }
  } catch {}
}

async function refresh() {
  try {
    const status = await window.installer.getStatus();
    setStatus(status);
  } catch (error) {
    statusTextEl.textContent = `取得失敗: ${messageOf(error)}`;
  }
}

async function runAction(action) {
  if (busy) return;
  setBusy(true);
  setProgress({
    phase: 'start',
    percent: 0,
    title: '準備中...',
    detail: '処理を開始しています'
  });

  try {
    const payload = {
      installDir: installDirEl.value.trim()
    };

    let result = null;

    if (action === 'install') {
      result = await window.installer.install(payload);
    } else if (action === 'repair') {
      result = await window.installer.repair(payload);
    } else if (action === 'update') {
      result = await window.installer.update(payload);
    } else if (action === 'uninstall') {
      const ok = confirm('PlayPocket をアンインストールしますか？');
      if (!ok) {
        setProgress({
          percent: 0,
          title: 'キャンセルしました',
          detail: 'アンインストールを中止しました'
        });
        return;
      }
      result = await window.installer.uninstall(payload);
    }

    if (result?.message) {
      setProgress({
        percent: 100,
        title: '完了',
        detail: result.message
      });
    }

    await refresh();
    checkLatest(true);
  } catch (error) {
    setProgress({
      percent: 0,
      title: '失敗しました',
      detail: messageOf(error)
    });
  } finally {
    setBusy(false);
  }
}

browseInstallBtn.addEventListener('click', async () => {
  try {
    const dir = await window.installer.chooseInstallDir();
    if (dir) {
      installDirEl.value = dir;
      await window.installer.setInstallDir(dir);
      await refresh();
    }
  } catch (error) {
    setProgress({
      percent: 0,
      title: '失敗しました',
      detail: messageOf(error)
    });
  }
});

openInstallBtn.addEventListener('click', async () => {
  try {
    await window.installer.openInstallDir(installDirEl.value.trim());
  } catch (error) {
    setProgress({
      percent: 0,
      title: '失敗しました',
      detail: messageOf(error)
    });
  }
});

checkLatestBtn.addEventListener('click', () => checkLatest(false));

cancelBtn.addEventListener('click', async () => {
  cancelBtn.disabled = true;
  try {
    await window.installer.cancel();
  } catch {}
});

installBtn.addEventListener('click', () => runAction('install'));
repairBtn.addEventListener('click', () => runAction('repair'));
updateBtn.addEventListener('click', () => runAction('update'));
uninstallBtn.addEventListener('click', () => runAction('uninstall'));

installDirEl.addEventListener('change', async () => {
  try {
    await window.installer.setInstallDir(installDirEl.value.trim());
    await refresh();
  } catch (error) {
    setProgress({
      percent: 0,
      title: '失敗しました',
      detail: messageOf(error)
    });
  }
});

window.installer.onProgress((payload) => {
  setProgress(payload);
});

(async () => {
  await setIcon();
  await setVersion();
  await refresh();
  setProgress({
    percent: 0,
    title: '待機中',
    detail: '操作を開始してください'
  });

  try {
    const intent = await window.installer.getLaunchIntent();
    if (intent?.autoUninstall) {
      await runAction('uninstall');
      return;
    }
  } catch {}

  checkLatest(true);
})();
