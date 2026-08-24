// Finding the `claude` binary that both the Agent SDK and the sign-in flow need.
//
// The vsix bundles exactly ONE platform package — a ~330 MB native binary — and
// CI packages on linux-x64, so everyone else downloads 105 MB of a binary their
// machine cannot run. The SDK's own resolution then fails with
//
//   Native CLI binary for linux-x64 not found. Reinstall
//   @anthropic-ai/claude-agent-sdk without --omit=optional, or set
//   options.pathToClaudeCodeExecutable.
//
// which tells a user nothing — and it fails even when they have Claude Code
// installed and on PATH, because nothing ever pointed the SDK at it.
//
// So: use a bundled binary only when it was built for this machine, and
// otherwise use the user's own install. A macOS or Windows or ARM user with
// Claude Code already installed then works, instead of hitting a Linux error
// message about optional dependencies.
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Everything about the machine this needs, injected so it can be tested. */
export interface ExecutableProbe {
  platform: string;
  arch: string;
  /** The bundled node_modules/@anthropic-ai directory, if there is one. */
  bundleDir: string | null;
  pathEntries: string[];
  home: string;
  isFile: (candidate: string) => boolean;
}

/** Executable names to try, per platform. */
export function binaryNames(platform: string): string[] {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
}

/**
 * The SDK's platform packages that could run here, best first.
 *
 * A glibc binary does not run on Alpine and vice versa, so musl leads on a musl
 * system. Unknown platform/arch pairs get an empty list rather than a guess:
 * a wrong binary fails later and more confusingly than no binary now.
 */
export function platformPackages(platform: string, arch: string, musl = false): string[] {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!cpu) return [];
  if (platform === 'linux') {
    const glibc = `claude-agent-sdk-linux-${cpu}`;
    const alpine = `claude-agent-sdk-linux-${cpu}-musl`;
    return musl ? [alpine, glibc] : [glibc, alpine];
  }
  if (platform === 'darwin') return [`claude-agent-sdk-darwin-${cpu}`];
  if (platform === 'win32') return cpu === 'x64' ? ['claude-agent-sdk-win32-x64'] : [];
  return [];
}

/** True when this Linux is musl-based (Alpine), where glibc binaries fail. */
export function detectMusl(isFile: (p: string) => boolean, platform: string): boolean {
  if (platform !== 'linux') return false;
  return ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1'].some(isFile);
}

/**
 * Where a `claude` installed by the user tends to live, for the case where PATH
 * is not inherited — a GUI-launched VS Code on macOS gets a login shell's PATH
 * only sometimes, which is a classic source of "works in my terminal" reports.
 */
export function wellKnownDirs(home: string): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

/**
 * The binary to run, or null when this machine has none.
 *
 * Null is a real answer and the caller must say so plainly — it is the whole
 * first-run experience for anyone not on the packaged platform.
 */
export function findClaudeExecutable(probe: ExecutableProbe): string | null {
  const names = binaryNames(probe.platform);
  if (probe.bundleDir) {
    const musl = detectMusl(probe.isFile, probe.platform);
    for (const pkg of platformPackages(probe.platform, probe.arch, musl)) {
      for (const name of names) {
        const candidate = path.join(probe.bundleDir, pkg, name);
        if (probe.isFile(candidate)) return candidate;
      }
    }
  }
  for (const dir of [...probe.pathEntries, ...wellKnownDirs(probe.home)]) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (probe.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** What to tell the user when there is nothing to run. */
export const NO_CLAUDE_MESSAGE =
  'Claude Code was not found on this machine. Install it from https://claude.com/download ' +
  '(or `npm i -g @anthropic-ai/claude-code`) and reload the window. ' +
  'The bundled copy only ships for the platform this extension was packaged for.';

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** The resolved binary for this process, computed once. */
let cached: string | null | undefined;

export function claudeExecutable(entry = process.argv[1] ?? ''): string | null {
  if (cached !== undefined) return cached;
  const bundleDir = entry
    ? path.join(path.dirname(entry), '..', 'node_modules', '@anthropic-ai')
    : null;
  cached = findClaudeExecutable({
    platform: process.platform,
    arch: process.arch,
    bundleDir,
    pathEntries: (process.env.PATH ?? '').split(path.delimiter),
    home: os.homedir(),
    isFile: isExecutableFile,
  });
  return cached;
}
