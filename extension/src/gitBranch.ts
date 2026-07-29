import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads a repository's current branch straight off disk. No subprocess: git may
 * not be on PATH in a code-server container, and spawning per panel per branch
 * switch is wasteful when the answer is two small files.
 */
export type HeadState =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; sha: string }
  | { kind: 'unknown' };

export interface GitInfo {
  gitDir: string;
  headFile: string;
  /** True when the directory is a linked worktree with its own HEAD. */
  isWorktree: boolean;
  /** Directory holding the `.git` entry — the checkout's own root. */
  root: string;
  /** The repository's main git dir; linked worktrees are registered under it. */
  commonDir: string;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const REFS_HEADS = 'refs/heads/';
/** Depth guard: a symlink loop must not spin the walk forever. */
const MAX_DEPTH = 64;

export function parseHead(contents: string): HeadState {
  const line = contents.trim();
  if (!line) return { kind: 'unknown' };
  if (line.startsWith('ref:')) {
    const ref = line.slice(4).trim();
    const name = ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
    return name ? { kind: 'branch', name } : { kind: 'unknown' };
  }
  if (SHA_RE.test(line)) return { kind: 'detached', sha: line.toLowerCase() };
  return { kind: 'unknown' };
}

/** `gitdir: <path>` — how a linked worktree points at its own git directory. */
export function parseGitFile(contents: string): string | null {
  const line = contents.trim();
  if (!line.startsWith('gitdir:')) return null;
  const dir = line.slice('gitdir:'.length).trim();
  return dir || null;
}

/** Chip text for a head state; null means "show nothing". */
export function formatBranch(head: HeadState): string | null {
  if (head.kind === 'branch') return head.name;
  if (head.kind === 'detached') return head.sha.slice(0, 8);
  return null;
}

export function findGitDir(startDir: string): GitInfo | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) {
      return {
        gitDir: candidate,
        headFile: path.join(candidate, 'HEAD'),
        isWorktree: false,
        root: dir,
        commonDir: candidate,
      };
    }
    if (stat?.isFile()) {
      let target: string | null = null;
      try {
        target = parseGitFile(fs.readFileSync(candidate, 'utf8'));
      } catch {
        target = null;
      }
      if (!target) return null;
      const gitDir = path.isAbsolute(target) ? target : path.resolve(dir, target);
      // A linked worktree's git dir sits under <main>/.git/worktrees/<name>;
      // `commondir` points back at the repository everything is registered in.
      let commonDir = gitDir;
      try {
        const rel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (rel) commonDir = path.resolve(gitDir, rel);
      } catch {
        // Not readable — treat this worktree's own dir as the registry root.
      }
      return {
        gitDir,
        headFile: path.join(gitDir, 'HEAD'),
        isWorktree: true,
        root: dir,
        commonDir,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** What the composer chip shows, and which glyph it earns. */
export interface ChipState {
  text: string;
  /** True when this is worktree identity rather than a plain branch. */
  worktree: boolean;
}

/**
 * Decide the chip.
 *
 * A worktree wins outright: when one is in play its name *is* the answer to
 * "where is this working", and pairing it with a branch only crowds a chip
 * that has to survive a phone-width composer.
 */
export function chipLabel(
  branch: string | null,
  worktreeName: string | null,
  held: string[],
): ChipState | null {
  if (worktreeName) return { text: worktreeName, worktree: true };
  if (held.length === 1) return { text: held[0], worktree: true };
  // Several at once: no single name is the answer, so report how many.
  if (held.length > 1) return { text: String(held.length), worktree: true };
  if (branch) return { text: branch, worktree: false };
  return null;
}

/** Where Claude Code puts the worktrees it manages for subagents. */
const AGENT_WORKTREE_SEGMENT = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

/**
 * Names of agent worktrees the repository currently *holds* — registered under
 * .claude/worktrees and locked, which is how Claude Code marks one as in use.
 *
 * Read from git's own registry rather than from SDK hook events: the registry
 * is true regardless of which process created the worktree or when, so this
 * survives a daemon restart. Hook-based counting did not.
 */
export function heldWorktrees(info: GitInfo): string[] {
  const dir = path.join(info.commonDir, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no linked worktrees, or no repository
  }
  const held: string[] = [];
  for (const name of names) {
    // `locked` marks a worktree as actively held; an idle leftover has none.
    if (!fs.existsSync(path.join(dir, name, 'locked'))) continue;
    let target: string;
    try {
      target = fs.readFileSync(path.join(dir, name, 'gitdir'), 'utf8').trim();
    } catch {
      continue;
    }
    if (target.includes(AGENT_WORKTREE_SEGMENT)) held.push(name);
  }
  return held.sort();
}

export function readBranch(info: GitInfo): HeadState {
  try {
    return parseHead(fs.readFileSync(info.headFile, 'utf8'));
  } catch {
    return { kind: 'unknown' };
  }
}
