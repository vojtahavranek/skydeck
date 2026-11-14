// The snapshot's seam (S2 7.2; plan task 33). Pure; imports nothing.
//
// A record from the keeper can end inside an escape sequence, and a snapshot taken there would cut
// it: the next record's continuation would reach a screen rebuilt from the snapshot as text. This
// scanner follows the stream the screen side applies as xterm.js 6.0.0's parser does — its
// `EscapeSequenceParser`, the VT500 state machine of vt100.net as xterm.js changed it, on code
// points decoded from UTF-8 as its `Utf8ToUtf32` decodes them — and keeps the sequence the stream
// stands inside: exactly what puts a fresh parser into the state of the original, so that the next
// record completes it on the rebuilt screen as it does on the original.
//
// What is kept, and what is not:
// - a code point that changes nothing a later byte can see is left out: a C0 control that
//   xterm.js executes inside an ESC or CSI sequence (its effect is already in the snapshot), one it
//   ignores, a digit that leaves a parameter as it is, an intermediate older than the four
//   xterm.js keeps, what follows a parameter list xterm.js has stopped reading, and everything
//   inside a sequence xterm.js ignores (a CSI or DCS it has given up on; SOS, PM and APC). So an
//   ESC, CSI or DCS head stays under 1 KiB however long the program makes it;
// - the code points a string's handler (OSC, DCS) will receive are kept; when they would pass
//   64 KiB the string is kept as its introducer and what makes xterm.js 6.0.0 ignore the rest, so
//   that no handler acts on a cut payload (the original acts on it: xterm.js's own limit is 10 MB).
//
// xterm.js, where it differs from the VT500 diagram, wins: the rebuilt screen is xterm.js too. An
// ESC ends an OSC or a DCS at once (its handler runs) and begins a new sequence; a C1 control
// inside a string leaves for the ground state or a new sequence; a character above U+009F ends an
// ESC sequence, a CSI or DCS head, and SOS, PM or APC.
//
// One known difference from xterm.js's decoder: xterm.js 6.0.0 loses a character cut between two
// writes after a continuation byte 0x80 (its `Utf8ToUtf32` stops reading what it kept at the first
// 0x80); this scanner completes it. The keeper never ends a record inside a UTF-8 character
// (S2 7.1), so the two never see such a cut.

export interface EscapeTail {
  /** Follows the stream: every byte the screen side applies, in order, in any chunks. */
  push(bytes: Uint8Array): void;
  /** The escape sequence the stream stands inside; '' in the ground state. */
  unfinished(): string;
}

// xterm.js's parser states (`ParserState`).
const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTERMEDIATE = 5;
const CSI_IGNORE = 6;
const SOS_PM_APC_STRING = 7;
const OSC_STRING = 8;
const DCS_ENTRY = 9;
const DCS_PARAM = 10;
const DCS_IGNORE = 11;
const DCS_INTERMEDIATE = 12;
const DCS_PASSTHROUGH = 13;

// xterm.js's parser actions (`ParserAction`).
const IGNORE = 0;
const ERROR = 1;
const PRINT = 2;
const EXECUTE = 3;
const OSC_START = 4;
const OSC_PUT = 5;
const OSC_END = 6;
const CSI_DISPATCH = 7;
const PARAM = 8;
const COLLECT = 9;
const ESC_DISPATCH = 10;
const CLEAR = 11;
const DCS_HOOK = 12;
const DCS_PUT = 13;
const DCS_UNHOOK = 14;

/** Every code point from U+00A0 up is looked up as this one, as in xterm.js. */
const NON_ASCII = 0xa0;

/**
 * xterm.js 6.0.0's `VT500_TRANSITION_TABLE`, built by the same rules in the same order:
 * `table[state << 8 | code]` is `action << 4 | next state`.
 */
