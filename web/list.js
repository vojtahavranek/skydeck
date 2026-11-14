// The list (S2 12.1, 12.2 stage A, 12.9's list zone, 12.10; plan task 27): the filter field, the
// sections Open, This week and Earlier as the server sent them, rows of one or two lines, the
// footer of done sessions, and the title bar's counts (`#counts`). Its interface is contract
// 2.9's; app.js owns the selection, the zones and the keys and hands the list its actions. What
// each element says comes from web/list-text.js; everything from the server reaches the DOM as
// text (textContent, title), never as markup.
//
// A render never loses a click (contract 2.9): app.js renders when a list arrives and when only
// the zone changed — the focus a mousedown moves, before its mouseup —, so every element the list
// draws is made once and kept: a row keeps its element and every element inside it across
// renders, and a render only changes texts and `hidden`. Lines no longer drawn are removed.

/** @import { ListMessage, RowPayload, SectionPayload, TerminalPayload } from '../src/window/protocol.ts' */
/** @import { ListAction, Zone } from './keys.js' */
/** @import { RowText } from './list-text.js' */
import { countsText, footerText, rowText, sectionText } from './list-text.js';

/**
 * @typedef {object} ListHooks
 * @property {(id: string, how: 'click' | 'key') => void} select
 * @property {(id: string) => void} activate
 * @property {(change: { filter?: string, unfolded?: string[], showDone?: boolean }) => void} view
 */

/** The marks a row can show, each in an element of its own (list-text.js's kinds). */
const MARK_KINDS = ['crashed', 'continued', 'expired', 'expiring', 'duplicate', 'other', 'done'];
/** How often the ages are counted on (A18: the page formats them; a `list` comes on change). */
const AGE_TICK_MS = 1000;
/** A row's height when none is drawn to measure (PgUp and PgDn move by a page). */
const ROW_PX = 28;

/**
 * @param {string} className
 * @param {string} [tag]
 * @returns {HTMLElement}
 */
function element(className, tag = 'span') {
  const made = document.createElement(tag);
  made.className = className;
  return made;
}

/**
 * Sets the text of `target` when it differs (a text that stays is not replaced, so that nothing
 * moves under the pointer or a selection), and hides it while it is empty.
 * @param {HTMLElement} target
 * @param {string} text
 */
function setText(target, text) {
  if (target.textContent !== text) {
    target.textContent = text;
  }
  const hidden = text === '';
  if (target.hidden !== hidden) {
    target.hidden = hidden;
  }
}

/**
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
 * @param {HTMLElement} target
 * @param {string} tip
 */
function setTip(target, tip) {
  if (target.title !== tip) {
    target.title = tip;
  }
}

/**
 * One row's elements, made once (S2 12.2): the state icon, then the first line — the slot, the
 * ticket key or the group, the title, the marks, the chip, ✎, the age — and the state line.
 *
 * A double click activates only when both its clicks were on this row: Chromium counts a double
 * click by time and distance, not by element, so a list that moved the rows between the two
 * clicks would otherwise resume a session the user clicked once (S2 12.6: nothing resumes but on
 * purpose). Then they are two single clicks: each selects the row it landed on.
 * @param {string} id
 * @param {ListHooks} hooks
 * @param {{ first: string | null }} clicks the row of the last click that began a sequence
 */
function makeRow(id, hooks, clicks) {
  const root = element('list-row', 'div');
  root.dataset.id = id;
  root.addEventListener('click', (event) => {
    if (event.detail <= 1) {
      clicks.first = id;
    }
    hooks.select(id, 'click');
  });
  root.addEventListener('dblclick', () => {
    if (clicks.first === id) {
      hooks.activate(id);
    }
  });
  const icon = element('row-icon');
  const main = element('row-main');
  const first = element('row-line');
  const slot = element('row-slot');
  const key = element('row-key');
  const group = element('row-group');
  const title = element('row-title');
  const marks = new Map(MARK_KINDS.map((kind) => [kind, element('row-mark')]));
  for (const [kind, mark] of marks) {
    mark.dataset.kind = kind;
  }
  const chip = element('row-chip');
  const note = element('row-note');
  const age = element('row-age');
  const state = element('row-state', 'div');
  first.append(slot, key, group, title, ...marks.values(), chip, note, age);
  main.append(first, state);
  root.append(icon, main);
  return { root, icon, slot, key, group, title, marks, chip, note, age, state };
}

/** @typedef {ReturnType<typeof makeRow>} RowElements */

/**
 * Draws `text` into a row's elements, changing only what differs.
 * @param {RowElements} row
 * @param {RowText} text
 * @param {boolean} done
 */
