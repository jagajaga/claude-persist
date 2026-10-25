// The Android app's newest release, fetched by this machine for the phone.
//
// The releases live in a private repository, which a phone cannot read
// without a GitHub login of its own. This machine has one (`gh`), so it asks,
// downloads the APK once, and the phone takes it from here through /file --
// behind the same login as everything else.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { baseDir } from './paths.js';

export const DEFAULT_APP_REPO = 'jagajaga/claude-persist-android';
export const appDir = path.join(baseDir, 'app');

export interface AppRelease {
  tag: string;
  /** "0.1.13" from "v0.1.13". */
  version: string;
  name: string;
  size: number;
  /** Set when the APK is on this machine, ready for /file. */
  path?: string;
}

type Run = (cmd: string, args: string[]) => Promise<string>;

const realRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((String(stderr).trim().split('\n')[0] || err.message).slice(0, 300)));
      else resolve(String(stdout));
    });
  });

export async function appRelease(
  opts: { download?: boolean; repo?: string; dir?: string },
  run: Run = realRun,
): Promise<AppRelease> {
  const repo = opts.repo ?? DEFAULT_APP_REPO;
  const raw = JSON.parse(await run('gh', ['release', 'view', '--repo', repo, '--json', 'tagName,assets'])) as {
    tagName: string;
    assets: Array<{ name: string; size: number }>;
  };
  const apk = raw.assets.find((a) => a.name.endsWith('.apk'));
  if (!apk) throw new Error(`release ${raw.tagName} has no APK`);
  if (!/^[\w.-]+$/.test(raw.tagName) || !/^[\w.-]+\.apk$/.test(apk.name)) throw new Error('unexpected release names');
  const release: AppRelease = { tag: raw.tagName, version: raw.tagName.replace(/^v/, ''), name: apk.name, size: apk.size };
  const dir = path.join(opts.dir ?? appDir, raw.tagName);
  const target = path.join(dir, apk.name);
  const have = fs.existsSync(target) && fs.statSync(target).size === apk.size;
  if (!have && opts.download) {
    fs.mkdirSync(dir, { recursive: true });
    await run('gh', ['release', 'download', raw.tagName, '--repo', repo, '--pattern', apk.name, '--dir', dir, '--clobber']);
    if (!fs.existsSync(target) || fs.statSync(target).size !== apk.size) throw new Error('download did not complete');
  }
  return fs.existsSync(target) && fs.statSync(target).size === apk.size ? { ...release, path: target } : release;
}
