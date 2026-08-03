// Wire protocol between the claude-persist daemon and its clients (the VS Code
// extension). Transport: newline-delimited JSON over a unix domain socket at
// ~/.claude-persist/daemon.sock.
//
// The daemon owns the Claude sessions; clients are disposable. A client that
// reconnects sends `attach` with the last seq it has seen and receives a
// replay of everything it missed, then live pushes.

export const PROTOCOL_VERSION = 20;

/**
 * Reply to `hello`. `entry` is the module path the daemon was launched from;
 * clients check that it still exists on disk, because the protocol number
 * alone can't detect a daemon whose extension directory has been deleted out
 * from under it by an upgrade that didn't change the protocol.
 */
export interface HelloResult {
  protocolVersion: number;
  pid: number;
  entry: string;
}

export type SessionStatus = 'idle' | 'running' | 'error';

/** Mirrors the Agent SDK's PermissionMode (the UI exposes default/bypass). */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/** Reasoning effort ("how smart"), mirrors the Agent SDK's EffortLevel. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  /** Model alias/id override; undefined = account default. */
  model?: string;
  /** Reasoning effort override; undefined = default. */
  effort?: EffortLevel;
  createdAt: number;
  lastActivityAt: number;
  eventCount: number;
}

/** Something the user attaches to a message via the composer's + button. */
export type Attachment =
  | { kind: 'image'; name: string; mediaType: string; data: string }
  | { kind: 'file'; path: string };

/** A single chat-visible event. Persisted events replay after reconnect. */
export type ChatEvent =
  | { type: 'user_message'; text: string; attachments?: Array<{ kind: 'image' | 'file'; label: string }> }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId?: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId?: string; summary: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; input: unknown }
  /** Claude asked the user a question (AskUserQuestion tool). */
  | {
      type: 'question_request';
      requestId: string;
      questions: Array<{
        question: string;
        header: string;
        multiSelect?: boolean;
        options: Array<{ label: string; description?: string }>;
      }>;
    }
  | { type: 'permission_resolved'; requestId: string; allowed: boolean; answers?: Record<string, string> }
  | { type: 'status'; status: SessionStatus; detail?: string }
  | {
      type: 'result';
      summary: string;
      costUsd?: number;
      durationMs?: number;
      /** Total context size after this turn (drives the context ring). */
      contextTokens?: number;
      contextWindow?: number;
      /** Tokens consumed by this turn alone: fresh input + output. */
      turnTokens?: number;
    };

export interface PersistedEvent {
  seq: number;
  ts: number;
  event: ChatEvent;
}

/** A model available to this account, reported by the SDK at init. */
export interface ModelDescriptor {
  value: string;
  displayName: string;
  description?: string;
  effortLevels?: EffortLevel[];
}

/**
 * Plan rate-limit window kinds, as reported by the SDK's live `rate_limit_event`
 * push (`SDKRateLimitInfo.rateLimitType`). This is account-wide, not per-session.
 */
export type RateLimitWindowKind =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_overage_included'
  | 'overage';

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** One window's last-known state. `resetsAt` is epoch milliseconds. */
export interface RateLimitWindow {
  utilization: number | null;
  resetsAt: number | null;
  status: RateLimitStatus;
}

/** Every window the daemon has heard about so far; absent keys are simply unknown. */
export type RateLimits = Partial<Record<RateLimitWindowKind, RateLimitWindow>>;

/**
 * Everything the daemon knows about plan usage, from two sources that report
 * different halves of it: the live `rate_limit_event` push carries `status` and
 * `resetsAt` but usually no `utilization`, and the SDK's experimental usage call
 * carries `utilization` and `subscription_type` but no status. They are merged
 * per window rather than one replacing the other.
 */
export interface UsageSnapshot {
  windows: RateLimits;
  /** 'pro' | 'max' | 'team' | 'enterprise', or null for API-key/3P sessions. */
  subscriptionType: string | null;
  /**
   * False when plan rate limits don't apply at all (API key, Bedrock, Vertex,
   * or a profile missing the usage scope) — distinct from "not measured yet",
   * so the UI can say so instead of showing a permanently blank meter.
   */
  available: boolean;
}

/** An existing Claude Code (CLI / official extension) session on this machine. */
export interface ClaudeSessionCandidate {
  file: string;
  sdkSessionId: string;
  cwd: string;
  title: string;
  mtimeMs: number;
}

/**
 * A Claude credentials/config directory the daemon can point the SDK at via
 * CLAUDE_CONFIG_DIR. `configDir: null` is the default account: env left
 * unset, so the SDK falls back to ~/.claude.
 */
export interface AccountInfo {
  name: string;
  configDir: string | null;
  active: boolean;
}

export type Request =
  | { id: number; op: 'hello'; protocolVersion: number }
  | { id: number; op: 'listSessions' }
  | { id: number; op: 'createSession'; cwd: string; title?: string }
  /**
   * `limit` caps how many events come back, keeping the newest. A long-running
   * session can hold tens of thousands; replaying all of them would ship
   * megabytes to the webview and then block its renderer building the DOM.
   */
  | { id: number; op: 'attach'; sessionId: string; sinceSeq: number; limit?: number }
  | { id: number; op: 'detach'; sessionId: string }
  | { id: number; op: 'sendMessage'; sessionId: string; text: string; attachments?: Attachment[] }
  | { id: number; op: 'interrupt'; sessionId: string }
  | { id: number; op: 'permission'; sessionId: string; requestId: string; allow: boolean; message?: string; answers?: Record<string, string> }
  | { id: number; op: 'setPermissionMode'; sessionId: string; mode: PermissionMode }
  | { id: number; op: 'renameSession'; sessionId: string; title: string }
  /** undefined = leave unchanged; null = reset to default. */
  | { id: number; op: 'setSessionOptions'; sessionId: string; model?: string | null; effort?: EffortLevel | null }
  | { id: number; op: 'listModels' }
  | { id: number; op: 'listRateLimits' }
  | { id: number; op: 'listClaudeSessions' }
  | { id: number; op: 'importClaudeSession'; file: string }
  | { id: number; op: 'deleteSession'; sessionId: string }
  | { id: number; op: 'listAccounts' }
  /** `configDir: null` switches back to the default account. */
  | { id: number; op: 'setAccount'; configDir: string | null };

export type Push =
  | { kind: 'event'; sessionId: string; event: PersistedEvent }
  /** Broadcast when the daemon (re)learns the account's model list. */
  | { kind: 'models'; models: ModelDescriptor[] }
  /** Broadcast when a plan rate-limit window changes; account-wide. */
  | { kind: 'rateLimits'; usage: UsageSnapshot }
  /** Live-only streaming text; not persisted, superseded by the next assistant_text event. */
  | { kind: 'delta'; sessionId: string; text: string }
  | { kind: 'sessions_changed' }
  /** Broadcast whenever the active account or the set of known accounts changes. */
  | { kind: 'accounts'; accounts: AccountInfo[] };

export type ServerMessage =
  | { kind: 'response'; id: number; ok: true; result?: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | Push;
