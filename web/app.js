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
// Follow-up F36 (S2 12.13): the settings screen of web/settings.js, opened by the title bar's
// gear (F39) and by the switcher's command `> settings`, each through `windowChordGate`. It is modal
// as a dialog is (D2): `.app` is inert under its scrim, every window chord but Ctrl+Shift+H says
// `close the settings first (Esc)`, Esc closes it, and the keyboard goes back where it was.
//
// Follow-up F38 (S2 16.5, 12.1): the server's `update` says what its last look for a newer skydeck
// found; the title bar's `Update available` (before `Switch…` and the gear) shows exactly while a
// newer version is known (web/update-text.js), and its click, through `windowChordGate`, opens
// web/update.js's dialog, modal as "Mark done" is (`close the dialog first (Esc)`). The settings
// screen's group Updates follows every state. Milestone 2: the dialog's `Update now` sends `act update-apply`;
// while the server says `applying` and the page is connected, the dialog's running form is shown on
// every page, the page inert, every window chord answered `skydeck is being updated`. One function,
// liftUpdateLock(), lifts it when the connection is lost (S2 6.3's bar then names the update's log
// first and `skydeck window` second), when it ends fatal, and at every welcome. The result bar
// (`#update-result`) says how the last update from the window ended until its × (`act
// update-seen`) dismisses it on every page.
//
// Follow-up F41 (S2 12.14): the tour of the window of web/tour.js. It starts by itself once, at a
// list while the page is connected and no dialog is shown, when this browser has not seen it
// (`tour.fresh()`), and again from the key help's `Take the tour` and the switcher's `> tour`,
// each through `windowChordGate`. It is modal as a dialog is: `.app` is inert under it, every
// window chord but a reload says `close the tour first (Esc)`, a lost connection, a fatal bar or
// an update that runs (F38's running form) ends it unmarked, and when it closes the keyboard goes
// back where it was.
//
// Issue #192 (S2 12.1, 12.9): the handle on the border between the list and the right side of
// web/list-width.js, which sets the list's width by a drag, keeps it in the page's localStorage,
// and gives the default back at a double click. It takes no keyboard and does nothing while the
// page is modal (`modal`).
//
// Issue #199 (S2 7.10, 12.6): a session's shell, in a second terminal view (`shellView`, in
// `#shell` under `#terminal`, inside the right zone). The server lists the shells (`list.shells`);
// which of them this page shows is the page's own (`state.shellsShown`, nothing of it stored).
// The panel is drawn while the pane is a terminal that is not ended, a shell of it is listed and
// this page shows it; the session terminals' exits and re-attach queue stay their own.
//
// Order at load (S2 8.2.2): the launch token leaves the address first, before anything can open a
// connection; then the stored key is read; then the connection opens.

/** @import { ClosedBlock, ExitMessage, ListMessage, ResultMessage, RowPayload, SearchChip, SectionPayload, ServerMessage, ShellPayload, SwitchItem, TerminalPayload, WelcomeMessage } from '../src/window/protocol.ts' */
/** @import { EditWhat, ListAction, WindowChord, Zone } from './keys.js' */
/** @import { Change } from './connection.js' */
/** @import { Pane } from './pane.js' */
import { nextNeeding, UNREAD_TEXTS, unreadAct, windowTitle } from './attention-text.js';
import { decodeKey, loadKey, takeToken } from './auth.js';
import { createBanner } from './banner.js';
import { createCarryOver } from './carry-over.js';
import { NOTHING_TO_CARRY } from './carry-over-text.js';
import { createCards } from './cards.js';
import { createConnection, TEXTS } from './connection.js';
import { createEditor } from './edit.js';
import { createEndDialog } from './end-dialog.js';
import { asksFirst, asksPark, cannotEndText, END_TEXTS, textsOf } from './end-text.js';
import { serverNow } from './format.js';
import { createHelp } from './help.js';
import { cancels, listKey, switcherKey, windowChord } from './keys.js';
import { createList } from './list.js';
import { holdsNoSession } from './list-text.js';
import { createListWidth } from './list-width.js';
import { newFormDefaults } from './new-form-text.js';
import { createNotifications } from './notify.js';
import { blockInfo, movedMru, movedWith, paneFor, sessionRow } from './pane.js';
import { createRestartDialog } from './restart-dialog.js';
import { ACTION_LOST, noRestartText, offersRestart } from './restart-text.js';
import { cutWords } from './search-text.js';
import { shellPress, shellRefusedText } from './shell-panel-text.js';
import { createSwitcher, pickResumes } from './switcher.js';
import { createTerminalView } from './terminal-view.js';
import { createTour } from './tour.js';
import { TOUR_TEXTS } from './tour-text.js';
import { createSettingsDialog } from './settings.js';
import { createTheme } from './theme.js';
import { createToast } from './toast.js';
import { createUpdateDialog } from './update.js';
import { awayParts, resultText, showsNotice, UPDATE_TEXTS } from './update-text.js';

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
/** F44 (S2 12.15): the toast's words after a park, for a session that does not run and for one
 *  that runs or starts. */
const PARKED = 'Parked: listed under Parked. It comes back when you send it a prompt.';
const PARKED_RUNNING =
  'Parked: listed under Parked, and it keeps running. It comes back when you send it a prompt.';
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
  rightNone: byId('right-none'),
  cards: byId('cards'),
  terminal: byId('terminal'),
  shellBar: byId('shell-bar'),
  shell: byId('shell'),
  focusZone: byId('focus-zone'),
  keyMessage: byId('key-message'),
  help: byId('help'),
  editor: byId('editor'),
  endDialog: byId('end-dialog'),
  restartDialog: byId('restart-dialog'),
  settings: byId('settings'),
  settingsButton: byId('settings-button'),
  updateDialog: byId('update-dialog'),
  updateButton: byId('update-button'),
  updateResult: byId('update-result'),
  updateResultText: byId('update-result-text'),
  toast: byId('toast'),
  notifyOn: /** @type {HTMLButtonElement} */ (byId('notify-on')),
  switcher: byId('switcher'),
  switchButton: byId('switch-button'),
  measure: byId('cell-measure'),
  tour: byId('tour'),
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
  /**
   * S2 12.4: this page's `unread` or `read` that the server took, by session, while no list since
   * has come (the answer comes before the list that shows it): `u` again, and the header's
   * control, pick the opposite (`unreadAct`).
   * @type {Map<string, 'unread' | 'read'>}
   */
  unreadAnswered: new Map(),
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
  /**
   * Issue #199: the ids of the shells this page shows (its panel is drawn while its terminal is
   * the pane's); in memory only, empty at a load.
   * @type {Set<string>}
   */
  shellsShown: new Set(),
  /**
   * Issue #199: the terminal a `shell` act of this page was sent for, while no list has brought
   * its shell — `answered` once the act's result came (the first list after it clears it).
   * @type {{ term: string, answered: boolean } | null}
   */
  shellAsked: /** @type {{ term: string, answered: boolean } | null} */ (null),
  /**
   * Issue #199: the side of the terminal zone that had the keyboard last: the session's terminal
   * or its shell (the shell only while its panel is drawn).
   * @type {'session' | 'shell'}
   */
  shellSide: /** @type {'session' | 'shell'} */ ('session'),
  /** What the shell panel shows now (`renderShell`), to apply a change only. */
  shellKey: '',
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
  /** The sessions whose `done`, `undone`, `park` or `unpark` of this page waits for its answer
   *  (D15, F44). @type {Set<string>} */
  marking: new Set(),
  /**
   * This page's own `d` (or end) in the list (S2 12.9's exception, D15), or from follow-up F44 its
   * own `w` that parks (`mark` says which): the session, the section it was last listed in and
   * that section's order then, whether a list came since its act was sent, and whether the answer
   * came; `chosen` once the user chose that session again (Enter, a click, a chord: `select` with
   * another `how` than 'key'), which counts as having moved. While it names a session, a `w` and a
   * `d` on that session do nothing (F44's one guard; the end dialog is behind `d`'s).
   * @type {{ sessionId: string, section: SectionPayload['name'], order: string[], mark: 'done' | 'park', listed: boolean, answered: boolean, chosen?: boolean } | null}
   */
  leaving: null,
  /**
   * Where that `d` or `w` left the selection (`at`: the row it selected; for a `d` that selected
   * none the done session itself, for a `w` null), so that its Undo selects the session again
   * (ruled); `answered` once the Undo's answer came; `away` (F44) the section the session must have
   * left before it is selected again — `parked` after a `w`, whose row is still listed there until
   * the list that carries the Undo —, else null.
   * @type {{ sessionId: string, at: string | null, answered: boolean, away: SectionPayload['name'] | null } | null}
   */
  undoTo: null,
  /** The key (`code`) whose keydown opened the dialog or the switcher shown, until it is
   *  released: its auto-repeats type nothing into the field. */
  openedBy: '',
  /** Issue #188: the key (`code`) of the `f` that opened a resume card's Other flags…, until it is
   *  released: its auto-repeats type nothing into the field. */
  flagsBy: '',
  /** F30: what had the keyboard when the dialog "Mark done" opened: Cancel gives it back. */
  enderFrom: /** @type {Element | null} */ (null),
  /** Issue #166: what had the keyboard when the dialog "Restart" opened: it gets it back. */
  restarterFrom: /** @type {Element | null} */ (null),
  /** Issue #166: the line a restart that ended a terminal's program and did not resume the
   *  session puts on that terminal's ended bar, by terminal id. @type {Map<string, string>} */
  restartSaid: new Map(),
  /** F36: what had the keyboard when the settings screen opened: it gets it back. */
  settingsFrom: /** @type {Element | null} */ (null),
  /** F41: what had the keyboard when the tour opened: it gets it back. */
  tourFrom: /** @type {Element | null} */ (null),
  /** F41: whether the tour's start by itself was decided (it is, once per page). */
  tourTried: false,
  /** F38: what had the keyboard when the update dialog opened: it gets it back. */
  updateFrom: /** @type {Element | null} */ (null),
  /** F38, milestone 2: the update the last `update` said runs, while connected; null: none. */
  updateApplying: /** @type {{ to: string; sinceNs: string; name: string } | null} */ (null),
  /** F38: the update's log, as the last `update` named it (the bar while the server is away). */
  updateLog: '',
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
/**
 * The terminal views' dependencies: the session terminals' view and (issue #199) the shells'.
 * @type {Parameters<typeof createTerminalView>[1]}
 */
