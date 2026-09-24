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
//
// A pid on its own is not an identity. The lock file outlives the process that
// wrote it -- it is in ~/.claude-persist, which survives a container restart --
// while pid numbers are handed out again from the bottom every time a PID
// namespace starts. In this container the daemon has been pid 308 and pid 332
// on consecutive boots, and the extension host has been 80 and 84: small
// numbers, reassigned in roughly the same order, so a pid left in the lock by a
// previous boot very often names some *other* live process in this one. Read as
// "the daemon is alive", that number made the takeover path SIGTERM whatever
// innocent process had inherited it.
//
// So the lock records pid *and* the process's start time, which together do
// identify one process instance: the kernel counts starttime from boot, so the
// same number in a later namespace carries a different one.
import fs from 'node:fs';
import { lockPath as defaultLockPath } from './paths.js';

export interface LockHolder {
  pid: number;
  /**
   * Field 22 of /proc/<pid>/stat, as written. Null when this lock predates the
   * field, or the platform has no /proc to read it from -- "we cannot tell",
   * which callers must not confuse with "it matches".
   */
  startedAt: string | null;
}

/**
 * When a process began, in clock ticks since boot, or null if unknowable.
 *
 * Counted from boot rather than wall clock, so it stays comparable across a
 * container restart and cannot be spoofed by the clock moving. Fields are taken
 * from the last ')' rather than by splitting the whole line, because field 2 is
 * the executable name and an executable may be called `my (weird) name`.
 */
export function processStartTime(pid: number, procRoot = '/proc'): string | null {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    // Everything after "<pid> (<comm>) " begins at field 3, the state.
    const fields = stat.slice(close + 2).split(' ');
    const started = fields[19]; // field 22 overall
    return started !== undefined && /^\d+$/.test(started) ? started : null;
  } catch {
    return null;
  }
}

/** The raw contents of the lock file, or '' if unreadable/absent. */
export function readLock(lockFile: string = defaultLockPath): string {
  try {
    return fs.readFileSync(lockFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/** What the lock file says, or null when there is nothing readable in it. */
export function readLockHolder(lockFile: string = defaultLockPath): LockHolder | null {
  const [pidText, startedAt] = readLock(lockFile).split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startedAt: startedAt && /^\d+$/.test(startedAt) ? startedAt : null };
}

/** What this process should write, so a later boot can tell it apart. */
export function lockText(pid = process.pid): string {
  const startedAt = processStartTime(pid);
  return startedAt ? `${pid} ${startedAt}` : String(pid);
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
 * Is the process that wrote this lock still running?
 *
 * Not "is something running under that number". A recorded start time that does
 * not match the process now holding the pid means the writer is gone and its
 * number has been reissued, which is the ordinary state of affairs one
 * container restart later.
 */
export function holderIsRunning(holder: LockHolder | null): boolean {
  if (!holder) return false;
  if (!isAlive(holder.pid)) return false;
  // Nothing recorded: an older daemon wrote this. Treated as alive, as it
  // always was -- but callers must not signal it, since it cannot be identified.
  if (holder.startedAt === null) return true;
  return processStartTime(holder.pid) === holder.startedAt;
}

/** True only when the holder is running *and* provably the process we think. */
export function holderIsIdentified(holder: LockHolder | null): boolean {
  return holder?.startedAt != null && holderIsRunning(holder);
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
        fs.writeSync(fd, lockText(pid));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readLockHolder(lockFile);
    if (holder && holder.pid !== pid && holderIsRunning(holder)) return false;
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
    if (readLockHolder(lockFile)?.pid === pid) fs.unlinkSync(lockFile);
  } catch {
    // best effort
  }
}
