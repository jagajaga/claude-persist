import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsStore, ensureSdkTranscript, scanAccounts } from './accounts.js';

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
