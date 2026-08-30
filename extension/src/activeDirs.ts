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
export function dirsInUse(candidates: string[], procDir = '/proc'): string[] {
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
      if (cwd === dir || cwd.startsWith(prefix)) inUse.add(dir);
    }
  }
  return [...inUse].sort();
}
