import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, isNewerVersion } from '@claude-persist/shared';

test('parseRelease: picks the vsix asset out of a release', () => {
  const info = parseRelease({
    tag_name: 'v0.7.12',
    html_url: 'https://github.com/jagajaga/claude-persist/releases/tag/v0.7.12',
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://example.invalid/notes.txt' },
      { name: 'claude-persist-0.7.12.vsix', browser_download_url: 'https://example.invalid/x.vsix' },
    ],
  });
  assert.deepEqual(info, {
    tagName: 'v0.7.12',
    htmlUrl: 'https://github.com/jagajaga/claude-persist/releases/tag/v0.7.12',
    vsixUrl: 'https://example.invalid/x.vsix',
    vsixName: 'claude-persist-0.7.12.vsix',
  });
});

test('parseRelease: a release with no vsix still parses, without a download', () => {
  const info = parseRelease({ tag_name: 'v1.0.0', html_url: 'https://example.invalid/r', assets: [] });
  assert.deepEqual(info, { tagName: 'v1.0.0', htmlUrl: 'https://example.invalid/r' });
});

test('parseRelease: unusable payloads are null, not throws', () => {
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease('nope'), null);
  assert.equal(parseRelease({}), null);
  assert.equal(parseRelease({ tag_name: '   ' }), null);
  // What the API actually returns when the IP is rate-limited.
  assert.equal(parseRelease({ message: 'API rate limit exceeded' }), null);
});

test('parseRelease: tolerates a missing or malformed assets list', () => {
  assert.deepEqual(parseRelease({ tag_name: 'v2.0.0' }), { tagName: 'v2.0.0', htmlUrl: '' });
  assert.deepEqual(parseRelease({ tag_name: 'v2.0.0', assets: 'broken' }), {
    tagName: 'v2.0.0',
    htmlUrl: '',
  });
});

test('isNewerVersion: compares across the tag/package "v" mismatch', () => {
  assert.equal(isNewerVersion('v0.7.12', '0.7.11'), true);
  assert.equal(isNewerVersion('0.7.12', 'v0.7.11'), true);
});

test('isNewerVersion: equal and older are not newer', () => {
  assert.equal(isNewerVersion('v0.7.11', '0.7.11'), false);
  assert.equal(isNewerVersion('v0.7.10', '0.7.11'), false);
});

test('isNewerVersion: compares numerically, not lexically', () => {
  assert.equal(isNewerVersion('v0.7.100', '0.7.99'), true);
  assert.equal(isNewerVersion('v0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('v1.0.0', '0.99.99'), true);
});

test('isNewerVersion: junk degrades to 0 rather than NaN', () => {
  assert.equal(isNewerVersion('vnope', '0.0.1'), false);
  assert.equal(isNewerVersion('v0.0.1', 'nope'), true);
});
