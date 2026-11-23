// The list's width (issue #192; S2 12.1): the bounds, the one key of the page's localStorage and
// the rule of a stored value (web/list-width-text.js, pure); the script that applies a stored
// width before the first paint (web/list-width-early.js, a classic script, run here in a VM
// context of its own) reads exactly what list-width-text.js reads; and style.css's `.main` holds
// the shown width with the same numbers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  atPress,
  DEFAULT_WIDTH,
  DRAG_SLIP,
  dragBegun,
  HANDLE_TITLE,
  held,
  LIST_WIDTH_KEY,
  MAX_WIDTH,
  MIN_WIDTH,
  RIGHT_ROOM,
  shownWidth,
  widthOf,
} from '../../web/list-width-text.js';

const WEB = new URL('../../web/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, WEB), 'utf8');

/** Stored values that are no whole number: each means nothing stored. */
const NO_WIDTH: unknown[] = [
  null,
  undefined,
  '',
  ' ',
  'wide',
  '500px',
  '500.5',
  '500.0',
  '.5',
  '1e3',
  '+500',
  ' 500',
  '500 ',
  '500\n',
  '0x1f4',
  '--500',
  '-',
  'NaN',
  'Infinity',
  '５００',
  500,
  {},
];

/** Whole numbers and the width each stands for. */
const WHOLE: [string, number][] = [
  ['240', 240],
  ['400', 400],
  ['523', 523],
  ['800', 800],
  ['0500', 500],
  ['239', 240],
  ['0', 240],
  ['-0', 240],
  ['-5', 240],
  ['-99999', 240],
  ['801', 800],
  ['99999999', 800],
  ['9'.repeat(400), 800],
];

describe('the bounds and the stored value (web/list-width-text.js)', () => {
  test('one key of the page’s localStorage; 400 px by default, 240 … 800, the right side keeps 320', () => {
    assert.equal(LIST_WIDTH_KEY, 'skydeck-list-width');
    assert.equal(DEFAULT_WIDTH, 400);
    assert.equal(MIN_WIDTH, 240);
    assert.equal(MAX_WIDTH, 800);
    assert.equal(RIGHT_ROOM, 320);
  });

  test('a whole number is that width held to 240 … 800 (a negative one 240, a huge one 800)', () => {
    for (const [value, width] of WHOLE) {
      assert.equal(widthOf(value), width, value.slice(0, 20));
    }
  });

  test('anything that is no whole number — a fraction, a word, white space, an exponent, a sign but -, a number not stored as text — is nothing stored', () => {
    for (const value of NO_WIDTH) {
      assert.equal(widthOf(value), null, JSON.stringify(value) ?? String(value));
    }
  });

  test('a dragged width is rounded to a whole px and held to 240 … 800', () => {
    assert.equal(held(523.4), 523);
    assert.equal(held(523.5), 524);
    assert.equal(held(100), 240);
    assert.equal(held(2000), 800);
  });

  test('the width shown: at most the window less 320, never under 240', () => {
    assert.equal(shownWidth(600, 1400), 600);
    assert.equal(shownWidth(800, 1000), 680);
    assert.equal(shownWidth(800, 500), 240);
    assert.equal(shownWidth(240, 2000), 240);
  });

  test('a press becomes a drag once the pointer is more than 3 px from its x, compared as whole px; back at its x is the same whole px', () => {
    assert.equal(DRAG_SLIP, 3);
    for (const dx of [0, 1, 2, 3, -1, -3, 0.4, 3.4, -3.4]) {
      assert.equal(dragBegun(402, 402 + dx), false, `${dx}`);
    }
    for (const dx of [4, -4, 3.5, -3.6, 100]) {
      assert.equal(dragBegun(402, 402 + dx), true, `${dx}`);
    }
    assert.equal(dragBegun(401.6, 405.4), false, '402 and 405 as whole px');
    assert.equal(atPress(402, 402), true);
    assert.equal(atPress(402, 402.4), true);
    assert.equal(atPress(402, 403), false);
  });

  test('the handle’s tooltip says what a drag and a double click do', () => {
    assert.equal(
      HANDLE_TITLE,
      'Drag to change the width of the list. Double-click: back to 400 px.',
    );
  });
});

/** What list-width-early.js leaves on `<html>`: its `--list-width`, null when not set. */
function early(storage: () => unknown): string | null {
  const set: Record<string, string> = {};
  const window: Record<string, unknown> = {
    document: {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => {
            set[name] = value;
          },
        },
      },
    },
  };
  Object.defineProperty(window, 'localStorage', { get: storage });
  runInNewContext(read('list-width-early.js'), window);
  assert.deepEqual(
    Object.keys(set).filter((name) => name !== '--list-width'),
    [],
    'it sets nothing else',
  );
  return set['--list-width'] ?? null;
}

