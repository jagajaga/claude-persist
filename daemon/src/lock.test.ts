import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, isAlive, readLock, releaseLock } from './lock.js';

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
  assert.equal(readLock(file), '4242');
});

/**
 * The whole point of the lock: the second daemon must lose. Before this, two
 * daemons could both bind the socket and then race whole-file registry writes.
 */
test('acquireLock: loses to a live owner', () => {
  const file = lockFile();
  assert.equal(acquireLock(file, process.pid), true);
  assert.equal(acquireLock(file, process.pid + 1), false);
  assert.equal(readLock(file), String(process.pid)); // loser must not overwrite it
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
  assert.equal(readLock(file), '777');
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
  assert.equal(readLock(file), '999');
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
  assert.equal(readLock(file), '1234');
});

test('releaseLock: a missing lock file is not an error', () => {
  releaseLock(lockFile(), process.pid);
});
