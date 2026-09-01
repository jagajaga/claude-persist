import * as vscode from 'vscode';
import { formatAccountUsage } from './rateLimits';
import { resourceRootPaths } from './resourceRoots';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AccountInfo,
  Attachment,
  ModelDescriptor,
  PersistedEvent,
  SessionInfo,
} from '@claude-persist/shared';
import type { DaemonClient } from './daemonClient';
import { mergeExtraModels } from './models';
import { chipLabel, findGitDir, registeredWorktrees, workPlaces } from './gitBranch';
import { dirsInUseBySession } from './activeDirs';

export const VIEW_TYPE = 'claudePersist.chat';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MIMES = new Set(Object.values(IMAGE_TYPES));
const uploadsDir = path.join(os.homedir(), '.claude-persist', 'uploads');

/** Extensions we will render a preview for. */
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
/** Absolute POSIX-ish paths inside chat text, e.g. /home/me/shot.png */
const PATH_IN_TEXT = /(?:^|[\s"'`(\[<])(\/[^\s"'`)\]>:]+\.[A-Za-z0-9]+)/g;
/** Don't inline a huge file as a preview. */
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;

/**
 * Absolute image paths mentioned anywhere in a payload.
 *
 * Covers both attachment refs and paths that merely appear in message text or a
 * tool result, because "here's the screenshot at /tmp/x.png" should preview too.
 */
function collectImagePaths(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (path.isAbsolute(value) && PREVIEWABLE.test(value)) into.add(value);
    for (const m of value.matchAll(PATH_IN_TEXT)) {
      if (PREVIEWABLE.test(m[1])) into.add(m[1]);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectImagePaths(v, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectImagePaths(v, into);
  }
  return into;
}
/** Matches the daemon's default; "Load earlier" multiplies it. */
const REPLAY_LIMIT = 400;

/**
 * Where the webview may load images from. Images referenced in a chat live
 * wherever the user put them, so this spans the workspace, home, temp and our
 * own uploads — but not all of `/`, which would let any rendered path be read.
 */
function resourceRoots(): vscode.Uri[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return resourceRootPaths(uploadsDir, folders).map((p) => vscode.Uri.file(p));
}

/** Whether the panel should flag a broken connection at all. */
function connectionIndicatorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('claudePersist')
    .get<boolean>('connectionIndicator', true);
}

/** Persist an upload beside the session; returns null if it can't be written. */
function saveUpload(sessionId: string, name: string, bytes: Buffer): string | null {
  try {
    const dir = path.join(uploadsDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name.replace(/[/\\]/g, '_')}`);
    fs.writeFileSync(file, bytes);
    return file;
  } catch {
    return null; // preview is a nicety; never fail the send over it
  }
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  sessionId: string;
  lastSeq: number;
  ready: boolean;
  queue: unknown[];
  cwd?: string;
  /** Watches this session's own .git/HEAD so the branch chip tracks its cwd. */
  branchWatcher?: fs.FSWatcher;
  /** Last value pushed to the webview, so repeated fs events post once. */
  branchKey?: string;
  /**
   * Worktrees seen in use since this turn began. An agent between two commands
   * has no process in its worktree for that instant; without this the list
   * would blink entries in and out while it works.
   */
  worktreesThisTurn: Set<string>;
  /** Watches the worktree registry, so held worktrees update live. */
  registryWatcher?: fs.FSWatcher;
  /** How many events this panel asks for; grows when the user loads earlier. */
  replayLimit: number;
  baseTitle: string;
  pendingAttachments: Attachment[];
  /** In-flight chunked uploads from the browser, keyed by uploadId. */
  uploads: Map<string, { name: string; mediaType: string; total: number; chunks: string[] }>;
}

/**
 * One webview panel (a native editor tab) per session. Panels are disposable:
 * on window reload the serializer re-creates them and we re-attach to the
 * daemon with the last seen seq, replaying whatever happened while detached.
 */
export class ChatPanelManager {
  private panels = new Map<string, PanelEntry>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: () => DaemonClient | null,
    /** Connects (or reconnects) to the daemon; used when client() is null. */
    private readonly ensure?: () => Promise<DaemonClient>,
    /** Called whenever the user is looking at a session's chat tab. */
    private readonly onViewed?: (sessionId: string) => void,
  ) {}

  /** Current client, or connect on demand — never silently null for actions. */
  private async requireClient(): Promise<DaemonClient | null> {
    const existing = this.client();
    if (existing?.connected) return existing;
    if (!this.ensure) return null;
    try {
      return await this.ensure();
    } catch {
      return null;
    }
  }

  /** How many subagents this session has working; drives the composer chip. */
  handleAgents(sessionId: string, agents: Array<{ id: string; description: string }>): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    this.post(entry, { type: 'agents', agents });
  }

  handleEvent(sessionId: string, event: PersistedEvent): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    entry.lastSeq = Math.max(entry.lastSeq, event.seq + 1);
    // Reflect the working state in the editor tab title, so it's visible
    // even when the tab is not focused.
    if (event.event.type === 'status') {
      // A finished turn releases its worktrees: keeping them would turn the
      // list into everywhere this chat has ever worked.
      if (event.event.status !== 'running') {
        entry.worktreesThisTurn.clear();
        entry.branchKey = undefined;
        this.updateBranch(entry);
      }
      entry.panel.title =
        (event.event.status === 'running' ? '⧗ ' : '') + entry.baseTitle;
      if (entry.panel.visible) this.onViewed?.(sessionId);
    }
    this.post(entry, { type: 'event', event });
  }

  handleDelta(sessionId: string, text: string): void {
    const entry = this.panels.get(sessionId);
    if (entry) this.post(entry, { type: 'delta', text });
  }

  handleModels(models: ModelDescriptor[]): void {
    this.lastModels = models;
    const merged = this.mergedModels();
    for (const entry of this.panels.values()) {
      this.post(entry, { type: 'models', models: merged });
    }
  }

  /** Last SDK-probed model list, before extraModels merging. */
  private lastModels: ModelDescriptor[] = [];

  /** Broadcast from the daemon whenever the active/known accounts change. */
  handleAccounts(accounts: AccountInfo[]): void {
    this.lastAccounts = accounts;
    // Formatted here rather than in the webview so the picker and the status
    // bar cannot disagree about which window is closest or how it reads.
    const now = Date.now();
    const withUsage = accounts.map((account) => ({
      ...account,
      usageLabel: formatAccountUsage(account.lastUsage ?? null, now, account.active),
    }));
    for (const entry of this.panels.values()) {
      this.post(entry, { type: 'accounts', accounts: withUsage });
    }
  }

  /** Last known account list, account-wide like the model list. */
  private lastAccounts: AccountInfo[] = [];

  private mergedModels(): ModelDescriptor[] {
    const extras = vscode.workspace
      .getConfiguration('claudePersist')
      .get<string[]>('extraModels', []);
    return mergeExtraModels(this.lastModels, extras);
  }

  /** Tell every panel whether to flag a broken connection. */
  refreshConnectionIndicator(): void {
    const enabled = connectionIndicatorEnabled();
    for (const entry of this.panels.values()) {
      this.post(entry, { type: 'connectionIndicator', enabled });
    }
  }

  /** Re-push the model list to open panels (after extraModels changes). */
  refreshModels(): void {
    if (this.lastModels.length === 0) return;
    const models = this.mergedModels();
    for (const entry of this.panels.values()) {
      this.post(entry, { type: 'models', models });
    }
  }

  /**
   * Sign in, from the Command Palette.
   *
   * The login card has to live inside a webview — see addAccountInteractively
   * for why the code box cannot be a QuickInput — so this needs a panel. A user
   * who has never used this extension has none, and telling them "open a chat
   * first, then find the model pill" is exactly the dead end this command
   * exists to remove. So: use an open panel if there is one, otherwise open the
   * most recent session, and only ask them to create one if there are none.
   */
  async addAccountFromCommand(sessions: SessionInfo[]): Promise<void> {
    const open = [...this.panels.values()].find((entry) => entry.panel.visible)
      ?? [...this.panels.values()][0];
    if (open) {
      open.panel.reveal();
      await this.addAccountInteractively(open);
      return;
    }
    const newest = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (!newest) {
      void vscode.window.showInformationMessage(
        'Claude Persist: create a session first — sign-in happens inside a chat panel.',
      );
      return;
    }
    await this.openSession(newest);
    const entry = this.panels.get(newest.id);
    if (entry) await this.addAccountInteractively(entry);
  }

  async openSession(info: SessionInfo): Promise<void> {
    const existing = this.panels.get(info.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      info.title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: resourceRoots() },
    );
    this.bindPanel(panel, info.id, info.title);
  }

  /** Called both for fresh panels and for panels restored by the serializer. */
  bindPanel(panel: vscode.WebviewPanel, sessionId: string, title?: string): void {
    if (title) panel.title = title;
    // Set here, not only at creation: this method also runs for panels restored
    // by the serializer, which keep whatever options they were serialized with.
    // Since surviving a reload is this extension's whole point, nearly every
    // panel is a restored one — so setting localResourceRoots only in
    // createWebviewPanel left image previews blocked for essentially everyone.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots(),
    };
    const entry: PanelEntry = {
      panel,
      sessionId,
      lastSeq: 0,
      ready: false,
      queue: [],
      baseTitle: title ?? panel.title,
      worktreesThisTurn: new Set<string>(),
      pendingAttachments: [],
      uploads: new Map(),
      replayLimit: REPLAY_LIMIT,
    };
    this.panels.set(sessionId, entry);
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) this.onViewed?.(sessionId);
    });
    if (panel.visible) this.onViewed?.(sessionId);
    panel.webview.html = this.html(panel.webview, sessionId);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.type === 'clientError') {
        void vscode.window.showErrorMessage(`Claude Persist webview error: ${String(msg.message)}`);
        return;
      }
      if (msg.type === 'notify') {
        void vscode.window.showWarningMessage(`Claude Persist: ${String(msg.message)}`);
        return;
      }
      // Chunked upload from the user's device (browser). Chunks are acked
      // individually so the webview can show real delivery progress on slow
      // connections. Images become vision blocks, anything else is written
      // server-side and attached as a path.
      if (msg.type === 'uploadBegin') {
        entry.uploads.set(String(msg.uploadId), {
          name: String(msg.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file',
          mediaType: String(msg.mediaType || 'application/octet-stream'),
          total: Math.max(1, Number(msg.chunks) || 1),
          chunks: [],
        });
        return;
      }
      if (msg.type === 'uploadChunk') {
        const uploadId = String(msg.uploadId);
        const up = entry.uploads.get(uploadId);
        if (!up) return;
        const index = Number(msg.index);
        up.chunks[index] = String(msg.data || '');
        const received = up.chunks.filter((c) => c !== undefined).length;
        this.post(entry, { type: 'uploadAck', uploadId, received, total: up.total });
        if (received < up.total) return;
        entry.uploads.delete(uploadId);
        const data = up.chunks.join('');
        const bytes = Buffer.from(data, 'base64');
        if (IMAGE_MIMES.has(up.mediaType) && bytes.byteLength <= MAX_IMAGE_BYTES) {
          // Save a copy too: the base64 goes to the model but is never
          // persisted, so without a file on disk the thumbnail would vanish on
          // the next reload.
          const savedPath = saveUpload(sessionId, up.name, bytes);
          entry.pendingAttachments.push({
            kind: 'image',
            name: up.name,
            mediaType: up.mediaType,
            data,
            ...(savedPath ? { path: savedPath } : {}),
          });
        } else {
          const dir = path.join(uploadsDir, sessionId);
          fs.mkdirSync(dir, { recursive: true });
          const filePath = path.join(dir, `${Date.now()}-${up.name}`);
          fs.writeFileSync(filePath, bytes);
          entry.pendingAttachments.push({ kind: 'file', path: filePath });
        }
        this.postChips(entry);
        return;
      }
      // 'ready' must never be dropped: mark the panel ready even with no
      // daemon connection yet, so reattachAll() finds it after connect.
      if (msg.type === 'ping') {
        // Answer immediately, before any daemon work: the round trip is what
        // proves the browser <-> code-server hop is alive, and the payload
        // carries the second hop's state so one probe covers both.
        this.post(entry, {
          type: 'pong',
          daemon: this.client()?.connected === true,
          indicator: connectionIndicatorEnabled(),
        });
        return;
      }
      if (msg.type === 'addAccount') {
        // A name means "this account's login has lapsed, renew it": there is
        // nothing to choose and nothing to name, so skip straight to the code.
        await this.addAccountInteractively(entry, typeof msg.account === 'string' ? msg.account : undefined);
        return;
      }
      if (msg.type === 'loginCode') {
        const client = await this.requireClient();
        if (!client) return;
        const result = await client
          .submitLoginCode(String(msg.loginId ?? ''), String(msg.code ?? ''))
          .catch((err: unknown) => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        this.post(entry, { type: 'loginResult', ...result });
        return;
      }
      if (msg.type === 'openExternal') {
        const url = String(msg.url ?? '');
        if (url.startsWith('https://')) await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      if (msg.type === 'stopAgent') {
        const client = await this.requireClient();
        if (!client) return;
        const result = await client
          .stopAgent(entry.sessionId, String(msg.taskId ?? ''))
          .catch((err: unknown) => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        if (!result.ok && result.error) {
          void vscode.window.showWarningMessage(`Could not stop that subagent: ${result.error}`);
        }
        return;
      }
      if (msg.type === 'loginCancel') {
        const client = await this.requireClient();
        void client?.cancelLogin(String(msg.loginId ?? '')).catch(() => undefined);
        return;
      }
      if (msg.type === 'switchTab') {
        // A webview cannot move between editor tabs itself; the host can.
        await vscode.commands.executeCommand(
          msg.direction === 'previous'
            ? 'workbench.action.previousEditor'
            : 'workbench.action.nextEditor',
        );
        return;
      }
      if (msg.type === 'loadEarlier') {
        // Each click reaches four times further back. No hard ceiling: past a
        // few clicks the user has explicitly asked for the whole transcript.
        entry.replayLimit *= 4;
        if (await this.requireClient()) {
          await this.attach(entry, { full: true }).catch(() => undefined);
        }
        return;
      }
      if (msg.type === 'ready') {
        entry.ready = true;
        for (const queued of entry.queue.splice(0)) void panel.webview.postMessage(queued);
        if (await this.requireClient()) {
          await this.attach(entry).catch(() => undefined);
        }
        return;
      }
      const client = await this.requireClient();
      if (!client) {
        void vscode.window.showWarningMessage(
          'Claude Persist: daemon not reachable yet — reconnecting in the background, try again in a moment.',
        );
        return;
      }
      try {
        switch (msg.type) {
          case 'send':
            await client.sendMessage(sessionId, String(msg.text ?? ''), entry.pendingAttachments);
            entry.pendingAttachments = [];
            this.post(entry, { type: 'attachments', items: [] });
            break;
          case 'pickAttachment': {
            const uris = await vscode.window.showOpenDialog({
              canSelectMany: true,
              openLabel: 'Attach',
              defaultUri: entry.cwd ? vscode.Uri.file(entry.cwd) : undefined,
            });
            for (const uri of uris ?? []) {
              const ext = path.extname(uri.fsPath).toLowerCase();
              const mediaType = IMAGE_TYPES[ext];
              if (mediaType) {
                const bytes = fs.readFileSync(uri.fsPath);
                if (bytes.byteLength > MAX_IMAGE_BYTES) {
                  void vscode.window.showWarningMessage(
                    `${path.basename(uri.fsPath)} is over 5 MB — attached as a path instead.`,
                  );
                  entry.pendingAttachments.push({ kind: 'file', path: uri.fsPath });
                } else {
                  entry.pendingAttachments.push({
                    kind: 'image',
                    name: path.basename(uri.fsPath),
                    mediaType,
                    data: bytes.toString('base64'),
                  });
                }
              } else {
                entry.pendingAttachments.push({ kind: 'file', path: uri.fsPath });
              }
            }
            this.postChips(entry);
            break;
          }
          case 'removeAttachment': {
            const index = Number(msg.index);
            if (Number.isInteger(index)) entry.pendingAttachments.splice(index, 1);
            this.postChips(entry);
            break;
          }
          case 'openFile': {
            const raw = String(msg.path ?? '');
            if (!raw) break;
            const abs = path.isAbsolute(raw)
              ? raw
              : path.join(entry.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', raw);
            try {
              // vscode.open picks the right editor for the file type; images and
              // other binaries are not text documents and showTextDocument
              // rejects them outright ("cannot open /tmp/shot.png").
              await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs), {
                preview: true,
              });
            } catch {
              try {
                await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
              } catch {
                void vscode.window.showWarningMessage(`Claude Persist: cannot open ${abs}`);
              }
            }
            break;
          }
          case 'interrupt':
            await client.interrupt(sessionId);
            break;
          case 'compact':
            await client.sendMessage(sessionId, '/compact');
            break;
          case 'permission':
            await client.permission(
              sessionId,
              String(msg.requestId),
              msg.allow === true,
              typeof msg.message === 'string' ? msg.message : undefined,
              msg.answers && typeof msg.answers === 'object'
                ? (msg.answers as Record<string, string>)
                : undefined,
            );
            break;
          case 'setPermissionMode':
            await client.setPermissionMode(
              sessionId,
              msg.mode as 'default' | 'bypassPermissions',
            );
            break;
          case 'setOptions':
            await client.setSessionOptions(sessionId, {
              ...(msg.model !== undefined
                ? { model: (msg.model as string) || null }
                : {}),
              ...(msg.effort !== undefined
                ? { effort: ((msg.effort as string) ||
                    null) as import('@claude-persist/shared').EffortLevel | null }
                : {}),
            });
            break;
          case 'setAccount': {
            const configDir = typeof msg.configDir === 'string' ? msg.configDir : null;
            const accounts = await client.setAccount(configDir);
            this.handleAccounts(accounts);
            break;
          }
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    panel.onDidDispose(() => {
      const dying = this.panels.get(sessionId);
      dying?.branchWatcher?.close();
      dying?.registryWatcher?.close();
      this.panels.delete(sessionId);
      void this.client()?.detach(sessionId).catch(() => undefined);
    });
  }

  /** Update an open panel's tab title after a rename. */
  setTitle(sessionId: string, title: string): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    const running = entry.panel.title.startsWith('⧗');
    entry.baseTitle = title;
    entry.panel.title = (running ? '⧗ ' : '') + title;
  }

  /** Re-attach every open panel — used after the daemon connection is (re)established. */
  async reattachAll(): Promise<void> {
    for (const entry of this.panels.values()) {
      if (entry.ready) await this.attach(entry).catch(() => undefined);
    }
  }

  /**
   * Sign in to a new account without a terminal.
   *
   * The daemon drives the CLI with piped stdio, which is what selects the
   * hosted-callback flow: the TTY path starts a loopback callback server and
   * redirects to localhost, which is simply wrong under code-server, where the
   * browser is on the user's machine and the CLI is on the server. So the user
   * gets a link and a box to paste the code into, and never sees a shell.
   */
  /**
   * Start a sign-in for one named account and hand the code box to the panel.
   *
   * Shared by adding an account and renewing one whose login has lapsed: both
   * are the same exchange, and the second has nothing left to ask.
   */
  private async startLoginFor(entry: PanelEntry, name: string): Promise<void> {
    const client = await this.requireClient();
    if (!client) {
      void vscode.window.showWarningMessage('Claude Persist: daemon not reachable — try again in a moment.');
      return;
    }
    let login: { loginId: string; url: string };
    try {
      login = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Preparing sign-in for "${name}"…` },
        () => client.startLogin(name),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not start sign-in: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // openExternal goes through the remote's port/URI forwarding, so it opens on
    // the machine the user is actually sitting at.
    await vscode.env.openExternal(vscode.Uri.parse(login.url));
    // The code box lives in the panel rather than a QuickInput. VS Code binds
    // Ctrl+V in its own inputs to a command that reads the clipboard through
    // navigator.clipboard.readText(), which Firefox does not grant to web pages
    // — so under code-server the paste silently did nothing and only
    // Ctrl+Shift+V (the browser's native paste) worked. Inside a webview the
    // keystroke is handled by the browser, exactly as it already is for pasting
    // images into the composer.
    this.post(entry, { type: 'loginPrompt', loginId: login.loginId, name, url: login.url });
  }

  private async addAccountInteractively(entry: PanelEntry, renew?: string): Promise<void> {
    // A pick, not a name prompt. Sign-in could only ever create a *named*
    // account, so on a machine with no Claude Code login the one account the UI
    // lists first — "default" — could never be filled in, and the user had to
    // invent a name for what was really their only login.
    // Renewing a known account asks nothing: the account is already named, and
    // signing back into it writes to the same directory it always used.
    if (renew) {
      await this.startLoginFor(entry, renew);
      return;
    }
    const DEFAULT_CHOICE = 'Default account  (~/.claude)';
    const choice = await vscode.window.showQuickPick(
      [
        { label: DEFAULT_CHOICE, detail: 'The account Claude Code itself uses on this machine' },
        { label: 'New named account…', detail: 'A separate login, kept under ~/.claude-accounts' },
      ],
      { title: 'Sign in to Claude', placeHolder: 'Which account?' },
    );
    if (!choice) return;

    let name = 'default';
    if (choice.label !== DEFAULT_CHOICE) {
      const typed = await vscode.window.showInputBox({
        title: 'Sign in to Claude',
        prompt: 'Name for this account (used as its config folder name)',
        placeHolder: 'work',
        validateInput: (value) =>
          value === 'default'
            ? 'Pick "Default account" instead'
            : /^[a-z0-9-]+$/.test(value)
              ? undefined
              : 'Use lowercase letters, digits, and hyphens only',
      });
      if (!typed) return;
      name = typed;
    }

    await this.startLoginFor(entry, name);
  }

  private postChips(entry: PanelEntry): void {
    this.post(entry, {
      type: 'attachments',
      items: entry.pendingAttachments.map((a) => ({
        kind: a.kind,
        label: a.kind === 'image' ? a.name : path.basename(a.path),
      })),
    });
  }

  private async attach(entry: PanelEntry, opts?: { full?: boolean }): Promise<void> {
    const client = this.client();
    if (!client) return;
    // A full re-read replaces the transcript in the webview; an incremental
    // re-attach after a reconnect must only append what was missed.
    const full = opts?.full === true || entry.lastSeq === 0;
    const result = await client.attach(
      entry.sessionId,
      full ? 0 : entry.lastSeq,
      entry.replayLimit,
    );
    entry.baseTitle = result.info.title;
    entry.panel.title =
      (result.info.status === 'running' ? '⧗ ' : '') + result.info.title;
    entry.cwd = result.info.cwd;
    // A reattach means the webview was re-created and lost its chip; force a
    // fresh post by clearing the dedupe key.
    entry.branchKey = undefined;
    this.watchBranch(entry);
    this.updateBranch(entry);
    if (result.events.length > 0) {
      entry.lastSeq = result.events[result.events.length - 1].seq + 1;
    }
    this.post(entry, {
      type: 'replay',
      info: result.info,
      events: result.events,
      fromSeq: entry.lastSeq,
      // Tells the webview to clear first, so a widened window doesn't
      // duplicate what is already rendered.
      reset: full,
      hasEarlier: result.hasEarlier === true,
    });
    // Model list is account-wide; fetch lazily and push to this panel.
    void client
      .listModels()
      .then((models) => {
        this.lastModels = models;
        this.post(entry, { type: 'models', models: this.mergedModels() });
      })
      .catch(() => undefined);
    // Same for the account list — fetched lazily rather than on every push.
    void client
      .listAccounts()
      .then((accounts) => {
        this.lastAccounts = accounts;
        this.post(entry, { type: 'accounts', accounts });
      })
      .catch(() => undefined);
  }

  /** Push this session's branch to its webview, but only when it changed. */
  private updateBranch(entry: PanelEntry): void {
    const cwd = entry.cwd;
    if (!cwd) return;
    const info = findGitDir(cwd);
      // Which worktrees this conversation is using is a question about
      // processes, not about git: the registry says a checkout exists, not that
      // anyone is in it. Sticky for the length of a turn, because an agent
      // between two commands has no process in its worktree for that moment and
      // must not vanish from the list and come back.
      const registered = info ? registeredWorktrees(info) : [];
      // Attributed, not merely occupied. Every session in a repository used to
      // list every other session's worktrees, because "someone is working here"
      // cannot tell two conversations apart. The daemon stamps its session id
      // onto the CLI it launches, so the processes inside a worktree say whose
      // it is; a worktree nobody claims is left to the session that is in it.
      const owners = dirsInUseBySession(registered.map((w) => w.path));
      for (const [dir, sessions] of owners) {
        // Strictly this session's. An untagged worktree -- a terminal someone
        // opened there, or work from a daemon older than the tag -- is somebody
        // else's business; showing it to everyone is the bug being fixed, and
        // showing it to nobody is merely a smaller list.
        if (sessions.has(entry.sessionId)) entry.worktreesThisTurn.add(dir);
      }
      const places = info ? workPlaces(info, cwd, entry.worktreesThisTurn) : [];
      const chip = chipLabel(places);
      // The list is part of the key: a subagent taking another worktree may
      // leave the chip's text alone, and the panel still has to hear about it.
      const key = [
        chip?.text ?? '',
        String(chip?.worktree ?? false),
        ...places.map((place) => `${place.name}@${place.branch ?? ''}`),
      ].join('|');
      if (entry.branchKey === key) return;
      entry.branchKey = key;
      this.post(entry, {
        type: 'branch',
        name: chip?.text ?? null,
        worktree: chip?.worktree ?? false,
        path: cwd,
        places,
      });
  }

  /**
   * Watch the HEAD of the session's *own* git dir — a worktree has its own, so
   * the chip follows that directory rather than the window's repository.
   */
  private watchBranch(entry: PanelEntry): void {
    entry.branchWatcher?.close();
    entry.branchWatcher = undefined;
    entry.registryWatcher?.close();
    entry.registryWatcher = undefined;
    const cwd = entry.cwd;
    if (!cwd) return;
    const info = findGitDir(cwd);
    if (!info) return;
    try {
      // The registry directory appears and disappears as worktrees come and go,
      // so watch the git dir itself rather than a path that may not exist yet.
      const registry = fs.watch(info.commonDir, () => {
        if (this.panels.get(entry.sessionId) === entry) this.updateBranch(entry);
      });
      registry.on('error', () => undefined);
      entry.registryWatcher = registry;
      const watcher = fs.watch(info.headFile, (eventType) => {
        if (this.panels.get(entry.sessionId) !== entry) return; // panel is gone
        this.updateBranch(entry);
        // git often replaces HEAD instead of writing in place, which kills the
        // watch; re-establish it so the chip keeps updating.
        if (eventType === 'rename') {
          setTimeout(() => {
            if (this.panels.get(entry.sessionId) === entry) this.watchBranch(entry);
          }, 50);
        }
      });
      watcher.on('error', () => undefined); // non-fatal: chip just stops updating
      entry.branchWatcher = watcher;
    } catch {
      // Same: the chip keeps its attach-time value.
    }
  }

  private post(entry: PanelEntry, message: unknown): void {
    const enriched = this.withImageUris(entry, message);
    if (entry.ready) void entry.panel.webview.postMessage(enriched);
    else entry.queue.push(enriched);
  }

  /**
   * Attach a path -> webview-URI map for any previewable image in this message.
   *
   * Done here rather than at each call site because a missed site would break
   * previews only on replay — i.e. only after a reload, the case users actually
   * hit. The webview cannot build these URIs itself (asWebviewUri is host-side),
   * and only paths that exist and are within a permitted root get an entry, so
   * the renderer can treat "present in the map" as "safe to show".
   */
  private withImageUris(entry: PanelEntry, message: unknown): unknown {
    if (!message || typeof message !== 'object') return message;
    const paths = collectImagePaths(message);
    if (paths.size === 0) return message;
    const imageUris: Record<string, string> = {};
    for (const p of paths) {
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) continue;
        imageUris[p] = entry.panel.webview.asWebviewUri(vscode.Uri.file(p)).toString();
      } catch {
        // not readable from here (or gone) — simply no preview
      }
    }
    if (Object.keys(imageUris).length === 0) return message;
    return { ...(message as Record<string, unknown>), imageUris };
  }

  private html(webview: vscode.Webview, sessionId: string): string {
    // All CSS/JS is inlined: external webview resources go through
    // code-server's client-side service worker, which proved flaky on mobile
    // (blank, unstyled panels when it goes stale). Inline content cannot fail
    // to load. Verified: none of these files contain "</script>".
    const media = (...parts: string[]): string =>
      fs.readFileSync(path.join(this.context.extensionPath, 'media', ...parts), 'utf8');
    const inlineCss = media('chat.css');
    const inlineJs = [
      media('vendor', 'marked.js'),
      media('vendor', 'purify.min.js'),
      media('streamingMarkdown.js'),
      media('chat.js'),
    ];
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">${inlineCss}</style>
  <title>Claude</title>
</head>
<body data-session-id="${sessionId}">
  <div id="prompt-bar" title="Jump to where this exchange started" hidden></div>
  <main id="messages"><div id="thread"></div></main>
  <div id="pinned" hidden></div>
  <footer id="composer">
    <div id="input-box">
      <div id="chips" hidden></div>
      <textarea id="input" rows="1" placeholder="Message Claude…"></textarea>
      <div id="composer-row">
        <button id="attach" class="icon-btn" title="Attach files">+</button>
        <button id="model-pill" class="pill" title="Model and reasoning effort">
          <span id="model-pill-label">default</span>
        </button>
        <button id="context-ring" class="ring-btn" title="Context usage" hidden>
          <svg viewBox="0 0 20 20" width="18" height="18">
            <circle class="ring-bg" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5"/>
            <circle class="ring-fg" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5"
                    stroke-dasharray="47.1" stroke-dashoffset="47.1"
                    transform="rotate(-90 10 10)"/>
          </svg>
        </button>
        <span id="branch-chip" class="branch-chip" hidden></span>
        <span class="flex-spacer"></span>
        <button id="agents-chip" class="agents-chip" hidden title="Subagents working">
          <span class="agents-dot"></span><span id="agents-count">0</span>
        </button>
        <button id="perm-toggle" class="pill" title="Toggle bypass permissions">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 1 2.5 3v4.1c0 3.3 2.3 6.4 5.5 7.4 3.2-1 5.5-4.1 5.5-7.4V3L8 1zm0 1.6 4 1.5v3c0 2.6-1.7 5-4 5.9-2.3-.9-4-3.3-4-5.9v-3l4-1.5z"/></svg>
          <span>Bypass permissions</span>
        </button>
        <button id="send" class="send-btn" title="Send (Enter)">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 2.5 3 7.6l1 1 3.3-3.4V13.5h1.4V5.2L12 8.6l1-1L8 2.5z"/></svg>
        </button>
      </div>
    </div>
  </footer>
  ${inlineJs.map((code) => `<script nonce="${nonce}">${code}</script>`).join('\n  ')}
</body>
</html>`;
  }
}
