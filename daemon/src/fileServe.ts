// GET /file?path=/abs/path -- a file from this machine, for the phone to view.
//
// fsRead pages a file through the protocol, which is right for text but not
// for a video: a player wants to start at once and to jump, and it asks for
// byte ranges to do both. So the gateway also serves files over plain HTTP,
// with Range, behind the same code-server proxy and Authelia login as
// everything else -- read-only, absolute paths, regular files only.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  pdf: 'application/pdf', json: 'application/json', html: 'text/html', htm: 'text/html',
  txt: 'text/plain', md: 'text/plain', log: 'text/plain', csv: 'text/csv',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** One `bytes=a-b` range, clamped to the file; null for none, 'invalid' for one that cannot be served. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export function serveFile(req: http.IncomingMessage, res: http.ServerResponse): void {
  const query = new URL(req.url ?? '/', 'http://x').searchParams;
  const file = query.get('path') ?? '';
  const fail = (status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(message);
  };
  if (!path.isAbsolute(file)) return fail(400, 'path must be absolute');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return fail(404, 'no such file');
  }
  if (!stat.isFile()) return fail(400, 'not a file');
  const headers: Record<string, string | number> = {
    'content-type': contentType(file),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  };
  const range = parseRange(req.headers.range, stat.size);
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  headers['content-length'] = stat.size === 0 ? 0 : end - start + 1;
  if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
