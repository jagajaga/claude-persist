import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type {
  Attachment,
  ClaudeSessionCandidate,
  EffortLevel,
  ModelDescriptor,
  PermissionMode,
  PersistedEvent,
  Request,
  ServerMessage,
  SessionInfo,
} from '@claude-persist/shared';

const baseDir = path.join(os.homedir(), '.claude-persist');
const socketPath = path.join(baseDir, 'daemon.sock');

// Keep in sync with PROTOCOL_VERSION in shared/src/protocol.ts (the shared
// package is ESM, so the constant can't be require()d from this CJS module).
const EXPECTED_PROTOCOL = 12;

/** Omit that distributes over a union (plain Omit collapses union members). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface AttachResult {
  info: SessionInfo;
  events: PersistedEvent[];
}

type PushHandler = {
  onEvent(sessionId: string, event: PersistedEvent): void;
  onDelta(sessionId: string, text: string): void;
  onSessionsChanged(): void;
  onModels(models: ModelDescriptor[]): void;
  onDisconnect(): void;
};

/**
 * Thin request/response + push client over the daemon's unix socket.
 * The extension host runs on the server (code-server), so the socket is local.
 */
export class DaemonClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private handler: PushHandler;
  private daemonEntry: string;

  constructor(daemonEntry: string, handler: PushHandler) {
    this.daemonEntry = daemonEntry;
    this.handler = handler;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    try {
      await this.tryConnect();
      await this.verifyProtocol();
      return;
    } catch {
      // Not running, or an outdated daemon was just told to exit — (re)spawn.
    }
    await this.spawnDaemon();
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await this.tryConnect();
        await this.verifyProtocol();
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`Could not start claude-persist daemon: ${String(lastError)}`);
  }

  /**
   * Kill and replace a daemon speaking an older protocol (left over from a
   * previous extension version). Sessions themselves survive this: transcripts
   * and SDK session ids are on disk, and the new daemon resumes them.
   */
  private async verifyProtocol(): Promise<void> {
    const info = await this.request<{ protocolVersion: number; pid: number }>({
      op: 'hello',
      protocolVersion: EXPECTED_PROTOCOL,
    });
    if (info.protocolVersion === EXPECTED_PROTOCOL) return;
    this.socket?.destroy();
    this.socket = null;
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await new Promise((r) => setTimeout(r, 600));
    throw new Error(`Outdated daemon (protocol ${info.protocolVersion}) — restarting`);
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => {
        this.socket = socket;
        this.wire(socket);
        resolve();
      });
      socket.once('error', reject);
    });
  }

  private async spawnDaemon(): Promise<void> {
    if (!fs.existsSync(this.daemonEntry)) {
      throw new Error(`Daemon entry not found: ${this.daemonEntry}`);
    }
    fs.mkdirSync(baseDir, { recursive: true });
    const child = spawn(process.execPath, [this.daemonEntry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }

  private wire(socket: net.Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.dispatch(JSON.parse(line) as ServerMessage);
        } catch {
          // ignore malformed line
        }
      }
    });
    const onGone = (): void => {
      if (this.socket === socket) {
        this.socket = null;
        for (const p of this.pending.values()) p.reject(new Error('Daemon connection lost'));
        this.pending.clear();
        this.handler.onDisconnect();
      }
    };
    socket.on('close', onGone);
    socket.on('error', onGone);
  }

  private dispatch(message: ServerMessage): void {
    if ('kind' in message && message.kind === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
    switch (message.kind) {
      case 'event':
        this.handler.onEvent(message.sessionId, message.event);
        break;
      case 'delta':
        this.handler.onDelta(message.sessionId, message.text);
        break;
      case 'sessions_changed':
        this.handler.onSessionsChanged();
        break;
      case 'models':
        this.handler.onModels(message.models);
        break;
    }
  }

  private request<T>(req: DistributiveOmit<Request, 'id'>): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Not connected to daemon'));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.socket.write(`${JSON.stringify({ id, ...req })}\n`);
    return promise;
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.request({ op: 'listSessions' });
  }

  createSession(cwd: string, title?: string): Promise<SessionInfo> {
    return this.request({ op: 'createSession', cwd, title });
  }

  attach(sessionId: string, sinceSeq: number): Promise<AttachResult> {
    return this.request({ op: 'attach', sessionId, sinceSeq });
  }

  detach(sessionId: string): Promise<void> {
    return this.request({ op: 'detach', sessionId });
  }

  sendMessage(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
    return this.request({
      op: 'sendMessage',
      sessionId,
      text,
      ...(attachments && attachments.length ? { attachments } : {}),
    });
  }

  interrupt(sessionId: string): Promise<void> {
    return this.request({ op: 'interrupt', sessionId });
  }

  permission(
    sessionId: string,
    requestId: string,
    allow: boolean,
    message?: string,
    answers?: Record<string, string>,
  ): Promise<void> {
    return this.request({ op: 'permission', sessionId, requestId, allow, message, answers });
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    return this.request({ op: 'setPermissionMode', sessionId, mode });
  }

  setSessionOptions(
    sessionId: string,
    opts: { model?: string | null; effort?: EffortLevel | null },
  ): Promise<void> {
    return this.request({ op: 'setSessionOptions', sessionId, ...opts });
  }

  renameSession(sessionId: string, title: string): Promise<SessionInfo> {
    return this.request({ op: 'renameSession', sessionId, title });
  }

  listModels(): Promise<ModelDescriptor[]> {
    return this.request({ op: 'listModels' });
  }

  listClaudeSessions(): Promise<ClaudeSessionCandidate[]> {
    return this.request({ op: 'listClaudeSessions' });
  }

  importClaudeSession(file: string): Promise<SessionInfo> {
    return this.request({ op: 'importClaudeSession', file });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request({ op: 'deleteSession', sessionId });
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
