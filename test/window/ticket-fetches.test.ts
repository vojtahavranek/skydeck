// Follow-up F19 (T4): the server's reads of a ticket's status — one run at a time, so that at most
// one status command runs at a time; what is asked for at once waits for the running run and runs
// whatever its age; the tick's round starts only while nothing runs or waits, reads only what is
// due and starts at most 5 commands; the lists are told after each saved result; the stop aborts.
// On testPlatform, with a runner of the test's own that answers the status command.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Deck } from '../../src/sessions/deck.ts';
import { createSettings } from '../../src/window/settings.ts';
import { createTicketFetches } from '../../src/window/ticket-fetches.ts';
import type { TicketFetches } from '../../src/window/ticket-fetches.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { fakeRunner, runResult } from '../helpers/platform.ts';
import type { RunCall } from '../helpers/platform.ts';

const LIMIT = { timeout: 10_000 };
const MATCH = 'https://tickets.example.com/';
const url = (n: number): string => `${MATCH}t/${n}`;

interface Fixture {
  d: TestDeck;
  tickets: TicketFetches;
  calls: RunCall[];
  /** Lets the held runs answer (each run waits for it while `hold` is on). */
  release(): void;
  hold(on: boolean): void;
  /** The most runs at once so far. */
  most(): number;
  changes(): number;
  logs: string[];
  stop: AbortController;
}

function fixture(t: TestContext, answer = (_call: RunCall) => 'In Progress\ndoing\n'): Fixture {
  const d = testDeck(t, {
    config: { ticketStatus: [{ match: MATCH, command: ['status', '{url}'] }] },
  });
  let holding = false;
  let waiters: (() => void)[] = [];
  let running = 0;
  let most = 0;
  const runner = fakeRunner(async (call) => {
    running++;
    most = Math.max(most, running);
    if (holding) await new Promise<void>((resolve) => waiters.push(resolve));
    else await new Promise((resolve) => setImmediate(resolve));
    running--;
    return runResult({ stdout: answer(call) });
  });
  const deck: Deck = { ...d.deck, platform: { ...d.deck.platform, runner } };
  const stop = new AbortController();
  const logs: string[] = [];
  let changes = 0;
  const tickets = createTicketFetches({
    deck,
    signal: stop.signal,
    changed() {
      changes++;
    },
    log: (line) => logs.push(line),
  });
  const release = (): void => {
    const go = waiters;
    waiters = [];
    for (const resolve of go) resolve();
  };
  t.after(async () => {
    stop.abort();
    holding = false;
    release();
    await tickets.idle();
  });
  return {
    d,
    tickets,
    calls: runner.calls,
    release,
    hold(on) {
      holding = on;
    },
    most: () => most,
    changes: () => changes,
    logs,
    stop,
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert.ok(performance.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  'fetch reads at once in the background and tells the lists after each saved result',
  LIMIT,
  async (t) => {
    const f = fixture(t);
    f.tickets.fetch([url(1), url(2)]);
    await f.tickets.idle();

    assert.deepEqual(
      f.calls.map((call) => call.args),
      [[url(1)], [url(2)]],
    );
    assert.equal(f.changes(), 2);
    assert.deepEqual(
      f.d.deck.store.ticketStatuses().map((row) => [row.url, row.status]),
      [
        [url(1), 'In Progress'],
        [url(2), 'In Progress'],
      ],
    );
  },
);

test(
  'one run at a time: what is asked while one runs waits, then runs together; one command at a time',
  LIMIT,
  async (t) => {
    const f = fixture(t);
    f.hold(true);
    f.tickets.fetch([url(1)]);
    await until(() => f.calls.length === 1, 'the first run started');
    f.tickets.fetch([url(2)]);
    f.tickets.fetch([url(3), url(2)]);
    assert.equal(f.tickets.round([url(4)]), false, 'no round while one runs');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1, 'nothing else started meanwhile');

    f.hold(false);
    f.release();
    await f.tickets.idle();

    assert.deepEqual(
      f.calls.map((call) => call.args[0]),
      [url(1), url(2), url(3)],
    );
    assert.equal(f.most(), 1);
  },
);

test(
  'a fetch reads whatever the age; a round reads only what is due, at most 5 commands',
  LIMIT,
  async (t) => {
    const f = fixture(t);
    f.tickets.fetch([url(1)]);
    await f.tickets.idle();
    f.tickets.fetch([url(1)]);
    await f.tickets.idle();
    assert.equal(f.calls.length, 2, 'asked for at once: read again, though just read');

    const all = Array.from({ length: 8 }, (_, i) => url(i + 1));
    assert.equal(f.tickets.round(all), true);
    await f.tickets.idle();
    // url(1) was just read: not due; of the 7 others only 5 are read in this round.
    assert.deepEqual(
      f.calls.slice(2).map((call) => call.args[0]),
      all.slice(1, 6),
    );
    assert.equal(f.tickets.round(all), true);
    await f.tickets.idle();
    assert.deepEqual(
      f.calls.slice(7).map((call) => call.args[0]),
      all.slice(6, 8),
    );
    assert.equal(f.tickets.round(all), true);
    await f.tickets.idle();
    assert.equal(f.calls.length, 9, 'nothing is due any more');
  },
);

test(
  'a failure is saved and logged by its count, never its words; the old status stays',
  LIMIT,
  async (t) => {
    let text = 'Done\ndone\n';
    const f = fixture(t, () => text);
    f.tickets.fetch([url(1)]);
    await f.tickets.idle();
    text = '';
    f.tickets.fetch([url(1)]);
    await f.tickets.idle();

    const [row] = f.d.deck.store.ticketStatuses();
    assert.deepEqual([row?.status, row?.error], ['Done', 'the status command printed no status']);
    assert.deepEqual(f.logs, ['tickets: 1 of 1 ticket statuses could not be read']);
  },
);

test('the stop aborts the running read: nothing more is saved or started', LIMIT, async (t) => {
  const f = fixture(t);
  f.hold(true);
  f.tickets.fetch([url(1), url(2)]);
  await until(() => f.calls.length === 1, 'the run started');
  f.stop.abort();
  await f.tickets.idle();

  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.d.deck.store.ticketStatuses(), []);
  f.tickets.fetch([url(3)]);
  assert.equal(f.tickets.round([url(3)]), false);
  await f.tickets.idle();
  assert.equal(f.calls.length, 1);
});

