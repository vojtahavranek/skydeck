// Follow-up F41's words (web/tour-text.js): the six steps in their order and regions, each in the
// words of its mode, every key a step names one that web/keys.js classifies in the zone the step
// names it for, and where the panel goes beside a region.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KeyLike } from '../../web/keys.js';
import { tourCommand } from '../../src/window/view/search/switcher.ts';
import { listKey, windowChord } from '../../web/keys.js';
import type { Part, TourStep } from '../../web/tour-text.js';
import {
  placeNear,
  REGIONS,
  stepText,
  TOUR_KEY,
  TOUR_SEEN,
  TOUR_TEXTS,
  tourSteps,
} from '../../web/tour-text.js';

const MODES = ['app', 'tab'] as const;

/** A step's lines as the panel shows them. */
function textOf(step: TourStep): string[] {
  return step.lines.map((line) =>
    line
      .map((part: Part) =>
        typeof part === 'string'
          ? part
          : 'key' in part
            ? part.key
            : 'typed' in part
              ? part.typed
              : part.ui,
      )
      .join(''),
  );
}

/** Every key part of the steps. */
function keysOf(steps: TourStep[]): { key: string; zone: 'window' | 'list' }[] {
  return steps.flatMap((step) =>
    step.lines.flat().filter((part) => typeof part !== 'string' && 'key' in part),
  ) as { key: string; zone: 'window' | 'list' }[];
}

const NAMED: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  Esc: 'Escape',
};

/** The key events (US layout) a key name of the help's kind stands for. */
function eventsOf(name: string): KeyLike[] {
  const plain = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  if (name === 'Ctrl+Shift+1…9') {
    return [...'!@#$%^&*('].map((key, i) => ({
      ...plain,
      key,
      code: `Digit${i + 1}`,
      ctrlKey: true,
      shiftKey: true,
    }));
  }
  const parts = name.split('+');
  const last = parts.at(-1) as string;
  const has = (m: string): boolean => parts.slice(0, -1).includes(m);
  const key =
    NAMED[last] ??
    (last.length === 1 ? (has('Shift') ? last.toUpperCase() : last.toLowerCase()) : last);
  return [
    {
      key,
      code: '',
      ctrlKey: has('Ctrl'),
      shiftKey: has('Shift'),
      altKey: has('Alt'),
      metaKey: has('Meta'),
    },
  ];
}

test('six steps, in the order of the brief, each a region of the page, a title and two or three lines', () => {
  for (const mode of MODES) {
    const steps = tourSteps(mode);
    assert.deepEqual(
      steps.map((step) => step.region),
      ['list', 'right', 'keybar', 'list', 'switch', 'settings'],
      mode,
    );
    for (const step of steps) {
      assert.ok(step.region in REGIONS, step.region);
      assert.ok(step.title.length > 0 && step.title.length <= 30, step.title);
      assert.ok(step.lines.length >= 2 && step.lines.length <= 3, step.title);
      for (const line of textOf(step)) {
        assert.ok(line.length > 0 && line.length <= 90, `a short line: ${line}`);
      }
    }
  }
});

test('what each step says (the brief, Behaviour 2)', () => {
  const [list, right, keyboard, keys, around, settings] = tourSteps('app').map(textOf);
  assert.match(list?.join(' ') ?? '', /Open.*Recent.*Earlier/);
  assert.match(list?.join(' ') ?? '', /1–9/);
  assert.match(right?.join(' ') ?? '', /terminal/);
  assert.match(right?.join(' ') ?? '', /card/);
  assert.match(keyboard?.join(' ') ?? '', /Focus: list or Focus: terminal/);
  assert.match(keyboard?.join(' ') ?? '', /Ctrl\+Shift\+L/);
  assert.match(keyboard?.join(' ') ?? '', /Focus: terminal a letter you type goes to Claude Code/);
  assert.match(keys?.[0] ?? '', /^With Focus: list only/);
  for (const word of ['label', 'group', 'note', 'ticket', 'pull requests', 'done', 'filter']) {
    assert.match(keys?.join(' ') ?? '', new RegExp(word), word);
  }
  assert.match(keys?.join(' ') ?? '', /a show done sessions/);
  assert.match(around?.join(' ') ?? '', /Switch… \(Ctrl\+Shift\+P\)/);
  assert.match(around?.join(' ') ?? '', /Ctrl\+Shift\+1…9/);
  assert.match(around?.join(' ') ?? '', /new session/);
  assert.match(settings?.join(' ') ?? '', /gear opens Settings/);
  assert.match(settings?.join(' ') ?? '', /Ctrl\+Shift\+H shows every key/);
  assert.match(settings?.join(' ') ?? '', /Take the tour in the key help, or > tour in Switch…/);
});

test('every text a step says to type is a command of the server’s quick switcher (F41: > tour)', () => {
  for (const mode of MODES) {
    const typed = tourSteps(mode)
      .flatMap((step) => step.lines.flat())
      .filter((part) => typeof part !== 'string' && 'typed' in part) as { typed: string }[];
    assert.deepEqual(
      typed.map((part) => part.typed),
      ['> tour'],
    );
    for (const { typed: text } of typed) assert.equal(tourCommand(text), true, text);
  }
});

