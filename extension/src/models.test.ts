import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelDescriptor } from '@claude-persist/shared';
import { mergeExtraModels } from './models';

const probed: ModelDescriptor[] = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', displayName: 'Opus', effortLevels: ['low', 'high'] as ModelDescriptor['effortLevels'] },
];

test('appends unknown extras as bare descriptors after probed models', () => {
  const merged = mergeExtraModels(probed, ['claude-opus-5']);
  assert.deepEqual(merged.map((m) => m.value), ['default', 'opus[1m]', 'claude-opus-5']);
  assert.deepEqual(merged[2], { value: 'claude-opus-5', displayName: 'claude-opus-5' });
});

test('dedupes extras already in the probed list', () => {
  const merged = mergeExtraModels(probed, ['opus[1m]', 'claude-opus-5', 'claude-opus-5']);
  assert.deepEqual(merged.map((m) => m.value), ['default', 'opus[1m]', 'claude-opus-5']);
});

test('ignores blank entries and returns the probed list untouched for no extras', () => {
  assert.deepEqual(mergeExtraModels(probed, ['', '  ']), probed);
  assert.deepEqual(mergeExtraModels(probed, []), probed);
});

test('does not mutate the probed array', () => {
  const before = [...probed];
  mergeExtraModels(probed, ['claude-opus-5']);
  assert.deepEqual(probed, before);
});
