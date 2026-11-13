// Editing a session's note in the user's editor (design 7.1). Shared by `skydeck note` and the
// interactive list.
import { join } from 'node:path';

import { SkydeckError, UsageError } from '../platform/errors.ts';
import type { Env } from '../platform/types.ts';
import { setNote } from '../sessions/meta.ts';
import type { Deck } from '../sessions/deck.ts';
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

/**
 * Writes the note to `<stateDir>/note-<sessionId>.md` (readable by the user only), runs the editor
 * (D14) on it through `platform.runner.runInteractive`, stores what comes back and removes the
 * file, whichever way the editor ended. UsageError when stdin is not a terminal; SkydeckError
 * "editor exited <code>" (the note unchanged) when the editor fails.
 */
export async function editNote(ctx: Context, deck: Deck, sessionId: string): Promise<void> {
  if (!ctx.io.isTTY.stdin) {
    throw new UsageError('note: stdin is not a terminal, so there is no editor; use --set <text>');
  }
  const { files, runner } = ctx.platform;
  const [program, ...options] = editorCommand(ctx.platform.env);
  if (program === undefined) {
    throw new Error('editorCommand returned no program');
  }
  const path = join(deck.places.stateDir, `note-${sessionId}.md`);
  files.writeText(path, deck.store.meta(sessionId)?.note ?? '', 0o600);
  try {
    const code = await runner.runInteractive(program, [...options, path]);
    if (code === null) {
      throw new SkydeckError(`editor did not finish: ${program} could not be run or was killed`);
    }
    if (code !== 0) {
      throw new SkydeckError(`editor exited ${code}`);
    }
    const text = files.readText(path);
    if (text === null) {
      throw new SkydeckError('the editor removed the note file; the note is unchanged');
    }
    setNote(deck, sessionId, text);
  } finally {
    files.remove(path);
  }
}
