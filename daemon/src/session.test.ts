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
  onLimited: (at: number) => ({ retryAt: at, switchedTo: null, why: 'all-limited' }),
  onAuthFailure: () => ({ retryAt: 0, switchedTo: null }),
  beforeRetry: () => null,
  onAgents(): void {},
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

/**
 * An account switch disposes the live query and a retry installs a replacement.
 * The disposed query keeps draining, and its trailing messages used to be
 * applied anyway: a final empty `result` arrived 3s after the resumed turn had
 * started and set the session idle, so the panel showed "not working" while work
 * was in fact running. Observed in session ac83b87e at 10:48:01.
 */
test('consume: messages from a replaced query are ignored', async () => {
  const session = makeSession(`stale-query-${Date.now()}`);
  const stale = (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'from the old query' }] } };
    yield { type: 'result', subtype: 'success', result: '' };
  })();

  // A replacement query is already installed, so `stale` is no longer current.
  (session as unknown as { activeQuery: unknown }).activeQuery = { replacement: true };
  session.status = 'running';

  await (session as unknown as { consume(q: AsyncIterable<unknown>): Promise<void> }).consume(stale);

  assert.equal(session.eventCount, 0, 'a replaced query must not append events');
  assert.equal(session.status, 'running', 'nor flip the status of the turn that replaced it');
});

test('consume: messages from the current query are applied as usual', async () => {
  const session = makeSession(`live-query-${Date.now()}`);
  const live = (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
  })();
  (session as unknown as { activeQuery: unknown }).activeQuery = live;

  await (session as unknown as { consume(q: AsyncIterable<unknown>): Promise<void> }).consume(live);

  const { events } = session.eventsSince(0, 10);
  assert.ok(
    events.some((e) => e.event.type === 'assistant_text'),
    'the current query still drives the session',
  );
});

// ---------------------------------------------------------------------------
// Subagent attribution
//
// Several subagents write into one transcript at once and their messages
// arrive interleaved, indistinguishable from the main thread's. Every event a
// subagent produces is stamped with which one, so the chat can badge it.
// ---------------------------------------------------------------------------

/** handleSdkMessage is private at the type level only; TS erases that. */
function feed(session: InstanceType<typeof DaemonSession>, msg: Record<string, unknown>): void {
  (session as unknown as { handleSdkMessage(m: Record<string, unknown>): void }).handleSdkMessage(msg);
}

function dispatchAgent(
  session: InstanceType<typeof DaemonSession>,
  id: string,
  description: string,
): void {
  feed(session, {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description } }] },
  });
}

function agentsOf(session: InstanceType<typeof DaemonSession>): Array<string | undefined> {
  return session
    .eventsSince(0, 400)
    .events.map((e) => (e.event as { agent?: string }).agent);
}

test('subagent text is stamped with the agent that wrote it', () => {
  const session = makeSession(`agent-stamp-${Date.now()}`);
  dispatchAgent(session, 'toolu_a', 'Check daemon logs');
  feed(session, {
    type: 'assistant',
    parent_tool_use_id: 'toolu_a',
    message: { content: [{ type: 'text', text: 'the log says the socket was stale' }] },
  });

  const events = session.eventsSince(0, 400).events;
  const text = events.find((e) => e.event.type === 'assistant_text');
  assert.equal((text?.event as { agent?: string }).agent, 'Check daemon logs');
});

test('the main thread is not badged', () => {
  const session = makeSession(`agent-main-${Date.now()}`);
  feed(session, {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: 'answering directly' }] },
  });
  assert.deepEqual(agentsOf(session), [undefined]);
});

/** The point of the badge: two agents interleaved stay told apart. */
test('two subagents writing at once keep their own names', () => {
  const session = makeSession(`agent-two-${Date.now()}`);
  dispatchAgent(session, 'toolu_a', 'Audit rotation');
  dispatchAgent(session, 'toolu_b', 'Check daemon logs');
  for (const [parent, text] of [
    ['toolu_a', 'rotation looks right'],
    ['toolu_b', 'the socket was stale'],
    ['toolu_a', 'except the cooldown'],
  ] as const) {
    feed(session, {
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'text', text }] },
    });
  }

  const said = session
    .eventsSince(0, 400)
    .events.filter((e) => e.event.type === 'assistant_text')
    .map((e) => (e.event as { agent?: string }).agent);
  assert.deepEqual(said, ['Audit rotation', 'Check daemon logs', 'Audit rotation']);
});

