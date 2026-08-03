// Account switching: which Claude credentials/config dir the daemon points
// the SDK at (via CLAUDE_CONFIG_DIR). An "account" is any dir containing a
// `.credentials.json`. The default account is the env left unset (SDK falls
// back to ~/.claude); extra accounts live under ~/.claude-accounts/<name>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountInfo } from '@claude-persist/shared';
import { projectDirName } from './projectDir.js';

const DEFAULT_ACCOUNT_NAME = 'default';

function hasCredentials(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.credentials.json'));
}

/**
 * Discover known accounts. The default account (configDir: null) is always
 * offered — it's the normal, already-logged-in case. Named directories under
 * `accountsDir` are only offered once they actually hold credentials; a
 * reserved-but-never-logged-into name is skipped rather than shown as a dead
 * end (see addAccount in the extension host, which creates the dir before the
 * user logs in).
 */
export function scanAccounts(
  claudeDir: string,
  accountsDir: string,
): Array<{ name: string; configDir: string | null }> {
  const out: Array<{ name: string; configDir: string | null }> = [
    { name: DEFAULT_ACCOUNT_NAME, configDir: null },
  ];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(accountsDir);
  } catch {
    entries = []; // ~/.claude-accounts doesn't exist yet — no extra accounts
  }
  for (const name of entries.sort()) {
    const dir = path.join(accountsDir, name);
    if (hasCredentials(dir)) out.push({ name, configDir: dir });
  }
  return out;
}

/**
 * Session-scoped state that lives at the config-dir root rather than beside
 * the transcript. Resume works without these, but subagent shell environments
 * and background task state don't carry over.
 */
const ROOT_SIDECAR_DIRS = ['session-env', 'tasks'];

/** Newer = later mtime; equal mtimes fall back to the longer transcript. */
function isNewer(a: fs.Stats, b: fs.Stats): boolean {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs;
  return a.size > b.size;
}

/**
 * Which project-dir names a session's transcript might be filed under.
 *
 * Claude Code realpaths cwd before encoding it, so a workspace reached through
 * a symlink (`/home/coder/code-workspace` -> `/home/jaga/code-workspace`, the
 * usual code-server layout) is filed under the *resolved* path while the
 * daemon's registry stores the path the user opened. Probing only the stored
 * spelling found nothing and silently skipped the copy, and the resume then
 * failed with "No conversation found with session ID".
 *
 * `dest` is the name the SDK will actually read from, so it's the only correct
 * copy target; `search` covers both spellings because transcripts written by
 * older builds (or by tools that don't resolve) can sit under the raw one.
 */
function projectDirCandidates(cwd: string): { dest: string; search: string[] } {
  const raw = projectDirName(cwd);
  let resolved = raw;
  try {
    resolved = projectDirName(fs.realpathSync(cwd));
  } catch {
    // cwd is gone or unreadable — the stored spelling is the best we have
  }
  return { dest: resolved, search: resolved === raw ? [raw] : [resolved, raw] };
}

/** Recursive copy that only overwrites files the source is newer than. */
function mergeTree(src: string, dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return; // no sidecar of this kind for this session
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mergeTree(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const srcStat = fs.statSync(from);
      let destStat: fs.Stats | null = null;
      try {
        destStat = fs.statSync(to);
      } catch {
        // not there yet
      }
      if (destStat && !isNewer(srcStat, destStat)) continue;
      fs.copyFileSync(from, to);
      fs.utimesSync(to, srcStat.atime, srcStat.mtime);
    } catch {
      // skip anything unreadable rather than aborting the whole sync
    }
  }
}

export interface TranscriptSync {
  from: string;
  to: string;
}

/**
 * The Agent SDK resumes a session by reading
 * `<CLAUDE_CONFIG_DIR>/projects/<projectDirName(realpath(cwd))>/<sdkSessionId>.jsonl`
 * under whatever config dir it is currently launched with. Switching to a
 * config dir that has never seen this session means `resume` finds nothing and
 * the conversation's history is lost — even though the daemon's own transcript
 * (in ~/.claude-persist) is untouched. So before launching, make sure the
 * active dir holds the newest copy of the SDK-side transcript.
 *
 * "Newest", not "any": once a session has run under two accounts, both dirs
 * hold a transcript of different length, and resuming the shorter one silently
 * drops every turn recorded under the other account. Copies keep the source's
 * mtime so an unchanged transcript isn't rewritten on every switch — these
 * files reach tens of megabytes.
 *
 * Returns what was copied, or null if nothing needed copying (active dir
 * already newest) or nothing was found (brand-new session).
 */
