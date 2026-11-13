import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NS_PER_SECOND, isoFromNs } from '../../src/platform/time.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, S3, SEC, T0, statLine } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

const START = 51234567;

function spoolStart(d: TestDeck, sessionId: string, pid: number): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid,
    input: hookInput('SessionStart', sessionId, { source: 'startup' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
}

function liveFile(d: TestDeck, sessionId: string, pid: number): void {
  const busy = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const path = join(d.deck.places.claudeHome, 'sessions', `${pid}.json`);
  writeFileSync(path, JSON.stringify({ ...busy, pid, sessionId }));
  const seconds = Number((T0 - 10n * SEC) / NS_PER_SECOND);
  utimesSync(path, seconds, seconds);
  d.proc.setProcess(pid, { stat: statLine(pid, START), cmdline: ['claude'] });
}

function transcript(d: TestDeck, sessionId: string): void {
  const folder = join(d.deck.places.claudeHome, 'projects', 'demo');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId, timestamp: isoFromNs(T0), cwd: '/w', entrypoint: 'cli' })}\n`,
  );
}

test('refresh ingests, reconciles and scans', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S2, 4343);
  transcript(d, S3);
  const result = refresh(d.deck);
  assert.equal(result.ingest.ingested, 1);
  assert.equal(result.observed, 1);
  assert.equal(result.scan.read, 1);
});

test('refresh ingests before it reconciles', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S1, 4242);
  assert.equal(refresh(d.deck).observed, 0);
});

test('refresh passes progress to the scan', (t) => {
  const d = testDeck(t);
  transcript(d, S3);
  const calls: [number, number][] = [];
  refresh(d.deck, (done, total) => calls.push([done, total]));
  assert.deepEqual(calls, [[1, 1]]);
});

test('a refresh whose spool file, live process and transcript all fail does not throw', (t) => {
  const d = testDeck(t);
  writeFileSync(join(d.deck.places.spoolDir, '1-2-3.ev'), 'garbage');
  liveFile(d, S2, 4343);
  transcript(d, S3);
  const deck = deckWith(d.deck, {
    proc: {
      cmdline: () => {
        throw new Error('cmdline');
      },
    },
    files: {
      readBytes: () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    },
  });
  assert.deepEqual(refresh(deck), {
    ingest: { ingested: 0, duplicates: 0, bad: 1, scripted: 0 },
    observed: 0,
    scan: { read: 0, skipped: 0, missing: 0, prsAttached: 0 },
  });
  assert.notEqual(d.deck.store.getKv('ingest_problems'), null);
  assert.notEqual(d.deck.store.getKv('reconcile_problems'), null);
  assert.notEqual(d.deck.store.getKv('scan_problems'), null);
});

test('a refresh in which saving one spool event, one observed event and one transcript fails handles the others', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242); // its save fails
  const other = {
    event: 'SessionStart' as const,
    timeNs: T0 - 15n * SEC,
    pid: 4444,
    input: hookInput('SessionStart', S3, { source: 'startup' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(other, 2)), spoolText(other));
  liveFile(d, S2, 4343); // its save fails
  liveFile(d, S3, 4545);
  transcript(d, S1); // its save fails
  transcript(d, S2);
  const store = d.deck.store;
  const deck = deckWith(d.deck, {
    store: {
      insertEvent: (event) => {
        if (event.pid === 4242 || event.pid === 4343) throw new RangeError('cannot bind');
        return store.insertEvent(event);
      },
      saveTranscript: (row) => {
        if (row.sessionId === S1) throw new RangeError('cannot bind');
        store.saveTranscript(row);
      },
    },
  });
  assert.deepEqual(refresh(deck), {
    ingest: { ingested: 1, duplicates: 0, bad: 0, scripted: 0 },
    observed: 1,
    scan: { read: 1, skipped: 0, missing: 0, prsAttached: 0 },
  });
  assert.deepEqual(
    store.events().map((e) => [e.kind, e.pid]),
    [
      ['start', 4444],
      ['observed', 4545],
    ],
  );
  assert.deepEqual(
    store.transcripts().map((r) => r.sessionId),
    [S2],
  );
  for (const key of ['ingest_problems', 'reconcile_problems', 'scan_problems'] as const) {
    assert.equal((JSON.parse(store.getKv(key) ?? '[]') as string[]).length, 1, key);
  }
});

test('a locked database stops the refresh at the first item and records no item problems', (t) => {
  const d = testDeck(t);
  writeFileSync(join(d.deck.places.spoolDir, '1-2-3.ev'), 'garbage'); // would be recorded as bad
  spoolStart(d, S1, 4242);
  liveFile(d, S2, 4343);
  transcript(d, S3);
  let attempts = 0;
  const deck = deckWith(d.deck, {
    store: {
      insertEvent: () => {
        attempts++;
        throw Object.assign(new Error('database is locked'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 5,
        });
      },
    },
  });
  assert.throws(() => refresh(deck), /database is locked/);
  assert.equal(attempts, 1);
  for (const key of ['ingest_problems', 'reconcile_problems', 'scan_problems'] as const) {
    assert.equal(d.deck.store.getKv(key), null, key);
  }
  assert.deepEqual(d.deck.store.transcripts(), [], 'the scan did not run');
});
