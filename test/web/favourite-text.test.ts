// The favourite flags' text (S2 12.6, follow-up F15): the page's split of the flags field, held to
// the server's splitFlags; whether a favourite's words stand in the field; the field with a
// favourite added and taken out; which texts may be saved, held to the server's refusals; a
// chip's words. node:test on web/favourite-text.js, which uses no DOM and no clock.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  FAVOURITE_LENGTH as SERVER_FAVOURITE_LENGTH,
  FAVOURITE_REFUSALS as SERVER_REFUSALS,
  favouriteRefusal as serverRefusal,
} from '../../src/window/favourites.ts';
import { splitFlags } from '../../src/window/flags.ts';
import { MAX_FAVOURITES as SERVER_MAX } from '../../src/window/protocol.ts';
import {
  CHIP_LENGTH,
  chipWords,
  FAVOURITE_LENGTH,
  FAVOURITE_REFUSALS,
  favouriteRefusal,
  flagWords,
  holdsFavourite,
  MAX_FAVOURITES,
  withFavourite,
  withoutFavourite,
} from '../../web/favourite-text.js';

/** Texts that cover splitFlags's rules: quotes, adjacency, every kind of white space, refusals. */
const SPLIT_CASES: readonly string[] = [
  '',
  '   ',
  '--model opus',
  '  --model    opus   --verbose  ',
  '--model\topus\n--verbose\r\n-c',
  '--a\u00a0--b\u2003--c\u3000--d\u2028--e\ufeff--f',
  "--append-system-prompt 'a b'",
  `"a 'b' c"`,
  `'say "hi"'`,
  "'  a   b  '",
  "a'b c'd",
  `--x "" ''`,
  "''",
  `""''""`,
  "a''",
  "'unclosed",
  "--model 'opus",
  '--x "a b',
  'a\0b',
  "'a\0'",
  "'unclosed \0",
  '--name 😀 x',
  '😀"😀 😀"😀',
  '-c',
  '--model=opus --x=1',
];

describe('flagWords: the words of splitFlags, with their places', () => {
  test('the same words, or the same refusal, as the server for every case', () => {
    for (const text of SPLIT_CASES) {
      const server = splitFlags(text);
      const page = flagWords(text);
      if (server.ok) {
        assert.equal(page.ok, true, JSON.stringify(text));
        assert.deepEqual(
          page.ok ? page.words.map((word) => word.text) : null,
          server.flags,
          JSON.stringify(text),
        );
      } else {
        assert.deepEqual(page, { ok: false, error: server.error }, JSON.stringify(text));
      }
    }
  });

  test('each place holds its word as typed: split again, it is that one word', () => {
    for (const text of SPLIT_CASES) {
      const page = flagWords(text);
      if (!page.ok) continue;
      let after = 0;
      for (const word of page.words) {
        assert.ok(word.start >= after && word.end > word.start, JSON.stringify(text));
        after = word.end;
        const again = splitFlags(text.slice(word.start, word.end));
        assert.deepEqual(again, { ok: true, flags: [word.text] }, JSON.stringify(text));
      }
    }
  });

  test("places count UTF-16 units: a word after an emoji starts where the text's index says", () => {
    const page = flagWords('😀 --x');
    assert.deepEqual(page, {
      ok: true,
      words: [
        { text: '😀', start: 0, end: 2 },
        { text: '--x', start: 3, end: 6 },
      ],
    });
  });
});