test("a subagent's tool calls and results are badged too", () => {
  const session = makeSession(`agent-tools-${Date.now()}`);
  dispatchAgent(session, 'toolu_a', 'Check daemon logs');
  feed(session, {
    type: 'assistant',
    parent_tool_use_id: 'toolu_a',
    message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }] },
  });
  feed(session, {
    type: 'user',
    parent_tool_use_id: 'toolu_a',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }] },
  });

  const events = session.eventsSince(0, 400).events;
  const read = events.find(
    (e) => e.event.type === 'tool_use' && (e.event as { toolName: string }).toolName === 'Read',
  );
  const result = events.find((e) => e.event.type === 'tool_result');
  assert.equal((read?.event as { agent?: string }).agent, 'Check daemon logs');
  assert.equal((result?.event as { agent?: string }).agent, 'Check daemon logs');
});

/**
 * Level signals replace the agent map wholesale and key it by SDK task id,
 * while subagent messages carry the tool_use id — the two never join. The
 * dispatch description is remembered separately for exactly this reason.
 */
test('a badge survives the CLI taking over agent tracking', () => {
  const session = makeSession(`agent-level-${Date.now()}`);
  dispatchAgent(session, 'toolu_a', 'Audit rotation');
  feed(session, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'task_99', task_type: 'agent', description: 'something else' }],
  });
  feed(session, {
    type: 'assistant',
    parent_tool_use_id: 'toolu_a',
    message: { content: [{ type: 'text', text: 'still me' }] },
  });

  const text = session.eventsSince(0, 400).events.find((e) => e.event.type === 'assistant_text');
  assert.equal((text?.event as { agent?: string }).agent, 'Audit rotation');
});

/**
 * There is one preview line. With several subagents writing at once their
 * deltas arrived interleaved and it became a shuffle of two or three answers.
 */
