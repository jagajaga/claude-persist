import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accessTokenOf, fetchAccountLimits } from './accountLimits.js';

test('reads windows with percent and reset time from the usage answer, ignoring unknown kinds', async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  const fake = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.authorization });
    return {
      status: 200,
      json: async () => ({
        five_hour: { utilization: 100, resets_at: '2026-11-25T21:59:59.686673+00:00' },
        seven_day: { utilization: 33, resets_at: '2026-11-26T10:59:59+00:00' },
        seven_day_opus: null,
        maple_sundial: { utilization: 5 },
      }),
    };
  };
  const w = await fetchAccountLimits('tok', fake);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal(w?.five_hour?.utilization, 100);
  assert.equal(w?.five_hour?.resetsAt, Date.parse('2026-11-25T21:59:59.686673+00:00'));
  assert.equal(w?.seven_day?.utilization, 33);
  assert.equal(w?.seven_day_opus, undefined);
  assert.equal(Object.keys(w ?? {}).includes('maple_sundial'), false);
});

test('a refused or failed read is no reading, not an empty one', async () => {
  assert.equal(await fetchAccountLimits('t', async () => ({ status: 401, json: async () => ({}) })), null);
  assert.equal(await fetchAccountLimits('t', async () => { throw new Error('offline'); }), null);
});

test('the token comes from the account\'s own credentials; none when never signed in', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lim-'));
  const dir = path.join(home, 'a');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'AT' }, mcpOAuth: {} }));
  assert.equal(accessTokenOf(dir, home), 'AT');
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ mcpOAuth: { x: {} } }));
  assert.equal(accessTokenOf(dir, home), null);
  assert.equal(accessTokenOf(path.join(home, 'none'), home), null);
});
