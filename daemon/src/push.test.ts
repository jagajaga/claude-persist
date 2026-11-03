import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersistedEvent } from '@claude-persist/shared';
import { FcmSender, PushTokens, createPush, noticeFor } from './push.js';

const ev = (event: PersistedEvent['event']): PersistedEvent => ({ seq: 1, ts: 0, event });

test('Claude waiting on you is an attention notice naming the tool and what it touches', () => {
  assert.deepEqual(noticeFor('s1', 'blp|deck', ev({ type: 'permission_request', requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf  dist' } })), {
    kind: 'attention',
    sessionId: 's1',
    title: 'blp|deck',
    text: 'Allow Bash? rm -rf dist',
    requestId: 'r1',
  });
  assert.equal(
    noticeFor('s1', '', ev({ type: 'question_request', requestId: 'r2', questions: [{ question: 'Which one?', header: 'h', options: [] }] }))?.text,
    'Which one?',
  );
});

test('a finished turn is quiet and says its first line; an answer takes the notice down; nothing else notifies', () => {
  const done = noticeFor('s1', '', ev({ type: 'result', summary: '\nShipped v2\nmore' }));
  assert.equal(done?.kind, 'done');
  assert.equal(done?.text, 'Shipped v2');
  assert.equal(done?.title, 'Claude');
  assert.equal(noticeFor('s1', 't', ev({ type: 'permission_resolved', requestId: 'r1', allowed: true }))?.kind, 'resolved');
  assert.equal(noticeFor('s1', 't', ev({ type: 'assistant_text', text: 'hi' })), null);
  assert.equal(noticeFor('s1', 't', ev({ type: 'tool_use', toolName: 'Read', input: {} })), null);
});

test('tokens survive a restart and are kept once each', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'push-')), 'tokens.json');
  const a = new PushTokens(file);
  assert.equal(a.add('t1'), true);
  assert.equal(a.add('t1'), false);
  a.add('t2');
  a.remove('t1');
  assert.deepEqual(new PushTokens(file).list(), ['t2']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

function fakeGoogle(sendStatus: number, sendBody = '{}') {
  const calls: Array<{ url: string; body: string; auth?: string }> = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, body: init.body, auth: init.headers.authorization });
    if (url.includes('oauth2')) return { status: 200, text: async () => JSON.stringify({ access_token: 'AT', expires_in: 3600 }) };
    return { status: sendStatus, text: async () => sendBody };
  };
  return { calls, fetchImpl };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { project_id: 'p1', client_email: 'sa@p1.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

test('sends a data message signed in with a verifiable JWT, signing in once', async () => {
  const g = fakeGoogle(200);
  const sender = new FcmSender(account, g.fetchImpl);
  const notice = { kind: 'attention' as const, sessionId: 's1', title: 't', text: 'Allow Bash?', requestId: 'r1' };
  assert.equal(await sender.send('tok', notice), 'sent');
  assert.equal(await sender.send('tok', notice), 'sent');
  assert.equal(g.calls.filter((c) => c.url.includes('oauth2')).length, 1);
  const assertion = new URLSearchParams(g.calls[0].body).get('assertion')!;
  const [h, p, s] = assertion.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).scope, 'https://www.googleapis.com/auth/firebase.messaging');
  const sent = g.calls[1];
  assert.equal(sent.url, 'https://fcm.googleapis.com/v1/projects/p1/messages:send');
  assert.equal(sent.auth, 'Bearer AT');
  const message = JSON.parse(sent.body).message;
  assert.deepEqual(message.data, { kind: 'attention', sessionId: 's1', title: 't', text: 'Allow Bash?', requestId: 'r1' });
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.notification, undefined);
});

test('a phone Google no longer knows is forgotten; other failures keep it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const tokens = new PushTokens(path.join(dir, 't.json'));
  tokens.add('old');
  const logs: string[] = [];
  const gone = createPush({ sender: new FcmSender(account, fakeGoogle(404, '{"error":{"status":"NOT_FOUND"}}').fetchImpl), tokens, log: (m) => logs.push(m) });
  await gone.onEvent('s1', 't', ev({ type: 'result', summary: 'ok' }));
  assert.deepEqual(tokens.list(), []);
  tokens.add('kept');
  const flaky = createPush({ sender: new FcmSender(account, fakeGoogle(503).fetchImpl), tokens, log: (m) => logs.push(m) });
  await flaky.onEvent('s1', 't', ev({ type: 'result', summary: 'ok' }));
  assert.deepEqual(tokens.list(), ['kept']);
  assert.ok(logs.some((l) => l.includes('503')));
});

test('without a key nothing is sent, and registering says so', async () => {
  const tokens = new PushTokens(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'push-')), 't.json'));
  const push = createPush({ sender: null, tokens, log: () => {} });
  assert.deepEqual(push.register('t1'), { enabled: false });
  await push.onEvent('s1', 't', ev({ type: 'result', summary: 'ok' }));
});

test('a phone hears only the kinds it shows; old token files mean all kinds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify(['legacy']));
  const tokens = new PushTokens(path.join(dir, 't.json'));
  const g = fakeGoogle(200);
  const push = createPush({ sender: new FcmSender(account, g.fetchImpl), tokens, log: () => {} });
  push.register('quiet', ['attention']);
  await push.onEvent('s1', 't', ev({ type: 'result', summary: 'ok' }));
  const to = () => g.calls.filter((c) => c.url.includes('messages:send')).map((c) => JSON.parse(c.body).message.token);
  assert.deepEqual(to(), ['legacy']);
  assert.deepEqual(new PushTokens(path.join(dir, 't.json')).wanting('done'), ['legacy']);
});

test('an answered request is pushed only if its request was', async () => {
  const tokens = new PushTokens(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'push-')), 't.json'));
  const g = fakeGoogle(200);
  const push = createPush({ sender: new FcmSender(account, g.fetchImpl), tokens, log: () => {} });
  push.register('p', ['attention', 'done']);
  const kinds = () => g.calls.filter((c) => c.url.includes('messages:send')).map((c) => JSON.parse(c.body).message.data.kind);
  // Answered in the editor, never announced: no wake-up for it.
  await push.onEvent('s1', 't', ev({ type: 'permission_resolved', requestId: 'r0', allowed: true }));
  assert.deepEqual(kinds(), []);
  await push.onEvent('s1', 't', ev({ type: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {} }));
  await push.onEvent('s1', 't', ev({ type: 'permission_resolved', requestId: 'r1', allowed: true }));
  await push.onEvent('s1', 't', ev({ type: 'permission_resolved', requestId: 'r1', allowed: true }));
  assert.deepEqual(kinds(), ['attention', 'resolved']);
});

