const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const RPC = require("discord-rpc");

const DISCORD_CLIENT_ID = "1489154338705375242";

let rpc = null;
let mainWindow = null;

const APP_ID = 'io.github.takkunlego0916.playpocket';
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_ID); } catch (e) {}
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

try {
  const safeUserData = path.join(app.getPath('appData'), 'PlayPocket');
  app.commandLine.appendSwitch('disk-cache-dir', path.join(safeUserData, 'Cache'));
} catch (e) {
  console.warn("userData設定失敗:", e);
}

function createWindow() {
  const icoPath = path.join(__dirname, 'app', 'icons', 'appIcon.ico');
  const pngPath = path.join(__dirname, 'app', 'icons', 'appIcon.png');

  let icon;
  if (fs.existsSync(icoPath)) icon = nativeImage.createFromPath(icoPath);
  else if (fs.existsSync(pngPath)) icon = nativeImage.createFromPath(pngPath);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);

  const indexPath = path.resolve(__dirname, 'app', 'index.html');
  if (!fs.existsSync(indexPath)) {
    mainWindow.loadURL('data:text/html,<h2>index.htmlが無い</h2>');
  } else {
    mainWindow.loadURL(`file://${indexPath.replace(/\\/g, '/')}`);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function initRPC() {
  rpc = new RPC.Client({ transport: "ipc" });

  rpc.on("ready", () => {
    console.log("Discord RPC Ready");
  });

  rpc.on("disconnected", () => {
    console.log("RPC disconnected → 再接続");
    setTimeout(() => {
      rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(console.error);
    }, 5000);
  });

  rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(console.error);
}

ipcMain.on("set-rpc", (_, data = {}) => {
  if (!rpc) return;

  try {
    const now = Date.now();

    rpc.setActivity({
      details: data.title || "再生中",
      state: data.playlist || "PlayPocketで再生中",

      startTimestamp: data.startTimestamp || now,
      endTimestamp: data.endTimestamp || undefined,

      largeImageKey: "app",
      largeImageText: "PlayPocket",

      instance: false
    });

  } catch (e) {
    console.error("RPC error:", e);
  }
});

ipcMain.on("clear-rpc", () => {
  if (!rpc) return;
  try {
    rpc.clearActivity();
  } catch (e) {
    console.error("RPC clear error:", e);
  }
});


app.whenReady().then(() => {
  initRPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (rpc) {
    try {
      rpc.clearActivity();
    } catch (e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('read-file', async (_, relativePath) => {
  try {
    const base = app.getPath('userData');
    const full = path.resolve(base, relativePath);
    if (!full.startsWith(path.resolve(base))) throw new Error('Access denied');
    return fs.readFileSync(full, 'utf8');
  } catch (e) {
    console.error('read-file error:', e);
    throw e;
  }
});

ipcMain.handle('write-file', async (_, relativePath, data) => {
  try {
    const base = app.getPath('userData');
    const full = path.resolve(base, relativePath);
    if (!full.startsWith(path.resolve(base))) throw new Error('Access denied');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data, 'utf8');
    return true;
  } catch (e) {
    console.error('write-file error:', e);
    throw e;
  }
});

ipcMain.handle('get-app-paths', () => {
  return {
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    home: app.getPath('home'),
    temp: app.getPath('temp'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents')
  };
});


process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
