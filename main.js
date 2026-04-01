const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'io.github.takkunlego0916.playpocket';
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_ID); } catch (e) { /* ignore */ }
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

try {
  const safeUserData = path.join(app.getPath('appData'), 'PlayPocket');
  app.setPath('userData', safeUserData);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(safeUserData, 'Cache'));
} catch (e) {
  console.warn('Failed to set safe userData path:', e);
}

let mainWindow = null;

function createWindow() {
  const icoPath = path.join(__dirname, 'app', 'icons', 'appIcon.ico');
  const pngPath = path.join(__dirname, 'app', 'icons', 'appIcon.png');
  let icon;
  if (fs.existsSync(icoPath)) {
    icon = nativeImage.createFromPath(icoPath);
  } else if (fs.existsSync(pngPath)) {
    icon = nativeImage.createFromPath(pngPath);
  } else {
    icon = undefined;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    center: true,
    show: false,
    autoHideMenuBar: true,
    frame: true,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false
    }
  });

  try {
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
  } catch (e) {
    console.warn('Failed to remove application menu:', e);
  }

  try {
    const indexPath = path.resolve(__dirname, 'app', 'index.html');
    console.log('Attempting to load index at:', indexPath);
    if (!fs.existsSync(indexPath)) {
      console.error('index.html not found at', indexPath);
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2>index.html が見つかりません</h2><p>app/index.html を配置してください。</p>'));
    } else {
      const fileUrl = `file://${indexPath.replace(/\\/g, '/')}`;
      mainWindow.loadURL(encodeURI(fileUrl)).catch(err => {
        console.error('Failed to load index.html via loadURL:', err);
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2>読み込みエラー</h2><pre>' + String(err) + '</pre>'));
      });
    }
  } catch (e) {
    console.error('Error while loading index.html:', e);
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

ipcMain.handle('read-file', async (_, relativePath) => {
  try {
    const base = path.join(app.getPath('userData'));
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
    const base = path.join(app.getPath('userData'));
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

app.whenReady().then(() => {
  console.log('__dirname =', __dirname);
  console.log('process.cwd() =', process.cwd());
  console.log('app.getPath(userData) =', app.getPath('userData'));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
