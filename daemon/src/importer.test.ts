import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listClaudeSessions } from './importer.js';
import { projectDirName } from './projectDir.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-importer-test-'));
}

/** Write a minimal but realistic Claude Code transcript. */
function writeTranscript(
  configDir: string,
  cwd: string,
  sessionId: string,
  texts: string[],
  mtimeMs?: number,
): string {
  const dir = path.join(configDir, 'projects', projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = texts.map((text) =>
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      message: { role: 'user', content: text },
    }),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('listClaudeSessions: reads the transcript metadata, not just the filename', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  writeTranscript(claudeDir, '/home/me/project', 'sess-1', ['refactor the parser']);

  const found = listClaudeSessions([claudeDir]);
  assert.equal(found.length, 1);
  assert.equal(found[0].sdkSessionId, 'sess-1');
  assert.equal(found[0].cwd, '/home/me/project');
  assert.equal(found[0].title, 'refactor the parser');
});

/**
 * The bug this guards: projectsDir was hardcoded to ~/.claude/projects, so with
 * a named account active the picker listed the default account's sessions (and
 * offered transcripts the SDK would then fail to resume), while sessions
 * created under a named account were invisible no matter what was active.
 */
test('listClaudeSessions: spans every known account, not just the default', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  const workDir = path.join(root, 'claude-accounts', 'work');
  writeTranscript(claudeDir, '/home/me/from-cli', 'cli-1', ['a CLI session']);
  writeTranscript(workDir, '/home/me/from-work', 'work-1', ['a work-account session']);

  const ids = listClaudeSessions([claudeDir, workDir])
    .map((c) => c.sdkSessionId)
    .sort();
  assert.deepEqual(ids, ['cli-1', 'work-1']);
});

/**
 * Switching accounts copies a transcript between config dirs, so the same
 * session legitimately exists twice. Listing it twice would offer the user a
 * choice between a complete transcript and a truncated one.
 */
test('listClaudeSessions: a session present in two accounts is listed once, newest copy winning', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  const workDir = path.join(root, 'claude-accounts', 'work');
  const cwd = '/home/me/project';
  const older = writeTranscript(claudeDir, cwd, 'shared-1', ['turn one'], 1_000_000_000);
  const newer = writeTranscript(workDir, cwd, 'shared-1', ['turn one', 'turn two'], 2_000_000_000);

  const found = listClaudeSessions([claudeDir, workDir]);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, newer);
  assert.notEqual(found[0].file, older);

  // Order of the config dirs must not change the winner.
  const reversed = listClaudeSessions([workDir, claudeDir]);
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].file, newer);
});

test('listClaudeSessions: an account that has never run a session is skipped, not fatal', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  writeTranscript(claudeDir, '/home/me/project', 'sess-1', ['hello']);
  const found = listClaudeSessions([path.join(root, 'never-used'), claudeDir]);
  assert.equal(found.length, 1);
});

test('listClaudeSessions: results are newest-first', () => {
  const root = tmpDir();
  const claudeDir = path.join(root, 'claude');
  writeTranscript(claudeDir, '/home/me/old', 'old-1', ['old'], 1_000_000_000);
  writeTranscript(claudeDir, '/home/me/new', 'new-1', ['new'], 3_000_000_000);
  writeTranscript(claudeDir, '/home/me/mid', 'mid-1', ['mid'], 2_000_000_000);

  assert.deepEqual(
    listClaudeSessions([claudeDir]).map((c) => c.sdkSessionId),
    ['new-1', 'mid-1', 'old-1'],
  );
});
