import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { launchWhere } from '../../src/cli/launching.ts';
import { launchPrepared, launchSpec, startDeadline } from '../../src/sessions/launch.ts';
import { acquireLock, lockKey, readLock } from '../../src/sessions/resume.ts';
import type { PreparedLaunch } from '../../src/sessions/resume.ts';
import { handoffScript } from '../../src/terminals/here.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../../src/terminals/types.ts';
import { testDeck } from '../helpers/deck.ts';
import { S1, SEC, T0, fakeRunner, runResult } from '../helpers/platform.ts';

/** S1 has no event in these decks: its lock records id 0. */
const NO_EVENTS = { latestEventId: null };

function prepared(dir: string, over: Partial<PreparedLaunch> = {}): PreparedLaunch {
  return {
    sessionId: S1,
    cwd: dir,
    argv: ['claude', '--resume', S1],
    flagsKnown: true,
    unknownFlags: [],
    kind: 'resume',
    preparedAtNs: T0,
    label: null,
    ...over,
  };
}

// --- launchWhere: step 1's launchPrepared, the terminal chosen as the command line does -----------

test('launchWhere returns its lines instead of printing them: warnings first', async (t) => {
  const d = testDeck(t, { env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }) });
  const p = prepared(d.sandbox.home, { flagsKnown: false, unknownFlags: ['--a\x1b[1mb', '--c'] });
  const outcome = await launchWhere(d.deck, p, 'here');
  assert.deepEqual(outcome, {
    code: 0,
    lines: [
      'skydeck: original flags unknown; resuming with defaults',
      'skydeck: started with flags skydeck does not know, not passed on resume: --ab --c',
    ],
  });
  assert.equal(readFileSync(join(d.sandbox.root, 'handoff'), 'utf8'), handoffScript(p));
  assert.equal(d.stderr(), '');
  assert.equal(d.stdout(), '');
});

test('launchWhere with nothing to say returns no lines', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  assert.deepEqual(await launchWhere(d.deck, prepared(d.sandbox.home), null), {
    code: 0,
    lines: [],
  });
  assert.equal(d.runner.calls.length, 1);
});

test('launchWhere without a tab adapter returns the reason and the command', async (t) => {
  const d = testDeck(t);
  const outcome = await launchWhere(d.deck, prepared('/w'), 'tab');
  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.lines.slice(1), [
    'skydeck: to start it yourself, run:',
    `cd -- /w && claude --resume ${S1}`,
  ]);
  assert.match(outcome.lines[0] ?? '', /^skydeck: no terminal adapter that opens tabs/);
  assert.equal(d.stderr(), '');
});

test('launchWhere after a timeout prints no command: a resume says to look again, a new session names its id', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  const reason = 'skydeck: wezterm timed out; a tab may have opened';
  assert.deepEqual(await launchWhere(d.deck, prepared('/w'), null), {
    code: 1,
    lines: [reason, `skydeck: run skydeck again to see whether session ${S1} is running`],
  });
  assert.deepEqual(await launchWhere(d.deck, prepared('/w', { kind: 'new' }), null), {
    code: 1,
    lines: [
      reason,
      `skydeck: the new session's id is ${S1}; running skydeck shows whether it started`,
    ],
  });
});

test('launchWhere keeps the lock when it prints the command: the user may run it now', async (t) => {
  const d = testDeck(t, {
    config: { terminal: 'wezterm' },
    env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'no-such-dir', 'h') }),
  });
  acquireLock(d.deck, S1, NO_EVENTS);
  const cases: { runner: ReturnType<typeof fakeRunner>; where: 'here' | 'tab' | null }[] = [
    { runner: fakeRunner(() => runResult({ code: 1, stderr: 'no window\n' })), where: null }, // refused
    { runner: fakeRunner(() => runResult({ code: null, notFound: true })), where: null }, // not installed
    { runner: fakeRunner(), where: 'here' }, // the handoff cannot be written: a rejected open
  ];
  for (const { runner, where } of cases) {
    d.platform.runner = runner;
    const outcome = await launchWhere(d.deck, prepared('/w'), where);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.lines.at(-1), `cd -- /w && claude --resume ${S1}`);
    assert.equal(d.deck.store.getKv(lockKey(S1)), `${T0}:0`);
  }
});

test('launchWhere keeps the lock when no tab adapter is configured: it prints the command', async (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, NO_EVENTS);
  assert.equal((await launchWhere(d.deck, prepared('/w'), 'tab')).code, 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), `${T0}:0`);
});

test('launchWhere releases the lock after a definite failure when it prints no command', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  acquireLock(d.deck, S1, NO_EVENTS);
  d.platform.runner = fakeRunner(() => runResult({ code: 1, stderr: 'no window\n' }));
  const p = prepared('/w', { argv: ['claude', '--resume', S1, '--model', 'op\x1b[31mus'] });
  const outcome = await launchWhere(d.deck, p, null);
  assert.equal(
    outcome.lines.at(-1),
    'skydeck: the command contains control characters and cannot be printed safely',
  );
  assert.equal(d.deck.store.getKv(lockKey(S1)), null); // nothing started, nothing to run by hand
});

