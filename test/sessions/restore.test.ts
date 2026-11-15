import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Ns } from '../../src/platform/types.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import {
  latestEarlierBoot,
  planRestore,
  restorePlan,
  runRestore,
} from '../../src/sessions/restore.ts';
import type {
  ReportOutcome,
  RestoreEntry,
  RestoreHooks,
  RestoreOutcome,
} from '../../src/sessions/restore.ts';
import { ResumeRefusedError, SkydeckError } from '../../src/platform/errors.ts';
import {
  acquireLock,
  lockKey,
  lockTakenNs,
  prepareResume,
  readLock,
} from '../../src/sessions/resume.ts';
import { handoffScript, hereTerminal } from '../../src/terminals/here.ts';
import { shellQuote } from '../../src/text/shell.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../../src/terminals/types.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { ds, rowOf } from '../helpers/derived.ts';
import { BOOT_A, BOOT_B, SEC, T0 } from '../helpers/platform.ts';
import {
  BOOT_C,
  DAY,
  HOUR,
  MINUTE,
  NOW,
  PROC_START,
  addSession,
  fakeTabs,
  leftoverBusyFile,
  listOrder,
  projectDir,
  restoreDeck,
  sid,
  startClaude,
} from '../helpers/restore.ts';

const BOOT_D = '9f4a5b6c-7d8e-4f9a-b0ac-2d3e4f5a6b7c';

/** What a test compares of an entry: everything but the row, which is checked by its id. */
function shape(entry: RestoreEntry): Record<string, unknown> {
  const { row, ...rest } = entry;
  return { id: row.id, ...rest };
}

// --- planRestore -------------------------------------------------------------------------------

/**
 * The machine of the plan's table: current boot BOOT_B; BOOT_A earlier, its last event at T0;
 * BOOT_C older, its last event at T0 - 1 day.
 */
function restartedMachine(t: Parameters<typeof restoreDeck>[0]): TestDeck {
  const d = restoreDeck(t);
  const earlier = T0 - HOUR;
  addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs: earlier });
  addSession(d, sid(2), {
    boot: BOOT_A,
    pid: 102,
    startNs: earlier,
    end: { detail: 'other', atNs: T0 - 30n * SEC },
  });
  addSession(d, sid(3), {
    boot: BOOT_A,
    pid: 103,
    startNs: earlier,
    end: { detail: 'other', atNs: T0 - 10n * MINUTE },
  });
  addSession(d, sid(4), {
    boot: BOOT_A,
    pid: 104,
    startNs: earlier,
    end: { detail: 'exit', atNs: T0 },
  });
  addSession(d, sid(5), { boot: BOOT_C, pid: 105, startNs: T0 - DAY });
  addSession(d, sid(6), { boot: BOOT_B, pid: 106, startNs: NOW - HOUR });
  addSession(d, sid(7), { boot: BOOT_A, pid: 107, startNs: earlier });
  d.deck.store.updateMeta(sid(7), { doneAtNs: T0 }, T0);
  addSession(d, sid(8), { boot: BOOT_A, pid: 108, startNs: earlier });
  refresh(d.deck);
  rmSync(join(d.deck.places.claudeHome, 'projects', 'demo', `${sid(8)}.jsonl`));
  addSession(d, sid(9), { boot: BOOT_A, pid: 109, startNs: earlier });
  leftoverBusyFile(d, sid(9), 109);
  refresh(d.deck);
  return d;
}

const S1_ENTRY = {
  id: sid(1),
  bootId: BOOT_A,
  endedAtNs: null,
  wasWorking: false,
  preselected: true,
};
const S2_ENTRY = {
  id: sid(2),
  bootId: BOOT_A,
  endedAtNs: T0 - 30n * SEC,
  wasWorking: false,
  preselected: true,
};
const S3_ENTRY = {
  id: sid(3),
  bootId: BOOT_A,
  endedAtNs: T0 - 10n * MINUTE,
  wasWorking: false,
  preselected: false,
};
const S5_ENTRY = {
  id: sid(5),
  bootId: BOOT_C,
  endedAtNs: null,
  wasWorking: false,
  preselected: true,
};
const S6_ENTRY = {
  id: sid(6),
  bootId: BOOT_B,
  endedAtNs: null,
  wasWorking: false,
  preselected: true,
};
const S9_ENTRY = {
  id: sid(9),
  bootId: BOOT_A,
  endedAtNs: null,
  wasWorking: true,
  preselected: true,
};

test('the default set: what ended unexpectedly in the latest earlier boot, not done, not expired', (t) => {
  const d = restartedMachine(t);
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, false);
  assert.deepEqual(entries.map(shape), [S1_ENTRY, S2_ENTRY, S3_ENTRY, S9_ENTRY]);
});

test('--all adds what ended unexpectedly in any other boot, the current one included', (t) => {
  const d = restartedMachine(t);
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, true);
  assert.deepEqual(entries.map(shape), [
    S1_ENTRY,
    S2_ENTRY,
    S3_ENTRY,
    S5_ENTRY,
    S6_ENTRY,
    S9_ENTRY,
  ]);
});

test('entries come out in the order of the given rows', (t) => {
  const d = restartedMachine(t);
  const rows = loadRows(d.deck).reverse();
  const entries = planRestore(rows, d.deck.store.events(), BOOT_B, true);
  assert.deepEqual(
    entries.map((entry) => entry.row.id),
    [sid(9), sid(6), sid(5), sid(3), sid(2), sid(1)],
  );
  assert.equal(entries[0]?.row, rows[0]);
});

test('without an earlier boot the default set is empty; --all still finds the current boot', (t) => {
  const d = restoreDeck(t);
  addSession(d, sid(1), { boot: BOOT_B, pid: 101, startNs: NOW - HOUR });
  addSession(d, sid(2), { boot: BOOT_B, pid: 102, startNs: NOW - HOUR });
  refresh(d.deck);
  const rows = loadRows(d.deck);
  assert.deepEqual(planRestore(rows, d.deck.store.events(), BOOT_B, false), []);
  assert.deepEqual(
    planRestore(rows, d.deck.store.events(), BOOT_B, true).map((entry) => entry.row.id),
    [sid(1), sid(2)],
  );
});

test('preselected: ended at or after two minutes before the last event of its boot', (t) => {
  const d = restoreDeck(t);
  const twoMinutesBefore = T0 - 2n * MINUTE;
  addSession(d, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    end: { detail: 'other', atNs: twoMinutesBefore },
  });
  addSession(d, sid(2), {
    boot: BOOT_A,
    pid: 102,
    startNs: T0 - HOUR,
    end: { detail: 'other', atNs: twoMinutesBefore - 1n },
  });
  addSession(d, sid(3), {
    boot: BOOT_A,
    pid: 103,
    startNs: T0 - HOUR,
    end: { detail: 'exit', atNs: T0 },
  });
  refresh(d.deck);
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, false);
  assert.deepEqual(
    entries.map((entry) => [entry.row.id, entry.preselected]),
    [
      [sid(1), true],
      [sid(2), false],
    ],
  );
});

test('with --all an entry is preselected against the last event of its own boot (D17)', (t) => {
  const d = restartedMachine(t);
  const bootCEnd = T0 - DAY; // BOOT_C's last event so far: sid(5)'s start
  // Ended 30 s before BOOT_C's last event: hours before BOOT_A's, still preselected.
  addSession(d, sid(10), {
    boot: BOOT_C,
    pid: 110,
    startNs: bootCEnd - HOUR,
    end: { detail: 'other', atNs: bootCEnd - 30n * SEC },
  });
  // Ended ten minutes before BOOT_C's last event: not preselected.
  addSession(d, sid(11), {
    boot: BOOT_C,
    pid: 111,
    startNs: bootCEnd - HOUR,
    end: { detail: 'other', atNs: bootCEnd - 10n * MINUTE },
  });
  refresh(d.deck);
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, true);
  assert.deepEqual(
    entries
      .filter((entry) => entry.bootId === BOOT_C)
      .map((entry) => [entry.row.id, entry.endedAtNs, entry.preselected]),
    [
      [sid(5), null, true],
      [sid(10), bootCEnd - 30n * SEC, true],
      [sid(11), bootCEnd - 10n * MINUTE, false],
    ],
  );
});

test('a boot counts as earlier only when a session was held in it: an end alone does not', (t) => {
  const d = restartedMachine(t);
  // BOOT_D is later than BOOT_A but has only an end event: no session was held in it.
  d.deck.store.insertEvent({
    spoolName: `boot-d-end.ev`,
    timeNs: T0 + HOUR,
    kind: 'end',
    detail: 'exit',
    rawDetail: 'prompt_input_exit',
    sessionId: sid(4),
    bootId: BOOT_D,
    pid: 4,
    procStart: 1,
    cwd: null,
    argv: null,
    name: null,
    payload: null,
  });
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, false);
  assert.deepEqual(
    entries.map((entry) => entry.row.id),
    [sid(1), sid(2), sid(3), sid(9)],
  );
});

test('a boot in which reconcile observed a session is an earlier boot like one with a start', (t) => {
  const d = restartedMachine(t);
  d.deck.store.insertEvent({
    spoolName: null,
    timeNs: T0 + HOUR,
    kind: 'observed',
    detail: '',
    rawDetail: null,
    sessionId: sid(10),
    bootId: BOOT_D,
    pid: 110,
    procStart: 1,
    cwd: projectDir(d),
    argv: ['claude'],
    name: null,
    payload: null,
  });
  refresh(d.deck);
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, false);
  // (sid(10) has no transcript, so the command, which passes listed rows only, would not offer it.)
  assert.deepEqual(
    entries.map((entry) => [entry.row.id, entry.bootId, entry.endedAtNs]),
    [[sid(10), BOOT_D, null]],
  );
});

