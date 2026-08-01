import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionInfo } from '@claude-persist/shared';
import { DaemonClient } from './daemonClient';
import { ChatPanelManager, VIEW_TYPE } from './chatPanel';
import { SessionsProvider } from './sessionsView';
import { sessionTitleFromInput } from './sessionTitle';

let client: DaemonClient | null = null;
let panels: ChatPanelManager;
let sessionsProvider: SessionsProvider;
let statusItem: vscode.StatusBarItem;
let reconnectTimer: NodeJS.Timeout | undefined;
let connecting: Promise<DaemonClient> | null = null;

/** Background reconnect with backoff after a daemon disconnect. */
function scheduleReconnect(context: vscode.ExtensionContext, delayMs = 1000): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    ensureClient(context).catch(() =>
      scheduleReconnect(context, Math.min(delayMs * 2, 15000)),
    );
  }, delayMs);
}

function resolveDaemonEntry(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('claudePersist').get<string>('daemonEntry');
  if (configured) return configured;
  // Monorepo dev layout: <repo>/extension and <repo>/daemon side by side.
  const candidates = [
    path.join(context.extensionPath, '..', 'daemon', 'dist', 'main.js'),
    path.join(context.extensionPath, 'daemon', 'dist', 'main.js'), // bundled into the .vsix
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

async function ensureClient(context: vscode.ExtensionContext): Promise<DaemonClient> {
  if (client?.connected) return client;
  if (connecting) return connecting; // collapse concurrent connect attempts
  connecting = doConnect(context).finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doConnect(context: vscode.ExtensionContext): Promise<DaemonClient> {
  const fresh = new DaemonClient(resolveDaemonEntry(context), {
    onEvent: (sessionId, event) => panels.handleEvent(sessionId, event),
    onDelta: (sessionId, text) => panels.handleDelta(sessionId, text),
    onSessionsChanged: () => sessionsProvider.refresh(),
    onModels: (models) => panels.handleModels(models),
    onDisconnect: () => {
      client = null;
      statusItem.text = '$(debug-disconnect) Claude Persist';
      statusItem.tooltip = 'Daemon disconnected — reconnecting…';
      sessionsProvider.refresh();
      scheduleReconnect(context);
    },
  });
  await fresh.connect();
  client = fresh;
  statusItem.text = '$(sparkle) Claude Persist';
  statusItem.tooltip = 'Connected to claude-persist daemon';
  sessionsProvider.refresh();
  await panels.reattachAll();
  return fresh;
}

async function pickCwd(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri.fsPath;
  if (folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick();
    return picked?.uri.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Select working directory for the Claude session',
  });
  return picked?.[0]?.fsPath;
}

/**
 * Apply claudePersist.defaultModel to a freshly created/imported session, so
 * new chats start on the model you want instead of the account default.
 */
async function applyDefaultModel(c: DaemonClient, info: SessionInfo): Promise<SessionInfo> {
  const model = vscode.workspace
    .getConfiguration('claudePersist')
    .get<string>('defaultModel', '')
    .trim();
  if (!model) return info;
  try {
    await c.setSessionOptions(info.id, { model });
    return { ...info, model };
  } catch {
    return info; // non-fatal: the session still works on the account default
  }
}

async function pickSession(c: DaemonClient): Promise<SessionInfo | undefined> {
  const sessions = await c.listSessions();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('No Claude Persist sessions yet — create one first.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({
      label: s.title,
      description: s.status === 'running' ? '$(sync~spin) running' : s.status,
      detail: s.cwd,
      session: s,
    })),
    { title: 'Open Claude session' },
  );
  return picked?.session;
}

