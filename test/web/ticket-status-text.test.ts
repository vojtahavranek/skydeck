// Follow-up F19 (T3, T6, T7, T4): a ticket's status in the page's words. The row's small chip (its
// status cut at 14 characters with `…`, `<name> · <status>` as its tooltip, its category's tint
// word), the header's chip (`<name>` and the status, the address then `<status>, checked <age> ago`
// as its tooltip, after a failure `status not read: <words>` and the last known status; a ticket
// from the group only once a status is known or was tried) and the dialog's line beside ↻.
// node:test on web/list-text.js and web/header-text.js, which use no DOM and no clock.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  RowPayload,
  SelectedPayload,
  TicketStatusPayload,
} from '../../src/window/protocol.ts';
import { ticketHeader, ticketStatusLine } from '../../web/header-text.js';
import { knownCategory, ROW_STATUS_LENGTH, rowText } from '../../web/list-text.js';

const SEC = 1_000_000_000n;
const NOW = 1_794_474_000_000_000_000n;
const NOW_NS = String(NOW);
const ago = (seconds: bigint): string => String(NOW - seconds * SEC);
const URL = 'https://tickets.example.com/browse/ABC-123';

function row(over: Partial<RowPayload> = {}): RowPayload {
  return {
    id: '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d',
    shortId: '0b5f3c1e',
    title: 'a title',
    titleSource: 'generated',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: NOW_NS,
    lastActivityNs: NOW_NS,
    dir: null,
    marks: [],
    hasNote: false,
    noteHead: [],
    done: false,
    prs: [],
    chip: null,
    terminal: null,
    slot: null,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
    ...over,
  };
}

function status(over: Partial<TicketStatusPayload> = {}): TicketStatusPayload {
  return {
    url: URL,
    name: 'ABC-123',
    stored: true,
    status: 'In Progress',
    category: 'doing',
    okAtNs: ago(180n),
    triedAtNs: ago(180n),
    error: null,
    ...over,
  };
}

function selected(over: Partial<SelectedPayload> = {}): SelectedPayload {
  return {
    sessionId: '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d',
    command: null,
    flagsKnown: true,
    unknownFlags: [],
    launchFlags: [],
    ended: null,
    expiring: false,
    expired: false,
    note: null,
    noteTooLong: false,
    ticketUrl: null,
    ticket: { url: URL, text: 'ABC-123' },
    ticketKeys: true,
    ticketStatus: status(),
    ...over,
  };
}

describe("the row's ticket chip (T7)", () => {
  test('the status, its tooltip and its category; none without a status', () => {
    assert.deepEqual(
      rowText(
        row({ ticketStatus: { name: 'ABC-123', status: 'In Review', category: 'review' } }),
        NOW_NS,
        null,
      ).ticket,
      { text: 'In Review', tip: 'ABC-123 · In Review', category: 'review' },
    );
    assert.equal(rowText(row(), NOW_NS, null).ticket, null, 'a row of a server before F19');
    assert.equal(rowText(row({ ticketStatus: null }), NOW_NS, null).ticket, null);
    assert.equal(
      rowText(
        row({ ticketStatus: { name: 'x', status: ' \u001b[0m ', category: null } }),
        NOW_NS,
        null,
      ).ticket,
      null,
    );
  });

  test('cut at 14 characters with `…`; the tooltip has it whole', () => {
    assert.equal(ROW_STATUS_LENGTH, 14);
    const exact = rowText(
      row({ ticketStatus: { name: 'n', status: 'Ready for test', category: null } }),
      NOW_NS,
      null,
    );
    assert.equal(exact.ticket?.text, 'Ready for test');
    const long = rowText(
      row({
        ticketStatus: { name: 'ABC-1', status: 'Waiting for the customer', category: 'blocked' },
      }),
      NOW_NS,
      null,
    );
    assert.deepEqual(long.ticket, {
      text: 'Waiting for t…',
      tip: 'ABC-1 · Waiting for the customer',
      category: 'blocked',
    });
    assert.equal([...(long.ticket?.text ?? '')].length, 14);
  });

  test('a category the page does not know, or none, is no tint: grey', () => {
    for (const word of ['todo', 'doing', 'review', 'blocked', 'done', 'closed']) {
      assert.equal(knownCategory(word), word);
    }
    for (const word of ['Doing', 'later', '', null, 3, 'checks-failing', 'toString']) {
      assert.equal(knownCategory(word), '', String(word));
    }
  });
});

