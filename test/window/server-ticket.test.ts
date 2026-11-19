// Follow-up F18 end to end on the server (S2 12.5, 8.2.3; K6, K8): the ticket set from one page
// through `act ticket`, replaced and removed; every page's `list.selected` learns it; each refusal
// in readTicket's words; a message of the wrong shape closes the page and stores nothing; the
// value is there for a server started again. In the test process on realTestPlatform.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TICKET_REFUSALS } from '../../src/sessions/ticket.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { S1 } from '../helpers/platform.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const JIRA = 'https://example.com/browse/{key}';

/** A page of `server` with S1 selected, once its list carries S1's `selected`; and that list. */
async function pageOnS1(
  t: Parameters<typeof serverSandbox>[0],
  d: ServerSandbox,
  server: TestServer['server'],
): Promise<{ page: TestPage; list: ListMessage }> {
  const page = await connectTestPage(t, d, server, { view: { selected: S1 } });
  const list = await page.list((candidate) => candidate.selected?.sessionId === S1, 'S1 selected');
  return { page, list };
}

describe('the ticket in the window (F18)', () => {
  test("set from page A by a link: in page B's selected, and in the store; replaced; removed", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const { page: a, list } = await pageOnS1(t, d, test.server);
    const { page: b } = await pageOnS1(t, d, test.server);
    assert.equal(list.selected?.ticket, null);
    assert.equal(list.selected?.ticketKeys, false);

    const set = await a.act({
      kind: 'ticket',
      sessionId: S1,
      text: 'https://github.com/owner/repo/issues/5',
    });
    assert.deepEqual([set.ok, set.lines, set.error], [true, [], null]);
    await b.list(
      (later) =>
        later.selected?.ticket?.url === 'https://github.com/owner/repo/issues/5' &&
        later.selected.ticket.text === 'repo #5',
      'the ticket in B',
    );
    assert.equal(d.deck.store.meta(S1)?.ticket, 'https://github.com/owner/repo/issues/5');

    const replaced = await b.act({
      kind: 'ticket',
      sessionId: S1,
      text: 'https://example.com/tickets/fix-the-upload',
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    await a.list(
      (later) => later.selected?.ticket?.text === 'fix-the-upload',
      'the replaced ticket in A',
    );

    const removed = await a.act({ kind: 'ticket', sessionId: S1, text: '' });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    await b.list((later) => later.selected?.ticket === null, 'no ticket in B');
    assert.equal(d.deck.store.meta(S1)?.ticket, null);
  });

  test('with ticketUrl a bare key sets the filled address; selected.ticketKeys is true', async (t) => {
    const d = serverSandbox(t, { config: { ticketUrl: JIRA } });
    d.resumable(S1);
    const test = await d.start();
    const { page, list } = await pageOnS1(t, d, test.server);
    assert.equal(list.selected?.ticketKeys, true);

    const result = await page.act({ kind: 'ticket', sessionId: S1, text: 'ABC-123' });

    assert.equal(result.ok, true, JSON.stringify(result));
    await page.list(
      (later) =>
        later.selected?.ticket?.url === 'https://example.com/browse/ABC-123' &&
        later.selected.ticket.text === 'ABC-123',
      'the ticket by its key',
    );
    assert.equal(d.deck.store.meta(S1)?.ticket, 'https://example.com/browse/ABC-123');
  });

  test('each refusal is answered in its words; nothing is stored and the page stays connected', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const { page } = await pageOnS1(t, d, test.server);
    const cases: [string, string][] = [
      ['ABC-123', TICKET_REFUSALS.keyWithoutTicketUrl],
      ['javascript:alert(1)', TICKET_REFUSALS.notHttp],
      ['https://example.com/a\nb', TICKET_REFUSALS.lineBreak],
      ['https://example.com/\u001b[31mred', TICKET_REFUSALS.control],
      [`https://example.com/${'a'.repeat(2049)}`, TICKET_REFUSALS.tooLong],
      ['https://someone:secret@example.com/x', TICKET_REFUSALS.credentials],
      ['https://example.com/a?b=\\c', TICKET_REFUSALS.notOpenable],
      ['not a link', TICKET_REFUSALS.notATicket],
    ];
    for (const [text, words] of cases) {
      const result = await page.act({ kind: 'ticket', sessionId: S1, text });
      assert.deepEqual([result.ok, result.lines, result.error], [false, [words], words], text);
    }
    assert.equal(d.deck.store.meta(S1)?.ticket ?? null, null);
  });

  test('a ticket act of a wrong shape closes the page with 1008 and stores nothing', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    for (const wrong of [
      { t: 'act', id: 1, kind: 'ticket', sessionId: S1, url: 'https://example.com/x' },
      { t: 'act', id: 2, kind: 'ticket', sessionId: S1 },
      { t: 'act', id: 3, kind: 'ticket', sessionId: S1, text: 7 },
      { t: 'act', id: 4, kind: 'ticket', sessionId: S1, text: 'ABC-1', base: '' },
      { t: 'act', id: 5, kind: 'ticket', sessionId: 'S1', text: 'https://example.com/x' },
      {
        t: 'act',
        id: 6,
        kind: 'ticket',
        sessionId: S1,
        text: `https://example.com/${'a'.repeat(4097)}`,
      },
    ]) {
      const { page } = await pageOnS1(t, d, test.server);
      page.send(wrong);
      assert.equal((await page.closed).code, 1008, JSON.stringify(wrong).slice(0, 120));
    }
    assert.equal(d.deck.store.meta(S1)?.ticket ?? null, null);
  });

  test('a server started again sends the ticket set before', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const first = await d.start();
    const { page } = await pageOnS1(t, d, first.server);
    const set = await page.act({
      kind: 'ticket',
      sessionId: S1,
      text: 'https://example.com/browse/ABC-123',
    });
    assert.equal(set.ok, true, JSON.stringify(set));

    await first.server.stop('the test restarts it');
    const again = await d.start();
    const { list } = await pageOnS1(t, d, again.server);

    assert.deepEqual(list.selected?.ticket, {
      url: 'https://example.com/browse/ABC-123',
      text: 'ABC-123',
    });
  });
});
