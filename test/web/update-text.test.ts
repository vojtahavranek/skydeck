// Follow-up F38's words for the update notice (web/update-text.js): when the title bar's control
// shows, what the dialog says for each answer of the server's look (the notes, the fold of the
// other changes in its three forms, the database note, the bottom lines, the blocked form), the
// settings screen's block `Updates`, and (milestone 2) Update now, its running form and the bars.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { UpdateCheckPayload, UpdatePayload } from '../../src/window/protocol.ts';
import {
  awayParts,
  blockText,
  dialogModel,
  offersUpdateNow,
  resultText,
  runningLine,
  runningRuns,
  settingsLines,
  showsNotice,
  UPDATE_TEXTS,
} from '../../web/update-text.js';
import type { DialogModel } from '../../web/update-text.js';

const SEC = 1_000_000_000n;
const NOW = 1_794_474_000_000_000_000n;
const ago = (seconds: bigint): string => String(NOW - seconds * SEC);

type Available = Extract<UpdateCheckPayload, { state: 'available' }>;

const NOTE = {
  title: [{ text: 'Parked: set a session aside', code: false }],
  paragraphs: [
    [
      { text: 'Press ', code: false },
      { text: 'w', code: true },
      { text: ' on a session.', code: false },
    ],
  ],
};
const AVAILABLE: Available = {
  state: 'available',
  summary: '4 new commits on origin/main',
  from: '1546b37aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  to: 'c75af0ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  versions: null,
  upstream: 'origin/main',
  notes: [NOTE],
  moreNotes: 0,
  others: ['three', 'two', 'one'],
  otherCount: 3,
  upgradesDatabase: false,
  blocked: null,
};
const available = (over: Partial<Available> = {}): Available => ({ ...AVAILABLE, ...over });

/** The body as it reads: each block's text, the fold as `[fold] <label>` and its items as `- <item>`. */
function reads(model: DialogModel): string[] {
  return [
    ...model.before.map(blockText),
    ...(model.fold === null
      ? []
      : [
          `[fold${model.fold.openAtStart ? ' open' : ''}] ${model.fold.label}`,
          ...model.fold.items.map((item) => `- ${item}`),
        ]),
    ...model.after.map(
      (block) => `${block.kind === 'line' ? '' : `(${block.kind}) `}${blockText(block)}`,
    ),
  ];
}
const CURRENT: UpdateCheckPayload = {
  state: 'current',
  summary: 'skydeck is up to date (main at 0123456, as origin/main)',
};

function payload(over: Partial<UpdatePayload> = {}): UpdatePayload {
  return {
    checking: false,
    check: AVAILABLE,
    checkedAtNs: ago(90n),
    fetchedAtNs: ago(90n),
    failure: null,
    applying: null,
    version: null,
    log: '/state/update.log',
    result: null,
    ...over,
  };
}

describe('showsNotice', () => {
  test('exactly while a newer version is known', () => {
    assert.equal(showsNotice(payload()), true);
    assert.equal(showsNotice(payload({ failure: { atNs: ago(1n), line: 'x' } })), true);
    assert.equal(showsNotice(payload({ check: CURRENT })), false);
    assert.equal(showsNotice(payload({ check: { state: 'cannot', summary: 'no' } })), false);
    assert.equal(showsNotice(payload({ check: null })), false);
    assert.equal(showsNotice(null), false);
  });
});

