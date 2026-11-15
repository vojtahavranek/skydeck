import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HiddenBy, RowPayload, SwitcherPayload } from '../../../../src/window/protocol.ts';
import { foundIn, searchWords, searchable } from '../../../../src/window/view/search/filter.ts';
import {
  MAX_ITEMS,
  restoreOffer,
  switcherPayload,
} from '../../../../src/window/view/search/switcher.ts';
import type { SwitchCandidate } from '../../../../src/window/view/search/switcher.ts';
import { rowPayload } from '../../../../src/window/view/sections.ts';
import { ds, meta, rowOf } from '../../../helpers/derived.ts';
import { S1, S2, S3 } from '../../../helpers/platform.ts';

/** What a candidate is given in a test: a row that matches nothing in particular unless named. */
interface Spec {
  id: string;
  title?: string;
  group?: string;
  done?: boolean;
  open?: boolean;
  need?: boolean;
  hiddenBy?: HiddenBy[];
}

/**
 * A candidate as build.ts makes one (task 96): the payload of a row step 1's builders load, and
 * that row's `Searchable`. Ids in the tests are at most 3 characters long, so that no word of 4 or
 * more can match one through the id's prefix (E2) unless a case means it to.
 */
function candidate(spec: Spec): SwitchCandidate {
  const row = rowOf(
    ds({
      id: spec.id,
      dir: '/home/dev/plain',
      hidden: spec.done ?? false,
      transcript: { customTitle: spec.title ?? 'neutral' },
    }),
    { metas: spec.group === undefined ? [] : [meta(spec.id, { group: spec.group })] },
  );
  return {
    row: rowPayload(row, { terminal: null, elsewhere: null }),
    searchable: searchable(row),
    open: spec.open ?? false,
    need: spec.need ?? false,
    hiddenBy: spec.hiddenBy ?? [],
  };
}

/** The items as `id:rank`, in order. */
function ranked(payload: SwitcherPayload): string[] {
  return payload.items.map((item) => `${item.row.id}:${item.rank}`);
}

/** Freezes the candidates, their rows and their arrays, so that a write throws. */
function frozen(candidates: SwitchCandidate[]): readonly SwitchCandidate[] {
  for (const c of candidates) {
    Object.freeze(c.hiddenBy);
    Object.freeze(c.row.marks);
    Object.freeze(c.row.prs);
    Object.freeze(c.row);
    Object.freeze(c);
  }
  return Object.freeze(candidates);
}

// --- the constant --------------------------------------------------------------------------------

test('MAX_ITEMS is 50 (E9)', () => {
  assert.equal(MAX_ITEMS, 50);
});

// --- the ranking ---------------------------------------------------------------------------------

test('switcherPayload: no text lists every candidate, ranked need, open, not running, done', () => {
  // The candidates' order, as build.ts gives it: Open's rows first, then the others most recent
  // first; the ranks are interleaved in it on purpose.
  const candidates = [
    candidate({ id: 'o1', open: true }),
    candidate({ id: 'n1', open: true, need: true }),
    candidate({ id: 'o2', open: true }),
    candidate({ id: 'd1', done: true }),
    candidate({ id: 'r1' }),
    candidate({ id: 'n2', need: true }),
    candidate({ id: 'r2' }),
    candidate({ id: 'd2', done: true }),
  ];
  const payload = switcherPayload('', candidates, ['n1', 'n2']);
  assert.deepEqual(ranked(payload), [
    'n1:need',
    'n2:need',
    'o1:open',
    'o2:open',
    'r1:not-running',
    'r2:not-running',
    'd1:done',
    'd2:done',
  ]);
  assert.equal(payload.more, 0);
});

test('switcherPayload: white space only is no text: every candidate', () => {
  const candidates = [candidate({ id: 'r1' }), candidate({ id: 'd1', done: true })];
  assert.deepEqual(ranked(switcherPayload(' \t\n ', candidates, [])), [
    'r1:not-running',
    'd1:done',
  ]);
});

