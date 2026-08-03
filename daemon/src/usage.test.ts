import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UsageSnapshot } from '@claude-persist/shared';
import { applyRateLimitEvent, applyUsageResponse, toEpochMs } from './usage.js';

const EMPTY: UsageSnapshot = { windows: {}, subscriptionType: null, available: true };

/**
 * Captured verbatim from a live
 * usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() call, including
 * the window kinds this protocol does not model. Kept real so a shape change in
 * the (explicitly unstable) API shows up here rather than in the status bar.
 */
const LIVE_USAGE = {
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: '2026-08-03T14:19:59.720196+00:00' },
    seven_day: { utilization: 4, resets_at: '2026-08-06T10:59:59.720216+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    tangelo: null,
    iguana_necktie: null,
    extra_usage: { is_enabled: false, utilization: null },
  },
};

// ------------------------------------------------------------------ toEpochMs

/**
 * `SDKRateLimitInfo.resetsAt` is typed as a bare `number` and was assumed to be
 * milliseconds. It is seconds: 1785766800 read as ms is 1970-01-21, so every
 * window rendered "resets any moment now" permanently.
 */
test('toEpochMs: epoch seconds are scaled, epoch milliseconds pass through', () => {
  const ms = Date.parse('2026-08-03T14:20:00.000Z');
  assert.equal(toEpochMs(1785766800), ms);
  assert.equal(toEpochMs(ms), ms);
  assert.equal(toEpochMs(1785766800), toEpochMs(ms));
});

test('toEpochMs: ISO strings parse, junk becomes null', () => {
  assert.equal(toEpochMs('2026-08-03T14:20:00.000Z'), Date.parse('2026-08-03T14:20:00.000Z'));
  assert.equal(toEpochMs('not a date'), null);
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(undefined), null);
  assert.equal(toEpochMs(Number.NaN), null);
  assert.equal(toEpochMs({}), null);
});

// -------------------------------------------------------- applyUsageResponse

test('applyUsageResponse: extracts utilization, reset and subscription type', () => {
  const next = applyUsageResponse(EMPTY, LIVE_USAGE);
  assert.equal(next.subscriptionType, 'team');
  assert.equal(next.available, true);
  assert.equal(next.windows.five_hour?.utilization, 42);
  assert.equal(next.windows.five_hour?.resetsAt, Date.parse('2026-08-03T14:19:59.720Z'));
  assert.equal(next.windows.seven_day?.utilization, 4);
});

/**
 * The live payload contains seven_day_cowork, tangelo, iguana_necktie,
 * extra_usage and friends. Anything not in RateLimitWindowKind must be dropped
 * rather than trusted to match our window shape.
 */
test('applyUsageResponse: ignores window kinds the protocol does not model', () => {
  const next = applyUsageResponse(EMPTY, LIVE_USAGE);
  assert.deepEqual(Object.keys(next.windows).sort(), ['five_hour', 'seven_day']);
});

test('applyUsageResponse: a null window means "not in effect", not a zeroed window', () => {
  const next = applyUsageResponse(EMPTY, LIVE_USAGE);
  assert.equal('seven_day_opus' in next.windows, false);
});

test('applyUsageResponse: rate_limits_available false is recorded, not silently ignored', () => {
  // API key / Bedrock / Vertex sessions: plan limits genuinely don't apply.
  const next = applyUsageResponse(EMPTY, {
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  });
  assert.equal(next.available, false);
  assert.equal(next.subscriptionType, null);
});

test('applyUsageResponse: a garbage or empty payload leaves the snapshot usable', () => {
  assert.deepEqual(applyUsageResponse(EMPTY, {}), EMPTY);
  assert.deepEqual(applyUsageResponse(EMPTY, { rate_limits: 'nope' }), EMPTY);
});

test('applyUsageResponse: preserves a status the live push already reported', () => {
  const withStatus: UsageSnapshot = {
    ...EMPTY,
    windows: { five_hour: { utilization: null, resetsAt: null, status: 'allowed_warning' } },
  };
  const next = applyUsageResponse(withStatus, LIVE_USAGE);
  assert.equal(next.windows.five_hour?.status, 'allowed_warning');
  assert.equal(next.windows.five_hour?.utilization, 42);
});

// ------------------------------------------------------ applyRateLimitEvent

test('applyRateLimitEvent: records status and scales the seconds reset', () => {
  const next = applyRateLimitEvent({}, {
    rateLimitType: 'five_hour',
    status: 'allowed',
    resetsAt: 1785766800,
  });
  assert.equal(next.five_hour?.status, 'allowed');
  assert.equal(next.five_hour?.resetsAt, Date.parse('2026-08-03T14:20:00.000Z'));
  assert.equal(next.five_hour?.utilization, null);
});

/**
 * The ordering hazard: the push fires far more often than the usage call, and
 * carries no utilization. If it overwrote the window wholesale it would blank
 * the percentage seconds after the usage call found it, and the status bar would
 * flicker back to showing nothing.
 */
test('applyRateLimitEvent: never erases a utilization the usage call found', () => {
  const withUsage = applyUsageResponse(EMPTY, LIVE_USAGE);
  const next = applyRateLimitEvent(withUsage.windows, {
    rateLimitType: 'five_hour',
    status: 'allowed_warning',
  });
  assert.equal(next.five_hour?.utilization, 42, 'utilization must survive the push');
  assert.equal(next.five_hour?.status, 'allowed_warning', 'status must be updated');
  assert.equal(next.five_hour?.resetsAt, withUsage.windows.five_hour?.resetsAt);
});

test('applyRateLimitEvent: a utilization in the push does win when present', () => {
  const withUsage = applyUsageResponse(EMPTY, LIVE_USAGE);
  const next = applyRateLimitEvent(withUsage.windows, {
    rateLimitType: 'five_hour',
    status: 'allowed',
    utilization: 77,
  });
  assert.equal(next.five_hour?.utilization, 77);
});

test('applyRateLimitEvent: unknown kinds return the same object (no broadcast)', () => {
  const windows = { five_hour: { utilization: 1, resetsAt: null, status: 'allowed' as const } };
  assert.equal(applyRateLimitEvent(windows, { rateLimitType: 'tangelo' }), windows);
  assert.equal(applyRateLimitEvent(windows, {}), windows);
});

test('applyRateLimitEvent: an unrecognised status falls back to allowed', () => {
  const next = applyRateLimitEvent({}, { rateLimitType: 'overage', status: 'who_knows' });
  assert.equal(next.overage?.status, 'allowed');
});
