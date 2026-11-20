// `act end-session` (follow-up F30; src/window/end-session.ts): every refusal, with nothing done;
// done first, then the hang-up; the answer once the program ended (the end recorded, the terminal
// closed) or after the wait; one hang-up while a request waits. A fake hub the test drives, on a
// test deck whose session runs (a live holder in fake /proc, ingested from the spool).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadRows } from '../../src/sessions/load.ts';
import { markDone, markUndone } from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { ENDED_IN_WINDOW } from '../../src/store/types.ts';
import { createActions } from '../../src/window/actions.ts';
import type { PageInfo, TerminalHub, TerminalInfo } from '../../src/window/hub.ts';
import type { ActMessage, ResultMessage } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, S1, S2, T0 } from '../helpers/platform.ts';
import { startRunning } from '../helpers/session-files.ts';

const PAGE: PageInfo = { windowId: '0123456789abcdef', focused: true, area: null };
const TERM = 'a1b2c3d4e5f6';
const PID = 5151;
/** The process start startRunning's stat line and spool event give the holder. */
const START = 51234567;

/** A terminal of the window running S1's program, which can be ended. */
function info(over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: TERM,
    slot: 1,
    state: 'running',
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/w',
    program: { pid: PID, procStart: START },
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    endable: true,
    ...over,
  };
}

interface FakeHub extends TerminalHub {
  terminals: TerminalInfo[];
  /** What the hub was asked, in order: 'end <id>', 'close <id>'. */
  asked: string[];
  /** What `end` answers (default 'ok'); called with the store's done mark of S1 at the call. */
  endAnswer: 'ok' | 'cannot' | 'unknown';
  /** The program ended: the terminal's exit as its keeper sends it, then the change. */
  exitNow(over?: Partial<TerminalInfo>): void;
  changed(): void;
  listeners(): number;
}

