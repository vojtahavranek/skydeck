import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildNewCommand, buildResumeCommand } from '../../src/claude/launch.ts';
import type { Context } from '../../src/cli/context.ts';
import { main } from '../../src/cli/main.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { setLabel } from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { acquireLock, lockKey } from '../../src/sessions/resume.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../../src/terminals/types.ts';
import { printableCommand } from '../../src/text/shell.ts';
import type { KeeperExit } from '../../src/window/frames.ts';
import type { TerminalHub, TerminalInfo, TerminalState } from '../../src/window/hub.ts';
import { createLaunches } from '../../src/window/launches.ts';
import type { Launched, Launches } from '../../src/window/launches.ts';
import type { NewRequest } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, S3, SEC, T0, statLine } from '../helpers/platform.ts';
import { startRunning, userRecord, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

/** The first id testPlatform's uuid() gives: the session a `new` prepares. */
const NEW_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'do-not-log-this-text';
/** What the configuration names as the program; every launch runs it and nothing else. */
const CLAUDE = '/opt/skydeck-test/claude';
const SIZE = { cols: 100, rows: 30 };
const MAY_START: readonly TerminalState[] = ['starting', 'running', 'reconnecting', 'newer-keeper'];
const ALREADY_OPEN = 'this session is already open in the window';

// --- fakes ------------------------------------------------------------------------------------

/** What happened, in order, across the fakes: 'terminalFor 100x30', 'open <sessionId>', 'close <id>'. */
type Events = string[];

function info(id: string, state: TerminalState, over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    slot: 1,
    state,
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/w',
    program: null,
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

const exit = (over: Partial<KeeperExit>): KeeperExit => ({
  code: null,
  signal: null,
  atNs: String(T0),
  notStarted: null,
  ...over,
});

/** A hub holding `terminals`; `close` forgets one that is over (ended, lost, not started), as the registry does. */
function fakeHub(events: Events, terminals: TerminalInfo[]): TerminalHub & { closed: string[] } {
  const closed: string[] = [];
  const unused = (): never => {
    throw new Error('not used by the launches');
  };
  return {
    closed,
    list: () => terminals,
    close(termId) {
      events.push(`close ${termId}`);
      const index = terminals.findIndex((terminal) => terminal.id === termId);
      const terminal = terminals[index];
      if (terminal === undefined) return 'unknown';
      if (!['ended', 'lost', 'not-started'].includes(terminal.state)) return 'running';
      terminals.splice(index, 1);
      closed.push(termId);
      return 'ok';
    },
    attach: unused,
    input: unused,
    resize: unused,
    setTheme: unused,
    onChange: unused,
  };
}

interface Harness {
  d: TestDeck;
  launches: Launches;
  events: Events;
  specs: LaunchSpec[];
  sizes: { cols: number; rows: number }[];
  logs: string[];
  terminals: TerminalInfo[];
  hub: ReturnType<typeof fakeHub>;
}

function harness(
  d: TestDeck,
  options: {
    answer?: (spec: LaunchSpec) => OpenResult | Promise<OpenResult>;
    terminals?: TerminalInfo[];
    terminalFor?: (size: { cols: number; rows: number }) => Terminal;
    deck?: Deck;
  } = {},
): Harness {
  const events: Events = [];
  const specs: LaunchSpec[] = [];
  const sizes: { cols: number; rows: number }[] = [];
  const logs: string[] = [];
  const terminals = options.terminals ?? [];
  const hub = fakeHub(events, terminals);
  const answer = options.answer ?? ((): OpenResult => ({ ok: true }));
  const launches = createLaunches({
    deck: options.deck ?? d.deck,
    hub,
    terminalFor:
      options.terminalFor ??
      ((size) => {
        sizes.push(size);
        events.push(`terminalFor ${size.cols}x${size.rows}`);
        return {
          name: 'window',
          opensTabs: true,
          async open(spec) {
            specs.push(spec);
            events.push(`open ${spec.sessionId}`);
            return answer(spec);
          },
        };
      }),
    log: (line) => logs.push(line),
  });
  return { d, launches, events, specs, sizes, logs, terminals, hub };
}

/** A deck whose configuration names CLAUDE as the program. */
function deckOf(t: Parameters<typeof testDeck>[0]): TestDeck {
  return testDeck(t, { config: { claudeCommand: CLAUDE } });
}

// --- sessions ---------------------------------------------------------------------------------

/** S1: a transcript in the sandbox's home and one start by process 4242 (gone) with `--model opus`. */
function resumableSession(d: TestDeck, sessionId = S1): void {
  const dir = d.sandbox.home;
  writeTranscript(d, sessionId, [{ ...userRecord(sessionId, T0 - 30n * SEC), cwd: dir }]);
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 120n * SEC,
    pid: 4242,
    pwd: dir,
    argv: ['claude', '--model', 'opus'],
    input: hookInput('SessionStart', sessionId, { source: 'resume', cwd: dir }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
}

const refusedWith = (code: number, lines: string[]): Launched => ({
  code,
  lines,
  refused: true,
  sessionId: null,
});

function newRequest(d: TestDeck, over: Partial<NewRequest> = {}): NewRequest {
  return { dir: d.sandbox.home, label: null, group: null, flags: [], ...over };
}

/** What `skydeck <words>` printed on stderr in `cwd`, without its `skydeck: ` prefix and its line end. */
async function commandSays(d: TestDeck, words: string[], cwd = d.platform.cwd): Promise<string> {
  const before = d.stderr().length;
  const ctx: Context = { io: d.ctx.io, platform: { ...d.platform, cwd } };
  assert.notEqual(await main(words, ctx), 0, words.join(' '));
  const said = d.stderr().slice(before);
  assert.ok(said.startsWith('skydeck: ') && said.endsWith('\n'), JSON.stringify(said));
  return said.slice('skydeck: '.length, -1);
}

/** Nothing was started or taken for the session: no terminal opened, no lock, no label stored. */
function nothingStarted(h: Harness, sessionId: string): void {
  assert.ok(!h.events.some((event) => event.startsWith('open ')), h.events.join(', '));
  assert.deepEqual(h.specs, []);
  assert.equal(h.d.deck.store.getKv(lockKey(sessionId)), null, 'no lock');
  assert.deepEqual(h.d.deck.store.allMeta(), [], 'no label or group stored');
}

// --- resume -----------------------------------------------------------------------------------

describe('resume goes through prepareResumeById (design 7.6, S2 11.1)', () => {
  test('a session that is not running: started, code 0, the spec of buildResumeCommand with the configured claudeCommand and the size given', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    refresh(d.deck);
    setLabel(d.deck, S1, 'fix the retry');
    const h = harness(d);
    assert.deepEqual(await h.launches.resume(S1, SIZE), {
      code: 0,
      lines: [],
      refused: false,
      sessionId: S1,
    });
    assert.deepEqual(h.sizes, [SIZE]);
    const lock = d.deck.store.getKv(lockKey(S1));
    assert.ok(lock !== null, 'the lock is taken');
    const { argv } = buildResumeCommand({
      claudeCommand: CLAUDE,
      launch: ['claude', '--model', 'opus'],
      sessionId: S1,
      label: 'fix the retry',
    });
    assert.equal(argv[0], CLAUDE);
    assert.deepEqual(h.specs, [
      {
        cwd: d.sandbox.home,
        argv,
        sessionId: S1,
        kind: 'resume',
        lock,
        startByNs: T0 + 55n * SEC,
        label: 'fix the retry',
      },
    ]);
    assert.deepEqual(h.logs, []);
  });

  test('a running session: the guard refuses with code 4 and its line; the terminal is built, never opened, no lock', async (t) => {
    const d = deckOf(t);
    writeTranscript(d, S1);
    startRunning(d, S1, 5151);
    const h = harness(d);
    assert.deepEqual(
      await h.launches.resume(S1, SIZE),
      refusedWith(4, ['0b5f3c1e is running (pid 5151)']),
    );
    assert.deepEqual(h.events, ['terminalFor 100x30']);
    nothingStarted(h, S1);
  });

  test('a lock another skydeck holds: code 4, is being resumed; its lock is left as it is', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    refresh(d.deck);
    acquireLock(d.deck, S1, { latestEventId: d.deck.store.latestEventIdOfSession(S1) });
    const theirs = d.deck.store.getKv(lockKey(S1));
    d.clock.advanceMs(12_000);
    const h = harness(d);
    assert.deepEqual(
      await h.launches.resume(S1, SIZE),
      refusedWith(4, ['0b5f3c1e is being resumed (12 s ago); try again in 48 s']),
    );
    assert.equal(d.deck.store.getKv(lockKey(S1)), theirs);
    assert.deepEqual(h.specs, []);
  });

  test('two resumes of one session at once: the second meets the lock of the first and opens nothing', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    // The first open never answers (its program is starting); any later one would answer at once,
    // so that a second open fails the case instead of hanging it.
    let opens = 0;
    const h = harness(d, {
      answer: () => (++opens === 1 ? new Promise<OpenResult>(() => undefined) : { ok: true }),
    });
    void h.launches.resume(S1, SIZE);
    assert.deepEqual(
      await h.launches.resume(S1, SIZE),
      refusedWith(4, ['0b5f3c1e is being resumed (0 s ago); try again in 60 s']),
    );
    assert.equal(h.specs.length, 1);
  });

  test('rows derived without a boot id: code 4, the refusal of design 5.5, nothing taken', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    d.proc.setBootId(null);
    const h = harness(d);
    assert.deepEqual(
      await h.launches.resume(S1, SIZE),
      refusedWith(4, ['cannot tell which sessions are running: the boot id could not be read']),
    );
    nothingStarted(h, S1);
  });

  test('an id the deck does not know: code 3, the RefError line', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const h = harness(d);
    assert.deepEqual(
      await h.launches.resume(S2, SIZE),
      refusedWith(3, [`no session matches '${S2}'`]),
    );
    nothingStarted(h, S2);
  });

  test("the terminal failing: code 1, launchPrepared's lines (the reason and the command to run by hand), not refused", async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const h = harness(d, {
      answer: () => ({ ok: false, error: 'the keeper could not be started', timedOut: false }),
    });
    const command = printableCommand(d.sandbox.home, [CLAUDE, '--resume', S1, '--model', 'opus']);
    assert.ok(command !== null);
    assert.deepEqual(await h.launches.resume(S1, SIZE), {
      code: 1,
      lines: [
        'skydeck: the keeper could not be started',
        'skydeck: to start it yourself, run:',
        command,
      ],
      refused: false,
      sessionId: null,
    });
  });

  test('a timeout: code 1, no command and no session; the lock stays (the program may have started)', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const h = harness(d, { answer: () => ({ ok: false, error: 'no answer', timedOut: true }) });
    assert.deepEqual(await h.launches.resume(S1, SIZE), {
      code: 1,
      lines: [
        'skydeck: no answer',
        `skydeck: run skydeck again to see whether session ${S1} is running`,
      ],
      refused: false,
      sessionId: null,
    });
    assert.notEqual(d.deck.store.getKv(lockKey(S1)), null);
  });

  test('an open() that rejects or throws is a timeout: the reason by kind, no command, one log line by kind; the lock stays', async (t) => {
    const throwing = (): never => {
      throw new RangeError(`${SECRET} /home/someone`);
    };
    for (const [name, answer] of [
      ['rejects', () => Promise.reject(new TypeError(SECRET))],
      ['throws', throwing],
    ] as const) {
      await t.test(name, async (t) => {
        const d = deckOf(t);
        resumableSession(d);
        const h =
          name === 'rejects'
            ? harness(d, { answer })
            : harness(d, {
                terminalFor: () => ({ name: 'window', opensTabs: true, open: throwing }),
              });
        const kind = name === 'rejects' ? 'TypeError' : 'RangeError';
        assert.deepEqual(await h.launches.resume(S1, SIZE), {
          code: 1,
          lines: [
            `skydeck: the terminal failed unexpectedly (${kind})`,
            `skydeck: run skydeck again to see whether session ${S1} is running`,
          ],
          refused: false,
          sessionId: null,
        });
        assert.deepEqual(h.logs, [`resume: the terminal failed (${kind})`]);
        assert.notEqual(d.deck.store.getKv(lockKey(S1)), null);
      });
    }
  });

  test('a terminal factory that throws is thrown on, before anything is taken', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const h = harness(d, {
      terminalFor: () => {
        throw new TypeError(SECRET);
      },
    });
    await assert.rejects(h.launches.resume(S1, SIZE), TypeError);
    nothingStarted(h, S1);
    assert.deepEqual(h.logs, []);
  });

  test('an unexpected throw after the lock was taken and before open() gives that lock back and is thrown on', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    // launchPrepared reads the lock just before it opens; that read fails (the third read of S1's
    // lock: the first is acquireLock's, the second the launch's own, of the lock it took).
    let reads = 0;
    const deck = deckWith(d.deck, {
      store: {
        getKv: (key) => {
          if (key === lockKey(S1) && ++reads === 3) throw new Error(SECRET);
          return d.deck.store.getKv(key);
        },
      },
    });
    const h = harness(d, { deck });
    await assert.rejects(h.launches.resume(S1, SIZE), { message: SECRET });
    assert.deepEqual(h.specs, []);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
    assert.deepEqual(h.logs, []);
  });

  test('a lock that cannot be given back after such a throw: the first error is thrown on, one log line by kind', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const first = new Error('the read');
    let reads = 0;
    let failed = false;
    const deck = deckWith(d.deck, {
      store: {
        getKv: (key) => {
          if (key === lockKey(S1) && ++reads === 3) {
            failed = true;
            throw first;
          }
          return d.deck.store.getKv(key);
        },
        // releaseLock's transaction, after the read failed.
        transaction: (fn) => {
          if (failed) throw Object.assign(new RangeError(SECRET), { code: 'EIO' });
          return d.deck.store.transaction(fn);
        },
      },
    });
    const h = harness(d, { deck });
    await assert.rejects(h.launches.resume(S1, SIZE), (error) => error === first);
    assert.deepEqual(h.logs, ['resume: the lock was not given back (RangeError (EIO))']);
    assert.deepEqual(h.specs, []);
  });

  test('an unexpected throw after open() was called keeps the lock: the program may have started', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const h = harness(d, { answer: () => undefined as never }); // launchPrepared throws reading it
    await assert.rejects(h.launches.resume(S1, SIZE), TypeError);
    assert.equal(h.specs.length, 1);
    assert.notEqual(d.deck.store.getKv(lockKey(S1)), null);
  });

  test('a busy store is thrown on: nothing is refused for it, nothing opened', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const busy = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    const deck = deckWith(d.deck, {
      store: {
        transaction: () => {
          throw busy;
        },
      },
    });
    const h = harness(d, { deck });
    await assert.rejects(h.launches.resume(S1, SIZE), (error) => error === busy);
    assert.deepEqual(h.specs, []);
  });

  test("the session's terminals that are over are closed once the guard and the lock let it through, then it opens; others stay", async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const terminals = [
      info('aaaaaaaaaaa1', 'ended'),
      info('aaaaaaaaaaa2', 'not-started', { sessionId: null }),
      info('aaaaaaaaaaa3', 'lost'),
      info('aaaaaaaaaaa4', 'ended', { sessionId: S3 }), // showed S3 when it ended
      info('aaaaaaaaaaa5', 'running', { expectedSessionId: S2, sessionId: S2 }),
    ];
    const h = harness(d, { terminals });
    assert.equal((await h.launches.resume(S1, SIZE)).code, 0);
    assert.deepEqual(h.events.slice(-4), [
      'close aaaaaaaaaaa1',
      'close aaaaaaaaaaa2',
      'close aaaaaaaaaaa3',
      `open ${S1}`,
    ]);
    assert.deepEqual(
      terminals.map((terminal) => terminal.id),
      ['aaaaaaaaaaa4', 'aaaaaaaaaaa5'],
    );
  });

  test('a refused resume leaves the ended terminal in place', async (t) => {
    const d = deckOf(t);
    writeTranscript(d, S1);
    startRunning(d, S1, 5151);
    const h = harness(d, { terminals: [info('aaaaaaaaaaa1', 'ended')] });
    assert.equal((await h.launches.resume(S1, SIZE)).refused, true);
    assert.deepEqual(h.hub.closed, []);
  });
});

