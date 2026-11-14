// The list's text (S2 12.1, 12.2, stage A; plan task 27): what a row, its state line, a section
// header, the footer and the title bar's counts say, from what the server sent (S2 8.2.3).
// node:test on web/list-text.js, which uses no DOM.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sanitize as serverSanitize } from '../../src/text/sanitize.ts';
import type { RowPayload, SectionPayload, TerminalPayload } from '../../src/window/protocol.ts';
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
    ...over,
  };
}

function pr(level: string, number: number, error: string | null = null): RowPayload['prs'][number] {
  return {
    url: `https://github.com/o/r/pull/${number}`,
    repo: 'o/r',
    number,
    title: null,
    level,
    error,
  };
}

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
        chip: { level: 'checks-failing', count: 1 },
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
      tip: 'o/r #7 · failing',
      dotted: false,
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

describe("rowText: the chip (design 7.3's rule, S2 12.3's words)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['cant-read', "can't read"],
    ['unfetched', 'not fetched'],
    ['checks-failing', 'failing'],
    ['changes-requested', 'changes'],
    ['checks-pending', 'pending'],
    ['review-required', 'review'],
    ['draft', 'draft'],
    ['approved-green', 'approved'],
    ['merged', 'merged'],
    ['closed', 'closed'],
  ];
  for (const [level, words] of cases) {
    test(`one pull request of level ${level}: "PR · ${words}"`, () => {
      const text = rowText(row({ prs: [pr(level, 1)], chip: { level, count: 1 } }), now, null);
      assert.equal(text.chip?.text, `PR · ${words}`);
      assert.equal(text.chip?.dotted, level === 'cant-read');
    });
  }

  test('several: the count and the worst, each in the tooltip with its own state and error', () => {
    const text = rowText(
      row({
        prs: [pr('cant-read', 3, 'gh: HTTP 502'), pr('merged', 4), pr('draft', 5)],
        chip: { level: 'cant-read', count: 3 },
      }),
      now,
      null,
    );
    assert.deepEqual(text.chip, {
      text: "3 PRs · can't read",
      tip: "o/r #3 · can't read · gh: HTTP 502\no/r #4 · merged\no/r #5 · draft",
      dotted: true,
    });
  });

  test('no chip without a pull request', () => {
    assert.equal(rowText(row(), now, null).chip, null);
  });
});

describe("chipText: the chip's words, for the row and for task 29's header", () => {
  test('one pull request: "PR · <state>"; several: "<n> PRs · <the worst>"', () => {
    assert.equal(chipText({ level: 'review-required', count: 1 }), 'PR · review');
    assert.equal(chipText({ level: 'checks-failing', count: 3 }), '3 PRs · failing');
    assert.equal(chipText({ level: 'cant-read', count: 2 }), "2 PRs · can't read");
  });

  test('a level the page does not know is shown as the server named it, sanitised', () => {
    assert.equal(chipText({ level: 'later\x1b[31m-level', count: 1 }), 'PR · later-level');
  });

  test('exactly what a row shows for its chip', () => {
    for (const level of ['cant-read', 'unfetched', 'draft', 'approved-green', 'merged', 'closed']) {
      for (const count of [1, 2, 30]) {
        const chip = { level, count };
        assert.equal(chipText(chip), rowText(row({ chip, prs: [] }), now, null).chip?.text);
      }
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
        prs: [pr('cant-read', 9, 'boom\x1b[31m!')],
        chip: { level: 'cant-read', count: 1 },
      }),
      now,
      null,
    );
    assert.equal(text.title, '<img src=x onerror=alert(1)>');
    assert.equal(text.group, 'G');
    assert.equal(text.chip?.tip, "o/r #9 · can't read · boom!");
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
    ...over,
  };
}

describe('sectionText (S2 12.1)', () => {
  test('the three names, each with its count', () => {
    assert.deepEqual(sectionText(section({ name: 'open', count: 3 }), now), {
      title: 'Open',
      count: '3',
      span: '',
    });
    assert.equal(sectionText(section({ name: 'week', count: 1 }), now).title, 'This week');
    assert.equal(sectionText(section({ name: 'earlier', count: 1 }), now).title, 'Earlier');
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
    assert.deepEqual(text, { title: 'Earlier', count: '12', span: '8d–41d ago' });
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
