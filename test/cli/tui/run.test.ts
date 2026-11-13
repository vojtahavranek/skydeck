import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Context, Io } from '../../../src/cli/context.ts';
import { main } from '../../../src/cli/main.ts';
import { formatChip } from '../../../src/cli/row.ts';
import { initModel, visibleRows } from '../../../src/cli/tui/model.ts';
import type { Ns, RunResult } from '../../../src/platform/types.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { attachManualPr, markDone, setLabel } from '../../../src/sessions/meta.ts';
import { refresh } from '../../../src/sessions/refresh.ts';
import { handoffScript } from '../../../src/terminals/here.ts';
import { shellQuote } from '../../../src/text/shell.ts';
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { S1, S2, S3, SEC, T0, fakeRunner, runResult, statLine } from '../../helpers/platform.ts';
import type { FakeRunner, RunCall } from '../../helpers/platform.ts';
import {
  startRunning,
  userRecord,
  withRunner,
  writeTranscript,
} from '../../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';

/** The alternate screen, the cursor hidden, autowrap off (a row wider than the terminal is cut, not wrapped). */
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l';
/** Autowrap and the cursor back, the normal screen back. */
const LEAVE = '\x1b[?7h\x1b[?25h\x1b[?1049l';
const CLEAR = '\x1b[H\x1b[2J';
const PR1 = 'https://github.com/o/r/pull/1';
const PR2 = 'https://github.com/o/r/pull/2';
const MINUTE: Ns = 60n * SEC;

type Keys = readonly (string | (() => string))[];
type Options = NonNullable<Parameters<typeof testDeck>[1]>;

/** What `gh api graphql` prints for one open pull request, no review, checks passing. */
const OPEN_GREEN = JSON.stringify({
  data: {
    p0: {
      pullRequest: {
        title: 'Fix the retry',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
      },
    },
  },
});

/**
 * A deck on two terminals (stdin and stdout), started through the launcher (it has a handoff
 * file), that answers `keys`; S1 and S2 known from their transcripts, S1 the more recent one, so
 * that it is the first row.
 */
function listDeck(t: TestContext, keys: Keys, options: Options = {}): TestDeck {
  const d = testDeck(t, {
    stdinTTY: true,
    stdoutTTY: true,
    keys,
    env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }),
    ...options,
  });
  writeTranscript(d, S1, [userRecord(S1, T0 - 30n * SEC)]);
  writeTranscript(d, S2, [userRecord(S2, T0 - 60n * MINUTE)]);
  return d;
}

/** Gives S1 a project directory that exists (resume refuses one that does not); returns it. */
function resumable(d: TestDeck): string {
  const dir = join(d.sandbox.root, 'project');
  mkdirSync(dir, { recursive: true });
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: dir }]);
  return dir;
}

/** Every frame painted, as its lines. */
function frames(d: TestDeck): string[][] {
  return d
    .stdout()
    .split(CLEAR)
    .slice(1)
    .map((part) => (part.split('\x1b')[0] ?? '').split('\r\n'));
}

const short = (id: string): string => id.slice(0, 8);

/** The short id on the selected line of a frame. */
function selectedIn(frame: readonly string[]): string | undefined {
  const line = frame.find((candidate) => candidate.startsWith('> '));
  return [S1, S2, S3].map(short).find((id) => line?.includes(id) === true);
}

/** The short ids of the row lines of a frame, top to bottom. */
function rowOrder(frame: readonly string[]): string[] {
  return frame.flatMap((line) => [S1, S2, S3].map(short).filter((id) => line.includes(id)));
}

const lastLines = (d: TestDeck): string[] => frames(d).map((frame) => frame.at(-1) ?? '');

/**
 * The context of `d` with a keyboard that lets every pending promise and the next macrotask run
 * before each chunk: a background refresh that only waits for a fake `gh` is done before the next
 * key.
 */
function patient(ctx: Context): Context {
  const io: Io = {
    ...ctx.io,
    keys: async function* () {
      for await (const chunk of ctx.io.keys()) {
        await new Promise((resolve) => setImmediate(resolve));
        yield chunk;
      }
    },
  };
  return { ...ctx, io };
}

const ghCalls = (runner: FakeRunner): RunCall[] =>
  runner.calls.filter((call) => call.command === 'gh');

const gh = (answer: () => RunResult | Promise<RunResult>): FakeRunner => fakeRunner(answer);

test('q: the alternate screen is entered and left, and a frame shows both sessions', async (t) => {
  const d = listDeck(t, ['q']);

  assert.equal(await main([], d.ctx), 0);

  assert.ok(d.stdout().startsWith(ENTER), JSON.stringify(d.stdout().slice(0, 20)));
  assert.ok(d.stdout().endsWith(LEAVE), JSON.stringify(d.stdout().slice(-20)));
  assert.ok(
    frames(d).some(
      (frame) => frame.join('\n').includes(short(S1)) && frame.join('\n').includes(short(S2)),
    ),
  );
  assert.equal(frames(d)[0]?.length, 24, 'a frame fills the terminal');
  assert.equal(d.stderr(), '');
  assert.equal(d.openKeys(), 0, 'the terminal was given back');
  assert.equal(d.clock.timers(), 0, 'the background refresh was stopped');
});

test('the keys are taken before anything is painted, so that nothing typed early is echoed', async (t) => {
  const d = listDeck(t, ['q']);
  const writtenWhenTaken: string[] = [];
  const ctx: Context = {
    ...d.ctx,
    io: {
      ...d.ctx.io,
      keys: () => {
        writtenWhenTaken.push(d.stdout());
        return d.ctx.io.keys();
      },
    },
  };

  assert.equal(await main([], ctx), 0);

  assert.deepEqual(writtenWhenTaken, ['']);
});

test('the end of the keys quits like q, and ctrl-c quits too', async (t) => {
  const ended = listDeck(t, []);
  assert.equal(await main([], ended.ctx), 0);
  assert.ok(ended.stdout().endsWith(LEAVE));
  assert.equal(ended.openKeys(), 0);
  assert.equal(ended.clock.timers(), 0);

  const interrupted = listDeck(t, ['\x03', 'd']);
  assert.equal(await main([], interrupted.ctx), 0);
  assert.ok(interrupted.stdout().endsWith(LEAVE));
  assert.equal(interrupted.openKeys(), 0);
  assert.equal(interrupted.clock.timers(), 0);
  assert.equal(interrupted.deck.store.meta(S1)?.doneAtNs ?? null, null, 'nothing after ctrl-c');
});

