import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dirsInUse, dirsInUseBySession } from './activeDirs';

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

// ---------------------------------------------------------------------------
// Whose worktree is it
//
// "Is anyone working here" cannot tell two conversations apart, so every
// session in a repository listed every other session's worktrees as its own.
// The daemon stamps its session id onto the CLI it launches; the processes
// inside a worktree therefore say whose it is.
// ---------------------------------------------------------------------------

/** A /proc where each process has a cwd and, optionally, a session tag. */
function taggedProc(procs: Record<string, { cwd: string; session?: string }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-proc-'));
  for (const [pid, { cwd, session }] of Object.entries(procs)) {
    fs.mkdirSync(path.join(root, pid));
    fs.symlinkSync(cwd, path.join(root, pid, 'cwd'));
    const env = ['PATH=/usr/bin', ...(session ? [`CLAUDE_PERSIST_SESSION=${session}`] : []), ''];
    fs.writeFileSync(path.join(root, pid, 'environ'), env.join('\0'));
  }
  return root;
}

test('a worktree is attributed to the session working in it', () => {
  const proc = taggedProc({
    '1': { cwd: '/wt/alpha', session: 'sess-a' },
    '2': { cwd: '/wt/beta', session: 'sess-b' },
  });
  const owners = dirsInUseBySession(['/wt/alpha', '/wt/beta'], proc);
  assert.deepEqual([...(owners.get('/wt/alpha') ?? [])], ['sess-a']);
  assert.deepEqual([...(owners.get('/wt/beta') ?? [])], ['sess-b']);
});

test("two sessions in one repository do not inherit each other's worktrees", () => {
  const proc = taggedProc({
    '1': { cwd: '/wt/alpha/src', session: 'sess-a' },
    '2': { cwd: '/wt/beta', session: 'sess-b' },
    '3': { cwd: '/wt/gamma', session: 'sess-b' },
  });
  const owners = dirsInUseBySession(['/wt/alpha', '/wt/beta', '/wt/gamma'], proc);
  const mine = [...owners].filter(([, s]) => s.has('sess-b')).map(([dir]) => dir);
  assert.deepEqual(mine.sort(), ['/wt/beta', '/wt/gamma']);
});

/**
 * A process with no tag was not launched by this daemon -- a terminal the user
 * opened there, say. It is still work in the worktree, so it is reported, and
 * the caller decides; claiming it for one session would be a guess.
 */
test('an untagged process marks the worktree busy but claims it for nobody', () => {
  const proc = taggedProc({ '1': { cwd: '/wt/alpha' } });
  const owners = dirsInUseBySession(['/wt/alpha'], proc);
  assert.equal(owners.has('/wt/alpha'), true);
  assert.equal(owners.get('/wt/alpha')?.size, 0);
});

test('several sessions in one worktree are all recorded', () => {
  const proc = taggedProc({
    '1': { cwd: '/wt/alpha', session: 'sess-a' },
    '2': { cwd: '/wt/alpha/deep', session: 'sess-b' },
  });
  assert.deepEqual([...(dirsInUseBySession(['/wt/alpha'], proc).get('/wt/alpha') ?? [])].sort(), [
    'sess-a',
    'sess-b',
  ]);
});

test('an unreadable environ leaves the worktree unattributed, not missing', () => {
  const proc = taggedProc({ '1': { cwd: '/wt/alpha', session: 'sess-a' } });
  fs.rmSync(path.join(proc, '1', 'environ'));
  const owners = dirsInUseBySession(['/wt/alpha'], proc);
  assert.equal(owners.has('/wt/alpha'), true);
  assert.equal(owners.get('/wt/alpha')?.size, 0);
});
