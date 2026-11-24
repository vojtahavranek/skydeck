// The view model during a restart (issue #166; S2 7.6, 12.1): a terminal a restart holds keeps its
// session's row under Open, with its number and at its place — also once its program has ended
// and the session reads as not running — until the session's next terminal is there; a kept order
// keeps that place through a freeze; the next terminal, without a number, takes the old one's
// place among those without (`placeNs`). Such a row is not offered for ending (`endable`). Pure.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DerivedSession, Holder } from '../../../src/sessions/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload } from '../../../src/window/protocol.ts';
import { buildListMessage, keptNow } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { ds, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

function termId(n: number): string {
  return n.toString(16).padStart(12, '0');
}

/** A terminal of the window showing `expectedSessionId` (a resume, running). */
function term(
  n: number,
  over: Partial<TerminalInfo> & { expectedSessionId: string },
): TerminalInfo {
  return {
    id: termId(n),
    slot: null,
    state: 'running',
    sessionId: over.expectedSessionId,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4000 + n, procStart: 100 + n },
    openedNs: T0 - 600n * SEC + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    endable: true,
    ...over,
  };
}

const EXIT = { code: 129, signal: null, atNs: String(T0), notStarted: null };

function holder(pid: number, procStart: number): Holder {
  return { process: { bootId: BOOT_A, pid, procStart }, sinceNs: T0, live: null, scripted: false };
}

/** A session held by the program of terminal `n`. */
function runningIn(id: string, n: number): DerivedSession {
  return ds({ id, state: 'working', holders: [holder(4000 + n, 100 + n)] });
}

function input(over: Partial<Omit<ViewInput, 'view'>>): ViewInput {
  return {
    rows: [],
    terminals: [],
    elsewhere: new Map(),
    selected: null,
    nowNs: T0,
    ...over,
    view: { filter: '', unfolded: [], showDone: false, selected: null },
  };
}

function section(message: ReturnType<typeof buildListMessage>, name: string): RowPayload[] {
  return message.sections.find((one) => one.name === name)?.rows ?? [];
}

const drawn = (message: ReturnType<typeof buildListMessage>): string[] =>
  section(message, 'open').map((row) => `${row.id.slice(0, 2)}:${row.slot ?? '-'}`);

test('held while its program runs: the row as before, but not offered for ending; the terminal says restarting', () => {
  const message = buildListMessage(
    input({
      rows: rows([runningIn(S1, 1)]),
      terminals: [term(1, { expectedSessionId: S1, slot: 2, restarting: true })],
    }),
  );
  const row = section(message, 'open')[0];
  assert.deepEqual([row?.id, row?.slot, row?.terminal, row?.endable], [S1, 2, termId(1), false]);
  assert.equal(message.terminals[0]?.restarting, true);
});

test('held after its program ended: the row stays under Open with its number and its terminal, whether the session still reads as running or not', () => {
  for (const session of [runningIn(S1, 1), ds({ id: S1 })]) {
    const message = buildListMessage(
      input({
        rows: rows([session]),
        terminals: [
          term(1, {
            expectedSessionId: S1,
            slot: 2,
            state: 'ended',
            exit: EXIT,
            endable: false,
            restarting: true,
          }),
        ],
      }),
    );
    const row = section(message, 'open')[0];
    assert.deepEqual(
      [row?.id, row?.slot, row?.terminal, row?.starting, row?.endable],
      [S1, 2, termId(1), false, false],
      session.state,
    );
    assert.deepEqual(section(message, 'week'), []);
  }
});

test('not held: an ended terminal’s row is under Recent without a number, as before (F43); its terminal carries no restarting', () => {
  const message = buildListMessage(
    input({
      rows: rows([ds({ id: S1 })]),
      terminals: [
        term(1, { expectedSessionId: S1, slot: 2, state: 'ended', exit: EXIT, endable: false }),
      ],
    }),
  );
  assert.deepEqual(section(message, 'open'), []);
  assert.equal(section(message, 'week')[0]?.slot, null);
  assert.equal(Object.hasOwn(message.terminals[0] ?? {}, 'restarting'), false);
});

test('a kept order keeps a held row’s place through a freeze, its program ended', () => {
  const kept = [S2, S1, S3];
  const message = input({
    rows: rows([runningIn(S2, 2), ds({ id: S1 }), runningIn(S3, 3)]),
    terminals: [
      term(2, { expectedSessionId: S2, slot: 1 }),
      term(1, {
        expectedSessionId: S1,
        slot: 2,
        state: 'ended',
        exit: EXIT,
        endable: false,
        restarting: true,
      }),
      term(3, { expectedSessionId: S3, slot: 3 }),
    ],
    openOrder: kept,
  });
  assert.deepEqual(keptNow(message), kept);
  assert.deepEqual(drawn(buildListMessage(message)), [
    `${S2.slice(0, 2)}:1`,
    `${S1.slice(0, 2)}:2`,
    `${S3.slice(0, 2)}:3`,
  ]);
});

test('without a kept order, among the terminals without a number, the next terminal of a restart takes the old one’s place', () => {
  // S1's terminal was opened first; its restart's next terminal is opened last.
  const first = term(1, { expectedSessionId: S1 });
  const terminals = [
    term(9, { expectedSessionId: S1, openedNs: T0, placeNs: first.openedNs }),
    term(2, { expectedSessionId: S2 }),
    term(3, { expectedSessionId: S3 }),
  ];
  const message = buildListMessage(
    input({ rows: rows([runningIn(S1, 9), runningIn(S2, 2), runningIn(S3, 3)]), terminals }),
  );
  assert.deepEqual(
    section(message, 'open').map((row) => row.id),
    [S1, S2, S3],
  );
  // Without it, opened last, it comes last.
  const plain = buildListMessage(
    input({
      rows: rows([runningIn(S1, 9), runningIn(S2, 2), runningIn(S3, 3)]),
      terminals: terminals.map((one) => {
        const copy = { ...one };
        delete copy.placeNs;
        return copy;
      }),
    }),
  );
  assert.deepEqual(
    section(plain, 'open').map((row) => row.id),
    [S2, S3, S1],
  );
});
