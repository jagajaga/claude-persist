import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountInfo } from '@claude-persist/shared';
import {
  SWITCH_COOLDOWN_MS,
  SWITCH_SETTLE_MS,
  type RotationState,
  accountForRetry,
  accountKey,
  byConfigDir,
  nextUsableAccount,
  planAfterLimit,
} from './rotation.js';

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const HOUR = 3600_000;

/** default first, then named dirs — the order the model menu shows. */
function accounts(active: string | null = null): AccountInfo[] {
  return [
    { name: 'default', configDir: null, active: active === null, signedIn: true },
    { name: 'senia00', configDir: '/acc/senia00', active: active === '/acc/senia00', signedIn: true },
    { name: 'serokell', configDir: '/acc/serokell', active: active === '/acc/serokell', signedIn: true },
  ];
}

function state(limited: Array<[string | null, number]> = [], lastSwitchAt = 0): RotationState {
  return {
    limited: new Map(limited.map(([dir, at]) => [accountKey(dir), at])),
    unusable: new Set<string>(),
    lastSwitchAt,
  };
}

// ------------------------------------------------------------- nextUsableAccount

test('nextUsableAccount: moves to the next account in list order', () => {
  const next = nextUsableAccount(accounts(null), null, state(), NOW);
  assert.equal(next?.name, 'senia00');
});

test('nextUsableAccount: wraps around from the last account to the first', () => {
  const next = nextUsableAccount(accounts('/acc/serokell'), '/acc/serokell', state(), NOW);
  assert.equal(next?.name, 'default', 'the list is a loop');
});

test('nextUsableAccount: skips accounts already known limited', () => {
  const next = nextUsableAccount(
    accounts(null),
    null,
    state([['/acc/senia00', NOW + HOUR]]),
    NOW,
  );
  assert.equal(next?.name, 'serokell');
});

test('nextUsableAccount: a limit that has already passed no longer blocks', () => {
  const next = nextUsableAccount(
    accounts(null),
    null,
    state([['/acc/senia00', NOW - 1]]),
    NOW,
  );
  assert.equal(next?.name, 'senia00');
});

test('nextUsableAccount: null when every other account is limited', () => {
  const next = nextUsableAccount(
    accounts(null),
    null,
    state([
      ['/acc/senia00', NOW + HOUR],
      ['/acc/serokell', NOW + 2 * HOUR],
    ]),
    NOW,
  );
  assert.equal(next, null);
});

test('nextUsableAccount: null with a single account — nowhere to go', () => {
  assert.equal(nextUsableAccount([accounts()[0]], null, state(), NOW), null);
});

// ----------------------------------------------------------------- planAfterLimit

const base = { accounts: accounts(null), current: null, now: NOW, ownResetAt: NOW + 5 * HOUR };

test('planAfterLimit: switches and retries almost immediately', () => {
  const plan = planAfterLimit({ ...base, state: state(), enabled: true });
  assert.equal(plan.why, 'switched');
  assert.equal(plan.switchTo?.name, 'senia00');
  assert.equal(plan.retryAt, NOW + SWITCH_SETTLE_MS, 'no waiting for a reset when there is room elsewhere');
});

test('planAfterLimit: disabled falls back to waiting for this account to reset', () => {
  const plan = planAfterLimit({ ...base, state: state(), enabled: false });
  assert.equal(plan.why, 'disabled');
  assert.equal(plan.switchTo, null);
  assert.equal(plan.retryAt, base.ownResetAt);
});

test('planAfterLimit: a single account has nowhere to go and waits', () => {
  const plan = planAfterLimit({
    ...base,
    accounts: [accounts()[0]],
    state: state(),
    enabled: true,
  });
  assert.equal(plan.why, 'single-account');
  assert.equal(plan.retryAt, base.ownResetAt);
});

/**
 * Sessions hit the limit seconds apart. Without the cooldown, three concurrent
 * sessions would each rotate and cycle the account three times for one wall of
 * limits — landing somewhere arbitrary.
 */
test('planAfterLimit: a recent switch is not repeated, it just retries where we are', () => {
  const plan = planAfterLimit({
    ...base,
    state: state([], NOW - SWITCH_COOLDOWN_MS / 2),
    enabled: true,
  });
  assert.equal(plan.why, 'cooldown');
  assert.equal(plan.switchTo, null);
  assert.equal(plan.retryAt, NOW + SWITCH_SETTLE_MS);
});

