import * as vscode from 'vscode';
import type { PersistedEvent, SessionInfo } from '@claude-persist/shared';
import type { DaemonClient } from './daemonClient';

export const VIEW_TYPE = 'claudePersist.chat';

interface PanelEntry {
  panel: vscode.WebviewPanel;
  sessionId: string;
  lastSeq: number;
  ready: boolean;
  queue: unknown[];
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
    this.post(entry, { type: 'event', event });
  }

  handleDelta(sessionId: string, text: string): void {
    const entry = this.panels.get(sessionId);
    if (entry) this.post(entry, { type: 'delta', text });
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
    const entry: PanelEntry = { panel, sessionId, lastSeq: 0, ready: false, queue: [] };
    this.panels.set(sessionId, entry);
    panel.webview.html = this.html(panel.webview, sessionId);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
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
            await client.sendMessage(sessionId, String(msg.text ?? ''));
            break;
          case 'interrupt':
            await client.interrupt(sessionId);
            break;
          case 'permission':
            await client.permission(
              sessionId,
              String(msg.requestId),
              msg.allow === true,
              typeof msg.message === 'string' ? msg.message : undefined,
            );
            break;
          case 'setPermissionMode':
            await client.setPermissionMode(
              sessionId,
              msg.mode as 'default' | 'bypassPermissions',
            );
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

  /** Re-attach every open panel — used after the daemon connection is (re)established. */
  async reattachAll(): Promise<void> {
    for (const entry of this.panels.values()) {
      if (entry.ready) await this.attach(entry).catch(() => undefined);
    }
  }

  private async attach(entry: PanelEntry): Promise<void> {
    const client = this.client();
    if (!client) return;
    const result = await client.attach(entry.sessionId, entry.lastSeq);
    entry.panel.title = result.info.title;
    if (result.events.length > 0) {
      entry.lastSeq = result.events[result.events.length - 1].seq + 1;
    }
    this.post(entry, {
      type: 'replay',
      info: result.info,
      events: result.events,
      fromSeq: entry.lastSeq,
    });
  }

  private post(entry: PanelEntry, message: unknown): void {
    if (entry.ready) void entry.panel.webview.postMessage(message);
    else entry.queue.push(message);
  }

  private html(webview: vscode.Webview, sessionId: string): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
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
  <main id="messages"><div id="thread"></div></main>
  <footer id="composer">
    <div id="status-line" hidden>
      <span class="spinner"></span><span id="status-text">Working…</span>
      <button id="stop" class="pill">Stop</button>
    </div>
    <div id="input-box">
      <textarea id="input" rows="1" placeholder="Message Claude…"></textarea>
      <div id="composer-row">
        <button id="attach" class="icon-btn" title="Attachments — coming soon" disabled>+</button>
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
