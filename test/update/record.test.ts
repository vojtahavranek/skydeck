// The stored outcome of the window's check for a newer skydeck (F38; src/update/record.ts): the
// strict reader, the checkout's root, and the texts as the page gets them.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { realPlatform } from '../../src/platform/real.ts';
import {
  CHECK_KEY,
  checkoutRoot,
  checkPayload,
  readCheck,
  readCheckEntry,
  writeCheck,
} from '../../src/update/record.ts';
import type { CheckRecord } from '../../src/update/record.ts';
import { testDeck } from '../helpers/deck.ts';
import { sandbox } from '../helpers/sandbox.ts';
import { NEW, OLD } from '../helpers/update.ts';

const ROOT = '/srv/skydeck';

function available(over: Partial<CheckRecord> = {}): CheckRecord {
  return {
    v: 1,
    root: ROOT,
    lookedAtNs: '1794474000000000000',
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