test('planAfterLimit: once the cooldown has passed, switching resumes', () => {
  const plan = planAfterLimit({
    ...base,
    state: state([], NOW - SWITCH_COOLDOWN_MS - 1),
    enabled: true,
  });
  assert.equal(plan.why, 'switched');
});

/** The whole point of the fallback: wait for the *soonest* reset, not our own. */
test('planAfterLimit: with every account spent, waits for the nearest limit to end', () => {
  const plan = planAfterLimit({
    ...base,
    ownResetAt: NOW + 5 * HOUR,
    state: state([
      ['/acc/senia00', NOW + 2 * HOUR],
      ['/acc/serokell', NOW + 30 * 60_000], // soonest
    ]),
    enabled: true,
  });
  assert.equal(plan.why, 'all-limited');
  assert.equal(plan.switchTo, null);
  assert.equal(plan.retryAt, NOW + 30 * 60_000);
});

test('planAfterLimit: our own reset wins when it is the nearest', () => {
  const plan = planAfterLimit({
    ...base,
    ownResetAt: NOW + 10 * 60_000,
    state: state([
      ['/acc/senia00', NOW + 2 * HOUR],
      ['/acc/serokell', NOW + 3 * HOUR],
    ]),
    enabled: true,
  });
  assert.equal(plan.retryAt, NOW + 10 * 60_000);
});

// ---------------------------------------------------------------- accountForRetry

/**
 * Decided at wake rather than at park time: by then a limit has ended, and the
 * account to use is the one that ended — not whichever account we happened to
 * stop on when everything was exhausted.
 */
test('accountForRetry: moves to the account whose limit has ended', () => {
  const target = accountForRetry(
    accounts('/acc/serokell'),
    '/acc/serokell',
    state([
      ['/acc/serokell', NOW + HOUR], // still limited
      ['/acc/senia00', NOW - 1], // ended
      [null, NOW + 2 * HOUR],
    ]),
    NOW,
    true,
  );
  assert.equal(target?.name, 'senia00');
});

test('accountForRetry: stays put when the current account already has room', () => {
  const target = accountForRetry(accounts(null), null, state(), NOW, true);
  assert.equal(target, null, 'no pointless switch');
});

test('accountForRetry: stays put when disabled, even if the current account is spent', () => {
  const target = accountForRetry(
    accounts(null),
    null,
    state([[null, NOW + HOUR]]),
    NOW,
    false,
  );
  assert.equal(target, null);
});

test('accountForRetry: null when nothing anywhere has room yet', () => {
  const target = accountForRetry(
    accounts(null),
    null,
    state([
      [null, NOW + HOUR],
      ['/acc/senia00', NOW + HOUR],
      ['/acc/serokell', NOW + HOUR],
    ]),
    NOW,
    true,
  );
  assert.equal(target, null);
});

test('accountKey: the default account (null configDir) has a stable key', () => {
  assert.equal(accountKey(null), accountKey(null));
  assert.notEqual(accountKey(null), accountKey('/acc/senia00'));
});

// -------------------------------------------------- accounts that share a login

/**
 * default and senia00 were both logged into accountUuid c67b076f — one Claude
 * account, one quota. Rotating from one to the other burns a step and is refused
 * by the identical limit, so they must count as a single account here.
 */
const sameLogin = (a: AccountInfo): string =>
  a.name === 'default' || a.name === 'senia00' ? 'shared-account' : accountKey(a.configDir);

test('nextUsableAccount: skips an account that shares the current login', () => {
  const next = nextUsableAccount(accounts(null), null, state(), NOW, sameLogin);
  assert.equal(next?.name, 'serokell', 'senia00 is the same account as default');
});

test('nextUsableAccount: limiting one directory limits every directory sharing that login', () => {
  // Refused on default; senia00 shares its identity, so only serokell remains.
  const afterLimit = state([[null, NOW + HOUR]]);
  const next = nextUsableAccount(accounts('/acc/senia00'), '/acc/senia00', afterLimit, NOW, sameLogin);
  assert.equal(next?.name, 'serokell');
});

test('planAfterLimit: with only a duplicate left, waits instead of pretending it can switch', () => {
  const twoDirsOneAccount = accounts(null).filter((a) => a.name !== 'serokell');
  const plan = planAfterLimit({
    accounts: twoDirsOneAccount,
    current: null,
    state: state(),
    now: NOW,
    ownResetAt: NOW + 3 * HOUR,
    enabled: true,
    identityOf: sameLogin,
  });
  assert.equal(plan.why, 'all-limited');
  assert.equal(plan.switchTo, null);
  assert.equal(plan.retryAt, NOW + 3 * HOUR);
});

