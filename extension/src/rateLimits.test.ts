import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeReset,
  formatStatusBarFallback,
  formatStatusBarText,
  formatTooltip,
  normalizeResetsAt,
  pickNextLimit,
  severityFor,
  windowLabel,
} from './rateLimits';

// ---- normalizeResetsAt: the two resetsAt shapes -----------------------------

test('normalizeResetsAt: an epoch-ms number passes through', () => {
  assert.equal(normalizeResetsAt(1_700_000_000_000), 1_700_000_000_000);
});

test('normalizeResetsAt: an ISO 8601 string (init handshake shape) parses to the same instant', () => {
  const iso = '2024-01-01T00:00:00.000Z';
  assert.equal(normalizeResetsAt(iso), Date.parse(iso));
});

test('normalizeResetsAt: null/undefined/garbage all become null', () => {
  assert.equal(normalizeResetsAt(null), null);
  assert.equal(normalizeResetsAt(undefined), null);
  assert.equal(normalizeResetsAt('not a date'), null);
  assert.equal(normalizeResetsAt(NaN), null);
});

// ---- pickNextLimit: selection rule ------------------------------------------

test('pickNextLimit: highest utilization wins', () => {
  const next = pickNextLimit({
    five_hour: { utilization: 40, resetsAt: 1000 },
    seven_day: { utilization: 62, resetsAt: 2000 },
    seven_day_opus: { utilization: 10, resetsAt: 3000 },
  });
  assert.equal(next?.kind, 'seven_day');
  assert.equal(next?.utilization, 62);
});

test('pickNextLimit: a tie is broken by whichever resets soonest', () => {
  // Realistic epoch-ms values: anything under 1e11 is epoch seconds and gets
  // scaled, so toy numbers like 2000 can't stand in for timestamps.
  const soon = Date.parse('2026-08-03T11:00:00.000Z');
  const later = Date.parse('2026-08-03T12:00:00.000Z');
  const next = pickNextLimit({
    five_hour: { utilization: 80, resetsAt: later },
    seven_day: { utilization: 80, resetsAt: soon },
  });
  assert.equal(next?.kind, 'seven_day');
  assert.equal(next?.resetsAtMs, soon);
});

test('pickNextLimit: null and missing windows are ignored', () => {
  const next = pickNextLimit({
    five_hour: null,
    seven_day: { utilization: null, resetsAt: null },
    seven_day_opus: { utilization: 33, resetsAt: Date.parse('2026-08-03T12:00:00.000Z') },
  });
  assert.equal(next?.kind, 'seven_day_opus');
});

test('pickNextLimit: all-null (or empty) input returns null', () => {
  assert.equal(pickNextLimit({}), null);
  assert.equal(pickNextLimit(null), null);
  assert.equal(pickNextLimit(undefined), null);
  assert.equal(
    pickNextLimit({
      five_hour: { utilization: null, resetsAt: null },
      seven_day: null,
    }),
    null,
  );
});

test('pickNextLimit: a tie where one side has an unknown reset prefers the known one', () => {
  const next = pickNextLimit({
    five_hour: { utilization: 55, resetsAt: null },
    seven_day: { utilization: 55, resetsAt: 9000 },
  });
  assert.equal(next?.kind, 'seven_day');
});

test('pickNextLimit: mixed resetsAt shapes both normalise before comparison', () => {
  const isoLater = '2030-01-01T00:00:00.000Z';
  const next = pickNextLimit({
    five_hour: { utilization: 70, resetsAt: 1000 }, // epoch ms, very soon
    seven_day: { utilization: 70, resetsAt: isoLater }, // ISO string, far later
  });
  assert.equal(next?.kind, 'five_hour');
});

// ---- formatStatusBarText / windowLabel --------------------------------------

test('formatStatusBarText: null degrades to today\'s exact default text', () => {
  assert.equal(formatStatusBarText(null), '$(sparkle) Claude Persist');
});

test('formatStatusBarText: renders the compact window label and rounded percent', () => {
  assert.equal(
    formatStatusBarText({ kind: 'five_hour', utilization: 61.6, resetsAtMs: null, status: 'allowed' }),
    '$(sparkle) 5h 62%',
  );
});

