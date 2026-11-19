import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lockKey } from '../../src/sessions/resume.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import type { DerivedSession, LastHolding, Mark } from '../../src/sessions/types.ts';
import { parsePageMessage } from '../../src/window/protocol.ts';
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
    launchFlags: ['--model', 'opus'],
    ended: null,
    expiring: false,
    expired: false,
    note: null,
    noteTooLong: false,
    ticketUrl: null,
    ticket: null,
    ticketKeys: false,
    ticketStatus: null,
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

// --- the flags it was started with (follow-up F16) -----------------------------------------------

test('selectedPayload: launchFlags are the recorded flags a resume passes on again, in the order recorded, each token sanitised', (t) => {
  const d = testDeck(t);
  const payload = selectedPayload(
    d.deck,
    row({
      launch: [
        'claude',
        '--permission-mode',
        'plan',
        '--frob',
        '--append-system-prompt',
        'be  brief\tnow',
        '--model',
        'op\x1b[31mus',
      ],
    }),
  );
  // A value with spaces is one token, as recorded; a tab and an escape sequence are sanitised.
  assert.deepEqual(payload.launchFlags, [
    '--permission-mode',
    'plan',
    '--append-system-prompt',
    'be  brief now',
    '--model',
    'opus',
  ]);
  assert.deepEqual(payload.unknownFlags, ['--frob']);
});

test('selectedPayload: no launchFlags without a recorded launch, with only unknown flags, or with none', (t) => {
  const d = testDeck(t);
  assert.deepEqual(selectedPayload(d.deck, row({ launch: null })).launchFlags, []);
  assert.deepEqual(selectedPayload(d.deck, row({ launch: ['claude', '--frob'] })).launchFlags, []);
  assert.deepEqual(selectedPayload(d.deck, row({ launch: ['claude'] })).launchFlags, []);
});

