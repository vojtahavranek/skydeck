// The notes of what is new (S2 16.5 "What an update brings"): one small file per change a user can
// see, `docs/news/<yyyy-mm-dd>-<name>.md`. Its first line is `# <title>`; after a blank line, the
// text: plain sentences in one or more paragraphs (a blank line between them; a line break inside
// a paragraph is a space). A run between two backticks is code; nothing else of Markdown means
// anything. The look reads the notes an update brings from git objects of the fetched commit, so
// a note is foreign text: it is sanitised and clipped here, and a file that is not a note is
// skipped (parseNote's null). The repository's own test holds every note of the checkout to the
// limits (noteProblem).
import { clip } from '../text/clip.ts';
import { sanitize } from '../text/sanitize.ts';

/** The folder of the notes, from the checkout's top, as git's paths read. */
export const NEWS_DIR = 'docs/news';
/** A note's file name; every other name is not a note (README.md says the format). */
export const NOTE_FILE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$/;
/** The longest title and text shown (UTF-16 units); a longer one is clipped with `…`. */
export const TITLE_MAX = 120;
export const TEXT_MAX = 600;
/** The most notes an update shows; the rest are `… and <n> more`. */
export const NOTES_SHOWN = 20;
/** A larger file is not a note: it is not read. Of any file only this much is kept. */
export const NOTE_BYTES = 8 * 1024;

/** A note as it is shown: its title, and its text's paragraphs (sanitised, clipped). */
export interface Note {
  title: string;
  paragraphs: string[];
}

/** A piece of a text: as written, or a code run (its backticks dropped). */
export interface Run {
  text: string;
  code: boolean;
}

/** `text` as it is when it is at most `max` long, else its start and `…`, `max` long in all. */
function clipped(text: string, max: number): string {
  return text.length > max ? `${clip(text, max - 1)}…` : text;
}

/**
 * Whether `text` shows nothing: empty, or only spaces and characters that are drawn as nothing
 * (format characters such as a zero-width space, separators).
 */
function blank(text: string): boolean {
  return text.replace(/[\s\p{Cf}\p{Z}]/gu, '') === '';
}

/** The parts of a file, before any limit: null when it is not a note at all. */
function parts(text: string): { title: string; paragraphs: string[] } | null {
  // A NUL, or a byte that is not UTF-8 (decoded as U+FFFD): a binary file.
  if (text.includes('\0') || text.includes('\ufffd')) return null;
  const lines = text
    .replace(/^\ufeff/, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  const head = /^# (.*)$/.exec(lines[0] ?? '');
  if (head === null || (lines[1] ?? '').trim() !== '') return null;
  const title = sanitize(head[1] ?? '').trim();
  const paragraphs: string[] = [];
  let open: string[] = [];
  const end = (): void => {
    // A paragraph that sanitising leaves showing nothing is dropped.
    const paragraph = sanitize(open.join(' ')).trim();
    if (!blank(paragraph)) paragraphs.push(paragraph);
    open = [];
  };
  for (const line of lines.slice(2)) {
    const words = line.trim();
    if (words === '') end();
    else open.push(words);
  }
  end();
  if (blank(title) || paragraphs.length === 0) return null;
  return { title, paragraphs };
}

/** The paragraphs within TEXT_MAX in all: the one that passes it clipped with `…`, the rest dropped. */
export function clipText(paragraphs: readonly string[], max = TEXT_MAX): string[] {
  const kept: string[] = [];
  let left = max;
  for (const paragraph of paragraphs) {
    if (paragraph.length <= left) {
      kept.push(paragraph);
      left -= paragraph.length;
      continue;
    }
    const last = kept.pop();
    if (left > 1 || last === undefined) {
      if (last !== undefined) kept.push(last);
      kept.push(`${clip(paragraph, left - 1)}…`);
    } else {
      // No room for a clipped paragraph: the last one kept ends with the `…` instead.
      kept.push(`${clip(last, last.length - 1 + left)}…`);
    }
    break;
  }
  return kept;
}

/** A title within TITLE_MAX, clipped with `…`. */
export function clipTitle(title: string): string {
  return clipped(title, TITLE_MAX);
}

/** A file's text as a note, for the look: sanitised and within the limits; null: not a note. */
export function parseNote(text: string): Note | null {
  const found = parts(text);
  if (found === null) return null;
  return { title: clipTitle(found.title), paragraphs: clipText(found.paragraphs) };
}

/**
 * What is wrong with a note of the repository (its file's bytes), for its test; null: nothing.
 * Stricter than the look: a note over the limits, or one with a character the look would remove,
 * is refused rather than clipped.
 */
export function noteProblem(bytes: Uint8Array): string | null {
  if (bytes.length > NOTE_BYTES) return `it is larger than ${NOTE_BYTES} bytes`;
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('\0') || text.includes('\ufffd')) return 'it is not UTF-8 text';
  const lines = text.replace(/^\ufeff/, '').split('\n');
  if (!/^# /.test(lines[0] ?? '')) return 'its first line is not `# <title>`';
  if ((lines[1] ?? '').trim() !== '') return 'its title line is not followed by a blank line';
  if (blank(sanitize(lines[0] ?? '').slice(2))) return 'its title is empty';
  const found = parts(text);
  if (found === null) return 'its text is empty';
  for (const line of lines) {
    if (sanitize(line.replace(/\r$/, '')) !== line.replace(/\r$/, '')) {
      return 'it holds a control character or an escape sequence';
    }
  }
  if (found.title.length > TITLE_MAX) {
    return `its title is ${found.title.length} characters long, over ${TITLE_MAX}`;
  }
  const length = found.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  if (length > TEXT_MAX) return `its text is ${length} characters long, over ${TEXT_MAX}`;
  return null;
}

/**
 * A text in its runs: a run between two backticks is code (without them); a backtick without a
 * partner, and an empty pair, are text as written.
 */
export function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  let plain = '';
  let at = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    plain += text.slice(at, match.index);
    if (plain !== '') runs.push({ text: plain, code: false });
    plain = '';
    runs.push({ text: match[1] ?? '', code: true });
    at = match.index + match[0].length;
  }
  plain += text.slice(at);
  if (plain !== '') runs.push({ text: plain, code: false });
  return runs;
}
