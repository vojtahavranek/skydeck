import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { editNote } from '../../src/cli/notes.ts';
import type { Context } from '../../src/cli/context.ts';
import { SkydeckError, UsageError } from '../../src/platform/errors.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { setNote } from '../../src/sessions/meta.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
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
    /** The runner rejects, as `child_process` does for a spawn error other than ENOENT. */
    spawnError?: Error;
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
  if (options.spawnError !== undefined) {
    const error = options.spawnError;
    runner.runInteractive = () => Promise.reject(error);
  }
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

  test('a non-zero exit is "editor exited <code>": the note is unchanged and the file this edit made is gone', async (t) => {
    const { d, ctx, deck } = withEditor(t, { env: { EDITOR: 'ed' }, code: 3 });
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

  test('an editor that changed the file and then failed leaves the text in it: it was never stored', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      code: 3,
      edit: (path) => writeFileSync(path, 'ten minutes of careful typing'),
    });
    setNote(d.deck, S1, 'old');
    const file = join(d.places.stateDir, `note-${S1}.md`);

    await assert.rejects(
      editNote(ctx, deck, S1),
      (error: unknown) =>
        error instanceof SkydeckError &&
        error.exitCode === 1 &&
        error.message === `editor exited 3; your text is in ${file}`,
    );

    assert.equal(readFileSync(file, 'utf8'), 'ten minutes of careful typing');
    assert.equal(noteOf(d), 'old');
  });

  test('a file left by an earlier edit that the editor then changed and failed on is named too', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      code: 1,
      edit: (path) => writeFileSync(path, 'left behind, and more'),
    });
    const file = join(d.places.stateDir, `note-${S1}.md`);
    writeFileSync(file, 'left behind');

    await assert.rejects(
      editNote(ctx, deck, S1),
      (error: unknown) =>
        error instanceof SkydeckError &&
        error.message === `editor exited 1; your text is in ${file}`,
    );

    assert.equal(readFileSync(file, 'utf8'), 'left behind, and more');
  });

  test('an editor that could not be run names the file only when it holds text from before', async (t) => {
    const { d, ctx, deck } = withEditor(t, { env: { EDITOR: 'ed' }, code: null });
    const file = join(d.places.stateDir, `note-${S1}.md`);
    writeFileSync(file, 'left behind');

    await assert.rejects(
      editNote(ctx, deck, S1),
      (error: unknown) => error instanceof SkydeckError && !error.message.includes(file),
    );
    assert.equal(readFileSync(file, 'utf8'), 'left behind');
  });

  test('a note that was set elsewhere while the editor ran does not make an untouched file worth keeping', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      code: 1,
      edit: () => setNote(d.deck, S1, 'set meanwhile'),
    });
    setNote(d.deck, S1, 'old');

    await assert.rejects(editNote(ctx, deck, S1), /^SkydeckError: editor exited 1$/);

    assert.equal(existsSync(join(d.places.stateDir, `note-${S1}.md`)), false);
    assert.equal(noteOf(d), 'set meanwhile');
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

  test('when saving fails after the editor, the typed text stays in the note file and the error names it', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: 'ed' },
      edit: (path) => writeFileSync(path, 'ten minutes of careful typing'),
    });
    setNote(d.deck, S1, 'old');
    const locked = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    const failing = deckWith(deck, {
      store: {
        updateMeta: () => {
          throw locked;
        },
      },
    });
    const file = join(d.places.stateDir, `note-${S1}.md`);

    await assert.rejects(
      editNote(ctx, failing, S1),
      (error: unknown) =>
        error instanceof SkydeckError &&
        error.exitCode === 1 &&
        error.message ===
          `the note was not saved (Error: database is locked); your text is in ${file}` &&
        error.cause === locked,
    );

    assert.equal(readFileSync(file, 'utf8'), 'ten minutes of careful typing');
    assert.equal(noteOf(d), 'old');
  });

  test('after a failed save, the next edit opens the kept file, so the typed text is not lost', async (t) => {
    const first = withEditor(t, {
      env: { EDITOR: 'ed' },
      edit: (path) => writeFileSync(path, 'ten minutes of careful typing'),
    });
    const { d } = first;
    setNote(d.deck, S1, 'old');
    const file = join(d.places.stateDir, `note-${S1}.md`);
    const failing = deckWith(first.deck, {
      store: {
        updateMeta: () => {
          throw new Error('database is locked');
        },
      },
    });
    await assert.rejects(editNote(first.ctx, failing, S1), SkydeckError);

    // the retry, with a store that works: its editor must see what was typed, not the stored note
    const seen: string[] = [];
    const runner = fakeRunner(undefined, (call) => {
      seen.push(readFileSync(fileOf(call), 'utf8'));
      return 0;
    });
    const platform = { ...d.platform, runner };
    const ctx: Context = { io: d.ctx.io, platform };
    await editNote(ctx, { ...d.deck, platform }, S1);

    assert.deepEqual(seen, ['ten minutes of careful typing']);
    assert.equal(noteOf(d), 'ten minutes of careful typing');
    assert.equal(existsSync(file), false, 'removed once stored');
    assert.equal(
      d.stderr(),
      `skydeck: an earlier edit of this note was not saved; continuing with its text in ${file}\n`,
    );
  });

  test('a file left by an earlier edit is continued; an editor that fails does not delete it', async (t) => {
    const { d, ctx, deck, startedWith } = withEditor(t, { env: { EDITOR: 'ed' }, code: 1 });
    const file = join(d.places.stateDir, `note-${S1}.md`);
    writeFileSync(file, 'left behind');

    await assert.rejects(editNote(ctx, deck, S1), /^SkydeckError: editor exited 1$/);

    assert.deepEqual(startedWith, ['left behind']);
    assert.equal(readFileSync(file, 'utf8'), 'left behind');
    assert.equal(noteOf(d), undefined, 'the text was never stored');
    assert.match(d.stderr(), /^skydeck: an earlier edit of this note was not saved; continuing/);
  });

  for (const [why, options] of [
    ['could not be run or was killed', { code: null }],
    [
      'cannot be run at all',
      { spawnError: Object.assign(new Error('spawn ed EACCES'), { code: 'EACCES' }) },
    ],
  ] as const) {
    test(`a file left by an earlier edit stays when the editor ${why}`, async (t) => {
      const { d, ctx, deck } = withEditor(t, { env: { EDITOR: 'ed' }, ...options });
      const file = join(d.places.stateDir, `note-${S1}.md`);
      writeFileSync(file, 'left behind');

      await assert.rejects(editNote(ctx, deck, S1), SkydeckError);

      assert.equal(readFileSync(file, 'utf8'), 'left behind');
    });
  }

  test("a file left by an earlier edit that holds the stored text is not the edit's own: it stays", async (t) => {
    const { d, ctx, deck } = withEditor(t, { env: { EDITOR: 'ed' }, code: 1 });
    setNote(d.deck, S1, 'stored');
    const file = join(d.places.stateDir, `note-${S1}.md`);
    writeFileSync(file, 'stored');

    await assert.rejects(editNote(ctx, deck, S1), SkydeckError);

    assert.equal(readFileSync(file, 'utf8'), 'stored');
  });

  test('with no file left, nothing is said and the editor sees the stored note', async (t) => {
    const { d, ctx, deck, startedWith } = withEditor(t, { env: { EDITOR: 'ed' } });
    setNote(d.deck, S1, 'stored');
    await editNote(ctx, deck, S1);
    assert.deepEqual(startedWith, ['stored']);
    assert.equal(d.stderr(), '');
  });

  test('an editor that cannot be run (the runner rejects) is a failure that names it; the note is unchanged and the file is gone', async (t) => {
    const { d, ctx, deck } = withEditor(t, {
      env: { EDITOR: '/etc/not-executable --flag' },
      spawnError: Object.assign(new Error('spawn /etc/not-executable EACCES'), { code: 'EACCES' }),
    });
    setNote(d.deck, S1, 'old');

    await assert.rejects(
      editNote(ctx, deck, S1),
      (error: unknown) =>
        error instanceof SkydeckError &&
        !(error instanceof UsageError) &&
        error.exitCode === 1 &&
        error.message === 'editor could not be run: /etc/not-executable (EACCES)',
    );

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
