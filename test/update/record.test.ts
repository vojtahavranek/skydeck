// The stored outcome of the window's check for a newer skydeck, and the entry of an update started
// from the window (F38; src/update/record.ts): the strict readers, the checkout's root, and the
// texts as the page gets them. The check's record is of version 2 (the notes of what is new): one
// of the shape before reads as none, and the reader of the shape before takes none of the new.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { realPlatform } from '../../src/platform/real.ts';
import {
  CHECK_KEY,
  checkoutRoot,
  checkPayload,
  clearRun,
  readCheck,
  readCheckEntry,
  readRun,
  readRunEntry,
  RUN_KEY,
  writeCheck,
  writeRun,
} from '../../src/update/record.ts';
import type { CheckRecord, RunRecord } from '../../src/update/record.ts';
import { testDeck } from '../helpers/deck.ts';
import { sandbox } from '../helpers/sandbox.ts';
import { NEW, OLD } from '../helpers/update.ts';

const ROOT = '/srv/skydeck';

type Available = Extract<CheckRecord['outcome'], { kind: 'available' }>;

function outcome(over: Partial<Available> = {}): Available {
  return {
    kind: 'available',
    upstream: 'origin/main',
    count: 2,
    from: OLD,
    to: NEW,
    notes: [{ title: 'Parked: set a session aside', paragraphs: ['Press `w` on it.', 'More.'] }],
    moreNotes: 0,
    others: ['the new commit'],
    otherCount: 1,
    upgradesDatabase: false,
    blocked: null,
    ...over,
  };
}

function available(over: Partial<CheckRecord> = {}): CheckRecord {
  return {
    v: 2,
    root: ROOT,
    lookedAtNs: '1794474000000000000',
    checkedAtNs: '1794474000000000000',
    fetchedAtNs: '1794474000000000000',
    failure: null,
    head: OLD,
    outcome: outcome(),
    ...over,
  };
}

/** The record of the shape before (version 1), as the code before this change wrote it. */
function before(outcomeBefore: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    root: ROOT,
    lookedAtNs: '1794474000000000000',
    checkedAtNs: '1794474000000000000',
    fetchedAtNs: '1794474000000000000',
    failure: null,
    head: OLD,
    outcome: outcomeBefore,
  };
}

/**
 * The strict reader of the shape before (src/update/record.ts at 789189a, the record's own keys
 * and version), kept here to show that the code before this change reads a new record as none.
 */
function readerBefore(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = [
    'v',
    'root',
    'lookedAtNs',
    'checkedAtNs',
    'fetchedAtNs',
    'failure',
    'head',
    'outcome',
  ];
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return false;
  return (value as { v: unknown }).v === 1;
}