const viewDeps = {
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
  // Issue #184: `window.copyOnSelect` as the server's last list says it, read at each release of
  // the mouse. The default is the server's (S2 4.3): a list without the field copies nothing.
  copyOnSelect: () => state.list?.copyOnSelect === true,
};
const terminalView = createTerminalView(dom.terminal, viewDeps);
/**
 * Issue #199: the second view, of the sessions' shells, with the same dependencies; its optional
 * members (`reset`, `drop`, `heightFor`) are used only when present, as `fits` is.
 * @type {ReturnType<typeof createTerminalView> & { reset?: () => void, drop?: (id: string) => void, heightFor?: (rows: number) => number | null }}
 */
const shellView = createTerminalView(dom.shell, viewDeps);
/**
 * The view's optional `fits(width, height)` (contract 2.9, task 28): the columns and rows a
 * terminal of the view shows in a terminal area of that many CSS pixels, or null while it cannot
 * tell. A view without it leaves `area()` to the page's own arithmetic.
 * @type {typeof terminalView & { fits?: (width: number, height: number) => { cols: number, rows: number } | null }}
 */
const fitting = terminalView;
/**
 * F15: the open new form's listener of the favourites (cards.js's `watchFavourites`; null while
 * no form is open), and what a list says of them: its texts, [] for a list without the field.
 * @type {((favourites: string[]) => void) | null}
 */
let favouritesListener = null;
/** @param {ListMessage | null} list */
const favouritesOf = (list) =>
  Array.isArray(list?.favourites) ? list.favourites.filter((text) => typeof text === 'string') : [];
const cards = createCards(dom.cards, {
  act: (action) => act(action),
  select: (id) => select(id, 'click'),
  edit: (what, sessionId) => edit(what, sessionId, '', ''),
  done: (sessionId) => markDone(sessionId, false),
  restart: (sessionId) => askRestart(sessionId, false),
  park: (sessionId) => markParked(sessionId, false),
  unread: (sessionId) => markUnread(sessionId),
  unreadAnswered: (sessionId) => state.unreadAnswered.get(sessionId) ?? null,
  // Issue #199: the header's Shell is the header's own session's, which the pane shows.
  shell: () => pressShell(true, true),
  say: (text) => say(text),
  watchFavourites: (listener) => {
    favouritesListener = listener;
    listener?.(favouritesOf(state.list));
  },
});
// F41: the help's `Take the tour` passes the gate of a window chord, as the gear does.
const help = createHelp(dom.help, {
  tour: () => {
    if (windowChordGate('tour')) {
      openTour();
    }
  },
});
const toast = createToast(dom.toast);
const editor = createEditor(dom.editor, {
  act: (action) => act(action),
  toast: (text, undo) => toast.show(text, undo),
  closed: () => dialogClosed(),
  now: () => listNow(),
});
// F30: the dialog "Mark done" of a session the window can end (web/end-dialog.js), and from F44
// the dialog "Park" (S2 12.15), the same dialog with the mark `park`. Its presses name the
// session, the terminal and the mark it was opened for, never the selection of the moment.
const ender = createEndDialog(dom.endDialog, {
  chose: (choice, session) => {
    if (choice === 'end') {
      endSession(session.sessionId, session.term, session.fromList, session.mark);
    } else if (session.mark === 'park') {
      // `Park, keep it running`: exactly `w` on a running session before the dialog. The dialog
      // followed every list up to this press (`ender.update`, in the same task as the list), so
      // its session is listed and not parked: a list that showed otherwise had closed it.
      sendPark(session.sessionId, session.fromList, PARKED_RUNNING);
    } else {
      keepRunning(session.sessionId, session.fromList);
    }
  },
  gone: (text) => toast.show(text, null),
  closed: (choice) => enderClosed(choice),
  // The keys the page acts on while a dialog is shown, which the dialog "Park" leaves to it: its
  // window chords (refused with `close the dialog first (Esc)`, or the help's) and reload keys.
  pageKey: (event) => windowChord(event, state.zone) !== null || listKey(event)?.kind === 'reload',
});
/** Issue #166: the favourites' listener a form had when the dialog "Restart" took it. */
let favouritesBefore = /** @type {((favourites: string[]) => void) | null} */ (null);
// Issue #166: the dialog "Restart" of a session the window can end (web/restart-dialog.js). It
// sends its own `act restart`, for the session and the terminal it was opened for.
const restarter = createRestartDialog(dom.restartDialog, {
  act: (action) => act(action),
  watchFavourites: (listener) => {
    if (listener !== null) {
      favouritesBefore = favouritesListener;
      favouritesListener = listener;
      listener(favouritesOf(state.list));
    } else {
      favouritesListener = favouritesBefore; // a form behind the dialog gets its chips again
      favouritesBefore = null;
    }
  },
  finished: (outcome, session) => restartFinished(outcome, session.term),
  gone: (text) => toast.show(text, null),
  closed: (choice) => restarterClosed(choice),
});
// Follow-up F13: the window's theme (web/theme.js), chosen in the settings screen's Appearance
// (F39). Whenever the page's colours may have changed — a choice, another window's change, the
// system's scheme while the page follows it — the server is told them again (`theme`), so that it
// answers OSC 10 / 11 with the colours the terminals have (S2 7.2); while the connection is down,
// the next `start` carries them. The terminal view repaints its terminals by itself (it watches
// <html data-theme> and the colour themes' attributes).
const pageTheme = createTheme({
  changed: () => {
    send({ t: 'theme', theme: theme() });
  },
});
// F36: the settings screen (web/settings.js).
const settingsDialog = createSettingsDialog(dom.settings, {
  act: (action) => act(action),
  closed: () => settingsClosed(),
  say: (text) => say(text),
  theme: pageTheme,
  checkNow: () =>
    act({ kind: 'update-check' }).then((result) => {
      if (result.update !== undefined) updateState(result.update);
      return result;
    }),
  now: () => listNow(),
});
// F38: the dialog of the title bar's `Update available` (web/update.js).
const updateDialog = createUpdateDialog(dom.updateDialog, {
  act: (action) => act(action),
  answered: (update) => updateState(update),
  closed: () => updateClosed(),
});
// F41: the tour of the window (web/tour.js).
const tour = createTour(dom.tour, { closed: () => tourClosed() });
// Issue #192: the handle between the list and the right side (web/list-width.js). It takes no
// keyboard, and does nothing while the page is modal; the terminal follows the width by its own
// refit, and the server hears of it only as of a window resize (`resize`, `focus`).
createListWidth(byId('list-handle'), { list: dom.listZone, blocked: () => modal() });
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
// F40 (S2 12.6): the carry-over bar, between the right side's header and its card (the two
// children every cards module makes), so above the terminal or the card.
const carryHost = document.createElement('div');
carryHost.className = 'carry-over';
carryHost.hidden = true;
dom.cards.querySelector('.card-header')?.after(carryHost);
const carry = createCarryOver(carryHost, {
  act: (action) => act(action),
  say: (text) => say(text),
  back: () => setZone('list'),
});
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
  settings: () => {
    if (windowChordGate('settings')) {
      openSettings();
    }
  },
  // F41: `> tour`, through the same gate as the help's `Take the tour`.
  tour: () => {
    if (windowChordGate('tour')) {
      openTour();
    }
  },
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
// F36: the title bar's gear (F39), through the same gate; it takes no keyboard on a click either.
dom.settingsButton.addEventListener('click', () => {
  if (windowChordGate('settings')) {
    openSettings();
  }
});
// F38: the title bar's `Update available`, through the same gate.
dom.updateButton.addEventListener('click', () => {
  if (windowChordGate('update')) {
    openUpdate();
  }
});

/** Whether a dialog, the switcher or the tour is shown (D2, E11, F30, F36, F41: then the page is modal). */
function modal() {
  return (
    editor.shown() ||
    switcher.shown() ||
    ender.shown() ||
    restarter.shown() ||
    settingsDialog.shown() ||
    updateDialog.shown() ||
    tour.shown()
  );
}

// --- what the page says -------------------------------------------------------------------------