test(
  "F36: ticketRefreshMinutes changed in the window is the next round's, without a restart",
  LIMIT,
  async (t) => {
    const f = fixture(t);
    f.tickets.fetch([url(1)]);
    await f.tickets.idle();
    f.d.clock.advanceMs(5 * 60_000);
    assert.equal(f.tickets.round([url(1)]), true);
    await f.tickets.idle();
    assert.equal(f.calls.length, 1, 'read 5 minutes ago: not due at 10 minutes');
    const settings = createSettings({ deck: f.d.deck, log: () => {} });
    assert.equal(settings.set('ticketRefreshMinutes', 2).ok, true);
    assert.equal(f.tickets.round([url(1)]), true);
    await f.tickets.idle();
    assert.equal(f.calls.length, 2, 'due at 2 minutes');
  },
);

test(
  'F36: ticketUrl changed in the window gives the next read its {key}, without a restart',
  LIMIT,
  async (t) => {
    const d = testDeck(t, {
      config: { ticketStatus: [{ match: MATCH, command: ['status', '{key}'] }] },
    });
    const runner = fakeRunner(async () => runResult({ stdout: 'In Progress\ndoing\n' }));
    const deck: Deck = { ...d.deck, platform: { ...d.deck.platform, runner } };
    const tickets = createTicketFetches({
      deck,
      signal: new AbortController().signal,
      changed() {},
      log: () => {},
    });
    // Only ticketUrl's `{key}` finds the key here: no /browse/KEY, and its last part is no key.
    const address = `${MATCH}i/ABC-12/~view`;
    tickets.fetch([address]);
    await tickets.idle();
    assert.equal(runner.calls.length, 0, 'without ticketUrl the address gives no key');
    const settings = createSettings({ deck, log: () => {} });
    assert.equal(settings.set('ticketUrl', `${MATCH}i/{key}/~view`).ok, true);
    tickets.fetch([address]);
    await tickets.idle();
    assert.deepEqual(
      runner.calls.map((call) => [call.command, ...call.args]),
      [['status', 'ABC-12']],
    );
  },
);
