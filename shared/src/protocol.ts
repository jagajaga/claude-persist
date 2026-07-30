// Wire protocol between the claude-persist daemon and its clients (the VS Code
// extension). Transport: newline-delimited JSON over a unix domain socket at
// ~/.claude-persist/daemon.sock.
//
// The daemon owns the Claude sessions; clients are disposable. A client that
// reconnects sends `attach` with the last seq it has seen and receives a
// replay of everything it missed, then live pushes.

export const PROTOCOL_VERSION = 15;

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
  /**
   * Where the conversation is *actually* working. Diverges from `cwd` when it
   * moves into a worktree; absent means it never left `cwd`.
   */
  effectiveCwd?: string;
  /** Worktrees this session's subagents currently hold open. */
  activeWorktrees?: number;
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

/** An existing Claude Code (CLI / official extension) session on this machine. */
export interface ClaudeSessionCandidate {
  file: string;
  sdkSessionId: string;
  cwd: string;
  title: string;
  mtimeMs: number;
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
  | { id: number; op: 'listClaudeSessions' }
  | { id: number; op: 'importClaudeSession'; file: string }
  | { id: number; op: 'deleteSession'; sessionId: string };

export type Push =
  | { kind: 'event'; sessionId: string; event: PersistedEvent }
  /** Broadcast when the daemon (re)learns the account's model list. */
  | { kind: 'models'; models: ModelDescriptor[] }
  /** Live-only streaming text; not persisted, superseded by the next assistant_text event. */
  | { kind: 'delta'; sessionId: string; text: string }
  /**
   * Live-only: the conversation moved directory. Not persisted — it describes
   * right now, not the transcript. Worktrees are read from git's registry by
   * the client, which is true regardless of when they were created.
   */
  | { kind: 'workspace'; sessionId: string; cwd: string }
  | { kind: 'sessions_changed' };

export type ServerMessage =
  | { kind: 'response'; id: number; ok: true; result?: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | Push;
