'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ASSETS = path.resolve(__dirname, '..', 'app', 'src', 'main', 'assets');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'fake-bridge.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} Linux Android 14 PlayPocketAndroid`);
  win.loadFile(path.join(ASSETS, 'index.html'), { query: { dev: '1' } });
});

app.on('window-all-closed', () => app.quit());
