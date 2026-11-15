import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildNewCommand } from '../../src/claude/launch.ts';
import { main } from '../../src/cli/main.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import {
  attachManualPr,
  detachSessionPr,
  keptNotePath,
  setGroup,
  setLabel,
  setNote,
} from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { lockKey } from '../../src/sessions/resume.ts';
import type { Store } from '../../src/store/store.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../../src/terminals/types.ts';
import { printableCommand } from '../../src/text/shell.ts';
import { createActions } from '../../src/window/actions.ts';
import type { ActionDeps } from '../../src/window/actions.ts';
import type { PageInfo, TerminalHub, TerminalInfo, TerminalState } from '../../src/window/hub.ts';
import type { ActMessage, ResultMessage } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, S1, S2, S3, SEC, T0, statLine } from '../helpers/platform.ts';
import { startRunning, userRecord, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

const PAGE: PageInfo = {
  windowId: '0123456789abcdef',
  focused: true,
  area: { cols: 120, rows: 40 },
};
/** The first id testPlatform's uuid() gives: the session a `new` prepares. */
const NEW_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'do-not-log-this-text';

// --- fakes ------------------------------------------------------------------------------------

/** What happened, in order, across the fakes: 'terminalFor 100x30', 'open <sessionId>', 'close <id>'. */
type Events = string[];

/** A terminal that records the specs it was given and answers as the test says. */
function fakeTerminal(
  events: Events,
  answer: (spec: LaunchSpec) => OpenResult | Promise<OpenResult> = () => ({ ok: true }),
): { terminal: Terminal; specs: LaunchSpec[] } {
  const specs: LaunchSpec[] = [];
  return {
    specs,
    terminal: {
      name: 'window',
      opensTabs: true,
      async open(spec) {
        specs.push(spec);
        events.push(`open ${spec.sessionId}`);
        return answer(spec);
      },
    },
  };
}

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

/** A hub holding `terminals`; `close` forgets one that is over (ended, lost, not started), as the registry does. */
function fakeHub(
  events: Events,
  terminals: TerminalInfo[] = [],
): TerminalHub & { closed: string[] } {
  const closed: string[] = [];
  const unused = (): never => {
    throw new Error('not used by the actions');
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
  events: Events;
  specs: LaunchSpec[];
  sizes: { cols: number; rows: number }[];
  links: string[];
  logs: string[];
  hub: ReturnType<typeof fakeHub>;
  /** What the edits told the server, in order: 'changed', 'fetch <urls>', 'refresh <sessionId>'. */
  told: string[];
  act(action: ActMessage): Promise<ResultMessage>;
}

function harness(
  d: TestDeck,
  options: {
    answer?: (spec: LaunchSpec) => OpenResult | Promise<OpenResult>;
    terminals?: TerminalInfo[];
    openLink?: (url: string) => Promise<boolean>;
    terminalFor?: ActionDeps['terminalFor'];
    deck?: Deck;
    /** Called at each changed(), after it is recorded in `told`. */
    changed?: () => void;
    /** Called at each prs.fetch(), after it is recorded in `told`. */
    fetch?: () => void;
  } = {},
): Harness {
  const events: Events = [];
  const { terminal, specs } = fakeTerminal(events, options.answer);
  const sizes: { cols: number; rows: number }[] = [];
  const links: string[] = [];
  const logs: string[] = [];
  const hub = fakeHub(events, options.terminals);
  const told: string[] = [];
  const actions = createActions({
    deck: options.deck ?? d.deck,
    hub,
    terminalFor:
      options.terminalFor ??
      ((size) => {
        sizes.push(size);
        events.push(`terminalFor ${size.cols}x${size.rows}`);
        return terminal;
      }),
    openLink:
      options.openLink ??
      (async (url) => {
        links.push(url);
        return true;
      }),
    log: (line) => logs.push(line),
    changed: () => {
      told.push('changed');
      options.changed?.();
    },
    prs: {
      fetch: (urls) => {
        told.push(`fetch ${urls.join(' ')}`);
        options.fetch?.();
      },
      refresh: (sessionId) => told.push(`refresh ${sessionId}`),
    },
  });
  return {
    d,
    events,
    specs,
    sizes,
    links,
    logs,
    hub,
    told,
    act: (action) => actions.act(PAGE, action),
  };
}

// --- sessions ---------------------------------------------------------------------------------

/** S1: a transcript in the sandbox's home and one start by process 4242 (gone) with `--model opus`. */
function resumableSession(d: TestDeck): void {
  const dir = d.sandbox.home;
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: dir }]);
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 120n * SEC,
    pid: 4242,
    pwd: dir,
    argv: ['claude', '--model', 'opus'],
    input: hookInput('SessionStart', S1, { source: 'resume', cwd: dir }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
}

const resume = (sessionId: string, id = 7): ActMessage => ({
  t: 'act',
  id,
  kind: 'resume',
  sessionId,
  cols: 100,
  rows: 30,
});

function newAction(over: Partial<Extract<ActMessage, { kind: 'new' }>> = {}): ActMessage {
  return {
    t: 'act',
    id: 8,
    kind: 'new',
    dir: '/',
    label: '',
    group: '',
    flags: '',
    cols: 90,
    rows: 20,
    ...over,
  };
}

const refused = (id: number, message: string): ResultMessage => ({
  t: 'result',
  id,
  ok: false,
  lines: [message],
  error: message,
  sessionId: null,
});

// --- resume -----------------------------------------------------------------------------------

test('resume of a session that is not running opens the terminal with the resume spec and the size given', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d);
  const result = await h.act(resume(S1));
  assert.deepEqual(result, {
    t: 'result',
    id: 7,
    ok: true,
    lines: [],
    error: null,
    sessionId: S1,
  });
  assert.deepEqual(h.sizes, [{ cols: 100, rows: 30 }]);
  const lock = d.deck.store.getKv(lockKey(S1));
  assert.ok(lock !== null, 'the lock is taken');
  assert.deepEqual(h.specs, [
    {
      cwd: d.sandbox.home,
      argv: ['claude', '--resume', S1, '--model', 'opus'],
      sessionId: S1,
      kind: 'resume',
      lock,
      startByNs: T0 + 55n * SEC,
      label: null,
    },
  ]);
});

test('resume whose terminal fails answers launchPrepared lines: the reason and the command to run by hand', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d, {
    answer: () => ({ ok: false, error: 'the keeper could not be started', timedOut: false }),
  });
  const result = await h.act(resume(S1));
  const command = printableCommand(d.sandbox.home, ['claude', '--resume', S1, '--model', 'opus']);
  assert.ok(command !== null);
  assert.deepEqual(result, {
    t: 'result',
    id: 7,
    ok: false,
    lines: [
      'skydeck: the keeper could not be started',
      'skydeck: to start it yourself, run:',
      command,
    ],
    error: null,
    sessionId: null,
  });
});

test('resume that timed out names no command and no session', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d, { answer: () => ({ ok: false, error: 'no answer', timedOut: true }) });
  const result = await h.act(resume(S1));
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, null);
  assert.deepEqual(result.lines, [
    'skydeck: no answer',
    `skydeck: run skydeck again to see whether session ${S1} is running`,
  ]);
});

test('resume of a running session answers the guard: the terminal is built but never opened, no lock is taken', async (t) => {
  const d = testDeck(t);
  writeTranscript(d, S1);
  startRunning(d, S1, 5151);
  const h = harness(d);
  assert.deepEqual(await h.act(resume(S1)), refused(7, '0b5f3c1e is running (pid 5151)'));
  // Ruled (review 1): terminalFor only builds the terminal; open() is what starts anything.
  assert.deepEqual(h.events, ['terminalFor 100x30']);
  assert.deepEqual(h.specs, []);
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
});

test('resume of a session being resumed answers the lock', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d, { answer: () => new Promise<OpenResult>(() => undefined) }); // never answers
  void h.act(resume(S1, 1));
  const second = await h.act(resume(S1, 2));
  assert.deepEqual(second, refused(2, '0b5f3c1e is being resumed (0 s ago); try again in 60 s'));
  // The second terminal is built, never opened.
  assert.deepEqual(h.events, ['terminalFor 100x30', `open ${S1}`, 'terminalFor 100x30']);
  assert.equal(h.specs.length, 1);
});

