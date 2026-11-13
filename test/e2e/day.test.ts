/**
 * A recorded day, end to end (design 12): eight hook events, six transcripts, two live-session
 * files and one process that is still alive go in; `skydeck ls --json` comes out, and the answer is
 * compared with `expected-ls.json`, which was worked out by hand from design 5 to 7, not copied
 * from skydeck's output. Nothing in the fixtures is conversation text.
 */
import assert from 'node:assert/strict';
import { cpSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../src/cli/main.ts';
import { NS_PER_MINUTE } from '../../src/platform/time.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { T0 } from '../helpers/platform.ts';

const DAY = fileURLToPath(new URL('../fixtures/day/', import.meta.url));
const MIN = NS_PER_MINUTE;
const AT_0904 = Number((T0 + 4n * MIN) / 1_000_000_000n);

const S1 = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';
const S2 = '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e';
const S3 = '2d7b5e3a-0f4c-4b8d-9e5f-4a3b2c1d0e9f';
const S5 = '4f9d7a5c-2b6e-4daf-9071-6c5d4e3f2a1b';

interface FakeProcFile {
  bootId: string;
  processes: Record<string, { stat: string; cmdline: string[] }>;
}

/** Every file below `dir` was last modified at 09:04, a minute before the command runs. */
function touchAll(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      utimesSync(join(entry.parentPath, entry.name), AT_0904, AT_0904);
    }
  }
}

/** The day, on disk and in the fake `/proc`, with the clock at 09:05 (T0 + 5 minutes). */
function recordedDay(t: TestContext, options: { columns?: number } = {}): TestDeck {
  const d = testDeck(t, {
    startNs: T0 + 5n * MIN,
    size: { columns: options.columns ?? 80, rows: 24 },
  });
  cpSync(join(DAY, 'spool'), d.deck.places.spoolDir, { recursive: true });
  cpSync(join(DAY, 'claude'), d.deck.places.claudeHome, { recursive: true });
  touchAll(d.deck.places.spoolDir);
  touchAll(d.deck.places.claudeHome);
  const proc = JSON.parse(readFileSync(join(DAY, 'proc.json'), 'utf8')) as FakeProcFile;
  d.proc.setBootId(proc.bootId);
  for (const [pid, process] of Object.entries(proc.processes)) {
    d.proc.setProcess(Number(pid), process);
  }
  return d;
}

test('ls --json of the recorded day is what design 5 to 7 give, worked out by hand', async (t) => {
  const d = recordedDay(t);

  assert.equal(await main(['ls', '--json'], d.ctx), 0);

  assert.equal(d.stderr(), '');
  const expected: unknown = JSON.parse(readFileSync(join(DAY, 'expected-ls.json'), 'utf8'));
  assert.deepEqual(JSON.parse(d.stdout()), expected);
  // The scripted run (S9, `claude -p x`) was dropped at ingest and counted; the SDK session (S6) is
  // known from its transcript and never listed.
  assert.equal(d.deck.store.getKv('dropped_scripted'), '1');
});

test('ls of the recorded day prints each group and row, the way the list shows them', async (t) => {
  const d = recordedDay(t, { columns: 120 });

  assert.equal(await main(['ls'], d.ctx), 0);

  assert.equal(
    d.stdout(),
    [
      'ABC-123',
      '  working     ABC-123 add retries    4m  4f9d7a5c',
      '',
      'no group',
      '  not-running 2026-11-12 08:45 web   15m  ended-unexpectedly,was-working,continued  2d7b5e3a',
      '  not-running Fix retry loop   25m  ended-unexpectedly,was-working  1pr:unfetched  0b5f3c1e',
      '  not-running quick check    9m  3e8c6f4b',
      '  not-running Clean up logging   20m  1c6a4d2f',
      '',
    ].join('\n'),
  );
});

test('show of the session /clear led to names what it continues, the link, and the launch command', async (t) => {
  const d = recordedDay(t);

  assert.equal(await main(['show', '2d7b'], d.ctx), 0);

  assert.equal(
    d.stdout(),
    [
      '2026-11-12 08:45 web',
      `id:        ${S3}`,
      'state:     not-running since 2026-11-12T08:50:00.000Z',
      'marks:     ended-unexpectedly,was-working,continued',
      'label:     -',
      'group:     -',
      'dir:       /home/dev/projects/web',
      'launch:    claude',
      `continues: ${S2}`,
      'link:      clear 1c6a4d2f -> 2d7b5e3a at 2026-11-12T08:45:00.200Z',
      '',
    ].join('\n'),
  );
});

test('show of the session that ended with the machine lists its pull request, "not fetched"', async (t) => {
  const d = recordedDay(t);

  assert.equal(await main(['show', '0b5f'], d.ctx), 0);

  assert.equal(
    d.stdout(),
    [
      'Fix retry loop',
      `id:        ${S1}`,
      'state:     not-running since 2026-11-12T08:40:00.000Z',
      'marks:     ended-unexpectedly,was-working',
      'label:     -',
      'group:     -',
      'dir:       /home/dev/projects/api',
      'launch:    claude --model opus',
      'pr:        https://github.com/acme/api/pull/12  not fetched',
      '',
    ].join('\n'),
  );
  assert.deepEqual(d.runner.calls, [], 'show never touches the network without --refresh');
});

test('show of the running session lists the process that holds it', async (t) => {
  const d = recordedDay(t);

  assert.equal(await main(['show', '4f9d'], d.ctx), 0);

  assert.equal(
    d.stdout(),
    [
      'ABC-123 add retries',
      `id:        ${S5}`,
      'state:     working since 2026-11-12T09:01:00.000Z',
      'marks:     -',
      'label:     -',
      'group:     ABC-123',
      'dir:       /home/dev/projects/api',
      'launch:    claude --add-dir /home/dev/projects/lib',
      'holder:    pid 5000 since 2026-11-12T09:00:00.000Z',
      '',
    ].join('\n'),
  );
});

test('show --json of the continued session has its link and no holder', async (t) => {
  const d = recordedDay(t);

  assert.equal(await main(['show', '2d7b', '--json'], d.ctx), 0);

  const json = JSON.parse(d.stdout()) as Record<string, unknown>;
  assert.equal(json['id'], S3);
  assert.equal(json['continuedFrom'], S2);
  assert.deepEqual(json['launch'], ['claude']);
  assert.deepEqual(json['unknownFlags'], []);
  assert.deepEqual(json['links'], [
    { kind: 'clear', from: S2, to: S3, at: '2026-11-12T08:45:00.200Z' },
  ]);
  assert.deepEqual(json['holders'], []);
});
