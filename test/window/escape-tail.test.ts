// The scanner of the snapshot's seam (S2 7.2; plan task 33): it follows the bytes a screen side
// applies far enough to know the escape sequence the stream stands inside, and keeps exactly what
// puts a fresh xterm.js 6.0.0 parser into the state of the original. Platform: none — the scanner
// is pure; the vendored xterm.js of the checkout is the oracle.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Terminal } from '@xterm/headless';

import { escapeTail } from '../../src/window/escape-tail.ts';
import { loadXterm } from '../../src/window/xterm.ts';
import type { XtermModules } from '../../src/window/xterm.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytesOf = (stream: string | Uint8Array): Uint8Array =>
  typeof stream === 'string' ? utf8(stream) : stream;

/** The tail after `stream`, pushed whole. */
function tailOf(stream: string | Uint8Array): string {
  const scanner = escapeTail();
  scanner.push(bytesOf(stream));
  return scanner.unfinished();
}

/** The tail after `stream`, pushed one byte at a time. */
function tailByteByByte(stream: string | Uint8Array): string {
  const scanner = escapeTail();
  const bytes = bytesOf(stream);
  for (let at = 0; at < bytes.length; at++) {
    scanner.push(bytes.subarray(at, at + 1));
  }
  return scanner.unfinished();
}

let modules: XtermModules;

before(async () => {
  modules = await loadXterm(checkout);
});

/** 64 KiB: a string sequence's kept bytes may not pass it. */
const LIMIT = 65536;

// --- The table ---------------------------------------------------------------------------------

