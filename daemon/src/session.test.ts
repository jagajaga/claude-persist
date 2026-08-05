import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@claude-persist/shared';

// DaemonSession reads its files from paths.ts's `sessionsDir`, which is
// derived from os.homedir() at import time. Point HOME at a scratch
// directory *before* the first import of session.js in this process so
// nothing here ever touches a real ~/.claude-persist.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-session-test-'));
fs.mkdirSync(path.join(tmpHome, '.claude-persist', 'sessions'), { recursive: true });
process.env.HOME = tmpHome;

const { DaemonSession } = await import('./session.js');

function sessionsDir(): string {
  return path.join(tmpHome, '.claude-persist', 'sessions');
}

const noopCallbacks = {
  onEvent(): void {},
  onDelta(): void {},
  onMetaChanged(): void {},
  onModels(): void {},
  onRateLimit(): void {},
  onUsage(): void {},
  rateLimitWindows: () => ({}),
  log(): void {},
  onLimited: (at: number) => ({ retryAt: at, switchedTo: null }),
  beforeRetry: () => null,
};

function makeSession(id: string): InstanceType<typeof DaemonSession> {
  const meta = { id, title: id, cwd: '/tmp', createdAt: 0, lastActivityAt: 0 };
  return new DaemonSession(meta, noopCallbacks);
}

/** appendEvent is `private` at the type level only — TS erases that at
 * runtime, so tests drive it directly instead of going through sendMessage()
 * (which would spin up a real Agent SDK subprocess). */
function append(session: InstanceType<typeof DaemonSession>, event: ChatEvent): void {
  (session as unknown as { appendEvent(e: ChatEvent): void }).appendEvent(event);
}

test('a brand-new session has eventCount 0 and no events', () => {
  const session = makeSession(`fresh-${Date.now()}`);
  assert.equal(session.eventCount, 0);
  assert.deepEqual(session.eventsSince(0, 400), { events: [], hasEarlier: false });
});

test('eventCount and eventsSince track appended events, seq assigned in order', () => {
  const id = `count-${Date.now()}`;
  const session = makeSession(id);
  for (let i = 0; i < 5; i++) append(session, { type: 'assistant_text', text: `msg ${i}` });

  assert.equal(session.eventCount, 5);
  const { events, hasEarlier } = session.eventsSince(0, 400);
  assert.equal(hasEarlier, false);
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
});

test('eventsSince caps to the newest `limit` and reports hasEarlier', () => {
  const id = `limit-${Date.now()}`;
  const session = makeSession(id);
  for (let i = 0; i < 10; i++) append(session, { type: 'assistant_text', text: `msg ${i}` });

  const { events, hasEarlier } = session.eventsSince(0, 4);
  assert.equal(hasEarlier, true);
  assert.deepEqual(
    events.map((e) => e.seq),
    [6, 7, 8, 9],
  );
});

test('eventsSince(seq) past the end returns nothing', () => {
  const id = `past-end-${Date.now()}`;
  const session = makeSession(id);
  for (let i = 0; i < 3; i++) append(session, { type: 'assistant_text', text: `msg ${i}` });

  assert.deepEqual(session.eventsSince(100, 400), { events: [], hasEarlier: false });
  assert.deepEqual(session.eventsSince(3, 400), { events: [], hasEarlier: false });
});

