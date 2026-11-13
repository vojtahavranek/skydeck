import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { isListed } from '../../../src/sessions/list.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { refresh } from '../../../src/sessions/refresh.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1, S2, SEC, T0 } from '../../helpers/platform.ts';
import {
  appendRecord,
  startRunning,
  twoSessions,
  userRecord,
} from '../../helpers/session-files.ts';

refCases('done', 'skydeck done <ref>');

const rowOf = (d: ReturnType<typeof twoSessions>, id: string) => {
  const row = loadRows(d.deck).find((r) => r.id === id);
  assert.ok(row, `${id} has a row`);
  return row;
};

test('done <ref> hides the session: not listed, but listed with --all, and marked done', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['done', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e done\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.doneAtNs, T0);
  const row = rowOf(d, S1);
  assert.equal(row.done, true);
  assert.equal(isListed(row, false), false);
  assert.equal(isListed(row, true), true);
  assert.equal(isListed(rowOf(d, S2), false), true, 'the other session is still listed');
});

test('done never stops a running session', async (t) => {
  const d = twoSessions(t);
  startRunning(d, S1, 4242);
  assert.equal(await main(['done', '0b5f'], d.ctx), 0);
  assert.equal(rowOf(d, S1).state, 'working');
  assert.notEqual(d.proc.stat(4242), null);
  assert.deepEqual(d.runner.calls, []);
  assert.deepEqual(d.runner.interactiveCalls, []);
});

test('a done session with a later user record in its transcript is listed again without undone', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['done', '0b5f'], d.ctx), 0);
  assert.equal(isListed(rowOf(d, S1), false), false);

  appendRecord(d, S1, userRecord(S1, T0 + 60n * SEC), T0 + 60n * SEC);
  refresh(d.deck);

  const row = rowOf(d, S1);
  assert.equal(row.done, false);
  assert.equal(isListed(row, false), true);
  assert.equal(d.deck.store.meta(S1)?.doneAtNs, T0, 'the done time itself is not touched');
});

test('done with an extra argument is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['done', '0b5f', 'extra'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: too many arguments\nskydeck done <ref>'), d.stderr());
  assert.equal(d.deck.store.meta(S1), null);
});
