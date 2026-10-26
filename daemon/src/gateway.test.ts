import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startGateway } from './gateway.js';

interface Handle { id: number; send: (m: unknown) => void; closed: boolean }

/** A fake daemon: echoes requests, and lets a test push to every client. */
function fakeDaemon() {
  const handles: Handle[] = [];
  let next = 0;
  return {
    handles,
    handlers: {
      open: (send: (m: unknown) => void): Handle => {
        const h = { id: next++, send, closed: false };
        handles.push(h);
        return h;
      },
      request: (h: Handle, req: { id: number; op: string } & Record<string, unknown>) => {
        if (req.op === 'boom') throw new Error('it broke');
        if (req.op === 'slow') return new Promise((r) => setTimeout(() => r('late'), 30));
        return { echo: req.op, client: h.id };
      },
      close: (h: Handle) => { h.closed = true; },
    },
  };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
}

test('ws: a request gets its response, matched by id', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const ws = await connect(gw.port);
  ws.send(JSON.stringify({ id: 7, op: 'listSessions' }));
  assert.deepEqual(await nextMessage(ws), { kind: 'response', id: 7, ok: true, result: { echo: 'listSessions', client: 0 } });
  ws.close();
  await gw.close();
});

test('ws: a failing request answers with its error, and the connection survives', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const ws = await connect(gw.port);
  ws.send(JSON.stringify({ id: 1, op: 'boom' }));
  assert.deepEqual(await nextMessage(ws), { kind: 'response', id: 1, ok: false, error: 'it broke' });
  ws.send(JSON.stringify({ id: 2, op: 'hello' }));
  assert.equal((await nextMessage(ws)).id, 2);
  ws.close();
  await gw.close();
});

test('ws: pushes reach the client', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const ws = await connect(gw.port);
  await new Promise((r) => setTimeout(r, 20));
  d.handles[0].send({ kind: 'event', sessionId: 's', event: { seq: 3 } });
  assert.deepEqual(await nextMessage(ws), { kind: 'event', sessionId: 's', event: { seq: 3 } });
  ws.close();
  await gw.close();
});

test('ws: junk and non-requests are ignored, not fatal', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const ws = await connect(gw.port);
  ws.send('not json');
  ws.send(JSON.stringify({ op: 'no id' }));
  ws.send(JSON.stringify({ id: 9, op: 'hello' }));
  assert.equal((await nextMessage(ws)).id, 9);
  ws.close();
  await gw.close();
});

test('ws: closing the socket releases what the client held', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const ws = await connect(gw.port);
  await new Promise((r) => setTimeout(r, 20));
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.handles[0].closed, true);
  await gw.close();
});

/**
 * A phone that walks out of coverage never closes its socket. Without pings
 * its subscriptions would sit there until TCP gave up, many minutes later.
 */
test('ws: a client that stops answering pings is dropped', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers, heartbeatMs: 40 });
  const ws = await connect(gw.port);
  // Stop answering: the ws client auto-replies to pings unless we cut it off.
  (ws as unknown as { _socket: { pause(): void } })._socket.pause();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.handles[0].closed, true, 'released after missing pongs');
  ws.terminate();
  await gw.close();
});

test('ws: a client that answers pings is kept', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers, heartbeatMs: 40 });
  const ws = await connect(gw.port);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.handles[0].closed, false);
  ws.close();
  await gw.close();
});

/**
 * A phone busy sending a big frame can't get its pong through until the
 * frame is done. It was dropped for that -- 260 times in one evening, each
 * drop losing the chunk in flight. Data arriving counts as alive.
 */
test('ws: a client still sending is kept though it answers no pings', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers, heartbeatMs: 40 });
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`, { autoPong: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const busy = setInterval(() => ws.send('x'.repeat(1000)), 15);
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(d.handles[0].closed, false, 'still sending: kept');
    clearInterval(busy);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(d.handles[0].closed, true, 'silent and no pongs: dropped');
  } finally {
    // Closed whatever happened, so a failure fails rather than hanging the run.
    clearInterval(busy);
    ws.terminate();
    await gw.close();
  }
});

/** For networks where WebSockets die or are filtered: one request, plain HTTP. */
test('rpc: a single request over HTTP, with its throwaway client released', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const res = await fetch(`http://127.0.0.1:${gw.port}/proxy/7790/rpc`, {
    method: 'POST',
    body: JSON.stringify({ id: 4, op: 'slow' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { kind: 'response', id: 4, ok: true, result: 'late' });
  assert.equal(d.handles[0].closed, true, 'nothing left subscribed after the answer');
  await gw.close();
});

test('rpc: a body that is not a request is refused', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const bad = await fetch(`http://127.0.0.1:${gw.port}/rpc`, { method: 'POST', body: 'nope' });
  assert.equal(bad.status, 400);
  const notReq = await fetch(`http://127.0.0.1:${gw.port}/rpc`, { method: 'POST', body: '{"x":1}' });
  assert.equal(notReq.status, 400);
  await gw.close();
});

test('rpc: an oversized body is refused before it is read in full', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers, maxPayloadBytes: 1000 });
  const res = await fetch(`http://127.0.0.1:${gw.port}/rpc`, { method: 'POST', body: 'x'.repeat(5000) }).catch(() => null);
  assert.ok(!res || res.status === 413, `got ${res?.status}`);
  await gw.close();
});

test('health: answers under any proxy prefix', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  const res = await fetch(`http://127.0.0.1:${gw.port}/proxy/7790/health`);
  assert.deepEqual(await res.json(), { ok: true });
  await gw.close();
});

/**
 * The one property that keeps the gateway off the public network: it is only
 * ever reached through code-server's proxy, behind the owner's login. Being
 * reachable on 127.0.0.1 proves nothing -- 0.0.0.0 is reachable there too --
 * so this checks the address actually bound.
 */
test('it binds to loopback only', async () => {
  const d = fakeDaemon();
  const gw = await startGateway({ port: 0, handlers: d.handlers });
  assert.equal(gw.address, '127.0.0.1');
  await gw.close();
});
