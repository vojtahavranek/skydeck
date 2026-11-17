/**
 * Stage E's fields of `view` and `list` (plan E 2.3): `view.chips`, `view.closed` (E6 as ruled
 * 2026-11-16, which replaced `view.opened`) and `view.switcher` with the limits `parsePageMessage`
 * applies, a view without them, and the types every side codes against (`RowPayload.stack`,
 * `SectionPayload.closedStacks` of follow-up F9, `list.filtering`, `list.switcher`).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_CLOSED, parsePageMessage } from '../../src/window/protocol.ts';
import type {
  ClosedBlock,
  ClosedStackPayload,
  HiddenBy,
  ListMessage,
  RestoreOffer,
  RowPayload,
  SearchChip,
  SectionPayload,
  StackPayload,
  SwitchItem,
  SwitchRank,
  SwitcherPayload,
  ViewMessage,
} from '../../src/window/protocol.ts';
import { SEARCH_CHIPS } from '../../src/window/view/search/filter.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const MARKER = 'MARKER-7f3a';

/** Asserts a refusal that quotes nothing of the input; returns its kind. */
function refused(result: { ok: boolean; kind?: string; value?: unknown }): string {
  assert.deepEqual(Object.keys(result), ['ok', 'kind'], `not refused: ${JSON.stringify(result)}`);
  assert.equal(result.ok, false);
  const kind = result.kind as string;
  assert.equal(typeof kind, 'string');
  assert.ok(kind.length > 0);
  assert.ok(!kind.includes(MARKER), `kind ${JSON.stringify(kind)} quotes the input`);
  return kind;
}

/** Asserts that the view is taken exactly as sent. */
function taken(view: Record<string, unknown>): void {
  assert.deepEqual(parsePageMessage(JSON.stringify(view)), { ok: true, value: view });
}

const page = (value: unknown): ReturnType<typeof parsePageMessage> =>
  parsePageMessage(JSON.stringify(value));

/** Stage A's view, as its page sends it. */
const VIEW: ViewMessage = { t: 'view', filter: 'orb', unfolded: [], showDone: false, selected: S1 };

/** A text of `bytes` bytes of UTF-8 that starts with `prefix` (ASCII). */
function bytesLong(bytes: number, prefix = ''): string {
  return prefix + 'a'.repeat(bytes - prefix.length);
}

/** The JSON of `view` with the string `"LONE"` replaced by one holding a lone surrogate. */
function withLone(view: Record<string, unknown>): string {
  return JSON.stringify(view).replace('"LONE"', '"a\\ud800b"');
}

describe('view: a view without the fields of stage E is taken (a page of stage A)', () => {
  test('none of chips, closed and switcher', () => {
    taken({ ...VIEW });
  });

  test('each one alone, the others absent', () => {
    taken({ ...VIEW, chips: ['note'] });
    taken({ ...VIEW, closed: [{ section: 'week', group: 'ORB-2107' }] });
    taken({ ...VIEW, switcher: 'orb' });
    taken({ ...VIEW, switcher: null });
  });

  test('all three at once, each at its limit', () => {
    const closed = Array.from({ length: MAX_CLOSED }, (_, i) => ({
      section: 'open',
      group: bytesLong(1024, `G${i}-`),
    }));
    taken({
      ...VIEW,
      chips: ['running', 'open-pr', 'note'],
      closed,
      switcher: bytesLong(1024, '>'),
    });
  });

  test('an unknown field is still refused beside them', () => {
    refused(page({ ...VIEW, chips: [], closed: [], switcher: null, [MARKER]: 1 }));
    refused(page({ ...VIEW, stacks: [] }));
    refused(page({ ...VIEW, chip: [] }));
  });
});