const CASES: [name: string, stream: string, tail: string][] = [
  ['nothing', '', ''],
  ['plain text', 'hello 漢字 🙂 Žluťoučký kůň', ''],
  [
    'complete sequences of every kind',
    '\x1b[31mred\x1b[0m\x1b(B\x1b#8\x1b]0;t\x07\x1bP$qm\x1b\\\x1b_a\x1b\\\x1b7\u009b1m',
    '',
  ],
  ['ESC', '\x1b', '\x1b'],
  ['text, then ESC', 'ab\x1b', '\x1b'],
  ['CSI with parameters', '\x1b[38;5', '\x1b[38;5'],
  ['CSI with a prefix', '\x1b[?', '\x1b[?'],
  ['CSI with a prefix and a parameter', '\x1b[?2004', '\x1b[?2004'],
  ['CSI with sub-parameters', '\x1b[38:2::1', '\x1b[38:2::1'],
  ['CSI with an intermediate (DECSCUSR)', '\x1b[4 ', '\x1b[4 '],
  ['CSI with a prefix and an intermediate (DECRQM)', '\x1b[?2026$', '\x1b[?2026$'],
  ['ESC (', '\x1b(', '\x1b('],
  ['ESC #', '\x1b#', '\x1b#'],
  ['OSC 0 with part of a title', '\x1b]0;tit', '\x1b]0;tit'],
  ['OSC with part of its number', '\x1b]5', '\x1b]5'],
  ['OSC with UTF-8 characters', '\x1b]0;Žluťoučký kůň 漢字 🙂', '\x1b]0;Žluťoučký kůň 漢字 🙂'],
  ['OSC 8 with part of a link', '\x1b]8;;https://exa', '\x1b]8;;https://exa'],
  // xterm.js ends an OSC at the ESC (and runs its handler); the ESC begins a new sequence.
  ['an OSC ending in ESC', '\x1b]0;title\x1b', '\x1b'],
  ['DCS (DECRQSS)', '\x1bP$q', '\x1bP$q'],
  ['DCS with part of its payload', '\x1bP$qm', '\x1bP$qm'],
  ['DCS with parameters', '\x1bP1;2', '\x1bP1;2'],
  ['a DCS ending in ESC', '\x1bP$qm\x1b', '\x1b'],
  // xterm.js ignores what SOS, PM and APC carry: only the introducer matters.
  ['SOS', '\x1bXsos text', '\x1bX'],
  ['PM', '\x1b^pm text', '\x1b^'],
  ['APC', '\x1b_apc text', '\x1b_'],
  ['an APC ending in ESC', '\x1b_apc\x1b', '\x1b'],
  ['CSI as U+009B', '\u009b1;2', '\u009b1;2'],
  ['OSC as U+009D', '\u009d0;t', '\u009d0;t'],
  ['DCS as U+0090', '\u0090$q', '\u0090$q'],
  ['SOS as U+0098', '\u0098sos', '\u0098'],
  ['PM as U+009E', '\u009epm', '\u009e'],
  ['APC as U+009F', '\u009fapc', '\u009f'],
  ['an OSC after BEL', '\x1b]0;t\x07', ''],
  ['an OSC after ST', '\x1b]0;t\x1b\\', ''],
  ['an OSC after ST as U+009C', '\x1b]0;t\u009c', ''],
  ['a DCS after ST', '\x1bP$qm\x1b\\', ''],
  ['an APC after ST', '\x1b_a\x1b\\', ''],
  ['a CSI after CAN', '\x1b[31\x18', ''],
  ['a CSI after SUB', '\x1b[31\x1a', ''],
  ['an OSC after CAN', '\x1b]0;t\x18', ''],
  ['a DCS after SUB', '\x1bP$qm\x1a', ''],
  ['a C1 control ends a CSI', '\x1b[31\u0085', ''],
  ['an ESC inside a CSI keeps only the new sequence', '\x1b[31\x1b[4', '\x1b[4'],
  ['an ESC inside an OSC keeps only the new sequence', '\x1b]0;t\x1b[1', '\x1b[1'],
  ['a C0 control inside a CSI is not kept', '\x1b[3\n1\r;\x085', '\x1b[31;5'],
  ['a C0 control after ESC is not kept', '\x1b\r(', '\x1b('],
  ['DEL inside a CSI is not kept', '\x1b[3\x7f1', '\x1b[31'],
  // xterm.js ignores a C0 control inside an OSC, and gives DEL to the handler.
  ['a C0 control inside an OSC is not kept', '\x1b]0;a\tb', '\x1b]0;ab'],
  ['DEL inside an OSC is kept', '\x1b]0;a\x7fb', '\x1b]0;a\x7fb'],
  ['a C0 control inside a DCS payload is kept', '\x1bPq#0\n!', '\x1bPq#0\n!'],
  ['a non-ASCII character ends an APC', '\x1b_aé', ''],
  ['a non-ASCII character ends an ESC sequence', '\x1bé', ''],
  ['a CSI that xterm.js ignores', '\x1b[1<2;3', '\x1b[1<'],
  ['an OSC whose number is not a number', '\x1b]x;abc', '\x1b]x'],
  ['digits that change no parameter are not kept', '\x1b[0;0005', '\x1b[0;5'],
];

describe('escapeTail: the sequence the stream stands inside', () => {
  for (const [name, stream, tail] of CASES) {
    test(`${name}: ${JSON.stringify(tail)}`, () => {
      assert.equal(tailOf(stream), tail);
    });

    test(`${name}: pushed one byte at a time, the same tail`, () => {
      assert.equal(tailByteByByte(stream), tail);
    });
  }

  test('a stream pushed in two pieces at every byte gives the tail of the whole', () => {
    const stream = utf8(CASES.map(([, s]) => s).join('a'));
    const whole = tailOf(stream);
    for (let at = 0; at <= stream.length; at++) {
      const scanner = escapeTail();
      scanner.push(stream.subarray(0, at));
      scanner.push(stream.subarray(at));
      assert.equal(scanner.unfinished(), whole, `cut at ${at}`);
    }
  });

  test('the tail follows the stream: it is asked for at any point, and again', () => {
    const scanner = escapeTail();
    scanner.push(utf8('ab\x1b[3'));
    assert.equal(scanner.unfinished(), '\x1b[3');
    assert.equal(scanner.unfinished(), '\x1b[3');
    scanner.push(utf8('1mX'));
    assert.equal(scanner.unfinished(), '');
    scanner.push(new Uint8Array(0));
    assert.equal(scanner.unfinished(), '');
  });

  test('a chunk the caller reuses after push does not change the tail', () => {
    const scanner = escapeTail();
    const chunk = utf8('\x1b]0;abc');
    scanner.push(chunk);
    chunk.fill(0x41);
    assert.equal(scanner.unfinished(), '\x1b]0;abc');
  });
});

