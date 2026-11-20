// Follow-up F33 (S2 12.2): the marks of a copy's row. While it is empty: `empty copy`, whose
// tooltip names the original and says it shows by itself once it has a first message; once used:
// `continued`, whose tooltip names the original it began as a copy of. Every other row keeps its
// marks and their words. node:test on web/list-text.js, which uses no DOM.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RowPayload } from '../../src/window/protocol.ts';
import { rowText } from '../../web/list-text.js';

const NOW = '1794474000000000000';
const ID = '11111111-2222-4333-8444-555555555555';
const ORIGINAL = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';

function row(over: Partial<RowPayload> = {}): RowPayload {
  return {
    id: ID,
    shortId: ID.slice(0, 8),
    title: 'A made-up title',
    titleSource: 'generated',
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: NOW,
    lastActivityNs: NOW,
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

const marksOf = (over: Partial<RowPayload>) => rowText(row(over), NOW, null).marks;

const EMPTY_TIP =
  'an empty copy of "A made-up title" made by Claude Code; it shows by itself once it has a first message';

describe('the marks of a copy', () => {
  test('empty: `empty copy` in the place of `continued`, its tooltip naming the original', () => {
    assert.deepEqual(
      marksOf({
        marks: ['continued', 'empty-copy'],
        copyOf: { id: ORIGINAL, title: 'A made-up title' },
      }),
      [{ kind: 'continued', text: 'empty copy', tip: EMPTY_TIP }],
    );
  });

  test('empty, with other marks and done: each keeps its place', () => {
    assert.deepEqual(
      marksOf({
        marks: ['ended-unexpectedly', 'continued', 'empty-copy'],
        copyOf: { id: ORIGINAL, title: 'A made-up title' },
        done: true,
      }).map((mark) => mark.text),
      ['crashed', 'empty copy', 'done'],
    );
  });

  test('empty but listed anyway (the user kept it, or a terminal of the window shows it): "it has no message yet"', () => {
    assert.deepEqual(
      marksOf({
        marks: ['continued', 'empty-copy'],
        copyOf: { id: ORIGINAL, title: 'A made-up title', hiddenWhileEmpty: false },
      }),
      [
        {
          kind: 'continued',
          text: 'empty copy',
          tip: 'an empty copy of "A made-up title" made by Claude Code; it has no message yet',
        },
      ],
    );
    assert.deepEqual(
      marksOf({
        marks: ['continued', 'empty-copy'],
        copyOf: { id: ORIGINAL, title: 'A made-up title', hiddenWhileEmpty: true },
      }).map((mark) => mark.tip),
      [EMPTY_TIP],
      'shown only by `a` or a search: the long form',
    );
  });

  test('an original skydeck does not know: named by its short id', () => {
    assert.deepEqual(
      marksOf({ marks: ['continued', 'empty-copy'], copyOf: { id: ORIGINAL, title: null } }),
      [
        {
          kind: 'continued',
          text: 'empty copy',
          tip: 'an empty copy of session 0b5f3c1e made by Claude Code; it shows by itself once it has a first message',
        },
      ],
    );
  });

  test('once used: `continued`, its tooltip naming the original it began as a copy of', () => {
    assert.deepEqual(
      marksOf({ marks: ['continued'], copyOf: { id: ORIGINAL, title: 'A made-up title' } }),
      [{ kind: 'continued', text: 'continued', tip: 'it began as a copy of "A made-up title"' }],
    );
  });

  test('the original’s title is sanitised again on the page', () => {
    const [mark] = marksOf({
      marks: ['continued'],
      copyOf: { id: ORIGINAL, title: 'red\u001b[31m text\u0007' },
    });
    assert.equal(mark?.tip, 'it began as a copy of "red text"');
  });

  test('`empty-copy` is never shown as a mark of its own, even without `continued`', () => {
    assert.deepEqual(
      marksOf({ marks: ['empty-copy'], copyOf: { id: ORIGINAL, title: 'A made-up title' } }),
      [{ kind: 'continued', text: 'empty copy', tip: EMPTY_TIP }],
    );
  });
});

describe('every other row as before', () => {
  test('a continued row that is no copy (copyOf null or absent, a server before F33)', () => {
    const expected = [
      {
        kind: 'continued',
        text: 'continued',
        tip: 'it continues another session (/clear or a fork)',
      },
    ];
    assert.deepEqual(marksOf({ marks: ['continued'], copyOf: null }), expected);
    assert.deepEqual(marksOf({ marks: ['continued'] }), expected);
  });

  test('a copyOf that is not an object of strings is none', () => {
    for (const copyOf of [{ id: 7, title: 'x' }, 'x', [], { title: 'x' }]) {
      assert.deepEqual(
        marksOf({ marks: ['continued'], copyOf: copyOf as unknown as RowPayload['copyOf'] }).map(
          (mark) => mark.tip,
        ),
        ['it continues another session (/clear or a fork)'],
        JSON.stringify(copyOf),
      );
    }
  });
});
