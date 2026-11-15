// Which session each terminal shows (S2 7.5) and which sessions run outside the window (S2 7.9;
// plan task 21). mapTerminals is pure over its input: the cases of the rule run on a fake /proc;
// the cases with real programs (the stand-in in a terminal, a wrapper, /clear, a stand-in in a pty
// of its own) run on realTestPlatform with real keepers.
import assert from 'node:assert/strict';
import { readlinkSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { parentPidFromStat } from '../../src/claude/procstat.ts';
import type { Ns, Proc } from '../../src/platform/types.ts';
import { launchPrepared } from '../../src/sessions/launch.ts';
import { loadSessions } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import type { Holder } from '../../src/sessions/types.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
import { mapTerminals } from '../../src/window/mapping.ts';
import { windowTerminal } from '../../src/window/window-terminal.ts';
import { ds } from '../helpers/derived.ts';
import { BOOT_A, BOOT_B, S1, S2, S3, SEC, T0, fakeProc, statLine } from '../helpers/platform.ts';
import type { FakeProc } from '../helpers/platform.ts';
import {
  CPR,
  CPR_ANSWER,
  DA1,
  DA1_ANSWER,
  started as startedFrame,
  until,
} from '../helpers/keeper.ts';
import type { Mirror, TestRegistry } from '../helpers/registry.ts';
import { standinCommand } from '../helpers/standin.ts';
import { windowDeck } from '../helpers/window-deck.ts';
import type { WindowDeck } from '../helpers/window-deck.ts';

const TIMEOUT: Ns = 120n * SEC;

function terminal(over: Partial<TerminalInfo> & { id: string }): TerminalInfo {
  return {
    slot: 1,
    state: 'running',
    expectedSessionId: S1,
    sessionId: null,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: null,
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

function holder(pid: number, procStart: number, over: Partial<Holder> = {}): Holder {
  return {
    process: { bootId: BOOT_A, pid, procStart },
    sinceNs: T0,
    live: null,
    scripted: false,
    ...over,
  };
}

/** A /proc/<pid>/stat line whose parent (field 4) is `ppid` and whose start (field 22) is `start`. */
function statWithParent(pid: number, start: number, ppid: number): string {
  const fixed = statLine(pid, start).replace(/^(\d+ \(claude\) S) 1 /, `$1 ${ppid} `);
  assert.equal(parentPidFromStat(fixed), ppid, 'the parent field was set');
  return fixed;
}

/** A fake /proc with each process [pid, start, ppid]. */
function procOf(processes: [pid: number, start: number, ppid: number][]): FakeProc {
  const proc = fakeProc({ bootId: BOOT_A });
  for (const [pid, start, ppid] of processes) {
    proc.setProcess(pid, { stat: statWithParent(pid, start, ppid), cmdline: [] });
  }
  return proc;
}

function map(
  terminals: TerminalInfo[],
  sessions: ReturnType<typeof ds>[],
  proc: Proc,
  over: { bootId?: string | null; nowNs?: Ns } = {},
): ReturnType<typeof mapTerminals> {
  return mapTerminals({
    terminals,
    sessions,
    proc,
    bootId: over.bootId === undefined ? BOOT_A : over.bootId,
    nowNs: over.nowNs ?? T0 + SEC,
    startTimeoutNs: TIMEOUT,
  });
}

const PROGRAM = { pid: 5000, procStart: 900 };

describe('mapTerminals: which session a terminal shows', () => {
  test('a holder whose pid and process start are the program: shown, not elsewhere', () => {
    const proc = procOf([[5000, 900, 4000]]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
      proc,
    );
    assert.deepEqual([...got.shown], [['aaaaaaaaaaaa', S1]]);
    assert.deepEqual([...got.notReported], []);
    assert.deepEqual([...got.elsewhere], []);
  });

  test('a holder that descends from the program (a wrapper as claudeCommand): shown', () => {
    const proc = procOf([
      [5000, 900, 4000],
      [5001, 901, 5000],
      [5002, 902, 5001],
    ]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S2, state: 'running', holders: [holder(5002, 902)] })],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S2);
    assert.equal(got.elsewhere.size, 0);
  });

  test('at most 8 steps up: a program 8 parents above the holder is its terminal, 9 is not', () => {
    // 5000 is the program; 5001 its child, … 5009 nine steps below it.
    const chain: [number, number, number][] = [[5000, 900, 4000]];
    for (let i = 1; i <= 9; i++) {
      chain.push([5000 + i, 900 + i, 5000 + i - 1]);
    }
    const proc = procOf(chain);
    const eight = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(5008, 908)] })],
      proc,
    );
    assert.equal(eight.shown.get('aaaaaaaaaaaa'), S1);
    const nine = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(5009, 909)] })],
      proc,
    );
    assert.equal(nine.shown.get('aaaaaaaaaaaa'), null);
    assert.deepEqual(nine.elsewhere.get(S1), { pid: 5009, tty: null });
  });

  test('a pid of the program with another process start is not the program (pid reused)', () => {
    const proc = procOf([[5000, 777, 4000]]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(5000, 777)] })],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), null);
    assert.ok(got.elsewhere.has(S1));
  });

  test('a parent that started after its child is another process that took the pid: not followed', () => {
    // 5001's parent field names 5000, but the process 5000 now has started later than 5001.
    const proc = procOf([
      [5000, 950, 4000],
      [5001, 901, 5000],
    ]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: { pid: 5000, procStart: 950 } })],
      [ds({ id: S1, state: 'running', holders: [holder(5001, 901)] })],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), null);
    assert.ok(got.elsewhere.has(S1));
  });

  test('a holder whose own process start does not match its stat line is gone: not followed, not elsewhere', () => {
    const proc = procOf([
      [5000, 900, 4000],
      [5001, 999, 5000],
    ]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(5001, 901)] })],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), null);
    assert.equal(got.elsewhere.size, 0);
    assert.equal(got.unknown.size, 0);
  });

  test('a holder of another boot is no live holder: neither the terminal’s nor elsewhere', () => {
    const proc = procOf([[5000, 900, 4000]]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [
        ds({
          id: S1,
          state: 'running',
          holders: [holder(5000, 900, { process: { bootId: BOOT_B, pid: 5000, procStart: 900 } })],
        }),
      ],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), null);
    assert.equal(got.elsewhere.size, 0);
    assert.equal(got.unknown.size, 0);
  });

  test('the holder nearest the program decides: a scripted run below it does not move the terminal', () => {
    // The program (5000) holds S1; a `claude -p` it ran (5002, two steps below) holds S2.
    const proc = procOf([
      [5000, 900, 4000],
      [5001, 901, 5000],
      [5002, 902, 5001],
    ]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [
        ds({
          id: S2,
          state: 'running',
          holders: [holder(5002, 902, { sinceNs: T0 + 5n * SEC, scripted: true })],
        }),
        ds({ id: S1, state: 'running', holders: [holder(5000, 900)] }),
      ],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.equal(got.elsewhere.size, 0, 'the scripted run belongs to the terminal: not elsewhere');
  });

  test('two holders at the same distance: the one with the latest event', () => {
    const proc = procOf([
      [5000, 900, 4000],
      [5001, 901, 5000],
      [5002, 902, 5000],
    ]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [
        ds({ id: S1, state: 'running', holders: [holder(5001, 901, { sinceNs: T0 })] }),
        ds({ id: S2, state: 'running', holders: [holder(5002, 902, { sinceNs: T0 + SEC })] }),
      ],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S2);
  });

  test('each terminal gets its own session; one with none of its own shows nothing', () => {
    const proc = procOf([
      [5000, 900, 4000],
      [6000, 600, 4000],
    ]);
    const got = map(
      [
        terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM }),
        terminal({ id: 'bbbbbbbbbbbb', program: { pid: 6000, procStart: 600 } }),
        terminal({ id: 'cccccccccccc', program: { pid: 7000, procStart: 700 } }),
      ],
      [
        ds({ id: S1, state: 'running', holders: [holder(5000, 900)] }),
        ds({ id: S2, state: 'running', holders: [holder(6000, 600)] }),
      ],
      proc,
    );
    assert.deepEqual([...got.shown].sort(), [
      ['aaaaaaaaaaaa', S1],
      ['bbbbbbbbbbbb', S2],
      ['cccccccccccc', null],
    ]);
  });
});

