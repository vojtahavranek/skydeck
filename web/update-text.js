// Follow-up F38's words for the update notice (S2 16.5, 12.1, 12.13), pure (no DOM): whether the
// title bar's `Update available` shows, what the dialog it opens says for each answer of the
// server's look, and the settings screen's block `Updates`. The page decides no rule: what is
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
  /** The command the dialog gives: applying from the window is not offered here. */
  apply: 'To apply it, in a WSL terminal of your own: skydeck update',
  setRight: 'Once that is set right, in a WSL terminal of your own: skydeck update',
};

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
 * The settings screen's block: when the last check ran and what it says; with a failed last
 * fetch, first when and why, then what is known and from when; `Checking…` while one runs.
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
    lines.push(
      update.fetchedAtNs === null
        ? UPDATE_TEXTS.nothingFetched
        : `Known from ${ago(update.fetchedAtNs)}: ${check.summary}`,
    );
  } else if (update.fetchedAtNs === null) {
    lines.push(`Last check: ${check.summary}`);
  } else {
    lines.push(`Last check: ${ago(update.fetchedAtNs)} — ${check.summary}`);
  }
  if (update?.checking === true) {
    lines.push(UPDATE_TEXTS.checking);
  }
  return lines;
}
