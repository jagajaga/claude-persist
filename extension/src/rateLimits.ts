import type { RateLimitWindowKind } from '@claude-persist/shared';

/**
 * No `vscode` import here — this module is unit tested directly (see
 * rateLimits.test.ts) the same way gitBranch.ts is. All VS Code plumbing
 * (ThemeColor, the status bar item itself) stays in extension.ts.
 */

export type Severity = 'normal' | 'warning' | 'error';

/** A single window's state, loose enough to accept either shape the SDK uses. */
export interface RawWindow {
  utilization: number | null | undefined;
  /** ISO 8601 string (init-handshake shape) or epoch milliseconds (live-push shape). */
  resetsAt: string | number | null | undefined;
  status?: 'allowed' | 'allowed_warning' | 'rejected';
}

export type RawWindows = Partial<Record<RateLimitWindowKind, RawWindow | null | undefined>>;

export interface NextLimit {
  kind: RateLimitWindowKind;
  /** 0-100. */
  utilization: number;
  /** Epoch milliseconds, or null if the SDK didn't report one. */
  resetsAtMs: number | null;
  status: 'allowed' | 'allowed_warning' | 'rejected';
}

/** Stable iteration order — also doubles as display order in the tooltip. */
const WINDOW_ORDER: RateLimitWindowKind[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

const WINDOW_LABELS: Record<RateLimitWindowKind, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d opus',
  seven_day_sonnet: '7d sonnet',
  seven_day_overage_included: '7d overage',
  overage: 'overage',
};

export function windowLabel(kind: RateLimitWindowKind): string {
  return WINDOW_LABELS[kind];
}

/**
 * Epoch *seconds* below this, epoch milliseconds at or above it. 1e11 ms is
 * 1973, and 1e11 seconds is the year 5138 — no real timestamp is ambiguous.
 */
const EPOCH_MS_FLOOR = 1e11;

/**
 * Normalise every `resetsAt` shape the SDK uses into epoch milliseconds.
 *
 * The usage endpoint's `resets_at` is an ISO 8601 string. The live
 * `rate_limit_event` push reports a *number*, and this code previously
 * documented and treated that number as epoch milliseconds — it is epoch
 * seconds. A real observed value of 1785766800 was being read as
 * 1970-01-21 instead of 2026-08-03T14:20Z, so every reset rendered as
 * "resets any moment now", permanently. The SDK types say only
 * `resetsAt?: number` with no unit, so scale is detected rather than assumed.
 *
 * Invalid or missing values become null rather than NaN, so callers never guard.
 */
export function normalizeResetsAt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < EPOCH_MS_FLOOR ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toNextLimit(kind: RateLimitWindowKind, w: RawWindow): NextLimit | null {
  if (w.utilization === null || w.utilization === undefined) return null;
  return {
    kind,
    utilization: w.utilization,
    resetsAtMs: normalizeResetsAt(w.resetsAt),
    status: w.status ?? 'allowed',
  };
}

/** A null reset (unknown) never wins a tie against a known one. */
function resetsSooner(a: number | null, b: number | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return a < b;
}

/**
 * The window that will be hit first: highest utilization wins; a tie is
 * broken by whichever resets soonest. Windows with a null/missing
 * utilization (never reported) are ignored. Returns null when nothing usable
 * was reported at all, which callers should treat as "show nothing".
 */
export function pickNextLimit(windows: RawWindows | null | undefined): NextLimit | null {
  if (!windows) return null;
  let best: NextLimit | null = null;
  for (const kind of WINDOW_ORDER) {
    const raw = windows[kind];
    if (!raw) continue;
    const candidate = toNextLimit(kind, raw);
    if (!candidate) continue;
    if (
      !best ||
      candidate.utilization > best.utilization ||
      (candidate.utilization === best.utilization && resetsSooner(candidate.resetsAtMs, best.resetsAtMs))
    ) {
      best = candidate;
    }
  }
  return best;
}

const WARNING_UTILIZATION = 75;
const ERROR_UTILIZATION = 90;

/**
 * Severity for the status bar's background color. The SDK's own `status`
 * ('allowed_warning' / 'rejected') is authoritative when present; the
 * utilization thresholds are a fallback for whenever `status` is missing or
 * still 'allowed' but the number itself is already high (a client that
 * missed a status flip should not stay green at 96%). 75%/90% mirror the
 * kind of "getting close" / "about to be cut off" bands most usage meters
 * use — comfortably before the 5-hour or 7-day window actually resets.
 */
export function severityFor(next: NextLimit | null): Severity {
  if (!next) return 'normal';
  if (next.status === 'rejected' || next.utilization >= ERROR_UTILIZATION) return 'error';
  if (next.status === 'allowed_warning' || next.utilization >= WARNING_UTILIZATION) return 'warning';
  return 'normal';
}

