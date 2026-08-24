import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ACTIVE_MS,
  type AgentActivity,
  activeAgents,
  AGENT_TAG_MAX,
  agentDescription,
  agentTag,
  pruneAgents,
  tasksFromLevelSignal,
} from './agents.js';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');

function agents(entries: Array<[string, number]>): Map<string, AgentActivity> {
  return new Map(
    entries.map(([id, lastActivityAt]) => [id, { id, description: id, lastActivityAt }]),
  );
}

/**
 * The reason this is activity-based at all: every Agent dispatch resolves in
 * 0.0s with "Async agent launched successfully" — 405 real calls in one session,
 * none left outstanding — so counting unresolved tool calls always yields zero.
 * There is no finish event, only evidence of work.
 */
test('activeAgents: counts those that produced something recently', () => {
  const live = activeAgents(agents([['a', NOW - 1_000], ['b', NOW - 5_000]]), NOW);
  assert.deepEqual(live.map((a) => a.id).sort(), ['a', 'b']);
});

test('activeAgents: one that has gone quiet stops counting', () => {
  const live = activeAgents(agents([['a', NOW - 1_000], ['b', NOW - AGENT_ACTIVE_MS - 1]]), NOW);
  assert.deepEqual(live.map((a) => a.id), ['a']);
});

test('activeAgents: nothing running is an empty list, not a zero to render', () => {
  assert.deepEqual(activeAgents(new Map(), NOW), []);
  assert.deepEqual(activeAgents(agents([['a', NOW - AGENT_ACTIVE_MS - 1]]), NOW), []);
});

/** Silence produces no message to react to, so expiry has to be swept. */
test('pruneAgents: drops the expired and reports whether anything changed', () => {
  const map = agents([['a', NOW - 1_000], ['b', NOW - AGENT_ACTIVE_MS - 1]]);
  assert.equal(pruneAgents(map, NOW), true);
  assert.deepEqual([...map.keys()], ['a']);
  assert.equal(pruneAgents(map, NOW), false, 'a second sweep changes nothing');
});

test('agentDescription: prefers the description, then the type, then the prompt', () => {
  assert.equal(agentDescription({ description: 'Review PR 728', prompt: 'long…' }), 'Review PR 728');
  assert.equal(agentDescription({ subagent_type: 'code-reviewer' }), 'code-reviewer');
  assert.equal(agentDescription({ prompt: 'check the migration' }), 'check the migration');
});

test('agentDescription: collapses whitespace and truncates, so the tooltip stays a tooltip', () => {
  const long = agentDescription({ prompt: 'x'.repeat(200) });
  assert.ok(long.length <= 81, `got ${long.length}`);
  assert.ok(long.endsWith('…'));
  assert.equal(agentDescription({ description: '  spread\n  over lines  ' }), 'spread over lines');
});

test('agentDescription: falls back rather than showing an empty chip tooltip', () => {
  assert.equal(agentDescription(undefined), 'subagent');
  assert.equal(agentDescription({}), 'subagent');
  assert.equal(agentDescription({ description: '   ' }), 'subagent');
});

// ------------------------------------------------------ tasksFromLevelSignal

/**
 * The CLI's own live-task set, which is authoritative where the activity
 * heuristic is a guess. It carries REPLACE semantics — swap the whole set — so a
 * missed start/stop edge cannot leave a task showing as running forever, and it
 * carries the task_id that stopTask needs.
 */
test('tasksFromLevelSignal: reads the live set, keeping ids and descriptions', () => {
  const tasks = tasksFromLevelSignal({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 't1', task_type: 'agent', description: 'Review PR 728' },
      { task_id: 't2', task_type: 'bash', description: 'pytest -x' },
    ],
  });
  assert.equal(tasks?.length, 2);
  assert.deepEqual(tasks?.map((t) => t.taskId), ['t1', 't2']);
  assert.deepEqual(tasks?.map((t) => t.kind), ['agent', 'bash']);
  assert.equal(tasks?.[0].description, 'Review PR 728');
  // id doubles as the map key, so it must be the stoppable one.
  assert.equal(tasks?.[0].id, 't1');
});

/** An empty payload means "nothing is running", not "no information". */
test('tasksFromLevelSignal: an empty set is a real answer, not null', () => {
  const tasks = tasksFromLevelSignal({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [],
  });
  assert.deepEqual(tasks, []);
});

test('tasksFromLevelSignal: null for anything that is not the level signal', () => {
  assert.equal(tasksFromLevelSignal({ type: 'assistant' }), null);
  assert.equal(tasksFromLevelSignal({ type: 'system', subtype: 'init' }), null);
  assert.equal(tasksFromLevelSignal({}), null);
});

test('tasksFromLevelSignal: skips entries with no id, since they cannot be stopped', () => {
  const tasks = tasksFromLevelSignal({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_type: 'agent', description: 'no id' }, { task_id: 'ok', description: 'fine' }],
  });
  assert.deepEqual(tasks?.map((t) => t.id), ['ok']);
});

test('tasksFromLevelSignal: survives a malformed payload', () => {
  assert.deepEqual(tasksFromLevelSignal({ type: 'system', subtype: 'background_tasks_changed' }), []);
  const tasks = tasksFromLevelSignal({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [null, 'nope', { task_id: 'x' }],
  });
  assert.deepEqual(tasks?.map((t) => t.description), ['background task']);
});

// ---------------------------------------------------------------------------
// agentTag: the badge beside every message a subagent writes
// ---------------------------------------------------------------------------

test('agentTag: the dispatch description is the badge', () => {
  assert.equal(agentTag('Check daemon logs', 'toolu_01abcd'), 'Check daemon logs');
});

test('agentTag: a long description is clipped to a chip', () => {
  const tag = agentTag('Audit every call site of the rotation planner and report', 'toolu_01abcd');
  assert.ok(tag.length <= AGENT_TAG_MAX, `badge too long: ${tag}`);
  assert.ok(tag.endsWith('…'), 'clipping is visible');
  assert.ok(tag.startsWith('Audit every'), 'and keeps the front, which identifies it');
});

test('agentTag: whitespace is collapsed so the chip stays one line', () => {
  assert.equal(agentTag('review\n  the   diff', 'toolu_01abcd'), 'review the diff');
});

/**
 * Two nameless agents sharing one badge would defeat the point of badging at
 * all — telling apart the several that write into one transcript at once.
 */
test('agentTag: nameless agents fall back to their id, and stay distinct', () => {
  const first = agentTag(undefined, 'toolu_01aaaa');
  const second = agentTag('subagent', 'toolu_01bbbb');
  assert.notEqual(first, second);
  assert.match(first, /^subagent /);
});

test('agentTag: the same agent always gets the same badge', () => {
  assert.equal(agentTag(undefined, 'toolu_01aaaa'), agentTag(undefined, 'toolu_01aaaa'));
});
