import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHIP_ORDER } from '../../../../src/github.ts';
import { matchesFilter } from '../../../../src/sessions/list.ts';
import type { ListRow } from '../../../../src/sessions/list.ts';
import type { PrRow } from '../../../../src/store/types.ts';
import {
  FIELD_UNITS,
  ID_PREFIX_MIN,
  MAX_FOUND,
  MAX_WORD_UNITS,
  MAX_WORDS,
  SEARCH_CHIPS,
  foundIn,
  isFiltering,
  matchesChips,
  matchesWords,
  searchWords,
  searchable,
} from '../../../../src/window/view/search/filter.ts';
import { windowChip } from '../../../../src/window/view/chip.ts';
import { attached, ds, meta, prRow, rowOf, rows } from '../../../helpers/derived.ts';
import { S1, S2, S3, T0 } from '../../../helpers/platform.ts';

/** What a row is given in a test: every field neutral unless named. */
interface RowSpec {
  id?: string;
  title?: string;
  group?: string;
  note?: string;
  dir?: string | null;
  prs?: PrRow[];
  /** F18: the ticket's address. */
  ticket?: string;
  /** F35: marked done. */
  done?: boolean;
}

/** A row as step 1 loads it: its title a name set in Claude Code, its group and note in meta. */
function row(spec: RowSpec = {}): ListRow {
  const id = spec.id ?? S1;
  const prs = spec.prs ?? [];
  const hasMeta = spec.group !== undefined || spec.note !== undefined || spec.ticket !== undefined;
  return rowOf(
    ds({
      id,
      dir: spec.dir === undefined ? '/home/dev/plain' : spec.dir,
      transcript: { customTitle: spec.title ?? 'neutral' },
      ...(spec.done === true ? { hidden: true, doneAtNs: T0 } : {}),
    }),
    {
      metas: hasMeta
        ? [
            meta(id, {
              group: spec.group ?? null,
              note: spec.note ?? null,
              ticket: spec.ticket ?? null,
            }),
          ]
        : [],
      prs,
      sessionPrs: prs.map((pr) => attached(id, pr)),
    },
  );
}

function matches(target: ListRow, text: string): boolean {
  return matchesWords(searchable(target), searchWords(text));
}

// --- the constants -----------------------------------------------------------------------------

test('the bounds of E3 and the chips of E4 are as the plan fixes them', () => {
  assert.equal(MAX_WORDS, 16);
  assert.equal(MAX_WORD_UNITS, 64);
  assert.equal(FIELD_UNITS, 16_384);
  assert.equal(ID_PREFIX_MIN, 4);
  assert.equal(MAX_FOUND, 32);
  assert.deepEqual(SEARCH_CHIPS, ['running', 'open-pr', 'note', 'done']);
  assert.ok(Object.isFrozen(SEARCH_CHIPS));
});

// --- searchWords -------------------------------------------------------------------------------

