// Stage B's parts of the server with the mark unread (S2 12.4, 13; server.ts `attentionParts`):
// a mark that changed the facts pushes every page's list at once, marking unread notifies nothing,
// and a `read` is judged by the notifier at once — so that a session read and then ended in its
// window terminal starts to need you again and notifies (`ended`), not as a reason that changed.
// On testPlatform's fake clock through testDeck, with live files the test writes, trusted through
// the fake /proc, as test/window/attention.test.ts does.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Ns } from '../../src/platform/types.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import type { TerminalHub, TerminalInfo } from '../../src/window/hub.ts';
import type { NotifyMessage } from '../../src/window/protocol.ts';
import { attentionParts } from '../../src/window/server.ts';
import type { AttentionParts } from '../../src/window/server.ts';
import type { Tick } from '../../src/window/tick.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, SEC, T0, statLine } from '../helpers/platform.ts';
import { listRow } from '../helpers/rows.ts';

const PID = 4242;
const START = 51234567;
const MS = 1_000_000n;

/** `<claudeHome>/sessions/<pid>.json` for `sessionId` with `status` at `at`, its process trusted. */
function liveFile(d: TestDeck, sessionId: string, status: string, at: Ns): void {
  const ms = Number(at / MS);
  writeFileSync(
    join(d.deck.places.claudeHome, 'sessions', `${PID}.json`),
    JSON.stringify({
      pid: PID,
      sessionId,
      procStart: String(START),
      status,
      updatedAt: ms,
      statusUpdatedAt: ms,
    }),
  );
  d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
}

interface Parts {
  d: TestDeck;
  parts: AttentionParts;
  rows: ListRow[];
  terminals: TerminalInfo[];
  notified: NotifyMessage[];
  pushes: number[];
}

function parts(t: TestContext): Parts {
  const d = testDeck(t);
  const rows: ListRow[] = [listRow({ id: S1, state: 'running' })];
  const terminals: TerminalInfo[] = [];
  const notified: NotifyMessage[] = [];
  const pushes: number[] = [];
  const made = attentionParts({
    deck: d.deck,
    hub: { list: () => terminals } as unknown as TerminalHub,
    tick: () => ({ rows: () => rows, elsewhere: () => new Map() }) as unknown as Tick,
    pages: () => ({
      notify: (message) => {
        notified.push(message);
        return true;
      },
      pushList: () => {
        pushes.push(pushes.length + 1);
      },
    }),
    log: () => undefined,
    storeNewer: () => undefined,
    openOrder: () => [],
  });
  t.after(() => {
    made.seen.stop();
  });
  return { d, parts: made, rows, terminals, notified, pushes };
}

/** S1 finished while nobody looked: one notify `finished`. */
function finished(p: Parts): void {
  liveFile(p.d, S1, 'busy', T0);
  p.parts.tick.look();
  p.parts.tick.refreshed(); // ready: the first judgement records and sends nothing
  liveFile(p.d, S1, 'idle', T0 + SEC);
  p.parts.tick.look();
  assert.deepEqual(
    p.notified.map((one) => one.reason),
    ['finished'],
  );
}

test('a mark that changed the facts pushes the lists at once; marking unread notifies nothing', (t) => {
  const p = parts(t);
  finished(p);
  assert.deepEqual(p.parts.mark(listRow({ id: S1, state: 'running' }), 'read'), { ok: true });
  assert.equal(p.pushes.length, 1);
  assert.deepEqual(p.parts.mark(listRow({ id: S1, state: 'running' }), 'unread'), { ok: true });
  assert.equal(p.pushes.length, 2);
  p.parts.tick.look();
  p.parts.tick.refreshed();
  assert.equal(p.notified.length, 1, 'the mark unread starts to need you for nobody');
  // A refusal pushes nothing.
  p.rows[0] = listRow({ id: S1, done: true });
  assert.equal(p.parts.mark(p.rows[0], 'unread').ok, false);
  assert.equal(p.pushes.length, 2);
});

test('a session read and then ended in its window terminal at the next refresh notifies `ended`', (t) => {
  const p = parts(t);
  finished(p);
  p.parts.mark(listRow({ id: S1, state: 'running' }), 'read');

  p.rows[0] = listRow({ id: S1, marks: ['ended-unexpectedly'] });
  p.terminals.push({
    id: 'aaaaaaaaaaaa',
    slot: 1,
    state: 'ended',
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: PID, procStart: START },
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: { code: null, signal: 1, atNs: String(T0 + 5n * SEC), notStarted: null },
    notReported: false,
  });
  p.parts.tick.refreshed();

  assert.deepEqual(
    p.notified.map((one) => one.reason),
    ['finished', 'ended'],
  );
});
