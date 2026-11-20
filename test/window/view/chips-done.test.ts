/**
 * Follow-up F35 (S2 12.1, 12.2, 12.8): the chips respect `Show done`, keep the sections and the
 * blocks, and the chip `Done`. W: a word is typed; C: one of `running`, `open-pr`, `note`; D: the
 * chip `done`; S: `showDone`. A row is in the sections when it matches every word and every chip
 * (D: it is marked done) and, if the list hides it without the filter (a done one, an empty copy),
 * when S, W or D holds. Flat rows, every section unfolded and no block for W only; under chips
 * alone the list is drawn as without the filter over the rows that remain, and the footer counts
 * the done sessions that match. Pure: step 1's builders, no platform.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_DAY, NS_PER_MINUTE } from '../../../src/platform/time.ts';
import type { ListRow } from '../../../src/sessions/list.ts';
import type { DerivedSession, Holder } from '../../../src/sessions/types.ts';
import type { ClosedBlock, SearchChip, SectionPayload } from '../../../src/window/protocol.ts';
import type { AttentionFacts } from '../../../src/window/view/attention.ts';
import { buildListMessage } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { ds, meta, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const NOW = T0;
const DAY = NS_PER_DAY;
const MIN = NS_PER_MINUTE;
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const S6 = '5a0e8b6d-3c7f-4ebf-8b8c-7d6e5f4a3b2c';
const S7 = '6b1f9c7e-4d8a-4fca-9c9d-8e7f6a5b4c3d';

type Message = ReturnType<typeof buildListMessage>;
type View = Partial<ViewInput['view']>;

function holder(pid: number): Holder {
  return {
    process: { bootId: BOOT_A, pid, procStart: 500 + pid },
    sinceNs: T0,
    live: null,
    scripted: false,
  };
}

/** A session running elsewhere (under Open), held by `pid`. */
function running(
  id: string,
  title: string,
  pid: number,
  over: Omit<Parameters<typeof ds>[0], 'id'> = {},
): DerivedSession {
  return ds({
    id,
    state: 'working',
    holders: [holder(pid)],
    transcript: { aiTitle: title },
    ...over,
  });
}

/** A session that is not running, last active `ago` before NOW, marked done when `done`. */
function idle(id: string, title: string, ago: bigint, done = false): DerivedSession {
  return ds({
    id,
    lastActivityNs: NOW - ago,
    hidden: done,
    doneAtNs: done ? T0 : null,
    transcript: { aiTitle: title },
  });
}

function input(over: Partial<Omit<ViewInput, 'view'>> & { view?: View }): ViewInput {
  return {
    rows: [],
    terminals: [],
    elsewhere: new Map(),
    selected: null,
    nowNs: NOW,
    ...over,
    view: { filter: '', unfolded: [], showDone: false, selected: null, ...over.view },
  };
}

function section(message: Message, name: SectionPayload['name']): SectionPayload {
  const found = message.sections.find((s) => s.name === name);
  assert.ok(found, `no section ${name}`);
  return found;
}

/** Every row the sections carry, sorted (the truth table asks which, not where). */
function listed(message: Message): string[] {
  return message.sections.flatMap((s) => s.rows.map((row) => row.id)).sort();
}

function ids(message: Message, name: SectionPayload['name']): string[] {
  return section(message, name).rows.map((row) => row.id);
}

function shut(name: SectionPayload['name'], ...groups: string[]): ClosedBlock[] {
  return groups.map((group) => ({ section: name, group }));
}

// --- C1: what a chip lists — the truth table of W, C, D and S ----------------------------------

/**
 * OPEN: running elsewhere, not done, a note. DONE: marked done, not running (Recent), a note.
 * DONE_RUNS: marked done and running elsewhere (under Open, S2 12.10), a note. PLAIN: not done,
 * not running, a note; COPY: an empty copy of PLAIN running elsewhere (F33), no note. Every title
 * holds the word `work`.
 */
const OPEN = S1;
const DONE = S2;
const DONE_RUNS = S3;
const PLAIN = S4;
const COPY = S5;