test('resume of an id the deck does not know answers the RefError', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d);
  assert.deepEqual(await h.act(resume(S2)), refused(7, `no session matches '${S2}'`));
  assert.deepEqual(h.events, ['terminalFor 100x30']);
  assert.deepEqual(h.specs, []);
});

test("resume closes the session's ended terminals first, then opens the new one; other terminals stay", async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const terminals = [
    info('aaaaaaaaaaa1', 'ended'),
    info('aaaaaaaaaaa2', 'not-started', { sessionId: null }),
    info('aaaaaaaaaaa3', 'lost'),
    // Not S1's: it showed S3 when it ended (after /clear), and its row is S3's.
    info('aaaaaaaaaaa4', 'ended', { sessionId: S3 }),
    info('aaaaaaaaaaa5', 'ended', { expectedSessionId: S2, sessionId: S2 }),
    // A running one of another session (S1's own would refuse the resume: the test below).
    info('aaaaaaaaaaa6', 'running', { expectedSessionId: S2, sessionId: S2 }),
  ];
  const h = harness(d, { terminals });
  assert.equal((await h.act(resume(S1))).ok, true);
  assert.deepEqual(h.hub.closed, ['aaaaaaaaaaa1', 'aaaaaaaaaaa2', 'aaaaaaaaaaa3']);
  assert.deepEqual(h.events.slice(-4), [
    'close aaaaaaaaaaa1',
    'close aaaaaaaaaaa2',
    'close aaaaaaaaaaa3',
    `open ${S1}`,
  ]);
  assert.deepEqual(
    terminals.map((terminal) => terminal.id),
    ['aaaaaaaaaaa4', 'aaaaaaaaaaa5', 'aaaaaaaaaaa6'],
  );
});

test('resume is refused while a terminal of the window was opened for the session and may still run, whatever the lock says', async (t) => {
  // Ruled (review 2 of task 32): claude can wait at a dialog before its SessionStart for longer
  // than the lock holds; the guard then sees no holder, but the window knows its own terminal.
  const d = testDeck(t);
  resumableSession(d);
  const terminals: TerminalInfo[] = [];
  const h = harness(d, { terminals });
  assert.equal((await h.act(resume(S1, 1))).ok, true);
  terminals.push(info('aaaaaaaaaaa1', 'starting', { sessionId: null }));
  const lock = d.deck.store.getKv(lockKey(S1));
  d.clock.advanceMs(61_000); // the lock is stale now
  for (const state of ['starting', 'running', 'reconnecting', 'newer-keeper'] as const) {
    terminals[0] = info('aaaaaaaaaaa1', state, { sessionId: state === 'running' ? S1 : null });
    assert.deepEqual(
      await h.act(resume(S1, 2)),
      refused(2, 'this session is already open in the window'),
      state,
    );
  }
  assert.deepEqual(h.events, ['terminalFor 100x30', `open ${S1}`]); // nothing built, one opened
  assert.equal(d.deck.store.getKv(lockKey(S1)), lock); // no lock taken
  assert.deepEqual(h.hub.closed, []);
});

test('resume is allowed again once that terminal ended, and closes it first; a new session is never refused by it', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const terminals = [info('aaaaaaaaaaa1', 'starting', { sessionId: null })];
  const h = harness(d, { terminals });
  assert.equal((await h.act(newAction({ dir: d.sandbox.home }))).ok, true);
  terminals[0] = info('aaaaaaaaaaa1', 'ended', { sessionId: null });
  assert.equal((await h.act(resume(S1))).ok, true);
  assert.deepEqual(h.hub.closed, ['aaaaaaaaaaa1']);
  assert.deepEqual(h.events.slice(-2), ['close aaaaaaaaaaa1', `open ${S1}`]);
});

test("resume is not refused by a running terminal that now shows another session (after /clear), nor by another session's", async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d, {
    terminals: [
      info('aaaaaaaaaaa1', 'running', { sessionId: S3 }),
      info('aaaaaaaaaaa2', 'starting', { expectedSessionId: S2, sessionId: null }),
    ],
  });
  assert.equal((await h.act(resume(S1))).ok, true);
});

test('an unexpected throw after the lock was taken and before open() gives the lock back', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  // launchPrepared reads the lock just before it opens; that read fails (the third read of S1's
  // lock: the first is acquireLock's, the second the actions' own, of the lock they took).
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
  const result = await h.act(resume(S1));
  assert.equal(result.ok, false);
  assert.deepEqual(h.specs, []);
  assert.deepEqual(h.logs, ['act resume: failed (Error)']);
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
});

test('an unexpected throw after open() was called keeps the lock: the program may have started', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  // An open() that resolves to nothing: launchPrepared throws reading its result, after the open.
  const h = harness(d, { answer: () => undefined as never });
  const result = await h.act(resume(S1));
  assert.equal(result.ok, false);
  assert.equal(h.events.at(-1), `open ${S1}`);
  assert.deepEqual(h.logs, ['act resume: failed (TypeError)']);
  assert.deepEqual(
    h.specs.map((spec) => spec.lock),
    [d.deck.store.getKv(lockKey(S1))],
  );
  assert.notEqual(d.deck.store.getKv(lockKey(S1)), null);
});

test('the lock given back is the one the resume took, never one another skydeck wrote since', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  let reads = 0;
  const deck = deckWith(d.deck, {
    store: {
      getKv: (key) => {
        if (key === lockKey(S1) && ++reads === 3) {
          d.deck.store.setKv(lockKey(S1), 'another skydeck'); // ours was taken over meanwhile
          throw new Error(SECRET);
        }
        return d.deck.store.getKv(key);
      },
    },
  });
  const h = harness(d, { deck });
  assert.equal((await h.act(resume(S1))).ok, false);
  assert.equal(d.deck.store.getKv(lockKey(S1)), 'another skydeck');
});

test('a refused resume leaves the ended terminal in place', async (t) => {
  const d = testDeck(t);
  writeTranscript(d, S1);
  startRunning(d, S1, 5151);
  const h = harness(d, { terminals: [info('aaaaaaaaaaa1', 'ended')] });
  assert.equal((await h.act(resume(S1))).ok, false);
  assert.deepEqual(
    h.events.filter((event) => event.startsWith('close')),
    [],
  );
});

test('a hub whose close throws does not stop the resume; the failure is logged by kind', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d, { terminals: [info('aaaaaaaaaaa1', 'ended')] });
  h.hub.close = () => {
    throw new TypeError(SECRET);
  };
  assert.equal((await h.act(resume(S1))).ok, true);
  assert.equal(h.specs.length, 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0] ?? '', /TypeError/);
  assert.ok(!(h.logs[0] ?? '').includes(SECRET));
});

// --- new --------------------------------------------------------------------------------------

test('new with a directory, a label, a group and flags opens buildNewCommand and stores the meta', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  const result = await h.act(
    newAction({ dir: d.sandbox.home, label: 'fix', group: 'ABC-1', flags: '--model opus' }),
  );
  assert.deepEqual(result, {
    t: 'result',
    id: 8,
    ok: true,
    lines: [],
    error: null,
    sessionId: NEW_ID,
  });
  assert.deepEqual(h.sizes, [{ cols: 90, rows: 20 }]);
  assert.deepEqual(h.specs, [
    {
      cwd: d.sandbox.home,
      argv: buildNewCommand({
        claudeCommand: 'claude',
        sessionId: NEW_ID,
        label: 'fix',
        extra: ['--model', 'opus'],
      }),
      sessionId: NEW_ID,
      kind: 'new',
      lock: null,
      startByNs: T0 + 55n * SEC,
      label: 'fix',
    },
  ]);
  const meta = d.deck.store.meta(NEW_ID);
  assert.equal(meta?.label, 'fix');
  assert.equal(meta?.group, 'ABC-1');
});

test('new splits the flags as S2 12.6 says: quotes group words, any whitespace separates', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  await h.act(newAction({ dir: d.sandbox.home, flags: `--model\topus  'a prompt' "x y"` }));
  assert.deepEqual(h.specs[0]?.argv.slice(3), ['--model', 'opus', 'a prompt', 'x y']);
});

