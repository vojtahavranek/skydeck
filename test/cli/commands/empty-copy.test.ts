// Follow-up F33, end to end through the commands: a copy that Claude Code's background feature
// started (`claude --fork-session --resume <the original's transcript>`) whose transcript holds only
// a title is not in `skydeck ls`, is in `ls --all` and `show` with its mark and its copy link, and is
// an ordinary continued session once it has a turn. done, undone and resume work on it as on any
// session: the resume guard still sees its running process.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../../src/cli/main.ts';
import { isoFromNs } from '../../../src/platform/time.ts';
import { testDeck } from '../../helpers/deck.ts';
import type { TestDeck } from '../../helpers/deck.ts';
import { S1, S2, S3, SEC, T0, statLine } from '../../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../../helpers/spool.ts';
import {
  appendRecord,
  prLinkRecord,
  userRecord,
  writeTranscript,
} from '../../helpers/session-files.ts';

const COPY = S1;
const ORIGINAL = S2;
const TITLE = 'made-up title';
const PID = 4242;

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(d: TestDeck, args: string[]): Promise<Run> {
  const [outAt, errAt] = [d.stdout().length, d.stderr().length];
  const code = await main(args, d.ctx);
  return { code, out: d.stdout().slice(outAt), err: d.stderr().slice(errAt) };
}

interface SessionJson {
  id: string;
  marks: string[];
  continuedFrom: string | null;
  done: boolean;
}

async function listed(d: TestDeck, ...flags: string[]): Promise<SessionJson[]> {
  const { code, out } = await run(d, ['ls', '--json', ...flags]);
  assert.equal(code, 0);
  return (JSON.parse(out) as { sessions: SessionJson[] }).sessions;
}

const titleRecord = (sessionId: string): Record<string, unknown> => ({
  type: 'ai-title',
  aiTitle: TITLE,
  sessionId,
});

/**
 * The original S2 (one prompt, titled), and its copy S1 started by pid 4242 with the background
 * feature's command, whose transcript holds only the copied title. `running`: pid 4242 still runs
 * (a trusted live file); else it exited.
 */
function copyDeck(
  t: Parameters<typeof testDeck>[0],
  running: boolean,
  status: 'idle' | 'busy' | 'waiting' = 'idle',
): TestDeck {
  const d = testDeck(t, { env: (s) => ({ SKYDECK_HANDOFF: join(s.root, 'handoff') }) });
  writeTranscript(d, ORIGINAL, [titleRecord(ORIGINAL), userRecord(ORIGINAL, T0 - 600n * SEC)]);
  writeTranscript(d, COPY, [titleRecord(COPY)]);
  const transcript = join(d.deck.places.claudeHome, 'projects', 'demo', `${ORIGINAL}.jsonl`);
  // The copy's transcript names no directory: the hook's does, one that exists (for a resume).
  const dir = join(d.sandbox.root, 'project');
  mkdirSync(dir, { recursive: true });
  const events = [
    {
      event: 'SessionStart' as const,
      timeNs: T0 - 20n * SEC,
      pid: PID,
      pwd: dir,
      input: hookInput('SessionStart', COPY, { source: 'startup', cwd: dir }),
      argv: ['claude', '--fork-session', '--resume', transcript, '--permission-mode', 'auto'],
    },
    ...(running
      ? []
      : [
          {
            event: 'SessionEnd' as const,
            timeNs: T0 - 15n * SEC,
            pid: PID,
            input: hookInput('SessionEnd', COPY, { reason: 'prompt_input_exit' }),
          },
        ]),
  ];
  events.forEach((fields, i) => {
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, i + 1)), spoolText(fields));
  });
  if (running) {
    const busy = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../fixtures/claude/sessions/busy.json', import.meta.url)),
        'utf8',
      ),
    ) as Record<string, unknown>;
    writeFileSync(
      join(d.deck.places.claudeHome, 'sessions', `${PID}.json`),
      JSON.stringify({ ...busy, pid: PID, sessionId: COPY, status }),
    );
    d.proc.setProcess(PID, { stat: statLine(PID, 51234567), cmdline: ['claude'] });
  }
  return d;
}

