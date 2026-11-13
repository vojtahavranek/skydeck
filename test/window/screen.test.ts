// The screen side (S2 7.2, 7.3, 9.3, 9.4; plan task 12): a headless xterm.js fed every record in
// stream order, the only responder to terminal queries, silent while it replays, and snapshots
// that rebuild the screen exactly. Platform: none — the vendored modules of the checkout.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { IBuffer, IBufferCell, Terminal } from '@xterm/headless';

import { createScreen } from '../../src/window/screen.ts';
import type { ScreenSide } from '../../src/window/screen.ts';
import { loadXterm } from '../../src/window/xterm.ts';
import type { XtermModules } from '../../src/window/xterm.ts';
import { sandbox } from '../helpers/sandbox.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let modules: XtermModules;

before(async () => {
  modules = await loadXterm(checkout);
});

// --- Looking inside a screen ------------------------------------------------------------------

/**
 * The modules with a `Terminal` that remembers every instance, so that a test can read the cells
 * of the headless terminal a screen keeps without the screen exporting anything for tests.
 * `afterWrite` runs right after each `write` was handed to xterm.js, before it parses it.
 */
function spying(afterWrite?: () => void): { modules: XtermModules; terminals: Terminal[] } {
  const terminals: Terminal[] = [];
  const Base = modules.Terminal;
  class Spy extends Base {
    constructor(...args: ConstructorParameters<typeof Base>) {
      super(...args);
      terminals.push(this);
    }
    override write(data: string | Uint8Array, callback?: () => void): void {
      super.write(data, callback);
      afterWrite?.();
    }
  }
  return { modules: { ...modules, Terminal: Spy }, terminals };
}

/** A screen and the headless terminal inside it. */
interface Opened {
  screen: ScreenSide;
  term: Terminal;
  answers: string[];
}

function open(
  init: { cols: number; rows: number; snapshot: string | null },
  options: { live?: boolean; afterWrite?: () => void } = {},
): Opened {
  const spy = spying(options.afterWrite);
  const answers: string[] = [];
  const screen = createScreen(spy.modules, init, (bytes) => {
    assert.ok(bytes instanceof Uint8Array);
    answers.push(text(bytes));
  });
  const term = spy.terminals[0];
  assert.ok(term, 'createScreen made no terminal');
  assert.equal(spy.terminals.length, 1);
  if (options.live) {
    screen.goLive();
  }
  return { screen, term, answers };
}

/** Resolves once everything queued on the screen's chain has been applied. */
const settled = (screen: ScreenSide): Promise<void> => screen.resize(screen.cols, screen.rows);

/** A screen built from `from`'s snapshot, settled. */
async function rebuilt(from: ScreenSide): Promise<Opened> {
  const snap = await from.snapshot();
  const copy = open({ cols: snap.cols, rows: snap.rows, snapshot: snap.data });
  await settled(copy.screen);
  return copy;
}

interface CoreState {
  cursorHidden: boolean;
  mouseEncoding: string;
  cursorStyle: string | undefined;
  cursorBlink: boolean | undefined;
  cursorBlinkOption: boolean | undefined;
  /** Mode 2026, read through the public API. */
  synchronizedOutput: boolean;
  /** Mode 20 (LNM), which xterm.js keeps as its `convertEol` option. */
  newLineMode: boolean | undefined;
}

interface Core {
  coreService: {
    isCursorHidden: boolean;
    decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean };
  };
  coreMouseService: { activeEncoding: string };
  optionsService: { rawOptions: { cursorBlink?: boolean } };
}

/**
 * xterm.js 6.0.0's own state of what the serialise addon does not restore, read from its
 * internals (the vendored bundle keeps these names): the ground truth that the screen side's
 * tracking must reproduce, independent of that tracking.
 */
function coreState(term: Terminal): CoreState {
  const core = (term as unknown as { _core: Core })._core;
  assert.equal(typeof core.coreService.isCursorHidden, 'boolean', 'xterm.js internals moved');
  assert.equal(typeof core.coreMouseService.activeEncoding, 'string', 'xterm.js internals moved');
  return {
    cursorHidden: core.coreService.isCursorHidden,
    mouseEncoding: core.coreMouseService.activeEncoding,
    cursorStyle: core.coreService.decPrivateModes.cursorStyle,
    cursorBlink: core.coreService.decPrivateModes.cursorBlink,
    cursorBlinkOption: core.optionsService.rawOptions.cursorBlink,
    synchronizedOutput: term.modes.synchronizedOutputMode,
    newLineMode: term.options.convertEol,
  };
}

/** One cell: an erased cell and a printed blank look the same, so both count as a space. */
function cellKey(cell: IBufferCell): string {
  return [
    cell.getChars() || ' ',
    cell.getWidth(),
    cell.getFgColorMode(),
    cell.getFgColor(),
    cell.getBgColorMode(),
    cell.getBgColor(),
    cell.isBold(),
    cell.isItalic(),
    cell.isDim(),
    cell.isUnderline(),
    cell.isBlink(),
    cell.isInverse(),
    cell.isInvisible(),
    cell.isStrikethrough(),
    cell.isOverline(),
  ].join('|');
}

