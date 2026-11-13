// One terminal's screen side (S2 7.2, 7.3, 9.3, 9.4): a headless xterm.js fed every record in
// stream order through one chain, the only responder to terminal queries, silent while it
// replays, and snapshots that rebuild the screen exactly.
import type { IBufferCell, Terminal } from '@xterm/headless';

import type { XtermModules } from './xterm.ts';

export interface ScreenSide {
  /**
   * Applies a record in order; resolves when applied. While replaying, query answers are dropped.
   * Rejects with the error when `answer` throws for this record's answers; the record is applied
   * all the same.
   */
  output(bytes: Uint8Array): Promise<void>;
  /** Applies a resize in order. A size outside 1–65,535 gives a promise rejected with a RangeError. */
  resize(cols: number, rows: number): Promise<void>;
  /** Ends the replay: from now on answers go to `answer`. */
  goLive(): void;
  /** The snapshot at the current point of the chain (after every queued record), S2 7.2's additions appended. */
  snapshot(): Promise<{ cols: number; rows: number; data: string }>;
  setTheme(theme: { fg: string; bg: string } | null): void;
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
}

/** S2 7.2: the screen side keeps as much scrollback as the page (8.2.6). */
const SCROLLBACK = 5000;

/** A pty's size, as the keeper frames carry it (2 bytes each). */
const MAX_SIZE = 65535;

/** xterm.js's own default theme, used for a colour the page did not report as `#rrggbb`. */
const DEFAULT_THEME = { fg: '#ffffff', bg: '#000000' };

const isSize = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE;

function checkSize(cols: number, rows: number): void {
  if (!isSize(cols) || !isSize(rows)) {
    throw new RangeError(`a terminal is 1-${MAX_SIZE} columns and rows, not ${cols} x ${rows}`);
  }
}

/** `#rrggbb` as xterm reports a colour, `rgb:rrrr/gggg/bbbb`; the default theme's colour else. */
function rgbOf(colour: string, fallback: string): string {
  const hex = /^#[0-9a-fA-F]{6}$/.test(colour) ? colour.toLowerCase() : fallback;
  const channel = (at: number): string => hex.slice(at, at + 2).repeat(2);
  return `rgb:${channel(1)}/${channel(3)}/${channel(5)}`;
}

/**
 * What the serialise addon does not restore (S2 7.2, section 21), tracked with parser hooks that
 * follow xterm.js 6.0.0's own handling of the same sequences (its `InputHandler`): DECSET and
 * DECRST 25, 1006, 1016 and 12, DECSCUSR, and the resets RIS and DECSTR.
 */
interface Tracked {
  cursorHidden: boolean;
  mouseEncoding: 'DEFAULT' | 'SGR' | 'SGR_PIXELS';
  /** DECSCUSR's style and blink; null when unset (the terminal's options apply). */
  cursorStyle: 'block' | 'underline' | 'bar' | null;
  cursorBlink: boolean | null;
  /** Mode 12, which xterm.js keeps as its `cursorBlink` option; null when never set. */
  blinkOption: boolean | null;
}

const fresh = (): Tracked => ({
  cursorHidden: false,
  mouseEncoding: 'DEFAULT',
  cursorStyle: null,
  cursorBlink: null,
  blinkOption: null,
});

/** The plain parameters of a CSI sequence (sub-parameters, given as arrays, are skipped). */
const plain = (params: (number | number[])[]): number[] =>
  params.filter((p): p is number => typeof p === 'number');

function track(term: Terminal, state: { tracked: Tracked }): void {
  const decset = (params: (number | number[])[], on: boolean): boolean => {
    const t = state.tracked;
    for (const mode of plain(params)) {
      if (mode === 25) t.cursorHidden = !on;
      else if (mode === 1006) t.mouseEncoding = on ? 'SGR' : 'DEFAULT';
      else if (mode === 1016) t.mouseEncoding = on ? 'SGR_PIXELS' : 'DEFAULT';
      else if (mode === 12) t.blinkOption = on;
    }
    return false;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => decset(params, true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => decset(params, false));
  // DECSCUSR, as xterm.js's setCursorStyle reads it.
  term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
    const t = state.tracked;
    const style = params.length === 0 ? 1 : (plain(params)[0] ?? 0);
    if (style === 0) {
      t.cursorStyle = null;
      t.cursorBlink = null;
    } else {
      if (style === 1 || style === 2) t.cursorStyle = 'block';
      else if (style === 3 || style === 4) t.cursorStyle = 'underline';
      else if (style === 5 || style === 6) t.cursorStyle = 'bar';
      t.cursorBlink = style % 2 === 1;
    }
    return false;
  });
  // DECSTR shows the cursor and clears DECSCUSR; the mouse encoding and mode 12 stay.
  term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
    const t = state.tracked;
    t.cursorHidden = false;
    t.cursorStyle = null;
    t.cursorBlink = null;
    return false;
  });
  // RIS resets the mouse encoding and DECSCUSR. In xterm.js 6.0.0 it leaves the cursor's
  // visibility as it was, and the options, mode 12 among them.
  term.parser.registerEscHandler({ final: 'c' }, () => {
    const t = state.tracked;
    t.mouseEncoding = 'DEFAULT';
    t.cursorStyle = null;
    t.cursorBlink = null;
    return false;
  });
}

