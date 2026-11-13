import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { settingsPath } from '../../src/claude/settings.ts';
import { NS_PER_DAY, NS_PER_SECOND, isoFromNs } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { loadRows, loadSessions } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_B, S1, S2, S3, SEC, T0, statLine } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

const START = 51234567;

const seconds = (ns: Ns): number => Number(ns / NS_PER_SECOND);

/** The spool event of a `startup` of `sessionId` by process `pid`, not yet ingested. */
function spoolStart(d: TestDeck, sessionId: string, pid: number): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid,
    input: hookInput('SessionStart', sessionId, { source: 'startup' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
}

/** A running process `pid` and its trusted live file, busy, naming `sessionId`. */
function liveFile(d: TestDeck, sessionId: string, pid: number): void {
  const busy = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const path = join(d.deck.places.claudeHome, 'sessions', `${pid}.json`);
  writeFileSync(path, JSON.stringify({ ...busy, pid, sessionId }));
  d.proc.setProcess(pid, { stat: statLine(pid, START), cmdline: ['claude'] });
}

/** A transcript of `sessionId` whose file was last modified at `mtimeNs`. */
function transcript(
  d: TestDeck,
  sessionId: string,
  options: { aiTitle?: string; mtimeNs?: Ns } = {},
): void {
  const folder = join(d.deck.places.claudeHome, 'projects', 'demo');
  mkdirSync(folder, { recursive: true });
  const lines = [
    { type: 'user', sessionId, timestamp: isoFromNs(T0 - 30n * SEC), cwd: '/w', entrypoint: 'cli' },
    ...(options.aiTitle === undefined
      ? []
      : [{ type: 'ai-title', sessionId, aiTitle: options.aiTitle }]),
  ];
  const path = join(folder, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  const mtime = seconds(options.mtimeNs ?? T0 - 10n * SEC);
  utimesSync(path, mtime, mtime);
}

test('a started, busy session with a titled transcript is one working row', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S1, 4242);
  transcript(d, S1, { aiTitle: 'Fix retry' });
  refresh(d.deck);
  const rows = loadRows(d.deck);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, S1);
  assert.equal(rows[0]?.state, 'working');
  assert.equal(rows[0]?.title, 'Fix retry');
  assert.equal(rows[0]?.titleSource, 'generated');
});

test('loadRows reads nothing in: it does not refresh', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  transcript(d, S2);
  assert.deepEqual(loadRows(d.deck), []);
  assert.deepEqual(loadSessions(d.deck), []);
});

test('loadSessions gives the derived sessions the rows carry', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S1, 4242);
  transcript(d, S2);
  refresh(d.deck);
  const sessions = loadSessions(d.deck);
  assert.deepEqual(
    sessions.map((s) => s.id),
    [S1, S2],
  );
  assert.deepEqual(
    loadRows(d.deck).map((row) => row.session),
    sessions,
  );
});

test('now is the clock’s: the same transcript is not expiring today and is in 26 days', (t) => {
  const d = testDeck(t);
  transcript(d, S1);
  refresh(d.deck);
  assert.deepEqual(loadRows(d.deck)[0]?.marks, []);
  d.clock.setNs(T0 + 26n * NS_PER_DAY);
  assert.deepEqual(loadRows(d.deck)[0]?.marks, ['expiring']);
});

test('a transcript last modified long ago is expiring, by cleanupPeriodDays of the settings file', (t) => {
  const d = testDeck(t);
  writeFileSync(settingsPath(d.deck.places.claudeHome), '{"cleanupPeriodDays":10}');
  transcript(d, S1, { mtimeNs: T0 - 6n * NS_PER_DAY });
  refresh(d.deck);
  assert.deepEqual(loadRows(d.deck)[0]?.marks, ['expiring']);
});

/**
 * Three transcripts 6, 24 and 26 days old. `expiring` starts at (retention − 5) days, so of these
 * only 6 and 24 together with 26 pin a retention of 29 or 30 days: 6 days old rules out anything
 * shorter than 11, 26 days old anything of 31 or more.
 */