describe("the dialog's body", () => {
  test('available: the notes, the fold of the other changes (folded), the commits and the command at the bottom', () => {
    const model = dialogModel(AVAILABLE);
    assert.deepEqual(reads(model), [
      'Parked: set a session aside Press w on a session.',
      '[fold] 3 other changes',
      '- three',
      '- two',
      '- one',
      '(meta) 1546b37 → c75af0e on origin/main',
      '(meta) In a terminal instead: skydeck update',
    ]);
    assert.deepEqual(model.before[0], { kind: 'note', ...NOTE });
    // The ids and the command in the terminal's font.
    assert.deepEqual(
      model.after.flatMap((block) =>
        block.kind === 'note' ? [] : block.runs.filter((run) => run.code).map((run) => run.text),
      ),
      ['1546b37', 'c75af0e', 'skydeck update'],
    );
    assert.equal(UPDATE_TEXTS.terminal, 'In a terminal instead: skydeck update');
  });

  test("the bottom line with the versions the server gives: `<old> → <new> on <upstream>`, then the ids small after it in the terminal's font", () => {
    const model = dialogModel(available({ versions: '0.9.16 → 0.9.19' }));
    assert.deepEqual(reads(model).slice(-2), [
      '(meta) 0.9.16 → 0.9.19 on origin/main  1546b37 → c75af0e',
      '(meta) In a terminal instead: skydeck update',
    ]);
    const meta = model.after.at(-2);
    assert.ok(meta !== undefined && meta.kind === 'meta');
    assert.deepEqual(meta.runs, [
      { text: '0.9.16 → 0.9.19 on origin/main  ', code: false },
      { text: '1546b37', code: true },
      { text: ' → ', code: false },
      { text: 'c75af0e', code: true },
    ]);
  });

  test('the fold line: one other change; no note at all, `<n> changes` open from the start; no other change, none', () => {
    assert.equal(
      dialogModel(available({ others: ['one'], otherCount: 1 })).fold?.label,
      '1 other change',
    );
    const none = dialogModel(available({ notes: [] }));
    assert.deepEqual(none.fold, {
      label: '3 changes',
      openAtStart: true,
      items: ['three', 'two', 'one'],
    });
    assert.equal(
      dialogModel(available({ notes: [], others: ['one'], otherCount: 1 })).fold?.label,
      '1 change',
    );
    assert.equal(dialogModel(available({ others: [], otherCount: 0 })).fold, null);
  });

  test('no note shown but notes not read (moreNotes): the update brings notes, so the fold reads `other changes`, folded', () => {
    const model = dialogModel(available({ notes: [], moreNotes: 3 }));
    assert.deepEqual(model.fold, {
      label: '3 other changes',
      openAtStart: false,
      items: ['three', 'two', 'one'],
    });
    assert.equal(blockText(model.before[0]!), '… and 3 more');
  });

  test('more notes and more other changes than listed: … and <n> more', () => {
    const model = dialogModel(available({ notes: [NOTE, NOTE], moreNotes: 3, otherCount: 25 }));
    assert.equal(blockText(model.before.at(-1) ?? model.before[0]!), '… and 3 more');
    assert.deepEqual(model.fold?.items.at(-1), '… and 22 more');
    assert.equal(model.fold?.label, '25 other changes');
    assert.equal(model.fold?.openAtStart, false);
  });

  test('the database note: a marked block before the bottom lines, naming the commit to go back to', () => {
    const model = dialogModel(available({ upgradesDatabase: true }));
    assert.deepEqual(reads(model).slice(-3), [
      '(database) This update may upgrade the database. A copy is kept first; an older skydeck cannot open it afterwards. Going back to 1546b37: docs/install.md, "Going back".',
      '(meta) 1546b37 → c75af0e on origin/main',
      '(meta) In a terminal instead: skydeck update',
    ]);
  });

  test('blocked: the notes and the fold as for one that can be applied, then why and the command once that is set right; no terminal line', () => {
    const blocked =
      'this checkout has changes that are not committed (1 file, the first: a.txt); commit or undo them first';
    const model = dialogModel(available({ blocked, upgradesDatabase: true }));
    assert.deepEqual(reads(model).slice(0, 2), [
      'Parked: set a session aside Press w on a session.',
      '[fold] 3 other changes',
    ]);
    assert.deepEqual(reads(model).slice(-4), [
      expectDatabase(),
      `This checkout cannot be updated as it is: ${blocked}`,
      'Once that is set right, in a WSL terminal of your own: skydeck update',
      '(meta) 1546b37 → c75af0e on origin/main',
    ]);
    assert.equal(blockText(model.after[2]!), UPDATE_TEXTS.setRight);
  });

  test('a refusal of Update now: under the answer, before the bottom lines', () => {
    const model = dialogModel(
      AVAILABLE,
      'a check for updates is running; try again once it has ended',
    );
    assert.deepEqual(reads(model).slice(-3), [
      'a check for updates is running; try again once it has ended',
      '(meta) 1546b37 → c75af0e on origin/main',
      '(meta) In a terminal instead: skydeck update',
    ]);
  });

  test('current: its summary alone', () => {
    assert.deepEqual(reads(dialogModel(CURRENT)), [CURRENT.summary]);
  });

  test('cannot: why skydeck cannot tell, then the command once that is set right', () => {
    const line = 'the branch main follows no branch of a remote; update it with git yourself';
    const model = dialogModel({ state: 'cannot', summary: line });
    assert.deepEqual(reads(model), [
      `skydeck cannot tell here whether there is an update: ${line}`,
      'Once that is set right, in a WSL terminal of your own: skydeck update',
    ]);
    assert.equal(model.fold, null);
  });

  test('none yet', () => {
    assert.deepEqual(reads(dialogModel(null)), ['No check was made yet.']);
  });
});