describe('view.chips: distinct values of SearchChip (E4)', () => {
  test('[] and each chip alone are taken', () => {
    taken({ ...VIEW, chips: [] });
    for (const chip of SEARCH_CHIPS) {
      taken({ ...VIEW, chips: [chip] });
    }
  });

  test('any order of the three is taken', () => {
    taken({ ...VIEW, chips: ['note', 'running'] });
    taken({ ...VIEW, chips: ['note', 'open-pr', 'running'] });
  });

  test("the parser's chips are SEARCH_CHIPS: the type's members, the list and what is taken agree", () => {
    // A Record over the type must name every member and nothing else (the compiler holds it).
    const members: Record<SearchChip, true> = { running: true, 'open-pr': true, note: true };
    assert.deepEqual(Object.keys(members).sort(), [...SEARCH_CHIPS].sort());
    for (const chip of Object.keys(members)) {
      assert.equal(page({ ...VIEW, chips: [chip] }).ok, true, chip);
    }
  });

  test('an unknown chip is refused, also Show done (it is view.showDone) and any other case', () => {
    for (const chip of [
      MARKER,
      'Running',
      'RUNNING',
      'open_pr',
      'openPr',
      'has-note',
      'done',
      'show-done',
      '',
      ' note',
      'note ',
    ]) {
      refused(page({ ...VIEW, chips: [chip] }));
      refused(page({ ...VIEW, chips: ['running', chip] }));
    }
  });

  test('a chip named twice is refused', () => {
    refused(page({ ...VIEW, chips: ['note', 'note'] }));
    refused(page({ ...VIEW, chips: ['running', 'open-pr', 'running'] }));
  });

  test('what is not an array of strings is refused', () => {
    for (const chips of [null, 'note', { 0: 'note' }, 1, true, [1], [null], [['note']], [{}]]) {
      refused(page({ ...VIEW, chips }));
    }
  });

  test('a name of Object.prototype is no chip', () => {
    for (const chip of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      refused(page({ ...VIEW, chips: [chip] }));
    }
  });
});

/** `view.closed`'s entries: each group closed in `section`. */
function closedIn(section: string, ...groups: string[]): { section: string; group: string }[] {
  return groups.map((group) => ({ section, group }));
}

