// Follow-up F41 (S2 12.14): the tour of the window, a few steps over the real page as it is — with
// the sessions it has, or with none —, each pointing at one region (web/tour-text.js): the region
// stands out in a ring whose shadow dims the rest of the page, and a small panel beside it says
// what is there, `Step n of N`, with `Back`, `Next` (`Done` on the last step) and `Skip the tour`.
//
// It is modal as a dialog is (D2): app.js makes the page inert under it, and a transparent layer
// over the whole window takes every click outside the panel, so that the page under it takes no
// key and no click; nothing lies over a region once the tour is gone, and the terminal's own
// layers are not restyled. Keys come from app.js's capture phase (`key()`): Enter or → goes on
// (Enter on a button of the panel presses that button), ← goes back, Esc skips, Tab and Shift+Tab
// walk the panel's buttons and stay in it; each acts once per press. Space (with any modifiers)
// and Shift+Enter do nothing: taken and cancelled at their keydown and their keyup, so that they
// press no button — a sentence typed as the tour pops up must not walk it and end it. The ring
// follows its region when the region changes size without a window resize (a ResizeObserver on
// the region, dropped when the step changes and at the close).
//
// Seen (the brief's Behaviour 4): ending the tour with `Done`, `Skip the tour` or Esc marks it seen
// in the page's own localStorage (TOUR_KEY), as the theme's choice is kept (web/theme.js); nothing
// goes to the server. `fresh()` tells app.js whether it may start by itself: only while the mark
// is absent and the storage can be read and written (a write and its removal, the probe). A tour
// that app.js ends (`abort()`: the connection lost, a fatal bar) marks nothing. The words are those
// of the mode the page shows at its opening (`<html data-display>`, the page's app-only and
// tab-only rule). Every text reaches the DOM as text.

/** @import { Part, TourStep } from './tour-text.js' */
import {
  placeNear,
  REGIONS,
  stepText,
  TOUR_KEY,
  TOUR_SEEN,
  TOUR_TEXTS,
  tourSteps,
} from './tour-text.js';

/**
 * @typedef {object} TourDeps
 * @property {() => void} closed  called once whenever the tour closes, whatever closed it
 */

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
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function button(className, text) {
  const made = /** @type {HTMLButtonElement} */ (element('button', className, text));
  made.type = 'button';
  return made;
}

/**
 * One part of a line: text as text, a key as a `kbd`, a text to type as `code`, a control's words
 * marked as such.
 * @param {Part} part
 * @returns {Node}
 */
function partNode(part) {
  if (typeof part === 'string') {
    return document.createTextNode(part);
  }
  if ('key' in part) {
    return element('kbd', 'tour-key', part.key);
  }
  if ('typed' in part) {
    return element('code', 'tour-typed', part.typed);
  }
  return element('span', 'tour-ui', part.ui);
}

/**
 * Space, with or without Shift.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function isSpace(event) {
  return event.key === ' ' || event.code === 'Space';
}

/**
 * Whether the tour may start by itself: the storage holds no mark and can be read and written.
 * @returns {boolean}
 */
function fresh() {
  try {
    if (localStorage.getItem(TOUR_KEY) === TOUR_SEEN) {
      return false;
    }
    localStorage.setItem(TOUR_KEY, 'probe');
    localStorage.removeItem(TOUR_KEY);
    return true;
  } catch {
    return false; // no storage: it could never be marked seen
  }
}

function markSeen() {
  try {
    localStorage.setItem(TOUR_KEY, TOUR_SEEN);
  } catch {
    // Nothing to do: the probe passed when it started by itself.
  }
}

/**
 * @param {HTMLElement} root  #tour
 * @param {TourDeps} deps
 */
