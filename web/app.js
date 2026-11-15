// The page shell (S2 12.1, 12.9; plan 2.9): the key and the connection, the page's state — the
// last `list`, the selection, the focus zone, the most-recently-used order of sessions for
// Ctrl+Tab, the terminals' exits —, the key dispatch over the key table (web/keys.js), and what
// the title bar, the bars and the key bar say. The list, the terminal view, the cards and the key
// help are reached only through contract 2.9's functions; pane.js chooses the right side.
//
// Order at load (S2 8.2.2): the launch token leaves the address first, before anything can open a
// connection; then the stored key is read; then the connection opens.

/** @import { ExitMessage, ListMessage, ResultMessage, RowPayload, ServerMessage, TerminalPayload, WelcomeMessage } from '../src/window/protocol.ts' */
/** @import { ListAction, WindowChord, Zone } from './keys.js' */
/** @import { Change } from './connection.js' */
/** @import { Pane } from './pane.js' */
import { decodeKey, loadKey, takeToken } from './auth.js';
import { createCards } from './cards.js';
import { createConnection, TEXTS } from './connection.js';
import { createHelp } from './help.js';
import { cancels, listKey, windowChord } from './keys.js';
import { createList } from './list.js';
import { paneFor } from './pane.js';
import { createTerminalView } from './terminal-view.js';

// S2 8.2.2: before anything else.
let token = takeToken();

const NO_KEY =
  'this window has no key; run skydeck window (or skydeck window --print-url for a browser tab)';
const RESTARTED = "skydeck's server restarted; your sessions kept running";
/** How long a line of the key bar stays. */
const KEY_MESSAGE_MS = 5000;
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
  list: byId('list'),
  rightZone: byId('right-zone'),
  cards: byId('cards'),
  terminal: byId('terminal'),
  focusZone: byId('focus-zone'),
  keyMessage: byId('key-message'),
  help: byId('help'),
  measure: byId('cell-measure'),
};

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
  /** @type {string | null} */
  selected: null,
  /** @type {Zone} */
  zone: 'terminal',
  /** Session ids, the most recently selected first (Ctrl+Tab, Ctrl+Shift+O). @type {string[]} */
  mru: [],
  view: { filter: '', unfolded: /** @type {string[]} */ ([]), showDone: false },
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
  select: (id, how) => select(id, how),
  activate: (id) => activate(id),
  view: (change) => changeView(change),
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
});
const help = createHelp(dom.help);

// --- what the page says -------------------------------------------------------------------------

