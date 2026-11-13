// How a JSON document is written to the terminal (design 7.5, 7.4).

/**
 * What `JSON.stringify` leaves as it is although a terminal acts on it: DEL, the C1 controls
 * (U+009B alone starts a control sequence on a terminal that reads 8-bit controls) and the
 * bidirectional controls. The C0 controls it escapes itself.
 */
const TERMINAL_ACTIVE = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * `JSON.stringify(value, null, 2)` and a newline, with the characters a terminal would act on
 * written as `\uXXXX` escapes. Such characters can only stand inside a string (a key is one too),
 * where the escape means the same character, so `JSON.parse` of the text gives the exact value
 * back, and `skydeck show --json` on a terminal is safe whatever a note or a command line holds
 * (design 7.4: nothing foreign reaches the terminal as a control; here the data is not changed,
 * only how it is written).
 */
export function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2).replace(
    TERMINAL_ACTIVE,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${text}\n`;
}