function world(): Pick<ViewInput, 'rows' | 'elsewhere'> {
  return {
    rows: rows(
      [
        running(OPEN, 'alpha work', 9001),
        idle(DONE, 'beta work', 2n * MIN, true),
        running(DONE_RUNS, 'gamma work', 9003, { hidden: true, doneAtNs: T0 }),
        idle(PLAIN, 'epsilon work', 4n * MIN),
        running(COPY, 'epsilon work', 9005, {
          marks: ['continued', 'empty-copy'],
          continuedFrom: PLAIN,
          copyOf: PLAIN,
          transcript: { aiTitle: 'epsilon work', lastUserNs: null, lastTurnRole: null },
        }),
      ],
      {
        metas: [
          meta(OPEN, { note: 'n' }),
          meta(DONE, { note: 'n' }),
          meta(DONE_RUNS, { note: 'n' }),
          meta(PLAIN, { note: 'n' }),
        ],
      },
    ),
    elsewhere: new Map([
      [OPEN, { pid: 9001, tty: null }],
      [DONE_RUNS, { pid: 9003, tty: null }],
      [COPY, { pid: 9005, tty: null }],
    ]),
  };
}

function build(view: View): Message {
  return buildListMessage(input({ ...world(), view }));
}

describe('C1: the rows each combination of a word, the chips, Done and Show done lists', () => {
  const sorted = (...list: string[]) => [...list].sort();
  /** [why, view, the rows listed, doneHidden]. */
  const table: [string, View, string[], number][] = [
    // Neither: stage A's rule — a done row that runs is listed (S2 12.10), the copy hidden.
    ['nothing', {}, [OPEN, DONE_RUNS, PLAIN], 1],
    ['S', { showDone: true }, [OPEN, DONE, DONE_RUNS, PLAIN, COPY], 0],
    ['W', { filter: 'work' }, [OPEN, DONE, DONE_RUNS, PLAIN, COPY], 0],
    ['W with S', { filter: 'work', showDone: true }, [OPEN, DONE, DONE_RUNS, PLAIN, COPY], 0],
    // Each chip alone: no done row the list hides, no empty copy (F33); the done one that runs stays.
    ['C note', { chips: ['note'] }, [OPEN, DONE_RUNS, PLAIN], 1],
    ['C running', { chips: ['running'] }, [OPEN, DONE_RUNS], 0],
    ['C open-pr', { chips: ['open-pr'] }, [], 0],
    ['two chips', { chips: ['running', 'note'] }, [OPEN, DONE_RUNS], 0],
    ['C note with S', { chips: ['note'], showDone: true }, [OPEN, DONE, DONE_RUNS, PLAIN], 0],
    ['C running with S', { chips: ['running'], showDone: true }, [OPEN, DONE_RUNS, COPY], 0],
    // A chip with a word: the word lists the done ones and the copy, as today.
    ['C note with W', { chips: ['note'], filter: 'work' }, [OPEN, DONE, DONE_RUNS, PLAIN], 0],
    ['C running with W', { chips: ['running'], filter: 'work' }, [OPEN, DONE_RUNS, COPY], 0],
    ['C note with W beta', { chips: ['note'], filter: 'beta' }, [DONE], 0],
    // Done: only the rows marked done, whatever Show done says.
    ['D', { chips: ['done'] }, [DONE, DONE_RUNS], 0],
    ['D with S', { chips: ['done'], showDone: true }, [DONE, DONE_RUNS], 0],
    ['D with C running', { chips: ['running', 'done'] }, [DONE_RUNS], 0],
    ['D with C note', { chips: ['note', 'done'] }, [DONE, DONE_RUNS], 0],
    ['D with C note and S', { chips: ['note', 'done'], showDone: true }, [DONE, DONE_RUNS], 0],
    ['D with W', { chips: ['done'], filter: 'work' }, [DONE, DONE_RUNS], 0],
    ['D with W beta', { chips: ['done'], filter: 'beta' }, [DONE], 0],
    ['D with W alpha', { chips: ['done'], filter: 'alpha' }, [], 0],
  ];
  for (const [why, view, want, doneHidden] of table) {
    test(`${why}: ${JSON.stringify(view)}`, () => {
      const message = build(view);
      assert.deepEqual(listed(message), sorted(...want));
      assert.equal(message.doneHidden, doneHidden, 'doneHidden');
    });
  }

  test('a done row the chips list keeps its done mark; the done one that runs stays under Open', () => {
    const message = build({ chips: ['done'] });
    assert.deepEqual(ids(message, 'open'), [DONE_RUNS]);
    assert.deepEqual(ids(message, 'week'), [DONE]);
    for (const row of message.sections.flatMap((s) => s.rows)) {
      assert.equal(row.done, true, row.id);
    }
  });

  test('`filtering` is a word or any chip, Done too; `searching` a word only (white space is none)', () => {
    const flags = (view: View) => {
      const message = build(view);
      return [message.filtering, message.searching];
    };
    assert.deepEqual(flags({}), [false, false]);
    assert.deepEqual(flags({ filter: ' \t ' }), [false, false]);
    assert.deepEqual(flags({ chips: ['note'] }), [true, false]);
    assert.deepEqual(flags({ chips: ['done'] }), [true, false]);
    assert.deepEqual(flags({ chips: ['done'], filter: ' ' }), [true, false]);
    assert.deepEqual(flags({ filter: 'work' }), [true, true]);
    assert.deepEqual(flags({ filter: 'work', chips: ['done'] }), [true, true]);
  });

  test('the title bar does not move: counts and needYou.count are the same under every chip and Done', () => {
    const facts: AttentionFacts = {
      marks: new Map([
        [
          DONE,
          {
            turnEndedSeq: null,
            turnEndedNs: null,
            seenSeq: null,
            windowEndSeq: 1,
            windowEndNs: NOW - SEC,
          },
        ],
        [
          PLAIN,
          {
            turnEndedSeq: null,
            turnEndedNs: null,
            seenSeq: null,
            windowEndSeq: 2,
            windowEndNs: NOW - SEC,
          },
        ],
      ]),
      live: new Map(),
    };
    const at = (view: View) => buildListMessage(input({ ...world(), attention: facts, view }));
    // The counts follow Show done (S2 8.2.7), never a chip.
    for (const showDone of [false, true]) {
      const plain = at({ showDone });
      for (const chips of [['note'], ['running'], ['done'], ['note', 'done']] as SearchChip[][]) {
        const message = at({ chips, showDone });
        const why = `${chips.join()} ${String(showDone)}`;
        assert.deepEqual(message.counts, plain.counts, why);
        assert.equal(message.needYou.count, plain.needYou.count, why);
      }
      assert.equal(plain.needYou.count, showDone ? 2 : 1, 'the done one counts once shown');
    }
  });
});

