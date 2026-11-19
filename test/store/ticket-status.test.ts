// Follow-up F19 (T5; S2 10.2): the cached status of a ticket, one row per address in the table
// `ticket_status` of migration 4. A success sets the text, the category, both times and clears the
// failure; a failure sets only when it was tried and its words, so that the last known status and
// its age stay; the first attempt for an address makes its row, whichever way it went.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import { sandbox } from '../helpers/sandbox.ts';

const T0 = 1_762_988_000_000_000_000n;
const SEC = 1_000_000_000n;
const A = 'https://tickets.example.com/browse/ABC-1';
const B = 'https://github.com/owner/repo/issues/5';

function fresh(t: TestContext): { store: Store; path: string } {
  const path = join(sandbox(t).root, 'skydeck.db');
  const store = openStore(path);
  t.after(() => {
    store.close();
  });
  return { store, path };
}

function rawRows(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test('a new store has no ticket status', (t) => {
  assert.deepEqual(fresh(t).store.ticketStatuses(), []);
});

test('a success makes the row: the text, the category, ok_at_ns = tried_at_ns, no error', (t) => {
  const { store, path } = fresh(t);
  store.saveTicketStatus(A, { ok: true, atNs: T0, status: 'In Progress', category: 'doing' });

  assert.deepEqual(store.ticketStatuses(), [
    { url: A, status: 'In Progress', category: 'doing', okAtNs: T0, triedAtNs: T0, error: null },
  ]);
  assert.deepEqual(rawRows(path, 'SELECT * FROM ticket_status'), [
    {
      url: A,
      status: 'In Progress',
      category: 'doing',
      ok_at_ns: T0,
      tried_at_ns: T0,
      error: null,
    },
  ]);
});

test('a failure keeps the last status, its category and its age; a success clears the failure', (t) => {
  const { store } = fresh(t);
  store.saveTicketStatus(A, { ok: true, atNs: T0, status: 'In Review', category: 'review' });
  store.saveTicketStatus(A, { ok: false, atNs: T0 + SEC, error: 'the status command exited 1' });

  assert.deepEqual(store.ticketStatuses(), [
    {
      url: A,
      status: 'In Review',
      category: 'review',
      okAtNs: T0,
      triedAtNs: T0 + SEC,
      error: 'the status command exited 1',
    },
  ]);

  store.saveTicketStatus(A, { ok: true, atNs: T0 + 2n * SEC, status: 'Done', category: 'done' });
  assert.deepEqual(store.ticketStatuses(), [
    {
      url: A,
      status: 'Done',
      category: 'done',
      okAtNs: T0 + 2n * SEC,
      triedAtNs: T0 + 2n * SEC,
      error: null,
    },
  ]);
});

test('a first attempt that failed makes a row with no status; no category is stored as NULL', (t) => {
  const { store } = fresh(t);
  store.saveTicketStatus(B, { ok: false, atNs: T0, error: 'gh is not installed' });
  store.saveTicketStatus(A, { ok: true, atNs: T0, status: 'reopened', category: null });

  // Ordered by the address: B (github.com) before A (tickets.example.com).
  assert.deepEqual(store.ticketStatuses(), [
    {
      url: B,
      status: null,
      category: null,
      okAtNs: null,
      triedAtNs: T0,
      error: 'gh is not installed',
    },
    { url: A, status: 'reopened', category: null, okAtNs: T0, triedAtNs: T0, error: null },
  ]);
});

test('a category the database holds that skydeck does not know is read as none', (t) => {
  const { store, path } = fresh(t);
  store.saveTicketStatus(A, { ok: true, atNs: T0, status: 'x', category: 'todo' });
  const db = new DatabaseSync(path);
  db.prepare("UPDATE ticket_status SET category = 'later-word'").run();
  db.close();

  assert.equal(store.ticketStatuses()[0]?.category, null);
});