describe(`view.closed: at most MAX_CLOSED (${MAX_CLOSED}) distinct entries, each a section and a text (E6, ruled 2026-11-16)`, () => {
  test('MAX_CLOSED is 64', () => {
    assert.equal(MAX_CLOSED, 64);
  });

  test('[] is taken (no block closed), and so are 64 entries; a 65th is refused', () => {
    taken({ ...VIEW, closed: [] });
    const entries = closedIn('week', ...Array.from({ length: MAX_CLOSED }, (_, i) => `ORB-${i}`));
    taken({ ...VIEW, closed: entries });
    refused(page({ ...VIEW, closed: [...entries, { section: 'week', group: `${MARKER}-65` }] }));
    refused(
      page({
        ...VIEW,
        closed: closedIn('open', ...Array.from({ length: 1000 }, (_, i) => `${MARKER}${i}`)),
      }),
    );
    // The limit is over all sections together.
    const mixed = Array.from({ length: MAX_CLOSED + 1 }, (_, i) => ({
      section: ['open', 'week', 'earlier'][i % 3],
      group: `G${i}`,
    }));
    taken({ ...VIEW, closed: mixed.slice(0, MAX_CLOSED) });
    refused(page({ ...VIEW, closed: mixed }));
  });

  test('each of the three sections is taken; any other name is refused', () => {
    for (const section of ['open', 'week', 'earlier']) {
      taken({ ...VIEW, closed: closedIn(section, 'ORB-1') });
    }
    for (const section of [
      MARKER,
      'Open',
      'WEEK',
      'Recent',
      'recent',
      'Earlier',
      '',
      'done',
      '__proto__',
      'constructor',
    ]) {
      refused(page({ ...VIEW, closed: closedIn(section, 'ORB-1') }));
    }
  });

  test('an entry named twice is refused; the same group in two sections, or groups that differ in case or space, are distinct', () => {
    refused(page({ ...VIEW, closed: closedIn('week', MARKER, 'x', MARKER) }));
    refused(
      page({ ...VIEW, closed: [...closedIn('open', MARKER), { group: MARKER, section: 'open' }] }),
    );
    taken({
      ...VIEW,
      closed: [
        ...closedIn('open', 'ORB-1'),
        ...closedIn('week', 'ORB-1'),
        ...closedIn('earlier', 'ORB-1'),
      ],
    });
    taken({ ...VIEW, closed: closedIn('week', 'ORB-1', 'orb-1', 'ORB-1 ', '') });
    // A group that spells another entry's JSON is still its own text.
    taken({
      ...VIEW,
      closed: [...closedIn('open', 'a'), ...closedIn('open', '{"section":"open","group":"a"}')],
    });
  });

  test('a group is a text: 1,024 bytes of UTF-8 are taken, one more is refused', () => {
    taken({ ...VIEW, closed: closedIn('open', bytesLong(1024)) });
    refused(page({ ...VIEW, closed: closedIn('open', bytesLong(1025, MARKER)) }));
    taken({ ...VIEW, closed: closedIn('week', 'é'.repeat(512)) });
    refused(page({ ...VIEW, closed: closedIn('week', 'é'.repeat(513)) }));
    taken({ ...VIEW, closed: closedIn('earlier', '🙂'.repeat(256)) });
    refused(page({ ...VIEW, closed: closedIn('earlier', `${'🙂'.repeat(256)}a`) }));
    // The limit is per group, not over all of them.
    taken({ ...VIEW, closed: closedIn('open', bytesLong(1024, 'a'), bytesLong(1024, 'b')) });
  });

  test('a group that is not well formed (a lone surrogate) is refused', () => {
    refused(parsePageMessage(withLone({ ...VIEW, closed: closedIn('week', 'ORB-1', 'LONE') })));
    assert.equal(
      parsePageMessage(
        withLone({ ...VIEW, closed: closedIn('week', 'ORB-1', 'LONE') }).replace('\\ud800', 'x'),
      ).ok,
      true,
    );
  });

  test('what is not an array of entries with exactly a section and a group is refused, null too', () => {
    for (const closed of [
      null,
      'ORB-1',
      ['ORB-1'],
      { 0: { section: 'open', group: 'ORB-1' } },
      1,
      false,
      [null],
      [[]],
      [{ section: 'open' }],
      [{ group: 'ORB-1' }],
      [{ section: 'open', group: null }],
      [{ section: 'open', group: 1 }],
      [{ section: null, group: 'ORB-1' }],
      [{ section: ['open'], group: 'ORB-1' }],
      [{ section: 'open', group: 'ORB-1', open: false }],
      [{ section: 'open', group: 'ORB-1', [MARKER]: 1 }],
    ]) {
      refused(page({ ...VIEW, closed }));
    }
  });

  test('`opened`, the field it replaced, is refused (the page and the server are one build)', () => {
    refused(page({ ...VIEW, opened: [] }));
    refused(page({ ...VIEW, opened: ['ORB-1'], closed: [] }));
  });
});

describe('view.switcher: null or a text (E8)', () => {
  test('null, the empty text, a command and 1,024 bytes are taken, byte for byte', () => {
    taken({ ...VIEW, switcher: null });
    taken({ ...VIEW, switcher: '' });
    taken({ ...VIEW, switcher: '>restore' });
    taken({ ...VIEW, switcher: '  orb  fix\t' });
    taken({ ...VIEW, switcher: 'a\u0000b\u200bc' });
    taken({ ...VIEW, switcher: bytesLong(1024) });
    taken({ ...VIEW, switcher: 'é'.repeat(512) });
  });

  test('1,025 bytes are refused, and the kind quotes none of it', () => {
    refused(page({ ...VIEW, switcher: bytesLong(1025, MARKER) }));
    refused(page({ ...VIEW, switcher: 'é'.repeat(513) }));
    refused(page({ ...VIEW, switcher: `${'🙂'.repeat(256)}a` }));
  });

  test('a lone surrogate is refused', () => {
    refused(parsePageMessage(withLone({ ...VIEW, switcher: 'LONE' })));
  });

  test('what is neither null nor a string is refused', () => {
    for (const switcher of [0, false, true, [], ['orb'], {}, { text: 'orb' }]) {
      refused(page({ ...VIEW, switcher }));
    }
  });
});

