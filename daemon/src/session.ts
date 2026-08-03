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
import { ROTATE_THRESHOLD, allLogFiles, loadTailAndCount, readRange, rotateActiveLog } from './logStore.js';
import { accountsStore, ensureSdkTranscript } from './accounts.js';

/**
 * Recent events kept resident per session. Larger than
 * DEFAULT_REPLAY_LIMIT (see main.ts) so a normal attach is served entirely
 * from memory; only a deliberate "load earlier" past this window touches
 * disk.
 */
const MAX_TAIL = 1000;

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
  /** Raw ModelInfo[] from the SDK init handshake. */
  onModels(models: unknown[]): void;
  /**
   * Raw SDKRateLimitInfo from a live `rate_limit_event` message. Account-wide,
   * not scoped to this session — see the comment on the 'rate_limit_event'
   * case in handleSdkMessage for why this is the only wired source.
   */
  onRateLimit(info: Record<string, unknown>): void;
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
  /** Newest events, oldest first, capped at MAX_TAIL — never the full transcript. */
  private tail: PersistedEvent[] = [];
  /** Total valid events ever appended (this session's next seq number). */
  private totalCount = 0;
  /** Valid events written to the *active* log file since it was last rotated. */
  private activeCount = 0;
  private input: InputQueue<unknown> | null = null;
  private activeQuery: ReturnType<typeof query> | null = null;
  private pendingPermissions = new Map<
    string,
    {
      isQuestion: boolean;
      settle: (allow: boolean, message?: string, answers?: Record<string, string>) => void;
    }
  >();
  private callbacks: SessionCallbacks;
  /**
   * A raw fd written synchronously, not a WriteStream: opening a stream is
   * asynchronous, so a rotation check running right after a write could
   * otherwise race the file's very creation. A sync fd makes "written" and
   * "exists on disk" the same moment, so rotateIfNeeded can never observe a
   * partially-open file. Volume here is interactive chat events, not a hot
   * loop, so the blocking write is not a concern.
   */
  private logFd: number | null = null;
  /** Usage of the most recent assistant API call — the true context size. */
  private lastCallUsage: Record<string, unknown> | null = null;

  constructor(meta: SessionMeta, callbacks: SessionCallbacks) {
    this.meta = meta;
    this.callbacks = callbacks;
    const { tail, count, perFile } = loadTailAndCount(allLogFiles(meta.id), MAX_TAIL);
    this.tail = tail;
    this.totalCount = count;
    this.activeCount = perFile[perFile.length - 1] ?? 0;
    // Catch up a pre-existing oversized active file (e.g. one that predates
    // this rotation policy) immediately, rather than waiting for its next
    // appended event.
    this.rotateIfNeeded();
  }

  get eventCount(): number {
    return this.totalCount;
  }

  /**
   * Events at or after `seq`, keeping only the newest `limit` (mirrors what
   * callers used to do themselves after fetching everything — pushed down
   * here so a request bounded to `limit` never has to materialize more).
   * `hasEarlier` tells the caller whether older events were cut off.
   */
  eventsSince(seq: number, limit: number): { events: PersistedEvent[]; hasEarlier: boolean } {
    const start = Math.max(0, seq);
    const total = this.totalCount;
    if (start >= total) return { events: [], hasEarlier: false };
    const effectiveStart = Math.max(start, total - limit);
    const hasEarlier = effectiveStart > start;
    const tailStart = total - this.tail.length;
    const events =
      effectiveStart >= tailStart
        ? this.tail.slice(effectiveStart - tailStart)
        : readRange(allLogFiles(this.meta.id), effectiveStart, total);
    return { events, hasEarlier };
  }

  /**
   * Move the active log file to a new archive generation once it has grown
   * past ROTATE_THRESHOLD events, so no single file this daemon ever reads or
   * writes can grow without bound. Nothing is deleted — the archive stays on
   * disk and stays readable via allLogFiles(); only the *active* file (the one
   * new events are appended to) resets to empty.
   */
  private rotateIfNeeded(): void {
    if (this.activeCount < ROTATE_THRESHOLD) return;
    if (this.logFd !== null) {
      fs.closeSync(this.logFd);
      this.logFd = null;
    }
    if (rotateActiveLog(this.meta.id)) this.activeCount = 0;
  }

  private appendEvent(event: ChatEvent): void {
    const persisted: PersistedEvent = { seq: this.totalCount, ts: Date.now(), event };
    this.totalCount++;
    this.tail.push(persisted);
    if (this.tail.length > MAX_TAIL) this.tail.shift();
    if (this.logFd === null) {
      this.logFd = fs.openSync(sessionLogPath(this.meta.id), 'a');
    }
    fs.writeSync(this.logFd, `${JSON.stringify(persisted)}\n`);
    this.activeCount++;
    this.callbacks.onEvent(this.meta.id, persisted);
    this.rotateIfNeeded();
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
      for (const [requestId, pending] of [...this.pendingPermissions.entries()]) {
        // Never auto-answer actual questions — only tool permissions.
        if (!pending.isQuestion) this.resolvePermission(requestId, true);
      }
    }
    try {
      await this.activeQuery?.setPermissionMode(mode);
    } catch (err) {
      // Surface instead of dying as an unhandled rejection; keep this.status
      // untouched — this is a mode-switch failure, not a session failure.
      this.appendEvent({
        type: 'status',
        status: this.status,
        detail: `Could not switch permission mode: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async setOptions(opts: {
    model?: string | null;
    effort?: NonNullable<SessionMeta['effort']> | null;
  }): Promise<void> {
    if (opts.model !== undefined) this.meta.model = opts.model ?? undefined;
    if (opts.effort !== undefined) this.meta.effort = opts.effort ?? undefined;
    this.callbacks.onMetaChanged();
    // Apply live to a running query; launch options cover the next one.
    try {
      if (this.activeQuery) {
        if (opts.model !== undefined) {
          await this.activeQuery.setModel(opts.model ?? undefined);
        }
        if (opts.effort !== undefined) {
          await this.activeQuery.applyFlagSettings({ effortLevel: opts.effort ?? null });
        }
      }
    } catch (err) {
      this.appendEvent({
        type: 'status',
        status: this.status,
        detail: `Could not apply model/effort: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  resolvePermission(
    requestId: string,
    allow: boolean,
    message?: string,
    answers?: Record<string, string>,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    this.appendEvent({
      type: 'permission_resolved',
      requestId,
      allowed: allow,
      ...(answers ? { answers } : {}),
    });
    pending.settle(allow, message, answers);
  }

  dispose(): void {
    this.input?.close();
    this.activeQuery = null;
    if (this.logFd !== null) {
      fs.closeSync(this.logFd);
      this.logFd = null;
    }
  }

  /**
   * Tear down the live query only — unlike dispose(), the session (its
   * transcript, log file, meta) stays fully alive. Used when the active
   * account changes: the next sendMessage() spawns a fresh query under the
   * new account's env and resumes the same sdkSessionId.
   */
  disposeActiveQuery(): void {
    this.input?.close();
    this.input = null;
    try {
      this.activeQuery?.close();
    } catch {
      // already closed/gone
    }
    this.activeQuery = null;
  }

  private ensureQuery(): void {
    if (this.activeQuery) return;
    // null = default account, env stays untouched (SDK falls back to ~/.claude).
    const activeAccountDir = accountsStore.active;
    if (activeAccountDir) {
      ensureSdkTranscript(
        this.meta.sdkSessionId,
        this.meta.cwd,
        activeAccountDir,
        accountsStore.allConcreteDirs(),
      );
    }
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
        ...(this.meta.model ? { model: this.meta.model } : {}),
        ...(this.meta.effort ? { effort: this.meta.effort } : {}),
        // Launch with the bypass *capability* so the mode can be toggled
        // mid-session; actual behavior is still governed by permissionMode.
        allowDangerouslySkipPermissions: true,
        canUseTool: this.canUseTool,
        // Don't replace the whole env — CLAUDE_CONFIG_DIR is the only thing
        // that changes between accounts.
        ...(activeAccountDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: activeAccountDir } } : {}),
      },
    });
    this.activeQuery = q;
    void q
      .initializationResult()
      .then((init) => {
        if (Array.isArray(init.models)) this.callbacks.onModels(init.models);
      })
      .catch(() => undefined);
    void this.consume(q);
  }

  private canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
    const requestId = randomUUID();

    // AskUserQuestion: render as a real question card; the answer flows back
    // through updatedInput.answers per the tool's contract.
    if (toolName === 'AskUserQuestion' && Array.isArray(input?.questions)) {
      this.appendEvent({
        type: 'question_request',
        requestId,
        questions: input.questions as never,
      });
      return new Promise((resolve) => {
        this.pendingPermissions.set(requestId, {
          isQuestion: true,
          settle: (allow, message, answers) => {
            if (allow && answers) {
              resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
            } else {
              resolve({ behavior: 'deny', message: message ?? 'User dismissed the question.' });
            }
          },
        });
      });
    }

    this.appendEvent({ type: 'permission_request', requestId, toolName, input });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        isQuestion: false,
        settle: (allow, message) => {
          if (allow) resolve({ behavior: 'allow', updatedInput: input });
          else resolve({ behavior: 'deny', message: message ?? 'User denied this tool use.' });
        },
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
        const message = msg.message as
          | { content?: Array<Record<string, unknown>>; usage?: Record<string, unknown> }
          | undefined;
        // Subagent (Agent tool) messages carry parent_tool_use_id and report
        // the SUBAGENT's context, not this conversation's — counting them would
        // make the context ring show someone else's window.
        if (message?.usage && msg.parent_tool_use_id == null) {
          this.lastCallUsage = message.usage;
        }
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
        // Context size must come from the FINAL assistant call's usage:
        // result.usage sums across every API call in the turn, so cached
        // prompt tokens get re-counted per tool-use step and wildly
        // overestimate context on long turns.
        const ctxUsage = this.lastCallUsage ?? usage;
        const contextTokens = ctxUsage
          ? num(ctxUsage.input_tokens) +
            num(ctxUsage.cache_read_input_tokens) +
            num(ctxUsage.cache_creation_input_tokens) +
            num(ctxUsage.output_tokens)
          : undefined;
        // This turn's own consumption: fresh (non-cache-read) input + output.
        const turnTokens = usage
          ? num(usage.input_tokens) +
            num(usage.cache_creation_input_tokens) +
            num(usage.output_tokens)
          : undefined;
        let contextWindow: number | undefined;
        const modelUsage = msg.modelUsage as Record<string, { contextWindow?: unknown }> | undefined;
        for (const entry of Object.values(modelUsage ?? {})) {
          if (typeof entry.contextWindow === 'number') {
            contextWindow = Math.max(contextWindow ?? 0, entry.contextWindow);
          }
        }
        this.appendEvent({
          type: 'result',
          summary: summarize(summaryText, 400),
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
          ...(contextTokens ? { contextTokens } : {}),
          ...(contextWindow ? { contextWindow } : {}),
          ...(turnTokens ? { turnTokens } : {}),
        });
        this.setStatus('idle');
        break;
      }
      case 'rate_limit_event': {
        // Plan rate-limit windows are NOT part of SDKControlInitializeResponse
        // (what q.initializationResult() returns, above) — that type only
        // carries commands/agents/models/output_style/account/fast_mode.
        // subscription_type/rate_limits_available/rate_limits live on
        // SDKControlGetUsageResponse, returned by the separate, explicitly
        // experimental usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        // control call — not called here. This live push (SDKRateLimitEvent,
        // part of the same SDKMessage union already flowing through this
        // switch) is the only rate-limit source this daemon has verified
        // actually fires, so it is the only one wired up.
        const info = msg.rate_limit_info as Record<string, unknown> | undefined;
        if (info) this.callbacks.onRateLimit(info);
        break;
      }
      default:
        break;
    }
  }
}