test('accountForRetry: a duplicate of the spent account is not a way out', () => {
  const target = accountForRetry(
    accounts(null),
    null,
    state([['', NOW + HOUR], ['shared-account', NOW + HOUR]]),
    NOW,
    true,
    sameLogin,
  );
  assert.equal(target?.name, 'serokell');
});

test('byConfigDir: the default identity keeps distinct directories distinct', () => {
  assert.notEqual(byConfigDir(accounts()[0]), byConfigDir(accounts()[1]));
});

// ---------------------------------------------- the cooldown must not loop

/**
 * What happened in production: a switch to an account that turned out to be
 * limited too. The cooldown branch returned "retry in 5s" without checking
 * whether the account we had just landed on had any room, so four turns were
 * spent in twenty seconds, each refused by the same weekly limit before it was
 * sent — and each reported to the user as "every account is limited".
 */
test('planAfterLimit: does not retry in seconds onto an account that is itself spent', () => {
  const justSwitched = NOW - 10_000;
  const plan = planAfterLimit({
    ...base,
    current: '/acc/senia00',
    accounts: accounts('/acc/senia00'),
    state: state([['/acc/senia00', NOW + 3 * HOUR]], justSwitched),
    enabled: true,
  });
  assert.equal(plan.why, 'cooldown-limited');
  assert.equal(plan.switchTo, null);
  assert.equal(
    plan.retryAt,
    justSwitched + SWITCH_COOLDOWN_MS + SWITCH_SETTLE_MS,
    'wait for the cooldown to end, then choose properly',
  );
  assert.ok(plan.retryAt - NOW > 15_000, 'not another five-second doomed retry');
});

/** The cooldown still does its job when the account we landed on is fine. */
test('planAfterLimit: retries promptly when the account just switched to has room', () => {
  const plan = planAfterLimit({
    ...base,
    current: '/acc/senia00',
    accounts: accounts('/acc/senia00'),
    state: state([], NOW - 10_000),
    enabled: true,
  });
  assert.equal(plan.why, 'cooldown');
  assert.equal(plan.retryAt, NOW + SWITCH_SETTLE_MS);
});

/** Once the cooldown is over, a spent account rotates away rather than waiting. */
test('planAfterLimit: after the cooldown, a spent account moves on', () => {
  const plan = planAfterLimit({
    ...base,
    current: '/acc/senia00',
    accounts: accounts('/acc/senia00'),
    state: state([['/acc/senia00', NOW + 3 * HOUR]], NOW - SWITCH_COOLDOWN_MS - 1),
    enabled: true,
  });
  assert.equal(plan.why, 'switched');
  assert.equal(plan.switchTo?.name, 'serokell');
});

// ---------------------------------------------------------------------------
// An account whose login has stopped working
//
// Rotation moved to an account whose OAuth had expired, which cost a turn and
// left the user to notice. A dead token is not a spent quota: there is no time
// to wait for, because it does not come back on its own.
// ---------------------------------------------------------------------------

function withUnusable(names: string[], lastSwitchAt = 0): RotationState {
  return { limited: new Map(), unusable: new Set(names), lastSwitchAt };
}

test('an account with a broken login is skipped like a spent one', () => {
  const next = nextUsableAccount(accounts(null), null, withUnusable(['/acc/senia00']), NOW);
  assert.equal(next?.name, 'serokell');
});

test('a broken login has no reset to wait for, so every account is out', () => {
  const state = withUnusable(['', '/acc/senia00', '/acc/serokell']);
  assert.equal(nextUsableAccount(accounts(null), null, state, NOW), null);
});

/** Two directories sharing one login break together, as they are one account. */
test('a broken login takes its duplicates with it', () => {
  const state: RotationState = { limited: new Map(), unusable: new Set(['shared-account']), lastSwitchAt: 0 };
  const next = nextUsableAccount(accounts(null), null, state, NOW, sameLogin);
  assert.equal(next?.name, 'serokell', 'default and senia00 are the same login');
});

test('planAfterLimit routes around a broken login too', () => {
  const plan = planAfterLimit({
    ...base,
    state: withUnusable(['/acc/senia00']),
    enabled: true,
  });
  assert.equal(plan.why, 'switched');
  assert.equal(plan.switchTo?.name, 'serokell');
});
