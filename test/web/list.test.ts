// The list's text (S2 12.1, 12.2, stage A; plan task 27): what a row, its state line, a section
// header, the footer and the title bar's counts say, from what the server sent (S2 8.2.3).
// node:test on web/list-text.js, which uses no DOM.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sanitize as serverSanitize } from '../../src/text/sanitize.ts';
import type {
  ChipPayload,
  RowPayload,
  SectionPayload,
  TerminalPayload,
} from '../../src/window/protocol.ts';
import {
  chipText,
  countsText,
  footerText,
  rowText,
  sanitize,
  sectionText,
} from '../../web/list-text.js';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
const DAY = 24n * HOUR;
/** The server's clock at the list (S2 8.2.3: times are nanoseconds as decimal strings). */
const NOW = 1_794_474_000_000_000_000n;
const now = String(NOW);
const ago = (ns: bigint): string => String(NOW - ns);

const ID = '11111111-2222-4333-8444-555555555555';

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

function terminal(over: Partial<TerminalPayload> = {}): TerminalPayload {
  return {
    id: 'aaaaaaaaaaaa',
    slot: 1,
    sessionId: ID,
    state: 'running',
    notReported: false,
    cols: 80,
    rows: 24,
    ownsSize: true,
    openedNs: ago(HOUR),
    ...over,
  };
}

function pr(
  level: string,
  number: number,
  error: string | null = null,
  okAtNs: string | null = ago(4n * MIN),
): RowPayload['prs'][number] {
  return {
    url: `https://github.com/o/r/pull/${number}`,
    repo: 'o/r',
    number,
    title: null,
    level,
    error,
    okAtNs,
  };
}

/** S2 12.3's chip of a row (what windowChip sends). */
const chip = (level: string, open: number, merged = 0): ChipPayload => ({ level, open, merged });
/** `n` pull requests of `level`, numbered from `from`. */
const many = (n: number, level: string, from: number): RowPayload['prs'] =>
  Array.from({ length: n }, (_, at) => pr(level, from + at));

describe('rowText: a running row has two lines', () => {
  test('working, in slot 1: the state line is the state and its time; no age on the first line', () => {
    const text = rowText(
      row({
        state: 'working',
        sinceNs: ago(4n * MIN + 10n * SEC),
        terminal: 'aaaaaaaaaaaa',
        slot: 1,
      }),
      now,
      terminal(),
    );
    assert.equal(text.icon, 'working');
    assert.equal(text.slot, '1');
    assert.equal(text.title, 'Fix the login page');
    assert.equal(text.stateLine, 'working 4m');
    assert.equal(text.age, '');
  });

  test('waiting with a detail: the detail between the state and its time', () => {
    const text = rowText(
      row({ state: 'waiting', stateDetail: 'permission', sinceNs: ago(3n * MIN) }),
      now,
      null,
    );
    assert.equal(text.icon, 'waiting');
    assert.equal(text.stateLine, 'waiting · permission · 3m');
  });

  test('a detail that is nothing once sanitised is no detail', () => {
    const text = rowText(
      row({ state: 'waiting', stateDetail: '\x1b[2J \x07', sinceNs: ago(3n * MIN) }),
      now,
      null,
    );
    assert.equal(text.stateLine, 'waiting 3m');
  });

  test('running (no live file): "running <time>"', () => {
    const text = rowText(row({ state: 'running', sinceNs: ago(45n * SEC) }), now, null);
    assert.equal(text.icon, 'running');
    assert.equal(text.stateLine, 'running 45s');
  });

  test('a starting row: "starting…", and "started, not reported" once its terminal is (S2 7.5)', () => {
    const starting = row({
      title: 'new session in /home/u/project',
      titleSource: 'fallback',
      starting: true,
      terminal: 'aaaaaaaaaaaa',
      slot: 2,
    });
    const text = rowText(starting, now, terminal({ slot: 2, sessionId: null, state: 'starting' }));
    assert.equal(text.icon, 'starting');
    assert.equal(text.slot, '2');
    assert.equal(text.stateLine, 'starting…');
    assert.equal(text.age, '');
    assert.equal(
      rowText(starting, now, terminal({ sessionId: null, state: 'running', notReported: true }))
        .stateLine,
      'started, not reported',
    );
  });

  test('a row running in another terminal: "running in another terminal", the icon of its state', () => {
    const text = rowText(
      row({
        state: 'working',
        elsewhere: { pid: 4242, tty: '/dev/pts/3', dir: '/home/u/project' },
      }),
      now,
      null,
    );
    assert.equal(text.icon, 'working');
    assert.equal(text.slot, '');
    assert.equal(text.stateLine, 'running in another terminal');
  });

  test('a running session marked done keeps its two lines and has the mark `done` (S2 12.10)', () => {
    const text = rowText(row({ state: 'working', sinceNs: ago(MIN), done: true }), now, null);
    assert.equal(text.stateLine, 'working 1m');
    assert.deepEqual(
      text.marks.map((mark) => mark.text),
      ['done'],
    );
  });
});

