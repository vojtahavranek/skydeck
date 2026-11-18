// The favourite flags of the new form (S2 12.6, follow-up F15): the page's split of the flags
// field, whether a favourite's words stand in it, the field with a favourite added or taken out,
// which texts may be saved as one, and a chip's words; web/favourites.js draws the chips and the
// ★. Pure: no DOM and no clock, so that node:test and the root type check load it
// (test/web/favourite-text.test.ts).
//
// `flagWords` is a copy of src/window/flags.ts's `splitFlags` (web/ never imports code from src/)
// that also gives each word's place in the text; the test holds the two to the same words and the
// same refusals. `favouriteRefusal` is the server's rule (src/window/favourites.ts) in the same
// order and words, held equal by the test, but for its last step: the flags `skydeck new` refuses
// (prepareNew's rule, over the flag table of src/claude/launch.ts) are the server's alone, which
// answers a save of them with prepareNew's words.

/** The most favourites skydeck keeps (protocol.ts's MAX_FAVOURITES, held equal by the test). */
export const MAX_FAVOURITES = 12;
/** A favourite holds at most this many characters (code points) once trimmed (the server's). */
export const FAVOURITE_LENGTH = 200;
/** A chip shows at most this many characters of its favourite, `…` the last when it is cut. */
export const CHIP_LENGTH = 28;

/** The refusals' words (the server's FAVOURITE_REFUSALS, held equal by the test). */
export const FAVOURITE_REFUSALS = {
  empty: 'there are no flags to save',
  control: 'the flags contain a line break or another control character',
  tooLong: `a favourite is at most ${FAVOURITE_LENGTH} characters`,
  known: 'these flags are a favourite already',
  full: `there are ${MAX_FAVOURITES} favourites already; remove one first`,
};

/** What a favourite never holds (ruled on review 2 of F15): a line break (U+2028 and U+2029
 *  too) or another control character (C0, DEL, C1) and the bidirectional controls — what design
 *  7.4's sanitiser takes away or changes —, so that a chip shows the favourite as it is. The
 *  server's CONTROL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Separates words outside quotes, as in splitFlags: any whitespace. */
const SEPARATOR = /^\s$/;

/**
 * @typedef {object} FlagWord
 * @property {string} text the word, as splitFlags gives it
 * @property {number} start its first UTF-16 index in the text, an opening quote included
 * @property {number} end the index after its last character, a closing quote included
 */

/**
 * splitFlags's words of `text`, each with its place: words separated by any whitespace, '…' and
 * "…" group words, no escapes; quoted and unquoted parts next to each other form one word, and a
 * quoted empty text is an empty word. An unclosed quote, then a NUL anywhere, are refused with
 * splitFlags's words.
 * @param {string} text
 * @returns {{ ok: true, words: FlagWord[] } | { ok: false, error: string }}
 */
export function flagWords(text) {
  /** @type {FlagWord[]} */
  const words = [];
  let word = '';
  let start = -1; // where the current word began; -1 between words
  /** @type {string | null} */
  let quote = null;
  let at = 0;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
    } else if (SEPARATOR.test(char)) {
      if (start >= 0) {
        words.push({ text: word, start, end: at });
        word = '';
        start = -1;
      }
    } else {
      if (start < 0) {
        start = at;
      }
      if (char === "'" || char === '"') {
        quote = char;
      } else {
        word += char;
      }
    }
    at += char.length;
  }
  if (quote !== null) {
    return { ok: false, error: `the flags have an unclosed ${quote}` };
  }
  if (text.includes('\0')) {
    return { ok: false, error: 'the flags contain a NUL character' };
  }
  if (start >= 0) {
    words.push({ text: word, start, end: at });
  }
  return { ok: true, words };
}

/**
 * @param {string} text
 * @returns {string[] | null} its words; null when it cannot be split
 */
function wordsOf(text) {
  const split = flagWords(text);
  return split.ok ? split.words.map((word) => word.text) : null;
}

/**
 * Where the first run of `wanted` stands among `words`: the index of its first word; -1 when it
 * stands nowhere, or holds no word.
 * @param {readonly string[]} words
 * @param {readonly string[]} wanted
 * @returns {number}
 */
