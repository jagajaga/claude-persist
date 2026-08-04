import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RateLimits } from '@claude-persist/shared';
import { MAX_WAIT_MS, MIN_WAIT_MS, isRateLimitResult, parseResetTime, planRetry, spreadMs } from './limits.js';

/** The message the user actually reports seeing. */
const REAL = "You've hit your session limit · resets 8:20pm (UTC)";
const NOW = Date.parse('2026-08-04T10:00:00.000Z');

// ------------------------------------------------------------ isRateLimitResult

test('isRateLimitResult: recognises the real session-limit message', () => {
  assert.equal(isRateLimitResult(REAL), true);
});

test('isRateLimitResult: recognises the usual wording variants', () => {
  for (const text of [
    "You've hit your usage limit · resets 8:20pm (UTC)",
    'You have reached your weekly limit',
    'Rate limit exceeded',
    'You are out of your 5-hour limit, resets at 20:20 UTC',
  ]) {
    assert.equal(isRateLimitResult(text), true, text);
  }
});

/**
 * A false positive parks a turn that would never succeed, so ordinary failures
 * must not look like limits.
 */
test('isRateLimitResult: ordinary failures and non-strings are not limits', () => {
  for (const text of [
    'Turn finished (error_during_execution)',
    'No conversation found with session ID: db2b5907',
    'Error: ENOENT: no such file or directory',
    'The tool call failed',
    '',
  ]) {
    assert.equal(isRateLimitResult(text), false, JSON.stringify(text));
  }
  assert.equal(isRateLimitResult(undefined), false);
  assert.equal(isRateLimitResult(null), false);
  assert.equal(isRateLimitResult({ limit: true }), false);
});

// --------------------------------------------------------------- parseResetTime

test('parseResetTime: parses "resets 8:20pm (UTC)" as 20:20 UTC today', () => {
  assert.equal(parseResetTime(REAL, NOW), Date.parse('2026-08-04T20:20:00.000Z'));
});

test('parseResetTime: a reset time already past today means tomorrow', () => {
  const lateNow = Date.parse('2026-08-04T22:00:00.000Z');
  assert.equal(parseResetTime(REAL, lateNow), Date.parse('2026-08-05T20:20:00.000Z'));
});

test('parseResetTime: handles 24-hour and am forms', () => {
  assert.equal(
    parseResetTime('resets at 20:20 UTC', NOW),
    Date.parse('2026-08-04T20:20:00.000Z'),
  );
  assert.equal(
    parseResetTime('resets 12:30am (UTC)', NOW),
    Date.parse('2026-08-05T00:30:00.000Z'),
  );
  assert.equal(
    parseResetTime('resets 12:30pm (UTC)', NOW),
    Date.parse('2026-08-04T12:30:00.000Z'),
  );
});

/**
 * Without a named timezone the same string could be half a day off, and parking
 * a turn for twelve extra hours is far worse than falling back to a backoff that
 * self-corrects.
 */
test('parseResetTime: refuses to guess when no timezone is named', () => {
  assert.equal(parseResetTime('resets 8:20pm', NOW), null);
  assert.equal(parseResetTime("You've hit your session limit", NOW), null);
  assert.equal(parseResetTime('resets 99:99 UTC', NOW), null);
});

// -------------------------------------------------------------------- spreadMs

/**
 * Several sessions hit the limit seconds apart, so without spreading they would
 * all wake at the same instant and re-exhaust the window in one burst.
 */
test('spreadMs: deterministic per session id, and spread across the window', () => {
  assert.equal(spreadMs('abc'), spreadMs('abc'));
  assert.notEqual(spreadMs('session-a'), spreadMs('session-b'));
  for (const id of ['a', 'b', 'session-x', '4995bb8b-2bf5-495a-b279-81941dc1d964']) {
    const v = spreadMs(id);
    assert.ok(v >= 0 && v < 60_000, `${id} -> ${v}`);
  }
});

// ------------------------------------------------------------------- planRetry

const base = { text: REAL, now: NOW, attempts: 1, sessionId: 'sess-1' };

