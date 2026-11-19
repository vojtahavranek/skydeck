// `skydeck install`'s first steps for a new user (follow-up F22): after `skydeck is installed`, a
// few short lines on what to do next, on stdout, after everything else install says — on a first
// install and on one that finds everything in place —; and one sentence before the question about
// old sessions that says what "done" does, only when that question is asked.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import type { Io } from '../../../src/cli/context.ts';
import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { Platform } from '../../../src/platform/types.ts';
import { capture } from '../../helpers/capture.ts';
import type { CaptureOptions } from '../../helpers/capture.ts';
import { installedTail, nextSteps, run, transcript } from '../../helpers/install.ts';
import { S1, S2, T0, testPlatform } from '../../helpers/platform.ts';

const DONE_SAYS =
  '"Done" only hides a session from skydeck\'s list: nothing is deleted, it can still be ' +
  'resumed, and skydeck ls --all shows it.';

const OLD = T0 - 10n * NS_PER_DAY;

/** One write of install's, on the stream it went to, in the order they came. */
type Write = ['out' | 'err', string];

/** `skydeck <argv>` with every write of both streams recorded in order (a prompt is on stderr). */
async function inOrder(
  platform: Platform,
  argv: string[],
  options: CaptureOptions,
): Promise<{ code: number; writes: Write[]; stdout: string; stderr: string }> {
  const captured = capture(options);
  const writes: Write[] = [];
  const io: Io = {
    ...captured.io,
    stdout: (text) => {
      writes.push(['out', text]);
      captured.io.stdout(text);
    },
    stderr: (text) => {
      writes.push(['err', text]);
      captured.io.stderr(text);
    },
    readLine: (prompt) => {
      writes.push(['err', prompt]);
      return captured.io.readLine(prompt);
    },
  };
  const code = await main(argv, { io, platform });
  return { code, writes, stdout: captured.stdout(), stderr: captured.stderr() };
}

/** The text of the writes from the last one on stderr to the end: what came after it. */
function afterLastStderr(writes: readonly Write[]): string {
  const last = writes.findLastIndex(([stream]) => stream === 'err');
  return writes
    .slice(last + 1)
    .map(([, text]) => text)
    .join('');
}

describe('install: the next steps after "skydeck is installed" (F22)', () => {
  test('a first install: "skydeck is installed", then the five lines, last on stdout and after everything on stderr', async (t) => {
    const d = testPlatform(t);

    const r = await inOrder(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    const tail = installedTail(d.platform);
    assert.ok(r.stdout.endsWith(tail), r.stdout);
    assert.ok(afterLastStderr(r.writes).endsWith(tail), JSON.stringify(r.writes.slice(-8)));
    assert.equal(r.stdout.split('skydeck is installed\n').length, 2, 'the line once');
    for (const line of nextSteps(d.platform)) {
      assert.ok(!r.stderr.includes(line), `not on stderr: ${line}`);
    }
  });

  test('an install that finds everything in place: the same lines, the same way', async (t) => {
    const d = testPlatform(t);
    await run(d.platform, ['install'], { lines: ['y', 'n'] });

    const r = await inOrder(d.platform, ['install'], { lines: [] });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /hook entries already present/);
    const tail = installedTail(d.platform);
    assert.ok(r.stdout.endsWith(tail), r.stdout);
    assert.ok(afterLastStderr(r.writes).endsWith(tail), JSON.stringify(r.writes.slice(-8)));
  });

  test('after the questions about old sessions and the ← shortcut, whatever the answers', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, OLD);
    // The ← shortcut on, so that its question is asked last of all.
    writeFileSync(d.places.claudeGlobalConfig, '{"numStartups": 1}\n', { mode: 0o600 });

    const r = await inOrder(d.platform, ['install'], { lines: ['y', 'n', 'n'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.endsWith('Turn the shortcut off? [y/N] '), r.stderr);
    const tail = installedTail(d.platform);
    assert.ok(afterLastStderr(r.writes).endsWith(tail), JSON.stringify(r.writes.slice(-8)));
  });

  test("at most five lines, each but the guide's shorter than 100 characters", (t) => {
    const d = testPlatform(t);
    const lines = nextSteps(d.platform);

    assert.ok(lines.length <= 5);
    for (const line of lines.slice(0, -1)) {
      assert.ok(line.length < 100, `${line.length}: ${line}`);
    }
  });

  test("the guide's line names the README of this checkout, which exists", async (t) => {
    const d = testPlatform(t);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    const guide = r.stdout.trimEnd().split('\n').at(-1) ?? '';
    assert.equal(guide, `The guide: ${join(d.platform.appRoot, 'README.md')}`);
    assert.ok(existsSync(join(d.platform.appRoot, 'README.md')));
  });

  test('an install that stops (a no to the hook entries) prints no next steps', async (t) => {
    const d = testPlatform(t);

    const r = await run(d.platform, ['install'], { lines: ['n'] });

    assert.equal(r.code, 1);
    for (const line of nextSteps(d.platform)) {
      assert.ok(!(r.stdout + r.stderr).includes(line), line);
    }
  });
});

describe('install: what "done" does, before the question about old sessions (F22)', () => {
  test('the question asked: the sentence on the line right before it, on stderr', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, OLD);
    transcript(d.places, S2, OLD);

    const r = await run(d.platform, ['install'], { lines: ['y', 'n'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      r.stderr.includes(`${DONE_SAYS}\nMark 2 sessions older than 7 days as done? [y/N] `),
      r.stderr,
    );
    assert.equal(r.stderr.split(DONE_SAYS).length, 2, 'once');
    assert.ok(!r.stdout.includes(DONE_SAYS));
    // The question, its default and its once-only rule are as before.
    assert.deepEqual(r.prompts, [
      'Add them? [y/N] ',
      'Mark 2 sessions older than 7 days as done? [y/N] ',
    ]);
  });

  test('no old session (no question): no sentence', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, T0 - 2n * NS_PER_DAY);

    const r = await run(d.platform, ['install'], { lines: ['y'] });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(DONE_SAYS), r.stderr);
  });

  test('a later install (the offer made once already): no question and no sentence', async (t) => {
    const d = testPlatform(t);
    transcript(d.places, S1, OLD);
    await run(d.platform, ['install'], { lines: ['y', 'n'] });

    const r = await run(d.platform, ['install']);

    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.prompts.some((prompt) => prompt.startsWith('Mark ')));
    assert.ok(!(r.stdout + r.stderr).includes(DONE_SAYS), r.stderr);
  });
});
