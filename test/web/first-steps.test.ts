// Follow-up F22: the rule for the window with no session at all — web/list-text.js's
// `holdsNoSession`, which the list (its short text) and app.js (the right side's line) both read.
// node:test on web/list-text.js, which uses no DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ListMessage, SectionPayload } from '../../src/window/protocol.ts';
import { holdsNoSession } from '../../web/list-text.js';

function section(name: SectionPayload['name'], count: number, folded = false): SectionPayload {
  return { name, folded, firstNs: null, lastNs: null, count, rows: [], closedStacks: [] };
}

/** A list whose sections hold `counts` sessions (Open, Recent, Earlier). */
function list(counts: [number, number, number], more: Partial<ListMessage> = {}): ListMessage {
  return {
    t: 'list',
    nowNs: '1794474000000000000',
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    needYou: { count: 0, order: [] },
    sections: [
      section('open', counts[0]),
      section('week', counts[1]),
      section('earlier', counts[2]),
    ],
    doneHidden: 0,
    banner: null,
    terminals: [],
    selected: null,
    dirs: [],
    ...more,
  };
}

test('holdsNoSession: no session in any section and no filter — true; done ones hidden do not count', () => {
  assert.equal(holdsNoSession(list([0, 0, 0]), ''), true);
  assert.equal(holdsNoSession(list([0, 0, 0], { filtering: false }), ''), true);
  assert.equal(holdsNoSession(list([0, 0, 0], { doneHidden: 3 }), ''), true);
});

test('holdsNoSession: a session in any section, a folded Earlier too — false', () => {
  assert.equal(holdsNoSession(list([1, 0, 0]), ''), false);
  assert.equal(holdsNoSession(list([0, 2, 0]), ''), false);
  const folded = list([0, 0, 0]);
  folded.sections[2] = section('earlier', 4, true); // folded: its count, no row
  assert.equal(holdsNoSession(folded, ''), false);
});

test("holdsNoSession: while the view filters (the server's word, or the field's text for a list without it) — false", () => {
  assert.equal(holdsNoSession(list([0, 0, 0], { filtering: true }), ''), false);
  assert.equal(holdsNoSession(list([0, 0, 0], { filtering: true }), 'zzz'), false);
  // A list without `filtering` (before stage E): the field's text says.
  assert.equal(holdsNoSession(list([0, 0, 0]), 'zzz'), false);
  // The server's word wins over the field's text, as in the list (E5).
  assert.equal(holdsNoSession(list([0, 0, 0], { filtering: false }), 'zzz'), true);
});

test('holdsNoSession: no list yet — false (nothing is known)', () => {
  assert.equal(holdsNoSession(null, ''), false);
});