test('d marks the selected session done, and the next frame no longer shows it', async (t) => {
  const d = listDeck(t, ['d', 'q']);

  assert.equal(await main([], d.ctx), 0);

  const first = frames(d)[0] ?? [];
  const afterD = (frames(d).at(-1) ?? []).join('\n');
  assert.equal(selectedIn(first), short(S1));
  assert.notEqual(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
  assert.ok(!afterD.includes(short(S1)), afterD);
  assert.ok(afterD.includes(short(S2)), afterD);
});

test('d on a done session shown with a undoes it', async (t) => {
  const d = listDeck(t, ['a', '/', 'alpha', '\r', 'd', 'q']);
  setLabel(d.deck, S1, 'alpha');
  markDone(d.deck, S1);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(d.deck.store.meta(S1)?.doneAtNs, null);
});

test('l, text, enter sets the label and the message says saved', async (t) => {
  const d = listDeck(t, ['l', 'a', 'b', '\r', 'q']);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(d.deck.store.meta(S1)?.label, 'ab');
  assert.ok(lastLines(d).includes('saved'), lastLines(d).join('\n'));
  assert.ok(frames(d).some((frame) => frame.join('\n').includes('ab')));
});

test('l on a label, deleted to nothing, clears it', async (t) => {
  const d = listDeck(t, ['l', '\x7f', '\x7f', '\x7f', '\r', 'q']);
  setLabel(d.deck, S1, 'ab');

  assert.equal(await main([], d.ctx), 0);

  assert.equal(d.deck.store.meta(S1)?.label, null);
  assert.ok(lastLines(d).includes('saved'));
});

test('a label the rules refuse leaves the label unchanged and shows why', async (t) => {
  const d = listDeck(t, ['l', '\x7f', '\x7f', '\x7f', '-', 'x', '\r', 'q']);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(d.deck.store.meta(S1)?.label ?? null, null);
  assert.ok(
    lastLines(d).some((line) => line.startsWith("a label cannot start with '-'")),
    lastLines(d).join('\n'),
  );
  assert.equal(d.stderr(), '');
});

test('g sets the group; an empty group clears it', async (t) => {
  const d = listDeck(t, ['g', 'G', '1', '\r', 'g', '\x7f', '\x7f', '\r', 'q']);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(d.deck.store.meta(S1)?.group, null);
  assert.ok(
    frames(d).some((frame) => frame.includes('G1')),
    'a frame shows the group G1',
  );
  assert.equal(lastLines(d).filter((line) => line === 'saved').length, 2);
});

test('p, a URL, enter attaches the pull request by hand', async (t) => {
  const d = listDeck(t, ['p', PR1, '\r', 'q']);

  assert.equal(await main([], d.ctx), 0);

  const links = d.deck.store.sessionPrs();
  assert.deepEqual(
    links.map(({ sessionId, url, origin, detachedAtNs }) => ({
      sessionId,
      url,
      origin,
      detachedAtNs,
    })),
    [{ sessionId: S1, url: PR1, origin: 'manual', detachedAtNs: null }],
  );
  assert.ok(lastLines(d).includes('saved'));
});

test('p fetches the pull request it attached at once, in the background, as pr add does', async (t) => {
  const runner = gh(() => runResult({ stdout: OPEN_GREEN }));
  const d = listDeck(t, ['p', PR1, '\r', 'q']);

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  assert.deepEqual(
    ghCalls(runner).map((call) => call.args.filter((arg) => /^n\d+=/.test(arg))),
    [['n0=1']],
  );
  assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.state, 'open');
  const chip = formatChip({ level: 'approved-green', count: 1 });
  assert.ok((frames(d).at(-1) ?? []).join('\n').includes(chip));
});

test('p with -URL detaches it; a URL that is not attached, or no URL at all, shows why', async (t) => {
  const d = listDeck(t, ['p', `-${PR1}`, '\r', 'p', `-${PR2}`, '\r', 'p', 'nope', '\r', 'q']);
  attachManualPr(d.deck, S1, PR1);

  assert.equal(await main([], d.ctx), 0);

  const link = d.deck.store.sessionPrs().find((row) => row.url === PR1);
  assert.notEqual(link?.detachedAtNs ?? null, null);
  const shown = lastLines(d);
  assert.ok(shown.includes('saved'), shown.join('\n'));
  assert.ok(shown.includes(`${PR2} is not attached to ${short(S1)}`), shown.join('\n'));
  assert.ok(shown.includes('not a GitHub pull-request URL: nope'), shown.join('\n'));
});

test('R on a session that is not running, terminal here: the handoff holds the resume and the list returns 0', async (t) => {
  const d = listDeck(t, ['R']);
  const dir = resumable(d);
  const handoff = join(d.sandbox.root, 'handoff');
  // What the terminal looked like when the handoff was written: claude takes it over from there.
  let atHandoff: { openKeys: number; left: boolean; timers: number } | undefined;
  const files = d.platform.files;
  const ctx: Context = {
    ...d.ctx,
    platform: {
      ...d.platform,
      files: {
        ...files,
        writeText: (path: string, text: string, mode?: number) => {
          if (path === handoff) {
            atHandoff = {
              openKeys: d.openKeys(),
              left: d.stdout().endsWith(LEAVE),
              timers: d.clock.timers(),
            };
          }
          files.writeText(path, text, mode);
        },
      },
    },
  };

  assert.equal(await main([], ctx), 0);

  assert.equal(
    readFileSync(handoff, 'utf8'),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', S1] }),
  );
  assert.deepEqual(atHandoff, { openKeys: 0, left: true, timers: 0 });
  assert.ok(d.stdout().endsWith(LEAVE), 'the screen was restored');
  assert.equal(
    d.stdout().indexOf(LEAVE),
    d.stdout().length - LEAVE.length,
    'left once, at the end',
  );
  assert.equal(d.stderr(), 'skydeck: original flags unknown; resuming with defaults\n');
});

test('R without the launcher (no handoff file): the list ends with exit 1 and says what to run', async (t) => {
  const d = listDeck(t, ['R', 'q'], { env: {} });
  resumable(d);

  assert.equal(await main([], d.ctx), 1);

  assert.ok(d.stdout().endsWith(LEAVE));
  assert.match(d.stderr(), /skydeck: not started through bin\/skydeck\n/);
  assert.match(d.stderr(), /skydeck: to start it yourself, run:\n/);
});

test('R on a running session shows that it is running and stays in the list', async (t) => {
  const d = listDeck(t, ['R', 'q']);
  startRunning(d, S1, 4242);

  assert.equal(await main([], d.ctx), 0);

  assert.ok(lastLines(d).includes(`${short(S1)} is running (pid 4242)`), lastLines(d).join('\n'));
  assert.ok(d.stdout().endsWith(LEAVE));
  assert.equal(d.stderr(), '');
});

test('R with a tab adapter opens a tab and stays in the list', async (t) => {
  const runner = fakeRunner(() => runResult({}));
  const d = listDeck(t, ['R', 'q'], { config: { terminal: 'wezterm' } });
  const dir = resumable(d);

  assert.equal(await main([], withRunner(d, runner)), 0);

  const spawned = runner.calls.filter((call) => call.command === 'wezterm');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]?.args.slice(-4), ['--', 'claude', '--resume', S1]);
  assert.ok(spawned[0]?.args.includes(dir));
  // What happened first, then the launch's warning.
  assert.ok(
    lastLines(d).includes(
      `opened ${short(S1)} in a new tab  original flags unknown; resuming with defaults`,
    ),
    lastLines(d).join('\n'),
  );
  assert.equal(d.stderr(), '');
});

test('R with a tab adapter and a known launch command says the tab was opened', async (t) => {
  const runner = fakeRunner(() => runResult({}));
  const d = listDeck(t, ['R', 'q'], { config: { terminal: 'wezterm' } });
  resumable(d);
  // A start event with a launch command, by a process that has ended.
  const spool = d.deck.places.spoolDir;
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid: 4242,
    pwd: join(d.sandbox.root, 'project'),
    argv: ['claude', '--model', 'opus'],
    input: hookInput('SessionStart', S1, { source: 'startup' }),
  };
  writeFileSync(join(spool, spoolName(fields, 1)), spoolText(fields));

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.ok(lastLines(d).includes(`opened ${short(S1)} in a new tab`), lastLines(d).join('\n'));
});

