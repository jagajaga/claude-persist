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
      return { gitDir, headFile: path.join(gitDir, 'HEAD'), isWorktree: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function readBranch(info: GitInfo): HeadState {
  try {
    return parseHead(fs.readFileSync(info.headFile, 'utf8'));
  } catch {
    return { kind: 'unknown' };
  }
}
