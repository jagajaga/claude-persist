import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSampler, killProcess, parsePidStat, parsePidStatus, type ProcSource } from './processes.js';

interface Fake {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  cpu: number;
  rssKb: number;
  swapKb?: number;
  cwd?: string | null;
  uid?: number;
  start?: number;
}

/** A /proc built from a list, with CPU times that can be advanced between samples. */
function fakeProc(procs: Fake[], opts: { self?: number; existing?: string[] } = {}) {
  let now = 1_000_000;
  const byPid = new Map(procs.map((p) => [p.pid, { ...p }]));
  const exists = new Set(opts.existing ?? ['/home/me/project', '/']);
  const source: ProcSource = {
    pids: () => [...byPid.keys()],
    read: (pid, file) => {
      const p = byPid.get(pid);
      if (!p) return null;
      if (file === 'stat') {
        const f = Array.from({ length: 50 }, () => '0');
        f[0] = 'S';
        f[4 - 3] = String(p.ppid);
        f[14 - 3] = String(p.cpu);
        f[15 - 3] = '0';
        f[22 - 3] = String(p.start ?? 0);
        return `${p.pid} (${p.comm}) ${f.join(' ')}`;
      }
      if (file === 'status') return `Name:\t${p.comm}\nUid:\t${p.uid ?? 1000}\t1000\t1000\t1000\nVmRSS:\t${p.rssKb} kB\nVmSwap:\t${p.swapKb ?? 0} kB\n`;
      return p.cmd.split(' ').join('\0') + '\0';
    },
    cwd: (pid) => (byPid.get(pid)?.cwd === undefined ? '/home/me/project' : byPid.get(pid)!.cwd ?? null),
    exists: (path) => exists.has(path),
    uptime: () => 10_000,
    passwd: () => 'root:x:0:0::/root:/bin/sh\ncoder:x:1000:1000::/home/coder:/bin/zsh\n',
    clockTicks: 100,
    self: opts.self ?? 50,
    now: () => now,
  };
  return {
    source,
    advance(ms: number, cpuTicks: Record<number, number>) {
      now += ms;
      for (const [pid, ticks] of Object.entries(cpuTicks)) byPid.get(Number(pid))!.cpu += ticks;
    },
  };
}

const machine = (): Fake[] => [
  { pid: 1, ppid: 0, comm: 'dumb-init', cmd: 'dumb-init /usr/bin/code-server --auth none', cpu: 0, rssKb: 1000 },
  { pid: 38, ppid: 1, comm: 'node', cmd: '/usr/lib/code-server/lib/node /usr/lib/code-server/out/node/entry', cpu: 0, rssKb: 300_000 },
  { pid: 50, ppid: 1, comm: 'node', cmd: 'node /x/daemon/dist/main.js', cpu: 0, rssKb: 90_000 },
  { pid: 60, ppid: 50, comm: 'claude', cmd: '/x/claude-agent-sdk-linux-x64/claude --resume=abc', cpu: 0, rssKb: 330_000 },
  { pid: 700, ppid: 1, comm: 'node', cmd: 'node vite --port 5199', cpu: 0, rssKb: 2_000_000, cwd: '/home/me/.claude/worktrees/gone (deleted)' },
  { pid: 701, ppid: 700, comm: 'esbuild', cmd: 'esbuild --service', cpu: 0, rssKb: 500_000, cwd: '/home/me/.claude/worktrees/gone (deleted)' },
  { pid: 800, ppid: 1, comm: 'python', cmd: 'python -m pytest', cpu: 0, rssKb: 280_000 },
];

test('stat: a command name with spaces and parentheses does not shift the fields', () => {
  const f = Array.from({ length: 50 }, () => '0');
  f[0] = 'R';
  f[1] = '42'; // ppid
  f[11] = '700'; // utime
  const parsed = parsePidStat(`9 (my (weird) name) ${f.join(' ')}`);
  assert.equal(parsed?.comm, 'my (weird) name');
  assert.equal(parsed?.ppid, 42);
  assert.equal(parsed?.utime, 700);
});

test('status: rss, swap and uid', () => {
  assert.deepEqual(parsePidStatus('Uid:\t1000\t1000\nVmRSS:\t2048 kB\nVmSwap:\t1024 kB\n'), { rssBytes: 2048 * 1024, swapBytes: 1024 * 1024, uid: 1000 });
  assert.deepEqual(parsePidStatus('Name: kthreadd\n'), { rssBytes: 0, swapBytes: 0, uid: null });
});

/** The first reading has nothing to compare with, so it says "unknown", not 0%. */
test('cpu: unknown on the first sample, measured from the second', () => {
  const fake = fakeProc(machine());
  const sampler = new ProcessSampler(fake.source);
  assert.equal(sampler.sample().processes.find((p) => p.pid === 800)?.cpuPercent, null);
  fake.advance(2000, { 800: 400 }); // 4 s of CPU in 2 s: two cores busy
  assert.equal(sampler.sample().processes.find((p) => p.pid === 800)?.cpuPercent, 200);
});

test('the busiest and the biggest are both listed', () => {
  const fake = fakeProc(machine());
  const sampler = new ProcessSampler(fake.source);
  sampler.sample(2);
  fake.advance(1000, { 800: 100 });
  const pids = sampler.sample(2).processes.map((p) => p.pid);
  assert.ok(pids.includes(800), 'busiest');
  assert.ok(pids.includes(700), 'biggest');
});