function fakeHub(d: TestDeck, terminals: TerminalInfo[]): FakeHub & { doneAtEnd: unknown[] } {
  const listeners = new Set<() => void>();
  const unused = (): never => {
    throw new Error('not used here');
  };
  const doneAtEnd: unknown[] = [];
  const hub: FakeHub & { doneAtEnd: unknown[] } = {
    terminals,
    asked: [],
    endAnswer: 'ok',
    doneAtEnd,
    list: () => hub.terminals.map((term) => ({ ...term })),
    close(termId) {
      hub.asked.push(`close ${termId}`);
      const index = hub.terminals.findIndex((term) => term.id === termId);
      const term = hub.terminals[index];
      if (term === undefined) return 'unknown';
      if (!['ended', 'lost', 'not-started'].includes(term.state)) return 'running';
      hub.terminals.splice(index, 1);
      hub.changed();
      return 'ok';
    },
    end(termId) {
      hub.asked.push(`end ${termId}`);
      doneAtEnd.push(d.deck.store.meta(S1)?.doneAtNs ?? null);
      return hub.endAnswer;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exitNow(over = {}) {
      const term = hub.terminals.find((one) => one.id === TERM);
      assert.ok(term);
      Object.assign(term, {
        state: 'ended',
        endable: false,
        exit: { code: 129, signal: null, atNs: String(T0), notStarted: null },
        ...over,
      });
      hub.changed();
    },
    changed() {
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
    attach: unused,
    input: unused,
    resize: unused,
    setTheme: unused,
  };
  return hub;
}

/** S1 running in the window's terminal: its holder (pid 5151) alive in fake /proc, ingested. */
function running(t: Parameters<typeof testDeck>[0]): TestDeck {
  const d = testDeck(t);
  startRunning(d, S1, PID);
  refresh(d.deck);
  const row = loadRows(d.deck).find((one) => one.id === S1);
  assert.equal(row?.state, 'working');
  return d;
}

function harness(d: TestDeck, terminals: TerminalInfo[] = [info()], deck = d.deck) {
  const hub = fakeHub(d, terminals);
  const told: string[] = [];
  const logs: string[] = [];
  const actions = createActions({
    deck,
    hub,
    terminalFor: () => {
      throw new Error('nothing is opened here');
    },
    openLink: async () => true,
    log: (line) => logs.push(line),
    changed: () => told.push('changed'),
    prs: { fetch: () => {}, refresh: () => {} },
  });
  return {
    hub,
    told,
    logs,
    act: (action: ActMessage): Promise<ResultMessage> => actions.act(PAGE, action),
  };
}

const endSession = (id = 9, term = TERM, sessionId = S1): ActMessage => ({
  t: 'act',
  id,
  kind: 'end-session',
  term,
  sessionId,
});

const refused = (id: number, message: string): ResultMessage => ({
  t: 'result',
  id,
  ok: false,
  lines: [message],
  error: message,
  sessionId: null,
});

/** The end events the window recorded for S1. */
function windowEnds(d: TestDeck) {
  return d.deck.store
    .events()
    .filter((event) => event.rawDetail === ENDED_IN_WINDOW)
    .map(({ kind, detail, spoolName, sessionId, bootId, pid, procStart, argv, cwd }) => ({
      kind,
      detail,
      spoolName,
      sessionId,
      bootId,
      pid,
      procStart,
      argv,
      cwd,
    }));
}

describe('act end-session: refused, nothing done', () => {
  const cases: [string, (d: TestDeck) => TerminalInfo[], string, ActMessage?][] = [
    [
      'an unknown terminal',
      () => [info()],
      'this terminal is no longer there',
      endSession(9, 'ffffffffffff'),
    ],
    [
      'a terminal that shows another session',
      () => [info({ sessionId: S2 })],
      'that terminal shows another session now',
    ],
    [
      'a terminal that holds no session yet',
      () => [info({ sessionId: null })],
      'that terminal shows another session now',
    ],
    [
      'an ended terminal',
      () => [
        info({
          state: 'ended',
          endable: false,
          exit: { code: 0, signal: null, atNs: '1', notStarted: null },
        }),
      ],
      'its program is not running',
    ],
    [
      'a terminal reconnecting',
      () => [info({ state: 'reconnecting', endable: false })],
      'its program is not running',
    ],
    [
      'a terminal whose keeper cannot end it (an older keeper, no connection)',
      () => [info({ endable: false })],
      'skydeck cannot end this one: end it in its terminal',
    ],
    [
      'a terminal that says nothing of it (absent is false)',
      () => [info({ endable: undefined })],
      'skydeck cannot end this one: end it in its terminal',
    ],
    [
      'a program that is not the session’s holder',
      () => [info({ program: { pid: 6262, procStart: 77 } })],
      'it does not run in that terminal',
    ],
  ];
  for (const [what, terminals, error, action] of cases) {
    test(what, async (t) => {
      const d = running(t);
      const h = harness(d, terminals(d));
      assert.deepEqual(await h.act(action ?? endSession()), refused(9, error));
      assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null, 'not marked done');
      assert.deepEqual(h.hub.asked, [], 'nothing sent');
      assert.deepEqual(h.told, []);
    });
  }

  test('a session already marked done (from another page) is not ended', async (t) => {
    const d = running(t);
    markDone(d.deck, S1);
    const h = harness(d);
    assert.deepEqual(await h.act(endSession()), refused(9, 'it was marked done meanwhile'));
    assert.deepEqual(h.hub.asked, []);
  });

  test('a session the store does not know', async (t) => {
    const d = running(t);
    const h = harness(d, [info({ sessionId: S2 })]);
    assert.deepEqual(
      await h.act(endSession(9, TERM, S2)),
      refused(9, 'skydeck does not know this session'),
    );
    assert.deepEqual(h.hub.asked, []);
  });

  test('a session that does not run any more (its holder is gone)', async (t) => {
    const d = running(t);
    d.proc.setProcess(PID, null);
    const h = harness(d);
    assert.deepEqual(await h.act(endSession()), refused(9, 'its program is not running'));
    assert.deepEqual(h.hub.asked, []);
  });

  test('a holder of another boot never counts as the terminal’s', async (t) => {
    const d = running(t);
    d.proc.setBootId('00000000-0000-4000-8000-0000000000bb');
    const h = harness(d);
    const result = await h.act(endSession());
    assert.equal(result.ok, false);
    assert.deepEqual(h.hub.asked, []);
  });

  test('a busy store: refused as busy, nothing sent', async (t) => {
    const d = running(t);
    const deck = deckWith(d.deck, {
      store: {
        updateMeta: () => {
          throw Object.assign(new Error('database is locked'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 5,
          });
        },
      },
    });
    const h = harness(d, [info()], deck);
    assert.deepEqual(
      await h.act(endSession()),
      refused(9, "skydeck's database is busy; try again"),
    );
    assert.deepEqual(h.hub.asked, []);
  });

  test('not a well-formed action (a term that is no terminal id, a session that is no id)', async (t) => {
    const d = running(t);
    const h = harness(d);
    for (const action of [
      { ...endSession(), term: 'TERM' },
      { ...endSession(), sessionId: 'S1' },
      { t: 'act', id: 9, kind: 'end-session', term: TERM },
      { ...endSession(), extra: true },
    ]) {
      assert.deepEqual(
        await h.act(action as ActMessage),
        refused(9, 'skydeck cannot do that action'),
      );
    }
    assert.deepEqual(h.hub.asked, []);
  });
});

describe('act end-session: done, then the hang-up', () => {
  test('the program ends: done first, one hang-up, the answer `ended`, the end recorded as an exit, the terminal closed', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(endSession());
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`end ${TERM}`]);
    assert.notEqual(h.hub.doneAtEnd[0], null, 'marked done before the hang-up was sent');
    assert.deepEqual(h.told, ['changed']);
    h.hub.exitNow();
    assert.deepEqual(await answer, {
      t: 'result',
      id: 9,
      ok: true,
      lines: [],
      error: null,
      sessionId: null,
      ended: true,
    });
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`end ${TERM}`, `close ${TERM}`]);
    assert.deepEqual(h.hub.terminals, [], 'closed: the slot is free, the row (done) is hidden');
    assert.deepEqual(windowEnds(d), [
      {
        kind: 'end',
        detail: 'exit',
        spoolName: null,
        sessionId: S1,
        bootId: BOOT_A,
        pid: PID,
        procStart: START,
        argv: null,
        cwd: null,
      },
    ]);
    assert.equal(h.hub.listeners(), 0, 'no watch is left');
    // Its holder gone, the session is an ordinary ended one: done, no mark, an exit.
    d.proc.setProcess(PID, null);
    const row = loadRows(d.deck).find((one) => one.id === S1);
    assert.equal(row?.state, 'not-running');
    assert.equal(row?.done, true);
    assert.deepEqual(row?.marks, []);
    assert.equal(row?.session.lastHolding?.endDetail, 'exit');
  });

  test('a program that ends only after the wait: `ended` false at 10 s, still marked done and running; its later end recorded and closed as one within the wait', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(endSession());
    await Promise.resolve();
    d.clock.advanceMs(9_999);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, 'not before the wait is over');
    d.clock.advanceMs(1);
    const result = await answer;
    assert.deepEqual([result.ok, result.ended], [true, false]);
    assert.notEqual(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
    assert.deepEqual(h.hub.asked, [`end ${TERM}`], 'one hang-up, no close');
    assert.equal(h.hub.terminals.length, 1);
    assert.deepEqual(windowEnds(d), []);
    // Its exit after the wait is still the user's end (ruled at review): recorded, then closed.
    d.clock.advanceMs(60_000);
    h.hub.exitNow();
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`end ${TERM}`, `close ${TERM}`]);
    assert.equal(windowEnds(d).length, 1);
    assert.equal(h.hub.listeners(), 0, 'followed no more');
    d.proc.setProcess(PID, null);
    const row = loadRows(d.deck).find((one) => one.id === S1);
    assert.deepEqual(
      [row?.done, row?.marks, row?.session.lastHolding?.endDetail],
      [true, [], 'exit'],
    );
  });

  test('after the wait, a terminal lost or forgotten is followed no more: nothing recorded, nothing closed', async (t) => {
    for (const how of ['lost', 'forgotten'] as const) {
      const d = running(t);
      const h = harness(d);
      const answer = h.act(endSession());
      await Promise.resolve();
      d.clock.advanceMs(10_000);
      assert.equal((await answer).ended, false);
      if (how === 'lost') {
        h.hub.exitNow({
          state: 'lost',
          exit: { code: null, signal: 1, atNs: '1', notStarted: null },
        });
      } else {
        h.hub.terminals.splice(0, 1);
        h.hub.changed();
      }
      assert.equal(h.hub.listeners(), 0, how);
      // A keeper's exit coming later (the same terminal found again) is not taken for the end.
      h.hub.terminals.splice(0, h.hub.terminals.length, info());
      h.hub.exitNow();
      await Promise.resolve();
      assert.deepEqual(windowEnds(d), [], how);
      assert.deepEqual(h.hub.asked, [`end ${TERM}`], how);
    }
  });

  test('undone and asked again while the first end is still followed: a second hang-up, one end recorded', async (t) => {
    const d = running(t);
    const h = harness(d);
    const first = h.act(endSession(9));
    await Promise.resolve();
    d.clock.advanceMs(10_000);
    assert.equal((await first).ended, false);
    assert.deepEqual(
      await h.act(endSession(10)),
      refused(10, 'it was marked done meanwhile'),
      'done: no second end without Undo',
    );
    markUndone(d.deck, S1);
    const second = h.act(endSession(11));
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`end ${TERM}`, `end ${TERM}`]);
    h.hub.exitNow();
    assert.equal((await second).ended, true);
    await Promise.resolve();
    assert.equal(windowEnds(d).length, 1);
    assert.equal(h.hub.listeners(), 0);
  });

  test('a hang-up that cannot be sent: marked done, `ended` false at once', async (t) => {
    const d = running(t);
    const h = harness(d);
    h.hub.endAnswer = 'cannot';
    const result = await h.act(endSession());
    assert.deepEqual([result.ok, result.ended], [true, false]);
    assert.notEqual(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
    assert.equal(h.hub.listeners(), 0);
  });

  test('a second request for the same terminal while one waits sends no second hang-up', async (t) => {
    const d = running(t);
    const h = harness(d);
    const first = h.act(endSession(9));
    const second = await h.act(endSession(10));
    assert.deepEqual(second, refused(10, 'skydeck is ending this session already'));
    assert.deepEqual(h.hub.asked, [`end ${TERM}`]);
    h.hub.exitNow();
    assert.equal((await first).ended, true);
    // Once answered, its terminal is closed: a third is refused, nothing is ended again.
    assert.deepEqual(await h.act(endSession(11)), refused(11, 'this terminal is no longer there'));
    assert.deepEqual(
      h.hub.asked.filter((one) => one.startsWith('end')),
      [`end ${TERM}`],
    );
  });

  test('a lost keeper (its exit made up) is not taken for the end: answered `ended` false at once, followed no more', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(endSession());
    await Promise.resolve();
    h.hub.exitNow({ state: 'lost', exit: { code: null, signal: 1, atNs: '1', notStarted: null } });
    assert.equal((await answer).ended, false);
    assert.equal(h.hub.listeners(), 0);
    assert.deepEqual(windowEnds(d), []);
    assert.deepEqual(h.hub.asked, [`end ${TERM}`]);
  });

  test('a change of the list behind the request never makes it act on another terminal', async (t) => {
    const d = running(t);
    const other = info({ id: 'f6e5d4c3b2a1', sessionId: S2, program: { pid: 7171, procStart: 9 } });
    const h = harness(d, [info(), other]);
    const answer = h.act(endSession());
    await Promise.resolve();
    // The other terminal ends: nothing of this request.
    const second = h.hub.terminals[1] as TerminalInfo;
    Object.assign(second, {
      state: 'ended',
      exit: { code: 0, signal: null, atNs: '1', notStarted: null },
    });
    h.hub.changed();
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`end ${TERM}`]);
    h.hub.exitNow();
    assert.equal((await answer).ended, true);
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`end ${TERM}`, `close ${TERM}`]);
    assert.deepEqual(
      h.hub.terminals.map((term) => term.id),
      ['f6e5d4c3b2a1'],
    );
  });
});
