import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type {
  AccountInfo,
  Attachment,
  ClaudeSessionCandidate,
  EffortLevel,
  HelloResult,
  ModelDescriptor,
  PermissionMode,
  PersistedEvent,
  ActiveAgent,
  LoginStarted,
  UsageSnapshot,
  Request,
  ServerMessage,
  SessionInfo,
} from '@claude-persist/shared';

const baseDir = path.join(os.homedir(), '.claude-persist');

/**
 * Must match daemon/src/paths.ts exactly — the two processes meet here and
 * nowhere else. Windows has no unix domain socket in the filesystem, so the
 * endpoint is a named pipe, keyed by home directory for the same reason the
 * unix path lives under a per-user directory.
 */
function pipeSuffix(home: string): string {
  let hash = 0;
  for (let i = 0; i < home.length; i++) hash = (Math.imul(hash, 31) + home.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

const socketPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\claude-persist-${pipeSuffix(os.homedir())}`
    : path.join(baseDir, 'daemon.sock');

// Keep in sync with PROTOCOL_VERSION in shared/src/protocol.ts (the shared
// package is ESM, so the constant can't be require()d from this CJS module).
// protocolVersion.test.ts asserts the two stay equal — desyncing them makes
// the extension kill every daemon it spawns.
const EXPECTED_PROTOCOL = 27;

/** How long to wait for a reply before treating the daemon as wedged. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The handshake is the first thing sent; a wedged daemon shouldn't cost 30s per retry. */
const HELLO_TIMEOUT_MS = 5_000;
/** Total budget for connect(), including killing and replacing an outdated daemon. */
const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 250;

/** Omit that distributes over a union (plain Omit collapses union members). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * The running daemon speaks a newer protocol than this extension build. Not
 * retryable: this window is the stale one, and killing the daemon to "fix" it
 * is exactly the behaviour that made two windows fight.
 */
class DaemonTooNewError extends Error {
  constructor(theirs: number, ours: number) {
    super(
      `Daemon is newer (protocol ${theirs} > ${ours}) — update this window's extension and reload`,
    );
    this.name = 'DaemonTooNewError';
  }
}

/**
 * The outdated daemon exists but refuses to die — a different uid owns it
 * (shared home directory, or a container restart that recycled its pid).
 * Retrying just re-sends SIGTERM 40 times and then reports a generic failure,
 * so stop and say something the user can act on.
 */