describe('mapTerminals: no holder', () => {
  test('a program without a holder: null; after the timeout since it was opened, notReported', () => {
    const proc = procOf([[5000, 900, 4000]]);
    const terms = [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM, openedNs: T0 })];
    const early = map(terms, [], proc, { nowNs: T0 + TIMEOUT - 1n });
    assert.equal(early.shown.get('aaaaaaaaaaaa'), null);
    assert.equal(early.notReported.size, 0);
    const late = map(terms, [], proc, { nowNs: T0 + TIMEOUT });
    assert.equal(late.shown.get('aaaaaaaaaaaa'), null);
    assert.deepEqual([...late.notReported], ['aaaaaaaaaaaa']);
  });

  test('a terminal whose keeper has not started its program: null, never notReported', () => {
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', state: 'starting', program: null })],
      [],
      procOf([]),
      { nowNs: T0 + 10n * TIMEOUT },
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), null);
    assert.equal(got.notReported.size, 0);
  });

  test('a program that showed a session and holds none for a moment keeps it, and is not notReported', () => {
    // Between the end and the start of /clear the program holds nothing: it is not "starting".
    const proc = procOf([[5000, 900, 4000]]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM, sessionId: S1 })],
      [ds({ id: S1 })],
      proc,
      { nowNs: T0 + 10n * TIMEOUT },
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.equal(got.notReported.size, 0);
  });

  test('an ended terminal keeps the session it showed; its old program pid is no one', () => {
    // The pid of the ended program now belongs to a process outside the window, same start
    // even (it cannot be, but the exit is what counts): the session runs elsewhere.
    const proc = procOf([[5000, 900, 4000]]);
    const exit = { code: 0, signal: null, atNs: String(T0), notStarted: null };
    const got = map(
      [
        terminal({ id: 'aaaaaaaaaaaa', state: 'ended', program: PROGRAM, sessionId: S1, exit }),
        terminal({
          id: 'bbbbbbbbbbbb',
          state: 'not-started',
          expectedSessionId: S3,
          exit: { ...exit, code: null, notStarted: 'x' },
        }),
      ],
      [ds({ id: S2, state: 'running', holders: [holder(5000, 900)] })],
      proc,
      { nowNs: T0 + 10n * TIMEOUT },
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.equal(got.shown.get('bbbbbbbbbbbb'), null);
    assert.equal(got.notReported.size, 0, 'an ended terminal is not "started, not reported"');
    assert.ok(got.elsewhere.has(S2));
  });

  test('a holder of another session wins over the one the terminal showed', () => {
    const proc = procOf([[5000, 900, 4000]]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM, sessionId: S1 })],
      [ds({ id: S2, state: 'running', holders: [holder(5000, 900)] })],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S2);
  });
});

