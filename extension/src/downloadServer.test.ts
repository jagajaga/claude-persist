import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DownloadServer, isWithinRoots } from './downloadServer';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-dl-'));
const ZIP = path.join(root, 'blooper-legal-drafts-2026-09-04.zip');
fs.writeFileSync(ZIP, 'PK pretend archive');

function get(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

test('serves a granted file as an attachment, with its name', async () => {
  const server = new DownloadServer(() => [root]);
  const url = await server.grant(ZIP);
  assert.ok(url, 'a file inside the roots should be grantable');
  const res = await get(url);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-disposition']), /attachment/);
  assert.match(
    String(res.headers['content-disposition']),
    /filename="blooper-legal-drafts-2026-09-04\.zip"/,
    'the browser needs the name, or it saves the token as the filename',
  );
  assert.equal(res.body, 'PK pretend archive');
  server.dispose();
});

/**
 * The URL is the whole key, so it must be worth nothing once used: one that
 * ends up in a browser history, a log or a screenshot is already spent.
 */
test('a token works once and then it is dead', async () => {
  const server = new DownloadServer(() => [root]);
  const url = (await server.grant(ZIP)) as string;
  assert.equal((await get(url)).status, 200);
  assert.equal((await get(url)).status, 404, 'the second claim must find nothing');
  server.dispose();
});

test('a token nobody granted is nothing', async () => {
  const server = new DownloadServer(() => [root]);
  const url = (await server.grant(ZIP)) as string;
  const base = url.slice(0, url.lastIndexOf('/'));
  assert.equal((await get(`${base}/madeitup`)).status, 404);
  assert.equal((await get(`${base.replace('/d', '')}/etc/passwd`)).status, 404);
  server.dispose();
});

/**
 * The point of granting at all. The server holds no notion of a path, so the
 * only thing it can serve is a file something already decided to hand out --
 * and that decision is made here, against the roots the panel may read.
 */
test('a file outside the roots is never granted', async () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-other-'));
  const secret = path.join(elsewhere, 'secret.zip');
  fs.writeFileSync(secret, 'not yours');
  const server = new DownloadServer(() => [root]);
  assert.equal(await server.grant(secret), null);
  assert.equal(await server.grant('/etc/passwd'), null);
  assert.equal(
    await server.grant(path.join(root, '..', path.basename(elsewhere), 'secret.zip')),
    null,
    'and not by walking out of a root either',
  );
  server.dispose();
});

test('a directory, a missing file and a relative path are all refused', async () => {
  const server = new DownloadServer(() => [root]);
  assert.equal(await server.grant(root), null, 'a folder is not a file');
  assert.equal(await server.grant(path.join(root, 'nope.zip')), null);
  assert.equal(await server.grant('drafts.zip'), null, 'a relative path has no meaning here');
  server.dispose();
});

test('nothing binds a port until something is granted', async () => {
  const server = new DownloadServer(() => [root]);
  assert.equal(await server.grant('/etc/shadow'), null);
  // A refused grant must not have started anything: a session that never
  // downloads should never open a socket.
  assert.equal((server as unknown as { server: unknown }).server, null);
  server.dispose();
});

test('it listens on loopback only', async () => {
  const server = new DownloadServer(() => [root]);
  const url = (await server.grant(ZIP)) as string;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/d\//, 'binding wider would publish the file');
  server.dispose();
});

// ------------------------------------------------------------- isWithinRoots

test('containment is by path, not by prefix', () => {
  assert.equal(isWithinRoots('/home/me/a.zip', ['/home/me']), true);
  assert.equal(isWithinRoots('/home/me/deep/a.zip', ['/home/me']), true);
  // The trap a naive startsWith() falls into: a sibling sharing a prefix.
  assert.equal(isWithinRoots('/home/mean/a.zip', ['/home/me']), false);
  assert.equal(isWithinRoots('/home/me/../elsewhere/a.zip', ['/home/me']), false);
  assert.equal(isWithinRoots('/home/me', ['/home/me']), false, 'the root is not a file in itself');
});