/** A `scripted` (or `scripted-end`) event (design 5.3) of process `pid` of `bootId` on `sessionId`. */
function scriptedEvent(
  d: TestDeck,
  bootId: string,
  sessionId: string,
  timeNs: Ns,
  pid: number,
  kind: 'scripted' | 'scripted-end' = 'scripted',
): void {
  d.deck.store.insertEvent({
    spoolName: `${kind}-${pid}.ev`,
    timeNs,
    kind,
    detail: '',
    rawDetail: 'resume',
    sessionId,
    bootId,
    pid,
    procStart: 1,
    cwd: null,
    argv: null,
    name: null,
    payload: null,
  });
}

test('a scripted run late in a boot does not move that boot’s last event: the preselection stays', (t) => {
  const d = restoreDeck(t);
  addSession(d, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    end: { detail: 'other', atNs: T0 - 2n * MINUTE },
  });
  addSession(d, sid(3), {
    boot: BOOT_A,
    pid: 103,
    startNs: T0 - HOUR,
    end: { detail: 'exit', atNs: T0 },
  });
  refresh(d.deck);
  scriptedEvent(d, BOOT_A, sid(3), T0 + 10n * MINUTE, 201);
  scriptedEvent(d, BOOT_A, sid(3), T0 + 11n * MINUTE, 201, 'scripted-end');
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, false);
  assert.deepEqual(
    entries.map((entry) => [entry.row.id, entry.preselected]),
    [[sid(1), true]],
  );
});

test('a scripted run late in an older boot does not make it the latest earlier boot', (t) => {
  const d = restartedMachine(t);
  scriptedEvent(d, BOOT_C, sid(5), T0 + HOUR, 205); // later than BOOT_A's last event (T0)
  const entries = planRestore(loadRows(d.deck), d.deck.store.events(), BOOT_B, false);
  assert.deepEqual(
    entries.map((entry) => entry.row.id),
    [sid(1), sid(2), sid(3), sid(9)],
  );
});

// --- latestEarlierBoot and restorePlan (S2 11.1) -------------------------------------------------

test('latestEarlierBoot: the boot other than this one whose last event is the latest, and that event', (t) => {
  const d = restartedMachine(t);
  // A scripted run later in the older BOOT_C, and one late in BOOT_A: neither counts (design 5.3).
  scriptedEvent(d, BOOT_C, sid(5), T0 + HOUR, 205);
  scriptedEvent(d, BOOT_A, sid(4), T0 + 10n * MINUTE, 204, 'scripted-end');
  assert.deepEqual(latestEarlierBoot(d.deck.store.events(), BOOT_B), {
    bootId: BOOT_A,
    lastEventNs: T0,
  });
});

test('latestEarlierBoot: none when only the current boot held a session, or there are no events', (t) => {
  const d = restoreDeck(t);
  addSession(d, sid(1), { boot: BOOT_B, pid: 101, startNs: NOW - HOUR });
  assert.equal(latestEarlierBoot(d.deck.store.events(), BOOT_B), null);
  assert.equal(latestEarlierBoot([], BOOT_B), null);
});

test('latestEarlierBoot: of two earlier boots whose last events tie, the first by its id', (t) => {
  const d = restoreDeck(t);
  // BOOT_C's start is stored first: the choice does not follow the order of the events.
  addSession(d, sid(5), { boot: BOOT_C, pid: 105, startNs: T0 });
  addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs: T0 });
  assert.ok(BOOT_A < BOOT_C);
  assert.deepEqual(latestEarlierBoot(d.deck.store.events(), BOOT_B), {
    bootId: BOOT_A,
    lastEventNs: T0,
  });
});

test('restorePlan: planRestore’s entries over the rows in list order, and the earlier boot', (t) => {
  const d = restartedMachine(t);
  for (const all of [false, true]) {
    const plan = restorePlan(d.deck, all);
    const expected = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, all);
    assert.deepEqual(plan.entries.map(shape), expected.map(shape), `all: ${all}`);
    assert.deepEqual(plan.earlier, { bootId: BOOT_A, lastEventNs: T0 }, `all: ${all}`);
  }
  assert.deepEqual(
    restorePlan(d.deck, false)
      .entries.map(shape)
      .toSorted((a, b) => String(a['id']).localeCompare(String(b['id']))),
    [S1_ENTRY, S2_ENTRY, S3_ENTRY, S9_ENTRY],
  );
});

test('restorePlan takes the rows it is given and puts them in list order itself', (t) => {
  const d = restartedMachine(t);
  const inOrder = listOrder(d).filter((row) => row.id !== sid(2));
  const rows = loadRows(d.deck)
    .filter((row) => row.id !== sid(2))
    .reverse();
  const plan = restorePlan(d.deck, false, rows);
  assert.deepEqual(
    plan.entries.map(shape),
    planRestore(inOrder, d.deck.store.events(), BOOT_B, false).map(shape),
  );
  const ids = plan.entries.map((entry) => entry.row.id);
  assert.deepEqual(ids.toSorted(), [sid(1), sid(3), sid(9)]);
  assert.notDeepEqual(
    rows.map((row) => row.id).filter((id) => ids.includes(id)),
    ids,
    'the rows were given out of list order',
  );
  for (const entry of plan.entries) {
    assert.ok(rows.includes(entry.row), 'the entries hold the rows given');
  }
});

test('restorePlan orders the entries as ls --all lists them: a done row can make its group the newest', (t) => {
  const d = restoreDeck(t);
  addSession(d, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    activityNs: T0 - 10n * MINUTE,
  });
  addSession(d, sid(2), { boot: BOOT_A, pid: 102, startNs: T0 - HOUR, activityNs: T0 - MINUTE });
  addSession(d, sid(3), {
    boot: BOOT_A,
    pid: 103,
    startNs: T0 - HOUR,
    activityNs: T0 - 5n * MINUTE,
  });
  d.deck.store.updateMeta(sid(1), { group: 'g1' }, T0);
  d.deck.store.updateMeta(sid(2), { group: 'g1', doneAtNs: T0 }, T0); // done: not offered
  d.deck.store.updateMeta(sid(3), { group: 'g2' }, T0);
  refresh(d.deck);
  // g1's newest row is the done sid(2), newer than g2's sid(3): g1 comes first, as in ls --all.
  assert.deepEqual(
    restorePlan(d.deck, false).entries.map((entry) => entry.row.id),
    [sid(1), sid(3)],
  );
});

test('restorePlan refreshes nothing: a start in the spool since the last refresh is not seen yet', (t) => {
  const d = restartedMachine(t);
  startClaude(d, sid(1), 4242);
  const spooled = readdirSync(d.deck.places.spoolDir);
  assert.ok(restorePlan(d.deck, false).entries.some((entry) => entry.row.id === sid(1)));
  assert.deepEqual(readdirSync(d.deck.places.spoolDir), spooled);
});

test('restorePlan refuses rows without a boot id with the command’s message', (t) => {
  const d = restartedMachine(t);
  d.proc.setBootId(null);
  assert.throws(
    () => restorePlan(d.deck, false),
    (error: unknown) =>
      error instanceof SkydeckError &&
      error.exitCode === 1 &&
      error.message ===
        'cannot read the boot id (/proc/sys/kernel/random/boot_id): restore cannot tell which sessions are still running',
  );
});

test('restorePlan with no rows: no entries and no earlier boot, also without a boot id', (t) => {
  const d = restoreDeck(t);
  assert.deepEqual(restorePlan(d.deck, true), { entries: [], earlier: null });
  d.proc.setBootId(null);
  assert.deepEqual(restorePlan(d.deck, false), { entries: [], earlier: null });
  assert.deepEqual(restorePlan(restartedMachine(t).deck, false, []), {
    entries: [],
    earlier: null,
  });
});

// --- runRestore with tabs ----------------------------------------------------------------------

const TAB_CONFIG = { restoreBatch: 2, restoreStartTimeoutSeconds: 3, restoreMinFreeMb: 4096 };

/** Five sessions that ended unexpectedly in BOOT_A, in list order sid(1)…sid(5); their entries. */
function fiveToRestore(
  t: Parameters<typeof restoreDeck>[0],
  options: Parameters<typeof restoreDeck>[1] = {},
): { d: TestDeck; entries: RestoreEntry[]; sleeps: number[] } {
  const d = restoreDeck(t, { config: TAB_CONFIG, ...options });
  for (let n = 1; n <= 5; n++) {
    addSession(d, sid(n), {
      boot: BOOT_A,
      pid: 100 + n,
      startNs: T0 - HOUR,
      activityNs: T0 - BigInt(n) * MINUTE,
    });
  }
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  assert.deepEqual(
    entries.map((entry) => entry.row.id),
    [1, 2, 3, 4, 5].map(sid),
  );
  const sleeps: number[] = [];
  const sleep = d.clock.sleep;
  d.clock.sleep = (ms) => {
    sleeps.push(ms);
    return sleep(ms);
  };
  return { d, entries, sleeps };
}

