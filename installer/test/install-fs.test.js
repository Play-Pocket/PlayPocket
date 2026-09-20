'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Lib = require('../lib/install-fs.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-installer-'));
}

function writeFile(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function makeManagedInstall(dir, version = '1.5.1') {
  writeFile(path.join(dir, `PlayPocket.${version}.exe`), 'exe');
  await Lib.writeInstallManifest(dir, version);
}

test('compareVersions orders semantic versions and tolerates prefixes', () => {
  assert.ok(Lib.compareVersions('1.5.1', '1.5.2') > 0);
  assert.ok(Lib.compareVersions('1.5.2', '1.5.1') < 0);
  assert.equal(Lib.compareVersions('v1.5.2', '1.5.2'), 0);
  assert.ok(Lib.compareVersions('1.9.0', '1.10.0') > 0);
  assert.ok(Lib.compareVersions('1.5', '1.5.1') > 0);
  assert.equal(Lib.extractVersionFromText('PlayPocket.1.5.2.exe'), '1.5.2');
  assert.equal(Lib.extractVersionFromText('no version'), null);
});

test('normalizeInstallDir rejects roots, empty values and hostile input', () => {
  assert.throws(() => Lib.normalizeInstallDir('C:\\'));
  assert.throws(() => Lib.normalizeInstallDir('   ', ''));
  assert.throws(() => Lib.normalizeInstallDir('C:\\a\u0000b'));
  assert.throws(() => Lib.normalizeInstallDir('x'.repeat(2000)));
  assert.equal(Lib.normalizeInstallDir('', 'C:\\Apps\\PlayPocket'), path.resolve('C:\\Apps\\PlayPocket'));
  assert.equal(Lib.normalizeInstallDir('C:\\Apps\\..\\Apps\\PlayPocket'), path.resolve('C:\\Apps\\PlayPocket'));
});

test('isSameOrNested detects containment', () => {
  assert.equal(Lib.isSameOrNested('C:\\a', 'C:\\a\\b'), true);
  assert.equal(Lib.isSameOrNested('C:\\a', 'C:\\a'), true);
  assert.equal(Lib.isSameOrNested('C:\\a', 'C:\\ab'), false);
  assert.equal(Lib.isSameOrNested('C:\\a\\b', 'C:\\a'), false);
});

test('walkFiles honours depth and entry limits and skips unreadable branches', async () => {
  const root = tempDir();
  for (let i = 0; i < 30; i++) writeFile(path.join(root, `f${i}.txt`));
  writeFile(path.join(root, 'a', 'b', 'c', 'd', 'deep.txt'));
  const all = await Lib.walkFiles(root);
  assert.ok(all.some((f) => f.endsWith('deep.txt')));
  const shallow = await Lib.walkFiles(root, { maxDepth: 1 });
  assert.ok(!shallow.some((f) => f.endsWith('deep.txt')));
  const limited = await Lib.walkFiles(root, { maxEntries: 10 });
  assert.ok(limited.length <= 10);
  await assert.rejects(() => Lib.walkFiles(path.join(root, 'missing')));
});

test('findLatestExe prefers the highest version and ignores uninstallers', async () => {
  const root = tempDir();
  writeFile(path.join(root, 'PlayPocket.1.5.1.exe'), 'a');
  writeFile(path.join(root, 'PlayPocket.1.5.2.exe'), 'b');
  writeFile(path.join(root, 'uninstall-PlayPocket.9.9.9.exe'), 'c');
  writeFile(path.join(root, 'readme.txt'), 'd');
  const found = await Lib.findLatestExe(root);
  assert.equal(found.name, 'PlayPocket.1.5.2.exe');
  assert.equal(found.version, '1.5.2');
  assert.equal(await Lib.findLatestExe(path.join(root, 'nope')), null);
  assert.equal(await Lib.findLatestExe(''), null);
});

test('managed install detection, replace guards and uninstall guards', async () => {
  const managed = tempDir();
  await makeManagedInstall(managed);
  assert.equal(await Lib.isManagedInstall(managed), true);
  await Lib.assertInstallDirectoryCanBeReplaced(managed);
  await Lib.assertManagedInstallDirectory(managed);

  const empty = tempDir();
  await Lib.assertInstallDirectoryCanBeReplaced(empty);
  await Lib.assertInstallDirectoryCanBeReplaced(path.join(empty, 'not-yet'));

  const foreign = tempDir();
  writeFile(path.join(foreign, 'important.docx'));
  writeFile(path.join(foreign, 'other-app.exe'));
  await assert.rejects(() => Lib.assertInstallDirectoryCanBeReplaced(foreign));
  await assert.rejects(() => Lib.assertManagedInstallDirectory(foreign));
  await assert.rejects(() => Lib.assertManagedInstallDirectory(path.join(foreign, 'missing')));
});

test('a forged manifest with a different app id is not trusted', async () => {
  const dir = tempDir();
  writeFile(path.join(dir, 'x.txt'));
  fs.writeFileSync(path.join(dir, Lib.INSTALL_MANIFEST_FILE), JSON.stringify({ appId: 'evil', productName: 'PlayPocket' }));
  assert.equal(await Lib.readInstallManifest(dir), null);
  assert.equal(await Lib.isManagedInstall(dir), false);
});

test('interrupted install: backup is restored when the install folder vanished', async () => {
  const parent = tempDir();
  const installDir = path.join(parent, 'PlayPocket');
  const backup = path.join(parent, `${Lib.BACKUP_PREFIX}abc`);
  await makeManagedInstall(backup, '1.5.1');
  assert.equal(await Lib.recoverInterruptedInstall(installDir), true);
  assert.ok(fs.existsSync(path.join(installDir, 'PlayPocket.1.5.1.exe')));
  assert.equal(fs.existsSync(backup), false);
});

test('interrupted install: nothing happens when the install folder exists or the backup is foreign', async () => {
  const parent = tempDir();
  const installDir = path.join(parent, 'PlayPocket');
  await makeManagedInstall(installDir, '1.5.2');
  await makeManagedInstall(path.join(parent, `${Lib.BACKUP_PREFIX}old`), '1.5.0');
  assert.equal(await Lib.recoverInterruptedInstall(installDir), false);
  assert.ok(fs.existsSync(path.join(installDir, 'PlayPocket.1.5.2.exe')));

  const parent2 = tempDir();
  const foreignBackup = path.join(parent2, `${Lib.BACKUP_PREFIX}zzz`);
  writeFile(path.join(foreignBackup, 'not-ours.txt'));
  assert.equal(await Lib.recoverInterruptedInstall(path.join(parent2, 'PlayPocket')), false);
  assert.equal(await Lib.recoverInterruptedInstall(path.join(tempDir(), 'missing-parent', 'PlayPocket')), false);
});

test('interrupted install: the newest of several backups wins', async () => {
  const parent = tempDir();
  const installDir = path.join(parent, 'PlayPocket');
  const older = path.join(parent, `${Lib.BACKUP_PREFIX}1`);
  const newer = path.join(parent, `${Lib.BACKUP_PREFIX}2`);
  await makeManagedInstall(older, '1.4.0');
  await makeManagedInstall(newer, '1.5.1');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(older, past, past);
  assert.equal(await Lib.recoverInterruptedInstall(installDir), true);
  assert.ok(fs.existsSync(path.join(installDir, 'PlayPocket.1.5.1.exe')));
});

test('cleanupStaleWorkDirs removes only staging and backup folders', async () => {
  const parent = tempDir();
  fs.mkdirSync(path.join(parent, `${Lib.STAGING_PREFIX}1`));
  fs.mkdirSync(path.join(parent, `${Lib.BACKUP_PREFIX}1`));
  fs.mkdirSync(path.join(parent, 'PlayPocket'));
  fs.mkdirSync(path.join(parent, 'Documents'));
  await Lib.cleanupStaleWorkDirs(parent);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['Documents', 'PlayPocket']);
  await Lib.cleanupStaleWorkDirs(path.join(parent, 'nonexistent'));
});

test('json helpers: atomic write, BOM tolerance, prototype pollution and non-object fallback', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  await Lib.writeJsonAtomic(file, { installDir: 'C:\\x' });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.deepEqual(await Lib.readJson(file, null), { installDir: 'C:\\x' });
  fs.writeFileSync(file, '\uFEFF{"ok":1}');
  assert.deepEqual(await Lib.readJson(file, null), { ok: 1 });
  fs.writeFileSync(file, '{"__proto__":{"polluted":true},"a":1}');
  const parsed = await Lib.readJson(file, null);
  assert.equal(parsed.a, 1);
  assert.equal({}.polluted, undefined);
  fs.writeFileSync(file, '[1,2]');
  assert.deepEqual(await Lib.readJson(file, { fallback: true }), { fallback: true });
  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(await Lib.readJson(file, { fallback: true }), { fallback: true });
  assert.deepEqual(await Lib.readJson(path.join(dir, 'none.json'), { fallback: 1 }), { fallback: 1 });
});
