// Wire protocol between the claude-persist daemon and its clients (the VS Code
// extension). Transport: newline-delimited JSON over a unix domain socket at
// ~/.claude-persist/daemon.sock.
//
// The daemon owns the Claude sessions; clients are disposable. A client that
// reconnects sends `attach` with the last seq it has seen and receives a
// replay of everything it missed, then live pushes.

export const PROTOCOL_VERSION = 1;

export type SessionStatus = 'idle' | 'running' | 'error';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  eventCount: number;
}

/** A single chat-visible event. Persisted events replay after reconnect. */
export type ChatEvent =
  | { type: 'user_message'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolName: string; input: unknown }
  | { type: 'tool_result'; summary: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; input: unknown }
  | { type: 'permission_resolved'; requestId: string; allowed: boolean }
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'result'; summary: string; costUsd?: number; durationMs?: number };

export interface PersistedEvent {
  seq: number;
  ts: number;
  event: ChatEvent;
}

export type Request =
  | { id: number; op: 'hello'; protocolVersion: number }
  | { id: number; op: 'listSessions' }
  | { id: number; op: 'createSession'; cwd: string; title?: string }
  | { id: number; op: 'attach'; sessionId: string; sinceSeq: number }
  | { id: number; op: 'detach'; sessionId: string }
  | { id: number; op: 'sendMessage'; sessionId: string; text: string }
  | { id: number; op: 'interrupt'; sessionId: string }
  | { id: number; op: 'permission'; sessionId: string; requestId: string; allow: boolean; message?: string }
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
