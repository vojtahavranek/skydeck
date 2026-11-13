import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { S1, S2, S3, SEC, T0, fakeRunner, runResult } from '../../helpers/platform.ts';
import type { FakeRunner, RunCall } from '../../helpers/platform.ts';
import {
  startRunning,
  userRecord,
  withRunner,
  writeTranscript,
} from '../../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
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
});

test('the end of the keys quits like q, and ctrl-c quits too', async (t) => {
  const ended = listDeck(t, []);
  assert.equal(await main([], ended.ctx), 0);
  assert.ok(ended.stdout().endsWith(LEAVE));

  const interrupted = listDeck(t, ['\x03', 'd']);
  assert.equal(await main([], interrupted.ctx), 0);
  assert.ok(interrupted.stdout().endsWith(LEAVE));
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

  assert.equal(await main([], d.ctx), 0);

  assert.equal(
    readFileSync(join(d.sandbox.root, 'handoff'), 'utf8'),
    handoffScript({ cwd: dir, argv: ['claude', '--resume', S1] }),
  );
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
  // The launch's warning is the message; it says what happened instead of "opened … in a new tab".
  assert.ok(
    lastLines(d).includes('original flags unknown; resuming with defaults'),
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

test('R with a tab that fails to open shows the reason and the command in the message line', async (t) => {
  const runner = fakeRunner((call) =>
    call.command === 'wezterm' ? runResult({ code: 1, stderr: 'no window\n' }) : runResult({}),
  );
  const d = listDeck(t, ['R', 'q'], {
    config: { terminal: 'wezterm' },
    size: { columns: 400, rows: 24 },
  });
  resumable(d);

  assert.equal(await main([], withRunner(d, runner)), 0);

  const message = lastLines(d).find((line) => line.includes('no window'));
  assert.ok(message !== undefined, lastLines(d).join('\n'));
  assert.match(message, /to start it yourself, run:/);
});

test('n runs the editor outside the alternate screen and stores the note', async (t) => {
  let shownWhileEditing = '';
  let d: TestDeck | undefined;
  const runner = fakeRunner(undefined, (call) => {
    shownWhileEditing = d?.stdout() ?? '';
    writeFileSync(call.args.at(-1) ?? '', 'x');
    return 0;
  });
  d = listDeck(t, ['n', 'q']);

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.equal(d.deck.store.meta(S1)?.note, 'x');
  assert.ok(shownWhileEditing.endsWith(LEAVE), 'the screen was left before the editor');
  const after = d.stdout().slice(shownWhileEditing.length);
  assert.ok(after.startsWith(ENTER + CLEAR), JSON.stringify(after.slice(0, 30)));
  assert.equal(runner.interactiveCalls.length, 1);
});

test('n: the line editNote writes, and its failure, are shown in the message line', async (t) => {
  const runner = fakeRunner(undefined, () => 1);
  const d = listDeck(t, ['n', 'q'], { size: { columns: 400, rows: 24 } });
  writeFileSync(join(d.deck.places.stateDir, `note-${S1}.md`), 'kept');

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.equal(d.stderr(), '');
  const message = lastLines(d).find((line) => line.includes('an earlier edit of this note'));
  assert.ok(message !== undefined, lastLines(d).join('\n'));
  assert.match(message, /editor exited 1/);
  assert.equal(d.deck.store.meta(S1)?.note ?? null, null);
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

test('quitting while the background refresh runs waits for it, saves its result and paints nothing more', async (t) => {
  const runner = gh(
    () =>
      new Promise<RunResult>((resolve) => {
        setTimeout(() => resolve(runResult({ stdout: OPEN_GREEN })), 30);
      }),
  );
  const d = listDeck(t, ['q']);
  attachManualPr(d.deck, S1, PR1);

  assert.equal(await main([], withRunner(d, runner)), 0);

  assert.equal(d.deck.store.prs().find((pr) => pr.url === PR1)?.state, 'open');
  assert.equal(frames(d).length, 1);
  assert.ok(d.stdout().endsWith(LEAVE));
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

test('a resize is painted without waiting for a key', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let size = { columns: 80, rows: 24 };
  let framesBefore = -1;
  let framesAfter = -1;
  let d: TestDeck | undefined;
  d = listDeck(t, [
    () => {
      framesBefore = frames(d as TestDeck).length;
      size = { columns: 60, rows: 10 };
      t.mock.timers.tick(1000);
      framesAfter = frames(d as TestDeck).length;
      return 'q';
    },
  ]);
  const ctx: Context = { ...d.ctx, io: { ...d.ctx.io, size: () => size } };

  assert.equal(await main([], ctx), 0);

  assert.equal(framesAfter, framesBefore + 1);
  const resized = frames(d)[framesBefore] ?? [];
  assert.equal(resized.length, 10);
  assert.ok(resized.every((line) => line.length <= 60));
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
  assert.equal(d.stderr(), 'skydeck: internal error: boom\n');
});
