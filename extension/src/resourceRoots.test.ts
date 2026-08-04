import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resourceRootPaths } from './resourceRoots';

test('resourceRootPaths: always covers uploads, home and temp', () => {
  const roots = resourceRootPaths('/some/uploads');
  assert.ok(roots.includes('/some/uploads'));
  assert.ok(roots.some((r) => r === os.homedir() || r === fs.realpathSync(os.homedir())));
  assert.ok(roots.some((r) => r === os.tmpdir() || r === fs.realpathSync(os.tmpdir())));
});

/**
 * The trap this exists for: code-server opens the workspace through
 * /home/coder/code-workspace -> /home/jaga/code-workspace, so paths arrive in
 * the resolved form. Allowing only the spelling VS Code reports leaves every
 * such image outside all roots, and the webview refuses it with no visible
 * reason — the same symlink trap that broke transcript lookup.
 */
test('resourceRootPaths: allows both the symlinked and resolved spellings', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-roots-')));
  const real = path.join(base, 'real-workspace');
  const link = path.join(base, 'linked-workspace');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'dir');

  const roots = resourceRootPaths('/uploads', [link]);
  assert.ok(roots.includes(link), 'the spelling VS Code reports must be allowed');
  assert.ok(roots.includes(real), 'the resolved spelling must be allowed too');
});

test('resourceRootPaths: a workspace folder that does not exist is still allowed literally', () => {
  const roots = resourceRootPaths('/uploads', ['/definitely/not/here']);
  assert.ok(roots.includes('/definitely/not/here'));
});

test('resourceRootPaths: no duplicates, no empty entries', () => {
  const roots = resourceRootPaths(os.tmpdir(), [os.tmpdir(), '']);
  assert.equal(new Set(roots).size, roots.length);
  assert.ok(!roots.includes(''));
});