test('new with an empty label and group stores no meta row and passes no name', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  const result = await h.act(newAction({ dir: d.sandbox.home, label: '', group: '' }));
  assert.equal(result.ok, true);
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.deepEqual(h.specs[0]?.argv, ['claude', '--session-id', NEW_ID]);
  assert.equal(h.specs[0]?.label, null);
});

test('new with a label and a group of only spaces counts them as none', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  const result = await h.act(newAction({ dir: d.sandbox.home, label: '   ', group: ' \t' }));
  assert.equal(result.ok, true);
  assert.deepEqual(d.deck.store.allMeta(), []);
});

test('new refuses what skydeck new refuses: nothing stored, the terminal never asked', async (t) => {
  const cases: {
    name: string;
    over: (d: TestDeck) => Partial<Extract<ActMessage, { kind: 'new' }>>;
    message: RegExp;
  }[] = [
    {
      name: '-r x',
      over: () => ({ flags: '-r x' }),
      message: /^cannot pass -r to claude: it picks an existing session/,
    },
    {
      name: '--continue',
      over: () => ({ flags: '--continue' }),
      message: /^cannot pass --continue to claude/,
    },
    {
      name: '--name y',
      over: () => ({ flags: '--name y' }),
      message: /^cannot pass --name to claude: the label is given/,
    },
    {
      name: 'an unclosed quote',
      over: () => ({ flags: "'unclosed" }),
      message: /^the flags have an unclosed '$/,
    },
    {
      name: 'a NUL in the flags',
      over: () => ({ flags: 'a\0b' }),
      message: /^the flags contain a NUL character$/,
    },
    {
      name: 'a relative directory',
      over: () => ({ dir: 'projects/demo' }),
      message: /^the directory projects\/demo is not absolute$/,
    },
    {
      name: 'a missing directory',
      over: (d) => ({ dir: join(d.sandbox.home, 'nope') }),
      message: /^the directory .*\/nope does not exist$/,
    },
    {
      name: 'a directory that is a file',
      over: (d) => {
        const file = join(d.sandbox.home, 'a-file');
        writeFileSync(file, '');
        return { dir: file };
      },
      message: /does not exist$/,
    },
    {
      name: 'a label starting with -',
      over: () => ({ label: '-x' }),
      message: /^a label cannot start with '-'/,
    },
    {
      name: 'a group of two lines',
      over: () => ({ group: 'a\nb' }),
      message: /^a group must be one line$/,
    },
  ];
  for (const { name, over, message } of cases) {
    await t.test(name, async (t) => {
      const d = testDeck(t);
      const h = harness(d);
      const result = await h.act(
        newAction({ dir: d.sandbox.home, label: 'fix', group: 'ABC-1', ...over(d) }),
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', message);
      assert.deepEqual(result.lines, [result.error]);
      assert.equal(result.sessionId, null);
      assert.ok(!h.events.some((event) => event.startsWith('open ')), h.events.join(', '));
      assert.deepEqual(h.specs, []);
      assert.deepEqual(d.deck.store.allMeta(), []);
    });
  }
});

test('new whose terminal fails definitely with no printable command gives back the label and group', async (t) => {
  const d = testDeck(t);
  const h = harness(d, { answer: () => ({ ok: false, error: 'no keeper', timedOut: false }) });
  const result = await h.act(
    newAction({ dir: d.sandbox.home, label: 'fix', flags: '--append-system-prompt a\x1b[31mb' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, null);
  assert.deepEqual(result.lines, [
    'skydeck: no keeper',
    'skydeck: the command contains control characters and cannot be printed safely',
  ]);
  assert.deepEqual(d.deck.store.allMeta(), []);
});

test('new that timed out names the new session for the user to look for, but not as started', async (t) => {
  const d = testDeck(t);
  const h = harness(d, { answer: () => ({ ok: false, error: 'no answer', timedOut: true }) });
  const result = await h.act(newAction({ dir: d.sandbox.home, label: 'fix' }));
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, null);
  assert.equal(
    result.lines.at(-1),
    `skydeck: the new session's id is ${NEW_ID}; running skydeck shows whether it started`,
  );
  assert.equal(d.deck.store.meta(NEW_ID)?.label, 'fix'); // it may have started
});

// --- close-terminal and open-link ---------------------------------------------------------------

test('close-terminal of a running terminal is refused; of an ended one it forgets it', async (t) => {
  const d = testDeck(t);
  const h = harness(d, {
    terminals: [info('aaaaaaaaaaa1', 'running'), info('aaaaaaaaaaa2', 'ended')],
  });
  const close = (term: string): ActMessage => ({ t: 'act', id: 3, kind: 'close-terminal', term });
  assert.deepEqual(
    await h.act(close('aaaaaaaaaaa1')),
    refused(3, 'the program still runs; end it inside claude'),
  );
  assert.deepEqual(await h.act(close('aaaaaaaaaaa2')), {
    t: 'result',
    id: 3,
    ok: true,
    lines: [],
    error: null,
    sessionId: null,
  });
  assert.deepEqual(h.hub.closed, ['aaaaaaaaaaa2']);
  assert.deepEqual(
    await h.act(close('aaaaaaaaaaa2')),
    refused(3, 'this terminal is no longer there'),
  );
});

test('open-link opens an http(s) URL through openLink, and nothing else', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  const link = (url: string): ActMessage => ({ t: 'act', id: 4, kind: 'open-link', url });
  assert.deepEqual(await h.act(link('https://github.com/a/b/pull/1')), {
    t: 'result',
    id: 4,
    ok: true,
    lines: [],
    error: null,
    sessionId: null,
  });
  const notOpened = 'skydeck opens only http and https links of at most 2,048 characters';
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    '-https://example.com',
    `https://example.com/${'a'.repeat(2048)}`,
    'https://example.com/?a\\b',
  ]) {
    assert.deepEqual(await h.act(link(url)), refused(4, notOpened), url);
  }
  assert.deepEqual(h.links, ['https://github.com/a/b/pull/1']);
  assert.deepEqual(h.logs, []);
});

test('open-link passes on the re-serialised URL', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  await h.act({ t: 'act', id: 4, kind: 'open-link', url: 'HTTPS://GitHub.com/a b' });
  assert.deepEqual(h.links, ['https://github.com/a%20b']);
});

/** `d`'s deck with `window.links` set to `links`. */
function deckWithLinks(d: TestDeck, links: 'default' | 'edge'): Deck {
  return { ...d.deck, config: { ...d.deck.config, window: { ...d.deck.config.window, links } } };
}

test('open-link that the default browser cannot open answers so, naming window.links "edge"', async (t) => {
  const d = testDeck(t);
  assert.equal(d.deck.config.window.links, 'default');
  const words =
    'the link could not be opened: the default browser could not be started (window.links "edge" opens links in Edge)';
  for (const deck of [d.deck, deckWithLinks(d, 'default')]) {
    const h = harness(d, { deck, openLink: async () => false });
    const result = await h.act({ t: 'act', id: 4, kind: 'open-link', url: 'https://example.com/' });
    assert.deepEqual(result, refused(4, words));
  }
});

test('open-link that Edge cannot open (window.links "edge") answers so', async (t) => {
  const d = testDeck(t);
  const h = harness(d, { deck: deckWithLinks(d, 'edge'), openLink: async () => false });
  const result = await h.act({ t: 'act', id: 4, kind: 'open-link', url: 'https://example.com/' });
  assert.deepEqual(result, refused(4, 'the link could not be opened: Edge could not be started'));
});

test('open-link of an address linkToOpen refuses gives the same refusal whatever window.links says, and opens nothing', async (t) => {
  const d = testDeck(t);
  for (const links of ['default', 'edge'] as const) {
    const h = harness(d, { deck: deckWithLinks(d, links) });
    const result = await h.act({ t: 'act', id: 4, kind: 'open-link', url: 'file:///etc/passwd' });
    assert.deepEqual(
      result,
      refused(4, 'skydeck opens only http and https links of at most 2,048 characters'),
    );
    assert.deepEqual(h.links, []);
  }
});