test('launchWhere keeps the lock after a timeout: the program may have started', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  acquireLock(d.deck, S1, NO_EVENTS);
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  assert.equal((await launchWhere(d.deck, prepared('/w'), null)).code, 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), `${T0}:0`);
});

test('launchWhere keeps the lock after a timeout even when the command cannot be printed', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  acquireLock(d.deck, S1, NO_EVENTS);
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  const p = prepared('/w', { argv: ['claude', '--resume', S1, '--model', 'op\x1b[31mus'] });
  assert.equal((await launchWhere(d.deck, p, null)).code, 1);
  assert.notEqual(readLock(d.deck, S1), null); // the tab may have opened: no second resume yet
});

test('launchWhere of a new session removes its label and group when it definitely started nothing and printed nothing', async (t) => {
  const unprintable = ['claude', '--session-id', S1, '--model', 'op\x1b[31mus'];
  const cases = [
    { answer: runResult({ code: 1, stderr: 'no window\n' }), argv: unprintable, kept: false },
    { answer: runResult({ code: 1, stderr: 'no window\n' }), argv: ['claude'], kept: true }, // printed
    { answer: runResult({ code: null, timedOut: true }), argv: unprintable, kept: true }, // may run
  ];
  for (const { answer, argv, kept } of cases) {
    const d = testDeck(t, { config: { terminal: 'wezterm' } });
    d.deck.store.updateMeta(S1, { label: 'fix it', group: 'ABC-1' }, T0);
    d.platform.runner = fakeRunner(() => answer);
    const p = prepared('/w', { kind: 'new', argv });
    assert.equal((await launchWhere(d.deck, p, null)).code, 1);
    assert.equal(
      d.deck.store.meta(S1)?.label ?? null,
      kept ? 'fix it' : null,
      JSON.stringify(argv),
    );
  }
});

test('launchWhere leaves a lock alone that is not the one the resume took', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  d.deck.store.setKv(lockKey(S1), `${T0}`);
  d.platform.runner = fakeRunner(() => {
    d.deck.store.setKv(lockKey(S1), 'someone else'); // taken over while the terminal was asked
    return runResult({ code: 1, stderr: 'no window\n' });
  });
  const p = prepared('/w', { argv: ['claude', '--resume', S1, 'a\tb'] }); // not printable: released
  assert.equal((await launchWhere(d.deck, p, null)).code, 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), 'someone else');
});

// --- startDeadline and launchSpec (A20, S2 7.1, 11.1) --------------------------------------------

test('startDeadline: a resume may start until 55 s after the time in its lock; new until 55 s after prepareNew', () => {
  const resume = prepared('/w', { preparedAtNs: T0 + 2n * SEC });
  assert.equal(startDeadline(resume, `${T0}:12`), T0 + 55n * SEC);
  assert.equal(startDeadline(resume, `${T0}`), T0 + 55n * SEC); // a lock an earlier skydeck wrote
  const fresh = prepared('/w', { kind: 'new', preparedAtNs: T0 + 3n * SEC });
  assert.equal(startDeadline(fresh, null), T0 + 58n * SEC);
  assert.equal(startDeadline(fresh, `${T0}:12`), T0 + 58n * SEC); // new takes no lock
});

test('startDeadline of a resume without a lock it can read counts from prepareResume', () => {
  const resume = prepared('/w', { preparedAtNs: T0 + 2n * SEC });
  assert.equal(startDeadline(resume, null), T0 + 57n * SEC);
  assert.equal(startDeadline(resume, 'someone else'), T0 + 57n * SEC);
});

test('launchSpec carries the command, the session, its kind, the lock, the deadline and the label', () => {
  assert.deepEqual(launchSpec(prepared('/w', { label: 'fix' }), `${T0}:12`), {
    cwd: '/w',
    argv: ['claude', '--resume', S1],
    sessionId: S1,
    kind: 'resume',
    lock: `${T0}:12`,
    startByNs: T0 + 55n * SEC,
    label: 'fix',
  });
  const fresh = prepared('/d', {
    kind: 'new',
    argv: ['claude', '--session-id', S1],
    preparedAtNs: T0 + 3n * SEC,
  });
  assert.deepEqual(launchSpec(fresh, `${T0}:12`), {
    cwd: '/d',
    argv: ['claude', '--session-id', S1],
    sessionId: S1,
    kind: 'new',
    lock: null,
    startByNs: T0 + 58n * SEC,
    label: null,
  });
});

// --- launchPrepared with the terminal as a parameter ---------------------------------------------

