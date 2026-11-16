// Test fixture: a verbatim copy of web/list.js at 40f7886 (task 26's placeholder), kept so
// that the page shell's own tests do not change when the real module arrives; not developed
// further. pinModules (test-page/helpers/shell.ts) serves it in place of web/list.js. One change
// since: follow-up F5 renamed the title of the key `week` to Recent.
//
// The list (S2 12.1, 12.2) — the smallest working version, replaced by task 27 (plan A16): the
// sections and rows the server sent, as plain lines, a selection, the list keys app.js hands on,
// and a filter field. Its interface is contract 2.9's. Every server string through textContent.

/** @import { ListMessage, RowPayload } from '../src/window/protocol.ts' */
/** @import { ListAction, Zone } from './keys.js' */

/**
 * @typedef {object} ListHooks
 * @property {(id: string, how: 'click' | 'key') => void} select
 * @property {(id: string) => void} activate
 * @property {(change: { filter?: string, unfolded?: string[], showDone?: boolean }) => void} view
 */

const SECTION_TITLES = { open: 'Open', week: 'Recent', earlier: 'Earlier' };
/** PgUp and PgDn move this many rows. */
const PAGE_ROWS = 10;

/**
 * @param {HTMLElement} root
 * @param {ListHooks} hooks
 */
export function createList(root, hooks) {
  const filter = document.createElement('input');
  filter.className = 'list-filter';
  filter.placeholder = 'Filter';
  filter.hidden = true;
  filter.addEventListener('input', () => hooks.view({ filter: filter.value }));
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      filter.value = '';
      hooks.view({ filter: '' });
      filter.hidden = true;
      root.focus();
    }
  });
  const body = document.createElement('div');
  body.className = 'list-body';
  root.replaceChildren(filter, body);

  /** @type {ListMessage | null} */
  let current = null;
  /** @type {string | null} */
  let selected = null;
  let showDone = false;

  /** @returns {RowPayload[]} */
  const rows = () => current?.sections.flatMap((section) => section.rows) ?? [];

  /** The lines drawn, by key ('section:<name>', the row's id, 'footer'): kept across renders. */
  /** @type {Map<string, HTMLElement>} */
  const drawn = new Map();

  /**
   * The line of `key`, made once: a render never replaces the element of a row, so that a click
   * whose mousedown came before the render (a list arrived, or the zone changed) still reaches it
   * (review 2 of task 26).
   * @param {string} key
   * @param {string} className
   * @param {string | null} id a row's session id, for its click and double click
   * @returns {HTMLElement}
   */
  const lineFor = (key, className, id) => {
    let line = drawn.get(key);
    if (line === undefined) {
      line = document.createElement('div');
      line.className = className;
      if (id !== null) {
        line.dataset.id = id;
        line.addEventListener('click', () => hooks.select(id, 'click'));
        line.addEventListener('dblclick', () => hooks.activate(id));
      }
      drawn.set(key, line);
    }
    return line;
  };

  /**
   * @param {ListMessage | null} list
   * @param {string | null} selectedId
   * @param {Zone} zone
   */
  const render = (list, selectedId, zone) => {
    root.dataset.zone = zone;
    if (list === current && selectedId === selected) {
      return; // only the zone changed
    }
    current = list;
    selected = selectedId;
    /** @type {HTMLElement[]} */
    const lines = [];
    for (const section of list?.sections ?? []) {
      const header = lineFor(`section:${section.name}`, 'list-section', null);
      header.textContent = `${SECTION_TITLES[section.name]} (${section.count})${section.folded ? ' · folded' : ''}`;
      lines.push(header);
      for (const row of section.rows) {
        const line = lineFor(row.id, 'list-row', row.id);
        line.dataset.selected = String(row.id === selectedId);
        const slot = row.slot === null ? '  ' : `${row.slot} `;
        line.textContent = `${slot}${row.title} · ${row.state}${row.terminal !== null ? ' · in the window' : ''}`;
        lines.push(line);
      }
    }
    if (list !== null && list.doneHidden > 0) {
      const footer = lineFor('footer', 'list-footer', null);
      footer.textContent = `${list.doneHidden} done hidden`;
      lines.push(footer);
    }
    // Moved only where the order changed; lines no longer drawn are removed.
    const keep = new Set(lines);
    for (const [key, line] of drawn) {
      if (!keep.has(line)) {
        line.remove();
        drawn.delete(key);
      }
    }
    lines.forEach((line, at) => {
      if (body.children[at] !== line) {
        body.insertBefore(line, body.children[at] ?? null);
      }
    });
  };

  /** @param {ListAction} action */
  const key = (action) => {
    const all = rows();
    switch (action.kind) {
      case 'move': {
        if (all.length === 0) {
          return;
        }
        const at = all.findIndex((row) => row.id === selected);
        const by = action.by;
        const index =
          by === 'home'
            ? 0
            : by === 'end'
              ? all.length - 1
              : Math.max(
                  0,
                  Math.min(
                    all.length - 1,
                    (at === -1 ? 0 : at) +
                      (by === 'page-up' ? -PAGE_ROWS : by === 'page-down' ? PAGE_ROWS : by),
                  ),
                );
        const row = all[index];
        if (row !== undefined) {
          hooks.select(row.id, 'key');
        }
        return;
      }
      case 'fold':
        hooks.view({ unfolded: [] });
        return;
      case 'unfold':
        hooks.view({ unfolded: ['earlier'] });
        return;
      case 'enter':
        if (selected !== null) {
          hooks.activate(selected);
        }
        return;
      case 'filter':
        editFilter();
        return;
      case 'show-done':
        showDone = !showDone;
        hooks.view({ showDone });
        return;
      case 'escape':
        // app.js hands Esc over while a filter is set: the field is cleared with it.
        filter.value = '';
        filter.hidden = true;
        hooks.view({ filter: '' });
        return;
    }
  };

  const editFilter = () => {
    filter.hidden = false;
    filter.focus();
  };

  return { render, key, editFilter };
}
