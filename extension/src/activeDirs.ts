import * as fs from 'fs';
import * as path from 'path';

/**
 * Which of these directories a process is working in right now.
 *
 * The question "which worktrees is this conversation using" has no answer in
 * git: a worktree registration says a checkout exists, not that anyone is in
 * it. This repository had 38 registered and one in use. Marking them by lock
 * file does not work either -- the agents here create worktrees with a plain
 * `git worktree add`, which locks nothing, so the previous check matched none
 * of them, ever.
 *
 * A live process with its working directory inside one is not a heuristic: it
 * is the thing being asked about. Reading /proc costs about a millisecond for
 * a container's worth of processes.
 *
 * Non-Linux hosts have no /proc and get an empty answer, which shows the
 * session's own checkout and nothing else -- fewer than the truth, never more.
 */
/** The session a process belongs to, from the tag the daemon set on it. */
function sessionOf(procDir: string, pid: string): string | null {
  try {
    const environ = fs.readFileSync(path.join(procDir, pid, 'environ'), 'utf8');
    for (const entry of environ.split('\0')) {
      if (entry.startsWith(TAG)) return entry.slice(TAG.length);
    }
  } catch {
    // not ours to read, or it exited; it simply goes unattributed
  }
  return null;
}

const TAG = 'CLAUDE_PERSIST_SESSION=';

/**
 * Which of these directories a process is working in, and for whom.
 *
 * The unattributed form of this question -- "is anyone in this worktree" --
 * cannot tell two conversations apart, so every session working in a repository
 * listed every other session's worktrees as its own.
 */
export function dirsInUseBySession(
  candidates: string[],
  procDir = '/proc',
): Map<string, Set<string>> {
  const bySession = new Map<string, Set<string>>();
  for (const dir of dirsInUse(candidates, procDir, bySession)) {
    if (!bySession.has(dir)) bySession.set(dir, new Set());
  }
  return bySession;
}

export function dirsInUse(
  candidates: string[],
  procDir = '/proc',
  attribute?: Map<string, Set<string>>,
): string[] {
  if (candidates.length === 0) return [];
  let pids: string[];
  try {
    pids = fs.readdirSync(procDir).filter((name) => /^\d+$/.test(name));
  } catch {
    return []; // no /proc: not Linux, or it is not mounted
  }
  const roots = candidates.map((dir) => ({ dir, prefix: dir.endsWith(path.sep) ? dir : dir + path.sep }));
  const inUse = new Set<string>();
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = fs.readlinkSync(path.join(procDir, pid, 'cwd'));
    } catch {
      continue; // exited between the listing and the read, or not ours to see
    }
    for (const { dir, prefix } of roots) {
      // Compare on a path boundary: /a/b must not match /a/bc.
      if (cwd !== dir && !cwd.startsWith(prefix)) continue;
      inUse.add(dir);
      if (!attribute) continue;
      const session = sessionOf(procDir, pid);
      if (!session) continue;
      const owners = attribute.get(dir) ?? new Set<string>();
      owners.add(session);
      attribute.set(dir, owners);
    }
  }
  return [...inUse].sort();
}
