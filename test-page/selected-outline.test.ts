// The selected line's outline in both zones (S2 12.2, 12.9): a selected row, a selected row inside a
// block's card and a selected closed caption show the `--selline` outline whichever zone has the
// keyboard; while the LIST has it they keep the `--sel` fill too, while the TERMINAL has it they
// have no fill; and nothing moves between the zones, the line's box and its text's place being the
// same. Read from the styles the page computes, in the light and the dark scheme. One scripted
// stand-in server (helpers/shell.ts) sends the list: Recent with a plain row, a block of two rows
// drawn as a card, and a block of three, which the test closes: its caption alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Browser, Page } from 'playwright';

import { S1, S2, S3 } from '../test/helpers/platform.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  clickRow,
  connection,
  honest,
  PAGE_WAIT_MS,
  problemsOf,
  readPage,
  standinServer,
  storeKey,
  toZone,
} from './helpers/shell.ts';

const NOW = 1_794_474_000_000_000_000n;
const MIN = 60_000_000_000n;
const ago = (ns: bigint): string => String(NOW - ns);

/** The sessions of the block `web`. */
const W1 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const W2 = '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b';
const W3 = '5a0e8b6d-3c7f-4e1a-8b8c-7d6e5f4a3b2c';

/** A row of Recent (S2 8.2.3), not running; a `block` makes it a row of that block's card. */
function row(
  id: string,
  minutes: bigint,
  block: { group: string; head: string; size: number } | null = null,
): Record<string, unknown> {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `session ${id.slice(0, 8)}`,
    titleSource: 'generated',
    group: block?.group ?? null,
    groupSource: block === null ? null : 'meta',
    state: 'not-running',
    stateDetail: null,
    sinceNs: ago(minutes * MIN),
    lastActivityNs: ago(minutes * MIN),
    dir: '/home/u/project',
    marks: [],
    hasNote: false,
    noteHead: [],
    done: false,
    prs: [],
    chip: null,
    terminal: null,
    slot: null,
    elsewhere: null,
    starting: false,
    attention: null,
    stack:
      block === null
        ? null
        : {
            group: block.group,
            size: block.size,
            role: id === block.head ? 'head' : 'member',
            head: block.head,
          },
  };
}

/**
 * Recent: the plain row S1, the card `orb` (S2, S3), and the block `web` (W1 to W3), drawn as a
 * card or, once `webClosed`, as its caption alone, after the others.
 */
function list(webClosed: boolean): Record<string, unknown> {
  const orb = { group: 'orb', head: S2, size: 2 };
  const web = { group: 'web', head: W1, size: 3 };
  const rows = [
    row(S1, 1n),
    row(S2, 2n, orb),
    row(S3, 3n, orb),
    ...(webClosed ? [] : [row(W1, 4n, web), row(W2, 5n, web), row(W3, 6n, web)]),
  ];
  return {
    t: 'list',
    nowNs: String(NOW),
    counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 },
    sections: [
      {
        name: 'week',
        folded: false,
        firstNs: null,
        lastNs: null,
        count: rows.length,
        rows,
        closedStacks: webClosed
          ? [{ group: 'web', size: 3, needYou: 0, head: W1, at: rows.length }]
          : [],
      },
    ],
    doneHidden: 0,
    banner: null,
    terminals: [],
    selected: null,
    dirs: [],
  };
}

/** Whether a view names Recent's block `web` closed (`view.closed`). */
const namesWebClosed = (view: Record<string, unknown>): boolean =>
  Array.isArray(view['closed']) &&
  view['closed'].some(
    (block: { section?: unknown; group?: unknown }) =>
      block.section === 'week' && block.group === 'web',
  );

/**
 * A page connected to a stand-in server that answers every `view` with the list, `web` closed
 * when the view says so; the block is closed here by a click on its caption, as a user does.
 */
async function opened(t: TestContext, chromium: Browser): Promise<Page> {
  const secret = new Uint8Array(32).fill(61);
  const page = await newPage(t, chromium);
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') conn.send(list(namesWebClosed(message)));
        if (message['t'] === 'attach') {
          conn.send({ t: 'snap', term: message['term'], ch: 1, cols: 80, rows: 24, data: '' });
        }
      },
    }),
  });
  await page.goto(standin.url);
  await storeKey(page, secret);
  await page.goto(standin.url);
  await connection(page, 'open');
  await page.locator(`#list [data-id="${W3}"]`).waitFor({ timeout: PAGE_WAIT_MS });
  await page.locator('#list .list-block', { hasText: 'web' }).locator('.block-head').click();
  await page.locator('#list .list-block[data-open="false"]').waitFor({ timeout: PAGE_WAIT_MS });
  return page;
}

/** What the page draws of one line: its fill, its four edges, its box and where its text starts. */
interface Look {
  background: string;
  /** Top, right, bottom, left: `<width> <style> <colour>`. */
  edges: string[];
  box: { width: number; height: number };
  /** The text's left and top edge from the line's own (a row's title, a caption's name). */
  text: { left: number; top: number };
}

