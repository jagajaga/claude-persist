import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountsStore,
  accountIdentity,
  ensureSdkTranscript,
  scanAccounts,
  shareUserConfig,
  sdkTranscriptExists,
} from './accounts.js';

/** A fresh scratch directory per test, cleaned up automatically. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-accounts-test-'));
}

function writeCredentials(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
}

// ---------------------------------------------------------------- scanAccounts

test('scanAccounts: always offers the default account, even without credentials', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude'); // never created
  const accountsDir = path.join(root, 'claude-accounts'); // never created
  const found = scanAccounts(claudeDir, accountsDir);
  assert.deepEqual(found, [{ name: 'default', configDir: null }]);
});

test('scanAccounts: finds named dirs with credentials and skips ones without', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  writeCredentials(claudeDir);
  const accountsDir = path.join(root, 'claude-accounts');
  writeCredentials(path.join(accountsDir, 'work'));
  fs.mkdirSync(path.join(accountsDir, 'half-logged-in'), { recursive: true }); // no .credentials.json

  const found = scanAccounts(claudeDir, accountsDir);
  assert.deepEqual(found, [
    { name: 'default', configDir: null },
    { name: 'work', configDir: path.join(accountsDir, 'work') },
  ]);
});

// ---------------------------------------------------------------- AccountsStore

test('AccountsStore: a fresh store defaults to the default account and lists it as active', () => {
  const root = tmpDir();
  const store = new AccountsStore({
    claudeDir: path.join(root, 'claude'),
    accountsDir: path.join(root, 'claude-accounts'),
    stateDir: path.join(root, 'claude-persist'),
  });
  assert.equal(store.active, null);
  assert.deepEqual(store.list(), [
    { name: 'default', configDir: null, active: true, signedIn: false },
  ]);
});

/**
 * The default account is listed whether or not it has credentials — it is the
 * normal already-logged-in case, and there is nowhere else to start. On a
 * machine that has never run Claude Code that meant the menu showed it, ticked
 * and active, while every message failed and nothing anywhere said why.
 */
test('AccountsStore: the default account reports whether it can actually be used', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  const store = new AccountsStore({
    claudeDir,
    accountsDir: path.join(root, 'claude-accounts'),
    stateDir: path.join(root, 'claude-persist'),
  });
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(store.list()[0].signedIn, false, 'no credentials anywhere');

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{}');
    assert.equal(store.list()[0].signedIn, true, 'a login file is credentials');

    // An API key authenticates with no login file at all; calling that setup
    // "not signed in" would be wrong in the direction that scares people.
    fs.rmSync(path.join(claudeDir, '.credentials.json'));
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal(store.list()[0].signedIn, true, 'an API key counts');
  } finally {
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  }
});

test('AccountsStore: the active choice persists across a fresh construct (daemon restart)', () => {
  const root = tmpDir();
  const accountsDir = path.join(root, 'claude-accounts');
  writeCredentials(path.join(accountsDir, 'work'));
  const opts = {
    claudeDir: path.join(root, 'claude'),
    accountsDir,
    stateDir: path.join(root, 'claude-persist'),
  };

  const first = new AccountsStore(opts);
  const workDir = path.join(accountsDir, 'work');
  first.setActive(workDir);
  assert.equal(first.active, workDir);

  const second = new AccountsStore(opts);
  assert.equal(second.active, workDir);
  const active = second.list().find((a) => a.active);
  assert.equal(active?.name, 'work');
});

// ---------------------------------------------------------------- ensureSdkTranscript

test('ensureSdkTranscript: copies the transcript from another config dir when missing from the active one', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const oldDir = path.join(root, 'claude');
  const newDir = path.join(root, 'claude-accounts', 'work');
  const sdkSessionId = 'abc-123';

  const srcFile = path.join(oldDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '{"line":1}\n');

  ensureSdkTranscript(sdkSessionId, cwd, newDir, [oldDir, newDir]);

  const destFile = path.join(newDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  assert.equal(fs.existsSync(destFile), true);
  assert.equal(fs.readFileSync(destFile, 'utf8'), '{"line":1}\n');
});