/** `proc` whose stat throws (EACCES) for `pid`: a process that is there but cannot be read. */
function unreadable(proc: Proc, pid: number): Proc {
  return {
    ...proc,
    stat: (asked) => {
      if (asked === pid) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return proc.stat(asked);
    },
  };
}

describe('mapTerminals: a /proc read that fails is unknown (ruled)', () => {
  /**
   * Terminal A (program 5000) shows S3 (its holder is the program); B (program 6000) and C
   * (program 7000) have no holder and were opened long ago, C already "not reported"; S2 runs
   * outside (8000); S1's holder is `s1Holder`.
   */
  function pass(
    proc: Proc,
    s1Holder: Holder,
    aShowed: string | null = null,
  ): ReturnType<typeof mapTerminals> {
    return map(
      [
        terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM, sessionId: aShowed }),
        terminal({ id: 'bbbbbbbbbbbb', program: { pid: 6000, procStart: 600 } }),
        terminal({ id: 'cccccccccccc', program: { pid: 7000, procStart: 700 }, notReported: true }),
      ],
      [
        ds({ id: S1, state: 'running', holders: [s1Holder] }),
        ds({ id: S2, state: 'running', holders: [holder(8000, 800)] }),
        ds({ id: S3, state: 'running', holders: [holder(5000, 900)] }),
      ],
      proc,
      { nowNs: T0 + 10n * TIMEOUT },
    );
  }
  const PROCESSES: [number, number, number][] = [
    [5000, 900, 4000],
    [5001, 901, 5000],
    [5002, 902, 5001],
    [6000, 600, 4000],
    [7000, 700, 4000],
    [8000, 800, 1],
  ];

  test('at the holder: its session is unknown, not elsewhere; the rest of the pass is decided', () => {
    const got = pass(unreadable(procOf(PROCESSES), 5002), holder(5002, 902));
    assert.deepEqual([...got.unknown], [S1]);
    assert.equal(got.elsewhere.has(S1), false);
    assert.deepEqual([...got.elsewhere.keys()], [S2]);
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S3);
    assert.equal(got.shown.get('bbbbbbbbbbbb'), null);
  });

  test('in such a pass no terminal is newly “not reported”; one that was stays', () => {
    const got = pass(unreadable(procOf(PROCESSES), 5002), holder(5002, 902));
    assert.deepEqual([...got.notReported], ['cccccccccccc']);
    // The same pass with every read working: B is not reported now.
    const readable = pass(procOf(PROCESSES), holder(8000, 800));
    assert.deepEqual([...readable.notReported].sort(), ['bbbbbbbbbbbb', 'cccccccccccc']);
    assert.equal(readable.unknown.size, 0);
  });

  test('at an ancestor: unknown too; a terminal it may belong to keeps what it showed', () => {
    const proc = unreadable(procOf(PROCESSES), 5001);
    const got = pass(proc, holder(5002, 902), S1);
    assert.deepEqual([...got.unknown], [S1]);
    assert.equal(got.elsewhere.has(S1), false);
    // A is shown S3 by its readable holder; with no other holder it would keep S1.
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S3);
    const alone = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM, sessionId: S1 })],
      [ds({ id: S1, state: 'running', holders: [holder(5002, 902)] })],
      proc,
    );
    assert.equal(alone.shown.get('aaaaaaaaaaaa'), S1);
    assert.deepEqual([...alone.unknown], [S1]);
  });

  test('a stat line whose process start or parent cannot be read is unknown, not “gone”', () => {
    const proc = procOf(PROCESSES);
    proc.setProcess(5001, { stat: '5001 (claude) S', cmdline: [] });
    const got = pass(proc, holder(5002, 902));
    assert.deepEqual([...got.unknown], [S1]);
    assert.equal(got.elsewhere.has(S1), false);
  });

  test('a session with one unreadable holder and one that is a terminal’s: shown by that one, still unknown', () => {
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(5002, 902), holder(5000, 900)] })],
      unreadable(procOf(PROCESSES), 5002),
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.deepEqual([...got.unknown], [S1]);
    assert.equal(got.elsewhere.size, 0);
  });

  test('without a boot id every running session is unknown: nothing elsewhere, nothing newly not reported', () => {
    const got = pass(procOf(PROCESSES), holder(8000, 800));
    assert.equal(got.unknown.size, 0);
    const none = map(
      [terminal({ id: 'bbbbbbbbbbbb', program: { pid: 6000, procStart: 600 } })],
      [ds({ id: S2, state: 'running', holders: [holder(8000, 800)] })],
      procOf(PROCESSES),
      { bootId: null, nowNs: T0 + 10n * TIMEOUT },
    );
    assert.deepEqual([...none.unknown], [S2]);
    assert.equal(none.elsewhere.size, 0);
    assert.equal(none.notReported.size, 0);
    assert.equal(none.shown.get('bbbbbbbbbbbb'), null);
    // Derive sees no holder at all without a boot id: still nothing newly not reported.
    const empty = map(
      [terminal({ id: 'bbbbbbbbbbbb', program: { pid: 6000, procStart: 600 } })],
      [],
      procOf(PROCESSES),
      { bootId: null, nowNs: T0 + 10n * TIMEOUT },
    );
    assert.equal(empty.notReported.size, 0);
  });

  test('a pass in which nothing is unknown has an empty set', () => {
    const got = map([], [ds({ id: S1 })], procOf([]));
    assert.equal(got.unknown.size, 0);
  });
});

