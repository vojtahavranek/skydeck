// `skydeck park <ref>` (follow-up F44; design 7.1, 7.5), in the sandbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { isoFromNs } from '../../../src/platform/time.ts';
import { isListed } from '../../../src/sessions/list.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { markParked } from '../../../src/sessions/meta.ts';
import { refresh } from '../../../src/sessions/refresh.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1, S2, SEC, T0 } from '../../helpers/platform.ts';
import {
  appendRecord,
  startRunning,
  twoSessions,
  userRecord,
} from '../../helpers/session-files.ts';

refCases('park', 'skydeck park <ref>');

const rowOf = (d: ReturnType<typeof twoSessions>, id: string) => {
  const row = loadRows(d.deck).find((r) => r.id === id);
  assert.ok(row, `${id} has a row`);
  return row;
};

test('park --help says that it stays listed, never stops a process, and what ends it', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '--help'], d.ctx), 0);
  const usage = d.stdout().replaceAll('\n', ' ');
  for (const words of [
    'It stays listed',
    'the window lists it under Parked',
    'It never stops a process',
    'once you send it a prompt',
    "'skydeck unpark <ref>'",
    'Parking a session marked done shows it again',
  ]) {
    assert.ok(usage.includes(words), words);
  }
});

test('park <ref> parks the session at the clock time: still listed, marked parked, not done', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e parked\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.parkedAtNs, T0);
  const row = rowOf(d, S1);
  assert.equal(row.parked, true);
  assert.equal(row.done, false);
  assert.equal(isListed(row, false), true, 'it is not hidden');
  assert.equal(rowOf(d, S2).parked, false, 'the other session is not parked');
});

test('park of a session marked done: parked, no longer done, listed without --all', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['done', '0b5f'], d.ctx), 0);
  assert.equal(isListed(rowOf(d, S1), false), false);
  d.clock.setNs(T0 + 5n * SEC);

  assert.equal(await main(['park', '0b5f'], d.ctx), 0);

  const row = rowOf(d, S1);
  assert.equal(row.parked, true);
  assert.equal(row.done, false);
  assert.equal(isListed(row, false), true);
  assert.equal(d.deck.store.meta(S1)?.doneAtNs, null);
  assert.equal(d.deck.store.meta(S1)?.parkedAtNs, T0 + 5n * SEC);
});

test('done of a parked session: done, no longer parked', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  d.clock.setNs(T0 + 5n * SEC);

  assert.equal(await main(['done', '0b5f'], d.ctx), 0);

  const row = rowOf(d, S1);
  assert.equal(row.done, true);
  assert.equal(row.parked, false);
  assert.equal(d.deck.store.meta(S1)?.parkedAtNs, null);
  assert.equal(await main(['undone', '0b5f'], d.ctx), 0);
  assert.equal(rowOf(d, S1).parked, false, 'un-done, it is not parked');
});

test('park twice keeps the time of the first parking, and says the same line', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  const first = d.deck.store.meta(S1);
  d.clock.setNs(T0 + 60n * SEC);

  assert.equal(await main(['park', '0b5f'], d.ctx), 0);

  assert.equal(d.stdout(), '0b5f3c1e parked\n0b5f3c1e parked\n');
  assert.deepEqual(d.deck.store.meta(S1), first, 'nothing written');
});

test('park takes a label as its ref', async (t) => {
  const d = twoSessions(t);
  d.deck.store.updateMeta(S2, { label: 'waits for review' }, T0);
  assert.equal(await main(['park', 'waits for review'], d.ctx), 0);
  assert.equal(d.stdout(), '1c6a4d2f parked\n');
  assert.equal(rowOf(d, S2).parked, true);
  assert.equal(rowOf(d, S1).parked, false);
});

test('park never stops a running session', async (t) => {
  const d = twoSessions(t);
  startRunning(d, S1, 4242);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  const row = rowOf(d, S1);
  assert.equal(row.state, 'working');
  assert.equal(row.parked, true);
  assert.notEqual(d.proc.stat(4242), null);
  assert.deepEqual(d.runner.calls, []);
  assert.deepEqual(d.runner.interactiveCalls, []);
});

test('a parked session with a later prompt in its transcript is no longer parked; the time stays', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);

  appendRecord(d, S1, userRecord(S1, T0 + 60n * SEC), T0 + 60n * SEC);
  refresh(d.deck);

  assert.equal(rowOf(d, S1).parked, false);
  assert.equal(d.deck.store.meta(S1)?.parkedAtNs, T0);
});

test('a parking a prompt ended is parked again: the mark is written anew (true), with the new time, and ls shows it parked', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f'], d.ctx), 0);
  appendRecord(d, S1, userRecord(S1, T0 + 60n * SEC), T0 + 60n * SEC);
  refresh(d.deck);
  const ended = rowOf(d, S1);
  assert.equal(ended.parked, false);
  assert.equal(ended.session.parkedAtNs, T0, 'the stored time of the ended parking stays');
  d.clock.setNs(T0 + 120n * SEC);

  assert.equal(markParked(d.deck, ended), true);

  assert.equal(d.deck.store.meta(S1)?.parkedAtNs, T0 + 120n * SEC);
  assert.equal(rowOf(d, S1).parked, true);
  const printed = d.stdout().length;
  assert.equal(await main(['ls', '--json'], d.ctx), 0);
  const { sessions } = JSON.parse(d.stdout().slice(printed)) as {
    sessions: { id: string; parked: boolean; parkedAt: string | null }[];
  };
  const listed = sessions.find((session) => session.id === S1);
  assert.equal(listed?.parked, true);
  assert.equal(listed?.parkedAt, isoFromNs(T0 + 120n * SEC));
});

test('park with an extra argument is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['park', '0b5f', 'extra'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: too many arguments\nskydeck park <ref>'), d.stderr());
  assert.equal(d.deck.store.meta(S1), null);
});
