// The stored outcome of the window's check for a newer skydeck, and the entry of an update started
// from the window (F38; src/update/record.ts): the strict readers, the checkout's root, and the
// texts as the page gets them.
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

function available(over: Partial<CheckRecord> = {}): CheckRecord {
  return {
    v: 1,
    root: ROOT,
    lookedAtNs: '1794474000000000000',
    checkedAtNs: '1794474000000000000',
    fetchedAtNs: '1794474000000000000',
    failure: null,
    head: OLD,
    outcome: {
      kind: 'available',
      upstream: 'origin/main',
      count: 2,
      to: NEW,
      lines: ['2 new commits on origin/main (0123456..fedcba9):', '  fedcba9  the new commit'],
      blocked: null,
    },
    ...over,
  };
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
      { ...good, v: 2 },
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
      { ...good, outcome: { ...good.outcome, lines: ['a', 1] } },
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

  test('every line is clipped to 300 characters as it is stored', (t) => {
    const d = testDeck(t);
    const long = 'z'.repeat(5000);
    writeCheck(
      d.deck.store,
      available({
        failure: { atNs: '1', line: long },
        outcome: {
          kind: 'available',
          upstream: long,
          count: 1,
          to: NEW,
          lines: [long],
          blocked: long,
        },
      }),
    );
    const read = readCheck(d.deck.store, ROOT);
    assert.ok(read !== null && read.outcome.kind === 'available');
    for (const line of [
      read.failure?.line,
      read.outcome.upstream,
      read.outcome.lines[0],
      read.outcome.blocked,
    ]) {
      assert.equal(line?.length, 300);
      assert.ok(line?.endsWith('…'));
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
  test('each outcome: its state, summary, lines, to and blocked', () => {
    assert.deepEqual(checkPayload(available()), {
      state: 'available',
      summary: '2 new commits on origin/main',
      to: NEW,
      lines: ['2 new commits on origin/main (0123456..fedcba9):', '  fedcba9  the new commit'],
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

  test('texts are sanitised and clipped', () => {
    const payload = checkPayload(
      available({
        outcome: {
          kind: 'available',
          upstream: 'origin/\u001b[31mmain',
          count: 1,
          to: NEW,
          lines: ['a\u0007b', 'q'.repeat(400)],
          blocked: 'x\u001b]0;title\u0007y',
        },
      }),
    );
    assert.ok(payload.state === 'available');
    assert.doesNotMatch(payload.summary, /\u001b/);
    assert.doesNotMatch(payload.lines[0] ?? '', /\u0007/);
    assert.equal(payload.lines[1]?.length, 300);
    assert.doesNotMatch(payload.blocked ?? '', /[\u001b\u0007]/);
  });
});
