// Follow-up F38's words for the update notice (S2 16.5, 12.1, 12.13), pure (no DOM): whether the
// title bar's `Update available` shows, what the dialog it opens says for each answer of the
// server's look (the notes of what is new, the fold of the other changes, the database note, the
// bottom lines; dialogModel), the lines of the settings screen's group Updates, and (milestone 2) whether the dialog offers
// `Update now`, its running form, and the bar while the server is away for an update. The page decides no rule: what is
// known, and whether it can be applied, is the server's (src/window/updates.ts); these functions
// only put its texts into sentences. Every text they return reaches the DOM as text.

/** @import { NotePayload, TextRun, UpdateCheckPayload, UpdatePayload } from '../src/window/protocol.ts' */
import { ageBetween } from './format.js';

export const UPDATE_TEXTS = {
  button: 'Update available',
  heading: 'Update available',
  close: 'Close',
  looking: 'Looking at the checkout…',
  checkNow: 'Check now',
  checking: 'Checking…',
  never: 'No check was made yet.',
  nothingFetched: 'Nothing was fetched before.',
  /** The command the dialog gives beside `Update now` (its last line, small). */
  terminal: 'In a terminal instead: skydeck update',
  setRight: 'Once that is set right, in a WSL terminal of your own: skydeck update',
  /** Milestone 2: the dialog's second click, and what a window chord says while an update runs. */
  updateNow: 'Update now',
  beingUpdated: 'skydeck is being updated',
};

/**
 * Whether the dialog offers `Update now` for the look's answer: only for an update that can be
 * applied as the checkout is (the server decides; it refuses any other).
 * @param {UpdateCheckPayload | null} check
 * @returns {boolean}
 */
export function offersUpdateNow(check) {
  return check?.state === 'available' && check.blocked === null;
}

/**
 * The dialog's running form while an update runs (every page, connected and told `applying`), in
 * runs: the name the server gives the commit (its version, else its short id).
 * @param {string} name `applying.name`
 * @returns {TextRun[]}
 */
export function runningRuns(name) {
  return [plain(`skydeck is being updated to ${name}. The window comes back by itself.`)];
}

/**
 * The running form's line as text.
 * @param {string} name `applying.name`
 * @returns {string}
 */
export function runningLine(name) {
  return runningRuns(name)
    .map((run) => run.text)
    .join('');
}

/**
 * S2 6.3's bar while the server is away for an update, in its parts: the text, the log, the text,
 * the command. The log comes first and the command second: after a merge that was cut off the
 * command starts nothing until the checkout is set right, and the log says so.
 * @param {string} since the time the update started, as the page shows a time (HH:MM:SS)
 * @param {string} log the update's log
 * @returns {{ text: string; code?: boolean }[]}
 */
export function awayParts(since, log) {
  return [
    {
      text: `skydeck is being updated (since ${since}): the server restarts by itself and this window comes back; sessions keep running. If it is not back within two minutes, the update's log says why: `,
    },
    { text: log, code: true },
    { text: ' — read it first; then, in a WSL terminal: ' },
    { text: 'skydeck window', code: true },
  ];
}

/**
 * The result bar's text: how the last update from the window ended, in the server's words
 * (`updated to <version>`, or why not).
 * @param {{ ok: boolean; text: string }} result
 * @returns {string}
 */
export function resultText(result) {
  return result.text;
}

/**
 * Whether a newer version is known: the title bar's control shows exactly then.
 * @param {UpdatePayload | null | undefined} update
 * @returns {boolean}
 */
export function showsNotice(update) {
  return update?.check?.state === 'available';
}

/**
 * @param {string} text
 * @returns {TextRun}
 */
function plain(text) {
  return { text, code: false };
}

/**
 * @param {string} text
 * @returns {TextRun}
 */
function code(text) {
  return { text, code: true };
}

/**
 * One block of the dialog's body: a note (its title, its paragraphs), a line in the window's font,
 * the database note (a marked block), or a small muted line at the bottom.
 * @typedef {{ kind: 'note'; title: TextRun[]; paragraphs: TextRun[][] }
 *   | { kind: 'line' | 'database' | 'meta'; runs: TextRun[] }} DialogBlock
 */

/**
 * The fold of the other changes: its button's words (without the arrow), whether it is open at
 * every open of the dialog, and the list under it.
 * @typedef {{ label: string; openAtStart: boolean; items: string[] }} DialogFold
 */

/**
 * The dialog's body, top to bottom: the blocks before the fold, the fold (null: none), the blocks
 * after it.
 * @typedef {{ before: DialogBlock[]; fold: DialogFold | null; after: DialogBlock[] }} DialogModel
 */

/**
 * `n` and the word for one or more of it (`1 change`, `3 changes`).
 * @param {number} n
 * @param {string} one
 * @param {string} more
 * @returns {string}
 */
function counted(n, one, more) {
  return `${n} ${n === 1 ? one : more}`;
}

/**
 * A body of one line (a look that has not answered, a message of the page's).
 * @param {string | TextRun[]} text
 * @returns {DialogModel}
 */
export function lineModel(text) {
  return {
    before: [{ kind: 'line', runs: typeof text === 'string' ? [plain(text)] : text }],
    fold: null,
    after: [],
  };
}

/** The line that gives the command once what stands in the way is set right. */
const SET_RIGHT_RUNS = [
  plain('Once that is set right, in a WSL terminal of your own: '),
  code('skydeck update'),
];