describe('escapeTail: UTF-8 as xterm.js 6.0.0 decodes it', () => {
  const BYTE_CASES: [name: string, bytes: number[], tail: string][] = [
    ['an invalid byte is skipped, not read as C1', [0x1b, 0x5b, 0x31, 0x9b, 0x32], '\x1b[12'],
    [
      'a byte that does not continue a character is read on its own',
      [0x1b, 0x5d, 0x30, 0x3b, 0xc3, 0x1b],
      '\x1b',
    ],
    ['a BOM is skipped', [0x1b, 0x5d, 0x30, 0x3b, 0xef, 0xbb, 0xbf, 0x61], '\x1b]0;a'],
    ['an overlong form is not a control', [0x1b, 0x5d, 0x30, 0x3b, 0xc0, 0x9b, 0x61], '\x1b]0;a'],
    [
      'an encoded surrogate is skipped',
      [0x1b, 0x5d, 0x30, 0x3b, 0xed, 0xa0, 0x80, 0x61],
      '\x1b]0;a',
    ],
    [
      'a code point above U+10FFFF is skipped',
      [0x1b, 0x5d, 0x30, 0x3b, 0xf4, 0x90, 0x80, 0x80, 0x61],
      '\x1b]0;a',
    ],
    ['C1 as two bytes is a control', [0xc2, 0x9b, 0x35], '\u009b5'],
  ];

  for (const [name, bytes, tail] of BYTE_CASES) {
    test(`${name}`, () => {
      assert.equal(tailOf(Uint8Array.from(bytes)), tail);
      assert.equal(tailByteByByte(Uint8Array.from(bytes)), tail);
    });
  }
});

describe('escapeTail: bounds', () => {
  test(`an OSC whose kept bytes would pass 64 KiB is kept as its introducer and a number that is no number`, () => {
    const scanner = escapeTail();
    const intro = '\x1b]52;c;';
    scanner.push(utf8(intro + 'A'.repeat(LIMIT - intro.length)));
    assert.equal(scanner.unfinished().length, LIMIT, 'exactly 64 KiB is still kept');

    scanner.push(utf8('A'));
    assert.equal(scanner.unfinished(), '\x1b]!');
    scanner.push(utf8('B'.repeat(100_000)));
    assert.equal(scanner.unfinished(), '\x1b]!');
    scanner.push(utf8('\x07'));
    assert.equal(scanner.unfinished(), '');
  });

  test('the bound counts UTF-8 bytes, and the C1 introducer is kept as it was', () => {
    const scanner = escapeTail();
    scanner.push(utf8(`\u009d0;${'漢'.repeat(LIMIT / 3)}`));
    assert.equal(scanner.unfinished(), '\u009d!');
  });

  test('a DCS whose kept bytes would pass 64 KiB is kept as its introducer and what makes xterm.js ignore it', () => {
    const scanner = escapeTail();
    scanner.push(utf8(`\x1bP1;2q${'#'.repeat(LIMIT)}`));
    assert.equal(scanner.unfinished(), '\x1bP!0');
    scanner.push(utf8('\x1b\\'));
    assert.equal(scanner.unfinished(), '');
  });

  test('an endless CSI keeps less than 1 KiB: digits, separators and intermediates that change nothing are not kept', () => {
    for (const stream of [
      `\x1b[${'1;'.repeat(100_000)}`,
      `\x1b[${'9'.repeat(100_000)}`,
      `\x1b[1${':2'.repeat(100_000)}`,
      `\x1b[?${'0'.repeat(100_000)}`,
      `\x1b[1${'!'.repeat(100_000)}`,
      `\x1b${'('.repeat(100_000)}`,
      `\x1bP${'1;'.repeat(100_000)}`,
      `\x1b[1<${'2;'.repeat(100_000)}`,
    ]) {
      assert.ok(tailOf(stream).length < 1024, JSON.stringify(stream.slice(0, 8)));
    }
  });

  test('an endless OSC number keeps only the digits that change it, and is not bounded', () => {
    // xterm.js's OSC number is `number * 10 + digit` without a limit: it reaches Infinity, after
    // which no digit changes it.
    let number = 0;
    let digits = 0;
    while (number * 10 + 1 !== number) {
      number = number * 10 + 1;
      digits++;
    }

    assert.equal(tailOf(`\x1b]${'0'.repeat(100_000)}`), '\x1b]0');
    assert.equal(tailOf(`\x1b]${'0'.repeat(100_000)}1`), '\x1b]01');
    assert.equal(tailOf(`\x1b]${'1'.repeat(100_000)}`), `\x1b]${'1'.repeat(digits)}`);
    assert.equal(tailOf(`\x1b]${'0'.repeat(100_000)};ti`), '\x1b]0;ti');
  });
});

