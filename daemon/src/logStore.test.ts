import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersistedEvent } from '@claude-persist/shared';
import {
  ROTATE_THRESHOLD,
  allLogFiles,
  archiveLogPath,
  listArchiveGenerations,
  loadTailAndCount,
  readLinesSync,
  readRange,
  rotateActiveLog,
} from './logStore.js';

/** A fresh scratch directory per test, cleaned up automatically. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-logstore-test-'));
}

function writeLines(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, lines.map((l) => `${l}\n`).join(''));
}

function persisted(seq: number, text = `event ${seq}`): PersistedEvent {
  return { seq, ts: seq, event: { type: 'assistant_text', text } };
}

function line(event: PersistedEvent): string {
  return JSON.stringify(event);
}

// ---------------------------------------------------------------- readLinesSync

test('readLinesSync: yields each line without the trailing newline', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  writeLines(file, ['one', 'two', 'three']);
  const seen: string[] = [];
  readLinesSync(file, (l) => {
    seen.push(l);
  });
  assert.deepEqual(seen, ['one', 'two', 'three']);
});

test('readLinesSync: a missing file yields nothing (treated as empty, like "no log yet")', () => {
  const dir = tmpDir();
  const seen: string[] = [];
  readLinesSync(path.join(dir, 'does-not-exist.jsonl'), (l) => {
    seen.push(l);
  });
  assert.deepEqual(seen, []);
});

test('readLinesSync: a file with no trailing newline still yields its last line', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'one\ntwo');
  const seen: string[] = [];
  readLinesSync(file, (l) => {
    seen.push(l);
  });
  assert.deepEqual(seen, ['one', 'two']);
});

test('readLinesSync: returning false stops early and closes the file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  writeLines(file, ['one', 'two', 'three', 'four']);
  const seen: string[] = [];
  readLinesSync(file, (l) => {
    seen.push(l);
    if (l === 'two') return false;
  });
  assert.deepEqual(seen, ['one', 'two']);
});

test('readLinesSync: a multi-byte character split across a chunk boundary decodes correctly', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  // "café 🎉" contains a 2-byte and a 4-byte UTF-8 character. A tiny chunk
  // size forces the reader to split its underlying buffer mid-character at
  // least once; only lines are safe split points (newline is never a UTF-8
  // continuation byte), so the decoded text must come out untouched either way.
  const text = 'café 🎉 done';
  writeLines(file, [text, 'second line']);
  const seen: string[] = [];
  readLinesSync(
    file,
    (l) => {
      seen.push(l);
    },
    3, // deliberately smaller than several of the multi-byte sequences above
  );
  assert.deepEqual(seen, [text, 'second line']);
});

// ---------------------------------------------------------------- loadTailAndCount

test('loadTailAndCount: an empty/missing log yields count 0 and an empty tail', () => {
  const dir = tmpDir();
  const { tail, count, perFile } = loadTailAndCount([path.join(dir, 'nope.jsonl')], 10);
  assert.equal(count, 0);
  assert.deepEqual(tail, []);
  assert.deepEqual(perFile, [0]);
});

test('loadTailAndCount: caps the resident tail at maxTail while counting everything', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  const events = Array.from({ length: 25 }, (_, i) => persisted(i));
  writeLines(file, events.map(line));

  const { tail, count } = loadTailAndCount([file], 10);
  assert.equal(count, 25);
  assert.equal(tail.length, 10);
  assert.deepEqual(
    tail.map((e) => e.seq),
    events.slice(-10).map((e) => e.seq),
  );
});

test('loadTailAndCount: a malformed line mid-file is skipped, matching the original loader', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  const lines = [line(persisted(0)), '{not valid json', line(persisted(1)), '', line(persisted(2))];
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const { tail, count } = loadTailAndCount([file], 10);
  assert.equal(count, 3); // the corrupt line and the blank line don't count
  assert.deepEqual(
    tail.map((e) => e.event),
    [persisted(0).event, persisted(1).event, persisted(2).event],
  );
});

test('loadTailAndCount: spans multiple files in order and reports a per-file count', () => {
  const dir = tmpDir();
  const fileA = path.join(dir, 'a.jsonl');
  const fileB = path.join(dir, 'b.jsonl');
  writeLines(fileA, [0, 1, 2].map((i) => line(persisted(i))));
  writeLines(fileB, [3, 4].map((i) => line(persisted(i))));

  const { tail, count, perFile } = loadTailAndCount([fileA, fileB], 100);
  assert.equal(count, 5);
  assert.deepEqual(perFile, [3, 2]);
  assert.deepEqual(
    tail.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
});

// ---------------------------------------------------------------- readRange

test('readRange: start at 0 returns a prefix', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  const events = Array.from({ length: 10 }, (_, i) => persisted(i));
  writeLines(file, events.map(line));

  const out = readRange([file], 0, 4);
  assert.deepEqual(
    out.map((e) => e.seq),
    [0, 1, 2, 3],
  );
});

test('readRange: a mid-file window returns exactly that slice', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  const events = Array.from({ length: 10 }, (_, i) => persisted(i));
  writeLines(file, events.map(line));

  const out = readRange([file], 4, 7);
  assert.deepEqual(
    out.map((e) => e.seq),
    [4, 5, 6],
  );
});

test('readRange: a window past the end of the data returns nothing extra', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  const events = Array.from({ length: 5 }, (_, i) => persisted(i));
  writeLines(file, events.map(line));

  const out = readRange([file], 3, 100);
  assert.deepEqual(
    out.map((e) => e.seq),
    [3, 4],
  );
});

test('readRange: stitches a window that spans an archive and the active file', () => {
  const dir = tmpDir();
  const archive = path.join(dir, 'a.jsonl');
  const active = path.join(dir, 'b.jsonl');
  writeLines(archive, [0, 1, 2, 3, 4].map((i) => line(persisted(i))));
  writeLines(active, [5, 6, 7].map((i) => line(persisted(i))));

  const out = readRange([archive, active], 3, 7);
  assert.deepEqual(
    out.map((e) => e.seq),
    [3, 4, 5, 6],
  );
});

test('readRange: an empty log yields nothing', () => {
  const dir = tmpDir();
  const out = readRange([path.join(dir, 'nope.jsonl')], 0, 10);
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------- rotation

test('rotateActiveLog: renames the active file to generation 1 on first rotation', () => {
  const dir = tmpDir();
  writeLines(path.join(dir, 'sess.jsonl'), [line(persisted(0))]);

  const rotated = rotateActiveLog('sess', dir);
  assert.equal(rotated, true);
  assert.equal(fs.existsSync(path.join(dir, 'sess.jsonl')), false);
  assert.equal(fs.existsSync(archiveLogPath('sess', 1, dir)), true);
});

test('rotateActiveLog: generations increment and never overwrite an earlier archive', () => {
  const dir = tmpDir();
  writeLines(path.join(dir, 'sess.jsonl'), [line(persisted(0))]);
  assert.equal(rotateActiveLog('sess', dir), true);

  writeLines(path.join(dir, 'sess.jsonl'), [line(persisted(1))]);
  assert.equal(rotateActiveLog('sess', dir), true);

  assert.deepEqual(listArchiveGenerations('sess', dir), [1, 2]);
  // Both archives still exist and are individually readable — nothing lost.
  assert.deepEqual(
    fs.readFileSync(archiveLogPath('sess', 1, dir), 'utf8').trim(),
    line(persisted(0)),
  );
  assert.deepEqual(
    fs.readFileSync(archiveLogPath('sess', 2, dir), 'utf8').trim(),
    line(persisted(1)),
  );
});

test('rotateActiveLog: no active file to rotate returns false and touches nothing', () => {
  const dir = tmpDir();
  assert.equal(rotateActiveLog('nope', dir), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('allLogFiles: lists archives oldest-first, active file last, even if the active file does not exist yet', () => {
  const dir = tmpDir();
  writeLines(path.join(dir, 'sess.jsonl'), [line(persisted(0))]);
  rotateActiveLog('sess', dir); // -> sess.jsonl.1, no active file remains
  writeLines(path.join(dir, 'sess.jsonl'), [line(persisted(1))]);
  rotateActiveLog('sess', dir); // -> sess.jsonl.2, no active file remains

  const files = allLogFiles('sess', dir);
  assert.deepEqual(files, [
    archiveLogPath('sess', 1, dir),
    archiveLogPath('sess', 2, dir),
    path.join(dir, 'sess.jsonl'),
  ]);
});

test('ROTATE_THRESHOLD is a sane positive bound', () => {
  assert.ok(ROTATE_THRESHOLD > 0);
});
