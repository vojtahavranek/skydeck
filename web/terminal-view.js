// The terminal view (S2 8.2.4, 8.2.6, 9, 12.6, 15.4; plan task 28, contract 2.9): one xterm.js
// 6.0.0 per attached terminal, with the vendored addons, fed by the snapshot and the stream of
// S2 8.2.4 and sized by the server only (S2 8.2.6: the view only computes the proposal sent in
// `attach` and `resize`, by its own rule of what fits — see `fitIn`). The page's terminal answers
// no query (S2 9.3), maps the keys of S2 9.1, writes the clipboard only for the shown terminal of
// a focused window (S2 9.5), opens links only on a Ctrl+click and through the server (S2 9.6),
// finds in the scrollback (S2 9.7) and ignores the program's window title (S2 15.4).
//
// Up to eight terminals stay attached, the least recently shown detached beyond that; while the
// window is hidden only the shown one stays attached (S2 12.6). A detached terminal's xterm.js is
// disposed: showing it again costs one snapshot.
//
// Notices are the page's own text over the terminal they concern, never written into it, so that
// the page's screen stays the screen side's: the reconnecting bar (S2 7.8) and "sized by another
// window" follow the terminal's state; a gap or a newer keeper is the state the server repeats
// after every snapshot — a notice of it that the next snapshot does not repeat no longer holds and
// goes, and one the user dismissed is not shown again for a repeat; `input-full` goes once input
// is taken again.

/** @import { ExitMessage, SizeMessage, SnapMessage, TerminalPayload } from '../src/window/protocol.ts' */
/** @import { IBufferRange, ILink, ILinkHandler, ITheme } from '@xterm/xterm' */
import { Terminal } from '../vendor/xterm/xterm/lib/xterm.mjs';
import { SearchAddon } from '../vendor/xterm/addon-search/lib/addon-search.mjs';
import { UnicodeGraphemesAddon } from '../vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs';
import { terminalKey } from './keys.js';

/**
 * @typedef {object} TerminalViewDeps
 * @property {(message: Record<string, unknown> & { t: string }) => void} send
 * @property {(e: KeyboardEvent) => boolean} chord
 * @property {(url: string) => void} openLink
 */

/** S2 12.6: at most this many terminals stay attached. */
const MAX_ATTACHED = 8;
/** S2 8.2.6: as the screen side's (7.2). */
const SCROLLBACK = 5000;
/** S2 9.5: a program writes the clipboard with at most this much text (bytes of UTF-8). */
const CLIPBOARD_BYTES = 1024 * 1024;
/** S2 8.2.6: a proposed size is at most this. */
const MAX_COLS = 1000;
const MAX_ROWS = 500;
/** The terminal's font list (S2 12.6, #154; check W9), as style.css's `--term-font`. No symbol or
 *  emoji font is named: Windows' own fallback draws an emoji in colour (Segoe UI Emoji) and a
 *  symbol such as ⏺ ⎿ ⏵ in the program's colour. "Segoe UI Symbol" here drew every emoji in one
 *  colour and a joined emoji as its parts, squashed into two cells; "Segoe UI Emoji" here would
 *  draw ⏺ ⚠ ❤ as colour emoji, deaf to the program's colours. */
const FONT = '"Cascadia Mono", "Cascadia Code", Consolas, monospace';
/** A layout change is proposed to the server once it has settled this long. */
const REFIT_MS = 100;
/** `input-full` goes once input sent this long ago had no `input-full` (the server answers at once). */
const TAKEN_MS = 1000;
/** Characters given to xterm.js and not parsed yet above which the next writes wait in the view:
 *  xterm.js 6.0.0 throws away a write while more than 50,000,000 wait (`write data discarded`). */
const PARSE_AHEAD = 4_000_000;
/** What may wait in the view for xterm.js; beyond it the waiting output is dropped and a fresh
 *  snapshot asked for (S2 8.2.4: a snapshot is always right). */
const WAITING_MAX = 32_000_000;
/** S2 9.6: the server opens a URL of at most this many characters. */
const URL_MAX = 2048;
/** The room xterm.js's scroll bar takes at the box's right edge (the fit addon's 14 px with a
 *  scrollback): what every proposal and `fits` count out, with the style sheet's room around the
 *  text (`padding`). */
const SCROLL_BAR = 14;
/** The terminal states whose program is over (hub.ts). */
const OVER = new Set(['ended', 'lost', 'not-started']);

/** The texts the view shows itself. */
const TEXTS = {
  /** S2 7.8. */
  reconnecting: 'reconnecting to this terminal',
  /** S2 8.2.6. */
  sizedElsewhere: 'sized by another window; type here to size it to this one',
  /** For each reason the server takes no input (its text names one of them only, task 16). */
  inputFull:
    'this terminal is not taking input at the moment: not all of what you typed or pasted reached the program',
  /** @param {string} url */
  linkTarget: (url) => `this link leads to ${url}; Ctrl+click it again to open it`,
  noMatch: 'no match',
  /** @param {number} index @param {number} count */
  matches: (index, count) => (index < 0 ? `${count} found` : `${index + 1} of ${count}`),
};

/** A URL in plain text (S2 9.6): `http://` or `https://` and URL characters. */
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%()']+/g;

/**
 * @typedef {object} Term one attached terminal
 * @property {string} id
 * @property {Terminal} xterm
 * @property {SearchAddon} search
 * @property {HTMLElement} box
 * @property {HTMLElement} bars
 * @property {HTMLElement} hint
 * @property {number | null} channel its output frames' channel (S2 8.2.3), from its snap
 * @property {{ cols: number, rows: number } | null} proposed the size this page proposed last
 * @property {boolean} asked the view sent `attach` and its snap has not come
 * @property {boolean} replay after a snap, until the terminal's first record
 * @property {boolean} over its program is over (S2 7.8): dimmed, takes no input
 * @property {boolean} owner whether this page owns the size (S2 8.2.6)
 * @property {string} state
 * @property {Map<string, Notice>} notices by kind
 * @property {Set<string>} dismissed `<kind>:<text>` of the gap and newer-keeper notices the user
 *   dismissed (forgotten when a snapshot's replay ends without that kind)
 * @property {Set<string>} replayed the kinds the server repeated after the last snap
 * @property {boolean} quiet a focus report xterm.js makes by itself is not the user's (S2 9.2)
 * @property {number} parsing characters given to xterm.js and not parsed yet
 * @property {{ data: string | Uint8Array, then?: () => void, counted: boolean }[]} waiting writes
 *   held for xterm.js
 * @property {number} waitingSize the characters of the held output (a snap's own do not count)
 * @property {boolean} refreshing a fresh snapshot was asked for: output until it comes is dropped
 * @property {number} refusedAt when the last `input-full` came (performance.now)
 * @property {number} sentAt when the page last sent input
 * @property {string | null} armed the OSC 8 link target the next Ctrl+click opens
 */