test("switcherPayload: those that need you come in needOrder's order, not the candidates'", () => {
  const candidates = [
    candidate({ id: 'n1', need: true }),
    candidate({ id: 'n2', need: true }),
    candidate({ id: 'n3', need: true }),
  ];
  assert.deepEqual(ranked(switcherPayload('', candidates, ['n3', 'n1', 'n2'])), [
    'n3:need',
    'n1:need',
    'n2:need',
  ]);
});

test("switcherPayload: one that needOrder lacks comes after the others that need you, in the candidates' order", () => {
  const candidates = [
    candidate({ id: 'x2', need: true }),
    candidate({ id: 'o1', open: true }),
    candidate({ id: 'n1', need: true }),
    candidate({ id: 'x1', need: true }),
    candidate({ id: 'n2', need: true }),
  ];
  assert.deepEqual(ranked(switcherPayload('', candidates, ['n2', 'n1'])), [
    'n2:need',
    'n1:need',
    'x2:need',
    'x1:need',
    'o1:open',
  ]);
});

test('switcherPayload: needOrder orders only; an id in it that does not need you, or is no candidate, changes nothing', () => {
  const candidates = [
    candidate({ id: 'o1', open: true }),
    candidate({ id: 'r1' }),
    candidate({ id: 'n1', need: true }),
  ];
  // `o1` and `r1` are named but do not need you: they keep their own ranks. `zz` is no candidate.
  // `n1` is named twice (where it counts then is the next case's).
  assert.deepEqual(ranked(switcherPayload('', candidates, ['zz', 'r1', 'n1', 'o1', 'n1'])), [
    'n1:need',
    'o1:open',
    'r1:not-running',
  ]);
});

test('switcherPayload: an id that needOrder names twice counts at its first place', () => {
  const candidates = [candidate({ id: 'n2', need: true }), candidate({ id: 'n1', need: true })];
  assert.deepEqual(ranked(switcherPayload('', candidates, ['n1', 'n2', 'n1'])), [
    'n1:need',
    'n2:need',
  ]);
});

test("switcherPayload: without needOrder those that need you keep the candidates' order", () => {
  const candidates = [
    candidate({ id: 'n2', need: true }),
    candidate({ id: 'r1' }),
    candidate({ id: 'n1', need: true }),
  ];
  assert.deepEqual(ranked(switcherPayload('', candidates, [])), [
    'n2:need',
    'n1:need',
    'r1:not-running',
  ]);
});

test('switcherPayload: a done row that is open is `open`; a done row that needs you is `need`', () => {
  const candidates = [
    candidate({ id: 'd1', done: true }),
    candidate({ id: 'do', done: true, open: true }),
    candidate({ id: 'dn', done: true, need: true }),
    candidate({ id: 'dx', done: true, open: true, need: true }),
  ];
  assert.deepEqual(ranked(switcherPayload('', candidates, [])), [
    'dn:need',
    'dx:need',
    'do:open',
    'd1:done',
  ]);
});

test("switcherPayload: the rank is the candidate's `open` and `need`, not read again from the row", () => {
  // A row that starts in a terminal of the window is `not-running` in its state and open all the
  // same (build.ts knows it); a row whose payload carries no attention is `need` when it is told so.
  const starting = candidate({ id: 's1', open: true });
  assert.equal(starting.row.state, 'not-running');
  const needing = candidate({ id: 'n1', need: true });
  assert.equal(needing.row.attention, null);
  assert.deepEqual(ranked(switcherPayload('', [starting, needing], [])), ['n1:need', 's1:open']);
});

// --- matching ------------------------------------------------------------------------------------

test('switcherPayload: two words list only the candidates that match both', () => {
  const candidates = [
    candidate({ id: 'a', title: 'fix the login bug' }),
    candidate({ id: 'b', title: 'login page' }),
    candidate({ id: 'c', title: 'another bug' }),
    candidate({ id: 'd', title: 'bug in login', done: true }),
    candidate({ id: 'e', title: 'nothing here', group: 'login' }),
  ];
  assert.deepEqual(ranked(switcherPayload('LOGIN bug', candidates, [])), [
    'a:not-running',
    'd:done',
  ]);
});