test('only the main thread streams into the live preview', () => {
  const deltas: string[] = [];
  const meta = { id: `agent-delta-${Date.now()}`, title: 't', cwd: '/tmp', createdAt: 0, lastActivityAt: 0 };
  const session = new DaemonSession(meta, {
    ...noopCallbacks,
    onDelta(_id: string, text: string): void {
      deltas.push(text);
    },
  });

  const delta = (parent: string | null, text: string) =>
    feed(session, {
      type: 'stream_event',
      parent_tool_use_id: parent,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
  delta(null, 'main ');
  delta('toolu_a', 'subagent ');
  delta(null, 'thread');

  assert.deepEqual(deltas, ['main ', 'thread']);
});

// ---------------------------------------------------------------------------
// A stalled turn
//
// Observed in blooper2.0-dima, 02:13 to 04:03: five "restart and continue"
// messages, each followed by exactly twenty more minutes of silence, then the
// session gave up and the user restarted it by hand. The retry was being
// pushed into the very query that had stopped answering.
// ---------------------------------------------------------------------------

function stall(session: InstanceType<typeof DaemonSession>): void {
  (session as unknown as { parkForLimit(t: string, o: { stalled?: boolean }): void }).parkForLimit('', {
    stalled: true,
  });
}

test('a stalled turn drops its query, so the retry starts a fresh one', () => {
  const session = makeSession(`stall-dispose-${Date.now()}`);
  session.status = 'running';
  const query = { closed: false, close(): void { this.closed = true; } };
  (session as unknown as { activeQuery: unknown }).activeQuery = query;

  stall(session);

  assert.equal(query.closed, true, 'the stalled query was left installed');
  assert.equal(
    (session as unknown as { activeQuery: unknown }).activeQuery,
    null,
    'sendMessage would reuse it and the retry would go nowhere',
  );
});

/** A rate limit is different: that query is fine and the account is the problem. */
test('a rate-limited turn keeps its query', () => {
  const session = makeSession(`limit-keeps-${Date.now()}`);
  session.status = 'running';
  const query = { closed: false, close(): void { this.closed = true; } };
  (session as unknown as { activeQuery: unknown }).activeQuery = query;

  (session as unknown as { parkForLimit(t: string, o: Record<string, unknown>): void }).parkForLimit(
    "You've hit your session limit · resets 3:10pm (UTC)",
    {},
  );

  assert.equal(query.closed, false);
});

test('a stall does not report itself as a rate limit', () => {
  const session = makeSession(`stall-words-${Date.now()}`);
  session.status = 'running';
  stall(session);

  const notice = session.eventsSince(0, 10).events.at(-1)?.event as { detail?: string };
  assert.doesNotMatch(notice.detail ?? '', /rate limit/i, 'a stall is not a limit');
  assert.match(notice.detail ?? '', /stopped responding/i);
});

/**
 * Giving up told the user they were "still rate limited" after a stall, which
 * sent them to look at a quota that was never the problem.
 */
test('giving up after stalls says what actually happened', () => {
  const session = makeSession(`stall-giveup-${Date.now()}`);
  session.status = 'running';
  for (let i = 0; i < 7; i++) stall(session);

  const details = session
    .eventsSince(0, 40)
    .events.map((e) => (e.event as { detail?: string }).detail ?? '');
  const giveUp = details.find((d) => /giving up/i.test(d));
  assert.ok(giveUp, 'never gave up');
  assert.match(giveUp, /not a rate limit/i);
});

// ---------------------------------------------------------------------------
// An account switch cuts off every session, not just the one that was refused
//
// Observed on 2026-08-30: sasha hit a spend limit at 19:19 and was parked and
// resumed automatically. Three other sessions were running on the same account
// and were disposed with nothing scheduled -- no error, no retry, no notice.
// They were restarted by hand, twice each, because the first message after a
// dead query returns error_during_execution.
// ---------------------------------------------------------------------------

test('a running turn is queued when the account changes under it', () => {
  const id = `switch-${Date.now()}`;
  const session = makeSession(id);
  session.status = 'running';

  assert.equal(session.parkForAccountSwitch(Date.now() + 5_000, 'serokell', 'rate limit'), true);

  const pendingFile = path.join(sessionsDir(), `${id}.pending.json`);
  assert.equal(fs.existsSync(pendingFile), true, 'nothing would resume this turn');
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as { retryAt: number };
  assert.ok(pending.retryAt > Date.now(), 'queued for the near future');

  const notice = session.eventsSince(0, 10).events.at(-1)?.event as { detail?: string };
  assert.match(notice.detail ?? '', /continue automatically/);
  assert.match(notice.detail ?? '', /serokell/, 'say where it went');
});

/** The reason is passed through: a user picking another account is not a limit. */
test('the notice states why the account changed', () => {
  const session = makeSession(`switch-reason-${Date.now()}`);
  session.status = 'running';
  session.parkForAccountSwitch(Date.now() + 5_000, 'work', 'signed in');

  const notice = session.eventsSince(0, 10).events.at(-1)?.event as { detail?: string };
  assert.match(notice.detail ?? '', /signed in/);
  assert.doesNotMatch(notice.detail ?? '', /rate limit/i);
});

test('an idle session has no turn to carry across', () => {
  const session = makeSession(`switch-idle-${Date.now()}`);
  assert.equal(session.parkForAccountSwitch(Date.now() + 5_000, 'work', 'rate limit'), false);
  assert.equal(session.eventCount, 0, 'and says nothing about it');
});

/** The refused session parked itself already; that schedule must win. */
test('a turn already queued for its own limit is not re-queued', () => {
  const id = `switch-already-${Date.now()}`;
  const session = makeSession(id);
  session.status = 'running';
  const pendingFile = path.join(sessionsDir(), `${id}.pending.json`);
  fs.writeFileSync(pendingFile, JSON.stringify({ text: 'limit', retryAt: 4102444800000, attempts: 3 }));
  (session as unknown as { pending: unknown }).pending = {
    text: 'limit',
    retryAt: 4102444800000,
    attempts: 3,
  };

  assert.equal(session.parkForAccountSwitch(Date.now() + 5_000, 'work', 'rate limit'), true);
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as { attempts: number };
  assert.equal(pending.attempts, 3, 'the limit-driven schedule wins');
});

// ---------------------------------------------------------------------------
// "Working" is not the same question as "status is running"
//
// Observed 2026-08-30 22:09: five sessions were working, three reported idle
// because their subagents were doing the work, and the daemon restart queued
// only the two marked running. The other three were killed with nothing
// scheduled and were restarted by hand. One of them had gone idle at 21:14 and
// produced a result at 21:37 -- twenty-three minutes of work, while idle.
// ---------------------------------------------------------------------------

test('a session with live subagents is busy, whatever its status says', () => {
  const session = makeSession(`busy-agents-${Date.now()}`);
  session.status = 'idle';
  (session as unknown as { agents: Map<string, unknown> }).agents = new Map([
    ['toolu_a', { id: 'toolu_a', description: 'reviewing', lastActivityAt: Date.now() }],
  ]);
  assert.equal(session.busy, true);
});

test('a session the SDK is still talking to is busy', () => {
  const session = makeSession(`busy-sdk-${Date.now()}`);
  session.status = 'idle';
  (session as unknown as { lastSdkActivityAt: number }).lastSdkActivityAt = Date.now();
  assert.equal(session.busy, true);
});

test('a genuinely idle session is not busy', () => {
  const session = makeSession(`busy-not-${Date.now()}`);
  session.status = 'idle';
  (session as unknown as { lastSdkActivityAt: number }).lastSdkActivityAt = Date.now() - 10 * 60_000;
  assert.equal(session.busy, false);
});

/** The whole point: this is what gets queued across a restart. */
test('a restart queues a session whose subagents are working', () => {
  const id = `busy-restart-${Date.now()}`;
  const session = makeSession(id);
  session.status = 'idle';
  (session as unknown as { lastSdkActivityAt: number }).lastSdkActivityAt = Date.now();

  assert.equal(session.parkForRestart(), true, 'this work would be lost silently');
  assert.equal(fs.existsSync(path.join(sessionsDir(), `${id}.pending.json`)), true);
});

test('a restart still leaves a genuinely idle session alone', () => {
  const session = makeSession(`busy-restart-idle-${Date.now()}`);
  session.status = 'idle';
  assert.equal(session.parkForRestart(), false);
});

// ---------------------------------------------------------------------------
// A login that has expired mid-conversation
// ---------------------------------------------------------------------------

function authFailure(
  session: InstanceType<typeof DaemonSession>,
  text = 'Failed to authenticate: OAuth session expired and could not be refreshed',
): void {
  (session as unknown as { handleSdkMessage(m: Record<string, unknown>): void }).handleSdkMessage({
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: text,
  });
}

test('an expired login moves to another account and carries on', () => {
  const meta = { id: `auth-move-${Date.now()}`, title: 't', cwd: '/tmp', createdAt: 0, lastActivityAt: 0 };
  const session = new DaemonSession(meta, {
    ...noopCallbacks,
    onAuthFailure: () => ({ retryAt: Date.now() + 5_000, switchedTo: 'serokell' }),
  });
  session.status = 'running';
  authFailure(session);

  const notice = session.eventsSince(0, 20).events.map((e) => e.event as { detail?: string; action?: string });
  const moved = notice.find((n) => /Switched to "serokell"/.test(n.detail ?? ''));
  assert.ok(moved, 'the turn stopped instead of moving on');
  assert.equal(moved.action, undefined, 'nothing to sign in to: it already moved');
  assert.ok(session.retryAt !== null, 'and it must actually be scheduled to continue');
});

/** Only when nowhere is left does it become the user's problem. */
test('with nowhere left to go it asks for a sign-in', () => {
  const session = makeSession(`auth-stuck-${Date.now()}`);
  session.status = 'running';
  authFailure(session);

  const notice = session.eventsSince(0, 20).events.map((e) => e.event as { action?: string });
  assert.ok(notice.some((n) => n.action === 'signin'), 'no way offered to fix it');
});

/** A missing install is not fixed by rotating: no account has it either. */
test('a missing Claude Code does not rotate accounts', () => {
  let asked = false;
  const meta = { id: `auth-nobin-${Date.now()}`, title: 't', cwd: '/tmp', createdAt: 0, lastActivityAt: 0 };
  const session = new DaemonSession(meta, {
    ...noopCallbacks,
    onAuthFailure: () => {
      asked = true;
      return { retryAt: 0, switchedTo: null };
    },
  });
  session.status = 'running';
  authFailure(session, 'Native CLI binary for linux-x64 not found');
  assert.equal(asked, false);
});

// ---------------------------------------------------------------------------
// Counting the images a conversation carries
//
// Past twenty images in one request the API applies a stricter per-image limit
// to all of them -- including ones resent from earlier turns -- and rejects
// what exceeds it. The panel shrinks uploads only once that is in reach, so it
// needs the count, and the count cannot be recovered from the event log: that
// log rotates and its tail is capped.
// ---------------------------------------------------------------------------

test('images are counted as they are appended', () => {
  const session = makeSession(`imgcount-${Date.now()}`);
  const meta = (session as unknown as { meta: { imageCount?: number } }).meta;
  assert.equal(meta.imageCount ?? 0, 0);

  append(session, {
    type: 'user_message',
    text: 'one',
    attachments: [{ kind: 'image', label: 'a.png', path: '/tmp/a.png', mediaType: 'image/png' }],
  });
  assert.equal(meta.imageCount, 1);

  append(session, {
    type: 'user_message',
    text: 'two at once',
    attachments: [
      { kind: 'image', label: 'b.png', path: '/tmp/b.png', mediaType: 'image/png' },
      { kind: 'image', label: 'c.png', path: '/tmp/c.png', mediaType: 'image/png' },
    ],
  });
  assert.equal(meta.imageCount, 3, 'every image in one message counts: they share a request');
});

test('messages without images leave the count alone', () => {
  const session = makeSession(`imgcount-text-${Date.now()}`);
  const meta = (session as unknown as { meta: { imageCount?: number } }).meta;
  append(session, { type: 'user_message', text: 'just words' });
  append(session, {
    type: 'user_message',
    text: 'a file, not a picture',
    attachments: [{ kind: 'file', label: 'notes.txt', path: '/tmp/notes.txt' }],
  });
  assert.equal(meta.imageCount ?? 0, 0);
});
