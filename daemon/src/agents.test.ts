import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ACTIVE_MS, type AgentActivity, activeAgents, agentDescription, pruneAgents } from './agents.js';

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
