import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { launchPrepared } from '../../src/cli/launching.ts';
import { acquireLock, lockKey, readLock } from '../../src/sessions/resume.ts';
import type { PreparedLaunch } from '../../src/sessions/resume.ts';
import { handoffScript } from '../../src/terminals/here.ts';
import { testDeck } from '../helpers/deck.ts';
import { S1, T0, fakeRunner, runResult } from '../helpers/platform.ts';

/** S1 has no event in these decks. */
const NO_EVENTS = { latestEventId: null };

function prepared(dir: string, over: Partial<PreparedLaunch> = {}): PreparedLaunch {
  return {
    sessionId: S1,
    cwd: dir,
    argv: ['claude', '--resume', S1],
    flagsKnown: true,
    unknownFlags: [],
    kind: 'resume',
    ...over,
  };
}

test('launchPrepared returns its lines instead of printing them: warnings first', async (t) => {
  const d = testDeck(t, { env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }) });
  const p = prepared(d.sandbox.home, { flagsKnown: false, unknownFlags: ['--a\x1b[1mb', '--c'] });
  const outcome = await launchPrepared(d.deck, p, 'here');
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

test('launchPrepared with nothing to say returns no lines', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  assert.deepEqual(await launchPrepared(d.deck, prepared(d.sandbox.home), null), {
    code: 0,
    lines: [],
  });
  assert.equal(d.runner.calls.length, 1);
});

test('launchPrepared without a tab adapter returns the reason and the command', async (t) => {
  const d = testDeck(t);
  const outcome = await launchPrepared(d.deck, prepared('/w'), 'tab');
  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.lines.slice(1), [
    'skydeck: to start it yourself, run:',
    `cd -- /w && claude --resume ${S1}`,
  ]);
  assert.match(outcome.lines[0] ?? '', /^skydeck: no terminal adapter that opens tabs/);
  assert.equal(d.stderr(), '');
});

test('launchPrepared after a timeout prints no command: a resume says to look again, a new session names its id', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  const reason = 'skydeck: wezterm timed out; a tab may have opened';
  assert.deepEqual(await launchPrepared(d.deck, prepared('/w'), null), {
    code: 1,
    lines: [reason, `skydeck: run skydeck again to see whether session ${S1} is running`],
  });
  assert.deepEqual(await launchPrepared(d.deck, prepared('/w', { kind: 'new' }), null), {
    code: 1,
    lines: [
      reason,
      `skydeck: the new session's id is ${S1}; running skydeck shows whether it started`,
    ],
  });
});

test('launchPrepared keeps the lock when it prints the command: the user may run it now', async (t) => {
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
    const outcome = await launchPrepared(d.deck, prepared('/w'), where);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.lines.at(-1), `cd -- /w && claude --resume ${S1}`);
    assert.equal(d.deck.store.getKv(lockKey(S1)), `${T0}`);
  }
});

test('launchPrepared keeps the lock when no tab adapter is configured: it prints the command', async (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, NO_EVENTS);
  assert.equal((await launchPrepared(d.deck, prepared('/w'), 'tab')).code, 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), `${T0}`);
});

test('launchPrepared releases the lock after a definite failure when it prints no command', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  acquireLock(d.deck, S1, NO_EVENTS);
  d.platform.runner = fakeRunner(() => runResult({ code: 1, stderr: 'no window\n' }));
  const p = prepared('/w', { argv: ['claude', '--resume', S1, '--model', 'op\x1b[31mus'] });
  const outcome = await launchPrepared(d.deck, p, null);
  assert.equal(
    outcome.lines.at(-1),
    'skydeck: the command contains control characters and cannot be printed safely',
  );
  assert.equal(d.deck.store.getKv(lockKey(S1)), null); // nothing started, nothing to run by hand
});

test('launchPrepared keeps the lock after a timeout: the program may have started', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  acquireLock(d.deck, S1, NO_EVENTS);
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  assert.equal((await launchPrepared(d.deck, prepared('/w'), null)).code, 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), `${T0}`);
});

test('launchPrepared keeps the lock after a timeout even when the command cannot be printed', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  acquireLock(d.deck, S1, NO_EVENTS);
  d.platform.runner = fakeRunner(() => runResult({ code: null, timedOut: true }));
  const p = prepared('/w', { argv: ['claude', '--resume', S1, '--model', 'op\x1b[31mus'] });
  assert.equal((await launchPrepared(d.deck, p, null)).code, 1);
  assert.notEqual(readLock(d.deck, S1), null); // the tab may have opened: no second resume yet
});

test('launchPrepared of a new session removes its label and group when it definitely started nothing and printed nothing', async (t) => {
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
    assert.equal((await launchPrepared(d.deck, p, null)).code, 1);
    assert.equal(
      d.deck.store.meta(S1)?.label ?? null,
      kept ? 'fix it' : null,
      JSON.stringify(argv),
    );
  }
});

test('launchPrepared leaves a lock alone that is not the one the resume took', async (t) => {
  const d = testDeck(t, { config: { terminal: 'wezterm' } });
  d.deck.store.setKv(lockKey(S1), `${T0}`);
  d.platform.runner = fakeRunner(() => {
    d.deck.store.setKv(lockKey(S1), 'someone else'); // taken over while the terminal was asked
    return runResult({ code: 1, stderr: 'no window\n' });
  });
  const p = prepared('/w', { argv: ['claude', '--resume', S1, 'a\tb'] }); // not printable: released
  assert.equal((await launchPrepared(d.deck, p, null)).code, 1);
  assert.equal(d.deck.store.getKv(lockKey(S1)), 'someone else');
});
