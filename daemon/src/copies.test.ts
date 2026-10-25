import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The daemon answers the phone's "where is this chat working" with the very
 * code the editor panel uses for its branch chip. The extension is CommonJS
 * and this package is ESM, so the files are copied rather than shared -- and
 * a copy that drifts would make the phone and the panel disagree. These must
 * stay byte-for-byte identical; change both or neither.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const ext = path.join(here, '..', '..', 'extension', 'src');

for (const file of ['gitBranch.ts', 'activeDirs.ts']) {
  test(`${file} is the extension's own, unchanged`, () => {
    assert.equal(fs.readFileSync(path.join(src, file), 'utf8'), fs.readFileSync(path.join(ext, file), 'utf8'));
  });
}
