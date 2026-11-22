// Follow-up F38's words for the update notice (S2 16.5, 12.1, 12.13), pure (no DOM): whether the
// title bar's `Update available` shows, what the dialog it opens says for each answer of the
// server's look, the settings screen's block `Updates`, and (milestone 2) whether the dialog offers
// `Update now`, its running form, and the bar while the server is away for an update. The page decides no rule: what is
// known, and whether it can be applied, is the server's (src/window/updates.ts); these functions
// only put its texts into sentences. Every text they return reaches the DOM as text.

/** @import { UpdateCheckPayload, UpdatePayload } from '../src/window/protocol.ts' */
import { ageBetween } from './format.js';

export const UPDATE_TEXTS = {
  button: 'Update available',
  heading: 'Update available',
  close: 'Close',
  looking: 'Looking at the checkout…',
  /** The settings screen's block. */
  block: 'Updates',
  checkNow: 'Check now',
  checking: 'Checking…',
  never: 'No check was made yet.',
  nothingFetched: 'Nothing was fetched before.',
  /** The command the dialog gives beside `Update now`. */
  apply: 'To apply it, in a WSL terminal of your own: skydeck update',
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
 * The dialog's running form while an update runs (every page, connected and told `applying`).
 * @param {string} to the commit's full id
 * @returns {string}
 */
export function runningLine(to) {
  return `skydeck is being updated to ${to.slice(0, 7)}. The window comes back by itself.`;
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
 * (`updated to <id>`, or why not).
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
 * The dialog's lines for the look's answer: `skydeck update --check`'s lines and the command for
 * an update that can be applied; the reason first for one that cannot; the summary for one the
 * look found stale; for a look that cannot tell, why, and the command once that is set right.
 * @param {UpdateCheckPayload | null} check
 * @returns {string[]}
 */
export function dialogLines(check) {
  if (check === null) {
    return [UPDATE_TEXTS.never];
  }
  switch (check.state) {
    case 'available':
      return check.blocked === null
        ? [...check.lines, UPDATE_TEXTS.apply]
        : [
            ...check.lines,
            `This checkout cannot be updated as it is: ${check.blocked}`,
            UPDATE_TEXTS.setRight,
          ];
    case 'current':
      return [check.summary];
    case 'cannot':
      return [
        `skydeck cannot tell here whether there is an update: ${check.summary}`,
        UPDATE_TEXTS.setRight,
      ];
  }
  return [];
}

/**
 * The settings screen's block: when the last check ended and what it says; with a failed last
 * check, first when and why, then what is known and from when (the last fetch that worked);
 * `Checking…` while one runs.
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
