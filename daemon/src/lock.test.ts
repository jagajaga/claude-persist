import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  holderIsIdentified,
  holderIsRunning,
  isAlive,
  processStartTime,
  readLockHolder,
  releaseLock,
} from './lock.js';

function lockFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lock-test-')), 'daemon.lock');
}

/** A pid that definitely isn't running, found rather than guessed. */
function deadPid(): number {
  for (let pid = 2 ** 22 - 1; pid > 1000; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find an unused pid on this machine');
}

test('isAlive: true for this process, false for a pid that is gone', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(deadPid()), false);
});

test('acquireLock: a fresh lock is taken and records the owning pid', () => {
  const file = lockFile();
  assert.equal(acquireLock(file, 4242), true);
  assert.equal(readLockHolder(file)?.pid, 4242);
});

/**
 * The whole point of the lock: the second daemon must lose. Before this, two
 * daemons could both bind the socket and then race whole-file registry writes.
 */
test('acquireLock: loses to a live owner', () => {
  const file = lockFile();
  assert.equal(acquireLock(file, process.pid), true);
  assert.equal(acquireLock(file, process.pid + 1), false);
  assert.equal(readLockHolder(file)?.pid, process.pid); // loser must not overwrite it
});

/**
 * A daemon that was SIGKILLed never runs its shutdown, so it leaves the lock
 * behind. If a stale lock were permanent, one crash would wedge every future
 * daemon out for good.
 */
test('acquireLock: clears a stale lock left by a dead owner and takes it', () => {
  const file = lockFile();
  fs.writeFileSync(file, String(deadPid()));
  assert.equal(acquireLock(file, 777), true);
  assert.equal(readLockHolder(file)?.pid, 777);
});

test('acquireLock: a lock recording our own pid is re-taken, not treated as a rival', () => {
  const file = lockFile();
  fs.writeFileSync(file, String(process.pid));
  assert.equal(acquireLock(file, process.pid), true);
});

test('acquireLock: garbage in the lock file is treated as stale', () => {
  const file = lockFile();
  fs.writeFileSync(file, 'not-a-pid');
  assert.equal(acquireLock(file, 999), true);
  assert.equal(readLockHolder(file)?.pid, 999);
});

test('releaseLock: removes our own lock', () => {
  const file = lockFile();
  acquireLock(file, 555);
  releaseLock(file, 555);
  assert.equal(fs.existsSync(file), false);
});

/**
 * The mirror of the socket-unlink bug: a daemon exiting slowly during an
 * upgrade must not delete the lock its replacement now holds.
 */
test('releaseLock: leaves a successor\'s lock alone', () => {
  const file = lockFile();
  acquireLock(file, 1234); // the successor
  releaseLock(file, 999); // the slow predecessor exiting
  assert.equal(readLockHolder(file)?.pid, 1234);
});

test('releaseLock: a missing lock file is not an error', () => {
  releaseLock(lockFile(), process.pid);
});

// ---------- a pid is not an identity -----------------------------------------
//
// The lock file lives in ~/.claude-persist and outlives the container that
// wrote it. Pid numbers do not: a PID namespace hands them out from the bottom
// again on every restart, and this container has given the daemon 308 and 332
// on consecutive boots while the extension host got 80 and 84. A pid left
// behind by the last boot therefore names some *unrelated* live process in this
// one -- and reading that as "the daemon is alive" is what made the takeover
// path SIGTERM an innocent one.

/** A /proc that a test can write into. */
function fakeProc(entries: Record<number, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-proc-'));
  for (const [pid, starttime] of Object.entries(entries)) {
    fs.mkdirSync(path.join(root, pid));
    // Real shape: "<pid> (<comm>) <state> ..." with starttime at field 22.
    const fields = Array.from({ length: 50 }, (_, i) => String(i));
    fields[19] = starttime; // field 22 overall
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (node) ${fields.join(' ')}\n`);
  }
  return root;
}

test('start time is read from the right field, even for an odd executable name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-proc-odd-'));
  fs.mkdirSync(path.join(root, '7'));
  const fields = Array.from({ length: 50 }, (_, i) => String(i));
  fields[19] = '998877';
  // An executable really can be called this, and splitting the whole line on
  // spaces would then count every field from the wrong place.
  fs.writeFileSync(path.join(root, '7', 'stat'), `7 (my (weird) name) ${fields.join(' ')}\n`);
  assert.equal(processStartTime(7, root), '998877');
});

test('an unreadable /proc entry is "cannot tell", not a value', () => {
  const root = fakeProc({ 7: '123' });
  assert.equal(processStartTime(9999, root), null, 'no such process');
  assert.equal(processStartTime(7, path.join(root, 'nope')), null, 'no such /proc');
});

test('the lock records who took it, not merely that someone did', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lock-id-'));
  const file = path.join(dir, 'daemon.lock');
  assert.equal(acquireLock(file, process.pid), true);
  const holder = readLockHolder(file);
  assert.equal(holder?.pid, process.pid);
  assert.equal(
    holder?.startedAt,
    processStartTime(process.pid),
    'without this the number alone is all a later boot has to go on',
  );
});

test('a lock from a previous boot is not its successor, even at the same pid', () => {
  // The exact shape of the outage: pid 308 wrote the lock last boot; pid 308
  // exists again this boot and is somebody else entirely.
  const lastBoot = { pid: 308, startedAt: '1000' };
  const thisBoot = fakeProc({ 308: '9999' });
  assert.equal(
    processStartTime(lastBoot.pid, thisBoot),
    '9999',
    'same number, different process',
  );
  assert.notEqual(processStartTime(lastBoot.pid, thisBoot), lastBoot.startedAt);
});

test('a holder that cannot be identified is never signalled', () => {
  // A lock with no start time in it -- written by a build from before this.
  assert.equal(holderIsIdentified({ pid: process.pid, startedAt: null }), false);
  // And one that is provably us.
  assert.equal(
    holderIsIdentified({ pid: process.pid, startedAt: processStartTime(process.pid) }),
    true,
  );
  // A live pid whose start time disagrees: the number was reissued.
  assert.equal(holderIsIdentified({ pid: process.pid, startedAt: '1' }), false);
});

test('a legacy lock still reads as held, so nothing stampedes over a live daemon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lock-legacy-'));
  const file = path.join(dir, 'daemon.lock');
  fs.writeFileSync(file, String(process.pid)); // old format: pid alone
  const holder = readLockHolder(file);
  assert.equal(holder?.startedAt, null);
  assert.equal(holderIsRunning(holder), true, 'we cannot tell, so we assume it lives');
  assert.equal(holderIsIdentified(holder), false, 'but it is not proven, so never signal it');
});

test('a dead pid is neither running nor identified', () => {
  const dead = 0x7ffffff; // far above any real pid on these systems
  assert.equal(holderIsRunning({ pid: dead, startedAt: '1' }), false);
  assert.equal(holderIsIdentified({ pid: dead, startedAt: '1' }), false);
});

test('garbage in the lock file is not a holder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lock-junk-'));
  const file = path.join(dir, 'daemon.lock');
  for (const junk of ['', '   ', 'not-a-pid', '0', '-3']) {
    fs.writeFileSync(file, junk);
    assert.equal(readLockHolder(file), null, `"${junk}" is not a lock holder`);
  }
});