test('ensureSdkTranscript: no-ops when the active dir already has the transcript', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const activeDir = path.join(root, 'claude');
  const sdkSessionId = 'abc-123';

  const destFile = path.join(activeDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, '{"already":"here"}\n');
  const mtimeBefore = fs.statSync(destFile).mtimeMs;

  ensureSdkTranscript(sdkSessionId, cwd, activeDir, [activeDir]);

  assert.equal(fs.readFileSync(destFile, 'utf8'), '{"already":"here"}\n');
  assert.equal(fs.statSync(destFile).mtimeMs, mtimeBefore);
});

test('ensureSdkTranscript: no-ops when no known config dir has the transcript (brand-new session)', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const activeDir = path.join(root, 'claude-accounts', 'work');
  const otherDir = path.join(root, 'claude'); // exists but has nothing for this session

  ensureSdkTranscript('never-seen', cwd, activeDir, [otherDir, activeDir]);

  const destFile = path.join(activeDir, 'projects', projectDir, 'never-seen.jsonl');
  assert.equal(fs.existsSync(destFile), false);
});

test('ensureSdkTranscript: a missing sdkSessionId (brand-new session, no resume yet) is a no-op', () => {
  const root = tmpDir();
  ensureSdkTranscript(undefined, '/home/me/project', path.join(root, 'claude'), []);
  assert.deepEqual(fs.readdirSync(root), []);
});

/**
 * The regression that produced "No conversation found with session ID": on
 * code-server the workspace is reached through a symlink
 * (/home/coder/code-workspace -> /home/jaga/code-workspace), the registry
 * stores the symlinked path, but Claude Code realpaths cwd before encoding it.
 * Probing only the stored spelling found nothing, skipped the copy silently,
 * and then resumed into an empty account dir.
 */
test('ensureSdkTranscript: finds a transcript filed under the realpath of a symlinked cwd', () => {
  const root = fs.realpathSync(tmpDir());
  const realProject = path.join(root, 'real', 'project');
  fs.mkdirSync(realProject, { recursive: true });
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
  const cwd = path.join(root, 'link', 'project'); // what the registry stores
  const resolvedName = realProject.replace(/[^a-zA-Z0-9]/g, '-');
  const linkedName = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  assert.notEqual(resolvedName, linkedName); // the two spellings really differ

  const oldDir = path.join(root, 'claude');
  const newDir = path.join(root, 'claude-accounts', 'work');
  const sdkSessionId = 'sym-1';

  // Claude Code wrote it under the *resolved* name.
  const srcFile = path.join(oldDir, 'projects', resolvedName, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '{"turn":1}\n');

  const result = ensureSdkTranscript(sdkSessionId, cwd, newDir, [oldDir, newDir]);

  // ...and it must land under the resolved name too, since that's where the
  // SDK will look when it resumes.
  const destFile = path.join(newDir, 'projects', resolvedName, `${sdkSessionId}.jsonl`);
  assert.equal(result?.to, destFile);
  assert.equal(fs.readFileSync(destFile, 'utf8'), '{"turn":1}\n');
  assert.equal(
    fs.existsSync(path.join(newDir, 'projects', linkedName, `${sdkSessionId}.jsonl`)),
    false,
  );
});

test('ensureSdkTranscript: a stale copy in the active dir loses to a newer one elsewhere', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const activeDir = path.join(root, 'claude-accounts', 'work');
  const otherDir = path.join(root, 'claude');
  const sdkSessionId = 'abc-123';

  // The session ran under `work` first, then continued under the default
  // account, so the default's transcript is longer and newer.
  const staleFile = path.join(activeDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, '{"turn":1}\n');
  fs.utimesSync(staleFile, new Date(1_000_000), new Date(1_000_000));

  const freshFile = path.join(otherDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(freshFile), { recursive: true });
  fs.writeFileSync(freshFile, '{"turn":1}\n{"turn":2}\n');
  fs.utimesSync(freshFile, new Date(2_000_000), new Date(2_000_000));

  const result = ensureSdkTranscript(sdkSessionId, cwd, activeDir, [otherDir, activeDir]);

  assert.equal(result?.from, freshFile);
  assert.equal(fs.readFileSync(staleFile, 'utf8'), '{"turn":1}\n{"turn":2}\n');
  // mtime is carried over so the next switch compares content age, not copy
  // age — otherwise every switch rewrites tens of megabytes of identical bytes.
  assert.equal(fs.statSync(staleFile).mtimeMs, fs.statSync(freshFile).mtimeMs);
  assert.equal(ensureSdkTranscript(sdkSessionId, cwd, activeDir, [otherDir, activeDir]), null);
});

