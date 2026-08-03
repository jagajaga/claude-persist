import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { claimOwnership, socketServing } from './ownership.js';
import { readLock } from './lock.js';

function scratch(): { lockFile: string; socketPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ownership-test-'));
  return { lockFile: path.join(dir, 'daemon.lock'), socketPath: path.join(dir, 'daemon.sock') };
}

/** A server that answers `hello`, i.e. a healthy daemon. */
function serving(socketPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', () => socket.write(`${JSON.stringify({ kind: 'response', id: 0, ok: true })}\n`));
    });
    server.listen(socketPath, () => resolve(server));
  });
}

/** A server that accepts connections and then ignores you: a wedged daemon. */
function accepting(socketPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer(() => undefined);
    server.listen(socketPath, () => resolve(server));
  });
}

/** A real live process to own a lock, so isAlive() is genuinely true. */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  return child;
}

// ------------------------------------------------------------- socketServing

test('socketServing: true when a daemon answers', async () => {
  const { socketPath } = scratch();
  const server = await serving(socketPath);
  try {
    assert.equal(await socketServing(socketPath), true);
  } finally {
    server.close();
  }
});

test('socketServing: false when there is no socket file at all', async () => {
  const { socketPath } = scratch();
  assert.equal(await socketServing(socketPath), false);
});

test('socketServing: false for a stale socket file with nothing behind it', async () => {
  const { socketPath } = scratch();
  fs.writeFileSync(socketPath, ''); // leftover file, not a live listener
  assert.equal(await socketServing(socketPath), false);
});

/**
 * Stronger than a connect check on purpose: a daemon stuck in synchronous work
 * accepts the connection and never replies. Treating that as "serving" would
 * make every replacement defer to a process that can't answer a request.
 */
test('socketServing: false when the listener accepts but never replies', async () => {
  const { socketPath } = scratch();
  const server = await accepting(socketPath);
  try {
    assert.equal(await socketServing(socketPath, 300), false);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------ claimOwnership

test('claimOwnership: takes a free lock', async () => {
  const { lockFile, socketPath } = scratch();
  assert.equal(await claimOwnership({ lockFile, socketPath, pid: 4242 }), true);
  assert.equal(readLock(lockFile), '4242');
});

test('claimOwnership: defers to an owner that is alive and serving', async () => {
  const { lockFile, socketPath } = scratch();
  const child = liveProcess();
  const server = await serving(socketPath);
  try {
    fs.writeFileSync(lockFile, String(child.pid));
    assert.equal(await claimOwnership({ lockFile, socketPath, pid: 999999 }), false);
    assert.equal(readLock(lockFile), String(child.pid)); // untouched
  } finally {
    server.close();
    child.kill('SIGKILL');
  }
});

test('claimOwnership: takes a lock left behind by a dead owner', async () => {
  const { lockFile, socketPath } = scratch();
  const child = liveProcess();
  const deadPid = child.pid!;
  await new Promise((r) => {
    child.once('exit', r);
    child.kill('SIGKILL');
  });
  fs.writeFileSync(lockFile, String(deadPid));
  assert.equal(await claimOwnership({ lockFile, socketPath, pid: 777 }), true);
  assert.equal(readLock(lockFile), '777');
});

/**
 * The wedge this whole module exists for. An older daemon's shutdown unlinks
 * socketPath unconditionally, deleting its successor's socket; the successor
 * keeps the lock but is unreachable, and before this every replacement exited
 * "daemon already running" until a human ran kill.
 */
test('claimOwnership: takes over from a live owner that is not serving', async () => {
  const { lockFile, socketPath } = scratch();
  const child = liveProcess();
  try {
    fs.writeFileSync(lockFile, String(child.pid));
    // No socket at all: exactly the state after an old daemon unlinked it.
    assert.equal(await claimOwnership({ lockFile, socketPath, pid: 555, graceMs: 300 }), true);
    assert.equal(readLock(lockFile), '555');
  } finally {
    child.kill('SIGKILL');
  }
});

test('claimOwnership: takes over from an owner whose listener has wedged', async () => {
  const { lockFile, socketPath } = scratch();
  const child = liveProcess();
  const server = await accepting(socketPath);
  try {
    fs.writeFileSync(lockFile, String(child.pid));
    const claimed = await claimOwnership({
      lockFile,
      socketPath,
      pid: 556,
      graceMs: 300,
      probeMs: 300,
    });
    assert.equal(claimed, true);
    assert.equal(readLock(lockFile), '556');
  } finally {
    server.close();
    child.kill('SIGKILL');
  }
});

test('claimOwnership: signals the displaced owner rather than only stealing the lock', async () => {
  const { lockFile, socketPath } = scratch();
  const child = liveProcess();
  let signalled = false;
  child.once('exit', () => {
    signalled = true;
  });
  fs.writeFileSync(lockFile, String(child.pid));
  assert.equal(await claimOwnership({ lockFile, socketPath, pid: 557, graceMs: 400 }), true);
  // SIGTERM reaches it; the grace loop gives it time to go.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(signalled, true, 'displaced owner should have been SIGTERMed, not left running');
  child.kill('SIGKILL'); // no-op if already gone
});

test('claimOwnership: garbage in the lock file does not block takeover', async () => {
  const { lockFile, socketPath } = scratch();
  fs.writeFileSync(lockFile, 'not-a-pid');
  assert.equal(await claimOwnership({ lockFile, socketPath, pid: 888 }), true);
  assert.equal(readLock(lockFile), '888');
});
