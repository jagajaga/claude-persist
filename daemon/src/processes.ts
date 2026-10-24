// What is eating the machine, and a way to stop it -- from the phone, while
// the machine is struggling.
//
// Written for the moment it matters most. On 2026-10-10 this host had 3 GB of
// RAM left and 16 GB of swap full, mostly from dev servers whose worktrees had
// been deleted; on 2026-10-24 a pile of leaked test browsers took it down
// outright. In that state a new process may fail to start at all, so nothing
// here spawns one: no `ps`, no `top`, no `kill` binary. Everything is read
// straight from /proc and signalled with process.kill, which work as long as
// this process is scheduled at all.
import fs from 'node:fs';

export interface ProcInfo {
  pid: number;
  ppid: number;
  user: string;
  /** Percent of one core since the previous sample, top-style; null on the first. */
  cpuPercent: number | null;
  rssBytes: number;
  swapBytes: number;
  ageSeconds: number;
  /** The command line, trimmed for display. */
  command: string;
  /** Working directory, or null when it cannot be read (another user's). */
  cwd: string | null;
  /**
   * Its working directory no longer exists. A dev server left running in a
   * deleted worktree is the classic way this machine fills up.
   */
  orphaned: boolean;
  /** Children, recursively, and the memory they hold with it. */
  descendants: number;
  treeRssBytes: number;
  /** Killing this would cut off the way in: pid 1, code-server, this daemon. */
  protected: boolean;
  protectedReason?: string;
  /** Set for a Claude session's own process, so the phone can say which. */
  role?: 'claude-session' | 'daemon' | 'code-server';
}

export interface ProcessSnapshot {
  processes: ProcInfo[];
  /** All processes on the machine, for "showing 40 of 812". */
  total: number;
  /** Every orphan on the machine, listed or not: what reapOrphans would free. */
  orphans: { count: number; rssBytes: number };
  sampledAt: number;
}

/** Fields of /proc/<pid>/stat we use. */
export interface PidStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  utime: number;
  stime: number;
  starttime: number;
}

/**
 * /proc/<pid>/stat, parsed from the last ')' so a command name containing
 * spaces or parentheses cannot shift the fields.
 */
export function parsePidStat(text: string): PidStat | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  const f = text.slice(close + 2).split(' ');
  // f[0] is field 3 (state); field N is f[N - 3].
  const num = (n: number): number => Number(f[n - 3]);
  const parsed = {
    pid,
    comm,
    state: f[0] ?? '?',
    ppid: num(4),
    utime: num(14),
    stime: num(15),
    starttime: num(22),
  };
  return Number.isFinite(parsed.pid) && Number.isFinite(parsed.utime) ? parsed : null;
}

/** RSS, swap and the real uid from /proc/<pid>/status. */
export function parsePidStatus(text: string): { rssBytes: number; swapBytes: number; uid: number | null } {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const uid = /^Uid:\s+(\d+)/m.exec(text);
  return { rssBytes: kb('VmRSS'), swapBytes: kb('VmSwap'), uid: uid ? Number(uid[1]) : null };
}

export function parsePasswd(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid && /^\d+$/.test(uid)) users.set(Number(uid), name);
  }
  return users;
}

export interface ProcSource {
  pids(): number[];
  read(pid: number, file: 'stat' | 'status' | 'cmdline'): string | null;
  cwd(pid: number): string | null;
  exists(path: string): boolean;
  /** Seconds since boot. */
  uptime(): number;
  passwd(): string;
  /** Clock ticks per second; 100 on every Linux this will meet. */
  clockTicks: number;
  self: number;
  now(): number;
}

export const realProcSource: ProcSource = {
  pids: () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number),
  read: (pid, file) => {
    try {
      return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
    } catch {
      return null; // gone between listing and reading, or not ours
    }
  },
  cwd: (pid) => {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  exists: (p) => fs.existsSync(p),
  uptime: () => Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]),
  passwd: () => {
    try {
      return fs.readFileSync('/etc/passwd', 'utf8');
    } catch {
      return '';
    }
  },
  clockTicks: 100,
  self: process.pid,
  now: () => Date.now(),
};

