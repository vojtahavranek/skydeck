// Issue #199's words and rule for the page, pure (no DOM): what Ctrl+Shift+S (in both zones) and
// the header's `Shell` do with the selected session's shell (S2 12.9). Whether a session may have
// a shell is the server's rule (S2 4.3): the page sends `act shell` for the pane's terminal and
// shows the server's refusal; the toasts for a pane without a terminal of the window are words
// from the row's own fields, as `r`'s are (restart-text.js).

/** @import { RowPayload, ShellPayload } from '../src/window/protocol.ts' */
/** @import { Pane } from './pane.js' */

export const SHELL_TEXTS = {
  noSession: 'no session selected',
  openFirst:
    "a shell opens under a session's terminal in this window: open the session first (Enter)",
  elsewhere:
    "a shell opens under a session's terminal in this window; this one runs in another terminal",
  background:
    "a shell opens under a session's terminal in this window; this one runs in Claude Code's background",
  ended: 'this session has ended: resume it first, then open a shell',
  /** The toast of the server's refusal of `act shell`. */
  refused: 'Shell: ',
  /** The header's control (S2 12.5) and its tooltips. */
  control: 'Shell',
  open: "open a shell in this session's folder (Ctrl+Shift+S)",
  hidden: 'a shell is open: show it (Ctrl+Shift+S)',
  shown: 'hide the shell: what runs in it keeps running (Ctrl+Shift+S)',
  /** The dot beside `Shell` while a shell is open, shown or hidden. */
  mark: 'a shell is open',
};

/**
 * @typedef {{ do: 'act' } | { do: 'show' } | { do: 'hide' } | { do: 'focus' } | { toast: string }} ShellPress
 */

/**
 * What a press of the shell's key does (S2 12.9; the gate of a shown dialog, switcher or tour is
 * app.js's, before this):
 * - no session selected (`selected` false, or the pane shows none or a caption):
 *   the toast `no session selected`;
 * - the pane is no terminal of the window (the session does not run, runs elsewhere, the new form
 *   is over it): a toast that says to open the session first, or where it runs;
 * - the pane's terminal is ended: its toast;
 * - the terminal has no shell: the act (`act`);
 * - it has one and the panel is hidden: shown with the keyboard (`show`);
 * - the panel is shown and the keyboard is in the shell: hidden, the keyboard to the session's
 *   terminal (`hide`);
 * - the panel is shown and the keyboard is anywhere else: the keyboard to the shell (`focus`).
 * @param {{ pane: Pane, selected: boolean, shell: ShellPayload | null, shown: boolean, inShell: boolean }} press
 * @returns {ShellPress}
 */
export function shellPress({ pane, selected, shell, shown, inShell }) {
  if (!selected || pane.kind === 'none' || pane.kind === 'group') {
    return { toast: SHELL_TEXTS.noSession };
  }
  if (pane.kind === 'elsewhere') {
    return { toast: elsewhereText(pane.row) };
  }
  if (pane.kind !== 'terminal') {
    return { toast: SHELL_TEXTS.openFirst };
  }
  if (pane.ended) {
    return { toast: SHELL_TEXTS.ended };
  }
  if (shell === null) {
    return { do: 'act' };
  }
  if (!shown) {
    return { do: 'show' };
  }
  return inShell ? { do: 'hide' } : { do: 'focus' };
}

/**
 * The toast for a session that runs outside the window's terminals, from its row's own fields.
 * @param {RowPayload} row
 * @returns {string}
 */
function elsewhereText(row) {
  return row.elsewhere?.background === true ? SHELL_TEXTS.background : SHELL_TEXTS.elsewhere;
}

/**
 * The toast of the server's refusal of `act shell`.
 * @param {string} error
 * @returns {string}
 */
export function shellRefusedText(error) {
  return `${SHELL_TEXTS.refused}${error}`;
}

/**
 * The header's `Shell` (S2 12.5) for the state of the shown terminal's shell: none open, open and
 * hidden, open and shown. Its words, its tooltip, and whether its dot says that a shell is open.
 * @param {'none' | 'hidden' | 'shown'} state
 * @returns {{ text: string, tip: string, mark: boolean }}
 */
export function shellControl(state) {
  return {
    text: SHELL_TEXTS.control,
    tip:
      state === 'none'
        ? SHELL_TEXTS.open
        : state === 'hidden'
          ? SHELL_TEXTS.hidden
          : SHELL_TEXTS.shown,
    mark: state !== 'none',
  };
}
