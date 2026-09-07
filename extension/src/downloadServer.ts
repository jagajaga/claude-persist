// Handing a file to the browser, which the panel cannot do itself.
//
// A webview runs in an iframe sandboxed `allow-scripts allow-same-origin`. That
// set has no `allow-downloads`, so an <a download> inside it does nothing at
// all -- no error, no console message, no file. Fetching the bytes and building
// a blob does not help: the blocked step is the download, not the reading.
//
// So the bytes are served instead. This binds a loopback HTTP server, hands out
// a single-use token per file, and the extension turns that into a URL the
// browser can reach (code-server proxies loopback ports, and passes
// Content-Disposition through untouched). The workbench opens it; the workbench
// is not sandboxed, so the download happens there.
//
// What keeps this from being a hole in the machine: nothing is served that was
// not granted, a grant is minted only for a file inside the same roots the
// webview may already read, tokens are 256 bits and single-use, and they expire
// in five minutes whether used or not.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Long enough to survive a slow tap, short enough that a leaked URL is stale. */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

interface Grant {
  file: string;
  name: string;
  expiresAt: number;
}

/**
 * Is this file one we may hand out?
 *
 * The roots are the same ones the webview is already allowed to read from, so
 * this grants nothing that was not already reachable -- it only changes how it
 * arrives. Both spellings of a path are checked because a workspace reached
 * through a symlink (code-server's /home/coder/code-workspace) resolves to a
 * different string than the one the user sees.
 */
export function isWithinRoots(file: string, roots: string[]): boolean {
  const candidates = new Set([path.resolve(file)]);
  try {
    candidates.add(fs.realpathSync(file));
  } catch {
    // Does not exist, or is not readable from here; the literal form still gets
    // its check, and the stat below is what actually refuses it.
  }
  return [...candidates].some((candidate) =>
    roots.some((root) => {
      const from = path.resolve(root);
      const rel = path.relative(from, candidate);
      // Empty means the file *is* the root; ".." means it escaped it.
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    }),
  );
}

export class DownloadServer {
  private server: http.Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly roots: () => string[]) {}

  /**
   * A path the browser can fetch this file from once, or null if it may not.
   *
   * Refusing here rather than at request time keeps the server itself
   * incapable of serving anything it was not told about: a token is the only
   * key, and there is no path in the URL to tamper with.
   */
  async grant(file: string): Promise<string | null> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    if (!path.isAbsolute(file)) return null;
    if (!isWithinRoots(file, this.roots())) return null;

    this.sweep();
    const token = crypto.randomBytes(32).toString('base64url');
    this.grants.set(token, {
      file,
      name: path.basename(file),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    const port = await this.start();
    return `http://127.0.0.1:${port}/d/${token}`;
  }

  /** Bind on first use: a session that never downloads never opens a port. */
  private start(): Promise<number> {
    if (this.listening) return this.listening;
    this.listening = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.serve(req, res));
      server.on('error', reject);
      // Loopback only. The browser reaches it through code-server's proxy,
      // which runs on this same host; binding wider would publish it.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address === 'string' || address === null) {
          reject(new Error('download server did not get a port'));
          return;
        }
        this.server = server;
        resolve(address.port);
      });
      server.unref();
    });
    return this.listening;
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    const notFound = (): void => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    };
    const token = /^\/d\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')?.[1];
    if (token === undefined) {
      notFound();
      return;
    }
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt < Date.now()) {
      this.grants.delete(token);
      notFound();
      return;
    }
    // Single use: the URL is dead the moment it has been claimed, so one that
    // ends up in a log or a history is worth nothing.
    this.grants.delete(token);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(grant.file);
    } catch {
      notFound();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(stat.size),
      // Both spellings: the plain one for old clients, the encoded one so a
      // name with a space or a non-ASCII character survives.
      'content-disposition':
        `attachment; filename="${grant.name.replace(/["\\]/g, '_')}"; ` +
        `filename*=UTF-8''${encodeURIComponent(grant.name)}`,
      // Nothing here is worth keeping: the URL will not work twice.
      'cache-control': 'no-store',
    });
    // Streamed, so a large archive costs a buffer rather than its own size in
    // memory -- which is what ruled out doing this in the webview.
    fs.createReadStream(grant.file).pipe(res);
  }

  /** Forget grants nobody claimed. */
  private sweep(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(token);
    }
  }

  dispose(): void {
    this.grants.clear();
    this.server?.close();
    this.server = null;
    this.listening = null;
  }
}