describe('rowText: a row that is not running has one line', () => {
  test('the state icon, the title, the marks in words, the chip, ✎ and the age of its last activity', () => {
    const text = rowText(
      row({
        lastActivityNs: ago(3n * DAY + HOUR),
        marks: ['ended-unexpectedly', 'was-working', 'expiring'],
        hasNote: true,
        noteHead: ['first line', 'second'],
        prs: [pr('checks-failing', 7)],
        chip: chip('checks-failing', 1),
      }),
      now,
      null,
    );
    assert.equal(text.icon, 'crashed');
    assert.equal(text.stateLine, null);
    assert.equal(text.slot, '');
    assert.equal(text.age, '3d');
    // design 6.3's marks in words (S2 12.2): was-working is the "mid-turn" kind of a crash.
    assert.deepEqual(
      text.marks.map((mark) => [mark.kind, mark.text]),
      [
        ['crashed', 'crashed mid-turn'],
        ['expiring', 'expires soon'],
      ],
    );
    // Ruled (plan task 27): the row carries only that it is expiring, so no number of days —
    // not even the server's 5, which the page does not own.
    assert.equal(
      text.marks[1]?.tip,
      'its transcript will be deleted soon unless the session is resumed',
    );
    assert.doesNotMatch(text.marks.map((mark) => `${mark.text} ${mark.tip}`).join(' '), /\d/);
    assert.deepEqual(text.chip, {
      text: 'PR · failing',
      merged: '',
      tip: 'o/r #7 · failing',
      dotted: false,
      dim: false,
      level: 'checks-failing',
    });
    assert.equal(text.note, 'first line');
  });

  test('every mark of design 6.3 in words, then `done`', () => {
    const text = rowText(
      row({
        marks: ['ended-unexpectedly', 'continued', 'expired', 'duplicate'],
        done: true,
      }),
      now,
      null,
    );
    assert.deepEqual(
      text.marks.map((mark) => mark.text),
      ['crashed', 'continued', 'expired', '2 processes', 'done'],
    );
    for (const mark of text.marks) assert.notEqual(mark.tip, '', `${mark.text} has a tooltip`);
  });

  test('a mark the page does not know is shown as the server named it, sanitised', () => {
    const text = rowText(row({ marks: ['some-later\x1b[31m-mark'] }), now, null);
    assert.deepEqual(
      text.marks.map((mark) => mark.text),
      ['some-later-mark'],
    );
  });

  test('the icon of a row that is not running and did not crash', () => {
    assert.equal(rowText(row(), now, null).icon, 'not-running');
  });

  test('a row with an ended terminal keeps its slot number', () => {
    const text = rowText(
      row({ terminal: 'aaaaaaaaaaaa', slot: 3 }),
      now,
      terminal({ slot: 3, state: 'ended' }),
    );
    assert.equal(text.slot, '3');
    assert.equal(text.stateLine, null);
  });
});