/** Every line of `b` equals the same line of `a`: every cell, and the wrap flag. */
function assertSameBuffer(a: IBuffer, b: IBuffer, cols: number, label: string): void {
  assert.equal(b.length, a.length, `${label}: number of lines`);
  assert.equal(b.baseY, a.baseY, `${label}: scrollback lines`);
  for (let y = 0; y < a.length; y++) {
    const la = a.getLine(y);
    const lb = b.getLine(y);
    assert.ok(la && lb, `${label}: line ${y} missing`);
    const show = `${label} line ${y}: ${JSON.stringify(la.translateToString(true))} vs ${JSON.stringify(lb.translateToString(true))}`;
    assert.equal(lb.isWrapped, la.isWrapped, `${show}: wrap flag`);
    for (let x = 0; x < cols; x++) {
      const ca: IBufferCell | undefined = la.getCell(x);
      const cb: IBufferCell | undefined = lb.getCell(x);
      assert.ok(ca && cb);
      assert.equal(cellKey(cb), cellKey(ca), `${show}: cell ${x}`);
    }
  }
}

/** `b` shows exactly what `a` shows, and is in the same state for what comes next. */
function assertSameScreen(a: Terminal, b: Terminal): void {
  assert.deepEqual([b.cols, b.rows], [a.cols, a.rows], 'size');
  assert.equal(b.buffer.active.type, a.buffer.active.type, 'active buffer');
  assertSameBuffer(a.buffer.normal, b.buffer.normal, a.cols, 'normal buffer');
  if (a.buffer.active.type === 'alternate') {
    assertSameBuffer(a.buffer.alternate, b.buffer.alternate, a.cols, 'alternate buffer');
  }
  assert.deepEqual(
    [b.buffer.active.cursorX, b.buffer.active.cursorY],
    [a.buffer.active.cursorX, a.buffer.active.cursorY],
    'cursor position',
  );
  assert.deepEqual({ ...b.modes }, { ...a.modes }, 'modes');
  assert.deepEqual(coreState(b), coreState(a), 'cursor and mouse state');
}

// --- A recorded byte stream -------------------------------------------------------------------

type Step = { out: string } | { size: [number, number] };

const STYLES = [
  '31',
  '1;32',
  '3;33',
  '4;34',
  '7;35',
  '9;36',
  '2;37',
  '38;5;208',
  '38;2;1;2;3',
  '48;5;17;97',
  '48;2;40;40;60',
  '1;3;4;9;53',
  '5',
  '8',
  '90',
  '104',
];

/** One line of output: a style, now and then wide characters, every seventh line long enough to wrap. */
function line(i: number): string {
  const style = STYLES[i % STYLES.length] ?? '0';
  const wide = i % 5 === 0 ? ' 漢字🙂👍🏽' : '';
  const long = i % 7 === 0 ? ` ${'wrap-'.repeat(32)}` : '';
  const status = i % 11 === 0 ? `\x1b[48;5;236m status\x1b[K\x1b[0m` : '';
  return `\x1b[${style}mline ${i}\x1b[0m${wide}${long}${status} end\r\n`;
}

/**
 * Colours, wide characters, 300 lines, two resizes, the alternate screen, modes 2004, 1004,
 * 1000+1006, 25 off and DECSCUSR 4. Each step is one record; no record splits a sequence.
 */
function recordedStream(endInAlternate: boolean, lines = 300): Step[] {
  const steps: Step[] = [{ out: '\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1006h' }];
  for (let i = 0; i < lines; i++) {
    if (i === Math.floor(lines * 0.4)) steps.push({ size: [100, 30] });
    if (i === Math.floor(lines * 0.8)) steps.push({ size: [70, 20] });
    steps.push({ out: line(i) });
  }
  steps.push({
    out: '\x1b[?1049h\x1b[H\x1b[44;97m full screen \x1b[0m\r\n\x1b[1;35m漢字🙂\x1b[0m',
  });
  // A record that ends with a pen set while the alternate screen shows (review 2, N1).
  steps.push({ out: '\x1b[5;10H\x1b[38;2;200;100;50mboxed\x1b[1;3m' });
  steps.push({ out: ' more\x1b[0m' });
  if (!endInAlternate) {
    steps.push({ out: '\x1b[?1049l' });
  }
  steps.push({ out: '\x1b[?25l\x1b[4 q' });
  steps.push({ out: '\x1b[38;2;10;200;30m> \x1b[0mtyping 漢字\x1b[3D' });
  return steps;
}

function apply(screen: ScreenSide, step: Step): Promise<void> {
  return 'out' in step ? screen.output(utf8(step.out)) : screen.resize(...step.size);
}

async function applyAll(screen: ScreenSide, steps: Step[]): Promise<void> {
  for (const step of steps) {
    await apply(screen, step);
  }
}

// --- loadXterm --------------------------------------------------------------------------------

/** An app root in a sandbox with a copy of the checkout's `vendor/`. */
function copyOfVendor(t: Parameters<typeof sandbox>[0]): string {
  const root = sandbox(t).root;
  cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
  return root;
}