// --- C2: sections and blocks stay under chips --------------------------------------------------

/** Recent: S1, S2, S3 of ORB-1 with a note, S4 of ORB-1 done with a note, S5 of ORB-1 without a
 *  note; Earlier: S6 with a note, S7 done with a note. */
function blockWorld(): ListRow[] {
  return rows(
    [
      idle(S1, 'ORB-1 fix one', MIN),
      idle(S2, 'ORB-1 fix two', 2n * MIN),
      idle(S3, 'ORB-1 fix three', 3n * MIN),
      idle(S4, 'ORB-1 fix done', 4n * MIN, true),
      idle(S5, 'ORB-1 fix bare', 5n * MIN),
      idle(S6, 'old note', 30n * DAY),
      idle(S7, 'old done note', 31n * DAY, true),
    ],
    {
      metas: [S1, S2, S3, S4, S6, S7].map((id) => meta(id, { note: 'n' })),
    },
  );
}

function blocks(view: View): Message {
  return buildListMessage(input({ rows: blockWorld(), view }));
}

describe('C2: under chips alone the sections keep their fold and the blocks form over the rows that remain', () => {
  test('a chip: Earlier stays folded (its count the rows it matches), the block is drawn, nothing flat', () => {
    const message = blocks({ chips: ['note'] });
    const earlier = section(message, 'earlier');
    assert.equal(earlier.folded, true);
    assert.equal(earlier.count, 1, 'S6 only: the done S7 is not listed');
    assert.deepEqual(earlier.rows, []);
    assert.deepEqual(ids(message, 'week'), [S1, S2, S3]);
    for (const row of section(message, 'week').rows) {
      assert.equal(row.stack?.group, 'ORB-1', row.id);
      assert.equal(row.stack?.size, 3, row.id);
      assert.equal(row.stack?.head, S1, row.id);
    }
    assert.equal(message.doneHidden, 2, 'S4 and S7 match the chip');
  });

  test('unfolded by the view, Earlier stays unfolded under a chip; setting or clearing one moves no fold', () => {
    for (const unfolded of [[], ['earlier']]) {
      for (const chips of [
        [],
        ['note'],
        ['done'],
        ['note', 'done'],
        ['running'],
      ] as SearchChip[][]) {
        const message = blocks({ unfolded, chips });
        assert.equal(section(message, 'earlier').folded, unfolded.length === 0, `${chips.join()}`);
      }
    }
    assert.deepEqual(ids(blocks({ unfolded: ['earlier'], chips: ['note'] }), 'earlier'), [S6]);
  });

  test('a closed block stays closed under a chip, its caption counting the rows that remain', () => {
    const closed = shut('week', 'ORB-1');
    const plain = blocks({ closed });
    assert.deepEqual(section(plain, 'week').closedStacks, [
      { group: 'ORB-1', size: 4, needYou: 0, head: S1, at: 0 },
    ]);
    const noted = blocks({ closed, chips: ['note'] });
    assert.deepEqual(ids(noted, 'week'), []);
    assert.deepEqual(section(noted, 'week').closedStacks, [
      { group: 'ORB-1', size: 3, needYou: 0, head: S1, at: 0 },
    ]);
    assert.equal(section(noted, 'week').count, 3);
    // With Show done the done one is back in the block; with Done it is the only one: no block.
    const shown = blocks({ closed, chips: ['note'], showDone: true });
    assert.equal(section(shown, 'week').closedStacks[0]?.size, 4);
    const done = blocks({ closed, chips: ['done'], unfolded: ['earlier'] });
    assert.deepEqual(section(done, 'week').closedStacks, []);
    assert.deepEqual(ids(done, 'week'), [S4]);
    assert.equal(section(done, 'week').rows[0]?.stack, null);
  });

  test('a block left with one row is no block; a section left with none is empty as without a filter', () => {
    const message = blocks({ chips: ['note'], filter: '' });
    assert.equal(section(message, 'open').count, 0);
    const one = buildListMessage(
      input({
        rows: rows([idle(S1, 'ORB-1 one', MIN), idle(S2, 'ORB-1 two', 2n * MIN)], {
          metas: [meta(S1, { note: 'n' })],
        }),
        view: { chips: ['note'], closed: shut('week', 'ORB-1') },
      }),
    );
    assert.deepEqual(ids(one, 'week'), [S1]);
    assert.equal(section(one, 'week').rows[0]?.stack, null);
    assert.deepEqual(section(one, 'week').closedStacks, []);
  });

  test('Done alone: the done rows in their sections, Earlier folded as the view has it, their blocks formed', () => {
    const list = rows([
      idle(S1, 'ORB-2 one', MIN, true),
      idle(S2, 'ORB-2 two', 2n * MIN, true),
      idle(S3, 'ORB-2 open', 3n * MIN),
      idle(S4, 'old done', 30n * DAY, true),
    ]);
    const message = buildListMessage(input({ rows: list, view: { chips: ['done'] } }));
    assert.deepEqual(ids(message, 'week'), [S1, S2]);
    assert.deepEqual(
      section(message, 'week').rows.map((row) => row.stack?.size),
      [2, 2],
    );
    assert.equal(section(message, 'earlier').folded, true);
    assert.equal(section(message, 'earlier').count, 1);
    assert.equal(message.doneHidden, 0);
  });

  test('a word, with chips or not: flat rows, every section unfolded, no block, no closed caption (as before)', () => {
    const closed = shut('week', 'ORB-1');
    for (const view of [
      { filter: 'orb' },
      { filter: 'orb', chips: ['note'] },
      { filter: 'orb', chips: ['done'] },
    ] as View[]) {
      const message = blocks({ closed, ...view });
      for (const s of message.sections) {
        assert.equal(s.folded, false, `${s.name} ${JSON.stringify(view)}`);
        assert.deepEqual(s.closedStacks, [], `${s.name} ${JSON.stringify(view)}`);
        for (const row of s.rows) {
          assert.equal(row.stack, null, `${row.id} ${JSON.stringify(view)}`);
        }
      }
    }
  });
});

