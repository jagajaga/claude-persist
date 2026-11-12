import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from './registry.js';

function registryFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-registry-test-')), 'registry.json');
}

test('load: a missing file is a normal first run, not a corruption', () => {
  const file = registryFile();
  const registry = new Registry(file);
  assert.equal(registry.load(), null);
  assert.deepEqual(registry.list(), []);
});

test('save/load: round-trips sessions', () => {
  const file = registryFile();
  const first = new Registry(file);
  const meta = first.create('/home/me/project', 'My session');
  meta.sdkSessionId = 'sdk-1';
  first.save();

  const second = new Registry(file);
  assert.equal(second.load(), null);
  const loaded = second.get(meta.id);
  assert.equal(loaded?.title, 'My session');
  assert.equal(loaded?.sdkSessionId, 'sdk-1');
});

/**
 * The bug this guards: load() swallowed parse errors and started empty, and the
 * next save() — which runs on every sent message, via touch() — overwrote the
 * only copy. A single torn write meant every session's title, cwd and
 * sdkSessionId were gone for good, with the sidebar simply looking empty.
 */
test('load: a corrupt registry is quarantined, not silently replaced', () => {
  const file = registryFile();
  fs.writeFileSync(file, '[{"id":"a","title":"half a wri');

  const registry = new Registry(file);
  const quarantine = registry.load();
  assert.ok(quarantine, 'a corrupt registry must report where it went');
  assert.notEqual(quarantine, file);
  assert.equal(fs.existsSync(quarantine!), true);
  assert.match(fs.readFileSync(quarantine!, 'utf8'), /half a wri/);
  assert.deepEqual(registry.list(), []);

  // And the recovery copy survives the daemon carrying on and writing.
  registry.create('/home/me/project');
  assert.match(fs.readFileSync(quarantine!, 'utf8'), /half a wri/);
});

test('load: valid JSON that is not an array is treated as corrupt', () => {
  const file = registryFile();
  fs.writeFileSync(file, '{"sessions":[]}');
  const registry = new Registry(file);
  assert.ok(registry.load());
});

test('load: junk entries are skipped without discarding the good ones', () => {
  const file = registryFile();
  fs.writeFileSync(
    file,
    JSON.stringify([
      null,
      { title: 'no id at all' },
      { id: 'keep-me', title: 'Good', cwd: '/x', createdAt: 1, lastActivityAt: 2 },
    ]),
  );
  const registry = new Registry(file);
  assert.equal(registry.load(), null);
  assert.deepEqual(
    registry.list().map((m) => m.id),
    ['keep-me'],
  );
});

test('save: replaces atomically and leaves no temp files behind', () => {
  const file = registryFile();
  const registry = new Registry(file);
  registry.create('/home/me/project');
  registry.save();
  const strays = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(strays, []);
  // Still parseable, i.e. the rename landed a complete document.
  assert.equal(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))), true);
});

test('save: a reader never observes a partially written registry', () => {
  const file = registryFile();
  const registry = new Registry(file);
  for (let i = 0; i < 20; i++) registry.create(`/home/me/p${i}`);
  // Every save is a rename over a fully written temp file, so any read between
  // saves sees a complete array — never a truncated one.
  for (let i = 0; i < 20; i++) {
    registry.save();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
    assert.equal(parsed.length, 20);
  }
});

test('fork: a new chat in the same folder and settings that branches off the original', () => {
  const file = registryFile();
  const registry = new Registry(file);
  const source = registry.create('/home/me/shalyto', 'shl|Copy');
  source.sdkSessionId = 'sdk-orig';
  source.model = 'claude-fable-5-2';
  source.effort = 'max';
  source.permissionMode = 'bypassPermissions';
  const copied: Array<[string, string]> = [];
  const fork = registry.fork(source.id, (from, to) => copied.push([from, to]));

  assert.notEqual(fork.id, source.id);
  assert.equal(fork.cwd, '/home/me/shalyto');
  assert.equal(fork.title, 'shl|Copy (fork)');
  assert.equal(fork.titleSetByUser, true);
  assert.deepEqual([fork.model, fork.effort, fork.permissionMode], ['claude-fable-5-2', 'max', 'bypassPermissions']);
  assert.equal(fork.sdkSessionId, 'sdk-orig');
  assert.equal(fork.forkPending, true);
  assert.deepEqual(copied, [[source.id, fork.id]]);
  // The original is left exactly as it was.
  assert.equal(source.forkPending, undefined);
  // And the fork survives a restart still waiting to branch.
  const again = new Registry(file);
  again.load();
  assert.equal(again.get(fork.id)?.forkPending, true);
});

test('fork: a chat with no conversation yet cannot be forked', () => {
  const registry = new Registry(registryFile());
  const empty = registry.create('/tmp', 'new');
  assert.throws(() => registry.fork(empty.id, () => {}), /no conversation/);
  assert.throws(() => registry.fork('nope', () => {}), /unknown session/);
});
