// Recognising a plan rate-limit rejection and deciding when to try again.
//
// A limit does not arrive as a thrown error — it comes back as a `result`
// message whose text reads like "You've hit your session limit · resets 8:20pm
// (UTC)". So the SDK iterator keeps running and the turn simply ends with no
// answer, which is why nothing retried: from the daemon's point of view the turn
// completed.
//
// Pure functions, no I/O, so the parsing and the clamping are testable — getting
// either wrong means either hammering a limit or parking for hours.
import type { RateLimits } from '@claude-persist/shared';

/**
 * Never park longer than this without re-probing. A wrong reset time (a
 * timezone we misread, a window that resets earlier than advertised) would
 * otherwise strand a turn for hours. Retrying costs one rejected turn, so
 * re-checking is cheap and self-correcting.
 */
export const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** Never retry instantly, even if the reset is already in the past. */
export const MIN_WAIT_MS = 30_000;
/** Buffer past the reset instant, so we don't miss by a second. */
const RESET_BUFFER_MS = 30_000;

/**
 * Does this `result` text describe a rate limit rather than a real failure?
 *
 * Deliberately broad on wording ("session limit", "usage limit", "weekly
 * limit") but anchored on the two things every variant has: the word limit, and
 * either "hit/reached/exceeded" or a reset time. A false positive parks a turn
 * that would never succeed — but the MAX_WAIT clamp bounds that, and the retry
 * surfaces the real error.
 */
export function isRateLimitResult(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  if (!/\blimits?\b/i.test(text)) return false;
  return /\b(hit|reached|exceeded|out of)\b/i.test(text) || /\bresets?\b/i.test(text);
}

/**
 * Pull an absolute reset instant out of text like "resets 8:20pm (UTC)".
 *
 * Only trusted when the text names UTC. Without a timezone the same string
 * could be up to a day off, and a 12-hour mis-park is far worse than falling
 * back to a backoff that self-corrects.
 */
export function parseResetTime(text: string, now: number): number | null {
  if (!/\butc\b|\bz\b|\+00:?00/i.test(text)) return null;
  const match = /\bresets?\b[^0-9]{0,12}(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;

  const at = new Date(now);
  at.setUTCHours(hour, minute, 0, 0);
  let when = at.getTime();
  // A reset time earlier in the day than "now" means tomorrow.
  if (when <= now) when += 24 * 60 * 60 * 1000;
  return when;
}

/** Escalating fallback when no reset instant is known at all. */
function backoffMs(attempts: number): number {
  const ladder = [5, 15, 30, 60].map((m) => m * 60_000);
  return ladder[Math.min(attempts, ladder.length) - 1] ?? ladder[ladder.length - 1];
}

/**
 * Spread concurrent retries deterministically from the session id.
 *
 * Several sessions hit the limit within seconds of each other, so they would all
 * wake at the same instant and re-exhaust the window in one burst. Hashing the
 * id spreads them over a minute with no coordination and no randomness (which
 * would break the daemon's replay-ability).
 */
export function spreadMs(sessionId: string, windowMs = 60_000): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) % 1_000_003;
  }
  return hash % windowMs;
}

export interface RetryPlan {
  at: number;
  /** Why this instant — surfaced in the log so a wrong wait is diagnosable. */
  source: 'window' | 'text' | 'backoff';
}

/**
 * When to re-send a turn the plan limit rejected.
 *
 * Prefers the structured `resetsAt` the SDK's rate-limit push reports, because
 * it needs no parsing. (It only became usable once resetsAt was fixed to be read
 * as seconds — while it pointed at 1970 every wait would have collapsed to the
 * MIN_WAIT floor and hammered the limit.)
 */
export function planRetry(opts: {
  windows: RateLimits;
  text: string;
  now: number;
  attempts: number;
  sessionId: string;
}): RetryPlan {
  const { windows, text, now, attempts, sessionId } = opts;

  // The soonest future reset among windows that are actually blocking us; fall
  // back to any known future reset.
  const resets = Object.values(windows)
    .filter((w): w is NonNullable<typeof w> => !!w && typeof w.resetsAt === 'number')
    .filter((w) => (w.resetsAt as number) > now);
  const rejected = resets.filter((w) => w.status === 'rejected');
  const pool = rejected.length ? rejected : resets;
  const soonest = pool.length ? Math.min(...pool.map((w) => w.resetsAt as number)) : null;

  let at: number;
  let source: RetryPlan['source'];
  if (soonest !== null) {
    at = soonest + RESET_BUFFER_MS;
    source = 'window';
  } else {
    const parsed = parseResetTime(text, now);
    if (parsed !== null) {
      at = parsed + RESET_BUFFER_MS;
      source = 'text';
    } else {
      at = now + backoffMs(attempts);
      source = 'backoff';
    }
  }

  at += spreadMs(sessionId);
  at = Math.min(at, now + MAX_WAIT_MS);
  at = Math.max(at, now + MIN_WAIT_MS);
  return { at, source };
}
