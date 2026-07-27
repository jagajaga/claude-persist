import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '@claude-persist/shared';
import { groupSessions, isUnread, reconcileSeen } from './sessionsModel';

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 'id',
  title: 't',
  cwd: '/w/a',
  status: 'idle',
  permissionMode: 'default',
  createdAt: 0,
  lastActivityAt: 0,
  eventCount: 0,
  ...over,
});

test('isUnread: completed session with newer activity than seen', () => {
  const s = session({ id: 's1', lastActivityAt: 100 });
  assert.equal(isUnread(s, { s1: 50 }), true);
  assert.equal(isUnread(s, { s1: 100 }), false);
});

test('isUnread: errored turns count as completed', () => {
  const s = session({ id: 's1', status: 'error', lastActivityAt: 100 });
  assert.equal(isUnread(s, { s1: 50 }), true);
});

test('isUnread: running sessions never count', () => {
  const s = session({ id: 's1', status: 'running', lastActivityAt: 100 });
  assert.equal(isUnread(s, { s1: 50 }), false);
});

test('isUnread: unknown sessions are treated as seen', () => {
  assert.equal(isUnread(session({ id: 's1', lastActivityAt: 100 }), {}), false);
});

test('reconcileSeen: initializes new sessions as seen, prunes deleted', () => {
  const sessions = [
    session({ id: 'a', lastActivityAt: 10 }),
    session({ id: 'b', lastActivityAt: 20 }),
  ];
  assert.deepEqual(reconcileSeen(sessions, { a: 5, gone: 1 }), { a: 5, b: 20 });
});

test('reconcileSeen: returns null when nothing changed', () => {
  assert.equal(reconcileSeen([session({ id: 'a' })], { a: 5 }), null);
});

test('groupSessions: groups by cwd (trailing slash normalized), sessions newest-first', () => {
  const groups = groupSessions(
    [
      session({ id: '1', cwd: '/w/a', lastActivityAt: 10 }),
      session({ id: '2', cwd: '/w/b', lastActivityAt: 30 }),
      session({ id: '3', cwd: '/w/a/', lastActivityAt: 20 }),
    ],
    [],
    {},
  );
  assert.deepEqual(groups.map((g) => g.cwd), ['/w/b', '/w/a']);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['3', '1']);
});

test('groupSessions: current workspace pinned first despite older activity', () => {
  const groups = groupSessions(
    [
      session({ id: '1', cwd: '/w/old', lastActivityAt: 10 }),
      session({ id: '2', cwd: '/w/new', lastActivityAt: 99 }),
    ],
    ['/w/old'],
    {},
  );
  assert.deepEqual(groups.map((g) => g.cwd), ['/w/old', '/w/new']);
  assert.equal(groups[0].isCurrent, true);
  assert.equal(groups[1].isCurrent, false);
});

test('groupSessions: hasUnread set when any session in the group is unread', () => {
  const groups = groupSessions(
    [
      session({ id: '1', cwd: '/w/a', lastActivityAt: 100 }),
      session({ id: '2', cwd: '/w/a', lastActivityAt: 5 }),
    ],
    [],
    { 1: 50, 2: 5 },
  );
  assert.equal(groups[0].hasUnread, true);
});