describe('loadXterm', () => {
  test('loads the headless terminal and the two addons from the vendored files', async () => {
    const loaded = await loadXterm(checkout);

    assert.equal(typeof loaded.Terminal, 'function');
    assert.equal(typeof loaded.SerializeAddon, 'function');
    assert.equal(typeof loaded.UnicodeGraphemesAddon, 'function');
    const term = new loaded.Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    const serialize = new loaded.SerializeAddon();
    term.loadAddon(serialize);
    term.loadAddon(new loaded.UnicodeGraphemesAddon());
    await new Promise<void>((resolve) => term.write('hi', resolve));
    assert.equal(serialize.serialize(), 'hi');
    term.dispose();
  });

  test('loads once: a second call gives the same modules', async () => {
    const first = await loadXterm(checkout);
    const second = await loadXterm(checkout);

    assert.equal(second, first);
  });

  test('loads from the app root it is given, never from node_modules', async (t) => {
    const root = copyOfVendor(t);

    const copied = await loadXterm(root);

    assert.notEqual(copied.Terminal, (await loadXterm(checkout)).Terminal);
    assert.notEqual(copied.SerializeAddon, (await loadXterm(checkout)).SerializeAddon);
  });

  test('an app root without the vendored files: rejects, and a later call tries again', async (t) => {
    const root = sandbox(t).root;

    await assert.rejects(loadXterm(root));

    cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
    const loaded = await loadXterm(root);
    assert.equal(typeof loaded.Terminal, 'function');
  });

  test('a vendored module without the export: rejects, naming it', async (t) => {
    const root = sandbox(t).root;
    cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
    const serialize = join(root, 'vendor/xterm/addon-serialize/lib');
    mkdirSync(serialize, { recursive: true });
    writeFileSync(join(serialize, 'addon-serialize.mjs'), 'export const other = 1;\n');

    await assert.rejects(loadXterm(root), /SerializeAddon/);
  });
});

// --- The screen side --------------------------------------------------------------------------

describe('createScreen: size and scrollback', () => {
  test('starts at the size it is given and follows resizes in order', async () => {
    const { screen, term } = open({ cols: 80, rows: 24, snapshot: null });

    assert.deepEqual([screen.cols, screen.rows], [80, 24]);
    await screen.resize(100, 30);
    assert.deepEqual([screen.cols, screen.rows], [100, 30]);
    assert.deepEqual([term.cols, term.rows], [100, 30]);
    screen.dispose();
  });

  test('a resize queued behind output is applied after that output', async () => {
    const { screen, term } = open({ cols: 10, rows: 3, snapshot: null });

    const written = screen.output(utf8('0123456789abcdef'));
    const resized = screen.resize(20, 3);
    await Promise.all([written, resized]);

    // The text was written at 10 columns, so it wrapped (at 20 it would be one line); xterm.js
    // does not unwrap the cursor's line when the terminal grows.
    assert.deepEqual([term.cols, term.rows], [20, 3]);
    assert.equal(term.buffer.active.getLine(0)?.translateToString(true), '0123456789');
    assert.equal(term.buffer.active.getLine(1)?.translateToString(true), 'abcdef');
    assert.equal(term.buffer.active.getLine(1)?.isWrapped, true);
    screen.dispose();
  });

  test('keeps 5,000 lines of scrollback', async () => {
    const { screen, term } = open({ cols: 80, rows: 24, snapshot: null });

    await screen.output(utf8(Array.from({ length: 5100 }, (_, i) => `${i}\r\n`).join('')));

    assert.equal(term.buffer.normal.length, 5000 + 24);
    screen.dispose();
  });

  const BAD_SIZES = [
    [0, 24],
    [80, 0],
    [65536, 24],
    [80, 1.5],
    [Number.NaN, 24],
    [-1, 24],
  ] as const;

  test('createScreen throws a RangeError for a size outside 1-65,535 or not a whole number', () => {
    for (const [cols, rows] of BAD_SIZES) {
      assert.throws(
        () => createScreen(modules, { cols, rows, snapshot: null }, () => {}),
        RangeError,
      );
    }
  });

  test('resize gives a promise rejected with a RangeError for such a size, and changes nothing', async () => {
    const { screen, term } = open({ cols: 80, rows: 24, snapshot: null });

    for (const [cols, rows] of BAD_SIZES) {
      let result: Promise<void> | undefined;
      assert.doesNotThrow(() => {
        result = screen.resize(cols, rows);
      });
      await assert.rejects(result ?? Promise.resolve(), RangeError);
    }

    await settled(screen);
    assert.deepEqual([screen.cols, screen.rows, term.cols, term.rows], [80, 24, 80, 24]);
    screen.dispose();
  });

  test('applies the bytes as they were when output was called', async () => {
    const { screen, term } = open({ cols: 20, rows: 3, snapshot: null });
    const bytes = utf8('abc');

    const applied = screen.output(bytes);
    bytes.fill(0x58);
    await applied;

    assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'abc');
    screen.dispose();
  });
});