test('R with a tab that fails to open: the message says so first; the command is printed when the list ends', async (t) => {
  const runner = fakeRunner((call) =>
    call.command === 'wezterm' ? runResult({ code: 1, stderr: 'no window\n' }) : runResult({}),
  );
  const d = listDeck(t, ['R', 'j', 'q'], { config: { terminal: 'wezterm' } });
  const dir = resumable(d);
  let stderrWhileListed = '';
  const ctx = withRunner(d, runner);
  const io = ctx.io;
  ctx.io = {
    ...io,
    keys: () => {
      const keys = io.keys();
      return {
        next: async () => {
          stderrWhileListed = d.stderr();
          return keys.next();
        },
        return: async () => (await keys.return?.()) ?? { done: true, value: undefined },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };

  assert.equal(await main([], ctx), 0);

  const message = lastLines(d).find((line) => line.startsWith('opening')) ?? '';
  assert.ok(
    message.startsWith(
      `opening ${short(S1)} in a new tab failed; the details are printed when the list ends`,
    ),
    lastLines(d).join('\n'),
  );
  assert.ok(message.length <= 80, 'at 80 columns the outcome is what is seen');
  assert.equal(stderrWhileListed, '', 'nothing written under the list');
  assert.equal(
    d.stderr(),
    [
      'skydeck: original flags unknown; resuming with defaults',
      'skydeck: no window',
      'skydeck: to start it yourself, run:',
      `cd -- ${shellQuote(dir)} && ${['claude', '--resume', S1].map(shellQuote).join(' ')}`,
      '',
    ].join('\n'),
  );
  assert.ok(d.stdout().endsWith(LEAVE));
});

test('n runs the editor outside the alternate screen and stores the note', async (t) => {
  let shownWhileEditing = '';
  let keysWhileEditing = -1;
  let d: TestDeck | undefined;
  const runner = fakeRunner(undefined, (call) => {
    shownWhileEditing = d?.stdout() ?? '';
    keysWhileEditing = d?.openKeys() ?? -1;
    writeFileSync(call.args.at(-1) ?? '', 'x');
    return 0;
  });
  d = listDeck(t, ['n', 'q']);

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.equal(d.deck.store.meta(S1)?.note, 'x');
  assert.ok(shownWhileEditing.endsWith(LEAVE), 'the screen was left before the editor');
  assert.equal(keysWhileEditing, 0, 'the editor has the terminal to itself');
  assert.equal(d.openKeys(), 0);
  const after = d.stdout().slice(shownWhileEditing.length);
  assert.ok(after.startsWith(ENTER + CLEAR), JSON.stringify(after.slice(0, 30)));
  assert.equal(runner.interactiveCalls.length, 1);
});

test('a fetch that ends while the editor runs paints nothing over it; the list shows its result after', async (t) => {
  let answer: (result: RunResult) => void = () => {};
  const runner = gh(
    () =>
      new Promise<RunResult>((resolve) => {
        answer = resolve;
      }),
  );
  let d: TestDeck | undefined;
  runner.runInteractive = async (_command, args) => {
    answer(runResult({ stdout: OPEN_GREEN }));
    await new Promise((resolve) => setImmediate(resolve)); // the fetch is saved meanwhile
    writeFileSync(args.at(-1) ?? '', 'x');
    return 0;
  };
  d = listDeck(t, ['n', 'q']);
  attachManualPr(d.deck, S1, PR1);

  assert.equal(await main([], withRunner(d, runner)), 0);

  const out = d.stdout();
  const left = out.indexOf(LEAVE);
  const back = out.indexOf(ENTER, left);
  assert.ok(left > 0 && back > left, JSON.stringify(out.slice(left, left + 40)));
  assert.equal(out.slice(left, back).includes(CLEAR), false, 'nothing painted over the editor');
  assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.state, 'open');
  const chip = formatChip({ level: 'approved-green', count: 1 });
  assert.ok((frames(d).at(-1) ?? []).join('\n').includes(chip));
});

test('n: the outcome comes first in the message line, then the line editNote wrote', async (t) => {
  const runner = fakeRunner(undefined, () => 1);
  const d = listDeck(t, ['n', 'q']);
  writeFileSync(join(d.deck.places.stateDir, `note-${S1}.md`), 'kept');

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.equal(d.stderr(), '');
  const message = lastLines(d).find((line) => line.startsWith('editor exited 1'));
  assert.ok(message !== undefined, lastLines(d).join('\n'));
  assert.ok(message.startsWith('editor exited 1  an earlier edit of this note was not saved'));
  assert.ok(message.length <= 80);
  assert.equal(d.deck.store.meta(S1)?.note ?? null, null);
  // The editor failed, but the text in the file was never stored: the next edit continues with it.
  assert.equal(readFileSync(join(d.deck.places.stateDir, `note-${S1}.md`), 'utf8'), 'kept');
});

test('background refresh: a pull request never fetched gets its new level painted, the order kept', async (t) => {
  let d: TestDeck | undefined;
  const runner = gh(() => {
    if (d !== undefined) {
      // S2 starts running meanwhile: a reorder would put it first, the background does not reorder.
      startRunning(d, S2, 4343);
      refresh(d.deck);
    }
    return runResult({ stdout: OPEN_GREEN });
  });
  d = listDeck(t, ['q']);
  attachManualPr(d.deck, S1, PR1);

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  const all = frames(d);
  const first = all[0] ?? [];
  const last = all.at(-1) ?? [];
  assert.ok(all.length >= 2, String(all.length));
  assert.ok(first.join('\n').includes(formatChip({ level: 'unfetched', count: 1 })));
  assert.ok(last.join('\n').includes(formatChip({ level: 'approved-green', count: 1 })));
  assert.deepEqual(rowOrder(last), rowOrder(first));
  assert.deepEqual(rowOrder(first), [short(S1), short(S2)]);
  assert.equal(ghCalls(runner).length, 1);
  assert.equal(ghCalls(runner)[0]?.options?.env?.['GH_PROMPT_DISABLED'], '1');
});

test('a background refresh with nothing due runs no gh and paints nothing more', async (t) => {
  const runner = gh(() => runResult({ stdout: OPEN_GREEN }));
  const d = listDeck(t, ['q']);

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  assert.equal(ghCalls(runner).length, 0);
  assert.equal(frames(d).length, 1);
});

/** A `gh` that answers only when it is aborted (the fake runner then rejects, as the real one does). */
const hangingGh = (): FakeRunner => gh(() => new Promise<RunResult>(() => {}));

/** Lets every timer and pending promise run, so that anything written late would be written by now. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

test(
  'q while the background refresh waits for gh returns at once, and nothing is written afterwards',
  {
    timeout: 5000,
  },
  async (t) => {
    const runner = hangingGh();
    const d = listDeck(t, ['q']);
    attachManualPr(d.deck, S1, PR1);

    assert.equal(await main([], withRunner(d, runner)), 0);
    await settle();

    assert.equal(ghCalls(runner).length, 1);
    assert.ok(ghCalls(runner)[0]?.options?.signal?.aborted);
    const pr = d.deck.store.prs().find((row) => row.url === PR1);
    assert.deepEqual([pr?.triedAtNs, pr?.okAtNs, pr?.error], [null, null, null]);
    assert.equal(frames(d).length, 1);
    assert.ok(d.stdout().endsWith(LEAVE));
  },
);

test(
  'R in this terminal while the background refresh waits for gh hands off at once',
  {
    timeout: 5000,
  },
  async (t) => {
    const runner = hangingGh();
    const d = listDeck(t, ['R']);
    const dir = resumable(d);
    attachManualPr(d.deck, S1, PR1);

    assert.equal(await main([], withRunner(d, runner)), 0);
    await settle();

    assert.equal(
      readFileSync(join(d.sandbox.root, 'handoff'), 'utf8'),
      handoffScript({ cwd: dir, argv: ['claude', '--resume', S1] }),
    );
    assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.triedAtNs, null);
  },
);

test(
  'r fetches in the background: keys are read meanwhile, and q does not wait for gh',
  {
    timeout: 5000,
  },
  async (t) => {
    const runner = hangingGh();
    const d = listDeck(t, ['r', 'j', 'q']);
    attachManualPr(d.deck, S1, PR1);
    d.deck.store.savePrResult(PR1, {
      ok: true,
      atNs: T0 - MINUTE,
      title: 'Fix the retry',
      state: 'open',
      review: null,
      checks: 'passing',
    });

    assert.equal(await main([], withRunner(d, runner)), 0);
    await settle();

    assert.equal(ghCalls(runner).length, 1, 'r asked once');
    assert.ok(lastLines(d).includes('refreshing pull requests…'), lastLines(d).join('\n'));
    assert.equal(selectedIn(frames(d).at(-1) ?? []), short(S2), 'j was read while gh was running');
    assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.triedAtNs, T0 - MINUTE);
  },
);

test('r computes the order again: a session that started running moves up', async (t) => {
  let d: TestDeck | undefined;
  d = listDeck(t, [
    () => {
      if (d !== undefined) startRunning(d, S2, 4343);
      return 'r';
    },
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  assert.deepEqual(rowOrder(frames(d)[0] ?? []), [short(S1), short(S2)]);
  assert.deepEqual(rowOrder(frames(d).at(-1) ?? []), [short(S2), short(S1)]);
});

test('r ingests what is new, and asks about every pull request of the listed sessions again', async (t) => {
  let d: TestDeck | undefined;
  const runner = gh(() => runResult({ stdout: OPEN_GREEN }));
  d = listDeck(t, [
    () => {
      if (d !== undefined) startRunning(d, S3, 4545);
      return 'r';
    },
    'q',
  ]);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0 - MINUTE,
    title: 'Fix the retry',
    state: 'open',
    review: null,
    checks: 'passing',
  });
  // A pull request of a done session: not listed, so not asked about.
  attachManualPr(d.deck, S2, PR2);
  markDone(d.deck, S2);

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  const all = frames(d);
  assert.ok(!(all[0] ?? []).join('\n').includes(short(S3)));
  assert.ok((all.at(-1) ?? []).join('\n').includes(short(S3)), (all.at(-1) ?? []).join('\n'));
  // The background refresh asks about the one never tried (the done session's, PR2); r asks about
  // PR1, read a minute ago, because S1 is listed, and not about PR2, whose session is not.
  const asked = ghCalls(runner).map((call) => call.args.filter((arg) => /^n\d+=/.test(arg)));
  assert.deepEqual(asked, [['n0=2'], ['n0=1']]);
});

test(
  'r while the pull requests of an earlier r are being fetched starts no second fetch and says one runs',
  {
    timeout: 5000,
  },
  async (t) => {
    const runner = hangingGh();
    const d = listDeck(t, ['r', 'j', 'r', 'q']);
    attachManualPr(d.deck, S1, PR1);
    d.deck.store.savePrResult(PR1, {
      ok: true,
      atNs: T0 - MINUTE,
      title: 'Fix the retry',
      state: 'open',
      review: null,
      checks: 'passing',
    });

    assert.equal(await main([], withRunner(d, runner)), 0);

    assert.equal(ghCalls(runner).length, 1);
    assert.equal(lastLines(d).at(-1), 'refreshing pull requests…');
  },
);

test('r after the fetch of an earlier r has finished fetches again, and the message goes away', async (t) => {
  const runner = gh(() => runResult({ stdout: OPEN_GREEN }));
  const d = listDeck(t, ['r', 'r', 'q']);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0 - MINUTE,
    title: 'Fix the retry',
    state: 'open',
    review: null,
    checks: 'passing',
  });

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  assert.equal(ghCalls(runner).length, 2);
  assert.notEqual(lastLines(d).at(-1), 'refreshing pull requests…', lastLines(d).join('\n'));
});

test(
  'r while the fetch of an earlier r runs still reads what is new and computes the order again',
  {
    timeout: 5000,
  },
  async (t) => {
    const runner = hangingGh();
    let d: TestDeck | undefined;
    d = listDeck(t, [
      'r',
      () => {
        if (d !== undefined) startRunning(d, S2, 4343);
        return 'r';
      },
      'q',
    ]);
    attachManualPr(d.deck, S1, PR1);
    d.deck.store.savePrResult(PR1, {
      ok: true,
      atNs: T0 - MINUTE,
      title: 'Fix the retry',
      state: 'open',
      review: null,
      checks: 'passing',
    });

    assert.equal(await main([], withRunner(d, runner)), 0);

    assert.equal(ghCalls(runner).length, 1);
    assert.deepEqual(rowOrder(frames(d).at(-1) ?? []), [short(S2), short(S1)]);
  },
);

test(
  'q while the fetch that p started waits for gh returns at once, and nothing is saved',
  {
    timeout: 5000,
  },
  async (t) => {
    const runner = hangingGh();
    const d = listDeck(t, ['p', PR1, '\r', 'q']);

    assert.equal(await main([], withRunner(d, runner)), 0);
    await settle();

    assert.equal(ghCalls(runner).length, 1);
    assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.triedAtNs, null);
  },
);

test('a background fetch that fails says so in the message line', async (t) => {
  // The clock fails once, right after gh answered: saving the answer throws.
  let breakClock = false;
  const runner = gh(() => {
    breakClock = true;
    return runResult({ stdout: OPEN_GREEN });
  });
  const d = listDeck(t, ['q']);
  attachManualPr(d.deck, S1, PR1);
  const ctx = withRunner(d, runner);
  const clock = ctx.platform.clock;
  ctx.platform = {
    ...ctx.platform,
    clock: {
      ...clock,
      nowNs: () => {
        if (breakClock) {
          breakClock = false;
          throw new Error('clock broke');
        }
        return clock.nowNs();
      },
    },
  };

  assert.equal(await main([], patient(ctx)), 0);

  assert.ok(
    lastLines(d).includes('the pull requests could not be refreshed: Error: clock broke'),
    lastLines(d).join('\n'),
  );
});

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
  test(
    `${signal} gives the terminal back before the process ends`,
    { timeout: 5000 },
    async (t) => {
      let atSignal:
        { leftLast: boolean; openKeys: number; aborted: boolean; timers: number } | undefined;
      let timersBefore = -1;
      const runner = hangingGh();
      let d: TestDeck | undefined;
      d = listDeck(t, [
        () => {
          const deck = d as TestDeck;
          timersBefore = deck.clock.timers();
          deck.terminate(signal);
          atSignal = {
            leftLast: deck.stdout().endsWith(LEAVE),
            openKeys: deck.openKeys(),
            aborted: ghCalls(runner)[0]?.options?.signal?.aborted === true,
            timers: deck.clock.timers(),
          };
          return 'j';
        },
      ]);
      attachManualPr(d.deck, S1, PR1);

      assert.equal(await main([], withRunner(d, runner)), 0);
      const written = d.stdout();
      d.terminate(signal);

      assert.equal(timersBefore, 1, 'the background refresh ran until then');
      assert.deepEqual(atSignal, { leftLast: true, openKeys: 0, aborted: true, timers: 0 });
      assert.equal(written.split(LEAVE).length, 2, 'left once');
      assert.equal(d.stdout(), written, 'the list no longer listens');
    },
  );
}

test('after every key the window scrolls by the least that keeps the selected row in view', async (t) => {
  const d = listDeck(t, ['j', 'j', 'k', 'q'], { size: { columns: 80, rows: 4 } });
  writeTranscript(d, S3, [userRecord(S3, T0 - 120n * MINUTE)]);

  assert.equal(await main([], d.ctx), 0);

  const order = visibleRows(initModel(loadRows(d.deck), T0)).map((row) => row.shortId);
  assert.deepEqual(order, [short(S1), short(S2), short(S3)]);
  // Four lines: title, two body lines, the last line. After j j the window shows S2 and S3; k
  // moves the cursor up to S2 and the window stays where it is.
  const afterK = frames(d).at(-1) ?? [];
  assert.equal(afterK.length, 4);
  assert.ok(afterK[1]?.startsWith('> ') && afterK[1].includes(short(S2)), afterK.join('\n'));
  assert.ok(afterK[2]?.includes(short(S3)), afterK.join('\n'));
});

test('a resize is painted at once, at the new size; after the list it paints nothing', async (t) => {
  let framesBefore = -1;
  let framesAfter = -1;
  let d: TestDeck | undefined;
  d = listDeck(t, [
    () => {
      framesBefore = frames(d as TestDeck).length;
      d?.resize({ columns: 60, rows: 10 });
      framesAfter = frames(d as TestDeck).length;
      return 'q';
    },
  ]);

  assert.equal(await main([], d.ctx), 0);
  const written = d.stdout();
  d.resize({ columns: 40, rows: 5 });

  assert.equal(framesAfter, framesBefore + 1);
  const resized = frames(d)[framesBefore] ?? [];
  assert.equal(resized.length, 10);
  assert.ok(resized.every((line) => line.length <= 60));
  assert.equal(d.stdout(), written, 'the list no longer listens');
});

test('an error inside the list restores the terminal and is reported by the error mapping', async (t) => {
  let broken = false;
  const d = listDeck(t, [
    () => {
      broken = true;
      return 'j';
    },
    'q',
  ]);
  const ctx: Context = {
    ...d.ctx,
    io: {
      ...d.ctx.io,
      size: () => {
        if (broken) throw new Error('boom');
        return { columns: 80, rows: 24 };
      },
    },
  };

  assert.equal(await main([], ctx), 1);

  assert.ok(d.stdout().startsWith(ENTER));
  assert.ok(d.stdout().endsWith(LEAVE));
  assert.equal(d.openKeys(), 0);
  assert.equal(d.clock.timers(), 0);
  assert.equal(d.stderr(), 'skydeck: internal error: boom\n');
});

// --- the background refresh (design 7.3, 7.4) ------------------------------------------------------

/** The list's refresh period: every 5 s while it is on screen. */
const PERIOD_MS = 5000;

/** The line of a frame that shows `id`. */
const lineOf = (frame: readonly string[], id: string): string =>
  frame.find((line) => line.includes(short(id))) ?? '';

/** Frames whose message line (the last one) is `message`. */
const framesSaying = (d: TestDeck, message: string): number =>
  lastLines(d).filter((line) => line === message).length;

/** The spool files still waiting to be ingested. */
const spooled = (d: TestDeck): string[] =>
  readdirSync(d.deck.places.spoolDir).filter((name) => name.endsWith('.ev'));

test('every 5 s the list refreshes by itself: new states and sessions show, the order and the selected session stay', async (t) => {
  let d: TestDeck | undefined;
  let framesBefore = -1;
  let framesAt4999 = -1;
  d = listDeck(t, [
    'j',
    () => {
      const deck = d as TestDeck;
      startRunning(deck, S2, 4343); // S2 starts working: a reorder would put it first
      writeTranscript(deck, S3, [userRecord(S3, T0 - 5n * SEC)]); // new, and the most recent
      framesBefore = frames(deck).length;
      deck.clock.advanceMs(PERIOD_MS - 1);
      framesAt4999 = frames(deck).length;
      deck.clock.advanceMs(1);
      return '';
    },
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(framesAt4999, framesBefore, 'nothing before 5 s');
  assert.equal(frames(d).length, framesBefore + 1, 'one frame, painted by the refresh');
  const refreshed = frames(d).at(-1) ?? [];
  assert.deepEqual(rowOrder(refreshed), [short(S1), short(S2), short(S3)]);
  assert.equal(selectedIn(refreshed), short(S2), 'the cursor stays on its session');
  assert.ok(lineOf(refreshed, S2).includes('working'), refreshed.join('\n'));
  assert.equal(refreshed[0], 'skydeck  3 sessions  1 working · 2 not-running', 'the counts too');
  assert.deepEqual(spooled(d), []);
  assert.equal(d.stderr(), '');
});

test('a background refresh that changes nothing that is shown paints nothing', async (t) => {
  let d: TestDeck | undefined;
  const counts: number[] = [];
  const count = (): void => {
    counts.push(frames(d as TestDeck).length);
  };
  d = listDeck(t, [
    () => {
      count();
      // A spool file that cannot be parsed: the refresh moves it to spool/bad, the list shows nothing of it.
      writeFileSync(join((d as TestDeck).deck.places.spoolDir, '1-0-1.ev'), 'garbage\n');
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      count();
      return '';
    },
    () => {
      startRunning(d as TestDeck, S2, 4343);
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      count();
      return '';
    },
    'q',
  ]);
  // Ages in hours, which 5 s do not change.
  writeTranscript(d, S1, [userRecord(S1, T0 - 120n * MINUTE)]);
  writeTranscript(d, S2, [userRecord(S2, T0 - 180n * MINUTE)]);

  assert.equal(await main([], d.ctx), 0);

  const [first = -1, second = -1, third = -1] = counts;
  assert.equal(second, first, 'the first refresh changed nothing that is shown');
  assert.equal(third, first + 1, 'the second one did');
  assert.deepEqual(readdirSync(join(d.deck.places.spoolDir, 'bad')), ['1-0-1.ev']);
});

test('no background refresh while an input is open: what is typed stays, the refresh comes after', async (t) => {
  let d: TestDeck | undefined;
  let framesBefore = -1;
  let framesAfter = -1;
  let spoolWhileTyping: string[] = [];
  d = listDeck(t, [
    'l',
    'a',
    () => {
      const deck = d as TestDeck;
      startRunning(deck, S2, 4343);
      framesBefore = frames(deck).length;
      deck.clock.advanceMs(PERIOD_MS);
      framesAfter = frames(deck).length;
      spoolWhileTyping = spooled(deck);
      return 'b';
    },
    '\r',
    () => {
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      return '';
    },
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(framesAfter, framesBefore, 'nothing painted while the input is open');
  assert.equal(spoolWhileTyping.length, 1, 'nothing read in while the input is open');
  assert.equal(d.deck.store.meta(S1)?.label, 'ab');
  assert.ok(lineOf(frames(d).at(-1) ?? [], S2).includes('working'));
});

test('no background refresh while the editor runs; the list refreshes after it', async (t) => {
  let d: TestDeck | undefined;
  let spoolWhileEditing: string[] = [];
  const runner = fakeRunner(undefined, (call) => {
    const deck = d as TestDeck;
    startRunning(deck, S2, 4343);
    deck.clock.advanceMs(PERIOD_MS);
    spoolWhileEditing = spooled(deck);
    writeFileSync(call.args.at(-1) ?? '', 'x');
    return 0;
  });
  d = listDeck(t, [
    'n',
    () => {
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      return '';
    },
    'q',
  ]);

  assert.equal(await main([], withRunner(d, runner)), 0);

  const out = d.stdout();
  const left = out.indexOf(LEAVE);
  const back = out.indexOf(ENTER, left);
  assert.equal(out.slice(left, back).includes(CLEAR), false, 'nothing painted over the editor');
  assert.equal(spoolWhileEditing.length, 1, 'nothing read in while the editor runs');
  assert.ok(lineOf(frames(d).at(-1) ?? [], S2).includes('working'));
});

test('no background refresh while a tab is being opened', async (t) => {
  let d: TestDeck | undefined;
  let framesBefore = -1;
  let framesAfter = -1;
  const runner = fakeRunner((call) => {
    if (call.command === 'wezterm') {
      const deck = d as TestDeck;
      writeTranscript(deck, S3, [userRecord(S3, T0 - 5n * SEC)]);
      framesBefore = frames(deck).length;
      deck.clock.advanceMs(PERIOD_MS);
      framesAfter = frames(deck).length;
    }
    return runResult({});
  });
  d = listDeck(t, ['R', 'q'], { config: { terminal: 'wezterm' } });
  resumable(d);

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.ok(framesBefore > 0);
  assert.equal(framesAfter, framesBefore, 'nothing painted while the tab opens');
  assert.ok(!(frames(d).at(-1) ?? []).join('\n').includes(short(S3)), 'and nothing read in');
});

test('a background refresh fetches the pull requests that are due, and starts no fetch while one runs', async (t) => {
  let answer: (result: RunResult) => void = () => {};
  const runner = gh(
    () =>
      new Promise<RunResult>((resolve) => {
        answer = resolve;
      }),
  );
  let d: TestDeck | undefined;
  const calls: number[] = [];
  const tick = (before?: () => void) => (): string => {
    before?.();
    (d as TestDeck).clock.advanceMs(PERIOD_MS);
    calls.push(ghCalls(runner).length);
    return '';
  };
  d = listDeck(t, [
    '',
    tick(), // read a minute ago: not due
    tick(() => {
      (d as TestDeck).clock.setNs(T0 + 5n * MINUTE); // its last attempt is more than 5 minutes old
    }),
    tick(), // the fetch still runs: no second one
    () => {
      answer(runResult({ stdout: OPEN_GREEN }));
      return '';
    },
    'q',
  ]);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0 - MINUTE,
    title: 'Fix the retry',
    state: 'draft',
    review: null,
    checks: 'passing',
  });

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  assert.deepEqual(calls, [0, 1, 1]);
  assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.state, 'open');
  const chip = formatChip({ level: 'approved-green', count: 1 });
  assert.ok((frames(d).at(-1) ?? []).join('\n').includes(chip));
});

test(
  'a background refresh starts no fetch while the fetch of r runs',
  { timeout: 5000 },
  async (t) => {
    const runner = hangingGh();
    let d: TestDeck | undefined;
    d = listDeck(t, [
      'r',
      () => {
        const deck = d as TestDeck;
        deck.clock.setNs(T0 + 10n * MINUTE); // due for an automatic refresh too
        deck.clock.advanceMs(PERIOD_MS);
        return '';
      },
      'q',
    ]);
    attachManualPr(d.deck, S1, PR1);
    d.deck.store.savePrResult(PR1, {
      ok: true,
      atNs: T0 - MINUTE,
      title: 'Fix the retry',
      state: 'open',
      review: null,
      checks: 'passing',
    });

    assert.equal(await main([], patient(withRunner(d, runner))), 0);

    assert.equal(ghCalls(runner).length, 1, 'only the fetch of r');
  },
);

test(
  'q while the fetch of a background refresh waits for gh returns at once, and nothing is saved',
  { timeout: 5000 },
  async (t) => {
    const runner = hangingGh();
    let d: TestDeck | undefined;
    d = listDeck(t, [
      '',
      () => {
        const deck = d as TestDeck;
        deck.clock.setNs(T0 + 10n * MINUTE);
        deck.clock.advanceMs(PERIOD_MS);
        return '';
      },
      'q',
    ]);
    attachManualPr(d.deck, S1, PR1);
    d.deck.store.savePrResult(PR1, {
      ok: true,
      atNs: T0 - MINUTE,
      title: 'Fix the retry',
      state: 'open',
      review: null,
      checks: 'passing',
    });

    assert.equal(await main([], patient(withRunner(d, runner))), 0);
    const written = d.stdout();
    await settle();
    d.clock.advanceMs(10 * PERIOD_MS);

    assert.equal(ghCalls(runner).length, 1);
    assert.ok(ghCalls(runner)[0]?.options?.signal?.aborted);
    assert.equal(d.deck.store.prs().find((row) => row.url === PR1)?.triedAtNs, T0 - MINUTE);
    assert.equal(d.stdout(), written, 'nothing painted after the list ended');
    assert.equal(d.clock.timers(), 0);
  },
);

test('a background refresh that fails says so once, and the list goes on', async (t) => {
  const BUSY = 'the list could not be refreshed: Error: database is locked';
  let broken = false;
  let d: TestDeck | undefined;
  const tick = (before: () => void) => (): string => {
    before();
    (d as TestDeck).clock.advanceMs(PERIOD_MS);
    return '';
  };
  d = listDeck(t, [
    tick(() => {
      broken = true; // fails: the message
    }),
    'j', // a key takes the message away
    tick(() => {}), // the same failure: not said again
    tick(() => {
      broken = false; // works again, and shows what changed meanwhile
      startRunning(d as TestDeck, S2, 4343);
    }),
    tick(() => {
      broken = true; // a failure after one that worked is said again
    }),
    'q',
  ]);
  const bootId = d.proc.bootId;
  d.proc.bootId = () => {
    if (broken) {
      throw new Error('database is locked');
    }
    return bootId();
  };

  assert.equal(await main([], d.ctx), 0);

  assert.equal(framesSaying(d, BUSY), 2, lastLines(d).join('\n'));
  const shown = lastLines(d);
  assert.equal(shown.indexOf(BUSY), 1, 'said by the first refresh');
  assert.equal(shown.at(-1), BUSY, 'and by the last');
  assert.ok(frames(d).some((frame) => lineOf(frame, S2).includes('working')));
  assert.equal(d.stderr(), '');
});

test('an automatic fetch that fails again and again says so once', async (t) => {
  const FAILED = 'the pull requests could not be refreshed: Error: clock broke';
  // The clock fails right after every gh answer: saving it throws, and the pull request stays due.
  let breakClock = false;
  const runner = gh(() => {
    breakClock = true;
    return runResult({ stdout: OPEN_GREEN });
  });
  let d: TestDeck | undefined;
  d = listDeck(t, [
    '', // the fetch of the opening fails: the message
    'j', // a key takes it away
    () => {
      (d as TestDeck).clock.advanceMs(PERIOD_MS); // the same failure: not said again
      return '';
    },
    'q',
  ]);
  attachManualPr(d.deck, S1, PR1);
  const ctx = withRunner(d, runner);
  const clock = ctx.platform.clock;
  ctx.platform = {
    ...ctx.platform,
    clock: {
      ...clock,
      nowNs: () => {
        if (breakClock) {
          breakClock = false;
          throw new Error('clock broke');
        }
        return clock.nowNs();
      },
    },
  };

  assert.equal(await main([], patient(ctx)), 0);

  assert.equal(ghCalls(runner).length, 2, 'asked when the list opened and again 5 s later');
  assert.equal(framesSaying(d, FAILED), 1, lastLines(d).join('\n'));
});

test('when the selected session leaves the list at a background refresh, the cursor takes the next row and the message says so', async (t) => {
  let d: TestDeck | undefined;
  d = listDeck(t, [
    'j',
    () => {
      markDone((d as TestDeck).deck, S2); // done in another skydeck
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      return '';
    },
    'd', // acts on the row the cursor went to: S3, never the first row
    'q',
  ]);
  writeTranscript(d, S3, [userRecord(S3, T0 - 120n * MINUTE)]);
  setLabel(d.deck, S2, 'beta');

  assert.equal(await main([], d.ctx), 0);

  const refreshed = frames(d).find((frame) => frame.at(-1) === 'session "beta" left the list');
  assert.ok(refreshed !== undefined, lastLines(d).join('\n'));
  assert.equal(selectedIn(refreshed), short(S3));
  assert.notEqual(d.deck.store.meta(S3)?.doneAtNs ?? null, null);
  assert.equal(d.deck.store.meta(S1)?.doneAtNs ?? null, null);
  assert.equal(framesSaying(d, 'session "beta" left the list'), 1, 'said once');
});

test('r: when the selected session left the list, the cursor takes the row after it and the message says so first', async (t) => {
  let answer: (result: RunResult) => void = () => {};
  const runner = gh(
    () =>
      new Promise<RunResult>((resolve) => {
        answer = resolve;
      }),
  );
  let d: TestDeck | undefined;
  d = listDeck(t, [
    'j',
    () => {
      const deck = d as TestDeck;
      markDone(deck.deck, S2);
      startRunning(deck, S3, 4545); // S3 moves to the top when the order is computed again
      return 'r';
    },
    () => {
      answer(runResult({ stdout: OPEN_GREEN })); // the fetch of r ends
      return '';
    },
    'q',
  ]);
  writeTranscript(d, S3, [userRecord(S3, T0 - 120n * MINUTE)]);
  attachManualPr(d.deck, S1, PR1); // read a minute ago: only r asks about it
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0 - MINUTE,
    title: 'Fix the retry',
    state: 'open',
    review: null,
    checks: 'passing',
  });

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  const LEFT = `session ${short(S2)} left the list`;
  const afterR = frames(d).find((frame) => frame.at(-1)?.startsWith(LEFT) === true);
  assert.ok(afterR !== undefined, lastLines(d).join('\n'));
  assert.equal(afterR.at(-1), `${LEFT}  refreshing pull requests…`);
  assert.deepEqual(rowOrder(afterR.slice(0, -1)), [short(S3), short(S1)]);
  assert.equal(selectedIn(afterR), short(S3), 'the row after S2 in the order shown before');
  assert.equal(lastLines(d).at(-1), LEFT, 'once the fetch has ended, the notice stays');
});

