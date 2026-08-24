import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_IN_HINT, friendlyError, isSetupFailure } from './errorHints.js';

/**
 * The two failures a new user hits before anything else. Both used to arrive
 * verbatim: one as advice for a terminal this extension exists to avoid, the
 * other as a sentence about npm optional dependencies.
 */
test('a missing login says where sign-in is', () => {
  const out = friendlyError('Invalid API key · Please run /login');
  assert.match(out, /Add Account/);
  assert.match(out, /model pill/);
});

test('a missing Claude Code says to install it', () => {
  const out = friendlyError('Native CLI binary for linux-x64 not found. Reinstall ...');
  assert.match(out, /claude\.com\/download/);
});

test('spawn failures from the sign-in flow are recognised too', () => {
  assert.equal(isSetupFailure('spawn claude ENOENT'), true);
  assert.match(friendlyError('Error: spawn claude ENOENT'), /claude\.com\/download/);
});

/** The guess can be wrong, so the original is never thrown away. */
test('the original message is always kept', () => {
  const raw = 'Invalid API key · Please run /login';
  assert.ok(friendlyError(raw).includes(raw));
});

test('an unrecognised error is passed through untouched', () => {
  const raw = 'Context low: compact the conversation to continue';
  assert.equal(friendlyError(raw), raw);
  assert.equal(isSetupFailure(raw), false);
});

/**
 * "authorization" and "unauthorized" are one letter apart in intent but this
 * must not fire on ordinary prose — the limit-notice matcher in this project
 * has been over-eager twice, and each time it resent the user's message in a
 * loop for hours.
 */
test('ordinary prose about logins is not hijacked', () => {
  for (const text of [
    'I added a login form to the settings page',
    'The API key rotation script now runs nightly',
    'Turn finished (success)',
  ]) {
    assert.equal(isSetupFailure(text), false, `false positive on: ${text}`);
  }
});

test('empty and nullish messages are safe', () => {
  assert.equal(friendlyError(''), '');
  assert.equal(friendlyError(undefined as unknown as string), '');
  assert.equal(isSetupFailure(''), false);
});

test('the hint names both routes to sign-in, since only one exists per context', () => {
  assert.match(SIGN_IN_HINT, /Command Palette/);
  assert.match(SIGN_IN_HINT, /model pill/);
});
