// The list (S2 12.1, 12.2 stage A, 12.9's list zone, 12.10; plan task 27): the filter field, the
// sections Open, Recent (key `week`) and Earlier as the server sent them, rows of one or two lines,
// the footer of done sessions, and the title bar's counts (`#counts`). Its interface is contract
// 2.9's; app.js owns the selection, the zones and the keys and hands the list its actions. What
// each element says comes from web/list-text.js; everything from the server reaches the DOM as
// text (textContent, title), never as markup.
//
// Stage B (plan B task 55): a row that needs you carries `data-attention="<reason>"` (its left bar
// and bold title are list.css's) and the reason's line as its second line (list-text.js), and the
// counts start with `3 need you` on an element `data-state="need-you"`, whose dot list.css draws.
//
// Stage E (plan E task 97, E4–E7): the chips under the filter field (web/chips.js) and the blocks
// of every section as the server sends them (E6 as ruled 2026-11-16; the protocol calls a block a
// stack), drawn as CARDS since follow-up F9: a box of its own (`.list-block`) with a caption line
// at its top (`.block-head`: the fold arrow, the group's name, its number of sessions) and, while
// open, every session of the block as an ordinary row, none special; a closed block is its caption
// alone (`data-open="false"`, no row: the server sends none of its rows, `section.closedStacks`),
// with ` · 1 needs you` in the needs-you colour while sessions it hides need you. A CLOSED caption
// can hold the selection (app.js's `caption`: no session is selected then); an open one cannot. ←
// and → on a block, and done sessions while filtering. The list keeps the chips and the blocks the
// user closed as it keeps `showDone`: its own state, sent whole in the page's `view` (`closed`,
// each entry a section and a group; a block is open unless named there). Which rows match, which
// form a block, and whether the list is filtering are the server's (`list.filtering`); the page
// decides no rule.
//
// A render never loses a click (contract 2.9): app.js renders when a list arrives and when only
// the zone changed — the focus a mousedown moves, before its mouseup —, so every element the list
// draws is made once and kept: a row keeps its element and every element inside it across
// renders, and a render only changes texts and `hidden`. Lines no longer drawn are removed.

/** @import { ClosedBlock, HiddenBy, ListMessage, RowPayload, SearchChip, SectionPayload, StackPayload, TerminalPayload } from '../src/window/protocol.ts' */
/** @import { ListAction, Zone } from './keys.js' */
/** @import { RowText } from './list-text.js' */
/** A closed block's caption (F9). @typedef {{ section: SectionPayload['name'], group: string }} Caption */
import { needYouText } from './attention-text.js';
import { createChips } from './chips.js';
import { serverNow } from './format.js';
import { countsText, footerText, rowText, sanitize, sectionText } from './list-text.js';
import { blockInfo, MAY_START } from './pane.js';
import { captionNeedText } from './search-text.js';

/**
 * @typedef {object} ViewChange
 * @property {string} [filter]
 * @property {string[]} [unfolded]
 * @property {boolean} [showDone]
 * @property {SearchChip[]} [chips] E4: the chips set, each once
 * @property {ClosedBlock[]} [closed] E6: the blocks the user closed, each its section and group
 */
/**
 * @typedef {object} ListHooks
 * @property {(id: string, how: 'click' | 'key' | 'list', change?: ViewChange) => void} select
 *   `list`: the list zone takes the keyboard first (F9: a click on a selected closed caption), so
 *   that no terminal does; `change` goes in the same `view` (F9: opening a caption, ruling 3)
 * @property {(section: SectionPayload['name'], group: string, change?: ViewChange) => void} caption
 *   F9: selects the caption of the closed block of `group` in `section` (no session is selected
 *   then); `change` is the list's view change that goes in the same `view` (← closing the block:
 *   no view names a block closed while a session of it is selected, ruling 1)
 * @property {(id: string) => void} activate
 * @property {(change: ViewChange) => void} view
 * @property {(text: string) => void} [say] a line for the key bar (a refused click, F3)
 */

/** The marks a row can show, each in an element of its own (list-text.js's kinds). */
const MARK_KINDS = ['crashed', 'continued', 'expired', 'expiring', 'duplicate', 'other', 'done'];
/** How often the ages are counted on (A18: the page formats them; a `list` comes on change). */
const AGE_TICK_MS = 1000;
/** A row's height when none is drawn to measure (PgUp and PgDn move by a page). */
const ROW_PX = 28;
/** E4: the chips that narrow the list, in the order a view names them (`Show done` is `showDone`). */
const SEARCH_CHIPS = /** @type {const} */ (['running', 'open-pr', 'note']);
/** E6: the most entries a view's `closed` holds (the parser's MAX_CLOSED; web/ imports only types
 *  from src/, so the page holds the number itself). */
