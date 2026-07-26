import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = 'jagajaga/claude-persist';
const SKIP_KEY = 'claudePersist.skipVersion';

interface Release {
  tag_name: string;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function getJson(url: string): Promise<Release> {
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
              resolve(JSON.parse(body) as Release);
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

/** Compare "a.b.c" semver-ish strings; returns true if `remote` > `local`. */
function isNewer(remote: string, local: string): boolean {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const l = local.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

/**
 * Sideloaded VSIX installs don't auto-update, so on startup we check the
 * latest GitHub release and offer a one-click update (download + install).
 */
export async function checkForUpdate(context: vscode.ExtensionContext, interactive = false): Promise<void> {
  const current = context.extension.packageJSON.version as string;
  let release: Release;
  try {
    release = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch {
    if (interactive) void vscode.window.showWarningMessage('Claude Persist: could not check for updates.');
    return;
  }
  const latest = release.tag_name;
  if (!isNewer(latest, current)) {
    if (interactive) void vscode.window.showInformationMessage(`Claude Persist is up to date (${current}).`);
    return;
  }
  if (!interactive && context.globalState.get<string>(SKIP_KEY) === latest) return;

  const asset = release.assets.find((a) => a.name.endsWith('.vsix'));
  const actions = asset ? ['Update now', 'View release', 'Skip'] : ['View release', 'Skip'];
  const choice = await vscode.window.showInformationMessage(
    `Claude Persist ${latest} is available (you have ${current}).`,
    ...actions,
  );
  if (choice === 'View release') {
    void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  } else if (choice === 'Skip') {
    await context.globalState.update(SKIP_KEY, latest);
  } else if (choice === 'Update now' && asset) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading Claude Persist ${latest}…` },
      async () => {
        const tmp = path.join(os.tmpdir(), asset.name);
        await download(asset.browser_download_url, tmp);
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          vscode.Uri.file(tmp),
        );
      },
    );
    const reload = await vscode.window.showInformationMessage(
      `Claude Persist ${latest} installed. Reload to activate.`,
      'Reload window',
    );
    if (reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
