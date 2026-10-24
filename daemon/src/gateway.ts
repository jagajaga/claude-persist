// The daemon's protocol, over the network, for the Android client.
//
// The daemon itself only listens on a Unix socket, which is right for the
// editor on the same machine and unreachable from a phone. This puts the same
// requests and pushes on a WebSocket, bound to loopback only: the phone gets to
// it through code-server's own proxy (https://<host>/proxy/<port>/), which sits
// behind the owner's Authelia login. Nothing here is exposed beyond what
// code-server already proxies, and no reverse-proxy rule had to change.
//
// Built for a bad network, because that is where a phone lives:
//  - one WebSocket message is one protocol message, compressed;
//  - the server pings every few seconds and drops a client that stops
//    answering, so a dead link is let go of in seconds rather than holding a
//    subscription until TCP finally gives up minutes later;
//  - POST /rpc answers any single request over plain HTTP, for networks where
//    WebSockets keep dying or are filtered outright. With `attach` and a
//    `sinceSeq`, polling it is a complete, if slower, fallback: the daemon's
//    replay-by-sequence means nothing is missed between polls.
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

export interface GatewayHandlers<Handle> {
  /** A client connected. `send` delivers pushes and responses to it. */
  open(send: (message: unknown) => void): Handle;
  /** One request from that client; resolves to its result. */
  request(handle: Handle, req: { id: number; op: string } & Record<string, unknown>): unknown | Promise<unknown>;
  /** The client is gone; forget everything it subscribed to. */
  close(handle: Handle): void;
}

export interface GatewayOptions<Handle> {
  port: number;
  host?: string;
  handlers: GatewayHandlers<Handle>;
  /** How often the server pings; a client missing two in a row is dropped. */
  heartbeatMs?: number;
  /** Largest single message or /rpc body. An image attachment is the big one. */
  maxPayloadBytes?: number;
  log?: (message: string) => void;
}

export interface Gateway {
  port: number;
  /** The address actually bound -- loopback, or something is wrong. */
  address: string;
  close(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_MAX_PAYLOAD = 24 * 1024 * 1024;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startGateway<Handle>(opts: GatewayOptions<Handle>): Promise<Gateway> {
  const host = opts.host ?? '127.0.0.1';
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxPayload = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
  const log = opts.log ?? ((): void => undefined);
  const { handlers } = opts;

  const answer = async (
    handle: Handle,
    raw: unknown,
  ): Promise<{ kind: 'response'; id: number; ok: boolean; result?: unknown; error?: string } | null> => {
    const req = raw as { id?: unknown; op?: unknown } & Record<string, unknown>;
    if (!req || typeof req !== 'object' || typeof req.op !== 'string' || typeof req.id !== 'number') {
      return null;
    }
    try {
      const result = await handlers.request(handle, req as { id: number; op: string });
      return { kind: 'response', id: req.id, ok: true, result };
    } catch (err) {
      return { kind: 'response', id: req.id, ok: false, error: errorText(err) };
    }
  };

  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url.endsWith('/health')) {
      reply(200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.endsWith('/rpc')) {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxPayload) {
          reply(413, { ok: false, error: 'Request too large' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reply(400, { ok: false, error: 'Body is not JSON' });
          return;
        }
        // A throwaway client: pushes have nowhere to go over plain HTTP, and
        // whatever it subscribed to is released the moment it has its answer.
        const handle = handlers.open(() => undefined);
        void answer(handle, body)
          .then((response) => {
            if (response) reply(200, response);
            else reply(400, { ok: false, error: 'Not a request' });
          })
          .finally(() => handlers.close(handle));
      });
      return;
    }
    reply(404, { ok: false, error: 'Not found' });
  });

  const wss = new WebSocketServer({ server, maxPayload, perMessageDeflate: true });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const handle = handlers.open((message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    });
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      void answer(handle, parsed).then((response) => {
        if (response && ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
      });
    });
    let closed = false;
    const done = (): void => {
      if (closed) return;
      closed = true;
      handlers.close(handle);
    };
    ws.on('close', done);
    ws.on('error', done);
  });

  // Dead links are dropped, not waited out: a phone that walked out of
  // coverage never closes its socket, and its subscriptions would otherwise
  // pile up behind TCP's retransmission timeout for many minutes.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        log('gateway: client stopped answering pings; dropping it');
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, heartbeatMs);
  sweep.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      const bound = typeof address === 'object' && address ? address.address : host;
      log(`gateway listening on http://${bound}:${port}`);
      resolve({
        port,
        address: bound,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
