import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelDescriptor,
  PersistedEvent,
  Request,
  ServerMessage,
  SessionInfo,
} from '@claude-persist/shared';
import { PROTOCOL_VERSION } from '@claude-persist/shared';
import { ensureDirs, socketPath, sessionLogPath, logPath } from './paths.js';
import { Registry } from './registry.js';
import { DaemonSession } from './session.js';
import { importClaudeSession, listClaudeSessions } from './importer.js';

ensureDirs();
const log = fs.createWriteStream(logPath, { flags: 'a' });
function logLine(text: string): void {
  log.write(`${new Date().toISOString()} ${text}\n`);
}

const registry = new Registry();
registry.load();

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

const callbacks = {
  onModels(models: unknown[]): void {
    cacheModels(models);
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
  onWorkspace(sessionId: string, cwd: string, worktrees: number): void {
    broadcast(sessionId, { kind: 'workspace', sessionId, cwd, worktrees });
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
    // Only when it has actually moved, so a client can tell "never left" from
    // "moved back".
    ...(live && live.workingDir !== meta.cwd ? { effectiveCwd: live.workingDir } : {}),
    ...(live?.worktreeCount ? { activeWorktrees: live.worktreeCount } : {}),
  };
}

function handleRequest(client: Client, req: Request): unknown | Promise<unknown> {
  switch (req.op) {
    case 'hello':
      return { protocolVersion: PROTOCOL_VERSION, pid: process.pid };
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
      return { info: sessionInfo(req.sessionId), events: session.eventsSince(req.sinceSeq) };
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
    case 'listClaudeSessions':
      return listClaudeSessions();
    case 'importClaudeSession': {
      const meta = importClaudeSession(registry, req.file);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(meta.id);
    }
    case 'deleteSession': {
      sessions.get(req.sessionId)?.dispose();
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

function start(): void {
  // Single-instance guard: if a live daemon already owns the socket, exit;
  // if the socket file is stale (previous daemon died), remove it.
  const probe = net.connect(socketPath);
  probe.once('connect', () => {
    probe.destroy();
    logLine('daemon already running, exiting');
    process.exit(0);
  });
  probe.once('error', () => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // did not exist
    }
    const server = net.createServer(onConnection);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      logLine(`daemon listening on ${socketPath} (pid ${process.pid})`);
    });
    const shutdown = (): void => {
      logLine('daemon shutting down');
      for (const session of sessions.values()) session.dispose();
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

process.on('uncaughtException', (err) => logLine(`uncaught: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => logLine(`unhandled rejection: ${String(err)}`));

start();