async function run(
  d: TestDeck,
  terminal: Terminal,
  entries: readonly RestoreEntry[],
  hooks: RestoreHooks = {},
): Promise<{
  outcome: RestoreOutcome;
  lines: string[];
  /** Each line with the outcome report() was given for it. */
  reported: [string, ReportOutcome | undefined][];
}> {
  const lines: string[] = [];
  const reported: [string, ReportOutcome | undefined][] = [];
  const outcome = await runRestore(
    {
      deck: d.deck,
      terminal,
      report: (line, ended) => {
        lines.push(line);
        reported.push([line, ended]);
      },
      ...hooks,
    },
    entries,
  );
  return { outcome, lines, reported };
}

const NOTHING = {
  started: [],
  timedOut: [],
  failed: [],
  notStarted: [],
  handedOff: null,
  printed: [],
  stoppedForMemory: false,
  stopped: false,
};

function titleOf(entries: readonly RestoreEntry[], id: string): string {
  return entries.find((entry) => entry.row.id === id)?.row.title ?? '?';
}

test('five sessions that all start are opened in batches of 2, 2, 1, each after the last has started', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const lines: string[] = [];
  const reportedAtOpen: number[] = [];
  const tabs = fakeTabs(d, {
    onOpen: () => {
      reportedAtOpen.push(lines.length); // how many sessions were reported started by then
    },
  });
  const outcome = await runRestore(
    { deck: d.deck, terminal: tabs.terminal, report: (line) => lines.push(line) },
    entries,
  );
  assert.deepEqual(outcome, { ...NOTHING, started: [1, 2, 3, 4, 5].map(sid) });
  assert.deepEqual(tabs.opened, [1, 2, 3, 4, 5].map(sid));
  // The third open comes after both sessions of the first batch started, the fifth after the second batch.
  assert.deepEqual(reportedAtOpen, [0, 0, 2, 2, 4]);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(
    { cwd: tabs.specs[0]?.cwd, argv: tabs.specs[0]?.argv },
    { cwd: projectDir(d), argv: ['claude', '--resume', sid(1)] },
  );
  assert.deepEqual(
    lines,
    [1, 2, 3, 4, 5].map((n) => `started ${sid(n).slice(0, 8)} ${titleOf(entries, sid(n))}`),
  );
});

/** What a terminal needs beyond the command (S2 11.1): the session, the lock, the deadline, the label. */
function launchFields(spec: LaunchSpec | undefined): Record<string, unknown> {
  return {
    sessionId: spec?.sessionId,
    kind: spec?.kind,
    lock: spec?.lock,
    startByNs: spec?.startByNs,
    label: spec?.label,
  };
}

/** The deadline of a resume (A20): 55 s after the time its lock records. */
function deadlineOf(lock: string | null | undefined): bigint | null {
  return lock === null || lock === undefined ? null : BigInt(lock.split(':')[0] ?? '') + 55n * SEC;
}

test('restore gives a terminal that opens tabs each launch with the lock it took, its deadline and label', async (t) => {
  const { d, entries } = fiveToRestore(t);
  d.deck.store.updateMeta(sid(2), { label: 'fix it' }, T0);
  const locks: (string | null)[] = [];
  const tabs = fakeTabs(d, {
    onOpen: (_count, id) => {
      locks.push(readLock(d.deck, id)); // the lock as it is while the terminal opens
      d.clock.advanceMs(1500); // the next prepare takes its lock later
    },
  });
  await run(d, tabs.terminal, entries.slice(0, 2));
  assert.equal(locks.length, 2);
  assert.notEqual(locks[0], locks[1]);
  assert.deepEqual(tabs.specs.map(launchFields), [
    {
      sessionId: sid(1),
      kind: 'resume',
      lock: locks[0],
      startByNs: deadlineOf(locks[0]),
      label: null,
    },
    {
      sessionId: sid(2),
      kind: 'resume',
      lock: locks[1],
      startByNs: deadlineOf(locks[1]),
      label: 'fix it',
    },
  ]);
  assert.match(locks[0] ?? '', /^[0-9]+:[0-9]+$/);
});

test('restore hands a session off here with the lock it took, its deadline and label', async (t) => {
  const { d, entries } = fiveToRestore(t);
  d.deck.store.updateMeta(sid(1), { label: 'fix it' }, T0);
  const specs: LaunchSpec[] = [];
  const locks: (string | null)[] = [];
  const handoff = here(d);
  const recorded: Terminal = {
    ...handoff,
    open: (spec) => {
      specs.push(spec);
      locks.push(readLock(d.deck, spec.sessionId));
      return handoff.open(spec);
    },
  };
  await run(d, recorded, entries.slice(0, 2));
  assert.deepEqual(specs.map(launchFields), [
    {
      sessionId: sid(1),
      kind: 'resume',
      lock: locks[0],
      startByNs: deadlineOf(locks[0]),
      label: 'fix it',
    },
  ]);
  assert.match(locks[0] ?? '', /^[0-9]+:[0-9]+$/);
});

test('a session that does not start in time is reported after 3 checks a second apart; the next batch still runs', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const tabs = fakeTabs(d, { starts: (id) => id !== sid(2) });
  const { outcome, lines } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [1, 3, 4, 5].map(sid),
    timedOut: [sid(2)],
  });
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.deepEqual(tabs.opened, [1, 2, 3, 4, 5].map(sid));
  assert.ok(lines.includes(`timed out 00000002 ${titleOf(entries, sid(2))}`), lines.join('\n'));
  // Its tab may still open: its lock stays, so no other resume starts it a second time.
  assert.notEqual(d.deck.store.getKv(lockKey(sid(2))), null);
});

test('too little memory before the first batch: nothing is opened, all five are not started', async (t) => {
  const { d, entries } = fiveToRestore(t, { memAvailableMb: 3000 });
  const tabs = fakeTabs(d);
  const { outcome, lines } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome, {
    ...NOTHING,
    notStarted: [1, 2, 3, 4, 5].map(sid),
    stoppedForMemory: true,
  });
  assert.deepEqual(tabs.opened, []);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
  assert.ok(lines[0]?.includes('3000 MiB'), lines.join('\n'));
  assert.ok(lines.includes(`not started 00000005 ${titleOf(entries, sid(5))}`), lines.join('\n'));
});

test('memory that drops after the first batch stops the restore before the second', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    onOpen: (count) => {
      if (count === 2) {
        d.proc.setMemAvailableMb(3000);
      }
    },
  });
  const { outcome } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [sid(1), sid(2)],
    notStarted: [3, 4, 5].map(sid),
    stoppedForMemory: true,
  });
  assert.deepEqual(tabs.opened, [sid(1), sid(2)]);
});

test('memory that cannot be read counts as enough', async (t) => {
  const { d, entries } = fiveToRestore(t);
  d.proc.setMemAvailableMb(null);
  const { outcome } = await run(d, fakeTabs(d).terminal, entries);
  assert.deepEqual(outcome.started, [1, 2, 3, 4, 5].map(sid));
  assert.equal(outcome.stoppedForMemory, false);
});

test('a selected session that became running is refused and not opened', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(3), 4242);
  const tabs = fakeTabs(d);
  const { outcome, lines } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome.failed, [{ id: sid(3), reason: '00000003 is running (pid 4242)' }]);
  assert.deepEqual(outcome.started, [1, 2, 4, 5].map(sid));
  assert.deepEqual(tabs.opened, [1, 2, 4, 5].map(sid));
  assert.ok(lines.includes('failed 00000003: 00000003 is running (pid 4242)'), lines.join('\n'));
});

test('a tab that fails to open is a failure with the terminal’s reason; the others go on', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    starts: (id) => id !== sid(2),
    result: (id) => (id === sid(2) ? { ok: false, error: 'boom', timedOut: false } : { ok: true }),
  });
  const { outcome, lines } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome.failed, [{ id: sid(2), reason: 'boom' }]);
  assert.deepEqual(outcome.started, [1, 3, 4, 5].map(sid));
  assert.deepEqual(outcome.timedOut, []);
  assert.ok(lines.includes('failed 00000002: boom'), lines.join('\n'));
  // Nothing was started: the lock is released at once, the user is not kept waiting.
  assert.equal(d.deck.store.getKv(lockKey(sid(2))), null);
});

test('a terminal that rejects releases the lock too; one that timed out keeps it', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    starts: () => false,
    result: (id) => (id === sid(1) ? 'reject' : TAB_TIMEOUT),
  });
  await run(d, tabs.terminal, entries.slice(0, 2));
  assert.equal(d.deck.store.getKv(lockKey(sid(1))), null);
  assert.notEqual(d.deck.store.getKv(lockKey(sid(2))), null);
});

const TAB_TIMEOUT: OpenResult = {
  ok: false,
  error: 'wezterm timed out; a tab may have opened',
  timedOut: true,
};

test('a tab whose opening timed out may have opened: restore waits for its start like any other', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const lines: string[] = [];
  const reportedAtOpen: number[] = [];
  const tabs = fakeTabs(d, {
    onOpen: () => {
      reportedAtOpen.push(lines.length);
    },
    result: (id) => (id === sid(2) ? TAB_TIMEOUT : { ok: true }),
  });
  const outcome = await runRestore(
    { deck: d.deck, terminal: tabs.terminal, report: (line) => lines.push(line) },
    entries,
  );
  assert.deepEqual(outcome, { ...NOTHING, started: [1, 2, 3, 4, 5].map(sid) });
  assert.deepEqual(reportedAtOpen, [0, 0, 2, 2, 4]); // the third open waited for sid(2) too
  assert.deepEqual(sleeps, []);
});