function paintRow(row, text, done) {
  setData(row.root, 'icon', text.icon);
  setData(row.root, 'lines', text.stateLine === null ? '1' : '2');
  setData(row.root, 'done', String(done));
  setData(row.icon, 'icon', text.icon);
  setTip(row.icon, text.icon === 'crashed' ? 'not running: it ended unexpectedly' : text.icon);
  setText(row.slot, text.slot);
  setTip(row.slot, text.slot === '' ? '' : `Ctrl+Shift+${text.slot}`);
  setText(row.key, text.key);
  setText(row.group, text.group);
  // The title always takes its place (a title that is only its key leaves it empty, not gone).
  if (row.title.textContent !== text.title) {
    row.title.textContent = text.title;
  }
  setTip(row.title, [text.key, text.title].filter((part) => part !== '').join(' '));
  for (const [kind, mark] of row.marks) {
    const shown = text.marks.filter((candidate) => candidate.kind === kind);
    setText(mark, shown.map((candidate) => candidate.text).join(', '));
    setTip(mark, shown.map((candidate) => candidate.tip).join('\n'));
  }
  setText(row.chip, text.chip?.text ?? '');
  setTip(row.chip, text.chip?.tip ?? '');
  setData(row.chip, 'dotted', String(text.chip?.dotted ?? false));
  setText(row.note, text.note === null ? '' : '✎');
  setTip(row.note, text.note === null ? '' : text.note === '' ? 'has a note' : text.note);
  setText(row.age, text.age);
  setTip(row.age, text.age === '' ? '' : 'last activity');
  setText(row.state, text.stateLine ?? '');
}

/** A section header's elements, made once (S2 12.1). @param {SectionPayload['name']} name */
function makeHeader(name) {
  const root = element('list-section', 'div');
  root.dataset.section = name;
  const twist = element('section-twist');
  twist.setAttribute('aria-hidden', 'true');
  const title = element('section-title');
  const count = element('section-count');
  const span = element('section-span');
  root.append(twist, title, count, span);
  return { root, title, count, span };
}

/**
 * @param {HTMLElement} root
 * @param {ListHooks} hooks
 */