describe('resume and refusal(): already open while a terminal may still run (S2 11.1)', () => {
  for (const state of MAY_START) {
    test(`${state}: refused with code 4 before the guard, nothing built or taken, whatever the lock says`, async (t) => {
      const d = deckOf(t);
      resumableSession(d);
      const terminals = [info('aaaaaaaaaaa1', state, { sessionId: null })];
      const h = harness(d, { terminals });
      assert.equal(h.launches.refusal(S1), ALREADY_OPEN);
      assert.deepEqual(await h.launches.resume(S1, SIZE), refusedWith(4, [ALREADY_OPEN]));
      assert.deepEqual(h.events, [], 'no terminal built, none closed');
      nothingStarted(h, S1);
      // The session it shows decides once it shows one.
      terminals[0] = info('aaaaaaaaaaa1', state, { expectedSessionId: S2, sessionId: S1 });
      assert.equal(h.launches.refusal(S1), ALREADY_OPEN);
      assert.equal(h.launches.refusal(S2), null);
    });
  }

  for (const state of ['ended', 'lost', 'not-started'] as const) {
    test(`${state}: no refusal; the resume closes it and opens`, async (t) => {
      const d = deckOf(t);
      resumableSession(d);
      const h = harness(d, { terminals: [info('aaaaaaaaaaa1', state)] });
      assert.equal(h.launches.refusal(S1), null);
      assert.equal((await h.launches.resume(S1, SIZE)).code, 0);
      assert.deepEqual(h.hub.closed, ['aaaaaaaaaaa1']);
    });
  }

  test('a running terminal that now shows another session (after /clear) refuses that one, not the one it was opened for', async (t) => {
    const d = deckOf(t);
    resumableSession(d);
    const h = harness(d, { terminals: [info('aaaaaaaaaaa1', 'running', { sessionId: S3 })] });
    assert.equal(h.launches.refusal(S1), null);
    assert.equal(h.launches.refusal(S3), ALREADY_OPEN);
    assert.equal((await h.launches.resume(S1, SIZE)).code, 0);
  });
});