test('a tab whose opening timed out and that never starts times out, keeps its lock, prints nothing', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const sleepsAtOpen: number[] = [];
  const tabs = fakeTabs(d, {
    onOpen: () => {
      sleepsAtOpen.push(sleeps.length);
    },
    starts: (id) => id !== sid(2),
    result: (id) => (id === sid(2) ? TAB_TIMEOUT : { ok: true }),
  });
  const { outcome, lines } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [1, 3, 4, 5].map(sid),
    timedOut: [sid(2)],
  });
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.notEqual(d.deck.store.getKv(lockKey(sid(2))), null);
  assert.equal(
    lines.some((line) => line.includes('cd --')),
    false,
    lines.join('\n'),
  );
  // The next batch waited for it: the third tab opened only after its three checks.
  assert.deepEqual(sleepsAtOpen, [0, 0, 3, 3, 3]);
});

test('a terminal whose open() rejects is a failed open, not an error of the restore', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    starts: (id) => id !== sid(1),
    result: (id) => (id === sid(1) ? 'reject' : { ok: true }),
  });
  const { outcome } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome.failed, [
    { id: sid(1), reason: 'cannot open the terminal (Error: the terminal fell over)' },
  ]);
  assert.deepEqual(outcome.started, [2, 3, 4, 5].map(sid));
});

test('a terminal’s reason is sanitised before it is reported', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    starts: () => false,
    result: () => ({ ok: false, error: 'no \x1b[31mwindow', timedOut: false }),
  });
  const { outcome, lines } = await run(d, tabs.terminal, entries.slice(0, 1));
  assert.deepEqual(outcome.failed, [{ id: sid(1), reason: 'no window' }]);
  assert.deepEqual(lines, ['failed 00000001: no window']);
});

test('a session the deck no longer knows is a failure', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const unknown = sid(42);
  const ghost: RestoreEntry = {
    row: rowOf(ds({ id: unknown, marks: ['ended-unexpectedly'] })),
    bootId: BOOT_A,
    endedAtNs: null,
    wasWorking: false,
    preselected: true,
  };
  const tabs = fakeTabs(d);
  const { outcome } = await run(d, tabs.terminal, [ghost, ...entries.slice(0, 1)]);
  assert.deepEqual(outcome.failed, [{ id: unknown, reason: 'no longer known' }]);
  assert.deepEqual(outcome.started, [sid(1)]);
  assert.deepEqual(tabs.opened, [sid(1)]);
});

test('flags skydeck does not know are named before the session is opened', async (t) => {
  const d = restoreDeck(t, { config: TAB_CONFIG });
  addSession(d, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    argv: ['claude', '--frob', '--model', 'opus'],
  });
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  const tabs = fakeTabs(d);
  const { lines } = await run(d, tabs.terminal, entries);
  assert.deepEqual(lines, [
    '00000001: started with flags skydeck does not know, not passed on resume: --frob',
    `started 00000001 ${titleOf(entries, sid(1))}`,
  ]);
  assert.deepEqual(tabs.specs[0]?.argv, ['claude', '--resume', sid(1), '--model', 'opus']);
});

// --- one session is never resumed twice (principle 7) --------------------------------------------

test('a restore run while another is opening the same sessions opens none of them a second time', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const second: { outcome?: RestoreOutcome } = {};
  const opened: string[] = [];
  const secondTabs = fakeTabs(d, {
    onOpen: (_count, id) => {
      opened.push(id);
    },
  });
  const firstTabs = fakeTabs(d, {
    onOpen: async (count, id) => {
      opened.push(id);
      if (count === 1) {
        // Another skydeck restores the same set while this one is opening its first tab.
        second.outcome = (await run(d, secondTabs.terminal, entries)).outcome;
      }
    },
  });
  const { outcome } = await run(d, firstTabs.terminal, entries);
  assert.deepEqual(opened.toSorted(), [1, 2, 3, 4, 5].map(sid));
  assert.deepEqual(firstTabs.opened, [sid(1)]);
  assert.deepEqual(
    [...outcome.started, ...(second.outcome?.started ?? [])].toSorted(),
    [1, 2, 3, 4, 5].map(sid),
  );
});

test('a session whose tab timed out is refused by a restore run again within the minute', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const first = await run(d, fakeTabs(d, { starts: () => false }).terminal, entries.slice(0, 1));
  assert.deepEqual(first.outcome.timedOut, [sid(1)]);
  d.clock.advanceMs(10_000);
  const again = fakeTabs(d);
  const second = await run(d, again.terminal, entries.slice(0, 1));
  assert.deepEqual(again.opened, []);
  // The lock was renewed when restore gave up on it, 10 s ago.
  assert.match(second.outcome.failed[0]?.reason ?? '', /^00000001 is being resumed \(10 s ago\)/);
});

test('a session restore waits for keeps its lock past 60 s, and for a minute after it timed out', async (t) => {
  // The real default wait, 120 s, on the fake clock.
  const { d, entries, sleeps } = fiveToRestore(t, {
    config: { restoreBatch: 2, restoreMinFreeMb: 4096 },
  });
  /** What a `skydeck resume` of sid(1) would get now. */
  const resumeNow = (): string => {
    refresh(d.deck);
    const row = loadRows(d.deck).find((candidate) => candidate.id === sid(1));
    assert.ok(row !== undefined);
    try {
      prepareResume(d.deck, row);
      return 'resumed';
    } catch (error) {
      assert.ok(error instanceof ResumeRefusedError, String(error));
      return error.message;
    }
  };
  const attempts: string[] = [];
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 61 || sleeps.length === 119) {
      attempts.push(resumeNow()); // 61 s and 119 s after the tab was opened
    }
  };
  const { outcome } = await run(
    d,
    fakeTabs(d, { starts: () => false }).terminal,
    entries.slice(0, 1),
  );
  assert.deepEqual(outcome.timedOut, [sid(1)]);
  assert.equal(sleeps.length, 120);
  attempts.push(resumeNow()); // as soon as it was reported
  d.clock.advanceMs(59_000);
  attempts.push(resumeNow());
  assert.equal(attempts.length, 4);
  for (const attempt of attempts) {
    assert.match(attempt, /^00000001 is being resumed \(/);
  }
  d.clock.advanceMs(2_000); // a minute after restore gave up, the lock no longer holds
  assert.equal(resumeNow(), 'resumed');
});

test('the locks of a batch hold while the rest of a large batch is still being opened', async (t) => {
  const d = restoreDeck(t, { config: { restoreBatch: 7, restoreMinFreeMb: 4096 } });
  for (let n = 1; n <= 7; n++) {
    addSession(d, sid(n), {
      boot: BOOT_A,
      pid: 100 + n,
      startNs: T0 - HOUR,
      activityNs: T0 - BigInt(n) * MINUTE,
    });
  }
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  assert.equal(entries.length, 7);
  /** What a `skydeck resume` of sid(1) would get now. */
  const resumeNow = (): string => {
    refresh(d.deck);
    const row = loadRows(d.deck).find((candidate) => candidate.id === sid(1));
    assert.ok(row !== undefined);
    try {
      prepareResume(d.deck, row);
      return 'resumed';
    } catch (error) {
      assert.ok(error instanceof ResumeRefusedError, String(error));
      return error.message;
    }
  };
  let duringSeventh = 'not tried';
  const tabs = fakeTabs(d, {
    starts: () => false,
    // Every `wezterm cli spawn` is killed at its 10 s timeout: the seventh is prepared 60 s after the first.
    onOpen: (count) => {
      if (count === 7) {
        duringSeventh = resumeNow();
      }
      d.clock.advanceMs(10_000);
    },
    result: () => TAB_TIMEOUT,
  });
  await run(d, tabs.terminal, entries);
  assert.deepEqual(tabs.opened, [1, 2, 3, 4, 5, 6, 7].map(sid));
  assert.match(duringSeventh, /^00000001 is being resumed \(/);
});

test('a session that started keeps no lock, though its lock was renewed after the start', async (t) => {
  const d = restoreDeck(t, { config: { restoreBatch: 3, restoreMinFreeMb: 4096 } });
  for (let n = 1; n <= 3; n++) {
    addSession(d, sid(n), {
      boot: BOOT_A,
      pid: 100 + n,
      startNs: T0 - HOUR,
      activityNs: T0 - BigInt(n) * MINUTE,
    });
  }
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  const pids = new Map<string, number>();
  // A real tab takes a moment: claude has started in it before the next tab of the batch opens,
  // and restore renews the earlier locks then, before it has read their start events.
  const tabs = fakeTabs(d, {
    starts: () => false,
    onOpen: (count, id) => {
      pids.set(id, 7000 + count);
      startClaude(d, id, 7000 + count);
      d.clock.advanceMs(2_000);
    },
  });
  const { outcome } = await run(d, tabs.terminal, entries);
  assert.deepEqual(outcome.started, [1, 2, 3].map(sid));
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
  // The user quits sid(1) at once and resumes it 5 s later: nothing keeps them waiting.
  d.proc.setProcess(pids.get(sid(1)) ?? 0, null);
  d.clock.advanceMs(5_000);
  refresh(d.deck);
  const row = loadRows(d.deck).find((candidate) => candidate.id === sid(1));
  assert.ok(row !== undefined);
  assert.equal(prepareResume(d.deck, row).sessionId, sid(1));
});

test('a start event that names no process does not count as started: the session times out and keeps its lock', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    starts: () => false,
    // The hook ran without CLAUDE_PID: pid 0, no process start time. No claude can be told by it.
    onOpen: (_count, id) => {
      const timeNs = d.clock.nowNs();
      d.deck.store.insertEvent({
        spoolName: `${timeNs}-0-${id}.ev`,
        timeNs,
        kind: 'start',
        detail: 'resume',
        rawDetail: 'resume',
        sessionId: id,
        bootId: BOOT_B,
        pid: 0,
        procStart: null,
        cwd: projectDir(d),
        argv: ['claude', '--resume', id],
        name: null,
        payload: null,
      });
    },
  });
  const { outcome } = await run(d, tabs.terminal, entries.slice(0, 1));
  assert.deepEqual(outcome.started, []);
  assert.deepEqual(outcome.timedOut, [sid(1)]);
  assert.notEqual(d.deck.store.getKv(lockKey(sid(1))), null);
});

