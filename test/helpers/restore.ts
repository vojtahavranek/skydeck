/**
 * A machine after a restart, for the tests of `restore` (design 7.8): sessions whose processes ran
 * in earlier boots, with their transcripts on disk and their events in the store; and a fake tab
 * terminal whose tabs start (or do not start) `claude`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { isoFromNs } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { buildList, flatRows } from '../../src/sessions/list.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import type { EndDetail } from '../../src/store/types.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../../src/terminals/types.ts';
import { testDeck } from './deck.ts';
import type { TestDeck } from './deck.ts';
import { BOOT_B, SEC, T0, statLine } from './platform.ts';
import { hookInput, spoolName, spoolText } from './spool.ts';

/** A boot older than BOOT_A. */
export const BOOT_C = '8e3f4a5b-6c7d-4e8f-a09b-1c2d3e4f5a6b';
export const MINUTE: Ns = 60n * SEC;
export const HOUR: Ns = 60n * MINUTE;
export const DAY: Ns = 24n * HOUR;
/** The clock in the current boot, BOOT_B: two hours after BOOT_A's last event (T0). */
export const NOW: Ns = T0 + 2n * HOUR;
export const PROC_START = 51234567;

/** Session `n` (1–99): `000000nn-aaaa-4aaa-8aaa-aaaaaaaaaaaa`; its short id is `000000nn`. */
export function sid(n: number): string {
  return `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
}

/** testDeck in BOOT_B at NOW, with a handoff file as bin/skydeck gives it. */
export function restoreDeck(
  t: TestContext,
  options: Parameters<typeof testDeck>[1] = {},
): TestDeck {
  return testDeck(t, {
    bootId: BOOT_B,
    startNs: NOW,
    env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }),
    ...options,
  });
}

/** `<sandbox>/project`, the project directory of every session here (it exists). */
export function projectDir(d: TestDeck): string {
  const dir = join(d.sandbox.root, 'project');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface History {
  boot: string;
  pid: number;
  startNs: Ns;
  /** The `end` event that closed the holding; none: the process held the session at its last event. */
  end?: { detail: EndDetail; atNs: Ns };
  /** The recorded launch command of the start event; default ['claude']. */
  argv?: readonly string[];
  /** The time of the transcript's last record (an assistant record); default startNs + 1 minute. */
  activityNs?: Ns;
  /** The session's project directory (created); default projectDir(d). */
  dir?: string;
}

/**
 * Session `id` with a transcript on disk (a user record, then an assistant record: no turn in
 * progress) in its directory (history.dir, else projectDir(d)), and its start (and end) event
 * written through the store.
 */
export function addSession(d: TestDeck, id: string, history: History): void {
  const dir = history.dir ?? projectDir(d);
  mkdirSync(dir, { recursive: true });
  const activityNs = history.activityNs ?? history.startNs + MINUTE;
  const record = (type: string, atNs: Ns): string =>
    `${JSON.stringify({ type, sessionId: id, timestamp: isoFromNs(atNs), cwd: dir, entrypoint: 'cli' })}\n`;
  const folder = join(d.deck.places.claudeHome, 'projects', 'demo');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${id}.jsonl`),
    record('user', activityNs - 5n * SEC) + record('assistant', activityNs),
  );
  const event = (kind: 'start' | 'end', timeNs: Ns, detail: string) => ({
    spoolName: `${timeNs}-${history.pid}-${kind}-${id}.ev`,
    timeNs,
    kind,
    detail: detail as never,
    rawDetail: detail,
    sessionId: id,
    bootId: history.boot,
    pid: history.pid,
    procStart: PROC_START,
    cwd: dir,
    argv: kind === 'start' ? [...(history.argv ?? ['claude'])] : null,
    name: null,
    payload: null,
  });
  d.deck.store.insertEvent(event('start', history.startNs, 'startup'));
  if (history.end !== undefined) {
    d.deck.store.insertEvent(event('end', history.end.atNs, history.end.detail));
  }
}

/** A leftover live-session file of a dead process (pid, PROC_START) that says it was busy. */
export function leftoverBusyFile(d: TestDeck, id: string, pid: number): void {
  writeFileSync(
    join(d.deck.places.claudeHome, 'sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: id,
      cwd: projectDir(d),
      startedAt: 1794474000000,
      procStart: String(PROC_START),
      version: '2.1.323',
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'busy',
      updatedAt: 1794474030000,
      statusUpdatedAt: 1794474030000,
    }),
  );
}

/** refresh, then the rows in list order (`ls --all`), as the command passes them. */
export function listOrder(d: TestDeck): ListRow[] {
  refresh(d.deck);
  return flatRows(
    buildList(loadRows(d.deck), { showAll: true, filter: '', nowNs: d.clock.nowNs() }),
  );
}

let nextPid = 9000;

/**
 * `claude` started in the current boot for session `id`, as a tab would start it: the hook's
 * SessionStart spool file at the clock's time, and the process alive in the fake /proc (it keeps
 * running).
 */
export function startClaude(d: TestDeck, id: string, pid: number = nextPid++): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs: d.clock.nowNs(),
    pid,
    bootId: BOOT_B,
    pwd: projectDir(d),
    argv: ['claude', '--resume', id],
    input: hookInput('SessionStart', id, { source: 'resume', cwd: projectDir(d) }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, pid)), spoolText(fields));
  d.proc.setProcess(pid, { stat: statLine(pid, PROC_START), cmdline: ['claude'] });
}

/** The session id an argument list resumes (the word after `--resume`). */
export function resumedId(argv: readonly string[]): string {
  return argv[argv.indexOf('--resume') + 1] ?? '';
}

export interface FakeTabs {
  terminal: Terminal;
  /** The specs open() was called with, in order. */
  specs: LaunchSpec[];
  /** The session ids open() was called for, in order. */
  opened: string[];
}

/**
 * A terminal that opens tabs. open() records the spec; `onOpen` (if given) runs next and may
 * change the world; then a session for which `starts` is true gets its claude started
 * (startClaude); the result is `result(id)` (default ok), and a result 'reject' rejects.
 */
export function fakeTabs(
  d: TestDeck,
  options: {
    starts?: (id: string) => boolean;
    result?: (id: string) => OpenResult | 'reject';
    onOpen?: (count: number, id: string) => void | Promise<void>;
  } = {},
): FakeTabs {
  const specs: LaunchSpec[] = [];
  const opened: string[] = [];
  const terminal: Terminal = {
    name: 'wezterm',
    opensTabs: true,
    async open(spec) {
      const id = resumedId(spec.argv);
      specs.push(spec);
      opened.push(id);
      await options.onOpen?.(opened.length, id);
      if (options.starts?.(id) ?? true) {
        startClaude(d, id);
      }
      const result = options.result?.(id) ?? { ok: true };
      if (result === 'reject') {
        throw new Error('the terminal fell over');
      }
      return result;
    },
  };
  return { terminal, specs, opened };
}
