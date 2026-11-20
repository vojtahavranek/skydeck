// The header's and the pull-request dialog's text (S2 12.3, 12.5; plan D task 38, D11–D13): a
// pull request's words in the header's line and in the dialog, the fold's text, "opened <time> ·
// last active <age>", the title's source, the note's line. node:test on web/header-text.js, which
// uses no DOM and no clock.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PrPayload, RowPayload, SelectedPayload } from '../../src/window/protocol.ts';
import {
  ERROR_MAX,
  foldText,
  noteLine,
  prItemParts,
  prItemText,
  prItemTip,
  prLineParts,
  prLineText,
  prName,
  prLineTip,
  splitPrs,
  STARTED_WITH_MAX,
  startedWithText,
  ticketChip,
  ticketField,
  timesText,
  titleSourceText,
} from '../../web/header-text.js';
import { chipText } from '../../web/list-text.js';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
const DAY = 24n * HOUR;
const NOW = 1_794_474_000_000_000_000n;
const now = String(NOW);
const ago = (ns: bigint): string => String(NOW - ns);
const ID = '11111111-2222-4333-8444-555555555555';

function pr(level: string, over: Partial<PrPayload> = {}): PrPayload {
  return {
    url: 'https://github.com/acme/web/pull/7',
    repo: 'acme/web',
    number: 7,
    title: 'Fix the retry',
    level,
    error: null,
    okAtNs: ago(4n * MIN),
    ...over,
  };
}

function row(over: Partial<RowPayload> = {}): RowPayload {
  return {
    id: ID,
    shortId: ID.slice(0, 8),
    title: 'Fix the login page',
    titleSource: 'generated',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: ago(2n * DAY),
    lastActivityNs: ago(2n * DAY),
    dir: '/home/u/project',
    marks: [],
    hasNote: false,
    noteHead: [],
    done: false,
    prs: [],
    chip: null,
    terminal: null,
    slot: null,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
    ...over,
  };
}

function selected(note: string | null, noteTooLong = false): SelectedPayload {
  return {
    sessionId: ID,
    command: null,
    flagsKnown: true,
    unknownFlags: [],
    launchFlags: [],
    ended: null,
    expiring: false,
    expired: false,
    note,
    noteTooLong,
    ticketUrl: null,
    ticket: null,
    ticketKeys: false,
  };
}

/** `selected` with the flags of follow-up F16. */
function flagged(launchFlags: unknown, unknownFlags: unknown = []): SelectedPayload {
  return { ...selected(null), launchFlags, unknownFlags } as SelectedPayload;
}

/** Every level of design 7.3 and its words in the dialog (D13). */
const LINE_WORDS = [
  ['unfetched', 'not fetched'],
  ['checks-failing', 'checks failing'],
  ['changes-requested', 'changes requested'],
  ['checks-pending', 'checks pending'],
  ['review-required', 'review required'],
  ['draft', 'draft'],
  ['approved-green', 'approved, green'],
  ['merged', 'merged'],
  ['closed', 'closed'],
] as const;

describe('prName: a pull request by its repository and number (the toast of ×, D13)', () => {
  test('`owner/repo #7`, the repository sanitised', () => {
    assert.equal(prName(pr('draft')), 'acme/web #7');
    assert.equal(
      prName(pr('draft', { repo: 'ac\x1b[1mme/web\u0007', number: 12 })),
      'acme/web #12',
    );
  });
});

describe("prItemText: an open pull request in the header's line (S2 12.5)", () => {
  test("the repository, the number and the chip's own words for its state (S2 12.3)", () => {
    assert.equal(prItemText(pr('checks-failing')), 'acme/web #7 · failing');
    for (const level of [
      'cant-read',
      'unfetched',
      'checks-failing',
      'changes-requested',
      'checks-pending',
      'review-required',
      'draft',
      'approved-green',
    ]) {
      // One implementation of the words: the list's chip of one pull request of that level.
      const words = chipText({ level, open: 1, merged: 0 }).replace(/^PR · /, '');
      assert.equal(prItemText(pr(level)), `acme/web #7 · ${words}`, level);
    }
  });

  test('a repository or a level with an escape sequence or a control character is sanitised', () => {
    assert.equal(
      prItemText(pr('later\x1b[31m-level', { repo: 'ac\x1b[31mme/w\u0007eb' })),
      'acme/web #7 · later-level',
    );
  });
});