test('windowLabel: every window kind gets a short label', () => {
  assert.equal(windowLabel('five_hour'), '5h');
  assert.equal(windowLabel('seven_day'), '7d');
  assert.equal(windowLabel('seven_day_opus'), '7d opus');
  assert.equal(windowLabel('seven_day_sonnet'), '7d sonnet');
  assert.equal(windowLabel('seven_day_overage_included'), '7d overage');
  assert.equal(windowLabel('overage'), 'overage');
});

// ---- severityFor -------------------------------------------------------------

test('severityFor: no data is normal', () => {
  assert.equal(severityFor(null), 'normal');
});

test('severityFor: rejected status is always error, regardless of utilization', () => {
  assert.equal(
    severityFor({ kind: 'five_hour', utilization: 10, resetsAtMs: null, status: 'rejected' }),
    'error',
  );
});

test('severityFor: allowed_warning status is warning even at low utilization', () => {
  assert.equal(
    severityFor({ kind: 'five_hour', utilization: 5, resetsAtMs: null, status: 'allowed_warning' }),
    'warning',
  );
});

test('severityFor: utilization crossing the error threshold escalates even when status says allowed', () => {
  assert.equal(
    severityFor({ kind: 'five_hour', utilization: 95, resetsAtMs: null, status: 'allowed' }),
    'error',
  );
});

test('severityFor: utilization crossing the warning threshold escalates even when status says allowed', () => {
  assert.equal(
    severityFor({ kind: 'five_hour', utilization: 80, resetsAtMs: null, status: 'allowed' }),
    'warning',
  );
});

test('severityFor: comfortably under both thresholds is normal', () => {
  assert.equal(
    severityFor({ kind: 'five_hour', utilization: 20, resetsAtMs: null, status: 'allowed' }),
    'normal',
  );
});

// ---- formatRelativeReset -------------------------------------------------------

test('formatRelativeReset: unknown reset says so instead of guessing', () => {
  assert.equal(formatRelativeReset(null, 0), 'resets at an unknown time');
});

test('formatRelativeReset: hours and minutes both shown when both are nonzero', () => {
  const now = 0;
  const resetsAt = now + (2 * 60 + 10) * 60_000;
  assert.equal(formatRelativeReset(resetsAt, now), 'resets in 2h 10m');
});

test('formatRelativeReset: whole hours omit the minutes', () => {
  const now = 0;
  assert.equal(formatRelativeReset(now + 3 * 3_600_000, now), 'resets in 3h');
});

test('formatRelativeReset: under an hour shows minutes only', () => {
  const now = 0;
  assert.equal(formatRelativeReset(now + 15 * 60_000, now), 'resets in 15m');
});

test('formatRelativeReset: already past resets says so instead of a negative duration', () => {
  assert.equal(formatRelativeReset(-1, 0), 'resets any moment now');
});

// ---- formatTooltip -------------------------------------------------------------

test('formatTooltip: nothing reported yet falls back to the plain connected message', () => {
  assert.equal(formatTooltip({}, null), 'Connected to claude-persist daemon');
  assert.equal(formatTooltip(null, null), 'Connected to claude-persist daemon');
});

test('formatTooltip: lists every reported window with utilization and relative reset', () => {
  const now = Date.parse('2026-08-03T10:00:00.000Z');
  const text = formatTooltip(
    {
      five_hour: { utilization: 62, resetsAt: now + 60_000 },
      seven_day_opus: { utilization: 10, resetsAt: now + 3_600_000 },
    },
    null,
    now,
  );
  assert.equal(
    text,
    '5h: 62% — resets in 1m\n7d opus: 10% — resets in 1h',
  );
});

test('formatTooltip: subscription type is prepended when known', () => {
  const now = Date.parse('2026-08-03T10:00:00.000Z');
  const text = formatTooltip(
    { five_hour: { utilization: 62, resetsAt: now + 60_000 } },
    'max',
    now,
  );
  assert.equal(text, 'Plan: max\n5h: 62% — resets in 1m');
});

test('formatTooltip: windows with null utilization are skipped', () => {
  const text = formatTooltip(
    {
      five_hour: { utilization: null, resetsAt: null },
      seven_day: { utilization: 5, resetsAt: null },
    },
    null,
  );
  assert.equal(text, '7d: 5% — resets at an unknown time');
});