describe("rowText: the chip (S2 12.3's rule and words, plan D4)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['cant-read', "can't read"],
    ['unfetched', 'not fetched'],
    ['checks-failing', 'failing'],
    ['changes-requested', 'changes'],
    ['checks-pending', 'pending'],
    ['review-required', 'review'],
    ['draft', 'draft'],
    ['approved-green', 'approved'],
  ];
  for (const [level, words] of cases) {
    test(`one open pull request of level ${level}: "PR · ${words}"`, () => {
      const text = rowText(row({ prs: [pr(level, 1)], chip: chip(level, 1) }), now, null);
      assert.equal(text.chip?.text, `PR · ${words}`);
      assert.equal(text.chip?.merged, '');
      assert.equal(text.chip?.dotted, level === 'cant-read');
      assert.equal(text.chip?.dim, false);
      // F4: the state the chip names, for its tint.
      assert.equal(text.chip?.level, level);
    });
  }

  // S2 12.3's table, row by row: the chip, its merged part apart, and the tooltip.
  const table: ReadonlyArray<
    readonly [
      string,
      RowPayload['prs'],
      ChipPayload,
      NonNullable<ReturnType<typeof rowText>['chip']>,
    ]
  > = [
    [
      '1 open, review required',
      [pr('review-required', 7)],
      chip('review-required', 1),
      {
        text: 'PR · review',
        merged: '',
        tip: 'o/r #7 · review',
        dotted: false,
        dim: false,
        level: 'review-required',
      },
    ],
    [
      '1 open, checks failing; 30 merged',
      [pr('checks-failing', 7), ...many(30, 'merged', 100)],
      chip('checks-failing', 1, 30),
      {
        text: 'PR · failing',
        merged: '+30',
        tip: 'o/r #7 · failing\n30 merged',
        dotted: false,
        dim: false,
        level: 'checks-failing',
      },
    ],
    [
      '2 open: a draft and an approved, green one',
      [pr('approved-green', 1), pr('draft', 2)],
      chip('draft', 2),
      {
        text: '2 PRs · draft',
        merged: '',
        tip: 'o/r #1 · approved\no/r #2 · draft',
        dotted: false,
        dim: false,
        level: 'draft',
      },
    ],
    [
      'one that cannot be read and one with changes requested; 4 merged',
      [
        pr('cant-read', 3, 'gh: HTTP 502', ago(3n * HOUR + 5n * MIN)),
        ...many(4, 'merged', 10),
        pr('changes-requested', 5),
      ],
      chip('cant-read', 2, 4),
      {
        text: "2 PRs · can't read",
        merged: '+4',
        tip: "o/r #3 · can't read · last read 3h ago · gh: HTTP 502\no/r #5 · changes\n4 merged",
        dotted: true,
        dim: false,
        level: 'cant-read',
      },
    ],
    [
      '3 open, the worst failing; 30 merged',
      [
        pr('checks-pending', 1),
        pr('checks-failing', 2),
        pr('draft', 3),
        ...many(30, 'merged', 100),
      ],
      chip('checks-failing', 3, 30),
      {
        text: '3 PRs · failing',
        merged: '+30',
        tip: 'o/r #1 · pending\no/r #2 · failing\no/r #3 · draft\n30 merged',
        dotted: false,
        dim: false,
        level: 'checks-failing',
      },
    ],
    [
      'none open; 3 merged, 1 closed',
      [...many(3, 'merged', 1), pr('closed', 9)],
      chip('merged', 0, 3),
      {
        text: '3 merged',
        merged: '',
        tip: '3 merged · 1 closed',
        dotted: false,
        dim: true,
        level: 'merged',
      },
    ],
    [
      'none open; 1 closed',
      [pr('closed', 9)],
      chip('closed', 0),
      { text: 'closed', merged: '', tip: '1 closed', dotted: false, dim: true, level: 'closed' },
    ],
  ];
  for (const [name, prs, given, expected] of table) {
    test(name, () => {
      assert.deepEqual(rowText(row({ prs, chip: given }), now, null).chip, expected);
    });
  }

  test("can't read: the age of the last read, or never read without one; then the error", () => {
    const text = (okAtNs: string | null, error: string | null): string =>
      rowText(
        row({ prs: [pr('cant-read', 9, error, okAtNs)], chip: chip('cant-read', 1) }),
        now,
        null,
      ).chip?.tip ?? '';
    assert.equal(
      text(ago(3n * HOUR), 'gh: HTTP 502'),
      "o/r #9 · can't read · last read 3h ago · gh: HTTP 502",
    );
    assert.equal(text(null, 'gh: HTTP 502'), "o/r #9 · can't read · never read · gh: HTTP 502");
    assert.equal(text(ago(2n * DAY), null), "o/r #9 · can't read · last read 2d ago");
    // A time that is not one gives no age: never read is said only when there was no read.
    assert.equal(text('soon', null), "o/r #9 · can't read");
  });

  test('the age of the last read counts on with the time given (the list repaints its ages)', () => {
    const later = String(NOW + 2n * HOUR);
    const unreadable = row({
      prs: [pr('cant-read', 9, null, ago(HOUR))],
      chip: chip('cant-read', 1),
    });
    assert.equal(
      rowText(unreadable, now, null).chip?.tip,
      "o/r #9 · can't read · last read 1h ago",
    );
    assert.equal(
      rowText(unreadable, later, null).chip?.tip,
      "o/r #9 · can't read · last read 3h ago",
    );
  });

  test('only open ones are listed in the tooltip, each once; the finished ones as counts after them', () => {
    const text = rowText(
      row({
        prs: [pr('merged', 1), pr('closed', 2), pr('unfetched', 3, null, null), pr('closed', 4)],
        chip: chip('unfetched', 1, 1),
      }),
      now,
      null,
    );
    assert.equal(text.chip?.tip, 'o/r #3 · not fetched\n1 merged · 2 closed');
  });

  test('a level the page does not know is shown as the server named it, sanitised', () => {
    const text = rowText(
      row({ prs: [pr('later\x1b[31m-level', 1)], chip: chip('later\x1b[31m-level', 1) }),
      now,
      null,
    );
    assert.equal(text.chip?.text, 'PR · later-level');
    assert.equal(text.chip?.tip, 'o/r #1 · later-level');
    // F4: a level the page does not know names no state, so the chip keeps today's grey; nothing
    // of the server's text reaches the chip's attribute.
    assert.equal(text.chip?.level, '');
    for (const foreign of ['<b>x</b>', 'merged ', 'Merged', 'constructor', '__proto__', '']) {
      assert.equal(
        rowText(row({ prs: [pr(foreign, 1)], chip: chip(foreign, 1) }), now, null).chip?.level,
        '',
        foreign,
      );
    }
  });

  test('no chip without a pull request', () => {
    assert.equal(rowText(row(), now, null).chip, null);
  });
});