const TABLE = ((): Uint8Array => {
  const table = new Uint8Array((DCS_PASSTHROUGH + 1) << 8).fill((ERROR << 4) | GROUND);
  const range = (start: number, end: number): number[] =>
    Array.from({ length: end - start }, (_, i) => start + i);
  const add = (codes: number[], state: number, action: number, next: number): void => {
    for (const code of codes) table[(state << 8) | code] = (action << 4) | next;
  };
  const PRINTABLES = range(0x20, 0x7f);
  const EXECUTABLES = [...range(0x00, 0x18), 0x19, ...range(0x1c, 0x20)];

  add(PRINTABLES, GROUND, PRINT, GROUND);
  // Anywhere.
  for (let state = GROUND; state <= DCS_PASSTHROUGH; state++) {
    add([0x18, 0x1a, 0x99, 0x9a], state, EXECUTE, GROUND);
    add(range(0x80, 0x90), state, EXECUTE, GROUND);
    add(range(0x90, 0x98), state, EXECUTE, GROUND);
    add([0x9c], state, IGNORE, GROUND);
    add([0x1b], state, CLEAR, ESCAPE);
    add([0x9d], state, OSC_START, OSC_STRING);
    add([0x98, 0x9e, 0x9f], state, IGNORE, SOS_PM_APC_STRING);
    add([0x9b], state, CLEAR, CSI_ENTRY);
    add([0x90], state, CLEAR, DCS_ENTRY);
  }
  // C0 controls and DEL.
  add(EXECUTABLES, GROUND, EXECUTE, GROUND);
  add(EXECUTABLES, ESCAPE, EXECUTE, ESCAPE);
  add([0x7f], ESCAPE, IGNORE, ESCAPE);
  add(EXECUTABLES, OSC_STRING, IGNORE, OSC_STRING);
  add(EXECUTABLES, CSI_ENTRY, EXECUTE, CSI_ENTRY);
  add([0x7f], CSI_ENTRY, IGNORE, CSI_ENTRY);
  add(EXECUTABLES, CSI_PARAM, EXECUTE, CSI_PARAM);
  add([0x7f], CSI_PARAM, IGNORE, CSI_PARAM);
  add(EXECUTABLES, CSI_IGNORE, EXECUTE, CSI_IGNORE);
  add(EXECUTABLES, CSI_INTERMEDIATE, EXECUTE, CSI_INTERMEDIATE);
  add([0x7f], CSI_INTERMEDIATE, IGNORE, CSI_INTERMEDIATE);
  add(EXECUTABLES, ESCAPE_INTERMEDIATE, EXECUTE, ESCAPE_INTERMEDIATE);
  add([0x7f], ESCAPE_INTERMEDIATE, IGNORE, ESCAPE_INTERMEDIATE);
  // OSC.
  add([0x5d], ESCAPE, OSC_START, OSC_STRING);
  add(PRINTABLES, OSC_STRING, OSC_PUT, OSC_STRING);
  add([0x7f], OSC_STRING, OSC_PUT, OSC_STRING);
  add([0x9c, 0x1b, 0x18, 0x1a, 0x07], OSC_STRING, OSC_END, GROUND);
  add(range(0x1c, 0x20), OSC_STRING, IGNORE, OSC_STRING);
  // SOS, PM, APC: nothing.
  add([0x58, 0x5e, 0x5f], ESCAPE, IGNORE, SOS_PM_APC_STRING);
  add(PRINTABLES, SOS_PM_APC_STRING, IGNORE, SOS_PM_APC_STRING);
  add(EXECUTABLES, SOS_PM_APC_STRING, IGNORE, SOS_PM_APC_STRING);
  add([0x9c], SOS_PM_APC_STRING, IGNORE, GROUND);
  add([0x7f], SOS_PM_APC_STRING, IGNORE, SOS_PM_APC_STRING);
  // CSI.
  add([0x5b], ESCAPE, CLEAR, CSI_ENTRY);
  add(range(0x40, 0x7f), CSI_ENTRY, CSI_DISPATCH, GROUND);
  add(range(0x30, 0x3c), CSI_ENTRY, PARAM, CSI_PARAM);
  add([0x3c, 0x3d, 0x3e, 0x3f], CSI_ENTRY, COLLECT, CSI_PARAM);
  add(range(0x30, 0x3c), CSI_PARAM, PARAM, CSI_PARAM);
  add(range(0x40, 0x7f), CSI_PARAM, CSI_DISPATCH, GROUND);
  add([0x3c, 0x3d, 0x3e, 0x3f], CSI_PARAM, IGNORE, CSI_IGNORE);
  add(range(0x20, 0x40), CSI_IGNORE, IGNORE, CSI_IGNORE);
  add([0x7f], CSI_IGNORE, IGNORE, CSI_IGNORE);
  add(range(0x40, 0x7f), CSI_IGNORE, IGNORE, GROUND);
  add(range(0x20, 0x30), CSI_ENTRY, COLLECT, CSI_INTERMEDIATE);
  add(range(0x20, 0x30), CSI_INTERMEDIATE, COLLECT, CSI_INTERMEDIATE);
  add(range(0x30, 0x40), CSI_INTERMEDIATE, IGNORE, CSI_IGNORE);
  add(range(0x40, 0x7f), CSI_INTERMEDIATE, CSI_DISPATCH, GROUND);
  add(range(0x20, 0x30), CSI_PARAM, COLLECT, CSI_INTERMEDIATE);
  // ESC with intermediates.
  add(range(0x20, 0x30), ESCAPE, COLLECT, ESCAPE_INTERMEDIATE);
  add(range(0x20, 0x30), ESCAPE_INTERMEDIATE, COLLECT, ESCAPE_INTERMEDIATE);
  add(range(0x30, 0x7f), ESCAPE_INTERMEDIATE, ESC_DISPATCH, GROUND);
  add(range(0x30, 0x50), ESCAPE, ESC_DISPATCH, GROUND);
  add(range(0x51, 0x58), ESCAPE, ESC_DISPATCH, GROUND);
  add([0x59, 0x5a, 0x5c], ESCAPE, ESC_DISPATCH, GROUND);
  add(range(0x60, 0x7f), ESCAPE, ESC_DISPATCH, GROUND);
  // DCS.
  add([0x50], ESCAPE, CLEAR, DCS_ENTRY);
  add(EXECUTABLES, DCS_ENTRY, IGNORE, DCS_ENTRY);
  add([0x7f], DCS_ENTRY, IGNORE, DCS_ENTRY);
  add(range(0x1c, 0x20), DCS_ENTRY, IGNORE, DCS_ENTRY);
  add(range(0x20, 0x30), DCS_ENTRY, COLLECT, DCS_INTERMEDIATE);
  add(range(0x30, 0x3c), DCS_ENTRY, PARAM, DCS_PARAM);
  add([0x3c, 0x3d, 0x3e, 0x3f], DCS_ENTRY, COLLECT, DCS_PARAM);
  add(EXECUTABLES, DCS_IGNORE, IGNORE, DCS_IGNORE);
  add(range(0x20, 0x80), DCS_IGNORE, IGNORE, DCS_IGNORE);
  add(range(0x1c, 0x20), DCS_IGNORE, IGNORE, DCS_IGNORE);
  add(EXECUTABLES, DCS_PARAM, IGNORE, DCS_PARAM);
  add([0x7f], DCS_PARAM, IGNORE, DCS_PARAM);
  add(range(0x1c, 0x20), DCS_PARAM, IGNORE, DCS_PARAM);
  add(range(0x30, 0x3c), DCS_PARAM, PARAM, DCS_PARAM);
  add([0x3c, 0x3d, 0x3e, 0x3f], DCS_PARAM, IGNORE, DCS_IGNORE);
  add(range(0x20, 0x30), DCS_PARAM, COLLECT, DCS_INTERMEDIATE);
  add(EXECUTABLES, DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE);
  add([0x7f], DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE);
  add(range(0x1c, 0x20), DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE);
  add(range(0x20, 0x30), DCS_INTERMEDIATE, COLLECT, DCS_INTERMEDIATE);
  add(range(0x30, 0x40), DCS_INTERMEDIATE, IGNORE, DCS_IGNORE);
  add(range(0x40, 0x7f), DCS_INTERMEDIATE, DCS_HOOK, DCS_PASSTHROUGH);
  add(range(0x40, 0x7f), DCS_PARAM, DCS_HOOK, DCS_PASSTHROUGH);
  add(range(0x40, 0x7f), DCS_ENTRY, DCS_HOOK, DCS_PASSTHROUGH);
  add(EXECUTABLES, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH);
  add(PRINTABLES, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH);
  add([0x7f], DCS_PASSTHROUGH, IGNORE, DCS_PASSTHROUGH);
  add([0x1b, 0x9c, 0x18, 0x1a], DCS_PASSTHROUGH, DCS_UNHOOK, GROUND);
  // Code points from U+00A0 up.
  add([NON_ASCII], GROUND, PRINT, GROUND);
  add([NON_ASCII], OSC_STRING, OSC_PUT, OSC_STRING);
  add([NON_ASCII], CSI_IGNORE, IGNORE, CSI_IGNORE);
  add([NON_ASCII], DCS_IGNORE, IGNORE, DCS_IGNORE);
  add([NON_ASCII], DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH);
  return table;
})();

