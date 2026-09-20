'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-installer-e2e-'));
const LOCALAPPDATA = path.join(RUN, 'local');
const USER_DATA = path.join(RUN, 'ud');
const PORT = 9800 + Math.floor(Math.random() * 100);
const INSTALL_DIR = path.join(LOCALAPPDATA, 'Programs', 'PlayPocket');
const BACKUP_DIR = path.join(LOCALAPPDATA, 'Programs', '.PlayPocket-backup-interrupted');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKUP_DIR, 'PlayPocket.1.5.1.exe'), 'exe');
  fs.writeFileSync(path.join(BACKUP_DIR, '.playpocket-install.json'), JSON.stringify({
    appId: 'io.github.takkunlego0916.playpocket.installer', productName: 'PlayPocket', version: '1.5.1'
  }));

  const child = spawn(ELECTRON, ['.', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, LOCALAPPDATA },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stderr.on('data', (d) => logs.push(String(d).trim()));

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('installer page not found');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 1;
  const pending = new Map();
  const issues = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      issues.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      issues.push(`EXCEPTION ${message.params.exceptionDetails.text}`);
    } else if (message.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: false });
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = id++;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (fn) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result.result.value;
  };

  await sleep(1500);
  const info = await evaluate(async () => {
    const out = {};
    out.version = document.getElementById('installerVersion').textContent;
    out.status = await window.installer.getStatus();
    out.api = Object.keys(window.installer).sort().join();
    try { await window.installer.setInstallDir('C:\\'); out.root = 'accepted'; } catch (e) { out.root = e.message; }
    try { await window.installer.setInstallDir(''); out.empty = 'accepted'; } catch (e) { out.empty = e.message; }
    try { await window.installer.uninstall({ installDir: 'C:\\Windows' }); out.uninstallSystem = 'accepted'; } catch (e) { out.uninstallSystem = e.message; }
    try { await window.installer.openInstallDir('C:\\definitely-missing-dir-xyz'); out.open = 'accepted'; } catch (e) { out.open = e.message; }
    out.navigation = await new Promise((resolve) => {
      const before = location.href;
      location.href = 'https://example.com/';
      setTimeout(() => resolve(location.href === before), 400);
    });
    out.cspBlocksFetch = await fetch('https://example.com/').then(() => false, () => true);
    return out;
  });

  check('installer shows its own version', info.version === 'PlayPocket Installer v1.5.2', info.version);
  check('interrupted install recovered at startup', fs.existsSync(path.join(INSTALL_DIR, 'PlayPocket.1.5.1.exe')) && !fs.existsSync(BACKUP_DIR), fs.readdirSync(path.join(LOCALAPPDATA, 'Programs')));
  check('status reports the recovered install and version', info.status.installExists === true && info.status.installedVersion === '1.5.1', info.status);
  check('drive root is rejected with a clear message', /ドライブ直下/.test(info.root), info.root);
  check('empty install dir accepted only via fallback (no crash)', typeof info.empty === 'string', info.empty);
  check('uninstall refuses a folder that PlayPocket does not manage', /管理されていない/.test(info.uninstallSystem), info.uninstallSystem);
  check('open missing folder is refused', /見つかりません/.test(info.open), info.open);
  check('renderer cannot navigate away', info.navigation === true, info.navigation);
  check('renderer cannot fetch external URLs', info.cspBlocksFetch === true, info.cspBlocksFetch);
  check('preload exposes exactly the expected API', info.api === 'chooseInstallDir,getIconPath,getLaunchIntent,getStatus,getVersion,install,onProgress,openInstallDir,repair,setInstallDir,uninstall,update', info.api);

  const realIssues = issues.filter((line) => !/example\.com|Refused to|Failed to fetch|net::ERR|Content Security Policy/i.test(line));
  check('no unexpected console errors', realIssues.length === 0, realIssues);

  try { ws.close(); } catch {}
  try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  console.log(`\nRESULT: ${failures === 0 ? 'all passed' : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('RUNNER ERROR', error);
  process.exit(2);
});
