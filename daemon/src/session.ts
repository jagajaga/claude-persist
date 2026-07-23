import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment,
  ChatEvent,
  PersistedEvent,
  SessionStatus,
} from '@claude-persist/shared';
import type { SessionMeta } from './registry.js';
import { sessionLogPath } from './paths.js';

/**
 * Push-based AsyncIterable used as the SDK's streaming prompt input. The
 * query() loop pulls from it; sendMessage() pushes into it. It never ends on
 * its own — the session stays open across turns until close() is called.
 */
class InputQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface SessionCallbacks {
  onEvent(sessionId: string, event: PersistedEvent): void;
  onDelta(sessionId: string, text: string): void;
  onMetaChanged(): void;
}

/** Truncate long tool payloads before persisting/rendering. */
function summarize(value: unknown, max = 2000): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

export class DaemonSession {
  readonly meta: SessionMeta;
  status: SessionStatus = 'idle';
  private events: PersistedEvent[] = [];
  private input: InputQueue<unknown> | null = null;
  private activeQuery: ReturnType<typeof query> | null = null;
  private pendingPermissions = new Map<string, (allow: boolean, message?: string) => void>();
  private callbacks: SessionCallbacks;
  private logStream: fs.WriteStream | null = null;

  constructor(meta: SessionMeta, callbacks: SessionCallbacks) {
    this.meta = meta;
    this.callbacks = callbacks;
    this.loadLog();
  }

  get eventCount(): number {
    return this.events.length;
  }

  eventsSince(seq: number): PersistedEvent[] {
    return this.events.slice(Math.max(0, seq));
  }

  private loadLog(): void {
    try {
      const lines = fs.readFileSync(sessionLogPath(this.meta.id), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line) as PersistedEvent);
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // no log yet
    }
  }

  private appendEvent(event: ChatEvent): void {
    const persisted: PersistedEvent = { seq: this.events.length, ts: Date.now(), event };
    this.events.push(persisted);
    if (!this.logStream) {
      this.logStream = fs.createWriteStream(sessionLogPath(this.meta.id), { flags: 'a' });
    }
    this.logStream.write(`${JSON.stringify(persisted)}\n`);
    this.callbacks.onEvent(this.meta.id, persisted);
  }

  private setStatus(status: SessionStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.appendEvent({ type: 'status', status, detail });
  }

  sendMessage(text: string, attachments: Attachment[] = []): void {
    const labels = attachments.map((a) => ({
      kind: a.kind,
      label: a.kind === 'image' ? a.name : a.path,
    }));
    this.appendEvent({
      type: 'user_message',
      text,
      ...(labels.length ? { attachments: labels } : {}),
    });

    const content: unknown[] = [];
    for (const a of attachments) {
      if (a.kind === 'image') {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: a.mediaType, data: a.data },
        });
      }
    }
    const filePaths = attachments.filter((a) => a.kind === 'file') as Array<{ path: string }>;
    const fullText = filePaths.length
      ? `${text}\n\nAttached files (read them as needed):\n${filePaths.map((a) => a.path).join('\n')}`
      : text;
    content.push({ type: 'text', text: fullText });

    this.ensureQuery();
    this.input!.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.meta.sdkSessionId ?? '',
    });
    this.setStatus('running');
  }

  async interrupt(): Promise<void> {
    await this.activeQuery?.interrupt();
  }

  async setPermissionMode(mode: NonNullable<SessionMeta['permissionMode']>): Promise<void> {
    this.meta.permissionMode = mode;
    this.callbacks.onMetaChanged();
    // Bypass mode stops future canUseTool prompts; unblock any prompt that is
    // already waiting, otherwise the turn stays parked on a stale question.
    if (mode === 'bypassPermissions') {
      for (const requestId of [...this.pendingPermissions.keys()]) {
        this.resolvePermission(requestId, true);
      }
    }
    await this.activeQuery?.setPermissionMode(mode);
  }

  resolvePermission(requestId: string, allow: boolean, message?: string): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);
    this.appendEvent({ type: 'permission_resolved', requestId, allowed: allow });
    resolve(allow, message);
  }

  dispose(): void {
    this.input?.close();
    this.activeQuery = null;
    this.logStream?.end();
  }

  private ensureQuery(): void {
    if (this.activeQuery) return;
    this.input = new InputQueue();
    const q = query({
      // The SDK accepts an AsyncIterable of user messages for multi-turn
      // streaming input; the session stays alive between turns.
      prompt: this.input as AsyncIterable<never>,
      options: {
        cwd: this.meta.cwd,
        ...(this.meta.sdkSessionId ? { resume: this.meta.sdkSessionId } : {}),
        includePartialMessages: true,
        permissionMode: this.meta.permissionMode ?? 'default',
        canUseTool: this.canUseTool,
      },
    });
    this.activeQuery = q;
    void this.consume(q);
  }

  private canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
    const requestId = randomUUID();
    this.appendEvent({ type: 'permission_request', requestId, toolName, input });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, (allow, message) => {
        if (allow) resolve({ behavior: 'allow', updatedInput: input });
        else resolve({ behavior: 'deny', message: message ?? 'User denied this tool use.' });
      });
    });
  };

  private async consume(q: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const raw of q) {
        this.handleSdkMessage(raw as Record<string, unknown>);
      }
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    } finally {
      this.activeQuery = null;
      this.input = null;
    }
  }

  private handleSdkMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          if (this.meta.sdkSessionId !== msg.session_id) {
            this.meta.sdkSessionId = msg.session_id;
            this.callbacks.onMetaChanged();
          }
        }
        break;
      }
      case 'assistant': {
        const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            this.appendEvent({ type: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            this.appendEvent({
              type: 'tool_use',
              toolUseId: typeof block.id === 'string' ? block.id : undefined,
              toolName: String(block.name ?? 'tool'),
              input: block.input,
            });
          }
        }
        break;
      }
      case 'user': {
        // Tool results come back as user-role messages.
        const message = msg.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_result') {
              this.appendEvent({
                type: 'tool_result',
                toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
                summary: summarize(block.content, 1500),
                isError: block.is_error === true,
              });
            }
          }
        }
        break;
      }
      case 'stream_event': {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            this.callbacks.onDelta(this.meta.id, delta.text);
          }
        }
        break;
      }
      case 'result': {
        const summaryText =
          typeof msg.result === 'string' ? msg.result : `Turn finished (${String(msg.subtype ?? 'done')})`;
        const usage = msg.usage as Record<string, unknown> | undefined;
        const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
        const contextTokens = usage
          ? num(usage.input_tokens) +
            num(usage.cache_read_input_tokens) +
            num(usage.cache_creation_input_tokens) +
            num(usage.output_tokens)
          : undefined;
        this.appendEvent({
          type: 'result',
          summary: summarize(summaryText, 400),
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
          ...(contextTokens ? { contextTokens } : {}),
        });
        this.setStatus('idle');
        break;
      }
      default:
        break;
    }
  }
}
