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
 * Give up re-parking after this many attempts and surface the failure instead.
 * A safety net: without it, any misdetection loops for as long as the session
 * lives, burning a turn's worth of tokens per cycle.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Silence from the SDK that means a turn has died rather than gone quiet.
 *
 * Generous on purpose: a turn running a long test suite produces no SDK messages
 * while the tool executes, so a short threshold would interrupt real work. But
 * without any threshold a turn can hang forever, which is what happened — a
 * session's last recorded event was a `tool_use` and it sat there overnight, with
 * no result, no error, and no status change to show anything was wrong.
 */
export const STALL_MS = 20 * 60 * 1000;

/**
 * How soon to retry a stalled turn. Short, because a stall is not evidence of a
 * rate limit: if the cause *was* a limit, the retry produces a limit result and
 * re-parks with the real reset time; if it was a transient hang, the work resumes
 * in a couple of minutes instead of never.
 */
export const STALL_RETRY_MS = 2 * 60 * 1000;

const LIMIT_PATTERNS = [
  /\brate[- ]limited\b/i,
  /\b(usage|session|weekly|spend)[- ]limits?\b/i,
  /\bhit\b[^.!?]{0,40}\blimits?\b/i,
  /\b(reached|exceeded)\b[^.!?]{0,40}\blimits?\b/i,
  /\blimits?\b[^.!?]{0,25}\b(reached|exceeded)\b/i,
  /\bout of\b[^.!?]{0,40}\blimits?\b/i,
];

/**
 * Was this turn refused by a plan rate limit?
 *
 * `isError` is the load-bearing half, and it is not optional. Matching on text
 * alone is fundamentally unsafe here: a *successful* answer discussing rate
 * limits — quoting "You've hit your session limit · resets 8:20pm (UTC)", say —
 * reads exactly like a rejection. That really happened: an assistant reply about
 * this very feature was misclassified, re-parked, and resent five hours later,
 * then again, in a loop that no window ever justified (five_hour sat at 0%,
 * status allowed). A completed turn must never be treated as limited, whatever
 * its prose says, so the patterns below only ever apply to an errored result.
 */
export function isRateLimitResult(text: unknown, isError: boolean): boolean {
  if (!isError) return false;
  if (typeof text !== 'string') return false;
  return LIMIT_PATTERNS.some((re) => re.test(text));
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

/**
 * What to send when a parked turn resumes.
 *
 * Replaying the user's original message makes the model start the work over,
 * which is not resuming — it is repeating. The SDK transcript already holds
 * everything the interrupted turn produced (partial replies, tool calls and
 * their results), and `resume` puts all of it back in context, so the useful
 * thing to send is an instruction to carry on from there.
 *
 * Only when the limit struck before the turn produced anything is replaying the
 * original message correct: there is nothing to continue, and a bare "carry on"
 * would leave the model with no task.
 */
export function buildRetryEnvelope(
  pending: { envelope: unknown; producedOutput: boolean },
  sdkSessionId: string,
): unknown {
  if (!pending.producedOutput) return pending.envelope;
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: CONTINUATION_PROMPT }],
    },
    parent_tool_use_id: null,
    session_id: sdkSessionId,
  };
}

export const CONTINUATION_PROMPT =
  '[claude-persist] Your previous turn was cut off partway through by a plan rate limit, ' +
  'which has now reset. The conversation above is your own work up to the moment it stopped, ' +
  'including any tool calls that already ran. Continue from exactly where you left off: ' +
  'finish what remained, and do not redo work that is already complete or start over. ' +
  'If the work was already finished, just say so briefly.';