test('switcherPayload: a word may be in any field, each word in a field of its own', () => {
  const candidates = [
    candidate({ id: 'a', title: 'the title', group: 'ORB-2107' }),
    candidate({ id: 'b', title: 'orb-2107 title' }),
    candidate({ id: 'c', title: 'other', group: 'ORB-9' }),
  ];
  assert.deepEqual(ranked(switcherPayload('orb-2107 title', candidates, [])), [
    'a:not-running',
    'b:not-running',
  ]);
});

test("switcherPayload: the id's first 4 characters find its session; 3 do not", () => {
  const candidates = [
    candidate({ id: S1, title: 'first' }),
    candidate({ id: S2, title: 'second' }),
    candidate({ id: S3, title: 'third' }),
  ];
  assert.deepEqual(ranked(switcherPayload(S2.slice(0, 4), candidates, [])), [`${S2}:not-running`]);
  assert.deepEqual(ranked(switcherPayload(S2.slice(0, 8).toUpperCase(), candidates, [])), [
    `${S2}:not-running`,
  ]);
  assert.deepEqual(ranked(switcherPayload(S2.slice(0, 3), candidates, [])), []);
});

test('switcherPayload: a pattern in the text is only itself', () => {
  const candidates = [
    candidate({ id: 'a', title: 'fix (x) .* done' }),
    candidate({ id: 'b', title: 'fix abc done' }),
  ];
  assert.deepEqual(ranked(switcherPayload('.*', candidates, [])), ['a:not-running']);
  assert.deepEqual(ranked(switcherPayload('(x)', candidates, [])), ['a:not-running']);
  assert.deepEqual(ranked(switcherPayload('[a-z]', candidates, [])), []);
});

test('switcherPayload: only the first 16 words of the text count (searchWords)', () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => `w${i + 1}`);
  const candidates = [candidate({ id: 'a', title: sixteen.join(' ') })];
  assert.deepEqual(ranked(switcherPayload(`${sixteen.join(' ')} absent`, candidates, [])), [
    'a:not-running',
  ]);
});

// --- the command form (E12, ruled) ---------------------------------------------------------------

/** Sessions that a search for the words of the command form's texts would find. */
function commandLike(): SwitchCandidate[] {
  return [
    candidate({ id: 'a', title: '> restore >r >restore' }),
    candidate({ id: 'b', title: '>foo foo > rest', need: true }),
    candidate({ id: 'c', title: '>', open: true }),
    candidate({ id: 'd', title: 'restore old', done: true }),
  ];
}

test('switcherPayload: a text whose first character is `>` lists no session, whatever follows', () => {
  const candidates = commandLike();
  for (const text of [
    '>restore',
    '>r',
    '> rest',
    '>Restore',
    '> RESTORE',
    '>',
    '> ',
    '> foo',
    '>foo',
    '>>',
  ]) {
    assert.deepEqual(
      switcherPayload(text, candidates, ['b']),
      { query: text, command: true, items: [], more: 0, restore: null },
      JSON.stringify(text),
    );
  }
});

test('switcherPayload: `command` is true exactly when the first character of the text is `>`', () => {
  const candidates = commandLike();
  const cases: [string, boolean][] = [
    ['>', true],
    ['> foo', true],
    ['>restore', true],
    ['>>', true],
    [' >restore', false],
    ['\t>r', false],
    ['restore', false],
    ['foo >', false],
    ['', false],
  ];
  for (const [text, command] of cases) {
    assert.equal(switcherPayload(text, candidates, []).command, command, JSON.stringify(text));
    assert.equal(switcherPayload(text, [], []).command, command, JSON.stringify(text));
  }
});

test('switcherPayload: a text that has `>` after its first character searches sessions', () => {
  const candidates = commandLike();
  // A leading space: the word `>restore`.
  assert.deepEqual(ranked(switcherPayload(' >restore', candidates, [])), ['a:not-running']);
  assert.deepEqual(ranked(switcherPayload('\t>r', candidates, [])), ['a:not-running']);
  // `>` as a later word.
  assert.deepEqual(ranked(switcherPayload('foo >', candidates, [])), ['b:need']);
});

