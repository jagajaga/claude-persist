import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMeter } from './tokenFlow.js';

function meter() {
  let t = 1_000_000;
  const m = new TokenMeter(() => t);
  return { m, advance: (ms: number) => { t += ms; } };
}

const call = (input: number, write: number, read: number, output: number) => ({
  input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output,
});

test('processed is fresh input + cache writes + output; cache reads are kept apart', () => {
  const { m } = meter();
  m.record('s1', call(10, 2000, 50000, 300), 'msg_1');
  const f = m.snapshot();
  assert.deepEqual(f.lastMinute, { input: 10, cacheWrite: 2000, cacheRead: 50000, output: 300, processed: 2310 });
  assert.equal(f.calls.lastMinute, 1);
});

/** The SDK repeats one call's usage on each of its content blocks. */
test('one API call is counted once however many blocks repeat it', () => {
  const { m } = meter();
  for (let i = 0; i < 3; i++) m.record('s1', call(1, 0, 0, 100), 'msg_same');
  assert.equal(m.snapshot().lastMinute.output, 100);
});

test('the minute rolls off into the hour, and the hour rolls off entirely', () => {
  const { m, advance } = meter();
  m.record('s1', call(0, 0, 0, 500), 'a');
  advance(61_000);
  m.record('s1', call(0, 0, 0, 100), 'b');
  let f = m.snapshot();
  assert.equal(f.lastMinute.output, 100);
  assert.equal(f.lastHour.output, 600);
  advance(3_600_000);
  f = m.snapshot();
  assert.equal(f.lastHour.output, 0);
  assert.equal(f.calls.lastHour, 0);
});

test('the busiest chats of the last five minutes, busiest first', () => {
  const { m } = meter();
  m.record('quiet', call(0, 0, 0, 10), 'q');
  m.record('busy', call(0, 1000, 0, 200), 'b');
  assert.deepEqual(m.snapshot().bySession.map((s) => s.sessionId), ['busy', 'quiet']);
});

test('empty or junk usage counts for nothing', () => {
  const { m } = meter();
  m.record('s1', undefined);
  m.record('s1', { input_tokens: 'x', output_tokens: -5 });
  m.record('s1', call(0, 0, 0, 0), 'z');
  assert.equal(m.snapshot().calls.lastHour, 0);
});
