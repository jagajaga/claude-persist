import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountsStore,
  ensureSdkTranscript,
  scanAccounts,
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
  assert.deepEqual(store.list(), [{ name: 'default', configDir: null, active: true }]);
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
