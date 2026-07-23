import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Attachment,
  ModelDescriptor,
  PersistedEvent,
  SessionInfo,
} from '@claude-persist/shared';
import type { DaemonClient } from './daemonClient';

export const VIEW_TYPE = 'claudePersist.chat';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface PanelEntry {
  panel: vscode.WebviewPanel;
  sessionId: string;
  lastSeq: number;
  ready: boolean;
  queue: unknown[];
  cwd?: string;
  baseTitle: string;
  pendingAttachments: Attachment[];
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
  ) {}

  handleEvent(sessionId: string, event: PersistedEvent): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    entry.lastSeq = Math.max(entry.lastSeq, event.seq + 1);
    // Reflect the working state in the editor tab title, so it's visible
    // even when the tab is not focused.
    if (event.event.type === 'status') {
      entry.panel.title =
        (event.event.status === 'running' ? '⏳ ' : '') + entry.baseTitle;
    }
    this.post(entry, { type: 'event', event });
  }

  handleDelta(sessionId: string, text: string): void {
    const entry = this.panels.get(sessionId);
    if (entry) this.post(entry, { type: 'delta', text });
  }

  handleModels(models: ModelDescriptor[]): void {
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
    };
    this.panels.set(sessionId, entry);
    panel.webview.html = this.html(panel.webview, sessionId);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.type === 'clientError') {
        void vscode.window.showErrorMessage(`Claude Persist webview error: ${String(msg.message)}`);
        return;
      }
      const client = this.client();
      if (!client) return;
      try {
        switch (msg.type) {
          case 'ready':
            entry.ready = true;
            for (const queued of entry.queue.splice(0)) void panel.webview.postMessage(queued);
            await this.attach(entry);
            break;
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
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    panel.onDidDispose(() => {
      this.panels.delete(sessionId);
      void this.client()?.detach(sessionId).catch(() => undefined);
    });
  }

  /** Update an open panel's tab title after a rename. */
  setTitle(sessionId: string, title: string): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    const running = entry.panel.title.startsWith('⏳');
    entry.baseTitle = title;
    entry.panel.title = (running ? '⏳ ' : '') + title;
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

  private async attach(entry: PanelEntry): Promise<void> {
    const client = this.client();
    if (!client) return;
    const result = await client.attach(entry.sessionId, entry.lastSeq);
    entry.baseTitle = result.info.title;
    entry.panel.title =
      (result.info.status === 'running' ? '⏳ ' : '') + result.info.title;
    entry.cwd = result.info.cwd;
    if (result.events.length > 0) {
      entry.lastSeq = result.events[result.events.length - 1].seq + 1;
    }
    this.post(entry, {
      type: 'replay',
      info: result.info,
      events: result.events,
      fromSeq: entry.lastSeq,
    });
    // Model list is account-wide; fetch lazily and push to this panel.
    void client
      .listModels()
      .then((models) => this.post(entry, { type: 'models', models }))
      .catch(() => undefined);
  }

  private post(entry: PanelEntry, message: unknown): void {
    if (entry.ready) void entry.panel.webview.postMessage(message);
    else entry.queue.push(message);
  }

  private html(webview: vscode.Webview, sessionId: string): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'marked.js'));
    const purifyUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'purify.min.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
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
        <select id="model-select" class="select-pill" title="Model">
          <option value="">model: default</option>
        </select>
        <select id="effort-select" class="select-pill" title="Reasoning effort — how smart / how long it thinks">
          <option value="">effort: default</option>
        </select>
        <button id="context-ring" class="ring-btn" title="Context usage" hidden>
          <svg viewBox="0 0 20 20" width="18" height="18">
            <circle class="ring-bg" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5"/>
            <circle class="ring-fg" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5"
                    stroke-dasharray="47.1" stroke-dashoffset="47.1"
                    transform="rotate(-90 10 10)"/>
          </svg>
        </button>
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
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${purifyUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
