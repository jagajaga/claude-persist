import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const baseDir = path.join(os.homedir(), '.claude-persist');
export const socketPath = path.join(baseDir, 'daemon.sock');
export const registryPath = path.join(baseDir, 'registry.json');
export const sessionsDir = path.join(baseDir, 'sessions');
export const logPath = path.join(baseDir, 'daemon.log');

export function ensureDirs(): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

export function sessionLogPath(sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}