export function createList(root, hooks) {
  // The filter (S2 12.8, stage A: design 7.4's): always there at the top, `/` gives it the
  // keyboard; Enter and Esc end the entry (Esc also clears it) and give the keyboard back to the
  // list when they are released, so that their auto-repeats stay in the field and act on no row.
  const filterBar = element('list-filterbar', 'div');
  const filter = /** @type {HTMLInputElement} */ (element('list-filter', 'input'));
  filter.type = 'text';
  filter.placeholder = 'Filter: title, group, note, PR, directory   /';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filter.setAttribute('aria-label', 'Filter the list');
  filterBar.append(filter);
  filter.addEventListener('input', () => hooks.view({ filter: filter.value }));
  /** The Enter or Esc that ended the entry, until it is released ('' when none). */
  let leaving = '';
  filter.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      if (event.key === 'Escape' && filter.value !== '') {
        filter.value = '';
        hooks.view({ filter: '' });
      }
      leaving = event.key;
    }
  });
  filter.addEventListener('keyup', (event) => {
    if (leaving !== '' && event.key === leaving) {
      leaving = '';
      root.focus(); // the field keeps no keyboard of its own: back to the list
    }
  });
  filter.addEventListener('blur', () => {
    leaving = '';
  });

  const body = element('list-body', 'div');
  const empty = element('list-empty', 'div');
  empty.textContent = 'No session matches the filter.';
  const footer = element('list-footer', 'div');
  const footerLine = element('footer-text');
  const footerAction = element('footer-action');
  footer.append(footerLine, ' · ', footerAction);
  footer.hidden = true;
  footerAction.addEventListener('click', () => toggleDone());
  root.replaceChildren(filterBar, body, footer);

  /**
   * The row of the click that began the current click sequence (makeRow: a double click acts
   * only when both its clicks were on one row). Every first click anywhere in the list forgets
   * it before a row's own listener may set it again (capture phase), so that a sequence begun
   * off a row — on blank space, on a header — never matches an older click on a row.
   */
  const clicks = { first: /** @type {string | null} */ (null) };
  root.addEventListener(
    'click',
    (event) => {
      if (event.detail <= 1) {
        clicks.first = null;
      }
    },
    true,
  );

  /** @type {ListMessage | null} */
  let current = null;
  /** @type {string | null} */
  let selected = null;
  let showDone = false;
  /** When `current` arrived (performance.now()), to count its ages on (A18). */
  let receivedAt = 0;
  /** The section the selected row was drawn in, to scroll to it when it moves to another. */
  let selectedSection = '';
  /**
   * An Enter of the list's is down and not yet released. app.js hands the list its action, not
   * the event, so the list tells an auto-repeated Enter from a press by the release: a held Enter
   * resumes once, its repeats nothing (review 2).
   */
  let enterDown = false;
  addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Enter') {
        enterDown = false;
      }
    },
    true,
  );
  addEventListener('blur', () => {
    enterDown = false;
  });

  /** @type {Map<string, RowElements>} */
  const rowElements = new Map();
  /** @type {Map<string, ReturnType<typeof makeHeader>>} */
  const headers = new Map();

  /** @returns {RowPayload[]} the rows drawn, in order */
  const rows = () => current?.sections.flatMap((section) => section.rows) ?? [];

  /** The server's time now: the list's, counted on by the time since it came. */
  const nowNs = () => {
    if (current === null) {
      return '';
    }
    if (!/^-?[0-9]+$/.test(current.nowNs)) {
      return current.nowNs;
    }
    const elapsed = BigInt(Math.max(0, Math.floor((performance.now() - receivedAt) * 1e6)));
    return String(BigInt(current.nowNs) + elapsed);
  };

  /**
   * @param {RowPayload} row
   * @returns {TerminalPayload | null}
   */
  const terminalOf = (row) =>
    row.terminal === null
      ? null
      : (current?.terminals.find((candidate) => candidate.id === row.terminal) ?? null);

  /**
   * @param {SectionPayload['name']} name
   */
  const headerFor = (name) => {
    let header = headers.get(name);
    if (header === undefined) {
      const made = makeHeader(name);
      if (name === 'earlier') {
        made.root.addEventListener('click', () => {
          const section = current?.sections.find((candidate) => candidate.name === 'earlier');
          if (section !== undefined) {
            fold(!section.folded);
          }
        });
      }
      headers.set(name, made);
      header = made;
    }
    return header;
  };

  /** @param {string} id */
  const rowFor = (id) => {
    let row = rowElements.get(id);
    if (row === undefined) {
      row = makeRow(id, hooks, clicks);
      rowElements.set(id, row);
    }
    return row;
  };

  /** Draws every age and state line again for the time now (A18). */
  const paintAges = () => {
    const now = nowNs();
    for (const section of current?.sections ?? []) {
      const header = headers.get(section.name);
      if (header !== undefined) {
        setText(header.span, sectionText(section, now).span);
      }
      for (const row of section.rows) {
        const drawn = rowElements.get(row.id);
        if (drawn !== undefined) {
          paintRow(drawn, rowText(row, now, terminalOf(row)), row.done);
        }
      }
    }
  };
  setInterval(paintAges, AGE_TICK_MS);

  /** The title bar's counts (S2 12.1), written into index.html's `#counts`. */
  const paintCounts = () => {
    const counts = document.getElementById('counts');
    if (counts === null) {
      return;
    }
    const parts = current === null ? [] : countsText(current.counts);
    const text = parts.map((part) => part.text).join(' · ');
    if (counts.textContent === text) {
      return;
    }
    /** @type {(Node | string)[]} */
    const children = [];
    for (const part of parts) {
      if (children.length > 0) {
        children.push(' · ');
      }
      const count = element('count');
      count.dataset.state = part.state;
      count.textContent = part.text;
      children.push(count);
    }
    counts.replaceChildren(...children);
  };

  /**
   * @param {ListMessage | null} list
   * @param {string | null} selectedId
   * @param {Zone} zone
   */
  const render = (list, selectedId, zone) => {
    setData(root, 'zone', zone);
    if (list === current && selectedId === selected) {
      return; // only the zone changed
    }
    const moved = selectedId !== selected;
    if (list !== current) {
      receivedAt = performance.now();
    }
    current = list;
    selected = selectedId;
    const now = nowNs();
    const filtering = filter.value !== '';
    const sections = list?.sections ?? [];
    const nothing = filtering && sections.every((section) => section.count === 0);
    /** @type {HTMLElement[]} */
    const lines = [];
    let sectionNow = '';
    if (nothing) {
      lines.push(empty);
    }
    for (const section of nothing ? [] : sections) {
      // Open is always there; a section with nothing in it is not (S2 12.1).
      if (section.count === 0 && section.name !== 'open') {
        continue;
      }
      const header = headerFor(section.name);
      const text = sectionText(section, now);
      setText(header.title, text.title);
      setText(header.count, text.count);
      setText(header.span, text.span);
      setData(header.root, 'folded', String(section.folded));
      lines.push(header.root);
      for (const row of section.rows) {
        const drawn = rowFor(row.id);
        paintRow(drawn, rowText(row, now, terminalOf(row)), row.done);
        setData(drawn.root, 'selected', String(row.id === selectedId));
        if (row.id === selectedId) {
          sectionNow = section.name;
        }
        lines.push(drawn.root);
      }
    }
    // Moved only where the order changed; lines no longer drawn are removed.
    const keep = new Set(lines);
    for (const [id, row] of rowElements) {
      if (!keep.has(row.root)) {
        row.root.remove();
        rowElements.delete(id);
      }
    }
    for (const [name, header] of headers) {
      if (!keep.has(header.root)) {
        header.root.remove();
        headers.delete(name);
      }
    }
    if (!keep.has(empty)) {
      empty.remove();
    }
    lines.forEach((line, at) => {
      if (body.children[at] !== line) {
        body.insertBefore(line, body.children[at] ?? null);
      }
    });

    const foot = list === null ? null : footerText(list.doneHidden, showDone);
    footer.hidden = foot === null;
    setText(footerLine, foot?.text ?? '');
    setText(footerAction, foot?.action ?? '');
    paintCounts();

    // The selected row is scrolled into view when the selection changed and when the row moved
    // to another section (a resume brings it to Open); never for a move inside its section, so
    // that a list that arrives does not pull the list back from where the user scrolled it.
    if (selectedId !== null && (moved || sectionNow !== selectedSection)) {
      rowElements.get(selectedId)?.root.scrollIntoView({ block: 'nearest' });
    }
    selectedSection = sectionNow;
  };

  const toggleDone = () => {
    showDone = !showDone;
    hooks.view({ showDone });
  };

  /**
   * Folds or unfolds Earlier (S2 12.1: the only section that folds). Folding it with the
   * selection inside selects the row above it, so that the selection stays on a row the list
   * shows.
   * @param {boolean} folded
   */
  const fold = (folded) => {
    const earlier = current?.sections.find((section) => section.name === 'earlier');
    // While a filter is set every section is unfolded (S2 12.8): nothing folds, and the
    // selection stays on its row, which stays shown.
    if (earlier === undefined || filter.value !== '') {
      return;
    }
    if (folded && selected !== null && earlier.rows.some((row) => row.id === selected)) {
      const before = (current?.sections ?? [])
        .filter((section) => section.name !== 'earlier')
        .flatMap((section) => section.rows)
        .at(-1);
      if (before !== undefined) {
        hooks.select(before.id, 'key');
      }
    }
    hooks.view({ unfolded: folded ? [] : ['earlier'] });
  };

  /** How many rows a page is: those the list's body shows, less one. */
  const pageRows = () => {
    const sample =
      (selected === null ? undefined : rowElements.get(selected)) ??
      rowElements.values().next().value;
    const height = sample?.root.offsetHeight || ROW_PX;
    return Math.max(1, Math.floor(body.clientHeight / height) - 1);
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
        /** @type {number} */
        let index;
        if (by === 'home') {
          index = 0;
        } else if (by === 'end') {
          index = all.length - 1;
        } else if (at === -1) {
          index = 0; // nothing of the list selected: its first row
        } else {
          const step = by === 'page-up' ? -pageRows() : by === 'page-down' ? pageRows() : by;
          index = Math.max(0, Math.min(all.length - 1, at + step));
        }
        const row = all[index];
        if (row !== undefined && row.id !== selected) {
          hooks.select(row.id, 'key');
        }
        return;
      }
      case 'fold':
        fold(true);
        return;
      case 'unfold':
        fold(false);
        return;
      case 'enter':
        if (enterDown) {
          return; // an auto-repeat of an Enter that is still down
        }
        enterDown = true;
        if (selected !== null && all.some((row) => row.id === selected)) {
          hooks.activate(selected);
        }
        return;
      case 'filter':
        editFilter();
        return;
      case 'show-done':
        toggleDone();
        return;
      case 'escape':
        // app.js hands Esc over while a filter is set: the field is cleared with it.
        filter.value = '';
        hooks.view({ filter: '' });
        return;
      default:
        return;
    }
  };

  /** `/` (S2 12.9): the filter field takes the keyboard, its caret after what it holds. */
  const editFilter = () => {
    filter.focus();
    filter.setSelectionRange(filter.value.length, filter.value.length);
  };

  return { render, key, editFilter };
}