// --- new --------------------------------------------------------------------------------------

describe('newSession goes through prepareNew as the request is (design 7.7, S2 11.1)', () => {
  test('started: code 0 and the new id; the spec of buildNewCommand with the configured claudeCommand; the label and group stored', async (t) => {
    const d = deckOf(t);
    const h = harness(d);
    const flags = ['--model', 'opus', '--dangerously-skip-permissions', 'a prompt'];
    assert.deepEqual(
      await h.launches.newSession(newRequest(d, { label: 'fix', group: 'ABC-1', flags }), SIZE),
      { code: 0, lines: [], refused: false, sessionId: NEW_ID },
    );
    assert.deepEqual(h.sizes, [SIZE]);
    const argv = buildNewCommand({
      claudeCommand: CLAUDE,
      sessionId: NEW_ID,
      label: 'fix',
      extra: flags,
    });
    assert.equal(argv[0], CLAUDE);
    assert.deepEqual(h.specs, [
      {
        cwd: d.sandbox.home,
        argv,
        sessionId: NEW_ID,
        kind: 'new',
        lock: null,
        startByNs: T0 + 55n * SEC,
        label: 'fix',
      },
    ]);
    assert.equal(d.deck.store.meta(NEW_ID)?.group, 'ABC-1');
  });

  test('label and group null: no meta row and no name', async (t) => {
    const d = deckOf(t);
    const h = harness(d);
    assert.equal((await h.launches.newSession(newRequest(d), SIZE)).code, 0);
    assert.deepEqual(h.specs[0]?.argv, [CLAUDE, '--session-id', NEW_ID]);
    assert.deepEqual(d.deck.store.allMeta(), []);
  });

  test('the flags are passed on as given: an empty word and a word with spaces stay one word each', async (t) => {
    const d = deckOf(t);
    const h = harness(d);
    await h.launches.newSession(newRequest(d, { flags: ['', 'two words', '--model'] }), SIZE);
    assert.deepEqual(h.specs[0]?.argv.slice(3), ['', 'two words', '--model']);
  });

  test("what skydeck new refuses is refused with code 2 and the command line's own message; nothing started or stored, nothing logged", async (t) => {
    // Task 70's reviewer: the route passes label, group, dir and flags on raw; prepareNew is the
    // one place that checks them. Each case holds the rule by its text (`message`) and holds that
    // the command line says the same (the command runs in `dir` when one is given).
    const cases: {
      name: string;
      over: Partial<NewRequest>;
      words: string[];
      dir?: (d: TestDeck) => string;
      message: RegExp;
    }[] = [
      {
        name: 'a label that is a flag',
        over: { label: '--dangerously-skip-permissions' },
        words: ['new', '--label=--dangerously-skip-permissions'],
        message: /^a label cannot start with '-' \(Claude Code would read it as a flag\)$/,
      },
      {
        name: 'a label with an escape sequence',
        over: { label: 'red \x1b[31mtext' },
        words: ['new', '--label=red \x1b[31mtext'],
        message: /^a label cannot contain control characters$/,
      },
      {
        name: 'a label of two lines',
        over: { label: 'two\nlines' },
        words: ['new', '--label=two\nlines'],
        message: /^a label must be one line$/,
      },
      {
        name: 'a blank label',
        over: { label: ' ' },
        words: ['new', '--label= '],
        message: /^a label cannot be empty$/,
      },
      {
        name: 'an empty label',
        over: { label: '' },
        words: ['new', '--label='],
        message: /^a label cannot be empty$/,
      },
      {
        name: 'a group with an escape sequence',
        over: { group: 'a\x1b]0;x\x07b' },
        words: ['new', '--group=a\x1b]0;x\x07b'],
        message: /^a group cannot contain control characters$/,
      },
      {
        name: 'a group of two lines',
        over: { group: 'a\nb' },
        words: ['new', '--group=a\nb'],
        message: /^a group must be one line$/,
      },
      {
        name: 'a blank group',
        over: { group: '\t' },
        words: ['new', '--group=\t'],
        message: /^a group cannot be empty$/,
      },
      {
        name: 'an empty directory',
        over: {},
        words: ['new'],
        dir: () => '',
        message: /^the directory  is not absolute$/,
      },
      {
        name: 'a relative directory',
        over: {},
        words: ['new'],
        dir: () => 'projects/demo',
        message: /^the directory projects\/demo is not absolute$/,
      },
      {
        // It exists from the test's own working directory: only the rule refuses it.
        name: 'a relative directory that exists',
        over: {},
        words: ['new'],
        dir: () => '.',
        message: /^the directory \. is not absolute$/,
      },
      {
        name: 'a directory with an escape sequence',
        over: {},
        words: ['new'],
        dir: () => 'rel\x1b]0;x\x07/dir',
        message: /^the directory rel\/dir is not absolute$/,
      },
      {
        name: 'an absolute directory that is missing',
        over: {},
        words: ['new'],
        dir: (d) => join(d.sandbox.home, 'nope'),
        message: /^the directory \/.*\/nope does not exist$/,
      },
      {
        name: 'an absolute path that is a file',
        over: {},
        words: ['new'],
        dir: (d) => {
          const file = join(d.sandbox.home, 'a-file');
          writeFileSync(file, '');
          return file;
        },
        message: /^the directory \/.*\/a-file does not exist$/,
      },
      {
        name: '--resume <id> among the flags',
        over: { flags: ['--model', 'opus', '--resume', S1] },
        words: ['new', '--', '--model', 'opus', '--resume', S1],
        message:
          /^cannot pass --resume to claude: it picks an existing session; use skydeck resume$/,
      },
      {
        name: '-r <id>',
        over: { flags: ['-r', S1] },
        words: ['new', '--', '-r', S1],
        message: /^cannot pass -r to claude: it picks an existing session; use skydeck resume$/,
      },
      {
        name: '--continue',
        over: { flags: ['--continue'] },
        words: ['new', '--', '--continue'],
        message:
          /^cannot pass --continue to claude: it picks an existing session; use skydeck resume$/,
      },
      {
        name: 'a cluster with -c',
        over: { flags: ['-cp'] },
        words: ['new', '--', '-cp'],
        message: /^cannot pass .+ to claude: it picks an existing session; use skydeck resume$/,
      },
      {
        name: '--name',
        over: { flags: ['--name', 'x'] },
        words: ['new', '--', '--name', 'x'],
        message: /^cannot pass --name to claude: the label is given with --label/,
      },
    ];
    for (const { name, over, words, dir, message } of cases) {
      await t.test(name, async (t) => {
        const d = deckOf(t);
        const where = dir?.(d);
        const said = await commandSays(d, words, where);
        assert.match(said, message);
        const h = harness(d);
        assert.deepEqual(
          await h.launches.newSession(
            newRequest(d, where === undefined ? over : { ...over, dir: where }),
            SIZE,
          ),
          refusedWith(2, [said]),
        );
        nothingStarted(h, NEW_ID);
        assert.deepEqual(h.logs, []);
      });
    }
  });

  test('a refusal that quotes what was sent reaches the caller sanitised', async (t) => {
    const d = deckOf(t);
    const h = harness(d);
    for (const request of [
      newRequest(d, { dir: `rel\x1b]0;x\x07\n/dir\u202e` }),
      newRequest(d, { flags: ['-c\x1b[2J'] }),
    ]) {
      const launched = await h.launches.newSession(request, SIZE);
      assert.equal(launched.refused, true);
      for (const line of launched.lines) {
        assert.ok(!/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/.test(line), JSON.stringify(line));
      }
    }
  });

  test('a terminal factory that throws is thrown on, before anything is stored', async (t) => {
    const d = deckOf(t);
    const h = harness(d, {
      terminalFor: () => {
        throw new TypeError(SECRET);
      },
    });
    await assert.rejects(h.launches.newSession(newRequest(d, { label: 'fix' }), SIZE), TypeError);
    nothingStarted(h, NEW_ID);
  });

  test('a definite failure with nothing printable gives the label back; a timeout keeps it and names the new id', async (t) => {
    const d = deckOf(t);
    const definite = harness(d, {
      answer: () => ({ ok: false, error: 'no keeper', timedOut: false }),
    });
    assert.deepEqual(
      await definite.launches.newSession(
        newRequest(d, { label: 'fix', flags: ['--append-system-prompt', 'a\x1b[31mb'] }),
        SIZE,
      ),
      {
        code: 1,
        lines: [
          'skydeck: no keeper',
          'skydeck: the command contains control characters and cannot be printed safely',
        ],
        refused: false,
        sessionId: null,
      },
    );
    assert.deepEqual(d.deck.store.allMeta(), []);
    const timedOut = harness(d, {
      answer: () => ({ ok: false, error: 'no answer', timedOut: true }),
    });
    const second = '00000000-0000-4000-8000-000000000002';
    assert.deepEqual(
      (await timedOut.launches.newSession(newRequest(d, { label: 'fix' }), SIZE)).lines.at(-1),
      `skydeck: the new session's id is ${second}; running skydeck shows whether it started`,
    );
    assert.equal(d.deck.store.meta(second)?.label, 'fix');
  });

  test('an open() that rejects is a timeout logged by kind', async (t) => {
    const d = deckOf(t);
    const h = harness(d, { answer: () => Promise.reject(new TypeError(SECRET)) });
    const launched = await h.launches.newSession(newRequest(d, { label: 'fix' }), SIZE);
    assert.equal(launched.lines[0], 'skydeck: the terminal failed unexpectedly (TypeError)');
    assert.deepEqual(h.logs, ['new: the terminal failed (TypeError)']);
    assert.equal(d.deck.store.meta(NEW_ID)?.label, 'fix');
  });
});