// --- the unexpected ---------------------------------------------------------------------------

test('a terminal factory that throws: ok false, one log line with the kind and no message, nothing taken', async (t) => {
  const throwing = (): never => {
    throw new TypeError(`${SECRET} /home/someone`);
  };
  for (const action of [resume(S1), newAction({ label: 'fix', group: 'ABC-1' })]) {
    await t.test(action.kind, async (t) => {
      const d = testDeck(t);
      resumableSession(d);
      const h = harness(d, { terminalFor: throwing });
      const result = await h.act(
        action.kind === 'new' ? { ...action, dir: d.sandbox.home } : action,
      );
      assert.equal(result.ok, false);
      assert.equal(result.sessionId, null);
      assert.equal(h.logs.length, 1);
      assert.match(h.logs[0] ?? '', new RegExp(`^act ${action.kind}: failed \\(TypeError\\)$`));
      for (const text of [...h.logs, ...result.lines, result.error ?? '']) {
        assert.ok(!text.includes(SECRET), text);
      }
      assert.equal(d.deck.store.getKv(lockKey(S1)), null);
      assert.deepEqual(d.deck.store.allMeta(), []);
    });
  }
});

test('a terminal whose open() rejects: one log line by kind, no message, no command, the lock and the label kept', async (t) => {
  // Ruled (review 1, replaced): a window terminal whose open() rejects may already have a keeper,
  // so the result is that of a timeout — no command to run by hand, which could resume twice.
  const cases = [
    {
      action: resume(S1),
      last: `skydeck: run skydeck again to see whether session ${S1} is running`,
    },
    {
      action: newAction({ label: 'fix', group: 'ABC-1' }),
      last: `skydeck: the new session's id is ${NEW_ID}; running skydeck shows whether it started`,
    },
  ];
  for (const { action, last } of cases) {
    await t.test(action.kind, async (t) => {
      const d = testDeck(t);
      resumableSession(d);
      const h = harness(d, { answer: () => Promise.reject(new TypeError(`${SECRET} /home/x`)) });
      const result = await h.act(
        action.kind === 'new' ? { ...action, dir: d.sandbox.home } : action,
      );
      assert.deepEqual(result, {
        t: 'result',
        id: action.id,
        ok: false,
        lines: ['skydeck: the terminal failed unexpectedly (TypeError)', last],
        error: null,
        sessionId: null,
      });
      assert.deepEqual(h.logs, [`act ${action.kind}: the terminal failed (TypeError)`]);
      for (const text of [...h.logs, ...result.lines]) {
        assert.ok(!text.includes(SECRET), text);
        assert.ok(!text.includes('cd --') && !text.includes('run:'), text);
      }
      if (action.kind === 'resume') {
        assert.notEqual(d.deck.store.getKv(lockKey(S1)), null); // as after a timeout
      } else {
        assert.equal(d.deck.store.meta(NEW_ID)?.label, 'fix');
      }
    });
  }
});

test('a terminal whose open() throws at once is treated as one that rejects', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const throwing: Terminal = {
    name: 'window',
    opensTabs: true,
    open: () => {
      throw new RangeError(SECRET); // not a rejected promise: a throw before one is returned
    },
  };
  const h = harness(d, { terminalFor: () => throwing });
  const result = await h.act(resume(S1));
  assert.equal(result.lines[0], 'skydeck: the terminal failed unexpectedly (RangeError)');
  assert.deepEqual(h.logs, ['act resume: the terminal failed (RangeError)']);
});

test('an openLink that rejects, or a hub whose close throws: ok false and one log line by kind', async (t) => {
  const d = testDeck(t);
  const h = harness(d, {
    openLink: () => Promise.reject(Object.assign(new Error(SECRET), { code: 'EPERM' })),
  });
  const link = await h.act({ t: 'act', id: 4, kind: 'open-link', url: 'https://example.com/' });
  assert.equal(link.ok, false);
  h.hub.close = () => {
    throw new RangeError(SECRET);
  };
  const close = await h.act({ t: 'act', id: 5, kind: 'close-terminal', term: 'aaaaaaaaaaa1' });
  assert.equal(close.ok, false);
  assert.equal(close.id, 5);
  assert.deepEqual(h.logs, [
    'act open-link: failed (Error (EPERM))',
    'act close-terminal: failed (RangeError)',
  ]);
  for (const text of [...link.lines, link.error ?? '', ...close.lines, close.error ?? '']) {
    assert.ok(!text.includes(SECRET), text);
  }
});

test('an action of no stage, or not well formed, is refused without acting', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d);
  const hostile = [
    { t: 'act', id: 9, kind: 'search', text: 'x' },
    { t: 'act', id: 9, kind: 'restore', sessionIds: [S1, S1] },
    { t: 'act', id: 9, kind: 'dismiss-restore', bootId: BOOT_A.toUpperCase() },
    { t: 'act', id: 9, kind: 'resume', sessionId: S1, cols: 0, rows: 30 },
    { t: 'act', id: 9, kind: 'resume', sessionId: S1, cols: 100, rows: 1.5 },
    { t: 'act', id: 9, kind: 'resume', sessionId: 'S1', cols: 100, rows: 30 },
    { t: 'act', id: 9, kind: 'resume', sessionId: S1, cols: 65536, rows: 30 },
    { t: 'act', id: 9, kind: 'resume', sessionId: S1, cols: 100, rows: 30, extra: 1 },
    { t: 'act', id: 9, kind: 'new', dir: 7, label: '', group: '', flags: '', cols: 1, rows: 1 },
    newAction({ dir: d.sandbox.home, cols: 0 }),
    newAction({ dir: d.sandbox.home, rows: 65536 }),
    { ...newAction({ dir: d.sandbox.home }), label: 7 },
    { ...newAction({ dir: d.sandbox.home }), flags: null },
    // The parser's text limits (UTF-8 bytes: paths 4,096, other text 1,024) and well-formed text.
    newAction({ dir: d.sandbox.home, label: 'x'.repeat(1025) }),
    newAction({ dir: d.sandbox.home, label: 'x'.repeat(5000) }),
    newAction({ dir: d.sandbox.home, label: 'é'.repeat(513) }),
    newAction({ dir: d.sandbox.home, flags: 'x'.repeat(200_000) }),
    newAction({ dir: `/${'d'.repeat(4096)}` }),
    newAction({ dir: d.sandbox.home, label: 'a\ud800b' }),
    { t: 'act', id: 9, kind: 'close-terminal', term: '../server' },
    { t: 'act', id: 9, kind: 'open-link', url: null },
    { t: 'act', id: 9, kind: 'open-link', url: `https://example.com/${'u'.repeat(4096)}` },
    { t: 'input', id: 9, kind: 'resume', sessionId: S1, cols: 100, rows: 30 },
  ] as unknown as ActMessage[];
  for (const action of hostile) {
    const result = await h.act({ ...action, id: 9 });
    assert.deepEqual(result, refused(9, 'skydeck cannot do that action'), JSON.stringify(action));
  }
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.links, []);
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.equal(h.logs.length, hostile.length);
  for (const line of h.logs) {
    // The parser's kind: fixed text, never what the page sent.
    assert.match(line, /^act: refused an action that is not valid \([\w.-]+: [a-z ]+\)$/);
  }
});

// --- stage D: editing (plan D, task 36) --------------------------------------------------------

/** S1 resumable and known to the store (a refresh read it), so that it is a row of loadRows. */
function knownSession(d: TestDeck): void {
  resumableSession(d);
  refresh(d.deck);
}

const ok = (id: number, lines: string[] = []): ResultMessage => ({
  t: 'result',
  id,
  ok: true,
  lines,
  error: null,
  sessionId: null,
});

const label = (text: string, id = 31): ActMessage => ({
  t: 'act',
  id,
  kind: 'label',
  sessionId: S1,
  text,
});
const group = (text: string, id = 32): ActMessage => ({
  t: 'act',
  id,
  kind: 'group',
  sessionId: S1,
  text,
});
const note = (text: string, base: string, id = 33): ActMessage => ({
  t: 'act',
  id,
  kind: 'note',
  sessionId: S1,
  text,
  base,
});
const PR7 = 'https://github.com/acme/web/pull/7';

