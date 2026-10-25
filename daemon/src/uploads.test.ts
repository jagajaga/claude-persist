import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_UPLOAD_BYTES, safeName, uploadChunk } from './uploads.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-uploads-'));
const b64 = (s: string) => Buffer.from(s).toString('base64');
const base = { sessionId: 'sess-1', uploadId: 'up-1', name: 'notes.txt' };

test('chunks join up, and the last one names the finished file', () => {
  const r = root();
  assert.deepEqual(uploadChunk({ ...base, offset: 0, data: b64('hello ') }, r), { received: 6 });
  const done = uploadChunk({ ...base, offset: 6, data: b64('world'), done: true }, r);
  assert.equal(done.received, 11);
  assert.equal(fs.readFileSync(done.path!, 'utf8'), 'hello world');
  assert.equal(path.dirname(done.path!), path.join(r, 'sess-1'));
  assert.match(path.basename(done.path!), /notes\.txt$/);
});

/** The bad-network case: a chunk's answer is lost and the phone sends it again. */
test('a repeated chunk is not written twice; the answer says where to carry on', () => {
  const r = root();
  uploadChunk({ ...base, offset: 0, data: b64('abc') }, r);
  assert.deepEqual(uploadChunk({ ...base, offset: 0, data: b64('abc') }, r), { received: 3 });
  const done = uploadChunk({ ...base, offset: 3, data: b64('def'), done: true }, r);
  assert.equal(fs.readFileSync(done.path!, 'utf8'), 'abcdef');
});

test('a chunk after a gap is refused without writing, so nothing is corrupted', () => {
  const r = root();
  uploadChunk({ ...base, offset: 0, data: b64('abc') }, r);
  assert.deepEqual(uploadChunk({ ...base, offset: 10, data: b64('zzz') }, r), { received: 3 });
});

test('the last chunk sent again after finishing still answers with the file', () => {
  const r = root();
  uploadChunk({ ...base, offset: 0, data: b64('ab') }, r);
  const first = uploadChunk({ ...base, offset: 2, data: b64('cd'), done: true }, r);
  assert.deepEqual(uploadChunk({ ...base, offset: 2, data: b64('cd'), done: true }, r), first);
  assert.equal(fs.readFileSync(first.path!, 'utf8'), 'abcd');
});

test('an upload named to escape its directory is written inside it', () => {
  const r = root();
  const done = uploadChunk({ ...base, name: '../../../evil.sh', offset: 0, data: b64('x'), done: true }, r);
  assert.equal(path.dirname(done.path!), path.join(r, 'sess-1'));
  assert.equal(fs.existsSync(path.join(r, 'evil.sh')), false);
});

test('names cannot climb out of the uploads directory', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..\\..\\x.txt'), 'x.txt');
  assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName(''), 'file');
  assert.throws(() => uploadChunk({ ...base, sessionId: '../x', offset: 0, data: '' }, root()), /session id/);
  assert.throws(() => uploadChunk({ ...base, uploadId: 'a/b', offset: 0, data: '' }, root()), /upload id/);
});

test('a file over the limit is refused and its partial copy removed', () => {
  const r = root();
  const big = Buffer.alloc(1024).toString('base64');
  const over = { ...base, offset: MAX_UPLOAD_BYTES - 512, data: big };
  // Pretend most of it is already there.
  fs.mkdirSync(path.join(r, 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(r, 'sess-1', '.part-up-1'), '');
  fs.truncateSync(path.join(r, 'sess-1', '.part-up-1'), MAX_UPLOAD_BYTES - 512);
  assert.throws(() => uploadChunk(over, r), /larger than/);
  assert.equal(fs.existsSync(path.join(r, 'sess-1', '.part-up-1')), false);
});
