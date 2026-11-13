import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { launchPrepared } from '../../src/cli/launching.ts';
import type { PreparedLaunch } from '../../src/sessions/resume.ts';
import { handoffScript } from '../../src/terminals/here.ts';
import { testDeck } from '../helpers/deck.ts';
import { S1, fakeRunner, runResult } from '../helpers/platform.ts';

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