describe('prLineText: a pull request on its line of the dialog (D13)', () => {
  test('every level in its words, then `checked <age> ago` once read; a merged or closed one says no age', () => {
    for (const [level, words] of LINE_WORDS) {
      const final = level === 'merged' || level === 'closed';
      assert.equal(
        prLineText(pr(level), now),
        `acme/web #7 · ${words}${final ? '' : ' · checked 4m ago'}`,
        level,
      );
    }
  });

  test('never read: no age (a pull request not fetched yet has none)', () => {
    assert.equal(prLineText(pr('unfetched', { okAtNs: null }), now), 'acme/web #7 · not fetched');
    assert.equal(
      prLineText(pr('approved-green', { okAtNs: null }), now),
      'acme/web #7 · approved, green',
    );
  });

  test("can't read: when it was last read, `never read` without a read, then its error", () => {
    assert.equal(
      prLineText(pr('cant-read', { okAtNs: ago(3n * HOUR), error: 'gh: HTTP 502' }), now),
      "acme/web #7 · can't read · last read 3h ago · gh: HTTP 502",
    );
    assert.equal(
      prLineText(pr('cant-read', { okAtNs: null, error: 'gh is not installed' }), now),
      "acme/web #7 · can't read · never read · gh is not installed",
    );
    assert.equal(
      prLineText(pr('cant-read', { okAtNs: null, error: null }), now),
      "acme/web #7 · can't read · never read",
    );
  });

  test('an age counts from `now` as the list counts it (A18): 4m, then 5m a minute later', () => {
    const p = pr('draft', { okAtNs: ago(4n * MIN + 59n * SEC) });
    assert.equal(prLineText(p, now), 'acme/web #7 · draft · checked 4m ago');
    assert.equal(prLineText(p, String(NOW + SEC)), 'acme/web #7 · draft · checked 5m ago');
  });

  test('a time that cannot be read gives no age, not a wrong one', () => {
    assert.equal(prLineText(pr('draft', { okAtNs: 'soon' }), now), 'acme/web #7 · draft');
    assert.equal(
      prLineText(pr('cant-read', { okAtNs: 'soon', error: 'x' }), now),
      "acme/web #7 · can't read · x",
    );
  });

  test(`an error is cut in the dialog to ${String(120)} units with …, never inside a surrogate pair; whole when asked`, () => {
    assert.equal(ERROR_MAX, 120);
    const long = `gh: ${'e'.repeat(300)}`;
    const line = prLineText(pr('cant-read', { okAtNs: null, error: long }), now);
    const error = line.split(' · ').at(-1) ?? '';
    assert.equal(error.length, ERROR_MAX);
    assert.equal(error, `${long.slice(0, ERROR_MAX - 1)}…`);
    assert.equal(
      prLineText(pr('cant-read', { okAtNs: null, error: long }), now, false),
      `acme/web #7 · can't read · never read · ${long}`,
    );
    // An emoji across the cut: the pair is dropped whole, not split.
    const pair = `${'a'.repeat(ERROR_MAX - 2)}😀tail`;
    const cut = prLineText(pr('cant-read', { okAtNs: null, error: pair }), now)
      .split(' · ')
      .at(-1);
    assert.equal(cut, `${'a'.repeat(ERROR_MAX - 2)}…`);
    assert.ok(cut?.isWellFormed());
    // At the limit nothing is cut.
    const exact = 'x'.repeat(ERROR_MAX);
    assert.equal(
      prLineText(pr('cant-read', { okAtNs: null, error: exact }), now)
        .split(' · ')
        .at(-1),
      exact,
    );
  });

  test('an unknown level is shown as sent, sanitised', () => {
    assert.equal(
      prLineText(pr('later\x1b[31m-level'), now),
      'acme/web #7 · later-level · checked 4m ago',
    );
  });

  test('a surrogate pair that ends right before the cut is kept whole', () => {
    const before = `${'a'.repeat(ERROR_MAX - 3)}😀tail`;
    const cut = prLineText(pr('cant-read', { okAtNs: null, error: before }), now)
      .split(' · ')
      .at(-1);
    assert.equal(cut, `${'a'.repeat(ERROR_MAX - 3)}😀…`);
  });

  test('a repository or an error with an escape sequence is sanitised', () => {
    assert.equal(
      prLineText(
        pr('cant-read', {
          repo: 'acme/\x1b]8;;http://x\x07web',
          okAtNs: null,
          error: 'gh: \x1b[31mred\x1b[0m\nsecond',
        }),
        now,
      ),
      "acme/web #7 · can't read · never read · gh: red second",
    );
  });
});