describe('mapTerminals: a holder that is gone runs nowhere (review 2)', () => {
  // The sessions were derived a moment before: the holder has ended since, or its pid is another
  // process's now. By design 5.5 it is dead: not in a terminal, not elsewhere, not unknown.
  const exit = { code: 0, signal: null, atNs: String(T0), notStarted: null };
  const terminals = (): TerminalInfo[] => [
    terminal({ id: 'aaaaaaaaaaaa', state: 'ended', program: PROGRAM, sessionId: S1, exit }),
    terminal({ id: 'bbbbbbbbbbbb', program: { pid: 6000, procStart: 600 } }),
  ];

  test('the holder’s process is gone (the terminal’s program that has just ended)', () => {
    const got = map(
      terminals(),
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
      procOf([[6000, 600, 4000]]),
    );
    assert.deepEqual([...got.elsewhere], []);
    assert.deepEqual([...got.unknown], []);
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
  });

  test('the holder’s pid is another process now: never named as running elsewhere', () => {
    const proc = procOf([
      [5000, 999_999, 1],
      [6000, 600, 4000],
    ]);
    proc.setFdTarget(5000, 0, '/dev/pts/42');
    const got = map(
      terminals(),
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
      proc,
    );
    assert.deepEqual([...got.elsewhere], []);
    assert.deepEqual([...got.unknown], []);
  });

  test('also with no terminal at all: a gone holder is not elsewhere, a live one is', () => {
    const proc = procOf([[8000, 800, 1]]);
    const got = map(
      [],
      [
        ds({ id: S1, state: 'running', holders: [holder(5000, 900)] }),
        ds({ id: S2, state: 'running', holders: [holder(8000, 800)] }),
      ],
      proc,
    );
    assert.deepEqual([...got.elsewhere.keys()], [S2]);
  });

  test('of two holders the gone one is skipped: elsewhere names the live one', () => {
    const proc = procOf([[8100, 810, 1]]);
    const got = map(
      [],
      [ds({ id: S1, state: 'running', holders: [holder(8000, 800), holder(8100, 810)] })],
      proc,
    );
    assert.deepEqual(got.elsewhere.get(S1), { pid: 8100, tty: null });
  });
});