/** @param {'connecting' | 'open' | 'lost' | 'fatal'} value */
function setConnectionState(value) {
  document.documentElement.dataset.connection = value;
  state.connected = value === 'open';
  if (value === 'lost' || value === 'fatal') {
    tour.abort(); // F41: ended, not marked seen
  }
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
// F38: the result bar's × dismisses the result on every page (the server's `update` hides it).
byId('update-result-close').addEventListener('click', () => {
  void act({ kind: 'update-seen' }).then((result) => {
    if (result.update !== undefined) updateState(result.update);
    keepKeyboard();
  });
});
// The page's chrome takes no keyboard on a mouse click (ruled, review 2 round three): a click on
// the title bar, the key bar or the notice's × leaves the keyboard where it was — in the filter,
// say, so that what the user types next does not land on the list. Their buttons still work, and
// from the keyboard too.
for (const chrome of [
  document.querySelector('.titlebar'),
  document.querySelector('.keybar'),
  byId('info-close'),
  byId('update-result-close'),
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
      sideView().focus(); // issue #199: the side of the terminal zone that had it last
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
/** F37: this page's `reorder` waits for its answer; a press meanwhile does nothing (a held key
 *  moves the session at the round trip's pace). */
let reordering = false;
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
 * The terminal's colours as `#rrggbb` (S2 8.2.2 `start.theme`, and follow-up F13's `theme`), from
 * style.css's variables as the page's scheme has them now (the system's, or the one Settings'
 * Mode forces).
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

/**
 * `byPage` (S2 12.4): the selection is the page's own, not the user's — the first row it selects
 * by itself at its first list, or the selection it reports again once (re)connected. A fact for
 * the server's mark unread, which takes no such selection as a coming back.
 * @param {boolean} [byPage]
 */
function sendFocus(byPage = false) {
  const message = {
    t: 'focus',
    focused: document.hasFocus(),
    selected: state.selected,
    area: area(),
  };
  state.lastFocus = JSON.stringify(message);
  send(byPage ? { ...message, byPage: true } : message);
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
 *  that holds it (C1); F18's ticket too. */
const EDITS = new Set(['label', 'group', 'note', 'ticket', 'carry-over']);
/** F15's actions (S2 12.6): the list that holds one can come up to a second after its answer. */
const FAVOURITE_ACTS = new Set(['favourite-add', 'favourite-remove']);
/** F40's acts (S2 12.6): on `ok` a `view` asks for the list that holds the answer now. */
const CARRY_ACTS = new Set(['carry-over', 'dismiss-carry-over']);
/** Each dialog's list key, for D3's sentence. */
const KEY_OF = { label: 'l', group: 'g', note: 'n', ticket: 't', pr: 'p' };

/** The fields of an action that S2 8.2.3's limits hold, with their names for a refusal. */
const LIMITED = /** @type {Record<string, [string, string, number][]>} */ ({
  // Issue #188: "Other flags…", held as the new form's flags; #166: the restart's too.
  resume: [['flags', 'the flags', TEXT_BYTES]],
  restart: [['flags', 'the flags', TEXT_BYTES]],
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
  // F18: a link or a key, held to the URL limit.
  ticket: [['text', 'the ticket', PATH_BYTES]],
  // F15 (S2 12.6).
  'favourite-add': [['text', 'the flags', TEXT_BYTES]],
  'favourite-remove': [['text', 'the favourite', TEXT_BYTES]],
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
  if (how !== 'key' && state.leaving?.sessionId === id) {
    state.leaving.chosen = true; // F44: the user chose it again, so its list moves nothing
  }
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
      let asked = false;
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
        asked = true;
      }
      if (result.ok && !asked && (FAVOURITE_ACTS.has(action.kind) || CARRY_ACTS.has(action.kind))) {
        // F15: the server sends a page at most one list a second, so the list of a change can
        // come up to a second after its answer; a `view` asks for it now (as for EDITS above).
        sendView();
      }
      // The lines of a plain resume are its card's; "Other flags…" shows its own (#188), and
      // one that started leaves the card no older line.
      if (action.kind === 'resume' && typeof action['sessionId'] === 'string') {
        if (action['flags'] === undefined) {
          state.lines.set(
            action['sessionId'],
            result.ok ? [] : result.error === null ? result.lines : [result.error],
          );
        } else if (result.ok) {
          state.lines.set(action['sessionId'], []);
        }
      }
      // Issue #166: a restart brings its session back where it was and moves nothing: the
      // selection and the keyboard stay where the user has them (ruled).
      if (result.ok && result.sessionId !== null && action.kind !== 'restart') {
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
 * `selected` of that session, which holds the whole note (D3), and so does the ticket's (F18: its
 * address, and whether a key is taken); a label, group, note or ticket that this
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
  const needsSelected = what === 'note' || what === 'ticket';
  if ((needsSelected && selected === null) || (what !== 'pr' && state.unlisted.has(sessionId))) {
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
  appRoot.inert = modal(); // F38: the running form of an update may stand over it
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

// --- F38: the update notice ---------------------------------------------------------------------

/**
 * The check's state, from an `update` message or an act's answer: the title bar's control shows
 * exactly while a newer version is known; the dialog and the settings screen follow.
 * @param {import('../src/window/protocol.ts').UpdatePayload} update
 */
function updateState(update) {
  dom.updateButton.hidden = !showsNotice(update);
  state.updateLog = update.log;
  showUpdateResult(update.result);
  if (update.applying !== null && state.connected) {
    applyingShown(update.applying);
  } else if (state.updateApplying !== null) {
    liftUpdateLock(); // refused before the stop: the server runs on, the bar gives the line
  }
  updateDialog.update(update);
  settingsDialog.updateState(update);
}

/**
 * Milestone 2: the result bar while the server says how the last update from the window ended.
 * @param {{ ok: boolean; text: string } | null} result
 */
function showUpdateResult(result) {
  if (result === null) {
    dom.updateResult.hidden = true;
    return;
  }
  dom.updateResultText.textContent = resultText(result);
  dom.updateResult.hidden = false;
}

/**
 * Milestone 2: an update runs. Every other dialog is closed (Settings, "Mark done", the
 * switcher, the editor with what was typed in it; F41's tour, not marked seen), then the dialog's
 * running form stands over the inert page; the keyboard is given back where it was once it is
 * lifted.
 * @param {{ to: string; sinceNs: string; name: string }} applying
 */
function applyingShown(applying) {
  // Every other dialog goes first (a text half typed in the editor is dropped): nothing but the
  // running form takes a key or a click while an update runs.
  if (settingsDialog.shown()) settingsDialog.escape();
  if (ender.shown()) ender.cancel();
  if (restarter.shown()) restarter.cancel();
  if (switcher.shown()) switcher.close();
  if (editor.shown()) editor.close();
  if (tour.shown()) tour.abort(); // F41: something bigger took the page; seen it is not
  if (state.updateApplying === null && !updateDialog.shown()) {
    help.hide();
    state.updateFrom = document.activeElement;
  }
  state.updateApplying = applying;
  appRoot.inert = true;
  updateDialog.running(applying);
}

/**
 * Milestone 2: the running form and the lock lifted, and the page's `applying` forgotten — at a
 * lost connection, a fatal end and every welcome (the server's `update` after `start` says what
 * holds now). A page without a server is never left inert.
 */
function liftUpdateLock() {
  state.updateApplying = null;
  updateDialog.running(null);
}

/**
 * Milestone 2: S2 6.3's bar while the server is away for an update — the log first, then the
 * command.
 * @param {string} sinceNs
 */
function showUpdateAway(sinceNs) {
  const since = clockTime(new Date(Number(BigInt(sinceNs) / 1_000_000n)));
  dom.goneText.replaceChildren(
    ...awayParts(since, state.updateLog).map((part) => {
      if (part.code !== true) return part.text;
      const code = document.createElement('code');
      code.textContent = part.text;
      return code;
    }),
  );
  dom.gone.hidden = false;
}

/**
 * `Update available`, once past the gate: the help hidden, the page inert under the dialog, which
 * looks again; it remembers what had the keyboard.
 */
function openUpdate() {
  if (modal()) {
    return;
  }
  help.hide();
  state.updateFrom = document.activeElement;
  appRoot.inert = true;
  updateDialog.open();
}

/**
 * The update dialog closed: the page is no longer inert, and the keyboard goes back where it was
 * when that is still there, else to the zone's holder (as the settings screen's close).
 */
function updateClosed() {
  appRoot.inert = modal(); // milestone 2: the running form may have stood over another dialog
  const from = state.updateFrom;
  state.updateFrom = null;
  if (broughtTakesKeyboard()) {
    return;
  }
  if (
    from instanceof HTMLElement &&
    from !== document.body &&
    from.isConnected &&
    from.checkVisibility() &&
    !dom.updateDialog.contains(from)
  ) {
    from.focus();
    if (document.activeElement === from) {
      return;
    }
  }
  giveKeyboard();
}

// --- F36: the settings screen -------------------------------------------------------------------

/**
 * The gear or the switcher's `> settings`, once past the gate: the help hidden, the page inert
 * under the dialog, which asks the server for the screen; it remembers what had the keyboard.
 */
function openSettings() {
  if (modal()) {
    return;
  }
  help.hide();
  state.settingsFrom = document.activeElement;
  appRoot.inert = true;
  settingsDialog.open();
}

/**
 * The settings screen closed, whatever closed it: the page is no longer inert, and the keyboard
 * goes back where it was when that is still there — a text field, the list, the terminal —, else
 * to the zone's holder; a terminal this page's resume brought meanwhile takes it first.
 */
function settingsClosed() {
  appRoot.inert = modal(); // F38: the running form of an update may stand over it
  state.openedBy = '';
  const from = state.settingsFrom;
  state.settingsFrom = null;
  if (broughtTakesKeyboard()) {
    return;
  }
  if (
    from instanceof HTMLElement &&
    from !== document.body &&
    from.isConnected &&
    from.checkVisibility() &&
    !dom.settings.contains(from)
  ) {
    from.focus();
    if (document.activeElement === from) {
      return;
    }
  }
  giveKeyboard();
}

// --- F41: the tour of the window ----------------------------------------------------------------

/**
 * At each list until it is decided, once per page: the tour starts by itself while the page is
 * connected and no dialog is shown, when this browser has not seen it and can keep the mark.
 */
function startTour() {
  if (state.tourTried || !state.connected || modal()) {
    return;
  }
  state.tourTried = true;
  if (tour.fresh()) {
    openTour();
  }
}

/** The start by itself or the help's `Take the tour`: the help hidden, the page inert under it. */
function openTour() {
  if (modal()) {
    return;
  }
  help.hide();
  state.tourFrom = document.activeElement;
  appRoot.inert = true;
  tour.open(); // the keyboard on its `Next`
}

/**
 * The tour closed, whatever closed it: the page is no longer inert, and the keyboard goes back
 * where it was when that is still there — a text field, the list, the terminal —, else to the
 * zone's holder (also when only the zone itself had it); a terminal this page's resume brought
 * meanwhile takes it first.
 */
function tourClosed() {
  appRoot.inert = false;
  const from = state.tourFrom;
  state.tourFrom = null;
  if (broughtTakesKeyboard()) {
    return;
  }
  if (
    from instanceof HTMLElement &&
    from !== document.body &&
    from !== dom.rightZone &&
    from.isConnected &&
    from.checkVisibility() &&
    !dom.tour.contains(from)
  ) {
    from.focus();
    if (document.activeElement === from) {
      return;
    }
  }
  giveKeyboard();
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
  appRoot.inert = modal(); // F38: the running form of an update may stand over it
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
 * the header's Done also marks a session the list does not show (E13). F30: a session not marked
 * done that the window can end (`asksFirst`) is marked nothing yet: the dialog "Mark done" asks
 * first (`openEnder`); a running one it cannot end gets its own toast (`cannotEndText`: F34's
 * words for a session in Claude Code's background, else `END_TEXTS.cannotEnd`).
 * @param {string} sessionId
 * @param {boolean} fromList
 */
function markDone(sessionId, fromList) {
  const row = sessionRow(state.list, sessionId);
  if (row === null) {
    say('no session selected');
    return;
  }
  // F44's one guard: a `d` on the session this page's own `w`, `d` or end just marked, before its
  // list decided where the selection goes, does nothing.
  if (state.marking.has(sessionId) || state.leaving?.sessionId === sessionId) {
    return;
  }
  if (asksFirst(row)) {
    openEnder(row, fromList);
    return;
  }
  sendDone(sessionId, fromList, cannotEndText(row));
}

/**
 * The `done` or `undone` of `markDone` for the session's row as the list has it now; a `done` of a
 * running session shows `runningText` in the toast (F30: `Keep it running` passes D15's own words).
 * @param {string} sessionId
 * @param {boolean} fromList
 * @param {string} runningText
 */
function sendDone(sessionId, fromList, runningText) {
  const row = sessionRow(state.list, sessionId);
  if (row === null || state.marking.has(sessionId)) {
    return;
  }
  const kind = row.done ? 'undone' : 'done';
  // F44: the toast's Undo gives back what was there: a parked session marked done is parked again.
  const parked = row.parked === true;
  const place = placeOf(sessionId);
  if (fromList && kind === 'done' && place !== null) {
    state.leaving = { sessionId, ...place, mark: 'done', listed: false, answered: false };
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
    // rule of Open (`open` in src/window/view/build.ts; ruled 13:05Z). F44: so does a row under
    // Parked, which runs or not there; marked done, a running one goes under Open.
    const running =
      place !== null && place.section !== 'parked'
        ? place.section === 'open'
        : row.starting || row.state !== 'not-running';
    toast.show(running ? runningText : DONE_HIDDEN, () =>
      undoMark(sessionId, parked ? 'park' : 'undone'),
    );
    answeredDone(sessionId);
  });
}

/** A `done` (or an end) of this page's `d` was answered: S2 12.9's exception, as D15 has it. */
function answeredDone(/** @type {string} */ sessionId) {
  if (state.leaving?.sessionId === sessionId) {
    state.leaving.answered = true;
    if (state.leaving.listed) {
      leaveDone(); // a list since the act was sent holds the result (ruled 06:38Z, 08:15Z)
    } else {
      sendView(); // as M2: the list that holds it comes at once (review 2's S3, ruled)
    }
  }
}

/**
 * F44 (S2 12.15): `w` and the header's Park park the session, or un-park a parked one (the act
 * picked from its row's `parked`, as `d` picks `done` or `undone`). One act per session at a
 * time, and nothing while this page's own `w`, `d` or end of it has not been decided by its list
 * (the one guard). A session not parked that the window can end (`asksPark`) is parked nothing
 * yet: the dialog "Park" asks first (`openEnder` with the mark `park`); every other one is parked
 * at once (`sendPark`), a running one the window cannot end with its own toast (`cannotEndText`
 * with the mark `park`). `fromList`: this page's `w` in the list, after which the selection moves
 * to the next row of the section the row left (`leavePark`, at the list that shows it gone); the
 * header's control leaves the selection to the main rule. The row is `sessionRow`'s, as for Done.
 * @param {string} sessionId
 * @param {boolean} fromList
 */
function markParked(sessionId, fromList) {
  const row = sessionRow(state.list, sessionId);
  if (row === null) {
    say('no session selected');
    return;
  }
  if (state.marking.has(sessionId) || state.leaving?.sessionId === sessionId) {
    return;
  }
  if (asksPark(row)) {
    openEnder(row, fromList, 'park');
    return;
  }
  // A session still starting in a terminal of the window is no session the window cannot end:
  // it is not one yet, and runs on (the toast as before the dialog).
  sendPark(sessionId, fromList, row.starting ? PARKED_RUNNING : cannotEndText(row, 'park'));
}

/**
 * The `park` or `unpark` of `markParked` for the session's row as the list has it now: a park the
 * server took shows the toast with Undo (`undoMark`: `unpark`, or `done` for a session that was
 * done), for a running or starting session in `runningText` (the dialog's `Park, keep it running`
 * passes PARKED_RUNNING); an un-park shows none.
 * @param {string} sessionId
 * @param {boolean} fromList
 * @param {string} runningText
 */
function sendPark(sessionId, fromList, runningText) {
  const row = sessionRow(state.list, sessionId);
  if (row === null || state.marking.has(sessionId)) {
    return;
  }
  const parked = row.parked === true;
  const wasDone = row.done;
  const running = row.starting || row.state !== 'not-running';
  const place = placeOf(sessionId);
  if (fromList && !parked && place !== null) {
    state.leaving = { sessionId, ...place, mark: 'park', listed: false, answered: false };
    state.undoTo = null;
  }
  state.marking.add(sessionId);
  void act({ kind: parked ? 'unpark' : 'park', sessionId }).then((result) => {
    state.marking.delete(sessionId);
    if (!result.ok) {
      if (state.leaving?.sessionId === sessionId) {
        state.leaving = null; // refused before a list decided: a refused `w` moves nothing
      }
      say(result.error ?? 'skydeck could not do that');
      return;
    }
    if (parked) {
      return;
    }
    toast.show(running ? runningText : PARKED, () =>
      undoMark(sessionId, wasDone ? 'done' : 'unpark'),
    );
    answeredPark(sessionId);
  });
}

/**
 * S2 12.4: `u` and the header's `Unread` / `Read` mark the session unread, or read while its row
 * has a mark seeing clears (`unreadAct`); one act per session at a time, as `d` and `w`. The
 * server decides the rest and refuses an ask, a done session and one not started yet in the
 * toast's words; a mark it took says so in the toast (`u` again is its undo). The selection stays.
 * @param {string} sessionId
 */
function markUnread(sessionId) {
  const row = sessionRow(state.list, sessionId);
  if (row === null) {
    say('no session selected');
    return;
  }
  if (state.marking.has(sessionId)) {
    return;
  }
  const { kind } = unreadAct(row, state.unreadAnswered.get(sessionId) ?? null);
  state.marking.add(sessionId);
  void act({ kind, sessionId }).then((result) => {
    state.marking.delete(sessionId);
    if (result.ok) {
      state.unreadAnswered.set(sessionId, kind);
      render(); // the header's control says the opposite at once
    }
    toast.show(
      result.ok ? UNREAD_TEXTS[kind] : (result.error ?? 'skydeck could not do that'),
      null,
    );
  });
}

/** A `park` (or an end that parks) of this page's `w` was answered: F44's rule (`leavePark`). */
function answeredPark(/** @type {string} */ sessionId) {
  if (state.leaving?.sessionId === sessionId) {
    state.leaving.answered = true;
    sendView(); // no list showed the row gone from its section yet: the next one decides
  }
}

/**
 * F30: the dialog "Mark done" for `row`, over the page (modal, D2), or from F44 with the mark
 * `park` the dialog "Park": what had the keyboard is kept for Cancel.
 * @param {RowPayload} row
 * @param {boolean} fromList
 * @param {import('./end-text.js').DialogMark} [mark]
 */
function openEnder(row, fromList, mark = 'done') {
  if (modal()) {
    return;
  }
  // F44's one guard needs no check in the dialog's buttons (`keepRunning` → `sendDone`,
  // `sendPark`, `endSession`): the dialog opens only past `markDone`'s or
  // `markParked`'s guard, and while it is shown it is modal, so no list key and no header control
  // can make this page's `w` or `d` leave meanwhile.
  // The key help lies over every dialog: it goes, so that nothing hides this one (as for the
  // switcher), and while it is shown Ctrl+Shift+H is refused (`windowChordGate`).
  help.hide();
  state.enderFrom = document.activeElement;
  ender.open(row, fromList, mark);
  appRoot.inert = true;
}

/**
 * F30: the dialog closed, whatever closed it: the page is no longer inert; after Cancel the
 * keyboard goes back where it was, else (and when that is gone) to the zone's holder — or to a
 * terminal this page's resume brought meanwhile, as after any dialog.
 * @param {'end' | 'keep' | 'cancel' | 'gone'} choice
 */
function enderClosed(choice) {
  appRoot.inert = modal(); // F38: the running form of an update may stand over it
  const from = state.enderFrom;
  state.enderFrom = null;
  if (broughtTakesKeyboard()) {
    return;
  }
  if (
    choice === 'cancel' &&
    from instanceof HTMLElement &&
    from !== document.body &&
    from.isConnected &&
    from.checkVisibility()
  ) {
    from.focus();
    return;
  }
  giveKeyboard();
}

/**
 * Issue #166: `r` in the list (`fromList`: on the row the list shows) and the header's Restart (on
 * the pane's row, `sessionRow`'s): the dialog "Restart" for a session the window can restart
 * (`offersRestart`), else a toast that says why. What had the keyboard is kept for the dialog's
 * close.
 * @param {string} sessionId
 * @param {boolean} fromList
 */
function askRestart(sessionId, fromList) {
  const row = fromList ? rowOf(sessionId) : (sessionRow(state.list, sessionId) ?? undefined);
  if (row === undefined) {
    say('no session selected');
    return;
  }
  if (modal()) {
    return;
  }
  // F44's one guard, for `r` and Restart too: nothing on the session this page's own `w`, `d` or
  // end just marked, before its list decided where the selection goes.
  if (state.marking.has(sessionId) || state.leaving?.sessionId === sessionId) {
    return;
  }
  if (!offersRestart(row)) {
    const held = state.list?.terminals.some(
      (term) => term.id === row.terminal && term.restarting === true,
    );
    toast.show(noRestartText(row, held === true), null);
    return;
  }
  // The key help lies over every dialog: it goes, as for the dialog "Mark done".
  help.hide();
  state.restarterFrom = document.activeElement;
  const selected = state.list?.selected?.sessionId === row.id ? state.list.selected : null;
  restarter.open(row, selected);
  appRoot.inert = true;
}

/**
 * Issue #166: the dialog "Restart" closed, whatever closed it: the page is no longer inert, and the
 * keyboard goes back where it was (also after the answer: a terminal that replaced the one that had
 * it gets it as the zone's holder), else to the zone's holder.
 * @param {'cancel' | 'answered' | 'gone'} choice
 */
function restarterClosed(choice) {
  appRoot.inert = modal(); // F38: the running form of an update may stand over it
  const from = state.restarterFrom;
  state.restarterFrom = null;
  if (broughtTakesKeyboard()) {
    return;
  }
  if (
    choice !== 'gone' &&
    from instanceof HTMLElement &&
    from !== document.body &&
    from.isConnected &&
    from.checkVisibility()
  ) {
    from.focus();
    return;
  }
  giveKeyboard();
}

/**
 * Issue #166: the answer of a restart, once the dialog closed or as it closed: the toast in its
 * words, and for a session that ended and was not resumed, the line of its terminal's ended bar.
 * Nothing is selected and the keyboard is not moved (ruled): the user may be elsewhere by now.
 * @param {{ toast: string, bar: string | null }} outcome
 * @param {string} term the terminal the restart ended
 */
function restartFinished(outcome, term) {
  toast.show(outcome.toast, null);
  if (outcome.bar !== null) {
    state.restartSaid.set(term, outcome.bar);
    render();
  }
}

/**
 * F30's `Keep it running`: exactly D15's `d` on a running session — marked done, the Undo toast in
 * its words, the same selection rule.
 * @param {string} sessionId
 * @param {boolean} fromList
 */
function keepRunning(sessionId, fromList) {
  const row = sessionRow(state.list, sessionId);
  if (row === null) {
    toast.show(END_TEXTS.gone, null);
    return;
  }
  if (row.done) {
    toast.show(END_TEXTS.doneElsewhere, null);
    return;
  }
  sendDone(sessionId, fromList, DONE_RUNNING);
}

/**
 * F30's `End session and mark done`, and from F44 (`mark` `park`) `End session and park`: `act
 * end-session` for the session and the terminal the dialog was opened for (with `mark` `park` for
 * the latter; Done's act is as before, without one). The toast says `Ending the session…` until
 * the answer: ended (Undo marks it undone, or un-parks it; the program does not come back), not
 * ended within the server's wait (still marked, as after the Keep button; Undo too), or refused
 * (nothing was done; the server's words). After `d` in the list the selection follows D15's rule
 * for a row that is gone, after `w` F44's rule for a parked row (`leavePark`).
 * @param {string} sessionId
 * @param {string} term
 * @param {boolean} fromList
 * @param {import('./end-text.js').DialogMark} [mark]
 */
function endSession(sessionId, term, fromList, mark = 'done') {
  if (state.marking.has(sessionId)) {
    return;
  }
  const row = sessionRow(state.list, sessionId);
  // F44: the Undo gives back what was there: a parked session is parked again, a done one that
  // was parked is done again.
  const undo =
    mark === 'park'
      ? row?.done === true
        ? 'done'
        : 'unpark'
      : row?.parked === true
        ? 'park'
        : 'undone';
  const texts = textsOf(mark);
  const place = placeOf(sessionId);
  if (fromList && place !== null) {
    state.leaving = { sessionId, ...place, mark, listed: false, answered: false };
    state.undoTo = null;
  }
  state.marking.add(sessionId);
  toast.show(texts.ending, null, true);
  const marked = mark === 'park' ? { mark } : {};
  void act({ kind: 'end-session', term, sessionId, ...marked }).then((result) => {
    state.marking.delete(sessionId);
    if (!result.ok) {
      if (state.leaving?.sessionId === sessionId) {
        state.leaving = null; // a refused end moves nothing
      }
      toast.show(`End session: ${result.error ?? 'skydeck could not do that'}`, null);
      return;
    }
    toast.show(result.ended === true ? texts.ended : texts.notEnded, () =>
      undoMark(sessionId, undo),
    );
    if (mark === 'park') {
      answeredPark(sessionId);
    } else {
      answeredDone(sessionId);
    }
  });
}

/**
 * The toast's Undo, which gives back what was there (F44, both ways): of a `done`, `undone` — or
 * `park` for a session that was parked —; of a `park`, `unpark` — or `done` for a session that
 * was done. When it undoes this page's own `d` or `w` in the list, the session is selected again
 * once it is back, if the selection is still where that `d` or `w` left it (ruled; `followUndo`);
 * a `d` or `w` whose selection has not moved yet moves it no more.
 * @param {string} sessionId
 * @param {'undone' | 'park' | 'unpark' | 'done'} kind
 */
function undoMark(sessionId, kind) {
  if (state.leaving?.sessionId === sessionId) {
    state.leaving = null;
  }
  if (state.marking.has(sessionId)) {
    return;
  }
  state.marking.add(sessionId);
  const back = state.undoTo?.sessionId === sessionId ? state.undoTo : null;
  void act({ kind, sessionId }).then((result) => {
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
      followUndo(false);
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
  if (leaving.mark === 'park') {
    // F44: the first list that shows the row out of its section decides, before it is drawn and
    // without waiting for the answer (so the list never scrolls to the row under Parked).
    const row = state.list?.sections
      .find((section) => section.name === leaving.section)
      ?.rows.find((candidate) => candidate.id === leaving.sessionId);
    if (row === undefined) {
      leavePark(leaving);
      return;
    }
    const place = placeOf(leaving.sessionId);
    if (place !== null) {
      Object.assign(leaving, place);
    }
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
  if (!stayedFor(leaving)) {
    return; // the user moved meanwhile: the selection stays
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
  state.undoTo = {
    sessionId: leaving.sessionId,
    at: next ?? leaving.sessionId,
    answered: false,
    away: null,
  };
  if (next !== undefined) {
    select(next, 'key');
  }
}

/**
 * Whether the user is, when the list that decides comes, where this page's own `d` or `w` in the
 * list left them, so that the list may move the selection on (`leaveDone`, `leavePark`): the
 * session is still the selected one and was not chosen again (Enter, a click, a chord), the list
 * has the keyboard's zone, the new session's form is not open and no dialog is shown. Going to the
 * terminal (Enter, Esc, a click there, the zone chord), opening the form or choosing the session
 * again counts as the user having moved: a selection moved then would hand the next row the next
 * key, or its terminal the keyboard (since F44 the next row can run, under Open after `w`, under
 * Parked after `d`).
 * @param {NonNullable<typeof state.leaving>} leaving
 * @returns {boolean}
 */
function stayedFor(leaving) {
  return (
    leaving.chosen !== true &&
    state.selected === leaving.sessionId &&
    state.zone === 'list' &&
    !state.newOpen &&
    !modal()
  );
}

/**
 * F44 (S2 12.9, 12.15; the owner's decision): this page's `w` in the list parked the selected
 * session, and `state.list` is the first list that shows its row out of the section it left. When
 * the selection is still that session, it moves to the row after it in that section, else the one
 * before it — which may be a row of Open (parking stops nothing) —, else to none (`selectNone`);
 * the keyboard stays in the list. A selection the user moved meanwhile stays.
 * @param {NonNullable<typeof state.leaving>} leaving
 */
function leavePark(leaving) {
  state.leaving = null;
  if (!stayedFor(leaving)) {
    return; // the user moved meanwhile: the selection stays
  }
  const section = state.list?.sections.find((candidate) => candidate.name === leaving.section);
  const listed = new Set(section?.rows.map((row) => row.id) ?? []);
  const at = leaving.order.indexOf(leaving.sessionId);
  const next =
    leaving.order.slice(at + 1).find((id) => listed.has(id)) ??
    leaving.order
      .slice(0, at)
      .reverse()
      .find((id) => listed.has(id));
  state.undoTo = {
    sessionId: leaving.sessionId,
    at: next ?? null,
    answered: false,
    away: 'parked',
  };
  if (next === undefined) {
    selectNone();
  } else {
    select(next, 'key');
  }
}

/**
 * F44: no session is selected (after `w` on the only row of its section): no caption either; the
 * most-recently-used order is kept, so that no later list selects a row by itself and Ctrl+Tab
 * goes back to the session just parked. The zone stays.
 */
function selectNone() {
  state.newOpen = false;
  state.bringing = null;
  state.caption = null;
  state.selected = null;
  sendView();
  sendFocus();
  render();
}

/**
 * At the Undo's answer and at each list after it: the session back, selected again (ruled); F44:
 * after a `w`, once its row is no longer under Parked (so the list is never sent there and back).
 * A list after the answer that does not list the session (a done row that stopped meanwhile) ends
 * it: nothing selects the session again later.
 * @param {boolean} atList whether a list just came (else the answer did)
 */
function followUndo(atList) {
  const back = state.undoTo;
  if (back === null || !back.answered) {
    return;
  }
  if (rowOf(back.sessionId) === undefined) {
    if (atList) {
      state.undoTo = null; // not listed after the Undo's answer: nothing to select again, ever
    }
    return;
  }
  if (back.away !== null && placeOf(back.sessionId)?.section === back.away) {
    return;
  }
  state.undoTo = null;
  // Still where the `d` or `w` left it: that row, or (F44) none, no caption selected either.
  const stayed =
    back.at === null
      ? state.selected === null && state.caption === null
      : state.selected === back.at;
  if (stayed && state.selected !== back.sessionId) {
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
      error: ACTION_LOST,
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
  liftUpdateLock(); // F38: the server's `update` after `start` says what holds now
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
  if (change !== 'first') {
    // Issue #199 (S2 8.2.5): after a reconnect every shell is hidden, its streams gone with the
    // old connection; the header's dot says it is there, the key shows it again (a fresh snap).
    state.shellsShown.clear();
    state.shellAsked = null;
    state.shellKey = '';
    shellView.reset?.();
    dom.shell.hidden = true;
    dom.shellBar.hidden = true;
  }
  const shown = shownTerminal()?.id;
  state.reattach =
    change === 'wsl-restarted'
      ? []
      : [...attached.filter((id) => id === shown), ...attached.filter((id) => id !== shown)];
  state.welcomed = true;
  sendView();
  sendFocus(true); // the selection the page had, reported again: its own (S2 12.4)
}

/** @param {ServerMessage} message */
function received(message) {
  switch (message.t) {
    case 'list': {
      const before = state.list;
      state.list = message;
      // F40 (S2 12.9): the selection follows the terminal that showed it to its new session (after
      // `/clear`), so that the same terminal stays shown under the new session's header.
      const followed = state.caption === null ? movedWith(before, message, state.selected) : null;
      if (followed !== null && state.selected !== null) {
        state.mru = movedMru(state.mru, state.selected, followed);
        state.selected = followed;
        sendView();
        sendFocus();
      }
      state.listAt = performance.now();
      state.lists++;
      state.unlisted.clear(); // a list after the answer holds the result
      state.unreadAnswered.clear(); // and the mark unread or read (S2 12.4)
      dom.tick.hidden = true;
      if (state.selected === null && state.caption === null && state.mru.length === 0) {
        // Nothing selected yet: the first row (Open's first slot when there is one). Only before
        // anything was ever selected (F9: once a selected caption's block opened without a key,
        // nothing is selected on purpose, and no list selects a session for the user — but for
        // F40's, above: a list moves the selection only with the terminal that showed it).
        const first = rows()[0];
        if (first !== undefined) {
          state.selected = first.id;
          state.mru = [first.id];
          sendView();
          sendFocus(true); // selected by the page itself, not the user (S2 12.4)
        }
      }
      followDone();
      followUndo(true);
      // Stage C: before the render, whose keepKeyboard gives the zone the keyboard when a control
      // of the banner that had it went away (a restore began: Restore is gone).
      banner.render(message.banner ?? null);
      favouritesListener?.(favouritesOf(message)); // F15: the open form's chips (S2 12.6)
      shellsGone(message); // issue #199: a shell gone from the list leaves the page
      const toShell = shellListed(message); // issue #199: before the render, which draws it
      render();
      if (toShell && drawnShell(state.pane) !== null && !modal()) {
        shellKeyboard();
      }
      if (editor.shown()) {
        editor.update(message); // the dialog's session's row (task 38's list)
      }
      ender.update(message); // F30: its own session, never the selection's
      for (const term of state.restartSaid.keys()) {
        if (!message.terminals.some((one) => one.id === term)) {
          state.restartSaid.delete(term); // #166: a closed terminal's line goes with it
        }
      }
      restarter.update(message); // #166: its own session too
      // Stage B: the taskbar's count (S2 12.1), and the notifications of sessions that no
      // longer need you closed (B16). A list without `needYou` (stage A's) is none.
      document.title = windowTitle(message.needYou?.count ?? 0);
      notifications.update(message);
      // Stage E: the switcher's items, while it is shown (E8).
      switcher.update(message);
      startTour(); // F41: once, over the page as this list drew it
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
    }
    case 'snap':
      terminalView.snap(message);
      shellView.snap(message); // issue #199: each view ignores a terminal it does not have
      keepKeyboard();
      if (message.term === state.waitingSnap) {
        nextReattach();
      }
      return;
    case 'size':
      terminalView.size(message);
      shellView.size(message);
      keepKeyboard();
      return;
    case 'exit':
      if (shellView.attached().includes(message.term)) {
        shellView.exit(message); // issue #199: a shell's exit is its view's only
        return;
      }
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
        shellView.notice(message.term, message.kind, message.text);
        keepKeyboard();
      }
      return;
    case 'settings':
      // F36: a setting was changed in some window; an open screen follows.
      settingsDialog.update(message.settings);
      return;
    case 'update':
      // F38: the check's state; the title bar's control, the dialog and the settings follow.
      updateState(message.update);
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

/**
 * Issue #199: the shell the list has for the terminal `termId`, or null.
 * @param {string} termId
 * @returns {ShellPayload | null}
 */
function shellOf(termId) {
  return (state.list?.shells ?? []).find((one) => one.of === termId) ?? null;
}

/**
 * Issue #199 (S2 12.9): Ctrl+Shift+S, `s` and the header's `Shell` — what `shellPress` says for
 * the pane: a toast, the act for the pane's terminal, or the panel shown, hidden or given the
 * keyboard. `selected`: a session is selected for this press (for `s`, one the list shows).
 * `header`: the header's `Shell`, whose click takes no keyboard: on a shown panel it hides it, as
 * its tooltip says.
 * @param {boolean} selected
 * @param {boolean} [header]
 */
function pressShell(selected, header = false) {
  const pane = state.pane;
  const term = pane.kind === 'terminal' ? pane.term : null;
  const shell = term === null ? null : shellOf(term.id);
  const shown = drawnShell(pane) !== null;
  const inShell = header ? shown : dom.shell.contains(document.activeElement);
  const press = shellPress({ pane, selected, shell, shown, inShell });
  if ('toast' in press) {
    toast.show(press.toast, null);
    return;
  }
  if (term === null) {
    return;
  }
  switch (press.do) {
    case 'act':
      openShell(term.id);
      return;
    case 'show':
      if (shell !== null) {
        state.shellsShown.add(shell.id);
        render();
        shellKeyboard();
      }
      return;
    case 'hide':
      if (shell !== null) {
        state.shellsShown.delete(shell.id);
        render();
        setZone('terminal', false);
        terminalView.focus();
      }
      return;
    case 'focus':
      shellKeyboard();
      return;
  }
}

/** Issue #199: the keyboard to the shown panel's shell; the zone is the terminal's. */
function shellKeyboard() {
  setZone('terminal', false);
  shellView.focus();
}

/**
 * Issue #199: `act shell` for the terminal `termId`, with the first size of a panel of a third of
 * the terminal area (80 × 12 while the view cannot tell). The panel shows with the list that
 * brings the shell (`state.shellAsked`), not with the answer; a refusal is the toast.
 * @param {string} termId
 */
function openShell(termId) {
  if (state.shellAsked?.term === termId && !state.shellAsked.answered) {
    return; // asked already: the list brings it
  }
  const zone = dom.rightZone.getBoundingClientRect();
  const height = (zone.height - dom.cards.getBoundingClientRect().height) / 3;
  const fitted = shellView.fits(Math.max(1, zone.width), Math.max(1, height));
  const size =
    fitted !== null && Number.isFinite(fitted.cols) && Number.isFinite(fitted.rows)
      ? {
          cols: Math.max(1, Math.min(MAX_COLS, Math.floor(fitted.cols))),
          rows: Math.max(1, Math.min(MAX_ROWS, Math.floor(fitted.rows))),
        }
      : { cols: 80, rows: 12 };
  const asked = { term: termId, answered: false };
  state.shellAsked = asked;
  void act({ kind: 'shell', term: termId, ...size }).then((result) => {
    const waiting = state.shellAsked === asked; // else a list brought the shell, or a reconnect
    if (result.ok) {
      if (waiting) {
        asked.answered = true;
      }
      return;
    }
    if (waiting) {
      state.shellAsked = null;
    }
    // Also when a list brought the shell already: one that ended at once was listed while the
    // server waited for its end, and its panel came and went; the answer says why.
    toast.show(shellRefusedText(result.error ?? result.lines.join(' ')), null);
  });
}

/**
 * Issue #199: at a list, the shell `state.shellAsked` waits for: brought, it is shown (and, while
 * its terminal is the pane's, gets the keyboard after the render: the answer); not brought by the
 * first list after the act's answer, the act is forgotten (a shell that ended before that list, or
 * one another window opens later, must not open this page's panel).
 * @param {ListMessage} message
 * @returns {boolean} whether the shell is to get the keyboard after the render
 */
function shellListed(message) {
  const asked = state.shellAsked;
  if (asked === null) {
    return false;
  }
  const shell = (message.shells ?? []).find((one) => one.of === asked.term);
  if (shell === undefined) {
    if (asked.answered) {
      state.shellAsked = null;
    }
    return false;
  }
  state.shellAsked = null;
  state.shellsShown.add(shell.id);
  return state.pane.kind === 'terminal' && state.pane.term.id === asked.term;
}

/**
 * Issue #199: a shell this page shows that a list no longer has (its `exit`, its session's end)
 * leaves the page: its id the set, its terminal the view; the render then hides the panel and
 * `keepKeyboard` gives the keyboard to the session's terminal.
 * @param {ListMessage} message
 */
function shellsGone(message) {
  const listed = new Set((message.shells ?? []).map((one) => one.id));
  for (const id of [...state.shellsShown]) {
    if (!listed.has(id)) {
      state.shellsShown.delete(id);
      shellView.drop?.(id);
    }
  }
}

/**
 * Issue #199 (S2 12.5): what the header's Shell says for `pane`: null unless the pane is a
 * terminal of the window that is not ended; else whether a shell of it is open and shown.
 * @param {Pane} pane
 * @returns {'none' | 'hidden' | 'shown' | null}
 */
function headerShell(pane) {
  if (pane.kind !== 'terminal' || pane.ended) {
    return null;
  }
  if (shellOf(pane.term.id) === null) {
    return 'none';
  }
  return drawnShell(pane) !== null ? 'shown' : 'hidden';
}

/**
 * Issue #199 (S2 12.6): the shell the panel shows for `pane` — a shell of the pane's terminal that
 * this page shows, while that terminal is not ended —, or null.
 * @param {Pane} pane
 * @returns {ShellPayload | null}
 */
function drawnShell(pane) {
  if (pane.kind !== 'terminal' || pane.ended) {
    return null;
  }
  const shell = (state.list?.shells ?? []).find((one) => one.of === pane.term.id);
  return shell !== undefined && state.shellsShown.has(shell.id) ? shell : null;
}

/**
 * Issue #199: the shell panel and its bar drawn for `pane` (or hidden), and the shells' view shown
 * that shell (or none); applied only when it changed.
 * @param {Pane} pane
 */
function renderShell(pane) {
  const shell = drawnShell(pane);
  const key = shell === null ? '' : JSON.stringify(shell);
  if (key === state.shellKey) {
    return;
  }
  state.shellKey = key;
  dom.shell.hidden = shell === null;
  dom.shellBar.hidden = shell === null;
  shellView.show(shell);
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
  // Issue #166: the line a restart put on the ended bar of the pane's terminal.
  const said = pane.kind === 'terminal' ? (state.restartSaid.get(pane.term.id) ?? '') : '';
  // S2 12.4: the header's Unread / Read follows this page's answered act before the next list.
  const answered = paneRow === null ? null : (state.unreadAnswered.get(paneRow.id) ?? null);
  // Issue #199: the state of the pane's terminal's shell, for the header's Shell.
  const shellState = headerShell(pane);
  const key = JSON.stringify(
    pane.kind === 'new' ? ['new'] : [pane, exit, selected, lines, said, answered, shellState],
  );
  state.pane = pane;
  renderShell(pane);
  // F22: the right side's line while nothing is shown there and the list holds no session at all.
  const blank = pane.kind === 'none' && holdsNoSession(state.list, state.view.filter);
  if (dom.rightNone.hidden === blank) {
    dom.rightNone.hidden = !blank;
  }
  if (key === state.paneKey) {
    keepKeyboard(); // the list may have dropped what had the keyboard
    return;
  }
  state.paneKey = key;
  const before = dom.rightZone.dataset.paneTerm ?? '';
  if (pane.kind !== 'terminal' || pane.term.id !== before) {
    state.shellSide = 'session'; // issue #199: another terminal starts on the session's side
  }
  dom.rightZone.dataset.pane = pane.kind;
  dom.rightZone.dataset.paneTerm = pane.kind === 'terminal' ? pane.term.id : '';
  terminalView.show(pane.kind === 'terminal' ? pane.term : null);
  cards.hide();
  switch (pane.kind) {
    case 'terminal':
      cards.header(pane.row, selected, term, listNow, shellState);
      if (pane.ended) {
        // #188: the bar's Other flags… closes nothing for a row the list hides (E13: no card).
        cards.endedBar(pane.row, exit, pane.row !== null && rowOf(pane.row.id) !== undefined, said);
      }
      carry.render(pane.row, selected?.carryOver ?? null);
      break;
    case 'elsewhere':
      cards.header(pane.row, selected, null, listNow);
      cards.elsewhere(pane.row);
      carry.render(pane.row, selected?.carryOver ?? null);
      break;
    case 'resume':
      cards.header(pane.row, selected, null, listNow);
      cards.resumeCard(pane.row, selected, lines);
      carry.render(pane.row, selected?.carryOver ?? null);
      break;
    case 'new':
      // The selected session's directory (S2 12.6) and, F28, its group as the Group field's chip:
      // a hidden selection's too while a terminal of the window shows it (E13; review 2, ruled),
      // since its header was what the user saw (new-form-text.js).
      cards.header(null, null, null, listNow);
      cards.newForm(newFormDefaults(state.list, state.selected));
      carry.render(null, null);
      break;
    case 'group':
      // F9: a closed caption is selected: the group's card, no header, no terminal.
      cards.header(null, null, null, listNow);
      cards.groupCard(pane);
      carry.render(null, null);
      break;
    case 'none':
      cards.header(null, null, null, listNow);
      carry.render(null, null);
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
  // A control of the right side keeps the keyboard, but one of the carry-over bar (F40): the
  // terminal zone is the user's own move there (a zone chord), and the terminal is meant.
  if (
    dom.rightZone.contains(document.activeElement) &&
    document.activeElement !== dom.rightZone &&
    !carryHost.contains(document.activeElement)
  ) {
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
    sideView().focus(); // issue #199: the session's terminal, or its shell when it had it last
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
  // F40 (S2 12.9): while a control of the carry-over bar has the keyboard the page is in the list
  // zone, where no rule gives the terminal the keyboard.
  if (carryHost.contains(target)) {
    if (state.zone !== 'list') {
      setZone('list', false);
    }
    return;
  }
  // Issue #199: the side of the terminal zone that has the keyboard, for giveKeyboard.
  if (dom.shell.contains(target)) {
    state.shellSide = 'shell';
  } else if (dom.terminal.contains(target)) {
    state.shellSide = 'session';
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
 * passes — not while F30's dialog "Mark done" is shown, which the help would cover —; a reload
 * passes unless the dialog holds text the user typed and did not save, when the key bar says `save
 * or cancel the edit first`; everything else says `close the edit first (Esc)` (`close the dialog
 * first (Esc)` for "Mark done") and does nothing else. While F41's tour is shown, the reload keys
 * pass and everything else, Ctrl+Shift+H too (the help would cover it), says `close the tour first
 * (Esc)`; the help's `Take the tour` (`tour`) passes only where nothing is shown.
 * @param {WindowChord['kind'] | string} kind
 * @returns {boolean} whether it may act
 */
function windowChordGate(kind) {
  if (updateDialog.runningShown()) {
    say(UPDATE_TEXTS.beingUpdated); // F38, milestone 2: nothing acts while an update runs
    return false;
  }
  if (tour.shown()) {
    // F41: nothing of the tour is worth keeping, so a reload passes.
    if (kind === 'reload') {
      return true;
    }
    say(TOUR_TEXTS.closeFirst);
    return false;
  }
  if (switcher.shown()) {
    if (kind === 'switcher' || kind === 'reload') {
      return true;
    }
    say('close the switcher first (Esc)');
    return false;
  }
  // F30: the key help would lie over the dialog "Mark done" and hide what Enter presses (#166:
  // and over the dialog "Restart").
  if (
    !modal() ||
    (kind === 'help' && !ender.shown() && !restarter.shown() && !updateDialog.shown())
  ) {
    return true;
  }
  if (kind === 'reload') {
    if (!editor.changed() && !settingsDialog.changed()) {
      return true;
    }
    say('save or cancel the edit first');
    return false;
  }
  say(
    ender.shown() || restarter.shown() || updateDialog.shown()
      ? 'close the dialog first (Esc)'
      : settingsDialog.shown()
        ? 'close the settings first (Esc)'
        : 'close the edit first (Esc)',
  );
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
      keyboardView().find(); // issue #199: the view that holds the keyboard
      return;
    case 'copy':
      keyboardView().copy();
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
        keyboardView().pasteRaw();
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
    case 'shell':
      // Issue #199 (S2 12.9): a held key acts once.
      if (!event.repeat) {
        pressShell(state.selected !== null);
      }
      return;
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
    case 'park': {
      // F44 (S2 12.15): park the selected session, or un-park a parked one; at the first keydown
      // only, as `d`.
      if (event.repeat) {
        return true;
      }
      const row = selectedRow();
      if (row === undefined) {
        say('no session selected');
      } else {
        markParked(row.id, true);
      }
      return true;
    }
    case 'unread': {
      // S2 12.4: mark the selected session unread, or read; at the first keydown only, as `d`.
      if (event.repeat) {
        return true;
      }
      const row = selectedRow();
      if (row === undefined) {
        say('no session selected');
      } else {
        markUnread(row.id);
      }
      return true;
    }
    case 'reorder': {
      // F37 (S2 12.9): the selected session of Open one place up or down; the server moves it (or
      // says why not). The selection, by id, and the keyboard stay with it.
      const row = selectedRow();
      if (row === undefined) {
        say('no session selected');
        return true;
      }
      if (reordering) {
        return true;
      }
      reordering = true;
      const sessionId = row.id;
      void act({ kind: 'reorder', sessionId, direction: action.by < 0 ? 'up' : 'down' }).then(
        (result) => {
          reordering = false;
          if (!result.ok) {
            say(result.error ?? result.lines[0] ?? 'the session was not moved');
            return;
          }
          list.follow(sessionId);
          // The list of the new order can come up to a second after the answer (as for F15's).
          sendView();
        },
      );
      return true;
    }
    case 'carry':
      // F40 (S2 12.9): the keyboard to the carry-over bar whenever the pane shows it, also for a
      // selection the list does not show (a filter often hides the new session's row).
      if (!carry.focus()) {
        say(state.selected === null ? 'no session selected' : NOTHING_TO_CARRY);
      }
      return true;
    case 'restart': {
      // Issue #166 (S2 12.9): the dialog "Restart" of the selected row the list shows, at the
      // first keydown only; elsewhere a toast says why.
      if (event.repeat) {
        return true;
      }
      const row = selectedRow();
      if (row === undefined) {
        say('no session selected');
      } else {
        askRestart(row.id, true);
      }
      return true;
    }
    case 'flags': {
      // Issue #188 (S2 12.6, 12.9): the resume card's Other flags…, the keyboard in its field; a
      // held f acts once and types nothing into it.
      if (event.repeat) {
        return true;
      }
      // As every list key that acts: on the selected row the list shows (E13).
      if (selectedRow() === undefined) {
        say('no session selected');
        return true;
      }
      // The cards say why not: no resume card is shown, or its session expired.
      const why = cards.openFlags();
      if (why === null) {
        state.flagsBy = event.code;
      } else {
        say(why);
      }
      return true;
    }
    case 'shell':
      // Issue #199: as Ctrl+Shift+S, on the selected row the list shows (E13); once when held.
      if (!event.repeat) {
        pressShell(selectedRow() !== undefined);
      }
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
  if (tour.shown() && tour.key(event)) {
    event.stopPropagation();
    return; // F41: Enter, the arrows, Esc and Tab are the tour's
  }
  if (switcher.shown() && switcherCapture(event)) {
    return;
  }
  if (editor.shown() && dialogKey(event)) {
    return;
  }
  if (ender.shown() && ender.key(event)) {
    return; // F30: Esc, Tab, Enter and Space are the dialog's
  }
  if (restarter.shown() && restarter.key(event)) {
    return; // #166: Esc, Tab, the arrows, Enter and Space are the dialog's
  }
  if (settingsDialog.shown() && settingsKey(event)) {
    return; // F36: Esc, Tab and Enter in a field are the screen's
  }
  if (updateDialog.shown() && updateDialog.key(event)) {
    return; // F38: Esc and Tab are the dialog's
  }
  if (event.repeat && state.flagsBy !== '' && event.code === state.flagsBy) {
    event.preventDefault();
    return; // #188: a held f that opened Other flags… types nothing into its field
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
    } else if (
      zone === 'terminal' &&
      state.pane.kind === 'resume' &&
      event.key === 'Escape' &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      cards.flagsShown()
    ) {
      // Issue #188: Esc in Other flags… goes back to the card, nothing sent; a held Esc once.
      if (!event.repeat) {
        cards.closeFlags();
      }
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
 * F36: the keys the shown settings screen takes before anything else, in the capture phase — the
 * auto-repeats of the key that opened it, Esc (once per press; the key help first when it lies over
 * the screen), Tab and Enter in a field
 * (`settingsDialog.key`). True when it took the key; every other key goes on to onKeyDown's
 * dispatch, where the chords meet `windowChordGate` and no list key acts.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function settingsKey(event) {
  if (event.repeat && state.openedBy !== '' && event.code === state.openedBy) {
    event.preventDefault();
    return true;
  }
  if (event.isComposing || event.keyCode === 229) {
    return false; // a key of an IME composition is the IME's
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
      // Esc closes the top layer only: the key help when it lies over the screen (Ctrl+Shift+H).
      if (help.shown()) {
        help.hide();
      } else {
        settingsDialog.escape();
      }
    }
    return true;
  }
  if (settingsDialog.key(event)) {
    event.stopPropagation();
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
 * a held Tab there walks on (review 2 of task 75, C4); follow-up F40: the same for Enter on a
 * control of the carry-over bar, which goes away once `Carry over` or `×` is answered, so that
 * its repeats are no list `enter` (they would resume a session or show its terminal). Stage
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
    (dom.banner.contains(document.activeElement) && event.key === 'Enter') ||
    (carryHost.contains(document.activeElement) && event.key === 'Enter')
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
    if (event.code === state.flagsBy) {
      state.flagsBy = '';
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

/** Whether the keyboard is on a terminal view (inside its root `#terminal`, or `#shell`: #199). */
function terminalHasKeyboard() {
  return (
    dom.terminal.contains(document.activeElement) || dom.shell.contains(document.activeElement)
  );
}

/**
 * Issue #199 (S2 9.5, 9.7): the view whose element holds the keyboard — the shells' when it is
 * inside `#shell`, else the session terminals' —, which find, copy and the raw Ctrl+V act on.
 */
function keyboardView() {
  return dom.shell.contains(document.activeElement) ? shellView : terminalView;
}

/**
 * Issue #199: the view of the side of the terminal zone that had the keyboard last: the shell's
 * while its panel is drawn, else the session's terminal.
 */
function sideView() {
  return state.shellSide === 'shell' && drawnShell(state.pane) !== null ? shellView : terminalView;
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
  shellView.setHidden(document.hidden);
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
      output: (channel, bytes) => {
        terminalView.output(channel, bytes);
        shellView.output(channel, bytes); // channels are the connection's: they never clash
      },
      lost: (since) => {
        dropPending();
        state.bringing = null; // the resume's terminal is no longer the page's own news (Z1)
        // F38: told that an update runs, the bar names its log first; the lock is lifted.
        const applying = state.updateApplying;
        liftUpdateLock();
        if (applying === null) {
          showGone(since);
        } else {
          showUpdateAway(applying.sinceNs);
        }
        switcher.update(null); // E11: it says so; Enter does nothing, a kept Enter is dropped
      },
      fatal: (text) => {
        dropPending();
        liftUpdateLock(); // F38: a page that cannot reconnect is never left inert
        dom.gone.hidden = true;
        showProblem(text);
        switcher.update(null);
      },
      warn: (text) => showProblem(text),
    },
  });
}

void start();
