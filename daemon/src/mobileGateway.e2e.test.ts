// The real daemon, started with the gateway on, driven over a real WebSocket
// the way the phone will drive it. Unit tests cover each piece; this covers
// the wiring between them, which is where "every part passes and it does not
// work" lives.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-gw-e2e-'));
let daemon: ChildProcess;
let port = 0;
let ws: WebSocket;
let nextId = 1;
const pushes: Array<Record<string, unknown>> = [];
const waiting = new Map<number, (m: Record<string, unknown>) => void>();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** A request, answered or failed within a few seconds -- never a hang. */
function call(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${op} within 10s`));
    }, 10_000);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(m);
    });
    ws.send(JSON.stringify({ id, op, ...args }));
  });
}

async function waitForGateway(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('gateway never came up');
}

before(async () => {
  port = await freePort();
  daemon = spawn(process.execPath, [path.join(__dirname_(), 'main.js')], {
    env: { ...process.env, HOME: home, CLAUDE_PERSIST_GATEWAY_PORT: String(port), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    stdio: 'ignore',
  });
  await waitForGateway();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown>;
    if (m.kind === 'response') waiting.get(m.id as number)?.(m);
    else pushes.push(m);
  });
});

after(async () => {
  ws?.close();
  daemon?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
});

function __dirname_(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}

test('e2e: the daemon answers hello over the gateway', async () => {
  const r = await call('hello', { protocolVersion: 0 });
  assert.equal(r.ok, true);
  assert.equal(typeof (r.result as { protocolVersion: number }).protocolVersion, 'number');
});

test('e2e: chats can be listed and created, with the directory chosen', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'project-'));
  const created = await call('createSession', { cwd: dir, title: 'from the phone' });
  assert.equal(created.ok, true, String(created.error));
  const list = await call('listSessions');
  const sessions = list.result as Array<{ title: string; cwd: string }>;
  assert.ok(sessions.some((s) => s.title === 'from the phone' && s.cwd === dir));
});

test('e2e: server stats come back with real numbers', async () => {
  await call('serverStats');
  const r = await call('serverStats');
  const s = r.result as { cores: number; memory: { totalBytes: number }; load: number[] };
  assert.ok(s.cores > 0);
  assert.ok(s.memory.totalBytes > 0);
  assert.equal(s.load.length, 3);
});

test('e2e: the file browser lists and reads', async () => {
  fs.writeFileSync(path.join(home, 'note.txt'), 'hi from disk');
  const list = await call('fsList', { path: home });
  assert.ok((list.result as { entries: Array<{ name: string }> }).entries.some((e) => e.name === 'note.txt'));
  const read = await call('fsRead', { path: path.join(home, 'note.txt') });
  assert.equal((read.result as { data: string }).data, 'hi from disk');
});

test('e2e: a bad path is an error answer, not a dead connection', async () => {
  const r = await call('fsList', { path: 'relative/path' });
  assert.equal(r.ok, false);
  assert.equal((await call('hello', { protocolVersion: 0 })).ok, true);
});

/**
 * The outbox's guarantee, end to end: a phone that never heard back sends the
 * same message again, and the transcript holds it once.
 */
test('e2e: a resent message with the same client id is recorded once', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'idem-'));
  const s = (await call('createSession', { cwd: dir, title: 'idempotency' })).result as { id: string };
  await call('attach', { sessionId: s.id, sinceSeq: 0 });
  const first = await call('sendMessage', { sessionId: s.id, text: 'once', clientMessageId: 'phone-1' });
  const again = await call('sendMessage', { sessionId: s.id, text: 'once', clientMessageId: 'phone-1' });
  assert.deepEqual(first.result, { duplicate: false });
  assert.deepEqual(again.result, { duplicate: true });
  const replay = (await call('attach', { sessionId: s.id, sinceSeq: 0 })).result as { events: Array<{ event: { type: string; text?: string } }> };
  const copies = replay.events.filter((e) => e.event.type === 'user_message' && e.event.text === 'once');
  assert.equal(copies.length, 1);
});

test('e2e: a file uploads in chunks and lands beside the session', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'upload-'));
  const s = (await call('createSession', { cwd: dir, title: 'upload target' })).result as { id: string };
  const chunk = (offset: number, text: string, done = false) =>
    call('uploadChunk', { sessionId: s.id, uploadId: 'u1', name: 'log.txt', offset, data: Buffer.from(text).toString('base64'), done });
  assert.deepEqual((await chunk(0, 'part one, ')).result, { received: 10 });
  const done = (await chunk(10, 'part two', true)).result as { received: number; path: string };
  assert.equal(fs.readFileSync(done.path, 'utf8'), 'part one, part two');
  assert.ok(done.path.includes(s.id));
  const bad = await call('uploadChunk', { sessionId: 'no-such-chat', uploadId: 'u', name: 'x', offset: 0, data: '' });
  assert.equal(bad.ok, false);
});

test('e2e: history answers with older events, read-only', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'history-'));
  const s = (await call('createSession', { cwd: dir, title: 'history source' })).result as { id: string };
  const r = await call('history', { sessionId: s.id, beforeSeq: 0, limit: 50 });
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(r.result, { events: [], hasEarlier: false });
});

test('e2e: the feed answers with recent events across chats', async () => {
  const r = await call('feed', { limit: 50 });
  assert.equal(r.ok, true);
  const items = r.result as Array<{ sessionId: string; event: { event: { type: string } } }>;
  assert.ok(items.some((i) => i.event.event.type === 'user_message'), 'the idempotency test left a message');
});

test('e2e: plain HTTP /rpc works when WebSockets do not', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/proxy/${port}/rpc`, {
    method: 'POST',
    body: JSON.stringify({ id: 1, op: 'listSessions' }),
  });
  const body = (await res.json()) as { ok: boolean; result: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.result));
});

/**
 * The feed is live, not only a snapshot: a phone following every chat hears
 * about a new message in one it never opened.
 */
test('e2e: the feed delivers new messages from chats the client never attached', async () => {
  const feedWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r, j) => { feedWs.once('open', r); feedWs.once('error', j); });
  const seen: Array<Record<string, unknown>> = [];
  const answered = new Promise<void>((resolve) => {
    feedWs.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m.kind === 'response' && m.id === 1) resolve();
      else if (m.kind === 'event') seen.push(m);
    });
  });
  feedWs.send(JSON.stringify({ id: 1, op: 'feed', limit: 5 }));
  await answered;
  const dir = fs.mkdtempSync(path.join(home, 'feed-'));
  const s = (await call('createSession', { cwd: dir, title: 'feed source' })).result as { id: string };
  await call('sendMessage', { sessionId: s.id, text: 'news for the feed', clientMessageId: 'feed-1' });
  await new Promise((r) => setTimeout(r, 300));
  const hit = seen.find((m) => m.sessionId === s.id && (m.event as { event: { text?: string } }).event.text === 'news for the feed');
  assert.ok(hit, `feed got ${seen.length} events, none of them the new message`);
  feedWs.close();
});