function ageProbe(d: TestDeck): void {
  transcript(d, S1, { mtimeNs: T0 - 6n * NS_PER_DAY });
  transcript(d, S3, { mtimeNs: T0 - 24n * NS_PER_DAY });
  transcript(d, S2, { mtimeNs: T0 - 26n * NS_PER_DAY });
  refresh(d.deck);
}
const EXPIRING_UNDER_DEFAULT = { [S1]: [], [S2]: ['expiring'], [S3]: [] };
const marksOf = (rows: readonly { id: string; marks: string[] }[]): Record<string, string[]> =>
  Object.fromEntries(rows.map((row) => [row.id, row.marks]));

test('without a settings file the retention is 30 days', (t) => {
  const d = testDeck(t);
  ageProbe(d);
  assert.deepEqual(marksOf(loadRows(d.deck)), EXPIRING_UNDER_DEFAULT);
});

test('a settings file that cannot be read leaves the retention at its default and the list intact', (t) => {
  const d = testDeck(t);
  ageProbe(d);
  const settings = settingsPath(d.deck.places.claudeHome);
  const deck = deckWith(d.deck, {
    files: {
      readText(path: string): string | null {
        if (path === settings) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return d.deck.platform.files.readText(path);
      },
    },
  });
  assert.deepEqual(marksOf(loadRows(deck)), EXPIRING_UNDER_DEFAULT);
});

test('a changed boot leaves a session that was running as not-running, ended unexpectedly', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S1, 4242);
  transcript(d, S1);
  refresh(d.deck);
  assert.equal(loadRows(d.deck)[0]?.state, 'working');
  d.proc.setBootId(BOOT_B);
  const row = loadRows(d.deck)[0];
  assert.equal(row?.state, 'not-running');
  assert.ok(row?.marks.includes('ended-unexpectedly'));
});

test('a process that is gone leaves its session not-running', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S1, 4242);
  refresh(d.deck);
  d.proc.setProcess(4242, null);
  assert.equal(loadRows(d.deck)[0]?.state, 'not-running');
});

test('a live file whose process start differs from the process is not trusted: the session is running, not working', (t) => {
  const d = testDeck(t);
  spoolStart(d, S1, 4242);
  liveFile(d, S1, 4242);
  refresh(d.deck);
  // the process keeps its pid and start (so it is alive) but the file's procStart no longer fits
  const path = join(d.deck.places.claudeHome, 'sessions', '4242.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...file, procStart: '999' }));
  assert.equal(loadRows(d.deck)[0]?.state, 'running');
});

test('labels, groups, notes and pull requests of the store are in the rows', (t) => {
  const d = testDeck(t);
  transcript(d, S1);
  refresh(d.deck);
  const { store } = d.deck;
  store.updateMeta(S1, { label: 'my label', group: 'G', note: 'a note' }, T0);
  const pr = {
    url: 'https://github.com/o/r/pull/7',
    owner: 'o',
    repo: 'r',
    number: 7,
  };
  store.ensurePr(pr);
  store.attachPr(S1, pr.url, 'manual', T0);
  const row = loadRows(d.deck)[0];
  assert.equal(row?.title, 'my label');
  assert.equal(row?.titleSource, 'label');
  assert.equal(row?.group, 'G');
  assert.equal(row?.note, 'a note');
  assert.deepEqual(
    row?.prs.map((p) => [p.url, p.level]),
    [[pr.url, 'unfetched']],
  );
  assert.deepEqual(row?.chip, { level: 'unfetched', count: 1 });
});

test('a done session is a done row', (t) => {
  const d = testDeck(t);
  transcript(d, S1);
  refresh(d.deck);
  d.deck.store.updateMeta(S1, { doneAtNs: T0 }, T0);
  assert.equal(loadRows(d.deck)[0]?.done, true);
});

test('the group pattern of the configuration is used', (t) => {
  const d = testDeck(t, { config: { groupPattern: '^\\[\\w+\\]' } });
  transcript(d, S1, { aiTitle: '[ops] rotate keys' });
  transcript(d, S2, { aiTitle: 'ABC-1 not a group here' });
  refresh(d.deck);
  const groups = Object.fromEntries(loadRows(d.deck).map((row) => [row.id, row.group]));
  assert.deepEqual(groups, { [S1]: '[ops]', [S2]: null });
});
