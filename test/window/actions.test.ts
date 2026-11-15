import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildNewCommand } from '../../src/claude/launch.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { lockKey } from '../../src/sessions/resume.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../../src/terminals/types.ts';
import { printableCommand } from '../../src/text/shell.ts';
import { createActions } from '../../src/window/actions.ts';
import type { ActionDeps } from '../../src/window/actions.ts';
import type { PageInfo, TerminalHub, TerminalInfo, TerminalState } from '../../src/window/hub.ts';
import type { ActMessage, ResultMessage } from '../../src/window/protocol.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';
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
  } = {},
): Harness {
  const events: Events = [];
  const { terminal, specs } = fakeTerminal(events, options.answer);
  const sizes: { cols: number; rows: number }[] = [];
  const links: string[] = [];
  const logs: string[] = [];
  const hub = fakeHub(events, options.terminals);
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
  });
  return { d, events, specs, sizes, links, logs, hub, act: (action) => actions.act(PAGE, action) };
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

test('open-link that Edge cannot open answers so', async (t) => {
  const d = testDeck(t);
  const h = harness(d, { openLink: async () => false });
  const result = await h.act({ t: 'act', id: 4, kind: 'open-link', url: 'https://example.com/' });
  assert.deepEqual(result, refused(4, 'the link could not be opened: Edge could not be started'));
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

test('an action that is not one of stages A and D, or not well formed, is refused without acting', async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d);
  const hostile = [
    { t: 'act', id: 9, kind: 'restore', sessionIds: [S1] },
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

test("stage D's actions are known but not acted on yet: each answers so and nothing is written (task 36 acts on them)", async (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const h = harness(d);
  const url = 'https://github.com/acme/web/pull/7';
  const stageD: ActMessage[] = [
    { t: 'act', id: 21, kind: 'label', sessionId: S1, text: 'a label' },
    { t: 'act', id: 22, kind: 'group', sessionId: S1, text: 'ORB-2107' },
    { t: 'act', id: 23, kind: 'note', sessionId: S1, text: 'a note', base: '' },
    { t: 'act', id: 24, kind: 'done', sessionId: S1 },
    { t: 'act', id: 25, kind: 'undone', sessionId: S1 },
    { t: 'act', id: 26, kind: 'pr-refresh', sessionId: S1 },
    { t: 'act', id: 27, kind: 'pr-add', sessionId: S1, url },
    { t: 'act', id: 28, kind: 'pr-rm', sessionId: S1, url },
  ];
  for (const action of stageD) {
    assert.deepEqual(
      await h.act(action),
      refused(action.id, 'skydeck cannot do that action yet'),
      action.kind,
    );
  }
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.links, []);
  assert.deepEqual(h.logs, []);
  assert.deepEqual(d.deck.store.allMeta(), []);
  assert.deepEqual(d.deck.store.prs(), []);
  assert.deepEqual(d.deck.store.sessionPrs(), []);
  // One that is not well formed is still the parser's refusal.
  assert.deepEqual(
    await h.act({ t: 'act', id: 29, kind: 'label', sessionId: S1, text: 'x'.repeat(1025) }),
    refused(29, 'skydeck cannot do that action'),
  );
  assert.deepEqual(
    await h.act({
      t: 'act',
      id: 30,
      kind: 'note',
      sessionId: S1,
      text: 'x',
    } as unknown as ActMessage),
    refused(30, 'skydeck cannot do that action'),
  );
  assert.equal(h.logs.length, 2);
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