test('the app window names Ctrl+Tab and Ctrl+Shift+N; a browser tab, which keeps them, Ctrl+Shift+O and + New', () => {
  const app = keysOf(tourSteps('app')).map((part) => part.key);
  const tab = keysOf(tourSteps('tab')).map((part) => part.key);
  assert.ok(app.includes('Ctrl+Tab') && app.includes('Ctrl+Shift+N'));
  assert.ok(!app.includes('Ctrl+Shift+O'));
  assert.ok(tab.includes('Ctrl+Shift+O'));
  assert.ok(!tab.includes('Ctrl+Tab') && !tab.includes('Ctrl+Shift+N'));
  const appText = tourSteps('app').flatMap(textOf).join('\n');
  const tabText = tourSteps('tab').flatMap(textOf).join('\n');
  assert.doesNotMatch(appText, /\+ New/);
  assert.match(tabText, /\+ New in the key bar starts a new session/);
  assert.doesNotMatch(tabText, /Ctrl\+Tab|Ctrl\+Shift\+N/);
});

test('every key a step names is one web/keys.js classifies in the zone it is named for', () => {
  for (const mode of MODES) {
    for (const { key, zone } of keysOf(tourSteps(mode))) {
      for (const e of eventsOf(key)) {
        if (zone === 'window') {
          assert.notEqual(windowChord(e, 'terminal'), null, `${key}: a window chord`);
          assert.notEqual(windowChord(e, 'list'), null, `${key}: a window chord in the list`);
        } else {
          assert.equal(windowChord(e, 'list'), null, `${key}: not a window chord`);
          assert.notEqual(listKey(e), null, `${key}: a list key`);
        }
      }
    }
  }
  // The names stand for the keys they name (spot checks of the classification).
  const kind = (name: string): string | undefined =>
    windowChord(eventsOf(name)[0] as KeyLike, 'list')?.kind;
  assert.equal(kind('Ctrl+Shift+L'), 'toggle-zone');
  assert.equal(kind('Ctrl+Shift+P'), 'switcher');
  assert.equal(kind('Ctrl+Shift+H'), 'help');
  assert.equal(kind('Ctrl+Shift+N'), 'new');
  assert.equal(kind('Ctrl+Tab'), 'previous');
  assert.equal(kind('Ctrl+Shift+O'), 'previous');
  assert.equal(listKey(eventsOf('d')[0] as KeyLike)?.kind, 'done');
  assert.deepEqual(listKey(eventsOf('t')[0] as KeyLike), { kind: 'edit', what: 'ticket' });
});

test('every control a step names carries the element it is found in', () => {
  for (const mode of MODES) {
    for (const part of tourSteps(mode).flatMap((step) => step.lines.flat())) {
      if (typeof part !== 'string' && 'ui' in part) {
        assert.match(part.at, /^[#.]/, part.ui);
      }
    }
  }
});

test('the panel’s words, and the storage key that marks the tour seen', () => {
  assert.equal(stepText(2, 6), 'Step 2 of 6');
  assert.equal(TOUR_TEXTS.skip, 'Skip the tour');
  assert.equal(TOUR_TEXTS.closeFirst, 'close the tour first (Esc)');
  assert.deepEqual([TOUR_TEXTS.back, TOUR_TEXTS.next, TOUR_TEXTS.done], ['Back', 'Next', 'Done']);
  assert.equal(TOUR_KEY, 'skydeck-tour');
  assert.equal(TOUR_SEEN, 'seen');
});

test('the panel goes to the right of a region, else its left, else below, else above, inside the viewport', () => {
  const viewport = { width: 1200, height: 800 };
  const panel = { width: 320, height: 180 };
  // The list (left): to its right, from its top.
  assert.deepEqual(placeNear({ left: 0, top: 40, width: 360, height: 736 }, panel, viewport), {
    left: 372,
    top: 40,
  });
  // The right side: no room at its right, so at its left (over the list).
  assert.deepEqual(placeNear({ left: 360, top: 40, width: 840, height: 736 }, panel, viewport), {
    left: 28,
    top: 40,
  });
  // The key bar (the whole width, at the bottom): above it, from its left edge.
  assert.deepEqual(placeNear({ left: 0, top: 776, width: 1200, height: 24 }, panel, viewport), {
    left: 8,
    top: 584,
  });
  // The gear (top right): not to its right; to its left, from its top.
  assert.deepEqual(placeNear({ left: 1160, top: 6, width: 28, height: 24 }, panel, viewport), {
    left: 828,
    top: 8,
  });
  // A narrow window: the title bar's button is too near both edges; below it, moved in.
  assert.deepEqual(
    placeNear({ left: 200, top: 6, width: 100, height: 24 }, panel, { width: 400, height: 600 }),
    { left: 72, top: 42 },
  );
  // No room anywhere: the middle of the viewport.
  assert.deepEqual(
    placeNear({ left: 0, top: 0, width: 400, height: 300 }, panel, { width: 400, height: 300 }),
    { left: 40, top: 60 },
  );
});
