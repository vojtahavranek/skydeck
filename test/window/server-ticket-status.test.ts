// Follow-up F19 end to end on the server (T2, T4, T6, T7): a ticket's status read by a stand-in
// program of the test's own — a small script in the sandbox's home, run by this test's node; no
// network, no real gh — through a `ticketStatus` rule. A ticket set is read at once and every
// page's list shows it (the row's `ticketStatus` and the header's `selected.ticketStatus`); a
// failure keeps the old status beside its words; ↻ (`act ticket-refresh`) reads it again now; the
// tick reads the ticket of a listed session that was never tried, one address shared by two
// sessions once; one command runs at a time; the value is there for a server started again. The
// rule names the script by a path relative to the home directory: the command runs there.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { setGroup } from '../../src/sessions/meta.ts';
import type { ListMessage } from '../../src/window/protocol.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const MATCH = 'https://tickets.example.com/browse/';
const TICKET = `${MATCH}ABC-123`;
const SCRIPT = 'status-standin.mjs';

/**
 * The stand-in: records each run's start and end with its arguments and its working directory in
 * status/calls.jsonl, and answers as status/answer.json says, after its delay. Paths are relative:
 * it runs in the home directory.
 */
const STANDIN = `
import { appendFileSync, readFileSync } from 'node:fs';
const record = (what) =>
  appendFileSync('status/calls.jsonl', JSON.stringify({ what, args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
record('start');
const answer = JSON.parse(readFileSync('status/answer.json', 'utf8'));
setTimeout(() => {
  process.stdout.write(answer.stdout ?? '');
  process.stderr.write(answer.stderr ?? '');
  record('end');
  process.exitCode = answer.code ?? 0;
}, answer.delayMs ?? 0);
`;

interface Answer {
  stdout?: string;
  stderr?: string;
  code?: number;
  delayMs?: number;
}

interface World {
  d: ServerSandbox;
  answer(value: Answer): void;
  calls(): { what: string; args: string[]; cwd: string }[];
}

/** A server sandbox whose config has the rule; the stand-in in its home answers `first`. */
function world(t: TestContext, first: Answer, config: Record<string, unknown> = {}): World {
  const d = serverSandbox(t, {
    config: {
      ticketStatus: [{ match: MATCH, command: [process.execPath, SCRIPT, '{url}', '{key}'] }],
      ticketUrl: `${MATCH}{key}`,
      ...config,
    },
  });
  const dir = join(d.s.home, 'status');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(d.s.home, SCRIPT), STANDIN);
  const answer = (value: Answer): void => {
    writeFileSync(join(dir, 'answer.json'), JSON.stringify(value));
  };
  answer(first);
  return {
    d,
    answer,
    calls() {
      try {
        return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as { what: string; args: string[]; cwd: string });
      } catch {
        return [];
      }
    },
  };
}

/** A page of `server` with `sessionId` selected, once its list carries that `selected`. */
async function pageOn(
  t: TestContext,
  d: ServerSandbox,
  server: TestServer['server'],
  sessionId: string,
): Promise<TestPage> {
  const page = await connectTestPage(t, d, server, { view: { selected: sessionId } });
  await page.list((list) => list.selected?.sessionId === sessionId, `${sessionId} selected`);
  return page;
}

function rowOf(list: ListMessage, id: string) {
  return rowsOf(list).find((row) => row.id === id);
}

