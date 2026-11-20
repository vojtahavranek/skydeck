// S2 12.3: the window's pull-request chip (plan D4), the view model's pure function over the levels
// step 1 computes (design 7.3's `prLevel`).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CHIP_ORDER, prLevel } from '../../../src/github.ts';
import type { ChipLevel } from '../../../src/github.ts';
import { windowChip } from '../../../src/window/view/chip.ts';
import { prRow } from '../../helpers/derived.ts';

const prs = (...levels: string[]): { level: string }[] => levels.map((level) => ({ level }));
const times = (n: number, level: ChipLevel): ChipLevel[] => Array.from({ length: n }, () => level);

describe("windowChip: every row of S2 12.3's table", () => {
  const table: [string, string[], { level: string; open: number; merged: number }][] = [
    [
      '1 open, review required',
      ['review-required'],
      { level: 'review-required', open: 1, merged: 0 },
    ],
    [
      '1 open, checks failing; 30 merged',
      ['checks-failing', ...times(30, 'merged')],
      { level: 'checks-failing', open: 1, merged: 30 },
    ],
    [
      '2 open: a draft and an approved, green one',
      ['approved-green', 'draft'],
      { level: 'draft', open: 2, merged: 0 },
    ],
    [
      '2 open: one that cannot be read and one with changes requested; 4 merged',
      ['merged', 'changes-requested', 'merged', 'cant-read', 'merged', 'merged'],
      { level: 'cant-read', open: 2, merged: 4 },
    ],
    [
      '3 open, the worst failing; 30 merged',
      ['checks-pending', ...times(30, 'merged'), 'checks-failing', 'approved-green'],
      { level: 'checks-failing', open: 3, merged: 30 },
    ],
    [
      'none open; 3 merged, 1 closed',
      ['merged', 'closed', 'merged', 'merged'],
      { level: 'merged', open: 0, merged: 3 },
    ],
    ['none open; 1 closed', ['closed'], { level: 'closed', open: 0, merged: 0 }],
  ];
  for (const [name, levels, chip] of table) {
    test(name, () => {
      assert.deepEqual(windowChip(prs(...levels)), chip);
    });
  }
});

describe('windowChip: the rest of S2 12.3', () => {
  test('none attached: no chip', () => {
    assert.equal(windowChip([]), null);
  });

  test('only never-fetched ones are open: not fetched, counted', () => {
    assert.deepEqual(windowChip(prs('unfetched', 'unfetched', 'unfetched')), {
      level: 'unfetched',
      open: 3,
      merged: 0,
    });
  });

  test("a can't-read one with merged ones: can't read, one open, the merged apart", () => {
    assert.deepEqual(windowChip(prs('merged', 'cant-read', 'merged')), {
      level: 'cant-read',
      open: 1,
      merged: 2,
    });
  });

  test('closed ones are not counted, beside open and merged ones too', () => {
    assert.deepEqual(windowChip(prs('closed', 'draft', 'closed', 'merged')), {
      level: 'draft',
      open: 1,
      merged: 1,
    });
  });

  test("the open one shown is the first in design 7.3's order (CHIP_ORDER) without merged and closed", () => {
    const open = CHIP_ORDER.filter((level) => level !== 'merged' && level !== 'closed');
    assert.deepEqual(open, [
      'cant-read',
      'unfetched',
      'checks-failing',
      'changes-requested',
      'checks-pending',
      'review-required',
      'unresolved-comments',
      'draft',
      'checks-not-reported',
      'blocked',
      'open',
      'checks-passing',
      'approved-green',
    ]);
    // Each level against every one after it, in both orders of the input.
    open.forEach((worst, at) => {
      for (const better of open.slice(at + 1)) {
        for (const levels of [
          [worst, better],
          [better, worst],
        ]) {
          assert.deepEqual(windowChip(prs(...levels, 'merged')), {
            level: worst,
            open: 2,
            merged: 1,
          });
        }
      }
    });
  });

  test("over step 1's levels: a pull request that cannot be read was last seen open, so it is open", () => {
    const failing = prRow('acme/web', 7, { checks: 'failing' });
    const unreadable = prRow('acme/db', 3, { error: 'HTTP 502' });
    const neverFetched = prRow('acme/api', 9, { state: null, okAtNs: null });
    const merged = prRow('acme/api', 30, { state: 'merged' });
    const closed = prRow('acme/api', 31, { state: 'closed' });
    const views = [failing, unreadable, neverFetched, merged, closed].map((pr) => ({
      level: prLevel(pr),
    }));
    assert.deepEqual(windowChip(views), { level: 'cant-read', open: 3, merged: 1 });
  });

  test('a level design 7.3 does not name is open and needs the user less than every known one', () => {
    assert.deepEqual(windowChip(prs('later-level', 'approved-green')), {
      level: 'approved-green',
      open: 2,
      merged: 0,
    });
    assert.deepEqual(windowChip(prs('later-level', 'merged')), {
      level: 'later-level',
      open: 1,
      merged: 1,
    });
  });

  test('the input is not changed', () => {
    const input = prs('merged', 'draft');
    const copy = structuredClone(input);
    windowChip(input);
    assert.deepEqual(input, copy);
  });
});