/** The look of the line with `selector`, as the page computes it; `rgb(…)` colours. */
async function lookOf(page: Page, selector: string): Promise<Look> {
  return readPage(
    page,
    (selector) => {
      const line = document.querySelector(selector);
      if (!(line instanceof HTMLElement)) throw new Error(`no line ${selector}`);
      const text = line.querySelector(
        line.classList.contains('block-head') ? '.block-name' : '.row-title',
      );
      if (text === null) throw new Error(`no text in ${selector}`);
      const style = getComputedStyle(line);
      const at = line.getBoundingClientRect();
      const of = text.getBoundingClientRect();
      const round = (n: number): number => Math.round(n * 100) / 100;
      return {
        background: style.backgroundColor,
        edges: ['top', 'right', 'bottom', 'left'].map((side) =>
          ['width', 'style', 'color']
            .map((what) => style.getPropertyValue(`border-${side}-${what}`))
            .join(' '),
        ),
        box: { width: round(at.width), height: round(at.height) },
        text: { left: round(of.left - at.left), top: round(of.top - at.top) },
      };
    },
    selector,
  );
}

/** The page's `--sel` and `--selline` now, as it computes them. */
async function selColours(page: Page): Promise<{ fill: string; line: string }> {
  return readPage(
    page,
    () => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const resolve = (css: string): string => {
        probe.style.color = css;
        return getComputedStyle(probe).color;
      };
      const found = { fill: resolve('var(--sel)'), line: resolve('var(--selline)') };
      probe.remove();
      return found;
    },
    null,
  );
}

const NONE = 'rgba(0, 0, 0, 0)';

test('the selected line keeps its outline in both zones, and its fill while the list has the keyboard', async (t) => {
  const chromium = await browser(t);
  const page = await opened(t, chromium);
  const problems = problemsOf(page);

  /** Selects the line, waits for it to be the selected one. */
  const select = async (how: 'row' | 'row in a card' | 'caption'): Promise<string> => {
    if (how === 'row') {
      await clickRow(page, S1);
      return `#list [data-id="${S1}"][data-selected="true"]`;
    }
    if (how === 'row in a card') {
      await clickRow(page, S2);
      return `#list .list-block [data-id="${S2}"][data-selected="true"]`;
    }
    // The caption of `web`: one step down from the last row of the card above it.
    await clickRow(page, S3);
    await toZone(page, 'list');
    await page.keyboard.press('ArrowDown');
    await page
      .locator('#list .block-head[data-selected="true"]')
      .waitFor({ timeout: PAGE_WAIT_MS });
    return '#list .block-head[data-selected="true"]';
  };

  /** The plain row's look while selected (the list zone's), for what it looked like before. */
  let selectedRow: Look | null = null;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { fill, line } = await selColours(page);
    assert.notEqual(fill, line, `${scheme}: --sel and --selline are two colours`);
    for (const how of ['row', 'row in a card', 'caption'] as const) {
      const selector = await select(how);
      const which = `${scheme}, ${how}`;
      // Read with the pointer off the line, then on it, where a click leaves it: the same look.
      await page.mouse.move(0, 0);

      await toZone(page, 'list');
      const inList = await lookOf(page, selector);
      await page.locator(selector).hover();
      assert.deepEqual(
        await lookOf(page, selector),
        inList,
        `${which}: the list has the keyboard, the pointer on the line: the same`,
      );
      await page.mouse.move(0, 0);
      await toZone(page, 'terminal');
      const inTerminal = await lookOf(page, selector);
      await page.locator(selector).hover();
      assert.deepEqual(
        await lookOf(page, selector),
        inTerminal,
        `${which}: the terminal has it, the pointer on the line: the same`,
      );
      await page.mouse.move(0, 0);
      if (how === 'row') selectedRow = inList;

      const outline = Array.from({ length: 4 }, () => `1px solid ${line}`);
      assert.deepEqual(
        inList.edges,
        outline,
        `${which}: the list has the keyboard: the outline in --selline`,
      );
      assert.deepEqual(inTerminal.edges, outline, `${which}: the terminal has it: the outline too`);
      assert.equal(inList.background, fill, `${which}: the list has the keyboard: the --sel fill`);
      assert.equal(inTerminal.background, NONE, `${which}: the terminal has it: no fill`);
      assert.deepEqual(inList.box, inTerminal.box, `${which}: the line's box is the same`);
      assert.deepEqual(inList.text, inTerminal.text, `${which}: the text is where it was`);
      assert.ok(inList.box.height > 0 && inList.box.width > 0, `${which}: the line has a box`);
    }
  }

  // Nothing else of a row changed: the row above the selected one has no fill and no outline.
  await clickRow(page, S2);
  for (const wanted of ['list', 'terminal'] as const) {
    await toZone(page, wanted);
    await page.mouse.move(0, 0);
    const other = await lookOf(page, `#list [data-id="${S1}"]`);
    assert.equal(other.background, NONE, `${wanted}: a row that is not selected has no fill`);
    assert.ok(
      other.edges.every((edge) => edge.endsWith(NONE)),
      `${wanted}: a row that is not selected has no outline: ${other.edges.join(' | ')}`,
    );
    assert.deepEqual(
      { box: other.box, text: other.text },
      { box: selectedRow?.box, text: selectedRow?.text },
      `${wanted}: the row has the box and the text's place it had while selected`,
    );
  }
  assert.deepEqual(problems, []);
});
