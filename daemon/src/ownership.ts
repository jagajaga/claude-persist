// Deciding whether this process gets to be *the* daemon.
//
// The lock file (see lock.ts) is the atomic primitive, but the lock alone is not
// sufficient evidence that a daemon is usable. A daemon can hold the lock while
// its socket is gone: builds up to and including 0.7.32 unlink socketPath
// unconditionally on shutdown, so an older daemon exiting during an upgrade
// deletes its *successor's* socket. The successor then keeps the lock, listens
// on an unlinked inode nobody can reach, and every replacement exits "daemon
// already running" — a permanent wedge that only a manual kill clears. Observed
// in the wild, which is why this file exists.
//
// So: trust the lock, but verify the holder is actually answering.
import fs from 'node:fs';
import net from 'node:net';
import { PROTOCOL_VERSION } from '@claude-persist/shared';
import { acquireLock, isAlive, readLock } from './lock.js';

const DEFAULT_PROBE_MS = 2000;
const DEFAULT_GRACE_MS = 2000;

/**
 * Is a daemon actually answering on this socket?
 *
 * Deliberately stronger than "does the socket file exist" and than "can I
 * connect": it sends `hello` and waits for a reply, so a listener that accepts
 * connections but never responds (a daemon wedged in synchronous work) also
 * reads as not serving. Anything less and we would defer to a process that can
 * never serve a request.
 */
export function socketServing(socketPath: string, timeoutMs = DEFAULT_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = net.connect(socketPath);
    const finish = (serving: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(serving);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 0, op: 'hello', protocolVersion: PROTOCOL_VERSION })}\n`);
    });
    socket.once('data', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

export interface ClaimOptions {
  lockFile: string;
  socketPath: string;
  pid?: number;
  /** How long to let a displaced owner release the lock itself before forcing it. */
  graceMs?: number;
  probeMs?: number;
  log?: (message: string) => void;
}

/**
 * Become the daemon, or return false because a working one already exists.
 *
 * Takes the lock outright when it is free or stale. When it is held by a live
 * process, defers only if that process is genuinely serving; otherwise stops it,
 * clears the lock and takes over. That last path is what makes the wedge
 * self-clearing instead of needing a human with `kill`.
 */
export async function claimOwnership(opts: ClaimOptions): Promise<boolean> {
  const { lockFile, socketPath, pid = process.pid, graceMs = DEFAULT_GRACE_MS, probeMs } = opts;
  const log = opts.log ?? ((): void => undefined);

  if (acquireLock(lockFile, pid)) return true;

  const owner = Number(readLock(lockFile));
  if (await socketServing(socketPath, probeMs)) {
    log(`daemon already running (pid ${owner || 'unknown'}) and serving, exiting`);
    return false;
  }

  log(`lock held by pid ${owner || 'unknown'} but nothing is serving ${socketPath} — taking over`);
  if (owner && owner !== pid && isAlive(owner)) {
    try {
      process.kill(owner, 'SIGTERM');
    } catch {
      // already gone, or not ours to signal — the lock steal below still applies
    }
    // Prefer letting it release the lock itself: its own shutdown also closes
    // SDK queries, so stealing the lock out from under it would orphan them.
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && readLock(lockFile) === String(owner)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (readLock(lockFile) === String(owner)) {
    log(`pid ${owner} did not release the lock in time — clearing it`);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // someone else cleared it first
    }
  }
  return acquireLock(lockFile, pid);
}
