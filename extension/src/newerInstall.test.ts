import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedVersions, newerInstalledVersion, pendingUpgrade } from './newerInstall';

const ID = 'jaga.claude-persist-vscode';

/** An extensions folder, as VS Code lays one out. */
function extensionsDir(names: Record<string, string | null>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-newer-'));
  for (const [name, version] of Object.entries(names)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (version !== null) {
      fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ version }));
    }
  }
  return dir;
}

// ---------- which of them is newer ------------------------------------------

/**
 * The whole point. A window ran 1.0.47 for eight and a half days with three
 * newer builds beside it, and nothing in that window could tell: the daemon it
 * spawned was 1.0.47 too, so every check inside agreed with every other.
 */
test('a newer build on disk is reported', () => {
  assert.equal(newerInstalledVersion('1.0.47', ['1.0.47', '1.0.48', '1.0.49', '1.0.51']), '1.0.51');
});

test('the newest is reported, not merely the last one seen', () => {
  assert.equal(newerInstalledVersion('1.0.47', ['1.0.51', '1.0.48']), '1.0.51');
  assert.equal(newerInstalledVersion('1.0.9', ['1.0.10']), '1.0.10', 'ten is after nine');
});

/**
 * Silence is the common case and has to stay silent: a notification every
 * window shows on every start is one nobody reads by the time it matters.
 */
test('nothing is said when the running build is the newest', () => {
  assert.equal(newerInstalledVersion('1.0.57', ['1.0.51', '1.0.57']), null);
  assert.equal(newerInstalledVersion('1.0.57', ['1.0.57']), null);
  assert.equal(newerInstalledVersion('1.0.57', []), null);
});

/** An older copy left behind is the ordinary state of an extensions folder. */
test('an older build left behind says nothing', () => {
  assert.equal(newerInstalledVersion('1.0.57', ['1.0.45', '1.0.47']), null);
});

// ---------- reading the folder ----------------------------------------------

test('every installed copy of this extension is found', () => {
  const dir = extensionsDir({
    [`${ID}-1.0.47`]: '1.0.47',
    [`${ID}-1.0.51-linux-x64`]: '1.0.51',
    [`${ID}-1.0.57`]: '1.0.57',
  });
  const found = installedVersions(path.join(dir, `${ID}-1.0.47`), {
    list: (d) => fs.readdirSync(d),
    version: (m) => JSON.parse(fs.readFileSync(m, 'utf8')).version,
  });
  assert.deepEqual(found, ['1.0.47', '1.0.51', '1.0.57']);
});

/**
 * The version comes from the manifest, never from the folder name. A
 * platform-specific build installs as `...-1.0.51-linux-x64`, and a version
 * parsed off the end of that is "1.0.51-linux-x64" -- which compares correctly
 * only by accident, and stops doing so the moment a target sorts differently.
 */
test('a platform-specific folder reports its real version', () => {
  const dir = extensionsDir({ [`${ID}-1.0.51-linux-x64`]: '1.0.51' });
  const found = installedVersions(path.join(dir, `${ID}-1.0.51-linux-x64`), {
    list: (d) => fs.readdirSync(d),
    version: (m) => JSON.parse(fs.readFileSync(m, 'utf8')).version,
  });
  assert.deepEqual(found, ['1.0.51'], 'not "1.0.51-linux-x64"');
});

test('somebody else’s extension is not ours', () => {
  const dir = extensionsDir({
    [`${ID}-1.0.47`]: '1.0.47',
    'ms-python.python-2026.1.0': '2026.1.0',
    // Named after us, and not us: a prefix match would claim it.
    [`${ID}-extras-9.9.9`]: '9.9.9',
  });
  const found = installedVersions(path.join(dir, `${ID}-1.0.47`), {
    list: (d) => fs.readdirSync(d),
    version: (m) => JSON.parse(fs.readFileSync(m, 'utf8')).version,
  });
  assert.deepEqual(found, ['1.0.47'], '9.9.9 would have prompted a reload forever');
});

// ---------- when the disk will not answer -----------------------------------

/** Half-written during an install, or not ours to read. */
test('a manifest that cannot be read is not a version', () => {
  const dir = extensionsDir({ [`${ID}-1.0.47`]: '1.0.47', [`${ID}-1.0.99`]: null });
  assert.deepEqual(pendingUpgrade(path.join(dir, `${ID}-1.0.47`), '1.0.47'), null);
});

/**
 * A manifest that is there and says nothing useful is the more interesting
 * half: an install writes the file before it writes the contents, so this is
 * what a folder looks like for the moment one is in progress. Inventing a
 * version here would prompt a reload into a half-installed build.
 */
test('a manifest with no usable version is not a version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-newer-bad-'));
  const mk = (name: string, manifest: string): void => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'package.json'), manifest);
  };
  mk(`${ID}-1.0.47`, JSON.stringify({ version: '1.0.47' }));
  mk(`${ID}-1.0.98`, '{}');
  mk(`${ID}-1.0.99`, JSON.stringify({ version: 1.099 }));
  mk(`${ID}-1.1.0`, 'half a file{');
  assert.equal(pendingUpgrade(path.join(dir, `${ID}-1.0.47`), '1.0.47'), null);
});

test('a missing extensions folder is quiet, not broken', () => {
  const gone = path.join(os.tmpdir(), `cp-not-here-${Date.now()}`, `${ID}-1.0.47`);
  assert.equal(pendingUpgrade(gone, '1.0.47'), null, 'a dev host has no folder to read');
});

test('end to end: the folder that cost eight days', () => {
  const dir = extensionsDir({
    [`${ID}-1.0.45-linux-x64`]: '1.0.45',
    [`${ID}-1.0.47`]: '1.0.47',
    [`${ID}-1.0.48`]: '1.0.48',
    [`${ID}-1.0.49-linux-x64`]: '1.0.49',
    [`${ID}-1.0.51-linux-x64`]: '1.0.51',
  });
  assert.equal(pendingUpgrade(path.join(dir, `${ID}-1.0.47`), '1.0.47'), '1.0.51');
  assert.equal(pendingUpgrade(path.join(dir, `${ID}-1.0.51-linux-x64`), '1.0.51'), null);
});