// --- The oracle: xterm.js 6.0.0's own parser ----------------------------------------------------

// xterm.js's parser states (its `ParserState`), as numbers in the vendored bundle.
const ESCAPE_INTERMEDIATE = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTERMEDIATE = 5;
const OSC_STRING = 8;
const DCS_ENTRY = 9;
const DCS_PARAM = 10;
const DCS_INTERMEDIATE = 12;
const DCS_PASSTHROUGH = 13;
/** The OSC parser's state for a number that is no number (`OscState.ABORT`). */
const OSC_ABORT = 3;

interface ParserInternals {
  currentState: number;
  _collect: number;
  _params: {
    toArray(): (number | number[])[];
    _rejectDigits: boolean;
    _rejectSubDigits: boolean;
    _digitIsSub: boolean;
  };
  _oscParser: { _state: number; _id: number };
  _dcsParser: { _ident: number };
}

function parserOf(term: Terminal): ParserInternals {
  const parser = (term as unknown as { _core: { _inputHandler: { _parser: ParserInternals } } })
    ._core._inputHandler._parser;
  assert.equal(typeof parser.currentState, 'number', 'xterm.js internals moved');
  assert.equal(typeof parser._params.toArray, 'function', 'xterm.js internals moved');
  assert.equal(typeof parser._oscParser._state, 'number', 'xterm.js internals moved');
  return parser;
}

/**
 * Everything of the parser's state that the bytes after it can see: the state; what was collected
 * and the parameters where a dispatch or a hook can still use them; the OSC's number while in an
 * OSC; a DCS's identifier and parameters while in its payload. (Left out on purpose: what a
 * sequence that ended left behind, which the next sequence clears before it reads it.)
 */
function observable(p: ParserInternals): unknown {
  const state = p.currentState;
  const view: Record<string, unknown> = { state };
  const withParams = [
    CSI_ENTRY,
    CSI_PARAM,
    CSI_INTERMEDIATE,
    DCS_ENTRY,
    DCS_PARAM,
    DCS_INTERMEDIATE,
    DCS_PASSTHROUGH,
  ];
  if ([ESCAPE_INTERMEDIATE, ...withParams].includes(state)) view.collect = p._collect;
  if (withParams.includes(state)) {
    const params = p._params;
    view.params = params.toArray();
    view.rejectDigits = params._rejectDigits;
    if (!params._rejectDigits) {
      view.digitIsSub = params._digitIsSub;
      if (params._digitIsSub) view.rejectSubDigits = params._rejectSubDigits;
    }
  }
  if (state === OSC_STRING) {
    view.osc =
      p._oscParser._state === OSC_ABORT ? 'abort' : [p._oscParser._state, p._oscParser._id];
  }
  if (state === DCS_PASSTHROUGH) view.dcs = p._dcsParser._ident;
  return view;
}