test('a tab whose claude is stamped up to 5 s before restore read the clock counts as started: the clock stepped back', async (t) => {
  for (const [stepBackNs, started] of [
    [1_700_000_000n, true],
    [6n * SEC, false],
  ] as const) {
    const { d, entries } = fiveToRestore(t);
    // The wall clock steps back while the tab opens, so its claude's start is stamped earlier than
    // the time restore read before opening (and earlier than its lock).
    const tabs = fakeTabs(d, { onOpen: () => d.clock.setNs(d.clock.nowNs() - stepBackNs) });
    const { outcome } = await run(d, tabs.terminal, entries.slice(0, 1));
    const what = `stepped back ${stepBackNs} ns`;
    assert.deepEqual(outcome.started, started ? [sid(1)] : [], what);
    assert.deepEqual(outcome.timedOut, started ? [] : [sid(1)], what);
    // Started: restore dropped its lock. Not counted: the lock stays, its tab may still start it.
    assert.equal(d.deck.store.getKv(lockKey(sid(1))) === null, started, what);
  }
});

test('a start stored before restore took its lock does not count as started, though it is dated later', async (t) => {
  const { d, entries } = fiveToRestore(t);
  // A claude of this boot (pid 5151, dead now) started sid(1) while the clock was ten minutes ahead.
  d.deck.store.insertEvent({
    spoolName: `ahead-${sid(1)}.ev`,
    timeNs: NOW + 10n * MINUTE,
    kind: 'start',
    detail: 'resume',
    rawDetail: 'resume',
    sessionId: sid(1),
    bootId: BOOT_B,
    pid: 5151,
    procStart: PROC_START,
    cwd: projectDir(d),
    argv: ['claude', '--resume', sid(1)],
    name: null,
    payload: null,
  });
  const tabs = fakeTabs(d, { starts: () => false });
  const { outcome } = await run(d, tabs.terminal, entries.slice(0, 1));
  assert.deepEqual(tabs.opened, [sid(1)]);
  assert.deepEqual(outcome.started, []);
  assert.deepEqual(outcome.timedOut, [sid(1)]);
  assert.notEqual(d.deck.store.getKv(lockKey(sid(1))), null); // its tab may still start it
});

test('a scripted run on a session restore waits for does not count as started: it times out, keeps its lock', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, {
    starts: () => false,
    // While the tab opens, a script runs `claude -p --resume` on the session (a real process).
    onOpen: (_count, id) => scriptedEvent(d, BOOT_B, id, d.clock.nowNs(), 5555),
  });
  const { outcome } = await run(d, tabs.terminal, entries.slice(0, 1));
  assert.deepEqual(outcome.started, []);
  assert.deepEqual(outcome.timedOut, [sid(1)]);
  assert.notEqual(d.deck.store.getKv(lockKey(sid(1))), null);
});

test('a lock restore waits on is not renewed once another skydeck has taken it over', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t, {
    config: { ...TAB_CONFIG, restoreStartTimeoutSeconds: 3 },
  });
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 1) {
      d.deck.store.setKv(lockKey(sid(1)), 'taken over');
    }
  };
  await run(d, fakeTabs(d, { starts: () => false }).terminal, entries.slice(0, 1));
  assert.equal(d.deck.store.getKv(lockKey(sid(1))), 'taken over');
});

// --- runRestore without tabs ---------------------------------------------------------------------

function here(d: TestDeck): Terminal {
  return hereTerminal({ files: d.platform.files, env: d.platform.env });
}

/** What restore prints for a session it does not start: a resume that guards and locks when it is run. */
const resumeLine = (id: string): string => `skydeck resume ${id} --here`;

test('without tabs the first session is handed off here and a skydeck resume of each other one is printed', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const dir = projectDir(d);
  const { outcome, lines } = await run(d, here(d), entries.slice(0, 3));
  assert.deepEqual(outcome, {
    ...NOTHING,
    handedOff: sid(1),
    printed: [resumeLine(sid(2)), resumeLine(sid(3))],
  });
  assert.equal(
    readFileSync(join(d.sandbox.root, 'handoff'), 'utf8'),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', sid(1)] }),
  );
  assert.deepEqual(
    d.deck.store.kvEntries('resume_lock:').map((entry) => entry.key),
    [lockKey(sid(1))],
  );
  // Each line names its session first (short id, title, directory): with --yes no list was shown.
  assert.deepEqual(lines, [
    `resuming 00000001 ${titleOf(entries, sid(1))} in this terminal`,
    'to resume these yourself, run:',
    `00000002 ${shellQuote(titleOf(entries, sid(2)))} in ${shellQuote(dir)}:`,
    resumeLine(sid(2)),
    `00000003 ${shellQuote(titleOf(entries, sid(3)))} in ${shellQuote(dir)}:`,
    resumeLine(sid(3)),
  ]);
});

test('the line that names a printed session quotes its title and directory: pasted, it runs nothing', async (t) => {
  // A failed hand-off prints its own command, the next session its skydeck resume line: each after
  // a line that names the session. A user who selects the name line with the command pastes both.
  const d = restoreDeck(t, { config: TAB_CONFIG, env: { SKYDECK_HANDOFF: undefined } });
  const titles = [
    'Port notes -> README.md; $(touch TITLE_RAN) `touch TICK_RAN`',
    "it's done; touch SEMI_RAN",
  ];
  const dir = join(d.sandbox.root, 'proj $(touch DIR_RAN)');
  titles.forEach((title, index) => {
    const n = index + 1;
    addSession(d, sid(n), {
      boot: BOOT_A,
      pid: 100 + n,
      startNs: T0 - HOUR,
      activityNs: T0 - BigInt(n) * MINUTE,
      dir,
    });
    d.deck.store.updateMeta(sid(n), { label: title }, T0);
  });
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  const { outcome, lines } = await run(d, here(d), entries);
  const quotedDir = `'${d.sandbox.root}/proj $(touch DIR_RAN)'`;
  const names = [
    `00000001 'Port notes -> README.md; $(touch TITLE_RAN) \`touch TICK_RAN\`' in ${quotedDir}:`,
    `00000002 'it'\\''s done; touch SEMI_RAN' in ${quotedDir}:`,
  ];
  assert.deepEqual(lines.slice(-5), [
    'to resume these yourself, run:',
    names[0],
    outcome.printed[0],
    names[1],
    resumeLine(sid(2)),
  ]);
  // Fed to a shell, each name line runs a command that does not exist, and nothing else.
  const scratch = join(d.sandbox.root, 'scratch');
  mkdirSync(scratch);
  writeFileSync(join(scratch, 'README.md'), 'notes\n');
  for (const name of names) {
    const shell = spawnSync('sh', ['-s'], { cwd: scratch, input: `${name}\n`, encoding: 'utf8' });
    // A shell ran the line, and its only command was not found (127): without these, a missing sh
    // would let the checks below pass whatever the line holds.
    assert.equal(shell.error, undefined, name);
    assert.equal(shell.status, 127, `${name}\n${shell.stderr}`);
  }
  assert.deepEqual(readdirSync(scratch), ['README.md']);
  assert.equal(readFileSync(join(scratch, 'README.md'), 'utf8'), 'notes\n');
});

test('the line that names a printed session shows its label when it has one', async (t) => {
  const d = restoreDeck(t, { config: TAB_CONFIG });
  addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs: T0 - HOUR, activityNs: T0 - MINUTE });
  addSession(d, sid(2), {
    boot: BOOT_A,
    pid: 102,
    startNs: T0 - HOUR,
    activityNs: T0 - 2n * MINUTE,
  });
  d.deck.store.updateMeta(sid(2), { label: 'fix it' }, T0);
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  const { lines } = await run(d, here(d), entries);
  assert.ok(lines.includes(`00000002 'fix it' in ${shellQuote(projectDir(d))}:`), lines.join('\n'));
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(lines.join('\n')), false, JSON.stringify(lines));
});

test('without tabs a first session that became running is refused and the next one is handed off', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(1), 4242);
  const { outcome } = await run(d, here(d), entries.slice(0, 3));
  assert.deepEqual(outcome.failed, [{ id: sid(1), reason: '00000001 is running (pid 4242)' }]);
  assert.equal(outcome.handedOff, sid(2));
  assert.deepEqual(outcome.printed, [resumeLine(sid(3))]);
});

test('without tabs a command is not printed for a session that became running', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(2), 4242);
  const { outcome } = await run(d, here(d), entries.slice(0, 3));
  assert.equal(outcome.handedOff, sid(1));
  assert.deepEqual(outcome.failed, [{ id: sid(2), reason: '00000002 is running (pid 4242)' }]);
  assert.deepEqual(outcome.printed, [resumeLine(sid(3))]);
});