describe("chipText: the chip's whole text, for the row and for the header (S2 12.3)", () => {
  test('open ones: "PR · <state>" for one, "<n> PRs · <the worst>" for several, then +<merged>', () => {
    assert.equal(chipText(chip('review-required', 1)), 'PR · review');
    assert.equal(chipText(chip('checks-failing', 3)), '3 PRs · failing');
    assert.equal(chipText(chip('checks-failing', 1, 30)), 'PR · failing +30');
    assert.equal(chipText(chip('cant-read', 2, 4)), "2 PRs · can't read +4");
    assert.equal(chipText(chip('checks-failing', 3, 30)), '3 PRs · failing +30');
  });

  test('none open: "<n> merged" when any is merged, else "closed"', () => {
    assert.equal(chipText(chip('merged', 0, 3)), '3 merged');
    assert.equal(chipText(chip('merged', 0, 1)), '1 merged');
    assert.equal(chipText(chip('closed', 0)), 'closed');
  });

  test('a level the page does not know is shown as the server named it, sanitised', () => {
    assert.equal(chipText(chip('later\x1b[31m-level', 1)), 'PR · later-level');
  });

  test('exactly what a row shows for its chip: its text, then its merged part', () => {
    for (const level of ['cant-read', 'unfetched', 'draft', 'approved-green']) {
      for (const open of [1, 2, 30]) {
        for (const merged of [0, 1, 30]) {
          const given = chip(level, open, merged);
          const shown = rowText(row({ chip: given, prs: [] }), now, null).chip;
          assert.equal(
            chipText(given),
            [shown?.text, shown?.merged].filter((part) => part !== '').join(' '),
          );
        }
      }
    }
    for (const given of [chip('merged', 0, 3), chip('closed', 0)]) {
      assert.equal(chipText(given), rowText(row({ chip: given, prs: [] }), now, null).chip?.text);
    }
  });
});

