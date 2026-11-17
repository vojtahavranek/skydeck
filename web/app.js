// The page shell (S2 12.1, 12.9; plan 2.9): the key and the connection, the page's state — the
// last `list`, the selection, the focus zone, the most-recently-used order of sessions for
// Ctrl+Tab, the terminals' exits —, the key dispatch over the key table (web/keys.js), and what
// the title bar, the bars and the key bar say. The list, the terminal view, the cards and the key
// help are reached only through contract 2.9's functions; pane.js chooses the right side.
//
// Stage D (plan D task 37): the list keys `l` / F2, `g`, `n`, `p` open the dialogs of
// web/edit.js and `d` marks done (D15), with web/toast.js's Undo toast. While a dialog is shown
// it is modal (D2): `.app` is inert under its scrim, app.js moves the keyboard nowhere and acts
// on no list key, and every window chord passes `windowChordGate` first; when it closes,
// `dialogClosed` gives the keyboard back.
//
// Stage B (plan B task 55): the window title carries the count of sessions that need you, each
// `list` closes the notifications of sessions that no longer do (web/notify.js), Ctrl+Shift+J
// walks `needYou.order` as the server sends it (B14), a `notify` shows a desktop notification
// (B15), and a click on one passes `windowChordGate` as a window chord does.
//
// Stage C (plan C task 75): the restore banner of web/banner.js at the top of the list zone, drawn
// from each `list`'s `banner`, with the report of every restore run (`notice restore-progress`). A
// restore selects nothing and moves no keyboard (C21); a key held on one of its controls acts on
// nothing once the control is gone, as a key held in a dialog (`heldFromDialog`).
//
// Stage E (plan E task 98): the quick switcher of web/switcher.js, opened by Ctrl+Shift+P and by
// the title bar's `Switch…` through `windowChordGate`. Its text is the view's `switcher` (cut as
// the filter is: 1,024 bytes, then 16 words), and each `list` hands it its ranked items. While it
// is shown it is modal as a dialog is (E11): `.app` is inert under its scrim, app.js moves the
// keyboard nowhere and acts on no list key, and every window chord but Ctrl+Shift+P says `close
// the switcher first (Esc)`; when it closes the keyboard goes back where it was, or where a pick
// puts it. A pick reveals the row (`list.reveal`, E10), selects it and does what Enter in the
// list does; the restore offer sends `act restore` (E12).
//
// Order at load (S2 8.2.2): the launch token leaves the address first, before anything can open a
// connection; then the stored key is read; then the connection opens.

/** @import { ClosedBlock, ExitMessage, ListMessage, ResultMessage, RowPayload, SearchChip, SectionPayload, ServerMessage, SwitchItem, TerminalPayload, WelcomeMessage } from '../src/window/protocol.ts' */
/** @import { EditWhat, ListAction, WindowChord, Zone } from './keys.js' */
/** @import { Change } from './connection.js' */
/** @import { Pane } from './pane.js' */
import { nextNeeding, windowTitle } from './attention-text.js';
import { decodeKey, loadKey, takeToken } from './auth.js';
import { createBanner } from './banner.js';
import { createCards } from './cards.js';
import { createConnection, TEXTS } from './connection.js';
import { createEditor } from './edit.js';
import { serverNow } from './format.js';
import { createHelp } from './help.js';
import { cancels, listKey, switcherKey, windowChord } from './keys.js';
import { createList } from './list.js';
import { createNotifications } from './notify.js';
import { blockInfo, paneFor, sessionRow } from './pane.js';
import { cutWords } from './search-text.js';
import { createSwitcher, pickResumes } from './switcher.js';
import { createTerminalView } from './terminal-view.js';
import { createToast } from './toast.js';

// S2 8.2.2: before anything else.
let token = takeToken();

const NO_KEY =
  'this window has no key; run skydeck window (or skydeck window --print-url for a browser tab)';
const RESTARTED = "skydeck's server restarted; your sessions kept running";
/** How long a line of the key bar stays. */
const KEY_MESSAGE_MS = 5000;
/** D15: the toast's words (the mockup's), for a session hidden by done and for a running one. */
const DONE_HIDDEN = 'Marked done: hidden from the list. It comes back on new activity.';
const DONE_RUNNING = 'Marked done. Stays under Open while it runs; hidden once it stops.';
/** S2 8.2.6's limits of a proposed size. */
const MAX_COLS = 1000;
const MAX_ROWS = 500;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`the page has no #${id}`);
  }
  return found;
}

const dom = {
  gone: byId('gone'),
  goneText: byId('gone-text'),
  problem: byId('problem'),
  info: byId('info'),
  infoText: byId('info-text'),
  keepAlive: byId('keepalive'),
  tick: byId('tick'),
  listZone: byId('list-zone'),
  banner: byId('banner'),
  list: byId('list'),
  rightZone: byId('right-zone'),
  cards: byId('cards'),
  terminal: byId('terminal'),
  focusZone: byId('focus-zone'),
  keyMessage: byId('key-message'),
  help: byId('help'),
  editor: byId('editor'),
  toast: byId('toast'),
  notifyOn: /** @type {HTMLButtonElement} */ (byId('notify-on')),
  switcher: byId('switcher'),
  switchButton: byId('switch-button'),
  measure: byId('cell-measure'),
};
/** The page under a dialog: inert while one is shown (D2), so that nothing in it takes the keyboard. */
const appRoot = /** @type {HTMLElement} */ (document.querySelector('.app'));

/** The build the page was loaded with: its own URL is /assets/<build>/web/app.js. */
const assetVersion =
  /\/assets\/([^/]+)\/web\/app\.js$/.exec(new URL(import.meta.url).pathname)?.[1] ?? '';
const windowId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');
/** S2 5.1 `--print-url`: in a normal tab the browser keeps some chords, so the key bar says more. */
const inTab = !matchMedia('(display-mode: standalone)').matches;
document.documentElement.dataset.display = inTab ? 'tab' : 'app';

const state = {
  /** @type {ListMessage | null} */
  list: null,
  /** When the list shown came (performance.now()), for the server's now (`serverNow`, plan D6). */
  listAt: 0,
  /** How many lists came, to tell whether one came since an act was sent (ruled 06:38Z). */
  lists: 0,
  /**
   * The sessions whose label, group or note this page's own act changed, while no list that holds
   * that result has come (review 2's C1, ruled): their dialog would start from the old text.
   * @type {Set<string>}
   */
  unlisted: new Set(),
  /** @type {string | null} */
  selected: null,
  /**
   * F9: the selected caption of a closed block — its section and group, and the number of its
   * sessions and of those that need you as last drawn (the pane's group card keeps them while a
   * filter hides the caption) —, or null. Never with `selected`: while a caption is selected no
   * session is, and the server is told `selected: null` (nothing is seen, no session is acted on).
   * @type {{ section: SectionPayload['name'], group: string, size: number, needYou: number } | null}
   */
  caption: null,
  /** @type {Zone} */
  zone: 'terminal',
  /** Session ids, the most recently selected first (Ctrl+Tab, Ctrl+Shift+O). @type {string[]} */
  mru: [],
  view: {
    filter: '',
    unfolded: /** @type {string[]} */ ([]),
    showDone: false,
    chips: /** @type {SearchChip[]} */ ([]),
    closed: /** @type {ClosedBlock[]} */ ([]),
    /** E8: the switcher's text while it is shown, null while it is not. @type {string | null} */
    switcher: /** @type {string | null} */ (null),
  },
  /** Whether the connection is open (the switcher says when it is not, E11). */
  connected: false,
  /** What had the keyboard when the switcher opened: it gets it back when it closes (E11). @type {Element | null} */
  switcherFrom: /** @type {Element | null} */ (null),
  newOpen: false,
  /** @type {Map<string, ExitMessage>} */
  exits: new Map(),
  /** The lines of the last resume of a session that did not open its terminal. @type {Map<string, string[]>} */
  lines: new Map(),
  /** What the right side shows now, to apply a change only. */
  paneKey: '',
  /** @type {Pane} */
  pane: /** @type {Pane} */ ({ kind: 'none' }),
  /** The terminals to attach again after a reconnect, one after the other (S2 8.2.5, 8.2.8). @type {string[] | null} */
  reattach: null,
  /** @type {string | null} */
  waitingSnap: null,
  /** The first list after a welcome starts the re-attach. */
  welcomed: false,
  /** The height of the right side's header (`#cards .card-header`, a hook of contract 2.9) as
   *  last shown; 0 before any (Z1, item 5). */
  headerHeight: 0,
  /**
   * The session whose terminal a resume or new of this page is bringing (S2 11.3): set by its
   * result, ended when that terminal is shown, when another session is selected, or when the
   * connection is lost (Z1). @type {string | null}
   */
  bringing: null,
  lastFocus: '',
  /** The sessions whose `done` or `undone` of this page waits for its answer (D15). @type {Set<string>} */
  marking: new Set(),
  /**
   * This page's own `d` in the list (S2 12.9's exception, D15): the session, the section it was
   * last listed in and that section's order then, whether a list came since its act was sent, and
   * whether the answer came.
   * @type {{ sessionId: string, section: SectionPayload['name'], order: string[], listed: boolean, answered: boolean } | null}
   */
  leaving: null,
  /**
   * Where that `d` left the selection (`at`: the row it selected, or the done session itself when
   * it selected none), so that its Undo selects the session again (ruled); `answered` once the
   * Undo's answer came. @type {{ sessionId: string, at: string, answered: boolean } | null}
   */
  undoTo: null,
  /** The key (`code`) whose keydown opened the dialog or the switcher shown, until it is
   *  released: its auto-repeats type nothing into the field. */
  openedBy: '',
};

/** @type {ReturnType<typeof createConnection> | null} */
let connection = null;
let acts = 0;
/** @type {Map<number, (result: ResultMessage) => void>} */
const pending = new Map();
/** Events the page acted on as a window chord (S2 12.9: a key is acted on once). @type {WeakSet<Event>} */
const actedOn = new WeakSet();

