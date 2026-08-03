import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelDescriptor,
  PersistedEvent,
  RateLimits,
  RateLimitWindowKind,
  Request,
  ServerMessage,
  SessionInfo,
} from '@claude-persist/shared';
import type { HelloResult } from '@claude-persist/shared';
import { PROTOCOL_VERSION } from '@claude-persist/shared';
import { ensureDirs, socketPath, sessionLogPath, logPath } from './paths.js';
import { acquireLock, readLock, releaseLock } from './lock.js';
import { Registry } from './registry.js';
import { DaemonSession } from './session.js';
import { importClaudeSession, listClaudeSessions } from './importer.js';
import { accountsStore } from './accounts.js';

/**
 * Logging comes first and degrades rather than failing, because a crash during
 * module init used to leave no trace anywhere: the uncaughtException handlers
 * were installed at the *bottom* of this file — after ensureDirs() and the log
 * stream had already run — and the extension spawns us with stdio:'ignore', so
 * an unwritable ~/.claude-persist produced a daemon that died silently and an
 * extension that could only report "could not start".
 *
 * The append is synchronous on purpose. A buffered WriteStream drops whatever
 * was written immediately before a process.exit(), which is exactly when this
 * log matters — "daemon already running, exiting" and the server-error path both
 * exit on the next line, and both messages were being lost. This is a
 * lifecycle-only log (a handful of lines per daemon lifetime), so appendFileSync
 * costs nothing next to being able to diagnose a daemon that won't start.
 */
function logLine(text: string): void {
  const line = `${new Date().toISOString()} ${text}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    process.stderr.write(line);
  }
}

// Deliberately non-fatal: an uncaught error in one session's callback should
// not take down every other live session with it.
process.on('uncaughtException', (err) => logLine(`uncaught: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => logLine(`unhandled rejection: ${String(err)}`));

try {
  ensureDirs();
} catch (err) {
  logLine(`fatal: cannot create ${logPath}'s directory: ${String(err)}`);
  process.exit(1);
}

/**
 * Events replayed to a freshly attached panel. Chosen so a huge transcript
 * opens instantly; "Load earlier" widens the window on demand.
 */
const DEFAULT_REPLAY_LIMIT = 400;

const registry = new Registry();
const quarantined = registry.load();
if (quarantined) {
  logLine(`registry was unreadable and has been moved to ${quarantined}; starting with no sessions`);
}

const sessions = new Map<string, DaemonSession>();
/** sessionId -> set of client connections subscribed to it */
const subscribers = new Map<string, Set<Client>>();

interface Client {
  socket: net.Socket;
  send(message: ServerMessage): void;
  attached: Set<string>;
}

function broadcast(sessionId: string, message: ServerMessage): void {
  for (const client of subscribers.get(sessionId) ?? []) client.send(message);
}

function broadcastAll(message: ServerMessage): void {
  for (const client of clients) client.send(message);
}

// ---------- model list (learned from the SDK, never hardcoded) --------------

let modelCache: ModelDescriptor[] | null = null;
let modelProbe: Promise<ModelDescriptor[]> | null = null;

function toDescriptors(models: unknown[]): ModelDescriptor[] {
  const out: ModelDescriptor[] = [];
  for (const raw of models) {
    const m = raw as Record<string, unknown>;
    if (typeof m.value !== 'string') continue;
    out.push({
      value: m.value,
      displayName: typeof m.displayName === 'string' ? m.displayName : m.value,
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(Array.isArray(m.supportedEffortLevels)
        ? { effortLevels: m.supportedEffortLevels as ModelDescriptor['effortLevels'] }
        : {}),
    });
  }
  return out;
}

function cacheModels(models: unknown[]): void {
  const descriptors = toDescriptors(models);
  if (descriptors.length === 0) return;
  const changed = JSON.stringify(descriptors) !== JSON.stringify(modelCache);
  modelCache = descriptors;
  if (changed) broadcastAll({ kind: 'models', models: descriptors });
}

/** No session has run yet: launch a throwaway query just for the init handshake. */
function probeModels(): Promise<ModelDescriptor[]> {
  if (modelCache) return Promise.resolve(modelCache);
  if (modelProbe) return modelProbe;
  modelProbe = (async () => {
    const idleInput = (async function* () {
      await new Promise(() => undefined); // never yields; closed via close()
    })() as AsyncIterable<never>;
    const q = query({ prompt: idleInput, options: { cwd: os.homedir() } });
    try {
      const init = await q.initializationResult();
      if (Array.isArray(init.models)) cacheModels(init.models);
    } finally {
      try {
        q.close();
      } catch {
        // already closed
      }
      modelProbe = null;
    }
    return modelCache ?? [];
  })();
  return modelProbe;
}