describe('mapTerminals: elsewhere', () => {
  test('a running session none of whose holders is a terminal’s: the first holder’s pid and fd 0', () => {
    const proc = procOf([
      [5000, 900, 4000],
      [8000, 800, 1],
      [8100, 810, 1],
    ]);
    proc.setFdTarget(8000, 0, '/dev/pts/7');
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [
        ds({ id: S1, state: 'running', holders: [holder(8000, 800), holder(8100, 810)] }),
        ds({ id: S2, state: 'running', holders: [holder(8100, 810)] }),
        ds({ id: S3 }),
      ],
      proc,
    );
    assert.deepEqual(got.elsewhere.get(S1), { pid: 8000, tty: '/dev/pts/7' });
    assert.deepEqual(got.elsewhere.get(S2), { pid: 8100, tty: null }, 'fd 0 not readable: null');
    assert.equal(got.elsewhere.has(S3), false, 'not running: not elsewhere');
  });

  test('a session with one holder in a terminal and one outside is not elsewhere', () => {
    const proc = procOf([
      [5000, 900, 4000],
      [8000, 800, 1],
    ]);
    const got = map(
      [terminal({ id: 'aaaaaaaaaaaa', program: PROGRAM })],
      [ds({ id: S1, state: 'running', holders: [holder(8000, 800), holder(5000, 900)] })],
      proc,
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.equal(got.elsewhere.has(S1), false);
  });
});

