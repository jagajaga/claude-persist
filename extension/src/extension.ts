import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { RateLimits, SessionInfo } from '@claude-persist/shared';
import { DaemonClient } from './daemonClient';
import { ChatPanelManager, VIEW_TYPE } from './chatPanel';
import { SessionsProvider } from './sessionsView';
import { sessionTitleFromInput } from './sessionTitle';
import {
  formatStatusBarFallback,
  formatStatusBarText,
  formatTooltip,
  pickNextLimit,
  severityFor,
  type Severity,
} from './rateLimits';

let client: DaemonClient | null = null;
let panels: ChatPanelManager;
let sessionsProvider: SessionsProvider;
let statusItem: vscode.StatusBarItem;
let reconnectTimer: NodeJS.Timeout | undefined;
let connecting: Promise<DaemonClient> | null = null;
/**
 * Account-wide, not per-session — the daemon broadcasts one shared snapshot
 * to every client (see the 'rateLimits' push in daemonClient.ts). Merged by the
 * daemon from two half-sources: the live rate_limit_event push (status, reset)
 * and the SDK's experimental usage call (utilization, subscription type).
 */
let latestRateLimits: RateLimits = {};
/** From the SDK usage call: 'pro' | 'max' | ... or null for API-key sessions. */
let latestSubscriptionType: string | null = null;

/** Whether a rate limit should move work to the next logged-in account. */
function switchAccountOnLimitSetting(): boolean {
  return vscode.workspace
    .getConfiguration('claudePersist')
    .get<boolean>('switchAccountOnLimit', true);
}

function severityColor(sev: Severity): vscode.ThemeColor | undefined {
  if (sev === 'error') return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (sev === 'warning') return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

/** Repaint the status bar item from latestRateLimits; connect/disconnect own their own text otherwise. */
function refreshRateLimitDisplay(): void {
  const next = pickNextLimit(latestRateLimits);
  // With no utilization anywhere, show whatever a window does report (its reset
  // or a non-'allowed' status) rather than the bare label, which read as "this
  // feature doesn't exist".
  statusItem.text = next
    ? formatStatusBarText(next)
    : formatStatusBarFallback(latestRateLimits, Date.now()) ?? formatStatusBarText(null);
  statusItem.tooltip = formatTooltip(latestRateLimits, latestSubscriptionType);
  statusItem.backgroundColor = severityColor(severityFor(next));
}

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
    onAgents: (sessionId, agents) => panels.handleAgents(sessionId, agents),
    onSessionsChanged: () => sessionsProvider.refresh(),
    onModels: (models) => panels.handleModels(models),
    onRateLimits: (usage) => {
      latestRateLimits = usage.windows;
      latestSubscriptionType = usage.subscriptionType;
      refreshRateLimitDisplay();
    },
    onAccounts: (accounts) => panels.handleAccounts(accounts),
    onDisconnect: () => {
      client = null;
      statusItem.text = '$(debug-disconnect) Claude Persist';
      statusItem.tooltip = 'Daemon disconnected — reconnecting…';
      statusItem.backgroundColor = undefined;
      sessionsProvider.refresh();
      scheduleReconnect(context);
    },
  });
  await fresh.connect();
  client = fresh;
  // The daemon has no access to VS Code settings, so anything it acts on has to
  // be pushed — on every connect, since a daemon that outlived this window (or
  // was started by another one) may never have been told.
  void fresh.setOptions({ switchAccountOnLimit: switchAccountOnLimitSetting() }).catch(() => undefined);
  refreshRateLimitDisplay();
  sessionsProvider.refresh();
  await panels.reattachAll();
  // Rate limits are account-wide and may already be known from before this
  // client connected (or reconnected); pull the daemon's current snapshot
  // instead of waiting for the next live push, mirroring how each chat panel
  // pulls listModels() on attach rather than relying on the broadcast alone.
  void fresh
    .listRateLimits()
    .then((usage) => {
      latestRateLimits = usage.windows;
      latestSubscriptionType = usage.subscriptionType;
      refreshRateLimitDisplay();
    })
    .catch(() => undefined);
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
      if (e.affectsConfiguration('claudePersist.switchAccountOnLimit')) {
        void client
          ?.setOptions({ switchAccountOnLimit: switchAccountOnLimitSetting() })
          .catch(() => undefined);
      }
    }),
  );

  // Connect eagerly so restored panels attach right after reload. A failure
  // here used to be swallowed outright, which made a failed daemon upgrade
  // look like the extension had simply stopped existing: no sidebar content,
  // no chat, and nothing anywhere saying why. Report it on the status bar
  // (non-modal, since "the daemon isn't built yet" is normal in dev) and
  // escalate to a notification only when the user has to act.
  void ensureClient(context).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    statusItem.text = '$(error) Claude Persist';
    statusItem.tooltip = `Could not connect to the daemon:\n${reason}`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    if (/protocol \d+ > \d+/.test(reason)) {
      void vscode.window
        .showWarningMessage(
          'A newer claude-persist daemon is running than this window supports. Reload the window to pick up the updated extension.',
          'Reload Window',
        )
        .then((choice) => {
          if (choice) void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    }
  });
}

export function deactivate(): void {
  client?.dispose();
}