test('searchWords: spaces, tabs, line breaks, the no-break space and U+3000 separate words', () => {
  assert.deepEqual(searchWords('a b\tc\nd\r\ne f　g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('searchWords: white space at the start and the end gives no word', () => {
  assert.deepEqual(searchWords('  \t fix  bug \n'), ['fix', 'bug']);
  assert.deepEqual(searchWords(''), []);
  assert.deepEqual(searchWords(' \t\n 　 '), []);
});

test('searchWords: upper case is lowered', () => {
  assert.deepEqual(searchWords('ORB-2107 Fix ÉCOLE'), ['orb-2107', 'fix', 'école']);
});

test('searchWords: a repeated word counts once, in the place it first has', () => {
  assert.deepEqual(searchWords('fix bug Fix FIX bug login'), ['fix', 'bug', 'login']);
});

test('searchWords: 17 words give the first 16', () => {
  const words = Array.from({ length: 17 }, (_, i) => `w${i + 1}`);
  assert.deepEqual(searchWords(words.join(' ')), words.slice(0, 16));
});

test('searchWords: the first 16 words are taken before a repeated one is dropped', () => {
  // The 17th word is not one of the first 16, even though 15 of those are repeats.
  assert.deepEqual(searchWords(`${'x '.repeat(16)}y`), ['x']);
});

test('searchWords: a word of 100 units counts in its first 64', () => {
  assert.deepEqual(searchWords('x'.repeat(100)), ['x'.repeat(64)]);
  assert.deepEqual(searchWords(`ab ${'y'.repeat(64)}`), ['ab', 'y'.repeat(64)]);
});

test('searchWords: a word is cut after it is lower-cased', () => {
  // `İ` is one unit and lower-cases to two (`i` and U+0307): the cut counts the lower case.
  const [word = ''] = searchWords('İ'.repeat(64));
  assert.equal(word.length, MAX_WORD_UNITS);
  assert.equal(word, 'i̇'.repeat(32));
});

test('searchWords: two long words that are the same in their first 64 units count once', () => {
  assert.deepEqual(searchWords(`${'x'.repeat(70)}a ${'x'.repeat(80)}b`), ['x'.repeat(64)]);
});

test('searchWords: a word whose 64th unit is the first half of a surrogate pair is cut before it', () => {
  const cut = searchWords(`${'a'.repeat(63)}\u{1f600}b`);
  assert.deepEqual(cut, ['a'.repeat(63)]);
  // A pair that ends at unit 64 is kept whole.
  assert.deepEqual(searchWords(`${'a'.repeat(62)}\u{1f600}b`), [`${'a'.repeat(62)}\u{1f600}`]);
});

// --- matchesWords ------------------------------------------------------------------------------

test('matchesWords: each field on its own is searched', () => {
  const pr = prRow('echo-owner/foxtrot-repo', 4321);
  const cases: [string, RowSpec, string][] = [
    ['the title', { title: 'Alpha title' }, 'alpha'],
    ['the group', { group: 'Bravo-group' }, 'bravo-group'],
    ['the note', { note: 'charlie note' }, 'charlie'],
    ['the directory', { dir: '/home/dev/delta-dir' }, 'delta-dir'],
    ['owner/repo', { prs: [pr] }, 'echo-owner/foxtrot-repo'],
    ['the number', { prs: [pr] }, '4321'],
    ['owner/repo#number', { prs: [pr] }, 'echo-owner/foxtrot-repo#4321'],
    ['repo#number', { prs: [pr] }, 'foxtrot-repo#4321'],
    // F18: the ticket's short name and its address.
    [
      'the ticket name',
      { ticket: 'https://github.com/golf/hotel-repo/issues/77' },
      'hotel-repo #77',
    ],
    ['the ticket address', { ticket: 'https://example.com/india/ABC-123' }, 'example.com/india'],
  ];
  const plain = row();
  for (const [field, spec, word] of cases) {
    assert.equal(matches(row(spec), word), true, `${field}: ${word}`);
    assert.equal(matches(plain, word), false, `${field} absent: ${word}`);
  }
});

test('matchesWords: a word is found inside one field, never across the end of one and the next', () => {
  const target = row({
    title: 'Fix login',
    group: 'seeds',
    note: 'tail',
    dir: '/home/x',
    prs: [prRow('acme/web', 42)],
  });
  for (const word of ['login', 'seeds', 'tail', '/home/x', 'acme/web', 'web#42', '42']) {
    assert.equal(matches(target, word), true, word);
  }
  for (const word of ['logins', 'seedst', 'tail/home', 'xacme', 'web42', '42acme']) {
    assert.equal(matches(target, word), false, word);
  }
});

test('matchesWords: the fields are searched without regard to case', () => {
  assert.equal(matches(row({ title: 'ORB-2107 Fix the Login' }), 'login orb'), true);
  assert.equal(matches(row({ note: 'École' }), 'ÉCOLE'), true);
});

test('matchesWords: every word must be found, each in any field', () => {
  const target = row({ title: 'Fix the login', note: 'see the gateway' });
  assert.equal(matches(target, 'login gateway'), true);
  assert.equal(matches(target, 'gateway login fix'), true);
  assert.equal(matches(target, 'login payments'), false);
  assert.equal(matches(target, 'payments'), false);
});

test('matchesWords: no word matches every row', () => {
  assert.equal(matchesWords(searchable(row()), []), true);
  assert.equal(matchesWords(searchable(row({ dir: null })), []), true);
});

test('matchesWords: a word of the note after an escape sequence is found, the escape is not', () => {
  const target = row({ note: '\x1b[31mred\x1b[0m alert' });
  assert.equal(matches(target, 'red'), true);
  assert.equal(matches(target, 'red alert'), true);
  assert.equal(matches(target, '[31mred'), false);
  assert.equal(matches(target, '[0m'), false);
  // Design 7.4's filter searches the raw note and finds it: the window's rule does not.
  assert.equal(matchesFilter(target, '[31mred'), true);
});

test('matchesWords: the note is sanitised line by line', () => {
  // An unterminated control string ends with its line: the next line is still searched.
  const target = row({ note: '\x1b]0;hidden\nvisible\rnext' });
  assert.equal(matches(target, 'visible next'), true);
  assert.equal(matches(target, 'hidden'), false);
  // A lone carriage return ends a line too, as for `show` (design 7.4).
  assert.equal(matches(row({ note: '\x1b]0;hidden\rvisible' }), 'visible'), true);
  assert.equal(matches(row({ note: '\x1b]0;hidden\r\nvisible' }), 'visible'), true);
});

test('matchesWords: the id matches from its first 4 characters on, and only as its start', () => {
  const target = row({ id: S1 });
  assert.equal(S1.slice(0, 8), '0b5f3c1e');
  assert.equal(matches(target, S1.slice(0, 3)), false);
  assert.equal(matches(target, S1.slice(0, 4)), true);
  assert.equal(matches(target, S1.slice(0, 8)), true);
  assert.equal(matches(target, S1.slice(0, 13)), true);
  assert.equal(matches(target, S1), true);
  assert.equal(matches(target, S1.slice(0, 4).toUpperCase()), true);
  assert.equal(matches(target, S1.slice(4, 8)), false);
  assert.equal(matches(target, S1.slice(9, 13)), false);
  assert.equal(matches(target, `${S1}0`), false);
  assert.equal(matches(target, `${S1.slice(0, 8)} neutral`), true);
  assert.equal(matches(row({ id: S2 }), S1.slice(0, 8)), false);
});

test('matchesWords: for one word, the same as design 7.4 but for the id', () => {
  const list = rows(
    [
      ds({
        id: S1,
        dir: '/home/dev/projects/web',
        transcript: { customTitle: 'ORB-2107 Fix login' },
      }),
      ds({ id: S2, dir: null, transcript: { aiTitle: 'Refactor İstanbul module' } }),
      ds({ id: S3, dir: '/srv/app', transcript: { customTitle: 'Notes about 42' } }),
    ],
    {
      metas: [
        meta(S1, { note: 'Remember: straße and café' }),
        meta(S2, { group: 'Infra' }),
        meta(S3, { note: 'line one\r\nline two\nthree' }),
      ],
      prs: [prRow('acme/web', 42), prRow('other/thing', 7), prRow('acme/web', 420)],
      sessionPrs: [
        attached(S1, prRow('acme/web', 42)),
        attached(S3, prRow('other/thing', 7)),
        attached(S3, prRow('acme/web', 420)),
      ],
    },
  );
  const words = [
    'orb',
    'ORB-2107',
    'fix',
    'Login',
    'infra',
    'straße',
    'café',
    'CAFÉ',
    'remember:',
    'acme',
    'acme/web',
    'web',
    '4',
    '42',
    '420',
    'acme/web#42',
    'web#4',
    '#42',
    '#7',
    'thing#7',
    'line',
    'one',
    'two',
    'three',
    '/home',
    'projects/web',
    'srv',
    'İstanbul',
    'istanbul',
    'module',
    'about',
    'zzz',
    '/',
    '0b5f',
    S2.slice(0, 8),
    S3,
  ];
  let compared = 0;
  for (const target of list) {
    for (const word of words) {
      const parsed = searchWords(word);
      assert.equal(parsed.length, 1, word);
      const [lower = ''] = parsed;
      if (lower.length >= ID_PREFIX_MIN && target.id.startsWith(lower)) {
        continue; // the words of the id rule
      }
      compared += 1;
      assert.equal(
        matchesWords(searchable(target), parsed),
        matchesFilter(target, word),
        `${target.id.slice(0, 8)}: ${word}`,
      );
    }
  }
  assert.equal(compared, list.length * words.length - 3);
});

test('matchesWords: the words are text, never a pattern', () => {
  const plain = row({ title: 'abc def 123 xyz', dir: '/home/dev/plain' });
  for (const token of ['.', '.*', '(', '[a-z]', '\\d', '^', '$', '|', '+']) {
    assert.equal(matches(plain, token), false, `${token} in a text without it`);
    assert.equal(matches(row({ title: `abc${token}def` }), token), true, `${token} itself`);
  }
});

test('matchesWords: a note is searched in its first FIELD_UNITS units', () => {
  const ends = row({ note: `${'a'.repeat(FIELD_UNITS - 5)}zebra` });
  assert.equal(matches(ends, 'zebra'), true);
  const crosses = row({ note: `${'a'.repeat(FIELD_UNITS - 4)}zebra` });
  assert.equal(matches(crosses, 'zebra'), false);
  const after = row({ note: `${'a'.repeat(FIELD_UNITS)}zebra` });
  assert.equal(matches(after, 'zebra'), false);
});

test('matchesWords: a note is cut in its raw text, before it is sanitised', () => {
  // The escape sequence takes 4 raw units: sanitised, the word would end within the limit.
  const ends = row({ note: `${'a'.repeat(FIELD_UNITS - 9)}\x1b[0mzebra` });
  assert.equal(matches(ends, 'zebra'), true);
  const crosses = row({ note: `${'a'.repeat(FIELD_UNITS - 8)}\x1b[0mzebra` });
  assert.equal(matches(crosses, 'zebra'), false);
});

test('matchesWords: a title is searched in its first FIELD_UNITS units', () => {
  const ends = row({ title: `${'a'.repeat(FIELD_UNITS - 5)}zebra` });
  assert.equal(matches(ends, 'zebra'), true);
  const after = row({ title: `${'a'.repeat(FIELD_UNITS)}zebra` });
  assert.equal(matches(after, 'zebra'), false);
});

test('matchesWords: a field is cut to FIELD_UNITS also when its lower case is longer', () => {
  // `İ` lower-cases to two units: the title's first half fills the field once lower-cased.
  const title = `${'İ'.repeat(FIELD_UNITS / 2)}${'a'.repeat(FIELD_UNITS / 2 - 5)}zebra`;
  assert.equal(title.length, FIELD_UNITS);
  const target = row({ title });
  assert.deepEqual(
    searchable(target).fields.map((text) => text.length),
    [FIELD_UNITS, '/home/dev/plain'.length],
  );
  assert.equal(matches(target, 'zebra'), false);
  assert.equal(matches(target, 'i̇i̇'), true);
});

// --- searchable --------------------------------------------------------------------------------

test('searchable: the same row object gives the same object, a reloaded row a new one', () => {
  const first = row({ title: 'Fix login', note: 'a note' });
  const once = searchable(first);
  assert.equal(searchable(first), once);
  const reloaded = row({ title: 'Fix login', note: 'a note' });
  const again = searchable(reloaded);
  assert.notEqual(again, once);
  assert.deepEqual(again, once);
  assert.notEqual(searchable({ ...first }), once);
});

test('searchable: the ticket (F18) is two fields after the pull requests: its name, its address', () => {
  const target = searchable(
    row({ title: 'Fix Login', ticket: 'https://example.com/browse/ABC-12' }),
  );
  assert.deepEqual(target.fields, [
    'fix login',
    '/home/dev/plain',
    'abc-12',
    'https://example.com/browse/abc-12',
  ]);
});

test('searchable: the id and the fields, lower-cased', () => {
  const pr = prRow('Acme/Web', 42);
  const target = searchable(
    row({ title: 'Fix Login', group: 'Infra', note: 'One\r\nTwo', dir: '/Home/x', prs: [pr] }),
  );
  assert.equal(target.id, S1);
  assert.deepEqual(target.fields, [
    'fix login',
    'infra',
    'one\ntwo',
    '/home/x',
    'acme/web',
    '42',
    'acme/web#42',
  ]);
  assert.ok(Object.isFrozen(target));
  assert.ok(Object.isFrozen(target.fields));
});

// --- matchesChips and isFiltering --------------------------------------------------------------

test('matchesChips: running holds for a row in Open only', () => {
  const target = row();
  assert.equal(matchesChips(target, true, ['running']), true);
  assert.equal(matchesChips(target, false, ['running']), false);
});

test('matchesChips: open-pr holds while a pull request is not known to be merged or closed', () => {
  const byLevel: [string, PrRow][] = [
    ['cant-read', prRow('o/r', 1, { error: 'HTTP 502' })],
    ['unfetched', prRow('o/r', 2, { state: null, okAtNs: null })],
    ['checks-failing', prRow('o/r', 3, { checks: 'failing' })],
    ['changes-requested', prRow('o/r', 4, { review: 'changes-requested' })],
    ['checks-pending', prRow('o/r', 5, { checks: 'pending' })],
    ['review-required', prRow('o/r', 6, { review: 'review-required' })],
    ['unresolved-comments', prRow('o/r', 11, { review: 'unresolved-comments' })],
    ['draft', prRow('o/r', 7, { state: 'draft' })],
    ['checks-not-reported', prRow('o/r', 15, { checks: 'not-reported' })],
    ['blocked', prRow('o/r', 12, { review: 'blocked' })],
    ['open', prRow('o/r', 13, { review: 'not-required', checks: null })],
    ['checks-passing', prRow('o/r', 14, { review: 'not-required', checks: 'passing' })],
    ['approved-green', prRow('o/r', 8)],
    ['merged', prRow('o/r', 9, { state: 'merged' })],
    ['closed', prRow('o/r', 10, { state: 'closed' })],
  ];
  assert.deepEqual(
    byLevel.map(([level]) => level),
    [...CHIP_ORDER],
  );
  const finished = (level: string): boolean => level === 'merged' || level === 'closed';
  for (const [level, pr] of byLevel) {
    const target = row({ prs: [pr] });
    assert.equal(target.prs[0]?.level, level);
    assert.equal(matchesChips(target, false, ['open-pr']), !finished(level), level);
    // The same rule as the chip of the window's row (S2 12.3): it counts this one open, or not.
    const chip = windowChip(target.prs);
    assert.equal(matchesChips(target, false, ['open-pr']), (chip?.open ?? 0) > 0, level);
  }
  const merged = byLevel.find(([name]) => name === 'merged')?.[1];
  const closed = byLevel.find(([name]) => name === 'closed')?.[1];
  assert.ok(merged !== undefined && closed !== undefined);
  for (const [level, pr] of byLevel.filter(([name]) => !finished(name))) {
    assert.equal(matchesChips(row({ prs: [merged, pr, closed] }), false, ['open-pr']), true, level);
  }
  assert.equal(matchesChips(row({ prs: [merged, closed] }), true, ['open-pr']), false);
  assert.equal(matchesChips(row(), true, ['open-pr']), false);
});

test('matchesChips: note holds for a row with a note', () => {
  assert.equal(matchesChips(row({ note: 'remember' }), false, ['note']), true);
  assert.equal(matchesChips(row({ group: 'Infra' }), false, ['note']), false);
  assert.equal(matchesChips(row(), true, ['note']), false);
});

test('matchesChips: done holds for a row marked done (F35), running or not', () => {
  assert.equal(matchesChips(row({ done: true }), false, ['done']), true);
  assert.equal(matchesChips(row({ done: true }), true, ['done']), true);
  assert.equal(matchesChips(row(), false, ['done']), false);
  assert.equal(matchesChips(row({ note: 'x' }), true, ['done']), false);
  assert.equal(matchesChips(row({ done: true, note: 'x' }), false, ['note', 'done']), true);
  assert.equal(matchesChips(row({ done: true }), false, ['note', 'done']), false);
  assert.equal(matchesChips(row({ done: true }), false, ['running', 'done']), false);
});

test('matchesChips: every chip set must hold', () => {
  const withNote = row({ note: 'remember' });
  assert.equal(matchesChips(withNote, true, ['running', 'note']), true);
  assert.equal(matchesChips(withNote, false, ['running', 'note']), false);
  assert.equal(matchesChips(row(), true, ['running', 'note']), false);
  assert.equal(matchesChips(withNote, true, ['note', 'open-pr']), false);
});

test('matchesChips: no chip matches every row', () => {
  assert.equal(matchesChips(row(), false, []), true);
  assert.equal(matchesChips(row({ note: 'x' }), true, []), true);
});

test('isFiltering: a word or a chip', () => {
  assert.equal(isFiltering(['fix'], []), true);
  assert.equal(isFiltering([], ['note']), true);
  assert.equal(isFiltering(['fix'], ['running']), true);
  assert.equal(isFiltering([], ['done']), true);
  assert.equal(isFiltering([], []), false);
});

// --- foundIn -----------------------------------------------------------------------------------

test('foundIn: every occurrence of each word, in order, without regard to case', () => {
  assert.deepEqual(foundIn('Fix the FIX of fixtures', ['fix', 'the']), [
    [0, 3],
    [4, 7],
    [8, 11],
    [15, 18],
  ]);
  assert.deepEqual(foundIn('Fix the FIX of fixtures', ['the', 'fix']), [
    [0, 3],
    [4, 7],
    [8, 11],
    [15, 18],
  ]);
});

test('foundIn: overlapping and touching occurrences are merged', () => {
  assert.deepEqual(foundIn('aaa', ['aa']), [[0, 3]]);
  assert.deepEqual(foundIn('abcd', ['cd', 'ab']), [[0, 4]]);
  assert.deepEqual(foundIn('ORB-2107 x', ['2107', 'orb-2']), [[0, 8]]);
  assert.deepEqual(foundIn('xabcabcx', ['abc', 'cab']), [[1, 7]]);
  assert.deepEqual(foundIn('ab cd', ['ab', 'cd']), [
    [0, 2],
    [3, 5],
  ]);
});

test('foundIn: one range for a word that runs on through the whole title', () => {
  assert.deepEqual(foundIn('a'.repeat(FIELD_UNITS), ['a', 'aa', 'a'.repeat(64)]), [
    [0, FIELD_UNITS],
  ]);
});

test('foundIn: 33 occurrences give the first 32', () => {
  const found = foundIn('x '.repeat(33), ['x']);
  assert.equal(found.length, MAX_FOUND);
  assert.deepEqual(
    found,
    Array.from({ length: 32 }, (_, i) => [2 * i, 2 * i + 1]),
  );
});

test('foundIn: only in the first FIELD_UNITS units', () => {
  assert.deepEqual(foundIn(`${'a'.repeat(FIELD_UNITS - 5)}zebra`, ['zebra']), [
    [FIELD_UNITS - 5, FIELD_UNITS],
  ]);
  assert.deepEqual(foundIn(`${'a'.repeat(FIELD_UNITS - 4)}zebra`, ['zebra']), []);
  assert.deepEqual(foundIn(`${'a'.repeat(FIELD_UNITS)}zebra`, ['zebra']), []);
});

test('foundIn: nothing for a title whose lower case has another length', () => {
  assert.notEqual('İstanbul'.toLowerCase().length, 'İstanbul'.length);
  assert.deepEqual(foundIn('İstanbul', ['stan']), []);
  assert.deepEqual(foundIn('Istanbul', ['stan']), [[1, 5]]);
});

test('foundIn: nothing for no word, or a word that is not there', () => {
  assert.deepEqual(foundIn('Fix login', []), []);
  assert.deepEqual(foundIn('Fix login', ['zebra']), []);
  assert.deepEqual(foundIn('', ['fix']), []);
});

test('foundIn: an empty word is no word', () => {
  // Longer than MAX_FOUND units, so that an empty word taken as found would end the walk at once.
  assert.deepEqual(foundIn('x'.repeat(40), ['']), []);
  assert.deepEqual(foundIn(`${'x'.repeat(40)}b`, ['', 'b']), [[40, 41]]);
});

// --- the bound of E3 ---------------------------------------------------------------------------

test('the bound of E3: 16 words over 1,000 notes of FIELD_UNITS units each, within 2 seconds', (t) => {
  // 16 words, each `a`×31, one letter, `a`×32 (`b` for the first, `c` for the second, …), at the
  // end of notes of `a`s: every word scans every note to its end, and every row matches.
  const words = Array.from(
    { length: MAX_WORDS },
    (_, i) => `${'a'.repeat(31)}${String.fromCharCode(0x62 + i)}${'a'.repeat(32)}`,
  );
  assert.ok(words.every((word) => word.length === MAX_WORD_UNITS));
  const tail = words.join('');
  const note = `${'a'.repeat(FIELD_UNITS - tail.length)}${tail}`;
  assert.equal(note.length, FIELD_UNITS);
  const ids = Array.from(
    { length: 1_000 },
    (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
  );
  const list = rows(
    ids.map((id) => ds({ id, transcript: { customTitle: 'neutral' } })),
    { metas: ids.map((id) => meta(id, { note })) },
  );
  const targets = list.map(searchable);
  const parsed = searchWords(words.join(' '));
  assert.deepEqual(parsed, words);
  // The least of three runs: a loaded machine slows one run, never a quadratic step.
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    const matched = targets.filter((target) => matchesWords(target, parsed)).length;
    best = Math.min(best, performance.now() - started);
    assert.equal(matched, 1_000);
  }
  t.diagnostic(`the least of three runs: ${best.toFixed(0)} ms`);
  assert.ok(best < 2_000, `${best.toFixed(0)} ms`);
});
