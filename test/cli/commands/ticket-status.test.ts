// Follow-up F19 (T4, T8): a ticket's status on the command line. `ticket set` reads the new
// ticket's status at once; `ticket refresh <ref>` reads the session's now, whatever its age (the
// ticket set, else its group's link), `ticket refresh` every listed session's; `show` prints the
// status on the `ticket:` line and a failure's words under it, `show --json` under `ticket`. The
// status command is answered by a runner of the test's own: no program, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ShowJson } from '../../../src/cli/output.ts';
import { EXIT } from '../../../src/cli/exit.ts';
import { main } from '../../../src/cli/main.ts';
import { setGroup, setTicket } from '../../../src/sessions/meta.ts';
import { S1, S2, fakeRunner, runResult } from '../../helpers/platform.ts';
import type { RunCall } from '../../helpers/platform.ts';
import { twoSessions, withRunner } from '../../helpers/session-files.ts';

const MATCH = 'https://tickets.example.com/browse/';
const CONFIG = {
  ticketStatus: [{ match: MATCH, command: ['ticket-status', '{key}', '{url}'] }],
  ticketUrl: `${MATCH}{key}`,
};
const TICKET = `${MATCH}ABC-123`;

/** A runner whose status command prints `stdout` (exit `code`), recording its calls. */
function statusRunner(stdout: string, code = 0, stderr = '') {
  return fakeRunner((call: RunCall) =>
    call.command === 'ticket-status' ? runResult({ stdout, code, stderr }) : runResult({}),
  );
}

test('ticket set reads the status at once and prints it after the address', async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  const runner = statusRunner('In Progress\ndoing\n');

  assert.equal(await main(['ticket', 'set', '0b5f', 'ABC-123'], withRunner(d, runner)), EXIT.ok);

  assert.equal(d.stdout(), `0b5f3c1e ticket: ${TICKET} · In Progress\n`);
  assert.deepEqual(
    runner.calls.map((call) => [call.command, call.args]),
    [['ticket-status', ['ABC-123', TICKET]]],
  );
  assert.equal(d.deck.store.ticketStatuses()[0]?.category, 'doing');
});

test('ticket set of an address no provider reads runs nothing and prints the address alone', async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  const runner = statusRunner('x');
  assert.equal(
    await main(['ticket', 'set', '0b5f', 'https://example.com/x/1'], withRunner(d, runner)),
    EXIT.ok,
  );
  assert.equal(d.stdout(), '0b5f3c1e ticket: https://example.com/x/1\n');
  assert.equal(runner.calls.length, 0);
});

test('ticket refresh <ref> reads now whatever the age; a failure prints its words and keeps the old status', async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  setTicket(d.deck, S1, TICKET);
  assert.equal(
    await main(['ticket', 'refresh', '0b5f'], withRunner(d, statusRunner('Done\ndone'))),
    0,
  );
  assert.equal(d.stdout(), `0b5f3c1e ticket: ${TICKET} · Done\n`);

  const again = statusRunner('', 1, 'tracker: no such issue\n');
  assert.equal(await main(['ticket', 'refresh', '0b5f'], withRunner(d, again)), 0);
  assert.equal(again.calls.length, 1, 'read again at once, though it was just read');
  assert.ok(
    d
      .stdout()
      .endsWith(`0b5f3c1e ticket: ${TICKET} · Done (status not read: tracker: no such issue)\n`),
    d.stdout(),
  );
  const [row] = d.deck.store.ticketStatuses();
  assert.deepEqual([row?.status, row?.error], ['Done', 'tracker: no such issue']);
});

test("ticket refresh <ref> reads a group's link too; without a provider it says so and runs nothing", async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  setGroup(d.deck, S1, 'ABC-123');
  const runner = statusRunner('Blocked\nblocked');
  assert.equal(await main(['ticket', 'refresh', '0b5f'], withRunner(d, runner)), 0);
  assert.equal(d.stdout(), `0b5f3c1e ticket: ${TICKET} · Blocked\n`);

  const none = statusRunner('x');
  assert.equal(await main(['ticket', 'refresh', '1c6a'], withRunner(d, none)), 0);
  assert.ok(d.stdout().endsWith("1c6a4d2f: no status is read for this session's ticket\n"));
  assert.equal(none.calls.length, 0);
});

test('ticket refresh without <ref> reads every listed session’s ticket, one address once', async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  setTicket(d.deck, S1, TICKET);
  setGroup(d.deck, S2, 'ABC-123'); // the same address, through ticketUrl
  const runner = statusRunner('New\ntodo');

  assert.equal(await main(['ticket', 'refresh'], withRunner(d, runner)), 0);

  assert.equal(d.stdout(), 'fetched 1, failed 0\n');
  assert.equal(runner.calls.length, 1);
  assert.ok((await main(['ticket', 'refresh', 'a', 'b'], d.ctx)) === EXIT.usage);
});

test('show: the ticket line ends with the status; a failure adds a line of its words', async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  setTicket(d.deck, S1, TICKET);
  d.deck.store.saveTicketStatus(TICKET, {
    ok: true,
    atNs: 1_794_474_000_000_000_000n,
    status: 'In Review',
    category: 'review',
  });
  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);
  assert.ok(d.stdout().includes(`\nticket:    ${TICKET} · In Review\ndir:`), d.stdout());

  d.deck.store.saveTicketStatus(TICKET, {
    ok: false,
    atNs: 1_794_474_060_000_000_000n,
    error: 'the status command timed out after 10 s',
  });
  const before = d.stdout().length;
  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);
  assert.ok(
    d
      .stdout()
      .slice(before)
      .includes(
        `\nticket:    ${TICKET} · In Review\n           status not read: the status command timed out after 10 s\ndir:`,
      ),
    d.stdout().slice(before),
  );
});

test("show: a group's link gets its status on the one ticket line", async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  setGroup(d.deck, S1, 'ABC-123');
  d.deck.store.saveTicketStatus(TICKET, { ok: true, atNs: 1n, status: 'Done', category: 'done' });
  assert.equal(await main(['show', '0b5f'], d.ctx), EXIT.ok);
  assert.ok(d.stdout().includes(`\nticket:    ${TICKET} · Done\n`), d.stdout());
});

test('show --json: the status, its category, the times and the error under `ticket`', async (t) => {
  const d = twoSessions(t, { config: CONFIG });
  setTicket(d.deck, S1, TICKET);
  d.deck.store.saveTicketStatus(TICKET, {
    ok: true,
    atNs: 1_794_474_000_000_000_000n,
    status: 'In Review',
    category: 'review',
  });
  d.deck.store.saveTicketStatus(TICKET, {
    ok: false,
    atNs: 1_794_474_060_000_000_000n,
    error: 'tracker: down',
  });

  assert.equal(await main(['show', '0b5f', '--json'], d.ctx), EXIT.ok);

  assert.deepEqual((JSON.parse(d.stdout()) as ShowJson).ticket, {
    url: TICKET,
    text: 'ABC-123',
    status: 'In Review',
    category: 'review',
    okAt: '2026-11-12T09:00:00.000Z',
    triedAt: '2026-11-12T09:01:00.000Z',
    error: 'tracker: down',
  });
});