const MAX_CLOSED = 64;
/** Ruled 2026-11-16 (review 2 of F3): what a click that would close a block holding the selected
 *  session says (on its caption since F9). */
const HOLDS_SELECTED = 'this block holds the selected session; it stays open';
/** Ruled 2026-11-16 (review 2 of F3): what ← and a click on the caption say on a block a start
 *  holds open. */
const HOLDS_STARTING = 'this block holds a session that is still starting; it stays open';
/** F6 (L1, worded by the lead): what they say on a block that a terminal which ended before its
 *  session was known holds open — waiting never frees it; closing that terminal (the ended bar's
 *  Close) does. Short, so that the key bar shows it on one line at the window's usual widths. */
const HOLDS_ENDED = 'this block holds a terminal that ended at its start; close it first';
/** S2 8.2.3: a text of a view is at most 1,024 bytes of UTF-8 and well formed. */
const TEXT_BYTES = 1024;
const utf8 = new TextEncoder();

/**
 * Whether the server takes `group` in a view's `closed`: one it would refuse would close the
 * connection, so such a group is never sent and its block cannot be closed: it stays open (a named
 * limit).
 * @param {string} group
 */
function sendable(group) {
  return (
    typeof group === 'string' && group.isWellFormed() && utf8.encode(group).length <= TEXT_BYTES
  );
}

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
 * ticket key or the group, the title, the marks, the chip (S2 12.3: its open part, then its merged
 * part apart), ✎, the age — and the state line.
 *
 * A double click activates only when both its clicks were on this row: Chromium counts a double
 * click by time and distance, not by element, so a list that moved the rows between the two
 * clicks would otherwise resume a session the user clicked once (S2 12.6: nothing resumes but on
 * purpose). Then they are two single clicks: each selects the row it landed on.
 *
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
  const chipText = element('row-chip-text');
  const chipMerged = element('row-chip-merged');
  chip.append(chipText, chipMerged);
  const note = element('row-note');
  const age = element('row-age');
  const state = element('row-state', 'div');
  first.append(slot, key, group, title, ...marks.values(), chip, note, age);
  main.append(first, state);
  root.append(icon, main);
  return {
    root,
    icon,
    slot,
    key,
    group,
    title,
    marks,
    chip,
    chipText,
    chipMerged,
    note,
    age,
    state,
  };
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
  if (text.attention === null) {
    if (row.root.dataset['attention'] !== undefined) {
      delete row.root.dataset['attention'];
    }
  } else {
    setData(row.root, 'attention', text.attention);
  }
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
  // S2 12.3: `PR · failing`, then ` +30` in the chip's tint (dim on a grey chip); with none open
  // `3 merged` in merged's tint, `closed` dim (F4).
  const chip = text.chip;
  if (row.chip.hidden !== (chip === null)) {
    row.chip.hidden = chip === null;
  }
  setText(row.chipText, chip?.text ?? '');
  setText(row.chipMerged, chip === null || chip.merged === '' ? '' : ` ${chip.merged}`);
  setTip(row.chip, chip?.tip ?? '');
  setData(row.chip, 'dotted', String(chip?.dotted ?? false));
  setData(row.chip, 'dim', String(chip?.dim ?? false));
  // F4: the state it names, for its tint (style.css); '' for one the page does not know.
  setData(row.chip, 'level', chip?.level ?? '');
  setText(row.note, text.note === null ? '' : '✎');
  setTip(row.note, text.note === null ? '' : text.note === '' ? 'has a note' : text.note);
  setText(row.age, text.age);
  setTip(row.age, text.age === '' ? '' : 'last activity');
  setText(row.state, text.stateLine ?? '');
}

/**
 * Marks a row's place in an open block (E7, F9): `data-stack="head"` on its first row,
 * `data-stack="member"` on the others, nothing for a row in no block. Every row of a card is drawn
 * alike (list.css hides its ticket key and group there, which the caption says); the mark is a hook
 * for the tests only.
 * @param {RowElements} row
 * @param {StackPayload | null} stack
 */
