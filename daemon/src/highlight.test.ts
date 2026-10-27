import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_HIGHLIGHT_BYTES, highlightFile, languageFor } from './highlight.js';

const known = (l: string) => ['kotlin', 'typescript', 'docker', 'make', 'python', 'text', 'json', 'shellscript'].includes(l);
const write = (name: string, body: string) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-hl-')), name);
  fs.writeFileSync(file, body);
  return file;
};

test('language: by extension, by well-known name, text when unknown', () => {
  assert.equal(languageFor('/w/Main.kt', known), 'kotlin');
  assert.equal(languageFor('/w/build.gradle.kts', known), 'kotlin');
  assert.equal(languageFor('/w/app.ts', known), 'typescript');
  assert.equal(languageFor('/w/Dockerfile', known), 'docker');
  assert.equal(languageFor('/w/Makefile', known), 'make');
  assert.equal(languageFor('/w/run.sh', known), 'shellscript');
  assert.equal(languageFor('/w/notes.weird', known), 'text');
  assert.equal(languageFor('/w/README', known), 'text');
});

test('highlight: a TypeScript file comes back as coloured spans, line by line', async () => {
  const file = write('a.ts', 'const answer: number = 42;\n// done\n');
  const h = await highlightFile(file);
  assert.equal(h.language, 'typescript');
  assert.equal(h.theme, 'light-plus');
  assert.ok(h.lines.length >= 2);
  assert.equal(h.lines[0].map((s) => s[0]).join(''), 'const answer: number = 42;');
  const colours = new Set(h.lines[0].map((s) => s[1]));
  assert.ok(colours.size >= 3, `keyword, name and number differ: ${[...colours].join(' ')}`);
  assert.ok(h.lines[1].some((s) => s[1] !== null), 'the comment is coloured');
  assert.equal(h.truncated, false);
});

test('highlight: same-coloured neighbours are merged into one span', async () => {
  const h = await highlightFile(write('a.txt', 'plain words with nothing to colour\n'));
  assert.equal(h.language, 'text');
  assert.equal(h.lines[0].length, 1);
});

test('highlight: a huge file is coloured from its start, in whole lines', async () => {
  const line = 'x = 1\n';
  const h = await highlightFile(write('big.py', line.repeat(Math.ceil((MAX_HIGHLIGHT_BYTES * 1.2) / line.length))));
  assert.equal(h.truncated, true);
  assert.ok(h.lines.every((l) => l.map((s) => s[0]).join('') === 'x = 1'), 'no half line at the cut');
});

test('highlight: relative paths and folders are refused', async () => {
  await assert.rejects(highlightFile('rel/a.ts'), /absolute/);
  await assert.rejects(highlightFile(os.tmpdir()), /Not a file/);
});