describe("prItemParts and prLineParts: the state's words apart, for their tint (follow-up F4)", () => {
  /** Every level of design 7.3, one the page does not know (with an escape), and none. */
  const LEVELS = [
    'cant-read',
    ...LINE_WORDS.map(([level]) => level),
    'later\x1b[31m-level',
    '',
    'constructor',
  ];
  const KNOWN = new Set(['cant-read', ...LINE_WORDS.map(([level]) => level)]);

  test("an item: its name and separator, then the state's words; together exactly prItemText", () => {
    for (const level of LEVELS) {
      const parts = prItemParts(pr(level));
      assert.equal(parts.name + parts.state, prItemText(pr(level)), level);
      assert.equal(parts.name, 'acme/web #7 · ', level);
      assert.equal(parts.level, KNOWN.has(level) ? level : '', level);
    }
    assert.equal(prItemParts(pr('checks-failing')).state, 'failing');
    assert.equal(prItemParts(pr('later\x1b[31m-level')).state, 'later-level');
  });

  test("a line: its head, the state's words, its tail; together exactly prLineText, the error cut or whole", () => {
    const variants: Partial<PrPayload>[] = [
      {},
      { okAtNs: null },
      { okAtNs: 'soon' },
      { okAtNs: ago(3n * HOUR), error: 'gh: HTTP 502' },
      { okAtNs: null, error: `gh: ${'e'.repeat(300)}` },
      { okAtNs: 'soon', error: 'x' },
    ];
    for (const level of LEVELS) {
      for (const over of variants) {
        for (const cutError of [true, false]) {
          const given = pr(level, over);
          const parts = prLineParts(given, now, cutError);
          const what = `${JSON.stringify(level)} ${JSON.stringify(over)} ${String(cutError)}`;
          assert.equal(
            parts.head + parts.state + parts.tail,
            prLineText(given, now, cutError),
            what,
          );
          assert.equal(parts.level, KNOWN.has(level) ? level : '', what);
        }
      }
    }
    for (const [level, words] of LINE_WORDS) {
      const parts = prLineParts(pr(level), now);
      assert.deepEqual([parts.head, parts.state], ['acme/web #7 · ', words], level);
    }
    assert.deepEqual(prLineParts(pr('draft'), now), {
      head: 'acme/web #7 · ',
      state: 'draft',
      tail: ' · checked 4m ago',
      level: 'draft',
    });
    assert.deepEqual(prLineParts(pr('', { okAtNs: null }), now), {
      head: 'acme/web #7',
      state: '',
      tail: '',
      level: '',
    });
  });
});

