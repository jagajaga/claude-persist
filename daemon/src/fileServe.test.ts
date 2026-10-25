import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentType, parseRange } from './fileServe.js';
import { startGateway } from './gateway.js';

const noHandlers = { open: () => ({}), request: async () => null, close: () => {} };

test('range: the forms a video player sends', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'clamped to the end');
  assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 }, 'the last 30');
  assert.equal(parseRange('bytes=100-', 100), 'invalid', 'past the end');
  assert.equal(parseRange('bytes=5-2', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), 'invalid', 'multipart ranges are not served');
});

test('types: by extension, octet-stream otherwise', () => {
  assert.equal(contentType('/a/clip.MP4'), 'video/mp4');
  assert.equal(contentType('/a/shot.png'), 'image/png');
  assert.equal(contentType('/a/blob'), 'application/octet-stream');
});

async function withFile(body: Buffer, run: (base: string, file: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-file-'));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, body);
  const gw = await startGateway({ port: 0, handlers: noHandlers });
  try {
    await run(`http://127.0.0.1:${gw.port}/proxy/7790`, file);
  } finally {
    await gw.close();
  }
}

test('http: the whole file, typed, under the proxy prefix', async () => {
  await withFile(Buffer.from('0123456789'), async (base, file) => {
    const r = await fetch(`${base}/file?path=${encodeURIComponent(file)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(await r.text(), '0123456789');
  });
});

/** What lets a video start at once and jump: a partial answer with the right bytes. */
test('http: a range is answered with exactly those bytes', async () => {
  await withFile(Buffer.from('0123456789'), async (base, file) => {
    const r = await fetch(`${base}/file?path=${encodeURIComponent(file)}`, { headers: { range: 'bytes=3-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 3-5/10');
    assert.equal(await r.text(), '345');
    const bad = await fetch(`${base}/file?path=${encodeURIComponent(file)}`, { headers: { range: 'bytes=50-' } });
    assert.equal(bad.status, 416);
  });
});

test('http: only absolute paths to regular files', async () => {
  await withFile(Buffer.from('x'), async (base, file) => {
    assert.equal((await fetch(`${base}/file?path=relative.txt`)).status, 400);
    assert.equal((await fetch(`${base}/file?path=${encodeURIComponent(path.dirname(file))}`)).status, 400);
    assert.equal((await fetch(`${base}/file?path=/no/such/file`)).status, 404);
  });
});
