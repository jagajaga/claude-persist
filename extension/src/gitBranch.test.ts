import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  registeredWorktrees,
  parseHead,
  parseGitFile,
  formatBranch,
  chipLabel,
  findGitDir,
  readBranch,
  workPlaces,
  type GitInfo,
  type WorkPlace,
} from './gitBranch';

/** A place, as workPlaces() reports one. */
function place(over: Partial<WorkPlace> = {}): WorkPlace {
  return { name: 'main', branch: 'main', path: '/repo', worktree: false, current: true, ...over };
}

test('chipLabel: one place shows its name', () => {
  assert.deepEqual(chipLabel([place()]), { text: 'main', worktree: false });
});

test('chipLabel: one worktree shows its name, marked as a worktree', () => {
  const wt = place({ name: 'fix-1130', branch: 'fix/1130', worktree: true });
  assert.deepEqual(chipLabel([wt]), { text: 'fix-1130', worktree: true });
});

/**
 * Once subagents take worktrees of their own, no single name is the answer.
 * The chip counts and the list behind it says which.
 */
test('chipLabel: several places collapse to a count', () => {
  const chip = chipLabel([
    place(),
    place({ name: 'fix-1130', worktree: true, current: false }),
    place({ name: 'fix-1131', worktree: true, current: false }),
  ]);
  assert.deepEqual(chip, { text: '3', worktree: true });
});

test('chipLabel: nothing to show is null', () => {
  assert.equal(chipLabel([]), null);
});

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
  assert.equal(info.root, wt); // the worktree's own directory, not the main repo
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
  const info = { gitDir: root, headFile: path.join(root, 'HEAD'), isWorktree: false, root, commonDir: root };
  assert.deepEqual(readBranch(info), { kind: 'unknown' });
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Unfiltered on purpose. The previous version required a `locked` marker and a
 * path under .claude/worktrees; against a real repository that matched none of
 * 38 worktrees, because agents create them with a plain `git worktree add`.
 */
test('registeredWorktrees: every registration is returned, lock or not', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-reg-'));
  const reg = path.join(repo, '.git', 'worktrees');
  const add = (name: string, target: string, locked: boolean): void => {
    const d = path.join(reg, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'gitdir'), `${target}\n`);
    fs.writeFileSync(path.join(d, 'HEAD'), `ref: refs/heads/topic/${name}\n`);
    if (locked) fs.writeFileSync(path.join(d, 'locked'), '');
  };
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  add('anywhere', '/home/coder/wt/anywhere/.git', false);
  add('locked-one', '/srv/checkouts/locked-one/.git', true);

  const info = findGitDir(repo);
  assert.ok(info);
  const found = registeredWorktrees(info);
  assert.deepEqual(found.map((w) => w.name), ['anywhere', 'locked-one']);
  assert.deepEqual(found.map((w) => w.path), ['/home/coder/wt/anywhere', '/srv/checkouts/locked-one']);
  assert.deepEqual(found.map((w) => w.branch), ['topic/anywhere', 'topic/locked-one']);
});

test('heldWorktrees: a repository with no linked worktrees is empty', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-held-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const info = {
    gitDir: path.join(repo, '.git'),
    headFile: path.join(repo, '.git', 'HEAD'),
    isWorktree: false,
    root: repo,
    commonDir: path.join(repo, '.git'),
  };
  assert.deepEqual(registeredWorktrees(info), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// workPlaces: everywhere this conversation has work in progress
// ---------------------------------------------------------------------------

/** A repository with worktrees on disk, each on its own branch. */
function repoWithWorktrees(names: string[]): { root: string; info: GitInfo } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-places-'));
  fs.mkdirSync(path.join(root, '.git', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  for (const name of names) {
    const checkout = path.join(root, '.claude', 'worktrees', name);
    fs.mkdirSync(checkout, { recursive: true });
    const reg = path.join(root, '.git', 'worktrees', name);
    fs.mkdirSync(reg, { recursive: true });
    fs.writeFileSync(path.join(reg, 'gitdir'), `${path.join(checkout, '.git')}\n`);
    fs.writeFileSync(path.join(reg, 'HEAD'), `ref: refs/heads/fix/${name}\n`);
  }
  const info = findGitDir(root);
  assert.ok(info);
  return { root, info };
}

test('workPlaces: a plain checkout is one place, named by its branch', () => {
  const { root, info } = repoWithWorktrees([]);
  const places = workPlaces(info, root, []);
  assert.equal(places.length, 1);
  assert.deepEqual(
    { name: places[0].name, branch: places[0].branch, worktree: places[0].worktree, current: places[0].current },
    { name: 'main', branch: 'main', worktree: false, current: true },
  );
});

test('workPlaces: a worktree in use is listed, with the branch it is on', () => {
  const { root, info } = repoWithWorktrees(['1130', '1131']);
  const inUse = ['1130', '1131'].map((n) => path.join(root, '.claude', 'worktrees', n));
  const places = workPlaces(info, root, inUse);
  assert.deepEqual(places.map((p) => p.name), ['main', '1130', '1131']);
  assert.deepEqual(places.map((p) => p.branch), ['main', 'fix/1130', 'fix/1131']);
  assert.deepEqual(places.map((p) => p.current), [true, false, false]);
  assert.ok(places.every((p) => p.path.length > 0));
});

/**
 * The path comes from git's own `gitdir` pointer rather than from the name: a
 * worktree's directory need not be called what the worktree is called, and a
 * guessed path would send the user somewhere that does not exist.
 */
test('workPlaces: the path is read from git, not built from the name', () => {
  const { root, info } = repoWithWorktrees(['1130']);
  const reg = path.join(root, '.git', 'worktrees', '1130');
  const elsewhere = path.join(root, '.claude', 'worktrees', 'renamed-on-disk');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(reg, 'gitdir'), `${path.join(elsewhere, '.git')}\n`);

  const places = workPlaces(info, root, [elsewhere]);
  assert.equal(places[1].path, elsewhere);
});

test('workPlaces: an unreadable worktree is skipped rather than faked', () => {
  const { root, info } = repoWithWorktrees(['1130']);
  const wt = path.join(root, '.claude', 'worktrees', '1130');
  fs.rmSync(path.join(root, '.git', 'worktrees', '1130', 'gitdir'));
  assert.deepEqual(workPlaces(info, root, [wt]).map((p) => p.name), ['main']);
});

/**
 * The point of the rewrite: a registered worktree nobody is in is not somewhere
 * this conversation is working. One repository here had 38 registered and two
 * in use.
 */
test('workPlaces: registered but idle worktrees are not listed', () => {
  const { root, info } = repoWithWorktrees(['1130', '1131']);
  assert.deepEqual(workPlaces(info, root, []).map((p) => p.name), ['main']);
  const one = path.join(root, '.claude', 'worktrees', '1131');
  assert.deepEqual(workPlaces(info, root, [one]).map((p) => p.name), ['main', '1131']);
});
