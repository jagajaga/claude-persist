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
import fs from 'node:fs';
import os from 'node:os';
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

/**
 * Why protection failed, in words. err.message starts with the whole command
 * line, which hid the cause: inside Docker even root is refused, because the
 * default capability set drops CAP_SYS_RESOURCE (needed to lower
 * oom_score_adj) and CAP_SYS_NICE (needed for a negative nice).
 */
export function rescueFailure(message: string, stderr: string): string {
  if (/I\/O error|Operation not permitted|Permission denied/.test(stderr)) {
    return 'root here lacks CAP_SYS_RESOURCE and CAP_SYS_NICE (a container drops them by default; ' +
      'add cap_add: [SYS_RESOURCE, SYS_NICE] to it)';
  }
  if (/password is required|a terminal is required/.test(stderr + message)) return 'no passwordless sudo';
  return (stderr.trim().split('\n')[0] || message.split('\n')[0]).slice(0, 200);
}

/** Apply it; reports what happened, never throws. `onProtected` runs only if it worked. */
export function protectRescuePath(
  pids: number[],
  log: (message: string) => void,
  run: typeof execFile = execFile,
  onProtected: () => void = () => {},
): void {
  if (pids.length === 0) return;
  run('sudo', ['-n', 'sh', '-c', protectionScript(pids)], { timeout: 10_000 }, (err, _stdout, stderr) => {
    if (!err) {
      log(`rescue: protected pids ${pids.join(',')} (oom_score_adj ${RESCUE_OOM_ADJ}, nice ${RESCUE_NICE})`);
      onProtected();
      return;
    }
    log(`rescue: could not protect ${pids.join(',')}: ${rescueFailure(err.message, String(stderr ?? ''))}; continuing unprotected`);
  });
}

// ---------------------------------------------------------------- inheritance
//
// A child starts with its parent's oom_score_adj and nice. Protect code-server
// and this daemon, and every process started afterwards inherits it: each chat
// the daemon runs, each terminal code-server opens, and each dev server those
// launch. The hog would be protected along with the way in, which is worse
// than no protection at all. So whatever carries the protection without being
// a target is put back to normal. Raising either value needs no privilege.

export interface PriorityIo {
  oomAdj(pid: number): number | null;
  setOomAdj(pid: number, value: number): void;
  threads(pid: number): number[];
  nice(tid: number): number | null;
  setNice(tid: number, value: number): void;
}

export const realPriorityIo: PriorityIo = {
  oomAdj: (pid) => {
    try {
      return Number(fs.readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8'));
    } catch {
      return null;
    }
  },
  setOomAdj: (pid, value) => fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(value)),
  threads: (pid) => {
    try {
      return fs.readdirSync(`/proc/${pid}/task`).map(Number);
    } catch {
      return [];
    }
  },
  nice: (tid) => {
    try {
      return os.getPriority(tid);
    } catch {
      return null;
    }
  },
  setNice: (tid, value) => os.setPriority(tid, value),
};

/**
 * Put every inheritor of the protection back to normal; returns the pids reset.
 * Only exactly our values are touched, so anything set by someone else stands.
 */
export function sweepInherited(pids: number[], targets: ReadonlySet<number>, io: PriorityIo = realPriorityIo): number[] {
  const reset: number[] = [];
  for (const pid of pids) {
    if (targets.has(pid) || io.oomAdj(pid) !== RESCUE_OOM_ADJ) continue;
    try {
      io.setOomAdj(pid, 0);
    } catch {
      continue; // gone, or not ours
    }
    for (const tid of io.threads(pid)) {
      if (io.nice(tid) !== RESCUE_NICE) continue;
      try {
        io.setNice(tid, 0);
      } catch {
        // exited between the read and the write
      }
    }
    reset.push(pid);
  }
  return reset;
}

/** How often inheritors are swept: a new hog carries the protection this long at most. */
export const SWEEP_MS = 10_000;