// --- gone (plan C8) ---------------------------------------------------------------------------

describe('gone(): why a session can no longer start from its terminal (plan C8)', () => {
  test('null while any terminal of the session may still run, also beside one that is over', (t) => {
    const d = deckOf(t);
    for (const state of MAY_START) {
      const h = harness(d, {
        terminals: [
          info('aaaaaaaaaaa1', 'ended', { exit: exit({ code: 1 }) }),
          info('aaaaaaaaaaa2', state, { sessionId: null, openedNs: T0 - SEC }),
        ],
      });
      assert.equal(h.launches.gone(S1), null, state);
    }
  });

  test('each reason: not started, the keeper ended, claude ended (status or signal), no terminal listed', (t) => {
    const d = deckOf(t);
    const cases: [TerminalInfo[], string][] = [
      [
        [
          info('aaaaaaaaaaa1', 'not-started', {
            sessionId: null,
            exit: exit({ notStarted: 'the start deadline passed' }),
          }),
        ],
        'not started: the start deadline passed',
      ],
      [
        [
          info('aaaaaaaaaaa1', 'lost', {
            sessionId: null,
            exit: exit({ notStarted: 'the keeper ended before the program started' }),
          }),
        ],
        "its terminal's keeper ended",
      ],
      [
        [info('aaaaaaaaaaa1', 'ended', { exit: exit({ code: 1 }) })],
        'claude ended before the session started (status 1)',
      ],
      [
        [info('aaaaaaaaaaa1', 'ended', { exit: exit({ signal: 9 }) })],
        'claude ended before the session started (signal 9)',
      ],
      // An exit the registry never gives with these states: the reason without its detail.
      [
        [info('aaaaaaaaaaa1', 'ended', { exit: exit({}) })],
        'claude ended before the session started',
      ],
      [[info('aaaaaaaaaaa1', 'ended')], 'claude ended before the session started'],
      [[info('aaaaaaaaaaa1', 'not-started')], 'not started'],
      [[], 'its terminal was closed'],
      [
        [info('aaaaaaaaaaa1', 'running', { expectedSessionId: S2, sessionId: S2 })],
        'its terminal was closed',
      ],
    ];
    for (const [terminals, reason] of cases) {
      const h = harness(d, { terminals });
      assert.equal(h.launches.gone(S1), reason, terminals.map(({ state }) => state).join(', '));
    }
  });

  test('the terminal opened last decides when several are over', (t) => {
    const d = deckOf(t);
    const h = harness(d, {
      terminals: [
        // The registry lists in the order of opening; the one opened last stands in the middle
        // here, so that neither the first nor the last listed passes for it.
        info('aaaaaaaaaaa1', 'ended', { openedNs: T0, exit: exit({ code: 0 }) }),
        info('aaaaaaaaaaa2', 'not-started', {
          sessionId: null,
          openedNs: T0 + SEC,
          exit: exit({ notStarted: 'later one' }),
        }),
        info('aaaaaaaaaaa3', 'ended', { openedNs: T0 - SEC, exit: exit({ code: 3 }) }),
      ],
    });
    assert.equal(h.launches.gone(S1), 'not started: later one');
  });

  test("a lost terminal whose program may still live (design 5.5: its pid with the hello's start) is not gone; once that program is gone, it is", (t) => {
    // Task 71's review: gone gives the lock back on the server's word, so it stays null while a
    // program may still live — a lost keeper's program got SIGHUP, which it can survive.
    const d = deckOf(t);
    const program = { pid: 6161, procStart: 7777 };
    const lost = info('aaaaaaaaaaa1', 'lost', { program, exit: exit({ signal: 1 }) });
    const h = harness(d, { terminals: [lost] });
    d.proc.setProcess(6161, { stat: statLine(6161, 7777), cmdline: ['claude'] });
    assert.equal(h.launches.gone(S1), null, 'alive');
    d.proc.setProcess(6161, { stat: statLine(6161, 8888), cmdline: ['claude'] });
    assert.equal(
      h.launches.gone(S1),
      "its terminal's keeper ended",
      'the pid is another process now',
    );
    d.proc.setProcess(6161, null);
    assert.equal(h.launches.gone(S1), "its terminal's keeper ended", 'gone');
    d.proc.setProcess(6161, { stat: '6161 (claude) S', cmdline: ['claude'] });
    assert.equal(h.launches.gone(S1), null, 'a stat line without a start: cannot tell');
    const failing = harness(d, {
      terminals: [lost],
      deck: deckWith(d.deck, {
        proc: {
          stat: () => {
            throw Object.assign(new Error(SECRET), { code: 'EACCES' });
          },
        },
      }),
    });
    assert.equal(failing.launches.gone(S1), null, '/proc cannot be read: unknown is not dead');
    assert.deepEqual(failing.logs, []);
  });

  test('a reason the keeper sent is sanitised', (t) => {
    const d = deckOf(t);
    const h = harness(d, {
      terminals: [
        info('aaaaaaaaaaa1', 'not-started', { exit: exit({ notStarted: 'x\x1b[2J\ny\u202e' }) }),
      ],
    });
    assert.equal(h.launches.gone(S1), 'not started: x y');
  });
});

