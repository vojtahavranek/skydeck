// Follow-up F40 (S2 12.6): the words of the carry-over bar (web/carry-over-text.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APPLY_TEXT,
  DISMISS_TEXT,
  DISMISS_TITLE,
  DONE_TEXT,
  NOTHING_TO_CARRY,
  WAITING_TEXT,
  carryHeading,
  fieldText,
  keptText,
} from '../../web/carry-over-text.js';

test('the heading, with and without a ticket', () => {
  assert.equal(
    carryHeading({ id: 'x', title: 'fix the retry', ticket: 'TRY-1' }),
    'Cleared from "fix the retry" · TRY-1',
  );
  assert.equal(
    carryHeading({ id: 'x', title: 'fix the retry', ticket: null }),
    'Cleared from "fix the retry"',
  );
});

test("each field's words; one pull request and three", () => {
  assert.equal(fieldText({ name: 'label', text: 'fix', ticked: true }, 0), 'label');
  assert.equal(fieldText({ name: 'group', text: 'backend', ticked: true }, 0), 'group backend');
  assert.equal(fieldText({ name: 'ticket', text: 'TRY-1', ticked: true }, 0), 'ticket TRY-1');
  assert.equal(fieldText({ name: 'note', text: null, ticked: false }, 0), 'note');
  assert.equal(fieldText({ name: 'prs', text: null, ticked: false }, 1), '1 pull request');
  assert.equal(fieldText({ name: 'prs', text: null, ticked: false }, 3), '3 pull requests');
});

test('the kept line', () => {
  assert.equal(keptText([]), '');
  assert.equal(keptText(['label']), 'already set here: label');
  assert.equal(keptText(['label', 'note', 'prs']), 'already set here: label, note, pull requests');
});

test('the constants the page tests read', () => {
  assert.equal(DONE_TEXT, 'mark the old one done');
  assert.equal(APPLY_TEXT, 'Carry over');
  assert.equal(DISMISS_TEXT, '×');
  assert.equal(DISMISS_TITLE, 'Dismiss: carry nothing over');
  assert.equal(WAITING_TEXT, 'carrying over…');
  assert.equal(NOTHING_TO_CARRY, 'nothing to carry over to this session');
});
