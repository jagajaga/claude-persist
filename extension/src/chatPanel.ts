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
  <main id="messages"></main>
  <footer id="composer">
    <div id="status-line" hidden><span class="spinner"></span><span id="status-text">Working…</span>
      <button id="stop">Stop</button></div>
    <div id="input-row">
      <textarea id="input" rows="1" placeholder="Message Claude… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send" title="Send">➤</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