// --- C3: the footer's count under chips --------------------------------------------------------

describe('C3: under chips alone with Show done off, doneHidden counts the done sessions that match', () => {
  test('a chip that lists no row: none in the sections, doneHidden the done ones it matches', () => {
    const message = buildListMessage(
      input({
        rows: rows([idle(S1, 'plain', MIN), idle(S2, 'done one', 2n * MIN, true)], {
          metas: [meta(S2, { note: 'n' })],
        }),
        view: { chips: ['note'] },
      }),
    );
    assert.deepEqual(listed(message), []);
    assert.equal(message.filtering, true);
    assert.equal(message.doneHidden, 1);
  });

  test('two chips count the done ones both match; Show done, Done or a word count none', () => {
    const world = blockWorld();
    const hidden = (view: View) => buildListMessage(input({ rows: world, view })).doneHidden;
    assert.equal(hidden({}), 2);
    assert.equal(hidden({ chips: ['note'] }), 2);
    assert.equal(hidden({ chips: ['running'] }), 0);
    assert.equal(hidden({ chips: ['note', 'running'] }), 0);
    assert.equal(hidden({ chips: ['note'], showDone: true }), 0);
    assert.equal(hidden({ chips: ['done'] }), 0);
    assert.equal(hidden({ chips: ['note', 'done'] }), 0);
    assert.equal(hidden({ chips: ['note'], filter: 'old' }), 0);
  });
});

