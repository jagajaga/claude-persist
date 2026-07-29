import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plain script, loaded the same way the webview loads it. Path is relative to
// the compiled test in extension/dist/.
const { splitStreamingMarkdown } = require('../media/streamingMarkdown.js') as {
  splitStreamingMarkdown: (text: string) => { stable: string; tail: string };
};

test('no blank line yet: everything is tail', () => {
  assert.deepEqual(splitStreamingMarkdown('## Head\nsome tex'), {
    stable: '',
    tail: '## Head\nsome tex',
  });
});

test('one finished paragraph settles, the next stays raw', () => {
  assert.deepEqual(splitStreamingMarkdown('para one\n\npara tw'), {
    stable: 'para one\n\n',
    tail: 'para tw',
  });
});

test('splits at the LAST blank line, not the first', () => {
  const { stable, tail } = splitStreamingMarkdown('a\n\nb\n\nc');
  assert.equal(stable, 'a\n\nb\n\n');
  assert.equal(tail, 'c');
});

test('an open fence keeps its blank line raw', () => {
  const input = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
  assert.deepEqual(splitStreamingMarkdown(input), {
    stable: 'intro\n\n',
    tail: '```js\nconst a = 1;\n\nconst b = 2;',
  });
});

test('a closed fence settles with everything before it', () => {
  const input = '```js\ncode\n```\n\nafter';
  assert.deepEqual(splitStreamingMarkdown(input), {
    stable: '```js\ncode\n```\n\n',
    tail: 'after',
  });
});

test('a buffer that is nothing but an open fence stays entirely raw', () => {
  const input = '```js\nline\n\nline2';
  assert.deepEqual(splitStreamingMarkdown(input), { stable: '', tail: input });
});

test('tilde fences count too', () => {
  const input = 'x\n\n~~~\ncode\n\nmore';
  assert.deepEqual(splitStreamingMarkdown(input), {
    stable: 'x\n\n',
    tail: '~~~\ncode\n\nmore',
  });
});

test('empty and nullish inputs are safe', () => {
  assert.deepEqual(splitStreamingMarkdown(''), { stable: '', tail: '' });
  assert.deepEqual(
    splitStreamingMarkdown(undefined as unknown as string),
    { stable: '', tail: '' },
  );
});

test('stable + tail always reconstructs the input exactly', () => {
  const cases = [
    '',
    'a',
    'a\n\nb',
    'a\n\n\n\nb',
    '\n\nstart',
    '```\nx\n```\n\ny\n\n```\nz',
    'list:\n\n- one\n- two\n\ntail',
  ];
  for (const input of cases) {
    const { stable, tail } = splitStreamingMarkdown(input);
    assert.equal(stable + tail, input, `roundtrip failed for ${JSON.stringify(input)}`);
  }
});
