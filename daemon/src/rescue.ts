// Keeping the way in alive when the machine is not.
//
// The path from the phone to this daemon runs through code-server, and under
// memory pressure the kernel's OOM killer picks by size, not by importance:
// measured on this host, code-server scored 670 and this daemon 668, level
// with the very dev servers that were eating the machine. Lose either and the
// app cannot reach the processes it was opened to kill.
//
// So, when asked to (`"protect": true` in gateway.json), the daemon makes the
// path harder to kill: a strongly negative oom_score_adj, so the kernel takes
// the hogs first, and a small CPU priority boost, so it is still scheduled on a
// machine at load 80. Lowering either needs privilege; this uses passwordless
// sudo if the host has it, once, at startup -- while the machine is healthy
// enough to run it -- and does nothing at all if it does not.
import { execFile } from 'node:child_process';
import type { ProcSource } from './processes.js';

/** Low enough that the kernel kills almost anything else first; not -1000, which is "never". */
export const RESCUE_OOM_ADJ = -800;
/** A nudge, not a land-grab: enough to be scheduled under load. */
export const RESCUE_NICE = -5;

/** This daemon, and the code-server processes that carry the proxy. */
export function rescueTargets(source: ProcSource): number[] {
  const targets = new Set<number>([source.self]);
  for (const pid of source.pids()) {
    const cmd = (source.read(pid, 'cmdline') ?? '').split('\0').join(' ');
    // The server that answers HTTP and proxies /proxy/<port>/, and its launcher.
    if (/\/code-server\/out\/node\/entry/.test(cmd) || /\/usr\/lib\/code-server\/lib\/node \/usr\/lib\/code-server(?:\s|$)/.test(cmd)) {
      targets.add(pid);
    }
  }
  return [...targets].sort((a, b) => a - b);
}

/**
 * One shell script for all of it, so the privilege is asked for once.
 *
 * Every thread is reniced: setpriority on a pid changes only the thread with
 * that id, and Node does its work on several.
 */
export function protectionScript(pids: number[], oomAdj = RESCUE_OOM_ADJ, nice = RESCUE_NICE): string {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0).join(' ');
  return [
    `for p in ${list}; do`,
    `  [ -d /proc/$p ] || continue`,
    `  echo ${oomAdj} > /proc/$p/oom_score_adj`,
    `  for t in /proc/$p/task/*; do renice -n ${nice} -p "\${t##*/}" >/dev/null; done`,
    `done`,
  ].join('\n');
}

/** Apply it; reports what happened, never throws. */
export function protectRescuePath(
  pids: number[],
  log: (message: string) => void,
  run: typeof execFile = execFile,
): void {
  if (pids.length === 0) return;
  run('sudo', ['-n', 'sh', '-c', protectionScript(pids)], { timeout: 10_000 }, (err) => {
    if (err) log(`rescue: could not protect ${pids.join(',')} (${err.message.split('\n')[0]}); continuing unprotected`);
    else log(`rescue: protected pids ${pids.join(',')} (oom_score_adj ${RESCUE_OOM_ADJ}, nice ${RESCUE_NICE})`);
  });
}
