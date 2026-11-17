// The page's texts of search (S2 12.2, 12.8; plan task 93, E3, E7, E9; F9): the cut of a search
// text after its 16th word, a closed caption's ` · n needs you` and the pane's group card, a
// highlighted title's parts, the switcher's headings and footer. node:test on web/search-text.js, which uses no DOM.
//
// The page and the server must never disagree about a search text (ruled for task 93): what a
// word is, how many count, where one ends. So the page's cut is run here beside the server's own
// rule (src/window/view/search/filter.ts), over named texts and over generated ones.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  MAX_WORDS as SERVER_MAX_WORDS,
  foundIn,
  searchWords,
} from '../../src/window/view/search/filter.ts';
import {
  MAX_WORDS,
  captionNeedText,
  cutWords,
  groupCardText,
  highlightParts,
  rankHeading,
  switcherFooter,
} from '../../web/search-text.js';

/** The words of a text as the server counts them before it cuts or dedups (E2): its parts. */
function parts(text: string): string[] {
  return text.split(/\s+/u).filter((part) => part !== '');
}

const utf8 = new TextEncoder();

/** `n` distinct words: `w1`, `w2`, … */
function words(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `w${i + 1}`);
}

/**
 * What every text must give: the page's cut is a prefix of the text that the server reads as the
 * whole text (the same words), `cut` exactly when a 17th word was there; uncut, the text is kept
 * as typed (white space at its end too); cut, it ends where the 16th word ends.
 */
function assertParity(text: string): void {
  const { text: kept, cut } = cutWords(text);
  assert.deepEqual(searchWords(kept), searchWords(text), 'the server reads the same words');
  assert.equal(cut, parts(text).length > MAX_WORDS, 'cut exactly when a 17th word was there');
  assert.ok(text.startsWith(kept), 'the cut text is a prefix of the text');
  if (cut) {
    assert.deepEqual(parts(kept), parts(text).slice(0, MAX_WORDS), 'the first 16 words, whole');
    assert.match(text.slice(kept.length), /^\s/u, 'it ends where the 16th word ends');
  } else {
    assert.equal(kept, text, 'nothing is cut');
  }
}

