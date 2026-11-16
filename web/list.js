// The list (S2 12.1, 12.2 stage A, 12.9's list zone, 12.10; plan task 27): the filter field, the
// sections Open, This week and Earlier as the server sent them, rows of one or two lines, the
// footer of done sessions, and the title bar's counts (`#counts`). Its interface is contract
// 2.9's; app.js owns the selection, the zones and the keys and hands the list its actions. What
// each element says comes from web/list-text.js; everything from the server reaches the DOM as
// text (textContent, title), never as markup.
//
// Stage B (plan B task 55): a row that needs you carries `data-attention="<reason>"` (its left bar
// and bold title are list.css's) and the reason's line as its second line (list-text.js), and the
// counts start with `3 need you` on an element `data-state="need-you"`, whose dot list.css draws.
//
// Stage E (plan E task 97, E4–E7): the chips under the filter field (web/chips.js) and the stacks
// of This week and Earlier as the server sends them — a head with its `×4`, a closed stack's
// `+3 more in ORB-2107` line (no row: never selected, no `data-id`), an open stack's members
// indented after it —, ← and → on a stack, and done sessions while filtering. The list keeps the
// chips and the stacks the user opened as it keeps `showDone`: its own state, sent whole in the
// page's `view`, `opened` in every view (E6: a view without it gets no stacks). Which rows match,
// which stack, and whether the list is filtering are the server's (`list.filtering`); the page
// decides no rule.
//
// A render never loses a click (contract 2.9): app.js renders when a list arrives and when only
// the zone changed — the focus a mousedown moves, before its mouseup —, so every element the list
// draws is made once and kept: a row keeps its element and every element inside it across
// renders, and a render only changes texts and `hidden`. Lines no longer drawn are removed.

/** @import { HiddenBy, ListMessage, RowPayload, SearchChip, SectionPayload, StackPayload, TerminalPayload } from '../src/window/protocol.ts' */
/** @import { ListAction, Zone } from './keys.js' */
/** @import { RowText } from './list-text.js' */
import { needYouText } from './attention-text.js';
import { createChips } from './chips.js';
import { serverNow } from './format.js';
import { countsText, footerText, rowText, sectionText } from './list-text.js';
import { moreText, stackBadge } from './search-text.js';

/**
 * @typedef {object} ViewChange
 * @property {string} [filter]
 * @property {string[]} [unfolded]
 * @property {boolean} [showDone]
 * @property {SearchChip[]} [chips] E4: the chips set, each once
 * @property {string[]} [opened] E6: the groups whose stacks the user opened
 */
/**
 * @typedef {object} ListHooks
 * @property {(id: string, how: 'click' | 'key') => void} select
 * @property {(id: string) => void} activate
 * @property {(change: ViewChange) => void} view
 */

/** The marks a row can show, each in an element of its own (list-text.js's kinds). */
const MARK_KINDS = ['crashed', 'continued', 'expired', 'expiring', 'duplicate', 'other', 'done'];
/** How often the ages are counted on (A18: the page formats them; a `list` comes on change). */
const AGE_TICK_MS = 1000;
/** A row's height when none is drawn to measure (PgUp and PgDn move by a page). */
const ROW_PX = 28;
/** E4: the chips that narrow the list, in the order a view names them (`Show done` is `showDone`). */
const SEARCH_CHIPS = /** @type {const} */ (['running', 'open-pr', 'note']);
/** E6: the most groups a view's `opened` names (the parser's MAX_OPENED; web/ imports only types
 *  from src/, so the page holds the number itself). */
const MAX_OPENED = 64;
/** S2 8.2.3: a text of a view is at most 1,024 bytes of UTF-8 and well formed. */
const TEXT_BYTES = 1024;
const utf8 = new TextEncoder();

