// `act restart` (issue #166, with #188's flags; src/window/restart.ts): every refusal is decided
// before anything is ended — of the flags (act resume's checks, in its words), of the session and
// of its terminal —; then the program is hung up as "End session and mark done" hangs it up,
// without the done mark and without the close; once it ended the session is resumed as a plain
// resume does (or with the flags given), in a terminal that takes the held number; the old terminal
// is closed once the new one is there. When it does not work: given up after the wait (nothing
// resumed, later or ever), or ended and not resumed (the ended terminal stays). While a restart
// runs, a second one, an end, a resume, a done mark and a Close of that terminal are refused. A
// fake hub the test drives, on a test deck whose session runs.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { buildResumeCommand } from '../../src/claude/launch.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { markDone } from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { acquireLock, lockKey, refuseResumeFlags } from '../../src/sessions/resume.ts';
import { ENDED_IN_WINDOW } from '../../src/store/types.ts';
import type { LaunchSpec, OpenResult } from '../../src/terminals/types.ts';
import { createActions } from '../../src/window/actions.ts';
import type { PageInfo, SlotHold, TerminalHub, TerminalInfo } from '../../src/window/hub.ts';
import type { ActMessage, ResultMessage } from '../../src/window/protocol.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, SEC, T0, statLine } from '../helpers/platform.ts';
import { userRecord, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

const PAGE: PageInfo = { windowId: '0123456789abcdef', focused: true, area: null };
const TERM = 'a1b2c3d4e5f6';
const NEW_TERM = 'b2c3d4e5f6a7';
const PID = 5151;
const START = 51234567;
const CLAUDE = '/opt/skydeck-test/claude';
const RECORDED = ['--model', 'opus'];
const RESTARTING = 'skydeck is restarting this session';
const NOT_ENDED = 'claude has not ended within 10 seconds, so it runs on';

/** A terminal of the window running S1's program, which can be ended. */
function info(over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: TERM,
    slot: 3,
    state: 'running',
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/w',
    program: { pid: PID, procStart: START },
    openedNs: T0,
    cols: 90,
    rows: 28,
    exit: null,
    notReported: false,
    endable: true,
    ...over,
  };
}

/** S1 running in the window's terminal, started with `--model opus` in `project` (a directory made
 *  in the sandbox), else in the sandbox's home. */
function running(t: Parameters<typeof testDeck>[0], project?: string): TestDeck {
  const d = testDeck(t, { config: { claudeCommand: CLAUDE } });
  let dir = d.sandbox.home;
  if (project !== undefined) {
    dir = join(d.sandbox.root, project);
    mkdirSync(dir);
  }
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: dir }]);
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid: PID,
    pwd: dir,
    argv: ['claude', ...RECORDED],
    input: hookInput('SessionStart', S1, { source: 'startup', cwd: dir }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  const busy = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;
  writeFileSync(
    join(d.deck.places.claudeHome, 'sessions', `${PID}.json`),
    JSON.stringify({ ...busy, pid: PID, sessionId: S1 }),
  );
  d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
  refresh(d.deck);
  const row = loadRows(d.deck).find((one) => one.id === S1);
  assert.equal(row?.state, 'working');
  return d;
}

interface FakeHub extends TerminalHub {
  terminals: TerminalInfo[];
  /** What the hub was asked, in order: 'end <id>', 'hold <id>', 'take <id>', 'release <id>', 'close <id>'. */
  asked: string[];
  /** The program ended: its exit as its keeper sends it (its process gone), then the change. */
  exitNow(over?: Partial<TerminalInfo>): void;
  changed(): void;
}