// ---------- plan rate limits (account-wide, learned from the live SDK push) -

const RATE_LIMIT_WINDOW_KINDS: RateLimitWindowKind[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];
const RATE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);

let rateLimitCache: RateLimits = {};

/** Raw SDKRateLimitInfo -> one normalised window keyed by its rateLimitType. */
function normalizeRateLimitEvent(
  info: Record<string, unknown>,
): { kind: RateLimitWindowKind; window: NonNullable<RateLimits[RateLimitWindowKind]> } | null {
  const kind = info.rateLimitType;
  if (typeof kind !== 'string' || !RATE_LIMIT_WINDOW_KINDS.includes(kind as RateLimitWindowKind)) {
    return null;
  }
  const utilization = typeof info.utilization === 'number' ? info.utilization : null;
  const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
  const status = RATE_LIMIT_STATUSES.has(info.status as string)
    ? (info.status as 'allowed' | 'allowed_warning' | 'rejected')
    : 'allowed';
  return { kind: kind as RateLimitWindowKind, window: { utilization, resetsAt, status } };
}

const callbacks = {
  onModels(models: unknown[]): void {
    cacheModels(models);
  },
  onRateLimit(info: Record<string, unknown>): void {
    const normalized = normalizeRateLimitEvent(info);
    if (!normalized) return;
    rateLimitCache = { ...rateLimitCache, [normalized.kind]: normalized.window };
    broadcastAll({ kind: 'rateLimits', windows: rateLimitCache });
  },
  onEvent(sessionId: string, event: PersistedEvent): void {
    broadcast(sessionId, { kind: 'event', sessionId, event });
    // Status flips (idle/running/error) should update every client's session
    // list, not just subscribers of this session — e.g. the sidebar tree.
    if (event.event.type === 'status') broadcastAll({ kind: 'sessions_changed' });
  },
  onDelta(sessionId: string, text: string): void {
    broadcast(sessionId, { kind: 'delta', sessionId, text });
  },
  onMetaChanged(): void {
    registry.save();
  },
};

function getSession(id: string): DaemonSession {
  let session = sessions.get(id);
  if (!session) {
    const meta = registry.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    session = new DaemonSession(meta, callbacks);
    sessions.set(id, session);
  }
  return session;
}

function sessionInfo(id: string): SessionInfo {
  const meta = registry.get(id)!;
  const live = sessions.get(id);
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    status: live?.status ?? 'idle',
    permissionMode: meta.permissionMode ?? 'default',
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    eventCount: live?.eventCount ?? 0,
  };
}