describe('holdsFavourite: the favourite stands as one run among the field’s words', () => {
  test('alone, at the start, in the middle and at the end of the field', () => {
    assert.equal(holdsFavourite('--model opus', '--model opus'), true);
    assert.equal(holdsFavourite('--model opus --verbose', '--model opus'), true);
    assert.equal(holdsFavourite('-d --model opus --verbose', '--model opus'), true);
    assert.equal(holdsFavourite('--verbose --model opus', '--model opus'), true);
  });

  test('by words, not by characters: white space and quoting do not matter', () => {
    assert.equal(holdsFavourite('  --model\t opus  ', '--model opus'), true);
    assert.equal(holdsFavourite('\'--model\' "opus"', '--model opus'), true);
    assert.equal(holdsFavourite('--model opus', "--model 'opus'"), true);
  });

  test('a value with spaces is one word: quoted either way it is held, unquoted it is not', () => {
    const favourite = "--append-system-prompt 'be brief'";
    assert.equal(holdsFavourite('--append-system-prompt "be brief" -c', favourite), true);
    assert.equal(holdsFavourite("--append-system-prompt 'be brief'", favourite), true);
    assert.equal(holdsFavourite('--append-system-prompt be brief', favourite), false);
    assert.equal(holdsFavourite("--append-system-prompt 'be  brief'", favourite), false);
  });

  test('a favourite that is the prefix of another: held as words, never as characters', () => {
    assert.equal(holdsFavourite('--model opus', '--model'), true, 'a run of one word');
    assert.equal(holdsFavourite('--model opus', '--mod'), false, 'a word is whole');
    assert.equal(holdsFavourite('--model', '--model opus'), false, 'the longer one is not held');
    assert.equal(holdsFavourite('--model opusx', '--model opus'), false);
  });

  test('the words in another order, or apart, are not a run', () => {
    assert.equal(holdsFavourite('opus --model', '--model opus'), false);
    assert.equal(holdsFavourite('--model -c opus', '--model opus'), false);
  });

  test('the same flag twice: held', () => {
    assert.equal(holdsFavourite('--verbose --verbose', '--verbose'), true);
    assert.equal(holdsFavourite('--verbose -c --verbose', '--verbose'), true);
  });

  test('a field that cannot be split holds no favourite', () => {
    assert.equal(holdsFavourite("--model opus '", '--model opus'), false);
    assert.equal(holdsFavourite('--model opus "x', '--model'), false);
    assert.equal(holdsFavourite('--model\0 opus', '--model'), false);
  });

  test('an empty field holds nothing', () => {
    assert.equal(holdsFavourite('', '--model opus'), false);
    assert.equal(holdsFavourite('   ', '--verbose'), false);
  });
});

describe('withFavourite: added at the end of the field, one space between', () => {
  test('to an empty or blank field: the favourite alone', () => {
    assert.equal(withFavourite('', '--model opus'), '--model opus');
    assert.equal(withFavourite('  \t', '--model opus'), '--model opus');
  });

  test('after the text: one space between; the rest as typed', () => {
    assert.equal(withFavourite('--verbose', '--model opus'), '--verbose --model opus');
    assert.equal(withFavourite('  -d   --verbose', '-c'), '  -d   --verbose -c');
  });

  test('white space at the end gives way to the one space', () => {
    assert.equal(withFavourite('--verbose   ', '-c'), '--verbose -c');
    assert.equal(withFavourite('--verbose\u00a0', '-c'), '--verbose -c');
  });

  test('to a field that cannot be split: added as text all the same', () => {
    assert.equal(withFavourite("--x 'a", '-c'), "--x 'a -c");
  });

  test('what it gives holds the favourite when the field could be split', () => {
    for (const field of ['', '--verbose', '--a "b c"  ']) {
      for (const favourite of ['--model opus', "--append-system-prompt 'a b'", '-c']) {
        assert.equal(holdsFavourite(withFavourite(field, favourite), favourite), true);
      }
    }
  });
});

