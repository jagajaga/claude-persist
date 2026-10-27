import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeSettings, newestLogins, shareAccountSetup } from './sharedSetup.js';

/** A home with a default account and two named ones, laid out as on the real machine. */
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-share-'));
  const claudeDir = path.join(root, '.claude');
  const accountsDir = path.join(root, '.claude-accounts');
  const a = path.join(accountsDir, 'work');
  const b = path.join(accountsDir, 'home');
  for (const d of [claudeDir, a, b]) fs.mkdirSync(path.join(d, 'plugins'), { recursive: true });
  const w = (f: string, v: unknown) => fs.writeFileSync(f, JSON.stringify(v));
  w(path.join(claudeDir, 'settings.json'), { model: 'opus', enabledPlugins: { 'figma@official': true } });
  w(path.join(a, 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'reap.sh' }] }] }, permissions: { allow: ['Bash(git:*)'] } });
  w(path.join(b, 'settings.json'), { theme: 'dark', permissions: { allow: ['Bash(git:*)', 'Read'] } });
  w(path.join(root, '.claude.json'), { oauthAccount: { email: 'default@x' }, mcpServers: {} });
  w(path.join(a, '.claude.json'), { oauthAccount: { email: 'work@x' }, mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } });
  w(path.join(b, '.claude.json'), { oauthAccount: { email: 'home@x' } });
  w(path.join(claudeDir, '.credentials.json'), { claudeAiOauth: { accessToken: 'DEFAULT' } });
  w(path.join(a, '.credentials.json'), { claudeAiOauth: { accessToken: 'WORK' }, mcpOAuth: { 'sentry|1': { accessToken: 'sentry-token' } } });
  w(path.join(b, '.credentials.json'), { claudeAiOauth: { accessToken: 'HOME' } });
  w(path.join(claudeDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'figma@official': [{ installPath: path.join(claudeDir, 'plugins/cache/figma') }] } });
  w(path.join(a, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {} });
  const paths = { claudeDir, defaultClaudeJson: path.join(root, '.claude.json'), accountsDir };
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
  return { root, claudeDir, a, b, paths, read };
}

test('settings: hooks and permissions joined, plugins kept, first wins for the rest', () => {
  const merged = mergeSettings([
    { model: 'opus', enabledPlugins: { x: true } },
    { model: 'sonnet', hooks: { Stop: [{ c: 1 }] }, permissions: { allow: ['A'] } },
    { hooks: { Stop: [{ c: 1 }, { c: 2 }] }, permissions: { allow: ['A', 'B'], defaultMode: 'plan' }, enabledPlugins: { x: false, y: true } },
  ]);
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.hooks, { Stop: [{ c: 1 }, { c: 2 }] });
  assert.deepEqual(merged.permissions, { allow: ['A', 'B'], defaultMode: 'plan' });
  assert.deepEqual(merged.enabledPlugins, { x: true, y: true });
});

test('every account ends up with the same settings, linked, and the old files kept', () => {
  const h = home();
  shareAccountSetup(h.paths, () => {}, () => 42);
  for (const d of [h.a, h.b]) {
    assert.ok(fs.lstatSync(path.join(d, 'settings.json')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(d, 'settings.json.before-shared-42')), 'old copy kept');
  }
  const s = h.read(path.join(h.b, 'settings.json'));
  assert.equal((s.hooks.SessionStart[0].hooks[0] as { command: string }).command, 'reap.sh', 'work\'s hook reaches home');
  assert.deepEqual(s.permissions.allow, ['Bash(git:*)', 'Read']);
  assert.deepEqual(s.enabledPlugins, { 'figma@official': true });
  assert.equal(s.theme, 'dark');
});

/** Claude Code saves settings by replacing the file, which turns the link back into a file of its own. */
test('a settings file that came back on its own is merged in again', () => {
  const h = home();
  shareAccountSetup(h.paths, () => {}, () => 1);
  const file = path.join(h.a, 'settings.json');
  fs.rmSync(file);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['WebFetch'] } }));
  shareAccountSetup(h.paths, () => {}, () => 2);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.ok(h.read(path.join(h.claudeDir, 'settings.json')).permissions.allow.includes('WebFetch'));
});

test('MCP servers and their logins reach every account; each keeps its own Claude login', () => {
  const h = home();
  shareAccountSetup(h.paths);
  for (const [file, email] of [[h.paths.defaultClaudeJson, 'default@x'], [path.join(h.b, '.claude.json'), 'home@x']] as const) {
    const j = h.read(file);
    assert.deepEqual(Object.keys(j.mcpServers), ['sentry']);
    assert.equal(j.oauthAccount.email, email, 'its own account is untouched');
  }
  for (const [dir, login] of [[h.claudeDir, 'DEFAULT'], [h.b, 'HOME']] as const) {
    const c = h.read(path.join(dir, '.credentials.json'));
    assert.equal(c.mcpOAuth['sentry|1'].accessToken, 'sentry-token');
    assert.equal(c.claudeAiOauth.accessToken, login, 'its own Claude login is untouched');
    assert.equal(fs.statSync(path.join(dir, '.credentials.json')).mode & 0o777, 0o600);
  }
});

test('plugins installed in one account are listed in all, pointing at the same install', () => {
  const h = home();
  shareAccountSetup(h.paths);
  const listed = h.read(path.join(h.a, 'plugins', 'installed_plugins.json'));
  assert.equal(listed.plugins['figma@official'][0].installPath, path.join(h.claudeDir, 'plugins/cache/figma'));
});

test('a second run with nothing new writes nothing', () => {
  const h = home();
  shareAccountSetup(h.paths, () => {}, () => 1);
  const logs: string[] = [];
  shareAccountSetup(h.paths, (m) => logs.push(m), () => 2);
  assert.deepEqual(logs, []);
});

/** Found on the real machine: every MCP login was an empty stub from a sign-in never finished. */
test('logins: a real one beats an empty stub, and the newest real one wins', () => {
  const stub = { accessToken: '', serverUrl: 'https://mcp.sentry.dev/mcp' };
  const old = { accessToken: 'old-token' };
  const fresh = { accessToken: 'fresh-token' };
  assert.deepEqual(newestLogins([{ logins: { s: stub }, savedAt: 9 }, { logins: { s: old }, savedAt: 1 }]), { s: old });
  assert.deepEqual(newestLogins([{ logins: { s: old }, savedAt: 1 }, { logins: { s: fresh }, savedAt: 5 }]), { s: fresh });
  assert.deepEqual(newestLogins([{ logins: { s: fresh }, savedAt: 5 }, { logins: { s: old }, savedAt: 1 }]), { s: fresh });
});

test('signing in again in any account reaches all the others', () => {
  const h = home();
  shareAccountSetup(h.paths);
  // Signed in to Sentry afresh, in the home account, after sharing.
  const homeCreds = path.join(h.b, '.credentials.json');
  const c = h.read(homeCreds);
  c.mcpOAuth['sentry|1'] = { accessToken: 'brand-new' };
  fs.writeFileSync(homeCreds, JSON.stringify(c));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(homeCreds, later, later);
  shareAccountSetup(h.paths);
  for (const d of [h.claudeDir, h.a]) assert.equal(h.read(path.join(d, '.credentials.json')).mcpOAuth['sentry|1'].accessToken, 'brand-new');
});