describe('createScreen: snapshots rebuild the screen exactly', () => {
  for (const endInAlternate of [false, true]) {
    test(`a recorded stream, ending in the ${endInAlternate ? 'alternate' : 'normal'} screen: rebuilt cell for cell`, async () => {
      const a = open({ cols: 80, rows: 24, snapshot: null });
      await applyAll(a.screen, recordedStream(endInAlternate));

      const b = await rebuilt(a.screen);

      assert.ok(a.term.buffer.normal.baseY > 100, 'the stream left scrollback');
      assert.equal(a.term.buffer.active.type, endInAlternate ? 'alternate' : 'normal');
      assert.deepEqual(coreState(a.term), {
        cursorHidden: true,
        mouseEncoding: 'SGR',
        cursorStyle: 'underline',
        cursorBlink: false,
        cursorBlinkOption: false,
        synchronizedOutput: false,
        newLineMode: false,
      });
      assert.equal(a.term.modes.bracketedPasteMode, true);
      assert.equal(a.term.modes.sendFocusMode, true);
      assert.equal(a.term.modes.mouseTrackingMode, 'vt200');
      assertSameScreen(a.term, b.term);
      a.screen.dispose();
      b.screen.dispose();
    });
  }

  test('the snapshot carries the size at its point of the chain', async () => {
    const a = open({ cols: 80, rows: 24, snapshot: null });

    const resized = a.screen.resize(100, 30);
    const snap = await a.screen.snapshot();
    await resized;

    assert.deepEqual([snap.cols, snap.rows], [100, 30]);
    a.screen.dispose();
  });

  const MODE_CASES: { name: string; bytes: string; expect: Partial<CoreState> }[] = [
    { name: 'cursor hidden', bytes: '\x1b[?25l', expect: { cursorHidden: true } },
    {
      name: 'cursor hidden, then shown',
      bytes: '\x1b[?25l\x1b[?25h',
      expect: { cursorHidden: false },
    },
    { name: 'SGR mouse', bytes: '\x1b[?1000h\x1b[?1006h', expect: { mouseEncoding: 'SGR' } },
    {
      name: 'SGR mouse, then off',
      bytes: '\x1b[?1006h\x1b[?1006l',
      expect: { mouseEncoding: 'DEFAULT' },
    },
    {
      name: 'SGR-pixels mouse',
      bytes: '\x1b[?1003h\x1b[?1016h',
      expect: { mouseEncoding: 'SGR_PIXELS' },
    },
    {
      name: 'SGR-pixels, then off',
      bytes: '\x1b[?1016h\x1b[?1016l',
      expect: { mouseEncoding: 'DEFAULT' },
    },
    {
      name: 'two modes set in one sequence',
      bytes: '\x1b[?12;1006h',
      expect: { cursorBlinkOption: true, mouseEncoding: 'SGR' },
    },
    {
      name: 'two modes reset in one sequence',
      bytes: '\x1b[?1006h\x1b[?25;1006l',
      expect: { cursorHidden: true, mouseEncoding: 'DEFAULT' },
    },
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({
      name: `DECSCUSR ${n}`,
      bytes: `\x1b[${n} q`,
      expect:
        n === 0 ? { cursorStyle: undefined, cursorBlink: undefined } : { cursorBlink: n % 2 === 1 },
    })),
    { name: 'DECSCUSR without a parameter', bytes: '\x1b[ q', expect: {} },
    {
      name: 'DECSCUSR 7 (only the blink)',
      bytes: '\x1b[7 q',
      expect: { cursorStyle: undefined, cursorBlink: true },
    },
    {
      name: 'DECSCUSR 8 after 3',
      bytes: '\x1b[3 q\x1b[8 q',
      expect: { cursorStyle: 'underline', cursorBlink: false },
    },
    {
      name: 'DECSCUSR 4, then 0',
      bytes: '\x1b[4 q\x1b[0 q',
      expect: { cursorStyle: undefined, cursorBlink: undefined },
    },
    {
      name: 'blinking cursor (mode 12) on',
      bytes: '\x1b[?12h',
      expect: { cursorBlinkOption: true },
    },
    {
      name: 'mode 12 on, then off',
      bytes: '\x1b[?12h\x1b[?12l',
      expect: { cursorBlinkOption: false },
    },
    {
      // As in xterm.js 6.0.0: its full reset leaves the cursor hidden and the options as they are.
      name: 'RIS resets the mouse encoding, the style and 2026, not the visibility nor modes 12 and 20',
      bytes: '\x1b[?25l\x1b[?1006h\x1b[4 q\x1b[?12h\x1b[?2026h\x1b[20h\x1bc',
      expect: {
        cursorHidden: true,
        mouseEncoding: 'DEFAULT',
        cursorStyle: undefined,
        cursorBlink: undefined,
        cursorBlinkOption: true,
        synchronizedOutput: false,
        newLineMode: true,
      },
    },
    {
      name: 'synchronized output (2026) on',
      bytes: '\x1b[?2026h',
      expect: { synchronizedOutput: true },
    },
    {
      name: 'synchronized output on, then off',
      bytes: '\x1b[?2026h\x1b[?2026l',
      expect: { synchronizedOutput: false },
    },
    { name: 'new-line mode (20) on', bytes: '\x1b[20h', expect: { newLineMode: true } },
    {
      name: 'new-line mode on, then off',
      bytes: '\x1b[20h\x1b[20l',
      expect: { newLineMode: false },
    },
    {
      name: 'DECSTR resets visibility and style, not the mouse encoding',
      bytes: '\x1b[?25l\x1b[?1006h\x1b[4 q\x1b[!p',
      expect: {
        cursorHidden: false,
        mouseEncoding: 'SGR',
        cursorStyle: undefined,
        cursorBlink: undefined,
      },
    },
  ];

  for (const c of MODE_CASES) {
    test(`what the serialise addon misses: ${c.name}`, async () => {
      const a = open({ cols: 20, rows: 4, snapshot: null });
      await a.screen.output(utf8(`text${c.bytes}`));

      const b = await rebuilt(a.screen);

      const state = coreState(a.term);
      assert.deepEqual({ ...state, ...c.expect }, state, 'the case does what its name says');
      assertSameScreen(a.term, b.term);
      a.screen.dispose();
      b.screen.dispose();
    });
  }

  const CURSOR_CASES: { name: string; cols: number; rows: number; bytes: string }[] = [
    {
      name: 'the last row written full width, the cursor moved up',
      cols: 10,
      rows: 3,
      bytes: 'ab\r\ncd\r\n0123456789\x1b[1A\r\x1b[1C',
    },
    {
      name: 'the prototype case: a full last row below a prompt',
      cols: 70,
      rows: 6,
      bytes: `rule\r\n> typing\r\n${'x'.repeat(70)}\x1b[1A\r\x1b[8C`,
    },
    {
      name: 'the last row written full width, the cursor left after it',
      cols: 10,
      rows: 3,
      bytes: 'ab\r\ncd\r\n0123456789',
    },
    {
      name: 'a full row above other content, the cursor left after it',
      cols: 10,
      rows: 3,
      bytes: '\x1b[3;1Hbottom\x1b[1;1H0123456789',
    },
    {
      name: 'a full row ending in a coloured wide character, the cursor left after it',
      cols: 10,
      rows: 3,
      bytes: 'ab\r\n\x1b[3;1Hbelow\x1b[2;1H\x1b[1;31m01234567漢',
    },
    {
      name: 'a full row erased with the cursor left after it',
      cols: 10,
      rows: 3,
      bytes: '\x1b[3;1Hbottom\x1b[1;1H0123456789\x1b[1K',
    },
    {
      name: 'origin mode on, the cursor left after a full row',
      cols: 10,
      rows: 3,
      bytes: 'a\r\nb\r\nc\x1b[?6h0123456789',
    },
    {
      name: 'the alternate screen, the cursor left after a full row',
      cols: 10,
      rows: 3,
      bytes: 'normal\x1b[?1049h\x1b[2;1H0123456789\x1b[3;1Hz\x1b[2;10H9',
    },
  ];

  for (const c of CURSOR_CASES) {
    test(`the cursor: ${c.name}`, async () => {
      const a = open({ cols: c.cols, rows: c.rows, snapshot: null });
      await a.screen.output(utf8(c.bytes));

      const b = await rebuilt(a.screen);

      assertSameScreen(a.term, b.term);
      // The next character lands at the same place, with the same pen, on both.
      await a.screen.output(utf8('Z'));
      await b.screen.output(utf8('Z'));
      assertSameScreen(a.term, b.term);
      a.screen.dispose();
      b.screen.dispose();
    });
  }

  // Two defects of @xterm/addon-serialize 0.14.0 that the screen side corrects on the addon's
  // output, `correctSerialized` (review 2 of #48: N1 twice, N2).
  const ADDON_CASES: { name: string; cols: number; rows: number; bytes: string }[] = [
    {
      name: 'the alternate screen with a pen set: its cells do not take the pen',
      cols: 10,
      rows: 3,
      bytes: '\x1b[?1049h\x1b[Hplain\x1b[1;31m',
    },
    {
      name: 'the alternate screen, a background and then italic set',
      cols: 10,
      rows: 3,
      bytes: '\x1b[?1049h\x1b[H\x1b[44m bg \x1b[49m\x1b[3m',
    },
    {
      name: 'a blank row before a wrapped row keeps no stray character',
      cols: 6,
      rows: 4,
      bytes: 'abcdefgh\x1b[1;1H\x1b[2K\x1b[3;1H',
    },
  ];

  for (const c of ADDON_CASES) {
    test(`the serialise addon: ${c.name}`, async () => {
      const a = open({ cols: c.cols, rows: c.rows, snapshot: null });
      await a.screen.output(utf8(c.bytes));

      const b = await rebuilt(a.screen);

      assertSameScreen(a.term, b.term);
      await a.screen.output(utf8('Z'));
      await b.screen.output(utf8('Z'));
      assertSameScreen(a.term, b.term);
      a.screen.dispose();
      b.screen.dispose();
    });
  }

  // @xterm/addon-serialize 0.14.0 turns bold off and dim off both with SGR 22, which turns off
  // both; scripts/vendor.ts patches the vendored bundle. Each case also leaves a pen behind.
  const BOLD_DIM_CASES: { name: string; bytes: string }[] = [
    { name: 'dim, then bold', bytes: '\x1b[2mab\x1b[22m\x1b[1mcd' },
    { name: 'bold, then dim', bytes: '\x1b[1mab\x1b[22m\x1b[2mcd' },
    { name: 'bold and dim, then dim', bytes: '\x1b[1;2mab\x1b[22;2mcd' },
    { name: 'bold and dim, then bold', bytes: '\x1b[1;2mab\x1b[22;1mcd' },
    { name: 'bold and dim, then neither', bytes: '\x1b[1;2mab\x1b[22mcd' },
    { name: 'neither, then bold and dim', bytes: 'ab\x1b[1;2mcd' },
    {
      name: 'dim text with a bold word inside, as chalk writes it',
      bytes: '\x1b[2mone \x1b[1mtwo\x1b[22m\x1b[2m three\x1b[22m',
    },
  ];

  for (const c of BOLD_DIM_CASES) {
    test(`bold and dim: ${c.name}`, async () => {
      const a = open({ cols: 20, rows: 3, snapshot: null });
      await a.screen.output(utf8(c.bytes));

      const b = await rebuilt(a.screen);

      assertSameScreen(a.term, b.term);
      await a.screen.output(utf8('Z'));
      await b.screen.output(utf8('Z'));
      assertSameScreen(a.term, b.term);
      a.screen.dispose();
      b.screen.dispose();
    });
  }

  // A cursor past the last column after a character whose attributes the pen no longer has: the
  // character is re-printed with its own attributes, so the screen and the cursor are exact, and
  // the pen is then set back to the program's, so the next character is too.
  const PEN_CASES: { name: string; last: string }[] = [
    {
      name: 'every attribute, RGB and 256-colour',
      last: '\x1b[1;2;3;4;5;7;8;9;53;38;2;1;2;3;48;5;200mX',
    },
    { name: 'bright 16-colour foreground and background', last: '\x1b[95;104mX' },
    { name: '16-colour foreground, RGB background', last: '\x1b[33;48;2;250;128;0mX' },
    { name: 'a wide character in 256 colours', last: '\x1b[38;5;27m漢' },
  ];

  for (const c of PEN_CASES) {
    test(`the cursor past a last cell whose attributes the pen lost: ${c.name}`, async () => {
      const a = open({ cols: 10, rows: 3, snapshot: null });
      const width = c.last.endsWith('漢') ? 2 : 1;
      await a.screen.output(
        utf8(`\x1b[3;1Hbelow\x1b[1;1H${'-'.repeat(10 - width)}${c.last}\x1b[0m`),
      );

      const b = await rebuilt(a.screen);

      assert.equal(a.term.buffer.active.cursorX, 10);
      assertSameScreen(a.term, b.term);
      await a.screen.output(utf8('Z'));
      await b.screen.output(utf8('Z'));
      assertSameScreen(a.term, b.term);
      a.screen.dispose();
      b.screen.dispose();
    });
  }

  test('a full-width dim border closed at the end of a record: the next plain text is plain', async () => {
    const a = open({ cols: 10, rows: 3, snapshot: null });
    await a.screen.output(utf8(`\x1b[2m${'─'.repeat(10)}\x1b[22m`));

    const b = await rebuilt(a.screen);
    await a.screen.output(utf8('\r\nplain'));
    await b.screen.output(utf8('\r\nplain'));

    assertSameScreen(a.term, b.term);
    a.screen.dispose();
    b.screen.dispose();
  });

  test('the pen is read from internals the vendored xterm.js has', async () => {
    const term = new modules.Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write('\x1b[1;31m', resolve));

    const pen = (term as unknown as { _core?: { _inputHandler?: { _curAttrData?: IBufferCell } } })
      ._core?._inputHandler?._curAttrData;

    assert.ok(
      pen,
      'xterm.js has no _core._inputHandler._curAttrData: the screen side cannot restore the pen',
    );
    for (const method of [
      'isBold',
      'isDim',
      'isItalic',
      'isUnderline',
      'isBlink',
      'isInverse',
      'isInvisible',
      'isStrikethrough',
      'isOverline',
      'getFgColorMode',
      'getFgColor',
      'getBgColorMode',
      'getBgColor',
    ] as const) {
      assert.equal(typeof pen[method], 'function', method);
    }
    assert.ok(pen.isBold());
    assert.equal(pen.getFgColor(), 1);
    term.dispose();
  });

  for (const endInAlternate of [false, true]) {
    test(`a snapshot at every record boundary plus the records after it equals the whole stream (${endInAlternate ? 'alternate' : 'normal'} screen at the end)`, async () => {
      const steps = recordedStream(endInAlternate, 40);
      const whole = open({ cols: 80, rows: 24, snapshot: null });
      await applyAll(whole.screen, steps);
      const a = open({ cols: 80, rows: 24, snapshot: null });
      const snaps: { cols: number; rows: number; data: string }[] = [];
      for (const step of steps) {
        snaps.push(await a.screen.snapshot());
        await apply(a.screen, step);
      }

      for (const [at, snap] of snaps.entries()) {
        const b = open({ cols: snap.cols, rows: snap.rows, snapshot: snap.data });
        await applyAll(b.screen, steps.slice(at));
        try {
          assertSameScreen(whole.term, b.term);
        } catch (error) {
          assert.fail(`snapshot before record ${at}: ${String(error)}`);
        }
        b.screen.dispose();
      }
      whole.screen.dispose();
      a.screen.dispose();
    });
  }

  test('a Claude-like stream (full-width dim borders, bold inside dim) at 20 x 6: a snapshot at every record boundary rebuilds it', async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 12; i++) {
      steps.push({ out: `\x1b[2m${'─'.repeat(20)}` }); // ends past the last column
      steps.push({ out: '\x1b[22m' }); // the pen goes back to plain at the record's end
      steps.push({ out: `\r\nplain \x1b[2m⎿ \x1b[1mRead\x1b[22m\x1b[2m(file ${i})\x1b[22m` });
      steps.push({ out: `\r\n\x1b[1;2m* \x1b[22;1mdone\x1b[22m plain ${i}\r\n` });
      if (i === 6) steps.push({ size: [18, 6] });
    }
    const whole = open({ cols: 20, rows: 6, snapshot: null });
    await applyAll(whole.screen, steps);
    const a = open({ cols: 20, rows: 6, snapshot: null });
    const snaps: { cols: number; rows: number; data: string }[] = [];
    for (const step of steps) {
      snaps.push(await a.screen.snapshot());
      await apply(a.screen, step);
    }

    for (const [at, snap] of snaps.entries()) {
      const b = open({ cols: snap.cols, rows: snap.rows, snapshot: snap.data });
      await applyAll(b.screen, steps.slice(at));
      try {
        assertSameScreen(whole.term, b.term);
      } catch (error) {
        assert.fail(`snapshot before record ${at}: ${String(error)}`);
      }
      b.screen.dispose();
    }
    whole.screen.dispose();
    a.screen.dispose();
  });

  test('a snapshot requested while records are queued covers all of them, and none after', async () => {
    const steps = recordedStream(false);
    const at = 200;
    const a = open({ cols: 80, rows: 24, snapshot: null });

    const before = steps.slice(0, at).map((step) => apply(a.screen, step));
    const snapshot = a.screen.snapshot();
    const after = steps.slice(at).map((step) => apply(a.screen, step));
    await Promise.all([...before, ...after]);
    const snap = await snapshot;
    const c = open({ cols: snap.cols, rows: snap.rows, snapshot: snap.data });
    await applyAll(c.screen, steps.slice(at));

    assertSameScreen(a.term, c.term);
    a.screen.dispose();
    c.screen.dispose();
  });

  test('a snapshot of a rebuilt screen rebuilds it again', async () => {
    const a = open({ cols: 80, rows: 24, snapshot: null });
    await applyAll(a.screen, recordedStream(true));
    const b = await rebuilt(a.screen);

    const c = await rebuilt(b.screen);

    assertSameScreen(a.term, c.term);
    a.screen.dispose();
    b.screen.dispose();
    c.screen.dispose();
  });
});

