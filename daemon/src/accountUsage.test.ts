import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountUsageStore } from './accountUsage.js';

const file = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-usage-')), 'u.json');
const windows = (pct: number) => ({ seven_day: { utilization: pct, resetsAt: null, status: 'allowed' } }) as never;

test('a reading is remembered per account', () => {
  const store = new AccountUsageStore(file());
  store.record('/acc/work', windows(20));
  store.record('', windows(80));
  assert.equal(store.get('/acc/work')?.windows.seven_day?.utilization, 20);
  assert.equal(store.get('')?.windows.seven_day?.utilization, 80, 'the default account has its own');
  assert.equal(store.get('/acc/never-seen'), undefined);
});

/** Usage is re-read after every turn; an unchanged one must not redraw the menu. */
test('recording the same reading twice reports no change', () => {
  const store = new AccountUsageStore(file());
  assert.equal(store.record('/acc/work', windows(20)), true);
  assert.equal(store.record('/acc/work', windows(20)), false);
  assert.equal(store.record('/acc/work', windows(21)), true);
});

test('readings survive a daemon restart', () => {
  const f = file();
  new AccountUsageStore(f).record('/acc/work', windows(42), 1000);
  const reloaded = new AccountUsageStore(f);
  assert.equal(reloaded.get('/acc/work')?.windows.seven_day?.utilization, 42);
  assert.equal(reloaded.get('/acc/work')?.at, 1000, 'the age is the point; it has to persist too');
});

test('an unreadable store starts empty rather than failing', () => {
  const f = file();
  fs.writeFileSync(f, 'not json');
  assert.doesNotThrow(() => new AccountUsageStore(f));
  assert.equal(new AccountUsageStore(f).get('/acc/work'), undefined);
});