test('ensureSdkTranscript: copies into the default dir too (switching back off a named account)', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const claudeDir = path.join(root, 'claude'); // the default account
  const workDir = path.join(root, 'claude-accounts', 'work');
  const sdkSessionId = 'born-under-work';

  const srcFile = path.join(workDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '{"turn":1}\n');

  ensureSdkTranscript(sdkSessionId, cwd, claudeDir, [claudeDir, workDir]);

  const destFile = path.join(claudeDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  assert.equal(fs.existsSync(destFile), true);
});

/**
 * The failure that proved deriving the path from cwd can never work. A session
 * registered as /home/coder/code-workspace/blooper2.0 had its transcript filed
 * under the git worktree it actually ran in — a directory since deleted — so no
 * spelling of the registered cwd could reach it, and resume failed under every
 * account rather than only after a switch. A session id is a UUID, so scanning
 * project dirs for the filename is unambiguous.
 */
test('ensureSdkTranscript: finds a transcript filed under an unrelated cwd (git worktree)', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const worktreeDir = '/home/me/project/.claude-worktrees/feature-x'; // long gone
  const claudeDir = path.join(root, 'claude');
  const workDir = path.join(root, 'claude-accounts', 'work');
  const sdkSessionId = 'wt-1';

  const srcFile = path.join(
    claudeDir,
    'projects',
    worktreeDir.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sdkSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '{"turn":1}\n');

  const result = ensureSdkTranscript(sdkSessionId, cwd, workDir, [claudeDir, workDir]);

  // Copied to where the SDK will look given the *registered* cwd.
  const destFile = path.join(
    workDir,
    'projects',
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sdkSessionId}.jsonl`,
  );
  assert.equal(result?.from, srcFile);
  assert.equal(result?.to, destFile);
  assert.equal(fs.readFileSync(destFile, 'utf8'), '{"turn":1}\n');
  assert.equal(sdkTranscriptExists(sdkSessionId, cwd, workDir), true);
});

test('ensureSdkTranscript: a worktree transcript is reachable under the default account too', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const claudeDir = path.join(root, 'claude');
  const sdkSessionId = 'wt-2';

  const srcFile = path.join(
    claudeDir,
    'projects',
    '-home-me-project--claude-worktrees-gone',
    `${sdkSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '{"turn":1}\n');

  // No account switch involved at all — same config dir in and out.
  assert.equal(sdkTranscriptExists(sdkSessionId, cwd, claudeDir), false);
  ensureSdkTranscript(sdkSessionId, cwd, claudeDir, [claudeDir]);
  assert.equal(sdkTranscriptExists(sdkSessionId, cwd, claudeDir), true);
});

test('sdkTranscriptExists: false when nothing has been written for this session', () => {
  const root = tmpDir();
  assert.equal(sdkTranscriptExists('never-existed', '/home/me/project', path.join(root, 'claude')), false);
});

