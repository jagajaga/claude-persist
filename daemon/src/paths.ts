import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const baseDir = path.join(os.homedir(), '.claude-persist');
export const socketPath = path.join(baseDir, 'daemon.sock');
/** Holds the owning pid; created with O_EXCL so only one daemon can win it. */
export const lockPath = path.join(baseDir, 'daemon.lock');
export const registryPath = path.join(baseDir, 'registry.json');
export const sessionsDir = path.join(baseDir, 'sessions');
export const logPath = path.join(baseDir, 'daemon.log');

export function ensureDirs(): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

export function sessionLogPath(sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}

/**
 * A turn parked waiting for a rate limit to reset.
 *
 * Deliberately NOT in registry.json: the payload can carry base64 image
 * attachments, and the registry is rewritten in full on every single message.
 * One parked screenshot would bloat every subsequent write.
 */
export function pendingTurnPath(sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.pending.json`);
}

/** Session ids that have a parked turn on disk, for rescheduling at startup. */
export function pendingTurnSessionIds(): string[] {
  try {
    return fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.pending.json'))
      .map((f) => f.slice(0, -'.pending.json'.length));
  } catch {
    return [];
  }
}