class DaemonUnkillableError extends Error {
  constructor(pid: number) {
    super(
      `An outdated claude-persist daemon (pid ${pid}) is running and could not be stopped — ` +
        `it may belong to another user. Stop it manually (kill ${pid}) and reload the window.`,
    );
    this.name = 'DaemonUnkillableError';
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Why the running daemon needs replacing, or null if it's fine.
 *
 * The protocol number alone was never sufficient. Versions 0.7.26 through
 * 0.7.29 all spoke protocol 16, so those upgrades deliberately kept the running
 * daemon alive — but VS Code installs each version into its own directory and
 * deletes the old one, and the daemon runs `<extensionPath>/daemon/dist/main.js`
 * with the Agent SDK, and the native `claude` binary it spawns lazily per turn,
 * bundled beside it. Such a daemon stays up and answers `hello` perfectly while
 * every actual message fails, because the code it needs is gone from disk.
 *
 * Exported for tests; the deliberate narrowness is the interesting part.
 */
export function stalenessReason(info: HelloResult, expectedProtocol: number): string | null {
  if (info.protocolVersion !== expectedProtocol) {
    return `Outdated daemon (protocol ${info.protocolVersion} vs ${expectedProtocol})`;
  }
  // Only "the file it was launched from no longer exists" counts. Comparing it
  // against our own resolved entry instead would make two windows configured
  // with different daemonEntry paths kill each other's daemon forever — the
  // same mutual-murder shape the protocol check already had once.
  if (info.entry && !fs.existsSync(info.entry)) {
    return `Daemon running from a deleted install (${info.entry})`;
  }
  return null;
}

/** Is anything currently accepting connections on the socket? */
function socketAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const settle = (alive: boolean): void => {
      probe.destroy();
      resolve(alive);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
}

export interface AttachResult {
  info: SessionInfo;
  events: PersistedEvent[];
  /** True when the replay was capped and older events exist on disk. */
  hasEarlier?: boolean;
}

type PushHandler = {
  onEvent(sessionId: string, event: PersistedEvent): void;
  onDelta(sessionId: string, text: string): void;
  onAgents(sessionId: string, agents: ActiveAgent[]): void;
  onSessionsChanged(): void;
  onModels(models: ModelDescriptor[]): void;
  onRateLimits(usage: UsageSnapshot): void;
  onAccounts(accounts: AccountInfo[]): void;
  onDisconnect(): void;
};

/**
 * Thin request/response + push client over the daemon's unix socket.
 * The extension host runs on the server (code-server), so the socket is local.
 */
export class DaemonClient {
  private socket: net.Socket | null = null;
  /** Set by the detached child's 'error' event, which no retry would ever reveal. */
  private lastSpawnError: Error | null = null;
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
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.tryConnect();
        await this.verifyProtocol();
        return;
      } catch (err) {
        // Neither of these gets better by trying again: the first means this
        // window is the stale one, the second that we can't stop the daemon at
        // all. Both need the user, so surface them immediately.
        if (err instanceof DaemonTooNewError || err instanceof DaemonUnkillableError) throw err;
        lastError = err;
        // A handshake can fail with the socket still open and wired (a daemon
        // so old it answers 'hello' with "unknown op"). The next tryConnect
        // would overwrite this.socket and orphan this one, so drop it here —
        // field first, so onGone doesn't read it as a real disconnect.
        const stale = this.socket;
        this.socket = null;
        stale?.destroy();
      }
      // Spawn on every attempt where nothing is listening, not just once up
      // front. Spawning once lost a race: if an outdated daemon's shutdown
      // outlasted our wait, the replacement's single-instance probe still saw
      // the old socket, exited as "daemon already running", and *then* the old
      // daemon unlinked the socket on its way out — leaving no daemon at all
      // and a retry loop that only ever reconnected. Redundant spawns are
      // harmless: that same probe makes a second daemon exit(0) immediately.
      if (!(await socketAlive())) {
        try {
          await this.spawnDaemon();
        } catch (err) {
          lastError = err; // e.g. daemon not built — keep the real reason
        }
      }
      await delay(CONNECT_RETRY_MS);
    }
    const cause = this.lastSpawnError ?? lastError;
    throw new Error(
      `Could not start claude-persist daemon: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  /**
   * Kill and replace a daemon speaking an older protocol (left over from a
   * previous extension version). Sessions themselves survive this: transcripts
   * and SDK session ids are on disk, and the new daemon resumes them.
   */
  private async verifyProtocol(): Promise<void> {
    const info = await this.request<HelloResult>(
      { op: 'hello', protocolVersion: EXPECTED_PROTOCOL },
      HELLO_TIMEOUT_MS,
    );
    const reason = this.stalenessReason(info);
    if (!reason) return;
    // Clear the field *before* destroying: 'close' fires asynchronously, and
    // onGone only reports a disconnect for the socket it still believes is
    // current. Dropping it first keeps our own deliberate teardown from
    // firing onDisconnect and starting a reconnect that competes with the
    // connect() loop below.
    const stale = this.socket;
    this.socket = null;
    stale?.destroy();
    // Newest wins. Killing on ANY mismatch made two windows on different
    // extension versions murder each other's daemon in a loop (observed at
    // sub-second cadence in the daemon log) — and while they fought, nothing
    // could connect to the socket at all.
    if (info.protocolVersion > EXPECTED_PROTOCOL) {
      throw new DaemonTooNewError(info.protocolVersion, EXPECTED_PROTOCOL);
    }
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch (err) {
      // ESRCH just means it beat us to it. EPERM means we can't ever stop it,
      // and every retry from here is wasted — say so instead.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        throw new DaemonUnkillableError(info.pid);
      }
    }
    // No fixed sleep here: connect() polls the socket, so a slow shutdown
    // just costs another 250ms tick instead of racing a hardcoded deadline.
    throw new Error(`${reason} — restarting`);
  }

  private stalenessReason(info: HelloResult): string | null {
    return stalenessReason(info, EXPECTED_PROTOCOL);
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
    // Without this listener a failure to spawn at all (bad execPath, EACCES,
    // ENOMEM) was an unhandled 'error' event on a detached child: invisible
    // here, and invisible in the daemon log too since the daemon never ran.
    // The reason is kept so connect()'s final error can name it.
    child.once('error', (err) => {
      this.lastSpawnError = err;
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
      case 'agents':
        this.handler.onAgents(message.sessionId, message.agents);
        break;
      case 'sessions_changed':
        this.handler.onSessionsChanged();
        break;
      case 'models':
        this.handler.onModels(message.models);
        break;
      case 'rateLimits':
        this.handler.onRateLimits(message.usage);
        break;
      case 'accounts':
        this.handler.onAccounts(message.accounts);
        break;
    }
  }

  /**
   * Every daemon op replies immediately — long-running work (a turn in
   * progress) reports back through pushes, not the response — so a reply that
   * never arrives means the daemon is wedged, not busy. Without a timeout that
   * wedged the whole extension host: connect()'s promise is cached by
   * ensureClient, so one unanswered `hello` left every later command awaiting
   * a reply that was never coming, with nothing surfaced to the user.
   */
  private request<T>(
    req: DistributiveOmit<Request, 'id'>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('Not connected to daemon'));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Daemon did not respond to '${req.op}' within ${timeoutMs}ms`));
        // Drop the connection so the normal reconnect path takes over rather
        // than leaving a half-dead socket in place.
        socket.destroy();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    socket.write(`${JSON.stringify({ id, ...req })}\n`);
    return promise;
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.request({ op: 'listSessions' });
  }

  createSession(cwd: string, title?: string): Promise<SessionInfo> {
    return this.request({ op: 'createSession', cwd, title });
  }

  attach(sessionId: string, sinceSeq: number, limit?: number): Promise<AttachResult> {
    return this.request({ op: 'attach', sessionId, sinceSeq, ...(limit ? { limit } : {}) });
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

  listRateLimits(): Promise<UsageSnapshot> {
    return this.request({ op: 'listRateLimits' });
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

  /** Push VS Code settings the daemon acts on but cannot read for itself. */
  setOptions(opts: { switchAccountOnLimit?: boolean }): Promise<unknown> {
    return this.request({ op: 'setOptions', ...opts });
  }

  stopAgent(sessionId: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
    return this.request({ op: 'stopAgent', sessionId, taskId });
  }

  startLogin(name: string): Promise<LoginStarted> {
    return this.request({ op: 'startLogin', name });
  }

  submitLoginCode(loginId: string, code: string): Promise<{ ok: boolean; error?: string }> {
    return this.request({ op: 'submitLoginCode', loginId, code });
  }

  cancelLogin(loginId: string): Promise<void> {
    return this.request({ op: 'cancelLogin', loginId });
  }

  listAccounts(): Promise<AccountInfo[]> {
    return this.request({ op: 'listAccounts' });
  }

  setAccount(configDir: string | null): Promise<AccountInfo[]> {
    return this.request({ op: 'setAccount', configDir });
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
