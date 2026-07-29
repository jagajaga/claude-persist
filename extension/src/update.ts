import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ReleaseInfo } from '@claude-persist/shared';
import { isNewerVersion, parseRelease } from './release';

const REPO = 'jagajaga/claude-persist';
const SKIP_KEY = 'claudePersist.skipVersion';

/**
 * Tag currently being offered. The daemon re-pushes the latest release on every
 * reconnect, and the periodic check still runs — without this, an unanswered
 * notification would stack a duplicate every time.
 */
let offering: string | null = null;

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { 'User-Agent': 'claude-persist', Accept: 'application/vnd.github+json' } },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
            getJson(res.headers.location).then(resolve, reject);
            return;
          }
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on('error', reject);
  });
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u: string): void => {
      https
        .get(u, { headers: { 'User-Agent': 'claude-persist' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
            go(res.headers.location);
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        })
        .on('error', (e) => {
          fs.unlink(dest, () => reject(e));
        });
    };
    go(url);
  });
}

/**
 * Offer a release the daemon just told us about. This is the fast path: the
 * daemon polls GitHub once for every window and pushes, so the prompt appears
 * within a minute of publication without the window having to reload.
 */
export async function notifyRelease(
  context: vscode.ExtensionContext,
  release: ReleaseInfo,
): Promise<void> {
  const current = context.extension.packageJSON.version as string;
  if (!isNewerVersion(release.tagName, current)) return;
  if (context.globalState.get<string>(SKIP_KEY) === release.tagName) return;
  await offerUpdate(context, release, current);
}

/**
 * Sideloaded VSIX installs don't auto-update. This is the fallback path — used
 * at activation, on the manual command, and on a slow timer — for when the
 * daemon is unreachable or is running a build that predates release pushes.
 */
export async function checkForUpdate(
  context: vscode.ExtensionContext,
  interactive = false,
): Promise<void> {
  const current = context.extension.packageJSON.version as string;
  let release: ReleaseInfo | null;
  try {
    release = parseRelease(await getJson(`https://api.github.com/repos/${REPO}/releases/latest`));
  } catch {
    release = null;
  }
  if (!release) {
    if (interactive) {
      void vscode.window.showWarningMessage('Claude Persist: could not check for updates.');
    }
    return;
  }
  if (!isNewerVersion(release.tagName, current)) {
    if (interactive) {
      void vscode.window.showInformationMessage(`Claude Persist is up to date (${current}).`);
    }
    return;
  }
  // An explicit "check for updates" re-offers a version you previously skipped;
  // a background check honours the skip.
  if (!interactive && context.globalState.get<string>(SKIP_KEY) === release.tagName) return;
  await offerUpdate(context, release, current);
}

async function offerUpdate(
  context: vscode.ExtensionContext,
  release: ReleaseInfo,
  current: string,
): Promise<void> {
  if (offering === release.tagName) return; // a prompt for this tag is already up
  offering = release.tagName;
  try {
    const actions = release.vsixUrl
      ? ['Update now', 'View release', 'Skip']
      : ['View release', 'Skip'];
    const choice = await vscode.window.showInformationMessage(
      `Claude Persist ${release.tagName} is available (you have ${current}).`,
      ...actions,
    );
    if (choice === 'View release') {
      if (release.htmlUrl) void vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
    } else if (choice === 'Skip') {
      await context.globalState.update(SKIP_KEY, release.tagName);
    } else if (choice === 'Update now' && release.vsixUrl) {
      const url = release.vsixUrl;
      const name = release.vsixName ?? 'claude-persist.vsix';
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading Claude Persist ${release.tagName}…`,
        },
        async () => {
          const tmp = path.join(os.tmpdir(), name);
          await download(url, tmp);
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            vscode.Uri.file(tmp),
          );
        },
      );
      const reload = await vscode.window.showInformationMessage(
        `Claude Persist ${release.tagName} installed. Reload to activate.`,
        'Reload window',
      );
      if (reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } finally {
    offering = null;
  }
}
