import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lockKey } from '../../src/sessions/resume.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import type { DerivedSession, LastHolding, Mark } from '../../src/sessions/types.ts';
import { selectedPayload } from '../../src/window/selected.ts';
import { testDeck } from '../helpers/deck.ts';
import { ds } from '../helpers/derived.ts';
import { BOOT_A, S1, T0 } from '../helpers/platform.ts';
import { listRow } from '../helpers/rows.ts';

const DIR = '/home/dev/projects/demo';

/** S1's row, not running, in DIR, with the session's fields given (its marks become the row's too). */
function row(
  over: Partial<Omit<DerivedSession, 'transcript'>> = {},
  rowOver: Partial<ListRow> = {},
): ListRow {
  const marks: Mark[] = over.marks ?? [];
  return listRow({ id: S1, marks, ...rowOver, session: ds({ id: S1, dir: DIR, ...over }) });
}

/** A holding by a process that is gone, ended as `endDetail` says. */
function endedHolding(endDetail: LastHolding['endDetail']): LastHolding {
  return {
    process: { bootId: BOOT_A, pid: 4242, procStart: 51234567 },
    alive: false,
    endedAtNs: endDetail === null ? null : T0,
    endDetail,
  };
}

test('selectedPayload: the command a resume would run, with the recorded flags and the label', (t) => {
  const d = testDeck(t);
  const payload = selectedPayload(
    d.deck,
    row({ launch: ['claude', '--model', 'opus', 'a prompt'] }, { label: 'fix it' }),
  );
  assert.deepEqual(payload, {
    sessionId: S1,
    command: `cd -- ${DIR} && claude --resume ${S1} -n 'fix it' --model opus`,
    flagsKnown: true,
    unknownFlags: [],
    ended: null,
    expiring: false,
    expired: false,
  });
});

test('selectedPayload builds the command with claudeCommand, and without a recorded launch says the flags are unknown', (t) => {
  const d = testDeck(t, { config: { claudeCommand: '/opt/bin/claude' } });
  const payload = selectedPayload(d.deck, row({ launch: null }));
  assert.equal(payload.command, `cd -- ${DIR} && /opt/bin/claude --resume ${S1}`);
  assert.equal(payload.flagsKnown, false);
  assert.deepEqual(payload.unknownFlags, []);
});

test('selectedPayload takes no lock', (t) => {
  const d = testDeck(t);
  selectedPayload(d.deck, row({ launch: ['claude'] }));
  assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('selectedPayload: no command for a directory with a control character, or none known', (t) => {
  const d = testDeck(t);
  assert.equal(selectedPayload(d.deck, row({ dir: '/home/dev/a\x1b[31mb' })).command, null);
  assert.equal(selectedPayload(d.deck, row({ dir: '/home/dev/a\nb' })).command, null);
  assert.equal(selectedPayload(d.deck, row({ dir: null })).command, null);
});

test('selectedPayload: no command when a recorded flag holds a control character', (t) => {
  const d = testDeck(t);
  const payload = selectedPayload(
    d.deck,
    row({ launch: ['claude', '--model', 'op\x1b]0;x\x07us'] }),
  );
  assert.equal(payload.command, null);
  assert.equal(payload.flagsKnown, true);
});

test('selectedPayload gives no command, and does not throw, for a row whose id is not a session id', (t) => {
  const d = testDeck(t);
  const odd = listRow({
    id: 'not-a-session',
    session: ds({ id: 'not-a-session', launch: ['claude'] }),
  });
  const payload = selectedPayload(d.deck, odd);
  assert.equal(payload.command, null);
  assert.equal(payload.sessionId, 'not-a-session');
});

test('selectedPayload lists the flags a resume does not pass on, sanitised', (t) => {
  const d = testDeck(t);
  const payload = selectedPayload(
    d.deck,
    row({ launch: ['claude', '--frobnicate', '--model', 'opus', '--a\x1b[1mb=1', '--frobnicate'] }),
  );
  assert.deepEqual(payload.unknownFlags, ['--frobnicate', '--ab']);
  assert.equal(payload.command, `cd -- ${DIR} && claude --resume ${S1} --model opus`);
});

test('selectedPayload: how the session ended', async (t) => {
  const cases: {
    name: string;
    marks: Mark[];
    lastHolding: LastHolding | null;
    ended: 'exited' | 'unexpectedly' | 'mid-turn' | null;
  }[] = [
    {
      name: 'mid-turn: ended unexpectedly while working',
      marks: ['ended-unexpectedly', 'was-working'],
      lastHolding: endedHolding(null),
      ended: 'mid-turn',
    },
    {
      name: 'unexpectedly',
      marks: ['ended-unexpectedly'],
      lastHolding: endedHolding('other'),
      ended: 'unexpectedly',
    },
    {
      name: 'exited: an end of kind exit',
      marks: [],
      lastHolding: endedHolding('exit'),
      ended: 'exited',
    },
    { name: 'left through /clear', marks: [], lastHolding: endedHolding('clear'), ended: null },
    { name: 'moved on', marks: [], lastHolding: endedHolding('moved-on'), ended: null },
    { name: 'no holding known', marks: [], lastHolding: null, ended: null },
  ];
  for (const { name, marks, lastHolding, ended } of cases) {
    await t.test(name, (t) => {
      const d = testDeck(t);
      assert.equal(selectedPayload(d.deck, row({ marks, lastHolding })).ended, ended);
    });
  }
});

test('selectedPayload: expiring and expired from the marks', (t) => {
  const d = testDeck(t);
  const expiring = selectedPayload(d.deck, row({ marks: ['expiring'] }));
  assert.deepEqual([expiring.expiring, expiring.expired], [true, false]);
  const expired = selectedPayload(d.deck, row({ marks: ['expired'] }));
  assert.deepEqual([expired.expiring, expired.expired], [false, true]);
  const neither = selectedPayload(d.deck, row({ marks: ['continued'] }));
  assert.deepEqual([neither.expiring, neither.expired], [false, false]);
});