test('a background failure message goes away when that work succeeds again', async (t) => {
  const BUSY = 'the list could not be refreshed: Error: database is locked';
  let broken = false;
  let d: TestDeck | undefined;
  d = listDeck(t, [
    () => {
      broken = true;
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      return '';
    },
    () => {
      broken = false;
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      return '';
    },
    'q',
  ]);
  const bootId = d.proc.bootId;
  d.proc.bootId = () => {
    if (broken) {
      throw new Error('database is locked');
    }
    return bootId();
  };

  assert.equal(await main([], d.ctx), 0);

  assert.equal(framesSaying(d, BUSY), 1, lastLines(d).join('\n'));
  assert.notEqual(lastLines(d).at(-1), BUSY);
});

test('a background refresh that fails starts no fetch', async (t) => {
  let broken = false;
  let d: TestDeck | undefined;
  const runner = gh(() => runResult({ stdout: OPEN_GREEN }));
  d = listDeck(t, [
    '',
    () => {
      broken = true;
      (d as TestDeck).clock.setNs(T0 + 10n * MINUTE); // the pull request is due
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      return '';
    },
    'q',
  ]);
  attachManualPr(d.deck, S1, PR1);
  d.deck.store.savePrResult(PR1, {
    ok: true,
    atNs: T0 - MINUTE,
    title: 'Fix the retry',
    state: 'open',
    review: null,
    checks: 'passing',
  });
  const bootId = d.proc.bootId;
  d.proc.bootId = () => {
    if (broken) {
      throw new Error('database is locked');
    }
    return bootId();
  };

  assert.equal(await main([], patient(withRunner(d, runner))), 0);

  assert.equal(ghCalls(runner).length, 0);
});