/**
 * The dialog's body for the look's answer (S2 12.1). For an update: its notes, newest first (and
 * `… and <n> more`); the fold `▸ <n> other changes` over the subjects of the commits that add no
 * note (`<n> changes`, open from the start, when it brings no note; none when every commit adds
 * one); the database note when it changes the database's upgrade steps; why it cannot be applied
 * as it is and the command once that is set right, for one that is blocked; a refusal of `Update
 * now`; and small at the bottom `<old version> → <new version> on <upstream>` with the two ids
 * after it (the ids alone when the server knows neither version) and, for one that can be applied,
 * the command for a terminal. Up to date: its summary; one that cannot tell: why, and the command
 * once that is set right; none yet: that no check was made.
 * @param {UpdateCheckPayload | null} check
 * @param {string | null} [refusal] why `Update now` was refused, drawn under the answer
 * @returns {DialogModel}
 */
export function dialogModel(check, refusal = null) {
  /** @type {DialogBlock[]} */
  const refused = refusal === null ? [] : [{ kind: 'line', runs: [plain(refusal)] }];
  if (check === null) {
    return { ...lineModel(UPDATE_TEXTS.never), after: refused };
  }
  if (check.state === 'current') {
    return { ...lineModel(check.summary), after: refused };
  }
  if (check.state === 'cannot') {
    return {
      before: [
        {
          kind: 'line',
          runs: [plain(`skydeck cannot tell here whether there is an update: ${check.summary}`)],
        },
        { kind: 'line', runs: SET_RIGHT_RUNS },
      ],
      fold: null,
      after: refused,
    };
  }
  /** @type {DialogBlock[]} */
  const before = check.notes.map(
    /** @param {NotePayload} note @returns {DialogBlock} */
    (note) => ({ kind: 'note', title: note.title, paragraphs: note.paragraphs }),
  );
  if (check.moreNotes > 0) {
    before.push({ kind: 'line', runs: [plain(`… and ${check.moreNotes} more`)] });
  }
  const noNotes = check.notes.length === 0 && check.moreNotes === 0;
  const unlisted = check.otherCount - check.others.length;
  /** @type {DialogFold | null} */
  const fold =
    check.otherCount === 0
      ? null
      : {
          label: noNotes
            ? counted(check.otherCount, 'change', 'changes')
            : counted(check.otherCount, 'other change', 'other changes'),
          openAtStart: noNotes,
          items: [...check.others, ...(unlisted > 0 ? [`… and ${unlisted} more`] : [])],
        };
  const from = check.from.slice(0, 7);
  /** @type {DialogBlock[]} */
  const after = [];
  if (check.upgradesDatabase) {
    after.push({
      kind: 'database',
      runs: [
        plain(
          'This update may upgrade the database. A copy is kept first; an older skydeck cannot open it afterwards. Going back to ',
        ),
        code(from),
        plain(': docs/install.md, "Going back".'),
      ],
    });
  }
  if (check.blocked !== null) {
    after.push(
      {
        kind: 'line',
        runs: [plain(`This checkout cannot be updated as it is: ${check.blocked}`)],
      },
      { kind: 'line', runs: SET_RIGHT_RUNS },
    );
  }
  const to = check.to.slice(0, 7);
  after.push(...refused, {
    kind: 'meta',
    runs:
      check.versions === null
        ? [code(from), plain(' → '), code(to), plain(` on ${check.upstream}`)]
        : [plain(`${check.versions} on ${check.upstream}  `), code(from), plain(' → '), code(to)],
  });
  if (check.blocked === null) {
    after.push({ kind: 'meta', runs: [plain('In a terminal instead: '), code('skydeck update')] });
  }
  return { before, fold, after };
}

/**
 * A block's text as it reads (its runs joined; a note's title, then its paragraphs, by spaces).
 * @param {DialogBlock} block
 * @returns {string}
 */
export function blockText(block) {
  /** @param {TextRun[]} runs */
  const text = (runs) => runs.map((run) => run.text).join('');
  if (block.kind === 'note') {
    return [text(block.title), ...block.paragraphs.map(text)].join(' ');
  }
  return text(block.runs);
}

/**
 * The settings screen's block: first `skydeck <version>`, the version the server gives (none
 * before it does); then when the last check ended and what it says; with a failed last check,
 * first when and why, then what is known and from when (the last fetch that worked); `Checking…`
 * while one runs.
 * `nowNs`: the server's time now, as the list gives it ('' before the first list: no age).
 * @param {UpdatePayload | null} update
 * @param {string} nowNs
 * @returns {string[]}
 */
export function settingsLines(update, nowNs) {
  /** @param {string | null} thenNs */
  const ago = (thenNs) => {
    const age = ageBetween(nowNs, thenNs);
    return age === '' ? '' : `${age} ago`;
  };
  /** @type {string[]} */
  const lines = [];
  if (update != null && update.version !== null) lines.push(`skydeck ${update.version}`);
  const check = update?.check ?? null;
  if (update === null || check === null) {
    lines.push(UPDATE_TEXTS.never);
  } else if (update.failure !== null) {
    lines.push(`The last check failed ${ago(update.failure.atNs)}: ${update.failure.line}`);
    // A check that failed is its own `cannot`: its line is said once.
    const same = check.state === 'cannot' && check.summary === update.failure.line;
    if (!same) {
      lines.push(
        update.fetchedAtNs === null
          ? UPDATE_TEXTS.nothingFetched
          : `Known from ${ago(update.fetchedAtNs)}: ${check.summary}`,
      );
    }
  } else if (update.checkedAtNs === null) {
    lines.push(`Last check: ${check.summary}`);
  } else {
    // The time the last check ended, whatever it found (not that of the last fetch that worked).
    lines.push(`Last check: ${ago(update.checkedAtNs)} — ${check.summary}`);
  }
  if (update?.checking === true) {
    lines.push(UPDATE_TEXTS.checking);
  }
  return lines;
}