describe('withoutFavourite: its run taken out, the rest as typed', () => {
  test('alone: the field is empty', () => {
    assert.equal(withoutFavourite('--model opus', '--model opus'), '');
    assert.equal(withoutFavourite('  --model opus  ', '--model opus'), '');
  });

  test('at the start: with the white space after it', () => {
    assert.equal(withoutFavourite('--model opus   --verbose', '--model opus'), '--verbose');
    assert.equal(withoutFavourite('  --model opus -c', '--model opus'), '  -c');
  });

  test('in the middle: with the white space after it; the rest keeps its spacing', () => {
    assert.equal(withoutFavourite('-d  --model opus\t--verbose', '--model opus'), '-d  --verbose');
  });

  test('at the end: with the white space before it', () => {
    assert.equal(withoutFavourite('-d  --verbose   --model opus', '--model opus'), '-d  --verbose');
    assert.equal(withoutFavourite('-d --model opus  ', '--model opus'), '-d  ');
  });

  test('quoted values go with their quotes, as they were typed', () => {
    const favourite = "--append-system-prompt 'be brief'";
    assert.equal(
      withoutFavourite('-c --append-system-prompt "be brief" --verbose', favourite),
      '-c --verbose',
    );
    assert.equal(withoutFavourite(`--x "a b" -c`, '-c'), `--x "a b"`);
  });

  test('the same flag twice: both go, so that its chip is off after the click', () => {
    assert.equal(withoutFavourite('--verbose -c --verbose', '--verbose'), '-c');
    assert.equal(
      holdsFavourite(withoutFavourite('--verbose --verbose', '--verbose'), '--verbose'),
      false,
    );
  });

  test('a run that forms when one is taken out goes too', () => {
    assert.equal(withoutFavourite('a a b b', 'a b'), '');
    assert.equal(withoutFavourite('x a a b b y', 'a b'), 'x y');
  });

  test('a favourite that is the prefix of another takes out only its own words', () => {
    assert.equal(withoutFavourite('--model opus -c', '--model'), 'opus -c');
    assert.equal(withoutFavourite('--model opus --model', '--model opus'), '--model');
    assert.equal(withoutFavourite('--modelx opus', '--model'), '--modelx opus');
  });

  test('a field that does not hold it, or cannot be split, comes back as it is', () => {
    assert.equal(withoutFavourite('  -c   --verbose ', '--model opus'), '  -c   --verbose ');
    assert.equal(withoutFavourite("--model opus 'x", '--model opus'), "--model opus 'x");
  });

  test('added, then taken out: the field as it was, but for the white space at its end', () => {
    for (const field of ['', '--verbose', '  -d   "a b"']) {
      for (const favourite of ['--model opus', "--append-system-prompt 'a b'"]) {
        assert.equal(withoutFavourite(withFavourite(field, favourite), favourite), field);
      }
    }
  });
});

describe('favouriteRefusal: which texts may be saved', () => {
  test('a good text: null; it is judged trimmed', () => {
    assert.equal(favouriteRefusal('--model opus', []), null);
    assert.equal(favouriteRefusal('  --model opus \t', ['--verbose']), null);
  });

  test('empty or blank: refused with its words', () => {
    assert.equal(favouriteRefusal('', []), FAVOURITE_REFUSALS.empty);
    assert.equal(favouriteRefusal(' \t\u00a0', []), FAVOURITE_REFUSALS.empty);
    assert.equal(FAVOURITE_REFUSALS.empty, 'there are no flags to save');
  });

  test("not splittable: refused with splitFlags's words", () => {
    assert.equal(favouriteRefusal("--model 'opus", []), "the flags have an unclosed '");
    assert.equal(favouriteRefusal('--x "a', []), 'the flags have an unclosed "');
    assert.equal(favouriteRefusal('--x\0', []), 'the flags contain a NUL character');
  });

  test('a line break, another control character or a bidirectional control: refused with its words', () => {
    for (const text of [
      '--model\nopus',
      '--x\ry',
      '--model\topus',
      '--x \x1b[31mred',
      '--x\u0007',
      '--x\u007f',
      '--x\u0085y',
      '--x\u009b',
      '--x\u202ey',
      '--x\u2066y',
      '--x\u2028y',
      '--x\u2029y',
    ]) {
      assert.equal(favouriteRefusal(text, []), FAVOURITE_REFUSALS.control, JSON.stringify(text));
    }
    assert.equal(
      FAVOURITE_REFUSALS.control,
      'the flags contain a line break or another control character',
    );
    assert.equal(
      favouriteRefusal('--x\0', []),
      'the flags contain a NUL character',
      "splitFlags's",
    );
    assert.equal(favouriteRefusal("'\u0001", []), "the flags have an unclosed '", 'split first');
    assert.equal(favouriteRefusal(`\u0001${'a'.repeat(300)}`, []), FAVOURITE_REFUSALS.control);
    assert.equal(favouriteRefusal(' --x\t', []), null, 'white space at the ends is trimmed');
    assert.equal(
      favouriteRefusal('--x \u00a0 \u2003 y', []),
      null,
      'other white space is no control',
    );
  });

  test('at most 200 characters, counted as characters (an emoji is one), after the trim', () => {
    assert.equal(favouriteRefusal(`--x ${'a'.repeat(196)}`, []), null);
    assert.equal(favouriteRefusal(`--x ${'a'.repeat(197)}`, []), FAVOURITE_REFUSALS.tooLong);
    assert.equal(favouriteRefusal(`--x ${'😀'.repeat(196)}`, []), null);
    assert.equal(favouriteRefusal(`   --x ${'a'.repeat(196)}   `, []), null);
    assert.equal(FAVOURITE_REFUSALS.tooLong, 'a favourite is at most 200 characters');
  });

  test('already a favourite: the same words, however they are spaced or quoted', () => {
    const favourites = ['--model opus', "--append-system-prompt 'be brief'"];
    assert.equal(favouriteRefusal('--model opus', favourites), FAVOURITE_REFUSALS.known);
    assert.equal(favouriteRefusal(' --model   "opus"', favourites), FAVOURITE_REFUSALS.known);
    assert.equal(
      favouriteRefusal('--append-system-prompt "be brief"', favourites),
      FAVOURITE_REFUSALS.known,
    );
    assert.equal(favouriteRefusal('--model opus -c', favourites), null, 'more words: another one');
    assert.equal(favouriteRefusal('--model', favourites), null, 'fewer words: another one');
    assert.equal(FAVOURITE_REFUSALS.known, 'these flags are a favourite already');
  });

  test('a thirteenth one: refused; the twelfth is not', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `--f${i}`);
    assert.equal(favouriteRefusal('--new', eleven), null);
    assert.equal(favouriteRefusal('--new', [...eleven, '--f11']), FAVOURITE_REFUSALS.full);
    assert.equal(FAVOURITE_REFUSALS.full, 'there are 12 favourites already; remove one first');
  });

  test("the server's order: unclosed before too long, too long before known, known before full", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `--f${i}`);
    assert.equal(favouriteRefusal(`'${'a'.repeat(300)}`, []), "the flags have an unclosed '");
    assert.equal(favouriteRefusal('a'.repeat(201), ['a'.repeat(201)]), FAVOURITE_REFUSALS.tooLong);
    assert.equal(favouriteRefusal('--f3', twelve), FAVOURITE_REFUSALS.known);
  });
});