export function ensureSdkTranscript(
  sdkSessionId: string | undefined,
  cwd: string,
  activeConfigDir: string,
  otherConfigDirs: string[],
): TranscriptSync | null {
  if (!sdkSessionId) return null;
  const { dest: destProject, search } = projectDirCandidates(cwd);
  const destFile = path.join(activeConfigDir, 'projects', destProject, `${sdkSessionId}.jsonl`);

  // The active dir competes as a source too, so an already-present but stale
  // copy loses to a fresher one elsewhere.
  let best: { file: string; dir: string; project: string; stat: fs.Stats } | null = null;
  for (const dir of [activeConfigDir, ...otherConfigDirs]) {
    for (const project of search) {
      const file = path.join(dir, 'projects', project, `${sdkSessionId}.jsonl`);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!best || isNewer(stat, best.stat)) best = { file, dir, project, stat };
    }
  }
  if (!best) return null; // brand-new session, nothing to copy yet
  if (path.resolve(best.file) === path.resolve(destFile)) return null; // already newest

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(best.file, destFile);
  fs.utimesSync(destFile, best.stat.atime, best.stat.mtime);

  // Subagent transcripts and tool results live in a dir named after the
  // session next to the transcript itself.
  mergeTree(
    path.join(best.dir, 'projects', best.project, sdkSessionId),
    path.join(activeConfigDir, 'projects', destProject, sdkSessionId),
  );
  for (const name of ROOT_SIDECAR_DIRS) {
    mergeTree(path.join(best.dir, name, sdkSessionId), path.join(activeConfigDir, name, sdkSessionId));
  }
  return { from: best.file, to: destFile };
}

export interface AccountsStoreOptions {
  /** Defaults to ~/.claude. */
  claudeDir?: string;
  /** Defaults to ~/.claude-accounts. */
  accountsDir?: string;
  /** Defaults to ~/.claude-persist; the active choice persists as account.json inside it. */
  stateDir?: string;
}

/** Persists which account is active across daemon restarts. */
export class AccountsStore {
  private readonly claudeDir: string;
  private readonly accountsDir: string;
  private readonly stateFile: string;
  private activeConfigDir: string | null = null;

  constructor(opts: AccountsStoreOptions = {}) {
    this.claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
    this.accountsDir = opts.accountsDir ?? path.join(os.homedir(), '.claude-accounts');
    this.stateFile = path.join(
      opts.stateDir ?? path.join(os.homedir(), '.claude-persist'),
      'account.json',
    );
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { configDir?: string | null };
      this.activeConfigDir = raw.configDir ?? null;
    } catch {
      this.activeConfigDir = null; // first run, or corrupt state file
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify({ configDir: this.activeConfigDir }));
  }

  /** null = default account (no CLAUDE_CONFIG_DIR override). */
  get active(): string | null {
    return this.activeConfigDir;
  }

  /** The active dir as a concrete path, for callers (like ensureSdkTranscript) that need one. */
  activeConcreteDir(): string {
    return this.activeConfigDir ?? this.claudeDir;
  }

  /** Every known config dir, concrete (the default resolved to ~/.claude). */
  allConcreteDirs(): string[] {
    return this.list().map((a) => a.configDir ?? this.claudeDir);
  }

  list(): AccountInfo[] {
    return scanAccounts(this.claudeDir, this.accountsDir).map((a) => ({
      ...a,
      active: a.configDir === this.activeConfigDir,
    }));
  }

  setActive(configDir: string | null): AccountInfo[] {
    this.activeConfigDir = configDir;
    this.persist();
    return this.list();
  }
}

/** Shared across every session in this daemon process — one account choice at a time. */
export const accountsStore = new AccountsStore();