export function createTour(root, deps) {
  const scrim = element('div', 'tour-scrim');
  const spot = element('div', 'tour-spot');
  const panel = element('div', 'tour-panel');
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', TOUR_TEXTS.label);
  const title = element('div', 'tour-title');
  title.id = 'tour-title';
  panel.setAttribute('aria-describedby', 'tour-title');
  const lines = element('div', 'tour-lines');
  const count = element('span', 'tour-count');
  const skip = button('tour-skip', TOUR_TEXTS.skip);
  const back = button('tour-back', TOUR_TEXTS.back);
  const next = button('tour-next', TOUR_TEXTS.next);
  const foot = element('div', 'tour-foot');
  foot.append(count, element('span', 'tour-gap'), skip, back, next);
  panel.append(title, lines, foot);
  root.replaceChildren(scrim, spot, panel);
  root.hidden = true;

  let shown = false;
  let at = 0;
  /** @type {TourStep[]} */
  let steps = [];
  /** The region the ring is on: the observer places the ring again when its size changes. */
  /** @type {Element | null} */
  let watched = null;
  const follow = new ResizeObserver(() => place());
  /** @param {Element | null} target */
  const watch = (target) => {
    if (target === watched) {
      return;
    }
    follow.disconnect();
    watched = target;
    if (target !== null) {
      follow.observe(target);
    }
  };

  /** The ring over the step's region, and the panel beside it, as the page is laid out now. */
  const place = () => {
    const step = steps[at];
    if (!shown || step === undefined) {
      return;
    }
    const target = document.querySelector(REGIONS[step.region]);
    watch(target);
    const box = target?.getBoundingClientRect();
    const viewport = { width: innerWidth, height: innerHeight };
    const size = panel.getBoundingClientRect();
    if (box === undefined || box.width === 0 || box.height === 0) {
      spot.hidden = true;
      root.dataset['spot'] = 'none';
      const { left, top } = placeNear(
        { left: 0, top: 0, width: viewport.width, height: viewport.height },
        size,
        viewport,
      );
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px` });
      return;
    }
    spot.hidden = false;
    delete root.dataset['spot'];
    Object.assign(spot.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    const { left, top } = placeNear(box, size, viewport);
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px` });
  };
  addEventListener('resize', place);

  const draw = () => {
    const step = steps[at];
    if (step === undefined) {
      return;
    }
    root.dataset['region'] = step.region;
    root.dataset['step'] = String(at + 1);
    title.textContent = step.title;
    lines.replaceChildren(
      ...step.lines.map((line) => {
        const made = element('p', 'tour-line');
        made.append(...line.map(partNode));
        return made;
      }),
    );
    count.textContent = stepText(at + 1, steps.length);
    back.disabled = at === 0;
    next.textContent = at === steps.length - 1 ? TOUR_TEXTS.done : TOUR_TEXTS.next;
    place();
    next.focus();
  };

  /** @param {boolean} seen  whether the user ended it (Done, Skip, Esc), which marks it seen */
  const close = (seen) => {
    if (!shown) {
      return;
    }
    shown = false;
    if (seen) {
      markSeen();
    }
    // The keyboard leaves the panel before it is hidden: app.js gives it back.
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    watch(null);
    root.hidden = true;
    delete root.dataset['region'];
    delete root.dataset['step'];
    deps.closed();
  };

  const forward = () => {
    if (at >= steps.length - 1) {
      close(true);
      return;
    }
    at++;
    draw();
  };
  const backward = () => {
    if (at > 0) {
      at--;
      draw();
    }
  };

  next.addEventListener('click', forward);
  back.addEventListener('click', backward);
  skip.addEventListener('click', () => close(true));
  // A click outside the panel does nothing, and leaves the keyboard in the panel.
  scrim.addEventListener('mousedown', (event) => event.preventDefault());
  // A button pressed by Space is pressed at the keyup: that too is cancelled, whatever modifiers
  // are held (a second guard behind the cancel at the keydown).
  root.addEventListener(
    'keyup',
    (event) => {
      if (shown && isSpace(event)) {
        event.preventDefault();
      }
    },
    true,
  );

  return {
    /** Shows the first step, in the words of the mode the page shows; the keyboard on `Next`. */
    open() {
      if (shown) {
        return;
      }
      steps = tourSteps(document.documentElement.dataset['display'] === 'app' ? 'app' : 'tab');
      at = 0;
      shown = true;
      root.hidden = false;
      draw();
    },
    /** Ends the tour without marking it seen (app.js: the connection lost, a fatal bar). */
    abort() {
      close(false);
    },
    /**
     * A keydown while shown, from app.js's capture phase: true when the tour took it (and
     * cancelled it) — Enter, →, ←, Esc, Tab and Shift+Tab, and Space with any modifiers and
     * Shift+Enter, which do nothing.
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    key(event) {
      if (!shown) {
        return false;
      }
      if (event.isComposing || event.keyCode === 229) {
        return false; // a key of an IME composition is the IME's
      }
      // Space, whatever modifiers are held, would press the focused button (at its keyup): nothing.
      // No window chord and no reload key is a Space (web/keys.js).
      if (isSpace(event)) {
        event.preventDefault();
        return true;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return false;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [skip, back, next].filter((one) => !one.disabled);
        const from = controls.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        const to =
          from === -1
            ? event.shiftKey
              ? controls.length - 1
              : 0
            : (from + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[to]?.focus();
        return true;
      }
      // Shift+Enter would press the focused button: nothing.
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        return true;
      }
      if (event.shiftKey) {
        return false;
      }
      const act =
        event.key === 'Escape'
          ? () => close(true)
          : event.key === 'ArrowRight'
            ? forward
            : event.key === 'ArrowLeft'
              ? backward
              : event.key === 'Enter'
                ? () => {
                    const holder = document.activeElement;
                    if (holder instanceof HTMLButtonElement && panel.contains(holder)) {
                      holder.click();
                    } else {
                      forward();
                    }
                  }
                : null;
      if (act === null) {
        return false;
      }
      event.preventDefault();
      if (!event.repeat) {
        act();
      }
      return true;
    },
    fresh,
    /** @returns {boolean} */
    shown: () => shown,
  };
}