describe("the tooltips: the dialog line's and the header item's", () => {
  test("the dialog line's tooltip is the title; with the error that the line cut, the whole error after it", () => {
    assert.equal(prLineTip(pr('draft')), 'Fix the retry');
    assert.equal(prLineTip(pr('draft', { title: null })), '');
    const long = 'z'.repeat(ERROR_MAX + 1);
    assert.equal(prLineTip(pr('cant-read', { error: long })), `Fix the retry\n${long}`);
    assert.equal(prLineTip(pr('cant-read', { error: 'short', title: null })), '');
    assert.equal(
      prLineTip(pr('draft', { title: 'a <b>title</b> \x1b[1mbold' })),
      'a <b>title</b> bold',
    );
  });

  test("the header item's tooltip is the dialog's words with the error whole, then the title", () => {
    const long = 'z'.repeat(ERROR_MAX + 1);
    assert.equal(
      prItemTip(pr('cant-read', { okAtNs: ago(3n * HOUR), error: long }), now),
      `acme/web #7 · can't read · last read 3h ago · ${long}\nFix the retry`,
    );
    assert.equal(
      prItemTip(pr('checks-failing', { title: null }), now),
      'acme/web #7 · checks failing · checked 4m ago',
    );
  });
});

describe('splitPrs and foldText: the open ones, and the fold of the merged and closed ones (D13)', () => {
  test('the open ones (not known to be merged or closed) and the finished ones, each in the order sent', () => {
    const prs = [
      pr('merged', { number: 1 }),
      pr('cant-read', { number: 2 }),
      pr('closed', { number: 3 }),
      pr('unfetched', { number: 4 }),
      pr('merged', { number: 5 }),
    ];
    const { open, finished } = splitPrs(prs);
    assert.deepEqual(
      open.map((p) => p.number),
      [2, 4],
    );
    assert.deepEqual(
      finished.map((p) => p.number),
      [1, 3, 5],
    );
    assert.deepEqual(splitPrs([]), { open: [], finished: [] });
  });

  test('`30 merged`, `30 merged, 2 closed`, `1 closed`, with ▸ folded and ▾ unfolded; nothing for none', () => {
    assert.equal(foldText(30, 0, false), '30 merged ▸');
    assert.equal(foldText(30, 2, false), '30 merged, 2 closed ▸');
    assert.equal(foldText(0, 1, false), '1 closed ▸');
    assert.equal(foldText(30, 2, true), '30 merged, 2 closed ▾');
    assert.equal(foldText(0, 0, false), '');
    assert.equal(foldText(0, 0, true), '');
  });
});

describe('timesText: "opened <time> · last active <age>" (S2 12.5, D11)', () => {
  test('with a terminal of the window: when it opened, then the age of the last activity', () => {
    assert.equal(
      timesText('today at 14:02', ago(3n * MIN), now),
      'opened today at 14:02 · last active 3m',
    );
  });

  test('without one: the last activity only', () => {
    assert.equal(timesText('', ago(2n * DAY), now), 'last active 2d');
  });

  test('the age counts on with `now`: 1m, then 2m', () => {
    const last = ago(119n * SEC);
    assert.equal(timesText('', last, now), 'last active 1m');
    assert.equal(timesText('', last, String(NOW + SEC)), 'last active 2m');
  });

  test('a time that cannot be read gives no age', () => {
    assert.equal(timesText('', 'later', now), '');
    assert.equal(timesText('today at 14:02', 'later', now), 'opened today at 14:02');
  });
});

describe("titleSourceText: where the title comes from (S2 12.5, D11; design 7.1's order)", () => {
  test('each source in words; an unknown one says nothing', () => {
    assert.equal(titleSourceText('label'), 'title: your label');
    assert.equal(titleSourceText('name'), "title: Claude Code's name");
    assert.equal(titleSourceText('generated'), "title: Claude Code's summary");
    assert.equal(titleSourceText('fallback'), 'title: start time and folder');
    assert.equal(titleSourceText('summary'), '');
    assert.equal(titleSourceText('<b>x</b>'), '');
  });
});

