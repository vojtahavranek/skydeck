// What the page tests of the terminal view share (plan task 28): opening a session's terminal as a
// user does, reading what the shown terminal shows, and what the stand-in in it recorded.
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { readRecords } from '../../test/helpers/standin.ts';
import type { StandinRecord } from '../../test/helpers/standin.ts';
import { PAGE_WAIT_MS, clickRow, readPage, showsText } from './shell.ts';

/** The id of the terminal the right side shows ('' when none), as app.js marks it. */
export async function shownTerm(page: Page): Promise<string> {
  return readPage(
    page,
    () => document.getElementById('right-zone')?.dataset['paneTerm'] ?? '',
    null,
  );
}

/**
 * Waits until the right side shows a terminal of `sessionId` (its row selected) with the keyboard
 * in that terminal's xterm.js, and returns the terminal's id.
 */
export async function untilTerminalOf(page: Page, sessionId: string): Promise<string> {
  await page.waitForFunction(
    (id) => {
      const zone = document.getElementById('right-zone');
      const selected =
        document.querySelector('#list [data-selected="true"]')?.getAttribute('data-id') === id;
      const box = document.activeElement?.closest('.tv-term');
      return (
        selected &&
        zone?.dataset['pane'] === 'terminal' &&
        box instanceof HTMLElement &&
        box.dataset['term'] === zone.dataset['paneTerm'] &&
        document.activeElement?.closest('.xterm') !== null
      );
    },
    sessionId,
    { timeout: PAGE_WAIT_MS },
  );
  return shownTerm(page);
}

/**
 * Resumes `sessionId` from the list as a user does — one click on its row (the list zone), Enter —
 * and waits until its terminal is shown with the keyboard. Returns the terminal's id.
 */
export async function resumeHere(page: Page, sessionId: string): Promise<string> {
  await clickRow(page, sessionId);
  await showsText(page, '#focus-zone', /^Focus: list$/);
  await page.keyboard.press('Enter');
  return untilTerminalOf(page, sessionId);
}

/** The rows the shown terminal shows, as text (trailing spaces cut). */
export async function screenText(page: Page): Promise<string> {
  return readPage(
    page,
    () => {
      const box = document.querySelector('#terminal .tv-term:not([hidden])');
      const rows = box?.querySelectorAll('.xterm-rows > div') ?? [];
      return [...rows]
        .map((row) => (row.textContent ?? '').replaceAll(' ', ' ').trimEnd())
        .join('\n');
    },
    null,
  );
}

/** Waits until the shown terminal shows text matching `pattern`; returns that text. */
export async function untilScreen(
  page: Page,
  pattern: RegExp,
  timeout = PAGE_WAIT_MS,
): Promise<string> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const text = await screenText(page);
    if (pattern.test(text)) return text;
    if (performance.now() > deadline) {
      assert.fail(
        `the terminal shows ${JSON.stringify(text.slice(-2000))}, not ${String(pattern)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The records of the stand-in that runs `sessionId` (its start record names it). */
export function recordsOf(record: string, sessionId: string): StandinRecord[] {
  const all = readRecords(record);
  const pids = new Set(
    all
      .filter((entry) => entry.ev === 'start' && entry.argv.includes(sessionId))
      .map((entry) => entry.pid),
  );
  return all.filter((entry) => pids.has(entry.pid));
}

/** The input the stand-in of `sessionId` read, in hex, in order. */
export function inputOf(record: string, sessionId: string): string {
  return recordsOf(record, sessionId)
    .map((entry) => (entry.ev === 'input' ? entry.hex : ''))
    .join('');
}

/** Waits until `check()` holds, polling; fails with `what` after `timeout`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeout = PAGE_WAIT_MS,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, `${what} within ${timeout} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `text` as the hex of its UTF-8 bytes. */
export function hexOf(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex');
}

/** The prompt the stand-in draws for `sessionId` (plan 2.4), as screenText shows it (no trailing space). */
export function promptOf(sessionId: string): RegExp {
  return new RegExp(`standin ${sessionId.slice(0, 8)}>`);
}

/** The text of the shown terminal's notice of `kind` ('' when none). */
export async function noticeText(page: Page, kind: string): Promise<string> {
  return readPage(
    page,
    (kind) =>
      document.querySelector(
        `#terminal .tv-term:not([hidden]) .tv-bar[data-kind="${kind}"] .tv-bar-text`,
      )?.textContent ?? '',
    kind,
  );
}
