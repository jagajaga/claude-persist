// Single-instance ownership for the daemon.
//
// This replaces a probe-then-unlink-then-listen dance that was racy in both
// directions. Two daemons starting together could both see "no live socket",
// both unlink it, and both listen() successfully — unlink drops the other's
// bound path, so the second bind never saw EADDRINUSE. Two daemons then
// appended to the same session logs and raced whole-file registry writes, where
// the loser's copy silently won and sessions vanished from the sidebar.
//
// O_EXCL file creation is the atomic primitive that makes this actually
// exclusive, and it's what `wx` maps to.
import fs from 'node:fs';
import { lockPath as defaultLockPath } from './paths.js';

/** The pid recorded in the lock file, or '' if unreadable/absent. */
export function readLock(lockFile: string = defaultLockPath): string {
  try {
    return fs.readFileSync(lockFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Does this pid exist? EPERM means it does — it just belongs to another user,
 * which is exactly the shared-home case where we must NOT assume it's dead.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take exclusive ownership, or return false because someone else holds it.
 *
 * A lock left behind by a SIGKILLed daemon is cleared and retried once —
 * without that, one crash would wedge every future daemon out permanently.
 */
export function acquireLock(lockFile: string = defaultLockPath, pid = process.pid): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, String(pid));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = Number(readLock(lockFile));
    if (owner && owner !== pid && isAlive(owner)) return false;
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // another daemon cleared it first; the retry finds out who won
    }
  }
  return false;
}

/** Release only if we still own it — never delete a successor's lock. */
export function releaseLock(lockFile: string = defaultLockPath, pid = process.pid): void {
  try {
    if (readLock(lockFile) === String(pid)) fs.unlinkSync(lockFile);
  } catch {
    // best effort
  }
}