test('a background refresh while the filter is being typed shows what changed and keeps the filter open', async (t) => {
  let d: TestDeck | undefined;
  let afterTick: string[] = [];
  d = listDeck(t, [
    '/',
    'd',
    'e',
    () => {
      const deck = d as TestDeck;
      startRunning(deck, S2, 4343);
      deck.clock.advanceMs(PERIOD_MS);
      afterTick = frames(deck).at(-1) ?? [];
      return 'm';
    },
    'o',
    '\r',
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  assert.equal(afterTick.at(-1), '/de_', afterTick.join('\n'));
  assert.ok(lineOf(afterTick, S2).includes('working'), afterTick.join('\n'));
  assert.ok(frames(d).at(-1)?.[0]?.includes('filter: demo'), (frames(d).at(-1) ?? []).join('\n'));
});

test('a background refresh while the detail is open shows the session as it is now', async (t) => {
  let d: TestDeck | undefined;
  let afterTick: string[] = [];
  d = listDeck(t, [
    'j',
    '\r',
    () => {
      const deck = d as TestDeck;
      startRunning(deck, S2, 4343);
      deck.clock.advanceMs(PERIOD_MS);
      afterTick = frames(deck).at(-1) ?? [];
      return '\x1b';
    },
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  assert.ok(afterTick.includes(`id: ${S2}`), afterTick.join('\n'));
  assert.ok(
    afterTick.some((line) => line.startsWith('state: working')),
    afterTick.join('\n'),
  );
});

/** The context of `d` with every read of Claude Code's settings file counted: one per loading of the rows. */
function countingLoads(d: TestDeck, ctx: Context = d.ctx): { ctx: Context; loads: () => number } {
  const settings = join(d.deck.places.claudeHome, 'settings.json');
  const files = ctx.platform.files;
  let loads = 0;
  return {
    ctx: {
      ...ctx,
      platform: {
        ...ctx.platform,
        files: {
          ...files,
          readText: (path: string) => {
            if (path === settings) {
              loads++;
            }
            return files.readText(path);
          },
        },
      },
    },
    loads: () => loads,
  };
}

test('a background refresh that finds nothing new loads no rows; the times shown still move on', async (t) => {
  let d: TestDeck | undefined;
  let counting: ReturnType<typeof countingLoads> | undefined;
  const loadsAt: number[] = [];
  d = listDeck(t, [
    () => {
      loadsAt.push((counting as ReturnType<typeof countingLoads>).loads());
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      loadsAt.push((counting as ReturnType<typeof countingLoads>).loads());
      return '';
    },
    'q',
  ]);
  counting = countingLoads(d);

  assert.equal(await main([], counting.ctx), 0);

  const [before = -1, after = -1] = loadsAt;
  assert.ok(before >= 1, 'the rows were loaded when the list opened');
  assert.equal(after, before, 'not again by the refresh');
  assert.ok(lineOf(frames(d)[0] ?? [], S1).includes(' 30s '), (frames(d)[0] ?? []).join('\n'));
  assert.ok(
    lineOf(frames(d).at(-1) ?? [], S1).includes(' 35s '),
    (frames(d).at(-1) ?? []).join('\n'),
  );
});

test('what another skydeck saved, a live file that changed, and a process that ended show at the next refresh', async (t) => {
  let d: TestDeck | undefined;
  const shown: string[] = [];
  const tick = (change: () => void) => (): string => {
    change();
    const deck = d as TestDeck;
    deck.clock.advanceMs(PERIOD_MS);
    shown.push(lineOf(frames(deck).at(-1) ?? [], S2));
    return '';
  };
  const liveFile = (deck: TestDeck): string =>
    join(deck.deck.places.claudeHome, 'sessions', '4343.json');
  d = listDeck(t, [
    tick(() => {
      startRunning(d as TestDeck, S2, 4343); // working
    }),
    tick(() => {
      setLabel((d as TestDeck).deck, S2, 'beta'); // another connection, as another skydeck
    }),
    tick(() => {
      const path = liveFile(d as TestDeck);
      const live = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...live, status: 'waiting' }));
    }),
    tick(() => {
      (d as TestDeck).proc.setProcess(4343, null); // ended without removing its file
    }),
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  const [working = '', labelled = '', waiting = '', ended = ''] = shown;
  assert.ok(working.includes('working'), working);
  assert.ok(labelled.includes('beta'), labelled);
  assert.ok(waiting.includes('waiting'), waiting);
  assert.ok(ended.includes('not-running'), ended);
});

test('the rows are loaded again at least once a minute, whatever the refresh found', async (t) => {
  let d: TestDeck | undefined;
  let counting: ReturnType<typeof countingLoads> | undefined;
  const loadsAt: number[] = [];
  const count = (): void => {
    loadsAt.push((counting as ReturnType<typeof countingLoads>).loads());
  };
  d = listDeck(t, [
    () => {
      count();
      (d as TestDeck).clock.advanceMs(55_000);
      count();
      (d as TestDeck).clock.advanceMs(PERIOD_MS);
      count();
      return '';
    },
    'q',
  ]);
  counting = countingLoads(d);

  assert.equal(await main([], counting.ctx), 0);

  const [opened = -1, at55 = -1, at60 = -1] = loadsAt;
  assert.equal(at55, opened, 'eleven refreshes with nothing new');
  assert.equal(at60, opened + 1, 'the twelfth, a minute after the last loading');
});

test('what the refresh itself read in shows at once: a session known only from a new transcript', async (t) => {
  let d: TestDeck | undefined;
  let refreshed: string[] = [];
  d = listDeck(t, [
    () => {
      const deck = d as TestDeck;
      writeTranscript(deck, S3, [userRecord(S3, T0 - 120n * MINUTE)]); // no live file, no other skydeck
      deck.clock.advanceMs(PERIOD_MS);
      refreshed = frames(deck).at(-1) ?? [];
      return '';
    },
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  assert.deepEqual(rowOrder(refreshed), [short(S1), short(S2), short(S3)]);
});

// --- what makes a background refresh load the rows again (each the only trigger in its case) -------

/** A hook event for `sessionId` by process `pid`, put in the spool. */
function spoolEvent(
  d: TestDeck,
  event: 'SessionStart' | 'SessionEnd',
  sessionId: string,
  pid: number,
  timeNs: Ns,
  extra: Record<string, unknown>,
): void {
  const fields = { event, timeNs, pid, input: hookInput(event, sessionId, extra) };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 7)), spoolText(fields));
}

/** A key chunk: `change`, then one tick; the line of `id` in the frame after it is kept. */
const tickShowing =
  (get: () => TestDeck, id: string, shown: string[], change: () => void = () => {}) =>
  (): string => {
    change();
    const deck = get();
    deck.clock.advanceMs(PERIOD_MS);
    shown.push(lineOf(frames(deck).at(-1) ?? [], id) || '(not shown)');
    return '';
  };

test('an end event alone (the live file and the process unchanged) shows at the next tick', async (t) => {
  let d: TestDeck | undefined;
  const shown: string[] = [];
  const get = (): TestDeck => d as TestDeck;
  d = listDeck(t, [
    tickShowing(get, S2, shown),
    tickShowing(get, S2, shown, () => {
      spoolEvent(get(), 'SessionEnd', S2, 4343, T0 + 6n * SEC, { reason: 'prompt_input_exit' });
    }),
    'q',
  ]);
  startRunning(d, S2, 4343);

  assert.equal(await main([], d.ctx), 0);

  const [before = '', after = ''] = shown;
  assert.ok(before.includes('working'), before);
  assert.ok(after.includes('not-running'), after);
});

test('a session only its live file shows (no hook) appears once reconcile has observed it', async (t) => {
  let d: TestDeck | undefined;
  const shown: string[] = [];
  const get = (): TestDeck => d as TestDeck;
  d = listDeck(t, [
    tickShowing(get, S3, shown, () => {
      const deck = get();
      const path = join(deck.deck.places.claudeHome, 'sessions', '4444.json');
      writeFileSync(
        path,
        JSON.stringify({
          pid: 4444,
          sessionId: S3,
          cwd: '/home/dev/projects/demo',
          procStart: '51234567',
          entrypoint: 'cli',
          status: 'busy',
          updatedAt: 1794474030000,
          statusUpdatedAt: 1794474030000,
        }),
      );
      // Written a second before the tick: reconcile waits until it has settled (5.4).
      const at = Number((deck.clock.nowNs() + 4n * SEC) / SEC);
      utimesSync(path, at, at);
      deck.proc.setProcess(4444, { stat: statLine(4444, 51234567), cmdline: ['claude'] });
    }),
    tickShowing(get, S3, shown), // the live files are as they were: only `observed` says so
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  const [first = '', second = ''] = shown;
  assert.equal(first, '(not shown)');
  assert.ok(second.includes('working'), second);
});

test('a transcript that is deleted takes its row away at the next tick', async (t) => {
  let d: TestDeck | undefined;
  const shown: string[] = [];
  const get = (): TestDeck => d as TestDeck;
  d = listDeck(t, [
    tickShowing(get, S2, shown),
    tickShowing(get, S2, shown, () => {
      rmSync(join(get().deck.places.claudeHome, 'projects', 'demo', `${S2}.jsonl`));
    }),
    'q',
  ]);

  assert.equal(await main([], d.ctx), 0);

  const [before = '', after = ''] = shown;
  assert.ok(before.includes(short(S2)), before);
  assert.equal(after, '(not shown)');
});

test('after a tick that failed once it had read something in, the next tick loads the rows', async (t) => {
  let d: TestDeck | undefined;
  let broken = false;
  const shown: string[] = [];
  const get = (): TestDeck => d as TestDeck;
  d = listDeck(t, [
    tickShowing(get, S2, shown, () => {
      // Ingest saves the end event; reconcile, after it, fails.
      spoolEvent(get(), 'SessionEnd', S2, 4343, T0 + 1n * SEC, { reason: 'prompt_input_exit' });
      broken = true;
    }),
    tickShowing(get, S2, shown, () => {
      broken = false;
    }),
    'q',
  ]);
  startRunning(d, S2, 4343);
  const bootId = d.proc.bootId;
  d.proc.bootId = () => {
    if (broken) {
      throw new Error('database is locked');
    }
    return bootId();
  };

  assert.equal(await main([], d.ctx), 0);

  const [failed = '', next = ''] = shown;
  assert.ok(failed.includes('working'), failed);
  assert.ok(next.includes('not-running'), next);
  assert.equal(spooled(d).length, 0);
});

test('reloads: one per change, none for ticks that find nothing, and one per minute after the last', async (t) => {
  let d: TestDeck | undefined;
  let counting: ReturnType<typeof countingLoads> | undefined;
  const loads = (): number => (counting as ReturnType<typeof countingLoads>).loads();
  const counted: number[] = [];
  d = listDeck(t, [
    () => {
      const deck = d as TestDeck;
      const opened = loads();
      startRunning(deck, S2, 4343);
      deck.clock.advanceMs(PERIOD_MS); // 5 s: a change
      counted.push(loads() - opened);
      deck.clock.advanceMs(55_000); // 10 s to 60 s: eleven ticks that find nothing
      counted.push(loads() - opened);
      deck.clock.advanceMs(PERIOD_MS); // 65 s: a minute after the last loading
      counted.push(loads() - opened);
      deck.clock.advanceMs(55_000); // to 120 s
      counted.push(loads() - opened);
      deck.clock.advanceMs(PERIOD_MS); // 125 s
      counted.push(loads() - opened);
      return '';
    },
    'q',
  ]);
  counting = countingLoads(d);

  assert.equal(await main([], counting.ctx), 0);

  assert.deepEqual(counted, [1, 1, 2, 2, 3]);
});

test('a leftover live file written later than it was (only its time changed) shows at the next tick', async (t) => {
  // Two processes held S2 and are gone. A ended it properly at T0 - 25 s; B never sent an end, and
  // its leftover busy file was last written at T0 - 50 s, so A's end is the last holding. When B's
  // file turns out to be written later than A's end, B ended last, and unexpectedly, while working.
  let d: TestDeck | undefined;
  const shown: string[] = [];
  const get = (): TestDeck => d as TestDeck;
  const leftover = (deck: TestDeck): string =>
    join(deck.deck.places.claudeHome, 'sessions', '5002.json');
  const touch = (path: string, ns: Ns): void => {
    utimesSync(path, Number(ns / SEC), Number(ns / SEC));
  };
  d = listDeck(t, [
    tickShowing(get, S2, shown),
    tickShowing(get, S2, shown, () => {
      touch(leftover(get()), T0 - 10n * SEC);
    }),
    'q',
  ]);
  spoolEvent(d, 'SessionStart', S2, 5001, T0 - 30n * SEC, { source: 'resume' });
  spoolEvent(d, 'SessionEnd', S2, 5001, T0 - 25n * SEC, { reason: 'prompt_input_exit' });
  spoolEvent(d, 'SessionStart', S2, 5002, T0 - 40n * SEC, { source: 'resume' });
  const busy = JSON.parse(
    readFileSync(new URL('../../fixtures/claude/sessions/busy.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  writeFileSync(leftover(d), JSON.stringify({ ...busy, pid: 5002, sessionId: S2 }));
  touch(leftover(d), T0 - 50n * SEC);

  assert.equal(await main([], d.ctx), 0);

  const [before = '', after = ''] = shown;
  assert.ok(!before.includes('ended-unexpectedly'), before);
  assert.ok(after.includes('ended-unexpectedly'), after);
});

test('the notice of a session that left while the editor ran follows the outcome', async (t) => {
  let d: TestDeck | undefined;
  const runner = fakeRunner(undefined, (call) => {
    markDone((d as TestDeck).deck, S2); // done in another skydeck meanwhile
    writeFileSync(call.args.at(-1) ?? '', 'x');
    return 0;
  });
  d = listDeck(t, ['j', 'n', 'q']);

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.equal(lastLines(d).at(-1), `saved  session ${short(S2)} left the list`);
  assert.equal(selectedIn(frames(d).at(-1) ?? []), short(S1));
  assert.equal(d.deck.store.meta(S2)?.note, 'x');
});