describe('cutWords (web/search-text.js) — the page cuts as the server reads', () => {
  test('MAX_WORDS is the server’s', () => {
    assert.equal(MAX_WORDS, 16);
    assert.equal(MAX_WORDS, SERVER_MAX_WORDS);
  });

  // E2: the server splits at /\s+/u. Each of these separates two words for it.
  const separators: ReadonlyArray<readonly [name: string, space: string]> = [
    ['a space', ' '],
    ['a tab', '\t'],
    ['a line break', '\n'],
    ['a carriage return and a line break', '\r\n'],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
    ['a no-break space', '\u00a0'],
    ['the ogham space mark', '\u1680'],
    ['an en quad', '\u2000'],
    ['a hair space', '\u200a'],
    ['the line separator', '\u2028'],
    ['the paragraph separator', '\u2029'],
    ['a narrow no-break space', '\u202f'],
    ['the medium mathematical space', '\u205f'],
    ['an ideographic space', '\u3000'],
    ['a byte order mark', '\ufeff'],
    ['a run of mixed white space', ' \t\u00a0\n\u3000'],
  ];
  for (const [name, space] of separators) {
    test(`${name} separates words, for the page as for the server`, () => {
      const text = `${words(MAX_WORDS + 1).join(space)}`;
      assert.equal(searchWords(`a${space}b`).length, 2, 'the server splits there');
      assert.deepEqual(cutWords(text), { text: words(MAX_WORDS).join(space), cut: true });
      assertParity(text);
      assertParity(`a${space}b`);
    });
  }

  // E2, ruled (task 90, C4): a character that cannot be seen and is no white space is part of a
  // word, for the page as for the server.
  const joiners: ReadonlyArray<readonly [name: string, joiner: string]> = [
    ['a zero-width space', '\u200b'],
    ['a zero-width joiner', '\u200d'],
    ['a control character', '\u0001'],
    ['DEL', '\u007f'],
    ['the next-line control (no white space in JavaScript)', '\u0085'],
    ['the Mongolian vowel separator (no longer white space)', '\u180e'],
  ];
  for (const [name, joiner] of joiners) {
    test(`${name} is part of a word, for the page as for the server`, () => {
      assert.deepEqual(searchWords(`a${joiner}b`), [`a${joiner}b`], 'one word for the server');
      // 17 words of which two are joined: 16 words, nothing to cut.
      const joined = words(MAX_WORDS + 1);
      const text = `${joined.slice(0, 2).join(joiner)} ${joined.slice(2).join(' ')}`;
      assert.deepEqual(cutWords(text), { text, cut: false });
      assertParity(text);
      // 18 words of which two are joined: 17, cut after the 16th.
      const more = words(MAX_WORDS + 2);
      const longer = `${more.slice(0, 2).join(joiner)} ${more.slice(2).join(' ')}`;
      assert.deepEqual(cutWords(longer), {
        text: `${more.slice(0, 2).join(joiner)} ${more.slice(2, MAX_WORDS + 1).join(' ')}`,
        cut: true,
      });
      assertParity(longer);
    });
  }

  const texts: ReadonlyArray<readonly [name: string, text: string, expected?: string]> = [
    ['empty', '', ''],
    ['only white space', ' \t\n\u00a0\u3000 ', ' \t\n\u00a0\u3000 '],
    ['one word', 'login', 'login'],
    ['16 words', words(16).join(' '), words(16).join(' ')],
    [
      '16 words and white space after them',
      `${words(16).join(' ')} \t`,
      `${words(16).join(' ')} \t`,
    ],
    ['17 words', words(17).join(' '), words(16).join(' ')],
    ['17 words and white space after them', `${words(17).join(' ')}  `, words(16).join(' ')],
    ['white space before 17 words', `\t ${words(17).join(' ')}`, `\t ${words(16).join(' ')}`],
    ['40 words', words(40).join('  '), words(16).join('  ')],
    ['a repeated word, 17 times', Array(17).fill('fix').join(' '), Array(16).fill('fix').join(' ')],
    [
      'one word in two cases, 18 times',
      Array(9).fill('Fix fix').join(' '),
      Array(8).fill('Fix fix').join(' '),
    ],
    ['a word of 100 units (the server counts its first 64)', 'x'.repeat(100), 'x'.repeat(100)],
    ['1,024 bytes of one word', 'a'.repeat(1024), 'a'.repeat(1024)],
    ['1,024 bytes of one word of two-byte characters', 'é'.repeat(512), 'é'.repeat(512)],
    ['1,024 bytes of one word of surrogate pairs', '😀'.repeat(256), '😀'.repeat(256)],
    // `İ` lower-cases to two units: the server cuts its word after lower-casing (64 units of
    // `i̇`); the page does not cut a word at all.
    ['a word of 40 İ (80 units once lower-cased)', 'İ'.repeat(40), 'İ'.repeat(40)],
    ['63 units and an İ', `${'a'.repeat(63)}İ`, `${'a'.repeat(63)}İ`],
    ['17 words of İ', Array(17).fill('İİİ').join(' '), Array(16).fill('İİİ').join(' ')],
    // A surrogate pair where the server cuts a word (unit 64) and where the page cuts the text.
    [
      'a word whose 64th unit begins a surrogate pair',
      `${'a'.repeat(63)}😀b`,
      `${'a'.repeat(63)}😀b`,
    ],
    [
      'a surrogate pair at the end of the 16th word, before the cut',
      `${words(15).join(' ')} w16😀 w17😀`,
      `${words(15).join(' ')} w16😀`,
    ],
    ['a surrogate pair right after the cut', `${words(16).join(' ')} 😀`, words(16).join(' ')],
    // The server cuts a long word itself (its first 64 units): the page keeps it whole, also in
    // a text it cuts.
    [
      'words of 100 units among the first 16, and a 17th',
      `${'x'.repeat(100)} ${words(14).join(' ')} ${'İ'.repeat(50)} w17`,
      `${'x'.repeat(100)} ${words(14).join(' ')} ${'İ'.repeat(50)}`,
    ],
    // The 16th word is the one a cut at the end of the 16th word could shorten.
    [
      'a 16th word of 100 units, and a 17th',
      `${words(15).join(' ')} ${'x'.repeat(100)} w17`,
      `${words(15).join(' ')} ${'x'.repeat(100)}`,
    ],
    [
      'a 16th word of 70 İ (140 units once lower-cased), and a 17th',
      `${words(15).join(' ')} ${'İ'.repeat(70)} w17`,
      `${words(15).join(' ')} ${'İ'.repeat(70)}`,
    ],
    ['a lone surrogate', `a\ud800 b \udc00c`, `a\ud800 b \udc00c`],
  ];
  for (const [name, text, expected] of texts) {
    test(`${name}: the server reads the cut text as the text`, () => {
      assertParity(text);
      if (expected !== undefined) {
        assert.deepEqual(cutWords(text), {
          text: expected,
          cut: parts(text).length > MAX_WORDS,
        });
      }
    });
  }

  test('17 words in 1,024 bytes: cut after the 16th', () => {
    const long = words(17).map((word) => word.padEnd(59, 'x'));
    const text = long.join(' ');
    assert.equal(utf8.encode(text).length, 17 * 59 + 16);
    assertParity(text);
    assert.deepEqual(cutWords(text), { text: long.slice(0, 16).join(' '), cut: true });
  });

  test('every UTF-16 unit separates words for the page exactly when it does for the server', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      const unit = String.fromCharCode(code);
      const text = words(MAX_WORDS + 1).join(unit);
      const separates = searchWords(`a${unit}b`).length === 2;
      assert.equal(cutWords(text).cut, separates, `U+${code.toString(16).padStart(4, '0')}`);
      assertParity(text);
    }
  });

  test('a cut text is not cut again', () => {
    for (const text of [words(17).join(' '), words(16).join(' '), `${words(30).join('\t')}\n`]) {
      const once = cutWords(text).text;
      assert.deepEqual(cutWords(once), { text: once, cut: false });
    }
  });

  test('generated texts of every kind of white space and word character agree', () => {
    // A seeded generator (mulberry32), so that a failure is the same at every run.
    let seed = 0x93_93_93;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = (from: readonly string[]): string =>
      from[Math.floor(random() * from.length)] ?? '';
    const space = [' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\u1680', '\u2000', '\u2009'];
    space.push('\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff');
    const letters = ['a', 'B', 'z', '1', '-', '#', '/', 'é', 'İ', 'ß', 'Σ', '😀', '\ud800'];
    letters.push('\udc00', '\u200b', '\u200d', '\u0001', '\u007f', '\u0085', '\u180e', '\u00ad');
    for (let n = 0; n < 5000; n += 1) {
      const length = Math.floor(random() * 90);
      let text = '';
      for (let i = 0; i < length; i += 1) {
        text += random() < 0.4 ? pick(space) : pick(letters);
      }
      assertParity(text);
    }
  });
});