describe('skydeck ls and show on an empty copy', () => {
  for (const running of [true, false]) {
    test(`${running ? 'running' : 'ended'}: not in ls; in ls --all marked, continued from the original`, async (t) => {
      const d = copyDeck(t, running);
      assert.deepEqual(
        (await listed(d)).map((session) => session.id),
        [ORIGINAL],
      );
      const all = await listed(d, '--all');
      const copy = all.find((session) => session.id === COPY);
      assert.deepEqual(copy?.marks, ['continued', 'empty-copy']);
      assert.equal(copy?.continuedFrom, ORIGINAL);
      assert.equal(copy?.done, false);
      // An addition only: the same keys as every other session of version 1.
      const original = all.find((session) => session.id === ORIGINAL);
      assert.deepEqual(Object.keys(copy ?? {}), Object.keys(original ?? {}));

      const text = await run(d, ['ls', '--all']);
      assert.match(text.out, /continued,empty-copy/);
      assert.doesNotMatch((await run(d, ['ls'])).out, /empty-copy/);
    });
  }

  test('show --json: the copy link from the original, its marks; show prints the link', async (t) => {
    const d = copyDeck(t, true);
    const shown = await run(d, ['show', COPY.slice(0, 8), '--json']);
    assert.equal(shown.code, 0, shown.err);
    const json = JSON.parse(shown.out) as {
      marks: string[];
      continuedFrom: string;
      links: { kind: string; from: string; to: string; at: string }[];
      launch: string[];
    };
    assert.deepEqual(json.marks, ['continued', 'empty-copy']);
    assert.equal(json.continuedFrom, ORIGINAL);
    assert.deepEqual(json.links, [
      { kind: 'copy', from: ORIGINAL, to: COPY, at: isoFromNs(T0 - 20n * SEC) },
    ]);
    // Neither the flags nor the path of the original's transcript is stored.
    assert.deepEqual(json.launch, ['claude', '--permission-mode', 'auto']);

    const text = (await run(d, ['show', COPY.slice(0, 8)])).out;
    assert.match(text, new RegExp(`\\ncontinues: +${ORIGINAL}\\n`));
    assert.match(text, /\nlink: +copy 1c6a4d2f -> 0b5f3c1e at /);
    assert.match(text, /\nmarks: +continued,empty-copy\n/);
  });

  for (const status of ['busy', 'waiting'] as const) {
    test(`its process ${status === 'busy' ? 'works' : 'asks a question'} (live file ${status}): in ls at once, marked continued, whatever its transcript says yet`, async (t) => {
      const d = copyDeck(t, true, status);
      const copy = (await listed(d)).find((session) => session.id === COPY);
      assert.deepEqual(copy?.marks, ['continued']);
      assert.equal(copy?.continuedFrom, ORIGINAL);
    });
  }

  test('a pr-link record copied with the title: the pull request is attached, the copy stays hidden', async (t) => {
    const d = copyDeck(t, true);
    const url = 'https://github.com/example/repo/pull/7';
    writeTranscript(d, COPY, [titleRecord(COPY), prLinkRecord(COPY, url, T0 - 25n * SEC)]);
    assert.deepEqual(
      (await listed(d)).map((session) => session.id),
      [ORIGINAL],
    );
    const shown = await run(d, ['show', COPY.slice(0, 8), '--json']);
    const json = JSON.parse(shown.out) as { marks: string[]; prs: { url: string }[] };
    assert.deepEqual(json.marks, ['continued', 'empty-copy']);
    assert.deepEqual(
      json.prs.map((pr) => pr.url),
      [url],
    );
  });

  test('its first message: in ls by the usual rules, marked continued', async (t) => {
    const d = copyDeck(t, true);
    assert.equal((await listed(d)).length, 1);
    appendRecord(d, COPY, userRecord(COPY, T0 - 5n * SEC), T0 - 5n * SEC);
    const copy = (await listed(d)).find((session) => session.id === COPY);
    assert.deepEqual(copy?.marks, ['continued']);
    assert.equal(copy?.continuedFrom, ORIGINAL);
  });

  test('an ordinary session whose transcript holds only a title is listed as today', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S3, [titleRecord(S3)]);
    const fields = {
      event: 'SessionStart' as const,
      timeNs: T0 - 20n * SEC,
      pid: PID,
      input: hookInput('SessionStart', S3, { source: 'startup' }),
      argv: ['claude', '--resume', ORIGINAL],
    };
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
    d.proc.setProcess(PID, { stat: statLine(PID, 51234567), cmdline: ['claude'] });
    const sessions = await listed(d);
    assert.deepEqual(
      sessions.map((session) => [session.id, session.marks]),
      [[S3, []]],
    );
  });
});

test('ls --help says what --all lists besides the done sessions', async (t) => {
  const d = testDeck(t);
  const help = await run(d, ['ls', '--help']);
  assert.equal(help.code, 0);
  assert.match(
    help.out,
    /--all {7}also list the sessions marked done, and the copies of a session Claude Code made\n {14}that have no message yet\n/,
  );
});

describe('done, undone and resume on a hidden copy', () => {
  test('done and undone take it by its short id; undone, it stays hidden while it is empty', async (t) => {
    const d = copyDeck(t, false);
    assert.equal((await run(d, ['done', COPY.slice(0, 8)])).code, 0);
    assert.equal((await listed(d, '--all')).find((s) => s.id === COPY)?.done, true);
    assert.equal((await run(d, ['undone', COPY.slice(0, 8)])).code, 0);
    assert.equal((await listed(d, '--all')).find((s) => s.id === COPY)?.done, false);
    assert.deepEqual(
      (await listed(d)).map((session) => session.id),
      [ORIGINAL],
    );
  });

  test('resume of a hidden copy whose process runs is refused: the guard sees the process', async (t) => {
    const d = copyDeck(t, true);
    const refused = await run(d, ['resume', COPY.slice(0, 8)]);
    assert.equal(refused.code, 4);
    assert.equal(refused.err, `skydeck: ${COPY.slice(0, 8)} is running (pid ${PID})\n`);
  });

  test('resume of a hidden copy that ended resumes it, as any session', async (t) => {
    const d = copyDeck(t, false);
    const resumed = await run(d, ['resume', COPY.slice(0, 8)]);
    assert.equal(resumed.code, 0, resumed.err);
    const handoff = readFileSync(join(d.sandbox.root, 'handoff'), 'utf8');
    assert.match(handoff, new RegExp(`--resume ${COPY}`));
  });
});
