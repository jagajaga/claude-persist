import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenIncidents, incidentNotice, pickWorst } from './statusPage.js';

/** The real incident that killed a session for three hours, as the page served it. */
const REAL = {
  id: 'abc123',
  name: 'Elevated errors for multiple models',
  impact: 'major',
  created_at: '2026-09-03T13:26:04.201Z',
  status: 'investigating',
};

function answering(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

test('reads the open incidents off the page', async () => {
  const got = await fetchOpenIncidents(answering({ incidents: [REAL] }));
  assert.deepEqual(got, [
    {
      id: 'abc123',
      name: 'Elevated errors for multiple models',
      impact: 'major',
      startedAt: '2026-09-03T13:26:04.201Z',
    },
  ]);
});

test('an empty list is an answer: nothing is open', async () => {
  const got = await fetchOpenIncidents(answering({ incidents: [] }));
  assert.deepEqual(got, [], 'this is "all clear", not "unknown"');
});

/**
 * The distinction the whole design rests on. A page that will not answer must
 * never read as recovery: that would resume a turn into an outage still running
 * and tell the user it had cleared.
 */
test('a page that will not answer is null, not all-clear', async () => {
  const thrown = (async () => {
    throw new Error('ENOTFOUND');
  }) as unknown as typeof fetch;
  assert.equal(await fetchOpenIncidents(thrown), null, 'unreachable');
  assert.equal(await fetchOpenIncidents(answering({ incidents: [] }, false)), null, 'HTTP 500');
  assert.equal(await fetchOpenIncidents(answering('<html>nope</html>')), null, 'not JSON');
  assert.equal(await fetchOpenIncidents(answering({})), null, 'no incidents key');
});

test('an entry with nothing to say is dropped, not guessed at', async () => {
  const got = await fetchOpenIncidents(answering({ incidents: [{ impact: 'major' }, REAL] }));
  assert.equal(got?.length, 1, 'an incident with no id or name is unusable');
});

test('the notice names the incident, its grade and when it started', () => {
  const notice = incidentNotice([
    { id: 'a', name: 'Elevated errors for multiple models', impact: 'major', startedAt: REAL.created_at },
  ]);
  assert.equal(
    notice,
    'Anthropic reports: "Elevated errors for multiple models" (major), since 13:26 UTC.',
  );
});

test('nothing open, nothing to say', () => {
  assert.equal(incidentNotice([]), null);
});

/** A real outage often runs alongside an unrelated minor one; listing both buries it. */
test('the worst incident is the one reported', () => {
  const worst = pickWorst([
    { id: 'a', name: 'Delays in credit purchases', impact: 'minor', startedAt: '' },
    { id: 'b', name: 'Elevated errors', impact: 'critical', startedAt: '' },
    { id: 'c', name: 'Something', impact: 'major', startedAt: '' },
  ]);
  assert.equal(worst?.impact, 'critical');
});

test('an unparseable start time is left out rather than printed raw', () => {
  const notice = incidentNotice([{ id: 'a', name: 'Elevated errors', impact: 'major', startedAt: 'soon' }]);
  assert.equal(notice, 'Anthropic reports: "Elevated errors" (major).');
});
