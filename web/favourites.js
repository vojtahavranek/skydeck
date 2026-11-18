// The favourite flags of the new form (S2 12.6, follow-up F15): the ★ at the end of the field
// "Flags for claude" and the row of chips under it, one per favourite the server keeps (the list's
// `favourites`); web/cards.js puts them into its form. A chip is on while the field's words hold
// the favourite's words (favourite-text.js); a click on an off chip adds its text at the field's
// end, on an on one takes its runs out. The ★ saves the field's whole text, enabled only when
// `favouriteRefusal` sees no reason (its title says the reason); the server judges the rest and a
// refusal is the form's result line. The × of a chip removes the favourite, and the form's hint
// line offers `Undo` until the form closes or the favourites change again.
//
// The server answers an action before or after the list that holds it (it sends a page at most a
// list a second; app.js asks for one after each of these answers). So the chips show the list the
// page's own removals and Undos give at once — `ahead`, the lists they lead to, in order, until
// the server's lists have caught up; a list that is none of them is a change of another window,
// which takes the Undo away and drops `ahead` (a refused action drops it too) — and a save keeps
// the ★ disabled until a list after its answer: the chip comes with the server's list, never
// before (a refused save shows nothing).
//
// Keyboard (S2 12.9): the ★ and then the row come after the field and before Start; the row is
// one Tab stop (aria-activedescendant names its current chip), ← → move, Space turns the chip on
// or off, Delete and Backspace remove it, Enter starts as everywhere in the form. A disabled ★ is
// aria-disabled, not disabled: it keeps the keyboard and its place of Tab, so that pressing it
// never moves the keyboard. A click on a chip, its ×, the ★ or Undo takes no keyboard (their
// mousedown is cancelled), so that a click leaves the keyboard in the field. The keyboard never
// lands in a text field because of these controls (a key held down would type there, 12.9): the ★
// keeps it while it saves and once it is disabled; when the row that had it goes away (its last
// chip removed) the ★ takes it; Undo pressed from the keyboard gives it to the chip it puts back,
// and an Undo that goes away for another reason to the row (or the ★ when there is no chip). Every favourite reaches the DOM as text, sanitised for show and as
// stored in the field.

/** @import { ResultMessage } from '../src/window/protocol.ts' */
import {
  chipWords,
  favouriteRefusal,
  holdsFavourite,
  withFavourite,
  withoutFavourite,
} from './favourite-text.js';
import { sanitize } from './list-text.js';

const STAR_TIP = 'Save these flags as a favourite';
const REMOVE_TIP = 'Remove this favourite';

/** A number for each chip's id, unique in the page (aria-activedescendant). */
let made = 0;

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
 * A button that takes no keyboard on a click.
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function quietButton(className, text) {
  const button = /** @type {HTMLButtonElement} */ (element('button', className, text));
  button.type = 'button';
  button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}

/**
 * @param {readonly string[]} one
 * @param {readonly string[]} other
 */
const sameList = (one, other) =>
  one.length === other.length && one.every((text, i) => text === other[i]);

/**
 * @param {readonly string[]} list
 * @param {string} text
 * @param {number} at
 * @returns {string[]} the list with `text` put at place `at` (past the end: last), as the server does
 */
function withAt(list, text, at) {
  const made = [...list];
  made.splice(Math.min(at, made.length), 0, text);
  return made;
}

/**
 * The ★ and the chip row of a new form.
 * @param {object} parts
 * @param {HTMLFormElement} parts.form the new form (Enter on the row or the ★ submits it)
 * @param {HTMLInputElement} parts.flags the field "Flags for claude"
 * @param {HTMLElement} parts.hint the form's hint line (its text now is the one it goes back to)
 * @param {HTMLElement} parts.lines the form's result line
 * @param {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} parts.act
 * @returns {{ star: HTMLButtonElement, line: HTMLElement, update(favourites: string[]): void }}
 *   `line` is the form's line of the chip row (hidden while there is no favourite); `update` takes
 *   every list's favourites
 */
