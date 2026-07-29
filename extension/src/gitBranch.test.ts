import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseHead, parseGitFile, formatBranch, findGitDir, readBranch } from './gitBranch';

test('parseHead: symbolic ref to a branch', () => {
  assert.deepEqual(parseHead('ref: refs/heads/main\n'), { kind: 'branch', name: 'main' });
});

test('parseHead: branch name containing slashes', () => {
  assert.deepEqual(parseHead('ref: refs/heads/feature/new-ui\n'), {
    kind: 'branch',
    name: 'feature/new-ui',
  });
});

test('parseHead: detached head is a raw sha', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(parseHead(`${sha}\n`), { kind: 'detached', sha });
});

test('parseHead: junk and empty are unknown', () => {
  assert.deepEqual(parseHead(''), { kind: 'unknown' });
  assert.deepEqual(parseHead('not a head file'), { kind: 'unknown' });
  assert.deepEqual(parseHead('ref: '), { kind: 'unknown' });
});

test('parseGitFile: reads the gitdir pointer of a worktree', () => {
  assert.equal(parseGitFile('gitdir: /repo/.git/worktrees/x\n'), '/repo/.git/worktrees/x');
});

test('parseGitFile: anything else is null', () => {
  assert.equal(parseGitFile(''), null);
  assert.equal(parseGitFile('ref: refs/heads/main'), null);
  assert.equal(parseGitFile('gitdir:   '), null);
});

test('formatBranch: branch verbatim, sha truncated to 8, unknown null', () => {
  assert.equal(formatBranch({ kind: 'branch', name: 'main' }), 'main');
  assert.equal(
    formatBranch({ kind: 'detached', sha: '0123456789abcdef0123456789abcdef01234567' }),
    '01234567',
  );
  assert.equal(formatBranch({ kind: 'unknown' }), null);
});

test('findGitDir: finds a plain checkout from a nested directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });

  const info = findGitDir(nested);
  assert.ok(info);
  assert.equal(info.isWorktree, false);
  assert.equal(info.headFile, path.join(root, '.git', 'HEAD'));
  assert.deepEqual(readBranch(info), { kind: 'branch', name: 'main' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('findGitDir: follows a worktree .git file to its own HEAD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  const gitDir = path.join(root, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/side\n');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);

  const info = findGitDir(wt);
  assert.ok(info);
  assert.equal(info.isWorktree, true);
  assert.equal(info.gitDir, gitDir);
  assert.deepEqual(readBranch(info), { kind: 'branch', name: 'side' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('findGitDir: returns null outside a repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-nogit-'));
  assert.equal(findGitDir(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readBranch: missing HEAD file is unknown, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  const info = { gitDir: root, headFile: path.join(root, 'HEAD'), isWorktree: false };
  assert.deepEqual(readBranch(info), { kind: 'unknown' });
  fs.rmSync(root, { recursive: true, force: true });
});
