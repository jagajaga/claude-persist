import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  type ExecutableProbe,
  binaryNames,
  detectMusl,
  findClaudeExecutable,
  platformPackages,
  wellKnownDirs,
} from './claudeExecutable.js';

const BUNDLE = '/ext/daemon/node_modules/@anthropic-ai';

function probe(over: Partial<ExecutableProbe> & { files?: string[] }): ExecutableProbe {
  const files = new Set(over.files ?? []);
  return {
    platform: over.platform ?? 'linux',
    arch: over.arch ?? 'x64',
    bundleDir: over.bundleDir === undefined ? BUNDLE : over.bundleDir,
    pathEntries: over.pathEntries ?? ['/usr/bin'],
    home: over.home ?? '/home/u',
    isFile: over.isFile ?? ((p: string) => files.has(p)),
  };
}

// ------------------------------------------------------------ platformPackages

test('platformPackages: each platform names the package the SDK actually ships', () => {
  assert.deepEqual(platformPackages('darwin', 'arm64'), ['claude-agent-sdk-darwin-arm64']);
  assert.deepEqual(platformPackages('darwin', 'x64'), ['claude-agent-sdk-darwin-x64']);
  assert.deepEqual(platformPackages('win32', 'x64'), ['claude-agent-sdk-win32-x64']);
  assert.deepEqual(platformPackages('linux', 'arm64'), [
    'claude-agent-sdk-linux-arm64',
    'claude-agent-sdk-linux-arm64-musl',
  ]);
});

/** A glibc binary does not run on Alpine, so musl leads where musl is in use. */
test('platformPackages: musl systems prefer the musl build', () => {
  assert.deepEqual(platformPackages('linux', 'x64', true), [
    'claude-agent-sdk-linux-x64-musl',
    'claude-agent-sdk-linux-x64',
  ]);
});

/**
 * A wrong binary fails later and far more confusingly than no binary now — an
 * armv7 or 32-bit host must fall through to the user's own install.
 */
test('platformPackages: an unsupported cpu or platform gets no guess', () => {
  assert.deepEqual(platformPackages('linux', 'arm'), []);
  assert.deepEqual(platformPackages('win32', 'arm64'), []);
  assert.deepEqual(platformPackages('freebsd', 'x64'), []);
});

test('binaryNames: Windows shims are candidates too', () => {
  assert.deepEqual(binaryNames('linux'), ['claude']);
  assert.deepEqual(binaryNames('win32'), ['claude.exe', 'claude.cmd', 'claude']);
});

test('detectMusl: only ever true on linux', () => {
  const isFile = (p: string): boolean => p === '/lib/ld-musl-x86_64.so.1';
  assert.equal(detectMusl(isFile, 'linux'), true);
  assert.equal(detectMusl(isFile, 'darwin'), false);
  assert.equal(detectMusl(() => false, 'linux'), false);
});

// ------------------------------------------------------- findClaudeExecutable

test('the bundled binary wins when it was built for this machine', () => {
  const bundled = path.join(BUNDLE, 'claude-agent-sdk-linux-x64', 'claude');
  const found = findClaudeExecutable(
    probe({ files: [bundled, '/usr/bin/claude'], pathEntries: ['/usr/bin'] }),
  );
  assert.equal(found, bundled, 'no reason to prefer the user\u2019s install over the shipped one');
});

/**
 * The whole point. CI packages on linux-x64, so a macOS user gets a bundle full
 * of a Linux binary. Before this, the SDK found it, refused it, and reported
 * "Native CLI binary for linux-x64 not found" — on a Mac with Claude Code
 * installed and working.
 */
test('a bundle for the wrong platform is ignored in favour of the real install', () => {
  const linuxBundle = path.join(BUNDLE, 'claude-agent-sdk-linux-x64', 'claude');
  const found = findClaudeExecutable(
    probe({
      platform: 'darwin',
      arch: 'arm64',
      files: [linuxBundle, '/opt/homebrew/bin/claude'],
      pathEntries: ['/usr/bin'],
    }),
  );
  assert.equal(found, '/opt/homebrew/bin/claude');
});

test('PATH is searched in order', () => {
  const found = findClaudeExecutable(
    probe({
      bundleDir: null,
      files: ['/a/claude', '/b/claude'],
      pathEntries: ['/b', '/a'],
    }),
  );
  assert.equal(found, '/b/claude');
});

/**
 * A GUI-launched editor on macOS does not always inherit a login shell's PATH,
 * which is the classic "but it works in my terminal" report.
 */
test('well-known install locations are tried when PATH is empty', () => {
  const found = findClaudeExecutable(
    probe({ bundleDir: null, pathEntries: [], files: ['/home/u/.local/bin/claude'] }),
  );
  assert.equal(found, '/home/u/.local/bin/claude');
  assert.ok(wellKnownDirs('/home/u').includes('/opt/homebrew/bin'), 'homebrew is where macOS puts it');
});

test('a Windows shim is found', () => {
  const found = findClaudeExecutable(
    probe({
      platform: 'win32',
      bundleDir: null,
      pathEntries: ['C:\\bin'],
      files: [path.join('C:\\bin', 'claude.cmd')],
    }),
  );
  assert.equal(found, path.join('C:\\bin', 'claude.cmd'));
});

/** Null is a real answer: the caller has to tell the user, not spawn nothing. */
test('nothing anywhere is null, not a hopeful bare name', () => {
  assert.equal(findClaudeExecutable(probe({ bundleDir: null, files: [], pathEntries: ['/usr/bin'] })), null);
});

test('an empty PATH entry is skipped rather than resolving to a relative path', () => {
  const found = findClaudeExecutable(
    probe({ bundleDir: null, pathEntries: ['', '/usr/bin'], files: ['claude', '/usr/bin/claude'] }),
  );
  assert.equal(found, '/usr/bin/claude');
});
