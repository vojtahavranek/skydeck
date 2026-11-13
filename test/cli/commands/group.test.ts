import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1, S2 } from '../../helpers/platform.ts';
import { twoSessions } from '../../helpers/session-files.ts';

refCases('group', 'skydeck group <ref> [<text>]', ['x']);

test('group <ref> <text> stores the group, and the row has it', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['group', '0b5f', 'ABC-9'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e group: ABC-9\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.group, 'ABC-9');
  assert.equal(d.deck.store.meta(S2), null);
  const row = loadRows(d.deck).find((r) => r.id === S1);
  assert.equal(row?.group, 'ABC-9');
  assert.equal(row?.groupSource, 'meta');
});

test('the remaining words are joined with one space', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['group', '0b5f', 'Retry', 'work'], d.ctx), 0);
  assert.equal(d.deck.store.meta(S1)?.group, 'Retry work');
});

test('group <ref> without text clears the group', async (t) => {
  const d = twoSessions(t);
  await main(['group', '0b5f', 'ABC-9'], d.ctx);
  assert.equal(await main(['group', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e group: ABC-9\n0b5f3c1e group cleared\n');
  assert.equal(d.deck.store.meta(S1)?.group, null);
  assert.equal(loadRows(d.deck).find((r) => r.id === S1)?.group, null);
});

test('an empty text, or one of only spaces, clears the group like no text at all', async (t) => {
  const d = twoSessions(t);
  for (const blank of [[''], ['   '], ['', ''], ['\t']]) {
    await main(['group', '0b5f', 'ABC-9'], d.ctx);
    assert.equal(await main(['group', '0b5f', ...blank], d.ctx), 0, JSON.stringify(blank));
    assert.equal(d.deck.store.meta(S1)?.group, null, JSON.stringify(blank));
    assert.ok(d.stdout().endsWith('0b5f3c1e group cleared\n'));
  }
  assert.equal(d.stderr(), '');
});

test('a group may start with "-" (only a label may not)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['group', '0b5f', '--', '-x'], d.ctx), 0);
  assert.equal(d.deck.store.meta(S1)?.group, '-x');
});

test('a group with a control character or a line break is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['group', '0b5f', 'a\x1b]0;x\x07b'], d.ctx), 2);
  assert.equal(d.stderr(), 'skydeck: a group cannot contain control characters\n');
  assert.equal(await main(['group', '0b5f', 'a\nb'], d.ctx), 2);
  assert.match(d.stderr(), /\nskydeck: a group must be one line\n$/);
  assert.equal(d.deck.store.meta(S1), null);
  assert.equal(d.stdout(), '');
});