describe("noteLine: the note's line of the header (S2 12.5, D12)", () => {
  test('no note: the hint, marked empty', () => {
    assert.deepEqual(noteLine(row(), null), { text: 'no note', empty: true });
  });

  test('one line: that line; several: the first and …', () => {
    assert.deepEqual(noteLine(row({ hasNote: true, noteHead: ['only'] }), null), {
      text: 'only',
      empty: false,
    });
    assert.deepEqual(noteLine(row({ hasNote: true, noteHead: ['first', 'second'] }), null), {
      text: 'first …',
      empty: false,
    });
  });

  test("the whole note of `selected` decides whether there is more: a line after blank ones too (the list's head drops those)", () => {
    const note = 'first\n\n\n\nfifth';
    const r = row({ hasNote: true, noteHead: ['first'] });
    assert.deepEqual(noteLine(r, selected(note)), { text: 'first …', empty: false });
    assert.deepEqual(noteLine(r, selected('first\r\n\r\n  \n')), { text: 'first', empty: false });
    assert.deepEqual(noteLine(r, selected('\n\nfirst')), { text: 'first', empty: false });
    // Lines that hold only what the sanitiser removes are blank.
    assert.deepEqual(noteLine(r, selected('first\n\x1b[31m\x07')), {
      text: 'first',
      empty: false,
    });
    // A lone carriage return breaks a line too, as the server splits a note.
    assert.deepEqual(noteLine(r, selected('first\rsecond')), { text: 'first …', empty: false });
    // A note too long for `selected` (D5): the head decides.
    assert.deepEqual(noteLine(r, selected(null, true)), { text: 'first', empty: false });
  });

  test('the first line is sanitised again; a note with nothing printable shows …', () => {
    assert.deepEqual(
      noteLine(row({ hasNote: true, noteHead: ['a\x1b[31mred\x07 <b>x</b>'] }), null),
      {
        text: 'ared <b>x</b>',
        empty: false,
      },
    );
    assert.deepEqual(noteLine(row({ hasNote: true, noteHead: [] }), null), {
      text: '…',
      empty: false,
    });
  });
});

