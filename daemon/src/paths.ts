import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const baseDir = path.join(os.homedir(), '.claude-persist');

/**
 * Where clients connect.
 *
 * Windows has no unix domain socket in the filesystem. A named pipe lives in
 * its own namespace instead: it has no inode, cannot be chmod'ed, and cannot be
 * unlinked — so every filesystem operation the unix path performs on the socket
 * has to be skipped there (see `socketIsFile`). The name is derived from the
 * home directory so that, exactly as the per-user ~/.claude-persist does on
 * unix, two users on one machine get two daemons rather than fighting over one.
 */
export const socketPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\claude-persist-${pipeSuffix(os.homedir())}`
    : path.join(baseDir, 'daemon.sock');

/**
 * True when `socketPath` names a real file — the only case where it can be
 * stat'ed, chmod'ed or unlinked, and the only case where inode identity (which
 * the self-heal watch depends on) means anything.
 */
export const socketIsFile = process.platform !== 'win32';

/** A short, filename-safe digest of the home directory. */
function pipeSuffix(home: string): string {
  let hash = 0;
  for (let i = 0; i < home.length; i++) hash = (Math.imul(hash, 31) + home.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
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

/** Opt-in switch for the mobile gateway: `{ "port": 7790 }`. */
export const gatewayConfigPath = path.join(baseDir, 'gateway.json');

/**
 * The port the mobile gateway should listen on, or null to not start it.
 *
 * Off unless asked for: it is a network listener, and the editor -- the only
 * client most people have -- never needs one. An environment variable wins
 * over the file so a one-off run can try it without touching the setting.
 */
export function gatewayPort(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: () => string = () => fs.readFileSync(gatewayConfigPath, 'utf8'),
): number | null {
  const valid = (n: unknown): number | null =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  const fromEnv = (env.CLAUDE_PERSIST_GATEWAY_PORT ?? '').trim();
  if (fromEnv) return valid(Number(fromEnv));
  try {
    return valid((JSON.parse(readConfig()) as { port?: unknown }).port);
  } catch {
    return null;
  }
}

/**
 * Whether to protect the way in under memory pressure (see rescue.ts):
 * `{ "port": 7790, "protect": true }`. Off unless asked for, because it uses sudo.
 */
export function gatewayProtect(readConfig: () => string = () => fs.readFileSync(gatewayConfigPath, 'utf8')): boolean {
  try {
    return (JSON.parse(readConfig()) as { protect?: unknown }).protect === true;
  } catch {
    return false;
  }
}