function paintStack(row, stack) {
  if (stack === null) {
    if (row.root.dataset['stack'] !== undefined) {
      delete row.root.dataset['stack'];
    }
  } else {
    setData(row.root, 'stack', stack.role === 'head' ? 'head' : 'member');
  }
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
  filter.placeholder = 'Filter: title, group, note, PR, directory, short id   /';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filter.setAttribute('aria-label', 'Filter the list');
  // The chips under the field (S2 12.8, E4): the list's own state, as `showDone` is.
  const chipsRow = element('list-chips', 'div');
  filterBar.append(filter, chipsRow);
  /** E4: the chips set, in SEARCH_CHIPS's order. @type {SearchChip[]} */
  let chips = [];
  /** E6: the blocks the user closed, the oldest first. @type {ClosedBlock[]} */
  let closed = [];
  const chipsView = createChips(chipsRow, {
    toggle: (chip) => (chip === 'done' ? toggleDone() : toggleChip(chip)),
  });
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
  /**
   * The current click sequence began on a block's caption (F9; E7, ruled on review 2):
   * its first click opened or closed the block, so the list may have moved under the pointer, and
   * the later clicks of the sequence (`detail` above 1) are not acted on anywhere in the list —
   * their press takes no keyboard, their click selects no row and toggles no block, a double click
   * resumes nothing (task 38's rule for the header's buttons). Set at each sequence's first press.
   */
  let onStack = false;
  /** @param {EventTarget | null} target */
  const isStackControl = (target) =>
    target instanceof Element && target.closest('.block-head') !== null;
  /** @param {Event} event */
  const drop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener(
    'mousedown',
    (event) => {
      if (event.detail <= 1) {
        onStack = isStackControl(event.target);
      } else if (onStack) {
        drop(event);
      }
    },
    true,
  );
  root.addEventListener(
    'click',
    (event) => {
      if (event.detail <= 1) {
        clicks.first = null;
      } else if (onStack) {
        drop(event);
      }
    },
    true,
  );
  // (Defensive: in such a sequence no row's `clicks.first` is set and the caption has no dblclick
  // of its own, so nothing would act on it today; a listener added later stays covered.)
  root.addEventListener(
    'dblclick',
    (event) => {
      if (onStack) {
        drop(event);
      }
    },
    true,
  );

  /** @type {ListMessage | null} */
  let current = null;
  /** @type {string | null} */
  let selected = null;
  /** F9: the selected caption (app.js's), its section and group; null while none is.
   *  @type {Caption | null} */
  let selectedCaption = null;
  let showDone = false;
  /** Whether the page's view unfolds Earlier (`unfolded`): only the list sends it, app.js starts
   *  with none, so the list knows it as it knows `showDone` (reveal sends only what changes). */
  let earlierUnfolded = false;
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
  /**
   * Each block's card (F9), by its section and group, made once: the box, its caption line and the
   * caption's parts; `kids` the lines it holds after this render (the caption, then its rows).
   * @typedef {{ root: HTMLElement, head: HTMLElement, name: HTMLElement, count: HTMLElement,
   *   need: HTMLElement, kids: HTMLElement[] }} BlockElements
   * @type {Map<string, BlockElements>}
   */
  const blocks = new Map();

  /**
   * The row of `id` the list draws and its section's name, or undefined.
   * @param {string | null} id
   * @returns {{ row: RowPayload, section: SectionPayload['name'] } | undefined}
   */
  const placeOf = (id) => {
    for (const section of current?.sections ?? []) {
      const row = id === null ? undefined : section.rows.find((candidate) => candidate.id === id);
      if (row !== undefined) {
        return { row, section: section.name };
      }
    }
    return undefined;
  };

  /** Whether the list is filtering (E5): the server's answer; a list without it, stage A's rule. */
  const filtering = () =>
    typeof current?.filtering === 'boolean' ? current.filtering : filter.value !== '';

  /**
   * Whether the user closed the block of `group` in `section` (E6).
   * @param {SectionPayload['name']} section
   * @param {string} group
   */
  const isClosed = (section, group) =>
    closed.some((one) => one.section === section && one.group === group);

  /** @param {ClosedBlock[]} next */
  const sendClosed = (next) => {
    closed = next;
    hooks.view({ closed: closed.map((one) => ({ section: one.section, group: one.group })) });
  };

  /**
   * Opens the block of `group` in `section` (E6): the page forgets that the user closed it.
   * @param {SectionPayload['name']} section
   * @param {string} group
   */
  const openBlock = (section, group) => {
    if (isClosed(section, group)) {
      sendClosed(closed.filter((one) => one.section !== section || one.group !== group));
    }
  };

  /**
   * Closes the block of `group` in `section` (E7): adds it to `closed`, the oldest dropped past
   * MAX_CLOSED (that block opens again). It moves no selection: ← selects the caption first (F9),
   * a click never moves it (ruled 2026-11-16). A group the server would refuse is never sent: its
   * block cannot be closed, and nothing happens (it stays open). Returns whether it is closed.
   * @param {SectionPayload['name']} section
   * @param {string} group
   * @returns {boolean}
   */
  const shutBlock = (section, group) => {
    if (!sendable(group)) {
      return false;
    }
    if (!isClosed(section, group)) {
      sendClosed([...closed, { section, group }].slice(-MAX_CLOSED));
    }
    return true;
  };

  /**
   * F9: the block of `group` in `section` as the list draws it now: its closed caption, or its open
   * card's rows; null when the section draws neither.
   * @param {SectionPayload['name']} section
   * @param {string} group
   */
  const drawnBlock = (section, group) => {
    const part = current?.sections.find((candidate) => candidate.name === section);
    const caption = part?.closedStacks.find((candidate) => candidate.group === group);
    const rows = (part?.rows ?? []).filter((row) => (row.stack ?? null)?.group === group);
    return caption !== undefined
      ? { caption, rows: [] }
      : rows.length > 0
        ? { caption: null, rows }
        : null;
  };

  /**
   * F9's → and Enter on a selected caption, and a click on it: the block opens and its first
   * session is selected (`how` 'key' from the keys, 'list' from a click: the list zone takes the
   * keyboard first, so that no terminal does). Its first session is the caption's `head`, or the
   * first row of its card while a list that still draws it open has not been followed by one that
   * draws it closed (right after ←). Nothing while the list draws neither (a filter is set).
   * @param {SectionPayload['name']} section
   * @param {string} group
   * @param {'key' | 'list'} how
   */
  const openCaption = (section, group, how) => {
    const drawn = drawnBlock(section, group);
    const first = drawn?.caption?.head ?? drawn?.rows[0]?.id ?? null;
    if (first === null) {
      return;
    }
    // Ruled (3), the mirror of ←: the block's leaving `closed` and its first session's selection go
    // in ONE view, so that no view names the block closed while a session of it is selected. The
    // list's own state is set first.
    if (isClosed(section, group)) {
      closed = closed.filter((one) => one.section !== section || one.group !== group);
      hooks.select(first, how, {
        closed: closed.map((one) => ({ section: one.section, group: one.group })),
      });
    } else {
      hooks.select(first, how);
    }
  };

  /**
   * A click on a block's caption (E7, F9): opens the block, or closes it. A click never moves the
   * selection (ruled 2026-11-16) — but on the selected closed caption itself it opens the block and
   * selects its first session, as → does (K4). While the block holds the selected session (any of
   * its rows) the click to close is refused and the key bar says why; so it is while an unreported
   * terminal holds it open (`heldLine`).
   * @param {SectionPayload['name']} section
   * @param {string} group
   */
  const clickCaption = (section, group) => {
    const drawn = drawnBlock(section, group);
    if (drawn === null) {
      return;
    }
    if (drawn.caption !== null) {
      if (selectedCaption?.section === section && selectedCaption.group === group) {
        openCaption(section, group, 'list');
      } else {
        openBlock(section, group);
      }
      return;
    }
    if (drawn.rows.some((row) => row.id === selected)) {
      hooks.say?.(HOLDS_SELECTED);
      return;
    }
    const held = heldLine(section, group);
    if (held !== null) {
      hooks.say?.(held); // the server keeps it open: nothing moves
      return;
    }
    shutBlock(section, group);
  };

  /**
   * A block's card, made once (F9): the box and its caption line — the fold arrow (list.css draws
   * it by `data-open`), the group's name (text only), its number of sessions, and, while closed,
   * ` · 1 needs you` in the needs-you colour. The whole caption line is the control: a click opens
   * or closes the block (the first click of a sequence only, task 38's rule) and, its mousedown
   * cancelled, takes no keyboard. It carries no `data-id`.
   * @param {SectionPayload['name']} section
   * @param {string} group
   * @returns {BlockElements}
   */
  const blockFor = (section, group) => {
    const key = `${section}\n${group}`;
    let block = blocks.get(key);
    if (block === undefined) {
      const root = element('list-block', 'div');
      root.dataset.section = section;
      const head = element('block-head', 'div');
      const twist = element('block-twist');
      twist.setAttribute('aria-hidden', 'true');
      const name = element('block-name');
      const count = element('block-count');
      const need = element('block-need');
      need.hidden = true;
      head.append(twist, name, count, need);
      root.append(head);
      head.addEventListener('mousedown', (event) => event.preventDefault());
      head.addEventListener('click', (event) => {
        if (event.detail <= 1) {
          clickCaption(section, group);
        }
      });
      block = { root, head, name, count, need, kids: [] };
      blocks.set(key, block);
    }
    return block;
  };

  /**
   * Whether `row` is drawn with a terminal of the window that has not reported a session (its
   * `sessionId` is null in the list's `terminals`, S2 7.5): a start, or a program that ended before
   * it reported. A COPY OF THE SERVER'S RULE (`src/window/view/build.ts`, `stacked`'s `unreported`;
   * ruled 2026-11-16): the server draws a closed block open while one of its rows (F9: its first
   * too) is such a row, and this page forgets that it closed it (render) and refuses to close it
   * (`heldLine`, which tells the two lines apart by MAY_START, a copy too). A change of one is a
   * change of the other.
   * @param {RowPayload} row
   */
  const unreported = (row) =>
    row.terminal !== null &&
    current?.terminals.find((candidate) => candidate.id === row.terminal)?.sessionId === null;

  /**
   * What ← and a click on the caption say on the drawn block of `group` in `section` when one of
   * its rows (F9: its first too) is one that `unreported` names — the server keeps it open, so they
   * do nothing —, or null when none is: HOLDS_STARTING while such a member's terminal may still
   * start (MAY_START; it also wins when both kinds hold the block, since it is the one that changes
   * by itself), else HOLDS_ENDED (its terminal ended, was lost or never started before its session
   * was known). @param {SectionPayload['name']} section
   * @param {string} group
   * @returns {string | null}
   */
  const heldLine = (section, group) => {
    let held = null;
    for (const row of current?.sections.find((candidate) => candidate.name === section)?.rows ??
      []) {
      const stack = row.stack ?? null;
      if (stack === null || stack.group !== group || !unreported(row)) {
        continue;
      }
      const state = current?.terminals.find((candidate) => candidate.id === row.terminal)?.state;
      if (state !== undefined && MAY_START.has(state)) {
        return HOLDS_STARTING;
      }
      held = HOLDS_ENDED;
    }
    return held;
  };

  /** The server's time now: the list's, counted on by the time since it came (`serverNow`). */
  const nowNs = () =>
    current === null ? '' : serverNow(current.nowNs, performance.now() - receivedAt);

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

  /**
   * The title bar's counts (S2 12.1), written into index.html's `#counts`: first those that need
   * you (`needYou.count`, none in a list without it), then each state's.
   */
  const paintCounts = () => {
    const counts = document.getElementById('counts');
    if (counts === null) {
      return;
    }
    const needYou = current === null ? null : needYouText(current.needYou?.count ?? 0);
    const parts = [
      ...(needYou === null ? [] : [{ state: 'need-you', text: needYou }]),
      ...(current === null ? [] : countsText(current.counts)),
    ];
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
   * @param {Caption | null} [caption] F9: the selected caption (then `selectedId` is null)
   */
  const render = (list, selectedId, zone, caption = null) => {
    setData(root, 'zone', zone);
    const sameCaption =
      caption?.section === selectedCaption?.section && caption?.group === selectedCaption?.group;
    if (list === current && selectedId === selected && sameCaption) {
      return; // only the zone changed
    }
    const moved = selectedId !== selected || !sameCaption;
    if (list !== current) {
      receivedAt = performance.now();
    }
    current = list;
    selected = selectedId;
    selectedCaption = caption === null ? null : { section: caption.section, group: caption.group };
    const now = nowNs();
    const searching = filtering();
    const sections = list?.sections ?? [];
    const nothing = searching && sections.every((section) => section.count === 0);
    /** @type {HTMLElement[]} */
    const lines = [];
    /** The cards drawn, in order. @type {BlockElements[]} */
    const cards = [];
    /** The selected line (a row or a caption) and its section, to scroll it into view. */
    let selectedLine = /** @type {HTMLElement | null} */ (null);
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
      setTip(header.title, text.tip);
      setText(header.count, text.count);
      setText(header.span, text.span);
      setData(header.root, 'folded', String(section.folded));
      lines.push(header.root);
      /**
       * The card of `group` in this section, its caption painted, taken into this render's lines
       * once (a block's rows are one run of the section, so a second call adds to the same card).
       * @param {string} group
       * @param {number} size
       * @param {number | null} needYou the closed caption's count; null for an open card
       */
      const cardOf = (group, size, needYou) => {
        const block = blockFor(section.name, group);
        if (!cards.includes(block)) {
          const isSelected =
            selectedCaption?.section === section.name && selectedCaption.group === group;
          setData(block.root, 'open', String(needYou === null));
          setText(block.name, sanitize(group));
          setTip(block.name, sanitize(group));
          setText(block.count, String(size));
          setText(block.need, needYou === null ? '' : captionNeedText(needYou));
          setTip(block.head, needYou === null ? 'close the group' : 'open the group');
          setData(block.head, 'selected', String(isSelected));
          if (isSelected) {
            selectedLine = block.head;
            sectionNow = section.name;
          }
          block.kids = [block.head];
          cards.push(block);
          lines.push(block.root);
        }
        return block;
      };
      const captions = section.closedStacks;
      /** @param {number} at */
      const captionsAt = (at) => {
        for (const one of captions) {
          if (one.at === at) {
            cardOf(one.group, one.size, one.needYou);
          }
        }
      };
      section.rows.forEach((row, at) => {
        captionsAt(at);
        const drawn = rowFor(row.id);
        const stack = row.stack ?? null; // a list from before stage E has none
        paintRow(drawn, rowText(row, now, terminalOf(row)), row.done);
        paintStack(drawn, stack);
        setData(drawn.root, 'selected', String(row.id === selectedId));
        if (row.id === selectedId) {
          selectedLine = drawn.root;
          sectionNow = section.name;
        }
        if (stack === null) {
          lines.push(drawn.root);
        } else {
          cardOf(stack.group, stack.size, null).kids.push(drawn.root);
        }
      });
      captionsAt(section.rows.length);
    }
    // Moved only where the order changed; lines no longer drawn are removed.
    const keep = new Set([...lines, ...cards.flatMap((block) => block.kids)]);
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
    for (const [key, block] of blocks) {
      if (!cards.includes(block)) {
        block.root.remove();
        blocks.delete(key);
      }
    }
    if (!keep.has(empty)) {
      empty.remove();
    }
    /**
     * @param {HTMLElement} container
     * @param {HTMLElement[]} children
     */
    const place = (container, children) => {
      children.forEach((line, at) => {
        if (container.children[at] !== line) {
          container.insertBefore(line, container.children[at] ?? null);
        }
      });
      while (container.children.length > children.length) {
        container.lastElementChild?.remove();
      }
    };
    place(body, lines);
    for (const block of cards) {
      place(block.root, block.kids);
    }

    // While filtering the footer of done sessions is not shown (S2 12.8, E5): they are listed.
    const foot = list === null || searching ? null : footerText(list.doneHidden, showDone);
    footer.hidden = foot === null;
    setText(footerLine, foot?.text ?? '');
    setText(footerAction, foot?.action ?? '');
    paintCounts();

    // The selected line is scrolled into view when the selection changed and when it moved to
    // another section (a resume brings it to Open); never for a move inside its section, so that a
    // list that arrives does not pull the list back from where the user scrolled it.
    if (selectedLine !== null && (moved || sectionNow !== selectedSection)) {
      /** @type {HTMLElement} */ (selectedLine).scrollIntoView({ block: 'nearest' });
    }
    selectedSection = sectionNow;

    // G5 (ruled 2026-11-16; F9: any row of the block, its first too): a closed block that the
    // selection opened — one of its rows is selected, however it got there (a slot chord,
    // Ctrl+Shift+J, Ctrl+Tab, a notification, the switcher, a resume's answer, → on its caption) —
    // is forgotten as closed, so that it stays open once the selection leaves, until the user
    // closes it again. So is one that a row's unreported terminal opened (the server's rule, copied
    // in `unreported`), so that it stays open after the report.
    for (const section of sections) {
      for (const row of section.rows) {
        const stack = row.stack ?? null;
        if (stack !== null && (row.id === selectedId || unreported(row))) {
          openBlock(section.name, stack.group);
        }
      }
    }
  };

  /**
   * F9 (ruled (a), (b)): whether the selected caption `caption` can stay selected after this
   * render: while filtering, yes (as a selected session the filter hides stays selected); else only
   * while the page still names its block closed and the list draws that block (closed, or still
   * open right after ←). app.js selects nothing when it cannot: its block was opened without a key
   * (an unreported terminal of a session starting into it, the 65th closed block dropping it) or is
   * gone (fewer than two sessions of its group left in the section). @param {Caption} caption
   */
  const holds = (caption) =>
    filtering() ||
    (isClosed(caption.section, caption.group) &&
      blockInfo(current, caption.section, caption.group) !== null);

  /** `a`, the footer's `show` / `hide` and the chip `Show done`: one state (E4). */
  const toggleDone = () => {
    showDone = !showDone;
    chipsView.render(chips, showDone);
    hooks.view({ showDone });
  };

  /**
   * A chip that narrows the list (E4), on or off.
   * @param {SearchChip} chip
   */
  const toggleChip = (chip) => {
    const on = !chips.includes(chip);
    chips = SEARCH_CHIPS.filter((known) => (known === chip ? on : chips.includes(known)));
    chipsView.render(chips, showDone);
    hooks.view({ chips: [...chips] });
  };

  /**
   * F9: what the list's keys move through, in the list's order: every row drawn and every CLOSED
   * caption (an open card's caption holds no selection, K3), with the session id of its first row
   * (`head`; '' for the still-open card of ruling 2). While filtering there is no caption.
   * @typedef {{ kind: 'row', section: SectionPayload['name'], id: string }
   *   | { kind: 'caption', section: SectionPayload['name'], group: string, head: string }} Stop
   * @returns {Stop[]}
   */
  const stops = () => {
    /** @type {Stop[]} */
    const all = [];
    for (const section of current?.sections ?? []) {
      const captions = section.closedStacks;
      /** @param {number} at */
      const captionsAt = (at) => {
        for (const one of captions) {
          if (one.at === at) {
            all.push({ kind: 'caption', section: section.name, group: one.group, head: one.head });
          }
        }
      };
      section.rows.forEach((row, at) => {
        captionsAt(at);
        // Ruled (2): right after ←, before the list that draws it closed, the selected caption's
        // card is still drawn open: it counts as its caption, at the card's place, its rows none.
        const group = (row.stack ?? null)?.group;
        if (
          group !== undefined &&
          selectedCaption?.section === section.name &&
          selectedCaption.group === group
        ) {
          if (row.stack?.role === 'head') {
            all.push({ kind: 'caption', section: section.name, group, head: '' });
          }
          return;
        }
        all.push({ kind: 'row', section: section.name, id: row.id });
      });
      captionsAt(section.rows.length);
    }
    return all;
  };

  /**
   * Whether `stop` is what is selected now. A closed caption also stands where the selection is
   * when the selected session is its FIRST row, which the list does not draw yet (review 2's S1,
   * the mirror of ruling 2): right after →, Enter or a click on the caption, or a slot chord,
   * Ctrl+Shift+J or a notification that selected that hidden session, until the list that draws
   * the block open comes — so that ↑ ↓ step from the caption's place, never from the first line.
   * @param {Stop} stop
   */
  const isSelected = (stop) =>
    stop.kind === 'row'
      ? stop.id === selected
      : selectedCaption === null
        ? selected !== null && stop.head === selected
        : selectedCaption.section === stop.section && selectedCaption.group === stop.group;

  /**
   * The closed caption whose FIRST row is the selected session, which the list does not draw yet
   * (`isSelected`'s case); undefined when there is none.
   */
  const hiddenFirst = () =>
    selectedCaption !== null || selected === null || placeOf(selected) !== undefined
      ? undefined
      : stops().find((stop) => stop.kind === 'caption' && stop.head === selected);

  /** Selects `stop` from a key: a row (the zone stays), or a caption (F9). @param {Stop} stop */
  const selectStop = (stop) => {
    if (stop.kind === 'row') {
      hooks.select(stop.id, 'key');
    } else {
      hooks.caption(stop.section, stop.group);
    }
  };

  /**
   * Folds or unfolds Earlier (S2 12.1: the only section that folds). Folding it with the
   * selection inside — a row, or a caption (F9) — selects the line above it that can hold the
   * selection (a row, or a closed caption), so that the selection stays on what the list shows.
   * @param {boolean} folded
   */
  const fold = (folded) => {
    const earlier = current?.sections.find((section) => section.name === 'earlier');
    // While filtering (a word or a chip) every section is unfolded (S2 12.8, E5): nothing folds,
    // and the selection stays on its row, which stays shown.
    if (earlier === undefined || filtering()) {
      return;
    }
    const inside =
      selectedCaption?.section === 'earlier' ||
      hiddenFirst()?.section === 'earlier' ||
      (selected !== null && earlier.rows.some((row) => row.id === selected));
    if (folded && inside) {
      const before = stops()
        .filter((stop) => stop.section !== 'earlier')
        .at(-1);
      if (before !== undefined) {
        selectStop(before);
      }
    }
    earlierUnfolded = !folded;
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

  /**
   * @param {ListAction} action
   * @param {boolean} [repeat] the key is an auto-repeat of one held down (F9: ← on a caption)
   */
  const key = (action, repeat = false) => {
    switch (action.kind) {
      case 'move': {
        // F9: through the rows and the closed captions; with nothing selected, the first of them.
        const all = stops();
        if (all.length === 0) {
          return;
        }
        const at = all.findIndex(isSelected);
        const by = action.by;
        /** @type {number} */
        let index;
        if (by === 'home') {
          index = 0;
        } else if (by === 'end') {
          index = all.length - 1;
        } else if (at === -1) {
          index = 0; // nothing of the list selected: its first row or caption
        } else {
          const step = by === 'page-up' ? -pageRows() : by === 'page-down' ? pageRows() : by;
          index = Math.max(0, Math.min(all.length - 1, at + step));
        }
        const stop = all[index];
        if (stop !== undefined && !isSelected(stop)) {
          selectStop(stop);
        }
        return;
      }
      case 'fold': {
        // F9: ← on a selected caption does what ← on a closed head did, it folds Earlier (inside
        // Earlier the line above is selected) — but an auto-repeat does nothing there (ruled (d)):
        // a held ← that has just closed a block must not go on to fold Earlier and select a
        // session the user did not choose.
        if (selectedCaption !== null) {
          if (!repeat) {
            fold(true);
          }
          return;
        }
        // E7, F9: ← on any session of an open card closes the block and selects its caption (a
        // group the server would refuse: nothing, the block stays open; an unreported terminal
        // holding it open: the key bar says why); otherwise ← folds Earlier, as in stage A. On a
        // selected FIRST session the list does not draw yet (review 2's S1: → then ←, before the
        // list that draws the block open), ← closes the block again and selects its caption, as
        // ← on that session will once it is drawn — never a fold that leaves it hidden.
        const hidden = hiddenFirst();
        const drawn = placeOf(selected);
        /** @type {{ section: SectionPayload['name'], group: string } | null} */
        let place = null;
        if (drawn !== undefined && (drawn.row.stack ?? null) !== null) {
          place = { section: drawn.section, group: drawn.row.stack?.group ?? '' };
        } else if (drawn === undefined && hidden?.kind === 'caption') {
          place = { section: hidden.section, group: hidden.group };
        }
        if (place !== null) {
          const group = place.group;
          const held = heldLine(place.section, group);
          if (held !== null) {
            hooks.say?.(held); // the server keeps it open: nothing moves
          } else if (sendable(group)) {
            // Ruled (1): the closing and the caption's `selected: null` go in ONE view, so that no
            // view names the block closed while a session of it is still selected. The list's own
            // state is set first, so that the caption holds when app.js draws it.
            if (isClosed(place.section, group)) {
              hooks.caption(place.section, group);
            } else {
              closed = [...closed, { section: place.section, group }].slice(-MAX_CLOSED);
              hooks.caption(place.section, group, {
                closed: closed.map((one) => ({ section: one.section, group: one.group })),
              });
            }
          }
        } else {
          fold(true);
        }
        return;
      }
      case 'unfold': {
        // F9: → on a selected caption opens its block and selects its first session; otherwise →
        // unfolds Earlier, as in stage A (on a session of an open card too).
        if (selectedCaption !== null) {
          openCaption(selectedCaption.section, selectedCaption.group, 'key');
        } else {
          fold(false);
        }
        return;
      }
      case 'enter':
        if (enterDown) {
          return; // an auto-repeat of an Enter that is still down
        }
        // Set before any act (F9, ruled (d)): an Enter held on a caption opens the block and
        // selects its first session once; its repeats never resume that session.
        enterDown = true;
        if (selectedCaption !== null) {
          openCaption(selectedCaption.section, selectedCaption.group, 'key');
          return;
        }
        if (selected !== null && placeOf(selected) !== undefined) {
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

  /**
   * E10: changes the list's view so that it shows a row the switcher picked, as the row's
   * `hiddenBy` says — `filter`: the field and the chips cleared; `done`: Show done on; `folded`:
   * Earlier unfolded. One `view` with every field that changed, none when nothing did. Task 98
   * calls it.
   * @param {readonly HiddenBy[]} hiddenBy
   */
  const reveal = (hiddenBy) => {
    /** @type {ViewChange} */
    const change = {};
    if (hiddenBy.includes('filter')) {
      if (filter.value !== '') {
        filter.value = '';
        change.filter = '';
      }
      if (chips.length > 0) {
        chips = [];
        change.chips = [];
      }
    }
    if (hiddenBy.includes('done') && !showDone) {
      showDone = true;
      change.showDone = true;
    }
    if (hiddenBy.includes('folded') && !earlierUnfolded) {
      earlierUnfolded = true;
      change.unfolded = ['earlier'];
    }
    if (Object.keys(change).length > 0) {
      chipsView.render(chips, showDone);
      hooks.view(change);
    }
  };

  return { render, key, editFilter, reveal, holds };
}
