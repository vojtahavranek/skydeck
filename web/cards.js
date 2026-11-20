// The right side's header and cards (S2 7.8, 7.9, 12.5, 12.6; plan task 29, plan D task 38): the
// header of stage D (S2 12.5, D11–D15, D17) in four lines of one line each, so that it has one
// height for every session and window width (D12) — the title, the group chip, its ✎ or `+ group`,
// the state, Note and Done; the directory, "opened <time> · last active <age>", where the title
// comes from, the short id and (F16) the flags the session was started with; (F18) the ticket's
// chip, the window's chip (S2 12.3), the open pull requests and the buttons of the ticket's and
// the pull-request dialogs; the note's first line —, the resume card, the card of a session
// running in another terminal (or, F34, in Claude Code's background), the ended bar, the new form
// and (F9) the small card of a group whose closed caption is selected in the list. Its interface is contract 2.9's with plan D 2.4's
// changes. Every server string reaches the DOM through textContent or a tooltip.
//
// How app.js calls it: on a change of what the right side shows, `hide()` (every card and the
// header), then `header(row, selected, term, now)` (plan D 2.4) and at most one card. `act` is
// app.js's: it adds `t` and `id`, and for `resume` and `new` the size of the terminal area; a
// successful resume or new selects its session there and gives its terminal the keyboard (S2 11.3).
// The header's controls open task 37's dialogs through `edit` and mark done through `done`; a link
// of the header (a pull request, the ticket) is `act open-link`, and a refusal is a line in the key
// bar (`say`). Its ages count from `now()` and are drawn again on the header's own 1 s tick (A18).
//
// Keyboard and selection (S2 12.9, contract 2.9, D17): this module never calls focus(). The header
// and a card are filled in place while they show the same session or terminal, and a text is set
// only when it changed, so that text the user selected to copy stays selected when a list changes
// something else, and a render between the mousedown and the mouseup on a button loses no click.
// Only buttons cancel their mousedown, so that they take no keyboard; a text that acts (the title,
// the ticket link, a pull request, the note's line) acts on a click that selected no text, and can
// be selected and copied by a drag. A card whose facts changed while one of its buttons had the
// keyboard gives the keyboard up: an Enter must not press a button for what the user has not seen
// (nothing resumes but on purpose); app.js gives it to the zone after the call. The short id's copy
// takes no keyboard on a click.

/** @import { ElsewherePayload, ExitMessage, ResultMessage, RowPayload, SelectedPayload, TerminalPayload } from '../src/window/protocol.ts' */
/** @import { EditWhat } from './keys.js' */
/** @import { NewFormDefaults } from './new-form-text.js' */
import { chipWords } from './favourite-text.js';
import { favouriteControls } from './favourites.js';
import {
  noteLine,
  prItemParts,
  prItemTip,
  splitPrs,
  startedWithText,
  ticketChip,
  ticketHeader,
  timesText,
  titleSourceText,
} from './header-text.js';
import { elsewhereText, rowText } from './list-text.js';
import { groupCardText } from './search-text.js';

/**
 * @typedef {object} CardsDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(id: string) => void} select
 * @property {(what: EditWhat, sessionId: string) => void} edit stage D's dialogs (plan D 2.4;
 *   task 38's header controls call it)
 * @property {(sessionId: string) => void} done done, or undone for a done row (D15); the toast is
 *   app.js's
 * @property {(text: string) => void} say a line in the key bar
 * @property {(listener: ((favourites: string[]) => void) | null) => void} watchFavourites F15:
 *   the one listener of the favourites every list brings (S2 12.6) — the open new form's, null
 *   while none is open; app.js calls it at once with the favourites it has, then at every list
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COPIED_MS = 2000;
/** How often the header's ages are drawn again (A18, as the list's). */
const AGE_TICK_MS = 1000;

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/**
 * Sets `text` only when it differs, so that a selection in an unchanged text survives.
 * @param {HTMLElement} target
 * @param {string} text
 */