test('planRetry: prefers the structured window reset over parsing text', () => {
  const windows: RateLimits = {
    five_hour: { utilization: 100, resetsAt: Date.parse('2026-08-04T14:20:00.000Z'), status: 'rejected' },
  };
  const plan = planRetry({ ...base, windows });
  assert.equal(plan.source, 'window');
  // Just after the reset, plus this session's spread.
  assert.ok(plan.at >= Date.parse('2026-08-04T14:20:30.000Z'));
  assert.ok(plan.at < Date.parse('2026-08-04T14:22:00.000Z'));
});

test('planRetry: a rejected window wins over a merely-known one', () => {
  const windows: RateLimits = {
    five_hour: { utilization: 100, resetsAt: Date.parse('2026-08-04T14:20:00.000Z'), status: 'rejected' },
    seven_day: { utilization: 20, resetsAt: Date.parse('2026-08-04T11:00:00.000Z'), status: 'allowed' },
  };
  const plan = planRetry({ ...base, windows });
  assert.ok(plan.at > Date.parse('2026-08-04T14:20:00.000Z'));
});

test('planRetry: falls back to the message text when no window is known', () => {
  // Close enough to the reset that the MAX_WAIT clamp doesn't apply.
  const now = Date.parse('2026-08-04T18:00:00.000Z');
  const plan = planRetry({ ...base, now, windows: {} });
  assert.equal(plan.source, 'text');
  assert.ok(plan.at >= Date.parse('2026-08-04T20:20:30.000Z'));
  assert.ok(plan.at < Date.parse('2026-08-04T20:22:00.000Z'));
});

/**
 * The real message seen at 10:00 UTC points 10h20m ahead, past the 6h clamp. The
 * wait is capped and re-probed rather than trusted — if the limit is still in
 * force the turn simply parks again.
 */
test('planRetry: a text reset beyond the clamp is capped, not trusted', () => {
  const plan = planRetry({ ...base, windows: {} });
  assert.equal(plan.at, NOW + MAX_WAIT_MS);
});

test('planRetry: falls back to a backoff when nothing is parseable', () => {
  const plan = planRetry({ ...base, windows: {}, text: 'You have hit a limit' });
  assert.equal(plan.source, 'backoff');
  assert.equal(plan.at, NOW + 5 * 60_000 + spreadMs('sess-1'));
});

test('planRetry: the backoff escalates with attempts', () => {
  const at = (attempts: number): number =>
    planRetry({ ...base, windows: {}, text: 'hit a limit', attempts }).at - NOW;
  assert.ok(at(1) < at(2));
  assert.ok(at(2) < at(3));
  assert.ok(at(3) < at(4));
  assert.equal(at(9), at(4), 'the ladder caps rather than growing forever');
});

/**
 * A misread reset instant would otherwise strand a turn. Retrying costs one
 * rejected turn, so re-probing is cheap and self-correcting.
 */
test('planRetry: never parks longer than MAX_WAIT_MS', () => {
  const windows: RateLimits = {
    seven_day: { utilization: 100, resetsAt: NOW + 7 * 24 * 3600_000, status: 'rejected' },
  };
  const plan = planRetry({ ...base, windows });
  assert.equal(plan.at, NOW + MAX_WAIT_MS);
});

test('planRetry: never retries instantly, even if the reset is already past', () => {
  const windows: RateLimits = {
    five_hour: { utilization: 100, resetsAt: NOW - 60_000, status: 'rejected' },
  };
  // A past reset is not a candidate, so this lands on the text; either way it
  // must respect the floor.
  const plan = planRetry({ ...base, windows, text: 'hit a limit' });
  assert.ok(plan.at >= NOW + MIN_WAIT_MS);
});

test('planRetry: two sessions limited at the same instant do not wake together', () => {
  const windows: RateLimits = {
    five_hour: { utilization: 100, resetsAt: Date.parse('2026-08-04T14:20:00.000Z'), status: 'rejected' },
  };
  const a = planRetry({ ...base, windows, sessionId: 'session-a' });
  const b = planRetry({ ...base, windows, sessionId: 'session-b' });
  assert.notEqual(a.at, b.at);
});
