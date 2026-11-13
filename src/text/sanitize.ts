// Foreign text (a transcript, a live-session file, GitHub, a program's stderr) reaches the
// terminal only through here, so that nothing in it can move the cursor, change the title,
// start a hyperlink or hide what is printed.

/**
 * An escape sequence, tried in this order at each ESC (or C1 introducer):
 * - a control string: ESC ] / P / X / ^ / _ or U+009D / U+0090 / U+0098 / U+009E / U+009F, up to
 *   and including BEL, ESC '\' or U+009C, or to the end of the string;
 * - a CSI: ESC '[' or U+009B, parameter bytes, intermediate bytes and one final byte;
 * - any other ESC together with the one character after it (or alone at the end of the string).
 */
const ESCAPE_SEQUENCE =
  /(?:\x1b[\]PX^_]|[\u009d\u0090\u0098\u009e\u009f])[^]*?(?:\x07|\x1b\\|\u009c|$)|(?:\x1b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[^]?/gu;

const LINE_BREAKS_AND_TABS = /[\t\n\r]/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDIRECTIONAL_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Makes a foreign string safe to print on one terminal line. In this order:
 * 1. removes escape sequences: CSI (ESC '[' or U+009B, then bytes 0x30–0x3F, 0x20–0x2F, one final
 *    0x40–0x7E); OSC/DCS/SOS/PM/APC (ESC ']' 'P' 'X' '^' '_', or U+009D U+0090 U+0098 U+009E U+009F)
 *    up to and including BEL or ESC '\' or U+009C, or to the end of the string; any other ESC plus
 *    the one character after it;
 * 2. replaces each TAB, LF and CR with one space;
 * 3. removes the remaining U+0000–U+001F, U+007F–U+009F;
 * 4. removes the bidirectional controls U+202A–U+202E and U+2066–U+2069.
 * It does not trim and does not collapse spaces.
 */
export function sanitize(text: string): string {
  return text
    .replace(ESCAPE_SEQUENCE, '')
    .replace(LINE_BREAKS_AND_TABS, ' ')
    .replace(CONTROLS, '')
    .replace(BIDIRECTIONAL_CONTROLS, '');
}