function setText(target, text) {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

/**
 * @param {HTMLElement} target
 * @param {boolean} hidden
 */
function setHidden(target, hidden) {
  if (target.hidden !== hidden) {
    target.hidden = hidden;
  }
}

/**
 * A time of the protocol (nanoseconds as a decimal string) as a Date; null for anything else.
 * @param {string | null | undefined} ns
 * @returns {Date | null}
 */
function dateOf(ns) {
  if (typeof ns !== 'string' || !/^-?[0-9]+$/.test(ns)) {
    return null;
  }
  const date = new Date(Number(BigInt(ns) / 1_000_000n));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {number} value */
const two = (value) => String(value).padStart(2, '0');

/**
 * @param {Date} date
 * @param {boolean} seconds
 */
function clockOf(date, seconds) {
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return seconds ? `${time}:${two(date.getSeconds())}` : time;
}

/**
 * The day of `date` as the page's clock sees it: 'today', 'yesterday', or "13 Nov" (with the year
 * when it is not this one). The times on the right side are moments, not ages: a card is not
 * redrawn every second, and an age would go stale on it.
 * @param {Date} date
 * @returns {string}
 */
function dayOf(date) {
  const now = new Date();
  const midnight = (/** @type {Date} */ day) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/**
 * "today at 14:02", "yesterday at 18:02", "13 Nov at 18:02"; '' for a time that cannot be read.
 * @param {string | null | undefined} ns
 */
function momentOf(ns) {
  const date = dateOf(ns);
  return date === null ? '' : `${dayOf(date)} at ${clockOf(date, false)}`;
}

/**
 * S2 7.8's "at <time>": "14:02:11", "14:02:11 yesterday", "14:02:11 on 13 Nov".
 * @param {string | null | undefined} ns
 */
function exitTimeOf(ns) {
  const date = dateOf(ns);
  if (date === null) {
    return '';
  }
  const day = dayOf(date);
  const when = day === 'today' ? '' : day === 'yesterday' ? ' yesterday' : ` on ${day}`;
  return ` at ${clockOf(date, true)}${when}`;
}

/**
 * The header's state pill (S2 19: states only until stage B): "starting…", "running in another
 * terminal" (or F34's "running in Claude Code's background": `elsewhereText`), or the row's state
 * with its detail in brackets (design 7.4).
 * @param {RowPayload} row
 */
function stateOf(row) {
  if (row.starting) {
    return 'starting…';
  }
  if (row.elsewhere !== null) {
    return elsewhereText(row.elsewhere);
  }
  const state = row.state === 'not-running' ? 'not running' : row.state;
  const detail = row.stateDetail ?? '';
  return detail === '' ? state : `${state} (${detail})`;
}

/**
 * S2 7.8 and 7.3: how the program ended, for the bar.
 * @param {ExitMessage | null} exit
 */
function endedOf(exit) {
  if (exit === null) {
    // Before the page has the exit: true of an ended, a lost and a not-started terminal alike.
    return 'claude is not running in this terminal';
  }
  if (exit.notStarted !== null) {
    return `not started: ${exit.notStarted}`;
  }
  if (exit.lost) {
    return "the terminal's keeper ended unexpectedly; claude ended with it";
  }
  if (exit.code !== null) {
    return `claude exited (status ${exit.code})${exitTimeOf(exit.atNs)}`;
  }
  return `claude was ended by signal ${exit.signal ?? '?'}${exitTimeOf(exit.atNs)}`;
}

/**
 * A result's lines as the card shows them — the lines of a success (flag warnings), the error of a
 * refusal (its lines joined; app.js keeps the same for the resume card), or the lines of a launch
 * that failed.
 * @param {ResultMessage} result
 * @returns {string[]}
 */
function linesOf(result) {
  return result.ok || result.error === null ? result.lines : [result.error];
}

/**
 * A held Enter never presses a button or submits the form again: its auto-repeats are cancelled
 * (ruled for tasks 27 and 29). A fresh press acts.
 * @param {KeyboardEvent} event
 */
function refuseHeldEnter(event) {
  if (event.repeat && event.key === 'Enter') {
    event.preventDefault();
  }
}

/**
 * A button of a card. `run` is not started again while the action it started is pending.
 * @param {string} text
 * @param {string} className
 * @param {() => Promise<void>} run
 * @returns {HTMLButtonElement}
 */
function actionButton(text, className, run) {
  const button = /** @type {HTMLButtonElement} */ (element('button', `card-button ${className}`));
  button.type = 'button';
  button.textContent = text;
  let pending = false;
  button.addEventListener('keydown', refuseHeldEnter);
  button.addEventListener('click', () => {
    if (pending) {
      return;
    }
    pending = true;
    void run().finally(() => {
      pending = false;
    });
  });
  return button;
}

/**
 * Sets the tooltip only when it differs.
 * @param {HTMLElement} target
 * @param {string} tip
 */
function setTip(target, tip) {
  if (target.title !== tip) {
    target.title = tip;
  }
}

/**
 * Sets a data attribute only when it differs.
 * @param {HTMLElement} target
 * @param {string} name
 * @param {string} value
 */
function setData(target, name, value) {
  if (target.dataset[name] !== value) {
    target.dataset[name] = value;
  }
}

/**
 * Whether the page holds selected text: a click that ends a drag over a text that acts acts on
 * nothing, so that the text can be copied (D17).
 */
function textSelected() {
  const selection = getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== '';
}

/**
 * A button of the header (D17): it cancels its mousedown, so that a click on it takes no keyboard
 * and leaves it where it was; a held Enter on it acts once, and so does a double click (D15: the
 * second click would find what the first one changed — Done a done row, and send `undone`; review 2
 * of task 38). A press from the keyboard has no click count.
 * @param {string} className
 * @param {string} text
 * @param {string} tip
 * @param {() => void} run
 * @returns {HTMLButtonElement}
 */
function headerButton(className, text, tip, run) {
  const button = /** @type {HTMLButtonElement} */ (element('button', `header-button ${className}`));
  button.type = 'button';
  button.textContent = text;
  button.title = tip;
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('keydown', refuseHeldEnter);
  button.addEventListener('click', (event) => {
    if (event.detail <= 1) {
      run();
    }
  });
  return button;
}

/**
 * @param {HTMLElement} root
 * @param {CardsDeps} deps
 */
export function createCards(root, deps) {
  // --- the header (S2 12.5, plan D task 38): four lines, one height (D12) ---------------------
  const head = element('div', 'card-header');
  /**
   * The session the header shows, its terminal and `now`, for the age tick; F19: and the list's
   * `selected` of it (the ticket chip's tooltip counts its status' age).
   * @type {{ row: RowPayload, term: TerminalPayload | null, now: () => string,
   *          selected: SelectedPayload | null } | null}
   */
  let shownHead = null;
  /** The whole id the short id copies. */
  let headId = '';
  /**
   * The ticket address the group chip opens, null while it is plain text (D14).
   * @type {string | null}
   */
  let ticket = null;
  /** @param {EditWhat} what */
  const editHere = (what) => {
    if (headId !== '') {
      deps.edit(what, headId);
    }
  };
  /**
   * S2 9.6's `open-link` (the server checks the address again); a refusal in the key bar.
   * @param {string} url
   */
  const openLink = (url) => {
    void deps.act({ kind: 'open-link', url }).then((result) => {
      if (!result.ok) {
        deps.say(result.error ?? 'skydeck could not open the link');
      }
    });
  };

  // Line 1: the title (a click edits the label), the group chip (D14: it opens the ticket when it
  // is a link, else it is plain text; it never edits), ✎ or `+ group`, the state, Note and Done.
  const title = element('span', 'header-title');
  title.title = 'the label (l)';
  const group = element('span', 'header-group');
  const groupKey = element('span', 'header-group-key');
  const groupArrow = element('span', 'header-group-arrow');
  group.append(groupKey, groupArrow);
  const groupEdit = headerButton('header-group-edit', '✎', 'edit the group (g)', () =>
    editHere('group'),
  );
  const groupAdd = headerButton('header-group-add', '+ group', 'set a group (g)', () =>
    editHere('group'),
  );
  const state = element('span', 'header-state');
  const stateText = element('span', 'header-state-text');
  state.append(stateText);
  const noteButton = headerButton('header-note-button', 'Note', 'the note (n)', () =>
    editHere('note'),
  );
  // D15: done, or undone for a done row; one act per session at a time is app.js's.
  const doneButton = headerButton('header-done', 'Done', 'mark it done (d)', () => {
    if (headId !== '') {
      deps.done(headId);
    }
  });
  const actions = element('span', 'header-actions');
  actions.append(noteButton, doneButton);
  const top = element('div', 'header-top');
  top.append(title, group, groupEdit, groupAdd, state, actions);
  title.addEventListener('click', () => {
    if (!textSelected()) {
      editHere('label');
    }
  });
  group.addEventListener('click', () => {
    if (ticket !== null && !textSelected()) {
      openLink(ticket);
    }
  });

  // Line 2: the directory (one line, cut with an ellipsis, whole in its tooltip), "opened <time> ·
  // last active <age>", where the title comes from, the short id (never cut; a click copies), and
  // last (F16) the flags the session was started with — the first thing cut (cards.css), all of
  // them in its tooltip; not there without one, nor while the resume card shows ("Will run").
  const dir = element('span', 'header-dir');
  const times = element('span', 'header-times');
  const source = element('span', 'header-source');
  const shortId = element('span', 'header-id');
  const copied = element('span', 'header-copied');
  const flags = element('span', 'header-flags');
  const flagsText = element('span', 'header-flags-text');
  flags.append(flagsText);
  flags.hidden = true;
  const sub = element('div', 'header-sub');
  sub.append(dir, times, source, shortId, copied, flags);

  // Line 3: (F18) the ticket's chip — its name and ` ↗`, the address as its tooltip; a click that
  // selected no text opens it, as the group chip's link —, the window's chip (S2 12.3), the open
  // pull requests side by side as far as they fit (a click opens one; they give way before the
  // ticket's chip does), and the buttons of the ticket's and the pull-request dialogs, whole while
  // the window has room for them (cards.css); while none is attached, the hint `no pull request`
  // and `+ PR`. Without a ticket its chip is not there and the rest keeps its place. F19: with a
  // status known, ` · <status>` after the name (`.header-ticket-status`, cut before the name when
  // room is short) and the chip in its category's tint (`data-category`, style.css); a ticket from
  // the group has the chip only once a status is known or was tried, and then its status alone
  // (the group chip names it): no name, no arrow (ticketHeader).
  const ticketItem = element('span', 'header-ticket');
  const ticketText = element('span', 'header-ticket-text');
  const ticketStatus = element('span', 'header-ticket-status');
  const ticketArrow = element('span', 'header-ticket-arrow', ' ↗');
  ticketItem.append(ticketText, ticketStatus, ticketArrow);
  ticketItem.hidden = true;
  /**
   * The address the ticket's chip opens, null while it is not shown.
   * @type {string | null}
   */
  let ticketLink = null;
  ticketItem.addEventListener('click', () => {
    if (ticketLink !== null && !textSelected()) {
      openLink(ticketLink);
    }
  });
  const ticketButton = headerButton('header-ticket-button', '+ ticket', 'set a ticket (t)', () =>
    editHere('ticket'),
  );
  const chip = element('span', 'header-chip');
  const chipWords = element('span', 'header-chip-text');
  const chipMerged = element('span', 'header-chip-merged');
  chip.append(chipWords, chipMerged);
  const items = element('span', 'header-pr-items');
  const prsNone = element('span', 'header-prs-none', 'no pull request');
  const prsButton = headerButton('header-prs-button', '+ PR', 'the pull requests (p)', () =>
    editHere('pr'),
  );
  const prsLine = element('div', 'header-prs');
  prsLine.append(ticketItem, chip, prsNone, items, ticketButton, prsButton);
  /** The addresses of the items drawn, in order: they are made again only when these change. */
  let itemsKey = '';
  items.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.header-pr') : null;
    const url = item instanceof HTMLElement ? item.dataset['url'] : undefined;
    if (url !== undefined && !textSelected()) {
      openLink(url);
    }
  });

  // Line 4: the note's first line (a click edits the note), or the hint `no note`.
  const noteText = element('span', 'header-note-text');
  noteText.title = 'the note (n)';
  const noteLineOf = element('div', 'header-note');
  noteLineOf.append(noteText);
  noteText.addEventListener('click', () => {
    if (!textSelected()) {
      editHere('note');
    }
  });

  head.append(top, sub, prsLine, noteLineOf);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let copiedTimer = null;
  // A click copies; it takes no keyboard, so that the terminal or the list keeps it.
  shortId.addEventListener('mousedown', (event) => event.preventDefault());
  shortId.addEventListener('click', () => {
    const id = headId;
    /** @param {string} text */
    const say = (text) => {
      copied.textContent = text;
      if (copiedTimer !== null) {
        clearTimeout(copiedTimer);
      }
      copiedTimer = setTimeout(() => {
        // Late or not, it clears only its own line (header() clears it for another session).
        copiedTimer = null;
        if (copied.textContent === text) copied.textContent = '';
      }, COPIED_MS);
    };
    const clipboard = /** @type {Clipboard | undefined} */ (navigator.clipboard);
    if (clipboard === undefined) {
      say('could not copy the id');
      return;
    }
    clipboard.writeText(id).then(
      () => say('id copied'),
      () => say('could not copy the id'),
    );
  });

  /**
   * What of the header counts from the server's now — the times, the chip's tooltip, the items'
   * tooltips —, for the time now: at every `header()` and on the age tick.
   */
  const paintAges = () => {
    if (shownHead === null) {
      return;
    }
    const { row, term, now, selected } = shownHead;
    const nowNs = now();
    // F19: the ticket chip's tooltip counts its status' age.
    const ticketShown = ticketHeader(selected, nowNs);
    setTip(ticketItem, ticketShown?.tip ?? '');
    setText(
      times,
      timesText(term === null ? '' : momentOf(term.openedNs), row.lastActivityNs, nowNs),
    );
    // The list's own chip of the row (S2 12.3: one implementation of its words and tooltip).
    const shown = rowText(row, nowNs, term).chip;
    setHidden(chip, shown === null);
    setText(chipWords, shown?.text ?? '');
    setText(chipMerged, shown === null || shown.merged === '' ? '' : ` ${shown.merged}`);
    setTip(chip, shown?.tip ?? '');
    // F4: the state it names, for its tint (style.css); '' for one the page does not know.
    setData(chip, 'level', shown?.level ?? '');
    setData(chip, 'dim', String(shown?.dim ?? false));
    const open = splitPrs(Array.isArray(row.prs) ? row.prs : []).open;
    open.forEach((pr, at) => {
      const item = items.children[at];
      if (item instanceof HTMLElement) {
        setTip(item, prItemTip(pr, nowNs));
      }
    });
  };
  setInterval(paintAges, AGE_TICK_MS);

  const card = element('div', 'card');
  root.replaceChildren(head, card);
  head.hidden = true;
  card.hidden = true;

  /**
   * The card shown now: what it is for (`key`), how to fill it again, and what its last fill
   * said (`facts`).
   * @type {{ key: string, fill: (...args: any[]) => void, facts: string } | null}
   */
  let shown = null;

  /**
   * Shows the card `key`: the one shown when it is the same, else a new one from `build`. Its
   * facts are filled in place; when they changed while a control of the card had the keyboard,
   * the control gives it up (app.js gives it to the zone).
   * @template {any[]} A
   * @param {string} key
   * @param {() => { parts: HTMLElement[], fill: (...args: A) => void }} build
   * @param {A} args
   */
  function showCard(key, build, args) {
    if (shown === null || shown.key !== key) {
      const made = build();
      card.replaceChildren(...made.parts);
      shown = { key, fill: made.fill, facts: '' };
    }
    shown.fill(...args);
    const facts = factsOf();
    const holder = document.activeElement;
    if (facts !== shown.facts && holder instanceof HTMLElement && card.contains(holder)) {
      holder.blur();
    }
    shown.facts = facts;
    setHidden(card, false);
  }

  /**
   * What a card says, without the lines of an action's result; the parts hidden inside the card
   * say nothing (the card itself may be hidden by `hide()` meanwhile).
   */
  function factsOf() {
    /** @param {Element} part */
    const hiddenInCard = (part) => {
      for (
        let at = /** @type {Element | null} */ (part);
        at !== null && at !== card;
        at = at.parentElement
      ) {
        if (at instanceof HTMLElement && at.hidden) {
          return true;
        }
      }
      return false;
    };
    return [...card.querySelectorAll('[data-fact]')]
      .map((part) =>
        part instanceof HTMLButtonElement
          ? `${part.textContent}:${part.disabled}`
          : hiddenInCard(part)
            ? ''
            : (part.textContent ?? ''),
      )
      .join('\n');
  }

  /**
   * @param {HTMLElement} lines
   * @param {ResultMessage} result
   */
  const showResult = (lines, result) => {
    setText(lines, linesOf(result).join('\n'));
  };

  /**
   * A label and its value, as one line of a card's facts.
   * @param {string} label
   * @param {string} className
   */
  const fact = (label, className) => {
    const line = element('div', 'card-fact');
    const value = element('span', className);
    value.dataset['fact'] = '';
    line.append(element('span', 'card-label', label), value);
    return { line, value };
  };

  /** @param {string} sessionId */
  function buildResume(sessionId) {
    const ended = element('div', 'card-ended');
    ended.dataset['fact'] = '';
    const activity = fact('Last activity', 'card-activity');
    const where = fact('Directory', 'card-dir');
    const command = fact('Will run', 'card-command');
    const warnings = element('div', 'card-warnings');
    warnings.dataset['fact'] = '';
    const lines = element('div', 'card-lines');
    let pending = false;
    const button = actionButton('Resume here', 'primary', async () => {
      pending = true;
      setText(lines, 'resuming…');
      const result = await deps.act({ kind: 'resume', sessionId });
      pending = false;
      showResult(lines, result);
    });
    button.dataset['fact'] = '';
    const actions = element('div', 'card-actions');
    // True whenever it is shown: an expired session's card says it cannot be resumed instead.
    const hint = element('span', 'card-hint', 'opens in this window, in a new terminal');
    actions.append(button, hint);
    return {
      parts: [ended, activity.line, where.line, command.line, warnings, actions, lines],
      /**
       * @param {RowPayload} row
       * @param {SelectedPayload | null} selected
       * @param {string[]} resultLines
       */
      fill(row, selected, resultLines) {
        const expired = selected?.expired === true || row.marks.includes('expired');
        const how = expired
          ? 'Its transcript is gone: it cannot be resumed.'
          : selected?.ended === 'exited'
            ? 'Exited normally.'
            : selected?.ended === 'unexpectedly'
              ? 'Ended unexpectedly.'
              : selected?.ended === 'mid-turn'
                ? 'Ended unexpectedly in the middle of a turn.'
                : '';
        setText(ended, how);
        setHidden(ended, how === '');
        const moment = momentOf(row.lastActivityNs);
        setText(activity.value, moment === '' ? 'not known' : moment);
        setText(where.value, row.dir ?? 'not known');
        // `selected` comes with the list that answers the page's view: until then nothing is said
        // about the command.
        // Nothing will run for an expired session, whatever command the server could build.
        setHidden(command.line, selected === null || expired);
        setText(
          command.value,
          selected?.command ??
            'skydeck cannot show the exact command: the directory is not known, or a word of it cannot be shown',
        );
        /** @type {string[]} */
        const warned = [];
        if (selected !== null && !selected.flagsKnown) {
          warned.push('original flags unknown; resuming with defaults');
        }
        if (selected !== null && selected.unknownFlags.length > 0) {
          warned.push(
            `started with flags skydeck does not know, not passed on resume: ${selected.unknownFlags.join(' ')}`,
          );
        }
        // The words of the list's `expires soon` (ruled for task 27): no number the server did not
        // send — it sends only that the transcript is expiring.
        if (!expired && (selected?.expiring === true || row.marks.includes('expiring'))) {
          warned.push('its transcript will be deleted soon unless the session is resumed');
        }
        const now = [...warnings.children].map((line) => line.textContent).join('\n');
        if (now !== warned.join('\n')) {
          warnings.replaceChildren(...warned.map((text) => element('div', 'card-warning', text)));
        }
        button.disabled = expired;
        setHidden(hint, expired);
        if (!pending) {
          setText(lines, resultLines.join('\n'));
        }
      },
    };
  }

  /**
   * The card of a session no terminal of the window shows (S2 7.9): the holder's pid and terminal
   * device, the directory, and why it cannot be shown here. F34: for a session Claude Code runs in
   * its background (`background`), its own title and words, and no terminal device: it has none of
   * the user's.
   * @param {boolean} background
   */
  function buildElsewhere(background) {
    const where = fact('Process', 'card-where');
    const place = fact('Directory', 'card-dir');
    let title = 'Running in another terminal';
    const why = element(
      'div',
      'card-why',
      'It cannot be shown here: its terminal belongs to another program, and skydeck never takes it over. Once it has ended it can be resumed in the window.',
    );
    if (background) {
      title = "Running in Claude Code's background";
      why.replaceChildren(
        'Claude Code runs this session itself, without a terminal. skydeck cannot show it here. To see it or end it, run ',
        element('code', '', 'claude agents'),
        ' in a terminal. Once it has ended it can be resumed in the window.',
      );
    }
    return {
      parts: [element('div', 'card-title', title), where.line, place.line, why],
      /** @param {RowPayload} row */
      fill(row) {
        /** @type {ElsewherePayload | null} */
        const other = row.elsewhere;
        setText(
          where.value,
          other === null
            ? 'not known'
            : `pid ${other.pid}${background || other.tty === null ? '' : ` · ${other.tty}`}`,
        );
        setText(place.value, other?.dir ?? row.dir ?? 'not known');
      },
    };
  }

  /**
   * F9: the card of a selected closed caption — the group's name, the number of its sessions with
   * ` · 1 needs you` in the needs-you colour while any needs you, and what opens it. It has no
   * control: no key of the list acts on a session from here but → and Enter, which open the group.
   */
  function buildGroup() {
    const name = element('div', 'card-title card-group-name');
    name.dataset['fact'] = '';
    const count = element('span', 'card-group-count');
    count.dataset['fact'] = '';
    const need = element('span', 'card-group-need');
    need.dataset['fact'] = '';
    const line = element('div', 'card-group-line');
    line.append(count, need);
    const hint = element('div', 'card-hint card-group-hint');
    return {
      parts: [name, line, hint],
      /** @param {{ group: string, size: number, needYou: number }} info */
      fill(info) {
        const text = groupCardText(info.group, info.size, info.needYou);
        setText(name, text.title);
        setText(count, text.count);
        setText(need, text.need);
        setHidden(need, text.need === '');
        setText(hint, text.hint);
      },
    };
  }

  /**
   * @param {string | null} sessionId
   * @param {string | null} term
   */
  function buildEnded(sessionId, term) {
    const text = element('span', 'card-ended');
    text.dataset['fact'] = '';
    const lines = element('div', 'card-lines');
    /** @param {Record<string, unknown> & { kind: string }} action */
    const run = async (action) => {
      showResult(lines, await deps.act(action));
    };
    const bar = element('div', 'card-bar');
    bar.append(text);
    if (sessionId !== null) {
      bar.append(actionButton('Resume', 'primary', () => run({ kind: 'resume', sessionId })));
    }
    if (term !== null) {
      bar.append(actionButton('Close', '', () => run({ kind: 'close-terminal', term })));
    }
    return {
      parts: [bar, lines],
      /** @param {ExitMessage | null} exit */
      fill(exit) {
        setText(text, endedOf(exit));
      },
    };
  }

  return {
    /**
     * Plan D 2.4: app.js passes `selected` (list.selected when it is the row's session), the
     * pane's terminal (its `openedNs` is "opened <time>") and the server's now for every pane.
     * @param {RowPayload | null} row
     * @param {SelectedPayload | null} selected
     * @param {TerminalPayload | null} term
     * @param {() => string} now
     */
    header(row, selected, term, now) {
      if (row === null) {
        setHidden(head, true);
        shownHead = null;
        return;
      }
      if (row.id !== headId) {
        // "id copied" was about the session shown before.
        if (copiedTimer !== null) clearTimeout(copiedTimer);
        copiedTimer = null;
        setText(copied, '');
      }
      headId = row.id;
      shownHead = { row, term, now, selected };
      setText(title, row.title);
      // D14: with a group, the chip and ✎; with a ticket address (the server's, S2 12.5) the chip is
      // a link — the key, `↗`, the address as its tooltip —, else plain text.
      const hasGroup = row.group !== null;
      // The server sends an address only for a group that holds a ticket key (task 35).
      const address = typeof selected?.ticketUrl === 'string' ? selected.ticketUrl : null;
      ticket = address;
      setHidden(group, !hasGroup);
      setHidden(groupEdit, !hasGroup);
      setHidden(groupAdd, hasGroup);
      setText(groupKey, row.group ?? '');
      setText(groupArrow, address === null ? '' : ' ↗');
      setData(group, 'link', String(address !== null));
      setTip(group, address ?? (row.groupSource === 'title' ? 'group (from the title)' : 'group'));
      setText(stateText, stateOf(row));
      setText(doneButton, row.done ? 'Undone' : 'Done');
      setTip(doneButton, row.done ? 'show it again (d)' : 'mark it done (d)');
      setText(dir, row.dir ?? 'directory not known');
      // One line, cut with an ellipsis (a fixed height; ruled): the whole path in the tooltip.
      setTip(dir, row.dir ?? '');
      setText(source, titleSourceText(row.titleSource));
      setText(shortId, row.shortId);
      setTip(shortId, `session ${row.id}; a click copies it`);
      // F16: shown whatever the session's state; `resumeCard` hides it again.
      const started = startedWithText(selected);
      setText(flagsText, started.text);
      setTip(flags, started.tip);
      setHidden(flags, started.text === '');
      // Line 3: F18's ticket, from `selected` (the server's address and name), first; F19: with
      // its status — a group's ticket its status alone, no name and no arrow (the group chip
      // names it). The button names the ticket the user set (F18), not the group's.
      const ticketShown = ticketHeader(selected, now());
      const ticketSet = ticketChip(selected) !== null;
      const alone = ticketShown?.group === true;
      ticketLink = ticketShown?.url ?? null;
      setText(ticketText, ticketShown === null || alone ? '' : ticketShown.name);
      setHidden(ticketText, alone);
      setText(
        ticketStatus,
        ticketShown === null || ticketShown.status === ''
          ? ''
          : alone
            ? ticketShown.status
            : ` · ${ticketShown.status}`,
      );
      setHidden(ticketStatus, ticketShown === null || ticketShown.status === '');
      setHidden(ticketArrow, alone);
      setTip(ticketItem, ticketShown?.tip ?? '');
      setHidden(ticketItem, ticketShown === null);
      if (ticketShown === null || ticketShown.status === '') {
        delete ticketItem.dataset['status'];
        delete ticketItem.dataset['category'];
      } else {
        setData(ticketItem, 'status', 'true');
        setData(ticketItem, 'category', ticketShown.category);
      }
      setText(ticketButton, ticketSet ? 'Ticket' : '+ ticket');
      setTip(ticketButton, ticketSet ? 'the ticket (t)' : 'set a ticket (t)');
      // None attached exactly when there is no chip (S2 12.3).
      const none = row.chip === null;
      setHidden(prsNone, !none);
      setText(prsButton, none ? '+ PR' : 'Pull requests');
      const open = splitPrs(Array.isArray(row.prs) ? row.prs : []).open;
      const key = open.map((pr) => pr.url).join('\n');
      if (key !== itemsKey) {
        itemsKey = key;
        // F4: the state's words apart, so that they alone take the state's tint (style.css).
        items.replaceChildren(
          ...open.map(() => {
            const item = element('span', 'header-pr');
            item.append(element('span', 'header-pr-name'), element('span', 'header-pr-state'));
            return item;
          }),
        );
      }
      open.forEach((pr, at) => {
        const item = items.children[at];
        const [name, state] = item instanceof HTMLElement ? item.children : [];
        if (
          item instanceof HTMLElement &&
          name instanceof HTMLElement &&
          state instanceof HTMLElement
        ) {
          const parts = prItemParts(pr);
          setData(item, 'url', pr.url);
          setText(name, parts.name);
          setText(state, parts.state);
          setData(state, 'level', parts.level);
        }
      });
      const note = noteLine(row, selected);
      setText(noteText, note.text);
      setData(noteText, 'empty', String(note.empty));
      paintAges();
      setHidden(head, false);
    },
    /**
     * @param {RowPayload} row
     * @param {SelectedPayload | null} selected
     * @param {string[]} resultLines
     */
    resumeCard(row, selected, resultLines) {
      card.dataset['card'] = 'resume';
      // F16: while the card prints the command under "Will run", the header's item is not shown
      // beside it (app.js calls `header` first, then this, on every render of the resume card).
      // A card without one — a word it cannot print, no directory, an expired session — leaves
      // the item shown (ruled on review 2): the flags are never printed twice, nor nowhere.
      const expired = selected?.expired === true || row.marks.includes('expired');
      if (typeof selected?.command === 'string' && !expired) {
        setHidden(flags, true);
      }
      showCard(`resume:${row.id}`, () => buildResume(row.id), [row, selected, resultLines]);
    },
    /** @param {RowPayload} row */
    elsewhere(row) {
      card.dataset['card'] = 'elsewhere';
      // F34: built again when the session is said to run in Claude Code's background, or no longer.
      const background = row.elsewhere?.background === true;
      showCard(
        `elsewhere:${background ? 'background' : 'terminal'}:${row.id}`,
        () => buildElsewhere(background),
        [row],
      );
    },
    /**
     * @param {RowPayload | null} row
     * @param {ExitMessage | null} exit
     */
    endedBar(row, exit) {
      card.dataset['card'] = 'ended';
      const sessionId = row?.id ?? null;
      const term = row?.terminal ?? exit?.term ?? null;
      showCard(`ended:${term}:${sessionId}`, () => buildEnded(sessionId, term), [exit]);
    },
    /**
     * F9: the card of the group whose closed caption is selected.
     * @param {{ section: string, group: string, size: number, needYou: number }} info
     */
    groupCard(info) {
      card.dataset['card'] = 'group';
      showCard(`group:${info.section}\n${info.group}`, buildGroup, [info]);
    },
    /** @param {NewFormDefaults} defaults */
    newForm(defaults) {
      card.dataset['card'] = 'new';
      shown = null; // a form opened again starts from its defaults
      card.replaceChildren(newFormOf(defaults, deps));
      setHidden(card, false);
    },
    hide() {
      // Hidden, not removed: what had the keyboard in it is given back by app.js.
      setHidden(head, true);
      setHidden(card, true);
      deps.watchFavourites(null); // a form that is no longer shown takes no list
    },
  };
}

/**
 * S2 12.6's new form: the directory (the known project directories as its list, most recent
 * first; any absolute path can be typed), the label, the group and claude's flags as typed, with
 * F15's ★ at the end of the flags and the row of favourite flags under them (favourites.js). Enter
 * in a field, on the ★ or the row, or Start sends `act new` with the flags field's text; the
 * server's answer is shown in the form, which stays open on a refusal so that the input can be
 * fixed. Esc closes it (app.js, in the capture phase). The field always starts empty.
 * F28: the group field's list is the groups the list shows, and when the session the form takes
 * its directory from is in a group, one chip right after the field puts that group into it (a
 * click, or Enter or Space on it); the field itself starts empty, as every field but Directory.
 * @param {NewFormDefaults} defaults
 * @param {CardsDeps} deps
 * @returns {HTMLFormElement}
 */
function newFormOf(defaults, deps) {
  const form = /** @type {HTMLFormElement} */ (element('form', 'card-new'));
  form.noValidate = true;
  form.autocomplete = 'off';
  const known = /** @type {HTMLDataListElement} */ (element('datalist', 'card-dirs'));
  known.id = 'card-new-dirs';
  for (const dir of defaults.dirs) {
    const option = document.createElement('option');
    option.value = dir;
    known.append(option);
  }
  /**
   * @param {string} name
   * @param {string} label
   * @param {string} value
   * @param {string} [hint]
   * @returns {HTMLInputElement}
   */
  const field = (name, label, value, hint) => {
    const input = /** @type {HTMLInputElement} */ (element('input', 'card-field'));
    input.name = name;
    input.value = value;
    input.spellcheck = false;
    if (hint !== undefined) {
      input.placeholder = hint;
    }
    const line = element('label', 'card-form-line');
    line.append(element('span', 'card-label', label), input);
    form.append(line);
    return input;
  };
  form.append(element('div', 'card-title', 'New session'));
  const dir = field('directory', 'Directory', defaults.dir, 'an absolute path');
  dir.setAttribute('list', known.id);
  form.append(known);
  const label = field('label', 'Label', '', 'optional; a ticket key at its start is the group');
  const group = field('group', 'Group', '', 'optional');
  if (defaults.groups.length > 0) {
    const groups = /** @type {HTMLDataListElement} */ (element('datalist', 'card-groups'));
    groups.id = 'card-new-groups';
    for (const one of defaults.groups) {
      const option = document.createElement('option');
      option.value = one;
      groups.append(option);
    }
    group.setAttribute('list', groups.id);
    group.closest('label')?.after(groups);
  }
  if (defaults.group !== null) {
    groupChip(group, defaults.group);
  }
  const flags = field('flags', 'Flags for claude', '', 'optional, e.g. --model opus');
  flags.classList.add('mono');
  // The field's name is its label's words alone, not the ★'s too, which the label also holds.
  const flagsLabel = flags.closest('label')?.querySelector('.card-label');
  if (flagsLabel instanceof HTMLElement) {
    flagsLabel.id = 'card-new-flags-label';
    flags.setAttribute('aria-labelledby', flagsLabel.id);
  }
  const start = /** @type {HTMLButtonElement} */ (
    element('button', 'card-button primary', 'Start')
  );
  start.type = 'submit';
  const actions = element('div', 'card-actions');
  const hint = element('span', 'card-hint', 'starts in this window · Esc closes');
  actions.append(start, hint);
  const lines = element('div', 'card-lines');
  // F15: the ★ at the end of the flags field, the chips of the favourites on the line under it.
  const favourites = favouriteControls({ form, flags, hint, lines, act: deps.act });
  const withStar = element('span', 'card-flags');
  flags.replaceWith(withStar);
  withStar.append(flags, favourites.star);
  form.append(favourites.line, actions, lines);
  deps.watchFavourites(favourites.update);
  let pending = false;
  form.addEventListener('keydown', refuseHeldEnter);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    pending = true;
    lines.textContent = 'starting…';
    void deps
      .act({
        kind: 'new',
        dir: dir.value,
        label: label.value,
        group: group.value,
        flags: flags.value,
      })
      .then((result) => {
        lines.textContent = linesOf(result).join('\n');
      })
      .finally(() => {
        pending = false;
      });
  });
  return form;
}