/** The stage D actions on `sessionId`, each with fields that pass the parser. */
function everyEdit(sessionId: string): ActMessage[] {
  return [
    { t: 'act', id: 41, kind: 'label', sessionId, text: 'a label' },
    { t: 'act', id: 42, kind: 'group', sessionId, text: 'ORB-2107' },
    { t: 'act', id: 43, kind: 'note', sessionId, text: 'a note', base: '' },
    { t: 'act', id: 44, kind: 'done', sessionId },
    { t: 'act', id: 45, kind: 'undone', sessionId },
    { t: 'act', id: 46, kind: 'pr-refresh', sessionId },
    { t: 'act', id: 47, kind: 'pr-add', sessionId, url: PR7 },
    { t: 'act', id: 48, kind: 'pr-rm', sessionId, url: PR7 },
  ];
}

/** What `skydeck <words>` printed on stderr, without its `skydeck: ` prefix and its line end. */
async function commandSays(d: TestDeck, words: string[]): Promise<string> {
  const before = d.stderr().length;
  assert.notEqual(await main(words, d.ctx), 0, words.join(' '));
  const said = d.stderr().slice(before);
  assert.ok(said.startsWith('skydeck: ') && said.endsWith('\n'), JSON.stringify(said));
  return said.slice('skydeck: '.length, -1);
}

describe('label and group (S2 12.5, design 7.1)', () => {
  test('the text is stored trimmed through cleanLabel and setLabel, cleanGroup and setGroup; ok with no lines; changed() once each', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    assert.deepEqual(await h.act(label('  fix the retry  ')), ok(31));
    assert.deepEqual(await h.act(group(' ABC-12 cleanup ')), ok(32));
    assert.equal(d.deck.store.meta(S1)?.label, 'fix the retry');
    assert.equal(d.deck.store.meta(S1)?.group, 'ABC-12 cleanup');
    assert.deepEqual(h.told, ['changed', 'changed']);
    assert.deepEqual(h.logs, []);
  });

  test('an empty text, or one of only white space, clears it, as the commands do', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    for (const blank of ['', '   ', '\t', ' \n ']) {
      setLabel(d.deck, S1, 'keep');
      setGroup(d.deck, S1, 'KEEP-1');
      assert.deepEqual(await h.act(label(blank)), ok(31), JSON.stringify(blank));
      assert.deepEqual(await h.act(group(blank)), ok(32), JSON.stringify(blank));
      assert.equal(d.deck.store.meta(S1)?.label, null);
      assert.equal(d.deck.store.meta(S1)?.group, null);
    }
  });

  test("what design 7.1 refuses is refused with the message skydeck label or group prints for the same text, without its 'skydeck: '; nothing written", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    const cases: ['label' | 'group', string][] = [
      ['label', 'two\nlines'],
      ['label', 'a\rb'],
      ['label', 'red \x1b[31mtext'],
      ['label', 'a b'],
      ['label', 'bell\x07'],
      ['label', '-x'],
      ['label', '  --model opus'],
      ['group', 'ABC\t12'],
      ['group', 'two\nlines'],
      ['group', 'red \x1b[31mtext'],
    ];
    for (const [kind, text] of cases) {
      const expected = await commandSays(d, [kind, S1, '--', text]);
      const result = await h.act(kind === 'label' ? label(text) : group(text));
      assert.deepEqual(result, refused(kind === 'label' ? 31 : 32, expected), JSON.stringify(text));
    }
    assert.equal(d.deck.store.meta(S1), null, 'nothing written');
    assert.deepEqual(h.told, [], 'changed() never');
    assert.deepEqual(h.logs, []);
  });
});

test('changed() comes after the write: at that moment the store already holds it, for every kind that writes', async (t) => {
  const d = testDeck(t);
  knownSession(d);
  const seen: unknown[] = [];
  const h = harness(d, {
    changed() {
      const meta = d.deck.store.meta(S1);
      const attached = d.deck.store.sessionPrs().filter((link) => link.detachedAtNs === null);
      seen.push([meta?.label, meta?.group, meta?.note, meta?.doneAtNs !== null, attached.length]);
    },
  });
  const edits: ActMessage[] = [
    label('L'),
    group('G-1'),
    note('N', ''),
    { t: 'act', id: 44, kind: 'done', sessionId: S1 },
    { t: 'act', id: 45, kind: 'undone', sessionId: S1 },
    { t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url: PR7 },
    { t: 'act', id: 48, kind: 'pr-rm', sessionId: S1, url: PR7 },
  ];
  for (const action of edits) assert.equal((await h.act(action)).ok, true, action.kind);
  assert.deepEqual(seen, [
    ['L', null, null, false, 0],
    ['L', 'G-1', null, false, 0],
    ['L', 'G-1', 'N', false, 0],
    ['L', 'G-1', 'N', true, 0],
    ['L', 'G-1', 'N', false, 0],
    ['L', 'G-1', 'N', false, 1],
    ['L', 'G-1', 'N', false, 0],
  ]);
});

test('a committed write answers ok even when changed() or prs.fetch throws; one log line by kind, nothing of the text (ruled on #90, review 2)', async (t) => {
  const d = testDeck(t);
  knownSession(d);
  const h = harness(d, {
    changed() {
      throw new RangeError(`cannot tell ${SECRET}`);
    },
  });
  const url = `https://github.com/acme/${SECRET}/pull/7`;
  const edits: ActMessage[] = [
    label(SECRET),
    group(SECRET),
    note(SECRET, ''),
    { t: 'act', id: 44, kind: 'done', sessionId: S1 },
    { t: 'act', id: 45, kind: 'undone', sessionId: S1 },
    { t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url },
    { t: 'act', id: 48, kind: 'pr-rm', sessionId: S1, url },
  ];
  for (const action of edits) {
    const result = await h.act(action);
    assert.equal(result.ok, true, `${action.kind}: ${JSON.stringify(result)}`);
  }
  assert.equal(d.deck.store.meta(S1)?.label, SECRET);
  assert.equal(d.deck.store.meta(S1)?.note, SECRET);
  assert.ok(h.told.includes(`fetch ${url}`), 'pr-add still asks for its fetch');
  assert.deepEqual(
    h.logs,
    ['label', 'group', 'note', 'done', 'undone', 'pr-add', 'pr-rm'].map(
      (kind) => `act ${kind}: the lists were not told (RangeError)`,
    ),
  );

  const fetching = harness(d, {
    fetch() {
      throw new TypeError(`cannot fetch ${SECRET}`);
    },
  });
  const added = await fetching.act({ t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url });
  assert.deepEqual(added, ok(47, [`attached ${url}`]));
  assert.deepEqual(fetching.logs, ['act pr-add: the fetch was not asked for (TypeError)']);
});

