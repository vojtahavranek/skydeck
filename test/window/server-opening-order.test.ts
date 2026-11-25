// The opening order of the window's terminals under a clock that holds (issue #213, S2 7.1, 7.6,
// 12.1): two terminals opened one after the other while the server's wall clock gives one value
// get different opening stamps, so Open lists the terminals without a number in the order they
// were opened, and a freed number goes to the first of them — whatever their ids say (here they
// sort against the opening order). End to end on the server: sessions resumed into the window's
// terminals (real keepers running the stand-in), eleven of them, so that two wait without a
// number. In the test process (A19) on realTestPlatform, with the clock held by the test.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Platform } from '../../src/platform/types.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';
import type { TestPage } from '../helpers/window.ts';

/** Session `n` of these tests. */
function nth(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Open as drawn: "<n>:<slot>" for each row. */
function openOf(list: ListMessage): string[] {
  return (list.sections.find((section) => section.name === 'open')?.rows ?? []).map(
    (row) => `${Number.parseInt(row.id.slice(-12), 16)}:${row.slot ?? '-'}`,
  );
}

/** The first list whose Open passes `test`; on a timeout the last Open seen is in the message. */
async function openWhere(
  page: TestPage,
  test: (open: string[]) => boolean,
  what: string,
): Promise<ListMessage> {
  let last: string[] = [];
  try {
    return await page.list((list) => {
      last = openOf(list);
      return test(last);
    }, what);
  } catch {
    assert.fail(`${what}: Open read ${last.join(' ')}`);
  }
}

const reads = (order: readonly string[]) => (open: string[]) =>
  JSON.stringify(open) === JSON.stringify(order);

const ONE_TO_NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** The bytes of a terminal id (window-terminal.ts). */
const ID_BYTES = 6;

/**
 * Sessions 1–9 resumed on the running clock take numbers 1–9; then, while the clock holds, 10 and
 * 11 are resumed one after the other, with terminal ids that fall (10's sorts after 11's), and
 * wait without a number. Returns once the list shows all eleven.
 */
async function twoOpenedWhileHeld(t: TestContext): Promise<{ page: TestPage; list: ListMessage }> {
  const d = serverSandbox(t);
  const ids = Array.from({ length: 11 }, (_, at) => nth(at + 1));
  for (const id of ids) d.resumable(id);
  let heldNs: bigint | null = null;
  let falling = 0xf0;
  const held = (base: Platform): Platform => ({
    ...base,
    clock: { ...base.clock, nowNs: () => heldNs ?? base.clock.nowNs() },
    randomBytes: (count) =>
      heldNs !== null && count === ID_BYTES
        ? Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, falling--)
        : base.randomBytes(count),
  });
  let base: Platform | null = null;
  const server = await d.start({
    platform: (p) => {
      base = p;
      return held(p);
    },
  });
  const page = await connectTestPage(t, d, server.server);
  const resume = async (sessionId: string): Promise<void> => {
    const result = await page.act({ kind: 'resume', sessionId, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  for (const sessionId of ids.slice(0, 9)) await resume(sessionId);
  assert.ok(base !== null);
  heldNs = (base as Platform).clock.nowNs();
  await resume(nth(10));
  await resume(nth(11));
  heldNs = null;
  const numbered = ONE_TO_NINE.map((n) => `${n}:${n}`);
  const list = await openWhere(
    page,
    (open) => reads(numbered)(open.slice(0, 9)) && reads(['10:-', '11:-'])(open.slice(9).sort()),
    'every terminal opened',
  );
  return { page, list };
}

describe('the opening order under a clock that holds (#213)', () => {
  test('Open lists the terminals without a number in the order they were opened', async (t) => {
    const { page } = await twoOpenedWhileHeld(t);
    await openWhere(
      page,
      reads([...ONE_TO_NINE.map((n) => `${n}:${n}`), '10:-', '11:-']),
      'the first opened first',
    );
  });

  test('a freed number goes to the terminal without one that was opened first', async (t) => {
    const { page, list } = await twoOpenedWhileHeld(t);
    const five = list.terminals.find((one) => one.slot === 5)?.id;
    assert.ok(five !== undefined, 'a terminal with number 5');
    page.send({ t: 'input', term: five, data: '/exit\r' });
    await openWhere(
      page,
      reads([...ONE_TO_NINE.map((n) => (n === 5 ? '10:5' : `${n}:${n}`)), '11:-']),
      'the first opened took 5',
    );
  });
});
