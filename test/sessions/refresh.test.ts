import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NS_PER_SECOND, isoFromNs } from '../../src/platform/time.ts';
import type { Proc } from '../../src/platform/types.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { testDeck } from '../helpers/deck.ts';
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
  const proc: Proc = {
    ...d.proc,
    cmdline: () => {
      throw new Error('cmdline');
    },
  };
  const files = d.deck.platform.files;
  const deck = {
    ...d.deck,
    platform: {
      ...d.deck.platform,
      proc,
      files: {
        ...files,
        readBytes: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      },
    },
  };
  assert.deepEqual(refresh(deck), {
    ingest: { ingested: 0, duplicates: 0, bad: 1, scripted: 0 },
    observed: 0,
    scan: { read: 0, skipped: 0, missing: 0, prsAttached: 0 },
  });
  assert.notEqual(d.deck.store.getKv('ingest_problems'), null);
  assert.notEqual(d.deck.store.getKv('reconcile_problems'), null);
  assert.notEqual(d.deck.store.getKv('scan_problems'), null);
});
