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

const SECTION_TITLES = { open: 'Open', week: 'This week', earlier: 'Earlier' };
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

  /**
   * @param {ListMessage | null} list
   * @param {string | null} selectedId
   * @param {Zone} zone
   */
  const render = (list, selectedId, zone) => {
    root.dataset.zone = zone;
    // Only the zone changed (a mousedown on a row moved the keyboard here): the rows stay, so that
    // the row under the pointer is still there for the click (review 2 of task 26).
    if (list === current && selectedId === selected) {
      return;
    }
    current = list;
    selected = selectedId;
    if (list === null) {
      body.replaceChildren();
      return;
    }
    /** @type {HTMLElement[]} */
    const lines = [];
    for (const section of list.sections) {
      const header = document.createElement('div');
      header.className = 'list-section';
      header.textContent = `${SECTION_TITLES[section.name]} (${section.count})${section.folded ? ' · folded' : ''}`;
      lines.push(header);
      for (const row of section.rows) {
        const line = document.createElement('div');
        line.className = 'list-row';
        line.dataset.id = row.id;
        line.dataset.selected = String(row.id === selectedId);
        const slot = row.slot === null ? '  ' : `${row.slot} `;
        line.textContent = `${slot}${row.title} · ${row.state}${row.terminal !== null ? ' · in the window' : ''}`;
        line.addEventListener('click', () => hooks.select(row.id, 'click'));
        line.addEventListener('dblclick', () => hooks.activate(row.id));
        lines.push(line);
      }
    }
    if (list.doneHidden > 0) {
      const footer = document.createElement('div');
      footer.className = 'list-footer';
      footer.textContent = `${list.doneHidden} done hidden`;
      lines.push(footer);
    }
    body.replaceChildren(...lines);
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
