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

let busy = false;

function setBusy(nextBusy) {
  busy = nextBusy;
  const buttons = [
    installBtn,
    repairBtn,
    updateBtn,
    uninstallBtn,
    browseInstallBtn,
    openInstallBtn
  ];

  for (const button of buttons) {
    button.disabled = nextBusy;
  }
}

function setProgress(payload = {}) {
  const percent = typeof payload.percent === 'number' && Number.isFinite(payload.percent)
    ? Math.max(0, Math.min(100, payload.percent))
    : null;

  progressTitleEl.textContent = payload.title || '待機中';
  progressDetailEl.textContent = payload.detail || '';

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
  statusTextEl.textContent = status.installExists ? '準備完了' : '未作成';
}

async function setIcon() {
  try {
    const iconUrl = await window.installer.getIconPath();
    if (iconUrl) {
      heroIconEl.src = iconUrl;
    }
  } catch {}
}

async function refresh() {
  try {
    const status = await window.installer.getStatus();
    setStatus(status);
  } catch (error) {
    statusTextEl.textContent = `取得失敗: ${error.message}`;
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
  } catch (error) {
    setProgress({
      percent: 0,
      title: '失敗しました',
      detail: error.message
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
      detail: error.message
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
      detail: error.message
    });
  }
});

installBtn.addEventListener('click', () => runAction('install'));
repairBtn.addEventListener('click', () => runAction('repair'));
updateBtn.addEventListener('click', () => runAction('update'));
uninstallBtn.addEventListener('click', () => runAction('uninstall'));

installDirEl.addEventListener('change', async () => {
  await window.installer.setInstallDir(installDirEl.value.trim());
  await refresh();
});

window.installer.onProgress((payload) => {
  setProgress(payload);
});

(async () => {
  await setIcon();
  await refresh();
  setProgress({
    percent: 0,
    title: '待機中',
    detail: '操作を開始してください'
  });
})();