/**
 * @typedef {object} Notice
 * @property {HTMLElement} element
 * @property {string} text
 * @property {boolean} confirmed false from a snap until the server repeats it after that snap
 */

/**
 * @param {HTMLElement} root
 * @param {TerminalViewDeps} deps
 */
export function createTerminalView(root, deps) {
  /** The attached terminals. @type {Map<string, Term>} */
  const terms = new Map();
  /** Their ids, the most recently shown first: attached() and the order they are detached in. @type {string[]} */
  let order = [];
  /** @type {Map<number, Term>} */
  const byChannel = new Map();
  /** @type {Term | null} */
  let shown = null;
  let hidden = false;
  const find = findBar();
  root.append(find.element);

  // --- the terminals ----------------------------------------------------------------------------

  /**
   * A new xterm.js for `payload`, in its own box under the root, shown: it must be visible when it
   * is opened (xterm.js measures its cell then).
   * @param {TerminalPayload} payload
   * @returns {Term}
   */
  const create = (payload) => {
    const box = element('div', 'tv-term');
    box.dataset['term'] = payload.id;
    const screen = element('div', 'tv-screen');
    const bars = element('div', 'tv-bars');
    const hint = element('div', 'tv-hint');
    hint.textContent = TEXTS.sizedElsewhere;
    hint.hidden = true;
    box.append(screen, bars, hint);
    root.insertBefore(box, find.element);
    /** @type {Term} */
    const t = {
      id: payload.id,
      xterm: /** @type {Terminal} */ (/** @type {unknown} */ (null)),
      search: new SearchAddon(),
      box,
      bars,
      hint,
      channel: null,
      proposed: null,
      asked: false,
      replay: false,
      over: false,
      owner: true,
      state: payload.state,
      notices: new Map(),
      dismissed: new Set(),
      replayed: new Set(),
      quiet: false,
      parsing: 0,
      waiting: [],
      waitingSize: 0,
      refreshing: false,
      refusedAt: -Infinity,
      sentAt: -Infinity,
      armed: null,
    };
    const xterm = new Terminal({
      cols: payload.cols,
      rows: payload.rows,
      scrollback: SCROLLBACK,
      fontFamily: FONT,
      fontSize: fontSize(),
      theme: theme(),
      // Text at least 4.5 : 1 against its background, as VS Code's terminal draws it (dim text at
      // half that, xterm.js's rule; S2 12.6): a colour meant for the other background — a program
      // that assumes the other scheme, such as Claude Code in a theme of its own for it, or a fixed
      // 256-colour or 24-bit colour — is made lighter or darker until it can be read.
      minimumContrastRatio: 4.5,
      // The width addon uses the unicode API, which xterm.js 6.0.0 still marks as proposed.
      allowProposedApi: true,
      // xterm.js's own log quotes the program's output (ruled, task 33): nothing in the console.
      logLevel: 'off',
      linkHandler: oscLinks(t),
    });
    t.xterm = xterm;
    xterm.loadAddon(new UnicodeGraphemesAddon());
    xterm.loadAddon(t.search);
    swallowQueries(t);
    xterm.registerLinkProvider(plainLinks(t));
    xterm.attachCustomKeyEventHandler((event) => keyEvent(t, event));
    xterm.onData((data) => {
      // S2 9.2, 9.3: xterm.js reports the focus at once when it parses `CSI ? 1004 h` (also in a
      // snapshot): that report is not the user's, and must not reach the program or make this
      // page the size owner. Real focus changes later are.
      if (t.quiet && (data === '\x1b[I' || data === '\x1b[O')) {
        return;
      }
      sendInput(t, data, false);
    });
    xterm.onBinary((data) => sendInput(t, data, true));
    xterm.open(screen);
    screen.addEventListener('wheel', (event) => wheelInMargin(t, event), {
      capture: true,
      passive: false,
    });
    // S2 9.1: the page pastes, before xterm.js sees the event (the capture phase of its element):
    // xterm.js 6.0.0 neither cancels a paste (the browser then puts the whole text into its
    // hidden textarea, which makes the page slow at everything after) nor filters it (a text
    // that holds ESC [ 2 0 1 ~ ends its own bracketed paste, and the rest reaches the program as
    // typed keys). Without ESC no sequence can be in it. The find bar's field is not in here.
    screen.addEventListener(
      'paste',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        xterm.paste((event.clipboardData?.getData('text/plain') ?? '').replaceAll('\x1b', ''));
      },
      true,
    );
    return t;
  };

  /**
   * F2: a wheel in the margin around the text (terminal-view.css) does what one over the nearest
   * text cell does, once. xterm.js 6.0.0 scrolls with the wheel only over its scrollable element,
   * which the margin lies outside of; in the program's mouse mode its element reports the wheel.
   * So a wheel whose target is outside the scrollable element goes no further, and one like it
   * (the same deltas, keys and buttons, at the nearest point of the text) is dispatched on the
   * text, where it takes the way a wheel over the text takes: it scrolls, or reaches the program
   * as one report. The browser's own action follows the copy's (`preventDefault`).
   * @param {Term} t
   * @param {WheelEvent} event
   */
  const wheelInMargin = (t, event) => {
    const scrollable = t.xterm.element?.querySelector('.xterm-scrollable-element');
    const text = scrollable?.querySelector('.xterm-screen');
    if (!(text instanceof HTMLElement) || !(event.target instanceof Node)) {
      return;
    }
    if (scrollable?.contains(event.target)) {
      return; // over the text or the room at its right: xterm.js has it
    }
    event.stopPropagation();
    const box = text.getBoundingClientRect();
    /** @param {number} value @param {number} low @param {number} high */
    const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
    const x = clamp(event.clientX, box.left + 0.5, box.right - 0.5);
    const y = clamp(event.clientY, box.top + 0.5, box.bottom - 0.5);
    const copy = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: event.screenX + x - event.clientX,
      screenY: event.screenY + y - event.clientY,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      // Chromium's own wheel amounts, which xterm.js's scrolling reads first (not in the standard).
      ...{
        wheelDeltaX: Reflect.get(event, 'wheelDeltaX'),
        wheelDeltaY: Reflect.get(event, 'wheelDeltaY'),
      },
    });
    if (!text.dispatchEvent(copy)) {
      event.preventDefault();
    }
  };

  /**
   * S2 9.3, 9.5, 15.4: the parser handlers. The queries are answered once, by the screen side; the
   * page's terminal swallows each without answering. OSC 52 writes the clipboard (never read);
   * OSC 0 and 2, the program's window title, are ignored.
   * @param {Term} t
   */
  const swallowQueries = (t) => {
    const parser = t.xterm.parser;
    const swallow = () => true;
    for (const id of [
      { final: 'c' }, // DA1
      { prefix: '>', final: 'c' }, // DA2
      { final: 'n' }, // DSR, CPR
      { prefix: '?', final: 'n' }, // DSR (DEC), DECXCPR
      { intermediates: '$', final: 'p' }, // DECRQM
      { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM (DEC)
      { prefix: '>', final: 'q' }, // XTVERSION
      { final: 't' }, // window operations and reports
    ]) {
      parser.registerCsiHandler(id, swallow);
    }
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
    // Focus reporting turned on: xterm.js reports the focus at once (M1 of task 28's review).
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(1004)) {
        t.quiet = true;
        queueMicrotask(() => {
          t.quiet = false;
        });
      }
      return false;
    });
    for (const ident of [4, 10, 11, 12]) {
      // A colour query has `?`; a colour that is set goes on to xterm.js.
      parser.registerOscHandler(ident, (data) => data.includes('?'));
    }
    parser.registerOscHandler(0, swallow);
    parser.registerOscHandler(2, swallow);
    parser.registerOscHandler(52, (data) => {
      clipboardWrite(t, data);
      return true;
    });
  };

  /**
   * S2 9.5: OSC 52 `<selection>;<base64>` writes the clipboard — only for the terminal shown in a
   * focused window, and only up to 1 MiB of text; a read (`?`) is never answered.
   * @param {Term} t
   * @param {string} data
   */
  const clipboardWrite = (t, data) => {
    const at = data.indexOf(';');
    const payload = at === -1 ? '' : data.slice(at + 1);
    if (payload === '' || payload === '?' || payload.length > ((CLIPBOARD_BYTES + 2) / 3) * 4) {
      return;
    }
    if (t !== shown || hidden || document.hidden || !document.hasFocus()) {
      return;
    }
    let bytes;
    try {
      bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    } catch {
      return; // not base64
    }
    if (bytes.length > CLIPBOARD_BYTES) {
      return;
    }
    navigator.clipboard.writeText(new TextDecoder().decode(bytes)).catch(() => {});
  };

  /**
   * S2 9.1: every event of xterm.js's key handler goes to `deps.chord` first (it acts on a
   * keydown only and answers true for every event of a window chord, which xterm.js then drops);
   * the keys of the table are the page's — xterm.js neither sends nor cancels them.
   * @param {Term} t
   * @param {KeyboardEvent} event
   * @returns {boolean} whether xterm.js handles the event
   */
  const keyEvent = (t, event) => {
    if (deps.chord(event)) {
      return false;
    }
    const mapped = terminalKey(event);
    if (mapped === null) {
      return true;
    }
    if (mapped !== 'browser' && event.type === 'keydown') {
      sendInput(t, mapped.send, false);
      t.xterm.scrollToBottom();
    }
    return false;
  };

  /**
   * Input for the terminal (S2 8.2.3): makes this page the size owner. Not for a terminal whose
   * program is over.
   * @param {Term} t
   * @param {string} data
   * @param {boolean} binary
   */
  const sendInput = (t, data, binary) => {
    if (t.over || data === '') {
      return;
    }
    deps.send({ t: 'input', term: t.id, data, ...(binary ? { binary: true } : {}) });
    const sentAt = performance.now();
    t.sentAt = sentAt;
    if (t.notices.has('input-full')) {
      // The server answers input it does not take at once: none for this input means it was taken.
      setTimeout(() => {
        if (t.refusedAt < sentAt && performance.now() - sentAt >= TAKEN_MS) {
          dropNotice(t, 'input-full');
        }
      }, TAKEN_MS);
    }
  };

  // --- writing (S2 8.2.4, 8.2.8) ------------------------------------------------------------------

  /**
   * Writes to the terminal's xterm.js in order, never more than PARSE_AHEAD characters ahead of
   * what it has parsed: a snapshot can be 60 MiB (S2 8.2.8), and xterm.js throws away a write
   * while more than 50,000,000 characters wait. What comes meanwhile waits here; when more than
   * WAITING_MAX would wait, it is dropped and a fresh snapshot asked for, so that the screen is
   * never silently wrong. A snap's own writes (`counted` false) do not count toward it: a snap
   * replaces what waited, and dropping a large one would only ask the server for it again.
   * `then` runs once xterm.js has parsed `data`.
   * @param {Term} t
   * @param {string | Uint8Array} data
   * @param {{ then?: () => void, counted?: boolean }} [how]
   */
  const write = (t, data, how = {}) => {
    const counted = how.counted ?? true;
    if (t.waiting.length > 0 || t.parsing > PARSE_AHEAD) {
      t.waiting.push(
        how.then === undefined ? { data, counted } : { data, then: how.then, counted },
      );
      if (counted) {
        t.waitingSize += data.length;
        if (t.waitingSize > WAITING_MAX) {
          refresh(t);
        }
      }
      return;
    }
    give(t, data, how.then);
  };

  /**
   * @param {Term} t
   * @param {string | Uint8Array} data
   * @param {(() => void) | undefined} then
   */
  const give = (t, data, then) => {
    t.parsing += data.length;
    try {
      t.xterm.write(data, () => {
        t.parsing -= data.length;
        if (terms.get(t.id) !== t) {
          return; // detached meanwhile: its xterm.js is gone
        }
        then?.();
        // xterm.js 6.0.0 calls this before it counts the write as parsed: a write given from here
        // would still meet the whole of it waiting (and be thrown away). The next ones go after.
        queueMicrotask(() => drain(t));
      });
    } catch {
      // Behind PARSE_AHEAD (and the drain after xterm.js has counted a write as parsed) its
      // "write data discarded" cannot come; whatever else makes `write` throw, nothing is lost
      // silently: a fresh snapshot replaces what xterm.js refused.
      t.parsing -= data.length;
      refresh(t);
    }
  };

  /** @param {Term} t */
  const drain = (t) => {
    while (t.waiting.length > 0 && t.parsing <= PARSE_AHEAD) {
      const next =
        /** @type {{ data: string | Uint8Array, then?: () => void, counted: boolean }} */ (
          t.waiting.shift()
        );
      if (next.counted) {
        t.waitingSize -= next.data.length;
      }
      give(t, next.data, next.then);
    }
  };

  /**
   * Asks for a fresh snapshot of `t` (`attach` again; S2 8.2.4: a snapshot is always right) and
   * drops what waits and what comes until it is here.
   * @param {Term} t
   */
  const refresh = (t) => {
    t.waiting = [];
    t.waitingSize = 0;
    if (t.refreshing) {
      return;
    }
    t.refreshing = true;
    const size = (t === shown ? propose(t) : null) ??
      t.proposed ?? { cols: t.xterm.cols, rows: t.xterm.rows };
    t.proposed = size;
    deps.send({ t: 'attach', term: t.id, ...size });
  };

  // --- links (S2 9.6) ---------------------------------------------------------------------------

  /**
   * OSC 8 links (xterm.js gives only http and https ones): a Ctrl+click opens one whose text is
   * its target; for one whose text differs, the first Ctrl+click shows the target and the second
   * opens it.
   * @param {Term} t
   * @returns {ILinkHandler}
   */
  const oscLinks = (t) => ({
    activate(event, uri, range) {
      if (!event.ctrlKey) {
        return;
      }
      const target = canonical(uri);
      if (target === null || target.length > URL_MAX) {
        return; // S2 9.6: the server would open no such URL
      }
      if (canonical(textOf(t, range).trim()) === target || t.armed === target) {
        disarm(t);
        deps.openLink(target);
        return;
      }
      t.armed = target;
      showNotice(t, 'link', TEXTS.linkTarget(target));
    },
  });

  /**
   * @param {Term} t
   */
  const disarm = (t) => {
    t.armed = null;
    dropNotice(t, 'link');
  };

  /**
   * The text of a link's cells (one row: xterm.js 6.0.0 gives an OSC 8 link per row).
   * @param {Term} t
   * @param {IBufferRange} range 1-based, the end inclusive
   * @returns {string}
   */
  const textOf = (t, range) => {
    const line = t.xterm.buffer.active.getLine(range.start.y - 1);
    if (line === undefined || range.end.y !== range.start.y) {
      return '';
    }
    return line.translateToString(false, range.start.x - 1, range.end.x);
  };

  /**
   * Plain text that looks like a URL (S2 9.6), also across a wrapped line; a Ctrl+click opens it.
   * @param {Term} t
   */
  const plainLinks = (t) => ({
    /**
     * @param {number} y 1-based
     * @param {(links: ILink[] | undefined) => void} callback
     */
    provideLinks(y, callback) {
      const buffer = t.xterm.buffer.active;
      // The rows of the logical line that a URL touching row y can span: a URL is at most
      // URL_MAX characters, so no more rows than those are looked at, however long the line.
      const reach = Math.ceil(URL_MAX / Math.max(1, t.xterm.cols)) + 1;
      let first = y - 1;
      while (first > 0 && y - 1 - first < reach && buffer.getLine(first)?.isWrapped === true) {
        first--;
      }
      let last = y - 1;
      while (last - (y - 1) < reach && buffer.getLine(last + 1)?.isWrapped === true) {
        last++;
      }
      // The logical line's text, and for each UTF-16 unit of it the cell it is in.
      let text = '';
      /** @type {{ x: number, y: number, width: number }[]} */
      const cells = [];
      for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row);
        if (line === undefined) {
          break;
        }
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (cell === undefined) {
            break;
          }
          const width = cell.getWidth();
          if (width === 0) {
            continue; // the second half of a wide character
          }
          const chars = cell.getChars() || ' ';
          for (let unit = 0; unit < chars.length; unit++) {
            cells.push({ x, y: row, width });
          }
          text += chars;
        }
      }
      /** @type {ILink[]} */
      const links = [];
      for (const match of text.matchAll(URL_PATTERN)) {
        const url = trimUrl(match[0]);
        if (url.length > URL_MAX) {
          continue; // S2 9.6: the server would open no such URL
        }
        const start = cells[match.index];
        const end = cells[match.index + url.length - 1];
        if (start === undefined || end === undefined || start.y > y - 1 || end.y < y - 1) {
          continue;
        }
        links.push({
          range: {
            start: { x: start.x + 1, y: start.y + 1 },
            end: { x: end.x + end.width, y: end.y + 1 },
          },
          text: url,
          activate(event) {
            if (event.ctrlKey) {
              disarm(t);
              deps.openLink(url);
            }
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });

  // --- notices ----------------------------------------------------------------------------------

  /**
   * A notice over the terminal `t` (text, never markup), with a dismiss button unless it follows
   * the terminal's state.
   * @param {Term} t
   * @param {string} kind
   * @param {string} text
   * @param {boolean} [dismissable]
   */
  const showNotice = (t, kind, text, dismissable = true) => {
    const existing = t.notices.get(kind);
    if (existing !== undefined) {
      existing.text = text;
      existing.confirmed = true;
      const label = existing.element.firstElementChild;
      if (label !== null) {
        label.textContent = text;
      }
      return;
    }
    const bar = element('div', 'tv-bar');
    bar.dataset['kind'] = kind;
    const label = element('span', 'tv-bar-text');
    label.textContent = text;
    const close = /** @type {HTMLButtonElement} */ (element('button', 'tv-bar-close'));
    close.type = 'button';
    close.title = 'Dismiss';
    close.textContent = '×';
    // A mouse click leaves the keyboard where it was (the terminal); from the keyboard it works.
    close.addEventListener('mousedown', (event) => event.preventDefault());
    close.addEventListener('click', () => {
      const held = bar.contains(document.activeElement);
      if (kind === 'gap' || kind === 'newer-keeper') {
        // The text the bar shows now (a later notice of its kind may have replaced the first).
        t.dismissed.add(`${kind}:${t.notices.get(kind)?.text ?? text}`);
      }
      if (kind === 'link') {
        t.armed = null;
      }
      dropNotice(t, kind);
      if (held && t === shown) {
        t.xterm.focus(); // this handler hid what had the keyboard: the terminal takes it
      }
    });
    bar.append(label);
    if (dismissable) {
      bar.append(close);
    }
    t.bars.append(bar);
    t.notices.set(kind, { element: bar, text, confirmed: true });
  };

  /**
   * @param {Term} t
   * @param {string} kind
   */
  const dropNotice = (t, kind) => {
    t.notices.get(kind)?.element.remove();
    t.notices.delete(kind);
  };

  /**
   * The bars that follow the terminal's state: reconnecting (S2 7.8), "sized by another window"
   * (S2 8.2.6), and dimmed when its program is over.
   * @param {Term} t
   */
  const paint = (t) => {
    if (t.state === 'reconnecting') {
      showNotice(t, 'reconnecting', TEXTS.reconnecting, false);
    } else {
      dropNotice(t, 'reconnecting');
    }
    t.hint.hidden = t.owner || t.over;
    t.box.classList.toggle('over', t.over);
  };

  /**
   * The program is over (S2 7.8): the last screen dimmed; it takes no input.
   * @param {Term} t
   */
  const end = (t) => {
    if (!t.over) {
      t.over = true;
      t.xterm.options.disableStdin = true;
    }
    paint(t);
  };

  /**
   * After a snap the terminal's first record ends its replay: a gap or newer-keeper notice the
   * server did not repeat after the snap no longer holds.
   * @param {Term} t
   */
  const recordCame = (t) => {
    if (!t.replay) {
      return;
    }
    t.replay = false;
    for (const kind of ['gap', 'newer-keeper']) {
      if (t.replayed.has(kind)) {
        continue;
      }
      // Not repeated after the snapshot: it no longer holds, and a dismissal of it is forgotten,
      // so that the next such notice shows (it is a new occasion).
      if (t.notices.get(kind)?.confirmed === false) {
        dropNotice(t, kind);
      }
      for (const key of [...t.dismissed]) {
        if (key.startsWith(`${kind}:`)) {
          t.dismissed.delete(key);
        }
      }
    }
  };

  // --- sizes (S2 8.2.6) -------------------------------------------------------------------------

  /**
   * What the terminal's area holds at its font, or null when it cannot be measured (not shown):
   * its box measured as the fit addon measures it (the element xterm.js is in, whole pixels),
   * then `fitInside` — a function of the box, the pixel ratio, the cell and the style sheet's
   * room around the text only. The terminal takes
   * the page's font size first (style.css `--term-font-size`), so that the proposal and its
   * screen are measured at the same font, also after the size changed. Nothing in stage A
   * changes it; a font-size setting, if one ever comes, needs its own trigger and must reach
   * every open terminal at once (this reaches one terminal when it is next measured).
   * @param {Term} t
   * @returns {{ cols: number, rows: number } | null}
   */
  const propose = (t) => {
    const box = t.xterm.element?.parentElement;
    if (box === null || box === undefined) {
      return null;
    }
    const style = getComputedStyle(box);
    const width = parseInt(style.getPropertyValue('width'), 10);
    const height = parseInt(style.getPropertyValue('height'), 10);
    const size = fontSize();
    if (t.xterm.options.fontSize !== size) {
      t.xterm.options.fontSize = size;
    }
    const cell = measureCell(size);
    if (!(width > 0) || !(height > 0) || cell === null) {
      return null; // hidden, or no font yet
    }
    return fitInside(width, height, cell, t.xterm.element ?? root);
  };

  /**
   * Sends `resize` for the shown terminal when its area holds another size than this page last
   * proposed.
   */
  const refit = () => {
    const t = shown;
    if (t === null || t.asked) {
      return;
    }
    const size = propose(t);
    if (size !== null && !sameSize(size, t.proposed)) {
      t.proposed = size;
      deps.send({ t: 'resize', term: t.id, ...size });
    }
  };

  /**
   * The canvas `measureCell` measures with (made at its first call).
   * @type {OffscreenCanvasRenderingContext2D | null | undefined}
   */
  let canvas;
  /**
   * The cell of the terminals' font in device pixels at `size` px, measured as xterm.js 6.0.0
   * measures it: the canvas's metrics of `W` at the font (else 32 × W in a span); the height
   * rounded up to whole device pixels. Null while it cannot be measured.
   * @param {number} [size]
   * @returns {{ width: number, height: number, ratio: number } | null}
   */
  const measureCell = (size = fontSize()) => {
    let width = 0;
    let height = 0;
    try {
      canvas ??= new OffscreenCanvas(100, 100).getContext('2d');
      const context = canvas;
      if (context !== null) {
        context.font = `${size}px ${FONT}`;
        const metrics = context.measureText('W');
        if ('fontBoundingBoxAscent' in metrics && 'fontBoundingBoxDescent' in metrics) {
          width = metrics.width;
          height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
        }
      }
    } catch {
      // no canvas: the span below
    }
    if (!(width > 0 && height > 0)) {
      const probe = element('span', 'tv-measure');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;line-height:normal;font-family:${FONT};font-size:${size}px`;
      probe.textContent = 'W'.repeat(32);
      document.body.append(probe);
      width = probe.offsetWidth / 32;
      height = probe.offsetHeight;
      probe.remove();
    }
    if (!(width > 0 && height > 0)) {
      return null;
    }
    const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
    return { width: width * ratio, height: Math.ceil(height * ratio), ratio };
  };

  // The colours follow the page's light or dark scheme (style.css, terminal-view.css): the
  // system's, and the title bar's switch, which sets <html data-theme> (web/theme.js; follow-up
  // F13) —, and the scheme's colour theme, <html data-palette-light> and <html data-palette-dark>
  // (the title bar's second switch). Every terminal is repainted, a hidden one too.
  const retheme = () => {
    for (const t of terms.values()) {
      t.xterm.options.theme = theme();
    }
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  new MutationObserver(retheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette-light', 'data-palette-dark'],
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let refitTimer = null;
  new ResizeObserver(() => {
    if (refitTimer !== null) {
      clearTimeout(refitTimer);
    }
    refitTimer = setTimeout(() => {
      refitTimer = null;
      refit();
    }, REFIT_MS);
  }).observe(root);

  // --- attaching (S2 12.6) ----------------------------------------------------------------------

  /**
   * A new terminal, attached at once in attached(); its `attach` goes out once the caller's
   * render is done (a microtask), so that the proposal is measured with the header app.js puts
   * above the terminal after `show`.
   * @param {TerminalPayload} payload
   * @returns {Term}
   */
  const attach = (payload) => {
    const t = create(payload);
    terms.set(t.id, t);
    t.asked = true;
    queueMicrotask(() => {
      if (terms.get(t.id) !== t) {
        return; // detached meanwhile
      }
      const size = (t === shown ? propose(t) : null) ?? { cols: payload.cols, rows: payload.rows };
      t.proposed = size;
      deps.send({ t: 'attach', term: t.id, ...size });
    });
    return t;
  };

  /**
   * Detaches every terminal beyond the eight most recently shown, and while the window is hidden
   * every one but the shown: all in this call (contract 2.9), each dropped from attached() before
   * its `detach` is sent.
   */
  const trim = () => {
    const keep = hidden ? (shown === null ? [] : [shown.id]) : order.slice(0, MAX_ATTACHED);
    const gone = order.filter((id) => !keep.includes(id));
    order = order.filter((id) => keep.includes(id));
    for (const id of gone) {
      const t = terms.get(id);
      terms.delete(id);
      if (t !== undefined) {
        if (t.channel !== null && byChannel.get(t.channel) === t) {
          byChannel.delete(t.channel);
        }
        t.xterm.dispose();
        t.box.remove();
      }
      deps.send({ t: 'detach', term: id });
    }
  };

  /**
   * @param {Term | null} t
   */
  const setShown = (t) => {
    if (shown !== t) {
      find.close(false);
    }
    shown = t;
    for (const other of terms.values()) {
      other.box.hidden = other !== t;
    }
  };

  // --- find (S2 9.7) ----------------------------------------------------------------------------

  /** The find bar over the shown terminal (`@xterm/addon-search`). */
  function findBar() {
    const bar = element('div', 'tv-find');
    bar.hidden = true;
    const input = /** @type {HTMLInputElement} */ (element('input', 'tv-find-input'));
    input.type = 'text';
    input.placeholder = 'Find';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Find in the scrollback');
    const count = element('span', 'tv-find-count');
    /**
     * @param {string} text
     * @param {string} title
     * @param {() => void} action
     */
    const button = (text, title, action) => {
      const made = /** @type {HTMLButtonElement} */ (element('button', 'tv-find-button'));
      made.type = 'button';
      made.textContent = text;
      made.title = title;
      made.addEventListener('mousedown', (event) => event.preventDefault());
      made.addEventListener('click', action);
      return made;
    };
    const decorations = {
      matchBackground: '#f2d675',
      matchOverviewRuler: '#f2d675',
      activeMatchBackground: '#f59e3b',
      activeMatchColorOverviewRuler: '#f59e3b',
    };
    /** @type {{ dispose(): void } | null} */
    let results = null;
    /**
     * @param {boolean} forward
     * @param {boolean} incremental
     */
    const search = (forward, incremental) => {
      const t = shown;
      if (t === null || input.value === '') {
        t?.search.clearDecorations();
        count.textContent = '';
        return;
      }
      const options = { decorations, incremental };
      const found = forward
        ? t.search.findNext(input.value, options)
        : t.search.findPrevious(input.value, options);
      if (!found) {
        count.textContent = TEXTS.noMatch;
      }
    };
    /** @param {boolean} giveBack whether the terminal takes the keyboard (the bar had it) */
    const close = (giveBack) => {
      if (bar.hidden) {
        return;
      }
      const held = bar.contains(document.activeElement);
      bar.hidden = true;
      results?.dispose();
      results = null;
      for (const t of terms.values()) {
        t.search.clearDecorations();
      }
      if (giveBack && held) {
        shown?.xterm.focus();
      }
    };
    input.addEventListener('input', () => search(true, true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        search(!event.shiftKey, false);
      } else if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        close(true);
      }
    });
    bar.append(
      input,
      count,
      button('↑', 'Previous match (Shift+Enter)', () => search(false, false)),
      button('↓', 'Next match (Enter)', () => search(true, false)),
      button('×', 'Close (Esc)', () => close(true)),
    );
    return {
      element: bar,
      open() {
        const t = shown;
        if (t === null) {
          return;
        }
        if (bar.hidden) {
          bar.hidden = false;
          results = t.search.onDidChangeResults(({ resultIndex, resultCount }) => {
            count.textContent =
              resultCount === 0 ? TEXTS.noMatch : TEXTS.matches(resultIndex, resultCount);
          });
          const selected = t.xterm.getSelection();
          if (selected !== '' && !selected.includes('\n')) {
            input.value = selected;
          }
        }
        input.focus();
        input.select();
        if (input.value !== '') {
          search(true, true);
        }
      },
      close,
    };
  }

  // --- contract 2.9 -----------------------------------------------------------------------------

  return {
    /** @param {TerminalPayload | null} payload */
    show(payload) {
      if (payload === null) {
        setShown(null);
        if (hidden) {
          trim();
        }
        return;
      }
      let t = terms.get(payload.id);
      if (t === undefined) {
        setShown(null);
        t = attach(payload);
      }
      order = [payload.id, ...order.filter((id) => id !== payload.id)];
      setShown(t);
      t.state = payload.state;
      t.owner = payload.ownsSize;
      if (OVER.has(payload.state)) {
        end(t);
      }
      paint(t);
      trim();
      queueMicrotask(refit); // once the caller's render is done, as for an attach
    },
    /** @param {SnapMessage} msg */
    snap(msg) {
      const t = terms.get(msg.term);
      if (t === undefined) {
        return;
      }
      if (t.channel !== null && byChannel.get(t.channel) === t) {
        byChannel.delete(t.channel);
      }
      const other = byChannel.get(msg.ch);
      if (other !== undefined && other !== t) {
        other.channel = null;
      }
      byChannel.set(msg.ch, t);
      t.channel = msg.ch;
      const asked = t.asked;
      t.asked = false;
      t.replay = true;
      t.replayed.clear();
      disarm(t);
      for (const notice of t.notices.values()) {
        notice.confirmed = false;
      }
      // What waits of the stream before this snap is in it already (S2 8.2.4): dropped.
      t.waiting = [];
      t.waitingSize = 0;
      t.refreshing = false;
      const { xterm } = t;
      // S2 8.2.4: the terminal starts over at the snapshot's size, after what was written before
      // it, with the parser back in its ground state (CAN ends any sequence a stream that was cut
      // left open).
      write(t, '\x18', {
        counted: false,
        then: () => {
          xterm.reset();
          xterm.resize(msg.cols, msg.rows);
        },
      });
      write(t, msg.data, { counted: false });
      // The server sizes the terminal to the proposal it has of this page's: the one of this
      // view's own attach, or the list's size app.js proposed after a reconnect — which may also
      // stand for an attach of the view's that never reached the server (sent while the
      // connection was down). So the view's own size goes out whenever the snap's differs.
      const size = t === shown ? propose(t) : null;
      if (size !== null && !sameSize(size, msg)) {
        t.proposed = size;
        deps.send({ t: 'resize', term: t.id, ...size });
      } else if (!asked) {
        t.proposed = { cols: msg.cols, rows: msg.rows };
      }
    },
    /**
     * @param {number} channel
     * @param {Uint8Array} bytes
     */
    output(channel, bytes) {
      const t = byChannel.get(channel);
      if (t === undefined || t.refreshing) {
        return; // unknown, or a fresh snapshot is coming that holds it
      }
      recordCame(t);
      write(t, bytes);
    },
    /** @param {SizeMessage} msg */
    size(msg) {
      const t = terms.get(msg.term);
      if (t === undefined) {
        return;
      }
      recordCame(t);
      // In stream order: after the output written before it.
      write(t, '', { then: () => t.xterm.resize(msg.cols, msg.rows) });
      t.owner = msg.owner;
      paint(t);
    },
    /** @param {ExitMessage} msg */
    exit(msg) {
      const t = terms.get(msg.term);
      if (t === undefined) {
        return;
      }
      // A program that ended inside a synchronized update leaves mode 2026 set (the snapshot
      // keeps it), and xterm.js would hold the screen back for a second: nothing more comes, so
      // the page ends it (notes for task 28). The exit follows every snap of an ended terminal.
      write(t, '\x1b[?2026l');
      end(t);
    },
    /**
     * @param {string} term
     * @param {'gap' | 'input-full' | 'newer-keeper'} kind
     * @param {string} text
     */
    notice(term, kind, text) {
      const t = terms.get(term);
      if (t === undefined) {
        return;
      }
      if (kind === 'input-full') {
        t.refusedAt = performance.now();
        showNotice(t, kind, TEXTS.inputFull);
        return;
      }
      const existing = t.notices.get(kind);
      const key = `${kind}:${text}`;
      if (t.replay) {
        t.replayed.add(kind);
        if (existing === undefined && t.dismissed.has(key)) {
          return; // the server repeats it after every snap: once per terminal is enough
        }
      } else {
        t.dismissed.delete(key); // in the stream: a new occasion
      }
      showNotice(t, kind, text);
    },
    find() {
      find.open();
    },
    copy() {
      const t = shown;
      if (t !== null && t.xterm.hasSelection()) {
        navigator.clipboard.writeText(t.xterm.getSelection()).catch(() => {});
      }
    },
    pasteRaw() {
      if (shown !== null) {
        sendInput(shown, '\x16', false);
        shown.xterm.scrollToBottom();
      }
    },
    focus() {
      shown?.xterm.focus();
    },
    /** @param {boolean} isHidden */
    setHidden(isHidden) {
      if (isHidden === hidden) {
        return;
      }
      hidden = isHidden;
      trim();
    },
    /** @returns {string[]} */
    attached: () => [...order],
    /**
     * What fits (an optional member of contract 2.9, for app.js's `area()`): the columns and
     * rows a terminal of this view shows in a terminal area (`#terminal`'s box) of `width` ×
     * `height` CSS pixels — by the same rule as every proposal of the view (`fitInside`: the
     * room around the text and the scroll bar counted out), so that a terminal opened at it is not resized
     * after its start — or null while no cell can be measured
     * or for an area that is not a positive size. The numbers are always whole and at least 1
     * (app.js sends them to the server, which takes nothing else), whatever it is given.
     * @param {number} width
     * @param {number} height
     * @returns {{ cols: number, rows: number } | null}
     */
    fits(width, height) {
      if (!(width > 0) || !(height > 0)) {
        return null;
      }
      const cell = measureCell();
      if (cell === null) {
        return null;
      }
      return fitInside(Math.floor(width), Math.floor(height), cell, shown?.xterm.element ?? root);
    },
  };
}

/**
 * What a terminal box of `width` × `height` CSS pixels holds (`propose` and `fits`, so that the two
 * cannot count differently): `fitIn` for the area inside the room the style sheet keeps around
 * the text (`padding`, as it styles `element`) and the scroll bar's room.
 * @param {number} width
 * @param {number} height
 * @param {{ width: number, height: number, ratio: number }} cell
 * @param {Element} element
 * @returns {{ cols: number, rows: number }}
 */
function fitInside(width, height, cell, element) {
  const room = padding(element);
  return fitIn(width - room.left - room.right - SCROLL_BAR, height - room.top - room.bottom, cell);
}

/**
 * The room between the terminal's text and its box (F2): terminal-view.css's `--tv-pad-top`,
 * `--tv-pad-right`, `--tv-pad-bottom` and `--tv-pad-left` as they style `element` (xterm.js's
 * element, or the view's root while no terminal is shown), read at every measure, so that the
 * room counted is the room drawn (one source). The style sheet registers them as lengths: their
 * computed value is in px whatever unit or ancestor sets them. The top, left and bottom ones are
 * the padding of xterm.js's element; the right one is room left between the text and the scroll
 * bar's. A value that is no length of 0 or more counts as 0, as it draws none.
 * @param {Element} element
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
function padding(element) {
  const style = getComputedStyle(element);
  /** @param {string} side */
  const px = (side) => {
    const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(style.getPropertyValue(`--tv-pad-${side}`));
    return match === null ? 0 : Number(match[1]);
  };
  return { top: px('top'), right: px('right'), bottom: px('bottom'), left: px('left') };
}

/**
 * The view's one rule of what fits (S2 8.2.6; `fits` and every proposal): the most columns and
 * rows whose screen fits `across` × `down` CSS pixels, the screen being what xterm.js 6.0.0 makes
 * of it — cell × count in device pixels, rounded to whole CSS pixels. It does not depend on the
 * terminal's current size, as the fit addon's answer does (it divides by the cell of the current
 * size, so at some widths no size proposes itself: 104 columns propose 103 and 103 propose 104,
 * and a terminal shown there was resized every second; M4 of task 28's review). Whole numbers,
 * clamped to S2 8.2.6's limits and to at least 2 columns and 1 row, whatever it is given.
 * @param {number} across
 * @param {number} down
 * @param {{ width: number, height: number, ratio: number }} cell
 * @returns {{ cols: number, rows: number }}
 */
function fitIn(across, down, cell) {
  /**
   * @param {number} room
   * @param {number} unit device pixels
   * @param {number} least
   * @param {number} most
   */
  const largest = (room, unit, least, most) => {
    const screen = (/** @type {number} */ n) => Math.round((unit * n) / cell.ratio);
    if (!Number.isFinite(room)) {
      return room > 0 ? most : least;
    }
    let n = Math.max(least, Math.min(most, Math.floor((room * cell.ratio) / unit)));
    // From the estimate up: floor(room / cell) cells are at most `room` wide before the rounding,
    // so for a whole room the estimate fits; only more can.
    while (n < most && screen(n + 1) <= room) n++;
    return n;
  };
  return {
    cols: largest(across, cell.width, 2, MAX_COLS),
    rows: largest(down, cell.height, 1, MAX_ROWS),
  };
}

/**
 * @param {string} tag
 * @param {string} className
 * @returns {HTMLElement}
 */
function element(tag, className) {
  const made = document.createElement(tag);
  made.className = className;
  return made;
}

/**
 * @param {{ cols: number, rows: number }} a
 * @param {{ cols: number, rows: number } | null} b
 * @returns {boolean}
 */
function sameSize(a, b) {
  return b !== null && a.cols === b.cols && a.rows === b.rows;
}

/**
 * The URL as the WHATWG parser writes it (what the server opens, S2 9.6), or null for one that is
 * not http or https.
 * @param {string} text
 * @returns {string | null}
 */
function canonical(text) {
  if (!URL.canParse(text)) {
    return null;
  }
  const url = new URL(text);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/**
 * A URL found in text without the punctuation that ends a sentence after it, and without a
 * closing bracket it does not open. Linear: the brackets are counted once.
 * @param {string} url
 * @returns {string}
 */
function trimUrl(url) {
  let parens = 0;
  let brackets = 0;
  for (const char of url) {
    if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }
  // parens < 0: more `)` than `(` in what is left (the same for brackets).
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] ?? '';
    if (last === ')' && parens < 0) {
      parens++;
    } else if (last === ']' && brackets < 0) {
      brackets++;
    } else if (!".,;:!?'".includes(last)) {
      break;
    }
    end--;
  }
  return url.slice(0, end);
}

