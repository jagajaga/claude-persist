// Deciding what to do when the active account is refused by a plan limit:
// move to the next account that still has room, or — when every account is
// spent — wait for whichever limit ends soonest.
//
// Pure functions. The daemon holds the state (which accounts are limited, when
// we last switched); everything decided here is a function of that state, so the
// wrap-around, the cooldown and the all-limited fallback are testable without a
// daemon, an account, or a rate limit.
import type { AccountInfo } from '@claude-persist/shared';

/**
 * Accounts are keyed by config dir, but the default account's is null. One
 * function so the map key and the lookups can never disagree.
 */
export function accountKey(configDir: string | null): string {
  return configDir ?? '';
}

/**
 * How long after a switch to ignore further limit reports.
 *
 * Sessions hit the limit seconds apart, so without this three concurrent
 * sessions would each rotate and cycle the account three times for one wall of
 * limits. The first switch serves everyone; the rest simply retry on the account
 * that is now active.
 */
export const SWITCH_COOLDOWN_MS = 30_000;

/** Small pause after switching, so the previous query finishes tearing down. */
export const SWITCH_SETTLE_MS = 5_000;

export interface RotationState {
  /** accountKey -> epoch ms its limit ends. Entries in the past are ignored. */
  limited: Map<string, number>;
  /**
   * Accounts whose login has stopped working, by identity.
   *
   * Not the same as spent: a rate limit ends by itself and a dead token does
   * not, so there is no time to wait for. Cleared when that account signs in
   * again, which is the only thing that fixes it.
   */
  unusable: Set<string>;
  /** When the daemon last changed account, for the cooldown. */
  lastSwitchAt: number;
}

export interface RotationPlan {
  /** The account to activate, or null to stay put. */
  switchTo: AccountInfo | null;
  /** When the session should send "restart and continue". */
  retryAt: number;
  why:
    | 'switched'
    | 'cooldown'
    /** In cooldown *and* the account we are on is spent — retrying now is doomed. */
    | 'cooldown-limited'
    | 'all-limited'
    | 'disabled'
    | 'single-account';
}

/**
 * How an account is identified for rotation purposes: the Claude account it logs
 * into, so two directories sharing one login share one quota and count as one.
 * Falls back to the directory when identity is unknown, which keeps unknowns
 * distinct from each other rather than accidentally merging them.
 */
export type IdentityOf = (account: AccountInfo) => string;

export const byConfigDir: IdentityOf = (a) => accountKey(a.configDir);

function usable(
  account: AccountInfo,
  state: RotationState,
  now: number,
  identityOf: IdentityOf,
): boolean {
  if (state.unusable.has(identityOf(account))) return false;
  const until = state.limited.get(identityOf(account));
  return until === undefined || until <= now;
}

/**
 * The next account after `current`, wrapping, that is not currently limited.
 *
 * Order is the list's own order — the same order the model menu shows — so
 * rotation is predictable rather than dependent on which account happened to
 * fail. Returns null when every other account is limited too.
 */
export function nextUsableAccount(
  accounts: AccountInfo[],
  current: string | null,
  state: RotationState,
  now: number,
  identityOf: IdentityOf = byConfigDir,
): AccountInfo | null {
  if (accounts.length < 2) return null;
  const currentKey = accountKey(current);
  const start = accounts.findIndex((a) => accountKey(a.configDir) === currentKey);
  // An unknown current account (just deleted, say) still rotates: start at 0.
  const from = start >= 0 ? start : -1;
  const currentAccount = start >= 0 ? accounts[start] : null;
  const currentIdentity = currentAccount ? identityOf(currentAccount) : null;
  for (let step = 1; step <= accounts.length; step++) {
    const candidate = accounts[(from + step + accounts.length) % accounts.length];
    if (accountKey(candidate.configDir) === currentKey) continue;
    // Same login as the account that was just refused: same quota, same limit.
    if (currentIdentity !== null && identityOf(candidate) === currentIdentity) continue;
    if (usable(candidate, state, now, identityOf)) return candidate;
  }
  return null;
}

/**
 * What to do now that the active account has been refused.
 *
 * `ownResetAt` is when *this* account's limit ends — the fallback when there is
 * nowhere else to go.
 */
export function planAfterLimit(opts: {
  accounts: AccountInfo[];
  current: string | null;
  state: RotationState;
  now: number;
  ownResetAt: number;
  enabled: boolean;
  identityOf?: IdentityOf;
}): RotationPlan {
  const { accounts, current, state, now, ownResetAt, enabled } = opts;
  const identityOf = opts.identityOf ?? byConfigDir;
  if (!enabled) return { switchTo: null, retryAt: ownResetAt, why: 'disabled' };
  if (accounts.length < 2) return { switchTo: null, retryAt: ownResetAt, why: 'single-account' };

  // Another session just switched us; don't cycle again, just try where we are.
  if (now - state.lastSwitchAt < SWITCH_COOLDOWN_MS) {
    const currentAccount = accounts.find((a) => accountKey(a.configDir) === accountKey(current));
    // ...unless the account we landed on is itself spent. Retrying into a known
    // limit costs a real turn to be refused by the same limit, and the 5s retry
    // made that a loop: four turns in twenty seconds, each one doomed before it
    // was sent. Wait for the cooldown to end and then pick properly.
    if (currentAccount && !usable(currentAccount, state, now, identityOf)) {
      return {
        switchTo: null,
        retryAt: state.lastSwitchAt + SWITCH_COOLDOWN_MS + SWITCH_SETTLE_MS,
        why: 'cooldown-limited',
      };
    }
    return { switchTo: null, retryAt: now + SWITCH_SETTLE_MS, why: 'cooldown' };
  }

  const next = nextUsableAccount(accounts, current, state, now, identityOf);
  if (next) return { switchTo: next, retryAt: now + SWITCH_SETTLE_MS, why: 'switched' };

  // Everything is spent: wait for whichever limit ends first, including ours.
  const ends = [ownResetAt];
  for (const [, until] of state.limited) if (until > now) ends.push(until);
  return { switchTo: null, retryAt: Math.min(...ends), why: 'all-limited' };
}

/**
 * Which account to be on when a queued retry finally fires.
 *
 * Called at wake rather than decided at park time: by then a limit has ended,
 * and the account to use is the one that ended — not whichever account we
 * happened to stop on when everything was exhausted.
 */
export function accountForRetry(
  accounts: AccountInfo[],
  current: string | null,
  state: RotationState,
  now: number,
  enabled: boolean,
  identityOf: IdentityOf = byConfigDir,
): AccountInfo | null {
  if (!enabled || accounts.length < 2) return null;
  const currentAccount = accounts.find((a) => accountKey(a.configDir) === accountKey(current));
  // Already on an account with room — nothing to do.
  if (currentAccount && usable(currentAccount, state, now, identityOf)) return null;
  return nextUsableAccount(accounts, current, state, now, identityOf);
}
