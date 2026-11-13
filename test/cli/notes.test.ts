import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { editNote } from '../../src/cli/notes.ts';
import type { Context } from '../../src/cli/context.ts';
import { SkydeckError, UsageError } from '../../src/platform/errors.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { setNote } from '../../src/sessions/meta.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, fakeRunner } from '../helpers/platform.ts';
import type { RunCall } from '../helpers/platform.ts';

/** The file an editor was given: the last argument of its command line. */
const fileOf = (call: RunCall): string => {
  const path = call.args.at(-1);
  assert.ok(path !== undefined, 'the editor got a file');
  return path;
};

/**
 * A deck on a platform whose editor does `edit` to the file it is given (and records what the file
 * held when it started) and exits with `code`.
 */
function withEditor(
  t: Parameters<typeof testDeck>[0],
  options: {
    env?: Record<string, string | undefined>;
    stdinTTY?: boolean;
    edit?: (path: string) => void;
    code?: number | null;
  },
): {
  d: TestDeck;
  ctx: Context;
  deck: Deck;
  startedWith: string[];
  runner: ReturnType<typeof fakeRunner>;
} {
  const d = testDeck(t, { env: options.env ?? {}, stdinTTY: options.stdinTTY ?? true });
  const startedWith: string[] = [];
  const runner = fakeRunner(undefined, (call) => {
    const path = fileOf(call);
    startedWith.push(readFileSync(path, 'utf8'));
    options.edit?.(path);
    return options.code === undefined ? 0 : options.code;
  });
  const platform = { ...d.platform, runner };
  const ctx: Context = { io: d.ctx.io, platform };
  return { d, ctx, deck: { ...d.deck, platform }, startedWith, runner };
}

const noteOf = (d: TestDeck): string | null | undefined => d.deck.store.meta(S1)?.note;

describe('editNote', () => {
  test('stdin that is not a terminal is a usage error, and no editor is started', async (t) => {
    const { ctx, deck, runner } = withEditor(t, { stdinTTY: false });
    await assert.rejects(editNote(ctx, deck, S1), UsageError);
    assert.deepEqual(runner.interactiveCalls, []);
  });

  test('runs the editor on <stateDir>/note-<id>.md, stores what comes back and removes the file', async (t) => {
    const { d, ctx, deck, runner } = withEditor(t, {
      env: { EDITOR: 'fake-editor --wait' },
      edit: (path) => writeFileSync(path, 'edited\n'),
    });

    await editNote(ctx, deck, S1);

    const file = join(d.places.stateDir, `note-${S1}.md`);
    assert.equal(runner.interactiveCalls.length, 1);
    assert.equal(runner.interactiveCalls[0]?.command, 'fake-editor');
    assert.deepEqual(runner.interactiveCalls[0]?.args, ['--wait', file]);
    assert.equal(noteOf(d), 'edited\n');
    assert.equal(existsSync(file), false);
  });

  test('the editor is given the current note as the file content (empty when there is none)', async (t) => {
    const first = withEditor(t, { env: { EDITOR: 'ed' } });
    await editNote(first.ctx, first.deck, S1);
    assert.deepEqual(first.startedWith, ['']);

    const second = withEditor(t, { env: { EDITOR: 'ed' } });
    setNote(second.d.deck, S1, 'line one\nline two\n');
    await editNote(second.ctx, second.deck, S1);
    assert.deepEqual(second.startedWith, ['line one\nline two\n']);
    assert.equal(noteOf(second.d), 'line one\nline two\n', 'unchanged text stays as it was');
  });

  test('the note file is private to the user', async (t) => {
    let mode = 0;
    const { ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      edit: (path) => {
        mode = statSync(path).mode;
      },
    });
    await editNote(ctx, deck, S1);
    assert.equal(mode & 0o077, 0, `mode ${mode.toString(8)}`);
  });

  test('a note edited down to nothing is cleared', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      edit: (path) => writeFileSync(path, ' \n'),
    });
    setNote(d.deck, S1, 'old');
    await editNote(ctx, deck, S1);
    assert.equal(noteOf(d), null);
  });

  test('a non-zero exit is "editor exited <code>": the note is unchanged and the file is gone', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      code: 3,
      edit: (path) => writeFileSync(path, 'half done'),
    });
    setNote(d.deck, S1, 'old');

    await assert.rejects(
      editNote(ctx, deck, S1),
      (error: unknown) =>
        error instanceof SkydeckError &&
        !(error instanceof UsageError) &&
        error.exitCode === 1 &&
        error.message === 'editor exited 3',
    );

    assert.equal(noteOf(d), 'old');
    assert.equal(existsSync(join(d.places.stateDir, `note-${S1}.md`)), false);
  });

  test('an editor that could not be started, or was killed, is a failure too, and the note is unchanged', async (t) => {
    const { d, ctx, deck } = withEditor(t, { env: { EDITOR: 'ed' }, code: null });
    setNote(d.deck, S1, 'old');

    await assert.rejects(editNote(ctx, deck, S1), (error: unknown) => {
      return error instanceof SkydeckError && /^editor did not finish/.test(error.message);
    });

    assert.equal(noteOf(d), 'old');
    assert.equal(existsSync(join(d.places.stateDir, `note-${S1}.md`)), false);
  });

  test('VISUAL is used before EDITOR; neither set gives vi; empty values count as not set', async (t) => {
    const both = withEditor(t, { env: { VISUAL: 'visual-ed -x', EDITOR: 'editor' } });
    await editNote(both.ctx, both.deck, S1);
    assert.equal(both.runner.interactiveCalls[0]?.command, 'visual-ed');
    assert.deepEqual(both.runner.interactiveCalls[0]?.args.slice(0, -1), ['-x']);

    const neither = withEditor(t, { env: {} });
    await editNote(neither.ctx, neither.deck, S1);
    assert.equal(neither.runner.interactiveCalls[0]?.command, 'vi');
    assert.equal(neither.runner.interactiveCalls[0]?.args.length, 1);

    const empty = withEditor(t, { env: { VISUAL: '', EDITOR: '  nano  ' } });
    await editNote(empty.ctx, empty.deck, S1);
    assert.equal(empty.runner.interactiveCalls[0]?.command, 'nano');
    assert.equal(empty.runner.interactiveCalls[0]?.args.length, 1);
  });

  test('an editor that deletes the file leaves the note unchanged', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      edit: (path) => rmSync(path),
    });
    setNote(d.deck, S1, 'old');
    await assert.rejects(editNote(ctx, deck, S1), SkydeckError);
    assert.equal(noteOf(d), 'old');
  });
});
