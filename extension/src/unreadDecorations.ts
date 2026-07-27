import * as vscode from 'vscode';

export const DECORATION_SCHEME = 'claude-persist';

export const sessionUri = (id: string): vscode.Uri =>
  vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/session/${id}` });

// Raw cwd as path — vscode.Uri percent-encodes on serialization; pre-encoding would double-encode.
export const workspaceUri = (cwd: string): vscode.Uri =>
  vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/workspace/${cwd}` });

/**
 * Paints the red unread dot on sidebar items via their resourceUri.
 * Tree items cannot overlay icons; a FileDecoration badge is the native way.
 */
export class UnreadDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** uri.toString() of every item currently carrying the dot. */
  private unread = new Set<string>();

  /** Replace the decorated set and repaint. */
  update(uris: vscode.Uri[]): void {
    this.unread = new Set(uris.map((u) => u.toString()));
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME || !this.unread.has(uri.toString())) {
      return undefined;
    }
    return new vscode.FileDecoration(
      '●',
      'Unread activity',
      new vscode.ThemeColor('charts.red'),
    );
  }
}