// --- the modules of contract 2.9 --------------------------------------------------------------

/** @param {Record<string, unknown> & { t: string }} message */
const send = (message) => connection?.send(message) ?? false;

const list = createList(dom.list, {
  select: (id, how, change) => select(id, how, change),
  caption: (section, group, change) => selectCaption(section, group, change),
  activate: (id) => activate(id),
  view: (change) => changeView(change),
  say: (text) => say(text),
});
const terminalView = createTerminalView(dom.terminal, {
  send: (message) => {
    send(message);
    // The view detached the terminal the re-attach waits for: its snap will not come. The queue
    // goes on once the view is done (it may be detaching more: those are skipped then).
    if (message.t === 'detach' && message['term'] === state.waitingSnap) {
      queueMicrotask(() => {
        if (state.waitingSnap === message['term']) {
          nextReattach();
        }
      });
    }
  },
  chord: (event) => chordOf(event),
  openLink: (url) => {
    void act({ kind: 'open-link', url }).then((result) => {
      if (!result.ok) {
        say(result.error ?? 'skydeck could not open the link');
      }
    });
  },
});
/**
 * The view's optional `fits(width, height)` (contract 2.9, task 28): the columns and rows a
 * terminal of the view shows in a terminal area of that many CSS pixels, or null while it cannot
 * tell. A view without it leaves `area()` to the page's own arithmetic.
 * @type {typeof terminalView & { fits?: (width: number, height: number) => { cols: number, rows: number } | null }}
 */