describe('note (S2 12.5; plan D9, D10)', () => {
  test('with base the stored note, the text is stored exactly as typed: CRLF, trailing spaces, 65,536 bytes', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    const typed = 'first line  \r\n\tsecond line \n\n';
    assert.deepEqual(await h.act(note(typed, '')), ok(33), "base '' while there is none");
    assert.equal(d.deck.store.meta(S1)?.note, typed);
    const longest = `${'é'.repeat(32_767)}ab`; // 65,536 bytes of UTF-8
    assert.equal(Buffer.byteLength(longest, 'utf8'), 65_536);
    assert.deepEqual(await h.act(note(longest, typed)), ok(33));
    assert.equal(d.deck.store.meta(S1)?.note, longest);
    assert.deepEqual(h.told, ['changed', 'changed']);
    assert.deepEqual(h.logs, [], 'a note sent is never logged');
  });

  test('an empty text, or one of only white space, clears the note', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    for (const blank of ['', ' \n\t ']) {
      setNote(d.deck, S1, 'remember');
      assert.deepEqual(await h.act(note(blank, 'remember')), ok(33), JSON.stringify(blank));
      assert.equal(d.deck.store.meta(S1)?.note, null);
    }
  });

  test('a note changed elsewhere since the edit began is refused with S2 12.5 message; the stored note stays', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    setNote(d.deck, S1, 'as the dialog opened');
    setNote(d.deck, S1, 'changed by another window'); // between the dialog's start and its save
    assert.deepEqual(
      await h.act(note('my text', 'as the dialog opened')),
      refused(
        33,
        'the note was changed elsewhere while you edited it; your text is still in the box',
      ),
    );
    assert.equal(d.deck.store.meta(S1)?.note, 'changed by another window');
    assert.deepEqual(h.told, []);
    // A dialog opened on no note (base ''): a note set meanwhile refuses its save too.
    setNote(d.deck, S1, null);
    setNote(d.deck, S1, 'set meanwhile');
    assert.equal((await h.act(note('mine', ''))).ok, false);
    assert.equal(d.deck.store.meta(S1)?.note, 'set meanwhile');
    // The base is the stored string exactly (plan D3): a space or a line break of another kind is
    // another note.
    const differing: [stored: string, base: string][] = [
      ['text ', 'text'],
      ['one\r\ntwo', 'one\ntwo'],
      ['one\ntwo', 'one\r\ntwo'],
    ];
    for (const [stored, base] of differing) {
      setNote(d.deck, S1, stored);
      assert.equal((await h.act(note('mine', base))).ok, false, JSON.stringify(base));
      assert.equal(d.deck.store.meta(S1)?.note, stored);
    }
  });

  test('the same save sent twice (its answer lost): both ok, one write', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    setNote(d.deck, S1, 'before');
    assert.deepEqual(await h.act(note('after', 'before')), ok(33));
    const written = d.deck.store.meta(S1)?.updatedNs;
    d.clock.advanceMs(5000);
    assert.deepEqual(await h.act(note('after', 'before')), ok(33), 'not "changed elsewhere"');
    assert.equal(d.deck.store.meta(S1)?.updatedNs, written, 'nothing written the second time');
    assert.deepEqual(h.told, ['changed']);
  });

  test('a save that cleared the note, sent twice: both ok, one write', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    setNote(d.deck, S1, 'before');
    assert.deepEqual(await h.act(note('  \n', 'before')), ok(33));
    const written = d.deck.store.meta(S1)?.updatedNs;
    d.clock.advanceMs(5000);
    assert.deepEqual(await h.act(note('  \n', 'before')), ok(33), 'not "changed elsewhere"');
    assert.equal(d.deck.store.meta(S1)?.updatedNs, written);
    assert.deepEqual(h.told, ['changed']);
  });

  test('a stored note with CRLF line breaks, saved with that string as base and its LF form as text, is saved (plan D3)', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    setNote(d.deck, S1, 'one\r\ntwo\r\n');
    assert.deepEqual(await h.act(note('one\ntwo\n', 'one\r\ntwo\r\n')), ok(33));
    assert.equal(d.deck.store.meta(S1)?.note, 'one\ntwo\n');
  });

  test('the stored note is read and the new one written inside one store transaction', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    let depth = 0;
    const seen: string[] = [];
    const deck = deckWith(d.deck, {
      store: {
        transaction<T>(fn: () => T): T {
          depth++;
          try {
            return d.deck.store.transaction(fn);
          } finally {
            depth--;
          }
        },
        meta(sessionId: string) {
          seen.push(`meta at ${depth}`);
          return d.deck.store.meta(sessionId);
        },
        updateMeta(...args: Parameters<Store['updateMeta']>) {
          seen.push(`updateMeta at ${depth}`);
          return d.deck.store.updateMeta(...args);
        },
      },
    });
    const h = harness(d, { deck });
    assert.deepEqual(await h.act(note('text', '')), ok(33));
    assert.deepEqual(seen, ['meta at 1', 'updateMeta at 1']);
  });

  test('a save removes the note file a failed editor kept; a refused save leaves it (plan D10)', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    mkdirSync(d.deck.places.stateDir, { recursive: true });
    const kept = keptNotePath(d.deck, S1);
    const other = keptNotePath(d.deck, S2);
    writeFileSync(kept, 'typed in an editor that failed');
    writeFileSync(other, 'another session');
    setNote(d.deck, S1, 'stored');
    assert.equal((await h.act(note('mine', 'not what is stored'))).ok, false);
    assert.equal(existsSync(kept), true, 'kept after a refused save');
    assert.deepEqual(await h.act(note('mine', 'stored')), ok(33));
    assert.equal(existsSync(kept), false, 'removed after the save');
    assert.equal(existsSync(other), true, "another session's stays");
  });
  test('a save whose commit fails leaves the kept note file and the stored note: the file goes only after the commit', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    setNote(d.deck, S1, 'stored');
    mkdirSync(d.deck.places.stateDir, { recursive: true });
    const kept = keptNotePath(d.deck, S1);
    writeFileSync(kept, 'typed in an editor that failed');
    const deck = deckWith(d.deck, {
      store: {
        transaction<T>(fn: () => T): T {
          return d.deck.store.transaction(() => {
            fn();
            // As a commit that fails: everything fn wrote is rolled back.
            throw Object.assign(new Error('database is locked'), {
              code: 'ERR_SQLITE_ERROR',
              errcode: 5,
            });
          });
        },
      },
    });
    const h = harness(d, { deck });
    assert.deepEqual(
      await h.act(note('mine', 'stored')),
      refused(33, "skydeck's database is busy; try again"),
    );
    assert.equal(existsSync(kept), true, 'the text typed in the editor is kept');
    assert.equal(d.deck.store.meta(S1)?.note, 'stored');
    assert.deepEqual(h.told, []);
  });
});

describe('done and undone (S2 12.10)', () => {
  test('done sets the done time to now and undone clears it, through markDone and markUndone; changed() each', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    d.clock.advanceMs(1000);
    assert.deepEqual(await h.act({ t: 'act', id: 44, kind: 'done', sessionId: S1 }), ok(44));
    assert.equal(d.deck.store.meta(S1)?.doneAtNs, T0 + SEC);
    assert.deepEqual(await h.act({ t: 'act', id: 45, kind: 'undone', sessionId: S1 }), ok(45));
    assert.equal(d.deck.store.meta(S1)?.doneAtNs, null);
    assert.deepEqual(h.told, ['changed', 'changed']);
    assert.deepEqual(h.logs, []);
  });
});

describe('pull requests (S2 12.5, design 7.3; plan D8)', () => {
  test("pr-add attaches with origin manual, clears an earlier detach, answers 'attached <url>' and then asks for the fetch, which it does not wait for", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    attachManualPr(d.deck, S1, PR7);
    detachSessionPr(d.deck, S1, PR7);
    const h = harness(d);
    const result = await h.act({
      t: 'act',
      id: 47,
      kind: 'pr-add',
      sessionId: S1,
      url: 'https://GitHub.com/Acme/Web/pull/7/files',
    });
    assert.deepEqual(result, ok(47, [`attached ${PR7}`]));
    const [link] = d.deck.store.sessionPrs();
    assert.equal(link?.url, PR7);
    assert.equal(link?.origin, 'manual');
    assert.equal(link?.detachedAtNs, null, 'the earlier detach is gone');
    assert.deepEqual(h.told, ['changed', `fetch ${PR7}`], 'its key URL, once, after the write');
    assert.deepEqual(h.logs, [], 'an address sent is never logged');
  });

  test("pr-add of a URL that is not a pull request: requirePrKey's message, nothing attached", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    for (const url of [
      'https://github.com/acme/web/issues/7',
      'https://example.com/acme/web/pull/7',
    ]) {
      const result = await h.act({ t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url });
      assert.deepEqual(result, refused(47, `not a GitHub pull-request URL: ${url}`));
    }
    assert.deepEqual(d.deck.store.sessionPrs(), []);
    assert.deepEqual(d.deck.store.prs(), []);
    assert.deepEqual(h.told, []);
  });

  test("pr-rm detaches it through detachSessionPr; of one not attached, detachSessionPr's message", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    const rm: ActMessage = { t: 'act', id: 48, kind: 'pr-rm', sessionId: S1, url: PR7 };
    assert.deepEqual(await h.act(rm), refused(48, `${PR7} is not attached to ${S1.slice(0, 8)}`));
    assert.deepEqual(h.told, []);
    attachManualPr(d.deck, S1, PR7);
    assert.deepEqual(await h.act(rm), ok(48));
    assert.notEqual(d.deck.store.sessionPrs()[0]?.detachedAtNs, null);
    assert.deepEqual(h.told, ['changed']);
    assert.deepEqual(h.logs, []);
  });

  test("pr-refresh asks for the explicit refresh of the session's pull requests and answers ok at once", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    assert.deepEqual(await h.act({ t: 'act', id: 46, kind: 'pr-refresh', sessionId: S1 }), ok(46));
    assert.deepEqual(h.told, [`refresh ${S1}`], 'nothing written: no changed()');
    assert.deepEqual(h.logs, []);
  });
});

