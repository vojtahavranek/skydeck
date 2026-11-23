// The list's width (issue #192; S2 12.1, 12.9): the handle on the border between the list and the
// right side (`#list-handle`, index.html). A press of the primary button on it and a move change
// the list's width with the pointer, live, within web/list-width-text.js's bounds; the release (or
// the pointer lost: it is captured, so a release outside the window too) ends the drag and keeps
// the width in the page's own localStorage (LIST_WIDTH_KEY), as the theme's choice is kept
// (web/theme.js). A double click gives the default width back and removes the stored value. The
// width is `--list-width` on <html>, which style.css's `.main` reads and holds to the window, and
// which web/list-width-early.js puts there before the next load's first paint. Another page of
// the profile follows at once (the `storage` event). Storage that throws or is missing keeps
// nothing: the width holds for the life of the page.
//
// The handle takes no keyboard and no key (S2 12.9): it is not focusable, and every mousedown on
// it is cancelled, so that a press moves the keyboard nowhere, selects no text and starts no
// middle-button scroll; the list and the terminal see none of its events (the handle lies over
// the border, outside both zones, and holds the pointer while it drags). While `blocked()` (a
// dialog, the switcher, the tour) a press and a double click do nothing, and a drag that meets
// one ends as at a release. The terminal follows the new width by its own refit after a size
// change (web/terminal-view.js), as at a window resize. Nothing of it goes to the server.

import { held, HANDLE_TITLE, LIST_WIDTH_KEY, shownWidth, widthOf } from './list-width-text.js';

/** @returns {string | null} the stored value; null when storage throws */
function read() {
  try {
    return localStorage.getItem(LIST_WIDTH_KEY);
  } catch {
    return null;
  }
}

/** Keeps `width`, or no value for null. Storage that refuses keeps nothing.
 *  @param {number | null} width */
function write(width) {
  try {
    if (width === null) {
      localStorage.removeItem(LIST_WIDTH_KEY);
    } else {
      localStorage.setItem(LIST_WIDTH_KEY, String(width));
    }
  } catch {
    // The width holds for the life of the page.
  }
}

/**
 * @typedef {object} ListWidthDeps
 * @property {HTMLElement} list  the list's zone, whose width a drag starts from
 * @property {() => boolean} blocked  whether a dialog is shown (app.js's `modal`)
 */

/**
 * @param {HTMLElement} handle
 * @param {ListWidthDeps} deps
 */
export function createListWidth(handle, deps) {
  const root = document.documentElement;
  handle.title = HANDLE_TITLE;

  /** @param {number | null} width  null: the default width */
  const apply = (width) => {
    if (width === null) {
      root.style.removeProperty('--list-width');
    } else {
      root.style.setProperty('--list-width', `${width}px`);
    }
  };

  // web/list-width-early.js applied the stored width before the first paint; read again, so that
  // a change another page made since is not missed.
  apply(widthOf(read()));
  addEventListener('storage', (event) => {
    if (event.key === null || event.key === LIST_WIDTH_KEY) {
      apply(widthOf(read()));
    }
  });

  /** The drag under way: its pointer, where it started, the width now, whether it moved.
   *  @type {{ pointer: number, x: number, from: number, width: number, moved: boolean } | null} */
  let drag = null;

  const end = () => {
    if (drag === null) {
      return;
    }
    const { pointer, moved, width } = drag;
    drag = null;
    delete handle.dataset['dragging'];
    delete root.dataset['listDrag'];
    if (handle.hasPointerCapture(pointer)) {
      handle.releasePointerCapture(pointer);
    }
    if (moved) {
      write(width);
    }
  };

  // No keyboard, no text selection, no middle-button scroll: for every button.
  handle.addEventListener('mousedown', (event) => event.preventDefault());
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag !== null || deps.blocked()) {
      return;
    }
    const from = Math.round(deps.list.getBoundingClientRect().width);
    drag = { pointer: event.pointerId, x: event.clientX, from, width: from, moved: false };
    handle.setPointerCapture(event.pointerId);
    handle.dataset['dragging'] = '';
    root.dataset['listDrag'] = '';
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag === null || event.pointerId !== drag.pointer) {
      return;
    }
    if (deps.blocked()) {
      end();
      return;
    }
    if (event.clientX === drag.x && !drag.moved) {
      return;
    }
    drag.moved = true;
    drag.width = shownWidth(held(drag.from + event.clientX - drag.x), innerWidth);
    apply(drag.width);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    handle.addEventListener(type, (event) => {
      if (drag !== null && event instanceof PointerEvent && event.pointerId === drag.pointer) {
        end();
      }
    });
  }
  handle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (deps.blocked()) {
      return;
    }
    apply(null);
    write(null);
  });
}