const fitting = terminalView;
const cards = createCards(dom.cards, {
  act: (action) => act(action),
  select: (id) => select(id, 'click'),
  edit: (what, sessionId) => edit(what, sessionId, '', ''),
  done: (sessionId) => markDone(sessionId, false),
  say: (text) => say(text),
});
const help = createHelp(dom.help);
const toast = createToast(dom.toast);
const editor = createEditor(dom.editor, {
  act: (action) => act(action),
  toast: (text, undo) => toast.show(text, undo),
  closed: () => dialogClosed(),
  now: () => listNow(),
});
// Stage B (B15): a click on a notification passes the gate of a window chord, then selects. A
// session this page's list does not show (its filter, the folded Earlier) and that has no terminal
// of the window is not selected (ruled on review 2): the pane would be empty, and a focused page's
// selection is seen after 1.5 s (S2 12.4), which would clear a mark of a session never shown. One
// that a closed block hides is selected (F3, G5): `needYou.order` holds it — it holds the rows the
// list shows and those closed blocks hide, never one a filter, the fold or done hidden leaves out —,
// and the server opens its block for the selection. One that no longer needs you, has no terminal of
// the window and sits in a closed block is still refused (the page cannot know a closed block's
// members), so the line names the closed block too (F6, L4).
const notifications = createNotifications(dom.notifyOn, {
  select: (id) => {
    if (!windowChordGate('notification')) {
      return;
    }
    const inBlock = state.list?.needYou?.order?.includes(id) ?? false;
    if (rowOf(id) === undefined && !hasTerminal(id) && !inBlock) {
      say('that session is hidden by the filter, the fold or a closed block');
      return;
    }
    select(id, 'chord');
  },
});
// The item hides itself once the permission is answered: pressed from the keyboard, it takes the
// keyboard with it, and the zone's holder takes it back (S2 12.9), as for the notice's ×.
dom.notifyOn.addEventListener('blur', () => setTimeout(keepKeyboard, 0));
// Stage C (plan C task 75): the restore banner; its times in the page's own time zone (C18).
const banner = createBanner(dom.banner, {
  act: (action) => act(action),
  say: (text) => say(text),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
});
// A control of the banner pressed from the keyboard can take itself away (the report's ×): the
// zone's holder takes the keyboard back once the click is done, as for the notice's ×.
dom.banner.addEventListener('click', () => setTimeout(keepKeyboard, 0));
// A click sequence that began on the banner acts on nothing outside it (ruled on review 2 of task
// 75, N1): its first click can take its control away (Not now, the report's ×), the list then
// moves up under the pointer, and the later clicks of a double click would select — and its
// dblclick resume — the row that came to lie there. They are swallowed before the list, the
// header or the pane see them, and move no keyboard; a sequence that begins elsewhere is not.
let clicksFromBanner = false;
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
  addEventListener(
    type,
    (event) => {
      if (!(event instanceof MouseEvent)) {
        return;
      }
      const inBanner = event.target instanceof Node && dom.banner.contains(event.target);
      if (type === 'mousedown' && event.detail <= 1) {
        clicksFromBanner = inBanner;
      } else if (event.detail > 1 && clicksFromBanner && !inBanner) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}
// Stage E (plan E task 98): the quick switcher; its ages on the server's clock (`listNow`), the
// offer's time in the page's own time zone (stage C's rule for the banner, C18).
const switcher = createSwitcher(dom.switcher, {
  text: (value) => switcherText(value),
  pick: (item) => switcherPick(item),
  restore: (sessionIds) => switcherRestore(sessionIds),
  closed: () => switcherClosed(),
  now: () => listNow(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
});
// The title bar's `Switch…` passes the gate of a window chord (B15), as Ctrl+Shift+P does; the
// title bar takes no keyboard on a click, so the switcher knows where the keyboard was.
dom.switchButton.addEventListener('click', () => {
  if (windowChordGate('switcher')) {
    openSwitcher();
  }
});

/** Whether a dialog or the switcher is shown (D2, E11: then the page is modal). */
function modal() {
  return editor.shown() || switcher.shown();
}

// --- what the page says -------------------------------------------------------------------------

/** @param {'connecting' | 'open' | 'lost' | 'fatal'} value */
function setConnectionState(value) {
  document.documentElement.dataset.connection = value;
  state.connected = value === 'open';
}

/**
 * HH:MM:SS of `date` in the page's time zone (S2 6.3's "since 14:02:11").
 * @param {Date} date
 * @returns {string}
 */
function clockTime(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/**
 * S2 6.3's bar, with the time the server stopped answering.
 * @param {Date} since
 */
function showGone(since) {
  const command = document.createElement('code');
  command.textContent = 'skydeck window';
  dom.goneText.replaceChildren(
    `skydeck's server is not answering (since ${clockTime(since)}). Sessions in the window keep running unless WSL has stopped. To get back, open a WSL terminal and run: `,
    command,
  );
  dom.gone.hidden = false;
}

/** @param {string} text */
function showProblem(text) {
  dom.problem.textContent = text;
  dom.problem.hidden = false;
}

/** @param {string} text */
function showInfo(text) {
  dom.infoText.textContent = text;
  dom.info.hidden = false;
}
byId('info-close').addEventListener('click', () => {
  dom.info.hidden = true;
  keepKeyboard(); // pressed from the keyboard: its holder is no longer visible
});
// The page's chrome takes no keyboard on a mouse click (ruled, review 2 round three): a click on
// the title bar, the key bar or the notice's × leaves the keyboard where it was — in the filter,
// say, so that what the user types next does not land on the list. Their buttons still work, and
// from the keyboard too.
for (const chrome of [
  document.querySelector('.titlebar'),
  document.querySelector('.keybar'),
  byId('info-close'),
]) {
  chrome?.addEventListener('mousedown', (event) => event.preventDefault());
}
// A click that selected nothing gives the keyboard to the zone's holder once it is done: on a
// notice's text, on the key help (nothing had it then), on the header above a terminal (the zone
// itself had it). A click or drag that selected text of the page moves nothing, so that the text
// can be copied (ruled, review 2 of task 26: replaces the earlier rule, which took the selection
// away from a terminal whose holder is a text control, as xterm.js's is).
addEventListener('mouseup', () => {
  setTimeout(() => {
    if (modal() || textSelected()) {
      return; // D2: a dialog keeps the keyboard (it gives its own field the keyboard back)
    }
    if (document.activeElement === dom.rightZone && state.pane.kind === 'terminal') {
      terminalView.focus();
      return;
    }
    keepKeyboard();
  }, 0);
});
// (No rule acts on the end of a selection: a mousedown on text makes a caret first, and a rule
// that gave the terminal the keyboard then would take away the selection the drag is about to
// make. The keyboard comes back at the next plain click, a zone chord, or the next render once
// nothing is selected; ruled, review 2 of task 26.)

/** @type {ReturnType<typeof setTimeout> | null} */
let keyMessageTimer = null;
/** @param {string} text */
function say(text) {
  dom.keyMessage.textContent = text;
  if (keyMessageTimer !== null) {
    clearTimeout(keyMessageTimer);
  }
  keyMessageTimer = setTimeout(() => {
    dom.keyMessage.textContent = '';
  }, KEY_MESSAGE_MS);
}

/**
 * S2 6.2: "WSL is not kept running" while the keep-alive has failed; its reason as the tooltip.
 * @param {boolean} failed
 * @param {string | null} reason
 */
function showKeepAlive(failed, reason) {
  dom.keepAlive.hidden = !failed;
  dom.keepAlive.title = failed && reason !== null ? reason : '';
}

// --- sizes and colours --------------------------------------------------------------------------

/**
 * What the terminal area holds: the columns and rows of the view's `fits` (contract 2.9, task 28)
 * when it has one and can tell, else at the terminal's font, measured with the hidden cell of
 * index.html, which has the terminal's font (style.css, `--term-font`). The area is the right
 * zone's box as laid out — not rounded to whole pixels, as the view's own measure is not (at a
 * display scale of 125 % it is a fraction; F2, review 2), and without its border — less what
 * stands above the terminal: for `focus` (S2 8.2.3) while a terminal is
 * shown, what the cards show (the header, an ended bar); for an act's first size (`forAct`, S2
 * 8.2.6) and for another pane only the header, which the terminal it brings will have above it
 * (Z1, item 5).
 * @param {boolean} [forAct]
 * @returns {{ cols: number, rows: number }}
 */
function area(forAct = false) {
  // The zone's box less its borders (its 2 px top border, style.css `.zone`, is not the
  // terminal's), unrounded: clientWidth rounds, and half a pixel more could hold one column more
  // than the view, which floors, proposes once the terminal is there.
  const rect = dom.rightZone.getBoundingClientRect();
  const style = getComputedStyle(dom.rightZone);
  /** @param {string} side */
  const border = (side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
  const box = {
    width: rect.width - border('left') - border('right'),
    height: rect.height - border('top') - border('bottom'),
  };
  const above =
    state.pane.kind === 'terminal' && !forAct
      ? dom.cards.getBoundingClientRect().height
      : headerHeight();
  const height = box.height - above;
  // The view is never asked about an area under 1 px (cards taller than the zone), and its answer
  // is held to what the server takes, as the page's own is: whole numbers, 1…MAX_COLS ×
  // 1…MAX_ROWS; one that is no number (a cell not measured yet) leaves the page's own arithmetic.
  const fitted =
    typeof fitting.fits === 'function'
      ? fitting.fits(Math.max(1, box.width), Math.max(1, height))
      : null;
  if (fitted && Number.isFinite(fitted.cols) && Number.isFinite(fitted.rows)) {
    return {
      cols: Math.max(1, Math.min(MAX_COLS, Math.floor(fitted.cols))),
      rows: Math.max(1, Math.min(MAX_ROWS, Math.floor(fitted.rows))),
    };
  }
  const cell = dom.measure.getBoundingClientRect();
  const cellWidth = cell.width / 20 || 8;
  const cellHeight = cell.height || 17;
  return {
    cols: Math.max(1, Math.min(MAX_COLS, Math.floor(box.width / cellWidth))),
    rows: Math.max(1, Math.min(MAX_ROWS, Math.floor(height / cellHeight))),
  };
}

/**
 * The terminal's colours as `#rrggbb` (S2 8.2.2 `start.theme`), from style.css's variables.
 * @returns {{ fg: string, bg: string }}
 */
function theme() {
  const style = getComputedStyle(document.documentElement);
  /** @param {string} name @param {string} fallback */
  const colour = (name, fallback) => {
    const value = style.getPropertyValue(name).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(value) ? value : fallback;
  };
  return { fg: colour('--term-fg', '#d6d9de'), bg: colour('--term-bg', '#121417') };
}

// --- the state and the server -------------------------------------------------------------------

/** @returns {RowPayload[]} */
function rows() {
  return state.list?.sections.flatMap((section) => section.rows) ?? [];
}

/**
 * @param {string} id
 * @returns {RowPayload | undefined}
 */
function rowOf(id) {
  return rows().find((row) => row.id === id);
}

function sendView() {
  send({ t: 'view', ...state.view, selected: state.selected });
}

function sendFocus() {
  const message = {
    t: 'focus',
    focused: document.hasFocus(),
    selected: state.selected,
    area: area(),
  };
  state.lastFocus = JSON.stringify(message);
  send(message);
}

/** Sends `focus` when something it carries changed (S2 8.2.3: on every change). */
function focusChanged() {
  const message = {
    t: 'focus',
    focused: document.hasFocus(),
    selected: state.selected,
    area: area(),
  };
  if (JSON.stringify(message) !== state.lastFocus) {
    sendFocus();
  }
}

/** S2 8.2.3's limits of a string a page sends, in bytes of UTF-8; a note's text and base: D5. */
const TEXT_BYTES = 1024;
const PATH_BYTES = 4096;
const NOTE_BYTES = 65536;
/** At most this many sessions in one `restore`, and the form of the boot "Not now" names: what
 *  S2 8.2.3 takes (plan C 2.2), the server closing the connection for anything else. */
const RESTORE_IDS = 1000;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utf8 = new TextEncoder();

/**
 * `text` (well formed) cut to at most `bytes` bytes of UTF-8, never inside a character.
 * @param {string} text
 * @param {number} bytes
 * @returns {string}
 */
function cutTo(text, bytes) {
  let used = 0;
  let end = 0;
  for (const character of text) {
    used += utf8.encode(character).length;
    if (used > bytes) {
      break;
    }
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * A change of the page's view (S2 8.2.3 `view`). The filter's and the switcher's text are held to
 * S2 8.2.3's limit, so that the server never refuses the page's view (it would close the
 * connection for it), and to E3's 16 words: a longer one is cut to its first 1,024 bytes, then
 * after its 16th word (`cutWords`, as the server reads it). The key bar says so for the filter
 * (`the filter is cut to its first 1,024 bytes`, `… 16 words`); for the switcher its footer does.
 * @param {{ filter?: string, unfolded?: string[], showDone?: boolean, chips?: SearchChip[], closed?: ClosedBlock[], switcher?: string | null }} change
 */
function changeView(change) {
  let next = change;
  if (change.filter !== undefined) {
    next = { ...next, filter: searchText(change.filter, true) };
  }
  if (typeof change.switcher === 'string') {
    next = { ...next, switcher: searchText(change.switcher, false) };
  }
  state.view = { ...state.view, ...next };
  sendView();
}

/**
 * A search text as the page sends it (E3): its first 1,024 bytes of UTF-8, well formed, up to the
 * end of its 16th word. For the filter the key bar says when it was cut.
 * @param {string} text
 * @param {boolean} filter
 * @returns {string}
 */
function searchText(text, filter) {
  const bytes = cutTo(text.toWellFormed(), TEXT_BYTES);
  const words = cutWords(bytes);
  if (filter && bytes.length < text.length) {
    say('the filter is cut to its first 1,024 bytes');
  } else if (filter && words.cut) {
    say('the filter is cut to its first 16 words');
  }
  return words.text;
}

/** The acts whose result a dialog starts from: after this page's own `ok`, it waits for the list
 *  that holds it (C1). */
const EDITS = new Set(['label', 'group', 'note']);
/** Each dialog's list key, for D3's sentence. */
const KEY_OF = { label: 'l', group: 'g', note: 'n', pr: 'p' };

/** The fields of an action that S2 8.2.3's limits hold, with their names for a refusal. */
const LIMITED = /** @type {Record<string, [string, string, number][]>} */ ({
  new: [
    ['dir', 'the directory', PATH_BYTES],
    ['label', 'the label', TEXT_BYTES],
    ['group', 'the group', TEXT_BYTES],
    ['flags', 'the flags', TEXT_BYTES],
  ],
  'open-link': [['url', 'the link', PATH_BYTES]],
  // Stage D (plan D 2.2, 2.4).
  label: [['text', 'the label', TEXT_BYTES]],
  group: [['text', 'the group', TEXT_BYTES]],
  note: [
    ['text', 'the note', NOTE_BYTES],
    ['base', 'the note as it was', NOTE_BYTES],
  ],
  'pr-add': [['url', 'the address', PATH_BYTES]],
  'pr-rm': [['url', 'the address', PATH_BYTES]],
});

/**
 * Why S2 8.2.3 would refuse `action` (the server closes the connection for such a message, and a
 * dialog must not lose the user's text that way): a field over its limit, or text that is not
 * well formed (a lone surrogate); null when it would not.
 * @param {Record<string, unknown> & { kind: string }} action
 * @returns {string | null}
 */
function overLimit(action) {
  // Stage C (plan C 2.2): a restore's count of sessions, the form of the boot "Not now" names.
  const ids = action['sessionIds'];
  if (action.kind === 'restore' && Array.isArray(ids) && ids.length > RESTORE_IDS) {
    return `skydeck restores at most ${RESTORE_IDS.toLocaleString('en-US')} sessions at once; untick some`;
  }
  const bootId = action['bootId'];
  if (action.kind === 'dismiss-restore' && !(typeof bootId === 'string' && BOOT_ID.test(bootId))) {
    return "this offer's boot id is not one skydeck takes; it cannot be dismissed";
  }
  for (const [field, name, bytes] of LIMITED[action.kind] ?? []) {
    const value = action[field];
    if (typeof value !== 'string') {
      continue;
    }
    if (!value.isWellFormed()) {
      return `${name} holds text that is not well formed; skydeck cannot take it`;
    }
    if (utf8.encode(value).length > bytes) {
      return `${name} is longer than skydeck takes: at most ${bytes.toLocaleString('en-US')} bytes of UTF-8`;
    }
  }
  return null;
}

/**
 * Selects a session (S2 12.9): a click on a running row focuses its terminal, a click on another
 * row the list; moving with the list's keys keeps the list. `list` (F9, a click on a selected
 * closed caption): the list zone takes the keyboard before the session is shown, so that no
 * terminal takes it. A selected caption is no longer selected. `change` (F9: the list opening a
 * caption's block) goes in the same `view` (ruled (3): no view names a block closed while a
 * session of it is selected).
 * @param {string} id
 * @param {'click' | 'key' | 'chord' | 'list'} how
 * @param {{ closed?: ClosedBlock[] }} [change]
 */
function select(id, how, change) {
  state.newOpen = false;
  if (state.bringing !== id) {
    state.bringing = null; // the user chose another session: the resume's mark ends (Z1)
  }
  state.caption = null;
  if (change?.closed !== undefined) {
    state.view = { ...state.view, closed: change.closed };
  }
  if (state.selected !== id) {
    state.selected = id;
    state.mru = [id, ...state.mru.filter((other) => other !== id)];
    sendView();
    sendFocus();
  } else if (change?.closed !== undefined) {
    sendView();
  }
  if (how === 'list') {
    setZone('list');
  }
  render();
  if (how !== 'key' && how !== 'list') {
    setZone(hasTerminal(id) ? 'terminal' : 'list');
  }
}

/**
 * F9: selects the caption of the closed block of `group` in `section` (the list's keys: ↑ ↓ onto
 * it, ← on a session of its open card). No session is selected then: `view` and `focus` say
 * `selected: null`, so that the server sees none (S2 12.4's seen, notifications, the resume card),
 * and the pane shows the group card. The zone stays. `change` (← closing the block) goes in the
 * same `view` (ruled (1): no view names the block closed with a session of it selected).
 * @param {SectionPayload['name']} section
 * @param {string} group
 * @param {{ closed?: ClosedBlock[] }} [change]
 */
function selectCaption(section, group, change) {
  state.newOpen = false;
  state.bringing = null;
  const same =
    state.selected === null && state.caption?.section === section && state.caption.group === group;
  const info = blockInfo(state.list, section, group) ?? { size: 0, needYou: 0 };
  state.caption = { section, group, ...info };
  if (change?.closed !== undefined) {
    state.view = { ...state.view, closed: change.closed };
  }
  if (!same || change?.closed !== undefined) {
    state.selected = null;
    sendView();
  }
  if (!same) {
    sendFocus();
  }
  render();
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function hasTerminal(id) {
  const row = rowOf(id);
  return row !== undefined
    ? row.terminal !== null
    : (state.list?.terminals.some((term) => term.sessionId === id) ?? false);
}

/**
 * Enter or a double click (S2 12.6): a running session shows its terminal, a session elsewhere its
 * card, one that is not running is resumed.
 * @param {string} id
 */
function activate(id) {
  const row = rowOf(id);
  select(id, 'click');
  if (row === undefined || row.terminal !== null || row.elsewhere !== null) {
    return;
  }
  void act({ kind: 'resume', sessionId: id });
}

/**
 * An action (S2 8.2.3 `act`): `t` and `id` added, and for resume and new the terminal area as the
 * first size when the action has none. A successful resume or new selects its session (plan A25)
 * and focuses its terminal; the lines of one that did not open are kept for its resume card.
 * @param {Record<string, unknown> & { kind: string }} action
 * @returns {Promise<ResultMessage>}
 */
function act(action) {
  const id = ++acts;
  const sized =
    (action.kind === 'resume' || action.kind === 'new') && action['cols'] === undefined
      ? { ...action, ...area(true) }
      : action;
  /** @type {ResultMessage} */
  const unsent = {
    t: 'result',
    id,
    ok: false,
    lines: [],
    error: "skydeck's server is not connected; try again",
    sessionId: null,
  };
  const refused = overLimit(action);
  if (refused !== null) {
    return Promise.resolve({ ...unsent, error: refused });
  }
  if (!send({ t: 'act', id, ...sized })) {
    return Promise.resolve(unsent);
  }
  const listsAtSend = state.lists;
  return new Promise((resolve) => {
    pending.set(id, (result) => {
      // C1 (ruled): the list that holds an edit's result is one that came since the act was sent
      // (the real server sends it before the answer), else the next one; until then a dialog of
      // that session would start from the old text.
      if (
        result.ok &&
        EDITS.has(action.kind) &&
        typeof action['sessionId'] === 'string' &&
        state.lists === listsAtSend
      ) {
        state.unlisted.add(action['sessionId']);
        // The server sends no list equal to the last one, so after a save that changed nothing
        // shown none would come: a `view` asks for one, which the server answers at once
        // (review 2 of task 37, M2).
        sendView();
      }
      if (action.kind === 'resume' && typeof action['sessionId'] === 'string') {
        state.lines.set(
          action['sessionId'],
          result.ok ? [] : result.error === null ? result.lines : [result.error],
        );
      }
      if (result.ok && result.sessionId !== null) {
        state.bringing = result.sessionId;
        select(result.sessionId, 'chord');
        setZone('terminal');
      }
      render();
      resolve(result);
    });
  });
}

// --- stage D: the dialogs and done (plan D task 37) ------------------------------------------

/** The server's now as the page estimates it: the shown list's, counted on (plan D6, 2.4). */
function listNow() {
  return state.list === null ? '' : serverNow(state.list.nowNs, performance.now() - state.listAt);
}

/** The selected session's row, when the list shows it (S2 12.9: else none is selected). The list
 *  keys take it from here: they act on no session the list does not show (E13, ruled); the right
 *  side and the header's controls take `sessionRow`'s. */
function selectedRow() {
  return state.selected === null ? undefined : rowOf(state.selected);
}

/**
 * Opens the dialog `what` for `sessionId` (D1–D3): the list keys on the selected row, and the
 * header's controls (task 38) through the cards' `edit` — the session's row from `sessionRow`, so
 * also one the list does not show (E13). The note's dialog needs the list's
 * `selected` of that session, which holds the whole note (D3); a label, group or note that this
 * page's own act just changed waits for the list that holds it (C1). `key` is the key that opened
 * it ('' from the cards), `code` its physical key.
 * @param {EditWhat} what
 * @param {string} sessionId
 * @param {string} key
 * @param {string} code
 */
function edit(what, sessionId, key, code) {
  if (modal()) {
    return;
  }
  const row = sessionRow(state.list, sessionId);
  if (row === null) {
    say('no session selected');
    return;
  }
  const selected = state.list?.selected?.sessionId === sessionId ? state.list.selected : null;
  if ((what === 'note' && selected === null) || (what !== 'pr' && state.unlisted.has(sessionId))) {
    // D3's sentence; from the header's controls (no key) it names the dialog's own key.
    say(`the ${what} is not here yet; press ${key === '' ? KEY_OF[what] : key} again`);
    return;
  }
  state.openedBy = code;
  editor.open(what, row, selected); // the keyboard is in its field now
  appRoot.inert = true; // D2: nothing under the scrim takes the keyboard or a click
}

/**
 * The dialog closed, whatever closed it (`deps.closed`, D2): the page is no longer inert, and a
 * terminal that this page's resume or new brought meanwhile takes the keyboard, else the zone's
 * holder gets it — at once, without waiting for a list.
 */
function dialogClosed() {
  appRoot.inert = false;
  state.openedBy = '';
  if (!broughtTakesKeyboard()) {
    giveKeyboard();
  }
}

/**
 * After a dialog or the switcher closed: a terminal that this page's resume or new brought
 * meanwhile takes the keyboard (S2 11.3: the user's own action; D2, E11). False when none did.
 * @returns {boolean}
 */
function broughtTakesKeyboard() {
  const bringing = state.bringing;
  if (bringing === null) {
    return false;
  }
  setZone('terminal'); // the user's own action (and gives the zone the keyboard)
  const pane = state.pane;
  if (pane.kind === 'terminal' && (pane.row?.id === bringing || pane.term.sessionId === bringing)) {
    terminalView.focus();
    state.bringing = null;
  }
  // Not shown yet: render gives it the keyboard when its list comes.
  return true;
}

// --- stage E: the quick switcher (plan E task 98) ---------------------------------------------

/**
 * Ctrl+Shift+P or `Switch…`, once past the gate (E11): the help hidden, the page inert under the
 * switcher's scrim, the keyboard in its field; it remembers what had the keyboard. It gets the
 * list shown, or none while the page is not connected (it says so).
 */
function openSwitcher() {
  if (switcher.shown()) {
    return;
  }
  help.hide();
  state.switcherFrom = document.activeElement;
  appRoot.inert = true;
  switcher.open();
  switcher.update(state.connected ? state.list : null);
}

/**
 * The switcher's field changed (E8): the view's `switcher` is its text, cut as `changeView` cuts
 * it; the switcher learns the text sent, which its picks compare with `list.switcher.query`.
 * @param {string} value
 * @returns {string}
 */
function switcherText(value) {
  changeView({ switcher: value });
  return state.view.switcher ?? '';
}

/**
 * The switcher closed, whatever closed it: the page is no longer inert, the view's `switcher` is
 * null again, and the keyboard goes back where it was — or to a terminal this page's resume
 * brought meanwhile (E11); after a pick, `switcherPick` moves it on.
 */
function switcherClosed() {
  appRoot.inert = false;
  state.openedBy = '';
  const from = state.switcherFrom;
  state.switcherFrom = null;
  state.view = { ...state.view, switcher: null };
  sendView();
  if (broughtTakesKeyboard()) {
    return;
  }
  // A text field that had it (the filter, the New form's, the find bar's) when it is still there;
  // else the zone's holder — the list, or the terminal shown now —, never a button (S2 12.9).
  if (
    from instanceof HTMLElement &&
    isTextField(from) &&
    from.isConnected &&
    from.checkVisibility()
  ) {
    from.focus();
    return;
  }
  giveKeyboard();
}

/**
 * E10: a pick of the switcher (it has closed). When the list does not show the row, its view
 * changes first so that it does, as `hiddenBy` says (`list.reveal`), the key bar saying so when
 * the filter was cleared; then the row is selected and gets what Enter on it in the list does —
 * stage A's `activate`, applied to the switcher's row, since the sections may not hold it yet: a
 * terminal of the window or a session elsewhere is shown, one that is not running is resumed into
 * the window (a refusal shows on its card). A closed block needs nothing (G5: the server opens it
 * for its selected member, and the list then forgets that the user closed it).
 * @param {SwitchItem} item
 */
function switcherPick(item) {
  const row = item.row;
  const hiddenBy = Array.isArray(item.hiddenBy) ? item.hiddenBy : [];
  if (hiddenBy.length > 0) {
    list.reveal(hiddenBy);
    if (hiddenBy.includes('filter')) {
      say(`the filter was cleared to show ${row.shortId}`);
    }
  }
  // The keyboard goes where the pick puts it (E11), as Enter on the row in the list would: to the
  // list, or to the row's terminal — not back into the text field the switcher was opened from
  // and gave it back to as it closed (the filter's, where a `d` would be text; review 2, S4).
  const holder = document.activeElement;
  if (holder instanceof HTMLElement && isTextField(holder)) {
    holder.blur();
  }
  select(row.id, 'click');
  if (!pickResumes(row)) {
    return; // its terminal or its card is shown
  }
  void act({ kind: 'resume', sessionId: row.id }).then((result) => {
    // A refusal shows on the resume card; a session the list does not show has none, so the key
    // bar says it (ruled on review 2, C2).
    if (!result.ok && rowOf(row.id) === undefined) {
      say(result.error ?? 'skydeck could not resume that session');
    }
  });
}

/**
 * E12: Enter on the switcher's restore offer: `act restore` with its sessions, in the banner's
 * order; a refusal in the key bar (the run's report is stage C's banner's).
 * @param {string[]} sessionIds
 */
function switcherRestore(sessionIds) {
  void act({ kind: 'restore', sessionIds }).then((result) => {
    if (!result.ok) {
      say(result.error ?? 'skydeck could not restore those sessions');
    }
  });
}

/**
 * The section a session is listed in, and that section's order.
 * @param {string} sessionId
 * @returns {{ section: SectionPayload['name'], order: string[] } | null}
 */
function placeOf(sessionId) {
  const section = state.list?.sections.find((candidate) =>
    candidate.rows.some((row) => row.id === sessionId),
  );
  return section === undefined
    ? null
    : { section: section.name, order: section.rows.map((row) => row.id) };
}

/**
 * D15: `d` and the header's Done mark the session done, or undone for a done row; one act per
 * session at a time, and none while its own act waits. A `done` that the server took shows the
 * Undo toast. `fromList`: this page's `d` in the list, after which S2 12.9's exception moves the
 * selection (`leaveDone`); the Done button leaves it to the main rule. The row is `sessionRow`'s:
 * the header's Done also marks a session the list does not show (E13).
 * @param {string} sessionId
 * @param {boolean} fromList
 */
function markDone(sessionId, fromList) {
  const row = sessionRow(state.list, sessionId);
  if (row === null) {
    say('no session selected');
    return;
  }
  if (state.marking.has(sessionId)) {
    return;
  }
  const kind = row.done ? 'undone' : 'done';
  const place = placeOf(sessionId);
  if (fromList && kind === 'done' && place !== null) {
    state.leaving = { sessionId, ...place, listed: false, answered: false };
    state.undoTo = null;
  }
  state.marking.add(sessionId);
  void act({ kind, sessionId }).then((result) => {
    state.marking.delete(sessionId);
    if (!result.ok) {
      if (state.leaving?.sessionId === sessionId) {
        state.leaving = null; // a refused `d` moves nothing
      }
      say(result.error ?? 'skydeck could not do that');
      return;
    }
    if (kind === 'undone') {
      return;
    }
    // A row with no section (`selectedRow`'s, E13) says whether it runs by itself: the server's
    // rule of Open (`open` in src/window/view/build.ts; ruled 13:05Z).
    const running =
      place !== null ? place.section === 'open' : row.starting || row.state !== 'not-running';
    toast.show(running ? DONE_RUNNING : DONE_HIDDEN, () => undoDone(sessionId));
    if (state.leaving?.sessionId === sessionId) {
      state.leaving.answered = true;
      if (state.leaving.listed) {
        leaveDone(); // a list since the act was sent holds the result (ruled 06:38Z, 08:15Z)
      } else {
        sendView(); // as M2: the list that holds it comes at once (review 2's S3, ruled)
      }
    }
  });
}

/**
 * The toast's Undo of a `done`: `undone`. When it undoes this page's own `d` in the list, the
 * session is selected again once it is back, if the selection is still where that `d` left it
 * (ruled; `followUndo`); a `d` whose selection has not moved yet moves it no more.
 * @param {string} sessionId
 */
function undoDone(sessionId) {
  if (state.leaving?.sessionId === sessionId) {
    state.leaving = null;
  }
  if (state.marking.has(sessionId)) {
    return;
  }
  state.marking.add(sessionId);
  const back = state.undoTo?.sessionId === sessionId ? state.undoTo : null;
  void act({ kind: 'undone', sessionId }).then((result) => {
    state.marking.delete(sessionId);
    if (!result.ok) {
      if (state.undoTo === back) {
        state.undoTo = null;
      }
      say(result.error ?? 'skydeck could not do that');
      return;
    }
    if (back !== null && state.undoTo === back) {
      back.answered = true;
      followUndo();
    }
  });
  keepKeyboard(); // pressed from the keyboard, the toast's Undo is gone
}

/**
 * At each list while this page's `d` waits. Before its answer, a list holds the result only when
 * the row is gone from its section or marked done there (`listed`); one that still shows it as
 * not done is older than the write — a list that crossed the act, or one a busy store left stale
 * (review 2's S3, ruled 08:15Z) —, and only the row's place in it is kept. After its answer, with
 * no list holding it before, the next list decides, whatever it shows.
 */
function followDone() {
  const leaving = state.leaving;
  if (leaving === null) {
    return;
  }
  if (leaving.answered) {
    leaveDone();
    return;
  }
  const row = state.list?.sections
    .find((section) => section.name === leaving.section)
    ?.rows.find((candidate) => candidate.id === leaving.sessionId);
  if (row === undefined || row.done) {
    leaving.listed = true;
    return;
  }
  const place = placeOf(leaving.sessionId);
  if (place !== null) {
    Object.assign(leaving, place);
  }
}

/**
 * S2 12.9's exception (D15, ruled), decided once, on the list that holds the result of this
 * page's `d` — one that came since its act was sent and shows the write, else the next one, which
 * the page asks for (ruled 06:38Z and 08:15Z): when that
 * list no longer has the row, while that session is still the selected one, the row after it in
 * the same section is selected, else the one before it, else none — never a row of Open. A row
 * that list still has (it runs, under Open; done sessions shown) moves nothing, then or later.
 */
function leaveDone() {
  const leaving = state.leaving;
  if (leaving === null || !leaving.answered) {
    return;
  }
  state.leaving = null;
  if (rowOf(leaving.sessionId) !== undefined) {
    return;
  }
  if (state.selected !== leaving.sessionId) {
    return; // the user moved the selection meanwhile: it stays
  }
  const section = state.list?.sections.find((candidate) => candidate.name === leaving.section);
  const listed = new Set(section?.rows.map((row) => row.id) ?? []);
  const at = leaving.order.indexOf(leaving.sessionId);
  const next =
    leaving.section === 'open'
      ? undefined
      : (leaving.order.slice(at + 1).find((id) => listed.has(id)) ??
        leaving.order
          .slice(0, at)
          .reverse()
          .find((id) => listed.has(id)));
  state.undoTo = { sessionId: leaving.sessionId, at: next ?? leaving.sessionId, answered: false };
  if (next !== undefined) {
    select(next, 'key');
  }
}

/** At each list, once the Undo's answer came: the session back, selected again (ruled). */
function followUndo() {
  const back = state.undoTo;
  if (back === null || !back.answered || rowOf(back.sessionId) === undefined) {
    return;
  }
  state.undoTo = null;
  if (state.selected === back.at && state.selected !== back.sessionId) {
    select(back.sessionId, 'key');
  }
}

/** Every pending action ends when the connection is lost: its result never comes. */
function dropPending() {
  for (const [id, resolve] of pending) {
    resolve({
      t: 'result',
      id,
      ok: false,
      lines: [],
      error: "skydeck's server stopped answering; the action may or may not have been done",
      sessionId: null,
    });
  }
  pending.clear();
}

/**
 * S2 8.2.5, 8.2.8 (ruled, task 26): after a reconnect the page attaches again the terminals it had
 * attached, the shown one first, each next one once the previous one's snap has arrived. The
 * proposal is the terminal's size in the new list (the terminal view sends its own fitted size
 * afterwards). An id the new list does not carry is skipped; when a list comes without the
 * terminal whose snap the queue waits for (one forgotten before its snapshot never gets a snap),
 * the queue goes on.
 */
function nextReattach() {
  state.waitingSnap = null;
  const queue = state.reattach;
  while (queue !== null && queue.length > 0) {
    const id = /** @type {string} */ (queue.shift());
    const term = state.list?.terminals.find((candidate) => candidate.id === id);
    // Skipped: one the new list lacks, and one the view detached meanwhile.
    if (term === undefined || !terminalView.attached().includes(id)) {
      continue;
    }
    state.waitingSnap = id;
    send({ t: 'attach', term: id, cols: term.cols, rows: term.rows });
    return;
  }
  state.reattach = null;
}

/** The terminal the pane shows, if any. @returns {TerminalPayload | null} */
function shownTerminal() {
  return state.pane.kind === 'terminal' ? state.pane.term : null;
}

/**
 * @param {WelcomeMessage} welcome
 * @param {Change} change
 * @param {Date | null} lostSince
 */
function welcomed(welcome, change, lostSince) {
  dom.gone.hidden = true;
  dom.problem.hidden = true;
  showKeepAlive(welcome.keepAlive.state === 'failed', welcome.keepAlive.error);
  if (change === 'restarted') {
    showInfo(RESTARTED);
  } else if (change === 'wsl-restarted') {
    // S2 6.3: the terminals of the server that held them are gone.
    // The welcome carries no boot time: the moment the page lost the old server (ruled, task 26).
    showInfo(
      `WSL has restarted since ${clockTime(lostSince ?? new Date())}: the sessions that were running have ended.`,
    );
    state.exits.clear();
  }
  const attached = change === 'first' ? [] : terminalView.attached();
  const shown = shownTerminal()?.id;
  state.reattach =
    change === 'wsl-restarted'
      ? []
      : [...attached.filter((id) => id === shown), ...attached.filter((id) => id !== shown)];
  state.welcomed = true;
  sendView();
  sendFocus();
}

/** @param {ServerMessage} message */
function received(message) {
  switch (message.t) {
    case 'list':
      state.list = message;
      state.listAt = performance.now();
      state.lists++;
      state.unlisted.clear(); // a list after the answer holds the result
      dom.tick.hidden = true;
      if (state.selected === null && state.caption === null && state.mru.length === 0) {
        // Nothing selected yet: the first row (Open's first slot when there is one). Only before
        // anything was ever selected (F9: once a selected caption's block opened without a key,
        // nothing is selected on purpose, and no list selects a session for the user).
        const first = rows()[0];
        if (first !== undefined) {
          state.selected = first.id;
          state.mru = [first.id];
          sendView();
          sendFocus();
        }
      }
      followDone();
      followUndo();
      // Stage C: before the render, whose keepKeyboard gives the zone the keyboard when a control
      // of the banner that had it went away (a restore began: Restore is gone).
      banner.render(message.banner ?? null);
      render();
      if (editor.shown()) {
        editor.update(message); // the dialog's session's row (task 38's list)
      }
      // Stage B: the taskbar's count (S2 12.1), and the notifications of sessions that no
      // longer need you closed (B16). A list without `needYou` (stage A's) is none.
      document.title = windowTitle(message.needYou?.count ?? 0);
      notifications.update(message);
      // Stage E: the switcher's items, while it is shown (E8).
      switcher.update(message);
      if (state.welcomed) {
        state.welcomed = false;
        nextReattach();
      } else if (
        state.waitingSnap !== null &&
        (!message.terminals.some((term) => term.id === state.waitingSnap) ||
          !terminalView.attached().includes(state.waitingSnap))
      ) {
        nextReattach();
      }
      return;
    case 'snap':
      terminalView.snap(message);
      keepKeyboard();
      if (message.term === state.waitingSnap) {
        nextReattach();
      }
      return;
    case 'size':
      terminalView.size(message);
      keepKeyboard();
      return;
    case 'exit':
      state.exits.set(message.term, message);
      terminalView.exit(message);
      render();
      return;
    case 'result': {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message);
      return;
    }
    case 'notice':
      if (message.kind === 'keepalive-lost') {
        showKeepAlive(true, message.text);
      } else if (message.kind === 'keepalive-back') {
        showKeepAlive(false, null);
      } else if (message.kind === 'tick-failed') {
        // A7: shown until the next list.
        dom.tick.textContent = message.text;
        dom.tick.hidden = false;
      } else if (message.kind === 'restore-progress') {
        // Stage C (C10): one report line of a restore, whoever asked for it; it moves no keyboard
        // (C21), but a new report takes the last one's × away.
        banner.progress(message.text);
        keepKeyboard();
      } else if (message.term !== null) {
        terminalView.notice(message.term, message.kind, message.text);
        keepKeyboard();
      }
      return;
    case 'notify':
      // S2 13, B15: none for the session that is selected while this page has focus.
      notifications.show(message, { focused: document.hasFocus(), selected: state.selected });
      return;
    default:
      return;
  }
}

// --- rendering ----------------------------------------------------------------------------------

/**
 * Draws the list for the current state in `zone`. F9: a selected caption is kept while the list
 * can hold it (`list.holds`, ruled (a), (b)), its counts taken from what is drawn; when its block
 * was opened without a key or is gone, NOTHING is selected — never a session the user did not
 * choose — and the list is drawn again so.
 * @param {Zone} zone
 */
function renderList(zone) {
  list.render(state.list, state.selected, zone, state.caption);
  const caption = state.caption;
  if (caption === null) {
    return;
  }
  if (!list.holds(caption)) {
    state.caption = null;
    list.render(state.list, state.selected, zone, null);
    return;
  }
  const info = blockInfo(state.list, caption.section, caption.group);
  if (info !== null) {
    state.caption = { ...caption, ...info };
  }
}

/** Renders the list and the right side for the current state. */
function render() {
  renderList(state.zone);
  const caption = state.caption;
  /** @type {Pane} */
  const pane =
    caption !== null && !state.newOpen
      ? { kind: 'group', ...caption }
      : paneFor(
          state.selected,
          rows(),
          state.list?.terminals ?? [],
          state.newOpen,
          sessionRow(state.list, state.selected), // E13: also a session the list does not show
        );
  const exit = pane.kind === 'terminal' ? (state.exits.get(pane.term.id) ?? null) : null;
  // `list.selected` when it is the pane's session, for every pane (plan D 2.4, ruled on review B).
  const paneRow =
    pane.kind === 'new' || pane.kind === 'none' || pane.kind === 'group' ? null : pane.row;
  const selected =
    paneRow !== null && state.list?.selected?.sessionId === paneRow.id ? state.list.selected : null;
  const term = pane.kind === 'terminal' ? pane.term : null;
  const lines = pane.kind === 'resume' ? (state.lines.get(pane.row.id) ?? []) : [];
  const key = JSON.stringify(pane.kind === 'new' ? ['new'] : [pane, exit, selected, lines]);
  state.pane = pane;
  if (key === state.paneKey) {
    keepKeyboard(); // the list may have dropped what had the keyboard
    return;
  }
  state.paneKey = key;
  const before = dom.rightZone.dataset.paneTerm ?? '';
  dom.rightZone.dataset.pane = pane.kind;
  dom.rightZone.dataset.paneTerm = pane.kind === 'terminal' ? pane.term.id : '';
  terminalView.show(pane.kind === 'terminal' ? pane.term : null);
  cards.hide();
  switch (pane.kind) {
    case 'terminal':
      cards.header(pane.row, selected, term, listNow);
      if (pane.ended) {
        cards.endedBar(pane.row, exit);
      }
      break;
    case 'elsewhere':
      cards.header(pane.row, selected, null, listNow);
      cards.elsewhere(pane.row);
      break;
    case 'resume':
      cards.header(pane.row, selected, null, listNow);
      cards.resumeCard(pane.row, selected, lines);
      break;
    case 'new': {
      // The selected session's directory (S2 12.6): a hidden selection's too while a terminal of
      // the window shows it (E13; review 2, ruled), since its header was what the user saw.
      const selectedOne = sessionRow(state.list, state.selected);
      const row =
        selectedOne !== null &&
        (selectedOne.terminal !== null || rowOf(selectedOne.id) !== undefined)
          ? selectedOne
          : undefined;
      const dirs = state.list?.dirs ?? [];
      cards.header(null, null, null, listNow);
      cards.newForm({ dir: row?.dir ?? dirs[0] ?? '', dirs });
      break;
    }
    case 'group':
      // F9: a closed caption is selected: the group's card, no header, no terminal.
      cards.header(null, null, null, listNow);
      cards.groupCard(pane);
      break;
    case 'none':
      cards.header(null, null, null, listNow);
      break;
  }
  // S2 11.3: a terminal that comes to be shown in the terminal zone gets the keyboard (after a
  // resume its list comes after the result), unless a text field of the page has it.
  // A terminal the user's own action brought (a resume or new of this page) takes it whatever is
  // selected, as a zone chord does (S2 11.3 comes first); one that only a list brought does not
  // take it while text of the page is selected (ruled, review 2 of task 26). While a dialog is
  // shown nothing takes the keyboard (D2): the terminal of a resume takes it when the dialog
  // closes (`dialogClosed`), so `bringing` is kept until then.
  const ownAction =
    pane.kind === 'terminal' &&
    state.bringing !== null &&
    (pane.row?.id === state.bringing || pane.term.sessionId === state.bringing);
  if (
    !modal() &&
    pane.kind === 'terminal' &&
    pane.term.id !== before &&
    state.zone === 'terminal' &&
    !isTextField(document.activeElement) &&
    (ownAction || !textSelected())
  ) {
    terminalView.focus();
  }
  if (ownAction && !modal()) {
    state.bringing = null;
  }
  // What had the keyboard was replaced or hidden (a card): the zone takes it back.
  keepKeyboard();
  headerHeight(); // remembered for a pane that shows no header
  focusChanged();
}

/**
 * The right side's header's height (`#cards .card-header`, a hook of contract 2.9): as it is now
 * while one is shown, else as last shown; 0 before any was shown (Z1, item 5).
 * @returns {number}
 */
function headerHeight() {
  const header = dom.cards.querySelector('.card-header');
  if (header instanceof HTMLElement && header.checkVisibility()) {
    state.headerHeight = header.getBoundingClientRect().height;
  }
  return state.headerHeight;
}

// --- zones --------------------------------------------------------------------------------------

/**
 * The focus zone (S2 12.9): the coloured top edge, the key bar's `Focus: …`, and the keyboard.
 * @param {Zone} zone
 * @param {boolean} [moveFocus] false when the focus moved there already
 */
function setZone(zone, moveFocus = true) {
  if (modal()) {
    return; // D2: a dialog keeps the keyboard; `dialogClosed` gives it to the zone
  }
  state.zone = zone;
  dom.listZone.classList.toggle('focused', zone === 'list');
  dom.rightZone.classList.toggle('focused', zone === 'terminal');
  dom.focusZone.textContent = zone === 'list' ? 'Focus: list' : 'Focus: terminal';
  renderList(zone);
  if (!moveFocus) {
    return;
  }
  if (zone === 'list') {
    if (!dom.listZone.contains(document.activeElement)) {
      dom.list.focus();
    }
    return;
  }
  if (dom.rightZone.contains(document.activeElement) && document.activeElement !== dom.rightZone) {
    return;
  }
  giveKeyboard();
}

/**
 * Whether text of the page is selected (a range, not a caret). While it is, app.js moves the
 * keyboard nowhere by itself (ruled, review 2 of task 26); a zone chord still does.
 * @returns {boolean}
 */
function textSelected() {
  const selection = getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  // Only text the user can see counts: a selection left in a card that is hidden now holds
  // nothing back (ruled, review 2 of task 26).
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element !== null && element.checkVisibility();
}

/**
 * When what had the keyboard is gone — removed, or no longer visible because its container was
 * hidden (ruled, review 2 round three) — the zone takes it: run after every call into a module
 * that can remove or hide things, so that the modules of tasks 27–29 need no hook of their own.
 */
function keepKeyboard() {
  // Never while text of the page is selected: giving a text control (xterm.js's) the keyboard
  // would take the selection away, and a Ctrl+C meant to copy it would reach the program. Never
  // while a dialog is shown (D2).
  if (modal() || textSelected()) {
    return;
  }
  const element = document.activeElement;
  if (
    element === null ||
    element === document.body ||
    (element instanceof HTMLElement && !element.checkVisibility())
  ) {
    giveKeyboard();
  }
}

/**
 * Gives the keyboard to the zone the key bar names (S2 12.9), also when what had it went away (a
 * dismissed notice, a closed form, a card replaced): the list; in the terminal zone the shown
 * terminal, else a card's first text field, else the zone itself. Never a card's button: an Enter
 * would press it (S2 12.6: nothing resumes but on purpose).
 */
function giveKeyboard() {
  if (modal()) {
    return; // D2
  }
  if (state.zone === 'list') {
    dom.list.focus();
    return;
  }
  if (state.pane.kind === 'terminal') {
    terminalView.focus();
    if (dom.rightZone.contains(document.activeElement)) {
      return;
    }
  }
  const field = [...dom.cards.querySelectorAll('input, textarea, select')].find(
    (element) => isTextField(element) && element.closest('[hidden]') === null,
  );
  (field instanceof HTMLElement ? field : dom.rightZone).focus();
}

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (dom.listZone.contains(target) && state.zone !== 'list') {
    setZone('list', false);
  } else if (dom.rightZone.contains(target) && state.zone !== 'terminal') {
    setZone('terminal', false);
  }
});

// --- keys (S2 12.9) -----------------------------------------------------------------------------

/**
 * @param {Element | null} element
 * @returns {boolean}
 */
function isTextField(element) {
  if (element === null || element.closest('.xterm') !== null) {
    return false;
  }
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
      element.type,
    );
  }
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/**
 * Whether the keyboard is on the list itself (S2 12.9's list keys): inside the list zone, and not
 * on a control of it — a button, a link, a field, a summary, editable text — which takes its own
 * keys (Enter presses a button).
 * @returns {boolean}
 */
function listHasKeyboard() {
  const element = document.activeElement;
  if (element === null || element === document.body) {
    return true; // nothing has it: the zone does
  }
  if (!(element instanceof HTMLElement) || !dom.listZone.contains(element)) {
    return false;
  }
  return !(
    element.isContentEditable ||
    element.matches('button, a[href], input, select, textarea, summary')
  );
}

/** Whether xterm.js has the keyboard (its helper textarea, inside `.xterm`; task 28). */
function xtermHasKeyboard() {
  return document.activeElement?.closest('.xterm') != null;
}

/**
 * THE GATE EVERY WINDOW CHORD PASSES before it acts (S2 12.9, plan D2), whether its keydown came
 * to the page's listener or through the terminal view's `chord`; the list zone's reload keys pass
 * it too, as `reload`. Later stages send their own chord-like actions through it (stage B's click
 * on a notification, stage E's `Switch…`). With no dialog and no switcher shown everything passes.
 * While the switcher is shown (E11): Ctrl+Shift+P (`switcher`, which closes it) and the reload keys
 * pass (nothing typed there is worth keeping); everything else, Ctrl+Shift+H too, says `close the
 * switcher first (Esc)` and does nothing else. While a dialog is shown: Ctrl+Shift+H (`help`)
 * passes; a reload passes unless the dialog holds text the user typed and did not save, when the
 * key bar says `save or cancel the edit first`; everything else says `close the edit first (Esc)`
 * and does nothing else.
 * @param {WindowChord['kind'] | string} kind
 * @returns {boolean} whether it may act
 */
function windowChordGate(kind) {
  if (switcher.shown()) {
    if (kind === 'switcher' || kind === 'reload') {
      return true;
    }
    say('close the switcher first (Esc)');
    return false;
  }
  if (!modal() || kind === 'help') {
    return true;
  }
  if (kind === 'reload') {
    if (!editor.changed()) {
      return true;
    }
    say('save or cancel the edit first');
    return false;
  }
  say('close the edit first (Esc)');
  return false;
}

/**
 * A window chord (keys.js): its action, once it passed `windowChordGate`.
 * @param {WindowChord} chord
 * @param {KeyboardEvent} event
 */
function doChord(chord, event) {
  if (!windowChordGate(chord.kind)) {
    return;
  }
  switch (chord.kind) {
    case 'slot': {
      const row = rows().find((candidate) => candidate.slot === chord.slot);
      const id =
        row?.id ??
        state.list?.terminals.find((term) => term.slot === chord.slot)?.sessionId ??
        null;
      if (id === null) {
        say(`no session in slot ${chord.slot}`);
        return;
      }
      select(id, 'chord');
      return;
    }
    case 'previous': {
      const known = (/** @type {string} */ id) => rowOf(id) !== undefined || hasTerminal(id);
      const previous = state.mru.find((id) => id !== state.selected && known(id));
      if (previous === undefined) {
        say('no previous session');
        return;
      }
      select(previous, 'chord');
      return;
    }
    case 'toggle-zone':
      setZone(state.zone === 'list' ? 'terminal' : 'list');
      return;
    case 'new':
      openNew();
      return;
    case 'find':
      terminalView.find();
      return;
    case 'copy':
      terminalView.copy();
      return;
    case 'paste-raw':
      // A key of S2 9.1 that sends bytes acts only while the terminal itself has the keyboard:
      // never from the list, the form, the help or a text field — one of the view's own too, whose
      // key events reach this through `chord` (Z1, item 7).
      if (
        state.zone === 'terminal' &&
        terminalHasKeyboard() &&
        !isTextField(document.activeElement)
      ) {
        terminalView.pasteRaw();
      }
      return;
    case 'help':
      help.toggle();
      return;
    case 'reload':
      void connection?.reload();
      return;
    case 'next-attention': {
      // B14: the next of `needYou.order` as the server sent it; the key bar says when none is.
      const needYou = state.list?.needYou;
      const next = nextNeeding(needYou?.order ?? [], state.selected, needYou?.count ?? 0);
      if (next.id !== null) {
        select(next.id, 'chord');
      }
      if (next.say !== null) {
        say(next.say);
      }
      return;
    }
    case 'switcher':
      // E11: Ctrl+Shift+P opens the switcher, and closes it while it is shown.
      if (switcher.shown()) {
        switcher.close();
      } else {
        openSwitcher();
        state.openedBy = event.code; // its auto-repeats type nothing into the field
      }
      return;
  }
}

/**
 * A list key (keys.js) in the list zone: its action; whether the page acted on it.
 * @param {ListAction} action
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function doListKey(action, event) {
  switch (action.kind) {
    case 'reload':
      if (windowChordGate('reload')) {
        void connection?.reload();
      }
      return true;
    case 'edit': {
      // Stage D (plan D 2.4): on the selected row.
      const row = selectedRow();
      if (row === undefined) {
        say('no session selected');
      } else {
        edit(action.what, row.id, event.key, event.code);
      }
      return true;
    }
    case 'done': {
      // D15: at the first keydown only; its auto-repeats are cancelled and do nothing.
      if (event.repeat) {
        return true;
      }
      const row = selectedRow();
      if (row === undefined) {
        say('no session selected');
      } else {
        markDone(row.id, true);
      }
      return true;
    }
    case 'escape':
      // S2 12.9: Esc clears the filter — the list's, which also clears its field —, then goes
      // back to the terminal; a held Esc does only the first step (Z1, item 6).
      if (event.repeat) {
        return true;
      }
      if (state.view.filter !== '') {
        list.key(action);
        if (state.view.filter !== '') {
          changeView({ filter: '' });
        }
      } else {
        setZone('terminal');
      }
      return true;
    default:
      list.key(action, event.repeat); // F9: a held ← on a caption acts once
      return true;
  }
}

/**
 * The terminal view asks whether a key is the window's (contract 2.9 `chord`): true for a window
 * chord, acted on here unless the page's own listener acted on it already.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function chordOf(event) {
  const chord = windowChord(event, state.zone);
  if (chord === null) {
    return false;
  }
  // xterm.js asks for keydown, keypress and keyup alike: the chord is acted on at its keydown
  // only, and true tells the view to drop the others too (review 2 of task 26). (An auto-repeat
  // never gets here to act: onKeyDown stops every chord keydown but Ctrl+Shift+V's in a text
  // field, which doChord refuses.)
  if (event.type === 'keydown' && !actedOn.has(event)) {
    actedOn.add(event);
    doChord(chord, event);
  }
  return true;
}

/**
 * Every key reaches this first (the capture phase of the window). It cancels a key exactly when
 * keys.cancels says so (S2 12.9), and stops a window chord there, so that nothing else — xterm.js
 * included — acts on it a second time.
 * @param {KeyboardEvent} event
 */
function onKeyDown(event) {
  if (heldIntoTerminal(event)) {
    return; // swallowed: a held key that went into the terminal (Z1, item 6)
  }
  if (heldFromDialog(event)) {
    return; // swallowed: a held key that closed a dialog (review 2 of task 37)
  }
  if (switcher.shown() && switcherCapture(event)) {
    return;
  }
  if (editor.shown() && dialogKey(event)) {
    return;
  }
  const zone = state.zone;
  let handled = false;
  const chord = windowChord(event, zone);
  if (chord !== null && chord.kind === 'paste-raw' && isTextField(document.activeElement)) {
    return; // in a text field the browser's own Ctrl+Shift+V stands (Z1, item 7)
  }
  if (chord !== null) {
    if (!event.repeat && !actedOn.has(event)) {
      // a held chord acts once: its auto-repeats are only cancelled (Z1)
      actedOn.add(event);
      doChord(chord, event);
      keepKeyboard();
    }
    handled = true;
  } else if (zone === 'list' || !xtermHasKeyboard()) {
    const action = listKey(event);
    if (action !== null && action.kind === 'reload') {
      // The page's reload, in the list zone and while the page (not xterm.js) has the keyboard.
      handled = doListKey(action, event);
    } else if (action !== null && zone === 'list' && listHasKeyboard() && !modal()) {
      // (D2: while a dialog is shown no list key acts; its keys are the dialog's.)
      handled = doListKey(action, event);
    } else if (
      zone === 'terminal' &&
      state.pane.kind === 'new' &&
      event.key === 'Escape' &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      // Esc closes the new form (the page has the keyboard: xterm.js has not).
      closeNew();
      handled = true;
    }
  }
  // While a dialog is shown the terminal sends nothing: its keys (Shift+Enter) are the field's.
  if (cancels(event, modal() ? 'list' : zone, handled)) {
    event.preventDefault();
  }
  if (chord !== null) {
    event.stopPropagation();
  }
}

/**
 * D2: the keys a shown dialog takes before anything else, in the capture phase — Esc, handed to
 * the dialog (`escape()`, once per press: a held Esc is one), and the auto-repeats of the key that
 * opened it, which type nothing into its field. True when it took the key; every other key goes
 * on to onKeyDown's dispatch, where the chords meet `windowChordGate` and no list key acts.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function dialogKey(event) {
  if (event.repeat && state.openedBy !== '' && event.code === state.openedBy) {
    event.preventDefault();
    return true;
  }
  if (event.isComposing || event.keyCode === 229) {
    return false; // a key of an IME composition (its Esc cancels it) is the IME's, never the dialog's
  }
  if (
    event.key === 'Escape' &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      editor.escape();
    }
    return true;
  }
  return false;
}

/**
 * E11: the keys the shown switcher takes before anything else, in the capture phase — Esc, handed
 * to the switcher (`escape()`, once per press: a held Esc is one), and the auto-repeats of the key
 * that opened it, which type nothing into its field. True when it took the key; every other key
 * goes on to onKeyDown's dispatch, where the chords meet `windowChordGate`, no list key acts and
 * the field's own keys (↑ ↓ PgUp PgDn Enter Tab) reach the field. Esc while the New form is open
 * closes the switcher only: the form's Esc branch comes after this.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function switcherCapture(event) {
  if (event.repeat && state.openedBy !== '' && event.code === state.openedBy) {
    event.preventDefault();
    return true;
  }
  if (event.isComposing || event.keyCode === 229) {
    return false; // a key of an IME composition (its Esc cancels it) is the IME's
  }
  if (switcherKey(event)?.kind === 'close') {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      switcher.escape();
    }
    return true;
  }
  return false;
}

/**
 * Keys whose keydown came while a dialog was shown, by `code`, until they are released. A key
 * that closes a dialog — Enter in its field, on Cancel or on Save, Ctrl+Enter in the note — must
 * not act where the keyboard then goes (S2 12.9: a key pressed elsewhere acts there only when it
 * is pressed again): over a terminal `heldIntoTerminal` swallows its events, and over the list its
 * auto-repeats would be list keys (an Enter that resumes). Once the dialog is gone they act on
 * nothing; the next press acts (review 2 of task 37). Forgotten at the key's release, at a fresh
 * press, and when the window loses focus. Stage B: the same for a key pressed on the title bar's
 * `Turn on notifications`, which hides itself once the permission is answered — at once where a
 * policy answers without asking —, so that a held Enter there is no list `enter` either. Stage C:
 * the same for Enter pressed on a control of the restore banner, which can go away
 * under it — Restore once a restore runs, Not now once the offer is dismissed, the report's × —;
 * a held Tab there walks on (review 2 of task 75, C4). Stage
 * E: the same for a key pressed while the switcher is shown (`modal()`): the Enter of a pick or the
 * Esc that closes it acts on nothing where the keyboard then goes (E11).
 * @type {Set<string>}
 */
const pressedInDialog = new Set();

/**
 * Keeps `pressedInDialog` and swallows an auto-repeat of a key held since a dialog was shown (or
 * on `Turn on notifications`, or on a control of the banner), once the dialog (or the item, or
 * the control) no longer has it. True when it swallowed the event.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function heldFromDialog(event) {
  if (MODIFIER_KEYS.has(event.key)) {
    return false;
  }
  if (
    modal() ||
    document.activeElement === dom.notifyOn ||
    (dom.banner.contains(document.activeElement) && event.key === 'Enter')
  ) {
    if (!event.repeat) {
      pressedInDialog.add(event.code);
    }
    return false;
  }
  if (!pressedInDialog.has(event.code)) {
    return false;
  }
  if (event.repeat) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  pressedInDialog.delete(event.code); // a fresh press acts
  return false;
}

addEventListener('keydown', onKeyDown, true);
addEventListener('keypress', (event) => void heldIntoTerminal(event), true);
addEventListener(
  'keyup',
  (event) => {
    if (event.code === state.openedBy) {
      state.openedBy = '';
    }
    pressedInDialog.delete(event.code);
    heldIntoTerminal(event);
  },
  true,
);
addEventListener('blur', () => pressedInDialog.clear());

/**
 * Keys pressed while the keyboard was not on the program's holder, by `code`, until they are
 * released. A key the page or the view acted on can move the keyboard there — Enter on a running
 * row or one that resumes, Esc back to the terminal, the form's Enter, a card's button pressed by
 * key, the find bar's Esc or Enter —, and held, its auto-repeats, its keypress and its keyup would
 * then reach the program (an Esc that interrupts Claude Code, an Enter that submits its prompt):
 * once the holder has the keyboard they are swallowed until the key is released; the next press
 * passes (ruled, Z1 item 6). Whatever moved the keyboard: a key pressed outside the holder reaches
 * the program only when it is pressed again (ruled, Z1 C3). Modifiers are left alone.
 * @type {Set<string>}
 */
const pressedOutside = new Set();
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph']);

/** Whether the keyboard is on the terminal view (inside its root `#terminal`). */
function terminalHasKeyboard() {
  return dom.terminal.contains(document.activeElement);
}

/**
 * Whether the keyboard is on the program's own holder: the element inside `.xterm`, xterm.js's
 * textarea — nothing else of the view, neither a field nor a button of its own, such as its find
 * bar's (Z1, item 6).
 */
function programHasKeyboard() {
  return xtermHasKeyboard();
}

/**
 * Keeps `pressedOutside` and swallows (preventDefault, stopPropagation) an event of a held key
 * that went into the terminal. True when it swallowed the event.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function heldIntoTerminal(event) {
  if (MODIFIER_KEYS.has(event.key)) {
    return false;
  }
  const held = pressedOutside.has(event.code);
  const swallow = held && (event.type !== 'keydown' || event.repeat) && programHasKeyboard();
  if (event.type === 'keyup') {
    pressedOutside.delete(event.code);
  } else if (event.type === 'keydown' && !event.repeat) {
    if (programHasKeyboard()) {
      pressedOutside.delete(event.code);
    } else {
      pressedOutside.add(event.code);
    }
  }
  if (swallow) {
    event.preventDefault();
    event.stopPropagation();
  }
  return swallow;
}

function openNew() {
  state.newOpen = true;
  render();
  setZone('terminal');
}

/** The new form closed: the right side shows the selection again, the zone keeps the keyboard. */
function closeNew() {
  state.newOpen = false;
  render();
  giveKeyboard();
}
byId('new-button').addEventListener('click', openNew);

// --- the window ---------------------------------------------------------------------------------

// C2 (ruled): while a dialog holds text the user typed and did not save, leaving the page — the
// tab's reload, closing the window, connection.js's reload for another build, and a reload key's
// reload when text was typed after the key passed windowChordGate (the dialog was unchanged then)
// — asks first (the browser's own prompt).
addEventListener('beforeunload', (event) => {
  if (editor.changed()) {
    event.preventDefault();
  }
});
// A dropped file must not navigate the window (S2 17.4).
for (const type of ['dragover', 'drop']) {
  addEventListener(type, (event) => event.preventDefault());
}
addEventListener('focus', () => focusChanged());
addEventListener('blur', () => focusChanged());
document.addEventListener('visibilitychange', () => {
  terminalView.setHidden(document.hidden);
  keepKeyboard();
});
/** @type {ReturnType<typeof setTimeout> | null} */
let resizeTimer = null;
new ResizeObserver(() => {
  if (resizeTimer !== null) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    focusChanged();
  }, 200);
}).observe(dom.rightZone);

// --- start --------------------------------------------------------------------------------------

/** @param {string} text */
function fatal(text) {
  setConnectionState('fatal');
  showProblem(text);
}

async function start() {
  setConnectionState('connecting');
  setZone('terminal');
  const key = await loadKey();
  if (token === null && key === null) {
    fatal(NO_KEY);
    return;
  }
  const tokenBytes = token === null ? null : decodeKey(token);
  if (token !== null && tokenBytes === null) {
    fatal(TEXTS.notValid);
    return;
  }
  token = null; // S2 8.2.2: only the connection holds it, until it is used
  connection = createConnection({
    assetVersion,
    windowId,
    key,
    token: tokenBytes,
    start: () => ({ focused: document.hasFocus(), theme: theme() }),
    events: {
      state: (value) => setConnectionState(value),
      welcome: (welcome, change, since) => welcomed(welcome, change, since),
      message: (message) => received(message),
      output: (channel, bytes) => terminalView.output(channel, bytes),
      lost: (since) => {
        dropPending();
        state.bringing = null; // the resume's terminal is no longer the page's own news (Z1)
        showGone(since);
        switcher.update(null); // E11: it says so; Enter does nothing, a kept Enter is dropped
      },
      fatal: (text) => {
        dropPending();
        dom.gone.hidden = true;
        showProblem(text);
        switcher.update(null);
      },
      warn: (text) => showProblem(text),
    },
  });
}

void start();
