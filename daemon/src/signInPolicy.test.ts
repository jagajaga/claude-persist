import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldActivateAfterSignIn } from './signInPolicy.js';

const acct = (name: string, o: { active?: boolean; signedIn?: boolean; loginExpired?: boolean } = {}) => ({
  name,
  configDir: `/a/${name}`,
  active: o.active ?? false,
  signedIn: o.signedIn ?? true,
  loginExpired: o.loginExpired ?? false,
});

test('re-signing in a spare account leaves the working one in use, so no chat restarts', () => {
  const accounts = [acct('senia00', { active: true }), acct('arseniyseroka', { loginExpired: true })];
  assert.equal(shouldActivateAfterSignIn(accounts, '/a/arseniyseroka'), false);
});

test('signing in switches when the account in use cannot work', () => {
  assert.equal(shouldActivateAfterSignIn([acct('a', { active: true, loginExpired: true }), acct('b')], '/a/b'), true);
  assert.equal(shouldActivateAfterSignIn([acct('a', { active: true, signedIn: false }), acct('b')], '/a/b'), true);
  assert.equal(shouldActivateAfterSignIn([acct('b')], '/a/b'), true, 'nothing active: the first sign-in becomes it');
});

test('signing in the account already in use does not switch (no restart)', () => {
  assert.equal(shouldActivateAfterSignIn([acct('a', { active: true, loginExpired: true })], '/a/a'), false);
});