describe('the check entry in kv', () => {
  test('a round trip: what is written is read back, by its root', (t) => {
    const d = testDeck(t);
    const record = available({
      failure: { atNs: '1794474000000000001', line: 'git fetch failed' },
    });

    writeCheck(d.deck.store, record);

    assert.deepEqual(readCheck(d.deck.store, ROOT), record);
    assert.deepEqual(readCheckEntry(d.deck.store), record);
  });

  test('an entry of another root reads as none to this checkout, and as itself to readCheckEntry', (t) => {
    const d = testDeck(t);
    writeCheck(d.deck.store, available({ root: '/elsewhere' }));

    assert.equal(readCheck(d.deck.store, ROOT), null);
    assert.equal(readCheckEntry(d.deck.store)?.root, '/elsewhere');
  });

  test('a value that is not exactly a record reads as none', (t) => {
    const d = testDeck(t);
    const good = available();
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      { ...good, v: 1 },
      { ...good, v: 3 },
      { ...good, extra: 1 },
      { ...good, root: 5 },
      { ...good, root: '' },
      { ...good, lookedAtNs: 17 },
      { ...good, lookedAtNs: '-1' },
      { ...good, fetchedAtNs: 'soon' },
      { ...good, checkedAtNs: 'soon' },
      { ...good, checkedAtNs: undefined },
      { ...good, failure: { atNs: '1' } },
      { ...good, failure: { atNs: '1', line: 2 } },
      { ...good, head: 'HEAD' },
      { ...good, outcome: { kind: 'maybe', line: 'x' } },
      { ...good, outcome: { kind: 'current', line: 3 } },
      { ...good, outcome: { kind: 'current', line: 'x', extra: true } },
      { ...good, outcome: { ...good.outcome, count: '2' } },
      { ...good, outcome: { ...good.outcome, count: 0 } },
      { ...good, outcome: { ...good.outcome, to: 'fedcba9' } },
      { ...good, outcome: { ...good.outcome, from: null } },
      { ...good, outcome: { ...good.outcome, lines: ['a'] } },
      { ...good, outcome: { ...good.outcome, notes: 'x' } },
      { ...good, outcome: { ...good.outcome, notes: [{ title: 'x' }] } },
      { ...good, outcome: { ...good.outcome, notes: [{ title: 'x', paragraphs: [] }] } },
      { ...good, outcome: { ...good.outcome, notes: [{ title: 1, paragraphs: ['y'] }] } },
      { ...good, outcome: { ...good.outcome, notes: [{ title: 'x', paragraphs: ['y', 2] }] } },
      {
        ...good,
        outcome: { ...good.outcome, notes: [{ title: 'x', paragraphs: ['y'], extra: 1 }] },
      },
      {
        ...good,
        outcome: {
          ...good.outcome,
          notes: Array.from({ length: 21 }, () => ({ title: 'x', paragraphs: ['y'] })),
        },
      },
      { ...good, outcome: { ...good.outcome, moreNotes: -1 } },
      { ...good, outcome: { ...good.outcome, moreNotes: 1.5 } },
      { ...good, outcome: { ...good.outcome, others: [1] } },
      { ...good, outcome: { ...good.outcome, others: Array.from({ length: 21 }, () => 'x') } },
      { ...good, outcome: { ...good.outcome, otherCount: 3 } },
      { ...good, outcome: { ...good.outcome, otherCount: '1' } },
      { ...good, outcome: { ...good.outcome, upgradesDatabase: 'no' } },
      { ...good, outcome: { ...good.outcome, blocked: false } },
    ];
    for (const value of bad) {
      d.deck.store.setKv(CHECK_KEY, typeof value === 'string' ? value : JSON.stringify(value));
      assert.equal(readCheck(d.deck.store, ROOT), null, JSON.stringify(value));
      assert.equal(readCheckEntry(d.deck.store), null, JSON.stringify(value));
    }
    d.deck.store.deleteKv(CHECK_KEY);
    assert.equal(readCheckEntry(d.deck.store), null);
  });

  test('every line is clipped to 300 characters as it is stored, a note to 120 and 600', (t) => {
    const d = testDeck(t);
    const long = 'z'.repeat(5000);
    writeCheck(
      d.deck.store,
      available({
        failure: { atNs: '1', line: long },
        outcome: outcome({
          upstream: long,
          others: [long],
          notes: [{ title: long, paragraphs: [long, 'dropped'] }],
          blocked: long,
        }),
      }),
    );
    const read = readCheck(d.deck.store, ROOT);
    assert.ok(read !== null && read.outcome.kind === 'available');
    for (const line of [
      read.failure?.line,
      read.outcome.upstream,
      read.outcome.others[0],
      read.outcome.blocked,
    ]) {
      assert.equal(line?.length, 300);
      assert.ok(line?.endsWith('…'));
    }
    assert.equal(read.outcome.notes[0]?.title.length, 120);
    assert.deepEqual(read.outcome.notes[0]?.paragraphs, [`${'z'.repeat(599)}…`]);
  });
});

describe('the shape before (version 1) and the code before', () => {
  test('a record of the shape before, of each outcome, reads as none (the server then makes its own check; doctor says what it says for none)', (t) => {
    const d = testDeck(t);
    for (const outcomeBefore of [
      {
        kind: 'available',
        upstream: 'origin/main',
        count: 2,
        to: NEW,
        lines: ['2 new commits on origin/main (0123456..fedcba9):', '  fedcba9  the new commit'],
        blocked: null,
      },
      { kind: 'current', line: 'skydeck is up to date (main at 0123456, as origin/main)' },
      { kind: 'cannot', line: 'no' },
    ]) {
      d.deck.store.setKv(CHECK_KEY, JSON.stringify(before(outcomeBefore)));
      assert.equal(readCheckEntry(d.deck.store), null, JSON.stringify(outcomeBefore));
      assert.equal(readCheck(d.deck.store, ROOT), null);
    }
  });

  test('the reader of the shape before takes no record of the new one, of any outcome', (t) => {
    const d = testDeck(t);
    for (const record of [
      available(),
      available({ outcome: { kind: 'current', line: 'up to date' } }),
      available({ outcome: { kind: 'cannot', line: 'no' } }),
    ]) {
      writeCheck(d.deck.store, record);
      const stored: unknown = JSON.parse(d.deck.store.getKv(CHECK_KEY) ?? 'null');
      assert.equal(readerBefore(stored), false);
      // …while it took the shape it was written for.
      assert.equal(readerBefore(before({ kind: 'cannot', line: 'no' })), true);
    }
  });
});