/** The database note as reads() gives it. */
function expectDatabase(): string {
  return '(database) This update may upgrade the database. A copy is kept first; an older skydeck cannot open it afterwards. Going back to 1546b37: docs/install.md, "Going back".';
}

describe("the settings screen's block", () => {
  test('the version the server gives comes first, `skydeck <version>`; none before it does', () => {
    assert.deepEqual(settingsLines(payload({ version: '0.9.16' }), String(NOW)), [
      'skydeck 0.9.16',
      'Last check: 1m ago — 4 new commits on origin/main',
    ]);
    assert.deepEqual(settingsLines(payload({ version: '0.9', check: null }), String(NOW)), [
      'skydeck 0.9',
      UPDATE_TEXTS.never,
    ]);
    assert.deepEqual(settingsLines(payload({ version: null }), String(NOW)), [
      'Last check: 1m ago — 4 new commits on origin/main',
    ]);
  });

  test('the last check with its age and summary', () => {
    assert.deepEqual(settingsLines(payload(), String(NOW)), [
      'Last check: 1m ago — 4 new commits on origin/main',
    ]);
    assert.deepEqual(
      settingsLines(payload({ check: CURRENT, checkedAtNs: ago(0n) }), String(NOW)),
      [`Last check: 0s ago — ${CURRENT.summary}`],
    );
  });

  test("the age is the last check's end, whatever it found, not the last fetch that worked", () => {
    // A check that ended `cannot` a moment ago, after a fetch that worked three days before.
    const line = 'this checkout is not on a branch (detached HEAD); update it with git yourself';
    assert.deepEqual(
      settingsLines(
        payload({
          check: { state: 'cannot', summary: line },
          checkedAtNs: ago(2n),
          fetchedAtNs: ago(3n * 86_400n),
        }),
        String(NOW),
      ),
      [`Last check: 2s ago — ${line}`],
    );
  });

  test('a failure beside a known outcome: when and why first, then what is known and from when', () => {
    const failure = { atNs: ago(5n), line: 'git fetch from origin failed: fatal: gone' };
    assert.deepEqual(settingsLines(payload({ failure }), String(NOW)), [
      'The last check failed 5s ago: git fetch from origin failed: fatal: gone',
      'Known from 1m ago: 4 new commits on origin/main',
    ]);
  });

  test('a check that failed is its own cannot: its line once, with its age', () => {
    for (const line of [
      'skydeck could not check for an update (Error (EAGAIN))',
      'git symbolic-ref failed: no answer within 10 s; nothing was changed',
    ]) {
      const update = payload({
        check: { state: 'cannot', summary: line },
        checkedAtNs: ago(0n),
        failure: { atNs: ago(0n), line },
      });
      assert.deepEqual(settingsLines(update, String(NOW)), [
        `The last check failed 0s ago: ${line}`,
      ]);
    }
  });

  test('a failure with nothing fetched before', () => {
    const failure = { atNs: ago(5n), line: 'git fetch from origin failed: no answer within 60 s' };
    assert.deepEqual(
      settingsLines(payload({ check: CURRENT, fetchedAtNs: null, failure }), String(NOW)),
      [
        'The last check failed 5s ago: git fetch from origin failed: no answer within 60 s',
        'Nothing was fetched before.',
      ],
    );
  });

  test('a look that could not tell, with no fetch: its line', () => {
    const line = 'the branch main follows no branch of a remote; update it with git yourself';
    assert.deepEqual(
      settingsLines(
        payload({
          check: { state: 'cannot', summary: line },
          checkedAtNs: null,
          fetchedAtNs: null,
        }),
        String(NOW),
      ),
      [`Last check: ${line}`],
    );
  });

  test('no check yet; Checking… while one runs', () => {
    assert.deepEqual(settingsLines(null, String(NOW)), [UPDATE_TEXTS.never]);
    assert.deepEqual(settingsLines(payload({ check: null, fetchedAtNs: null }), ''), [
      'No check was made yet.',
    ]);
    assert.deepEqual(settingsLines(payload({ check: null, checking: true }), String(NOW)), [
      'No check was made yet.',
      'Checking…',
    ]);
  });
});

