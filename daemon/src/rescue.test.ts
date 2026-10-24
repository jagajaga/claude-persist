import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESCUE_OOM_ADJ, protectRescuePath, protectionScript, rescueFailure, rescueTargets } from './rescue.js';
import type { ProcSource } from './processes.js';

function source(cmds: Record<number, string>, self = 50): ProcSource {
  return {
    pids: () => Object.keys(cmds).map(Number),
    read: (pid, file) => (file === 'cmdline' ? (cmds[pid] ?? '').split(' ').join('\0') : null),
    cwd: () => null,
    exists: () => true,
    uptime: () => 0,
    passwd: () => '',
    clockTicks: 100,
    self,
    now: () => 0,
  };
}

test('targets: this daemon and code-server, nothing else', () => {
  const pids = rescueTargets(source({
    1: 'dumb-init /usr/bin/code-server --auth none',
    19: '/usr/lib/code-server/lib/node /usr/lib/code-server --auth none',
    38: '/usr/lib/code-server/lib/node /usr/lib/code-server/out/node/entry',
    73: '/usr/lib/code-server/lib/node /usr/lib/code-server/lib/vscode/out/bootstrap-fork --type=extensionHost',
    50: 'node /x/daemon/dist/main.js',
    700: 'node vite --port 5199',
  }));
  assert.deepEqual(pids, [19, 38, 50], 'the extension host and the dev server are not the way in');
});

test('script: oom protection for each, and every thread reniced', () => {
  const script = protectionScript([38, 50]);
  assert.match(script, /for p in 38 50; do/);
  assert.match(script, new RegExp(`echo ${RESCUE_OOM_ADJ} > /proc/\\$p/oom_score_adj`));
  assert.match(script, /for t in \/proc\/\$p\/task\/\*; do renice -n -5 -p/);
});

/** -1000 means "never kill", which would let this daemon itself exhaust the machine. */
test('script: protected, not immortal', () => {
  assert.ok(RESCUE_OOM_ADJ > -1000);
});

test('script: nothing but real pids reaches the shell', () => {
  const script = protectionScript([38, -1, 0, 1.5, Number.NaN, 50]);
  assert.match(script, /for p in 38 50; do/);
});

test('protect: uses sudo -n, so it never waits on a password prompt', () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fakeRun = ((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    calls.push({ cmd, args });
    cb(null);
  }) as unknown as typeof import('node:child_process').execFile;
  const logs: string[] = [];
  protectRescuePath([38, 50], (m) => logs.push(m), fakeRun);
  assert.equal(calls[0].cmd, 'sudo');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-n', 'sh', '-c']);
  assert.match(logs[0], /protected pids 38,50/);
});

test('protect: without sudo it says so and carries on', () => {
  const fakeRun = ((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) =>
    cb(new Error('sudo: a password is required'))) as unknown as typeof import('node:child_process').execFile;
  const logs: string[] = [];
  protectRescuePath([50], (m) => logs.push(m), fakeRun);
  assert.match(logs[0], /could not protect 50: no passwordless sudo; continuing unprotected/);
});

/** Measured on this host: root inside Docker, both writes refused. */
test('failure: a container without the capabilities is named as such', () => {
  const stderr = 'sh: 3: echo: echo: I/O error\nrenice: failed to set priority for 19 (process ID): Operation not permitted\n';
  assert.match(rescueFailure('Command failed: sudo -n sh -c for p in 19; do', stderr), /CAP_SYS_RESOURCE.*cap_add/);
});

test('failure: no sudo is said plainly', () => {
  assert.equal(rescueFailure('Command failed', 'sudo: a password is required\n'), 'no passwordless sudo');
});

test('failure: anything else shows its own first line, not the command', () => {
  assert.equal(rescueFailure('Command failed: sudo -n sh -c long script', 'sh: renice: not found\n'), 'sh: renice: not found');
});
