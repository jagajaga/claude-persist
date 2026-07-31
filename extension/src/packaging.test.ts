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
 *
 * One narrow, named exception: chatWebview.test.js spins up a jsdom window to
 * exercise the webview client (extension/media/chat.js) and requires the
 * jsdom package to do it. That require() is real, but it is not a runtime
 * hazard the way an activation-path require would be — nothing under
 * extension.ts ever requires a *.test.js file, compiled or not, so it never
 * executes during activation. It IS worth naming explicitly rather than
 * exempting every "*.test.js" wholesale: compiled test files currently ship
 * inside the VSIX as-is (confirmed both by reading .vscodeignore — it only
 * excludes src/**, tsconfig.json, node_modules/** and *.map/*.ts, nothing
 * under dist/*.test.js — and by running `vsce ls`, whose output lists e.g.
 * dist/packaging.test.js and dist/streamingMarkdown.test.js next to the real
 * dist/*.js files). Shipping them is harmless dead weight since they're never
 * loaded, but it means a blanket "*.test.js" exemption would silently wave
 * through a bare require in *any* future test file, vetted or not. Naming the
 * one file (and the one specifier) keeps the guard meaningful.
 */
test('no compiled extension-host file requires a bare package at runtime', () => {
  const dist = path.join(__dirname); // this test runs from dist/
  const ALLOWLIST: Record<string, string[]> = {
    'chatWebview.test.js': ['jsdom'],
  };
  const offenders: string[] = [];
  // Recursive: a future src/<subdir>/foo.ts lands in dist/<subdir>/ and must
  // not slip past this check.
  for (const file of fs.readdirSync(dist, { recursive: true }) as string[]) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      // Relative paths ship with us; 'vscode' is injected by the host; Node
      // built-ins are always present.
      if (specifier.startsWith('.') || specifier === 'vscode') continue;
      if (specifier.startsWith('node:')) continue;
      if (ALLOWLIST[file]?.includes(specifier)) continue;
      try {
        // Core modules resolve to their own bare name; anything else resolves
        // to a path, which means it came from node_modules — and node_modules
        // is exactly what the VSIX does not ship.
        if (require.resolve(specifier) === specifier) continue;
      } catch {
        // Not resolvable at all: still a runtime failure waiting to happen.
      }
      offenders.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Runtime require() of a bare specifier will break activation in the VSIX:\n${offenders.join('\n')}`,
  );
});