/** Processes that, if killed, take the way in with them. */
function protection(pid: number, command: string, self: number, ancestors: Set<number>): string | null {
  if (pid === 1) return 'the container itself';
  if (pid === self) return 'this daemon, which you are talking to';
  if (ancestors.has(pid)) return 'a parent of this daemon';
  if (/\/code-server\/(?:lib\/node|out\/node\/entry)|\/usr\/bin\/code-server|dumb-init/.test(command)) {
    return 'code-server, the way in';
  }
  return null;
}

/**
 * Samples every process, keeping the previous CPU times so each call reports
 * busy-ness since the last one -- the phone polls, so the second call is
 * seconds away and the first reports CPU as unknown rather than guessing.
 */
export class ProcessSampler {
  private last = new Map<number, { cpu: number; at: number }>();
  private users: Map<number, string> | null = null;

  constructor(private readonly source: ProcSource = realProcSource) {}

  /** The top processes by CPU and by memory, merged; protected ones flagged. */
  sample(limit = 40): ProcessSnapshot {
    const src = this.source;
    this.users ??= parsePasswd(src.passwd());
    const uptime = src.uptime();
    const now = src.now();
    const all: Array<PidStat & { rssBytes: number; swapBytes: number; uid: number | null }> = [];
    for (const pid of src.pids()) {
      const stat = src.read(pid, 'stat');
      const parsed = stat ? parsePidStat(stat) : null;
      if (!parsed) continue;
      const status = src.read(pid, 'status');
      all.push({ ...parsed, ...(status ? parsePidStatus(status) : { rssBytes: 0, swapBytes: 0, uid: null }) });
    }

    const byPid = new Map(all.map((p) => [p.pid, p]));
    const children = new Map<number, number[]>();
    for (const p of all) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid)!.push(p.pid);
    }
    const ancestors = new Set<number>();
    for (let p = byPid.get(src.self)?.ppid; p && p > 1 && !ancestors.has(p); p = byPid.get(p)?.ppid) ancestors.add(p);

    // CPU since the previous sample, per process.
    const nextLast = new Map<number, { cpu: number; at: number }>();
    const cpuOf = new Map<number, number | null>();
    for (const p of all) {
      const cpu = p.utime + p.stime;
      const prev = this.last.get(p.pid);
      const seconds = prev ? (now - prev.at) / 1000 : 0;
      cpuOf.set(p.pid, prev && seconds > 0 ? Math.max(0, ((cpu - prev.cpu) / src.clockTicks / seconds) * 100) : null);
      nextLast.set(p.pid, { cpu, at: now });
    }
    this.last = nextLast;

    const tree = (pid: number): { count: number; rss: number } => {
      let count = 0;
      let rss = 0;
      const stack = [...(children.get(pid) ?? [])];
      const seen = new Set<number>();
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        count++;
        rss += byPid.get(c)?.rssBytes ?? 0;
        stack.push(...(children.get(c) ?? []));
      }
      return { count, rss };
    };

    // Orphans are judged across every process, not just the ones listed: a
    // small leftover is still a leftover, and the phone's "kill orphans" button
    // must say how much it would free.
    const cwdOf = new Map<number, string | null>();
    const isOrphan = (pid: number): boolean => {
      if (!cwdOf.has(pid)) cwdOf.set(pid, src.cwd(pid));
      const cwd = cwdOf.get(pid)!;
      // The kernel marks a deleted directory "(deleted)"; a path that is gone is as good.
      return cwd !== null && (cwd.endsWith(' (deleted)') || !src.exists(cwd));
    };
    const commandOf = (p: (typeof all)[number]): string => {
      const raw = src.read(p.pid, 'cmdline') ?? '';
      return (raw.replace(/\0+$/, '').split('\0').join(' ') || `[${p.comm}]`).slice(0, 300);
    };
    const orphanList = all.filter((p) => isOrphan(p.pid) && protection(p.pid, commandOf(p), src.self, ancestors) === null);

    // The interesting ones: busiest, biggest and orphaned, merged, no duplicates.
    const byCpu = [...all].sort((a, b) => (cpuOf.get(b.pid) ?? 0) - (cpuOf.get(a.pid) ?? 0)).slice(0, limit);
    const byMem = [...all].sort((a, b) => b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes)).slice(0, limit);
    const chosen = new Map<number, (typeof all)[number]>();
    for (const p of [...byCpu, ...byMem, ...orphanList.slice(0, limit)]) chosen.set(p.pid, p);

    const processes: ProcInfo[] = [...chosen.values()].map((p) => {
      const command = commandOf(p);
      const orphaned = isOrphan(p.pid);
      const cwd = cwdOf.get(p.pid) ?? null;
      const reason = protection(p.pid, command, src.self, ancestors);
      const t = tree(p.pid);
      // Session first: the claude binary lives under code-server's extensions
      // directory (~/.local/share/code-server/extensions/.../claude), so a
      // looser "/code-server/" test called every chat part of code-server.
      const role: ProcInfo['role'] =
        p.pid === src.self ? 'daemon'
        : p.ppid === src.self && /claude-agent-sdk|\/claude(\s|$)/.test(command) ? 'claude-session'
        : /^\/usr\/lib\/code-server\/|^\/usr\/bin\/code-server/.test(command) ? 'code-server'
        : undefined;
      return {
        pid: p.pid,
        ppid: p.ppid,
        user: p.uid === null ? '?' : this.users!.get(p.uid) ?? String(p.uid),
        cpuPercent: cpuOf.get(p.pid) ?? null,
        rssBytes: p.rssBytes,
        swapBytes: p.swapBytes,
        ageSeconds: Math.max(0, uptime - p.starttime / src.clockTicks),
        command,
        cwd: cwd?.replace(/ \(deleted\)$/, '') ?? null,
        orphaned,
        descendants: t.count,
        treeRssBytes: p.rssBytes + t.rss,
        protected: reason !== null,
        ...(reason ? { protectedReason: reason } : {}),
        ...(role ? { role } : {}),
      };
    });
    const orphans = {
      count: orphanList.length,
      rssBytes: orphanList.reduce((n, p) => n + p.rssBytes, 0),
    };
    return { processes, total: all.length, orphans, sampledAt: now };
  }

  /** Every process whose working directory is gone, with its tree. */
  orphans(): ProcInfo[] {
    return this.sample(10_000).processes.filter((p) => p.orphaned && !p.protected);
  }
}