describe("startedWithText: the flags a session was started with, last on the header's second line (follow-up F16)", () => {
  const NONE = { text: '', tip: '' };

  test('nothing without flags: no selected, none recorded', () => {
    assert.deepEqual(startedWithText(null), NONE);
    assert.deepEqual(startedWithText(flagged([])), NONE);
    assert.deepEqual(startedWithText(flagged([], [])), NONE);
  });

  test('a session started only with flags the recording knows by name shows those names (ruled: it was started with a flag, so never nothing)', () => {
    assert.deepEqual(startedWithText(flagged([], ['--frob'])), {
      text: '--frob',
      tip: 'Started with: --frob\nNot recognised, not passed again on resume: --frob',
    });
  });

  test('the flags in the order recorded, as one text; the tooltip says "Started with:"', () => {
    assert.deepEqual(startedWithText(flagged(['--model', 'opus', '--permission-mode', 'plan'])), {
      text: '--model opus --permission-mode plan',
      tip: 'Started with: --model opus --permission-mode plan',
    });
  });

  test('a value with spaces is shown as recorded: not quoted, its spaces kept', () => {
    assert.deepEqual(startedWithText(flagged(['--append-system-prompt', 'be  brief', '-d'])), {
      text: '--append-system-prompt be  brief -d',
      tip: 'Started with: --append-system-prompt be  brief -d',
    });
  });

  test(`at most ${STARTED_WITH_MAX} characters, the last of them … beyond that; the tooltip uncut`, () => {
    assert.equal(STARTED_WITH_MAX, 40);
    const exact = ['--model', 'x'.repeat(40 - '--model '.length)];
    assert.equal(startedWithText(flagged(exact)).text, `--model ${'x'.repeat(32)}`);
    assert.equal(startedWithText(flagged(exact)).text.length, 40);
    const over = ['--model', 'x'.repeat(33)];
    const shown = startedWithText(flagged(over));
    assert.equal(shown.text, `--model ${'x'.repeat(31)}…`);
    assert.equal([...shown.text].length, 40);
    assert.equal(shown.tip, `Started with: --model ${'x'.repeat(33)}`);
    const long = ['--settings', `/home/u/${'s'.repeat(200)}.json`, '--model', 'opus'];
    const cutLong = startedWithText(flagged(long));
    assert.equal([...cutLong.text].length, 40);
    assert.ok(cutLong.text.endsWith('…'));
    assert.equal(cutLong.tip, `Started with: ${long.join(' ')}`);
  });

  test('characters are counted as characters: a pair of surrogates is one and never split', () => {
    const smiles = ['--append-system-prompt', '🙂'.repeat(30)];
    const shown = startedWithText(flagged(smiles));
    assert.equal([...shown.text].length, 40);
    assert.equal(shown.text, `--append-system-prompt ${'🙂'.repeat(16)}…`);
    assert.equal(startedWithText(flagged(['-d', '🙂'.repeat(37)])).text, `-d ${'🙂'.repeat(37)}`);
  });

  test('a character as it is seen: a joined emoji and a letter with its combining mark count as one each and are never split', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // one family emoji, five code points
    const shown = startedWithText(flagged(['--append-system-prompt', family.repeat(30)]));
    assert.equal(shown.text, `--append-system-prompt ${family.repeat(16)}…`);
    const marked = 'e\u0301'; // é as e and a combining acute accent
    assert.equal(
      startedWithText(flagged(['-d', marked.repeat(37)])).text,
      `-d ${marked.repeat(37)}`,
    );
    assert.equal(
      startedWithText(flagged(['-d', marked.repeat(38)])).text,
      `-d ${marked.repeat(36)}…`,
    );
  });

  test('the names not recognised come after the kept flags in the text and on the first line of the tooltip; its second line names them again, not passed on resume', () => {
    assert.deepEqual(startedWithText(flagged(['--model', 'opus'], ['--frob', '-Z'])), {
      text: '--model opus --frob -Z',
      tip: 'Started with: --model opus --frob -Z\nNot recognised, not passed again on resume: --frob -Z',
    });
  });

  test('the cut at 40 characters is over the whole text, the names included; the tooltip uncut', () => {
    const kept = ['--model', 'opus', '--permission-mode', 'plan']; // 35 characters
    const shown = startedWithText(flagged(kept, ['--frobnicate']));
    assert.equal(shown.text, '--model opus --permission-mode plan --f…');
    assert.equal([...shown.text].length, 40);
    assert.equal(
      shown.tip,
      'Started with: --model opus --permission-mode plan --frobnicate\nNot recognised, not passed again on resume: --frobnicate',
    );
    const names = Array.from({ length: 8 }, (_, at) => `--unknown-${at}`);
    const many = startedWithText(flagged([], names));
    assert.equal([...many.text].length, 40);
    assert.equal(many.text, '--unknown-0 --unknown-1 --unknown-2 --u…');
  });

  test("the server's strings are sanitised again; markup stays text", () => {
    assert.deepEqual(
      startedWithText(
        flagged(['--model', 'op\x1b[31mus\x07', '--name-x', '<b>x</b>\n'], ['--a\tb']),
      ),
      {
        text: '--model opus --name-x <b>x</b>  --a b',
        tip: 'Started with: --model opus --name-x <b>x</b>  --a b\nNot recognised, not passed again on resume: --a b',
      },
    );
  });

  test('a field missing, or of the wrong shape, holds no flag (a list of another server)', () => {
    const { launchFlags: _gone, ...older } = flagged(['--model', 'opus']);
    assert.deepEqual(startedWithText(older as SelectedPayload), NONE);
    assert.deepEqual(startedWithText(flagged('--model opus')), NONE);
    assert.deepEqual(startedWithText(flagged(['--model', 7])), NONE);
    assert.deepEqual(startedWithText(flagged(null)), NONE);
    // The names stand on their own: kept flags of the wrong shape do not hide them.
    assert.deepEqual(startedWithText(flagged(['--model', 7], ['--frob'])), {
      text: '--frob',
      tip: 'Started with: --frob\nNot recognised, not passed again on resume: --frob',
    });
    // Unknown names of the wrong shape: none, and no second line.
    assert.deepEqual(startedWithText(flagged(['--verbose'], '--frob')), {
      text: '--verbose',
      tip: 'Started with: --verbose',
    });
    assert.deepEqual(startedWithText(flagged(['--verbose'], [3])), {
      text: '--verbose',
      tip: 'Started with: --verbose',
    });
  });
});