describe('the width before the first paint (web/list-width-early.js)', () => {
  const holding = (value: unknown, asked: unknown[]) => () => ({
    getItem: (key: unknown) => {
      asked.push(key);
      return key === LIST_WIDTH_KEY ? value : null;
    },
  });

  test('a stored whole number is put on <html> as --list-width exactly as list-width-text.js reads it; it reads LIST_WIDTH_KEY only', () => {
    for (const [value, width] of WHOLE) {
      const asked: unknown[] = [];
      assert.equal(early(holding(value, asked)), `${width}px`, value.slice(0, 20));
      assert.equal(widthOf(value), width);
      assert.deepEqual(asked, [LIST_WIDTH_KEY]);
    }
  });

  test('every value list-width-text.js reads as nothing stored leaves <html> without --list-width', () => {
    for (const value of NO_WIDTH) {
      assert.equal(early(holding(value, [])), null, JSON.stringify(value) ?? String(value));
      assert.equal(widthOf(value), null);
    }
  });

  test('storage that throws (at reading it, or at its getItem) or is missing: no --list-width, and the script does not throw', () => {
    const denied = (): never => {
      throw new Error('SecurityError: access is denied');
    };
    assert.equal(early(denied), null);
    assert.equal(
      early(() => ({ getItem: denied })),
      null,
    );
    assert.equal(
      early(() => undefined),
      null,
    );
    assert.equal(
      early(() => null),
      null,
    );
    assert.equal(
      early(() => ({})),
      null,
    );
  });

  test('a classic script with nothing of its own left global, loaded in <head> ahead of the style sheets', () => {
    const text = read('list-width-early.js');
    assert.doesNotMatch(text, /^\s*(import|export)\b/m);
    const window: Record<string, unknown> = {
      document: { documentElement: { style: { setProperty: () => undefined } } },
      localStorage: { getItem: () => '500' },
    };
    const before = new Set(Object.keys(window));
    runInNewContext(text, window);
    assert.deepEqual(
      Object.keys(window).filter((name) => !before.has(name)),
      [],
    );
    const html = read('index.html');
    const script = html.indexOf(
      '<script src="/assets/__VERSION__/web/list-width-early.js"></script>',
    );
    assert.ok(script !== -1, 'index.html loads it as a classic script (no async, defer or module)');
    const sheet = html.indexOf('rel="stylesheet"');
    assert.ok(sheet !== -1 && script < sheet, 'ahead of the style sheets');
    assert.ok(script < html.indexOf('</head>'), 'in <head>');
  });
});

describe('the shown width in style.css', () => {
  test('`.main` shows the default without --list-width, and a stored one held to 240 … the window less 320', () => {
    const css = read('style.css').replaceAll(/\/\*[^]*?\*\//g, '');
    const main = /(?:^|\})\s*\.main\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const declared = main
      .split(';')
      .map((one) => one.replace(/\s+/g, ' ').trim())
      .filter((one) => one !== '');
    assert.ok(
      declared.includes(
        `--list-shown: max(${MIN_WIDTH}px, min(var(--list-width), 100vw - ${RIGHT_ROOM}px))`,
      ),
      JSON.stringify(declared),
    );
    assert.ok(
      declared.includes(`grid-template-columns: var(--list-shown, ${DEFAULT_WIDTH}px) 1fr`),
      JSON.stringify(declared),
    );
    assert.equal(
      css.match(/--list-width/g)?.length,
      1,
      'no other rule of style.css reads --list-width',
    );
  });
});