export interface KillResult {
  signalled: number[];
  failed: Array<{ pid: number; error: string }>;
  refused?: string;
}

/**
 * Signal a process, and with `tree` everything under it, children first so a
 * supervisor cannot respawn what was just killed.
 *
 * Refuses the protected processes outright: killing code-server or this daemon
 * from the phone would end the very connection the kill was sent over.
 */
export function killProcess(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  tree: boolean,
  snapshot: ProcInfo[],
  allChildren: (pid: number) => number[],
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  isProtected: (pid: number) => string | null = (p) => {
    const info = snapshot.find((s) => s.pid === p);
    return info?.protected ? info.protectedReason ?? 'protected' : null;
  },
): KillResult {
  const refusal = isProtected(pid);
  if (refusal) return { signalled: [], failed: [], refused: `Not killing pid ${pid}: ${refusal}` };
  const order: number[] = [];
  if (tree) {
    const visit = (p: number, seen: Set<number>): void => {
      for (const c of allChildren(p)) {
        if (seen.has(c)) continue;
        seen.add(c);
        visit(c, seen);
        order.push(c);
      }
    };
    visit(pid, new Set([pid]));
  }
  order.push(pid);
  const result: KillResult = { signalled: [], failed: [] };
  for (const p of order) {
    const why = isProtected(p);
    if (why) {
      result.failed.push({ pid: p, error: `skipped: ${why}` });
      continue;
    }
    try {
      kill(p, signal);
      result.signalled.push(p);
    } catch (err) {
      result.failed.push({ pid: p, error: (err as NodeJS.ErrnoException).code ?? String(err) });
    }
  }
  return result;
}

/** Children of a pid, read live: the snapshot only holds the interesting ones. */
export function childrenFrom(source: ProcSource): (pid: number) => number[] {
  return (pid) => {
    const out: number[] = [];
    for (const p of source.pids()) {
      const stat = source.read(p, 'stat');
      const parsed = stat ? parsePidStat(stat) : null;
      if (parsed?.ppid === pid) out.push(p);
    }
    return out;
  };
}
