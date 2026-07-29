import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTitleFromInput } from './sessionTitle';

test('keeps a title the user actually typed', () => {
  assert.equal(sessionTitleFromInput('claude-persist-branch chip', 'claude-persist'), 'claude-persist-branch chip');
});

test('drops the seed dash when the prefix is accepted unchanged', () => {
  assert.equal(sessionTitleFromInput('claude-persist-', 'claude-persist'), 'claude-persist');
});

test('drops trailing dashes and whitespace together', () => {
  assert.equal(sessionTitleFromInput('  work -  ', 'fallback'), 'work');
  assert.equal(sessionTitleFromInput('work--', 'fallback'), 'work');
});

test('falls back when nothing is left', () => {
  assert.equal(sessionTitleFromInput('', 'fallback'), 'fallback');
  assert.equal(sessionTitleFromInput('   ', 'fallback'), 'fallback');
  assert.equal(sessionTitleFromInput('-', 'fallback'), 'fallback');
});

test('leaves internal dashes alone', () => {
  assert.equal(sessionTitleFromInput('a-b-c', 'fallback'), 'a-b-c');
});
