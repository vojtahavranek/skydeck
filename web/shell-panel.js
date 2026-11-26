// A session's shell (issue #199; S2 12.6, 12.9): the split of the terminal area between the
// session's terminal (`#terminal`) and its shell's panel (`#shell`), and the bar between the two
// (`#shell-bar`, index.html). While the panel is drawn (`draw(true)`) the terminal area — the right
// zone's box less its borders and the cards — is laid out by web/shell-panel-split.js's rules:
// `data-shell="split"` on the zone, the panel the rules' height in px and the session's terminal
// the rest; or, in an area too low for both, `data-shell="full"`, the panel over the whole area and
// neither the session's terminal nor the bar laid out (web/shell-panel.css). A `ResizeObserver` on
// the zone and the cards applies the rules again whenever the area changes. Not drawn, the zone has
// no `data-shell` and the page is as before. Each terminal view proposes its own size from its own
// box when it changes (web/terminal-view.js), so both programs are told their new sizes.
//
// The bar, modelled on the list's handle (web/list-width.js): a press of the primary button and a
// move change the shell's height with the pointer, live, within the rules' bounds; the drag begins
// once the pointer is more than DRAG_SLIP px from the y of its press (whole px). The release (or
// the pointer lost: it is captured) keeps the height in the page's own localStorage
// (SHELL_HEIGHT_KEY), one height for every session; a begun drag released at the y of its press
// stores nothing. A double click removes it (back to a third), unless its second press became a
// drag. Another page of the profile follows at once (the `storage` event). Storage that throws or
// is missing keeps nothing: the height holds for the life of the page. The bar takes no keyboard
// and no key: it is not focusable and every mousedown on it is cancelled; while `blocked()` (a
// dialog) a press and a double click do nothing, and a drag that meets one ends as at a release.
// Nothing of it goes to the server.

import {
  atPress,
  BAR_TITLE,
  dragBegun,
  draggedHeight,
  heightOf,
  layoutOf,
  SHELL_HEIGHT_KEY,
} from './shell-panel-split.js';

/** @returns {string | null} the stored value; null when storage throws */
function read() {
  try {
    return localStorage.getItem(SHELL_HEIGHT_KEY);
  } catch {
    return null;
  }
}

/** Keeps `height`, or no value for null. Storage that refuses keeps nothing.
 *  @param {number | null} height */
function write(height) {
  try {
    if (height === null) {
      localStorage.removeItem(SHELL_HEIGHT_KEY);
    } else {
      localStorage.setItem(SHELL_HEIGHT_KEY, String(height));
    }
  } catch {
    // The height holds for the life of the page.
  }
}

/**
 * @typedef {object} ShellPanelDeps
 * @property {HTMLElement} zone  the right zone (`#right-zone`), whose box is the terminal area's
 * @property {HTMLElement} cards  what stands above the terminals (`#cards`)
 * @property {HTMLElement} bar  `#shell-bar`
 * @property {HTMLElement} panel  `#shell`
 * @property {() => boolean} blocked  whether a dialog is shown (app.js's `modal`)
 * @property {() => number} least  the px of MIN_ROWS rows (the shells' view's `heightFor`)
 * @property {() => void} [laidOut]  the split's mode changed (the session's terminal shown or not)
 */

/** @typedef {'split' | 'full'} ShellMode */

