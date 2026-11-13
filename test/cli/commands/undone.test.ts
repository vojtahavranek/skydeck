import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { isListed } from '../../../src/sessions/list.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1 } from '../../helpers/platform.ts';
import { twoSessions } from '../../helpers/session-files.ts';

refCases('undone', 'skydeck undone <ref>');

const rowOf = (d: ReturnType<typeof twoSessions>) => {
  const row = loadRows(d.deck).find((r) => r.id === S1);
  assert.ok(row);
  return row;
};

test('undone <ref> shows a done session again', async (t) => {
  const d = twoSessions(t);
  await main(['done', '0b5f'], d.ctx);
  assert.equal(isListed(rowOf(d), false), false);

  assert.equal(await main(['undone', '0b5f'], d.ctx), 0);

  assert.equal(d.stdout(), '0b5f3c1e done\n0b5f3c1e undone\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.doneAtNs, null);
  assert.equal(rowOf(d).done, false);
  assert.equal(isListed(rowOf(d), false), true);
});

test('a done session can be undone by its label (done ones are searched too, D22)', async (t) => {
  const d = twoSessions(t);
  await main(['label', '0b5f', 'work'], d.ctx);
  await main(['done', 'work'], d.ctx);
  assert.equal(isListed(rowOf(d), false), false);

  assert.equal(await main(['undone', 'work'], d.ctx), 0);

  assert.equal(isListed(rowOf(d), false), true);
});

test('undone on a session that is not done changes nothing visible and exits 0', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['undone', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e undone\n');
  assert.equal(isListed(rowOf(d), false), true);
});

test('undone with an extra argument is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['undone', '0b5f', 'extra'], d.ctx), 2);
  assert.ok(d.stderr().startsWith('skydeck: too many arguments\nskydeck undone <ref>'), d.stderr());
});
