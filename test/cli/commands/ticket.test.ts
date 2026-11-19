// `skydeck ticket set <ref> <link-or-key>` and `skydeck ticket clear <ref>` (follow-up F18, K7):
// the session's ticket from the command line, in the pattern of `skydeck group`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { TICKET_REFUSALS } from '../../../src/sessions/ticket.ts';
import { testContext } from '../../helpers/context.ts';
import { S1, S2 } from '../../helpers/platform.ts';
import { twoSessions } from '../../helpers/session-files.ts';

const USAGE = 'skydeck ticket set <ref> <link-or-key> | ticket clear <ref>';

test('ticket --help prints its usage and exits 0', async () => {
  const c = testContext();
  assert.equal(await main(['ticket', '--help'], c.ctx), 0);
  assert.ok(c.stdout().startsWith(USAGE), c.stdout());
  assert.equal(c.stderr(), '');
});

test('ticket set <ref> <link> stores the address, and the row has it with its name', async (t) => {
  const d = twoSessions(t);
  assert.equal(
    await main(['ticket', 'set', '0b5f', 'https://github.com/owner/repo/issues/5'], d.ctx),
    0,
  );
  assert.equal(d.stdout(), '0b5f3c1e ticket: https://github.com/owner/repo/issues/5\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.ticket, 'https://github.com/owner/repo/issues/5');
  assert.equal(d.deck.store.meta(S2), null);
  assert.deepEqual(loadRows(d.deck).find((row) => row.id === S1)?.ticket, {
    url: 'https://github.com/owner/repo/issues/5',
    text: 'repo #5',
  });
});

test('ticket set <ref> <key> fills ticketUrl and stores that address', async (t) => {
  const d = twoSessions(t, { config: { ticketUrl: 'https://example.com/browse/{key}' } });
  assert.equal(await main(['ticket', 'set', '0b5f', 'ABC-123'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e ticket: https://example.com/browse/ABC-123\n');
  assert.equal(d.deck.store.meta(S1)?.ticket, 'https://example.com/browse/ABC-123');
});

test('ticket set replaces the ticket before', async (t) => {
  const d = twoSessions(t);
  await main(['ticket', 'set', '0b5f', 'https://example.com/browse/ABC-1'], d.ctx);
  assert.equal(await main(['ticket', 'set', '0b5f', 'https://example.com/browse/ABC-2'], d.ctx), 0);
  assert.equal(d.deck.store.meta(S1)?.ticket, 'https://example.com/browse/ABC-2');
});

test('ticket clear <ref> removes it, and so does set with an empty text', async (t) => {
  const d = twoSessions(t);
  await main(['ticket', 'set', '0b5f', 'https://example.com/browse/ABC-1'], d.ctx);
  assert.equal(await main(['ticket', 'clear', '0b5f'], d.ctx), 0);
  assert.ok(d.stdout().endsWith('0b5f3c1e ticket cleared\n'), d.stdout());
  assert.equal(d.deck.store.meta(S1)?.ticket, null);
  await main(['ticket', 'set', '0b5f', 'https://example.com/browse/ABC-1'], d.ctx);
  assert.equal(await main(['ticket', 'set', '0b5f', ''], d.ctx), 0);
  assert.ok(d.stdout().endsWith('0b5f3c1e ticket cleared\n'), d.stdout());
  assert.equal(d.deck.store.meta(S1)?.ticket, null);
  assert.equal(d.stderr(), '');
});

test('a refused text is a usage error (exit 2) with its words; nothing is written', async (t) => {
  const d = twoSessions(t);
  const cases: [string, string][] = [
    ['ABC-123', TICKET_REFUSALS.keyWithoutTicketUrl],
    ['javascript:alert(1)', TICKET_REFUSALS.notHttp],
    ['https://example.com/a\x1b[31mb', TICKET_REFUSALS.control],
    ['not a link', TICKET_REFUSALS.notATicket],
  ];
  for (const [text, words] of cases) {
    const before = d.stderr().length;
    assert.equal(await main(['ticket', 'set', '0b5f', text], d.ctx), 2, JSON.stringify(text));
    assert.equal(d.stderr().slice(before), `skydeck: ${words}\n`);
  }
  assert.equal(d.deck.store.meta(S1), null);
  assert.equal(d.stdout(), '');
});

test('the words are checked before the reference: a refused text is exit 2 whatever <ref> is', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['ticket', 'set', 'nope1234', 'javascript:x'], d.ctx), 2);
  assert.equal(d.stderr(), `skydeck: ${TICKET_REFUSALS.notHttp}\n`);
});

test('a reference that matches nothing exits 3 and changes nothing', async (t) => {
  const d = twoSessions(t);
  for (const words of [
    ['set', 'nope1234', 'https://example.com/x'],
    ['clear', 'nope1234'],
  ]) {
    const before = d.stderr().length;
    assert.equal(await main(['ticket', ...words], d.ctx), 3, words.join(' '));
    assert.equal(d.stderr().slice(before), "skydeck: no session matches 'nope1234'\n");
  }
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.equal(d.stdout(), '');
});

test('a missing argument, one too many, or another subcommand is a usage error that shows the usage', async (t) => {
  const d = twoSessions(t);
  for (const words of [
    [],
    ['set'],
    ['set', '0b5f'],
    ['set', '0b5f', 'https://example.com/x', 'more'],
    ['clear'],
    ['clear', '0b5f', 'more'],
    ['add', '0b5f', 'https://example.com/x'],
  ]) {
    const before = d.stderr().length;
    assert.equal(await main(['ticket', ...words], d.ctx), 2, words.join(' '));
    assert.ok(d.stderr().slice(before).includes(USAGE), d.stderr().slice(before));
  }
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.equal(d.stdout(), '');
});