test('without tabs a command is not printed for a session another skydeck is resuming', async (t) => {
  const { d, entries } = fiveToRestore(t);
  acquireLock(d.deck, sid(2), { latestEventId: d.deck.store.latestEventIdOfSession(sid(2)) });
  d.clock.advanceMs(5_000);
  const { outcome } = await run(d, here(d), entries.slice(0, 3));
  assert.equal(outcome.handedOff, sid(1));
  assert.deepEqual(outcome.failed, [
    { id: sid(2), reason: '00000002 is being resumed by another skydeck' },
  ]);
  assert.deepEqual(outcome.printed, [resumeLine(sid(3))]);
});

test('without tabs a handoff that fails prints that session’s command too and hands nothing off', async (t) => {
  const { d, entries } = fiveToRestore(t, { env: { SKYDECK_HANDOFF: undefined } });
  const dir = projectDir(d);
  const { outcome, lines } = await run(d, here(d), entries.slice(0, 2));
  assert.equal(outcome.handedOff, null);
  assert.deepEqual(outcome.failed, [{ id: sid(1), reason: 'not started through bin/skydeck' }]);
  // As `resume` does after a failed launch: its own command, under the lock restore took for it.
  assert.deepEqual(outcome.printed, [
    `cd -- ${dir} && claude --resume ${sid(1)}`,
    resumeLine(sid(2)),
  ]);
  assert.deepEqual(lines.slice(-5), [
    'to resume these yourself, run:',
    `00000001 ${shellQuote(titleOf(entries, sid(1)))} in ${shellQuote(dir)}:`,
    `cd -- ${dir} && claude --resume ${sid(1)}`,
    `00000002 ${shellQuote(titleOf(entries, sid(2)))} in ${shellQuote(dir)}:`,
    resumeLine(sid(2)),
  ]);
  // The user may run sid(1)'s printed command now: its lock keeps other skydecks off it.
  assert.deepEqual(
    d.deck.store.kvEntries('resume_lock:').map((entry) => entry.key),
    [lockKey(sid(1))],
  );
});

test('without tabs a failed handoff whose command cannot be printed releases its lock', async (t) => {
  const d = restoreDeck(t, { config: TAB_CONFIG, env: { SKYDECK_HANDOFF: undefined } });
  addSession(d, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    argv: ['claude', '--model', 'op\x1b]0;x\x07us'],
  });
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  const { outcome, lines } = await run(d, here(d), entries);
  assert.deepEqual(outcome.failed, [{ id: sid(1), reason: 'not started through bin/skydeck' }]);
  assert.deepEqual(outcome.printed, []);
  assert.ok(
    lines.includes(
      '00000001: the command contains control characters and cannot be printed safely',
    ),
    lines.join('\n'),
  );
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('without tabs a handoff that timed out prints no command and keeps its lock, printable or not', async (t) => {
  // No terminal that runs here times out today; one that did may have started the session.
  const timingOut: Terminal = {
    name: 'here',
    opensTabs: false,
    open: async () => ({ ok: false, error: 'timed out; it may have started', timedOut: true }),
  };
  for (const argv of [['claude'], ['claude', '--model', 'op\x1b]0;x\x07us']]) {
    const d = restoreDeck(t, { config: TAB_CONFIG });
    addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs: T0 - HOUR, argv });
    const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
    const { outcome, lines } = await run(d, timingOut, entries);
    assert.deepEqual(
      outcome,
      {
        ...NOTHING,
        failed: [{ id: sid(1), reason: 'timed out; it may have started' }],
      },
      JSON.stringify(argv),
    );
    assert.deepEqual(lines, ['failed 00000001: timed out; it may have started']);
    assert.notEqual(d.deck.store.getKv(lockKey(sid(1))), null, JSON.stringify(argv));
  }
});

test('without tabs a session whose own command holds control characters gets the skydeck resume line', async (t) => {
  const d = restoreDeck(t, { config: TAB_CONFIG });
  addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs: T0 - HOUR, activityNs: T0 - MINUTE });
  addSession(d, sid(2), {
    boot: BOOT_A,
    pid: 102,
    startNs: T0 - HOUR,
    activityNs: T0 - 2n * MINUTE,
    argv: ['claude', '--model', 'op\x1b]0;x\x07us'],
  });
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  const { outcome, lines } = await run(d, here(d), entries);
  assert.equal(outcome.handedOff, sid(1));
  // The raw command is never printed; `skydeck resume` hands it to the launcher, where it is quoted.
  assert.deepEqual(outcome.printed, [resumeLine(sid(2))]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(lines.join('\n')), false, JSON.stringify(lines));
});

test('without tabs no resume line is printed for a session once the boot id cannot be read', async (t) => {
  const { d, entries } = fiveToRestore(t);
  // During sid(1)'s hand-off another skydeck starts sid(2), and the boot id stops being readable:
  // every process now looks dead, sid(2)'s too.
  const handingOff: Terminal = {
    name: 'here',
    opensTabs: false,
    async open() {
      startClaude(d, sid(2), 4242);
      d.proc.setBootId(null);
      return { ok: true };
    },
  };
  const { outcome } = await run(d, handingOff, entries.slice(0, 2));
  assert.equal(outcome.handedOff, sid(1));
  assert.deepEqual(outcome.printed, []);
  assert.deepEqual(outcome.failed, [
    { id: sid(2), reason: 'cannot tell which sessions are running: the boot id could not be read' },
  ]);
});

test('without tabs too little memory starts nothing', async (t) => {
  const { d, entries } = fiveToRestore(t, { memAvailableMb: 3000 });
  const { outcome } = await run(d, here(d), entries.slice(0, 2));
  assert.deepEqual(outcome, {
    ...NOTHING,
    notStarted: [sid(1), sid(2)],
    stoppedForMemory: true,
  });
});

// --- runRestore's hooks (S2 11.1; C8, C23) ----------------------------------------------------

const startedLine = (entries: readonly RestoreEntry[], n: number): string =>
  `started ${sid(n).slice(0, 8)} ${titleOf(entries, sid(n))}`;
const timedOutLine = (entries: readonly RestoreEntry[], n: number): string =>
  `timed out ${sid(n).slice(0, 8)} ${titleOf(entries, sid(n))}`;
const notStartedLine = (entries: readonly RestoreEntry[], n: number): string =>
  `not started ${sid(n).slice(0, 8)} ${titleOf(entries, sid(n))}`;
const ended = (n: number, kind: ReportOutcome['kind']): ReportOutcome => ({
  sessionId: sid(n),
  kind,
});

test('refuse: a session it names is failed with its reason, never locked or opened; the others start', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const asked: string[] = [];
  const locksAtOpen: (string | null)[] = [];
  const tabs = fakeTabs(d, {
    onOpen: () => {
      locksAtOpen.push(readLock(d.deck, sid(2)));
    },
  });
  const { outcome, lines } = await run(d, tabs.terminal, entries.slice(0, 3), {
    refuse: (id) => {
      asked.push(id);
      return id === sid(2) ? 'this session is already \x1b[31mopen in the window' : null;
    },
  });
  assert.deepEqual(asked, [1, 2, 3].map(sid));
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [sid(1), sid(3)],
    failed: [{ id: sid(2), reason: 'this session is already open in the window' }],
  });
  assert.deepEqual(tabs.opened, [sid(1), sid(3)]);
  assert.deepEqual(locksAtOpen, [null, null]);
  // sid(1) and sid(2) are the first batch: sid(2) is refused before sid(1)'s start is seen.
  assert.deepEqual(lines, [
    'failed 00000002: this session is already open in the window',
    startedLine(entries, 1),
    startedLine(entries, 3),
  ]);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('refuse is asked before the guard: a session that runs gets the hook’s reason', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(1), 4242);
  const { outcome } = await run(d, fakeTabs(d).terminal, entries.slice(0, 1), {
    refuse: () => 'this session is already open in the window',
  });
  assert.deepEqual(outcome.failed, [
    { id: sid(1), reason: 'this session is already open in the window' },
  ]);
});

test('refuse that names no session changes nothing', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d);
  const { outcome, lines } = await run(d, tabs.terminal, entries, { refuse: () => null });
  assert.deepEqual(outcome, { ...NOTHING, started: [1, 2, 3, 4, 5].map(sid) });
  assert.deepEqual(tabs.opened, [1, 2, 3, 4, 5].map(sid));
  assert.deepEqual(
    lines,
    [1, 2, 3, 4, 5].map((n) => startedLine(entries, n)),
  );
});

test('without tabs refuse is asked before the hand-off: the next session is handed off', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const { outcome } = await run(d, here(d), entries.slice(0, 3), {
    refuse: (id) => (id === sid(1) ? 'this session is already open in the window' : null),
  });
  assert.deepEqual(outcome, {
    ...NOTHING,
    failed: [{ id: sid(1), reason: 'this session is already open in the window' }],
    handedOff: sid(2),
    printed: [resumeLine(sid(3))],
  });
});