test('reconstructing a session from disk preserves eventCount and seq continuity', () => {
  const id = `reload-${Date.now()}`;
  const first = makeSession(id);
  for (let i = 0; i < 7; i++) append(first, { type: 'assistant_text', text: `msg ${i}` });
  assert.equal(first.eventCount, 7);

  // Simulate a daemon restart: a fresh DaemonSession for the same id re-reads
  // the log file from disk instead of resuming any in-memory state.
  const reloaded = makeSession(id);
  assert.equal(reloaded.eventCount, 7);
  append(reloaded, { type: 'assistant_text', text: 'msg 7' });
  assert.equal(reloaded.eventCount, 8);
  const { events } = reloaded.eventsSince(0, 400);
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

test('appending past ROTATE_THRESHOLD rotates the active log without losing or renumbering events', () => {
  const id = `rotate-${Date.now()}`;
  const session = makeSession(id);
  const n = 4500; // > 2x ROTATE_THRESHOLD, so more than one rotation happens
  for (let i = 0; i < n; i++) append(session, { type: 'assistant_text', text: `msg ${i}` });

  assert.equal(session.eventCount, n);

  const files = fs.readdirSync(sessionsDir()).filter((f) => f.startsWith(`${id}.jsonl`));
  assert.ok(files.length > 1, `expected rotation to produce more than one file, got: ${files.join(', ')}`);

  // Every archive plus the active file, read back in order, must reproduce
  // exactly the events that were appended, with contiguous seq numbers —
  // rotation must not drop, duplicate, or reorder anything.
  const ordered = files.sort((a, b) => {
    const ga = a === `${id}.jsonl` ? Infinity : Number(a.split('.').pop());
    const gb = b === `${id}.jsonl` ? Infinity : Number(b.split('.').pop());
    return ga - gb;
  });
  let expectedSeq = 0;
  for (const f of ordered) {
    const lines = fs
      .readFileSync(path.join(sessionsDir(), f), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    for (const l of lines) {
      const parsed = JSON.parse(l) as { seq: number };
      assert.equal(parsed.seq, expectedSeq);
      expectedSeq++;
    }
  }
  assert.equal(expectedSeq, n);

  // A fresh reload after rotation must still see the whole (rotated) history.
  const reloaded = makeSession(id);
  assert.equal(reloaded.eventCount, n);
  const tail = reloaded.eventsSince(0, 50);
  assert.equal(tail.events.length, 50);
  assert.equal(tail.hasEarlier, true);
  assert.deepEqual(
    tail.events.map((e) => e.seq),
    Array.from({ length: 50 }, (_, i) => n - 50 + i),
  );
});

/**
 * A daemon restart used to kill whatever was mid-turn: shutdown() disposes every
 * session, closing the SDK query, and nothing recorded that work had been in
 * progress. A long agentic turn simply stopped — no result, no error, nothing to
 * resume from. Restarts are routine (upgrades, protocol bumps, crashes), so the
 * turn has to be queued the same way a rate-limited one is.
 */
test('parkForRestart: queues a running turn so it continues after the restart', () => {
  const id = `restart-${Date.now()}`;
  const session = makeSession(id);
  session.status = 'running';

  assert.equal(session.parkForRestart(), true);

  const pendingFile = path.join(sessionsDir(), `${id}.pending.json`);
  assert.equal(fs.existsSync(pendingFile), true, 'the queued turn must survive the process');
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as {
    retryAt: number;
    attempts: number;
  };
  assert.ok(pending.retryAt > Date.now(), 'scheduled for after the daemon is back');
  assert.ok(pending.retryAt < Date.now() + 60_000, 'and soon, not parked for a limit window');
  assert.equal(pending.attempts, 0, 'a restart is not a rate-limit attempt');

  // And the panel is told, rather than the turn vanishing silently.
  const { events } = session.eventsSince(0, 10);
  const notice = events.at(-1)?.event;
  assert.equal(notice?.type, 'status');
  assert.match((notice as { detail?: string }).detail ?? '', /restarted mid-turn/);
});

test('parkForRestart: an idle session has nothing to queue', () => {
  const session = makeSession(`idle-restart-${Date.now()}`);
  assert.equal(session.parkForRestart(), false);
  assert.equal(session.eventCount, 0, 'and says nothing about it');
});

test('parkForRestart: does not overwrite a turn already queued for a limit', () => {
  const id = `already-${Date.now()}`;
  const session = makeSession(id);
  session.status = 'running';
  const pendingFile = path.join(sessionsDir(), `${id}.pending.json`);
  fs.writeFileSync(pendingFile, JSON.stringify({ text: 'limit', retryAt: 4102444800000, attempts: 3 }));
  (session as unknown as { pending: unknown }).pending = { text: 'limit', retryAt: 4102444800000, attempts: 3 };

  assert.equal(session.parkForRestart(), true);
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as { attempts: number };
  assert.equal(pending.attempts, 3, 'the limit-driven schedule wins');
});