function handleRequest(client: Client, req: Request): unknown | Promise<unknown> {
  switch (req.op) {
    case 'hello':
      return {
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        // process.argv[1] is the daemon entry the extension spawned us with.
        // The client checks it still exists: an upgrade that doesn't change
        // the protocol keeps this daemon alive on purpose, but VS Code has by
        // then deleted the versioned extension directory this file — and the
        // bundled SDK, and its native `claude` binary — was loaded from.
        entry: process.argv[1] ?? '',
      } satisfies HelloResult;
    case 'listSessions':
      return registry.list().map((meta) => sessionInfo(meta.id));
    case 'createSession': {
      const meta = registry.create(req.cwd, req.title);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(meta.id);
    }
    case 'attach': {
      const session = getSession(req.sessionId);
      client.attached.add(req.sessionId);
      let subs = subscribers.get(req.sessionId);
      if (!subs) subscribers.set(req.sessionId, (subs = new Set()));
      subs.add(client);
      const limit = req.limit && req.limit > 0 ? req.limit : DEFAULT_REPLAY_LIMIT;
      // eventsSince keeps the newest `limit` itself, so a huge transcript is
      // never materialized just to throw most of it away.
      const { events, hasEarlier } = session.eventsSince(req.sinceSeq, limit);
      return {
        info: sessionInfo(req.sessionId),
        events,
        hasEarlier,
      };
    }
    case 'detach': {
      client.attached.delete(req.sessionId);
      subscribers.get(req.sessionId)?.delete(client);
      return null;
    }
    case 'sendMessage': {
      const session = getSession(req.sessionId);
      session.sendMessage(req.text, req.attachments ?? []);
      registry.touch(req.sessionId);
      return null;
    }
    case 'interrupt': {
      void getSession(req.sessionId).interrupt();
      return null;
    }
    case 'permission': {
      getSession(req.sessionId).resolvePermission(req.requestId, req.allow, req.message, req.answers);
      return null;
    }
    case 'setPermissionMode': {
      void getSession(req.sessionId).setPermissionMode(req.mode);
      return null;
    }
    case 'setSessionOptions': {
      void getSession(req.sessionId).setOptions({ model: req.model, effort: req.effort });
      broadcastAll({ kind: 'sessions_changed' });
      return null;
    }
    case 'renameSession': {
      const title = req.title.trim();
      if (!title) throw new Error('Title cannot be empty');
      registry.rename(req.sessionId, title);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(req.sessionId);
    }
    case 'listModels':
      return modelCache ?? probeModels();
    case 'listRateLimits':
      return rateLimitCache;
    case 'listClaudeSessions':
      return listClaudeSessions();
    case 'importClaudeSession': {
      const meta = importClaudeSession(registry, req.file);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(meta.id);
    }
    case 'deleteSession': {
      void sessions.get(req.sessionId)?.dispose(); // never rejects; nothing to await on
      sessions.delete(req.sessionId);
      subscribers.delete(req.sessionId);
      registry.delete(req.sessionId);
      try {
        fs.unlinkSync(sessionLogPath(req.sessionId));
      } catch {
        // already gone
      }
      broadcastAll({ kind: 'sessions_changed' });
      return null;
    }
    case 'listAccounts':
      return accountsStore.list();
    case 'setAccount': {
      const accounts = accountsStore.setActive(req.configDir);
      // Live queries were launched with the previous account's env (or none);
      // tear them down so the next message spawns fresh under the new one.
      // Sessions and transcripts are untouched — only the in-flight SDK query.
      for (const session of sessions.values()) session.disposeActiveQuery();
      broadcastAll({ kind: 'accounts', accounts });
      broadcastAll({ kind: 'sessions_changed' });
      return accounts;
    }
    default:
      throw new Error(`Unknown op: ${(req as { op: string }).op}`);
  }
}

const clients = new Set<Client>();

function onConnection(socket: net.Socket): void {
  const client: Client = {
    socket,
    attached: new Set(),
    send(message: ServerMessage): void {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    },
  };
  clients.add(client);

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        continue;
      }
      try {
        Promise.resolve(handleRequest(client, req)).then(
          (result) => client.send({ kind: 'response', id: req.id, ok: true, result }),
          (err) =>
            client.send({
              kind: 'response',
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
      } catch (err) {
        client.send({
          kind: 'response',
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  const cleanup = (): void => {
    clients.delete(client);
    for (const sessionId of client.attached) subscribers.get(sessionId)?.delete(client);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/** How long SDK query teardown gets before we exit anyway. */
const SHUTDOWN_GRACE_MS = 2000;

function start(): void {
  if (!acquireLock()) {
    logLine(`daemon already running (pid ${readLock()}), exiting`);
    process.exit(0);
  }
  // The lock is ours, so any socket file still sitting here is stale by
  // definition — no live daemon could have been holding it.
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // wasn't there
  }

  const server = net.createServer(onConnection);
  /** Identifies the socket file we bound, so shutdown doesn't delete someone else's. */
  let boundIno: number | null = null;

  server.on('error', (err) => {
    // Previously unhandled: EADDRINUSE was swallowed by the uncaughtException
    // logger and left this process alive with no listener at all — a zombie
    // that the next client's probe would connect to and then hang against,
    // forever, because requests had no timeout either.
    logLine(`server error, exiting: ${String(err)}`);
    releaseLock();
    process.exit(1);
  });

  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    try {
      boundIno = fs.statSync(socketPath).ino;
    } catch {
      boundIno = null;
    }
    logLine(`daemon listening on ${socketPath} (pid ${process.pid})`);
  });

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    process.exit(0);
  };

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // a second SIGTERM must not re-enter teardown
    shuttingDown = true;
    logLine(`daemon shutting down (${signal})`);
    server.close();
    // Only remove the socket if it is still the one we bound. Unconditional
    // unlink meant a daemon exiting slowly during an upgrade deleted its own
    // *replacement's* socket on the way out, leaving a healthy daemon that
    // nothing could reach and a client stuck reconnecting to nothing.
    try {
      if (boundIno !== null && fs.statSync(socketPath).ino === boundIno) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // already gone
    }
    releaseLock();
    // Give SDK teardown a bounded moment: exiting immediately after dispose()
    // skipped it entirely and orphaned `claude` children on every kill cycle.
    void Promise.allSettled([...sessions.values()].map((s) => s.dispose())).then(finish);
    setTimeout(finish, SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