describe('mapTerminals: a lost keeper’s program while it lives (task 57; S2 7.5, 7.8)', () => {
  // A keeper that died sent no X: its exit is made up at once (SIGHUP), while the program it
  // started may still run its end for a moment, given to init.
  const lostExit = { code: null, signal: 1, atNs: String(T0), notStarted: null };
  const lost = (over: Partial<TerminalInfo> = {}): TerminalInfo =>
    terminal({
      id: 'aaaaaaaaaaaa',
      state: 'lost',
      program: PROGRAM,
      sessionId: S1,
      exit: lostExit,
      ...over,
    });

  test('its program still lives (its stat line names the start the keeper reported): the holder is the terminal’s, not elsewhere', () => {
    const got = map(
      [lost({ openedNs: T0 - 10n * TIMEOUT })],
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
      procOf([[5000, 900, 1]]),
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.deepEqual([...got.elsewhere], []);
    assert.deepEqual([...got.unknown], []);
    assert.equal(
      got.notReported.size,
      0,
      'a terminal with an exit is never "started, not reported"',
    );
  });

  test('also while lose()’s exit is on its way through the screen side (the state not yet lost), and for a holder below the program (a wrapper)', () => {
    const proc = procOf([
      [5000, 900, 1],
      [5001, 901, 5000],
    ]);
    for (const state of ['reconnecting', 'running', 'lost'] as const) {
      // The holder is the program itself, or its child below a wrapper.
      for (const held of [holder(5000, 900), holder(5001, 901)]) {
        const what = `${state}, holder ${held.process.pid}`;
        const got = map(
          [lost({ state })],
          [ds({ id: S1, state: 'running', holders: [held] })],
          proc,
        );
        assert.equal(got.shown.get('aaaaaaaaaaaa'), S1, what);
        assert.equal(got.elsewhere.has(S1), false, what);
      }
    }
  });

  test('a session held by the lost program and by a process outside is not elsewhere while the program lives', () => {
    const got = map(
      [lost()],
      [ds({ id: S1, state: 'running', holders: [holder(8000, 800), holder(5000, 900)] })],
      procOf([
        [5000, 900, 1],
        [8000, 800, 1],
      ]),
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.equal(got.elsewhere.has(S1), false);
  });

  test('once the program is gone it counts no more: its holder is gone, and a holder outside makes the session elsewhere', () => {
    const got = map(
      [lost()],
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900), holder(8000, 800)] })],
      procOf([[8000, 800, 1]]),
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1, 'it keeps the session it showed');
    assert.deepEqual(got.elsewhere.get(S1), { pid: 8000, tty: null });
  });

  test('its pid is another process now (another start): never the terminal’s program — a pid alone is no one', () => {
    const got = map(
      [lost()],
      [ds({ id: S2, state: 'running', holders: [holder(5000, 901)] })],
      procOf([[5000, 901, 1]]),
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1, 'not moved to S2');
    assert.deepEqual(got.elsewhere.get(S2), { pid: 5000, tty: null });
  });

  test('its pid is another process now, and the dead program’s own holder record is still in the rows: that holder is gone, not the terminal’s', () => {
    // The one input on which the start check of `lives` decides: the holder record has the
    // program's own pid and start, so holderPlace would match it with the program at once.
    for (const start of [899, 901]) {
      const got = map(
        [lost()],
        [ds({ id: S1, state: 'running', holders: [holder(5000, 900), holder(8000, 800)] })],
        procOf([
          [5000, start, 1],
          [8000, 800, 1],
        ]),
      );
      assert.deepEqual(got.elsewhere.get(S1), { pid: 8000, tty: null }, `start ${start}`);
      assert.deepEqual([...got.unknown], [], `start ${start}`);
    }
  });

  test('its stat line cannot be read, or names no process start: it may still run, so it counts — never “elsewhere”', () => {
    // Ruled (review 2's SHOULD 1): what cannot be told is not taken for gone (Proc's contract).
    const procs = (): Proc[] => {
      const noStart = procOf([[5001, 901, 5000]]);
      noStart.setProcess(5000, { stat: '5000 (claude) S 1', cmdline: [] });
      return [
        unreadable(
          procOf([
            [5000, 900, 1],
            [5001, 901, 5000],
          ]),
          5000,
        ),
        noStart,
      ];
    };
    for (const proc of procs()) {
      // The holder is the program: matched by its pid and start, nothing more to read.
      const own = map(
        [lost()],
        [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
        proc,
      );
      assert.equal(own.shown.get('aaaaaaaaaaaa'), S1);
      assert.equal(own.elsewhere.has(S1), false);
      assert.deepEqual([...own.unknown], []);
      // A holder below it: its walk meets the same read, so its session is unknown.
      const below = map(
        [lost()],
        [ds({ id: S1, state: 'running', holders: [holder(5001, 901)] })],
        proc,
      );
      assert.equal(below.shown.get('aaaaaaaaaaaa'), S1);
      assert.equal(below.elsewhere.has(S1), false);
      assert.deepEqual([...below.unknown], [S1]);
    }
  });

  test('a read of its stat line that fails once (EMFILE) and works a moment later: still the terminal’s, not elsewhere', () => {
    for (const held of [holder(5000, 900), holder(5001, 901)]) {
      const base = procOf([
        [5000, 900, 1],
        [5001, 901, 5000],
      ]);
      let failed = false;
      const proc: Proc = {
        ...base,
        stat: (pid) => {
          if (pid === 5000 && !failed) {
            failed = true;
            throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
          }
          return base.stat(pid);
        },
      };
      const got = map([lost()], [ds({ id: S1, state: 'running', holders: [held] })], proc);
      assert.ok(failed, 'the read failed once');
      const what = `holder ${held.process.pid}`;
      assert.equal(got.shown.get('aaaaaaaaaaaa'), S1, what);
      assert.equal(got.elsewhere.has(S1), false, what);
      assert.deepEqual([...got.unknown], [], what);
    }
  });

  test('only for less than 60 s after the loss: then everything is as for any ended terminal (ruled)', () => {
    const proc = procOf([[5000, 900, 1]]);
    const at = (ageNs: Ns): ReturnType<typeof mapTerminals> =>
      map(
        [lost({ exit: { ...lostExit, atNs: String(T0) } })],
        [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
        proc,
        { nowNs: T0 + ageNs },
      );
    for (const ageNs of [0n, 59n * SEC, 60n * SEC - 1n]) {
      assert.equal(at(ageNs).elsewhere.has(S1), false, `kept at ${ageNs} ns`);
      assert.equal(at(ageNs).shown.get('aaaaaaaaaaaa'), S1, `kept at ${ageNs} ns`);
    }
    for (const ageNs of [60n * SEC, 61n * SEC, 3600n * SEC]) {
      assert.deepEqual(
        at(ageNs).elsewhere.get(S1),
        { pid: 5000, tty: null },
        `as on main at ${ageNs} ns`,
      );
    }
  });

  test('a clock that stepped back since the loss keeps the program (it never counts out early)', () => {
    const got = map(
      [lost({ exit: { ...lostExit, atNs: String(T0 + 3600n * SEC) } })],
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
      procOf([[5000, 900, 1]]),
      { nowNs: T0 },
    );
    assert.equal(got.shown.get('aaaaaaaaaaaa'), S1);
    assert.equal(got.elsewhere.has(S1), false);
  });

  test('an exit time that is no decimal number counts the program out, as before, and does not throw', () => {
    const got = map(
      [lost({ exit: { ...lostExit, atNs: 'not a time' } })],
      [ds({ id: S1, state: 'running', holders: [holder(5000, 900)] })],
      procOf([[5000, 900, 1]]),
    );
    assert.deepEqual(got.elsewhere.get(S1), { pid: 5000, tty: null });
  });

  test('an exit the keeper sent (ended, not started) counts the program never, even with its pid and start alive', () => {
    const exit = { code: 0, signal: null, atNs: String(T0), notStarted: null };
    for (const over of [
      { state: 'ended' as const, exit },
      { state: 'not-started' as const, exit: { ...exit, code: null, notStarted: 'x' } },
    ]) {
      const got = map(
        [lost(over)],
        [ds({ id: S2, state: 'running', holders: [holder(5000, 900)] })],
        procOf([[5000, 900, 1]]),
      );
      assert.equal(got.shown.get('aaaaaaaaaaaa'), S1, over.state);
      assert.ok(got.elsewhere.has(S2), over.state);
    }
  });
});

