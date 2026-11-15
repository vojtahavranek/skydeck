// Whether a holder runs in the window (C15, S2 11.4; plan task 78): `holdersInWindow` over the
// keepers' .pid lines of the runtime directory the store records and mapping's walk
// (`holderPlace`, 9 parents up). The cases with real programs start a keeper of the keeper sandbox
// with the stand-in; the depth of the walk and the keeper's own pid run on a fake /proc.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { parentPidFromStat } from '../../src/claude/procstat.ts';
import type { Files } from '../../src/platform/types.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type { Holder } from '../../src/sessions/types.ts';
import { holdersInWindow } from '../../src/window/in-window.ts';
import { holderPlace } from '../../src/window/mapping.ts';
import { formatPidLine, parsePidLine } from '../../src/window/pidline.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { keeperSandbox, procStartOf, startProgram, stillRuns, within } from '../helpers/keeper.ts';
import type { KeeperBox } from '../helpers/keeper.ts';
import { BOOT_A, BOOT_B, S2, T0, realTestPlatform, statLine } from '../helpers/platform.ts';
import { standinCommand, waitForRecord } from '../helpers/standin.ts';

function holderOf(pid: number, procStart: number | null, bootId: string): Holder {
  return { process: { bootId, pid, procStart }, sinceNs: T0, live: null, scripted: false };
}

/** `stat` that calls `fails` the first time it is asked for `pid`, and `real` otherwise. */
function failsOnce(
  pid: number,
  real: (pid: number) => string | null,
  fails: () => never,
): (pid: number) => string | null {
  let first = true;
  return (asked) => {
    if (asked === pid && first) {
      first = false;
      return fails();
    }
    return real(asked);
  };
}

// --- with real programs -------------------------------------------------------------------------

interface KeeperDeck {
  box: KeeperBox;
  deck: Deck;
  /** The machine's boot id, as the holders of this boot record it. */
  bootId: string;
  /** Starts the stand-in itself, outside any keeper; its pid and process start once it runs. */
  outside(): Promise<{ pid: number; procStart: number }>;
}

/**
 * A keeper sandbox and a deck on its platform. The stand-ins `outside` started are killed and the
 * store is closed first at the test's end, before the keepers are killed and the sandbox goes.
 */
function keeperDeck(t: TestContext): KeeperDeck {
  let deck: Deck | null = null;
  const started: { pid: number; procStart: number; exited: Promise<unknown> }[] = [];
  t.after(async () => {
    deck?.store.close();
    for (const child of started) {
      if (stillRuns(child.pid, child.procStart)) {
        box.tp.platform.processes.signal(child.pid, 'SIGKILL');
      }
      await within(child.exited, `the stand-in ${child.pid} ended`);
    }
  });
  const box = keeperSandbox(t);
  deck = openDeck(box.tp.platform);
  const bootId = box.tp.platform.proc.bootId();
  assert.ok(bootId !== null, 'the machine has a boot id');
  const outside = async (): Promise<{ pid: number; procStart: number }> => {
    const record = join(box.s.root, 'records', `outside-${started.length}.jsonl`);
    const child = await box.tp.platform.processes.startDetached(
      standinCommand(box.s),
      ['--session-id', S2],
      { cwd: box.s.home, env: box.s.env({ STANDIN_RECORD: record, STANDIN_MAX_SECONDS: '60' }) },
    );
    const procStart = procStartOf(child.pid);
    assert.ok(procStart !== null, 'the stand-in runs');
    started.push({ pid: child.pid, procStart, exited: child.exited });
    const start = await waitForRecord(record, (r) => r.ev === 'start', 15_000);
    assert.equal(start.pid, child.pid, 'the script became the stand-in (exec)');
    return { pid: child.pid, procStart };
  };
  return { box, deck, bootId, outside };
}

