// One setup for every account: MCP servers, plugins, settings and their logins.
//
// Each Claude account is its own CLAUDE_CONFIG_DIR, and Claude Code reads its
// MCP servers, plugins, hooks and permissions from there. Only CLAUDE.md and
// skills were shared, so the daemon rotating to another account silently lost
// the rest. Measured on the machine this was written on: Sentry was set up in
// one account of five, the Figma and superpowers plugins only in the default,
// hooks (including the dev-server reaper) in two.
//
// Not shared, ever: each account's own Claude login (claudeAiOauth,
// oauthAccount) and its history. claude.ai connectors (Gmail, Drive, Slack...)
// belong to the claude.ai account itself and can only be connected there.
import fs from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function uniq<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const key = JSON.stringify(x);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Settings from several accounts as one: hooks and permission lists joined,
 * plugin and marketplace maps combined, anything else taken from the first
 * that has it (the default account comes first).
 */
export function mergeSettings(all: Json[]): Json {
  const out: Json = {};
  for (const s of all) {
    for (const [key, value] of Object.entries(s)) {
      if (key === 'hooks' && isObj(value)) {
        const hooks = (out.hooks ??= {}) as Json;
        for (const [event, list] of Object.entries(value)) {
          if (Array.isArray(list)) hooks[event] = uniq([...((hooks[event] as unknown[]) ?? []), ...list]);
        }
      } else if (key === 'permissions' && isObj(value)) {
        const perms = (out.permissions ??= {}) as Json;
        for (const [k, v] of Object.entries(value)) {
          if (Array.isArray(v)) perms[k] = uniq([...((perms[k] as unknown[]) ?? []), ...v]);
          else if (!(k in perms)) perms[k] = v;
        }
      } else if ((key === 'enabledPlugins' || key === 'extraKnownMarketplaces' || key === 'env') && isObj(value)) {
        out[key] = { ...value, ...((out[key] as Json) ?? {}) };
      } else if (!(key in out)) {
        out[key] = value;
      }
    }
  }
  return out;
}

/** Maps joined by key, the first holder of a key winning. */
export function unionByKey(maps: Array<Json | undefined>): Json {
  const out: Json = {};
  for (const m of maps) if (isObj(m)) for (const [k, v] of Object.entries(m)) if (!(k in out)) out[k] = v;
  return out;
}

function readJson(file: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: Json, mode?: number): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** Write only when the content actually changes: nothing is touched on a run with nothing to do. */
function writeIfChanged(file: string, before: Json | null, after: Json, mode?: number): boolean {
  if (before && JSON.stringify(before) === JSON.stringify(after)) return false;
  writeJson(file, after, mode);
  return true;
}

export interface SetupPaths {
  /** ~/.claude */
  claudeDir: string;
  /** The default account's .claude.json, which lives beside ~/.claude, not in it. */
  defaultClaudeJson: string;
  /** ~/.claude-accounts */
  accountsDir: string;
}

export function shareAccountSetup(p: SetupPaths, log: (m: string) => void = () => {}, now: () => number = Date.now): void {
  let names: string[];
  try {
    names = fs.readdirSync(p.accountsDir).filter((n) => {
      try {
        return fs.statSync(path.join(p.accountsDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return; // no named accounts: nothing to share with
  }
  const dirs = names.map((n) => path.join(p.accountsDir, n));
  shareSettings(p, dirs, names, log, now);
  sharePlugins(p, dirs, log);
  shareMcp(p, dirs, log);
}

/**
 * settings.json: every account's merged into the default's, then each account's
 * made a link to it. Claude Code replaces a settings file when it saves one, so
 * a link can come back a real file -- the next run merges it in again.
 */
function shareSettings(p: SetupPaths, dirs: string[], names: string[], log: (m: string) => void, now: () => number): void {
  const main = path.join(p.claudeDir, 'settings.json');
  const own = dirs.map((d) => {
    const file = path.join(d, 'settings.json');
    try {
      return fs.lstatSync(file).isSymbolicLink() ? null : readJson(file);
    } catch {
      return null;
    }
  });
  if (own.some((s) => s !== null)) {
    const before = readJson(main);
    const merged = mergeSettings([before ?? {}, ...own.filter((s): s is Json => s !== null)]);
    fs.mkdirSync(p.claudeDir, { recursive: true });
    writeIfChanged(main, before, merged);
    own.forEach((s, i) => {
      if (s === null) return;
      const file = path.join(dirs[i], 'settings.json');
      fs.renameSync(file, `${file}.before-shared-${now()}`);
      log(`account ${names[i]}: settings merged into the shared ones (old copy kept)`);
    });
  }
  if (!fs.existsSync(main)) return;
  for (const d of dirs) {
    const link = path.join(d, 'settings.json');
    let real: string | null = null;
    try {
      real = fs.realpathSync(link);
    } catch {
      // absent or broken
    }
    if (real === fs.realpathSync(main)) continue;
    try {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(main, link);
    } catch {
      // read-only, or a race with another daemon: the next run tries again
    }
  }
}

/** The installed-plugin and marketplace lists, joined: each entry points at where the plugin is installed. */
function sharePlugins(p: SetupPaths, dirs: string[], log: (m: string) => void): void {
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const all = [p.claudeDir, ...dirs].map((d) => ({ file: path.join(d, 'plugins', file), json: readJson(path.join(d, 'plugins', file)) }));
    const present = all.filter((a) => a.json !== null);
    if (present.length === 0) continue;
    const isInstalled = file === 'installed_plugins.json';
    const union = isInstalled
      ? unionByKey(present.map((a) => a.json!.plugins as Json | undefined))
      : unionByKey(present.map((a) => a.json!));
    for (const a of all) {
      if (a.json === null && !fs.existsSync(path.dirname(a.file))) continue;
      const after = isInstalled ? { ...(a.json ?? { version: 2 }), plugins: union } : union;
      if (writeIfChanged(a.file, a.json, after)) log(`plugins: ${path.relative(path.dirname(p.claudeDir), a.file)} now lists every account's`);
    }
  }
}

/**
 * MCP servers (user scope, in .claude.json) and their logins (mcpOAuth, in
 * .credentials.json): joined into every account. Those files also hold each
 * account's own Claude login and history, so only these keys are written.
 */
function shareMcp(p: SetupPaths, dirs: string[], log: (m: string) => void): void {
  const configs = [p.defaultClaudeJson, ...dirs.map((d) => path.join(d, '.claude.json'))];
  const read = configs.map((f) => ({ file: f, json: readJson(f) }));
  const servers = unionByKey(read.map((r) => r.json?.mcpServers as Json | undefined));
  if (Object.keys(servers).length > 0) {
    for (const r of read) {
      if (!r.json) continue;
      if (writeIfChanged(r.file, r.json, { ...r.json, mcpServers: servers })) log(`mcp: ${path.basename(path.dirname(r.file))} has every account's MCP servers`);
    }
  }
  const creds = [p.claudeDir, ...dirs].map((d) => ({ file: path.join(d, '.credentials.json'), json: readJson(path.join(d, '.credentials.json')) }));
  const tokens = unionByKey(creds.map((c) => c.json?.mcpOAuth as Json | undefined));
  if (Object.keys(tokens).length === 0) return;
  for (const c of creds) {
    if (!c.json) continue; // an account never logged in: nothing of its own to keep beside them
    if (writeIfChanged(c.file, c.json, { ...c.json, mcpOAuth: tokens }, 0o600)) log(`mcp: ${path.basename(path.dirname(c.file))} has every account's MCP logins`);
  }
}
