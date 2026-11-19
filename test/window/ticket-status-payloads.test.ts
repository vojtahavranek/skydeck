// Follow-up F19 (T4, T6–T8) in the window's pieces: the row's small `ticketStatus` field (S2
// 8.2.3: there only while a status is known; its bytes with and without), the header's
// `selected.ticketStatus` (times as text), the filter matching the status' text, `act
// ticket-refresh` in the parser, and the actions that ask for a read — a ticket set that a
// provider reads, and ↻ — without waiting for it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ListRow, TicketStatusView } from '../../src/sessions/list.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { setGroup } from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { createActions } from '../../src/window/actions.ts';
import type { PageInfo, TerminalHub } from '../../src/window/hub.ts';
import { parsePageMessage } from '../../src/window/protocol.ts';
import type { ActMessage } from '../../src/window/protocol.ts';
import { selectedPayload } from '../../src/window/selected.ts';
import { matchesWords, searchable, searchWords } from '../../src/window/view/search/filter.ts';
import { rowPayload } from '../../src/window/view/sections.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, T0 } from '../helpers/platform.ts';
import { listRow } from '../helpers/rows.ts';
import { writeTranscript } from '../helpers/session-files.ts';

const TICKET = 'https://tickets.example.com/browse/ABC-123';

function view(over: Partial<TicketStatusView> = {}): TicketStatusView {
  return {
    url: TICKET,
    name: 'ABC-123',
    stored: true,
    status: 'In Progress',
    category: 'doing',
    okAtNs: T0,
    triedAtNs: T0,
    error: null,
    ...over,
  };
}

const NO_TERMINAL = { terminal: null, elsewhere: null };

describe('the row payload (T7)', () => {
  test('a known status is the name, the text and the category; none, never read or never succeeded is null', () => {
    assert.deepEqual(
      rowPayload(listRow({ id: S1, ticketStatus: view() }), NO_TERMINAL).ticketStatus,
      {
        name: 'ABC-123',
        status: 'In Progress',
        category: 'doing',
      },
    );
    for (const ticketStatus of [
      null,
      view({ status: null, category: null, okAtNs: null, triedAtNs: null }),
      view({ status: null, category: null, okAtNs: null, error: 'gh is not installed' }),
    ]) {
      assert.equal(rowPayload(listRow({ id: S1, ticketStatus }), NO_TERMINAL).ticketStatus, null);
    }
    // After a failure the last known status stays on the row.
    assert.equal(
      rowPayload(listRow({ id: S1, ticketStatus: view({ error: 'x' }) }), NO_TERMINAL).ticketStatus
        ?.status,
      'In Progress',
    );
  });

  test('its bytes: 20 without a status; with `ABC-123 · In Progress · doing` 76, with a status of 40 characters 105', (t) => {
    const without = JSON.stringify(rowPayload(listRow({ id: S1 }), NO_TERMINAL));
    const withOne = JSON.stringify(
      rowPayload(listRow({ id: S1, ticketStatus: view() }), NO_TERMINAL),
    );
    const longest = JSON.stringify(
      rowPayload(listRow({ id: S1, ticketStatus: view({ status: 'x'.repeat(40) }) }), NO_TERMINAL),
    );
    const before = without.length - ',"ticketStatus":null'.length;
    t.diagnostic(
      `row: ${before} bytes before F19, ${without.length} without, ${withOne.length} with`,
    );
    assert.equal(without.length - before, 20);
    assert.equal(withOne.length - before, 76);
    assert.equal(longest.length - before, 105);
  });
});

describe('the selected payload (T6)', () => {
  test("the row's ticket status with its times as text; null without one", (t) => {
    const d = testDeck(t);
    const payload = selectedPayload(
      d.deck,
      listRow({ id: S1, ticketStatus: view({ error: 'down' }) }),
    );
    assert.deepEqual(payload.ticketStatus, {
      url: TICKET,
      name: 'ABC-123',
      stored: true,
      status: 'In Progress',
      category: 'doing',
      okAtNs: String(T0),
      triedAtNs: String(T0),
      error: 'down',
    });
    assert.equal(selectedPayload(d.deck, listRow({ id: S1 })).ticketStatus, null);
    const never = selectedPayload(
      d.deck,
      listRow({
        id: S1,
        ticketStatus: view({ status: null, okAtNs: null, triedAtNs: null, stored: false }),
      }),
    ).ticketStatus;
    assert.deepEqual([never?.okAtNs, never?.triedAtNs, never?.stored], [null, null, false]);
  });
});

