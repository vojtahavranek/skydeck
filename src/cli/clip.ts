const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

/**
 * The start of `text` that is at most `width` UTF-16 units long and does not end inside a
 * surrogate pair (half a pair would print as a broken character). Not a count of terminal cells:
 * a wide character takes two cells and one or two units.
 */
export function clip(text: string, width: number): string {
  if (!(width > 0)) {
    return '';
  }
  if (text.length <= width) {
    return text;
  }
  const end = Math.floor(width);
  const last = text.charCodeAt(end - 1);
  const splitsPair = last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST;
  return text.slice(0, splitsPair ? end - 1 : end);
}
