// Account switching: which Claude credentials/config dir the daemon points
// the SDK at (via CLAUDE_CONFIG_DIR). An "account" is any dir containing a
// `.credentials.json`. The default account is the env left unset (SDK falls
// back to ~/.claude); extra accounts live under ~/.claude-accounts/<name>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountInfo } from '@claude-persist/shared';
import { projectDirName } from './importer.js';

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
 * The Agent SDK resumes a session by reading
 * `<CLAUDE_CONFIG_DIR>/projects/<projectDirName(cwd)>/<sdkSessionId>.jsonl`
 * under whatever config dir it is currently launched with. Switching to a
 * config dir that has never seen this session means `resume` finds nothing
 * and the conversation's history is silently lost — even though the daemon's
 * own transcript (in ~/.claude-persist) is untouched. Copy the SDK-side
 * transcript over first if it's missing from the active dir but present under
 * any other known dir. No-ops if the destination already has it, or if no
 * source has it either (brand-new session, nothing to copy yet).
 */
export function ensureSdkTranscript(
  sdkSessionId: string | undefined,
  cwd: string,
  activeConfigDir: string,
  otherConfigDirs: string[],
): void {
  if (!sdkSessionId) return;
  const projectDir = projectDirName(cwd);
  const destFile = path.join(activeConfigDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  if (fs.existsSync(destFile)) return;
  for (const dir of otherConfigDirs) {
    if (dir === activeConfigDir) continue;
    const srcFile = path.join(dir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
    if (!fs.existsSync(srcFile)) continue;
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    return;
  }
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
