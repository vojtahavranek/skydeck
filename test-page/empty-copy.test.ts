// Follow-up F33 (S2 12.1, 12.2): a copy Claude Code's background feature made of a session — its
// process started with `--fork-session --resume <the original's transcript>`, its transcript only a
// title — is not a second row in the window: hidden, shown with `a` marked `empty copy` (its
// tooltip names the original), and, once it has a first message, listed by itself marked
// `continued`, without a reload. A real test server with sessions made the way step 1 sees them
// (transcripts, the hook's spool files); the page has web/'s real modules.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { isoFromNs } from '../src/platform/time.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { S1, S2 } from '../test/helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../test/helpers/spool.ts';
import type { ServerSandbox } from '../test/helpers/window.ts';
import { browser } from './helpers/browser.ts';
import { launched, PAGE_WAIT_MS, readPage, toZone } from './helpers/shell.ts';

const ORIGINAL = S2;
const COPY = S1;
const TITLE = 'made-up title';
const SEC = 1_000_000_000n;
/** A pid no process of the test has; the copy's process exited in any case (its end event). */
const PID = 4_190_001;

interface Shown {
  id: string;
  marks: { text: string; tip: string }[];
}

/** The rows the list draws, in order, with their visible marks and the marks' tooltips. */
async function drawn(page: Page): Promise<Shown[]> {
  return readPage(
    page,
    () =>
      [...document.querySelectorAll('#list .list-row')]
        .filter((element) => element instanceof HTMLElement && element.checkVisibility())
        .map((element) => ({
          id: (element as HTMLElement).dataset['id'] ?? '',
          marks: [...element.querySelectorAll('.row-mark')]
            .filter((mark) => mark instanceof HTMLElement && mark.checkVisibility())
            .map((mark) => ({ text: mark.textContent ?? '', tip: (mark as HTMLElement).title }))
            .filter((mark) => mark.text !== ''),
        })),
    null,
  );
}

async function untilDrawn(
  page: Page,
  check: (rows: Shown[]) => boolean,
  what: string,
): Promise<Shown[]> {
  const deadline = performance.now() + PAGE_WAIT_MS;
  for (;;) {
    const rows = await drawn(page);
    if (check(rows)) return rows;
    if (performance.now() > deadline) assert.fail(`${what}: ${JSON.stringify(rows)}`);
    await sleep(50);
  }
}

/** The original (a prompt, titled) and its copy's spool files and title-only transcript. */
function copyAndOriginal(d: ServerSandbox): { copyTranscript: string } {
  const dir = join(d.s.home, 'project');
  mkdirSync(dir, { recursive: true });
  const folder = join(d.s.claudeHome, 'projects', 'project');
  mkdirSync(folder, { recursive: true });
  const now = d.platform.clock.nowNs();
  const original = join(folder, `${ORIGINAL}.jsonl`);
  // The spool first, then the copy's transcript, then the original's: when the original's row is
  // drawn, the refresh that read it had read the others too.
  const events = [
    {
      event: 'SessionStart' as const,
      timeNs: now - 60n * SEC,
      pid: PID,
      pwd: dir,
      input: hookInput('SessionStart', COPY, { source: 'startup', cwd: dir }),
      argv: ['claude', '--fork-session', '--resume', original, '--permission-mode', 'auto'],
    },
    {
      event: 'SessionEnd' as const,
      timeNs: now - 59n * SEC,
      pid: PID,
      input: hookInput('SessionEnd', COPY, { reason: 'prompt_input_exit', cwd: dir }),
    },
  ];
  events.forEach((fields, i) => {
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, i + 1)), spoolText(fields));
  });
  const copyTranscript = join(folder, `${COPY}.jsonl`);
  writeFileSync(
    copyTranscript,
    `${JSON.stringify({ type: 'ai-title', aiTitle: TITLE, sessionId: COPY })}\n`,
  );
  const timestamp = isoFromNs(now - 120n * SEC);
  writeFileSync(
    original,
    [
      { type: 'user', sessionId: ORIGINAL, timestamp, cwd: dir, entrypoint: 'cli' },
      { type: 'ai-title', aiTitle: TITLE, sessionId: ORIGINAL },
    ]
      .map((record) => `${JSON.stringify(record)}\n`)
      .join(''),
  );
  return { copyTranscript };
}

const EMPTY_TIP = `an empty copy of "${TITLE}" made by Claude Code; it shows by itself once it has a first message`;

test('an empty copy made by Claude Code (follow-up F33)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    'one row, not two; `a` shows the copy marked `empty copy`; its first message lists it marked `continued`, without a reload',
    async (t) => {
      const l = await launched(t, chromium);
      const { page, d } = l;
      await page.evaluate(() => Reflect.set(globalThis, 'f33SameLoad', true));
      const { copyTranscript } = copyAndOriginal(d);

      await untilDrawn(page, (rows) => rows.some((row) => row.id === ORIGINAL), 'the original');
      await sleep(2500); // a refresh or more later: still one row
      assert.deepEqual(
        (await drawn(page)).map((row) => row.id),
        [ORIGINAL],
      );

      await toZone(page, 'list');
      await page.keyboard.press('a');
      const shown = await untilDrawn(page, (rows) => rows.length === 2, 'shown with `a`');
      assert.deepEqual(shown.find((row) => row.id === COPY)?.marks, [
        { text: 'empty copy', tip: EMPTY_TIP },
      ]);
      assert.deepEqual(shown.find((row) => row.id === ORIGINAL)?.marks, []);
      await page.keyboard.press('a');
      await untilDrawn(page, (rows) => rows.length === 1, 'hidden again by `a`');

      // Its first message (a prompt given in agent view): the list follows the transcript.
      const timestamp = isoFromNs(d.platform.clock.nowNs());
      appendFileSync(
        copyTranscript,
        `${JSON.stringify({ type: 'user', sessionId: COPY, timestamp, entrypoint: 'cli' })}\n`,
      );
      const used = await untilDrawn(page, (rows) => rows.length === 2, 'the copy, used');
      assert.deepEqual(used.find((row) => row.id === COPY)?.marks, [
        { text: 'continued', tip: `it began as a copy of "${TITLE}"` },
      ]);
      assert.equal(
        await page.evaluate(() => Reflect.get(globalThis, 'f33SameLoad')),
        true,
        'no reload',
      );
      assert.deepEqual(l.problems, []);
    },
  );
});
