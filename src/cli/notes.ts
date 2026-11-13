// Editing a session's note in the user's editor (design 7.1). Shared by `skydeck note` and the
// interactive list.
import { join } from 'node:path';

import { SkydeckError, UsageError } from '../platform/errors.ts';
import type { Env, Files } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { setNote } from '../sessions/meta.ts';
import { describeError } from '../sessions/problems.ts';
import { sanitize } from '../text/sanitize.ts';
import type { Context } from './context.ts';

/** `$VISUAL`, else `$EDITOR`, else `vi`, split on spaces (D14). An empty value counts as not set. */
function editorCommand(env: Env): string[] {
  for (const name of ['VISUAL', 'EDITOR']) {
    const words = (env[name] ?? '').split(' ').filter((word) => word !== '');
    if (words.length > 0) {
      return words;
    }
  }
  return ['vi'];
}

/** The file the editor works on: `<stateDir>/note-<sessionId>.md`. */
function notePath(deck: Deck, sessionId: string): string {
  return join(deck.places.stateDir, `note-${sessionId}.md`);
}

/**
 * Removes the note file a failed edit of this session kept: the user has now set the note
 * another way (`note --set`), so that unsaved text is not wanted any more.
 */
export function discardKeptNote(deck: Deck, sessionId: string): void {
  discard(deck.platform.files, notePath(deck, sessionId));
}

/** Removes the temporary note file; failing to is not worth ending the command for. */
function discard(files: Files, path: string): void {
  try {
    files.remove(path);
  } catch {
    // a leftover file is replaced by the next edit of the same note
  }
}

/**
 * What an editor that failed left in the file `path`, which held `atStart` when the editor started
 * (`made`: the edit made the file, from the stored note). The file is removed when the edit made it
 * and the editor did not change it: nothing the user typed is in it. Anything else stays, because
 * its text was never stored (principle 6): a file kept from an earlier edit, and one the editor
 * changed or that cannot be read. Returns true when the editor changed the file, so that text the
 * user typed is in it and the error should name it.
 */
function afterFailedEditor(files: Files, path: string, atStart: string, made: boolean): boolean {
  let now: string | null;
  try {
    now = files.readText(path);
  } catch {
    return false; // cannot be read: kept, and nothing is known about what is in it
  }
  if (now === null) {
    return false;
  }
  if (now !== atStart) {
    return true;
  }
  if (made) {
    discard(files, path);
  }
  return false;
}

/**
 * Writes the note to `<stateDir>/note-<sessionId>.md` (readable by the user only), runs the editor
 * (D14) on it through `platform.runner.runInteractive`, stores what comes back and removes the
 * file. UsageError when stdin is not a terminal; SkydeckError when the editor cannot be run,
 * exits with a non-zero code (`editor exited <code>`) or removes the file: the note is unchanged,
 * and the file is removed when this edit made it and the editor left it as it was; when the editor
 * changed it before failing, the error names it (the text in it was never stored). When the editor
 * ended well but storing the text fails (the database is locked, the disk is full), the file is
 * KEPT: it holds what the user just typed, and the error names its path.
 *
 * A file that is there when an edit starts (kept like that, or left by a crash) is not overwritten:
 * the editor opens it, and one line on stderr says so. It is not this edit's own, so it is never
 * removed when the editor fails: only a successful save removes it (design 7.1, principle 6).
 */
export async function editNote(ctx: Context, deck: Deck, sessionId: string): Promise<void> {
  if (!ctx.io.isTTY.stdin) {
    throw new UsageError('note: stdin is not a terminal, so there is no editor; use --set <text>');
  }
  const { files } = ctx.platform;
  const [program, ...options] = editorCommand(ctx.platform.env);
  if (program === undefined) {
    throw new Error('editorCommand returned no program');
  }
  const path = notePath(deck, sessionId);
  const left = files.readText(path); // the text of an earlier edit, null when there is none
  const made = left === null;
  const atStart = left ?? deck.store.meta(sessionId)?.note ?? '';
  if (made) {
    files.writeText(path, atStart, 0o600);
  } else {
    // What an earlier edit left: its text was typed by the user and never stored (a failed save,
    // a crash). Overwriting it with the stored note would lose that text.
    ctx.io.stderr(
      `skydeck: an earlier edit of this note was not saved; continuing with its text in ${sanitize(path)}\n`,
    );
  }
  let text: string;
  try {
    text = await runEditor(ctx, program, [...options, path], path);
  } catch (error) {
    if (afterFailedEditor(files, path, atStart, made) && error instanceof SkydeckError) {
      const named = new SkydeckError(`${error.message}; your text is in ${path}`, error.exitCode);
      named.cause = error;
      throw named;
    }
    throw error;
  }
  try {
    setNote(deck, sessionId, text);
  } catch (error) {
    const failure = new SkydeckError(
      `the note was not saved (${describeError(error)}); your text is in ${path}`,
    );
    failure.cause = error; // SkydeckError takes no options; the original error stays
    throw failure;
  }
  discard(files, path);
}

/** Runs the editor on `path` and returns what it left there. */
async function runEditor(
  ctx: Context,
  program: string,
  args: string[],
  path: string,
): Promise<string> {
  let code: number | null;
  try {
    code = await ctx.platform.runner.runInteractive(program, args);
  } catch (error) {
    // A spawn error other than "not found" (a file that is not executable, a directory).
    throw new SkydeckError(`editor could not be run: ${program} (${describeError(error)})`);
  }
  if (code === null) {
    throw new SkydeckError(`editor did not finish: ${program} could not be run or was killed`);
  }
  if (code !== 0) {
    throw new SkydeckError(`editor exited ${code}`);
  }
  const text = ctx.platform.files.readText(path);
  if (text === null) {
    throw new SkydeckError('the editor removed the note file; the note is unchanged');
  }
  return text;
}