describe('the run entry in kv (milestone 2)', () => {
  const AT = '1794474000000000000';
  const entries: RunRecord[] = [
    { v: 1, root: ROOT, state: 'applying', to: NEW, atNs: AT },
    { v: 1, root: ROOT, state: 'applied', to: NEW, atNs: AT },
    {
      v: 1,
      root: ROOT,
      state: 'failed',
      to: NEW,
      line: 'the update could not be applied',
      atNs: AT,
    },
  ];

  test('a round trip of each state, by its root; another root is none to readRun; clearRun removes it', (t) => {
    const d = testDeck(t);
    const { store } = d.deck;
    for (const entry of entries) {
      writeRun(store, entry);
      assert.deepEqual(readRun(store, ROOT), entry, entry.state);
      assert.deepEqual(readRunEntry(store), entry);
      assert.equal(readRun(store, '/elsewhere'), null);
    }
    clearRun(store);
    assert.equal(store.getKv(RUN_KEY), null);
    assert.equal(readRunEntry(store), null);
  });

  test('a value that is not exactly a run entry reads as none', (t) => {
    const d = testDeck(t);
    const { store } = d.deck;
    const base = { v: 1, root: ROOT, state: 'applied', to: NEW, atNs: AT };
    for (const value of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ ...base, v: 2 }),
      JSON.stringify({ ...base, root: '' }),
      JSON.stringify({ ...base, state: 'done' }),
      JSON.stringify({ ...base, to: NEW.slice(0, 7) }),
      JSON.stringify({ ...base, to: NEW.toUpperCase() }),
      JSON.stringify({ ...base, atNs: '-1' }),
      JSON.stringify({ ...base, extra: 1 }),
      JSON.stringify({ ...base, line: 'a line on an entry that is not failed' }),
      JSON.stringify({ ...base, state: 'failed' }), // a failed entry without its line
      JSON.stringify({ ...base, state: 'failed', line: 3 }),
    ]) {
      store.setKv(RUN_KEY, value);
      assert.equal(readRunEntry(store), null, value);
    }
  });

  test("a failed entry's line is clipped to 600 characters as it is stored", (t) => {
    const d = testDeck(t);
    const { store } = d.deck;
    writeRun(store, {
      v: 1,
      root: ROOT,
      state: 'failed',
      to: NEW,
      line: 'x'.repeat(5000),
      atNs: AT,
    });
    const read = readRunEntry(store);
    const line = read?.state === 'failed' ? read.line : '';
    assert.equal(line.length, 600);
    assert.ok(line.endsWith('…'));
  });
});

describe('checkoutRoot', () => {
  test('a path, a symbolic link to it, and a path that does not resolve', (t) => {
    const s = sandbox(t);
    const files = realPlatform().files;
    const dir = join(s.root, 'checkout');
    mkdirSync(dir);
    symlinkSync(dir, join(s.root, 'link'));

    assert.equal(checkoutRoot(files, dir), dir);
    assert.equal(checkoutRoot(files, join(s.root, 'link')), dir);
    assert.equal(checkoutRoot(files, join(s.root, 'gone')), join(s.root, 'gone'));
  });
});

describe('checkPayload', () => {
  test('each outcome: its state and summary; for an update its ids, the notes in runs, the other changes, the database and blocked', () => {
    assert.deepEqual(checkPayload(available()), {
      state: 'available',
      summary: '2 new commits on origin/main',
      from: OLD,
      to: NEW,
      upstream: 'origin/main',
      notes: [
        {
          title: [{ text: 'Parked: set a session aside', code: false }],
          paragraphs: [
            [
              { text: 'Press ', code: false },
              { text: 'w', code: true },
              { text: ' on it.', code: false },
            ],
            [{ text: 'More.', code: false }],
          ],
        },
      ],
      moreNotes: 0,
      others: ['the new commit'],
      otherCount: 1,
      upgradesDatabase: false,
      blocked: null,
    });
    assert.deepEqual(
      checkPayload(
        available({
          outcome: {
            kind: 'current',
            line: 'skydeck is up to date (main at 0123456, as origin/main)',
          },
        }),
      ),
      { state: 'current', summary: 'skydeck is up to date (main at 0123456, as origin/main)' },
    );
    assert.deepEqual(checkPayload(available({ outcome: { kind: 'cannot', line: 'no' } })), {
      state: 'cannot',
      summary: 'no',
    });
  });

  test('texts are sanitised and clipped, a note to its limits', () => {
    const payload = checkPayload(
      available({
        outcome: outcome({
          upstream: 'origin/\u001b[31mmain',
          count: 1,
          others: ['a\u0007b', 'q'.repeat(400)],
          notes: [
            { title: `t\u001b[1m${'T'.repeat(200)}`, paragraphs: ['p\u0007', 'P'.repeat(700)] },
          ],
          blocked: 'x\u001b]0;title\u0007y',
        }),
      }),
    );
    assert.ok(payload.state === 'available');
    assert.doesNotMatch(payload.summary, /\u001b/);
    assert.equal(payload.upstream, 'origin/main');
    assert.equal(payload.others[0], 'ab');
    assert.equal(payload.others[1]?.length, 300);
    assert.doesNotMatch(payload.blocked ?? '', /[\u001b\u0007]/);
    const [note] = payload.notes;
    assert.equal(note?.title[0]?.text, `t${'T'.repeat(118)}…`);
    assert.deepEqual(
      note?.paragraphs.map((runs) => runs.map((run) => run.text).join('')),
      ['p', `${'P'.repeat(598)}…`],
    );
  });
});