/** The terminal's font size: the page's (style.css `--term-font-size`), which app.js measures. */
function fontSize() {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--term-font-size'),
  );
  return Number.isFinite(value) && value > 0 ? value : 14;
}

/** The ANSI colours' names in xterm.js's theme, as terminal-view.css names its variables. */
const COLOURS = /** @type {const} */ ([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]);

/**
 * The terminal's colours from the page's styles: foreground and background as app.js reports
 * them to the server (`start.theme`, style.css), the ANSI colours and the cursor from
 * terminal-view.css.
 * @returns {ITheme}
 */
function theme() {
  const style = getComputedStyle(document.documentElement);
  /** @param {string} name */
  const read = (name) => style.getPropertyValue(name).trim();
  /** @type {ITheme} */
  const made = {};
  /** @type {[keyof ITheme & string, string][]} */
  const named = [
    ['foreground', '--term-fg'],
    ['background', '--term-bg'],
    ['cursor', '--tv-cursor'],
    ['cursorAccent', '--term-bg'],
    ['selectionBackground', '--tv-selection'],
    ...COLOURS.map(
      (name) =>
        /** @type {[keyof ITheme & string, string]} */ ([
          name,
          `--tv-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
        ]),
    ),
  ];
  for (const [key, variable] of named) {
    const value = read(variable);
    if (value !== '') {
      Object.assign(made, { [key]: value });
    }
  }
  return made;
}
