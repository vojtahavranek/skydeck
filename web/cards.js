// The right side's header and cards (S2 7.8, 7.9, 12.5, 12.6; plan task 29): the read-only header
// of stage A (S2 19: title, group, state, directory, short id, design 7.3's chip), the resume
// card, the card of a session running in another terminal, the ended bar and the new form. Its
// interface is contract 2.9's. Every server string reaches the DOM through textContent.
//
// How app.js calls it: on a change of what the right side shows, `hide()` (every card and the
// header), then `header(row)` and at most one card. `act` is app.js's: it adds `t` and `id`, and
// for `resume` and `new` the size of the terminal area; a successful resume or new selects its
// session there and gives its terminal the keyboard (S2 11.3).
//
// Keyboard and selection (S2 12.9, contract 2.9): this module never calls focus(). The header and
// a card are filled in place while they show the same session or terminal, and a text is set only
// when it changed, so that text the user selected to copy stays selected when a list changes
// something else, and a render between the mousedown and the mouseup on a button loses no click.
// A card whose facts changed while one of its buttons had the keyboard gives the keyboard up: an
// Enter must not press a button for what the user has not seen (nothing resumes but on purpose);
// app.js gives it to the zone after the call. The short id's copy takes no keyboard on a click.

/** @import { ElsewherePayload, ExitMessage, ResultMessage, RowPayload, SelectedPayload } from '../src/window/protocol.ts' */
import { chipText } from './list-text.js';

/**
 * @typedef {object} CardsDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(id: string) => void} select
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COPIED_MS = 2000;

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
 * The state of the header (S2 19: states only in stage A): "starting…", "running in another
 * terminal", or the row's state with its detail in brackets (design 7.4).
 * @param {RowPayload} row
 */
function stateOf(row) {
  if (row.starting) {
    return 'starting…';
  }
  if (row.elsewhere !== null) {
    return 'running in another terminal';
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
 * @param {HTMLElement} root
 * @param {CardsDeps} deps
 */
export function createCards(root, deps) {
  // --- the header (S2 12.5, read-only in stage A) -------------------------------------------
  const head = element('div', 'card-header');
  const title = element('span', 'header-title');
  const group = element('span', 'header-group');
  const state = element('span', 'header-state');
  const chip = element('span', 'header-chip');
  const dir = element('span', 'header-dir');
  const shortId = element('span', 'header-id');
  const copied = element('span', 'header-copied');
  const top = element('div', 'header-top');
  top.append(title, group, state, chip);
  const sub = element('div', 'header-sub');
  sub.append(dir, shortId, copied);
  head.append(top, sub);
  /** The whole id the short id copies. */
  let headId = '';
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

  /** @param {RowPayload} _row */
  function buildElsewhere(_row) {
    const where = fact('Process', 'card-where');
    const place = fact('Directory', 'card-dir');
    const why = element(
      'div',
      'card-why',
      'It cannot be shown here: its terminal belongs to another program, and skydeck never takes it over. Once it has ended it can be resumed in the window.',
    );
    return {
      parts: [
        element('div', 'card-title', 'Running in another terminal'),
        where.line,
        place.line,
        why,
      ],
      /** @param {RowPayload} row */
      fill(row) {
        /** @type {ElsewherePayload | null} */
        const other = row.elsewhere;
        setText(
          where.value,
          other === null
            ? 'not known'
            : `pid ${other.pid}${other.tty === null ? '' : ` · ${other.tty}`}`,
        );
        setText(place.value, other?.dir ?? row.dir ?? 'not known');
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
    /** @param {RowPayload | null} row */
    header(row) {
      if (row === null) {
        setHidden(head, true);
        return;
      }
      if (row.id !== headId) {
        // "id copied" was about the session shown before.
        if (copiedTimer !== null) clearTimeout(copiedTimer);
        copiedTimer = null;
        setText(copied, '');
      }
      headId = row.id;
      setText(title, row.title);
      setText(group, row.group ?? '');
      setHidden(group, row.group === null);
      group.title = row.groupSource === 'title' ? 'group (from the title)' : 'group';
      setText(state, stateOf(row));
      // Design 7.3's chip in S2 12.3's words — the list's own text of it (task 27).
      setText(chip, row.chip === null ? '' : chipText(row.chip));
      setHidden(chip, row.chip === null);
      chip.dataset['level'] = row.chip?.level ?? '';
      setText(dir, row.dir ?? 'directory not known');
      // One line, cut with an ellipsis (a fixed height; ruled): the whole path in the tooltip.
      dir.title = row.dir ?? '';
      setText(shortId, row.shortId);
      shortId.title = `session ${row.id}; a click copies it`;
      setHidden(head, false);
    },
    /**
     * @param {RowPayload} row
     * @param {SelectedPayload | null} selected
     * @param {string[]} resultLines
     */
    resumeCard(row, selected, resultLines) {
      card.dataset['card'] = 'resume';
      showCard(`resume:${row.id}`, () => buildResume(row.id), [row, selected, resultLines]);
    },
    /** @param {RowPayload} row */
    elsewhere(row) {
      card.dataset['card'] = 'elsewhere';
      showCard(`elsewhere:${row.id}`, () => buildElsewhere(row), [row]);
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
    /** @param {{ dir: string, dirs: string[] }} defaults */
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
    },
  };
}

/**
 * S2 12.6's new form: the directory (the known project directories as its list, most recent
 * first; any absolute path can be typed), the label, the group and claude's flags as typed. Enter
 * in a field or Start sends `act new`; the server's answer is shown in the form, which stays open
 * on a refusal so that the input can be fixed. Esc closes it (app.js, in the capture phase).
 * @param {{ dir: string, dirs: string[] }} defaults
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
  const flags = field('flags', 'Flags for claude', '', 'optional, e.g. --model opus');
  flags.classList.add('mono');
  const start = /** @type {HTMLButtonElement} */ (
    element('button', 'card-button primary', 'Start')
  );
  start.type = 'submit';
  const actions = element('div', 'card-actions');
  actions.append(start, element('span', 'card-hint', 'starts in this window · Esc closes'));
  const lines = element('div', 'card-lines');
  form.append(actions, lines);
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
