// What the new form starts from (S2 12.6, follow-up F28): the session it takes its directory from,
// that session's group as the Group field's one suggestion, and the groups the list shows as the
// field's completions. node:test on web/new-form-text.js, which uses no DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ClosedStackPayload,
  ListMessage,
  RowPayload,
  SectionPayload,
} from '../../src/window/protocol.ts';
import { newFormDefaults } from '../../web/new-form-text.js';
import { S1, S2, S3 } from '../helpers/platform.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const S5 = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
const T1 = '0123456789ab';
const DIRS = ['/home/u/recent', '/home/u/older'];

function row(id: string, more: Partial<RowPayload> = {}): RowPayload {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `title of ${id.slice(0, 8)}`,
    titleSource: 'summary',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: '1794474000000000000',
    lastActivityNs: '1794474000000000000',
    dir: `/home/u/dir-${id.slice(0, 4)}`,
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
    ...more,
  };
}

/** A row in `group`, the group as the list shows it, from where `source` says. */
const grouped = (id: string, group: string, source = 'meta', more: Partial<RowPayload> = {}) =>
  row(id, { group, groupSource: source, ...more });

function section(
  name: SectionPayload['name'],
  rows: RowPayload[],
  closedStacks: ClosedStackPayload[] = [],
): SectionPayload {
  return {
    name,
    folded: false,
    firstNs: null,
    lastNs: null,
    count: rows.length,
    rows,
    closedStacks,
  };
}

function caption(group: string, at: number): ClosedStackPayload {
  return { group, size: 2, needYou: 0, head: S5, at };
}

/** A list of `sections` (Open alone when given rows), its `dirs` and its `selectedRow`. */
function listOf(
  sections: SectionPayload[] | RowPayload[],
  more: { dirs?: string[]; selectedRow?: RowPayload | null } = {},
): ListMessage {
  const parts = sections.every((one) => 'rows' in one)
    ? (sections as SectionPayload[])
    : [section('open', sections as RowPayload[])];
  return {
    t: 'list',
    nowNs: '1794474000000000000',
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    needYou: { count: 0, order: [] },
    sections: parts,
    doneHidden: 0,
    banner: null,
    terminals: [],
    selected: null,
    dirs: more.dirs ?? DIRS,
    ...(more.selectedRow === undefined ? {} : { selectedRow: more.selectedRow }),
  };
}

test('no list: an empty directory, no suggestion, no completion', () => {
  assert.deepEqual(newFormDefaults(null, null), { dir: '', dirs: [], group: null, groups: [] });
  assert.deepEqual(newFormDefaults(null, S1), { dir: '', dirs: [], group: null, groups: [] });
});

test("no selection: the most recent directory, no suggestion; the list's groups as completions", () => {
  const list = listOf([grouped(S1, 'ABC-123', 'title'), row(S2), grouped(S3, 'infra')]);
  assert.deepEqual(newFormDefaults(list, null), {
    dir: '/home/u/recent',
    dirs: DIRS,
    group: null,
    groups: ['ABC-123', 'infra'],
  });
  assert.equal(newFormDefaults(listOf([row(S1)], { dirs: [] }), null).dir, '');
});

test('a selection without a group: its directory, no suggestion, the completions in their order', () => {
  const list = listOf([grouped(S1, 'ABC-123', 'title'), row(S2), grouped(S3, 'infra')]);
  assert.deepEqual(newFormDefaults(list, S2), {
    dir: row(S2).dir,
    dirs: DIRS,
    group: null,
    groups: ['ABC-123', 'infra'],
  });
});

test('a selection with a stored group: that group is the suggestion and the first completion', () => {
  const list = listOf([grouped(S1, 'ABC-123', 'title'), row(S2), grouped(S3, 'infra')]);
  assert.deepEqual(newFormDefaults(list, S3), {
    dir: row(S3).dir,
    dirs: DIRS,
    group: 'infra',
    groups: ['infra', 'ABC-123'],
  });
});

