import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_IN_HINT, friendlyError, isSetupFailure, needsSignIn } from './errorHints.js';

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

/**
 * What an expired refresh token looks like coming back from the CLI. Rotation
 * moved to an account whose login had lapsed; the turn died and the only advice
 * was to go and find a command in the palette.
 */
test('an expired OAuth session is recognised as a sign-in problem', () => {
  for (const text of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'OAuth session expired',
  ]) {
    assert.equal(needsSignIn(text), true, text);
    assert.equal(isSetupFailure(text), true, text);
    assert.match(friendlyError(text), /Add Account|model pill/);
  }
});

test('a missing binary is not a sign-in problem', () => {
  assert.equal(needsSignIn('Native CLI binary for linux-x64 not found'), false);
  assert.equal(isSetupFailure('Native CLI binary for linux-x64 not found'), true);
});

test('ordinary prose is neither', () => {
  assert.equal(needsSignIn('I refreshed the OAuth docs page'), false);
});