/** A headless terminal that logs what its handlers of a few sequences receive. */
function oracle(): { term: Terminal; log: unknown[][] } {
  const term = new modules.Terminal({ cols: 40, rows: 4, allowProposedApi: true, logLevel: 'off' });
  const log: unknown[][] = [];
  for (const ident of [0, 2, 8, 52, 777]) {
    term.parser.registerOscHandler(ident, (data) => {
      log.push(['osc', ident, data]);
      return false;
    });
  }
  for (const id of [
    { intermediates: '$', final: 'q' },
    { final: 'q' },
    { prefix: '?', final: 'p' },
  ]) {
    term.parser.registerDcsHandler(id, (data, params) => {
      log.push(['dcs', JSON.stringify(id), data, params]);
      return false;
    });
  }
  for (const id of [
    { final: 'm' },
    { prefix: '?', final: 'h' },
    { intermediates: ' ', final: 'q' },
    { prefix: '?', intermediates: '$', final: 'p' },
    { final: 'c' },
  ]) {
    term.parser.registerCsiHandler(id, (params) => {
      log.push(['csi', JSON.stringify(id), params]);
      return false;
    });
  }
  term.parser.registerEscHandler({ intermediates: '(', final: '0' }, () => {
    log.push(['esc', '(0']);
    return false;
  });
  return { term, log };
}

/**
 * Writes `data` as one parse call, at once: xterm.js 6.0.0's internal `_core.writeSync`, which hands
 * each chunk to the parser as `write` does, without the timer (the screen side's chunks are its
 * records). It warns that it will be removed: screen.test.ts pins it (S2 21).
 */
function write(term: Terminal, data: string | Uint8Array): void {
  const core = (term as unknown as { _core?: { writeSync?: (data: string | Uint8Array) => void } })
    ._core;
  assert.equal(typeof core?.writeSync, 'function', 'xterm.js has no _core.writeSync: see S2 21');
  core?.writeSync?.(data);
}

/**
 * The original parser after `chunks` (one write each) and a fresh one after their tail are in the
 * same state, and stay so through the writes of `next`: the same state, the same handler calls.
 */
function assertSameParser(
  chunks: Uint8Array | Uint8Array[],
  next: Uint8Array | Uint8Array[],
  label: string,
): void {
  const writes = Array.isArray(chunks) ? chunks : [chunks];
  const scanner = escapeTail();
  for (const chunk of writes) scanner.push(chunk);
  const tail = scanner.unfinished();
  const a = oracle();
  const b = oracle();
  try {
    for (const chunk of writes) write(a.term, chunk);
    write(b.term, tail);
    assert.deepEqual(observable(parserOf(b.term)), observable(parserOf(a.term)), 'after the cut');
    a.log.length = 0;
    b.log.length = 0;
    for (const chunk of Array.isArray(next) ? next : [next]) {
      write(a.term, chunk);
      write(b.term, chunk);
    }
    assert.deepEqual(b.log, a.log, 'handler calls after the cut');
    assert.deepEqual(observable(parserOf(b.term)), observable(parserOf(a.term)), 'after the rest');
  } catch (error) {
    assert.fail(`${label}: tail ${JSON.stringify(tail)}: ${String(error)}`);
  } finally {
    a.term.dispose();
    b.term.dispose();
  }
}