/** A terminal that records the specs it is opened with and answers `answer` ('reject': rejects). */
function recording(answer: OpenResult | 'reject' = { ok: true }): {
  terminal: Terminal;
  specs: LaunchSpec[];
} {
  const specs: LaunchSpec[] = [];
  const terminal: Terminal = {
    name: 'window',
    opensTabs: true,
    async open(spec) {
      specs.push(spec);
      if (answer === 'reject') {
        throw new Error('the terminal fell over');
      }
      return answer;
    },
  };
  return { terminal, specs };
}

test('launchPrepared opens the terminal it is given with the launch and the lock the resume took', async (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, NO_EVENTS); // at T0
  const p = prepared(d.sandbox.home, { label: 'fix', preparedAtNs: T0 + 2n * SEC });
  const { terminal, specs } = recording();
  assert.deepEqual(await launchPrepared(d.deck, p, terminal), { code: 0, lines: [] });
  assert.deepEqual(specs, [
    {
      cwd: d.sandbox.home,
      argv: ['claude', '--resume', S1],
      sessionId: S1,
      kind: 'resume',
      lock: `${T0}:0`,
      startByNs: T0 + 55n * SEC, // from the lock, not from prepareResume
      label: 'fix',
    },
  ]);
  assert.equal(readLock(d.deck, S1), `${T0}:0`);
});

test('launchPrepared of a new session gives no lock and a deadline counted from prepareNew', async (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, NO_EVENTS); // a lock of the id is no lock of this launch
  const p = prepared('/d', { kind: 'new', label: 'x', preparedAtNs: T0 + 3n * SEC });
  const { terminal, specs } = recording();
  await launchPrepared(d.deck, p, terminal);
  assert.equal(specs[0]?.lock, null);
  assert.equal(specs[0]?.startByNs, T0 + 58n * SEC);
  assert.equal(specs[0]?.label, 'x');
});

test("launchPrepared with a terminal gives step 1's outcome for every answer, and its lock handling", async (t) => {
  const printable = ['claude', '--resume', S1];
  const unprintable = ['claude', '--resume', S1, '--model', 'op\x1b[31mus'];
  const command = `cd -- /w && claude --resume ${S1}`;
  const cases: {
    name: string;
    answer: OpenResult | 'reject';
    argv: string[];
    code: number;
    tail: string[];
    lockKept: boolean;
  }[] = [
    { name: 'ok', answer: { ok: true }, argv: printable, code: 0, tail: [], lockKept: true },
    {
      name: 'refused',
      answer: { ok: false, error: 'no window', timedOut: false },
      argv: printable,
      code: 1,
      tail: ['skydeck: no window', 'skydeck: to start it yourself, run:', command],
      lockKept: true,
    },
    {
      name: 'timed out',
      answer: { ok: false, error: 'no window', timedOut: true },
      argv: unprintable,
      code: 1,
      tail: [
        'skydeck: no window',
        `skydeck: run skydeck again to see whether session ${S1} is running`,
      ],
      lockKept: true,
    },
    {
      name: 'control characters',
      answer: { ok: false, error: 'no\x1b[1m window', timedOut: false },
      argv: unprintable,
      code: 1,
      tail: [
        'skydeck: no window',
        'skydeck: the command contains control characters and cannot be printed safely',
      ],
      lockKept: false,
    },
    {
      name: 'rejected',
      answer: 'reject',
      argv: printable,
      code: 1,
      tail: [
        'skydeck: cannot open the terminal (Error: the terminal fell over)',
        'skydeck: to start it yourself, run:',
        command,
      ],
      lockKept: true,
    },
  ];
  for (const { name, answer, argv, code, tail, lockKept } of cases) {
    const d = testDeck(t);
    acquireLock(d.deck, S1, NO_EVENTS);
    const p = prepared('/w', { argv, flagsKnown: false });
    const outcome = await launchPrepared(d.deck, p, recording(answer).terminal);
    assert.deepEqual(
      outcome,
      { code, lines: ['skydeck: original flags unknown; resuming with defaults', ...tail] },
      name,
    );
    assert.equal(readLock(d.deck, S1), lockKept ? `${T0}:0` : null, name);
  }
});

test('launchPrepared without a terminal says the reason it is given, then the command; the lock stays', async (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, NO_EVENTS);
  assert.deepEqual(await launchPrepared(d.deck, prepared('/w'), null, 'the window\x07 is gone'), {
    code: 1,
    lines: [
      'skydeck: the window is gone',
      'skydeck: to start it yourself, run:',
      `cd -- /w && claude --resume ${S1}`,
    ],
  });
  assert.equal(readLock(d.deck, S1), `${T0}:0`);
});

test('launchPrepared without a terminal and without a reason says that no adapter opens tabs', async (t) => {
  const d = testDeck(t);
  const outcome = await launchPrepared(d.deck, prepared('/w'), null);
  assert.equal(outcome.code, 1);
  assert.equal(
    outcome.lines[0],
    `skydeck: no terminal adapter that opens tabs is configured (set "terminal" in ${d.deck.places.configPath})`,
  );
});