const DEFAULT_STATUS_TEXT = '$(sparkle) Claude Persist';

/** Status bar text: the sparkle icon stays; the label is the soonest-to-bite window. */
export function formatStatusBarText(next: NextLimit | null): string {
  if (!next) return DEFAULT_STATUS_TEXT;
  return `$(sparkle) ${windowLabel(next.kind)} ${Math.round(next.utilization)}%`;
}

/**
 * What to show when no window reports a utilization, but one still tells us
 * something useful — a reset time, or a non-'allowed' status.
 *
 * The live `rate_limit_event` push often carries only `status` and `resetsAt`
 * (`utilization` is optional in SDKRateLimitInfo and is frequently absent),
 * and because pickNextLimit requires a number, the status bar fell back to the
 * bare "Claude Persist" label and looked like the feature simply didn't exist.
 * Showing the window and its reset beats showing nothing.
 *
 * Returns null when there is genuinely nothing to say, so the caller keeps the
 * default label.
 */
export function formatStatusBarFallback(
  windows: RawWindows | null | undefined,
  now: number,
): string | null {
  if (!windows) return null;
  for (const kind of WINDOW_ORDER) {
    const raw = windows[kind];
    if (!raw) continue;
    if (raw.utilization !== null && raw.utilization !== undefined) continue; // pickNextLimit's job
    const resetsAtMs = normalizeResetsAt(raw.resetsAt);
    const status = raw.status ?? 'allowed';
    if (resetsAtMs === null && status === 'allowed') continue; // nothing worth showing
    const icon = status === 'allowed' ? '$(sparkle)' : '$(warning)';
    if (resetsAtMs === null) return `${icon} ${windowLabel(kind)} ${status.replace('_', ' ')}`;
    return `${icon} ${windowLabel(kind)} ${formatRelativeReset(resetsAtMs, now)}`;
  }
  return null;
}

/** "resets in 2h 10m" — falls back to "resets at an unknown time" rather than guessing. */
export function formatRelativeReset(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs === null) return 'resets at an unknown time';
  const diffMs = resetsAtMs - now;
  if (diffMs <= 0) return 'resets any moment now';
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  // Seven-day windows are the common case, and "resets in 72h" is arithmetic
  // the reader should not have to do. Past a day, say days.
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours > 0 ? `resets in ${days}d ${restHours}h` : `resets in ${days}d`;
  }
  if (hours > 0 && minutes > 0) return `resets in ${hours}h ${minutes}m`;
  if (hours > 0) return `resets in ${hours}h`;
  return `resets in ${minutes}m`;
}

const DEFAULT_TOOLTIP = 'Connected to claude-persist daemon';

/**
 * Every reported window with its utilization and a relative reset, plus the
 * subscription type when known. Returns the plain connected-tooltip when
 * nothing has been reported yet.
 */
export function formatTooltip(
  windows: RawWindows | null | undefined,
  subscriptionType: string | null | undefined,
  now: number = Date.now(),
): string {
  const lines: string[] = [];
  for (const kind of WINDOW_ORDER) {
    const raw = windows?.[kind];
    if (!raw || raw.utilization === null || raw.utilization === undefined) continue;
    const resetsAtMs = normalizeResetsAt(raw.resetsAt);
    lines.push(`${windowLabel(kind)}: ${Math.round(raw.utilization)}% — ${formatRelativeReset(resetsAtMs, now)}`);
  }
  if (lines.length === 0) return DEFAULT_TOOLTIP;
  if (subscriptionType) lines.unshift(`Plan: ${subscriptionType}`);
  return lines.join('\n');
}

/**
 * The short limit label shown beside an account in the picker: the window that
 * will bite first and how full it is, e.g. "7d 21%".
 *
 * Only the active account has a current reading — usage can only be read from a
 * live query — so everything else carries the age of its last one. A stale
 * number with its age attached is useful; a stale number pretending to be
 * current is not.
 */
export function formatAccountUsage(
  reading: { windows: RawWindows; at: number } | null | undefined,
  now: number,
  isActive: boolean,
): string | null {
  if (!reading) return null;
  const next = pickNextLimit(reading.windows);
  const label = next
    ? `${windowLabel(next.kind)} ${Math.round(next.utilization)}%`
    : formatStatusBarFallback(reading.windows, now)?.replace(/^\$\([a-z-]+\)\s*/, '') ?? null;
  if (!label) return null;
  return isActive ? label : `${label} · ${formatAge(reading.at, now)}`;
}

/** "just now", "2h ago", "3d ago" — enough to judge whether to trust it. */
export function formatAge(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