/** A small deterministic generator (mulberry32), so that a failure can be replayed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces of streams: every byte class the VT500 table tells apart, and broken UTF-8. */
const PIECES: Uint8Array[] = [
  ...[
    '\x1b',
    '[',
    ']',
    'P',
    'X',
    '^',
    '_',
    '(',
    '#',
    '?',
    '>',
    '<',
    '=',
    '$',
    '!',
    ' ',
    '"',
    '0',
    '1',
    '2',
    '5',
    '7',
    '8',
    '9',
    ';',
    ':',
    'm',
    'q',
    'h',
    'p',
    'c',
    '\\',
    '@',
    '~',
    'a',
    '\x07',
    '\x18',
    '\x1a',
    '\n',
    '\r',
    '\x08',
    '\x00',
    '\x1c',
    '\x7f',
    '\u009b',
    '\u009d',
    '\u0090',
    '\u009c',
    '\u0098',
    '\u009e',
    '\u009f',
    '\u0085',
    '\u0099',
    '\u00a0',
    'é',
    '漢',
    '🙂',
    '\x1b[',
    '\x1b]',
    '\x1bP',
    '\x1b]0;',
    '\x1b]8;;',
    '\x1b]52;c;',
    '\x1bP$q',
    '\x1b[?',
  ].map(utf8),
  Uint8Array.of(0x9b),
  Uint8Array.of(0xc3),
  Uint8Array.of(0xe2, 0x82),
  Uint8Array.of(0xff),
  Uint8Array.of(0xef, 0xbb, 0xbf),
  Uint8Array.of(0xc0, 0x9b),
];

function stream(next: () => number, length: number): Uint8Array {
  const parts: number[] = [];
  for (let i = 0; i < length; i++) {
    const piece = PIECES[Math.floor(next() * PIECES.length)] ?? PIECES[0];
    parts.push(...(piece ?? []));
  }
  return Uint8Array.from(parts);
}

/** `bytes` cut into up to four writes at random bytes (UTF-8 characters too). */
function writesOf(next: () => number, bytes: Uint8Array): Uint8Array[] {
  const cuts = [0, bytes.length];
  for (let i = Math.floor(next() * 4); i > 0; i--) cuts.push(Math.floor(next() * bytes.length));
  cuts.sort((x, y) => x - y);
  return cuts.slice(1).map((end, i) => bytes.slice(cuts[i], end));
}