/**
 * F28: the chip of `name` (the group of the session the new form takes its directory from, as the
 * list shows it) right after the Group field, on its line: drawn as a favourite's chip, its text
 * cut as a chip's (28 characters, `…`), the whole name in its title and its name for assistive
 * technology, which say what it does. A click (its mousedown cancelled: it takes no keyboard), or
 * Enter or Space on it — a button, Tab's stop right after the field —, puts the name into the
 * field in place of what is there; it starts nothing and stays.
 * @param {HTMLInputElement} group the Group field, in its line's label
 * @param {string} name
 */
function groupChip(group, name) {
  const chip = /** @type {HTMLButtonElement} */ (
    element('button', 'card-group-chip mono', chipWords(name))
  );
  chip.type = 'button';
  const tip = `Use the group ${name}`;
  chip.title = tip;
  chip.setAttribute('aria-label', tip);
  chip.addEventListener('mousedown', (event) => event.preventDefault());
  chip.addEventListener('click', () => {
    group.value = name;
  });
  const withChip = element('span', 'card-group-field');
  group.replaceWith(withChip);
  withChip.append(group, chip);
  // The field's name is its label's words alone, not the chip's too, which the label also holds.
  const words = group.closest('label')?.querySelector('.card-label');
  if (words instanceof HTMLElement) {
    words.id = 'card-new-group-label';
    group.setAttribute('aria-labelledby', words.id);
  }
}
