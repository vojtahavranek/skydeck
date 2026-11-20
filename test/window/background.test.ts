// Follow-up F34: a session Claude Code runs in its background (sent there with /bg or ←, started
// with `claude --bg`, made by /fork) has no terminal of the user's. Its holder runs outside every
// terminal of the window, as a session in another terminal does; what tells the two apart is its
// TRUSTED live-session file's `kind` `bg` (design.md 14). From the files to the row the page gets:
// the live file read, the rows derived and mapped as the server's tick does, the list built.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { mapTerminals } from '../../src/window/mapping.ts';
import type { ElsewherePayload } from '../../src/window/protocol.ts';
import { buildListMessage } from '../../src/window/view/build.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1 } from '../helpers/platform.ts';
import { startRunning, writeTranscript } from '../helpers/session-files.ts';

const PID = 4242;
/** A session id no event names. */
const OTHER = '1c6d4e2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e';

/**
 * The live-session file of `PID` (which `startRunning` wrote from the busy fixture, `kind`
 * `interactive`): written again as `text` when it is a string, else as the fixture's fields with
 * `changes` over them (undefined removes one).
 */
function liveFile(d: TestDeck, change: string | Record<string, unknown>): void {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;
  let text: string;
  if (typeof change === 'string') {
    text = change;
  } else {
    const record: Record<string, unknown> = { ...fixture, pid: PID, sessionId: S1 };
    for (const [name, value] of Object.entries(change)) {
      if (value === undefined) delete record[name];
      else record[name] = value;
    }
    text = JSON.stringify(record);
  }
  writeFileSync(join(d.deck.places.claudeHome, 'sessions', `${PID}.json`), text);
}

/** S1's row as the window lists it, with no terminal of the window: what the server would send. */
function rowOfS1(d: TestDeck): {
  state: string;
  elsewhere: ElsewherePayload | null;
  counts: { elsewhere: number; background?: number };
} {
  refresh(d.deck);
  const rows = loadRows(d.deck);
  const nowNs = d.platform.clock.nowNs();
  const mapping = mapTerminals({
    terminals: [],
    sessions: rows.map((row) => row.session),
    proc: d.platform.proc,
    bootId: d.platform.proc.bootId(),
    nowNs,
    startTimeoutNs: 0n,
  });
  const message = buildListMessage({
    rows,
    terminals: [],
    elsewhere: mapping.elsewhere,
    view: { filter: '', unfolded: [], showDone: false, selected: null },
    selected: null,
    nowNs,
  });
  const row = message.sections.flatMap((section) => section.rows).find((one) => one.id === S1);
  assert.ok(row !== undefined, 'S1 is listed');
  return { state: row.state, elsewhere: row.elsewhere, counts: message.counts };
}

/** A deck where S1 runs outside every terminal of the window, its live file as `change` says. */
function running(t: Parameters<typeof testDeck>[0], change: string | Record<string, unknown>) {
  const d = testDeck(t);
  writeTranscript(d, S1);
  startRunning(d, S1, PID);
  liveFile(d, change);
  return d;
}

test('F34: a trusted live file of kind `bg` makes the row say it runs in Claude Code’s background', (t) => {
  const row = rowOfS1(running(t, { kind: 'bg', jobId: '0b5f3c1e' }));
  assert.deepEqual(row.elsewhere, {
    pid: PID,
    tty: null,
    dir: '/home/dev/projects/demo',
    background: true,
  });
  assert.equal(row.state, 'working', 'its state is read from the file as for any session');
  assert.deepEqual([row.counts.elsewhere, row.counts.background], [0, 1], "the title bar's counts");
});

test('F34: every other live file reads as a session in another terminal, as before', async (t) => {
  const cases: [string, string | Record<string, unknown>][] = [
    ['kind interactive (a session in a terminal)', {}],
    ['no kind at all', { kind: undefined }],
    ['another value', { kind: 'BG' }],
    ['not a string', { kind: ['bg'] }],
    ['a file that is not JSON', '{"kind":"bg",'],
    ['a file of another process that had the pid (untrusted)', { kind: 'bg', procStart: '7' }],
    ['a file without a process start (untrusted)', { kind: 'bg', procStart: undefined }],
    // The process's file is of `kind` `bg` but names another session than the one it holds.
    ['a file naming another session', { kind: 'bg', sessionId: OTHER }],
  ];
  for (const [what, change] of cases) {
    await t.test(what, (t) => {
      const row = rowOfS1(running(t, change));
      assert.deepEqual(row.elsewhere, {
        pid: PID,
        tty: null,
        dir: '/home/dev/projects/demo',
        background: false,
      });
      assert.deepEqual([row.counts.elsewhere, row.counts.background], [1, 0]);
    });
  }
});