/** @param {'connecting' | 'open' | 'lost' | 'fatal'} value */
function setConnectionState(value) {
  document.documentElement.dataset.connection = value;
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
    if (textSelected()) {
      return;
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
 * zone's client box (without its border) less what stands above the terminal: for `focus` (S2 8.2.3) while a terminal is
 * shown, what the cards show (the header, an ended bar); for an act's first size (`forAct`, S2
 * 8.2.6) and for another pane only the header, which the terminal it brings will have above it
 * (Z1, item 5).
 * @param {boolean} [forAct]
 * @returns {{ cols: number, rows: number }}
 */
function area(forAct = false) {
  // The zone's client box: its 2 px top border (style.css `.zone`) is not the terminal's.
  const box = { width: dom.rightZone.clientWidth, height: dom.rightZone.clientHeight };
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

/** S2 8.2.3's limits of a string a page sends, in bytes of UTF-8. */
const TEXT_BYTES = 1024;
const PATH_BYTES = 4096;
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
 * A change of the page's view (S2 8.2.3 `view`). The filter is held to S2 8.2.3's limit, so that
 * the server never refuses the page's view (it would close the connection for it): a longer one
 * is cut to its first 1,024 bytes, and the key bar says so.
 * @param {{ filter?: string, unfolded?: string[], showDone?: boolean }} change
 */
function changeView(change) {
  let next = change;
  if (change.filter !== undefined) {
    const filter = cutTo(change.filter.toWellFormed(), TEXT_BYTES);
    if (filter.length < change.filter.length) {
      say('the filter is cut to its first 1,024 bytes');
    }
    next = { ...change, filter };
  }
  state.view = { ...state.view, ...next };
  sendView();
}

/** The fields of an action that S2 8.2.3's limits hold, with their names for a refusal. */
const LIMITED = /** @type {Record<string, [string, string, number][]>} */ ({
  new: [
    ['dir', 'the directory', PATH_BYTES],
    ['label', 'the label', TEXT_BYTES],
    ['group', 'the group', TEXT_BYTES],
    ['flags', 'the flags', TEXT_BYTES],
  ],
  'open-link': [['url', 'the link', PATH_BYTES]],
});

/**
 * Why S2 8.2.3 would refuse `action` (the server closes the connection for such a message), or
 * null when it would not.
 * @param {Record<string, unknown> & { kind: string }} action
 * @returns {string | null}
 */
function overLimit(action) {
  for (const [field, name, bytes] of LIMITED[action.kind] ?? []) {
    const value = action[field];
    if (typeof value !== 'string') {
      continue;
    }
    if (!value.isWellFormed()) {
      return `${name} holds text that is not well formed; skydeck cannot take it`;
    }
    if (utf8.encode(value).length > bytes) {
      return `${name} is longer than skydeck takes: at most ${bytes === TEXT_BYTES ? '1,024' : '4,096'} bytes of UTF-8`;
    }
  }
  return null;
}

/**
 * Selects a session (S2 12.9): a click on a running row focuses its terminal, a click on another
 * row the list; moving with the list's keys keeps the list.
 * @param {string} id
 * @param {'click' | 'key' | 'chord'} how
 */
function select(id, how) {
  state.newOpen = false;
  if (state.bringing !== id) {
    state.bringing = null; // the user chose another session: the resume's mark ends (Z1)
  }
  if (state.selected !== id) {
    state.selected = id;
    state.mru = [id, ...state.mru.filter((other) => other !== id)];
    sendView();
    sendFocus();
  }
  render();
  if (how !== 'key') {
    setZone(hasTerminal(id) ? 'terminal' : 'list');
  }
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
  return new Promise((resolve) => {
    pending.set(id, (result) => {
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
      dom.tick.hidden = true;
      if (state.selected === null) {
        // Nothing selected yet: the first row (Open's first slot when there is one).
        const first = rows()[0];
        if (first !== undefined) {
          state.selected = first.id;
          state.mru = [first.id];
          sendView();
          sendFocus();
        }
      }
      render();
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
      } else if (message.kind !== 'restore-progress' && message.term !== null) {
        terminalView.notice(message.term, message.kind, message.text);
        keepKeyboard();
      }
      return;
    default:
      return;
  }
}

// --- rendering ----------------------------------------------------------------------------------

/** Renders the list and the right side for the current state. */
function render() {
  list.render(state.list, state.selected, state.zone);
  const pane = paneFor(state.selected, rows(), state.list?.terminals ?? [], state.newOpen);
  const exit = pane.kind === 'terminal' ? (state.exits.get(pane.term.id) ?? null) : null;
  const selected =
    pane.kind === 'resume' && state.list?.selected?.sessionId === pane.row.id
      ? state.list.selected
      : null;
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
      cards.header(pane.row);
      if (pane.ended) {
        cards.endedBar(pane.row, exit);
      }
      break;
    case 'elsewhere':
      cards.header(pane.row);
      cards.elsewhere(pane.row);
      break;
    case 'resume':
      cards.header(pane.row);
      cards.resumeCard(pane.row, selected, lines);
      break;
    case 'new': {
      const row = state.selected === null ? undefined : rowOf(state.selected);
      const dirs = state.list?.dirs ?? [];
      cards.header(null);
      cards.newForm({ dir: row?.dir ?? dirs[0] ?? '', dirs });
      break;
    }
    case 'none':
      cards.header(null);
      break;
  }
  // S2 11.3: a terminal that comes to be shown in the terminal zone gets the keyboard (after a
  // resume its list comes after the result), unless a text field of the page has it.
  // A terminal the user's own action brought (a resume or new of this page) takes it whatever is
  // selected, as a zone chord does (S2 11.3 comes first); one that only a list brought does not
  // take it while text of the page is selected (ruled, review 2 of task 26).
  const ownAction =
    pane.kind === 'terminal' &&
    state.bringing !== null &&
    (pane.row?.id === state.bringing || pane.term.sessionId === state.bringing);
  if (
    pane.kind === 'terminal' &&
    pane.term.id !== before &&
    state.zone === 'terminal' &&
    !isTextField(document.activeElement) &&
    (ownAction || !textSelected())
  ) {
    terminalView.focus();
  }
  if (ownAction) {
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
  state.zone = zone;
  dom.listZone.classList.toggle('focused', zone === 'list');
  dom.rightZone.classList.toggle('focused', zone === 'terminal');
  dom.focusZone.textContent = zone === 'list' ? 'Focus: list' : 'Focus: terminal';
  list.render(state.list, state.selected, zone);
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
  // would take the selection away, and a Ctrl+C meant to copy it would reach the program.
  if (textSelected()) {
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
 * The name of a key for "<key>: comes in a later stage" (A11).
 * @param {KeyboardEvent} event
 * @returns {string}
 */
function keyName(event) {
  if (event.ctrlKey && event.shiftKey) {
    return `Ctrl+Shift+${event.key.length === 1 ? event.key.toUpperCase() : event.key}`;
  }
  return event.key;
}

/**
 * A window chord (keys.js): its action.
 * @param {WindowChord} chord
 * @param {KeyboardEvent} event
 */
function doChord(chord, event) {
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
    case 'later':
      say(`${keyName(event)}: comes in a later stage`);
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
      void connection?.reload();
      return true;
    case 'later':
      say(`${keyName(event)}: comes in a later stage`);
      return true;
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
      list.key(action);
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
    } else if (action !== null && zone === 'list' && listHasKeyboard()) {
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
  if (cancels(event, zone, handled)) {
    event.preventDefault();
  }
  if (chord !== null) {
    event.stopPropagation();
  }
}
addEventListener('keydown', onKeyDown, true);
addEventListener('keypress', (event) => void heldIntoTerminal(event), true);
addEventListener('keyup', (event) => void heldIntoTerminal(event), true);

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
      },
      fatal: (text) => {
        dropPending();
        dom.gone.hidden = true;
        showProblem(text);
      },
      warn: (text) => showProblem(text),
    },
  });
}

void start();