describe('holdersInWindow with real keepers', { concurrency: true }, () => {
  test('the stand-in a keeper started is in the window; a stand-in the test started is not', async (t) => {
    const { box, deck, bootId, outside } = keeperDeck(t);
    const keeper = await box.start();
    const { started } = await startProgram(keeper);
    const other = await outside();

    const got = holdersInWindow(deck, [
      holderOf(started.pid, started.procStart, bootId),
      holderOf(other.pid, other.procStart, bootId),
    ]);

    assert.deepEqual([...got], [started.pid]);
  });

  test('a wrapper as the program (the stand-in a child of a sh) → in the window', async (t) => {
    const { box, deck, bootId } = keeperDeck(t);
    const keeper = await box.start();
    // The keeper starts its program at G: from now on the script runs the stand-in as its child.
    standinCommand(box.s, { wrapper: true });
    const { started } = await startProgram(keeper);
    const start = await waitForRecord(keeper.record, (r) => r.ev === 'start', 15_000);
    assert.notEqual(start.pid, started.pid, 'the holder is not the program itself');
    const parent = parentPidFromStat(readFileSync(`/proc/${start.pid}/stat`, 'utf8'));
    assert.equal(parent, started.pid, "the stand-in is the wrapper's child");

    const got = holdersInWindow(deck, [holderOf(start.pid, procStartOf(start.pid), bootId)]);

    assert.deepEqual([...got], [start.pid]);
  });

  test("the keeper's .pid line naming a process start that is not its own → not in the window", async (t) => {
    const { box, deck, bootId } = keeperDeck(t);
    const keeper = await box.start();
    const { started } = await startProgram(keeper);
    const holders = [holderOf(started.pid, started.procStart, bootId)];
    assert.deepEqual([...holdersInWindow(deck, holders)], [started.pid], 'with its own line');
    const original = readFileSync(keeper.pidFile, 'utf8');
    const line = parsePidLine(original);
    assert.ok(line !== null && line.pid === keeper.pid);

    writeFileSync(keeper.pidFile, formatPidLine({ ...line, procStart: line.procStart + 1 }));
    try {
      assert.deepEqual([...holdersInWindow(deck, holders)], []);
    } finally {
      // So that the sandbox's clean-up finds the keeper by its line.
      writeFileSync(keeper.pidFile, original);
    }
  });

  test('the runtime directory is the one the store records, whatever the rule gives', async (t) => {
    const { box, deck, bootId } = keeperDeck(t);
    const keeper = await box.start();
    const { started } = await startProgram(keeper);
    const holders = [holderOf(started.pid, started.procStart, bootId)];
    const elsewhere = join(box.s.root, 'elsewhere');
    mkdirSync(join(elsewhere, 'terms'), { recursive: true });

    deck.store.setKv('window_runtime_dir', elsewhere);
    assert.deepEqual([...holdersInWindow(deck, holders)], [], 'no keeper in the recorded one');
    deck.store.setKv('window_runtime_dir', box.runtimeDir);
    assert.deepEqual([...holdersInWindow(deck, holders)], [started.pid]);
  });

  test('every doubt → not in the window: no boot id, a read that throws, another boot, no process start, a keeper line that is unknown, a holder that is gone', async (t) => {
    const { box, deck, bootId } = keeperDeck(t);
    const keeper = await box.start();
    const { started } = await startProgram(keeper);
    const holders = [holderOf(started.pid, started.procStart, bootId)];
    assert.deepEqual([...holdersInWindow(deck, holders)], [started.pid], 'without a doubt');
    const realStat = deck.platform.proc.stat;
    const fails = (): never => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    };
    const cases: [string, Deck, readonly Holder[]][] = [
      ['no boot id', deckWith(deck, { proc: { bootId: () => null } }), holders],
      ['the boot id cannot be read', deckWith(deck, { proc: { bootId: fails } }), holders],
      ['terms/ cannot be listed', deckWith(deck, { files: { list: fails } }), holders],
      ['the store cannot be read', deckWith(deck, { store: { getKv: fails } }), holders],
      [
        "the keeper's /proc entry cannot be read (its line is unknown)",
        deckWith(deck, {
          proc: { stat: (pid: number) => (pid === keeper.pid ? fails() : realStat(pid)) },
        }),
        holders,
      ],
      [
        // Only the line's judgement fails: the walk reads the keeper again and would reach it.
        'the keeper line is unknown (its /proc entry fails once, when the line is judged)',
        deckWith(deck, { proc: { stat: failsOnce(keeper.pid, realStat, fails) } }),
        holders,
      ],
      [
        "the holder's /proc entry cannot be read",
        deckWith(deck, {
          proc: { stat: (pid: number) => (pid === started.pid ? fails() : realStat(pid)) },
        }),
        holders,
      ],
      ['a holder of another boot', deck, [holderOf(started.pid, started.procStart, BOOT_B)]],
      ['a holder without a process start', deck, [holderOf(started.pid, null, bootId)]],
      [
        'a holder that is gone (its pid is another process now)',
        deck,
        [holderOf(started.pid, started.procStart + 1, bootId)],
      ],
    ];
    for (const [what, given, of] of cases) {
      assert.deepEqual([...holdersInWindow(given, of)], [], what);
    }
  });
});

test('no runtime directory → nothing in the window, and nothing is created', (t) => {
  let deck: Deck | null = null;
  t.after(() => deck?.store.close());
  const tp = realTestPlatform(t);
  deck = openDeck(tp.platform);
  const bootId = tp.platform.proc.bootId();
  assert.ok(bootId !== null);
  const self = holderOf(process.pid, procStartOf(process.pid), bootId);
  const run = join(tp.sandbox.skydeckHome, 'run');

  assert.deepEqual([...holdersInWindow(deck, [self])], []);
  assert.equal(existsSync(run), false, 'the rule’s directory is not created');

  const recorded = join(tp.sandbox.root, 'recorded-run');
  deck.store.setKv('window_runtime_dir', recorded);
  assert.deepEqual([...holdersInWindow(deck, [self])], []);
  assert.equal(existsSync(recorded), false, 'the recorded directory is not created');
  assert.equal(existsSync(run), false);
});