test('switcherPayload: a text without `>` searches sessions only: `restore` finds the sessions that hold it', () => {
  const candidates = commandLike();
  assert.deepEqual(ranked(switcherPayload('restore', candidates, [])), ['a:not-running', 'd:done']);
  assert.deepEqual(ranked(switcherPayload('RESTORE old', candidates, [])), ['d:done']);
  for (const text of ['restore', 'RESTORE', 'restore old', 'x restore2']) {
    assert.equal(switcherPayload(text, candidates, []).restore, null, text);
  }
});

// --- the bound -----------------------------------------------------------------------------------

/** `n` candidates `k0`, `k1`, … that are not running, each titled `common <its id>`. */
function many(n: number): SwitchCandidate[] {
  return Array.from({ length: n }, (_, i) => candidate({ id: `k${i}`, title: `common k${i}` }));
}

test('switcherPayload: 60 candidates give the first 50 items and `more` 10', () => {
  const payload = switcherPayload('', many(60), []);
  assert.equal(payload.items.length, 50);
  assert.equal(payload.more, 10);
  assert.deepEqual(
    payload.items.map((item) => item.row.id),
    Array.from({ length: 50 }, (_, i) => `k${i}`),
  );
});

test('switcherPayload: exactly 50 candidates give 50 items and `more` 0; 51 give `more` 1', () => {
  assert.deepEqual(
    [switcherPayload('', many(50), []).more, switcherPayload('', many(50), []).items.length],
    [0, 50],
  );
  assert.deepEqual(
    [switcherPayload('', many(51), []).more, switcherPayload('', many(51), []).items.length],
    [1, 50],
  );
});

test('switcherPayload: the cut is taken after the ranking: the last ranks are left out first', () => {
  // 55 not running, then 5 that need you at the end of the candidates' order.
  const candidates = [
    ...many(55),
    ...Array.from({ length: 5 }, (_, i) => candidate({ id: `n${i}`, need: true })),
  ];
  const payload = switcherPayload('', candidates, []);
  assert.deepEqual(
    payload.items.slice(0, 6).map((item) => `${item.row.id}:${item.rank}`),
    ['n0:need', 'n1:need', 'n2:need', 'n3:need', 'n4:need', 'k0:not-running'],
  );
  assert.equal(payload.items.at(-1)?.row.id, 'k44');
  assert.equal(payload.more, 10);
});

test('switcherPayload: `more` also counts the ranks after the one the cut falls in', () => {
  // 55 not running, then 7 done: the 50th item is the 50th not running; the 5 not running left
  // and all 7 done are left out.
  const candidates = [
    ...many(55),
    ...Array.from({ length: 7 }, (_, i) => candidate({ id: `d${i}`, done: true })),
  ];
  const payload = switcherPayload('', candidates, []);
  assert.equal(payload.items.length, 50);
  assert.ok(payload.items.every((item) => item.rank === 'not-running'));
  assert.equal(payload.more, 12);
});

test('switcherPayload: with a text that 3 of 60 match, 3 items and `more` 0', () => {
  const candidates = [
    ...many(20),
    candidate({ id: 'z1', title: 'zz one' }),
    ...many(20),
    candidate({ id: 'z2', title: 'two zz' }),
    ...many(17),
    candidate({ id: 'z3', title: 'zz', done: true }),
  ];
  assert.equal(candidates.length, 60);
  const payload = switcherPayload('zz', candidates, []);
  assert.deepEqual(ranked(payload), ['z1:not-running', 'z2:not-running', 'z3:done']);
  assert.equal(payload.more, 0);
});

// --- what an item carries ------------------------------------------------------------------------

test("switcherPayload: an item is exactly its rank, the candidate's row and hiddenBy, and foundIn(title, words)", () => {
  const hiddenBy: HiddenBy[] = ['filter', 'done', 'folded'];
  const c = candidate({ id: 'a', title: 'Fix the LOGIN bug, login again', done: true, hiddenBy });
  const [item] = switcherPayload('login FIX', [c], []).items;
  assert.ok(item !== undefined);
  assert.deepEqual(Object.keys(item).sort(), ['found', 'hiddenBy', 'rank', 'row']);
  assert.equal(item.rank, 'done');
  assert.equal(item.row, c.row);
  assert.deepEqual(item.hiddenBy, ['filter', 'done', 'folded']);
  assert.deepEqual(item.found, foundIn(c.row.title, searchWords('login FIX')));
  assert.deepEqual(item.found, [
    [0, 3],
    [8, 13],
    [19, 24],
  ]);
});