describe('captionNeedText (G5, F9): what a closed caption says of the sessions it hides that need you', () => {
  test('none: nothing', () => {
    assert.equal(captionNeedText(0), '');
  });

  test('one and more: ` · 1 needs you`, ` · 2 need you`', () => {
    assert.equal(captionNeedText(1), ' · 1 needs you');
    assert.equal(captionNeedText(2), ' · 2 need you');
    assert.equal(captionNeedText(17), ' · 17 need you');
  });

  test('what is no count is none (a list from before the field, or a bad value)', () => {
    for (const bad of [undefined, null, -1, 1.5, Number.NaN, Infinity, '2']) {
      assert.equal(captionNeedText(bad as number), '', String(bad));
    }
  });
});

describe('groupCardText (F9): the pane while a closed caption is selected', () => {
  test('the name, the number of its sessions, the needs-you part, what opens it', () => {
    assert.deepEqual(groupCardText('DE-184319', 3, 1), {
      title: 'DE-184319',
      count: '3 sessions',
      need: ' · 1 needs you',
      hint: '→ or Enter opens the group',
    });
    assert.deepEqual(groupCardText('infra', 2, 0), {
      title: 'infra',
      count: '2 sessions',
      need: '',
      hint: '→ or Enter opens the group',
    });
    assert.equal(groupCardText('one', 1, 0).count, '1 session');
    assert.equal(groupCardText('many', 12, 3).need, ' · 3 need you');
  });

  test('the group is sanitised: escape sequences, controls, line breaks; it stays text', () => {
    assert.equal(
      groupCardText('\u001b[31mORB\u001b[0m-21\u001b]0;title\u0007', 2, 0).title,
      'ORB-21',
    );
    assert.equal(groupCardText('ORB\n2107\u202e\u0000', 2, 0).title, 'ORB 2107');
    assert.equal(groupCardText('<b>ORB</b> & <img src=x>', 2, 0).title, '<b>ORB</b> & <img src=x>');
  });

  test('a count that is no whole number is 0', () => {
    for (const bad of [undefined, -1, 1.5, Number.NaN]) {
      assert.equal(groupCardText('g', bad as number, 0).count, '0 sessions', String(bad));
    }
  });
});

