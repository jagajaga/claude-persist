import * as vscode from 'vscode';
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
import { chipLabel, findGitDir, formatBranch, heldWorktrees, readBranch } from './gitBranch';

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
/** Matches the daemon's default; "Load earlier" multiplies it. */
const REPLAY_LIMIT = 400;

/** Whether the panel should flag a broken connection at all. */
function connectionIndicatorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('claudePersist')
    .get<boolean>('connectionIndicator', true);
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

  handleEvent(sessionId: string, event: PersistedEvent): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    entry.lastSeq = Math.max(entry.lastSeq, event.seq + 1);
    // Reflect the working state in the editor tab title, so it's visible
    // even when the tab is not focused.
    if (event.event.type === 'status') {
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
    for (const entry of this.panels.values()) {
      this.post(entry, { type: 'accounts', accounts });
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
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.bindPanel(panel, info.id, info.title);
  }

  /** Called both for fresh panels and for panels restored by the serializer. */
  bindPanel(panel: vscode.WebviewPanel, sessionId: string, title?: string): void {
    if (title) panel.title = title;
    const entry: PanelEntry = {
      panel,
      sessionId,
      lastSeq: 0,
      ready: false,
      queue: [],
      baseTitle: title ?? panel.title,
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
          entry.pendingAttachments.push({
            kind: 'image',
            name: up.name,
            mediaType: up.mediaType,
            data,
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
        const name = await vscode.window.showInputBox({
          title: 'Log in to another account',
          prompt: 'Name for this account (used as its config folder name)',
          placeHolder: 'work',
          validateInput: (value) =>
            /^[a-z0-9-]+$/.test(value) ? undefined : 'Use lowercase letters, digits, and hyphens only',
        });
        if (!name) return;
        const configDir = path.join(os.homedir(), '.claude-accounts', name);
        const bundledClaudeBin = path.join(
          this.context.extensionPath,
          'daemon',
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk-linux-x64',
          'claude',
        );
        const claudeBin = fs.existsSync(bundledClaudeBin) ? bundledClaudeBin : 'claude';
        const terminal = vscode.window.createTerminal({ name: `Claude login: ${name}` });
        terminal.sendText(`CLAUDE_CONFIG_DIR=${configDir} ${claudeBin} /login`);
        terminal.show();
        void vscode.window.showInformationMessage(
          'After logging in, pick the account from the model menu.',
        );
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
              await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
            } catch {
              void vscode.window.showWarningMessage(`Claude Persist: cannot open ${abs}`);
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
    // Read from git's registry, not from remembered hook events: worktrees
    // created before this daemon started are just as real as ones created after.
    const held = info ? heldWorktrees(info) : [];
    const chip = info
      ? chipLabel(
          formatBranch(readBranch(info)),
          info.isWorktree ? path.basename(info.root) : null,
          held,
        )
      : null;
    // fs.watch fires several times per write; posting unconditionally spams
    // the channel and re-renders the composer for nothing.
    const key = `${chip?.text ?? ''}|${chip?.worktree ?? false}`;
    if (entry.branchKey === key) return;
    entry.branchKey = key;
    this.post(entry, {
      type: 'branch',
      name: chip?.text ?? null,
      worktree: chip?.worktree ?? false,
      held,
      path: cwd,
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
    if (entry.ready) void entry.panel.webview.postMessage(message);
    else entry.queue.push(message);
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