function fakeHub(d: TestDeck, terminals: TerminalInfo[]): FakeHub {
  const listeners = new Set<() => void>();
  const unused = (): never => {
    throw new Error('not used here');
  };
  const find = (id: string): TerminalInfo | undefined => hub.terminals.find((one) => one.id === id);
  const hub: FakeHub = {
    terminals,
    asked: [],
    list: () => hub.terminals.map((term) => ({ ...term })),
    close(termId) {
      hub.asked.push(`close ${termId}`);
      const index = hub.terminals.findIndex((term) => term.id === termId);
      const term = hub.terminals[index];
      if (term === undefined) return 'unknown';
      if (!['ended', 'lost', 'not-started'].includes(term.state) || term.restarting) {
        return 'running';
      }
      hub.terminals.splice(index, 1);
      hub.changed();
      return 'ok';
    },
    end(termId) {
      hub.asked.push(`end ${termId}`);
      return 'ok';
    },
    holdSlot(termId): SlotHold | null {
      const term = find(termId);
      if (term === undefined || term.restarting || term.exit !== null) return null;
      hub.asked.push(`hold ${termId}`);
      term.restarting = true;
      let taken = false;
      let released = false;
      return {
        take(newId) {
          hub.asked.push(`take ${newId}`);
          if (released || taken || term.exit === null) return null;
          taken = true;
          const slot = term.slot;
          term.slot = null;
          return slot;
        },
        release() {
          if (released) return;
          released = true;
          hub.asked.push(`release ${termId}`);
          delete term.restarting;
          if (!taken && term.exit !== null) term.slot = null;
          hub.changed();
        },
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exitNow(over = {}) {
      const term = find(TERM);
      assert.ok(term);
      d.proc.setProcess(PID, null);
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
    attach: unused,
    input: unused,
    resize: unused,
    setTheme: unused,
  };
  return hub;
}

interface Harness {
  hub: FakeHub;
  /** Each terminal the actions built: its size and the hold it was given. */
  built: { cols: number; rows: number; held: boolean }[];
  specs: LaunchSpec[];
  act(action: ActMessage): Promise<ResultMessage>;
}

/**
 * The actions over the fake hub. A terminal they open lists a new terminal of the session with the
 * held number (`take`), or 9 without a hold, and answers `answer` (default: started).
 */
function harness(
  d: TestDeck,
  options: {
    terminals?: TerminalInfo[];
    answer?: (hub: FakeHub) => OpenResult;
    withoutHold?: boolean;
  } = {},
): Harness {
  const hub = fakeHub(d, options.terminals ?? [info()]);
  if (options.withoutHold === true) delete (hub as Partial<FakeHub>).holdSlot;
  const built: Harness['built'] = [];
  const specs: LaunchSpec[] = [];
  const actions = createActions({
    deck: d.deck,
    hub,
    terminalFor: (size, hold) => {
      built.push({ ...size, held: hold !== undefined });
      return {
        name: 'window',
        opensTabs: true,
        async open(spec) {
          specs.push(spec);
          const slot = hold === undefined ? 9 : hold.take(NEW_TERM);
          hub.terminals.push(
            info({
              id: NEW_TERM,
              slot,
              state: 'starting',
              sessionId: null,
              program: null,
              endable: false,
            }),
          );
          hub.changed();
          return options.answer?.(hub) ?? { ok: true };
        },
      };
    },
    openLink: async () => true,
    log: () => {},
    changed: () => {},
    prs: { fetch: () => {}, refresh: () => {} },
  });
  return { hub, built, specs, act: (action) => actions.act(PAGE, action) };
}

const restart = (over: Record<string, unknown> = {}): ActMessage =>
  ({ t: 'act', id: 9, kind: 'restart', term: TERM, sessionId: S1, ...over }) as ActMessage;

const refused = (message: string): ResultMessage => ({
  t: 'result',
  id: 9,
  ok: false,
  lines: [message],
  error: message,
  sessionId: null,
});

/** The end events the window recorded for S1. */
const windowEnds = (d: TestDeck): number =>
  d.deck.store.events().filter((event) => event.rawDetail === ENDED_IN_WINDOW).length;

/** Nothing was ended or taken: no hang-up, no hold, no lock, not marked done. */
function nothingDone(d: TestDeck, h: Harness): void {
  assert.deepEqual(
    h.hub.asked.filter((one) => one.startsWith('end') || one.startsWith('hold')),
    [],
    h.hub.asked.join(', '),
  );
  assert.equal(d.deck.store.getKv(lockKey(S1)), null, 'no lock');
  assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null, 'not marked done');
  assert.deepEqual(h.specs, [], 'nothing opened');
  assert.equal(
    h.hub.terminals.some((term) => term.restarting === true),
    false,
  );
}

/** The words `act resume` refuses `flags` with (refuseResumeFlags's UsageError). */
function resumeRefuses(flags: string[]): string {
  try {
    refuseResumeFlags(flags);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`act resume takes ${flags.join(' ')}`);
}

describe('act restart: refused before anything is ended', () => {
  const sessionCases: [string, () => TerminalInfo[], string, Record<string, unknown>?][] = [
    [
      'an unknown terminal',
      () => [info()],
      'this terminal is no longer there',
      { term: 'ffffffffffff' },
    ],
    [
      'a terminal that shows another session',
      () => [info({ sessionId: S2 })],
      'that terminal shows another session now',
    ],
    [
      'a terminal whose program holds no session yet',
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
      'a program that is not the session’s holder (it runs in another terminal)',
      () => [info({ program: { pid: 6262, procStart: 77 } })],
      'it does not run in that terminal',
    ],
  ];
  for (const [what, terminals, error, over] of sessionCases) {
    test(what, async (t) => {
      const d = running(t);
      const h = harness(d, { terminals: terminals() });
      assert.deepEqual(await h.act(restart(over)), refused(error));
      nothingDone(d, h);
    });
  }

  test('a session marked done (its row would hide its ended terminal): mark it undone first', async (t) => {
    const d = running(t);
    markDone(d.deck, S1);
    const h = harness(d);
    assert.deepEqual(await h.act(restart()), refused('it is marked done: mark it undone first'));
    assert.deepEqual(h.hub.asked, []);
  });

  test('a session the store does not know', async (t) => {
    const d = running(t);
    const h = harness(d, { terminals: [info({ sessionId: S2 })] });
    assert.deepEqual(
      await h.act(restart({ sessionId: S2 })),
      refused('skydeck does not know this session'),
    );
    nothingDone(d, h);
  });

  test('a session that also runs outside the terminal (two terminals show it): the resume would be refused', async (t) => {
    const d = running(t);
    const other = 7373;
    const fields = {
      event: 'SessionStart' as const,
      timeNs: T0 - 10n * SEC,
      pid: other,
      input: hookInput('SessionStart', S1, { source: 'resume' }),
    };
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 2)), spoolText(fields));
    d.proc.setProcess(other, { stat: statLine(other, START), cmdline: ['claude'] });
    refresh(d.deck);
    const h = harness(d);
    assert.deepEqual(
      await h.act(restart()),
      refused('it also runs outside this terminal, so it cannot be resumed'),
    );
    nothingDone(d, h);
  });

  test('a session whose directory is gone: the resume’s own words, before the end', async (t) => {
    const d = running(t, 'gone');
    rmdirSync(join(d.sandbox.root, 'gone'));
    const h = harness(d);
    const result = await h.act(restart());
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /^0b5f3c1e: directory .* no longer exists$/);
    nothingDone(d, h);
  });

  test('a lock another skydeck holds: refused, the lock left as it is', async (t) => {
    const d = running(t);
    acquireLock(d.deck, S1, {
      latestEventId: loadRows(d.deck).find((one) => one.id === S1)?.session.lastEventId ?? null,
    });
    const lock = d.deck.store.getKv(lockKey(S1));
    const h = harness(d);
    assert.deepEqual(
      await h.act(restart()),
      refused('0b5f3c1e is being resumed; try again in a minute'),
    );
    assert.equal(d.deck.store.getKv(lockKey(S1)), lock);
    assert.deepEqual(h.hub.asked, []);
  });

  test('flags in every spelling act resume refuses: its words, nothing ended', async (t) => {
    const lists = [
      ['--resume', S2],
      ['-r', S2],
      [`--resume=${S2}`],
      ['-c'],
      ['--continue'],
      ['-cp'],
      ['-pc'],
      ['-cZ'],
      ['--session-id', S2],
      ['--fork-session'],
      ['--from-pr', '12'],
      ['--teleport'],
      ['--name', 'x'],
      ['-n', 'x'],
      ['-nx'],
      ['--worktree', 'w'],
      ['-w'],
      ['--worktree=w'],
      ['-pw'],
      ['--tmux'],
      ['--bg'],
      ['--background'],
      ['--cloud'],
      ['--remote'],
      ['--desktop'],
      ['--init'],
      ['--init-only'],
      ['--maintenance'],
      ['--model', 'example', '--worktree'],
    ];
    const d = running(t);
    const h = harness(d);
    for (const flags of lists) {
      const text = flags.join(' ');
      const words = resumeRefuses(flags);
      assert.deepEqual(await h.act(restart({ flags: text })), refused(words), text);
    }
    assert.deepEqual(
      await h.act(restart({ flags: "--model 'example" })),
      refused("the flags have an unclosed '"),
    );
    nothingDone(d, h);
  });

  test('not a well-formed action (a term that is no id, no session, flags that are no text, a field more, flags over the bound)', async (t) => {
    const d = running(t);
    const h = harness(d);
    for (const action of [
      restart({ term: 'TERM' }),
      restart({ sessionId: 'S1' }),
      { t: 'act', id: 9, kind: 'restart', term: TERM },
      restart({ flags: ['--model', 'x'] }),
      restart({ flags: 7 }),
      restart({ flags: null }),
      restart({ cols: 80, rows: 24 }),
      restart({ extra: true }),
      restart({ flags: 'x'.repeat(5000) }),
    ]) {
      assert.deepEqual(
        await h.act(action as ActMessage),
        refused('skydeck cannot do that action'),
        JSON.stringify(action).slice(0, 80),
      );
    }
    nothingDone(d, h);
  });

  test('a hub that cannot hold a number restarts nothing', async (t) => {
    const d = running(t);
    const h = harness(d, { withoutHold: true });
    assert.deepEqual(await h.act(restart()), refused('skydeck cannot do that action'));
    nothingDone(d, h);
  });
});

