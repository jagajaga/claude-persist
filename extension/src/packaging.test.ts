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
 * exempting every "*.test.js" wholesale. .vscodeignore now excludes
 * dist/**\/*.test.js and scripts/package.sh strips the bundled daemon's
 * compiled tests (its node_modules/** rule matches only the extension root,
 * which is the same reason the bundled runtime survives packaging), so they no
 * longer ship — but a blanket "*.test.js" exemption would still silently wave
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

// ---------------------------------------------------------------------------
// Manifest guarantees a new user depends on
// ---------------------------------------------------------------------------

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as {
  keywords?: string[];
  capabilities?: { untrustedWorkspaces?: { supported?: boolean; description?: string } };
  contributes?: { commands?: Array<{ command: string; title: string }> };
};

/**
 * With no `capabilities.untrustedWorkspaces` declaration, VS Code defaults an
 * extension to *not supported* in Restricted Mode and disables it silently.
 * A freshly cloned folder is untrusted by default, so that is exactly where a
 * new user starts: the activity-bar icon never appears and nothing explains it.
 * Declaring it — even as unsupported — is what makes VS Code show the reason.
 */
test('workspace trust is declared, with a reason', () => {
  const trust = manifest.capabilities?.untrustedWorkspaces;
  assert.ok(trust, 'capabilities.untrustedWorkspaces missing: the extension vanishes in Restricted Mode');
  assert.equal(typeof trust.supported, 'boolean');
  assert.ok(
    (trust.description ?? '').length > 20,
    'an undeclared reason leaves the user with a disabled extension and no explanation',
  );
});

/**
 * Sign-in used to be reachable only from a menu inside the model pill, inside a
 * chat panel, which itself only exists once you have created a session. A user
 * with no Claude credentials had no way to find it.
 */
test('signing in is reachable from the Command Palette', () => {
  const commands = manifest.contributes?.commands ?? [];
  const addAccount = commands.find((c) => c.command === 'claudePersist.addAccount');
  assert.ok(addAccount, 'no claudePersist.addAccount command: sign-in is unreachable from a cold start');
  assert.match(addAccount.title, /^Claude Persist: /, 'palette search relies on the prefix');
});

test('the listing carries keywords, or marketplace search cannot find it', () => {
  assert.ok((manifest.keywords ?? []).length >= 3);
  assert.ok(manifest.keywords?.includes('claude'));
});
