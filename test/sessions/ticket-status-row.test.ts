// Follow-up F19 (T1, T6–T8): a row's ticket status. A session's ticket is the stored one (F18),
// else the address its group gives through ticketUrl; it has a status view exactly when a provider
// takes that address — with the cached row of that address when there is one (every session that
// shares the address shares the row), else empty (never tried). The filter matches the status'
// text; nothing about a row without a provider changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TicketStatusRule } from '../../src/platform/config.ts';
import { matchesFilter } from '../../src/sessions/list.ts';
import type { TicketStatusRow } from '../../src/store/types.ts';
import { ds, meta, rowOf, rows } from '../helpers/derived.ts';
import { S1, S2, T0 } from '../helpers/platform.ts';

const RULE: TicketStatusRule = {
  match: 'https://tickets.example.com/browse/',
  command: ['/home/u/bin/status', '{key}'],
};
const TICKET = 'https://tickets.example.com/browse/ABC-123';
const TICKET_URL = 'https://tickets.example.com/browse/{key}';

function cached(url: string, over: Partial<TicketStatusRow> = {}): TicketStatusRow {
  return {
    url,
    status: 'In Progress',
    category: 'doing',
    okAtNs: T0,
    triedAtNs: T0,
    error: null,
    ...over,
  };
}

test('a stored ticket a rule takes has the cached status of its address', () => {
  const row = rowOf(ds({ id: S1 }), {
    metas: [meta(S1, { ticket: TICKET })],
    ticketStatus: { rules: [RULE], rows: [cached(TICKET)] },
  });
  assert.deepEqual(row.ticketStatus, {
    url: TICKET,
    name: 'ABC-123',
    stored: true,
    status: 'In Progress',
    category: 'doing',
    okAtNs: T0,
    triedAtNs: T0,
    error: null,
  });
});

test('never tried: the view is there with nothing known; without a provider there is none', () => {
  const metas = [meta(S1, { ticket: TICKET })];
  assert.deepEqual(
    rowOf(ds({ id: S1 }), { metas, ticketStatus: { rules: [RULE], rows: [] } }).ticketStatus,
    {
      url: TICKET,
      name: 'ABC-123',
      stored: true,
      status: null,
      category: null,
      okAtNs: null,
      triedAtNs: null,
      error: null,
    },
  );
  // No rule takes it (and it is no GitHub issue): no status, also with a cached row of it.
  assert.equal(
    rowOf(ds({ id: S1 }), { metas, ticketStatus: { rules: [], rows: [cached(TICKET)] } })
      .ticketStatus,
    null,
  );
  // Without the input at all (a caller of F18's), and without a ticket.
  assert.equal(rowOf(ds({ id: S1 }), { metas }).ticketStatus, null);
  assert.equal(
    rowOf(ds({ id: S1 }), { ticketStatus: { rules: [RULE], rows: [] } }).ticketStatus,
    null,
  );
});

test("a ticket from the title's key, through ticketUrl, has a status too; the stored ticket wins", () => {
  const session = ds({ id: S1, transcript: { aiTitle: 'ABC-123 fix the upload' } });
  const fromGroup = rowOf(session, {
    ticketUrl: TICKET_URL,
    ticketStatus: { rules: [RULE], rows: [cached(TICKET, { status: 'Done', category: 'done' })] },
  });
  assert.equal(fromGroup.ticket, null);
  assert.deepEqual(
    [fromGroup.ticketStatus?.url, fromGroup.ticketStatus?.name, fromGroup.ticketStatus?.stored],
    [TICKET, 'ABC-123', false],
  );
  assert.equal(fromGroup.ticketStatus?.status, 'Done');

  const other = 'https://tickets.example.com/browse/XYZ-9';
  const stored = rowOf(session, {
    metas: [meta(S1, { ticket: other })],
    ticketUrl: TICKET_URL,
    ticketStatus: { rules: [RULE], rows: [cached(TICKET)] },
  });
  assert.deepEqual([stored.ticketStatus?.url, stored.ticketStatus?.stored], [other, true]);
  assert.equal(
    stored.ticketStatus?.status,
    null,
    'the group link’s status is not the stored ticket’s',
  );
});

test('a GitHub issue has a status without a rule; a pull request never', () => {
  const issue = 'https://github.com/owner/repo/issues/5';
  const row = rowOf(ds({ id: S1 }), {
    metas: [meta(S1, { ticket: issue })],
    ticketStatus: { rules: [], rows: [cached(issue, { status: 'open' })] },
  });
  assert.deepEqual([row.ticketStatus?.name, row.ticketStatus?.status], ['repo #5', 'open']);
  const pull = 'https://github.com/owner/repo/pull/5';
  assert.equal(
    rowOf(ds({ id: S1 }), {
      metas: [meta(S1, { ticket: pull })],
      ticketStatus: {
        rules: [{ match: 'https://github.com/', command: ['g'] }],
        rows: [cached(pull)],
      },
    }).ticketStatus,
    null,
  );
});

test('two sessions sharing an address share its one cached row', () => {
  const [a, b] = rows([ds({ id: S1 }), ds({ id: S2 })], {
    metas: [meta(S1, { ticket: TICKET }), meta(S2, { ticket: TICKET })],
    ticketStatus: {
      rules: [RULE],
      rows: [cached(TICKET, { status: 'Blocked', category: 'blocked' })],
    },
  });
  assert.equal(a?.ticketStatus?.status, 'Blocked');
  assert.equal(b?.ticketStatus?.status, 'Blocked');
});

test('a first read that failed shows no status, only its words', () => {
  const row = rowOf(ds({ id: S1 }), {
    metas: [meta(S1, { ticket: TICKET })],
    ticketStatus: {
      rules: [RULE],
      rows: [cached(TICKET, { status: null, category: null, okAtNs: null, error: 'down' })],
    },
  });
  assert.deepEqual(
    [row.ticketStatus?.status, row.ticketStatus?.category, row.ticketStatus?.error],
    [null, null, 'down'],
  );
});

test('a failure keeps the last status beside its words; foreign text is sanitised', () => {
  const row = rowOf(ds({ id: S1 }), {
    metas: [meta(S1, { ticket: TICKET })],
    ticketStatus: {
      rules: [RULE],
      rows: [
        cached(TICKET, {
          status: 'In \u001b[31mReview',
          category: 'review',
          okAtNs: T0 - 1n,
          triedAtNs: T0,
          error: 'error:\u0007 the\ttracker',
        }),
      ],
    },
  });
  assert.deepEqual(
    [row.ticketStatus?.status, row.ticketStatus?.error, row.ticketStatus?.okAtNs],
    ['In Review', 'error: the tracker', T0 - 1n],
  );
});

test("matchesFilter: the status' text too", () => {
  const row = rowOf(ds({ id: S1 }), {
    metas: [meta(S1, { ticket: TICKET })],
    ticketStatus: { rules: [RULE], rows: [cached(TICKET, { status: 'Waiting for QA' })] },
  });
  assert.equal(matchesFilter(row, 'for qa'), true);
  assert.equal(matchesFilter(row, 'abc-123'), true);
  assert.equal(matchesFilter(row, 'in progress'), false);
});
