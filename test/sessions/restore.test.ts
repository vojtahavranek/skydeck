import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Ns } from '../../src/platform/types.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { planRestore, runRestore } from '../../src/sessions/restore.ts';
import type { RestoreEntry, RestoreOutcome } from '../../src/sessions/restore.ts';
import { ResumeRefusedError } from '../../src/platform/errors.ts';
import { acquireLock, lockKey, prepareResume } from '../../src/sessions/resume.ts';
import { handoffScript, hereTerminal } from '../../src/terminals/here.ts';
import type { OpenResult, Terminal } from '../../src/terminals/types.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { ds, rowOf } from '../helpers/derived.ts';
import { BOOT_A, BOOT_B, SEC, T0 } from '../helpers/platform.ts';
import {
  BOOT_C,
  DAY,
  HOUR,
  MINUTE,
  NOW,
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
): Promise<{ outcome: RestoreOutcome; lines: string[] }> {
  const lines: string[] = [];
  const outcome = await runRestore(
    { deck: d.deck, terminal, report: (line) => lines.push(line) },
    entries,
  );
  return { outcome, lines };
}

const NOTHING = {
  started: [],
  timedOut: [],
  failed: [],
  notStarted: [],
  handedOff: null,
  printed: [],
  stoppedForMemory: false,
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
  assert.deepEqual(tabs.specs[0], { cwd: projectDir(d), argv: ['claude', '--resume', sid(1)] });
  assert.deepEqual(
    lines,
    [1, 2, 3, 4, 5].map((n) => `started ${sid(n).slice(0, 8)} ${titleOf(entries, sid(n))}`),
  );
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

test('without tabs the first session is handed off here and the commands of the others are printed', async (t) => {
  const { d, entries } = fiveToRestore(t);
  const dir = projectDir(d);
  const { outcome, lines } = await run(d, here(d), entries.slice(0, 3));
  assert.deepEqual(outcome, {
    ...NOTHING,
    handedOff: sid(1),
    printed: [
      `cd -- ${dir} && claude --resume ${sid(2)}`,
      `cd -- ${dir} && claude --resume ${sid(3)}`,
    ],
  });
  assert.equal(
    readFileSync(join(d.sandbox.root, 'handoff'), 'utf8'),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', sid(1)] }),
  );
  assert.deepEqual(
    d.deck.store.kvEntries('resume_lock:').map((entry) => entry.key),
    [lockKey(sid(1))],
  );
  assert.ok(lines.includes(outcome.printed[0] ?? '?'), lines.join('\n'));
  assert.ok(lines.includes(outcome.printed[1] ?? '?'), lines.join('\n'));
});

test('without tabs a first session that became running is refused and the next one is handed off', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(1), 4242);
  const { outcome } = await run(d, here(d), entries.slice(0, 3));
  assert.deepEqual(outcome.failed, [{ id: sid(1), reason: '00000001 is running (pid 4242)' }]);
  assert.equal(outcome.handedOff, sid(2));
  assert.deepEqual(outcome.printed, [`cd -- ${projectDir(d)} && claude --resume ${sid(3)}`]);
});

test('without tabs a command is not printed for a session that became running', async (t) => {
  const { d, entries } = fiveToRestore(t);
  startClaude(d, sid(2), 4242);
  const { outcome } = await run(d, here(d), entries.slice(0, 3));
  assert.equal(outcome.handedOff, sid(1));
  assert.deepEqual(outcome.failed, [{ id: sid(2), reason: '00000002 is running (pid 4242)' }]);
  assert.deepEqual(outcome.printed, [`cd -- ${projectDir(d)} && claude --resume ${sid(3)}`]);
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
  assert.deepEqual(outcome.printed, [`cd -- ${projectDir(d)} && claude --resume ${sid(3)}`]);
});

test('without tabs a handoff that fails prints that session’s command too and hands nothing off', async (t) => {
  const { d, entries } = fiveToRestore(t, { env: { SKYDECK_HANDOFF: undefined } });
  const dir = projectDir(d);
  const { outcome } = await run(d, here(d), entries.slice(0, 2));
  assert.equal(outcome.handedOff, null);
  assert.deepEqual(outcome.failed, [{ id: sid(1), reason: 'not started through bin/skydeck' }]);
  assert.deepEqual(outcome.printed, [
    `cd -- ${dir} && claude --resume ${sid(1)}`,
    `cd -- ${dir} && claude --resume ${sid(2)}`,
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

test('without tabs a command holding control characters is never printed', async (t) => {
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
  assert.deepEqual(outcome.printed, []);
  assert.deepEqual(outcome.failed, [
    {
      id: sid(2),
      reason: 'the command contains control characters and cannot be printed safely',
    },
  ]);
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(lines.join('\n')), false, JSON.stringify(lines));
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
