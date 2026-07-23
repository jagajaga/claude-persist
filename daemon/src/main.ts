import net from 'node:net';
import fs from 'node:fs';
import type {
  PersistedEvent,
  Request,
  ServerMessage,
  SessionInfo,
} from '@claude-persist/shared';
import { PROTOCOL_VERSION } from '@claude-persist/shared';
import { ensureDirs, socketPath, sessionLogPath, logPath } from './paths.js';
import { Registry } from './registry.js';
import { DaemonSession } from './session.js';

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

const callbacks = {
  onEvent(sessionId: string, event: PersistedEvent): void {
    broadcast(sessionId, { kind: 'event', sessionId, event });
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
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    eventCount: live?.eventCount ?? 0,
  };
}

function handleRequest(client: Client, req: Request): unknown {
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
      session.sendMessage(req.text);
      registry.touch(req.sessionId);
      return null;
    }
    case 'interrupt': {
      void getSession(req.sessionId).interrupt();
      return null;
    }
    case 'permission': {
      getSession(req.sessionId).resolvePermission(req.requestId, req.allow, req.message);
      return null;
    }
    case 'setPermissionMode': {
      void getSession(req.sessionId).setPermissionMode(req.mode);
      return null;
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
        const result = handleRequest(client, req);
        client.send({ kind: 'response', id: req.id, ok: true, result });
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