describe('act restart: ended, then resumed as a plain resume', () => {
  test('without flags: the hang-up, the end recorded (not marked done), the resume with the recorded flags at the old size in a terminal holding the old number; the old terminal closed', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(restart());
    await Promise.resolve();
    assert.deepEqual(h.hub.asked, [`hold ${TERM}`, `end ${TERM}`]);
    assert.equal(h.hub.terminals[0]?.restarting, true);
    h.hub.exitNow();
    const result = await answer;
    assert.deepEqual(result, {
      t: 'result',
      id: 9,
      ok: true,
      lines: [],
      error: null,
      sessionId: S1,
      ended: true,
    });
    const { argv } = buildResumeCommand({
      claudeCommand: CLAUDE,
      launch: ['claude', ...RECORDED],
      sessionId: S1,
      label: null,
    });
    assert.deepEqual(
      h.specs.map((spec) => spec.argv),
      [argv],
    );
    assert.deepEqual(h.built, [{ cols: 90, rows: 28, held: true }]);
    assert.deepEqual(h.hub.asked, [
      `hold ${TERM}`,
      `end ${TERM}`,
      `take ${NEW_TERM}`,
      `release ${TERM}`,
      `close ${TERM}`,
    ]);
    assert.deepEqual(
      h.hub.terminals.map((term) => [term.id, term.slot]),
      [[NEW_TERM, 3]],
      'the new terminal holds the number 3',
    );
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null, 'not marked done');
    assert.equal(windowEnds(d), 1, 'the end recorded as one the user asked for');
    assert.notEqual(d.deck.store.getKv(lockKey(S1)), null, 'the resume took the lock');
  });

  test('with flags: those flags in place of the recorded ones, as act resume passes them', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(
      restart({ flags: "--model example --mcp-config '/tmp/example config.json'" }),
    );
    await Promise.resolve();
    h.hub.exitNow();
    assert.equal((await answer).ok, true);
    const { argv } = buildResumeCommand({
      claudeCommand: CLAUDE,
      launch: ['claude', ...RECORDED],
      sessionId: S1,
      label: null,
      flags: ['--model', 'example', '--mcp-config', '/tmp/example config.json'],
    });
    assert.deepEqual(
      h.specs.map((spec) => spec.argv),
      [argv],
    );
  });

  test('with an empty field: resumed with no flags at all', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(restart({ flags: '  ' }));
    await Promise.resolve();
    h.hub.exitNow();
    assert.equal((await answer).ok, true);
    assert.deepEqual(h.specs[0]?.argv, [CLAUDE, '--resume', S1]);
  });
});