test("switcherPayload: `found` is of the row's title as it is, not of its lower-cased field", () => {
  // `\u0130` lower-cases to two units: foundIn's named limit gives no range, so that a range is
  // never one unit off in the title the page draws.
  const c = candidate({ id: 'a', title: '\u0130stanbul fix' });
  const [item] = switcherPayload('fix', [c], []).items;
  assert.equal(item?.row.title, '\u0130stanbul fix');
  assert.deepEqual(item?.found, []);
});

test('switcherPayload: with no text an item has no found ranges', () => {
  const [item] = switcherPayload('', [candidate({ id: 'a', title: 'anything' })], []).items;
  assert.deepEqual(item?.found, []);
});

test('switcherPayload: a word found only outside the title gives no range in it', () => {
  const [item] = switcherPayload(
    'orb-7',
    [candidate({ id: 'a', title: 'plain', group: 'ORB-7' })],
    [],
  ).items;
  assert.deepEqual(item?.found, []);
});

test('switcherPayload: hiddenBy is passed on for each item, whatever the rank', () => {
  const candidates = [
    candidate({ id: 'a', hiddenBy: [] }),
    candidate({ id: 'b', done: true, hiddenBy: ['done'] }),
    candidate({ id: 'c', hiddenBy: ['folded'] }),
    candidate({ id: 'd', open: true, hiddenBy: ['filter'] }),
  ];
  const payload = switcherPayload('', candidates, []);
  assert.deepEqual(
    payload.items.map((item) => [item.row.id, item.hiddenBy]),
    [
      ['d', ['filter']],
      ['a', []],
      ['c', ['folded']],
      ['b', ['done']],
    ],
  );
});

test('switcherPayload: `query` is the text as given, not cut and not lower-cased; `restore` is null', () => {
  const text = `  ORB Fix\t${Array.from({ length: 20 }, (_, i) => `W${i}`).join(' ')} ${'X'.repeat(100)} `;
  const payload = switcherPayload(text, [candidate({ id: 'a' })], []);
  assert.equal(payload.query, text);
  assert.equal(payload.restore, null);
});

test('switcherPayload: nothing gives { query, command: false, items: [], more: 0, restore: null }', () => {
  assert.deepEqual(switcherPayload('', [], []), {
    query: '',
    command: false,
    items: [],
    more: 0,
    restore: null,
  });
  assert.deepEqual(switcherPayload('fix', [], ['n1']), {
    query: 'fix',
    command: false,
    items: [],
    more: 0,
    restore: null,
  });
  assert.deepEqual(switcherPayload('absent', [candidate({ id: 'a' })], []), {
    query: 'absent',
    command: false,
    items: [],
    more: 0,
    restore: null,
  });
});

test('switcherPayload: a payload with items has exactly the contract fields', () => {
  const payload = switcherPayload('', [candidate({ id: 'a' })], []);
  assert.deepEqual(Object.keys(payload).sort(), ['command', 'items', 'more', 'query', 'restore']);
  assert.equal(payload.command, false);
});

test('switcherPayload: nothing in the input is written', () => {
  const candidates = frozen([
    candidate({ id: 'o1', open: true, hiddenBy: ['filter'] }),
    candidate({ id: 'n1', need: true }),
    candidate({ id: 'r1', title: 'fix it' }),
    candidate({ id: 'd1', done: true, title: 'fix that' }),
  ]);
  const needOrder = Object.freeze(['n1']);
  assert.deepEqual(ranked(switcherPayload('', candidates, needOrder)), [
    'n1:need',
    'o1:open',
    'r1:not-running',
    'd1:done',
  ]);
  assert.deepEqual(ranked(switcherPayload('fix', candidates, needOrder)), [
    'r1:not-running',
    'd1:done',
  ]);
});