test("a selection whose group is its title's key: that key, as the list shows it", () => {
  const list = listOf([row(S2), grouped(S1, 'ABC-123', 'title'), grouped(S3, 'infra')]);
  const made = newFormDefaults(list, S1);
  assert.equal(made.group, 'ABC-123');
  assert.deepEqual(made.groups, ['ABC-123', 'infra']);
  assert.equal(made.dir, row(S1).dir);
});

test('a selected row without a directory: the most recent known one, its group all the same', () => {
  const list = listOf([grouped(S1, 'ABC-123', 'title', { dir: null })]);
  assert.deepEqual(newFormDefaults(list, S1), {
    dir: '/home/u/recent',
    dirs: DIRS,
    group: 'ABC-123',
    groups: ['ABC-123'],
  });
});

test('a hidden selection whose terminal the window shows: its directory and its group, first, also when no listed row has it', () => {
  const hidden = grouped(S4, 'ops-7', 'meta', { terminal: T1, state: 'running' });
  const list = listOf([grouped(S1, 'ABC-123', 'title'), row(S2)], { selectedRow: hidden });
  assert.deepEqual(newFormDefaults(list, S4), {
    dir: hidden.dir,
    dirs: DIRS,
    group: 'ops-7',
    groups: ['ops-7', 'ABC-123'],
  });
});

test('a hidden selection without a terminal of the window: nothing of it, as for no selection', () => {
  const hidden = grouped(S4, 'ops-7');
  const list = listOf([grouped(S1, 'ABC-123', 'title'), row(S2)], { selectedRow: hidden });
  assert.deepEqual(newFormDefaults(list, S4), {
    dir: '/home/u/recent',
    dirs: DIRS,
    group: null,
    groups: ['ABC-123'],
  });
});

test("the list's selectedRow of another session, or no row of the selection at all: nothing of it", () => {
  const stale = grouped(S4, 'ops-7', 'meta', { terminal: T1, state: 'running' });
  const list = listOf([grouped(S1, 'ABC-123', 'title')], { selectedRow: stale });
  assert.deepEqual(newFormDefaults(list, S5), {
    dir: '/home/u/recent',
    dirs: DIRS,
    group: null,
    groups: ['ABC-123'],
  });
  assert.equal(newFormDefaults(listOf([row(S1)]), S2).group, null);
});

test('a listed selection is taken whatever selectedRow says; a listed row without a terminal too', () => {
  const listed = grouped(S1, 'ABC-123', 'title');
  const list = listOf([listed], { selectedRow: grouped(S1, 'other') });
  assert.equal(newFormDefaults(list, S1).group, 'ABC-123');
  assert.equal(newFormDefaults(list, S1).dir, listed.dir);
});

test("duplicates: each group once, at its first place, the selection's not repeated", () => {
  const list = listOf([
    section('open', [grouped(S1, 'infra'), grouped(S2, 'ABC-123', 'title')]),
    section('week', [grouped(S3, 'ABC-123', 'title'), grouped(S4, 'infra')], [caption('infra', 0)]),
    section('earlier', [grouped(S5, 'ABC-123', 'meta')], [caption('ABC-123', 1)]),
  ]);
  assert.deepEqual(newFormDefaults(list, null).groups, ['infra', 'ABC-123']);
  assert.deepEqual(newFormDefaults(list, S2).groups, ['ABC-123', 'infra']);
  assert.deepEqual(newFormDefaults(list, S4).groups, ['infra', 'ABC-123']);
});

