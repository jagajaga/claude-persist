import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestOfEachFamily } from './modelList.js';

const d = (value: string, displayName: string) => ({ value, displayName });

// What Claude's package listed on 2026-11-11.
const listed = [
  d('default', 'Default (recommended)'),
  d('opus', 'Opus 5.5'),
  d('claude-fable-5-2', 'Fable 5.2'),
  d('sonnet', 'Sonnet 5.5'),
  d('haiku', 'Haiku 5.5'),
  d('fable[1m]', 'Fable 5.1'),
  d('claude-haiku-4-5-20251001', 'Haiku 4.5'),
  d('claude-sonnet-5', 'Sonnet 5'),
  d('claude-opus-5', 'Opus 5'),
  d('claude-fable-5', 'Fable 5'),
  d('claude-opus-4-8', 'Opus 4.8'),
  d('claude-opus-4-7', 'Opus 4.7'),
  d('claude-opus-4-6', 'Opus 4.6'),
  d('claude-sonnet-4-6', 'Sonnet 4.6'),
];

test('the picker offers the default and the newest of each family, in Claude\'s order', () => {
  assert.deepEqual(newestOfEachFamily(listed).map((m) => m.value), ['default', 'opus', 'claude-fable-5-2', 'sonnet', 'haiku']);
});

test('a new release replaces its predecessor by itself; versions compare as numbers', () => {
  const later = [d('opus', 'Opus 5.5'), d('claude-opus-5-10', 'Opus 5.10'), d('claude-opus-6', 'Opus 6')];
  assert.deepEqual(newestOfEachFamily(later).map((m) => m.value), ['claude-opus-6']);
  assert.deepEqual(newestOfEachFamily([d('a', 'Opus 5.9'), d('b', 'Opus 5.10')]).map((m) => m.value), ['b']);
});

test('the same model twice keeps its plain alias over a pinned id or a long-context variant', () => {
  const twice = [d('claude-fable-5-3', 'Fable 5.3'), d('fable[1m]', 'Fable 5.3'), d('fable', 'Fable 5.3')];
  assert.deepEqual(newestOfEachFamily(twice).map((m) => m.value), ['fable']);
});