test('selectedPayload: launchFlags also for a row whose id is not a session id (no command), and while the directory is not known', (t) => {
  const d = testDeck(t);
  const odd = listRow({
    id: 'not-a-session',
    session: ds({ id: 'not-a-session', launch: ['claude', '--model', 'opus'] }),
  });
  assert.deepEqual(selectedPayload(d.deck, odd).launchFlags, ['--model', 'opus']);
  assert.deepEqual(
    selectedPayload(d.deck, row({ dir: null, launch: ['claude', '--verbose'] })).launchFlags,
    ['--verbose'],
  );
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

// --- the note and the ticket address (plan D5, D6) -----------------------------------------------

/** S1's row with the note `note` as stored. */
function noted(note: string | null): ListRow {
  return row({}, { note, hasNote: note !== null });
}

test('selectedPayload: the note exactly as stored, not sanitised (an escape character and CRLF kept)', (t) => {
  const d = testDeck(t);
  const note = 'first \x1b[31mred\x1b[0m line\r\nsecond\rthird\n\n  spaces  \t\n';
  const payload = selectedPayload(d.deck, noted(note));
  assert.equal(payload.note, note);
  assert.equal(payload.noteTooLong, false);
});

test('selectedPayload: no note gives null, and it is not too long', (t) => {
  const d = testDeck(t);
  const payload = selectedPayload(d.deck, noted(null));
  assert.equal(payload.note, null);
  assert.equal(payload.noteTooLong, false);
});

test('selectedPayload: a note of 65,536 bytes of UTF-8 is sent; one of 65,537 is null with noteTooLong', (t) => {
  const d = testDeck(t);
  const exact = `${'a'.repeat(65536 - 3)}€`; // € is three bytes: exactly 65,536
  assert.equal(Buffer.byteLength(exact, 'utf8'), 65536);
  assert.deepEqual(
    [selectedPayload(d.deck, noted(exact)).note, selectedPayload(d.deck, noted(exact)).noteTooLong],
    [exact, false],
  );
  // The multi-byte character lies across the limit: 65,534 + 3 bytes, fewer than 65,536 characters.
  const over = `${'a'.repeat(65536 - 2)}€`;
  assert.equal(Buffer.byteLength(over, 'utf8'), 65537);
  assert.ok(over.length < 65536);
  const payload = selectedPayload(d.deck, noted(over));
  assert.equal(payload.note, null);
  assert.equal(payload.noteTooLong, true);
  // Counted in bytes, not characters: 32,768 two-byte characters are the limit, one more is over.
  assert.equal(selectedPayload(d.deck, noted('é'.repeat(32768))).noteTooLong, false);
  assert.equal(selectedPayload(d.deck, noted('é'.repeat(32769))).noteTooLong, true);
  assert.equal(selectedPayload(d.deck, noted('🙂'.repeat(16385))).note, null);
});

test("selectedPayload's limit is act note's: the largest note it sends goes back as base, the first it withholds would not", (t) => {
  const d = testDeck(t);
  const asBase = (base: string): boolean =>
    parsePageMessage(
      JSON.stringify({ t: 'act', id: 1, kind: 'note', sessionId: S1, text: '', base }),
    ).ok;
  for (const [largest, first] of [
    ['a'.repeat(65536), 'a'.repeat(65537)],
    [`${'a'.repeat(65533)}€`, `${'a'.repeat(65534)}€`],
  ] as const) {
    assert.equal(selectedPayload(d.deck, noted(largest)).note, largest);
    assert.equal(asBase(largest), true);
    assert.equal(selectedPayload(d.deck, noted(first)).note, null);
    assert.equal(asBase(first), false);
  }
});

test('selectedPayload: an empty stored note is a note (the empty text, not null)', (t) => {
  const d = testDeck(t);
  assert.equal(selectedPayload(d.deck, noted('')).note, '');
});

test("selectedPayload: ticketUrl is ticketAddress of the row's group with the configuration's groupPattern and ticketUrl", (t) => {
  const d = testDeck(t, {
    config: { ticketUrl: 'https://example.atlassian.net/browse/{key}' },
  });
  const cases: [Partial<ListRow>, string | null][] = [
    [{ group: 'ORB-2107', groupSource: 'meta' }, 'https://example.atlassian.net/browse/ORB-2107'],
    [{ group: 'ABC-12', groupSource: 'title' }, 'https://example.atlassian.net/browse/ABC-12'],
    [
      { group: 'ABC-12 cleanup', groupSource: 'meta' },
      'https://example.atlassian.net/browse/ABC-12',
    ],
    [{ group: 'no key here', groupSource: 'meta' }, null],
    [{ group: null, groupSource: null }, null],
  ];
  for (const [over, address] of cases) {
    assert.equal(selectedPayload(d.deck, row({}, over)).ticketUrl, address, JSON.stringify(over));
  }
});

test('selectedPayload: ticketUrl is null without ticketUrl in the configuration', (t) => {
  const d = testDeck(t);
  assert.equal(
    selectedPayload(d.deck, row({}, { group: 'ORB-2107', groupSource: 'meta' })).ticketUrl,
    null,
  );
});

test("selectedPayload: ticketUrl uses the configuration's own groupPattern", (t) => {
  const d = testDeck(t, {
    config: { ticketUrl: 'https://tickets.example.net/t/{key}', groupPattern: '#[0-9]+|[0-9]+$' },
  });
  // The key is the text the pattern matches, and only when it is a key: `#7` is not one.
  assert.equal(
    selectedPayload(d.deck, row({}, { group: 'ticket 4711', groupSource: 'meta' })).ticketUrl,
    'https://tickets.example.net/t/4711',
  );
  assert.equal(
    selectedPayload(d.deck, row({}, { group: 'see #7', groupSource: 'meta' })).ticketUrl,
    null,
  );
});

test("selectedPayload: ticket (F18) is the row's ticket, its address and its name; null without one", (t) => {
  const d = testDeck(t);
  const ticket = { url: 'https://github.com/owner/repo/issues/5', text: 'repo #5' };
  assert.deepEqual(selectedPayload(d.deck, row({}, { ticket })).ticket, ticket);
  assert.equal(selectedPayload(d.deck, row()).ticket, null);
});

test("selectedPayload: a ticket stands beside the group's link; neither changes the other", (t) => {
  const d = testDeck(t, { config: { ticketUrl: 'https://example.com/browse/{key}' } });
  const ticket = { url: 'https://example.com/issues/77', text: '77' };
  const payload = selectedPayload(d.deck, row({}, { group: 'ABC-1', groupSource: 'meta', ticket }));
  assert.equal(payload.ticketUrl, 'https://example.com/browse/ABC-1');
  assert.deepEqual(payload.ticket, ticket);
});

test('selectedPayload: ticketKeys (F18) says whether ticketUrl is configured, so that a bare key sets a ticket', (t) => {
  assert.equal(selectedPayload(testDeck(t).deck, row()).ticketKeys, false);
  const d = testDeck(t, { config: { ticketUrl: 'https://example.com/browse/{key}' } });
  assert.equal(selectedPayload(d.deck, row()).ticketKeys, true);
});
