import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalescingSender, type Timers } from './coalesce.js';

type M = { kind: string; sessionId?: string; text?: string };

function fakeTimers() {
  let pending: (() => void) | null = null;
  const timers: Timers = {
    setTimeout: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  return { timers, fire: () => { const f = pending; pending = null; f?.(); }, armed: () => pending !== null };
}

test('a stream of text pieces goes as one frame per window, the first at once', () => {
  const sent: M[] = [];
  const t = fakeTimers();
  const s = coalescingSender<M>((m) => sent.push(m), 250, t.timers);
  for (const piece of ['The ', 'sea ', 'is ', 'salty']) s.send({ kind: 'delta', sessionId: 's1', text: piece });
  assert.deepEqual(sent, [{ kind: 'delta', sessionId: 's1', text: 'The ' }]);
  t.fire();
  assert.deepEqual(sent.slice(1), [{ kind: 'delta', sessionId: 's1', text: 'sea is salty' }]);
  // Quiet window: the timer stops, and the next piece goes at once again.
  t.fire();
  assert.equal(t.armed(), false);
  s.send({ kind: 'delta', sessionId: 's1', text: '!' });
  assert.equal(sent.at(-1)?.text, '!');
});

test('an event for a chat follows the text gathered for it; other chats keep gathering', () => {
  const sent: M[] = [];
  const t = fakeTimers();
  const s = coalescingSender<M>((m) => sent.push(m), 250, t.timers);
  s.send({ kind: 'delta', sessionId: 's1', text: 'a' });
  s.send({ kind: 'delta', sessionId: 's1', text: 'b' });
  s.send({ kind: 'delta', sessionId: 's2', text: 'x' });
  s.send({ kind: 'event', sessionId: 's1' });
  assert.deepEqual(sent.map((m) => `${m.kind}:${m.sessionId}:${m.text ?? ''}`), ['delta:s1:a', 'delta:s1:b', 'event:s1:']);
  t.fire();
  assert.deepEqual(sent.at(-1), { kind: 'delta', sessionId: 's2', text: 'x' });
});

test('closed, nothing more is sent', () => {
  const sent: M[] = [];
  const t = fakeTimers();
  const s = coalescingSender<M>((m) => sent.push(m), 250, t.timers);
  s.send({ kind: 'delta', sessionId: 's1', text: 'a' });
  s.send({ kind: 'delta', sessionId: 's1', text: 'b' });
  s.close();
  t.fire();
  assert.equal(sent.length, 1);
});
