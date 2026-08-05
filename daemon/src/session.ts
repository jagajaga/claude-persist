import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment,
  AttachmentRef,
  ChatEvent,
  PersistedEvent,
  RateLimits,
  SessionStatus,
} from '@claude-persist/shared';
import type { SessionMeta } from './registry.js';
import { pendingTurnPath, sessionLogPath } from './paths.js';
import { ROTATE_THRESHOLD, allLogFiles, loadTailAndCount, readRange, rotateActiveLog } from './logStore.js';
import { accountsStore, ensureSdkTranscript, sdkTranscriptExists } from './accounts.js';
import { MAX_ATTEMPTS, buildRetryEnvelope, isRateLimitResult, planRetry } from './limits.js';

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
  /** Raw SDKControlGetUsageResponse from the experimental usage control call. */
  onUsage(usage: Record<string, unknown>): void;
  /** Current plan windows, for scheduling a retry off the real reset instant. */
  rateLimitWindows(): RateLimits;
  /** Lifecycle logging (parked/retrying), so a stuck turn is diagnosable. */
  log(message: string): void;
}

/** A turn the plan limit rejected, held until the window resets. */
interface PendingTurn {
  /** The exact SDK envelope we pushed, replayed verbatim on retry. */
  envelope: unknown;
  retryAt: number;
  attempts: number;
  /** For the UI notice. */
  text: string;
  /**
   * Whether the interrupted turn had already produced work. Decides between
   * continuing and replaying — see buildRetryEnvelope.
   */
  producedOutput: boolean;
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
  /** Set while a turn is parked waiting for a rate limit to reset. */
  private pending: PendingTurn | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Did the current turn get anywhere before it was interrupted? */
  private turnProducedOutput = false;
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
    if (
      event.type === 'assistant_text' ||
      event.type === 'tool_use' ||
      event.type === 'tool_result'
    ) {
      this.turnProducedOutput = true;
    }
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
    // Keep the path and media type so the panel can render a thumbnail on
    // replay; the base64 itself is deliberately never persisted.
    const labels: AttachmentRef[] = attachments.map((a) =>
      a.kind === 'image'
        ? {
            kind: 'image',
            label: a.name,
            ...(a.path ? { path: a.path } : {}),
            mediaType: a.mediaType,
          }
        : { kind: 'file', label: a.path, path: a.path },
    );
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

    // A new message supersedes anything parked: the user is driving now, and
    // silently sending an old turn first would be a surprise.
    if (this.pending) this.cancelPendingRetry('superseded by a new message');

