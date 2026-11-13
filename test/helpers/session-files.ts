/**
 * Claude Code's files for the tests of the commands that need a session the deck knows about: a
 * transcript on disk (the refresh every command starts with reads transcripts from the disk, so a
 * row saved straight into the store would be marked missing), and a running process with its
 * trusted live file.
 */
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Context } from '../../src/cli/context.ts';
import { isoFromNs } from '../../src/platform/time.ts';
import type { Ns, Runner } from '../../src/platform/types.ts';
import { testDeck } from './deck.ts';
import type { TestDeck } from './deck.ts';
import { S1, S2, SEC, T0, statLine } from './platform.ts';
import { hookInput, spoolName, spoolText } from './spool.ts';

/** `<claudeHome>/projects/demo/<sessionId>.jsonl` */
export function transcriptPath(d: TestDeck, sessionId: string): string {
  return join(d.deck.places.claudeHome, 'projects', 'demo', `${sessionId}.jsonl`);
}

/** A `user` record: the user's own input at `atNs`. */
export function userRecord(sessionId: string, atNs: Ns): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    timestamp: isoFromNs(atNs),
    cwd: '/home/dev/projects/demo',
    entrypoint: 'cli',
  };
}

/** A `pr-link` record naming `url`. */
export function prLinkRecord(sessionId: string, url: string, atNs: Ns): Record<string, unknown> {
  return { type: 'pr-link', sessionId, prUrl: url, timestamp: isoFromNs(atNs) };
}

/**
 * The transcript of a `cli` session: `records`, by default one `user` record 30 seconds before T0.
 * The file's modification time is T0 - 10 s.
 */
export function writeTranscript(
  d: TestDeck,
  sessionId: string,
  records: readonly Record<string, unknown>[] = [userRecord(sessionId, T0 - 30n * SEC)],
): string {
  const path = transcriptPath(d, sessionId);
  mkdirSync(join(d.deck.places.claudeHome, 'projects', 'demo'), { recursive: true });
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  touch(path, T0 - 10n * SEC);
  return path;
}

/** Adds `record` to the end of the session's transcript; the file's modification time becomes `atNs`. */
export function appendRecord(
  d: TestDeck,
  sessionId: string,
  record: Record<string, unknown>,
  atNs: Ns,
): void {
  const path = transcriptPath(d, sessionId);
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  touch(path, atNs);
}

function touch(path: string, ns: Ns): void {
  const seconds = Number(ns / SEC);
  utimesSync(path, seconds, seconds);
}

/**
 * Process `pid` running `sessionId`, busy: a `startup` event waiting in the spool, a trusted live
 * file and an entry in the fake `/proc`. The row is `working` once the deck has refreshed.
 */
export function startRunning(d: TestDeck, sessionId: string, pid: number): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid,
    input: hookInput('SessionStart', sessionId, { source: 'startup' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  const busy = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;
  writeFileSync(
    join(d.deck.places.claudeHome, 'sessions', `${pid}.json`),
    JSON.stringify({ ...busy, pid, sessionId }),
  );
  d.proc.setProcess(pid, { stat: statLine(pid, 51234567), cmdline: ['claude'] });
}

/** A deck that knows S1 and S2 from their transcripts, as every command finds them. */
export function twoSessions(
  t: TestContext,
  options: Parameters<typeof testDeck>[1] = {},
): TestDeck {
  const d = testDeck(t, options);
  writeTranscript(d, S1);
  writeTranscript(d, S2);
  return d;
}

/** The test context with `runner` in place of the fake one, for a command that starts `gh` or an editor. */
export function withRunner(d: TestDeck, runner: Runner): Context {
  return { io: d.ctx.io, platform: { ...d.platform, runner } };
}