// --- on a fake /proc ----------------------------------------------------------------------------

const KEEPER = { pid: 5000, procStart: 900 };
const TERM = 'aaaaaaaaaaaa';

/** A /proc/<pid>/stat line whose parent (field 4) is `ppid` and whose start (field 22) is `start`. */
function statWithParent(pid: number, start: number, ppid: number): string {
  const fixed = statLine(pid, start).replace(/^(\d+ \(claude\) S) 1 /, `$1 ${ppid} `);
  assert.equal(parentPidFromStat(fixed), ppid, 'the parent field was set');
  return fixed;
}

/**
 * A deck on the fake /proc with a keeper alive by its .pid line in `<SKYDECK_HOME>/run/terms` and
 * a chain of processes below it: pid 5000 + n is n parents below the keeper (n = 1 … 12).
 */
function fakeKeeper(t: TestContext, lineBoot = BOOT_A): TestDeck {
  const d = testDeck(t);
  const terms = join(d.sandbox.skydeckHome, 'run', 'terms');
  mkdirSync(terms, { recursive: true });
  writeFileSync(
    join(terms, `${TERM}.pid`),
    formatPidLine({ ...KEEPER, bootId: lineBoot, keeper: { version: '1', started: true } }),
  );
  d.proc.setProcess(KEEPER.pid, {
    stat: statWithParent(KEEPER.pid, KEEPER.procStart, 1),
    cmdline: [],
  });
  for (let n = 1; n <= 12; n++) {
    const pid = KEEPER.pid + n;
    d.proc.setProcess(pid, {
      stat: statWithParent(pid, KEEPER.procStart + n, pid - 1),
      cmdline: [],
    });
  }
  return d;
}

/** The holder n parents below the fake keeper. */
const below = (n: number): Holder => holderOf(KEEPER.pid + n, KEEPER.procStart + n, BOOT_A);

describe('holdersInWindow on a fake /proc', () => {
  test('up to 9 parents below the keeper (8 below its program) → in the window; 10 → not', (t) => {
    const d = fakeKeeper(t);
    const holders = [1, 2, 8, 9, 10, 12].map(below);
    assert.deepEqual([...holdersInWindow(d.deck, holders)].sort(), [5001, 5002, 5008, 5009]);
  });

  test('the keeper itself as a holder → not in the window (it is no program of its own)', (t) => {
    const d = fakeKeeper(t);
    assert.deepEqual([...holdersInWindow(d.deck, [below(0)])], []);
  });

  test('a keeper line of another boot (dead by design 5.5) → nothing in the window', (t) => {
    const d = fakeKeeper(t, BOOT_B);
    assert.deepEqual([...holdersInWindow(d.deck, [below(1)])], []);
  });

  test('no keeper line at all → nothing in the window', (t) => {
    const d = testDeck(t);
    mkdirSync(join(d.sandbox.skydeckHome, 'run', 'terms'), { recursive: true });
    d.proc.setProcess(5001, { stat: statWithParent(5001, 901, 5000), cmdline: [] });
    assert.deepEqual([...holdersInWindow(d.deck, [below(1)])], []);
  });

  test('no holders, or no boot id → an empty set, and no directory is listed', (t) => {
    const d = fakeKeeper(t);
    const listed: string[] = [];
    const files: Partial<Files> = {
      list: (dir) => {
        listed.push(dir);
        return d.platform.files.list(dir);
      },
    };
    const counted = deckWith(d.deck, { files });
    assert.deepEqual([...holdersInWindow(counted, [below(1)])], [5001], 'the keeper is found');
    assert.equal(listed.length, 1, 'terms/ was listed once');

    listed.length = 0;
    assert.deepEqual([...holdersInWindow(counted, [])], []);
    d.proc.setBootId(null);
    assert.deepEqual([...holdersInWindow(counted, [below(1)])], []);
    assert.deepEqual(listed, []);
  });
});

describe('holderPlace: the walk of S2 7.5 with the number of parents it may climb', () => {
  test('8 parents by default (stage A), as many as maxSteps says', (t) => {
    const d = fakeKeeper(t);
    const programs = new Map([[KEEPER.pid, { procStart: KEEPER.procStart, termId: TERM }]]);
    assert.deepEqual(holderPlace(below(8), programs, d.proc), { termId: TERM, steps: 8 });
    assert.equal(holderPlace(below(9), programs, d.proc), 'outside');
    assert.deepEqual(holderPlace(below(9), programs, d.proc, 9), { termId: TERM, steps: 9 });
    assert.equal(holderPlace(below(10), programs, d.proc, 9), 'outside');
    assert.deepEqual(holderPlace(below(0), programs, d.proc, 9), { termId: TERM, steps: 0 });
  });
});
