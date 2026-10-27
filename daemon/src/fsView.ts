// Looking at the server's files from the phone: list a directory, read a file.
//
// Read-only by construction -- nothing here writes, renames or deletes. It
// reaches whatever the daemon's own user can read, the same as the terminal
// in the editor it lives next to; the gateway that serves it is reachable only
// through the code-server proxy behind the owner's login.
//
// Reads are paged with a hard cap. On a bad network a single 40 MB response
// is a request that never finishes; a page at a time is one that resumes.
import fs from 'node:fs';
import path from 'node:path';

/** Largest slice of a file one request may carry. */
export const MAX_READ_BYTES = 256 * 1024;
/** Largest directory listing one request may carry. */
export const MAX_LIST_ENTRIES = 2000;

export interface FsEntry {
  name: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtimeMs: number;
  /** For a link: where it points, and what that turned out to be. */
  target?: string;
  targetKind?: 'file' | 'dir' | 'missing';
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
}

export interface FsRead {
  path: string;
  size: number;
  offset: number;
  /** Text when the bytes are valid UTF-8 without NULs, else base64. */
  encoding: 'utf8' | 'base64';
  data: string;
  /** Bytes in this slice. */
  length: number;
  eof: boolean;
}

function kindOf(stat: fs.Stats): FsEntry['kind'] {
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** An absolute, normalised path, or an error that says why it is not one. */
function resolveAbsolute(p: string): string {
  if (typeof p !== 'string' || !p) throw new Error('A path is required');
  if (!path.isAbsolute(p)) throw new Error(`Not an absolute path: ${p}`);
  return path.resolve(p);
}

/**
 * Directories first, then files, each alphabetically -- the order every file
 * browser uses, so the phone has nothing to re-sort.
 */
export function listDirectory(p: string): FsListing {
  const dir = resolveAbsolute(p);
  const names = fs.readdirSync(dir);
  const entries: FsEntry[] = [];
  for (const name of names) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch {
      continue; // vanished between readdir and lstat
    }
    const entry: FsEntry = { name, kind: kindOf(stat), size: stat.size, mtimeMs: stat.mtimeMs };
    if (entry.kind === 'link') {
      try {
        entry.target = fs.readlinkSync(path.join(dir, name));
        const real = fs.statSync(path.join(dir, name));
        entry.targetKind = real.isDirectory() ? 'dir' : 'file';
      } catch {
        entry.targetKind = 'missing';
      }
    }
    entries.push(entry);
  }
  const isDir = (e: FsEntry): boolean => e.kind === 'dir' || (e.kind === 'link' && e.targetKind === 'dir');
  entries.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
  const truncated = entries.length > MAX_LIST_ENTRIES;
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
    truncated,
  };
}

/** True when the bytes read as text a person would want to see as text. */
export function looksLikeText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  // A slice can end mid-character; a decoder that only rejects interior
  // garbage is what is wanted, so check by round-trip with the tail trimmed.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const replacements = (decoded.match(/�/g) ?? []).length;
  return replacements <= 3;
}

/** One page of a file, as text when it is text. */
export function readFileSlice(p: string, offset = 0, length = MAX_READ_BYTES): FsRead {
  const file = resolveAbsolute(p);
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new Error(`Is a directory: ${file}`);
  const start = Math.max(0, Math.floor(offset));
  const want = Math.max(0, Math.min(MAX_READ_BYTES, Math.floor(length)));
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(want, Math.max(0, stat.size - start)));
    const read = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, start) : 0;
    const bytes = buffer.subarray(0, read);
    const text = looksLikeText(bytes);
    return {
      path: file,
      size: stat.size,
      offset: start,
      encoding: text ? 'utf8' : 'base64',
      data: text ? bytes.toString('utf8') : bytes.toString('base64'),
      length: read,
      eof: start + read >= stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make one new folder, for the phone's file browser. Absolute paths only;
 * the parent must exist, and an existing name is refused rather than
 * silently reused, so a typo is noticed.
 */
export function makeDirectory(p: string): { path: string } {
  if (!path.isAbsolute(p)) throw new Error('The path must be absolute');
  const target = path.resolve(p);
  const name = path.basename(target);
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Not a folder name');
  if (fs.existsSync(target)) throw new Error(`${name} already exists`);
  if (!fs.statSync(path.dirname(target), { throwIfNoEntry: false })?.isDirectory()) throw new Error('The folder it goes in does not exist');
  fs.mkdirSync(target);
  return { path: target };
}
