// Wire protocol between the claude-persist daemon and its clients (the VS Code
// extension). Transport: newline-delimited JSON over a unix domain socket at
// ~/.claude-persist/daemon.sock.
//
// The daemon owns the Claude sessions; clients are disposable. A client that
// reconnects sends `attach` with the last seq it has seen and receives a
// replay of everything it missed, then live pushes.

export const PROTOCOL_VERSION = 5;

export type SessionStatus = 'idle' | 'running' | 'error';

/** Mirrors the Agent SDK's PermissionMode (the UI exposes default/bypass). */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
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
  | { type: 'permission_resolved'; requestId: string; allowed: boolean }
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'result'; summary: string; costUsd?: number; durationMs?: number; contextTokens?: number; contextWindow?: number };

export interface PersistedEvent {
  seq: number;
  ts: number;
  event: ChatEvent;
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
  | { id: number; op: 'attach'; sessionId: string; sinceSeq: number }
  | { id: number; op: 'detach'; sessionId: string }
  | { id: number; op: 'sendMessage'; sessionId: string; text: string; attachments?: Attachment[] }
  | { id: number; op: 'interrupt'; sessionId: string }
  | { id: number; op: 'permission'; sessionId: string; requestId: string; allow: boolean; message?: string }
  | { id: number; op: 'setPermissionMode'; sessionId: string; mode: PermissionMode }
  | { id: number; op: 'listClaudeSessions' }
  | { id: number; op: 'importClaudeSession'; file: string }
  | { id: number; op: 'deleteSession'; sessionId: string };

export type Push =
  | { kind: 'event'; sessionId: string; event: PersistedEvent }
  /** Live-only streaming text; not persisted, superseded by the next assistant_text event. */
  | { kind: 'delta'; sessionId: string; text: string }
  | { kind: 'sessions_changed' };

export type ServerMessage =
  | { kind: 'response'; id: number; ok: true; result?: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | Push;