test("order: the sections' order, a closed block's caption at its place among the rows", () => {
  const list = listOf([
    section('open', [grouped(S1, 'o1'), row(S2)], [caption('c-before-first', 0)]),
    section(
      'week',
      [grouped(S3, 'w1'), grouped(S4, 'w2')],
      [caption('c-mid-a', 1), caption('c-mid-b', 1), caption('c-end', 2), caption('c-start', 0)],
    ),
    section('earlier', [], [caption('c-only', 0)]),
  ]);
  assert.deepEqual(newFormDefaults(list, null).groups, [
    'c-before-first',
    'o1',
    'c-start',
    'w1',
    'c-mid-a',
    'c-mid-b',
    'w2',
    'c-end',
    'c-only',
  ]);
  assert.deepEqual(newFormDefaults(list, S4).groups, [
    'w2',
    'c-before-first',
    'o1',
    'c-start',
    'w1',
    'c-mid-a',
    'c-mid-b',
    'c-end',
    'c-only',
  ]);
});

test("a caption placed past its section's rows is drawn by no list (web/list.js), so it is offered by none", () => {
  const list = listOf([
    section('open', [grouped(S1, 'o1')], [caption('c-past', 2), caption('c-end', 1)]),
    section('week', [], [caption('c-far', 3)]),
  ]);
  assert.deepEqual(newFormDefaults(list, null).groups, ['o1', 'c-end']);
});

test('a group is exact text: case, a trailing space, NFC and NFD, and names of Object members are groups of their own', () => {
  const names = ['abc', 'ABC', 'x', 'x ', 'é', 'é', '__proto__', 'constructor', 'toString'];
  const list = listOf(
    names.map((name, i) => grouped(`${S1.slice(0, -2)}${String(i).padStart(2, '0')}`, name)),
  );
  assert.deepEqual(newFormDefaults(list, null).groups, names);
  const selected = `${S1.slice(0, -2)}06`;
  assert.equal(newFormDefaults(list, selected).group, '__proto__');
  assert.deepEqual(newFormDefaults(list, selected).groups, [
    '__proto__',
    ...names.filter((one) => one !== '__proto__'),
  ]);
});

test('a row with no group, or an empty one, adds no completion and is no suggestion', () => {
  const list = listOf([row(S1), grouped(S2, ''), grouped(S3, 'infra')]);
  assert.deepEqual(newFormDefaults(list, null).groups, ['infra']);
  assert.equal(newFormDefaults(list, S2).group, null);
  assert.deepEqual(newFormDefaults(list, S2).groups, ['infra']);
});

test("as the list shows them: every group through the page's sanitiser (design 7.4), once by its shown text; one that shows as nothing is none", () => {
  const list = listOf([
    grouped(S1, '\x1b[31minfra\x1b[0m'),
    grouped(S2, 'infra'),
    grouped(S3, 'ops\t7‮'),
    grouped(S4, '\x07\x1b[0m'),
  ]);
  assert.deepEqual(newFormDefaults(list, null).groups, ['infra', 'ops 7']);
  assert.deepEqual(newFormDefaults(list, S1), {
    dir: row(S1).dir,
    dirs: DIRS,
    group: 'infra',
    groups: ['infra', 'ops 7'],
  });
  assert.equal(newFormDefaults(list, S3).group, 'ops 7');
  assert.equal(newFormDefaults(list, S4).group, null);
  assert.deepEqual(newFormDefaults(list, S4).groups, ['infra', 'ops 7']);
});

test('the input is not changed, and the answer holds arrays of its own', () => {
  const list = listOf([section('open', [grouped(S1, 'ABC-123', 'title')], [caption('infra', 1)])]);
  const frozen = structuredClone(list);
  const deepFreeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      Object.freeze(value);
      for (const inner of Object.values(value)) deepFreeze(inner);
    }
  };
  deepFreeze(frozen);
  const made = newFormDefaults(frozen, S1);
  assert.deepEqual(made, {
    dir: row(S1).dir,
    dirs: DIRS,
    group: 'ABC-123',
    groups: ['ABC-123', 'infra'],
  });
  assert.notEqual(made.dirs, frozen.dirs);
  made.dirs.push('/x');
  made.groups.push('y');
  assert.deepEqual(newFormDefaults(frozen, S1).dirs, DIRS);
});
