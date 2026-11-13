import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1, S2 } from '../../helpers/platform.ts';
import { twoSessions } from '../../helpers/session-files.ts';

refCases('label', 'skydeck label <ref> [<text>]', ['x']);

test('label <ref> <words…> joins the words with one space and stores them', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['label', '0b5f', 'fix', 'the', 'retry'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e label: fix the retry\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.label, 'fix the retry');
  assert.equal(d.deck.store.meta(S2), null, 'no other session is touched');
  const row = loadRows(d.deck).find((r) => r.id === S1);
  assert.equal(row?.title, 'fix the retry');
  assert.equal(row?.titleSource, 'label');
});

test('the label is stored trimmed', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['label', '0b5f', '  padded  '], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e label: padded\n');
  assert.equal(d.deck.store.meta(S1)?.label, 'padded');
});

test('label <ref> without text clears the label', async (t) => {
  const d = twoSessions(t);
  await main(['label', '0b5f', 'fix the retry'], d.ctx);
  assert.equal(await main(['label', '0b5f'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e label: fix the retry\n0b5f3c1e label cleared\n');
  assert.equal(d.deck.store.meta(S1)?.label, null);
});

test("a reference can be the session's label, and the label is replaced", async (t) => {
  const d = twoSessions(t);
  await main(['label', '0b5f', 'work'], d.ctx);
  assert.equal(await main(['label', 'work', 'other'], d.ctx), 0);
  assert.equal(d.deck.store.meta(S1)?.label, 'other');
});

test('an empty text, or one of only spaces, clears the label like no text at all (a script may pass an empty variable)', async (t) => {
  const d = twoSessions(t);
  for (const blank of [[''], ['   '], ['', ''], ['\t']]) {
    await main(['label', '0b5f', 'keep'], d.ctx);
    assert.equal(await main(['label', '0b5f', ...blank], d.ctx), 0, JSON.stringify(blank));
    assert.equal(d.deck.store.meta(S1)?.label, null, JSON.stringify(blank));
    assert.ok(d.stdout().endsWith('0b5f3c1e label cleared\n'));
  }
  assert.equal(d.stderr(), '');
});

test('a label that starts with "-" is a usage error (exit 2) and changes nothing', async (t) => {
  const d = twoSessions(t);
  await main(['label', '0b5f', 'keep'], d.ctx);
  assert.equal(await main(['label', '0b5f', '--', '-x'], d.ctx), 2);
  assert.match(d.stderr(), /^skydeck: a label cannot start with '-'/);
  assert.equal(d.deck.store.meta(S1)?.label, 'keep');
});

test('a label with a control character or a line break is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['label', '0b5f', 'a\x1b[31mb'], d.ctx), 2);
  assert.equal(d.stderr(), 'skydeck: a label cannot contain control characters\n');
  assert.equal(await main(['label', '0b5f', 'a\nb'], d.ctx), 2);
  assert.match(d.stderr(), /\nskydeck: a label must be one line\n$/);
  assert.equal(d.deck.store.meta(S1), null);
  assert.equal(d.stdout(), '');
});
