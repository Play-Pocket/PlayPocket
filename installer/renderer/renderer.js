const sourceDirEl    = document.getElementById('sourceDir');
const installDirEl   = document.getElementById('installDir');
const sourceExeEl    = document.getElementById('sourceExe');
const installedExeEl = document.getElementById('installedExe');
const statusTextEl   = document.getElementById('statusText');
const sourceStateEl  = document.getElementById('sourceState');
const installStateEl = document.getElementById('installState');
const sourceState2El = document.getElementById('sourceState2');
const installState2El = document.getElementById('installState2');
const logEl          = document.getElementById('log');
const heroIconEl     = document.getElementById('heroIcon');

const installBtn     = document.getElementById('installBtn');
const repairBtn      = document.getElementById('repairBtn');
const updateBtn      = document.getElementById('updateBtn');
const uninstallBtn   = document.getElementById('uninstallBtn');
const refreshBtn     = document.getElementById('refreshBtn');
const refreshBtn2    = document.getElementById('refreshBtn2');
const browseSourceBtn  = document.getElementById('browseSource');
const browseInstallBtn = document.getElementById('browseInstall');
const openSourceBtn  = document.getElementById('openSource');
const openInstallBtn = document.getElementById('openInstall');
const clearLogBtn    = document.getElementById('clearLog');

function formatTime(ms) {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString('ja-JP');
  } catch {
    return '-';
  }
}

function formatVersion(version) {
  if (!version) return 'v-';
  return `v${version}`;
}

function appendLog(text) {
  const time = new Date().toLocaleTimeString('ja-JP');
  const line = `[${time}] ${text}`;
  if (logEl.textContent) {
    logEl.textContent += `\n${line}`;
  } else {
    logEl.textContent = line;
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(busy) {
  const buttons = [
    installBtn,
    repairBtn,
    updateBtn,
    uninstallBtn,
    browseSourceBtn,
    browseInstallBtn,
    openSourceBtn,
    openInstallBtn,
    refreshBtn,
    refreshBtn2
  ];

  for (const button of buttons) {
    button.disabled = busy;
  }

  if (!busy) {
    refreshBtn.disabled = false;
    refreshBtn2.disabled = false;
  }
}

function setStatus(status) {
  sourceDirEl.value  = status.sourceDir  || '';
  installDirEl.value = status.installDir || '';

  sourceExeEl.textContent = status.sourceLatestVersion
    ? `${formatVersion(status.sourceLatestVersion)} / ${formatTime(status.sourceLatestTime)}`
    : 'v-';

  installedExeEl.textContent = status.installedVersion
    ? `${formatVersion(status.installedVersion)} / ${formatTime(status.installedTime)}`
    : 'v-';

  sourceStateEl.textContent  = `ソース: ${status.sourceExists  ? '存在' : '存在しません'}`;
  installStateEl.textContent = `インストール先: ${status.installExists ? '存在' : '存在しません'}`;
  sourceState2El.textContent  = status.sourceExists  ? '存在' : '存在しません';
  installState2El.textContent = status.installExists ? '存在' : '存在しません';
  statusTextEl.textContent    = status.installExists ? '状態: 準備完了' : '状態: 未インストール';
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
  setBusy(true);
  try {
    const status = await window.installer.getStatus();
    setStatus(status);
  } catch (error) {
    appendLog(`状態取得失敗: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function runAction(action) {
  setBusy(true);

  try {
    const payload = {
      sourceDir:  sourceDirEl.value.trim(),
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
        appendLog('アンインストールをキャンセルしました');
        return;
      }
      result = await window.installer.uninstall(payload);
    }

    if (result?.message) {
      appendLog(result.message);
    }

    const status = await window.installer.getStatus();
    setStatus(status);
  } catch (error) {
    appendLog(`操作失敗: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

browseSourceBtn.addEventListener('click', async () => {
  try {
    const dir = await window.installer.chooseSourceDir();
    if (dir) {
      sourceDirEl.value = dir;
      await window.installer.setSourceDir(dir);
      appendLog(`release フォルダを設定しました: ${dir}`);
      await refresh();
    }
  } catch (error) {
    appendLog(`参照失敗: ${error.message}`);
  }
});

browseInstallBtn.addEventListener('click', async () => {
  try {
    const dir = await window.installer.chooseInstallDir();
    if (dir) {
      installDirEl.value = dir;
      await window.installer.setInstallDir(dir);
      appendLog(`インストール先を設定しました: ${dir}`);
      await refresh();
    }
  } catch (error) {
    appendLog(`参照失敗: ${error.message}`);
  }
});

openSourceBtn.addEventListener('click', async () => {
  try {
    await window.installer.openSourceDir();
  } catch (error) {
    appendLog(`フォルダを開けませんでした: ${error.message}`);
  }
});

openInstallBtn.addEventListener('click', async () => {
  try {
    await window.installer.openInstallDir();
  } catch (error) {
    appendLog(`フォルダを開けませんでした: ${error.message}`);
  }
});

installBtn.addEventListener('click',   () => runAction('install'));
repairBtn.addEventListener('click',    () => runAction('repair'));
updateBtn.addEventListener('click',    () => runAction('update'));
uninstallBtn.addEventListener('click', () => runAction('uninstall'));
refreshBtn.addEventListener('click',   refresh);
refreshBtn2.addEventListener('click',  refresh);

clearLogBtn.addEventListener('click', () => {
  logEl.textContent = '';
  appendLog('ログを消去しました');
});

sourceDirEl.addEventListener('change', async () => {
  await window.installer.setSourceDir(sourceDirEl.value.trim());
  await refresh();
});

installDirEl.addEventListener('change', async () => {
  await window.installer.setInstallDir(installDirEl.value.trim());
  await refresh();
});

window.installer.onLog(appendLog);

(async () => {
  await setIcon();
  appendLog('起動しました');
  await refresh();
})();
