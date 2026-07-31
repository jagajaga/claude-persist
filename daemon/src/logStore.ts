import fs from 'node:fs';
import path from 'node:path';
import type { PersistedEvent } from '@claude-persist/shared';
import { sessionsDir, sessionLogPath } from './paths.js';

/**
 * On-disk storage for a session's transcript, read on demand instead of held
 * resident. The active file is `<id>.jsonl` (unchanged format/path, so
 * existing transcripts keep working untouched). Once it grows past
 * ROTATE_THRESHOLD events it is renamed to an archive generation
 * `<id>.jsonl.<n>` and a fresh empty active file takes its place — bounding
 * the size of any single file this module has to scan, without discarding
 * history: every archive stays on disk and stays readable.
 */

/** Events per generation before the active log is rotated to an archive. */
export const ROTATE_THRESHOLD = 2000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `dir` defaults to the real sessions directory in every exported function
 * below; tests inject a temp directory instead so they never touch
 * ~/.claude-persist.
 */
export function archiveLogPath(sessionId: string, gen: number, dir: string = sessionsDir): string {
  return path.join(dir, `${sessionId}.jsonl.${gen}`);
}

function activeLogPath(sessionId: string, dir: string): string {
  return dir === sessionsDir ? sessionLogPath(sessionId) : path.join(dir, `${sessionId}.jsonl`);
}

/** Existing archive generations for a session, oldest (lowest) first. */
export function listArchiveGenerations(sessionId: string, dir: string = sessionsDir): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${escapeRegExp(sessionId)}\\.jsonl\\.(\\d+)$`);
  const gens: number[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) gens.push(Number(m[1]));
  }
  return gens.sort((a, b) => a - b);
}

/** All log files for a session, chronological order, active file last. */
export function allLogFiles(sessionId: string, dir: string = sessionsDir): string[] {
  const archives = listArchiveGenerations(sessionId, dir).map((gen) => archiveLogPath(sessionId, gen, dir));
  return [...archives, activeLogPath(sessionId, dir)];
}

/**
 * Move the active log file to a new archive generation, unconditionally —
 * the caller decides *when* (see ROTATE_THRESHOLD). Returns false, leaving
 * the active file in place, if there is nothing to rotate or the rename
 * failed (e.g. a read-only filesystem); the caller should keep appending to
 * the existing file in that case rather than lose events.
 */
export function rotateActiveLog(sessionId: string, dir: string = sessionsDir): boolean {
  const activePath = activeLogPath(sessionId, dir);
  if (!fs.existsSync(activePath)) return false;
  const gens = listArchiveGenerations(sessionId, dir);
  const nextGen = gens.length ? gens[gens.length - 1] + 1 : 1;
  try {
    fs.renameSync(activePath, archiveLogPath(sessionId, nextGen, dir));
    return true;
  } catch {
    return false;
  }
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Stream a JSONL file line by line without ever holding the whole file in
 * memory. `onLine` receives each line (sans trailing newline); returning
 * `false` stops reading early and closes the file. Missing files are treated
 * as empty, matching the original loader's behavior for "no log yet".
 *
 * Chunks are buffered and only decoded to utf8 once a full line (delimited by
 * an ASCII '\n', which cannot occur as a UTF-8 continuation byte) has been
 * assembled, so multi-byte characters split across a chunk boundary decode
 * correctly.
 *
 * `chunkBytes` defaults to a real read size; tests pass a tiny value to force
 * chunk boundaries to fall mid-line (and mid-multibyte-character) on demand.
 */
export function readLinesSync(
  filePath: string,
  onLine: (line: string) => boolean | void,
  chunkBytes: number = READ_CHUNK_BYTES,
): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return;
  }
  try {
    const chunk = Buffer.alloc(chunkBytes);
    let carry = Buffer.alloc(0);
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      carry = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : Buffer.from(chunk.subarray(0, bytesRead));
      let newlineIdx: number;
      while ((newlineIdx = carry.indexOf(0x0a)) >= 0) {
        const line = carry.subarray(0, newlineIdx).toString('utf8');
        carry = carry.subarray(newlineIdx + 1);
        if (onLine(line) === false) return;
      }
    }
    if (carry.length > 0) {
      const line = carry.toString('utf8');
      if (line.trim()) onLine(line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(line: string): PersistedEvent | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as PersistedEvent;
  } catch {
    return undefined; // skip corrupt line, same tolerance as the original loader
  }
}

export interface TailAndCount {
  /** Most recent events, oldest first, capped at maxTail. */
  tail: PersistedEvent[];
  /** Total valid events across every file, in order. */
  count: number;
  /** Valid-event count contributed by each input file, same order as given. */
  perFile: number[];
}

/**
 * Read just enough of a session's files to know its total event count and
 * keep the newest `maxTail` events resident. Never materializes more than
 * `maxTail` parsed events at once.
 */
export function loadTailAndCount(filePaths: string[], maxTail: number): TailAndCount {
  let count = 0;
  const tail: PersistedEvent[] = [];
  const perFile: number[] = [];
  for (const filePath of filePaths) {
    let fileCount = 0;
    readLinesSync(filePath, (line) => {
      const event = parseLine(line);
      if (!event) return;
      count++;
      fileCount++;
      tail.push(event);
      if (tail.length > maxTail) tail.shift();
    });
    perFile.push(fileCount);
  }
  return { tail, count, perFile };
}

/**
 * Read the valid events whose position (0-based, in file order across all
 * valid events) falls in `[start, end)`. Used for history older than the
 * in-memory tail — e.g. a "load earlier" request that reaches past what is
 * cached. Stops reading as soon as `end` is reached.
 */
export function readRange(filePaths: string[], start: number, end: number): PersistedEvent[] {
  const out: PersistedEvent[] = [];
  let idx = 0;
  for (const filePath of filePaths) {
    if (idx >= end) break;
    readLinesSync(filePath, (line) => {
      const event = parseLine(line);
      if (!event) return;
      if (idx >= start) out.push(event);
      idx++;
      if (idx >= end) return false;
    });
  }
  return out;
}
