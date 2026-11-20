// Follow-up F33 (S2 12.1, 12.2, 12.8, 12.10): in the window an empty copy that no terminal of the
// window shows is listed as a done session is — only with done ones shown (`a`) or a typed search
// —, open or not; it is in no count of the title bar and no item of the switcher while hidden, and
// is not a done one for the footer. A terminal of the window that shows it keeps it listed,
// whatever else holds. Its row names its original (`copyOf`), and once used it is listed as any.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { DerivedSession, Holder } from '../../../src/sessions/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload, SectionPayload } from '../../../src/window/protocol.ts';
import { buildListMessage } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { ds, meta, rows } from '../../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../../helpers/platform.ts';

const NOW = T0;
const ORIGINAL = S2;
const COPY = S1;
const TITLE = 'made-up title';
const EMPTY = { aiTitle: TITLE, lastUserNs: null, lastTurnRole: null };

function holder(pid: number): Holder {
  return {
    process: { bootId: BOOT_A, pid, procStart: 500 },
    sinceNs: T0,
    live: null,
    scripted: false,
  };
}

/** The original, not running; the copy, running in Claude Code's background (outside the window). */
function sessions(copy: Omit<Parameters<typeof ds>[0], 'id'> = {}): DerivedSession[] {
  return [
    ds({ id: ORIGINAL, transcript: { aiTitle: TITLE }, lastActivityNs: T0 - 60n * SEC }),
    ds({
      id: COPY,
      state: 'running',
      holders: [holder(9000)],
      marks: ['continued', 'empty-copy'],
      continuedFrom: ORIGINAL,
      copyOf: ORIGINAL,
      transcript: EMPTY,
      ...copy,
    }),
  ];
}

function input(
  over: Partial<Omit<ViewInput, 'view'>> & { view?: Partial<ViewInput['view']> } = {},
): ViewInput {
  return {
    rows: rows(sessions()),
    terminals: [],
    elsewhere: new Map([[COPY, { pid: 9000, tty: null }]]),
    selected: null,
    nowNs: NOW,
    ...over,
    view: { filter: '', unfolded: [], showDone: false, selected: null, ...over.view },
  };
}

function section(message: ReturnType<typeof buildListMessage>, name: SectionPayload['name']) {
  const found = message.sections.find((s) => s.name === name);
  assert.ok(found, `no section ${name}`);
  return found;
}

function shownIds(message: ReturnType<typeof buildListMessage>): string[] {
  return message.sections.flatMap((s) => s.rows.map((row) => row.id)).sort();
}

function rowIn(message: ReturnType<typeof buildListMessage>, id: string): RowPayload {
  const row = message.sections.flatMap((s) => s.rows).find((r) => r.id === id);
  assert.ok(row, `no row ${id}`);
  return row;
}

/** A terminal of the window that shows the copy. */
function terminal(over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: '000000000001',
    slot: 1,
    state: 'running',
    expectedSessionId: COPY,
    sessionId: COPY,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4001, procStart: 101 },
    openedNs: T0 - NS_PER_DAY,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

describe('the window: an empty copy no terminal of the window shows', () => {
  test('running in the background: not under Open, in no count, not a done one for the footer', () => {
    const message = buildListMessage(input());
    assert.deepEqual(shownIds(message), [ORIGINAL]);
    assert.equal(section(message, 'open').count, 0);
    assert.deepEqual(message.counts, {
      working: 0,
      waiting: 0,
      running: 0,
      starting: 0,
      elsewhere: 0,
      background: 0,
      notRunning: 1,
    });
    assert.equal(message.doneHidden, 0);
  });

  test('F34: one Claude Code marks as a background session: in no count while hidden, `1 in the background` once `a` shows it', () => {
    const [own] = sessions();
    const copy = sessions()[1];
    assert.ok(own !== undefined && copy !== undefined);
    const live = {
      pid: 9000,
      sessionId: COPY,
      cwd: null,
      procStart: 500,
      entrypoint: 'cli',
      name: null,
      status: 'idle',
      waitingFor: null,
      updatedAtNs: null,
      statusUpdatedAtNs: null,
      background: true,
      mtimeNs: T0,
    };
    const background = rows([own, { ...copy, holders: [{ ...holder(9000), live }] }]);
    const hidden = buildListMessage(input({ rows: background }));
    assert.deepEqual(shownIds(hidden), [ORIGINAL]);
    assert.deepEqual([hidden.counts.background, hidden.counts.elsewhere], [0, 0]);
    const shown = buildListMessage(input({ rows: background, view: { showDone: true } }));
    assert.equal(rowIn(shown, COPY).elsewhere?.background, true);
    assert.deepEqual([shown.counts.background, shown.counts.elsewhere], [1, 0]);
  });

  test('not running: not under Recent either', () => {
    const message = buildListMessage(
      input({ rows: rows(sessions({ state: 'not-running', holders: [] })), elsewhere: new Map() }),
    );
    assert.deepEqual(shownIds(message), [ORIGINAL]);
    assert.equal(section(message, 'week').count, 1);
    assert.equal(message.counts.notRunning, 1);
  });

  test('with done ones shown (`a`): under Open, marked, naming its original', () => {
    const message = buildListMessage(input({ view: { showDone: true } }));
    assert.deepEqual(shownIds(message), [ORIGINAL, COPY].sort());
    const row = rowIn(message, COPY);
    assert.equal(section(message, 'open').rows[0]?.id, COPY);
    assert.deepEqual(row.marks, ['continued', 'empty-copy']);
    assert.deepEqual(row.copyOf, { id: ORIGINAL, title: TITLE, hiddenWhileEmpty: true });
    assert.equal(row.elsewhere?.pid, 9000);
  });

  test('a typed search lists it as it lists a done one', () => {
    const message = buildListMessage(input({ view: { filter: 'made-up' } }));
    assert.equal(message.filtering, true);
    assert.deepEqual(shownIds(message), [ORIGINAL, COPY].sort());
  });

  test('the quick switcher leaves it out while the list hides it; lists it while the list shows it', () => {
    const items = (view: Partial<ViewInput['view']>) =>
      (
        buildListMessage(input({ view: { switcher: 'made-up', ...view } })).switcher?.items ?? []
      ).map((item) => item.row.id);
    assert.deepEqual(items({}), [ORIGINAL]);
    assert.deepEqual(items({ showDone: true }).sort(), [ORIGINAL, COPY].sort());
  });

  test('selected, the view still has its payload (E13), and nothing guards it less: its holder is there', () => {
    const message = buildListMessage(input({ view: { selected: COPY } }));
    assert.equal(message.selectedRow?.id, COPY);
    assert.equal(message.selectedRow?.state, 'running');
    assert.equal(message.selectedRow?.elsewhere?.pid, 9000);
  });

  test('done as well: hidden, and one of the done ones the footer counts', () => {
    const message = buildListMessage(
      input({
        rows: rows(sessions({ state: 'not-running', holders: [], doneAtNs: T0, hidden: true })),
        elsewhere: new Map(),
      }),
    );
    assert.deepEqual(shownIds(message), [ORIGINAL]);
    assert.equal(message.doneHidden, 1);
  });
});