/**
 * Whether the server takes `group` in a view's `opened`: one it would refuse would close the
 * connection, so such a group is never sent and its stack opens only while a member is selected
 * (a named limit).
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
 * A stack's head shows `×4` after its ticket key (or group) (E7): a click on it opens or closes
 * the stack (`toggleStack`) and does nothing else — it selects no row and, its mousedown
 * cancelled, takes no keyboard.
 * @param {string} id
 * @param {ListHooks} hooks
 * @param {{ first: string | null }} clicks the row of the last click that began a sequence
 * @param {(head: string) => void} toggleStack
 */
function makeRow(id, hooks, clicks, toggleStack) {
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
  const stack = element('row-stack');
  stack.hidden = true;
  stack.addEventListener('mousedown', (event) => event.preventDefault());
  stack.addEventListener('click', (event) => {
    event.stopPropagation(); // not a click on the row: it selects nothing
    if (event.detail <= 1) {
      toggleStack(id); // the first click of a sequence only (task 38's rule)
    }
  });
  stack.addEventListener('dblclick', (event) => event.stopPropagation()); // and resumes nothing
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
  first.append(slot, key, group, stack, title, ...marks.values(), chip, note, age);
  main.append(first, state);
  root.append(icon, main);
  return {
    root,
    icon,
    slot,
    key,
    group,
    stack,
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
 * Draws a row's place in a stack (E7): `data-stack="head"` with its `×4`, `data-stack="member"`
 * (indented by search.css), nothing for a row in no stack.
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
  const head = stack !== null && stack.role === 'head';
  setText(row.stack, head ? stackBadge(stack.size) : '');
  setTip(row.stack, head ? (stack.open ? 'close the stack' : 'open the stack') : '');
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
  /** E6: the groups whose stacks the user opened, the oldest first. @type {string[]} */
  let opened = [];
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
   * The current click sequence began on a stack's `×4` or `+3 more` line (E7, ruled on review 2):
   * its first click opened or closed the stack, so the list may have moved under the pointer, and
   * the later clicks of the sequence (`detail` above 1) are not acted on anywhere in the list —
   * their press takes no keyboard, their click selects no row and toggles no stack, a double click
   * resumes nothing (task 38's rule for the header's buttons). Set at each sequence's first press.
   */
  let onStack = false;
  /** @param {EventTarget | null} target */
  const isStackControl = (target) =>
    target instanceof Element && target.closest('.row-stack, .list-more') !== null;
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
  // (Defensive: in such a sequence no row's `clicks.first` is set and ×n stops its own dblclick,
  // so nothing would act on it today; a listener added later stays covered.)
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
  /** A closed stack's `+3 more in ORB-2107` line, by its head's session id (E7). @type {Map<string, HTMLElement>} */
  const moreLines = new Map();

  /** @returns {RowPayload[]} the rows drawn, in order */
  const rows = () => current?.sections.flatMap((section) => section.rows) ?? [];

  /** The selected session's row, when the list draws it. */
  const selectedRow = () =>
    selected === null ? undefined : rows().find((row) => row.id === selected);

  /** Whether the list is filtering (E5): the server's answer; a list without it, stage A's rule. */
  const filtering = () =>
    typeof current?.filtering === 'boolean' ? current.filtering : filter.value !== '';

  /** @param {string[]} next */
  const sendOpened = (next) => {
    opened = next;
    hooks.view({ opened: [...opened] });
  };

  /**
   * Opens the stacks of `group` (E6): adds it to `opened`, the oldest dropped past MAX_OPENED.
   * A group the server would refuse is never sent. False when nothing was sent.
   * @param {string} group
   * @returns {boolean}
   */
  const openStack = (group) => {
    if (opened.includes(group) || !sendable(group)) {
      return false;
    }
    sendOpened([...opened, group].slice(-MAX_OPENED));
    return true;
  };

  /**
   * Closes the stacks of `group` (E7). With one of their members selected the head is selected
   * first, as ← on a member does: a selected member keeps its stack open (E6), and the page's
   * memory would add the group again at the next list.
   * @param {string} group
   */
  const closeStack = (group) => {
    const stack = selectedRow()?.stack ?? null;
    if (stack !== null && stack.role === 'member' && stack.group === group) {
      hooks.select(stack.head, 'key');
    }
    if (opened.includes(group)) {
      sendOpened(opened.filter((other) => other !== group));
    }
  };

  /**
   * A click on a head's `×4` or on its `+3 more` line (E7): opens the stack, or closes it.
   * @param {string} head the head's session id
   */
  const toggleStack = (head) => {
    const stack = rows().find((row) => row.id === head)?.stack ?? null;
    if (stack === null || stack.role !== 'head') {
      return;
    }
    if (stack.open) {
      closeStack(stack.group);
    } else {
      openStack(stack.group);
    }
  };

  /**
   * The line after a closed stack's head, made once (E7): no row — no `data-id`, never selected —,
   * and a click on it opens the stack and, its mousedown cancelled, takes no keyboard.
   * @param {string} head the head's session id
   */
  const moreFor = (head) => {
    let line = moreLines.get(head);
    if (line === undefined) {
      const made = element('list-more', 'div');
      made.dataset.head = head;
      made.title = 'open the stack';
      made.addEventListener('mousedown', (event) => event.preventDefault());
      made.addEventListener('click', (event) => {
        if (event.detail <= 1) {
          toggleStack(head); // the first click of a sequence only (task 38's rule)
        }
      });
      moreLines.set(head, made);
      line = made;
    }
    return line;
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
      row = makeRow(id, hooks, clicks, toggleStack);
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
    const searching = filtering();
    const sections = list?.sections ?? [];
    const nothing = searching && sections.every((section) => section.count === 0);
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
        const stack = row.stack ?? null; // a list from before stage E has none
        paintRow(drawn, rowText(row, now, terminalOf(row)), row.done);
        paintStack(drawn, stack);
        setData(drawn.root, 'selected', String(row.id === selectedId));
        if (row.id === selectedId) {
          sectionNow = section.name;
        }
        lines.push(drawn.root);
        if (stack !== null && stack.role === 'head' && !stack.open) {
          const more = moreFor(row.id);
          setText(more, moreText(stack.size, stack.group));
          lines.push(more);
        }
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
    for (const [head, more] of moreLines) {
      if (!keep.has(more)) {
        more.remove();
        moreLines.delete(head);
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

    // While filtering the footer of done sessions is not shown (S2 12.8, E5): they are listed.
    const foot = list === null || searching ? null : footerText(list.doneHidden, showDone);
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

    // E6's memory (ruled): a stack that the selection opened — a member of it is selected, however
    // it got there — stays open once the selection leaves, until the user closes it.
    const stack = selectedRow()?.stack ?? null;
    if (stack !== null && stack.role === 'member' && !opened.includes(stack.group)) {
      openStack(stack.group);
    }
  };

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
   * Folds or unfolds Earlier (S2 12.1: the only section that folds). Folding it with the
   * selection inside selects the row above it, so that the selection stays on a row the list
   * shows.
   * @param {boolean} folded
   */
  const fold = (folded) => {
    const earlier = current?.sections.find((section) => section.name === 'earlier');
    // While filtering (a word or a chip) every section is unfolded (S2 12.8, E5): nothing folds,
    // and the selection stays on its row, which stays shown.
    if (earlier === undefined || filtering()) {
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
      case 'fold': {
        // E7: ← on an open head closes its stack, ← on a member selects the head and closes it;
        // otherwise ← folds Earlier, as in stage A.
        const stack = selectedRow()?.stack ?? null;
        if (stack !== null && (stack.open || stack.role === 'member')) {
          closeStack(stack.group);
        } else {
          fold(true);
        }
        return;
      }
      case 'unfold': {
        // E7: → on a closed head opens its stack (a group the server would refuse: nothing);
        // otherwise → unfolds Earlier, as in stage A.
        const stack = selectedRow()?.stack ?? null;
        if (stack !== null && stack.role === 'head' && !stack.open) {
          openStack(stack.group);
        } else {
          fold(false);
        }
        return;
      }
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

  return { render, key, editFilter, reveal };
}
