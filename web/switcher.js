// The quick switcher (S2 12.8, 12.9; plan E task 98, E8–E12; contract 2.5): Ctrl+Shift+P, or the
// title bar's `Switch…`, shows a panel over the page — a field on top, the sessions the server
// ranked for its text under their headings (`Needs you`, `Open`, `Not running`, `Done`), and a
// footer that names its keys. The ranking, the matches and what hides a row from the list are the
// server's (`list.switcher`, E9): the page sends the field's text in its `view` and draws what
// comes back, deciding no rule (S2 4.3) — not even whether a text is a command (`command`, E12).
//
// E10: Enter (or a click on an item) acts only while the list drawn answers the text last sent
// (`deps.text`'s answer, after app.js's cuts), so that a fast `orb`, Enter never picks an item of
// the list for `or`: an Enter pressed before waits for that list and then acts on its highlighted
// item, and a click on an item of an older list does nothing. While the page is not connected the
// panel says so in place of its items and Enter does nothing; a kept Enter is dropped when the text
// changes, the switcher closes or the connection is lost (ruled).
//
// E11: the switcher is modal. Its field keeps the keyboard: a mousedown in the panel anywhere but
// in the field is cancelled, and when nothing has the keyboard (a click on the toast over its
// scrim) the next key gives it back to the field first. A click on the scrim closes it. The second
// click of a double click acts on nothing: not on the scrim of a switcher its first click opened,
// and not on what lies under an item its first click picked (ruled for task 38, applied here).
//
// Every text from the server — a title, a group, a directory, a state line — reaches the DOM as
// text (`textContent`, a `title` tooltip); the found parts of a title are `mark` elements whose
// text is set (plan 2.1). The elements are made once per session and kept across lists, so that a
// list arriving between a mousedown and its mouseup never loses the click.

/** @import { ListMessage, RestoreOffer, RowPayload, SwitchItem, SwitchRank, SwitcherPayload, TerminalPayload } from '../src/window/protocol.ts' */
import { activityTime } from './banner-text.js';
import { ageBetween } from './format.js';
import { switcherKey } from './keys.js';
import { rowText, sanitize } from './list-text.js';
import { cutWords, highlightParts, rankHeading, switcherFooter } from './search-text.js';

const PLACEHOLDER = 'Switch to a session…  (title, group, note, PR, ticket, directory, short id)';
const NO_MATCH = 'No session matches.';
const NOT_CONNECTED = "skydeck's server is not connected";
/** Command form (E12) without an offer: the commands, and when the restore is listed. */
const NO_COMMAND =
  'No command matches. > settings opens the settings; > restore is listed after Not now on the restore banner, until WSL restarts.';
/** F36: the settings command's line. */
const SETTINGS_LINE = 'Settings: skydeck’s settings, the plain ones changed here';
/** The footer's line when app.js cut the text it sent (E3). */
const WORDS_CUT = 'only the first 16 words are searched';
const BYTES_CUT = 'only the first 1,024 bytes are searched';
/** A row's height when none is drawn to measure (PgUp and PgDn move by a page). */
const ITEM_PX = 40;

/**
 * @typedef {object} SwitcherDeps
 * @property {(value: string) => string} text   its field changed: app.js sends view.switcher and
 *   answers the text it sent (after the cuts)
 * @property {(item: SwitchItem) => void} pick   Enter on the highlighted item, or a click on one
 * @property {(sessionIds: string[]) => void} restore   Enter on the restore offer (E12)
 * @property {() => void} settings   Enter on (or a click on) the settings command (F36)
 * @property {() => void} closed   once whenever it closes, whatever closed it
 * @property {() => string} now   the server's now (stage D's serverNow), for ages
 * @property {() => string} timeZone   the page's time zone, for the offer's time (stage C's)
 */