describe('the window: what keeps an empty copy listed', () => {
  test('a terminal of the window that shows it, running: under Open in its slot, counted', () => {
    const message = buildListMessage(input({ terminals: [terminal()], elsewhere: new Map() }));
    assert.deepEqual(shownIds(message), [ORIGINAL, COPY].sort());
    assert.equal(rowIn(message, COPY).terminal, '000000000001');
    assert.equal(rowIn(message, COPY).copyOf?.hiddenWhileEmpty, false);
    assert.equal(message.counts.running, 1);
  });

  test('… running there and marked done: under Open with its done mark (S2 12.10), no done one hidden', () => {
    const message = buildListMessage(
      input({
        rows: rows(sessions({ doneAtNs: T0, hidden: true })),
        terminals: [terminal()],
        elsewhere: new Map(),
      }),
    );
    assert.deepEqual(
      section(message, 'open').rows.map((row) => [row.id, row.done]),
      [[COPY, true]],
    );
    assert.equal(message.doneHidden, 0);
  });

  test('… its program ended (the ended bar): still listed, under Recent', () => {
    const message = buildListMessage(
      input({
        rows: rows(sessions({ state: 'not-running', holders: [] })),
        terminals: [terminal({ state: 'ended', sessionId: null })],
        elsewhere: new Map(),
      }),
    );
    assert.deepEqual(shownIds(message), [ORIGINAL, COPY].sort());
  });

  test('… opened for it and still starting: listed', () => {
    const message = buildListMessage(
      input({
        rows: rows(sessions({ state: 'not-running', holders: [] })),
        terminals: [terminal({ state: 'starting', sessionId: null })],
        elsewhere: new Map(),
      }),
    );
    assert.equal(rowIn(message, COPY).starting, true);
  });

  test('it carries something of the user’s (a label): listed under Open, counted, its mark kept', () => {
    const message = buildListMessage(
      input({ rows: rows(sessions(), { metas: [meta(COPY, { label: 'mine' })] }) }),
    );
    assert.deepEqual(shownIds(message), [ORIGINAL, COPY].sort());
    assert.equal(section(message, 'open').rows[0]?.id, COPY);
    assert.deepEqual(rowIn(message, COPY).marks, ['continued', 'empty-copy']);
    assert.equal(rowIn(message, COPY).copyOf?.hiddenWhileEmpty, false);
    assert.equal(message.counts.elsewhere, 1);
    const items = buildListMessage(
      input({
        rows: rows(sessions(), { metas: [meta(COPY, { label: 'mine' })] }),
        view: { switcher: '' },
      }),
    ).switcher?.items.map((item) => item.row.id);
    assert.deepEqual(items?.sort(), [ORIGINAL, COPY].sort());
  });

  test('… labelled, marked done and running in the background: under Open with its done mark', () => {
    const message = buildListMessage(
      input({
        rows: rows(sessions({ doneAtNs: T0, hidden: true }), {
          metas: [meta(COPY, { label: 'mine', doneAtNs: T0 })],
        }),
      }),
    );
    assert.deepEqual(
      section(message, 'open').rows.map((row) => [row.id, row.done]),
      [[COPY, true]],
    );
    assert.equal(message.doneHidden, 0);
  });

  test('its first turn or input: listed by the usual rules, marked continued only', () => {
    const message = buildListMessage(
      input({
        rows: rows(
          sessions({ marks: ['continued'], transcript: { ...EMPTY, lastTurnRole: 'user' } }),
        ),
      }),
    );
    assert.deepEqual(shownIds(message), [ORIGINAL, COPY].sort());
    const row = rowIn(message, COPY);
    assert.deepEqual(row.marks, ['continued']);
    assert.deepEqual(row.copyOf, { id: ORIGINAL, title: TITLE, hiddenWhileEmpty: false });
    assert.equal(message.counts.elsewhere, 1);
  });

  test('an ordinary session with a title-only transcript is listed as today; its row has no copyOf', () => {
    const message = buildListMessage(
      input({
        rows: rows([ds({ id: S3, state: 'running', holders: [holder(9100)], transcript: EMPTY })]),
        elsewhere: new Map([[S3, { pid: 9100, tty: null }]]),
      }),
    );
    assert.deepEqual(shownIds(message), [S3]);
    assert.equal(rowIn(message, S3).copyOf, null);
  });
});