describe('F18: the ticket chip and the ticket field', () => {
  const ticket = { url: 'https://example.com/browse/ABC-123', text: 'ABC-123' };

  test('ticketChip: the name, the whole address as its tooltip and as what a click opens', () => {
    assert.deepEqual(ticketChip({ ...selected(null), ticket }), {
      text: 'ABC-123',
      tip: 'https://example.com/browse/ABC-123',
      url: 'https://example.com/browse/ABC-123',
    });
  });

  test('ticketChip: none without a ticket, without selected, or for one of the wrong shape', () => {
    assert.equal(ticketChip(null), null);
    assert.equal(ticketChip(selected(null)), null);
    for (const wrong of [
      'https://example.com/x',
      {},
      { url: 1, text: 'a' },
      { url: 'https://example.com/x' },
      { url: '', text: 'a' },
    ]) {
      assert.equal(
        ticketChip({ ...selected(null), ticket: wrong } as unknown as SelectedPayload),
        null,
        JSON.stringify(wrong),
      );
    }
  });

  test('ticketChip: the name sanitised again; one with nothing left is the address', () => {
    const chip = ticketChip({
      ...selected(null),
      ticket: { url: ticket.url, text: 'a\u001b[31mb\u202e' },
    });
    assert.equal(chip?.text, 'ab');
    assert.equal(
      ticketChip({ ...selected(null), ticket: { url: ticket.url, text: '\u0007 ' } })?.text,
      ticket.url,
    );
  });

  test('ticketField: the address set, or empty; the placeholder names a key only with ticketUrl', () => {
    assert.deepEqual(ticketField({ ...selected(null), ticket, ticketKeys: true }), {
      value: 'https://example.com/browse/ABC-123',
      placeholder: 'a link, or a key like ABC-123',
      help: "A link is stored as the window opens it; a key becomes ticketUrl's link. Empty removes it.",
    });
    assert.deepEqual(ticketField({ ...selected(null), ticketKeys: false }), {
      value: '',
      placeholder: 'a link',
      help: 'An http or https link, stored as the window opens it (a key needs ticketUrl in config.json). Empty removes it.',
    });
    assert.equal(ticketField(null).placeholder, 'a link');
    assert.equal(ticketField(null).value, '');
  });
});

describe('F32: the new levels in the header and in the dialog (S2 12.5, D13)', () => {
  const cases = [
    ['unresolved-comments', 'comments', 'unresolved comments'],
    ['blocked', 'blocked', 'blocked'],
    ['open', 'open', 'open'],
    ['checks-passing', 'green', 'checks passing'],
    ['checks-not-reported', 'pending', 'checks pending'],
  ] as const;

  test("the header's line says the chip's words, the dialog's line its own, with the age", () => {
    for (const [level, chipWords, lineWords] of cases) {
      assert.equal(prItemText(pr(level)), `acme/web #7 · ${chipWords}`, level);
      assert.deepEqual(prItemParts(pr(level)), {
        name: 'acme/web #7 · ',
        state: chipWords,
        level,
      });
      assert.equal(prLineText(pr(level), now), `acme/web #7 · ${lineWords} · checked 4m ago`);
      assert.deepEqual(prLineParts(pr(level), now), {
        head: 'acme/web #7 · ',
        state: lineWords,
        tail: ' · checked 4m ago',
        level,
      });
    }
  });

  test('approved, green keeps its words', () => {
    assert.equal(
      prLineText(pr('approved-green'), now),
      'acme/web #7 · approved, green · checked 4m ago',
    );
  });
});
