// The favourite flags of the new form end to end on the server (S2 12.6, 10.2; follow-up F15): two
// pages of one server, a favourite added and removed from one, what the other's `list` shows
// (`favourites`) within a second and a half, the kv entry the store holds, and the list a server
// started again reads. In the test process (A19) on realTestPlatform.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ListMessage } from '../../src/window/protocol.ts';
import { connectTestPage, serverSandbox } from '../helpers/window.ts';

const same = (list: ListMessage, favourites: string[]): boolean =>
  JSON.stringify(list.favourites) === JSON.stringify(favourites);

describe('favourites in the window (S2 12.6; F15)', () => {
  test("added from page A: in A's and B's lists within 1.5 s, removed the same way; the store holds them", async (t) => {
    const d = serverSandbox(t);
    const running = await d.start();
    const a = await connectTestPage(t, d, running.server);
    const b = await connectTestPage(t, d, running.server);
    for (const page of [a, b]) await page.list((list) => same(list, []), 'no favourite yet');

    const sent = performance.now();
    const added = await a.act({ kind: 'favourite-add', text: ' --model opus ' });
    assert.equal(added.ok, true, JSON.stringify(added));
    await b.list((list) => same(list, ['--model opus']), 'the favourite in B', 1500);
    assert.ok(performance.now() - sent < 1500, `${Math.round(performance.now() - sent)} ms`);
    await a.list((list) => same(list, ['--model opus']), 'the favourite in A', 1500);
    assert.equal(d.deck.store.getKv('window_favourites'), '["--model opus"]');

    const second = await b.act({ kind: 'favourite-add', text: "--append-system-prompt '<b>'" });
    assert.equal(second.ok, true, JSON.stringify(second));
    await a.list(
      (list) => same(list, ['--model opus', "--append-system-prompt '<b>'"]),
      "B's favourite in A",
      1500,
    );

    const refused = await b.act({ kind: 'favourite-add', text: '--model  "opus"' });
    assert.deepEqual(
      [refused.ok, refused.error],
      [false, 'these flags are a favourite already'],
      'known by its words',
    );

    const removed = await b.act({ kind: 'favourite-remove', text: '--model opus' });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    await a.list((list) => same(list, ["--append-system-prompt '<b>'"]), 'the removal in A', 1500);
    const undone = await a.act({ kind: 'favourite-add', text: '--model opus', at: 0 });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    await b.list(
      (list) => same(list, ['--model opus', "--append-system-prompt '<b>'"]),
      'Undo: back at its old place, in B',
      1500,
    );
  });

  test('a server started again lists the same favourites, in the same order', async (t) => {
    const d = serverSandbox(t);
    const first = await d.start();
    const page = await connectTestPage(t, d, first.server);
    for (const text of ['--model opus', '--verbose', '--add-dir /tmp']) {
      const result = await page.act({ kind: 'favourite-add', text });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal((await page.act({ kind: 'favourite-remove', text: '--verbose' })).ok, true);
    await page.list((list) => same(list, ['--model opus', '--add-dir /tmp']), 'the two left');

    await first.server.stop('the test restarts it');
    const again = await d.start();
    const later = await connectTestPage(t, d, again.server);
    const list = await later.next('list', "the new server's first list");
    assert.deepEqual(list.favourites, ['--model opus', '--add-dir /tmp']);
  });
});