test('gone: at a look of the wait the session is failed, its renewed lock given back; the batch goes on', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t, {
    config: { ...TAB_CONFIG, restoreStartTimeoutSeconds: 10 },
  });
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 3) {
      startClaude(d, sid(2)); // seen at the fourth look
    }
  };
  const lockAtOpen = new Map<string, string | null>();
  let lockAtGone: string | null = null;
  const asked: [string, number][] = [];
  const tabs = fakeTabs(d, {
    starts: () => false,
    onOpen: (_count, id) => {
      lockAtOpen.set(id, readLock(d.deck, id));
    },
  });
  const { outcome, reported } = await run(d, tabs.terminal, entries.slice(0, 2), {
    gone: (id) => {
      asked.push([id, sleeps.length]);
      if (id === sid(1) && sleeps.length >= 2) {
        lockAtGone = readLock(d.deck, id);
        return 'its terminal was \x1b[31mclosed';
      }
      // Asked for sid(2) at the look that sees its start, this would fail it.
      return id === sid(2) && sleeps.length >= 3 ? 'asked after its start was seen' : null;
    },
  });
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [sid(2)],
    failed: [{ id: sid(1), reason: 'its terminal was closed' }],
  });
  assert.deepEqual(reported, [
    ['failed 00000001: its terminal was closed', ended(1, 'failed')],
    [startedLine(entries, 2), ended(2, 'started')],
  ]);
  // One look a second: sid(1) at the first three (failed at the third), sid(2) until its start.
  assert.deepEqual(asked, [
    [sid(1), 0],
    [sid(2), 0],
    [sid(1), 1],
    [sid(2), 1],
    [sid(1), 2],
    [sid(2), 2],
  ]);
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  // Its lock had been renewed since the tab opened, and that value was given back.
  assert.notEqual(lockAtGone, null);
  assert.notEqual(lockAtGone, lockAtOpen.get(sid(1)));
  assert.equal(d.deck.store.getKv(lockKey(sid(1))), null);
});

test('the signal is looked at before the memory check, with tabs and without: its stop is the one said', async (t) => {
  for (const tabs of [true, false]) {
    const what = `tabs: ${tabs}`;
    const { d, entries } = fiveToRestore(t, { memAvailableMb: 3000 });
    const terminal = tabs ? fakeTabs(d).terminal : here(d);
    const { outcome, lines } = await run(d, terminal, entries.slice(0, 2), {
      signal: AbortSignal.abort('stop'),
    });
    assert.deepEqual(outcome, { ...NOTHING, notStarted: [sid(1), sid(2)], stopped: true }, what);
    assert.deepEqual(
      lines,
      ['stopped: stop', notStartedLine(entries, 1), notStartedLine(entries, 2)],
      what,
    );
  }
});

test('the stop line’s reason is sanitised', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const { lines } = await run(d, fakeTabs(d).terminal, entries.slice(0, 1), {
    signal: AbortSignal.abort('stop \x1b[31mred\nline two'),
  });
  assert.deepEqual(lines, ['stopped: stop red line two', notStartedLine(entries, 1)]);
});

test('gone for a session whose lock another skydeck took over: failed, that lock left alone', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 1) {
      d.deck.store.setKv(lockKey(sid(1)), 'taken over');
    }
  };
  const tabs = fakeTabs(d, { starts: () => false });
  const { outcome, lines } = await run(d, tabs.terminal, entries.slice(0, 1), {
    gone: () => (sleeps.length >= 2 ? 'its terminal was closed' : null),
  });
  assert.deepEqual(outcome, {
    ...NOTHING,
    failed: [{ id: sid(1), reason: 'its terminal was closed' }],
  });
  assert.deepEqual(lines, ['failed 00000001: its terminal was closed']);
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(d.deck.store.getKv(lockKey(sid(1))), 'taken over');
});

test('signal aborted before the run: nothing opened, the stopped line, every entry not started', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d);
  const { outcome, reported } = await run(d, tabs.terminal, entries, {
    signal: AbortSignal.abort("the window's server is stopping"),
  });
  assert.deepEqual(tabs.opened, []);
  assert.deepEqual(outcome, { ...NOTHING, notStarted: [1, 2, 3, 4, 5].map(sid), stopped: true });
  assert.deepEqual(reported, [
    ["stopped: the window's server is stopping", undefined],
    ...[1, 2, 3, 4, 5].map((n) => [notStartedLine(entries, n), ended(n, 'not-started')]),
  ]);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('signal aborted while the second batch waits: that wait ends at its next look; timed out, stopped, not started', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t, {
    config: { ...TAB_CONFIG, restoreStartTimeoutSeconds: 10 },
  });
  const controller = new AbortController();
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 1) {
      controller.abort('the command that asked for it stopped');
    }
  };
  const lockAtOpen = new Map<string, string | null>();
  const tabs = fakeTabs(d, {
    starts: (id) => id === sid(1) || id === sid(2),
    onOpen: (_count, id) => {
      lockAtOpen.set(id, readLock(d.deck, id));
    },
  });
  const { outcome, lines } = await run(d, tabs.terminal, entries, { signal: controller.signal });
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(tabs.opened, [1, 2, 3, 4].map(sid));
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [sid(1), sid(2)],
    timedOut: [sid(3), sid(4)],
    notStarted: [sid(5)],
    stopped: true,
  });
  assert.deepEqual(lines, [
    startedLine(entries, 1),
    startedLine(entries, 2),
    timedOutLine(entries, 3),
    timedOutLine(entries, 4),
    'stopped: the command that asked for it stopped',
    notStartedLine(entries, 5),
  ]);
  // Their terminals may still start them: each keeps its lock, renewed at the last look (its time,
  // read to the millisecond, is that look's, a second after the open; a renewal's mark alone would
  // make any renewed value differ from the open's).
  for (const id of [sid(3), sid(4)]) {
    const lock = d.deck.store.getKv(lockKey(id));
    assert.notEqual(lock, null, id);
    assert.equal(lockTakenNs(lock ?? ''), d.clock.nowNs(), id);
    assert.equal(lockTakenNs(lockAtOpen.get(id) ?? ''), d.clock.nowNs() - SEC, id);
  }
});

test('signal aborted while a tab opens: no further entry is prepared, the opened one is looked for once', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const controller = new AbortController();
  const tabs = fakeTabs(d, { starts: () => false, onOpen: () => controller.abort('stop') });
  const { outcome, lines } = await run(d, tabs.terminal, entries, { signal: controller.signal });
  assert.deepEqual(tabs.opened, [sid(1)]);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(outcome, {
    ...NOTHING,
    timedOut: [sid(1)],
    notStarted: [2, 3, 4, 5].map(sid),
    stopped: true,
  });
  assert.deepEqual(lines, [
    timedOutLine(entries, 1),
    'stopped: stop',
    ...[2, 3, 4, 5].map((n) => notStartedLine(entries, n)),
  ]);
});

test('signal aborted while the last batch waits: the stopped line only when a session was still waited for', async (t) => {
  for (const startsAtNextLook of [false, true]) {
    const what = `starts at the next look: ${startsAtNextLook}`;
    const { d, entries, sleeps } = fiveToRestore(t);
    const controller = new AbortController();
    const sleep = d.clock.sleep;
    d.clock.sleep = async (ms) => {
      await sleep(ms);
      controller.abort('stop');
      if (startsAtNextLook) {
        startClaude(d, sid(2));
      }
    };
    const tabs = fakeTabs(d, { starts: (id) => id === sid(1) });
    const { outcome, lines } = await run(d, tabs.terminal, entries.slice(0, 2), {
      signal: controller.signal,
    });
    assert.deepEqual(sleeps, [1000], what);
    if (startsAtNextLook) {
      // Nothing was left when the run saw the abort: it ended as it would have.
      assert.deepEqual(outcome, { ...NOTHING, started: [sid(1), sid(2)] }, what);
      assert.deepEqual(lines, [startedLine(entries, 1), startedLine(entries, 2)], what);
    } else {
      assert.deepEqual(
        outcome,
        { ...NOTHING, started: [sid(1)], timedOut: [sid(2)], stopped: true },
        what,
      );
      assert.deepEqual(
        lines,
        [startedLine(entries, 1), timedOutLine(entries, 2), 'stopped: stop'],
        what,
      );
    }
  }
});

test('signal first seen at the look that ends the last batch’s wait by its time: the run ends as it would have', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const controller = new AbortController();
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 3) {
      controller.abort('stop'); // the wait's 3 s are over at the next look
    }
  };
  const tabs = fakeTabs(d, { starts: () => false });
  const { outcome, lines } = await run(d, tabs.terminal, entries.slice(0, 2), {
    signal: controller.signal,
  });
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.deepEqual(outcome, { ...NOTHING, timedOut: [sid(1), sid(2)] });
  assert.deepEqual(lines, [timedOutLine(entries, 1), timedOutLine(entries, 2)]);
});

test('without tabs a signal aborted before the run hands nothing off', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const { outcome, lines } = await run(d, here(d), entries.slice(0, 3), {
    signal: AbortSignal.abort('stop'),
  });
  assert.deepEqual(outcome, { ...NOTHING, notStarted: [1, 2, 3].map(sid), stopped: true });
  assert.deepEqual(lines, ['stopped: stop', ...[1, 2, 3].map((n) => notStartedLine(entries, n))]);
  assert.equal(existsSync(join(d.sandbox.root, 'handoff')), false);
});

test('without tabs a signal aborted during the hand-off prints no line for the others', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const controller = new AbortController();
  const handoff = here(d);
  const aborting: Terminal = {
    ...handoff,
    open: (spec) => {
      controller.abort('stop');
      return handoff.open(spec);
    },
  };
  const { outcome, lines } = await run(d, aborting, entries.slice(0, 3), {
    signal: controller.signal,
  });
  assert.deepEqual(outcome, {
    ...NOTHING,
    handedOff: sid(1),
    notStarted: [sid(2), sid(3)],
    stopped: true,
  });
  assert.deepEqual(lines, [
    `resuming 00000001 ${titleOf(entries, sid(1))} in this terminal`,
    'stopped: stop',
    notStartedLine(entries, 2),
    notStartedLine(entries, 3),
  ]);
});