export function favouriteControls({ form, flags, hint, lines, act }) {
  const hintText = hint.textContent ?? '';
  const star = quietButton('card-button card-star', '★');
  star.setAttribute('aria-label', STAR_TIP);
  const row = element('div', 'card-favourites');
  row.tabIndex = 0;
  row.setAttribute('role', 'listbox');
  row.setAttribute('aria-multiselectable', 'true');
  row.setAttribute('aria-label', 'Favourite flags');
  const line = element('div', 'card-form-line card-favourites-line');
  line.append(element('span', 'card-label'), row);
  line.hidden = true;

  /** The favourites of the server's last list. @type {string[]} */
  let favourites = [];
  /** The lists this page's own removals and Undos lead to, in order, not yet listed. */
  /** @type {string[][]} */
  let ahead = [];
  /** The favourites the chips show: the last of `ahead`, else the server's. */
  const shown = () => ahead.at(-1) ?? favourites;
  /** What the chips show now. @type {string[]} */
  let drawn = [];
  /** The chip that has the row's keyboard. */
  let current = 0;
  /** A save waits for its answer, then (`listAfter`) for a list. */
  let saving = false;
  let listAfter = false;
  /** The list a save that works leads to: this page's own change too, though not drawn ahead. */
  /** @type {string[] | null} */
  let saved = null;
  /** The removal the hint offers to undo. @type {{ text: string, at: number } | null} */
  let undo = null;
  /** The result line a favourite's refusal wrote, so that only it is cleared. */
  /** @type {string | null} */
  let refused = null;

  /** @param {ResultMessage} result */
  const answered = (result) => {
    if (result.ok) {
      if (refused !== null && lines.textContent === refused) {
        lines.textContent = '';
      }
      refused = null;
      return;
    }
    refused = result.error ?? result.lines.join('\n');
    lines.textContent = refused;
  };

  /** The row takes the keyboard, on the chip at `at`; while there is no chip, the ★. */
  const rowTakes = (/** @type {number} */ at) => {
    if (drawn.length === 0) {
      star.focus();
      return;
    }
    current = Math.max(0, Math.min(at, drawn.length - 1));
    paint();
    row.focus();
  };

  /** What had the keyboard goes away: it stays in the form, never in a text field. */
  const keepKeyboard = (/** @type {Element} */ going) => {
    if (going.contains(document.activeElement)) {
      rowTakes(current);
    }
  };

  const plainHint = () => {
    undo = null;
    if (hint.textContent !== hintText || hint.children.length > 0) {
      keepKeyboard(hint);
      hint.textContent = hintText;
    }
  };

  /** S2 12.6's `Removed <text> · Undo`, the text cut as the chip's, the whole in its title. */
  const offerUndo = () => {
    if (undo === null) {
      return;
    }
    const { text, at } = undo;
    const removed = element('span', 'card-hint-favourite mono', chipWords(sanitize(text)));
    removed.title = sanitize(text);
    const button = quietButton('card-undo', 'Undo');
    button.addEventListener('click', () => {
      const keyboard = document.activeElement === button;
      undo = null;
      hint.textContent = hintText;
      if (!shown().includes(text)) {
        ahead.push(withAt(shown(), text, at));
        draw();
        void act({ kind: 'favourite-add', text, at }).then(refusedDrops);
      }
      if (keyboard) {
        rowTakes(drawn.indexOf(text)); // the chip it put back
      }
    });
    hint.replaceChildren('Removed ', removed, ' · ', button);
  };

  /** The answer to a removal or an Undo: a refusal drops what the page expected. */
  const refusedDrops = (/** @type {ResultMessage} */ result) => {
    if (!result.ok) {
      ahead = [];
      draw();
    }
    answered(result);
  };

  /** The states of the chips and the ★ for the field's text now. */
  const paint = () => {
    const text = flags.value;
    [...row.children].forEach((chip, at) => {
      if (!(chip instanceof HTMLElement)) {
        return;
      }
      const on = holdsFavourite(text, drawn[at] ?? '');
      chip.dataset['on'] = String(on);
      chip.setAttribute('aria-selected', String(on));
      chip.dataset['current'] = String(at === current);
      if (at === current) {
        row.setAttribute('aria-activedescendant', chip.id);
      }
    });
    const reason = saving ? null : favouriteRefusal(text, shown());
    star.setAttribute('aria-disabled', String(saving || reason !== null));
    star.title = reason === null ? STAR_TIP : `${STAR_TIP}\n${reason}`;
  };

  /** @param {string} favourite */
  const chipOf = (favourite) => {
    const chip = element('div', 'card-favourite');
    chip.id = `card-favourite-${++made}`;
    chip.setAttribute('role', 'option');
    chip.title = sanitize(favourite);
    const x = element('span', 'card-favourite-x', '×');
    x.title = REMOVE_TIP;
    x.setAttribute('aria-hidden', 'true');
    chip.append(element('span', 'card-favourite-text mono', chipWords(sanitize(favourite))), x);
    return chip;
  };

  /** The chips of `shown()`; the current one stays on its favourite, else at its place. */
  const draw = () => {
    const list = shown();
    if (!sameList(list, drawn)) {
      const was = drawn[current];
      const kept = was === undefined ? -1 : list.indexOf(was);
      current = kept >= 0 ? kept : Math.max(0, Math.min(current, list.length - 1));
      drawn = [...list];
      const had = row.contains(document.activeElement);
      row.replaceChildren(...drawn.map(chipOf));
      line.hidden = drawn.length === 0;
      if (had && drawn.length === 0) {
        star.focus(); // the row went away: the keyboard goes to the ★ before it, never into the field
      }
    }
    paint();
  };

  /** @param {number} at */
  const toggle = (at) => {
    const favourite = drawn[at];
    if (favourite === undefined) {
      return;
    }
    current = at;
    flags.value = holdsFavourite(flags.value, favourite)
      ? withoutFavourite(flags.value, favourite)
      : withFavourite(flags.value, favourite);
    paint();
  };

  /** @param {number} at */
  const remove = (at) => {
    const favourite = drawn[at];
    if (favourite === undefined) {
      return;
    }
    current = at;
    undo = { text: favourite, at };
    ahead.push(drawn.filter((one) => one !== favourite));
    offerUndo();
    draw();
    void act({ kind: 'favourite-remove', text: favourite }).then((result) => {
      if (!result.ok && undo?.text === favourite) {
        plainHint();
      }
      refusedDrops(result);
      const back = drawn.indexOf(favourite);
      if (!result.ok && back >= 0) {
        current = back; // nothing changed: the chip has the row's keyboard as before
        paint();
      }
    });
  };

  const save = () => {
    if (star.getAttribute('aria-disabled') === 'true') {
      return;
    }
    const text = flags.value;
    plainHint(); // the favourites change again
    saving = true;
    saved = [...shown(), text.trim()];
    paint();
    void act({ kind: 'favourite-add', text }).then((result) => {
      if (!result.ok) {
        saved = null;
      }
      answered(result);
      // The list that holds a save that worked can come after the answer: until then the ★ waits.
      listAfter = result.ok && !shown().includes(text.trim());
      saving = listAfter;
      paint();
    });
  };

  /** The chip under `target`, and whether it is its ×. */
  const hit = (/** @type {EventTarget | null} */ target) => {
    const chip = target instanceof Element ? target.closest('.card-favourite') : null;
    const at = chip === null ? -1 : [...row.children].indexOf(chip);
    return { at, x: target instanceof Element && target.closest('.card-favourite-x') !== null };
  };

  row.addEventListener('mousedown', (event) => event.preventDefault());
  row.addEventListener('click', (event) => {
    const { at, x } = hit(event.target);
    if (at < 0) {
      return;
    }
    if (x) {
      remove(at);
    } else {
      toggle(at);
    }
  });
  row.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const last = drawn.length - 1;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        if (event.shiftKey) {
          return;
        }
        current = Math.max(0, Math.min(last, current + (event.key === 'ArrowLeft' ? -1 : 1)));
        paint();
        break;
      case ' ':
        if (!event.repeat) {
          toggle(current);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (!event.repeat) {
          remove(current);
        }
        break;
      case 'Enter':
        if (!event.repeat) {
          form.requestSubmit();
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  star.addEventListener('click', save);
  star.addEventListener('keydown', (event) => {
    // V6: Enter is Start everywhere in the form; Space (or a click) presses the ★.
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) {
        form.requestSubmit();
      }
    }
  });
  flags.addEventListener('input', paint);
  draw();

  return {
    star,
    line,
    update(list) {
      if (listAfter) {
        listAfter = false; // a list after the save's answer holds it
        saving = false;
      }
      const own = ahead.findIndex((one) => sameList(one, list));
      if (own >= 0) {
        ahead = ahead.slice(own + 1); // the server has caught up with this page's own change
      } else if (saved !== null && sameList(list, saved)) {
        ahead = []; // and with the save, which came after every change ahead
        saved = null;
      } else if (!sameList(list, favourites)) {
        ahead = [];
        saved = null;
        plainHint(); // another window changed the favourites
      }
      favourites = [...list];
      draw();
    },
  };
}
