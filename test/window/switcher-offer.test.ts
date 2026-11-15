// The restore offer in the quick switcher (S2 12.7; plan E12, task 98): `listFor` sets the list's
// `switcher.restore` from stage C's banner — only in command form (the text's first character is
// `>` and what follows names `restore`), only while the banner is not shown, holds preselected
// entries and no restore runs. A real test server (A19, realTestPlatform) with sessions of an
// earlier boot made by stage C's helper (test/helpers/window-restore.ts, task 74); every program
// is held at a gate, so that a case waits on what happened, not on a time.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_MINUTE } from '../../src/platform/time.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { until } from '../helpers/keeper.ts';
import { connectTestPage, WAIT_MS } from '../helpers/window.ts';
import type { TestPage } from '../helpers/window.ts';
import { EARLIER_BOOT, earlierId, restoreSandbox } from '../helpers/window-restore.ts';
import type { RestoreSandbox } from '../helpers/window-restore.ts';

const X1 = earlierId(1);
const X2 = earlierId(2);
const X3 = earlierId(3);

/** Three sessions of an earlier boot, in list order X3, X2, X1; X2 ended long before the boot's
 *  last event, so design 7.8 does not preselect it: the offer holds X3 and X1. */
function threeSessions(r: RestoreSandbox): void {
  const lastNs = r.d.platform.clock.nowNs() - 30n * NS_PER_MINUTE;
  const minutes = (n: number): bigint => BigInt(n) * NS_PER_MINUTE;
  r.earlierBoot([
    { sessionId: X1, startNs: lastNs - minutes(50) },
    { sessionId: X2, startNs: lastNs - minutes(40), endNs: lastNs - minutes(20) },
    { sessionId: X3, startNs: lastNs - minutes(30), endNs: lastNs },
  ]);
}

type Switcher = NonNullable<ListMessage['switcher']>;

/** Sends a view with the switcher's `text` and waits for the list that answers it. */
async function switcherFor(page: TestPage, text: string): Promise<Switcher> {
  page.view({ switcher: text });
  const list = await page.list(
    (l) => l.switcher?.query === text,
    `the switcher's answer to ${JSON.stringify(text)}`,
  );
  assert.ok(list.switcher !== undefined && list.switcher !== null);
  return list.switcher;
}

/** The first list whose banner offers the three sessions. */
async function offered(page: TestPage): Promise<ListMessage> {
  return page.list(
    (l) => l.banner !== null && l.banner.entries.length === 3,
    'a banner that offers the three sessions',
  );
}

describe('the restore offer in the switcher (S2 12.7, plan E12)', () => {
  test('while the banner is shown: `>restore` lists neither the offer nor a session', async (t) => {
    const r = restoreSandbox(t);
    threeSessions(r);
    const running = await r.d.start();
    const page = await connectTestPage(t, r.d, running.server);
    const first = await offered(page);
    assert.equal(first.banner?.shown, true);
    for (const text of ['>restore', '> rest', '>r']) {
      const answer = await switcherFor(page, text);
      assert.equal(answer.restore, null, `${text}: no offer while the banner is shown`);
      assert.equal(answer.command, true, `${text}: command form`);
      assert.deepEqual([answer.items, answer.more], [[], 0], `${text}: no session`);
    }
  });

  test("after Not now: `''`, `restore` and `restore x` search sessions only; `>restore` and `> rest` list the offer with the preselected ids in the banner's order and no session; `>` and `> foo` list neither", async (t) => {
    const r = restoreSandbox(t);
    threeSessions(r);
    const running = await r.d.start();
    const page = await connectTestPage(t, r.d, running.server);
    const first = await offered(page);
    const banner = first.banner;
    assert.ok(banner !== null);
    assert.deepEqual(
      banner.entries.filter((entry) => entry.preselected).map((entry) => entry.sessionId),
      [X3, X1],
      'the banner preselects X3 and X1, in its order',
    );
    const dismissed = await page.act({ kind: 'dismiss-restore', bootId: EARLIER_BOOT });
    assert.equal(dismissed.ok, true, dismissed.error ?? '');
    await page.list((l) => l.banner?.shown === false, 'the banner no longer shown');

    for (const text of ['', 'restore', 'restore x', ' >restore']) {
      const answer = await switcherFor(page, text);
      assert.equal(answer.restore, null, `${JSON.stringify(text)}: sessions only, no offer`);
      assert.equal(answer.command, false, `${JSON.stringify(text)}: not command form`);
    }
    assert.ok((await switcherFor(page, '')).items.length >= 3, 'an empty text lists every session');
    for (const text of ['>restore', '> rest', '>Restore', '> RESTORE']) {
      const answer = await switcherFor(page, text);
      assert.deepEqual(
        answer.restore,
        { count: 2, lastActivityNs: banner.lastActivityNs, sessionIds: [X3, X1] },
        `${text}: the offer`,
      );
      assert.equal(answer.command, true);
      assert.deepEqual([answer.items, answer.more], [[], 0], `${text}: no session`);
    }
    for (const text of ['>', '> foo']) {
      const answer = await switcherFor(page, text);
      assert.equal(answer.restore, null, `${text}: no offer`);
      assert.deepEqual([answer.command, answer.items], [true, []], `${text}: no session`);
    }
  });

  test('while a restore runs: `>restore` lists no offer (E12, ruled)', async (t) => {
    // The gates are held while the case looks: no start may time out meanwhile.
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    threeSessions(r);
    const running = await r.d.start();
    const page = await connectTestPage(t, r.d, running.server);
    await offered(page);
    const dismissed = await page.act({ kind: 'dismiss-restore', bootId: EARLIER_BOOT });
    assert.equal(dismissed.ok, true, dismissed.error ?? '');
    await page.list((l) => l.banner?.shown === false, 'the banner no longer shown');
    assert.notEqual((await switcherFor(page, '>restore')).restore, null, 'offered before the run');

    const result = await page.act({ kind: 'restore', sessionIds: [X3, X1] });
    assert.equal(result.ok, true, result.error ?? '');
    await until(() => r.waiting(X3) || r.waiting(X1), 'a session of the run at its gate', WAIT_MS);
    await page.list((l) => l.banner?.running === true, 'the banner says a restore runs');
    const during = await switcherFor(page, '> restore');
    assert.equal(during.restore, null, 'no offer while a restore runs');
    assert.deepEqual([during.command, during.items], [true, []]);
    r.open(X3);
    r.open(X1);
  });
});
