// What the server is doing right now: CPU, memory, swap, load and disk, for
// the phone's stats screen.
//
// Read from /proc rather than through `top` or `os`: os.loadavg() and
// os.freemem() exist, but "free" memory is the wrong number -- Linux fills
// spare RAM with page cache, so a healthy box reads as nearly full. What a
// person means by "how much RAM is left" is MemAvailable, and only
// /proc/meminfo has it. CPU busy-ness likewise needs two samples of
// /proc/stat; a single read is only the total since boot.
import fs from 'node:fs';
import os from 'node:os';

export interface CpuTimes {
  /** Jiffies spent doing anything. */
  busy: number;
  /** Jiffies in total, idle included. */
  total: number;
}

export interface ServerStats {
  /** Percent of all cores busy over the last sample interval, 0-100. */
  cpuPercent: number | null;
  cores: number;
  load: [number, number, number];
  memory: { totalBytes: number; availableBytes: number };
  swap: { totalBytes: number; freeBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  uptimeSeconds: number;
  processes: number | null;
  sampledAt: number;
}

/** The aggregate "cpu" line of /proc/stat, as busy and total jiffies. */
export function parseCpuTimes(procStat: string): CpuTimes | null {
  const line = procStat.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  // guest and guest_nice are already counted inside user and nice.
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const idleAll = idle + iowait;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idleAll };
}

/** Busy share between two samples, as a percentage. */
export function cpuPercentBetween(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  if (total <= 0) return null;
  const busy = after.busy - before.busy;
  return Math.max(0, Math.min(100, (busy / total) * 100));
}

/** The fields of /proc/meminfo that answer "how much is left", in bytes. */
export function parseMeminfo(meminfo: string): {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
} | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(meminfo);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  // MemAvailable is what a person means by "free". Kernels before 3.14 lack
  // it; there the old approximation is free + buffers + cache.
  const available =
    kb('MemAvailable') ??
    ((kb('MemFree') ?? 0) + (kb('Buffers') ?? 0) + (kb('Cached') ?? 0));
  if (total === null) return null;
  return {
    totalBytes: total,
    availableBytes: available,
    swapTotalBytes: kb('SwapTotal') ?? 0,
    swapFreeBytes: kb('SwapFree') ?? 0,
  };
}

/** /proc/loadavg: the three averages, and the process count. */
export function parseLoadavg(loadavg: string): { load: [number, number, number]; processes: number | null } | null {
  const parts = loadavg.trim().split(/\s+/);
  const load = parts.slice(0, 3).map(Number);
  if (load.length !== 3 || load.some((n) => !Number.isFinite(n))) return null;
  // Fourth field is "running/total".
  const total = Number((parts[3] ?? '').split('/')[1]);
  return { load: load as [number, number, number], processes: Number.isFinite(total) ? total : null };
}

export interface StatsSource {
  read: (file: string) => string;
  cores: () => number;
  uptime: () => number;
  disk: (path: string) => { totalBytes: number; freeBytes: number } | null;
  now: () => number;
}

const realSource: StatsSource = {
  read: (file) => fs.readFileSync(file, 'utf8'),
  cores: () => os.cpus().length,
  uptime: () => os.uptime(),
  disk: (p) => {
    try {
      const s = fs.statfsSync(p);
      return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

/**
 * Samples the machine on request, keeping the previous CPU reading so each
 * call reports busy-ness since the last one rather than since boot.
 *
 * The first call has nothing to compare against and reports cpuPercent null,
 * not a made-up number; the phone polls, so the second call is moments away.
 */
export class StatsSampler {
  private last: CpuTimes | null = null;

  constructor(
    private readonly source: StatsSource = realSource,
    private readonly diskPath: string = os.homedir(),
  ) {}

  sample(): ServerStats {
    const safe = <T>(fn: () => T): T | null => {
      try {
        return fn();
      } catch {
        return null;
      }
    };
    const cpu = safe(() => parseCpuTimes(this.source.read('/proc/stat')));
    const cpuPercent = cpu && this.last ? cpuPercentBetween(this.last, cpu) : null;
    if (cpu) this.last = cpu;
    const mem = safe(() => parseMeminfo(this.source.read('/proc/meminfo')));
    const load = safe(() => parseLoadavg(this.source.read('/proc/loadavg')));
    const disk = this.source.disk(this.diskPath);
    return {
      cpuPercent,
      cores: this.source.cores(),
      load: load?.load ?? [0, 0, 0],
      memory: { totalBytes: mem?.totalBytes ?? 0, availableBytes: mem?.availableBytes ?? 0 },
      swap: { totalBytes: mem?.swapTotalBytes ?? 0, freeBytes: mem?.swapFreeBytes ?? 0 },
      disk: disk ? { path: this.diskPath, ...disk } : null,
      uptimeSeconds: this.source.uptime(),
      processes: load?.processes ?? null,
      sampledAt: this.source.now(),
    };
  }
}