test('switcherPayload: its cost is linear in the candidates (40,000 that all need you and match)', () => {
  // A guard against a quadratic step (an `indexOf` in needOrder per candidate, or in a sort's
  // comparator), not a benchmark: linear, this takes a few tens of milliseconds; quadratic, many
  // seconds. The least of three runs, so that a loaded machine does not fail it.
  const n = 40_000;
  const candidates = Array.from({ length: n }, (_, i) =>
    candidate({ id: `k${i}`, title: `common k${i}`, need: true }),
  );
  // needOrder is the reverse of the candidates' order.
  const needOrder = candidates.map((c) => c.row.id).reverse();
  let least = Infinity;
  let payload: SwitcherPayload | null = null;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    payload = switcherPayload('common', candidates, needOrder);
    least = Math.min(least, performance.now() - started);
  }
  assert.equal(payload?.items.length, 50);
  assert.equal(payload?.more, n - 50);
  assert.equal(payload?.items[0]?.row.id, `k${n - 1}`);
  assert.equal(payload?.items[49]?.row.id, `k${n - 50}`);
  assert.ok(least < 1_000, `${least} ms`);
});

// --- the restore offer (E12) ---------------------------------------------------------------------

/** Stage C's banner payload, the four fields restoreOffer reads: three entries, two preselected. */
function banner(over: { shown?: boolean; running?: boolean; preselected?: boolean[] } = {}) {
  const preselected = over.preselected ?? [true, false, true];
  return {
    bootId: 'boot-earlier',
    lastActivityNs: '1794474000000000000',
    entries: [S2, S1, S3].map((sessionId, i) => ({
      sessionId,
      title: `entry ${i}`,
      preselected: preselected[i] ?? false,
    })),
    shown: over.shown ?? false,
    running: over.running ?? false,
  };
}

const OFFER = { count: 2, lastActivityNs: '1794474000000000000', sessionIds: [S2, S3] };

test('restoreOffer: `>` and a start of `restore` of at least one letter give the offer', () => {
  for (const text of [
    '>r',
    '>re',
    '> rest',
    '>restor',
    '>restore',
    '>  restore  ',
    '>\trestore\n',
    // Every white space that splits words (searchWords) is trimmed: the no-break space (AltGr or
    // Option with Space types it), the byte-order mark, the ideographic space, a line separator.
    '>\u00a0restore',
    '>\ufeffrestore',
    '>\u3000r',
    '> r\u2028',
  ]) {
    assert.deepEqual(restoreOffer(text, banner()), OFFER, JSON.stringify(text));
  }
});

test('restoreOffer: the command is taken whatever its case', () => {
  for (const text of ['> RESTORE', '>Restore', '>R', '>Rest', '> rEsToRe']) {
    assert.deepEqual(restoreOffer(text, banner()), OFFER, JSON.stringify(text));
  }
});

test("restoreOffer: a text without `>` searches sessions only, so a session's name never brings the offer", () => {
  for (const text of [
    'restore',
    'RESTORE',
    'restore old',
    'x restore2',
    'res',
    'rest',
    'x',
    'xrestore',
  ]) {
    assert.equal(restoreOffer(text, banner()), null, JSON.stringify(text));
  }
});

test('restoreOffer: an empty text, `>` alone, and `>` with what is no start of `restore` give null', () => {
  const texts = [
    '',
    ' ',
    '>',
    '> ',
    '>\t',
    '>restores',
    '>restore old',
    '> re store',
    '>x',
    '> foo',
    '>>restore',
    '> >restore',
    '>estore',
    'restore>',
    'x >restore',
    // `>` must be the text's first character.
    ' >restore',
    '\t>r',
    // Nothing is trimmed before the `>`, white space or not.
    '\ufeff>restore',
    '\u00a0>restore',
    '\u200b>restore',
    // A zero-width space is no white space: it is part of the command.
    '>\u200brestore',
    // Only ASCII `>` and the ASCII letters of `restore`: a look-alike is no command. The long s
    // upper-cases to `S`, so a comparison through toUpperCase() would take it.
    '\uff1erestore',
    '>r\u0435store',
    '>re\u017ftore',
    // The mockup's toast quotes it; the quotes are not the command.
    '"> restore"',
    '\u201c> restore\u201d',
  ];
  for (const text of texts) {
    assert.equal(restoreOffer(text, banner()), null, JSON.stringify(text));
  }
});