test('sdkTranscriptExists: resolves symlinked cwds the way the SDK does', () => {
  const root = fs.realpathSync(tmpDir());
  const realProject = path.join(root, 'real', 'project');
  fs.mkdirSync(realProject, { recursive: true });
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
  const claudeDir = path.join(root, 'claude');
  const file = path.join(
    claudeDir,
    'projects',
    realProject.replace(/[^a-zA-Z0-9]/g, '-'),
    'sym-2.jsonl',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');

  assert.equal(sdkTranscriptExists('sym-2', path.join(root, 'link', 'project'), claudeDir), true);
});

test('ensureSdkTranscript: brings the subagent and task sidecars along', () => {
  const root = tmpDir();
  const cwd = '/home/me/project';
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const oldDir = path.join(root, 'claude');
  const newDir = path.join(root, 'claude-accounts', 'work');
  const sdkSessionId = 'with-sidecars';

  const srcFile = path.join(oldDir, 'projects', projectDir, `${sdkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '{"turn":1}\n');
  const srcSubagent = path.join(oldDir, 'projects', projectDir, sdkSessionId, 'subagents');
  fs.mkdirSync(srcSubagent, { recursive: true });
  fs.writeFileSync(path.join(srcSubagent, 'agent-1.jsonl'), '{"sub":1}\n');
  const srcTasks = path.join(oldDir, 'tasks', sdkSessionId);
  fs.mkdirSync(srcTasks, { recursive: true });
  fs.writeFileSync(path.join(srcTasks, 'state.json'), '{}');

  ensureSdkTranscript(sdkSessionId, cwd, newDir, [oldDir, newDir]);

  assert.equal(
    fs.readFileSync(
      path.join(newDir, 'projects', projectDir, sdkSessionId, 'subagents', 'agent-1.jsonl'),
      'utf8',
    ),
    '{"sub":1}\n',
  );
  assert.equal(fs.existsSync(path.join(newDir, 'tasks', sdkSessionId, 'state.json')), true);
});

/**
 * What the daemon's account poller detects.
 *
 * `claude /login` writes .credentials.json *inside* an existing account
 * directory, so the transition that matters is dir-without-credentials ->
 * dir-with-credentials. Nothing used to notice it: the list was only rescanned
 * on request, so a freshly logged-in account stayed missing from the model menu
 * until the window was reloaded.
 */
test('scanAccounts: a reserved directory appears only once login writes credentials', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  const accountsDir = path.join(root, 'claude-accounts');
  // The extension creates the directory when you add an account, before login.
  fs.mkdirSync(path.join(accountsDir, 'work'), { recursive: true });

  const before = scanAccounts(claudeDir, accountsDir);
  assert.deepEqual(
    before.map((a) => a.name),
    ['default'],
    'a reserved-but-not-logged-in account is not offered',
  );

  // Now log in.
  fs.writeFileSync(path.join(accountsDir, 'work', '.credentials.json'), '{}');

  const after = scanAccounts(claudeDir, accountsDir);
  assert.deepEqual(after.map((a) => a.name), ['default', 'work']);
  assert.notEqual(
    JSON.stringify(before),
    JSON.stringify(after),
    'the change must be visible to a poller comparing successive scans',
  );
});

// ---------------------------------------------------------------- accountIdentity

function writeConfig(file: string, accountUuid?: string, organizationUuid?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ oauthAccount: { ...(accountUuid ? { accountUuid } : {}), ...(organizationUuid ? { organizationUuid } : {}) } }),
  );
}

/**
 * Two config dirs can hold different credentials for the *same* Claude account,
 * and then share one quota — observed with ~/.claude and
 * ~/.claude-accounts/senia00 both reporting accountUuid c67b076f. Rotating
 * between them on a rate limit wastes a step and hits the identical limit.
 */
test('accountIdentity: two directories logged into the same account match', () => {
  const home = tmpDir();
  writeConfig(path.join(home, '.claude.json'), 'acct-1', 'org-1');
  writeConfig(path.join(home, '.claude-accounts', 'copy', '.claude.json'), 'acct-1', 'org-1');
  writeConfig(path.join(home, '.claude-accounts', 'other', '.claude.json'), 'acct-2', 'org-2');

  const def = accountIdentity(null, home);
  assert.equal(def, 'acct-1');
  assert.equal(accountIdentity(path.join(home, '.claude-accounts', 'copy'), home), def);
  assert.notEqual(accountIdentity(path.join(home, '.claude-accounts', 'other'), home), def);
});

/**
 * The default account's config lives at ~/.claude.json, *outside* ~/.claude/,
 * unlike a named account's <configDir>/.claude.json. Reading the wrong place
 * makes the default look identity-less and therefore distinct from everything.
 */
test('accountIdentity: the default account reads ~/.claude.json, not ~/.claude/.claude.json', () => {
  const home = tmpDir();
  writeConfig(path.join(home, '.claude.json'), 'the-real-one');
  // A decoy in the place a named account would keep it.
  writeConfig(path.join(home, '.claude', '.claude.json'), 'wrong-one');
  assert.equal(accountIdentity(null, home), 'the-real-one');
});

test('accountIdentity: falls back to the organization when no accountUuid is written', () => {
  const home = tmpDir();
  const dir = path.join(home, '.claude-accounts', 'work');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ organizationUuid: 'org-9' }));
  assert.equal(accountIdentity(dir, home), 'org:org-9');
});

/** Unknown identity must never be treated as a match — callers keep such accounts distinct. */
test('accountIdentity: null when nothing identifies the account', () => {
  const home = tmpDir();
  const dir = path.join(home, '.claude-accounts', 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(accountIdentity(dir, home), null);
  assert.equal(accountIdentity(null, home), null);
});

// ---------------------------------------------------------------- shareUserConfig

/**
 * Claude Code reads memory and skills from whatever CLAUDE_CONFIG_DIR points at,
 * so switching account silently changed which rules applied — a named account had
 * none at all. Global instructions stopped being followed with nothing to show
 * why, and the daemon rotates accounts on its own.
 */
test('shareUserConfig: every account gets the default account rules and skills', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(path.join(claudeDir, 'skills', 'naming-commits'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# rules\n');
  const accountsDir = path.join(root, 'claude-accounts');
  writeCredentials(path.join(accountsDir, 'work'));
  writeCredentials(path.join(accountsDir, 'personal'));

  shareUserConfig(claudeDir, accountsDir);

  for (const name of ['work', 'personal']) {
    assert.equal(
      fs.readFileSync(path.join(accountsDir, name, 'CLAUDE.md'), 'utf8'),
      '# rules\n',
      `${name} must see the same rules`,
    );
    assert.equal(
      fs.existsSync(path.join(accountsDir, name, 'skills', 'naming-commits')),
      true,
      `${name} must see the same skills`,
    );
  }
});

/** One source of truth: editing the original must take effect everywhere. */
test('shareUserConfig: links, so an edit reaches every account at once', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'first\n');
  const accountsDir = path.join(root, 'claude-accounts');
  writeCredentials(path.join(accountsDir, 'work'));

  shareUserConfig(claudeDir, accountsDir);
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'edited\n');

  assert.equal(fs.readFileSync(path.join(accountsDir, 'work', 'CLAUDE.md'), 'utf8'), 'edited\n');
});

/** Never destroy something the user put there deliberately. */
test('shareUserConfig: an account with its own rules keeps them', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'shared\n');
  const accountsDir = path.join(root, 'claude-accounts');
  const own = path.join(accountsDir, 'work');
  writeCredentials(own);
  fs.writeFileSync(path.join(own, 'CLAUDE.md'), 'mine\n');

  shareUserConfig(claudeDir, accountsDir);

  assert.equal(fs.readFileSync(path.join(own, 'CLAUDE.md'), 'utf8'), 'mine\n');
});

test('shareUserConfig: repairs a link left dangling by a moved config', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'shared\n');
  const accountsDir = path.join(root, 'claude-accounts');
  const dir = path.join(accountsDir, 'work');
  writeCredentials(dir);
  fs.symlinkSync(path.join(root, 'gone', 'CLAUDE.md'), path.join(dir, 'CLAUDE.md'));

  shareUserConfig(claudeDir, accountsDir);

  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'shared\n');
});

test('shareUserConfig: idempotent, and safe with nothing to share', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const accountsDir = path.join(root, 'claude-accounts');
  writeCredentials(path.join(accountsDir, 'work'));

  // No CLAUDE.md or skills yet — must not create broken links.
  shareUserConfig(claudeDir, accountsDir);
  assert.equal(fs.existsSync(path.join(accountsDir, 'work', 'CLAUDE.md')), false);

  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'rules\n');
  shareUserConfig(claudeDir, accountsDir);
  shareUserConfig(claudeDir, accountsDir);
  assert.equal(fs.readFileSync(path.join(accountsDir, 'work', 'CLAUDE.md'), 'utf8'), 'rules\n');
});

test('shareUserConfig: no accounts directory at all is not an error', () => {
  const root = tmpDir();
  shareUserConfig(path.join(root, 'claude'), path.join(root, 'nope'));
});