test('stopAfterEmptyBatch: a first batch whose tabs open and never start stops the run after its wait', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const tabs = fakeTabs(d, { starts: (id) => id !== sid(1) && id !== sid(2) });
  const { outcome, reported } = await run(d, tabs.terminal, entries, {
    stopAfterEmptyBatch: true,
  });
  assert.deepEqual(tabs.opened, [sid(1), sid(2)]);
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.deepEqual(outcome, {
    ...NOTHING,
    timedOut: [sid(1), sid(2)],
    notStarted: [3, 4, 5].map(sid),
    stopped: true,
  });
  assert.deepEqual(reported, [
    [timedOutLine(entries, 1), ended(1, 'timed-out')],
    [timedOutLine(entries, 2), ended(2, 'timed-out')],
    ['stopped: no session of this batch started', undefined],
    ...[3, 4, 5].map((n) => [notStartedLine(entries, n), ended(n, 'not-started')]),
  ]);
});

test('stopAfterEmptyBatch: an empty batch after one whose sessions started stops the run', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, { starts: (id) => id === sid(1) || id === sid(2) });
  const { outcome, lines } = await run(d, tabs.terminal, entries, { stopAfterEmptyBatch: true });
  assert.deepEqual(tabs.opened, [1, 2, 3, 4].map(sid));
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [sid(1), sid(2)],
    timedOut: [sid(3), sid(4)],
    notStarted: [sid(5)],
    stopped: true,
  });
  assert.deepEqual(lines, [
    startedLine(entries, 1),
    startedLine(entries, 2),
    timedOutLine(entries, 3),
    timedOutLine(entries, 4),
    'stopped: no session of this batch started',
    notStartedLine(entries, 5),
  ]);
  // Their terminals may still start them.
  assert.notEqual(d.deck.store.getKv(lockKey(sid(3))), null);
  assert.notEqual(d.deck.store.getKv(lockKey(sid(4))), null);
});

test('stopAfterEmptyBatch with a signal first seen at the look that ends the wait: the signal’s stop is said', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const controller = new AbortController();
  const sleep = d.clock.sleep;
  d.clock.sleep = async (ms) => {
    await sleep(ms);
    if (sleeps.length === 3) {
      controller.abort("the window's server is stopping"); // the wait's time is up at the next look
    }
  };
  const tabs = fakeTabs(d, { starts: () => false });
  const { outcome, lines } = await run(d, tabs.terminal, entries, {
    signal: controller.signal,
    stopAfterEmptyBatch: true,
  });
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.deepEqual(outcome, {
    ...NOTHING,
    timedOut: [sid(1), sid(2)],
    notStarted: [3, 4, 5].map(sid),
    stopped: true,
  });
  assert.deepEqual(lines, [
    timedOutLine(entries, 1),
    timedOutLine(entries, 2),
    "stopped: the window's server is stopping",
    ...[3, 4, 5].map((n) => notStartedLine(entries, n)),
  ]);
});

test('stopAfterEmptyBatch: a batch whose sessions are all gone stops the run too', async (t) => {
  const { d, entries, sleeps } = fiveToRestore(t);
  const tabs = fakeTabs(d, { starts: () => false });
  const { outcome, lines } = await run(d, tabs.terminal, entries, {
    stopAfterEmptyBatch: true,
    gone: () => 'claude ended before the session started (status 127)',
  });
  assert.deepEqual(tabs.opened, [sid(1), sid(2)]);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(outcome, {
    ...NOTHING,
    failed: [1, 2].map((n) => ({
      id: sid(n),
      reason: 'claude ended before the session started (status 127)',
    })),
    notStarted: [3, 4, 5].map(sid),
    stopped: true,
  });
  assert.deepEqual(lines.slice(2, 3), ['stopped: no session of this batch started']);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('stopAfterEmptyBatch: a batch the guard refused whole opened nothing and does not stop the run', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(1), 4241);
  startClaude(d, sid(2), 4242);
  const tabs = fakeTabs(d);
  const { outcome, lines } = await run(d, tabs.terminal, entries, { stopAfterEmptyBatch: true });
  assert.deepEqual(tabs.opened, [3, 4, 5].map(sid));
  assert.deepEqual(outcome.started, [3, 4, 5].map(sid));
  assert.deepEqual(
    outcome.failed.map((failure) => failure.id),
    [sid(1), sid(2)],
  );
  assert.equal(outcome.stopped, false);
  assert.equal(
    lines.some((line) => line.startsWith('stopped:')),
    false,
    lines.join('\n'),
  );
});

test('stopAfterEmptyBatch: a batch in which one session started does not stop the run', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, { starts: (id) => id !== sid(1) });
  const { outcome } = await run(d, tabs.terminal, entries, { stopAfterEmptyBatch: true });
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [2, 3, 4, 5].map(sid),
    timedOut: [sid(1)],
  });
});

test('stopAfterEmptyBatch: a last or only batch that starts nothing ends the run without a stopped line', async (t) => {
  for (const [count, starting] of [
    [2, []],
    [5, [1, 2, 3, 4]],
  ] as const) {
    const what = `${count} entries`;
    const { d, entries } = fiveToRestore(t);
    const tabs = fakeTabs(d, { starts: (id) => starting.some((n) => sid(n) === id) });
    const { outcome, lines } = await run(d, tabs.terminal, entries.slice(0, count), {
      stopAfterEmptyBatch: true,
    });
    const timedOut = entries
      .slice(0, count)
      .map((entry) => entry.row.id)
      .filter((id) => !starting.some((n) => sid(n) === id));
    assert.deepEqual(outcome, { ...NOTHING, started: starting.map(sid), timedOut }, what);
    assert.equal(
      lines.some((line) => line.startsWith('stopped:')),
      false,
      `${what}\n${lines.join('\n')}`,
    );
  }
});

test('without stopAfterEmptyBatch a first batch that starts nothing does not stop the run', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const tabs = fakeTabs(d, { starts: (id) => id !== sid(1) && id !== sid(2) });
  const { outcome } = await run(d, tabs.terminal, entries);
  assert.deepEqual(tabs.opened, [1, 2, 3, 4, 5].map(sid));
  assert.deepEqual(outcome, {
    ...NOTHING,
    started: [3, 4, 5].map(sid),
    timedOut: [sid(1), sid(2)],
  });
});

test('report’s outcome with tabs: started, timed out, failed and not started; warnings and the stop carry none', async (t) => {
  const d = restoreDeck(t, { config: TAB_CONFIG });
  for (let n = 1; n <= 5; n++) {
    addSession(d, sid(n), {
      boot: BOOT_A,
      pid: 100 + n,
      startNs: T0 - HOUR,
      activityNs: T0 - BigInt(n) * MINUTE,
      argv: n === 1 ? ['claude', '--frob'] : ['claude'],
    });
  }
  const entries = planRestore(listOrder(d), d.deck.store.events(), BOOT_B, false);
  startClaude(d, sid(2), 4242);
  const tabs = fakeTabs(d, {
    starts: (id) => id !== sid(4),
    onOpen: (count) => {
      if (count === 3) {
        d.proc.setMemAvailableMb(3000);
      }
    },
  });
  const { reported } = await run(d, tabs.terminal, entries);
  assert.deepEqual(reported, [
    ['00000001: started with flags skydeck does not know, not passed on resume: --frob', undefined],
    ['failed 00000002: 00000002 is running (pid 4242)', ended(2, 'failed')],
    [startedLine(entries, 1), ended(1, 'started')],
    [startedLine(entries, 3), ended(3, 'started')],
    [timedOutLine(entries, 4), ended(4, 'timed-out')],
    [
      'stopped: only 3000 MiB of memory available, less than restoreMinFreeMb (4096 MiB)',
      undefined,
    ],
    [notStartedLine(entries, 5), ended(5, 'not-started')],
  ]);
});

test('report’s outcome without tabs: handed off, failed and printed; the header and name lines carry none', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(2), 4242);
  const dir = projectDir(d);
  const { reported } = await run(d, here(d), entries.slice(0, 3));
  assert.deepEqual(reported, [
    [`resuming 00000001 ${titleOf(entries, sid(1))} in this terminal`, ended(1, 'handed-off')],
    ['failed 00000002: 00000002 is running (pid 4242)', ended(2, 'failed')],
    ['to resume these yourself, run:', undefined],
    [`00000003 ${shellQuote(titleOf(entries, sid(3)))} in ${shellQuote(dir)}:`, undefined],
    [resumeLine(sid(3)), ended(3, 'printed')],
  ]);
  // A failed hand-off: its failure, then its own command printed, or the line that it cannot be.
  const failing = restoreDeck(t, { config: TAB_CONFIG, env: { SKYDECK_HANDOFF: undefined } });
  addSession(failing, sid(1), {
    boot: BOOT_A,
    pid: 101,
    startNs: T0 - HOUR,
    argv: ['claude', '--model', 'op\x1b]0;x\x07us'],
  });
  const one = planRestore(listOrder(failing), failing.deck.store.events(), BOOT_B, false);
  const unprintable = await run(failing, here(failing), one);
  assert.deepEqual(unprintable.reported, [
    ['failed 00000001: not started through bin/skydeck', ended(1, 'failed')],
    ['00000001: the command contains control characters and cannot be printed safely', undefined],
  ]);
});

// The time arithmetic above relies on these.
test('the fixtures: BOOT_A’s last event is T0 and the clock is two hours later', (t) => {
  const d = restartedMachine(t);
  const last: Ns = d.deck.store
    .events()
    .filter((event) => event.bootId === BOOT_A)
    .reduce((max, event) => (event.timeNs > max ? event.timeNs : max), 0n);
  assert.equal(last, T0);
  assert.equal(d.clock.nowNs(), NOW);
});