/** @param {ShellPanelDeps} deps */
export function createShellPanel(deps) {
  const { zone, cards, bar, panel } = deps;
  const root = document.documentElement;
  bar.title = BAR_TITLE;

  /** Whether the panel is drawn (app.js's render). */
  let drawn = false;
  /** The stored height, read again at every `storage` event. */
  let stored = heightOf(read());
  /** The drag under way: its pointer, the y of its press and the y it is at now, the shell's
   *  height at the press and now, whether it has begun.
   *  @type {{ pointer: number, y: number, at: number, from: number, height: number, moved: boolean } | null} */
  let drag = null;
  /** Whether the last press on the bar became a drag (a double click's second press that did is
   *  no double click). */
  let lastMoved = false;

  /** The terminal area's height: the zone's box less its borders and the cards, unrounded. */
  const area = () => {
    const style = getComputedStyle(zone);
    /** @param {string} side */
    const border = (side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
    const box = zone.getBoundingClientRect().height - border('top') - border('bottom');
    return box - cards.getBoundingClientRect().height;
  };

  /** The rules' layout now, with the dragged height while a drag has begun. */
  const layout = () => layoutOf(area(), drag?.moved === true ? drag.height : stored, deps.least());

  const apply = () => {
    const before = zone.dataset['shell'] ?? null;
    if (!drawn) {
      delete zone.dataset['shell'];
      panel.style.removeProperty('height');
    } else {
      const now = layout();
      zone.dataset['shell'] = now.mode;
      if (now.mode === 'split') {
        panel.style.height = `${now.shell}px`;
      } else {
        panel.style.removeProperty('height');
      }
    }
    if ((zone.dataset['shell'] ?? null) !== before) {
      deps.laidOut?.();
    }
  };

  const observer = new ResizeObserver(() => {
    if (drawn) {
      apply();
    }
  });
  observer.observe(zone);
  observer.observe(cards);

  addEventListener('storage', (event) => {
    if (event.key === null || event.key === SHELL_HEIGHT_KEY) {
      stored = heightOf(read());
      apply();
    }
  });

  const end = () => {
    if (drag === null) {
      return;
    }
    const { pointer, moved, height, y, at } = drag;
    drag = null;
    lastMoved = moved;
    delete bar.dataset['dragging'];
    delete root.dataset['shellDrag'];
    if (bar.hasPointerCapture(pointer)) {
      bar.releasePointerCapture(pointer);
    }
    if (moved && !atPress(y, at)) {
      stored = Math.round(height);
      write(stored);
    }
    apply(); // back to the stored height when nothing was kept
  };

  // No keyboard, no text selection, no middle-button scroll: for every button.
  bar.addEventListener('mousedown', (event) => event.preventDefault());
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag !== null || deps.blocked() || !drawn) {
      return;
    }
    const from = panel.getBoundingClientRect().height;
    const y = event.clientY;
    drag = { pointer: event.pointerId, y, at: y, from, height: from, moved: false };
    lastMoved = false;
    bar.setPointerCapture(event.pointerId);
    bar.dataset['dragging'] = '';
    root.dataset['shellDrag'] = '';
  });
  bar.addEventListener('pointermove', (event) => {
    if (drag === null || event.pointerId !== drag.pointer) {
      return;
    }
    if (deps.blocked()) {
      end();
      return;
    }
    if (!drag.moved && !dragBegun(drag.y, event.clientY)) {
      return; // a slip: no drag yet
    }
    drag.at = event.clientY;
    const now = layoutOf(area(), draggedHeight(drag.from, drag.y, event.clientY), deps.least());
    drag.moved = true;
    drag.height = now.mode === 'split' ? now.shell : drag.height;
    apply();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    bar.addEventListener(type, (event) => {
      if (drag !== null && event instanceof PointerEvent && event.pointerId === drag.pointer) {
        if (type === 'pointerup') {
          drag.at = event.clientY;
        }
        end();
      }
    });
  }
  bar.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (deps.blocked() || lastMoved) {
      return;
    }
    stored = null;
    write(null);
    apply();
  });

  return {
    /**
     * The panel drawn (`shown`) or not: the split applied, or the zone as before.
     * @param {boolean} shown
     */
    draw(shown) {
      drawn = shown;
      if (!shown) {
        end();
      }
      apply();
    },
    /**
     * The panel's height in px as the rules give it for the area now (the whole area when it is
     * too low): an act's first size is measured for it.
     * @returns {number}
     */
    height() {
      const now = layout();
      return now.mode === 'split' ? now.shell : area();
    },
    /** @returns {ShellMode | null} the split as laid out now; null while not drawn */
    mode() {
      const mode = zone.dataset['shell'];
      return mode === 'split' || mode === 'full' ? mode : null;
    },
  };
}
