import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeError, recordProblems } from '../../src/sessions/problems.ts';
import type { Store } from '../../src/store/store.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';

test('describeError gives the code of a system error, else the name and message, on one line', () => {
  assert.equal(describeError(Object.assign(new Error('EACCES: no'), { code: 'EACCES' })), 'EACCES');
  assert.equal(describeError(new TypeError('bad\nthing\t here')), 'TypeError: bad thing here');
  assert.equal(describeError('plain'), 'plain');
  // Only an errno-like code stands for the reason; node:sqlite gives every error the same code.
  const sqlite = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
  assert.equal(describeError(sqlite), 'Error: database is locked');
  const long = describeError(new Error('x'.repeat(300)));
  assert.equal(long, `${`Error: ${'x'.repeat(300)}`.slice(0, 200)}…`);
});

test('recordProblems keeps at most 20 lines: the first 19 and how many more', (t) => {
  const { deck } = testDeck(t);
  const lines = Array.from({ length: 25 }, (_, i) => `problem ${i + 1}`);
  recordProblems(deck.store, 'scan_problems', lines);
  const kept = JSON.parse(deck.store.getKv('scan_problems') ?? '[]') as string[];
  assert.equal(kept.length, 20);
  assert.deepEqual(kept.slice(0, 19), lines.slice(0, 19));
  assert.equal(kept[19], '… and 6 more');

  recordProblems(deck.store, 'scan_problems', lines.slice(0, 20));
  assert.deepEqual(JSON.parse(deck.store.getKv('scan_problems') ?? '[]'), lines.slice(0, 20));
});

test('recordProblems writes only when the lines change, and deletes the key when there are none', (t) => {
  const d = testDeck(t);
  const writes: string[] = [];
  const store: Partial<Store> = {
    setKv: (key, value) => {
      writes.push(`set ${key}`);
      d.deck.store.setKv(key, value);
    },
    deleteKv: (key) => {
      writes.push(`delete ${key}`);
      d.deck.store.deleteKv(key);
    },
  };
  const counted = deckWith(d.deck, { store }).store;
  recordProblems(counted, 'ingest_problems', []);
  recordProblems(counted, 'ingest_problems', ['a']);
  recordProblems(counted, 'ingest_problems', ['a']);
  recordProblems(counted, 'ingest_problems', ['a', 'b']);
  recordProblems(counted, 'ingest_problems', []);
  recordProblems(counted, 'ingest_problems', []);
  assert.deepEqual(writes, [
    'set ingest_problems',
    'set ingest_problems',
    'delete ingest_problems',
  ]);
  assert.equal(d.deck.store.getKv('ingest_problems'), null);
});