describe('escapeTail: a fresh xterm.js parser given the tail is in the state of the original', () => {
  test('every case of the table', () => {
    for (const [name, s] of CASES) {
      assertSameParser(utf8(s), utf8('1;2m\x07z\x1b\\'), name);
    }
  });

  // By design the rebuilt parser does not take a string kept bounded as the original does: it
  // ignores the rest, so that no handler of it acts on a cut payload.
  for (const [name, start, rest] of [
    ['an OSC 52 over 64 KiB', `\x1b]52;c;${'A'.repeat(LIMIT)}`, 'A\tA\x7fé漢\x07'],
    ['an OSC 52 over 64 KiB, ended by ESC', `\x1b]52;c;${'A'.repeat(LIMIT)}`, 'AA\x1b\\'],
    ['an OSC 52 over 64 KiB, ended by ST as U+009C', `\x1b]52;c;${'A'.repeat(LIMIT)}`, 'A\u009c'],
    ['an OSC 52 over 64 KiB, ended by CAN', `\x1b]52;c;${'A'.repeat(LIMIT)}`, 'A\x18'],
    ['a DCS over 64 KiB', `\x1bP$q${'m'.repeat(LIMIT)}`, 'm\n\x7fé漢\x1b\\'],
    ['a DCS over 64 KiB, ended by ST as U+009C', `\x1bP$q${'m'.repeat(LIMIT)}`, 'm\u009c'],
    ['a DCS over 64 KiB, ended by SUB', `\x1bPq${'#'.repeat(LIMIT)}`, '#\x1a'],
    ['a DCS over 64 KiB, ended by a C1 control', `\x1bPq${'#'.repeat(LIMIT)}`, '#\u0085'],
  ] as const) {
    test(`a string kept bounded: ${name} — left at the same byte, and no handler acts`, () => {
      const tail = tailOf(start);
      assert.ok(tail.length < 8, JSON.stringify(tail));
      const a = oracle();
      const b = oracle();
      write(a.term, start);
      write(b.term, tail);
      a.log.length = 0;
      // Inside the string, a DCS kept bounded is in xterm.js's DCS ignore state, not its payload.
      const left = (term: Terminal): boolean => [0, 1].includes(parserOf(term).currentState);
      for (const char of rest) {
        assert.equal(left(b.term), left(a.term), JSON.stringify(char));
        write(a.term, char);
        write(b.term, char);
      }
      assert.deepEqual(observable(parserOf(b.term)), observable(parserOf(a.term)), 'after the end');
      assert.deepEqual(b.log, [], 'the rebuilt parser runs no handler');
      a.log.length = 0;
      write(a.term, '\x1b]0;next\x07');
      write(b.term, '\x1b]0;next\x07');
      assert.deepEqual(b.log, a.log, 'the next sequence');
      a.term.dispose();
      b.term.dispose();
    });
  }

  test('endless CSI, ESC and DCS heads and OSC numbers', () => {
    for (const s of [
      `\x1b[${'1;'.repeat(40)}`,
      `\x1b[${'1;'.repeat(40)}5`,
      `\x1b[${'9'.repeat(40)}`,
      `\x1b[1${':2'.repeat(40)}`,
      `\x1b[1${':2'.repeat(40)};3`,
      `\x1b[1${':2'.repeat(40)};3:`,
      `\x1b[1${':2'.repeat(31)}::`,
      `\x1b[${'1;'.repeat(31)}1:2`,
      `\x1b[${'1;'.repeat(33)}:`,
      `\x1b[?${'0'.repeat(40)}1`,
      `\x1b[?1${'!'.repeat(7)}`,
      `\x1b[?1${'!$'.repeat(2)}`,
      `\x1b[?1$!$`,
      `\x1b${'('.repeat(7)}`,
      `\x1bP${'1;'.repeat(40)}`,
      `\x1bP?1${'!'.repeat(6)}`,
      `\x1b]${'0'.repeat(70_000)}`,
      `\x1b]${'9'.repeat(70_000)}`,
    ]) {
      for (const next of ['5m', ':7m', ';7m', '7m', '!q', '$p', '0', 'm', 'q;x\x07', '\x1b\\']) {
        assertSameParser(utf8(s), utf8(next), `${JSON.stringify(s)} then ${JSON.stringify(next)}`);
      }
    }
  });

  test('a DEL in a DCS payload: passed on inside a run of the same write, dropped at its start', () => {
    for (const writes of [
      ['\x1bPq#\x7f!'],
      ['\x1bPq\x7f#\x7f!'],
      ['\x1bPq#', '\x7f!'],
      ['\x1bPq#', '\x7f\x7f#\x7f'],
      ['\x1bPq#\x1b\\\x1bPq\x7f#'],
      ['\x1bP$q', 'm\x7f'],
    ]) {
      for (const next of [['\x7f#\x1b\\'], ['#\x7f\x1b\\'], ['\x1b\\']]) {
        assertSameParser(writes.map(utf8), next.map(utf8), JSON.stringify([writes, next]));
      }
    }
  });

  test('4,000 random streams in random writes, cut at a random point', () => {
    const next = random(33);
    for (let i = 0; i < 4000; i++) {
      const s = stream(next, 1 + Math.floor(next() * 24));
      const rest = stream(next, Math.floor(next() * 12));
      assertSameParser(
        writesOf(next, s),
        [...writesOf(next, rest), Uint8Array.of(0x1b, 0x5c)],
        `case ${i}`,
      );
    }
  });
});