function runAt(words, wanted) {
  if (wanted.length > 0) {
    for (let i = 0; i + wanted.length <= words.length; i++) {
      if (wanted.every((one, j) => words[i + j] === one)) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Whether the field holds the favourite: its words stand as one run among the field's words, each
 * split as splitFlags splits. A field that cannot be split holds none.
 * @param {string} field
 * @param {string} favourite
 * @returns {boolean}
 */
export function holdsFavourite(field, favourite) {
  const words = wordsOf(field);
  const wanted = wordsOf(favourite);
  return words !== null && wanted !== null && runAt(words, wanted) >= 0;
}

/**
 * The field with the favourite's text at its end, one space between: white space at the field's
 * end gives way to that space, and a blank field becomes the favourite's text alone. A field that
 * cannot be split gets it all the same, as text.
 * @param {string} field
 * @param {string} favourite
 * @returns {string}
 */
export function withFavourite(field, favourite) {
  const kept = field.replace(/\s+$/, '');
  return kept === '' ? favourite : `${kept} ${favourite}`;
}

/**
 * The field with the favourite's runs taken out, the first first, until none is left (so that its
 * chip is off after the click, also when a run forms where one was taken out): a run goes with the
 * white space after it, or when nothing follows it with the white space before it; when it was
 * all the field held, the field is empty. Everything else stays as typed. A field that holds no
 * run of it, or cannot be split, comes back as it is.
 * @param {string} field
 * @param {string} favourite
 * @returns {string}
 */
export function withoutFavourite(field, favourite) {
  const wanted = wordsOf(favourite) ?? [];
  let text = field;
  for (;;) {
    const split = flagWords(text);
    const at = split.ok
      ? runAt(
          split.words.map((word) => word.text),
          wanted,
        )
      : -1;
    if (!split.ok || at < 0) {
      return text;
    }
    const first = /** @type {FlagWord} */ (split.words[at]);
    const last = /** @type {FlagWord} */ (split.words[at + wanted.length - 1]);
    const next = split.words[at + wanted.length];
    const before = split.words[at - 1];
    if (next !== undefined) {
      text = text.slice(0, first.start) + text.slice(next.start);
    } else if (before !== undefined) {
      text = text.slice(0, before.end) + text.slice(last.end);
    } else {
      return '';
    }
  }
}

/**
 * Whether two texts are the same flags: both split, the same words in the same order.
 * @param {string} one
 * @param {string} other
 * @returns {boolean}
 */
function sameFlags(one, other) {
  const a = wordsOf(one);
  const b = wordsOf(other);
  return a !== null && b !== null && a.length === b.length && a.every((word, i) => word === b[i]);
}

/**
 * Why `text` cannot be saved as one more favourite beside `favourites`, in the server's words and
 * order; null when the page knows of no reason (the server refuses the flags `skydeck new` refuses
 * too). Judged on the text trimmed: empty; splitFlags refuses it; it holds a line break or another
 * control character (CONTROL); longer than FAVOURITE_LENGTH characters; the same words as a
 * favourite; MAX_FAVOURITES favourites already.
 * @param {string} text
 * @param {readonly string[]} favourites
 * @returns {string | null}
 */
export function favouriteRefusal(text, favourites) {
  const favourite = text.trim();
  if (favourite === '') {
    return FAVOURITE_REFUSALS.empty;
  }
  const split = flagWords(favourite);
  if (!split.ok) {
    return split.error;
  }
  if (CONTROL.test(favourite)) {
    return FAVOURITE_REFUSALS.control;
  }
  if ([...favourite].length > FAVOURITE_LENGTH) {
    return FAVOURITE_REFUSALS.tooLong;
  }
  if (favourites.some((one) => sameFlags(one, favourite))) {
    return FAVOURITE_REFUSALS.known;
  }
  return favourites.length >= MAX_FAVOURITES ? FAVOURITE_REFUSALS.full : null;
}

/**
 * A chip's words: the favourite cut at CHIP_LENGTH characters (code points, never inside one), the
 * last of them `…` when it was longer.
 * @param {string} favourite
 * @returns {string}
 */
export function chipWords(favourite) {
  const chars = [...favourite];
  return chars.length <= CHIP_LENGTH ? favourite : `${chars.slice(0, CHIP_LENGTH - 1).join('')}…`;
}