describe('rowText: the ticket key and the group (S2 12.2)', () => {
  test('a title that starts with its group: the key apart, the rest of the title after it', () => {
    const text = rowText(
      row({ title: 'ORB-2107: fix the login', group: 'ORB-2107', groupSource: 'title' }),
      now,
      null,
    );
    assert.equal(text.key, 'ORB-2107');
    assert.equal(text.group, '');
    assert.equal(text.title, 'fix the login');
  });

  test('a group the title does not start with: printed before the title', () => {
    const text = rowText(
      row({ title: 'fix the login', group: 'ORB-2107', groupSource: 'meta' }),
      now,
      null,
    );
    assert.equal(text.key, '');
    assert.equal(text.group, 'ORB-2107');
    assert.equal(text.title, 'fix the login');
  });

  test('a title that starts with the group inside a longer word: neither apart nor printed again', () => {
    for (const [title, group] of [
      ['ORB-21070 fix', 'ORB-2107'],
      ['ORB-2107 fix', 'ORB'],
    ] as const) {
      const text = rowText(row({ title, group, groupSource: 'meta' }), now, null);
      assert.deepEqual([text.key, text.group, text.title], ['', '', title], title);
    }
  });

  test('a title that is only its key', () => {
    const text = rowText(
      row({ title: 'ORB-2107', group: 'ORB-2107', groupSource: 'title' }),
      now,
      null,
    );
    assert.deepEqual([text.key, text.title], ['ORB-2107', '']);
  });
});

describe('rowText: text from the server is shown as text, sanitised', () => {
  test("a note's first line with an escape character is shown sanitised", () => {
    const text = rowText(
      row({ hasNote: true, noteHead: ['\x1b[31mred\x1b[0m alert\x07 \x1b]8;;http://x\x07link'] }),
      now,
      null,
    );
    assert.equal(text.note, 'red alert link');
  });

  test('a row with a note whose lines are all empty still has ✎, with no tooltip text', () => {
    assert.equal(rowText(row({ hasNote: true, noteHead: [] }), now, null).note, '');
    assert.equal(rowText(row({ hasNote: false }), now, null).note, null);
  });

  test('the title, the group and the chip tooltip pass the sanitiser; markup stays text', () => {
    const text = rowText(
      row({
        title: '<img src=x onerror=alert(1)>\x1b[2J',
        group: 'G\x1b]0;title\x07',
        groupSource: 'meta',
        prs: [pr('cant-read', 9, 'boom\x1b[31m!', null)],
        chip: chip('cant-read', 1),
      }),
      now,
      null,
    );
    assert.equal(text.title, '<img src=x onerror=alert(1)>');
    assert.equal(text.group, 'G');
    assert.equal(text.chip?.tip, "o/r #9 · can't read · never read · boom!");
  });

  test("a pull request's repository with an escape sequence or a line break is shown sanitised in the tooltip", () => {
    const hostile = { ...pr('checks-failing', 7), repo: 'o/r\x1b]8;;http://x\x07\n<b>x</b>' };
    const text = rowText(row({ prs: [hostile], chip: chip('checks-failing', 1) }), now, null);
    assert.equal(text.chip?.tip, 'o/r <b>x</b> #7 · failing');
  });

  test('a bad time gives no age, and nothing throws', () => {
    assert.equal(rowText(row({ lastActivityNs: 'soon' }), now, null).age, '');
    assert.equal(rowText(row({ state: 'working', sinceNs: '' }), now, null).stateLine, 'working');
  });
});

describe("sanitize (web/list-text.js): the server's rule (src/text/sanitize.ts)", () => {
  const inputs: readonly string[] = [
    '',
    'plain text',
    '\x1b[31mred\x1b[0m',
    '\x1b]0;window title\x07after',
    '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\',
    '\u009b2Jcsi',
    '\u009d0;c1 osc\u009c',
    'a\tb\nc\rd',
    '\x00\x01\x7f\u0085nul',
    'bidi \u202eevil\u202c \u2066x\u2069',
    'trailing escape \x1b',
    'unfinished \x1b]0;never closed',
    '  spaces  kept  ',
    'emoji 😀 and ü',
  ];
  for (const input of inputs) {
    test(JSON.stringify(input), () => {
      assert.equal(sanitize(input), serverSanitize(input));
    });
  }
});