test('restoreOffer: no offer while the banner is shown, while a restore runs, with nothing preselected, or without a banner', () => {
  assert.equal(restoreOffer('>restore', banner({ shown: true })), null);
  assert.equal(restoreOffer('>restore', banner({ running: true })), null);
  assert.equal(restoreOffer('>restore', banner({ preselected: [false, false, false] })), null);
  assert.equal(restoreOffer('>restore', banner({ preselected: [] })), null);
  assert.equal(restoreOffer('>restore', null), null);
});

/** A banner whose fields are set at run time to what its type does not allow: through a cast. */
function untyped(over: Record<string, unknown>): Parameters<typeof restoreOffer>[1] {
  return { ...banner(), ...over } as unknown as Parameters<typeof restoreOffer>[1];
}

test('restoreOffer: what is not positively known gives no offer: `shown` and `running` must be false', () => {
  // The offer starts programs (ruled): a banner that does not say it is hidden and idle offers
  // nothing.
  for (const value of [undefined, null, 0, '', 'false', NaN]) {
    assert.equal(
      restoreOffer('>restore', untyped({ shown: value })),
      null,
      `shown ${String(value)}`,
    );
    assert.equal(
      restoreOffer('>restore', untyped({ running: value })),
      null,
      `running ${String(value)}`,
    );
  }
  // A banner without the field at all.
  const { shown: _shown, ...noShown } = banner();
  const { running: _running, ...noRunning } = banner();
  assert.equal(
    restoreOffer('>restore', noShown as unknown as Parameters<typeof restoreOffer>[1]),
    null,
  );
  assert.equal(
    restoreOffer('>restore', noRunning as unknown as Parameters<typeof restoreOffer>[1]),
    null,
  );
});

test('restoreOffer: an entry counts only when its `preselected` is true', () => {
  const entries = [
    { sessionId: S1, preselected: 1 },
    { sessionId: S2, preselected: 'true' },
    { sessionId: S3, preselected: true },
    { sessionId: 'no-flag' },
    { sessionId: 'null-flag', preselected: null },
    { sessionId: 'object-flag', preselected: {} },
  ];
  assert.deepEqual(restoreOffer('>restore', untyped({ entries })), {
    count: 1,
    lastActivityNs: '1794474000000000000',
    sessionIds: [S3],
  });
  assert.equal(restoreOffer('>restore', untyped({ entries: entries.slice(0, 2) })), null);
});

test("restoreOffer: the preselected entries' ids in the banner's order, their count, its lastActivityNs", () => {
  assert.deepEqual(restoreOffer('>r', banner({ preselected: [false, true, false] })), {
    count: 1,
    lastActivityNs: '1794474000000000000',
    sessionIds: [S1],
  });
  assert.deepEqual(restoreOffer('>r', banner({ preselected: [true, true, true] })), {
    count: 3,
    lastActivityNs: '1794474000000000000',
    sessionIds: [S2, S1, S3],
  });
  assert.deepEqual(restoreOffer('>r', { ...banner(), lastActivityNs: null }), {
    count: 2,
    lastActivityNs: null,
    sessionIds: [S2, S3],
  });
});

test('restoreOffer: reads only the four fields, writes nothing, and its ids are its own array', () => {
  const entries = Object.freeze(
    [
      { sessionId: S1, preselected: true },
      { sessionId: S2, preselected: false },
    ].map((entry) => Object.freeze(entry)),
  );
  const given = Object.freeze({ entries, lastActivityNs: null, shown: false, running: false });
  const offer = restoreOffer('>restore', given);
  assert.deepEqual(offer, { count: 1, lastActivityNs: null, sessionIds: [S1] });
  offer?.sessionIds.push('more');
  assert.deepEqual(restoreOffer('>restore', given)?.sessionIds, [S1]);
});

// --- types the page and task 96 rely on ----------------------------------------------------------

test('an item row is a RowPayload as build.ts makes it', () => {
  const c = candidate({ id: 'a', title: 'typed' });
  const row: RowPayload = c.row;
  assert.equal(row.title, 'typed');
  assert.equal(switcherPayload('', [c], []).items[0]?.row, row);
});