describe("the header's ticket chip (T6)", () => {
  test('the stored ticket with a status: the name, the status, its tint, the address then the age', () => {
    assert.deepEqual(ticketHeader(selected(), NOW_NS), {
      name: 'ABC-123',
      status: 'In Progress',
      category: 'doing',
      tip: `${URL}\nIn Progress, checked 3m ago`,
      url: URL,
      group: false,
    });
  });

  test('after a failure: its words, then the last known status and its age', () => {
    const failed = selected({
      ticketStatus: status({
        okAtNs: ago(7200n),
        triedAtNs: ago(10n),
        error: 'the status command timed out after 10 s',
      }),
    });
    assert.deepEqual(ticketHeader(failed, NOW_NS), {
      name: 'ABC-123',
      status: 'In Progress',
      category: 'doing',
      tip: `${URL}\nstatus not read: the status command timed out after 10 s\nIn Progress, checked 2h ago`,
      url: URL,
      group: false,
    });
    const never = selected({
      ticketStatus: status({
        status: null,
        category: null,
        okAtNs: null,
        error: 'gh is not installed',
      }),
    });
    assert.deepEqual(ticketHeader(never, NOW_NS), {
      name: 'ABC-123',
      status: '',
      category: '',
      tip: `${URL}\nstatus not read: gh is not installed`,
      url: URL,
      group: false,
    });
  });

  test('the stored ticket without a status, or without a provider, is F18’s chip', () => {
    const plain = { name: 'ABC-123', status: '', category: '', tip: URL, url: URL, group: false };
    assert.deepEqual(ticketHeader(selected({ ticketStatus: null }), NOW_NS), plain);
    assert.deepEqual(
      ticketHeader(
        selected({
          ticketStatus: status({ status: null, category: null, okAtNs: null, triedAtNs: null }),
        }),
        NOW_NS,
      ),
      plain,
    );
    const { ticketStatus: _left, ...before } = selected();
    assert.deepEqual(ticketHeader(before as SelectedPayload, NOW_NS), plain, 'a server before F19');
  });

  test('a ticket from the group: shown only once a status is known or was tried, and then its status alone (the group chip names it); its name first in the tooltip', () => {
    const group = (over: Partial<TicketStatusPayload>) =>
      ticketHeader(
        selected({ ticket: null, ticketStatus: status({ stored: false, ...over }) }),
        NOW_NS,
      );
    assert.deepEqual(group({}), {
      name: 'ABC-123',
      status: 'In Progress',
      category: 'doing',
      tip: `ABC-123\n${URL}\nIn Progress, checked 3m ago`,
      url: URL,
      group: true,
    });
    assert.equal(group({ status: null, category: null, okAtNs: null, triedAtNs: null }), null);
    // Tried, never read: the chip says so, grey, its tooltip the failure's words.
    assert.deepEqual(group({ status: null, category: null, okAtNs: null, error: 'x' }), {
      name: 'ABC-123',
      status: 'status not read',
      category: '',
      tip: `ABC-123\n${URL}\nstatus not read: x`,
      url: URL,
      group: true,
    });
    // After a failure the last status stays, with its words and its age.
    assert.deepEqual(
      group({ okAtNs: ago(7200n), error: 'down' })?.tip,
      `ABC-123\n${URL}\nstatus not read: down\nIn Progress, checked 2h ago`,
    );
    assert.equal(ticketHeader(selected({ ticket: null, ticketStatus: null }), NOW_NS), null);
  });

  test("the status of another address than the stored ticket's is not the chip's", () => {
    const other = selected({
      ticketStatus: status({ url: 'https://tickets.example.com/browse/X-1' }),
    });
    assert.equal(ticketHeader(other, NOW_NS)?.status, '');
  });

  test('every text is sanitised again; a category the page does not know is grey', () => {
    const shown = ticketHeader(
      selected({
        ticketStatus: status({
          status: 'In \u001b[31mReview\u202e',
          category: 'later',
          error: null,
        }),
      }),
      NOW_NS,
    );
    assert.deepEqual([shown?.status, shown?.category], ['In Review', '']);
  });
});

describe("the ticket dialog's status line (T4)", () => {
  test('the status and when it was checked; a failure; not read yet; none without a provider', () => {
    assert.deepEqual(ticketStatusLine(selected(), NOW_NS), {
      text: 'In Progress · checked 3m ago',
      category: 'doing',
    });
    assert.deepEqual(
      ticketStatusLine(
        selected({
          ticketStatus: status({ okAtNs: ago(7200n), triedAtNs: ago(5n), error: 'tracker: down' }),
        }),
        NOW_NS,
      ),
      { text: 'status not read: tracker: down · last In Progress, checked 2h ago', category: '' },
    );
    assert.deepEqual(
      ticketStatusLine(
        selected({ ticketStatus: status({ status: null, okAtNs: null, triedAtNs: null }) }),
        NOW_NS,
      ),
      { text: 'status not read yet', category: '' },
    );
    assert.equal(ticketStatusLine(selected({ ticketStatus: null }), NOW_NS), null);
  });
});