function section(over: Partial<SectionPayload>): SectionPayload {
  return {
    name: 'open',
    folded: false,
    firstNs: null,
    lastNs: null,
    count: 0,
    rows: [],
    closedStacks: [],
    ...over,
  };
}

describe('sectionText (S2 12.1)', () => {
  test('the three names, each with its count', () => {
    assert.deepEqual(sectionText(section({ name: 'open', count: 3 }), now), {
      title: 'Open',
      tip: '',
      count: '3',
      span: '',
    });
    assert.equal(sectionText(section({ name: 'week', count: 1 }), now).title, 'Recent');
    assert.equal(sectionText(section({ name: 'earlier', count: 1 }), now).title, 'Earlier');
  });

  test('the key `week` is titled Recent, and only its header carries the tooltip with the exact meaning (F5)', () => {
    assert.deepEqual(sectionText(section({ name: 'week', count: 12 }), now), {
      title: 'Recent',
      tip: 'last active in the last 7 days',
      count: '12',
      span: '',
    });
    assert.equal(sectionText(section({ name: 'open', count: 1 }), now).tip, '');
    assert.equal(sectionText(section({ name: 'earlier', count: 1 }), now).tip, '');
    // The title is not a key: a name the page does not know is drawn as sent, with no tooltip.
    const unknown = sectionText(section({ name: 'Recent' as 'week', count: 1 }), now);
    assert.equal(unknown.title, 'Recent');
    assert.equal(unknown.tip, '');
  });

  test('Earlier folded: its count and the time span of its rows', () => {
    const text = sectionText(
      section({
        name: 'earlier',
        folded: true,
        count: 12,
        firstNs: ago(41n * DAY),
        lastNs: ago(8n * DAY),
      }),
      now,
    );
    assert.deepEqual(text, { title: 'Earlier', tip: '', count: '12', span: '8d–41d ago' });
  });

  test('a span of one age, and no span when unfolded or without times', () => {
    const one = section({
      name: 'earlier',
      folded: true,
      count: 1,
      firstNs: ago(9n * DAY),
      lastNs: ago(9n * DAY),
    });
    assert.equal(sectionText(one, now).span, '9d ago');
    assert.equal(sectionText({ ...one, folded: false }, now).span, '');
    assert.equal(sectionText({ ...one, firstNs: null, lastNs: null }, now).span, '');
  });
});

describe("countsText: the title bar's counts per state (S2 12.1, stage A)", () => {
  test('each state that has sessions, in a fixed order', () => {
    assert.deepEqual(
      countsText({ working: 3, waiting: 2, running: 1, starting: 1, elsewhere: 2, notRunning: 14 }),
      [
        { state: 'working', text: '3 working' },
        { state: 'waiting', text: '2 waiting' },
        { state: 'running', text: '1 running' },
        { state: 'starting', text: '1 starting' },
        { state: 'elsewhere', text: '2 in another terminal' },
        { state: 'not-running', text: '14 not running' },
      ],
    );
  });

  test('a state without sessions is left out; none at all is no text', () => {
    assert.deepEqual(
      countsText({ working: 0, waiting: 1, running: 0, starting: 0, elsewhere: 0, notRunning: 0 }),
      [{ state: 'waiting', text: '1 waiting' }],
    );
    assert.deepEqual(
      countsText({ working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 }),
      [],
    );
  });
});

describe('footerText (S2 12.1: "17 done hidden · show")', () => {
  test('done sessions hidden: their count and "show"', () => {
    assert.deepEqual(footerText(17, false), { text: '17 done hidden', action: 'show' });
  });
  test('done sessions shown: "hide"', () => {
    assert.deepEqual(footerText(0, true), { text: 'done sessions shown', action: 'hide' });
  });
  test('none hidden and none shown: no footer', () => {
    assert.equal(footerText(0, false), null);
  });
});

