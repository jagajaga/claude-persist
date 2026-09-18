// Noticing that a newer copy of this extension is sitting on disk, unused.
//
// VS Code installs an update *beside* the running one and loads it at the next
// window reload. Nothing makes that reload happen. On a desktop the prompt is
// hard to miss; in a browser tab on a phone that is never closed, a window can
// go on running the same build for days.
//
// One did: eight and a half days on 1.0.47 while 1.0.48, 1.0.49 and 1.0.51 sat
// in the extensions folder. Every fix shipped in them was invisible to the
// person who had asked for them, and the feature they kept asking after had
// never executed a single time.
//
// The daemon's own staleness check cannot catch this, and it is worth being
// precise about why: it compares the running daemon against the extension that
// spawned it, and those two agreed perfectly. Both were the old build. There is
// no disagreement anywhere inside a window that has not been reloaded -- the
// evidence only exists on disk, next door.
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions } from './daemonClient';

/**
 * The versions of this extension installed on disk, newest last.
 *
 * Read from each directory's own package.json rather than parsed out of the
 * directory name: a platform-specific build is installed as
 * `jaga.claude-persist-vscode-1.0.51-linux-x64`, and a version parsed off the
 * end of that is `1.0.51-linux-x64`, which compares as 1.0.51 only by luck.
 */
export function installedVersions(
  ourDir: string,
  read: {
    list: (dir: string) => string[];
    version: (manifest: string) => string | null;
  },
): string[] {
  const parent = path.dirname(ourDir);
  // The publisher-qualified id, which is the part of the folder name that is
  // stable across versions and targets.
  const id = path.basename(ourDir).replace(/-\d+\.\d+\.\d+.*$/, '');
  // A prefix match is not enough, separator or not: it also claims
  // `jaga.claude-persist-vscode-extras-9.9.9`, whose 9.9.9 would prompt a
  // reload that could never help. What follows the id has to be a version.
  const mine = (name: string): boolean =>
    name.startsWith(`${id}-`) && /^\d+\.\d+\.\d+/.test(name.slice(id.length + 1));
  let entries: string[];
  try {
    entries = read.list(parent);
  } catch {
    // No extensions directory to look in -- a dev host run from source, say.
    // Nothing to report is the right answer, not a broken window.
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    if (!mine(name)) continue;
    const version = read.version(path.join(parent, name, 'package.json'));
    if (version) found.push(version);
  }
  return found.sort(compareVersions);
}

/**
 * A newer build than the one running, or null.
 *
 * Null when the newest thing on disk is what is already running, which is the
 * ordinary case and must stay silent: a notification every window gets on every
 * start is one nobody reads by the time it matters.
 */
export function newerInstalledVersion(ourVersion: string, installed: string[]): string | null {
  let best: string | null = null;
  for (const candidate of installed) {
    if (compareVersions(candidate, ourVersion) <= 0) continue;
    if (best === null || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

function readVersion(manifest: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const version = (parsed as { version?: unknown })?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    // Half-written during an install, or not ours to read. A version we cannot
    // read is not a version we should act on.
    return null;
  }
}

/** The newest build installed beside this one, or null if this is it. */
export function pendingUpgrade(ourDir: string, ourVersion: string): string | null {
  return newerInstalledVersion(
    ourVersion,
    installedVersions(ourDir, { list: (dir) => fs.readdirSync(dir), version: readVersion }),
  );
}