describe("a ticket's status in the window (F19)", () => {
  test('set from page A: read at once in the home directory, and both pages show it — the row and the header', async (t) => {
    const w = world(t, { stdout: 'In Progress\ndoing\n' });
    w.d.resumable(S1);
    const test = await w.d.start();
    const a = await pageOn(t, w.d, test.server, S1);
    const b = await pageOn(t, w.d, test.server, S1);

    const set = await a.act({ kind: 'ticket', sessionId: S1, text: 'ABC-123' });
    assert.deepEqual([set.ok, set.error], [true, null]);

    const seen = await b.list(
      (list) =>
        list.selected?.ticketStatus?.status === 'In Progress' &&
        rowOf(list, S1)?.ticketStatus?.status === 'In Progress',
      'the status in page B',
      10_000,
    );
    assert.deepEqual(rowOf(seen, S1)?.ticketStatus, {
      name: 'ABC-123',
      status: 'In Progress',
      category: 'doing',
    });
    const selected = seen.selected?.ticketStatus;
    assert.deepEqual(
      [selected?.url, selected?.name, selected?.stored, selected?.category, selected?.error],
      [TICKET, 'ABC-123', true, 'doing', null],
    );
    assert.ok(selected?.okAtNs !== null && selected?.okAtNs === selected?.triedAtNs);
    await a.list((list) => rowOf(list, S1)?.ticketStatus?.status === 'In Progress', 'in page A');
    const [start] = w.calls();
    assert.deepEqual(start, { what: 'start', args: [TICKET, 'ABC-123'], cwd: w.d.s.home });
  });

  test('a failure keeps the old status beside its words; ↻ reads it again now, whatever its age', async (t) => {
    const w = world(t, { stdout: 'In Review\nreview\n' });
    w.d.resumable(S1);
    const test = await w.d.start();
    const page = await pageOn(t, w.d, test.server, S1);
    await page.act({ kind: 'ticket', sessionId: S1, text: TICKET });
    await page.list((list) => list.selected?.ticketStatus?.status === 'In Review', 'read', 10_000);

    w.answer({ code: 1, stderr: 'tracker: down for maintenance\n' });
    const refreshed = await page.act({ kind: 'ticket-refresh', sessionId: S1 });
    assert.deepEqual([refreshed.ok, refreshed.error], [true, null]);

    const failed = await page.list(
      (list) => list.selected?.ticketStatus?.error === 'tracker: down for maintenance',
      'the failure',
      10_000,
    );
    assert.equal(failed.selected?.ticketStatus?.status, 'In Review');
    assert.equal(failed.selected?.ticketStatus?.category, 'review');
    assert.notEqual(
      failed.selected?.ticketStatus?.okAtNs,
      failed.selected?.ticketStatus?.triedAtNs,
    );
    assert.deepEqual(rowOf(failed, S1)?.ticketStatus, {
      name: 'ABC-123',
      status: 'In Review',
      category: 'review',
    });
    assert.equal(w.calls().filter((call) => call.what === 'start').length, 2);
  });

  test('↻ for a session whose ticket no provider reads is refused with words; nothing runs', async (t) => {
    const w = world(t, { stdout: 'x' });
    w.d.resumable(S1);
    const test = await w.d.start();
    const page = await pageOn(t, w.d, test.server, S1);
    await page.act({ kind: 'ticket', sessionId: S1, text: 'https://example.com/other/1' });
    const result = await page.act({ kind: 'ticket-refresh', sessionId: S1 });
    assert.deepEqual(
      [result.ok, result.error],
      [false, "no status is read for this session's ticket"],
    );
    const list = await page.list((l) => l.selected?.ticket !== null, 'the ticket');
    assert.equal(list.selected?.ticketStatus, null);
    assert.equal(rowOf(list, S1)?.ticketStatus, null);
    assert.deepEqual(w.calls(), []);
  });

  test("the tick reads listed sessions' tickets that were never tried: one address of two sessions once, one command at a time", async (t) => {
    const w = world(t, { stdout: 'Blocked\nblocked\n', delayMs: 150 });
    w.d.resumable(S1);
    w.d.resumable(S2);
    // Both through the group's key: the same address, never set by hand.
    setGroup(w.d.deck, S1, 'ABC-123');
    setGroup(w.d.deck, S2, 'ABC-123');
    const other = await w.d.start();
    const page = await connectTestPage(t, w.d, other.server, { view: { selected: S2 } });

    const shown = await page.list(
      (list) =>
        rowOf(list, S1)?.ticketStatus?.status === 'Blocked' &&
        rowOf(list, S2)?.ticketStatus?.status === 'Blocked',
      'both rows read by the tick',
      15_000,
    );
    assert.equal(shown.selected?.ticketStatus?.stored, false, "the group's link");
    assert.deepEqual(
      w.calls().map((call) => call.what),
      ['start', 'end'],
      'one run for the one address',
    );
  });

  test('two tickets set at once run one after the other, never side by side', async (t) => {
    const w = world(t, { stdout: 'New\ntodo\n', delayMs: 300 });
    w.d.resumable(S1);
    w.d.resumable(S2);
    const test = await w.d.start();
    const page = await pageOn(t, w.d, test.server, S1);
    await Promise.all([
      page.act({ kind: 'ticket', sessionId: S1, text: 'ABC-1' }),
      page.act({ kind: 'ticket', sessionId: S2, text: 'ABC-2' }),
    ]);
    await page.list(
      (list) =>
        rowOf(list, S1)?.ticketStatus?.status === 'New' &&
        rowOf(list, S2)?.ticketStatus?.status === 'New',
      'both read',
      15_000,
    );
    assert.deepEqual(
      w.calls().map((call) => call.what),
      ['start', 'end', 'start', 'end'],
    );
  });

  test('a server started again sends the status read before', async (t) => {
    const w = world(t, { stdout: 'Done\ndone\n' });
    w.d.resumable(S1);
    const first = await w.d.start();
    const page = await pageOn(t, w.d, first.server, S1);
    await page.act({ kind: 'ticket', sessionId: S1, text: 'ABC-123' });
    await page.list((list) => list.selected?.ticketStatus?.status === 'Done', 'read', 10_000);
    await first.server.stop('the test restarts it');

    const again = await w.d.start();
    const list = await (
      await connectTestPage(t, w.d, again.server, { view: { selected: S1 } })
    ).list((l) => l.selected?.ticketStatus?.status === 'Done', 'after the restart');
    assert.deepEqual(rowOf(list, S1)?.ticketStatus, {
      name: 'ABC-123',
      status: 'Done',
      category: 'done',
    });
    // Done is read again only after 12 hours: the new server ran nothing.
    assert.equal(w.calls().filter((call) => call.what === 'start').length, 1);
  });
});