describe('highlightParts (E9: a title with its found parts)', () => {
  /** The parts always join to the text, and none is empty. */
  function assertJoins(
    text: string,
    found: [number, number][],
  ): { text: string; found: boolean }[] {
    const got = highlightParts(text, found);
    assert.equal(got.map((part) => part.text).join(''), text);
    assert.ok(
      got.every((part) => part.text !== ''),
      'no part is empty',
    );
    return got;
  }

  test('two ranges: five parts that join to the text', () => {
    assert.deepEqual(
      assertJoins('fix the login page', [
        [0, 3],
        [8, 13],
      ]),
      [
        { text: 'fix', found: true },
        { text: ' the ', found: false },
        { text: 'login', found: true },
        { text: ' page', found: false },
      ],
    );
    assert.deepEqual(
      assertJoins('a fix the login page', [
        [2, 5],
        [10, 15],
      ]),
      [
        { text: 'a ', found: false },
        { text: 'fix', found: true },
        { text: ' the ', found: false },
        { text: 'login', found: true },
        { text: ' page', found: false },
      ],
    );
  });

  test('no range: one part', () => {
    assert.deepEqual(assertJoins('fix the login page', []), [
      { text: 'fix the login page', found: false },
    ]);
  });

  test('an empty text gives no part', () => {
    assert.deepEqual(assertJoins('', []), []);
    assert.deepEqual(assertJoins('', [[0, 3]]), []);
  });

  test('the whole text found: one marked part', () => {
    assert.deepEqual(assertJoins('login', [[0, 5]]), [{ text: 'login', found: true }]);
  });

  test('ranges out of order: one that starts before the last kept end is clamped or dropped', () => {
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [6, 8],
        [1, 3],
      ]),
      [
        { text: 'abcdef', found: false },
        { text: 'gh', found: true },
        { text: 'ij', found: false },
      ],
    );
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [4, 6],
        [2, 8],
      ]),
      [
        { text: 'abcd', found: false },
        { text: 'efgh', found: true },
        { text: 'ij', found: false },
      ],
    );
  });

  test('overlapping and touching ranges: one marked part', () => {
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [1, 5],
        [3, 8],
      ]),
      [
        { text: 'a', found: false },
        { text: 'bcdefgh', found: true },
        { text: 'ij', found: false },
      ],
    );
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [1, 3],
        [3, 5],
      ]),
      [
        { text: 'a', found: false },
        { text: 'bcde', found: true },
        { text: 'fghij', found: false },
      ],
    );
  });

  test('empty and reversed ranges are dropped', () => {
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [2, 2],
        [5, 3],
      ]),
      [{ text: 'abcdefghij', found: false }],
    );
  });

  test('a dropped range leaves no trace for the ranges after it', () => {
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [12, 15],
        [5, 5],
        [7, 6],
        [1, 3],
      ]),
      [
        { text: 'a', found: false },
        { text: 'bc', found: true },
        { text: 'defghij', found: false },
      ],
    );
  });

  test('past the end: clamped to the text, or dropped', () => {
    assert.deepEqual(assertJoins('abcdefghij', [[8, 99]]), [
      { text: 'abcdefgh', found: false },
      { text: 'ij', found: true },
    ]);
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [10, 12],
        [12, 15],
      ]),
      [{ text: 'abcdefghij', found: false }],
    );
  });

  test('negative: clamped to the start, or dropped', () => {
    assert.deepEqual(assertJoins('abcdefghij', [[-3, 2]]), [
      { text: 'ab', found: true },
      { text: 'cdefghij', found: false },
    ]);
    assert.deepEqual(assertJoins('abcdefghij', [[-5, -1]]), [{ text: 'abcdefghij', found: false }]);
  });

  test('a range that is not a pair of whole numbers (three of them too) is dropped', () => {
    assert.deepEqual(
      assertJoins('abcdefghij', [
        [Number.NaN, 3],
        [1, Number.POSITIVE_INFINITY],
        [1.5, 4],
        [0, 2, 9] as unknown as [number, number],
        [6, 8],
      ]),
      [
        { text: 'abcdef', found: false },
        { text: 'gh', found: true },
        { text: 'ij', found: false },
      ],
    );
  });

  test('ranges that are not an array of pairs: one part (the server’s answer is foreign input)', () => {
    const notRanges = [null, undefined, 'x', 3, [null], [[1]], [['1', '3']], [{ 0: 1, 1: 3 }]];
    for (const found of notRanges) {
      assert.deepEqual(highlightParts('abcdefghij', found as unknown as [number, number][]), [
        { text: 'abcdefghij', found: false },
      ]);
    }
  });

  test('a range never splits a surrogate pair: it marks less, never half a character', () => {
    // 'a😀b' is a, a pair (units 1 and 2), b.
    assert.deepEqual(assertJoins('a😀b', [[2, 4]]), [
      { text: 'a😀', found: false },
      { text: 'b', found: true },
    ]);
    assert.deepEqual(assertJoins('a😀b', [[0, 2]]), [
      { text: 'a', found: true },
      { text: '😀b', found: false },
    ]);
    assert.deepEqual(
      assertJoins('a😀b', [
        [2, 2],
        [1, 2],
        [2, 3],
      ]),
      [{ text: 'a😀b', found: false }],
    );
    assert.deepEqual(assertJoins('a😀b', [[1, 3]]), [
      { text: 'a', found: false },
      { text: '😀', found: true },
      { text: 'b', found: false },
    ]);
  });

  test('the parts are the text as it is: markup in a title stays text', () => {
    assert.deepEqual(
      assertJoins('<mark>&amp;</mark> fix', [
        [0, 6],
        [19, 22],
      ]),
      [
        { text: '<mark>', found: true },
        { text: '&amp;</mark> ', found: false },
        { text: 'fix', found: true },
      ],
    );
  });

  test('the server’s ranges (foundIn of task 90) mark the words of a search text', () => {
    const title = 'Fix the Login page: login again';
    const found = foundIn(title, searchWords('LOGIN fix'));
    assert.deepEqual(assertJoins(title, found), [
      { text: 'Fix', found: true },
      { text: ' the ', found: false },
      { text: 'Login', found: true },
      { text: ' page: ', found: false },
      { text: 'login', found: true },
      { text: ' again', found: false },
    ]);
  });
});