describe('the filter (T8)', () => {
  test("the window's search matches the status' text", () => {
    const row: ListRow = listRow({ id: S1, ticketStatus: view({ status: 'Waiting for QA' }) });
    assert.ok(searchable(row).fields.includes('waiting for qa'));
    assert.equal(matchesWords(searchable(row), searchWords('for QA')), true);
    assert.equal(matchesWords(searchable(listRow({ id: S2 })), searchWords('for QA')), false);
    const unread = listRow({ id: S2, ticketStatus: view({ status: null }) });
    assert.equal(searchable(unread).fields.length, searchable(listRow({ id: S2 })).fields.length);
  });
});

describe('act ticket-refresh in the parser (T4)', () => {
  test('a session id and nothing more', () => {
    const parsed = parsePageMessage(
      JSON.stringify({ t: 'act', id: 3, kind: 'ticket-refresh', sessionId: S1 }),
    );
    assert.ok(parsed.ok);
    for (const wrong of [
      { t: 'act', id: 3, kind: 'ticket-refresh' },
      { t: 'act', id: 3, kind: 'ticket-refresh', sessionId: 'S1' },
      { t: 'act', id: 3, kind: 'ticket-refresh', sessionId: S1, url: TICKET },
    ]) {
      assert.equal(parsePageMessage(JSON.stringify(wrong)).ok, false, JSON.stringify(wrong));
    }
  });
});

/** Actions on `d` with a hub of no terminal; every read asked for is recorded in `asked`. */
function actions(d: TestDeck, tickets = true) {
  const asked: string[][] = [];
  const told: string[] = [];
  const hub = { list: () => [] } as unknown as TerminalHub;
  const handler = createActions({
    deck: d.deck,
    hub,
    terminalFor: () => {
      throw new Error('no terminal in this test');
    },
    openLink: async () => true,
    log: () => {},
    changed: () => told.push('changed'),
    prs: { fetch: () => {}, refresh: () => {} },
    ...(tickets ? { tickets: { fetch: (urls: readonly string[]) => asked.push([...urls]) } } : {}),
  });
  let id = 0;
  return {
    asked,
    told,
    act: (action: Record<string, unknown>) =>
      handler.act({} as PageInfo, { t: 'act', id: ++id, ...action } as ActMessage),
  };
}

function sessions(t: Parameters<typeof testDeck>[0]): TestDeck {
  const d = testDeck(t, {
    config: {
      ticketStatus: [{ match: 'https://tickets.example.com/', command: ['status', '{url}'] }],
      ticketUrl: 'https://tickets.example.com/browse/{key}',
    },
  });
  writeTranscript(d, S1);
  writeTranscript(d, S2);
  refresh(d.deck);
  return d;
}

describe('the actions that ask for a read (T4)', () => {
  test('a ticket set that a provider reads is asked for at once, after the lists were told; others are not', async (t) => {
    const d = sessions(t);
    const a = actions(d);
    assert.equal((await a.act({ kind: 'ticket', sessionId: S1, text: 'ABC-123' })).ok, true);
    assert.deepEqual(a.asked, [[TICKET]]);
    assert.deepEqual(a.told, ['changed']);
    await a.act({ kind: 'ticket', sessionId: S1, text: 'https://github.com/owner/repo/issues/5' });
    assert.deepEqual(a.asked.at(-1), ['https://github.com/owner/repo/issues/5']);
    await a.act({ kind: 'ticket', sessionId: S1, text: 'https://example.com/other' });
    await a.act({ kind: 'ticket', sessionId: S1, text: 'https://github.com/owner/repo/pull/5' });
    await a.act({ kind: 'ticket', sessionId: S1, text: '' });
    assert.equal(a.asked.length, 2, 'no provider, a pull request, removed: nothing asked');
  });

  test("↻ asks for the session's ticket — the one set, else its group's link — and answers ok at once", async (t) => {
    const d = sessions(t);
    const a = actions(d);
    setGroup(d.deck, S2, 'ABC-123');
    assert.deepEqual(await a.act({ kind: 'ticket-refresh', sessionId: S2 }), {
      t: 'result',
      id: 1,
      ok: true,
      lines: [],
      error: null,
      sessionId: null,
    });
    assert.deepEqual(a.asked, [[TICKET]]);
    assert.ok(loadRows(d.deck).some((row) => row.ticketStatus?.url === TICKET));
  });

  test('↻ without a provider for the ticket is refused in words; without the reads, too', async (t) => {
    const d = sessions(t);
    const a = actions(d);
    const result = await a.act({ kind: 'ticket-refresh', sessionId: S1 });
    assert.deepEqual(
      [result.ok, result.error],
      [false, "no status is read for this session's ticket"],
    );
    assert.deepEqual(a.asked, []);
    setGroup(d.deck, S1, 'ABC-123');
    const none = actions(d, false);
    assert.deepEqual(
      [(await none.act({ kind: 'ticket-refresh', sessionId: S1 })).error],
      ['skydeck cannot do that action'],
    );
  });
});