// --- C5: the switcher's "would have to change" -------------------------------------------------

describe("C5: the switcher's hiddenBy follows the new rule", () => {
  /** S1 not done (Recent), S2 done (Recent), S3 not done (Earlier), S4 done (Earlier); all with a
   *  note but S1. */
  function switchWorld(): ListRow[] {
    return rows(
      [
        idle(S1, 'alpha', MIN),
        idle(S2, 'beta', 2n * MIN, true),
        idle(S3, 'gamma', 30n * DAY),
        idle(S4, 'delta', 31n * DAY, true),
      ],
      { metas: [S2, S3, S4].map((id) => meta(id, { note: 'n' })) },
    );
  }
  const hidden = (view: View) => {
    const message = buildListMessage(
      input({ rows: switchWorld(), view: { switcher: '', ...view } }),
    );
    return Object.fromEntries(
      (message.switcher?.items ?? []).map((one) => [one.row.id, one.hiddenBy]),
    );
  };

  test('a done session a chip matches: done sessions shown (and Earlier unfolded where it is folded)', () => {
    assert.deepEqual(hidden({ chips: ['note'] }), {
      [S1]: ['filter'],
      [S2]: ['done'],
      [S3]: ['folded'],
      [S4]: ['done', 'folded'],
    });
    assert.deepEqual(hidden({ chips: ['note'], showDone: true, unfolded: ['earlier'] }), {
      [S1]: ['filter'],
      [S2]: [],
      [S3]: [],
      [S4]: [],
    });
  });

  test('under Done a done session it matches needs nothing but the fold; one it does not match: the filter, then done', () => {
    assert.deepEqual(hidden({ chips: ['done'] }), {
      [S1]: ['filter'],
      [S2]: [],
      [S3]: ['filter', 'folded'],
      [S4]: ['folded'],
    });
    // The switcher's pick clears every chip, Done too: a done session another chip hides then
    // needs done sessions shown.
    assert.deepEqual(hidden({ chips: ['done', 'running'] })[S2], ['filter', 'done']);
  });

  test('a word that matches: nothing hides it, done or folded, as before', () => {
    assert.deepEqual(hidden({ filter: 'delta' })[S4], []);
    assert.deepEqual(hidden({ filter: 'delta', chips: ['note'] })[S4], []);
    assert.deepEqual(hidden({ filter: 'beta', chips: ['done'] })[S2], []);
  });
});
