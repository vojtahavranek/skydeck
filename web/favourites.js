// The favourite flags of the new form (S2 12.6, follow-up F15): the ★ at the end of the field
// "Flags for claude" and the row of chips under it, one per favourite the server keeps (the list's
// `favourites`); web/cards.js puts them into its form. A chip is on while the field's words hold
// the favourite's words (favourite-text.js); a click on an off chip adds its text at the field's
// end, on an on one takes its runs out. The ★ saves the field's whole text, enabled only when
// `favouriteRefusal` sees no reason (its title says the reason); the server judges the rest and a
// refusal is the form's result line. The × of a chip removes the favourite, and the form's hint
// line offers `Undo` until the form closes or the favourites change again.
//
// Keyboard (S2 12.9): the ★ and then the row come after the field and before Start; the row is
// one Tab stop (aria-activedescendant names its current chip), ← → move, Space turns the chip on
// or off, Delete and Backspace remove it, Enter starts as everywhere in the form. A click on a
// chip, its × or Undo takes no keyboard (their mousedown is cancelled), so that a click leaves the
// keyboard in the field. When the row, or Undo, that had the keyboard goes away, the field takes
// it. Every favourite reaches the DOM as text (sanitised for show, as typed in the field).

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

  /** The favourites the chips show, in their order. @type {string[]} */
  let favourites = [];
  /** The chip that has the row's keyboard. */
  let current = 0;
  /** A save is waiting for its answer. */
  let saving = false;
  /** The removal the hint offers to undo: the list before it and the list it gives. */
  /** @type {{ text: string, at: number, before: string[], after: string[] } | null} */
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

  /** The keyboard stays in the form when what had it goes away. */
  const keepKeyboard = (/** @type {Element} */ going) => {
    if (going.contains(document.activeElement)) {
      flags.focus();
    }
  };

  const plainHint = () => {
    undo = null;
    if (hint.textContent !== hintText || hint.children.length > 0) {
      keepKeyboard(hint);
      hint.textContent = hintText;
    }
  };

  /** S2 12.6's `Removed <text> · Undo`. */
  const offerUndo = () => {
    if (undo === null) {
      return;
    }
    const { text, at } = undo;
    const shown = element('span', 'card-hint-favourite mono', chipWords(sanitize(text)));
    shown.title = sanitize(text);
    const button = quietButton('card-undo', 'Undo');
    button.addEventListener('click', () => {
      plainHint();
      void act({ kind: 'favourite-add', text, at }).then(answered);
    });
    hint.replaceChildren('Removed ', shown, ' · ', button);
  };

  /** The states of the chips and the ★ for the field's text now. */
  const paint = () => {
    const text = flags.value;
    [...row.children].forEach((chip, at) => {
      if (!(chip instanceof HTMLElement)) {
        return;
      }
      const on = holdsFavourite(text, favourites[at] ?? '');
      chip.dataset['on'] = String(on);
      chip.setAttribute('aria-selected', String(on));
      chip.dataset['current'] = String(at === current);
      if (at === current) {
        row.setAttribute('aria-activedescendant', chip.id);
      }
    });
    const reason = saving ? null : favouriteRefusal(text, favourites);
    star.disabled = saving || reason !== null;
    star.title = reason === null ? STAR_TIP : `${STAR_TIP}\n${reason}`;
  };

  /** @param {number} at */
  const toggle = (at) => {
    const favourite = favourites[at];
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
    const favourite = favourites[at];
    if (favourite === undefined) {
      return;
    }
    current = at;
    undo = {
      text: favourite,
      at,
      before: favourites,
      after: favourites.filter((one) => one !== favourite),
    };
    offerUndo();
    void act({ kind: 'favourite-remove', text: favourite }).then((result) => {
      if (!result.ok && undo?.text === favourite) {
        plainHint();
      }
      answered(result);
    });
  };

  const save = () => {
    if (star.disabled) {
      return;
    }
    saving = true;
    paint();
    void act({ kind: 'favourite-add', text: flags.value })
      .then(answered)
      .finally(() => {
        saving = false;
        paint();
      });
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
    const last = favourites.length - 1;
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
  paint();

  return {
    star,
    line,
    update(list) {
      if (sameList(list, favourites)) {
        return;
      }
      if (undo !== null && !sameList(list, undo.before) && !sameList(list, undo.after)) {
        plainHint(); // the favourites changed again
      }
      const was = favourites[current];
      favourites = [...list];
      const kept = was === undefined ? -1 : favourites.indexOf(was);
      current = kept >= 0 ? kept : Math.max(0, Math.min(current, favourites.length - 1));
      row.replaceChildren(...favourites.map(chipOf));
      if (favourites.length === 0) {
        keepKeyboard(line);
      }
      line.hidden = favourites.length === 0;
      paint();
    },
  };
}
