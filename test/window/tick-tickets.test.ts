// Follow-up F19 (T4): the tick offers the server's ticket reads a round over the ticket addresses
// of the sessions the pages listed — only those, only addresses a provider takes, each once —
// at each refresh; while a read runs (the round answers false) the listed sessions are kept for
// the next round. On testPlatform with fakes for everything but the deck.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { setGroup, setTicket } from '../../src/sessions/meta.ts';
import { createTick } from '../../src/window/tick.ts';
import type { Tick } from '../../src/window/tick.ts';
import { testDeck } from '../helpers/deck.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { writeTranscript } from '../helpers/session-files.ts';

const MATCH = 'https://tickets.example.com/browse/';

function fixture(t: TestContext, busy = (): boolean => false): { tick: Tick; rounds: string[][] } {
  const d = testDeck(t, {
    config: {
      ticketStatus: [{ match: MATCH, command: ['status', '{key}'] }],
      ticketUrl: `${MATCH}{key}`,
    },
  });
  for (const id of [S1, S2, S3]) writeTranscript(d, id);
  setTicket(d.deck, S1, `${MATCH}ABC-1`);
  setGroup(d.deck, S2, 'ABC-1'); // the same address, through the group's key
  setTicket(d.deck, S3, 'https://example.com/other/1'); // no provider
  const rounds: string[][] = [];
  const tick = createTick({
    deck: d.deck,
    hub: { list: () => [], close: () => 'ok', setSession: () => {} },
    pages: { pushList: () => {}, notice: () => {} },
    keepAlive: { tick: async () => {} },
    interop: { refresh: async () => null },
    keepersLog: join(d.deck.places.stateDir, 'keepers.log'),
    log: () => {},
    storeNewer: () => {},
    tickets: {
      round(urls) {
        rounds.push([...urls]);
        return !busy();
      },
    },
  });
  t.after(() => tick.stop());
  return { tick, rounds };
}

/** Two seconds of the tick: one refresh. */
async function refreshOnce(tick: Tick): Promise<void> {
  await tick.run();
  await tick.run();
}

test("a round over the listed sessions' ticket addresses that a provider takes, each address once", async (t) => {
  const { tick, rounds } = fixture(t);
  await refreshOnce(tick); // the rows are loaded
  assert.deepEqual(rounds, [], 'nothing listed: no round');

  tick.listed([S1, S2, S3]);
  await refreshOnce(tick);
  assert.deepEqual(rounds, [[`${MATCH}ABC-1`]]);

  await refreshOnce(tick);
  assert.equal(rounds.length, 1, 'no session listed since: no round');
  tick.listed([S3]);
  await refreshOnce(tick);
  assert.equal(rounds.length, 1, 'a session without a provider: no round');
});

test('a session that is not listed is not read', async (t) => {
  const { tick, rounds } = fixture(t);
  await refreshOnce(tick);
  tick.listed([S2]);
  await refreshOnce(tick);
  assert.deepEqual(rounds, [[`${MATCH}ABC-1`]]);
});

test('while a read runs the listed sessions are kept for the next round', async (t) => {
  let busy = true;
  const { tick, rounds } = fixture(t, () => busy);
  await refreshOnce(tick);
  tick.listed([S1]);
  await refreshOnce(tick);
  busy = false;
  await refreshOnce(tick);
  assert.deepEqual(rounds, [[`${MATCH}ABC-1`], [`${MATCH}ABC-1`]]);
  await refreshOnce(tick);
  assert.equal(rounds.length, 2);
});