describe('the session an edit acts on (plan D9, 2.5)', () => {
  test("a session the store does not know: RefError's message for every kind, nothing written", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    for (const action of everyEdit(S3)) {
      assert.deepEqual(
        await h.act(action),
        refused(action.id, `no session matches '${S3}'`),
        action.kind,
      );
    }
    assert.deepEqual(d.deck.store.allMeta(), []);
    assert.deepEqual(d.deck.store.sessionPrs(), []);
    assert.deepEqual(h.told, []);
    assert.deepEqual(h.logs, []);
  });

  test('the session of a `new` terminal that has not started yet: the not-started message for every kind', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    for (const state of ['starting', 'not-started', 'ended'] as const) {
      const h = harness(d, {
        terminals: [
          info('t-new', state, { kind: 'new', expectedSessionId: NEW_ID, sessionId: null }),
        ],
      });
      for (const action of everyEdit(NEW_ID)) {
        assert.deepEqual(
          await h.act(action),
          refused(action.id, 'this session has not started yet; edit it once it runs'),
          `${state} ${action.kind}`,
        );
      }
      assert.deepEqual(h.told, []);
    }
    assert.deepEqual(d.deck.store.allMeta(), []);
    assert.deepEqual(d.deck.store.sessionPrs(), []);
  });

  test('a session started in a `new` terminal that is still there is edited once the store knows it', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const opened = info('t-new', 'running', { kind: 'new', expectedSessionId: S1, sessionId: S1 });
    const terminals = [
      opened,
      { ...opened, sessionId: null },
      { ...opened, state: 'ended' as const },
    ];
    for (const terminal of terminals) {
      const h = harness(d, { terminals: [terminal] });
      const text = `in ${terminal.state} ${terminal.sessionId ?? 'unmapped'}`;
      assert.deepEqual(await h.act(label(text)), ok(31), text);
      assert.equal(d.deck.store.meta(S1)?.label, text);
    }
  });

  test('a resume terminal opened for an unknown id does not make it a session that has not started', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d, {
      terminals: [info('t-resume', 'starting', { expectedSessionId: S3, sessionId: null })],
    });
    const result = await h.act({ t: 'act', id: 41, kind: 'label', sessionId: S3, text: 'x' });
    assert.deepEqual(result, refused(41, `no session matches '${S3}'`));
  });

  test('a session is looked up as it is: no refresh runs first', async (t) => {
    const d = testDeck(t);
    resumableSession(d); // its transcript is not read yet: the store does not know it
    const h = harness(d);
    assert.deepEqual(await h.act(label('x')), refused(31, `no session matches '${S1}'`));
    assert.deepEqual(d.deck.store.transcripts(), [], 'nothing was read');
  });
});

describe("stage D's actions and what the parser refuses (plan 2.2)", () => {
  test("each kind with a field over its limit, or a session id that is not one, is refused with 'skydeck cannot do that action'; nothing written", async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const h = harness(d);
    const over = (bytes: number): string => 'x'.repeat(bytes);
    const hostile = [
      { t: 'act', id: 9, kind: 'label', sessionId: S1, text: over(1025) },
      { t: 'act', id: 9, kind: 'group', sessionId: S1, text: over(1025) },
      { t: 'act', id: 9, kind: 'note', sessionId: S1, text: over(65_537), base: '' },
      { t: 'act', id: 9, kind: 'note', sessionId: S1, text: 'x', base: over(65_537) },
      { t: 'act', id: 9, kind: 'note', sessionId: S1, text: 'x' },
      { t: 'act', id: 9, kind: 'pr-add', sessionId: S1, url: `${PR7}/${over(4097)}` },
      { t: 'act', id: 9, kind: 'pr-rm', sessionId: S1, url: `${PR7}/${over(4097)}` },
      { t: 'act', id: 9, kind: 'done', sessionId: 'S1' },
      { t: 'act', id: 9, kind: 'undone', sessionId: S1.toUpperCase() },
      { t: 'act', id: 9, kind: 'pr-refresh', sessionId: `${S1} ` },
      { t: 'act', id: 9, kind: 'label', sessionId: S1, text: 'a\ud800b' },
    ] as unknown as ActMessage[];
    for (const action of hostile) {
      assert.deepEqual(await h.act(action), refused(9, 'skydeck cannot do that action'));
    }
    assert.deepEqual(d.deck.store.allMeta(), []);
    assert.deepEqual(d.deck.store.sessionPrs(), []);
    assert.deepEqual(h.told, []);
    assert.equal(h.logs.length, hostile.length);
  });

  test('after every refused and every failed stage D act the log holds nothing of the label, group, note or address sent', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    let failure: 'busy' | 'other' | null = null;
    const deck = deckWith(d.deck, {
      store: {
        updateMeta(...args: Parameters<Store['updateMeta']>) {
          if (failure === 'busy') {
            throw Object.assign(new Error(`database is locked (${SECRET})`), {
              code: 'ERR_SQLITE_ERROR',
              errcode: 5,
            });
          }
          if (failure === 'other') throw new RangeError(`cannot store ${SECRET}`);
          return d.deck.store.updateMeta(...args);
        },
        attachPr() {
          throw new RangeError(`cannot attach ${SECRET}`);
        },
      },
    });
    const h = harness(d, { deck });
    const url = `https://github.com/acme/${SECRET}/pull/7`;
    const sent: ActMessage[] = [
      label(`${SECRET}\nsecond line`),
      label(`-${SECRET}`),
      group(`a\t${SECRET}`),
      note(SECRET, `not ${SECRET}`),
      { t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url: `https://example.com/${SECRET}` },
      { t: 'act', id: 48, kind: 'pr-rm', sessionId: S1, url },
      { t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url }, // attachPr throws
      { t: 'act', id: 9, kind: 'label', sessionId: S1, text: SECRET.repeat(100) },
      { t: 'act', id: 9, kind: 'pr-add', sessionId: S3, url },
    ];
    for (const action of sent) assert.equal((await h.act(action)).ok, false, action.kind);
    for (failure of ['busy', 'other'] as const) {
      for (const action of [label(SECRET), group(SECRET), note(SECRET, '')]) {
        assert.equal((await h.act(action)).ok, false, `${failure} ${action.kind}`);
      }
    }
    assert.ok(h.logs.length >= 8, JSON.stringify(h.logs));
    for (const line of h.logs) assert.ok(!line.includes(SECRET), line);
  });

  test('an edit that meets a busy database answers that it is busy; nothing written, changed() never', async (t) => {
    const d = testDeck(t);
    knownSession(d);
    const deck = deckWith(d.deck, {
      store: {
        transaction: () => {
          throw Object.assign(new Error('database is locked'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 5,
          });
        },
      },
    });
    const h = harness(d, { deck });
    assert.deepEqual(
      await h.act(note('text', '')),
      refused(33, "skydeck's database is busy; try again"),
    );
    assert.deepEqual(
      await h.act({ t: 'act', id: 47, kind: 'pr-add', sessionId: S1, url: PR7 }),
      refused(47, "skydeck's database is busy; try again"),
    );
    assert.equal(d.deck.store.meta(S1), null);
    assert.deepEqual(h.told, []);
  });
});

test('a refusal naming a hostile directory reaches the page sanitised', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  for (const dir of [`${d.sandbox.home}/a\x1b[31m\nb\x07`, `rel\x1b]0;x\x07/dir`]) {
    const result = await h.act(newAction({ dir }));
    assert.equal(result.ok, false);
    for (const text of [...result.lines, result.error ?? '']) {
      assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text), JSON.stringify(text));
    }
  }
});

