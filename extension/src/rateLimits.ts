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
 * Normalise the two `resetsAt` shapes the SDK uses into epoch milliseconds:
 * the init-handshake's `rate_limits` block reports an ISO 8601 string, the
 * live `rate_limit_event` push reports an epoch-ms number. Invalid or
 * missing values become null rather than NaN so callers never have to guard.
 */
export function normalizeResetsAt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
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

/** "resets in 2h 10m" — falls back to "resets at an unknown time" rather than guessing. */
export function formatRelativeReset(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs === null) return 'resets at an unknown time';
  const diffMs = resetsAtMs - now;
  if (diffMs <= 0) return 'resets any moment now';
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
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