describe('mapTerminals with real programs', { concurrency: true }, () => {
  const SIZE = { cols: 80, rows: 24 };

  /** S1 resumed in the window; its prompt is on the screen (its SessionStart hook has run). */
  async function launched(
    t: TestContext,
    options?: Parameters<typeof windowDeck>[1],
  ): Promise<{ w: WindowDeck; r: TestRegistry; id: string; m: Mirror }> {
    const w = await windowDeck(t, options);
    w.resumable(S1);
    const r = w.registry();
    const { deps } = w.deps(r);
    const outcome = await launchPrepared(
      w.deck,
      prepareResumeById(w.deck, S1),
      windowTerminal(deps, SIZE),
    );
    assert.equal(outcome.code, 0);
    const id = r.registry.list()[0]?.id ?? '';
    const m = await w.prompt(r, id, S1);
    return { w, r, id, m };
  }

  /** A refresh, then the mapping over what it loaded, as the server's tick does. */
  function mapNow(w: WindowDeck, r: TestRegistry): ReturnType<typeof mapTerminals> {
    refresh(w.deck);
    const { proc, clock } = w.tp.platform;
    return mapTerminals({
      terminals: r.registry.list(),
      sessions: loadSessions(w.deck),
      proc,
      bootId: proc.bootId(),
      nowNs: clock.nowNs(),
      startTimeoutNs: TIMEOUT,
    });
  }

  const holdersOf = (w: WindowDeck, sessionId: string): number[] =>
    loadSessions(w.deck)
      .find((s) => s.id === sessionId)
      ?.holders.map((h) => h.process.pid) ?? [];

  test('a holder whose pid is the program → shown at once, nothing elsewhere', async (t) => {
    const { w, r, id } = await launched(t);
    const got = mapNow(w, r);
    assert.equal(got.shown.get(id), S1);
    assert.equal(got.elsewhere.size, 0);
    assert.deepEqual(holdersOf(w, S1), [r.registry.list()[0]?.program?.pid]);
  });

  test('a wrapper as claudeCommand (the holder is the program’s child) → shown', async (t) => {
    const { w, r, id } = await launched(t, {
      claudeCommand: (s) => standinCommand(s, { wrapper: true }),
    });
    const got = mapNow(w, r);
    assert.equal(got.shown.get(id), S1);
    const program = r.registry.list()[0]?.program?.pid;
    const holders = holdersOf(w, S1);
    assert.equal(holders.length, 1);
    assert.notEqual(holders[0], program, 'the holder is not the program itself');
  });

  test('/clear → the new session is shown, and the old one is no longer held by the terminal', async (t) => {
    const { w, r, id } = await launched(t);
    assert.equal(r.registry.input(id, new TextEncoder().encode('/clear\r')), 'ok');
    let got = mapNow(w, r);
    await until(
      () => {
        got = mapNow(w, r);
        const shown = got.shown.get(id);
        return shown !== undefined && shown !== null && shown !== S1;
      },
      'the terminal shows the session /clear made',
      10_000,
    );
    assert.deepEqual(holdersOf(w, S1), []);
    assert.equal(got.elsewhere.size, 0);
  });

  test('a holder of another terminal (a stand-in in a pty of its own) → elsewhere, with its pid and fd 0', async (t) => {
    const { w, r, id } = await launched(t);
    const other = await w.start({ spec: { argv: [w.standin, '--resume', S2] } });
    const { client } = await other.claim();
    client.send('G');
    const started = startedFrame(await client.next('T', 15_000));
    await client.waitForOutput(DA1, 15_000);
    client.send('I', DA1_ANSWER);
    await client.waitForOutput(CPR, 15_000);
    client.send('I', CPR_ANSWER);
    await client.waitForOutput(`standin ${S2.slice(0, 8)}> `, 15_000); // its start hook has run
    const got = mapNow(w, r);
    assert.equal(got.shown.get(id), S1);
    const tty = readlinkSync(`/proc/${started.pid}/fd/0`);
    assert.match(tty, /^\/dev\/pts\/[0-9]+$/);
    assert.deepEqual(got.elsewhere.get(S2), { pid: started.pid, tty });
    assert.equal(got.elsewhere.has(S1), false);
  });
});
