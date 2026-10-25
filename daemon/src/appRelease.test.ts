import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appRelease } from './appRelease.js';

const view = JSON.stringify({ tagName: 'v0.1.20', assets: [{ name: 'notes.txt', size: 3 }, { name: 'claude-persist-0.1.20.apk', size: 5 }] });

function fakeGh(dir: string) {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return view;
    const out = args[args.indexOf('--dir') + 1];
    fs.writeFileSync(path.join(out, args[args.indexOf('--pattern') + 1]), 'apk!!');
    return '';
  };
  return { calls, run, dir };
}

test('asking only says what is newest, and downloads nothing', async () => {
  const gh = fakeGh(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-app-')));
  const r = await appRelease({ dir: gh.dir }, gh.run);
  assert.deepEqual(r, { tag: 'v0.1.20', version: '0.1.20', name: 'claude-persist-0.1.20.apk', size: 5 });
  assert.equal(gh.calls.length, 1);
});

test('download puts the APK where /file can serve it, once', async () => {
  const gh = fakeGh(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-app-')));
  const r = await appRelease({ dir: gh.dir, download: true }, gh.run);
  assert.equal(fs.readFileSync(r.path!, 'utf8'), 'apk!!');
  await appRelease({ dir: gh.dir, download: true }, gh.run);
  assert.equal(gh.calls.filter((c) => c[1] === 'download').length, 1, 'already here: not fetched again');
});

test('a release without an APK is an error, not a silent nothing', async () => {
  const run = async () => JSON.stringify({ tagName: 'v1', assets: [] });
  await assert.rejects(appRelease({ dir: os.tmpdir() }, run), /no APK/);
});

test('names that could escape the folder are refused', async () => {
  const run = async () => JSON.stringify({ tagName: '../../x', assets: [{ name: 'a.apk', size: 1 }] });
  await assert.rejects(appRelease({ dir: os.tmpdir(), download: true }, run), /unexpected/);
});
