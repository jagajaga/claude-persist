import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compareVersions, stalenessReason } from './daemonClient';

const OURS = 19;

function existingFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-staleness-test-'));
  const file = path.join(dir, 'main.js');
  fs.writeFileSync(file, '// pretend daemon entry\n');
  return file;
}

test('a matching daemon whose entry still exists is not stale', () => {
  const info = { protocolVersion: OURS, pid: 1, entry: existingFile() };
  assert.equal(stalenessReason(info, OURS), null);
});

test('an older protocol is stale', () => {
  const info = { protocolVersion: OURS - 1, pid: 1, entry: existingFile() };
  assert.match(stalenessReason(info, OURS) ?? '', /Outdated daemon/);
});

test('a newer protocol is also reported (connect() decides who loses)', () => {
  const info = { protocolVersion: OURS + 1, pid: 1, entry: existingFile() };
  assert.match(stalenessReason(info, OURS) ?? '', /Outdated daemon/);
});

/**
 * The gap the protocol integer could never cover: 0.7.26 through 0.7.29 all
 * spoke protocol 16, so those upgrades kept the running daemon on purpose —
 * while VS Code deleted the extension directory it was loaded from, taking the
 * bundled SDK and its native `claude` binary along. The daemon kept answering
 * `hello` while every real turn failed to spawn.
 */
test('a daemon whose entry file has been deleted is stale even on a matching protocol', () => {
  const file = existingFile();
  fs.rmSync(file);
  const reason = stalenessReason({ protocolVersion: OURS, pid: 1, entry: file }, OURS);
  assert.match(reason ?? '', /deleted install/);
  assert.match(reason ?? '', /main\.js/); // names the path, so the log is actionable
});

/**
 * Deliberately narrow: the check is "the daemon's own entry vanished", never
 * "the daemon's entry differs from mine". Two windows pointed at different
 * daemonEntry paths (the claudePersist.daemonEntry setting, or a dev checkout
 * beside an installed VSIX) would otherwise kill each other's daemon forever —
 * exactly the mutual-murder loop the protocol check already caused once.
 */
test('a daemon launched from a different but existing entry is left alone', () => {
  const theirs = existingFile();
  const ours = existingFile();
  assert.notEqual(theirs, ours);
  assert.equal(stalenessReason({ protocolVersion: OURS, pid: 1, entry: theirs }, OURS), null);
});

test('an empty entry (a daemon that could not report one) is not treated as deleted', () => {
  assert.equal(stalenessReason({ protocolVersion: OURS, pid: 1, entry: '' }, OURS), null);
});

// ---------------------------------------------------------------------------
// A daemon from an older build must be replaced
//
// It was replaced only when the protocol changed or its entry file vanished.
// Old extension directories are never pruned, so the entry goes on existing:
// a daemon spawned by 1.0.13 was still serving after six releases, and every
// daemon-side fix in them sat on disk doing nothing.
// ---------------------------------------------------------------------------

test('an older daemon build is stale even on a matching protocol', () => {
  const reason = stalenessReason(
    { protocolVersion: 29, pid: 1, entry: __filename, version: '1.0.13' },
    29,
    '1.0.20',
  );
  assert.match(reason ?? '', /older build/);
  assert.match(reason ?? '', /1\.0\.13/);
});

test('the same build is not stale', () => {
  assert.equal(
    stalenessReason({ protocolVersion: 29, pid: 1, entry: __filename, version: '1.0.20' }, 29, '1.0.20'),
    null,
  );
});

/**
 * Only older, never merely different. Two windows on different builds would
 * otherwise kill each other's daemon forever -- the same mutual-murder shape
 * the protocol check already had once. Older loses, so this converges.
 */
test('a newer daemon is left alone by an older window', () => {
  assert.equal(
    stalenessReason({ protocolVersion: 29, pid: 1, entry: __filename, version: '1.0.21' }, 29, '1.0.20'),
    null,
  );
});

test('a daemon that never reported a build is judged on protocol alone', () => {
  assert.equal(
    stalenessReason({ protocolVersion: 29, pid: 1, entry: __filename, version: null }, 29, '1.0.20'),
    null,
  );
});

test('compareVersions orders releases numerically, not as text', () => {
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1, '10 is after 9, not before it');
  assert.equal(compareVersions('1.0.20', '1.0.20'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0, 'a missing part is zero');
  assert.equal(compareVersions('junk', 'junk'), 0, 'unparseable is not a licence to kill');
});
