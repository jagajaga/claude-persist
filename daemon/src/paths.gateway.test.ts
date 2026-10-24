import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayPort, gatewayProtect } from './paths.js';

const noFile = () => { throw new Error('ENOENT'); };

/** It is a network listener: nobody gets one without asking. */
test('gateway: off unless asked for', () => {
  assert.equal(gatewayPort({}, noFile), null);
});

test('gateway: on from the config file', () => {
  assert.equal(gatewayPort({}, () => '{"port": 7790}'), 7790);
});

test('gateway: the environment wins over the file', () => {
  assert.equal(gatewayPort({ CLAUDE_PERSIST_GATEWAY_PORT: '8123' }, () => '{"port": 7790}'), 8123);
});

test('gateway: a nonsense port is no port, not a crash', () => {
  for (const bad of ['{"port": 0}', '{"port": 70000}', '{"port": "7790"}', '{"port": 1.5}', 'not json']) {
    assert.equal(gatewayPort({}, () => bad), null, bad);
  }
  assert.equal(gatewayPort({ CLAUDE_PERSIST_GATEWAY_PORT: 'abc' }, noFile), null);
});

/** It uses sudo; nobody gets that without asking. */
test('protect: off unless asked for, and only by an explicit true', () => {
  assert.equal(gatewayProtect(noFile), false);
  assert.equal(gatewayProtect(() => '{"port": 7790}'), false);
  assert.equal(gatewayProtect(() => '{"port": 7790, "protect": "yes"}'), false);
  assert.equal(gatewayProtect(() => '{"port": 7790, "protect": true}'), true);
});