    this.ensureQuery();
    const envelope = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.meta.sdkSessionId ?? '',
    };
    this.lastEnvelope = { envelope, text };
    this.turnProducedOutput = false;
    this.input!.push(envelope);
    this.setStatus('running');
  }

  /** The turn most recently submitted, kept so a rate-limited one can be replayed. */
  private lastEnvelope: { envelope: unknown; text: string } | null = null;

  /** Epoch ms a parked turn will be retried, or null. Surfaced in SessionInfo. */
  get retryAt(): number | null {
    return this.pending?.retryAt ?? null;
  }

  /**
   * Hold a turn the plan limit rejected and schedule a retry.
   *
   * The limit arrives as a normal `result` message, not an exception, so the
   * turn just ends with no answer — which is exactly why nothing used to retry.
   */
  private parkForLimit(text: string): void {
    const envelope = this.lastEnvelope;
    if (!envelope) return; // nothing to replay (e.g. limit hit on a resumed probe)
    const attempts = (this.pending?.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      // Stop rather than loop: whatever keeps failing is not clearing on its own.
      this.callbacks.log(
        `session ${this.meta.id} giving up after ${MAX_ATTEMPTS} rate-limit retries`,
      );
      this.pending = null;
      this.clearPersistedPending();
      this.appendEvent({
        type: 'status',
        status: 'error',
        detail: `Still rate limited after ${MAX_ATTEMPTS} automatic retries — giving up. Send the message again when you're ready.`,
      });
      return;
    }
    const plan = planRetry({
      windows: this.callbacks.rateLimitWindows(),
      text,
      now: Date.now(),
      attempts,
      sessionId: this.meta.id,
    });
    this.pending = {
      envelope: envelope.envelope,
      text: envelope.text,
      retryAt: plan.at,
      attempts,
      producedOutput: this.turnProducedOutput,
    };
    this.persistPending();
    this.callbacks.log(
      `session ${this.meta.id} rate limited; retry #${attempts} at ${new Date(plan.at).toISOString()} (from ${plan.source})`,
    );
    this.appendEvent({
      type: 'status',
      status: 'error',
      detail: this.turnProducedOutput
        ? `Rate limit reached partway through. This will continue automatically at ${new Date(plan.at).toISOString()} — you don't need to come back.`
        : `Rate limit reached. Your message is queued and will be sent automatically at ${new Date(plan.at).toISOString()} — you don't need to come back.`,
    });
    this.scheduleRetry();
  }

  /** (Re)arm the retry timer from this.pending. Safe to call repeatedly. */
  scheduleRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.pending) return;
    const delay = Math.max(0, this.pending.retryAt - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.runPendingRetry();
    }, delay);
    // Don't hold the daemon open solely for a retry; it is a long-lived process
    // anyway, and an unref'd timer still fires while it runs.
    this.retryTimer.unref();
  }

  private runPendingRetry(): void {
    const pending = this.pending;
    if (!pending) return;
    this.callbacks.log(`session ${this.meta.id} retrying rate-limited turn (attempt ${pending.attempts})`);
    // Start a fresh query rather than trusting one that has been idle for hours;
    // it resumes the same sdkSessionId, so no context is lost.
    this.disposeActiveQuery();
    this.ensureQuery();
    this.appendEvent({
      type: 'status',
      status: 'running',
      detail: pending.producedOutput
        ? 'Rate limit reset — continuing where it stopped…'
        : 'Rate limit reset — resending your queued message…',
    });
    this.status = 'running';
    this.input!.push(buildRetryEnvelope(pending, this.meta.sdkSessionId ?? ''));
  }

  private cancelPendingRetry(reason: string): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.pending) return;
    this.pending = null;
    this.clearPersistedPending();
    this.callbacks.log(`session ${this.meta.id} queued retry cancelled: ${reason}`);
    this.appendEvent({
      type: 'status',
      status: 'error',
      detail: `Queued retry cancelled (${reason}).`,
    });
  }

  /** Called by the daemon at startup for sessions with a parked turn on disk. */
  restorePending(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(pendingTurnPath(this.meta.id), 'utf8')) as PendingTurn;
      if (!raw || typeof raw.retryAt !== 'number' || raw.envelope === undefined) return;
      this.pending = raw;
      this.status = 'running';
      this.scheduleRetry();
      this.callbacks.log(
        `session ${this.meta.id} has a queued turn; retry at ${new Date(raw.retryAt).toISOString()}`,
      );
    } catch {
      this.clearPersistedPending();
    }
  }

  private persistPending(): void {
    if (!this.pending) return;
    try {
      fs.writeFileSync(pendingTurnPath(this.meta.id), JSON.stringify(this.pending));
    } catch {
      // A parked turn that can't be persisted still retries in-process; it just
      // won't survive a daemon restart. Not worth failing the session over.
    }
  }

  private clearPersistedPending(): void {
    try {
      fs.unlinkSync(pendingTurnPath(this.meta.id));
    } catch {
      // already gone
    }
  }

  async interrupt(): Promise<void> {
    // Also drop a queued retry — "stop" must mean stop, including hours from now.
    if (this.pending) this.cancelPendingRetry('interrupted');
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

  /**
   * Full teardown; never rejects. Resolves once the SDK query has been asked to
   * close — the previous version dropped the activeQuery reference without
   * closing it, so on an upgrade kill cycle (SIGTERM, then an immediate
   * process.exit) the SDK's own `claude` child process was never told to stop
   * and could outlive the daemon that spawned it.
   */
  async dispose(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.input?.close();
    this.input = null;
    const active = this.activeQuery;
    this.activeQuery = null;
    try {
      await active?.close();
    } catch {
      // already closed/gone
    }
    if (this.logFd !== null) {
      try {
        fs.closeSync(this.logFd);
      } catch {
        // fd already invalid
      }
      this.logFd = null;
    }
  }

  /**
   * Ask the SDK for real plan usage.
   *
   * The live `rate_limit_event` push is the only source that reliably fires, but
   * `SDKRateLimitInfo.utilization` is optional and in practice absent — so the
   * status bar, which needs a percentage, had nothing to show and fell back to a
   * bare label. This control call is where `utilization` and `subscription_type`
   * actually live (documented as "Percentage of the window used, 0-100").
   *
   * Called through a structural check rather than the typed method, and every
   * failure is swallowed: the name says
   * `_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, so an SDK that
   * renames or drops it must degrade to "no utilization" — which is merely the
   * old behaviour — instead of breaking turns.
   */
  private async pollUsage(activeQuery: unknown): Promise<void> {
    const probe = activeQuery as {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
    } | null;
    const fetchUsage = probe?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fetchUsage !== 'function') return;
    try {
      const usage = await fetchUsage.call(probe);
      if (usage && typeof usage === 'object') {
        this.callbacks.onUsage(usage as Record<string, unknown>);
      }
    } catch {
      // unstable API, or a session that ended mid-call — not worth surfacing
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
    const activeConcreteDir = accountsStore.activeConcreteDir();
    // Sync unconditionally, including when switching *back* to the default:
    // a session created while a named account was active has its SDK-side
    // transcript only under that account, so gating this on activeAccountDir
    // made the default direction fail to resume with the same
    // "No conversation found with session ID" error.
    ensureSdkTranscript(
      this.meta.sdkSessionId,
      this.meta.cwd,
      activeConcreteDir,
      accountsStore.allConcreteDirs(),
    );
    // Only resume against a transcript that is actually there. Passing an
    // sdkSessionId the SDK can't find fails every single turn with "No
    // conversation found with session ID" and leaves the user no way out — the
    // session is bricked for good. Starting a fresh SDK session loses the
    // model's context, but keeps the session usable, and the daemon's own
    // transcript still renders the full history in the panel. Say so rather
    // than dropping the context silently.
    const resumable =
      !!this.meta.sdkSessionId &&
      sdkTranscriptExists(this.meta.sdkSessionId, this.meta.cwd, activeConcreteDir);
    if (this.meta.sdkSessionId && !resumable) {
      // appendEvent, not setStatus: this renders the ⚠︎ notice in the thread
      // without marking the session errored — it is about to work fine.
      this.appendEvent({
        type: 'status',
        status: 'error',
        detail:
          `Previous conversation context could not be found (session ${this.meta.sdkSessionId}) — ` +
          'continuing as a new Claude session. The transcript above is preserved.',
      });
      this.meta.sdkSessionId = undefined;
      this.callbacks.onMetaChanged();
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
        // Populate usage as soon as the session is up, so the status bar has a
        // percentage before the first turn rather than only after one.
        void this.pollUsage(q);
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
        // Refresh usage after every turn: a turn is the only thing that moves
        // utilization, so this is exactly as often as it can change (plus the
        // window reset, which the live push reports on its own).
        void this.pollUsage(this.activeQuery);
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
        // A plan limit comes back as an ordinary result, so decide here whether
        // this turn actually finished or was refused.
        // Only an errored turn can be a rate-limit rejection. `subtype` is
        // 'success' on a normal answer; anything else, or is_error, means the
        // turn did not complete.
        const turnFailed =
          msg.is_error === true || (msg.subtype !== undefined && msg.subtype !== 'success');
        if (isRateLimitResult(summaryText, turnFailed)) {
          this.status = 'error';
          this.parkForLimit(summaryText);
        } else {
          // A real answer: whatever was parked has now been superseded.
          if (this.pending) {
            this.pending = null;
            this.clearPersistedPending();
            if (this.retryTimer) {
              clearTimeout(this.retryTimer);
              this.retryTimer = null;
            }
          }
          this.setStatus('idle');
        }
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