describe('the hooks never throw (task 71: a hook that throws would reject the whole restore)', () => {
  test('a hub whose list() throws: refusal refuses, gone waits; one log line by kind each, no message', (t) => {
    const d = deckOf(t);
    const h = harness(d);
    h.hub.list = () => {
      throw new TypeError(SECRET);
    };
    assert.equal(h.launches.refusal(S1), "the window's terminals could not be read (TypeError)");
    assert.equal(h.launches.gone(S1), null);
    assert.equal(h.logs.length, 2);
    for (const line of h.logs) {
      assert.match(line, /\(TypeError\)$/);
      assert.ok(!line.includes(SECRET), line);
    }
  });
});

// --- restoreTerminal ------------------------------------------------------------------------------

/** A launch spec as runRestore makes one (launchSpec) for `sessionId`. */
function restoreSpec(sessionId: string): LaunchSpec {
  return {
    cwd: '/w',
    argv: [CLAUDE, '--resume', sessionId],
    sessionId,
    kind: 'resume',
    lock: `${T0}:1`,
    startByNs: T0 + 55n * SEC,
    label: null,
  };
}

describe('restoreTerminal(): the terminal restore opens with', () => {
  test("built once with its size; its open closes the spec's session's terminals that are over, then opens the spec as given", async (t) => {
    const d = deckOf(t);
    const terminals = [
      info('aaaaaaaaaaa1', 'ended', { exit: exit({ code: 0 }) }),
      info('aaaaaaaaaaa2', 'lost', { sessionId: null }),
      info('aaaaaaaaaaa3', 'running', { expectedSessionId: S2, sessionId: S2 }),
      info('aaaaaaaaaaa4', 'ended', { expectedSessionId: S2, sessionId: S2 }),
    ];
    const h = harness(d, { terminals });
    const terminal = h.launches.restoreTerminal({ cols: 132, rows: 43 });
    assert.deepEqual(h.events, ['terminalFor 132x43']);
    assert.equal(terminal.name, 'window');
    assert.equal(terminal.opensTabs, true);
    assert.deepEqual(h.hub.closed, [], 'nothing closed before open');
    const spec = restoreSpec(S1);
    assert.deepEqual(await terminal.open(spec), { ok: true });
    assert.deepEqual(h.events, [
      'terminalFor 132x43',
      'close aaaaaaaaaaa1',
      'close aaaaaaaaaaa2',
      `open ${S1}`,
    ]);
    assert.deepEqual(h.specs, [spec]);
    assert.deepEqual(
      terminals.map((terminal) => terminal.id),
      ['aaaaaaaaaaa3', 'aaaaaaaaaaa4'],
    );
    assert.deepEqual(h.sizes, [{ cols: 132, rows: 43 }], 'the size is not read again');
  });

  test("the inner terminal's answer is passed on as it is", async (t) => {
    const d = deckOf(t);
    const failed: OpenResult = {
      ok: false,
      error: 'not started: the start deadline passed',
      timedOut: true,
    };
    const h = harness(d, { answer: () => failed });
    assert.deepEqual(await h.launches.restoreTerminal(SIZE).open(restoreSpec(S1)), failed);
  });

  test('an open() that rejects or throws: a timeout, one log line by kind, no message', async (t) => {
    for (const kind of ['rejects', 'throws'] as const) {
      await t.test(kind, async (t) => {
        const d = deckOf(t);
        const h = harness(d, {
          terminalFor: () => ({
            name: 'window',
            opensTabs: true,
            open:
              kind === 'rejects'
                ? () => Promise.reject(new TypeError(SECRET))
                : () => {
                    throw new TypeError(SECRET);
                  },
          }),
        });
        assert.deepEqual(await h.launches.restoreTerminal(SIZE).open(restoreSpec(S1)), {
          ok: false,
          error: 'the terminal failed unexpectedly (TypeError)',
          timedOut: true,
        });
        assert.deepEqual(h.logs, ['restore: the terminal failed (TypeError)']);
      });
    }
  });

  test('a factory that throws: restoreTerminal does not throw; its open is a definite failure by kind (nothing was spawned), nothing closed', async (t) => {
    const d = deckOf(t);
    const h = harness(d, {
      terminals: [info('aaaaaaaaaaa1', 'ended')],
      terminalFor: () => {
        throw Object.assign(new Error(SECRET), { code: 'EMFILE' });
      },
    });
    const terminal = h.launches.restoreTerminal(SIZE);
    assert.deepEqual(await terminal.open(restoreSpec(S1)), {
      ok: false,
      error: 'the terminal failed unexpectedly (Error (EMFILE))',
      timedOut: false,
    });
    assert.deepEqual(h.hub.closed, []);
    assert.deepEqual(h.logs, ['restore: the terminal could not be made (Error (EMFILE))']);
  });

  test('a hub whose close throws does not stop the open; logged by kind', async (t) => {
    const d = deckOf(t);
    const h = harness(d, { terminals: [info('aaaaaaaaaaa1', 'ended')] });
    h.hub.close = () => {
      throw new RangeError(SECRET);
    };
    assert.deepEqual(await h.launches.restoreTerminal(SIZE).open(restoreSpec(S1)), { ok: true });
    assert.deepEqual(h.logs, ['restore: an ended terminal was not closed (RangeError)']);
  });

  test('a spec that is not a resume is refused for certain: nothing closed, nothing opened (restore never starts a new session)', async (t) => {
    // Ruled on review 2 (C4): restore never starts a new session.
    const d = deckOf(t);
    const h = harness(d, {
      terminals: [info('aaaaaaaaaaa1', 'ended', { expectedSessionId: NEW_ID, sessionId: null })],
    });
    const spec: LaunchSpec = {
      ...restoreSpec(NEW_ID),
      argv: [CLAUDE, '--session-id', NEW_ID],
      kind: 'new',
      lock: null,
    };
    assert.deepEqual(await h.launches.restoreTerminal(SIZE).open(spec), {
      ok: false,
      error: 'restore starts only resumes',
      timedOut: false,
    });
    assert.deepEqual(h.events, ['terminalFor 100x30'], 'built, never opened, nothing closed');
    assert.deepEqual(h.specs, []);
    assert.deepEqual(h.logs, []);
  });
});