test('formatRelativeReset: long windows read in days, not dozens of hours', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const hours = (n: number) => now + n * 3600_000;
  assert.equal(formatRelativeReset(hours(72), now), 'resets in 3d');
  assert.equal(formatRelativeReset(hours(50), now), 'resets in 2d 2h');
  assert.equal(formatRelativeReset(hours(24), now), 'resets in 1d');
  // Below a day the hour/minute form still reads best.
  assert.equal(formatRelativeReset(hours(23), now), 'resets in 23h');
});

// ---- resetsAt units: the live push reports SECONDS, not milliseconds --------

/**
 * The bug: `SDKRateLimitInfo.resetsAt` is typed as a bare `number` and this code
 * documented and treated it as epoch milliseconds. A real observed value of
 * 1785766800 is epoch *seconds* — read as ms it lands in 1970, so every window
 * rendered "resets any moment now", permanently, for every user.
 */
test('normalizeResetsAt: an epoch-seconds number is scaled to milliseconds', () => {
  const seconds = 1785766800; // 2026-08-03T14:20:00Z, a real observed value
  assert.equal(normalizeResetsAt(seconds), seconds * 1000);
  assert.equal(new Date(normalizeResetsAt(seconds)!).toISOString(), '2026-08-03T14:20:00.000Z');
});

test('normalizeResetsAt: seconds and milliseconds for the same instant agree', () => {
  const ms = Date.parse('2026-08-03T14:20:00.000Z');
  assert.equal(normalizeResetsAt(ms / 1000), normalizeResetsAt(ms));
});

test('normalizeResetsAt: a seconds value renders as a future reset, not "any moment now"', () => {
  const now = Date.parse('2026-08-03T10:46:00.000Z');
  const resets = normalizeResetsAt(1785766800);
  assert.equal(formatRelativeReset(resets, now), 'resets in 3h 34m');
});

// ---- formatStatusBarFallback: something beats nothing ----------------------

/**
 * `utilization` is optional in SDKRateLimitInfo and in practice absent from the
 * live push, so pickNextLimit (which requires a number) returned null and the
 * status bar showed only its default label — indistinguishable from the feature
 * not existing.
 */
test('formatStatusBarFallback: shows the window and its reset when utilization is missing', () => {
  const now = Date.parse('2026-08-03T10:46:00.000Z');
  const text = formatStatusBarFallback(
    { five_hour: { utilization: null, resetsAt: 1785766800, status: 'allowed' } },
    now,
  );
  assert.equal(text, '$(sparkle) 5h resets in 3h 34m');
});

test('formatStatusBarFallback: a non-allowed status without a reset still says something', () => {
  const text = formatStatusBarFallback(
    { five_hour: { utilization: null, resetsAt: null, status: 'rejected' } },
    Date.now(),
  );
  assert.equal(text, '$(warning) 5h rejected');
});

test('formatStatusBarFallback: null when a window reports nothing usable at all', () => {
  assert.equal(
    formatStatusBarFallback({ five_hour: { utilization: null, resetsAt: null, status: 'allowed' } }, Date.now()),
    null,
  );
  assert.equal(formatStatusBarFallback({}, Date.now()), null);
  assert.equal(formatStatusBarFallback(null, Date.now()), null);
});

test('formatStatusBarFallback: defers to pickNextLimit when a utilization exists', () => {
  // Windows WITH a utilization are pickNextLimit's job; the fallback skips them
  // so the two can never disagree about which window to show.
  assert.equal(
    formatStatusBarFallback({ five_hour: { utilization: 42, resetsAt: 1785766800, status: 'allowed' } }, Date.now()),
    null,
  );
});

test('formatStatusBarFallback: follows WINDOW_ORDER, five_hour first', () => {
  const now = Date.parse('2026-08-03T10:46:00.000Z');
  const text = formatStatusBarFallback(
    {
      seven_day: { utilization: null, resetsAt: 1785766800, status: 'allowed' },
      five_hour: { utilization: null, resetsAt: 1785770400, status: 'allowed' },
    },
    now,
  );
  assert.match(text ?? '', /^\$\(sparkle\) 5h/);
});
