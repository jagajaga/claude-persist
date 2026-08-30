import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dirsInUse } from './activeDirs';

/** A stand-in /proc: one numbered directory per process, each with a cwd link. */
function fakeProc(cwds: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-proc-'));
  for (const [pid, cwd] of Object.entries(cwds)) {
    fs.mkdirSync(path.join(root, pid));
    fs.symlinkSync(cwd, path.join(root, pid, 'cwd'));
  }
  // Real /proc is full of non-numeric entries; they must not be walked.
  fs.mkdirSync(path.join(root, 'sys'));
  fs.writeFileSync(path.join(root, 'uptime'), '1 1');
  return root;
}

test('a directory with a process in it is in use', () => {
  const proc = fakeProc({ '1': '/wt/alpha', '2': '/elsewhere' });
  assert.deepEqual(dirsInUse(['/wt/alpha', '/wt/beta'], proc), ['/wt/alpha']);
});

test('a process deeper inside counts, since that is still working there', () => {
  const proc = fakeProc({ '1': '/wt/alpha/src/server' });
  assert.deepEqual(dirsInUse(['/wt/alpha'], proc), ['/wt/alpha']);
});

/** /wt/alpha must not be reported because something is in /wt/alpha-old. */
test('matching happens on a path boundary, not a string prefix', () => {
  const proc = fakeProc({ '1': '/wt/alpha-old' });
  assert.deepEqual(dirsInUse(['/wt/alpha'], proc), []);
});

test('several processes in one directory report it once', () => {
  const proc = fakeProc({ '1': '/wt/alpha', '2': '/wt/alpha/src', '3': '/wt/beta' });
  assert.deepEqual(dirsInUse(['/wt/alpha', '/wt/beta'], proc), ['/wt/alpha', '/wt/beta']);
});

test('nothing running anywhere is an empty answer, not an error', () => {
  const proc = fakeProc({ '1': '/somewhere/else' });
  assert.deepEqual(dirsInUse(['/wt/alpha'], proc), []);
});

/**
 * A process can exit between listing /proc and reading its cwd, and on any
 * host there are processes whose cwd cannot be read at all. Neither may throw.
 */
test('unreadable and vanished processes are skipped', () => {
  const proc = fakeProc({ '1': '/wt/alpha' });
  fs.mkdirSync(path.join(proc, '999')); // no cwd link at all
  assert.deepEqual(dirsInUse(['/wt/alpha'], proc), ['/wt/alpha']);
});

/** Hosts without /proc get fewer results than the truth, never a crash. */
test('a missing /proc is an empty answer', () => {
  assert.deepEqual(dirsInUse(['/wt/alpha'], '/no/such/proc'), []);
});

test('asking about nothing does not read /proc at all', () => {
  assert.deepEqual(dirsInUse([], '/no/such/proc'), []);
});