describe('createScreen: terminal queries', () => {
  const QUERIES: [string, string, string][] = [
    ['DA1', '\x1b[c', '\x1b[?1;2c'],
    ['DA2', '\x1b[>c', '\x1b[>0;276;0c'],
    ['CPR', 'ab\x1b[6n', '\x1b[1;3R'],
    ['DSR', '\x1b[5n', '\x1b[0n'],
    ['DECRQM 2026', '\x1b[?2026$p', '\x1b[?2026;2$y'],
    ['DECRQSS', '\x1bP$qm\x1b\\', '\x1bP1$r0m\x1b\\'],
  ];

  for (const [name, query, reply] of QUERIES) {
    test(`${name}: answered exactly once when live`, async () => {
      const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null }, { live: true });

      await screen.output(utf8(query));

      assert.deepEqual(answers, [reply]);
      screen.dispose();
    });

    test(`${name}: not answered while replaying; answered once after goLive`, async () => {
      const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null });

      await screen.output(utf8(query));
      assert.deepEqual(answers, []);
      screen.goLive();
      await screen.output(utf8(`\x1b[H${query}`));

      assert.deepEqual(answers, [reply]);
      screen.dispose();
    });
  }

  test('goLive takes its place in the chain: a record queued before it is part of the replay', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null });

    const replayed = screen.output(utf8('\x1b[c\x1b[5n'));
    screen.goLive();
    await replayed;
    assert.deepEqual(answers, []);
    await screen.output(utf8('\x1b[c'));

    assert.deepEqual(answers, ['\x1b[?1;2c']);
    screen.dispose();
  });

  test('a query inside the snapshot a screen starts from is not answered', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: 'x\x1b[c\x1b[6n' });

    screen.goLive();
    await settled(screen);

    assert.deepEqual(answers, []);
    screen.dispose();
  });

  test('an answer that throws rejects that record, and the chain goes on', async () => {
    const failure = new Error('the keeper connection is gone');
    const answered: string[] = [];
    const spy = spying();
    const screen = createScreen(spy.modules, { cols: 20, rows: 3, snapshot: null }, (bytes) => {
      answered.push(text(bytes));
      throw failure;
    });
    screen.goLive();
    screen.setTheme({ fg: '#112233', bg: '#ddeeff' });

    await assert.rejects(screen.output(utf8('a\x1b]11;?\x1b\\b\x1b[cc')), failure);
    await screen.output(utf8('d'));

    assert.deepEqual(answered, ['\x1b]11;rgb:dddd/eeee/ffff\x1b\\', '\x1b[?1;2c']);
    assert.equal(spy.terminals[0]?.buffer.active.getLine(0)?.translateToString(true), 'abcd');
    assert.match((await screen.snapshot()).data, /^abcd/);
    screen.dispose();
  });

  test('XTVERSION is not answered', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null }, { live: true });

    await screen.output(utf8('\x1b[>0q\x1b[>q'));

    assert.deepEqual(answers, []);
    screen.dispose();
  });

  test('OSC 10 and 11 are answered from the theme in rgb: form, with either terminator', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null }, { live: true });
    screen.setTheme({ fg: '#112233', bg: '#ddeeff' });

    await screen.output(utf8('\x1b]10;?\x1b\\\x1b]11;?\x07'));

    assert.deepEqual(answers, [
      '\x1b]10;rgb:1111/2222/3333\x1b\\',
      '\x1b]11;rgb:dddd/eeee/ffff\x1b\\',
    ]);
    screen.dispose();
  });

  test('OSC 10 with two queries answers the foreground and the background', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null }, { live: true });
    screen.setTheme({ fg: '#112233', bg: '#DDEEFF' });

    await screen.output(utf8('\x1b]10;?;?\x1b\\'));

    assert.deepEqual(answers, [
      '\x1b]10;rgb:1111/2222/3333\x1b\\',
      '\x1b]11;rgb:dddd/eeee/ffff\x1b\\',
    ]);
    screen.dispose();
  });

  test('a theme colour that is not exactly #rrggbb gives the default theme’s colour', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null }, { live: true });
    const ask = async (): Promise<string[]> => {
      answers.length = 0;
      await screen.output(utf8('\x1b]10;?\x1b\\\x1b]11;?\x1b\\'));
      return [...answers];
    };
    const DEFAULT_FG = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\';
    const DEFAULT_BG = '\x1b]11;rgb:0000/0000/0000\x1b\\';

    assert.deepEqual(await ask(), [DEFAULT_FG, DEFAULT_BG], 'no theme yet');
    for (const bad of [
      '#12345',
      '#1122334',
      '#11223g',
      ' #112233',
      '#112233\n',
      'rgb(1,2,3)',
      '112233',
      '',
    ]) {
      screen.setTheme({ fg: bad, bg: '#ddeeff' });
      assert.deepEqual(
        await ask(),
        [DEFAULT_FG, '\x1b]11;rgb:dddd/eeee/ffff\x1b\\'],
        JSON.stringify(bad),
      );
      screen.setTheme({ fg: '#112233', bg: bad });
      assert.deepEqual(
        await ask(),
        ['\x1b]10;rgb:1111/2222/3333\x1b\\', DEFAULT_BG],
        JSON.stringify(bad),
      );
    }
    screen.setTheme(null);
    assert.deepEqual(await ask(), [DEFAULT_FG, DEFAULT_BG], 'theme cleared');
    screen.dispose();
  });

  test('OSC 10 and 11 are not answered while replaying, nor when they set a colour', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null });
    screen.setTheme({ fg: '#112233', bg: '#ddeeff' });

    await screen.output(utf8('\x1b]10;?\x1b\\\x1b]11;?\x1b\\'));
    screen.goLive();
    await screen.output(utf8('\x1b]10;#ff0000\x1b\\\x1b]11;rgb:00/00/00\x1b\\'));

    assert.deepEqual(answers, []);
    screen.dispose();
  });
});