/** DECSCUSR's parameter for a style and a blink; 7 and 8 set only the blink, as in xterm.js. */
function cursorStyleParam(t: Tracked): number | null {
  if (t.cursorStyle !== null) {
    const base = { block: 1, underline: 3, bar: 5 }[t.cursorStyle];
    return t.cursorBlink === false ? base + 1 : base;
  }
  return t.cursorBlink === null ? null : t.cursorBlink ? 7 : 8;
}

// The colour modes of xterm.js's cell attributes (`Attributes.CM_*`).
const CM_P16 = 0x1000000;
const CM_P256 = 0x2000000;
const CM_RGB = 0x3000000;

function colourCodes(mode: number, colour: number, base: number): string[] {
  if (mode === CM_P16) return [String(colour < 8 ? base + colour : base + 60 + colour - 8)];
  if (mode === CM_P256) return [`${base + 8};5;${colour}`];
  if (mode === CM_RGB) {
    return [`${base + 8};2;${(colour >> 16) & 255};${(colour >> 8) & 255};${colour & 255}`];
  }
  return [];
}

/** The SGR sequence that gives a cell's attributes from the default ones; '' for none. */
function sgrOf(cell: IBufferCell): string {
  const codes: string[] = [];
  const flags: [number, number][] = [
    [cell.isBold(), 1],
    [cell.isDim(), 2],
    [cell.isItalic(), 3],
    [cell.isUnderline(), 4],
    [cell.isBlink(), 5],
    [cell.isInverse(), 7],
    [cell.isInvisible(), 8],
    [cell.isStrikethrough(), 9],
    [cell.isOverline(), 53],
  ];
  for (const [set, code] of flags) {
    if (set) codes.push(String(code));
  }
  codes.push(...colourCodes(cell.getFgColorMode(), cell.getFgColor(), 30));
  codes.push(...colourCodes(cell.getBgColorMode(), cell.getBgColor(), 40));
  return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`;
}

/**
 * Puts the cursor where it is in `term`. The serialise addon puts it one column too far left when
 * the last row is full, so a CUP always follows. A cursor past the last column (a character was
 * just printed there; the next one wraps) cannot be reached by CUP: the last character of that
 * row is printed again instead, with its attributes, which leaves the cursor past it (the pen is
 * set back afterwards, `penOf`).
 */
function cursorPosition(term: Terminal): string {
  const buffer = term.buffer.active;
  const row = buffer.cursorY + 1;
  if (buffer.cursorX < term.cols) {
    return `\x1b[${row};${buffer.cursorX + 1}H`;
  }
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  let at = term.cols - 1;
  let cell = line?.getCell(at);
  if (cell !== undefined && cell.getWidth() === 0 && at > 0) {
    at -= 1;
    cell = line?.getCell(at);
  }
  if (cell === undefined) {
    return `\x1b[${row};${term.cols}H`;
  }
  // An erased cell is re-printed as a blank with its attributes: it looks the same.
  return `\x1b[${row};${at + 1}H\x1b[0m${sgrOf(cell)}${cell.getChars() || ' '}`;
}

/**
 * Corrects two defects of @xterm/addon-serialize 0.14.0 in its output (ruled on #48; the bold and
 * dim one cannot be corrected from outside and is patched in the vendored bundle instead):
 * - it serialises the alternate screen as if the pen were the default, after restoring the
 *   program's pen at the end of the normal screen, so the alternate screen's cells took that pen:
 *   SGR 0 goes before its `CSI ? 1049 h CSI H`;
 * - above a blank row followed by a wrapped one, its wrap trick moves by `CSI 0 C` and `CSI 0 D`,
 *   which move one column, and leaves a stray `-`: those moves are dropped.
 * Exact on the text: no cell holds ESC, the addon writes 1049 only there (its modes never do),
 * and its own cursor moves are never of 0.
 */
function correctSerialized(text: string): string {
  return text
    .replace('\x1b[?1049h\x1b[H', '\x1b[0m\x1b[?1049h\x1b[H')
    .replaceAll('\x1b[0C', '')
    .replaceAll('\x1b[0D', '');
}

/**
 * The pen (the attributes the next character gets), read from the xterm.js internal the vendored
 * serialise addon itself reads for its pen; null if this xterm.js has none (a test pins it).
 */
function penOf(term: Terminal): IBufferCell | null {
  const core = (term as unknown as { _core?: { _inputHandler?: { _curAttrData?: IBufferCell } } })
    ._core;
  return core?._inputHandler?._curAttrData ?? null;
}

/** S2 7.2's additions to the serialise addon's snapshot. */
function additions(term: Terminal, t: Tracked): string {
  let out = t.cursorHidden ? '\x1b[?25l' : '\x1b[?25h';
  out += { DEFAULT: '\x1b[?1006l', SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h' }[t.mouseEncoding];
  out += '\x1b[0 q';
  const style = cursorStyleParam(t);
  if (style !== null) out += `\x1b[${style} q`;
  if (t.blinkOption !== null) out += t.blinkOption ? '\x1b[?12h' : '\x1b[?12l';
  // Read through xterm.js's public API, so they need no tracking: the screen side sets neither.
  if (term.modes.synchronizedOutputMode) out += '\x1b[?2026h';
  if (term.options.convertEol) out += '\x1b[20h';
  out += cursorPosition(term);
  // Last, so that nothing above (the re-printed cell) changes it again.
  const pen = penOf(term);
  return pen === null ? out : `${out}\x1b[0m${sgrOf(pen)}`;
}

/**
 * `answer` receives what the program must get as input (query answers). Scrollback 5,000.
 * Throws a RangeError for a size outside 1–65,535.
 */
export function createScreen(
  modules: XtermModules,
  init: { cols: number; rows: number; snapshot: string | null },
  answer: (bytes: Uint8Array) => void,
): ScreenSide {
  checkSize(init.cols, init.rows);
  const term = new modules.Terminal({
    cols: init.cols,
    rows: init.rows,
    scrollback: SCROLLBACK,
    // The width addon uses the unicode API, which xterm.js still marks as proposed.
    allowProposedApi: true,
  });
  term.loadAddon(new modules.UnicodeGraphemesAddon());
  const serializer = new modules.SerializeAddon();
  term.loadAddon(serializer);

  const encoder = new TextEncoder();
  let size = { cols: init.cols, rows: init.rows };
  let live = false;
  let disposed = false;
  let theme = DEFAULT_THEME;
  let chain: Promise<void> = Promise.resolve();
  const state = { tracked: fresh() };
  track(term, state);

  /**
   * The snapshot's seam (S2 7.2): the escape sequence the stream stands inside at the chain point,
   * appended last so that the next record completes it. Empty until plan task 33 follows the
   * stream; until then a snapshot taken inside an escape sequence is not exact.
   */
  const unfinished = (): string => '';

  /** Runs `step` after everything queued before it; a failed step does not stop the chain. */
  function enqueue<T>(step: () => T | Promise<T>): Promise<T> {
    const result = chain.then(step);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Answers are collected while xterm.js parses a record and handed to `answer` once it is
  // applied: an `answer` that throws inside the parser would stop the parse (the record's write
  // would never complete, and the chain with it) and surface as an uncaught exception.
  let answers: string[] = [];
  const send = (text: string): void => {
    if (live) {
      answers.push(text);
    }
  };

  /** Hands the answers of the record just applied to `answer`; rethrows the first failure. */
  function deliver(): void {
    const ready = answers;
    answers = [];
    let failure: { error: unknown } | null = null;
    for (const text of disposed ? [] : ready) {
      try {
        answer(encoder.encode(text));
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== null) {
      throw failure.error;
    }
  }

  // The headless terminal answers DA1, DA2, DECRQM, CPR, DSR and DECRQSS through onData.
  term.onData(send);

  // OSC 10 and 11 (and 10 with several `?`, which xterm reads as 10, 11, 12 in turn): the
  // headless terminal has no colours, so the screen side answers from the page's theme.
  for (const ident of [10, 11]) {
    term.parser.registerOscHandler(ident, (data) => {
      const slots = data.split(';');
      slots.forEach((slot, i) => {
        const which = ident + i;
        if (slot === '?' && (which === 10 || which === 11)) {
          const colour =
            which === 10 ? rgbOf(theme.fg, DEFAULT_THEME.fg) : rgbOf(theme.bg, DEFAULT_THEME.bg);
          send(`\x1b]${which};${colour}\x1b\\`);
        }
      });
      return slots.every((slot) => slot === '?');
    });
  }

  if (init.snapshot !== null) {
    const snapshot = init.snapshot;
    void enqueue(() => new Promise<void>((resolve) => term.write(snapshot, resolve)));
  }

  return {
    output(bytes) {
      // Queued, so applied later: the caller may reuse its buffer at once.
      const record = bytes.slice();
      return enqueue(() =>
        disposed
          ? undefined
          : new Promise<void>((resolve) => term.write(record, resolve)).then(deliver),
      );
    },
    resize(cols, rows) {
      try {
        checkSize(cols, rows);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(() => {
        if (!disposed) {
          term.resize(cols, rows);
          size = { cols, rows };
        }
      });
    },
    goLive() {
      void enqueue(() => {
        live = true;
      });
    },
    snapshot() {
      return enqueue(() => {
        if (disposed) {
          throw new Error('the screen is disposed');
        }
        const serialized = correctSerialized(serializer.serialize());
        const data = serialized + additions(term, state.tracked) + unfinished();
        return { cols: size.cols, rows: size.rows, data };
      });
    },
    setTheme(next) {
      theme = next ?? DEFAULT_THEME;
    },
    get cols() {
      return size.cols;
    },
    get rows() {
      return size.rows;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        term.dispose();
      }
    },
  };
}
