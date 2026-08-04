import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Directories a chat webview is allowed to load images from.
 *
 * No `vscode` import here so it can be unit tested directly, the same reason
 * rateLimits.ts stays separate.
 *
 * Deliberately not all of `/`: only the places chat images realistically live.
 */
export function resourceRootPaths(uploadsDir: string, workspaceFolders: string[] = []): string[] {
  const out = new Set<string>();
  for (const base of [uploadsDir, os.homedir(), os.tmpdir(), ...workspaceFolders]) {
    if (!base) continue;
    out.add(path.normalize(base));
    // Both spellings. A workspace reached through a symlink (code-server's
    // /home/coder/code-workspace -> /home/jaga/code-workspace) hands us paths in
    // the resolved form, which would otherwise fall outside every root and be
    // refused with no visible reason — the same trap that broke transcript
    // lookup for symlinked and worktree cwds.
    try {
      out.add(fs.realpathSync(base));
    } catch {
      // base does not exist; the literal form is still worth allowing
    }
  }
  return [...out];
}