describe('rankHeading (E9)', () => {
  test('each rank of the switcher has its heading', () => {
    assert.equal(rankHeading('need'), 'Needs you');
    assert.equal(rankHeading('open'), 'Open');
    assert.equal(rankHeading('not-running'), 'Not running');
    assert.equal(rankHeading('done'), 'Done');
  });

  test('a rank it does not know: its own name, sanitised and trimmed; nothing for no text', () => {
    assert.equal(rankHeading(' later\u001b[1m '), 'later');
    assert.equal(rankHeading('constructor'), 'constructor');
    assert.equal(rankHeading('__proto__'), '__proto__');
    assert.equal(rankHeading(null as unknown as string), '');
    assert.equal(rankHeading(7 as unknown as string), '');
  });
});

describe('switcherFooter', () => {
  test('each action, without more', () => {
    assert.equal(switcherFooter('switch', 0), '↑ ↓ move · Enter switch · Esc close');
    assert.equal(switcherFooter('resume here', 0), '↑ ↓ move · Enter resume here · Esc close');
    assert.equal(switcherFooter('restore', 0), '↑ ↓ move · Enter restore · Esc close');
  });

  test('each action, with more', () => {
    assert.equal(
      switcherFooter('switch', 3),
      '↑ ↓ move · Enter switch · Esc close · 3 more: type to narrow',
    );
    assert.equal(
      switcherFooter('resume here', 1),
      '↑ ↓ move · Enter resume here · Esc close · 1 more: type to narrow',
    );
    assert.equal(
      switcherFooter('restore', 120),
      '↑ ↓ move · Enter restore · Esc close · 120 more: type to narrow',
    );
  });
});

