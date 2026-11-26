// A session's shell (issue #199; S2 12.6): the split's rules (web/shell-panel-split.js, pure): the
// default third, a stored height held to both bounds, the too-low rule at its boundary, the stored
// values that are none, the drag's height, and the bar's height as the style sheet has it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  atPress,
  BAR_PX,
  BAR_TITLE,
  draggedHeight,
  dragBegun,
  heightOf,
  layoutOf,
  LEAST_FALLBACK,
  MAX_STORED,
  MIN_ROWS,
  SHELL_HEIGHT_KEY,
} from '../../web/shell-panel-split.js';
import * as listWidth from '../../web/list-width-text.js';

test('the numbers and the words', () => {
  assert.equal(MIN_ROWS, 4);
  assert.equal(BAR_PX, 6);
  assert.equal(LEAST_FALLBACK, 4 * 17 + 16);
  assert.equal(SHELL_HEIGHT_KEY, 'skydeck-shell-height');
  assert.equal(BAR_TITLE, 'Drag to change the height of the shell. Double-click: back to a third.');
  assert.equal(dragBegun, listWidth.dragBegun, "the list handle's rule of a drag's begin");
  assert.equal(atPress, listWidth.atPress);
  const css = readFileSync(new URL('../../web/shell-panel.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`\\.shell-bar \\{[^}]*\\bheight: ${BAR_PX}px;`), 'the bar in CSS');
});

test('without a stored height the shell is a third of the area, rounded', () => {
  assert.deepEqual(layoutOf(600, null, 84), { mode: 'split', shell: 200 });
  assert.deepEqual(layoutOf(601, null, 84), { mode: 'split', shell: 200 });
  assert.deepEqual(layoutOf(602, null, 84), { mode: 'split', shell: 201 });
  assert.deepEqual(layoutOf(700.5, null, 84), { mode: 'split', shell: 234 });
});

test('a stored height is held to both bounds: least, and the area less the bar and least', () => {
  const least = 84;
  const area = 600;
  assert.deepEqual(layoutOf(area, 250, least), { mode: 'split', shell: 250 });
  assert.deepEqual(layoutOf(area, 1, least), { mode: 'split', shell: least });
  assert.deepEqual(layoutOf(area, least, least), { mode: 'split', shell: least });
  const most = area - BAR_PX - least;
  assert.deepEqual(layoutOf(area, most, least), { mode: 'split', shell: most });
  assert.deepEqual(layoutOf(area, most + 1, least), { mode: 'split', shell: most });
  assert.deepEqual(layoutOf(area, MAX_STORED, least), { mode: 'split', shell: most });
  // A third that is under least (a low area) is least.
  assert.deepEqual(layoutOf(200, null, 90), { mode: 'split', shell: 90 });
});

test('too low: under twice least and the bar the shell takes the whole area; at it, both are least', () => {
  for (const least of [84, 100, LEAST_FALLBACK]) {
    const boundary = 2 * least + BAR_PX;
    assert.deepEqual(layoutOf(boundary - 1, null, least), { mode: 'full' }, `${least}: −1`);
    assert.deepEqual(layoutOf(boundary - 0.5, 500, least), { mode: 'full' });
    assert.deepEqual(layoutOf(boundary, null, least), { mode: 'split', shell: least });
    assert.deepEqual(layoutOf(boundary, 500, least), { mode: 'split', shell: least });
    assert.deepEqual(layoutOf(boundary, 1, least), { mode: 'split', shell: least });
  }
  assert.deepEqual(layoutOf(0, null, 84), { mode: 'full' });
  assert.deepEqual(layoutOf(Number.NaN, null, 84), { mode: 'full' }, 'an area not measured');
});

test('stored values that are none: anything but a whole number of 1 to 100,000 in decimal digits', () => {
  for (const value of [
    null,
    undefined,
    '',
    ' ',
    '0',
    '-1',
    '+200',
    '200px',
    '200.5',
    '200.0',
    '.5',
    '1e3',
    ' 200',
    '200 ',
    '0x10',
    '100001',
    '99999999999999999999',
    200,
    'high',
  ]) {
    assert.equal(heightOf(value), null, JSON.stringify(value));
  }
  assert.equal(heightOf('1'), 1);
  assert.equal(heightOf('250'), 250);
  assert.equal(heightOf('0250'), 250);
  assert.equal(heightOf('100000'), MAX_STORED);
});

test("the drag: the press's height and as many px more as the pointer went up", () => {
  assert.equal(draggedHeight(200, 500, 380), 320);
  assert.equal(draggedHeight(200, 500, 560), 140);
  assert.equal(draggedHeight(200, 500, 500), 200);
  assert.equal(dragBegun(500, 503), false, 'a slip of 3 px is no drag');
  assert.equal(dragBegun(500, 496), true);
});