describe('a refusal never quotes what it refused', () => {
  test('a marker in a chip, in a group, in a switcher text', () => {
    refused(page({ ...VIEW, chips: [MARKER] }));
    refused(page({ ...VIEW, chips: [`running${MARKER}`] }));
    refused(page({ ...VIEW, closed: closedIn('open', MARKER, MARKER) }));
    refused(page({ ...VIEW, closed: closedIn('open', MARKER.repeat(100)) }));
    refused(page({ ...VIEW, closed: closedIn(MARKER, 'ORB-1') }));
    refused(
      page({ ...VIEW, closed: [{ section: 'open', group: 1 }, ...closedIn('open', MARKER)] }),
    );
    refused(page({ ...VIEW, switcher: MARKER.repeat(100) }));
    refused(page({ ...VIEW, switcher: [MARKER] }));
  });
});

describe('the types of stage E (plan E 2.3) compile', () => {
  test('a view with every field of stage E', () => {
    const view: ViewMessage = {
      t: 'view',
      filter: 'orb fix',
      unfolded: ['earlier'],
      showDone: false,
      selected: null,
      chips: ['running', 'note'],
      closed: [{ section: 'earlier', group: 'ORB-2107' }],
      switcher: '>rest',
    };
    assert.equal(page(view).ok, true);
    const misspelt = {
      t: 'view',
      filter: '',
      unfolded: [],
      showDone: false,
      selected: null,
      // @ts-expect-error a chip is one of SearchChip
      chips: ['done'],
    } satisfies ViewMessage;
    refused(page(misspelt));
  });

  test('a row in a stack, and the list with filtering and the switcher', () => {
    const stack: StackPayload = { group: 'ORB-2107', size: 3, role: 'head', head: S1 };
    // F9: a closed block is a caption of its section, none of its rows in `rows`.
    const caption: ClosedStackPayload = {
      group: 'ORB-2107',
      size: 3,
      needYou: 1,
      head: S1,
      at: 0,
    };
    const closedSection = { closedStacks: [caption] } satisfies Pick<
      SectionPayload,
      'closedStacks'
    >;
    // Required (ruled on review 1 of F9): a section without closed blocks carries `[]`.
    const plainSection = { closedStacks: [] } satisfies Pick<SectionPayload, 'closedStacks'>;
    // @ts-expect-error every section carries closedStacks
    const missing: Pick<SectionPayload, 'closedStacks'> = {};
    assert.equal(closedSection.closedStacks.length, 1);
    assert.deepEqual([plainSection.closedStacks, missing], [[], {}]);
    const shut: ClosedBlock = { section: 'open', group: 'ORB-2107' };
    // @ts-expect-error a closed block's section is one of the three
    const wrong: ClosedBlock = { section: 'done', group: 'ORB-2107' };
    refused(page({ ...VIEW, closed: [wrong] }));
    taken({ ...VIEW, closed: [shut] });
    const row = { stack } satisfies Pick<RowPayload, 'stack'>;
    const rank: SwitchRank = 'not-running';
    const hiddenBy: HiddenBy[] = ['filter', 'done', 'folded'];
    const item = {
      rank,
      found: [[0, 3]],
      hiddenBy,
    } satisfies Omit<SwitchItem, 'row'>;
    const restore: RestoreOffer = { count: 1, lastActivityNs: '1', sessionIds: [S1] };
    const switcher: SwitcherPayload = {
      query: 'orb',
      command: false,
      items: [],
      more: 0,
      restore,
    };
    const list = { filtering: true, switcher } satisfies Pick<
      ListMessage,
      'filtering' | 'switcher'
    >;
    // Optional for the reader: a list of stage A has neither.
    const older: Pick<ListMessage, 'filtering' | 'switcher'> = {};
    assert.deepEqual(JSON.parse(JSON.stringify({ row, item, list, older })), {
      row,
      item,
      list,
      older,
    });
  });
});