export function activate(context: vscode.ExtensionContext): void {
  sessionsProvider = new SessionsProvider(() => client, context.globalState);
  panels = new ChatPanelManager(
    context,
    () => client,
    () => ensureClient(context),
    (sessionId) => sessionsProvider.markSeen(sessionId),
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudePersist.sessions', sessionsProvider),
    vscode.window.registerFileDecorationProvider(sessionsProvider.decorations),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(sparkle) Claude Persist';
  statusItem.command = 'claudePersist.openSession';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePersist.newSession', async () => {
      try {
        const c = await ensureClient(context);
        const cwd = await pickCwd();
        if (!cwd) return;
        const base = path.basename(cwd);
        const seed = `${base}-`;
        const raw = await vscode.window.showInputBox({
          title: 'Session title',
          value: seed,
          // Caret after the dash, nothing selected — so typing appends.
          valueSelection: [seed.length, seed.length],
        });
        // With a prefilled value, dismissing the box means "cancel", not
        // "use the default name".
        if (raw === undefined) return;
        const info = await applyDefaultModel(
          c,
          await c.createSession(cwd, sessionTitleFromInput(raw, base) || undefined),
        );
        await panels.openSession(info);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('claudePersist.openSession', async () => {
      try {
        const c = await ensureClient(context);
        const session = await pickSession(c);
        if (session) await panels.openSession(session);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('claudePersist.deleteSession', async () => {
      try {
        const c = await ensureClient(context);
        const session = await pickSession(c);
        if (!session) return;
        const confirmed = await vscode.window.showWarningMessage(
          `Delete session "${session.title}" and its history?`,
          { modal: true },
          'Delete',
        );
        if (confirmed === 'Delete') await c.deleteSession(session.id);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      'claudePersist.renameSession',
      async (item?: SessionInfo) => {
        try {
          const c = await ensureClient(context);
          const session = item ?? (await pickSession(c));
          if (!session) return;
          const title = await vscode.window.showInputBox({
            title: 'Rename session',
            value: session.title,
            validateInput: (v) => (v.trim() ? undefined : 'Title cannot be empty'),
          });
          if (!title?.trim()) return;
          await c.renameSession(session.id, title.trim());
          panels.setTitle(session.id, title.trim());
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand('claudePersist.importSession', async () => {
      try {
        const c = await ensureClient(context);
        const candidates = await c.listClaudeSessions();
        if (candidates.length === 0) {
          void vscode.window.showInformationMessage(
            'No Claude Code sessions found under ~/.claude/projects.',
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(
          candidates.map((s) => ({
            label: s.title,
            description: new Date(s.mtimeMs).toLocaleString(),
            detail: s.cwd,
            candidate: s,
          })),
          { title: 'Import Claude Code session', matchOnDetail: true },
        );
        if (!picked) return;
        const info = await applyDefaultModel(c, await c.importClaudeSession(picked.candidate.file));
        await panels.openSession(info);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('claudePersist.refreshSessions', async () => {
      try {
        await ensureClient(context);
      } catch {
        // stay silent — the view's emptiness is the signal
      }
      sessionsProvider.refresh();
    }),

    vscode.commands.registerCommand(
      'claudePersist.openSessionFromTree',
      async (session: SessionInfo) => {
        try {
          await ensureClient(context);
          await panels.openSession(session);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      'claudePersist.deleteSessionItem',
      async (session: SessionInfo) => {
        try {
          const c = await ensureClient(context);
          const confirmed = await vscode.window.showWarningMessage(
            `Delete session "${session.title}" and its history?`,
            { modal: true },
            'Delete',
          );
          if (confirmed === 'Delete') await c.deleteSession(session.id);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),
  );

  // Restore chat tabs after a window reload (including browser refresh in
  // code-server). The panel state carries the sessionId; the webview replays
  // its transcript from the daemon on 'ready'.
  vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    deserializeWebviewPanel: async (panel, state: { sessionId?: string } | undefined) => {
      const sessionId = state?.sessionId;
      if (!sessionId) {
        panel.dispose();
        return;
      }
      panels.bindPanel(panel, sessionId);
      try {
        await ensureClient(context);
      } catch {
        // Daemon not reachable yet; panel will attach on next action.
      }
    },
  });

  // Re-push the model dropdown when the user edits extraModels.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePersist.extraModels')) panels.refreshModels();
      if (e.affectsConfiguration('claudePersist.connectionIndicator')) {
        panels.refreshConnectionIndicator();
      }
    }),
  );

  // Connect eagerly so restored panels attach right after reload; don't spawn
  // errors at the user on startup if the daemon isn't built yet.
  void ensureClient(context).catch(() => undefined);
}

export function deactivate(): void {
  client?.dispose();
}