describe('Update now, its running form and the bars (milestone 2)', () => {
  test('Update now is offered only for an update that can be applied as it is', () => {
    assert.equal(offersUpdateNow(AVAILABLE), true);
    assert.equal(offersUpdateNow({ ...AVAILABLE, blocked: 'changes' }), false);
    assert.equal(offersUpdateNow(CURRENT), false);
    assert.equal(offersUpdateNow({ state: 'cannot', summary: 'no' }), false);
    assert.equal(offersUpdateNow(null), false);
  });

  test("the running form's line names the commit as the server names it (its version, else its short id), in plain text", () => {
    assert.equal(
      runningLine('0.9.19'),
      'skydeck is being updated to 0.9.19. The window comes back by itself.',
    );
    assert.equal(
      runningLine('c75af0e'),
      'skydeck is being updated to c75af0e. The window comes back by itself.',
    );
    assert.deepEqual(
      runningRuns('0.9.19').filter((run) => run.code),
      [],
    );
    assert.equal(UPDATE_TEXTS.beingUpdated, 'skydeck is being updated');
  });

  test("the bar while the server is away: the whole sentence, with the time, and the log's path before skydeck window", () => {
    const log = '/home/you/.local/state/skydeck/update.log';
    const parts = awayParts('14:02:11', log);
    const sentence = parts.map((part) => part.text).join('');
    assert.equal(
      sentence,
      "skydeck is being updated (since 14:02:11): the server restarts by itself and this window comes back; sessions keep running. If it is not back within two minutes, the update's log says why: /home/you/.local/state/skydeck/update.log — read it first; then, in a WSL terminal: skydeck window",
    );
    assert.ok(sentence.indexOf(log) < sentence.indexOf('skydeck window'));
    assert.deepEqual(
      parts.filter((part) => part.code === true).map((part) => part.text),
      [log, 'skydeck window'],
    );
  });

  test("the result bar gives the server's words: updated to <id>, or why not", () => {
    assert.equal(resultText({ ok: true, text: 'updated to 5d6e7f8' }), 'updated to 5d6e7f8');
    const why = 'the update could not be applied: error: a refusal; the checkout is as it was';
    assert.equal(resultText({ ok: false, text: why }), why);
  });
});
