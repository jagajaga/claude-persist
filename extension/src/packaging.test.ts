import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The packaged VSIX ships `dist/`, `media/` and a bundled `daemon/` — and no
 * node_modules beside dist. So any runtime require() of a bare package
 * specifier from the extension host resolves in this monorepo (via the
 * workspace symlink) and then fails at load time on a user's machine, taking
 * activate() with it: no sidebar, no chat tabs, and no working update
 * mechanism to recover with.
 *
 * `import type` is erased and stays fine; this catches the value imports.
 */
test('no compiled extension-host file requires a bare package at runtime', () => {
  const dist = path.join(__dirname); // this test runs from dist/
  const offenders: string[] = [];
  for (const file of fs.readdirSync(dist)) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      // Relative paths ship with us; 'vscode' is injected by the host; Node
      // built-ins are always present.
      if (specifier.startsWith('.') || specifier === 'vscode') continue;
      if (specifier.startsWith('node:')) continue;
      try {
        if (require.resolve(specifier) === specifier) continue; // core module
      } catch {
        // not resolvable as a core module — fall through and report it
      }
      const isBuiltin = !specifier.includes('/') && !require.resolve.paths(specifier)?.length;
      if (isBuiltin) continue;
      offenders.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Runtime require() of a bare specifier will break activation in the VSIX:\n${offenders.join('\n')}`,
  );
});