describe('rowText: a row that needs you (S2 12.2, 12.4; plan B13)', () => {
  test("a running row: the reason's line is its second line, in place of the state's", () => {
    const text = rowText(
      row({
        state: 'waiting',
        stateDetail: 'permission · Bash',
        sinceNs: ago(3n * MIN),
        terminal: 'aaaaaaaaaaaa',
        slot: 1,
        attention: { reason: 'asks', detail: 'permission · Bash', sinceNs: ago(3n * MIN) },
      }),
      now,
      terminal(),
    );
    assert.equal(text.stateLine, 'needs you · permission · Bash · 3m');
    assert.equal(text.attention, 'asks');
    assert.equal(text.age, '');
    assert.equal(text.icon, 'waiting');
  });

  test('a running row that finished its turn: "finished · not seen · 2m"', () => {
    const text = rowText(
      row({
        state: 'running',
        terminal: 'aaaaaaaaaaaa',
        slot: 1,
        attention: { reason: 'finished', detail: null, sinceNs: ago(2n * MIN) },
      }),
      now,
      terminal(),
    );
    assert.equal(text.stateLine, 'finished · not seen · 2m');
    assert.equal(text.attention, 'finished');
  });

  test('a row that is not running and ended in the window has two lines: the age is on the second', () => {
    const text = rowText(
      row({
        marks: ['ended-unexpectedly'],
        attention: { reason: 'ended', detail: null, sinceNs: ago(2n * MIN) },
      }),
      now,
      null,
    );
    assert.equal(text.stateLine, 'ended unexpectedly · not seen · 2m');
    assert.equal(text.attention, 'ended');
    assert.equal(text.age, '', 'no age on its first line');
    assert.equal(text.icon, 'crashed');
    assert.deepEqual(
      text.marks.map((mark) => mark.text),
      ['crashed'],
    );
  });

  test("the reason's line counts on with the time given (the list repaints its ages)", () => {
    const needs = row({
      state: 'running',
      terminal: 'aaaaaaaaaaaa',
      attention: { reason: 'finished', detail: null, sinceNs: ago(59n * SEC) },
    });
    assert.equal(rowText(needs, now, terminal()).stateLine, 'finished · not seen · 59s');
    assert.equal(
      rowText(needs, String(NOW + 2n * SEC), terminal()).stateLine,
      'finished · not seen · 1m',
    );
  });

  test('a detail with markup or an escape sequence is text, sanitised', () => {
    const text = rowText(
      row({
        state: 'waiting',
        terminal: 'aaaaaaaaaaaa',
        attention: { reason: 'asks', detail: '\x1b[31m<b>rm</b>\x1b[0m', sinceNs: null },
      }),
      now,
      terminal(),
    );
    assert.equal(text.stateLine, 'needs you · <b>rm</b>');
  });

  test('a reason the page does not know still marks the row (`other`), its words sanitised', () => {
    const text = rowText(
      row({
        state: 'running',
        terminal: 'aaaaaaaaaaaa',
        attention: {
          reason: 'pinged\x07',
          detail: null,
          sinceNs: null,
        } as unknown as RowPayload['attention'],
      }),
      now,
      terminal(),
    );
    assert.equal(text.attention, 'other');
    assert.equal(text.stateLine, 'pinged');
  });

  test('a row without attention is as before: no mark; one line when not running', () => {
    const notRunning = rowText(row(), now, null);
    assert.equal(notRunning.attention, null);
    assert.equal(notRunning.stateLine, null);
    assert.equal(notRunning.age, '2d');
    const working = rowText(
      row({ state: 'working', sinceNs: ago(4n * MIN), terminal: 'aaaaaaaaaaaa' }),
      now,
      terminal(),
    );
    assert.equal(working.attention, null);
    assert.equal(working.stateLine, 'working 4m');
  });

  test("a row of stage A's list, without the field, is a row without attention", () => {
    const { attention: _, ...withoutField } = row({ state: 'running', terminal: 'aaaaaaaaaaaa' });
    const text = rowText(withoutField as RowPayload, now, terminal());
    assert.equal(text.attention, null);
    assert.equal(text.stateLine, 'running 2d');
    const notRunning = rowText({ ...withoutField, state: 'not-running' } as RowPayload, now, null);
    assert.equal(notRunning.stateLine, null);
  });
});
