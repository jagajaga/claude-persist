import * as vscode from 'vscode';
import type { SessionInfo } from '@claude-persist/shared';
import type { DaemonClient } from './daemonClient';

/** Activity-bar tree listing all sessions known to the daemon. */
export class SessionsProvider implements vscode.TreeDataProvider<SessionInfo> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly client: () => DaemonClient | null) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(session: SessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.id = session.id;
    item.description = session.status === 'running' ? 'running…' : session.status;
    item.tooltip = new vscode.MarkdownString(
      `**${session.title}**\n\n${session.cwd}\n\nLast activity: ${new Date(session.lastActivityAt).toLocaleString()}`,
    );
    item.iconPath = new vscode.ThemeIcon(
      session.status === 'running' ? 'sync~spin' : 'comment-discussion',
    );
    item.contextValue = 'claudeSession';
    item.command = {
      command: 'claudePersist.openSessionFromTree',
      title: 'Open Session',
      arguments: [session],
    };
    return item;
  }

  async getChildren(element?: SessionInfo): Promise<SessionInfo[]> {
    if (element) return [];
    const client = this.client();
    if (!client?.connected) return [];
    try {
      return await client.listSessions();
    } catch {
      return [];
    }
  }
}