describe('act restart: when it does not work', () => {
  test('not ended within the wait: given up and said so; the session runs on with its number; nothing resumed, also when it ends later (recorded, not closed)', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(restart());
    await Promise.resolve();
    d.clock.advanceMs(9_999);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    d.clock.advanceMs(1);
    assert.deepEqual(await answer, { ...refused(NOT_ENDED), ended: false });
    assert.deepEqual(h.hub.asked, [`hold ${TERM}`, `end ${TERM}`, `release ${TERM}`]);
    const term = h.hub.terminals[0];
    assert.deepEqual([term?.slot, term?.restarting, term?.state], [3, undefined, 'running']);
    // It ends later: an ordinary ended terminal — the end recorded, nothing resumed or closed.
    d.clock.advanceMs(60_000);
    h.hub.exitNow();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(windowEnds(d), 1);
    assert.deepEqual(h.specs, [], 'never resumed');
    assert.deepEqual(h.hub.asked, [`hold ${TERM}`, `end ${TERM}`, `release ${TERM}`]);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
  });

  test('its keeper lost meanwhile: given up with that reason, nothing resumed', async (t) => {
    const d = running(t);
    const h = harness(d);
    const answer = h.act(restart());
    await Promise.resolve();
    h.hub.exitNow({ state: 'lost', exit: { code: null, signal: 1, atNs: '1', notStarted: null } });
    assert.deepEqual(await answer, {
      ...refused("its terminal's keeper ended unexpectedly"),
      ended: false,
    });
    assert.deepEqual(h.specs, []);
    assert.equal(h.hub.terminals[0]?.restarting, undefined);
  });

  test('ended, and the resume refused (the directory went meanwhile): the ended terminal stays, with no number, and the reason is the answer', async (t) => {
    const d = running(t, 'project');
    const h = harness(d);
    const answer = h.act(restart());
    await Promise.resolve();
    rmdirSync(join(d.sandbox.root, 'project'));
    h.hub.exitNow();
    const result = await answer;
    assert.deepEqual([result.ok, result.ended, result.sessionId], [false, true, null]);
    assert.match(result.error ?? '', /^0b5f3c1e: directory .* no longer exists$/);
    assert.deepEqual(result.lines, [result.error]);
    assert.deepEqual(h.specs, [], 'nothing opened');
    assert.deepEqual(
      h.hub.terminals.map((term) => [term.id, term.state, term.slot, term.restarting]),
      [[TERM, 'ended', null, undefined]],
      'an ended terminal like any other: its bar offers Resume, Other flags… and Close',
    );
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null, 'never ended and done');
    assert.equal(d.deck.store.getKv(lockKey(S1)), null, 'no lock left');
  });

  test('ended, and the new terminal failed before it was there: the ended terminal stays; the answer says why', async (t) => {
    const d = running(t);
    const h = harness(d, {
      answer: (hub) => {
        hub.terminals.splice(
          hub.terminals.findIndex((term) => term.id === NEW_TERM),
          1,
        );
        return { ok: false, error: 'the terminal’s keeper could not be started', timedOut: false };
      },
    });
    const answer = h.act(restart());
    await Promise.resolve();
    h.hub.exitNow();
    const result = await answer;
    assert.deepEqual([result.ok, result.ended], [false, true]);
    assert.ok(
      result.lines.some((line) => line.includes('could not be started')),
      result.lines.join('\n'),
    );
    assert.equal(result.error, result.lines.join(' '));
    assert.deepEqual(
      h.hub.terminals.map((term) => [term.id, term.state]),
      [[TERM, 'ended']],
    );
  });

  test('ended, and the new terminal is there but its program did not start: the old terminal is closed, the new one shows why', async (t) => {
    const d = running(t);
    const h = harness(d, {
      answer: (hub) => {
        const next = hub.terminals.find((term) => term.id === NEW_TERM);
        assert.ok(next);
        Object.assign(next, {
          state: 'not-started',
          exit: { code: null, signal: null, atNs: '1', notStarted: 'the deadline passed' },
        });
        return { ok: false, error: 'not started: the deadline passed', timedOut: true };
      },
    });
    const answer = h.act(restart());
    await Promise.resolve();
    h.hub.exitNow();
    const result = await answer;
    assert.deepEqual([result.ok, result.ended], [false, true]);
    assert.deepEqual(
      h.hub.terminals.map((term) => [term.id, term.state, term.slot]),
      [[NEW_TERM, 'not-started', 3]],
    );
  });
});

describe('act restart: one at a time', () => {
  test('while a restart waits for the end: a second restart, an end, a resume, a done mark and a Close of its terminal are refused in one sentence; nothing is sent twice', async (t) => {
    const d = running(t);
    const h = harness(d);
    const first = h.act(restart());
    await Promise.resolve();
    for (const action of [
      restart({ id: 10 }),
      { t: 'act', id: 10, kind: 'end-session', term: TERM, sessionId: S1 },
      { t: 'act', id: 10, kind: 'resume', sessionId: S1, cols: 80, rows: 24 },
      { t: 'act', id: 10, kind: 'done', sessionId: S1 },
      { t: 'act', id: 10, kind: 'close-terminal', term: TERM },
    ]) {
      assert.deepEqual(
        await h.act(action as ActMessage),
        { ...refused(RESTARTING), id: 10 },
        (action as { kind: string }).kind,
      );
    }
    assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null, 'not marked done');
    assert.deepEqual(h.hub.asked, [`hold ${TERM}`, `end ${TERM}`]);
    // Once it ended, the same holds until the new terminal is there.
    h.hub.exitNow();
    assert.equal((await first).ok, true);
    assert.equal(h.specs.length, 1, 'one resume');
  });
});