describe('createScreen: widths (S2 9.4)', () => {
  for (const [name, chars] of [
    ['🙂', '🙂'],
    ['🙂 with VS16', '🙂\u{fe0f}'],
    ['☺ with VS16', '\u{263a}\u{fe0f}'],
    ['a ZWJ family', '👨\u{200d}👩\u{200d}👧'],
    ['a skin-tone emoji', '👍🏽'],
  ] as const) {
    test(`${name} takes two columns`, async () => {
      const { screen, answers } = open({ cols: 20, rows: 2, snapshot: null }, { live: true });

      await screen.output(utf8(`${chars}\x1b[6n`));

      assert.deepEqual(answers, ['\x1b[1;3R']);
      screen.dispose();
    });
  }
});

describe('createScreen: dispose', () => {
  test('nothing is answered after dispose, also for a query already queued', async () => {
    const { screen, answers } = open({ cols: 80, rows: 24, snapshot: null }, { live: true });

    const queued = screen.output(utf8('\x1b[c'));
    screen.dispose();
    await queued;
    await screen.output(utf8('\x1b[c'));
    await screen.resize(100, 30);

    assert.deepEqual(answers, []);
  });

  test('a query xterm.js has not parsed yet when the screen is disposed is not answered', async () => {
    let dispose = (): void => {};
    const { screen, term, answers } = open(
      { cols: 80, rows: 24, snapshot: null },
      { live: true, afterWrite: () => dispose() },
    );
    let parsed = false;
    term.parser.registerCsiHandler({ final: 'c' }, () => {
      parsed = true;
      return false;
    });
    dispose = () => {
      assert.equal(parsed, false, 'xterm.js parsed the record inside write');
      screen.dispose();
    };

    await screen.output(utf8('\x1b[c\x1b]10;?\x1b\\\x1b]11;?\x07'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(answers, []);
  });

  test('a snapshot after dispose rejects; dispose twice is harmless', async () => {
    const { screen } = open({ cols: 80, rows: 24, snapshot: null });

    screen.dispose();
    screen.dispose();

    await assert.rejects(screen.snapshot(), /disposed/);
  });
});