/**
 * One entry of the panel: the offer, F36's settings command or an item, and its element.
 * @typedef {{ key: string, element: HTMLElement, offer: RestoreOffer | null, item: SwitchItem | null, settings?: true }} Entry
 */

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
 * Sets the text of `target` when it differs, and hides it while it is empty.
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
 * Whether a pick of the row resumes it (E10): it has no terminal of the window and does not run
 * elsewhere — stage A's `activate` rule; otherwise the pick shows its terminal or its card. The one
 * rule for the footer's `Enter resume here` and for app.js's pick, so that the footer says what
 * Enter sends (ruled on review 2, C1): a session that runs with neither (a lost keeper's program)
 * is resumed, and step 1 refuses it.
 * @param {RowPayload} row
 * @returns {boolean}
 */
export function pickResumes(row) {
  return row.terminal === null && row.elsewhere === null;
}

/**
 * The offer's line (E12): `Restore 3 sessions from yesterday at 18:02` (`1 session`); without a
 * time, the line without it.
 * @param {RestoreOffer} offer
 * @param {string} time
 */
function offerText(offer, time) {
  const count = offer.count === 1 ? '1 session' : `${offer.count} sessions`;
  return time === '' ? `Restore ${count}` : `Restore ${count} from ${time}`;
}

/** One item's elements, made once per session (contract 2.5's order). */
function makeItem() {
  const root = element('switcher-item', 'div');
  const icon = element('row-icon switcher-icon');
  const main = element('switcher-main');
  const first = element('switcher-first', 'div');
  const group = element('switcher-group');
  const title = element('switcher-title');
  first.append(group, title);
  const line = element('switcher-line', 'div');
  main.append(first, line);
  const meta = element('switcher-meta');
  const chip = element('switcher-chip');
  const slot = element('switcher-slot');
  const short = element('switcher-short');
  meta.append(chip, slot, short);
  root.append(icon, main, meta);
  return { root, icon, group, title, line, chip, slot, short, parts: '' };
}

/** @typedef {ReturnType<typeof makeItem>} ItemElements */

/**
 * @param {HTMLElement} root  #switcher (index.html)
 * @param {SwitcherDeps} deps
 */
export function createSwitcher(root, deps) {
  const scrim = element('switcher-scrim', 'div');
  const panel = element('switcher-panel', 'div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Quick switcher');
  const field = /** @type {HTMLInputElement} */ (element('switcher-field', 'input'));
  field.type = 'text';
  field.placeholder = PLACEHOLDER;
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Switch to a session');
  const listBox = element('switcher-list', 'div');
  const empty = element('switcher-empty', 'div');
  empty.hidden = true;
  // The offer acts on Enter only (E12, ruled on review 1): it starts programs, so it has no click
  // listener, and its mousedown, as anywhere in the panel, keeps the keyboard in the field.
  const offerLine = element('switcher-offer', 'div');
  offerLine.dataset['offer'] = 'restore';
  // F36: the settings command starts nothing, so a click on it acts as Enter does (E10's rule).
  const settingsLine = element('switcher-offer', 'div');
  settingsLine.dataset['offer'] = 'settings';
  settingsLine.textContent = SETTINGS_LINE;
  settingsLine.addEventListener('click', (event) => {
    if (event.detail > 1 || !current()) {
      return;
    }
    const entry = entries.find((candidate) => candidate.element === settingsLine);
    if (entry !== undefined) {
      choose(entry);
    }
  });
  const foot = element('switcher-foot', 'div');
  const keys = element('switcher-keys');
  const cut = element('switcher-cut');
  cut.hidden = true;
  foot.append(keys, cut);
  panel.append(field, listBox, foot);
  root.replaceChildren(scrim, panel);
  root.hidden = true;

  let shown = false;
  /** Whether the page is connected: update(null) says it is not. */
  let connected = false;
  /** The text deps.text last answered: E10's picks compare `list.switcher.query` with it. */
  let sent = '';
  /** The list's switcher drawn, and its list's terminals (a running row's state line). */
  /** @type {SwitcherPayload | null} */
  let payload = null;
  /** @type {TerminalPayload[]} */
  let terminals = [];
  /** An Enter waits for the list that answers `sent` (E10). */
  let kept = false;
  /** @type {Entry[]} */
  let entries = [];
  /** The highlighted entry: its index in `entries` and its key (`offer`, or `item <id>`). */
  let active = 0;
  /** @type {string | null} */
  let activeKey = null;
  /** @type {Map<string, ItemElements>} */
  const items = new Map();
  /** @type {Map<string, HTMLElement>} */
  const headings = new Map();

  const close = () => {
    if (!shown) {
      return;
    }
    shown = false;
    kept = false;
    // The keyboard leaves the panel before it is hidden: app.js gives it back (E11).
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    root.hidden = true;
    deps.closed();
  };

  /** Acts on an entry: the switcher closes first, then the pick or the restore (E10, E12). */
  const choose = (/** @type {Entry} */ entry) => {
    close();
    if (entry.settings === true) {
      deps.settings();
    } else if (entry.offer !== null) {
      deps.restore([...entry.offer.sessionIds]);
    } else if (entry.item !== null) {
      deps.pick(entry.item);
    }
  };

  /** Whether the list drawn answers the text last sent (E10). */
  const current = () => connected && payload !== null && payload.query === sent;

  /** Enter on the highlighted entry (E10; ruled: nothing while not connected). */
  const pick = () => {
    if (!connected) {
      return;
    }
    if (!current()) {
      kept = true;
      return;
    }
    kept = false;
    const entry = entries[active];
    if (entry !== undefined) {
      choose(entry);
    }
  };

  /** The footer: its keys for the highlighted entry, how many more, and the cut. */
  const paintFoot = () => {
    const entry = connected ? entries[active] : undefined;
    const action =
      entry?.settings === true
        ? 'open the settings'
        : entry?.offer != null
          ? 'restore'
          : entry?.item != null && pickResumes(entry.item.row)
            ? 'resume here'
            : 'switch';
    const more = connected && payload !== null && Number.isInteger(payload.more) ? payload.more : 0;
    setText(keys, switcherFooter(action, more));
  };

  /** Marks the highlighted entry; scrolls it into view when `scroll`. */
  const paintActive = (/** @type {boolean} */ scroll) => {
    entries.forEach((entry, index) => setData(entry.element, 'active', String(index === active)));
    if (scroll) {
      entries[active]?.element.scrollIntoView({ block: 'nearest' });
    }
    paintFoot();
  };

  /** @param {number} index */
  const setActive = (index) => {
    active = Math.max(0, Math.min(entries.length - 1, index));
    activeKey = entries[active]?.key ?? null;
    paintActive(true);
  };

  /** @param {1 | -1 | 'page-up' | 'page-down'} by */
  const move = (by) => {
    if (entries.length === 0) {
      return;
    }
    const height = entries[active]?.element.offsetHeight || ITEM_PX;
    const page = Math.max(1, Math.floor(listBox.clientHeight / height) - 1);
    const step = by === 'page-down' ? page : by === 'page-up' ? -page : by;
    setActive(active + step);
  };

  /**
   * Draws one item's elements.
   * @param {ItemElements} made
   * @param {SwitchItem} item
   * @param {string} nowNs
   */
  const paintItem = (made, item, nowNs) => {
    const { row } = item;
    const terminal = terminals.find((term) => term.id === row.terminal) ?? null;
    const text = rowText(row, nowNs, terminal);
    setData(made.root, 'rank', String(item.rank));
    setData(made.root, 'done', String(row.done === true));
    setData(made.icon, 'icon', text.icon);
    setTip(made.icon, text.icon === 'crashed' ? 'not running: it ended unexpectedly' : text.icon);
    setText(made.group, text.group);
    // The title as the server sent it, its found ranges marked (task 93: the ranges are of
    // `row.title`, the key included); each part sanitised again, as every text of the page.
    const parts = highlightParts(typeof row.title === 'string' ? row.title : '', item.found);
    const partsKey = JSON.stringify(parts);
    if (made.parts !== partsKey) {
      made.parts = partsKey;
      made.title.replaceChildren(
        ...parts.map((part) => {
          if (!part.found) {
            return document.createTextNode(sanitize(part.text));
          }
          const mark = document.createElement('mark');
          mark.textContent = sanitize(part.text);
          return mark;
        }),
      );
    }
    setTip(made.title, sanitize(typeof row.title === 'string' ? row.title : ''));
    const age = ageBetween(nowNs, row.lastActivityNs);
    const state =
      (row.starting || row.state !== 'not-running') && text.stateLine !== null
        ? text.stateLine
        : age === ''
          ? 'not running'
          : `not running · ${age}`;
    const dir = typeof row.dir === 'string' ? sanitize(row.dir) : '';
    setText(made.line, dir === '' ? state : `${state} · ${dir}`);
    const chip = text.chip;
    setText(
      made.chip,
      chip === null ? '' : chip.merged === '' ? chip.text : `${chip.text} ${chip.merged}`,
    );
    setTip(made.chip, chip?.tip ?? '');
    // F4: the state it names, so that its words take the state's tint (style.css).
    setData(made.chip, 'level', chip?.level ?? '');
    setText(made.slot, text.slot);
    setTip(made.slot, text.slot === '' ? '' : `Ctrl+Shift+${text.slot}`);
    setText(made.short, typeof row.shortId === 'string' ? sanitize(row.shortId) : '');
  };

  /** @param {SwitchRank} rank */
  const headingOf = (rank) => {
    let heading = headings.get(rank);
    if (heading === undefined) {
      heading = element('switcher-heading', 'div');
      heading.dataset['rank'] = String(rank);
      heading.textContent = rankHeading(rank);
      headings.set(rank, heading);
    }
    return heading;
  };

  /** Draws the panel for the state now; `reset`: the highlight goes to the first entry. */
  const draw = (/** @type {boolean} */ reset) => {
    /** @type {Entry[]} */
    const next = [];
    /** @type {HTMLElement[]} */
    const children = [];
    let emptyText = '';
    if (!connected) {
      emptyText = NOT_CONNECTED;
    } else if (payload !== null) {
      const nowNs = deps.now();
      const offer = payload.restore ?? null;
      if (offer !== null) {
        // E12: the time as stage C's banner says it, on the page's own clock and time zone.
        const time = activityTime(offer.lastActivityNs, Date.now(), deps.timeZone());
        setText(offerLine, offerText(offer, time));
        next.push({ key: 'offer', element: offerLine, offer, item: null });
        children.push(offerLine);
      }
      if (payload.settings === true) {
        next.push({
          key: 'settings',
          element: settingsLine,
          offer: null,
          item: null,
          settings: true,
        });
        children.push(settingsLine);
      }
      const listed = Array.isArray(payload.items) ? payload.items : [];
      /** @type {Set<string>} */
      const seen = new Set();
      /** @type {SwitchRank | null} */
      let rank = null;
      for (const item of listed) {
        const id = item.row.id;
        if (seen.has(id)) {
          continue; // each session once (a hook of the page: one element per id)
        }
        seen.add(id);
        let made = items.get(id);
        if (made === undefined) {
          made = makeItem();
          made.root.dataset['id'] = id;
          const root = made.root;
          root.addEventListener('click', (event) => {
            // E10: a click acts only on an item of the list that answers the text last sent;
            // the second click of a double click does nothing (ruled for task 38).
            if (event.detail > 1 || !current()) {
              return;
            }
            const entry = entries.find((candidate) => candidate.element === root);
            if (entry !== undefined) {
              choose(entry);
            }
          });
          items.set(id, made);
        }
        paintItem(made, item, nowNs);
        if (item.rank !== rank) {
          rank = item.rank;
          children.push(headingOf(item.rank));
        }
        next.push({ key: `item ${id}`, element: made.root, offer: null, item });
        children.push(made.root);
      }
      for (const id of [...items.keys()]) {
        if (!seen.has(id)) {
          items.delete(id);
        }
      }
      if (next.length === 0) {
        emptyText = payload.command === true ? NO_COMMAND : NO_MATCH;
      }
    }
    setText(empty, emptyText);
    if (emptyText !== '') {
      children.push(empty);
    }
    // Only what is out of place moves, so that an element under the pointer stays where it is.
    children.forEach((child, index) => {
      if (listBox.children[index] !== child) {
        listBox.insertBefore(child, listBox.children[index] ?? null);
      }
    });
    while (listBox.children.length > children.length) {
      listBox.lastElementChild?.remove();
    }
    entries = next;
    const found = reset || activeKey === null ? -1 : entries.findIndex((e) => e.key === activeKey);
    const index = found !== -1 ? found : reset ? 0 : Math.min(active, entries.length - 1);
    const moved = entries[Math.max(0, index)]?.key !== activeKey;
    active = Math.max(0, index);
    activeKey = entries[active]?.key ?? null;
    paintActive(moved);
  };

  // --- the field --------------------------------------------------------------------------------

  field.addEventListener('input', () => {
    if (!shown) {
      return; // a late `input` (an IME's, after the blur of a close) sends no text (review 2, C3)
    }
    kept = false; // a kept Enter is dropped when the text changes (ruled)
    const typed = field.value.toWellFormed();
    sent = deps.text(field.value);
    // E3: app.js cut what it sent after 1,024 bytes, then after 16 words; the footer says which.
    const words = cutWords(typed);
    setText(cut, sent === typed ? '' : words.cut && words.text === sent ? WORDS_CUT : BYTES_CUT);
  });
  field.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) {
      return; // an IME's Enter or Esc is the IME's
    }
    const key = switcherKey(event);
    if (key === null) {
      return;
    }
    event.preventDefault();
    switch (key.kind) {
      case 'move':
        move(key.by); // at each auto-repeat too
        return;
      case 'pick':
        if (!event.repeat) {
          pick(); // a held Enter picks once
        }
        return;
      case 'close':
        if (!event.repeat) {
          close();
        }
        return;
      case 'stay':
        return; // Tab and Shift+Tab stay in the field (E11)
    }
  });

  // --- the mouse --------------------------------------------------------------------------------

  // E11: a mousedown in the panel anywhere but in the field is cancelled, so that the keyboard
  // never leaves the field (a heading or the footer would otherwise take it).
  panel.addEventListener('mousedown', (event) => {
    if (event.target !== field) {
      event.preventDefault();
    }
  });
  // The scrim keeps the keyboard where it is; a click on it closes the switcher — not the second
  // click of a double click whose first one opened it (the title bar's `Switch…`).
  scrim.addEventListener('mousedown', (event) => event.preventDefault());
  scrim.addEventListener('click', (event) => {
    if (event.detail <= 1) {
      close();
    }
  });
  /**
   * Whether the mouse sequence going on began in the switcher (a press of `detail` 1 there). Its
   * later clicks (`detail` above 1) act on nothing once the switcher is closed: the second click
   * of a double click on an item lands on whatever lay under it — a row of the list, a card's
   * button —, and must neither select nor press it.
   */
  let ours = false;
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
    addEventListener(
      type,
      (event) => {
        if (!(event instanceof MouseEvent)) {
          return;
        }
        if (type === 'mousedown' && event.detail <= 1) {
          ours = shown && event.target instanceof Node && root.contains(event.target);
          return;
        }
        if (ours && !shown && event.detail > 1) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  // E11: when nothing has the keyboard while the switcher is shown — a click on the toast over
  // its scrim —, the next key gives it back to the field before that key acts (this listener is in
  // place before app.js's own). Not while text is selected: a Ctrl+C may be about to copy it.
  addEventListener(
    'keydown',
    () => {
      if (!shown) {
        return;
      }
      const holder = document.activeElement;
      if (holder instanceof HTMLElement && holder !== document.body && holder.checkVisibility()) {
        return;
      }
      const selection = getSelection();
      if (selection !== null && !selection.isCollapsed) {
        return;
      }
      field.focus();
    },
    true,
  );

  return {
    /** Shows the panel with an empty field, the keyboard in it; app.js then hands it a list. */
    open() {
      if (shown) {
        return;
      }
      shown = true;
      kept = false;
      payload = null;
      entries = [];
      active = 0;
      activeKey = null;
      field.value = '';
      setText(cut, '');
      root.hidden = false;
      sent = deps.text('');
      field.focus();
      draw(true);
    },
    close,
    /** @returns {boolean} */
    shown: () => shown,
    /**
     * Every list while shown, and null while the page is not connected: its items and its offer;
     * the highlight stays on the same entry while it is there, and goes to the first one for the
     * answer to another text.
     * @param {ListMessage | null} list
     */
    update(list) {
      if (!shown) {
        return;
      }
      if (list === null) {
        connected = false;
        kept = false; // a kept Enter is dropped when the connection is lost (ruled)
        draw(false);
        return;
      }
      connected = true;
      terminals = Array.isArray(list.terminals) ? list.terminals : [];
      const next = list.switcher ?? null;
      // A list without the switcher's answer (one sent before it was shown, or a server before
      // stage E) changes nothing drawn; at the first answer of an open, only one for its text.
      if (
        next !== null &&
        typeof next.query === 'string' &&
        (payload !== null || next.query === sent)
      ) {
        const reset = payload === null || payload.query !== next.query;
        payload = next;
        draw(reset);
      } else {
        draw(false);
      }
      if (kept && current()) {
        pick(); // the Enter that waited for this list acts on its highlighted entry
      }
    },
    /** app.js hands it Esc while shown, in the capture phase (as D2). */
    escape() {
      close();
    },
  };
}
