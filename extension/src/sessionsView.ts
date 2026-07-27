import * as path from 'path';
import * as vscode from 'vscode';
import type { SessionInfo } from '@claude-persist/shared';
import type { DaemonClient } from './daemonClient';
import {
  groupSessions,
  isUnread,
  isWorkspaceGroup,
  reconcileSeen,
} from './sessionsModel';
import type { SeenMap, TreeNode, WorkspaceGroup } from './sessionsModel';
import {
  sessionUri,
  UnreadDecorationProvider,
  workspaceUri,
} from './unreadDecorations';

const SEEN_KEY = 'claudePersist.seenActivity';

/**
 * Activity-bar tree: workspace groups (by session cwd) containing sessions.
 * Current workspace pinned first and expanded; groups and sessions ordered
 * by last activity desc. Unread sessions (turn completed while the tab was
 * not visible) carry a red dot, propagated to their group.
 */
export class SessionsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly decorations = new UnreadDecorationProvider();
  /** Last listSessions snapshot, for markSeen lookups. */
  private snapshot: SessionInfo[] = [];

  constructor(
    private readonly client: () => DaemonClient | null,
    private readonly state: vscode.Memento,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  /** The user is looking at this session — record it and clear its dot. */
  markSeen(sessionId: string): void {
    const session = this.snapshot.find((s) => s.id === sessionId);
    const seen: SeenMap = { ...this.seen() };
    const wasUnread = session ? isUnread(session, seen) : false;
    seen[sessionId] = Math.max(session?.lastActivityAt ?? 0, Date.now());
    void this.state.update(SEEN_KEY, seen);
    if (wasUnread) this.refresh();
  }

  private seen(): SeenMap {
    return this.state.get<SeenMap>(SEEN_KEY, {});
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return isWorkspaceGroup(node) ? this.groupItem(node) : this.sessionItem(node);
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node) return isWorkspaceGroup(node) ? node.sessions : [];
    const client = this.client();
    if (!client?.connected) return [];
    let sessions: SessionInfo[];
    try {
      sessions = await client.listSessions();
    } catch {
      return [];
    }
    this.snapshot = sessions;
    let seen = this.seen();
    const reconciled = reconcileSeen(sessions, seen);
    if (reconciled) {
      seen = reconciled;
      void this.state.update(SEEN_KEY, reconciled);
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.fsPath,
    );
    const groups = groupSessions(sessions, folders, seen);
    this.decorations.update([
      ...groups.filter((g) => g.hasUnread).map((g) => workspaceUri(g.cwd)),
      ...sessions.filter((s) => isUnread(s, seen)).map((s) => sessionUri(s.id)),
    ]);
    return groups;
  }

  private groupItem(group: WorkspaceGroup): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(group.cwd) || group.cwd,
      group.isCurrent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = group.cwd; // stable — VS Code remembers manual expand/collapse
    item.description = String(group.sessions.length);
    item.tooltip = group.cwd;
    item.iconPath = new vscode.ThemeIcon(group.isCurrent ? 'root-folder' : 'folder');
    item.contextValue = 'claudeWorkspaceGroup';
    item.resourceUri = workspaceUri(group.cwd);
    return item;
  }

  private sessionItem(session: SessionInfo): vscode.TreeItem {
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
    item.resourceUri = sessionUri(session.id);
    item.command = {
      command: 'claudePersist.openSessionFromTree',
      title: 'Open Session',
      arguments: [session],
    };
    return item;
  }
}
