import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_READ_BYTES, listDirectory, looksLikeText, readFileSlice } from './fsView.js';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-fs-'));
  fs.mkdirSync(path.join(root, 'zeta-dir'));
  fs.mkdirSync(path.join(root, 'alpha-dir'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'hello\nworld\n');
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.from([0, 1, 2, 255]));
  fs.symlinkSync(path.join(root, 'alpha-dir'), path.join(root, 'link-to-dir'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'broken-link'));
  return root;
}

test('list: directories first, then files, each alphabetically', () => {
  const root = tree();
  const names = listDirectory(root).entries.map((e) => e.name);
  assert.deepEqual(names, ['alpha-dir', 'link-to-dir', 'zeta-dir', 'a.bin', 'b.txt', 'broken-link']);
});

test('list: links say where they point and what that is', () => {
  const root = tree();
  const byName = Object.fromEntries(listDirectory(root).entries.map((e) => [e.name, e]));
  assert.equal(byName['link-to-dir'].kind, 'link');
  assert.equal(byName['link-to-dir'].targetKind, 'dir');
  assert.equal(byName['broken-link'].targetKind, 'missing');
});

test('list: the parent is given, and the root has none', () => {
  const root = tree();
  assert.equal(listDirectory(root).parent, path.dirname(root));
  assert.equal(listDirectory('/').parent, null);
});

test('list: a relative path is refused rather than resolved against the daemon cwd', () => {
  assert.throws(() => listDirectory('etc'), /absolute/);
});

test('read: text comes back as text', () => {
  const root = tree();
  const r = readFileSlice(path.join(root, 'b.txt'));
  assert.equal(r.encoding, 'utf8');
  assert.equal(r.data, 'hello\nworld\n');
  assert.equal(r.eof, true);
});

test('read: binary comes back as base64', () => {
  const root = tree();
  const r = readFileSlice(path.join(root, 'a.bin'));
  assert.equal(r.encoding, 'base64');
  assert.deepEqual(Buffer.from(r.data, 'base64'), Buffer.from([0, 1, 2, 255]));
});

/** One huge response never finishes on a bad network; pages do. */
test('read: a large file comes in pages, and resumes where it stopped', () => {
  const root = tree();
  const big = path.join(root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(MAX_READ_BYTES + 1000));
  const first = readFileSlice(big, 0, 10 * MAX_READ_BYTES);
  assert.equal(first.length, MAX_READ_BYTES, 'capped, whatever was asked for');
  assert.equal(first.eof, false);
  const second = readFileSlice(big, first.offset + first.length);
  assert.equal(second.length, 1000);
  assert.equal(second.eof, true);
});

test('read: a directory is not a file', () => {
  assert.throws(() => readFileSlice(tree()), /directory/);
});

test('text detection: NUL means binary, a cut multibyte character does not', () => {
  assert.equal(looksLikeText(Buffer.from('plain')), true);
  assert.equal(looksLikeText(Buffer.from([104, 0, 105])), false);
  const cut = Buffer.from('привет', 'utf8').subarray(0, 5); // ends mid-character
  assert.equal(looksLikeText(cut), true);
});
