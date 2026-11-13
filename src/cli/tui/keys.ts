// Raw terminal input as the key names `reduce` understands (plan 2.9.5). A chunk is what one read
// of standard input returned in raw mode: usually one key, sometimes several (a paste, a key held
// down).

const ESC = '\x1b';

/** The arrows the list reads; every other escape sequence is no key at all. */
const ARROWS: Readonly<Record<string, string>> = { A: 'up', B: 'down' };

/** C0 and C1 control characters and DEL: none of them is a key unless `decodeKeys` names it. */
const CONTROL = /^[\u0000-\u001f\u007f-\u009f]$/u;
const CSI_PARAMETER = /^[\x30-\x3f]$/;
const CSI_INTERMEDIATE = /^[\x20-\x2f]$/;
const CSI_FINAL = /^[\x40-\x7e]$/;

/** The character (code point) that starts at `at`; '' past the end. */
function characterAt(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? '' : String.fromCodePoint(code);
}

/**
 * The escape sequence that starts at `at` (an ESC): where it ends, and the key it is, if any.
 * - a lone ESC at the end of the chunk is the escape key;
 * - SS3 (ESC 'O' and one character) is an arrow as ESC OA or ESC OB, else nothing;
 * - CSI (ESC '[', parameter bytes 0x30–0x3F, intermediate bytes 0x20–0x2F, a final byte
 *   0x40–0x7E) is an arrow only as ESC[A or ESC[B (no parameters: a modifier makes another key);
 *   one cut off by the end of the chunk, or broken, ends the chunk: what follows is not trusted;
 * - ESC with any other character (Alt and a key) is dropped together with it.
 */
function escapeSequence(chunk: string, at: number): { end: number; key: string | null } {
  const introducer = characterAt(chunk, at + 1);
  if (introducer === '') {
    return { end: at + 1, key: 'escape' };
  }
  if (introducer === 'O') {
    const final = characterAt(chunk, at + 2);
    return { end: at + 2 + final.length, key: ARROWS[final] ?? null };
  }
  if (introducer !== '[') {
    return { end: at + 1 + introducer.length, key: null };
  }
  let end = at + 2;
  while (CSI_PARAMETER.test(chunk[end] ?? '')) end++;
  const parameters = end - (at + 2);
  while (CSI_INTERMEDIATE.test(chunk[end] ?? '')) end++;
  const final = chunk[end] ?? '';
  if (!CSI_FINAL.test(final)) {
    return { end: chunk.length, key: null };
  }
  const plain = parameters === 0 && end === at + 2;
  return { end: end + 1, key: plain ? (ARROWS[final] ?? null) : null };
}

/**
 * Splits raw terminal input into key names: ESC[A up, ESC[B down, ESC OA/OB too, \r and \n enter
 * (\r\n, as a paste brings it, is one), \x7f and \b backspace, \x03 ctrl-c, a lone ESC escape;
 * other escape sequences and other control characters are dropped. Everything else is one key per
 * character (a code point: a character outside the basic plane is one key).
 */
export function decodeKeys(chunk: string): string[] {
  const keys: string[] = [];
  let at = 0;
  while (at < chunk.length) {
    const character = characterAt(chunk, at);
    if (character === ESC) {
      const { end, key } = escapeSequence(chunk, at);
      if (key !== null) keys.push(key);
      at = end;
      continue;
    }
    at += character.length;
    if (character === '\r' || character === '\n') {
      keys.push('enter');
      if (character === '\r' && chunk[at] === '\n') at++;
    } else if (character === '\x7f' || character === '\b') {
      keys.push('backspace');
    } else if (character === '\x03') {
      keys.push('ctrl-c');
    } else if (!CONTROL.test(character)) {
      keys.push(character);
    }
  }
  return keys;
}