/** The thing that filled this machine: dev servers in deleted worktrees. */
test('a process whose working directory was deleted is an orphan', () => {
  const sampler = new ProcessSampler(fakeProc(machine()).source);
  const vite = sampler.sample().processes.find((p) => p.pid === 700)!;
  assert.equal(vite.orphaned, true);
  assert.equal(vite.cwd, '/home/me/.claude/worktrees/gone');
  assert.equal(sampler.sample().processes.find((p) => p.pid === 800)!.orphaned, false);
});

test('a tree reports its children and the memory they hold', () => {
  const vite = new ProcessSampler(fakeProc(machine()).source).sample().processes.find((p) => p.pid === 700)!;
  assert.equal(vite.descendants, 1);
  assert.equal(vite.treeRssBytes, (2_000_000 + 500_000) * 1024);
});

/** Killing these would end the connection the kill was sent over. */
test('pid 1, code-server and the daemon itself are protected', () => {
  const procs = new ProcessSampler(fakeProc(machine()).source).sample(100).processes;
  const flag = (pid: number) => procs.find((p) => p.pid === pid)!;
  assert.equal(flag(1).protected, true);
  assert.equal(flag(38).protected, true);
  assert.equal(flag(50).protected, true);
  assert.equal(flag(50).role, 'daemon');
  assert.equal(flag(700).protected, false);
});

test('a Claude session process is named as one, and is not protected', () => {
  const claude = new ProcessSampler(fakeProc(machine()).source).sample(100).processes.find((p) => p.pid === 60)!;
  assert.equal(claude.role, 'claude-session');
  assert.equal(claude.protected, false);
});

test('orphans: every orphaned process, never a protected one', () => {
  const orphans = new ProcessSampler(fakeProc(machine()).source).orphans().map((p) => p.pid).sort();
  assert.deepEqual(orphans, [700, 701]);
});

test('users are named from passwd', () => {
  const procs = new ProcessSampler(fakeProc([{ pid: 9, ppid: 1, comm: 'sshd', cmd: 'sshd', cpu: 0, rssKb: 1, uid: 0 }]).source).sample().processes;
  assert.equal(procs[0].user, 'root');
});

// ---------- killing -----------------------------------------------------------

const snapshot = () => new ProcessSampler(fakeProc(machine()).source).sample(100).processes;
const kids: Record<number, number[]> = { 700: [701], 701: [] };

test('kill: children first, so nothing respawns what was just killed', () => {
  const sent: Array<[number, string]> = [];
  const r = killProcess(700, 'SIGTERM', true, snapshot(), (p) => kids[p] ?? [], (p, s) => { sent.push([p, s]); });
  assert.deepEqual(sent, [[701, 'SIGTERM'], [700, 'SIGTERM']]);
  assert.deepEqual(r.signalled, [701, 700]);
});

/** A watcher restarts its worker; the deepest go first, all the way down. */
test('kill: grandchildren before children before the parent', () => {
  const sent: number[] = [];
  const tree: Record<number, number[]> = { 700: [701], 701: [702], 702: [] };
  killProcess(700, 'SIGTERM', true, snapshot(), (p) => tree[p] ?? [], (p) => { sent.push(p); });
  assert.deepEqual(sent, [702, 701, 700]);
});

test('kill: without tree, only the one process', () => {
  const sent: number[] = [];
  killProcess(700, 'SIGKILL', false, snapshot(), (p) => kids[p] ?? [], (p) => { sent.push(p); });
  assert.deepEqual(sent, [700]);
});

test('kill: a protected process is refused, and nothing is signalled', () => {
  const sent: number[] = [];
  const r = killProcess(38, 'SIGKILL', true, snapshot(), () => [], (p) => { sent.push(p); });
  assert.deepEqual(sent, []);
  assert.match(r.refused ?? '', /code-server/);
});

/** A tree that contains the daemon must not take the daemon with it. */
test('kill: a protected process inside a tree is skipped, the rest still go', () => {
  const sent: number[] = [];
  const r = killProcess(99, 'SIGTERM', true, snapshot(), (p) => (p === 99 ? [50, 98] : []), (p) => { sent.push(p); },
    (p) => (p === 50 ? 'this daemon' : null));
  assert.deepEqual(sent, [98, 99]);
  assert.equal(r.failed[0].pid, 50);
});

test('kill: a process that is already gone is reported, not thrown', () => {
  const r = killProcess(700, 'SIGTERM', false, snapshot(), () => [], () => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  assert.deepEqual(r.failed, [{ pid: 700, error: 'ESRCH' }]);
});

/** Measured on the real host: the claude binary sits under code-server's extensions dir. */
test('a session is a session even when its binary lives under code-server', () => {
  const procs = new ProcessSampler(fakeProc([
    { pid: 1, ppid: 0, comm: 'dumb-init', cmd: 'dumb-init /usr/bin/code-server', cpu: 0, rssKb: 1 },
    { pid: 50, ppid: 1, comm: 'node', cmd: 'node /x/daemon/dist/main.js', cpu: 0, rssKb: 1 },
    { pid: 920, ppid: 50, comm: 'claude', cmd: '/home/coder/.local/share/code-server/extensions/jaga.claude-persist-vscode-1.0.93-linux-x64/daemon/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --resume=x', cpu: 0, rssKb: 400_000 },
    { pid: 38, ppid: 19, comm: 'node', cmd: '/usr/lib/code-server/lib/node /usr/lib/code-server/out/node/entry', cpu: 0, rssKb: 300_000 },
  ]).source).sample(100).processes;
  const by = (pid: number) => procs.find((p) => p.pid === pid)!;
  assert.equal(by(920).role, 'claude-session');
  assert.equal(by(920).protected, false, 'a runaway chat must be killable');
  assert.equal(by(38).role, 'code-server');
});
