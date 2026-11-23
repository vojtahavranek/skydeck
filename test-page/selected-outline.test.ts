// The selected line's outline in both zones (S2 12.2, 12.9): a selected row, a selected row inside a
// block's card and a selected closed caption show the `--selline` outline whichever zone has the
// keyboard; while the LIST has it they keep the `--sel` fill too, while the TERMINAL has it they
// have no fill; and nothing moves between the zones, the line's box and its text's place being the
// same. Read from the styles the page computes, in the light and the dark scheme. One scripted
// stand-in server (helpers/shell.ts) sends the list: Recent with a plain row, a block of two rows
// drawn as a card, and a block drawn closed, as its caption alone.
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

/** The head of the closed block `web`, which has no row of its own in the list. */
const WEB_HEAD = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';

/** A row of Recent (S2 8.2.3), not running; `group` and `stack` make it a row of a card. */
function row(id: string, minutes: bigint, group: string | null = null): Record<string, unknown> {
  return {
    id,
    shortId: id.slice(0, 8),
    title: `session ${id.slice(0, 8)}`,
    titleSource: 'generated',
    group,
    groupSource: group === null ? null : 'meta',
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
      group === null ? null : { group, size: 2, role: id === S2 ? 'head' : 'member', head: S2 },
  };
}

/** Recent: the plain row S1, the card `orb` (S2, S3), and the block `web` closed, after them. */
function list(): Record<string, unknown> {
  const rows = [row(S1, 1n), row(S2, 2n, 'orb'), row(S3, 3n, 'orb')];
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
        closedStacks: [{ group: 'web', size: 3, needYou: 0, head: WEB_HEAD, at: rows.length }],
      },
    ],
    doneHidden: 0,
    banner: null,
    terminals: [],
    selected: null,
    dirs: [],
  };
}

/** A page connected to a stand-in server that answers every `view` with `list()`. */
async function opened(t: TestContext, chromium: Browser): Promise<Page> {
  const secret = new Uint8Array(32).fill(61);
  const page = await newPage(t, chromium);
  const standin = await standinServer(t, {
    socket: honest(secret, {
      open: (conn, message) => {
        if (message['t'] === 'view') conn.send(list());
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
  await page.locator(`#list [data-id="${S3}"]`).waitFor({ timeout: PAGE_WAIT_MS });
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

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { fill, line } = await selColours(page);
    assert.notEqual(fill, line, `${scheme}: --sel and --selline are two colours`);
    for (const how of ['row', 'row in a card', 'caption'] as const) {
      const selector = await select(how);
      const which = `${scheme}, ${how}`;
      // The pointer of the click is off the line: a hovered line is another state of it.
      await page.mouse.move(0, 0);

      await toZone(page, 'list');
      const inList = await lookOf(page, selector);
      await toZone(page, 'terminal');
      const inTerminal = await lookOf(page, selector);

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
  }
  assert.deepEqual(problems, []);
});