test('a message that is not an action, or cannot be read, is refused with id 0 and never rejects', async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  const odd = [{ t: 'ping', n: 1 }, { ...resume(S1), id: 1n }, null] as unknown as ActMessage[];
  for (const action of odd) {
    assert.deepEqual(await h.act(action), refused(0, 'skydeck cannot do that action'));
  }
  assert.deepEqual(h.events, []);
  assert.equal(h.logs.length, odd.length);
});

test("the limits are the parser's own: an action at them is acted on", async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  const label = 'é'.repeat(512); // 1,024 UTF-8 bytes
  const result = await h.act(newAction({ dir: d.sandbox.home, label, cols: 65535, rows: 1 }));
  assert.equal(result.ok, true);
  assert.deepEqual(h.sizes, [{ cols: 65535, rows: 1 }]);
  assert.equal(d.deck.store.meta(NEW_ID)?.label, label);
});

test("a refusal's message reaches the page sanitised: a flag quoted as typed carries no escape or line break", async (t) => {
  const d = testDeck(t);
  const h = harness(d);
  for (const flags of [`'-c\x1b[2J\nSECOND LINE'`, `-c\x1b]0;evil\x07`]) {
    const result = await h.act(newAction({ dir: d.sandbox.home, flags }));
    assert.equal(result.ok, false);
    for (const text of [...result.lines, result.error ?? '']) {
      assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text), JSON.stringify(text));
    }
    assert.match(result.lines[0] ?? '', /^cannot pass -c/);
    assert.equal(result.error, result.lines.join(' '));
    // The line break of the message is kept as a line break between lines, as failureText keeps it.
    assert.equal(result.lines.length, flags.includes('\n') ? 2 : 1);
  }
  assert.deepEqual(h.specs, []);
});

test('an action that meets a busy database answers that it is busy, logged by kind (ruled, task 23)', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const deck = deckWith(d.deck, {
    store: {
      transaction: () => {
        throw Object.assign(new Error('database is locked (marker-busy)'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 5,
        });
      },
    },
  });
  const h = harness(d, { deck });
  const result = await h.act(resume(S1));
  assert.deepEqual(result, refused(7, "skydeck's database is busy; try again"));
  assert.deepEqual(h.specs, [], 'nothing opened');
  assert.ok(
    h.logs.some((line) => line.includes('ERR_SQLITE_ERROR')),
    JSON.stringify(h.logs),
  );
  assert.ok(h.logs.every((line) => !line.includes('marker-busy')));
});

// --- stage C: restore (plan C, task 72) --------------------------------------------------------

const stageC: ActMessage[] = [
  { t: 'act', id: 31, kind: 'restore', sessionIds: [S1, S2] },
  { t: 'act', id: 32, kind: 'dismiss-restore', bootId: BOOT_A },
];

test("stage C's restore and dismiss-restore without their deps answer 'skydeck cannot do that action' and nothing is done", async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d);
  const kvBefore = d.deck.store.kvEntries('');
  for (const action of stageC) {
    assert.deepEqual(
      await h.act(action),
      refused(action.id, 'skydeck cannot do that action'),
      action.kind,
    );
  }
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.specs, []);
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.told, [], 'changed() never, no fetch');
  assert.deepEqual(d.deck.store.kvEntries(''), kvBefore);
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
});

describe('restore and dismiss-restore reach their deps (plan C 2.3)', () => {
  /** The harness with `restore` and `dismissRestore` that record their calls and answer `answer`. */
  function withRestore(
    d: TestDeck,
    answer: () => { ok: true } | { ok: false; error: string },
  ): { act: Harness['act']; calls: string[]; logs: string[]; told: string[]; events: Events } {
    const h = harness(d);
    const calls: string[] = [];
    const actions = createActions({
      deck: d.deck,
      hub: h.hub,
      terminalFor: () => {
        throw new Error('no terminal is built for a restore act');
      },
      openLink: async () => true,
      log: (line) => h.logs.push(line),
      changed: () => h.told.push('changed'),
      prs: { fetch: () => undefined, refresh: () => undefined },
      restore(sessionIds) {
        calls.push(`restore ${sessionIds.join(' ')}`);
        return answer();
      },
      dismissRestore(bootId) {
        calls.push(`dismiss ${bootId}`);
        return answer();
      },
    });
    return {
      act: (action) => actions.act(PAGE, action),
      calls,
      logs: h.logs,
      told: h.told,
      events: h.events,
    };
  }

  test('each calls its dep once with its fields; ok answers ok with no lines and no session (C21)', async (t) => {
    const d = testDeck(t);
    const h = withRestore(d, () => ({ ok: true }));
    assert.deepEqual(await h.act(stageC[0] as ActMessage), ok(31));
    assert.deepEqual(await h.act(stageC[1] as ActMessage), ok(32));
    assert.deepEqual(h.calls, [`restore ${S1} ${S2}`, `dismiss ${BOOT_A}`]);
    assert.deepEqual(h.logs, []);
    assert.deepEqual(h.told, [], 'the act itself writes nothing: its dep tells the lists');
    assert.deepEqual(h.events, []);
  });

  test("a refusal answers its error, sanitised, as the result's one line", async (t) => {
    const d = testDeck(t);
    const h = withRestore(d, () => ({
      ok: false,
      error: 'a restore is already running; wait until it has finished\x1b[2J',
    }));
    const line = 'a restore is already running; wait until it has finished';
    assert.deepEqual(await h.act(stageC[0] as ActMessage), refused(31, line));
    assert.deepEqual(await h.act(stageC[1] as ActMessage), refused(32, line));
    assert.deepEqual(h.logs, []);
  });

  test('a dep that throws is answered as any unexpected failure: by kind, logged by kind, never its message', async (t) => {
    const d = testDeck(t);
    const h = withRestore(d, () => {
      throw new TypeError(SECRET);
    });
    assert.deepEqual(
      await h.act(stageC[0] as ActMessage),
      refused(31, 'the action failed unexpectedly (TypeError)'),
    );
    assert.deepEqual(
      await h.act(stageC[1] as ActMessage),
      refused(32, 'the action failed unexpectedly (TypeError)'),
    );
    assert.deepEqual(h.logs, [
      'act restore: failed (TypeError)',
      'act dismiss-restore: failed (TypeError)',
    ]);
    for (const line of h.logs) assert.ok(!line.includes(SECRET), line);
  });

  test('a malformed restore never reaches the dep', async (t) => {
    const d = testDeck(t);
    const h = withRestore(d, () => ({ ok: true }));
    for (const action of [
      { t: 'act', id: 9, kind: 'restore', sessionIds: [] },
      { t: 'act', id: 9, kind: 'restore', sessionIds: ['S1'] },
      { t: 'act', id: 9, kind: 'dismiss-restore', bootId: 'not-a-boot' },
    ] as unknown as ActMessage[]) {
      assert.deepEqual(await h.act(action), refused(9, 'skydeck cannot do that action'));
    }
    assert.deepEqual(h.calls, []);
  });
});

test("resume is refused while a lost terminal's program may still run (task 82): the guard's words, nothing built or taken", async (t) => {
  // The program outlived its keeper's death before its SessionStart: the guard sees no holder, the
  // window sees the program its keeper reported.
  const d = testDeck(t);
  resumableSession(d);
  d.proc.setProcess(6161, { stat: statLine(6161, 7777), cmdline: ['claude'] });
  const terminals = [
    info('aaaaaaaaaaa1', 'lost', {
      program: { pid: 6161, procStart: 7777 },
      exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
    }),
  ];
  const h = harness(d, { terminals });
  assert.deepEqual(
    await h.act(resume(S1, 3)),
    refused(3, `${S1.slice(0, 8)} is running (pid 6161)`),
  );
  assert.deepEqual(h.events, []);
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  assert.deepEqual(h.hub.closed, []);
  assert.deepEqual(h.logs, []);
  d.proc.setProcess(6161, null); // the program has ended
  assert.equal((await h.act(resume(S1, 4))).ok, true);
  assert.deepEqual(h.hub.closed, ['aaaaaaaaaaa1']);
});
