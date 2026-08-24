import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * `EXPECTED_PROTOCOL` (extension, CommonJS) and `PROTOCOL_VERSION` (shared,
 * ESM) are two hand-maintained copies of one number: the shared package can't
 * be require()d from the extension host, so the constant is duplicated with a
 * "keep in sync" comment and nothing else.
 *
 * Getting them out of step is not a soft failure. The extension SIGTERMs any
 * daemon whose handshake doesn't match, so a bump on only one side means every
 * freshly spawned daemon reports the "wrong" version and is killed on sight —
 * an unbreakable kill/respawn loop, and "Could not start claude-persist
 * daemon" for every user, on every window, until a new release goes out.
 *
 * Cheap to get wrong (one edited line), so it's worth a test rather than a
 * comment. Both constants are read as text: importing the ESM one from a CJS
 * test is the exact thing that isn't possible here.
 */

const repoRoot = path.join(__dirname, '..', '..'); // this test runs from extension/dist

function readConstant(relPath: string, name: string): number {
  const file = path.join(repoRoot, relPath);
  const source = fs.readFileSync(file, 'utf8');
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(source);
  assert.ok(match, `could not find ${name} in ${relPath}`);
  return Number(match[1]);
}

test('EXPECTED_PROTOCOL matches shared PROTOCOL_VERSION', () => {
  const shared = readConstant('shared/src/protocol.ts', 'PROTOCOL_VERSION');
  const extension = readConstant('extension/src/daemonClient.ts', 'EXPECTED_PROTOCOL');
  assert.equal(
    extension,
    shared,
    `EXPECTED_PROTOCOL (${extension}) != PROTOCOL_VERSION (${shared}). ` +
      'Bump both, or the extension will kill every daemon it spawns.',
  );
});

/**
 * The socket path is the other hand-maintained copy, and for the same reason:
 * the daemon computes it in ESM (daemon/src/paths.ts), the extension host in
 * CommonJS (extension/src/daemonClient.ts), and neither can import the other.
 *
 * It is the single point where the two processes meet. Disagree by one
 * character and the extension connects to nothing, spawns a daemon, connects
 * to nothing again, and reports "Could not start claude-persist daemon"
 * forever — while a perfectly healthy daemon is listening a few bytes away.
 * Windows made this real: the unix branch is a path join, the pipe branch is an
 * escaped literal, and only one of them was written twice.
 */
function readSource(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('the daemon and the extension agree on the socket path', () => {
  const daemon = readSource('daemon/src/paths.ts');
  const extension = readSource('extension/src/daemonClient.ts');

  for (const fragment of ['pipe\\\\claude-persist-', "'.claude-persist'", "'daemon.sock'"]) {
    assert.ok(daemon.includes(fragment), `daemon/src/paths.ts lost ${fragment}`);
    assert.ok(
      extension.includes(fragment),
      `extension/src/daemonClient.ts does not match the daemon: missing ${fragment}`,
    );
  }
});

/** Both sides must branch on the platform, or one of them is wrong somewhere. */
test('both sides branch to a named pipe on Windows', () => {
  for (const file of ['daemon/src/paths.ts', 'extension/src/daemonClient.ts']) {
    assert.match(readSource(file), /process\.platform === 'win32'/, `${file} assumes unix`);
  }
});