describe('web/search-text.js is pure page code (plan 2.1, ruled for task 93)', () => {
  const source = readFileSync(new URL('../../web/search-text.js', import.meta.url), 'utf8');
  // The code without its comments (block comments, and lines that are a comment), so that a
  // comment may name what the code must not do. A `//` inside a line is left: it may be in a
  // string, and what follows it is code.
  const code = source.replaceAll(/\/\*[^]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

  test('it builds no pattern from a text: no RegExp, and match/matchAll/search take literals only', () => {
    assert.doesNotMatch(code, /\bRegExp\b/);
    assert.doesNotMatch(code, /\.(?:match|matchAll|search)\(\s*(?!\/)/);
    assert.doesNotMatch(code, /\[\s*['"`](?:match|matchAll|search)['"`]\s*\]/);
    assert.doesNotMatch(code, /\b(?:eval|Function)\s*\(/);
  });

  test('it logs nothing, touches no DOM, reads no clock, stores nothing, sends nothing', () => {
    assert.doesNotMatch(code, /\bconsole\b/);
    assert.doesNotMatch(code, /\b(?:document|window|innerHTML|outerHTML|insertAdjacentHTML)\b/);
    assert.doesNotMatch(code, /\b(?:Date|performance|setTimeout|setInterval|queueMicrotask)\b/);
    assert.doesNotMatch(code, /\b(?:localStorage|sessionStorage|indexedDB|navigator|location)\b/);
    assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|WebSocket|globalThis|self)\b/);
  });

  test('it imports sanitize of web/list-text.js and nothing else, nor passes a module on', () => {
    // Every statement that names a module: an import (a bare one too) or an export … from.
    const statements = [...code.matchAll(/^\s*(?:import\b|export\b[^;]*\bfrom\b)[^;]*;/gm)];
    assert.deepEqual(
      statements.map((found) => found[0].trim()),
      ["import { sanitize } from './list-text.js';"],
    );
    assert.doesNotMatch(code, /\bimport\s*\(/);
  });
});
