import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RateLimits } from '@claude-persist/shared';
import {
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  STALL_MS,
  STALL_RETRY_MS,
  RESUME_MESSAGE,
  isLimitNotice,
  isOverloadNotice,
  MAX_OVERLOAD_ATTEMPTS,
  OVERLOAD_RETRY_MS,
  parseResetTime,
  planRetry,
  spreadMs,
  windowsLookLimited,
} from './limits.js';

/** The message the user actually reports seeing. */
const REAL = "You've hit your session limit · resets 8:20pm (UTC)";
const NOW = Date.parse('2026-08-04T10:00:00.000Z');

// ------------------------------------------------------------ isOverloadNotice

/** What a 529 actually reads as, verbatim from a session it ended. */
const OVERLOAD =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — ' +
  'try again in a moment. If it persists, check https://status.claude.com.';

test('isOverloadNotice: recognises the real notice', () => {
  assert.equal(isOverloadNotice(OVERLOAD), true);
  assert.equal(isOverloadNotice(`  ${OVERLOAD}  `), true, 'surrounding whitespace is not meaningful');
  assert.equal(isOverloadNotice('API Error: 529 Overloaded'), true, 'the bare form too');
});

/**
 * The failure mode this has to survive, and it is not hypothetical: the turn
 * that built this feature spent its whole length quoting 529s, and the session
 * that reported the bug pasted the notice into the chat. Parking on either would
 * resend work that had just succeeded -- the same trap isLimitNotice fell into
 * for a day, so the same length rule answers it.
 */
test('isOverloadNotice: a reply that merely discusses a 529 is not a notice', () => {
  const reply =
    'Yes -- when a turn dies with "API Error: 529 Overloaded" the work stopped where it ' +
    'was and waited for someone to type continue. It parks a retry now, two minutes out, ' +
    'and sends "restart and continue" when it fires. An overload is server-wide, so it ' +
    'must not rotate accounts: that would spend a switch that cannot help and start a ' +
    'cooldown other sessions need. The give-up notice says it is not your quota.';
  assert.ok(reply.length > 300, 'this fixture only means anything while it is long');
  assert.equal(isOverloadNotice(reply), false);
});

test('isOverloadNotice: a rate limit is not an overload', () => {
  assert.equal(isOverloadNotice(REAL), false);
});

test('isOverloadNotice: nothing to read is not a notice', () => {
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(isOverloadNotice(value), false, String(value));
  }
});

/** Two minutes apart, and long enough in total to sit through an overnight run. */
test('overload retries are paced at two minutes and last twelve hours', () => {
  assert.equal(OVERLOAD_RETRY_MS, 2 * 60 * 1000);
  assert.equal((MAX_OVERLOAD_ATTEMPTS * OVERLOAD_RETRY_MS) / 3_600_000, 12);
});

// --------------------------------------------------------------- isLimitNotice

test('isLimitNotice: recognises the real notice', () => {
  assert.equal(isLimitNotice(REAL), true);
  assert.equal(isLimitNotice(`  ${REAL}  `), true, 'surrounding whitespace is not meaningful');
});

test('isLimitNotice: recognises the usual wording variants', () => {
  for (const text of [
    "You've hit your usage limit · resets 8:20pm (UTC)",
    'You have reached your weekly limit',
    'Rate limit exceeded',
    'You are out of your 5-hour limit, resets at 20:20 UTC',
  ]) {
    assert.equal(isLimitNotice(text), true, text);
  }
});

/**
 * The two false positives that made this feature resend messages for a day, both
 * long replies that merely discussed limits. Pattern matching alone flagged them,
 * and requiring the SDK's is_error/subtype to agree did not help — those reported
 * failure for a turn that plainly succeeded. Length is what separates a notice
 * (which replaces the answer) from a reply that mentions one.
 */
test('isLimitNotice: a long reply that merely discusses limits is not a notice', () => {
  const reply =
    'Yes. Restart completed cleanly at 07:57. Verified on the new process: the error gate is ' +
    `present, and the notice you saw quoted "${REAL}" verbatim, which is exactly why text ` +
    'matching misfired. five_hour is at 23% and status allowed, so nothing was rate limited. ' +
    'The stall watchdog fires after 20 minutes of silence and the attempt cap stops any loop.';
  assert.ok(reply.length > 300, 'fixture must be a realistically long reply');
  assert.equal(isLimitNotice(reply), false);
});

test('isLimitNotice: ordinary failures and non-strings are not notices', () => {
  for (const text of [
    'Turn finished (error_during_execution)',
    'No conversation found with session ID: db2b5907',
    'Error: ENOENT: no such file or directory',
    '',
    '   ',
    'I raised the concurrency limit in the config',
  ]) {
    assert.equal(isLimitNotice(text), false, JSON.stringify(text));
  }
  assert.equal(isLimitNotice(undefined), false);
  assert.equal(isLimitNotice(null), false);
  assert.equal(isLimitNotice({ limit: true }), false);
});

test('RESUME_MESSAGE is what a person would type', () => {
  assert.equal(RESUME_MESSAGE, 'restart and continue');
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

// ----------------------------------------------------- windowsLookLimited

/**
 * The check that finally stopped the false positives. Both other signals failed:
 * the result text is prose (an answer about limits reads like a rejection), and
 * the result's own error flags reported "failed" for a turn that plainly
 * succeeded — a successful reply was parked `(from window)` on a build that
 * already required turnFailed. Utilization and status are measured, so they
 * cannot be fooled by wording.
 */
test('windowsLookLimited: false when the windows have real headroom', () => {
  // The exact state during the false positive: claude.ai agreed with this.
  assert.equal(
    windowsLookLimited({
      five_hour: { utilization: 23, resetsAt: null, status: 'allowed' },
      seven_day: { utilization: 55, resetsAt: null, status: 'allowed' },
    }),
    false,
  );
});

test('windowsLookLimited: true when a window is rejected', () => {
  assert.equal(
    windowsLookLimited({
      five_hour: { utilization: 40, resetsAt: null, status: 'rejected' },
    }),
    true,
  );
});

test('windowsLookLimited: true when a window is effectively exhausted', () => {
  assert.equal(
    windowsLookLimited({ five_hour: { utilization: 100, resetsAt: null, status: 'allowed' } }),
    true,
  );
  assert.equal(
    windowsLookLimited({ seven_day: { utilization: 95, resetsAt: null, status: 'allowed' } }),
    true,
  );
});

/**
 * No measurement yet is not evidence of headroom — refusing to park here would
 * lose a genuine rejection on a daemon that has not yet heard from the usage API.
 */
test('windowsLookLimited: true when nothing has been measured', () => {
  assert.equal(windowsLookLimited({}), true);
  assert.equal(windowsLookLimited({ five_hour: undefined }), true);
});
