// `skydeck unpark <ref>` (follow-up F44; design 7.1, 7.5), in the sandbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { isListed } from '../../../src/sessions/list.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1, S2, SEC, T0 } from '../../helpers/platform.ts';
import { startRunning, twoSessions } from '../../helpers/session-files.ts';

refCases('unpark', 'skydeck unpark <ref>');

const rowOf = (d: ReturnType<typeof twoSessions>, id: string) => {
  const row = loadRows(d.deck).find((r) => r.id === id);
  assert.ok(row, `${id} has a row`);
  return row;
};

test('unpark <ref> ends the parking: listed as before, not parked, the other session still parked', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  assert.equal(await main(['park', '1c6a'], d.ctx), 0);
  d.clock.setNs(T0 + 5n * SEC);

  assert.equal(await main(['unpark', '0b5f'], d.ctx), 0);

  assert.equal(d.stdout(), '0b5f3c1e parked\n1c6a4d2f parked\n0b5f3c1e unparked\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.parkedAtNs, null);
  const row = rowOf(d, S1);
  assert.equal(row.parked, false);
  assert.equal(row.done, false);
  assert.equal(isListed(row, false), true);
  assert.equal(rowOf(d, S2).parked, true);
});

test('unpark of a session that is not parked says the same line and changes no mark', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['unpark', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e unparked\n');
  assert.equal(rowOf(d, S1).parked, false);
  assert.equal(d.deck.store.meta(S1)?.parkedAtNs ?? null, null);
  assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
});

test('unpark leaves a done mark alone', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['done', '0b5f'], d.ctx), 0);
  assert.equal(await main(['unpark', '0b5f'], d.ctx), 0);
  assert.equal(rowOf(d, S1).done, true);
  assert.equal(d.deck.store.meta(S1)?.doneAtNs, T0);
});

test('unpark takes a label as its ref', async (t) => {
  const d = twoSessions(t);
  d.deck.store.updateMeta(S2, { label: 'waits for review' }, T0);
  assert.equal(await main(['park', '1c6a'], d.ctx), 0);
  assert.equal(await main(['unpark', 'waits for review'], d.ctx), 0);
  assert.equal(d.stdout(), '1c6a4d2f parked\n1c6a4d2f unparked\n');
  assert.equal(rowOf(d, S2).parked, false);
});

test('unpark never starts or stops a process', async (t) => {
  const d = twoSessions(t);
  startRunning(d, S1, 4242);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  assert.equal(await main(['unpark', '0b5f'], d.ctx), 0);
  assert.equal(rowOf(d, S1).state, 'working');
  assert.notEqual(d.proc.stat(4242), null);
  assert.deepEqual(d.runner.calls, []);
  assert.deepEqual(d.runner.interactiveCalls, []);
});

test('unpark with an extra argument is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['unpark', '0b5f', 'extra'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: too many arguments\nskydeck unpark <ref>'), d.stderr());
  assert.equal(d.deck.store.meta(S1), null);
});
