'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const notes = [];

function read(rel, base = ROOT) {
  return fs.readFileSync(path.join(base, rel), 'utf8').replace(/^\uFEFF/, '');
}

function exists(rel, base = ROOT) {
  return fs.existsSync(path.join(base, rel));
}

function ok(name) {
  console.log(`  ok    ${name}`);
}

function fail(name, detail) {
  problems.push(`${name}: ${detail}`);
  console.log(`  FAIL  ${name} -> ${detail}`);
}

function expect(name, condition, detail) {
  if (condition) ok(name);
  else fail(name, detail);
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/\*/g, '\u0000')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function coveredByBuildFiles(rel, patterns) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(rel)) included = false;
    } else if (globToRegExp(pattern).test(rel)) {
      included = true;
    }
  }
  return included;
}

function listJs(dirRel) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) out.push(child);
    }
  };
  walk(dirRel);
  return out;
}

function checkVersions(pkg) {
  console.log('\n[version consistency]');
  const version = pkg.version;
  expect('package.json has a semver version', /^\d+\.\d+\.\d+$/.test(version), version);

  const lock = JSON.parse(read('package-lock.json'));
  expect('package-lock.json top-level version matches', lock.version === version, lock.version);
  expect('package-lock.json root package version matches', lock.packages && lock.packages[''] && lock.packages[''].version === version, lock.packages && lock.packages['']);

  const html = read('app/index.html');
  const label = html.match(/<div class="search">PlayPocket ([^<]+)<\/div>/);
  expect('index.html top bar shows the same version', !!label && label[1].trim() === version, label && label[1]);

  for (const readme of ['README.md', 'README.en.md']) {
    const text = read(readme);
    const mentions = [...text.matchAll(/PlayPocket-Installer-(\d+\.\d+\.\d+)-/g)].map((m) => m[1]);
    expect(`${readme} installer file names use ${version}`, mentions.length > 0 && mentions.every((v) => v === version), mentions);
  }

  const changelog = read('CHANGELOG.md');
  expect('CHANGELOG.md has a section for this version', new RegExp(`^# PlayPocket v${version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog), 'missing heading');

  const installerDir = process.env.PP_INSTALLER_DIR || path.resolve(ROOT, '..', 'PlayPocket-Installer');
  if (fs.existsSync(path.join(installerDir, 'package.json'))) {
    const installerPkg = JSON.parse(read('package.json', installerDir));
    expect(`installer package.json version matches (${installerDir})`, installerPkg.version === version, installerPkg.version);
    const installerLock = JSON.parse(read('package-lock.json', installerDir));
    expect('installer package-lock.json version matches', installerLock.version === version && installerLock.packages[''].version === version, installerLock.version);
  } else {
    notes.push('installer directory not found; skipped installer version check');
  }

  if (process.env.PP_ANDROID_DIR) {
    const gradle = read('app/build.gradle.kts', process.env.PP_ANDROID_DIR);
    const name = gradle.match(/versionName\s*=\s*"([^"]+)"/);
    expect('android versionName matches', !!name && name[1] === version, name && name[1]);
    const code = gradle.match(/versionCode\s*=\s*(\d+)/);
    expect('android versionCode is a positive integer', !!code && Number(code[1]) > 0, code && code[1]);
    if (process.env.PP_ANDROID_PREVIOUS_VERSION_CODE) {
      expect('android versionCode increased since the previous release', !!code && Number(code[1]) > Number(process.env.PP_ANDROID_PREVIOUS_VERSION_CODE), code && code[1]);
    }
    const androidHtml = read('app/src/main/assets/index.html', process.env.PP_ANDROID_DIR);
    const androidLabel = androidHtml.match(/<div class="search">PlayPocket ([^<]+)<\/div>/);
    expect('android index.html version label matches', !!androidLabel && androidLabel[1].trim() === version, androidLabel && androidLabel[1]);
  } else {
    notes.push('PP_ANDROID_DIR not set; skipped android version check');
  }
}

function checkIpcChannels() {
  console.log('\n[ipc channels]');
  const channels = require(path.join(ROOT, 'main', 'channels.js'));
  const preload = read('preload.js');
  const match = preload.match(/const CH = Object\.freeze\((\{[\s\S]*?\})\);/);
  expect('preload.js declares the channel table', !!match, 'CH table not found');
  if (!match) return;
  const preloadChannels = vm.runInNewContext(`(${match[1]})`);
  expect('preload.js channel names equal main/channels.js', JSON.stringify(preloadChannels) === JSON.stringify(channels), { preloadChannels, channels });

  const mainSource = read('main.js');
  const usedKeys = new Set([...mainSource.matchAll(/CH\.([A-Z_]+)/g)].map((m) => m[1]));
  expect('every channel used by main.js is defined', [...usedKeys].every((key) => key in channels), [...usedKeys].filter((key) => !(key in channels)));
  const commands = read('main/validators.js').match(/PLAYBACK_COMMANDS = Object\.freeze\((\[[^\]]*\])\)/);
  const preloadCommands = preload.match(/PLAYBACK_COMMANDS = new Set\((\[[^\]]*\])\)/);
  expect('playback command allow-lists match between preload and main', !!commands && !!preloadCommands && JSON.stringify(vm.runInNewContext(commands[1])) === JSON.stringify(vm.runInNewContext(preloadCommands[1])), 'mismatch');
}

function checkPackaging(pkg) {
  console.log('\n[packaging]');
  const patterns = (pkg.build && pkg.build.files) || [];
  const shipped = ['main.js', 'preload.js', ...listJs('main'), ...listJs('app')];
  const uncovered = shipped.filter((file) => !coveredByBuildFiles(file, patterns));
  expect('every shipped JS file is covered by build.files', uncovered.length === 0, uncovered);

  const requires = [];
  for (const file of ['main.js', ...listJs('main'), 'app/shared/schema.js']) {
    const dir = path.posix.dirname(file);
    for (const match of read(file).matchAll(/require\('(\.[^']+)'\)/g)) {
      const target = path.posix.normalize(`${dir}/${match[1]}`);
      const resolved = exists(target) ? target : `${target}.js`;
      requires.push({ from: file, target: resolved });
    }
  }
  const missing = requires.filter((r) => !exists(r.target));
  expect('every relative require() resolves to a file', missing.length === 0, missing);
  const notShipped = requires.filter((r) => !coveredByBuildFiles(r.target, patterns));
  expect('every required local module is packaged', notShipped.length === 0, notShipped);
}

function checkRenderer() {
  console.log('\n[renderer]');
  const html = read('app/index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const missing = scripts.filter((src) => !exists(`app/${src}`));
  expect('all <script src> files exist', missing.length === 0, missing);
  const order = ['shared/schema.js', 'js/core.js', 'js/db.js', 'js/media.js', 'js/engine.js', 'js/player.js', 'js/library.js', 'app.js'];
  const indexes = order.map((s) => scripts.indexOf(s));
  expect('scripts load in dependency order', indexes.every((v, i) => v >= 0 && (i === 0 || v > indexes[i - 1])), indexes);
  const unloaded = listJs('app').map((f) => f.slice(4)).filter((f) => !scripts.includes(f));
  expect('no orphaned renderer scripts', unloaded.length === 0, unloaded);
  expect('deck B is not declared muted in markup', !/id="videoPlayerB"[^>]*\smuted[\s>]/.test(html), 'muted attribute present');
  expect('CSP forbids network connections', /connect-src 'none'/.test(html) && /script-src 'self'/.test(html), 'CSP changed');
  expect('no inline scripts', !/<script(?![^>]*\ssrc=)[^>]*>/.test(html), 'inline <script> found');
}

function checkSyntax() {
  console.log('\n[syntax]');
  const files = ['main.js', 'preload.js', ...listJs('main'), ...listJs('app'), ...listJs('scripts'), ...listJs('test')];
  const broken = [];
  for (const file of files) {
    try {
      new vm.Script(read(file), { filename: file });
    } catch (error) {
      broken.push(`${file}: ${error.message}`);
    }
  }
  expect(`${files.length} JavaScript files parse`, broken.length === 0, broken);

  const commented = [];
  for (const file of ['main.js', 'preload.js', ...listJs('main'), ...listJs('app')]) {
    read(file).split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) commented.push(`${file}:${index + 1}`);
    });
  }
  expect('shipped code contains no comment lines', commented.length === 0, commented.slice(0, 10));
}

function checkSharedWithAndroid() {
  console.log('\n[shared modules]');
  const dir = process.env.PP_ANDROID_DIR;
  if (!dir) {
    notes.push('PP_ANDROID_DIR not set; skipped shared module comparison');
    return;
  }
  const assets = path.join(dir, 'app', 'src', 'main', 'assets');
  const shared = ['shared/schema.js', 'share.js', 'js/core.js', 'js/db.js', 'js/media.js', 'js/dialogs.js', 'js/settings.js', 'js/engine.js', 'js/player.js', 'js/library.js'];
  const normalize = (text) => text.replace(/\r\n/g, '\n');
  const different = shared.filter((file) => !fs.existsSync(path.join(assets, file)) || normalize(read(`app/${file}`)) !== normalize(fs.readFileSync(path.join(assets, file), 'utf8').replace(/^\uFEFF/, '')));
  expect('shared renderer modules are identical in the Android assets', different.length === 0, different);
}

function checkJsonFiles() {
  console.log('\n[json syntax]');
  const files = ['package.json', 'package-lock.json'];
  const broken = [];
  for (const file of files) {
    try {
      JSON.parse(read(file));
    } catch (error) {
      broken.push(`${file}: ${error.message}`);
    }
  }
  expect('JSON files parse', broken.length === 0, broken);
}

function checkRequiredFiles(pkg) {
  console.log('\n[required files]');
  const patterns = (pkg.build && pkg.build.files) || [];
  const literal = patterns.filter((p) => !p.startsWith('!') && !/[*?]/.test(p));
  const missing = literal.filter((file) => !exists(file));
  if (missing.length > 0) {
    notes.push(`build.files lists files that do not exist (electron-builder skips them): ${missing.join(', ')}`);
    console.log(`  warn  build.files entries missing on disk: ${missing.join(', ')}`);
  } else {
    ok('every literal build.files entry exists');
  }
  const required = ['app/index.html', 'app/styles.css', 'app/icons/appIcon.ico', 'main.js', 'preload.js', 'main/channels.js', 'app/shared/schema.js'];
  const absent = required.filter((file) => !exists(file));
  expect('required application files exist', absent.length === 0, absent);
  const icon = pkg.build && pkg.build.win && pkg.build.win.icon;
  expect('windows icon path from package.json exists', !!icon && exists(icon), icon);
}

function checkGitTag(pkg) {
  console.log('\n[git tag]');
  const refType = process.env.GITHUB_REF_TYPE;
  const refName = process.env.GITHUB_REF_NAME || process.env.PP_GIT_TAG;
  if ((refType === 'tag' || process.env.PP_GIT_TAG) && refName) {
    expect(`git tag ${refName} equals v${pkg.version}`, refName === `v${pkg.version}`, refName);
  } else {
    notes.push('no git tag in environment; skipped tag comparison');
  }
}

function main() {
  const pkg = JSON.parse(read('package.json'));
  console.log(`PlayPocket release verification (v${pkg.version})`);
  checkJsonFiles();
  checkRequiredFiles(pkg);
  checkVersions(pkg);
  checkGitTag(pkg);
  checkIpcChannels();
  checkPackaging(pkg);
  checkRenderer();
  checkSyntax();
  checkSharedWithAndroid();

  for (const note of notes) console.log(`\nnote: ${note}`);
  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s) found`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main();
