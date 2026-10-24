import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StatsSampler,
  cpuPercentBetween,
  parseCpuTimes,
  parseLoadavg,
  parseMeminfo,
  type StatsSource,
} from './serverStats.js';

const STAT = (user: number, idle: number) =>
  `cpu  ${user} 0 100 ${idle} 50 0 10 0 0 0\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 1 2 3\n`;

test('cpu: busy and total from the aggregate line, iowait counted as idle', () => {
  const t = parseCpuTimes(STAT(400, 1000));
  // busy = user + nice + system + irq + softirq + steal = 400+0+100+0+10+0
  assert.deepEqual(t, { busy: 510, total: 510 + 1000 + 50 });
});

test('cpu: a per-core line is not the aggregate', () => {
  assert.equal(parseCpuTimes('cpu0 1 2 3 4\n'), null);
});

test('cpu: percent between two samples', () => {
  const before = { busy: 100, total: 1000 };
  const after = { busy: 400, total: 2000 };
  assert.equal(cpuPercentBetween(before, after), 30);
});

test('cpu: no time passed means no answer, not 0% or NaN', () => {
  const s = { busy: 1, total: 10 };
  assert.equal(cpuPercentBetween(s, s), null);
});

/**
 * "Free" is the wrong number: Linux fills spare RAM with page cache, so a
 * healthy machine reads as nearly full. MemAvailable is what a person means.
 */
test('memory: available, not free', () => {
  const m = parseMeminfo('MemTotal: 32000000 kB\nMemFree: 1000000 kB\nMemAvailable: 20000000 kB\nSwapTotal: 16000000 kB\nSwapFree: 8000000 kB\n');
  assert.equal(m?.availableBytes, 20000000 * 1024);
  assert.equal(m?.totalBytes, 32000000 * 1024);
  assert.equal(m?.swapFreeBytes, 8000000 * 1024);
});

test('memory: old kernels without MemAvailable fall back to free + buffers + cache', () => {
  const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n');
  assert.equal(m?.availableBytes, 400 * 1024);
});

test('load: three averages and the process total', () => {
  assert.deepEqual(parseLoadavg('15.00 9.50 7.25 3/803 12345\n'), { load: [15, 9.5, 7.25], processes: 803 });
  assert.equal(parseLoadavg('garbage'), null);
});

function source(stats: string[]): StatsSource {
  let i = 0;
  return {
    read: (file) => {
      if (file === '/proc/stat') return stats[Math.min(i++, stats.length - 1)];
      if (file === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 600 kB\n';
      if (file === '/proc/loadavg') return '1.00 2.00 3.00 1/50 9\n';
      throw new Error(`unexpected ${file}`);
    },
    cores: () => 16,
    uptime: () => 3600,
    disk: () => ({ totalBytes: 100, freeBytes: 25 }),
    now: () => 42,
  };
}

/** The first reading has nothing to compare with; it says so instead of inventing a value. */
test('sampler: first call reports no CPU figure, the next one does', () => {
  const sampler = new StatsSampler(source([STAT(0, 0), STAT(500, 500)]), '/home/x');
  assert.equal(sampler.sample().cpuPercent, null);
  const second = sampler.sample();
  assert.ok(second.cpuPercent !== null && second.cpuPercent > 0, String(second.cpuPercent));
  assert.equal(second.cores, 16);
  assert.deepEqual(second.load, [1, 2, 3]);
  assert.equal(second.memory.availableBytes, 600 * 1024);
  assert.deepEqual(second.disk, { path: '/home/x', totalBytes: 100, freeBytes: 25 });
});

/** A box without /proc (macOS) still answers, with what it can. */
test('sampler: a missing /proc is degraded, not fatal', () => {
  const sampler = new StatsSampler({ ...source([]), read: () => { throw new Error('ENOENT'); } }, '/');
  const s = sampler.sample();
  assert.equal(s.cpuPercent, null);
  assert.equal(s.memory.totalBytes, 0);
  assert.equal(s.cores, 16);
});