describe("held to the server's rules (src/window/favourites.ts)", () => {
  test('the same limits and the same words', () => {
    assert.equal(MAX_FAVOURITES, SERVER_MAX);
    assert.equal(FAVOURITE_LENGTH, SERVER_FAVOURITE_LENGTH);
    assert.deepEqual(FAVOURITE_REFUSALS, SERVER_REFUSALS);
  });

  test("every text the page refuses, the server refuses with the same words; one the page takes, the server takes or refuses with prepareNew's words", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `--f${i}`);
    const lists: readonly string[][] = [[], ['--model opus'], twelve];
    const texts = [
      ...SPLIT_CASES,
      '--model  opus',
      '--f3',
      'a'.repeat(201),
      `--x ${'😀'.repeat(196)}`,
      '--resume x',
      '-c',
      '-cp',
      '--name x',
      '-n x',
      '--model opus --continue',
      '--worktree',
    ];
    for (const favourites of lists) {
      for (const text of texts) {
        const page = favouriteRefusal(text, favourites);
        const server = serverRefusal(text, favourites);
        const what = `${JSON.stringify(text)} beside ${favourites.length}`;
        if (page !== null) {
          assert.equal(server, page, what);
        } else if (server !== null) {
          assert.match(server, /^cannot pass .* to claude: /, what);
        }
      }
    }
  });
});

describe('chipWords: the favourite cut at 28 characters', () => {
  test('28 characters or fewer: as it is', () => {
    assert.equal(chipWords('--model opus'), '--model opus');
    assert.equal(chipWords('a'.repeat(28)), 'a'.repeat(28));
    assert.equal(CHIP_LENGTH, 28);
  });

  test('longer: 27 characters and `…`, 28 in all', () => {
    assert.equal(chipWords('a'.repeat(29)), `${'a'.repeat(27)}…`);
    assert.equal(chipWords(`--append-system-prompt 'be brief'`), "--append-system-prompt 'be …");
  });

  test('characters, not UTF-16 units: an emoji is never cut in half', () => {
    assert.equal(chipWords('😀'.repeat(28)), '😀'.repeat(28));
    assert.equal(chipWords('😀'.repeat(29)), `${'😀'.repeat(27)}…`);
  });
});
