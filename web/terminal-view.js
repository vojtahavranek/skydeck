// The terminal view (S2 8.2.4, 8.2.6, 9, 12.6, 15.4; plan task 28, contract 2.9): one xterm.js
// 6.0.0 per attached terminal, with the vendored addons, fed by the snapshot and the stream of
// S2 8.2.4 and sized by the server only (S2 8.2.6: the fit addon only computes the proposal sent
// in `attach` and `resize`). The page's terminal answers no query (S2 9.3), maps the keys of S2
// 9.1, writes the clipboard only for the shown terminal of a focused window (S2 9.5), opens links
// only on a Ctrl+click and through the server (S2 9.6), finds in the scrollback (S2 9.7) and
// ignores the program's window title (S2 15.4).
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
import { FitAddon } from '../vendor/xterm/addon-fit/lib/addon-fit.mjs';
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
/** The font list of the plan (task 28; check W9). */
const FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Symbol", monospace';
/** A layout change is proposed to the server once it has settled this long. */
const REFIT_MS = 100;
/** `input-full` goes once input sent this long ago had no `input-full` (the server answers at once). */
const TAKEN_MS = 1000;
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
    'this terminal is not taking input at the moment: what you typed was not sent to the program',
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
 * @property {FitAddon} fit
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
 * @property {Set<string>} dismissed the gap and newer-keeper texts the user dismissed
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
      fit: new FitAddon(),
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
      // The width addon uses the unicode API, which xterm.js 6.0.0 still marks as proposed.
      allowProposedApi: true,
      // xterm.js's own log quotes the program's output (ruled, task 33): nothing in the console.
      logLevel: 'off',
      linkHandler: oscLinks(t),
    });
    t.xterm = xterm;
    xterm.loadAddon(new UnicodeGraphemesAddon());
    xterm.loadAddon(t.fit);
    xterm.loadAddon(t.search);
    swallowQueries(t);
    xterm.registerLinkProvider(plainLinks(t));
    xterm.attachCustomKeyEventHandler((event) => keyEvent(t, event));
    xterm.onData((data) => sendInput(t, data, false));
    xterm.onBinary((data) => sendInput(t, data, true));
    xterm.open(screen);
    // xterm.js 6.0.0 sends a paste but does not cancel it, so the browser also puts the pasted
    // text into xterm.js's hidden textarea, after xterm.js has emptied it: a large paste then
    // holds megabytes there and makes the page slow at everything it does after. The page
    // cancels the paste once xterm.js has taken it (its listener on the textarea runs first).
    xterm.textarea?.addEventListener('paste', (event) => event.preventDefault());
    return t;
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
      if (target === null) {
        return;
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
      let first = y - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped === true) {
        first--;
      }
      let last = y - 1;
      while (buffer.getLine(last + 1)?.isWrapped === true) {
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
        t.dismissed.add(text);
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
    for (const [kind, notice] of [...t.notices]) {
      if ((kind === 'gap' || kind === 'newer-keeper') && !notice.confirmed) {
        dropNotice(t, kind);
      }
    }
  };

  // --- sizes (S2 8.2.6) -------------------------------------------------------------------------

  /**
   * What the terminal's area holds at its font (the fit addon), or null when it cannot be
   * measured (not shown).
   * @param {Term} t
   * @returns {{ cols: number, rows: number } | null}
   */
  const propose = (t) => {
    const dims = t.fit.proposeDimensions();
    if (dims === undefined || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
      return null;
    }
    return {
      cols: Math.max(1, Math.min(MAX_COLS, dims.cols)),
      rows: Math.max(1, Math.min(MAX_ROWS, dims.rows)),
    };
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

  // The colours follow the page's light or dark scheme (style.css, terminal-view.css).
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const t of terms.values()) {
      t.xterm.options.theme = theme();
    }
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
      disarm(t);
      for (const notice of t.notices.values()) {
        notice.confirmed = false;
      }
      const { xterm } = t;
      // S2 8.2.4: the terminal starts over at the snapshot's size, after what was written before
      // it (writes are queued), with the parser back in its ground state (CAN ends any sequence a
      // stream that was cut left open).
      xterm.write('\x18', () => {
        xterm.reset();
        xterm.resize(msg.cols, msg.rows);
      });
      xterm.write(msg.data);
      // A snap the page did not ask for (a reconnect, a page that fell behind): the server has
      // another proposal of this page's, so it gets this page's own when it differs.
      const size = t === shown ? propose(t) : null;
      if (size !== null && !sameSize(size, asked ? t.proposed : msg)) {
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
      if (t === undefined) {
        return;
      }
      recordCame(t);
      t.xterm.write(bytes);
    },
    /** @param {SizeMessage} msg */
    size(msg) {
      const t = terms.get(msg.term);
      if (t === undefined) {
        return;
      }
      recordCame(t);
      // In stream order: after the output written before it.
      t.xterm.write('', () => t.xterm.resize(msg.cols, msg.rows));
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
      t.xterm.write('\x1b[?2026l');
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
      if (t.replay && existing === undefined && t.dismissed.has(text)) {
        return; // the server repeats it after every snap: once per terminal is enough
      }
      if (!t.replay) {
        t.dismissed.delete(text); // a new occasion
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
 * closing bracket it does not open.
 * @param {string} url
 * @returns {string}
 */
function trimUrl(url) {
  /** @param {string} text @param {string} char */
  const count = (text, char) => text.split(char).length - 1;
  let end = url.length;
  while (end > 0) {
    const text = url.slice(0, end);
    const last = text[end - 1] ?? '';
    const unopened =
      (last === ')' && count(text, ')') > count(text, '(')) ||
      (last === ']' && count(text, ']') > count(text, '['));
    if (!".,;:!?'".includes(last) && !unopened) {
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
 * them to the server (`start.theme`, style.css), the ANSI colours from terminal-view.css.
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
    ['cursor', '--term-fg'],
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