// xterm.js's `Params`: 32 parameters, 32 sub-parameters, values clamped to 2^31 - 1.
const MAX_PARAMS = 32;
const MAX_SUB_PARAMS = 32;
const MAX_VALUE = 0x7fffffff;

// The OSC parser's states (`OscState`) that matter once an OSC has started.
const OSC_ID = 1;
const OSC_PAYLOAD = 2;
const OSC_ABORT = 3;

/** A string sequence's kept bytes may not pass this. */
const STRING_LIMIT = 65536;

/**
 * What follows a string's introducer when the string is too long to keep: xterm.js 6.0.0 then
 * ignores the rest of it up to the same terminator. An OSC whose number is not a number is
 * aborted (`OscState.ABORT`); a DCS head with a parameter after an intermediate goes to its
 * ignore state (`DCS_IGNORE`).
 */
const IGNORED_OSC = '!';
const IGNORED_DCS = '!0';

const utf8Length = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** UTF-8 bytes of a string of whole code points. */
function utf8LengthOf(text: string): number {
  let length = 0;
  for (const char of text) length += utf8Length(char.codePointAt(0) ?? 0);
  return length;
}

export function escapeTail(): EscapeTail {
  let state = GROUND;

  // The sequence the stream stands inside, in the order its parts come.
  /** ESC; ESC with `[`, `]`, `P`, `X`, `^` or `_`; or the C1 control that began it. */
  let intro = '';
  /** A CSI's or DCS's prefix (`<`, `=`, `>`, `?`). */
  let prefix = '';
  /** The parameter text that changes the parameters. */
  let params = '';
  /** The last four intermediates (xterm.js shifts older ones out of its 32-bit `_collect`). */
  let inter = '';
  let interCount = 0;
  /** The character that sent a CSI or DCS head into its ignore state. */
  let diverted = '';
  /** A DCS's final character. */
  let final = '';
  /** What a string's handler receives so far (an OSC's number included). */
  let payload = '';
  /** UTF-8 bytes of the tail of a string sequence. */
  let stringBytes = 0;
  /** The string was too long to keep. */
  let bounded = false;
  /**
   * A DCS payload run has begun in this push. xterm.js's table ignores DEL in a DCS payload, but
   * its read-ahead loop, once a payload character began a run, passes every DEL that follows in the
   * same write to the handler: so DEL is kept only inside such a run. The screen side pushes
   * exactly the writes xterm.js parses. (xterm.js parses a write longer than 131,072 units in
   * pieces, and a run ends at each: only a snapshot is that long, and only a DEL right after such
   * a boundary inside a DCS payload at the snapshot's very end would differ.)
   */
  let run = false;

  // xterm.js's `Params`, as far as it decides whether a byte changes anything.
  let count = 1;
  let subCount = 0;
  let rejectDigits = false;
  let rejectSubDigits = false;
  let digitIsSub = false;
  let lastParam = 0;
  let lastSub = -1;

  // xterm.js's `OscParser`, the same.
  let oscState = OSC_ID;
  let oscId = -1;

  /** A UTF-8 character cut at the end of the last push. */
  let held: number[] = [];

  function begin(introducer: string): void {
    intro = introducer;
    prefix = '';
    params = '';
    inter = '';
    interCount = 0;
    diverted = '';
    final = '';
    payload = '';
    stringBytes = 0;
    bounded = false;
    run = false;
    count = 1;
    subCount = 0;
    rejectDigits = false;
    rejectSubDigits = false;
    digitIsSub = false;
    lastParam = 0;
    lastSub = -1;
    oscState = OSC_ID;
    oscId = -1;
  }

  /**
   * `Params.addParam`, `addSubParam` and `addDigit` for one parameter character; whether it changed
   * anything a later byte can see. Once xterm.js rejects further parameters nothing does; while
   * the digits go to the parameters, whether further sub-parameters are rejected does not show.
   */
  function param(cp: number): boolean {
    if (rejectDigits) return false;
    if (cp === 0x3b) {
      digitIsSub = false;
      if (count >= MAX_PARAMS) {
        rejectDigits = true;
      } else {
        count++;
        lastParam = 0;
      }
      return true;
    }
    if (cp === 0x3a) {
      const seen = digitIsSub && rejectSubDigits;
      digitIsSub = true;
      if (subCount >= MAX_SUB_PARAMS) {
        rejectSubDigits = true;
        return !seen;
      }
      subCount++;
      lastSub = -1;
      return true;
    }
    if (digitIsSub && (subCount === 0 || rejectSubDigits)) return false;
    const digit = cp - 0x30;
    const before = digitIsSub ? lastSub : lastParam;
    const after = before === -1 ? digit : Math.min(before * 10 + digit, MAX_VALUE);
    if (digitIsSub) lastSub = after;
    else lastParam = after;
    return after !== before;
  }

  /** `OscParser.put` for one code point; whether it changed anything. */
  function oscPut(cp: number): boolean {
    if (oscState === OSC_ABORT) return false;
    if (oscState === OSC_PAYLOAD) return true;
    if (cp === 0x3b) {
      oscState = OSC_PAYLOAD;
      return true;
    }
    if (cp < 0x30 || cp > 0x39) {
      oscState = OSC_ABORT;
      return true;
    }
    const before = oscId;
    oscId = (oscId === -1 ? 0 : oscId) * 10 + cp - 0x30;
    return oscId !== before;
  }

  /** Keeps a code point of a string; past the limit, the string is kept bounded. */
  function keepString(cp: number): void {
    if (bounded) return;
    stringBytes += utf8Length(cp);
    if (stringBytes > STRING_LIMIT) {
      bounded = true;
      payload = '';
    } else {
      payload += String.fromCodePoint(cp);
    }
  }

  /** An introducer: a C1 control on its own, else ESC and the character after it. */
  const introducer = (cp: number): string =>
    cp >= 0x80 ? String.fromCodePoint(cp) : `\x1b${String.fromCodePoint(cp)}`;

  function head(): string {
    const prefixKept = prefix !== '' && interCount <= 3 ? prefix : '';
    return prefixKept + params + inter + diverted;
  }

  /** One code point through xterm.js's table, with what the scanner keeps of it. */
  function step(cp: number): void {
    const transition = TABLE[(state << 8) | (cp < NON_ASCII ? cp : NON_ASCII)] ?? 0;
    const action = transition >> 4;
    let next = transition & 15;
    switch (action) {
      case PRINT:
        break;
      case EXECUTE:
      case ERROR:
      case CSI_DISPATCH:
      case ESC_DISPATCH:
        // A control executed inside an ESC or CSI sequence leaves it as it is (the effect is in
        // the snapshot); anything else that leaves for the ground state ends the sequence.
        if (next === GROUND) begin('');
        break;
      case IGNORE:
        if (next === GROUND) {
          begin('');
        } else if (next === SOS_PM_APC_STRING) {
          // A new SOS, PM or APC, whose content xterm.js ignores.
          if (cp === 0x98 || cp === 0x9e || cp === 0x9f || state === ESCAPE) begin(introducer(cp));
        } else if (next !== state) {
          diverted = String.fromCodePoint(cp);
        } else if (state === DCS_PASSTHROUGH && run) {
          keepString(cp);
        }
        break;
      case CLEAR:
        begin(cp === 0x1b ? '\x1b' : introducer(cp));
        break;
      case OSC_START:
        begin(introducer(cp));
        stringBytes = utf8LengthOf(intro);
        break;
      case OSC_PUT:
        if (!bounded && oscPut(cp)) keepString(cp);
        break;
      case OSC_END:
      case DCS_UNHOOK:
        // xterm.js ends the string at an ESC as well, which then begins a sequence.
        if (cp === 0x1b) {
          next = ESCAPE;
          begin('\x1b');
        } else {
          begin('');
        }
        break;
      case PARAM:
        if (param(cp) || next !== state) params += String.fromCodePoint(cp);
        break;
      case COLLECT:
        if ((state === CSI_ENTRY || state === DCS_ENTRY) && cp >= 0x3c) {
          prefix = String.fromCodePoint(cp);
        } else {
          inter = (inter + String.fromCodePoint(cp)).slice(-4);
          interCount++;
        }
        break;
      case DCS_HOOK:
        run = false;
        final = String.fromCodePoint(cp);
        stringBytes = utf8LengthOf(intro + head() + final);
        break;
      case DCS_PUT:
        run = true;
        keepString(cp);
        break;
    }
    state = next;
  }

  /**
   * xterm.js's `Utf8ToUtf32.decode`: a byte that does not continue a character is read again on
   * its own, an invalid byte, an overlong form, a surrogate, a BOM and a code point above U+10FFFF
   * are skipped. A character cut at the end is held for the next push.
   */
  function decode(input: Uint8Array): void {
    run = false;
    const length = input.length;
    let i = 0;
    while (i < length) {
      const start = i;
      const b1 = input[i++] ?? 0;
      if (b1 < 0x80) {
        // In the ground state only ESC begins anything among the ASCII characters.
        if (state !== GROUND || b1 === 0x1b) step(b1);
        continue;
      }
      const need =
        (b1 & 0xe0) === 0xc0 ? 1 : (b1 & 0xf0) === 0xe0 ? 2 : (b1 & 0xf8) === 0xf0 ? 3 : -1;
      if (need === -1) continue;
      let cp = b1 & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
      let complete = true;
      let broken = false;
      for (let k = 0; k < need; k++) {
        if (i >= length) {
          complete = false;
          break;
        }
        const b = input[i++] ?? 0;
        if ((b & 0xc0) !== 0x80) {
          i--;
          broken = true;
          break;
        }
        cp = (cp << 6) | (b & 0x3f);
      }
      if (!complete) {
        held = Array.from(input.subarray(start));
        return;
      }
      if (broken) continue;
      if (need === 1 && cp < 0x80) {
        // An overlong two-byte form: xterm.js reads its second byte again.
        i--;
        continue;
      }
      if (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfeff)) continue;
      if (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) continue;
      step(cp);
    }
  }

  return {
    push(bytes) {
      if (held.length === 0) {
        decode(bytes);
        return;
      }
      const input = new Uint8Array(held.length + bytes.length);
      input.set(held);
      input.set(bytes, held.length);
      held = [];
      decode(input);
    },
    unfinished() {
      switch (state) {
        case GROUND:
          return '';
        case SOS_PM_APC_STRING:
          return intro;
        case OSC_STRING:
          return intro + (bounded ? IGNORED_OSC : payload);
        case DCS_PASSTHROUGH:
          return bounded ? intro + IGNORED_DCS : intro + head() + final + payload;
        default:
          return intro + head();
      }
    },
  };
}
