// Merging plan-usage data from the two sources that each report half of it.
//
// The live `rate_limit_event` push (SDKRateLimitInfo) carries `status` and
// `resetsAt`, but `utilization` is optional and in practice absent — which is
// why the status bar, which needs a percentage, had nothing to show and fell
// back to a bare label that read as "this feature doesn't exist".
//
// The experimental usage control call carries `utilization` (documented as
// "Percentage of the window used, 0-100"), an ISO `resets_at`, and
// `subscription_type` — but no per-window status.
//
// So neither source can simply replace the other; they merge per window.
import type { RateLimits, RateLimitWindow, RateLimitWindowKind, UsageSnapshot } from '@claude-persist/shared';

/** Stable order; also the order the UI prefers when picking a window to show. */
export const RATE_LIMIT_WINDOW_KINDS: RateLimitWindowKind[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

const RATE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);

/**
 * Epoch seconds below this, epoch milliseconds at or above it. 1e11 ms is 1973
 * and 1e11 seconds is the year 5138, so no real timestamp is ambiguous.
 *
 * `SDKRateLimitInfo.resetsAt` is typed as a bare `number` with no unit, and this
 * code used to assume milliseconds. It is seconds: an observed 1785766800 was
 * being read as 1970-01-21 instead of 2026-08-03T14:20Z, so every window
 * rendered "resets any moment now" forever. Confirmed against the usage
 * endpoint, which reports the same instant as an ISO string.
 */
const EPOCH_MS_FLOOR = 1e11;

export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < EPOCH_MS_FLOOR ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Fold one live `rate_limit_event` into the cache. Unknown kinds are ignored. */
export function applyRateLimitEvent(windows: RateLimits, info: Record<string, unknown>): RateLimits {
  const kind = info.rateLimitType;
  if (typeof kind !== 'string' || !RATE_LIMIT_WINDOW_KINDS.includes(kind as RateLimitWindowKind)) {
    return windows;
  }
  const key = kind as RateLimitWindowKind;
  const previous = windows[key];
  const status = RATE_LIMIT_STATUSES.has(info.status as string)
    ? (info.status as RateLimitWindow['status'])
    : 'allowed';
  return {
    ...windows,
    [key]: {
      // The push has no utilization; never let it erase one the usage call found.
      utilization: typeof info.utilization === 'number' ? info.utilization : previous?.utilization ?? null,
      resetsAt: toEpochMs(info.resetsAt) ?? previous?.resetsAt ?? null,
      status,
    },
  };
}

/**
 * Fold an SDKControlGetUsageResponse into a snapshot.
 *
 * Everything is read defensively: the call is named
 * `_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, and the live response
 * already contains window kinds this protocol doesn't model
 * (`seven_day_oauth_apps`, `seven_day_cowork`, `tangelo`, `extra_usage`, …), so
 * unknown keys must be skipped rather than trusted to match our shape.
 */
export function applyUsageResponse(previous: UsageSnapshot, usage: Record<string, unknown>): UsageSnapshot {
  const next: UsageSnapshot = { ...previous, windows: { ...previous.windows } };

  if (typeof usage.subscription_type === 'string' || usage.subscription_type === null) {
    next.subscriptionType = usage.subscription_type;
  }
  if (typeof usage.rate_limits_available === 'boolean') {
    next.available = usage.rate_limits_available;
  }

  const limits = usage.rate_limits;
  if (!limits || typeof limits !== 'object') return next;

  for (const [key, raw] of Object.entries(limits as Record<string, unknown>)) {
    if (!RATE_LIMIT_WINDOW_KINDS.includes(key as RateLimitWindowKind)) continue;
    if (!raw || typeof raw !== 'object') continue; // null means "window not in effect"
    const window = raw as { utilization?: unknown; resets_at?: unknown };
    const kind = key as RateLimitWindowKind;
    const before = next.windows[kind];
    next.windows[kind] = {
      utilization: typeof window.utilization === 'number' ? window.utilization : before?.utilization ?? null,
      resetsAt: toEpochMs(window.resets_at) ?? before?.resetsAt ?? null,
      // No status in this payload — keep whatever the live push last reported.
      status: before?.status ?? 'allowed',
    };
  }
  return next;
}
