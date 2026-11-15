// The restore banner (S2 12.7; plan C task 75, C9, C10, C21): at the top of the list zone, the
// offer the view model sends — the sessions of the latest earlier boot with their checkboxes,
// "Restore <n>" and "Not now" — and under it the report of every restore run, whoever asked for
// it. The page decides no rule (S2 4.3): whether the offer is shown, what it offers and whether a
// restore runs are the server's (`render(banner)`); this module keeps only the ticks and the
// report.
//
// - The offer is drawn while the banner is not null and `shown`; while `running` its checkboxes
//   are disabled and `A restore is running.` stands in place of the buttons. A banner that only
//   says a restore runs (no boot, no entries) shows that line alone.
// - The ticks start from each entry's `preselected` and stay across banners of the same boot: an
//   entry that left is dropped, a new one takes its `preselected`; another boot starts them again.
//   A banner without a boot (null, or one that only says a restore runs) leaves them as they are.
// - "Restore <k>" sends `act restore` with the ticked ids in the banner's order (each once),
//   disabled at 0 and while a restore runs; "Not now" sends `act dismiss-restore` with the boot.
//   Each acts once: not while its own act waits, not on a held Enter's auto-repeat (C10), not on
//   the second click of a double click (review 2 of task 38). A
//   refused result is the banner's line (the key bar's when the offer is not drawn); a new act,
//   another boot, or a run that begins or ends clears it.
// - The report (C10): the `restore-progress` lines as they come, the last 200, drawn while it
//   holds lines whatever the banner says. It ends at its `restore finished:` line, or — when that
//   line never came (the connection dropped, the server stopped, WSL restarted) — at the first
//   `list` that says no restore runs, with one last line of its own (ruled on review 2, S1); a
//   `list` that says a restore runs never ends it. An ended report has a × that removes it, and
//   the next line starts a new one.
// - The heading's `today` and `yesterday` follow the page's clock: a timer draws the heading again
//   while it is shown, writing only when its text changed (ruled on review 2, S2).
//
// Keyboard (S2 12.9): this module never calls focus(). Its controls take no keyboard on a mouse
// click (their mousedown's default is prevented), so the keyboard stays with the list or the
// terminal; Tab and Space work on them as the browser's own. app.js gives the keyboard back to
// the zone when a control that had it goes away. Every text — a title, a report line, a refusal —
// reaches the DOM through textContent.

/** @import { BannerEntryPayload, BannerPayload, ResultMessage } from '../src/window/protocol.ts' */
import { bannerHeading, entryText, restoreLabel } from './banner-text.js';

/**
 * @typedef {object} BannerDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 *   app.js's: it adds `t` and `id`
 * @property {(text: string) => void} say a line in the key bar
 * @property {() => string} timeZone the page's time zone (an IANA name, or `UTC`)
 */

/** C10: the report keeps at most this many lines, the last ones. */
const REPORT_LINES = 200;
/** The line that ends every run (plan C6): the report's only boundary. */
const FINISHED = 'restore finished:';
const RUNNING = 'A restore is running.';
/** The last line of a report whose `restore finished:` line never came (ruled on review 2, S1). */
const NOT_ARRIVED = 'the end of this report did not arrive; the list shows what started';
/** How often the heading is drawn again, for its `today` and `yesterday` (S2). */
const HEADING_TICK_MS = 30_000;

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/**
 * Sets `text` only when it differs, so that a selection in an unchanged text survives.
 * @param {HTMLElement} target
 * @param {string} text
 */
function setText(target, text) {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

/**
 * @param {HTMLElement} target
 * @param {boolean} hidden
 */
function setHidden(target, hidden) {
  if (target.hidden !== hidden) {
    target.hidden = hidden;
  }
}

/**
 * A held Enter never presses a button again: its auto-repeats are cancelled (the page's rule for
 * its buttons, cards.js). A fresh press acts.
 * @param {KeyboardEvent} event
 */
function refuseHeldEnter(event) {
  if (event.repeat && event.key === 'Enter') {
    event.preventDefault();
  }
}

/**
 * The banner as this page can use it: null for anything that is no banner object; entries kept
 * only when they are objects with a string `sessionId`, each session once.
 * @param {unknown} value
 * @returns {BannerPayload | null}
 */
function bannerOf(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const banner = /** @type {Partial<BannerPayload>} */ (value);
  const seen = new Set();
  /** @type {BannerEntryPayload[]} */
  const entries = [];
  for (const entry of Array.isArray(banner.entries) ? banner.entries : []) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.sessionId === 'string' &&
      !seen.has(entry.sessionId)
    ) {
      seen.add(entry.sessionId);
      entries.push({
        ...entry,
        shortId: String(entry.shortId ?? ''),
        title: String(entry.title ?? ''),
      });
    }
  }
  return {
    bootId: typeof banner.bootId === 'string' ? banner.bootId : null,
    lastActivityNs: typeof banner.lastActivityNs === 'string' ? banner.lastActivityNs : null,
    entries,
    shown: banner.shown === true,
    running: banner.running === true,
  };
}

/**
 * @param {HTMLElement} root `#banner` of index.html, in the list zone before `#list`
 * @param {BannerDeps} deps
 */
export function createBanner(root, deps) {
  const offer = element('div', 'banner-offer');
  const heading = element('div', 'banner-heading');
  const entriesBox = element('div', 'banner-entries');
  const actions = element('div', 'banner-actions');
  const restore = /** @type {HTMLButtonElement} */ (
    element('button', 'banner-button primary banner-restore')
  );
  restore.type = 'button';
  const notNow = /** @type {HTMLButtonElement} */ (
    element('button', 'banner-button banner-not-now', 'Not now')
  );
  notNow.type = 'button';
  const running = element('span', 'banner-running', RUNNING);
  const message = element('div', 'banner-message');
  actions.append(restore, notNow, running);
  offer.append(heading, entriesBox, actions, message);

  const report = element('div', 'banner-report');
  const reportLines = element('div', 'banner-report-lines');
  const reportClose = /** @type {HTMLButtonElement} */ (
    element('button', 'banner-report-close', '×')
  );
  reportClose.type = 'button';
  reportClose.title = 'Remove the report';
  report.append(reportLines, reportClose);
  root.replaceChildren(offer, report);

  // The page's chrome takes no keyboard on a mouse click (stage A's rule): a click on a checkbox,
  // its label or a button leaves the keyboard where it was. The heading and the report's lines
  // stay selectable text.
  root.addEventListener('mousedown', (event) => {
    if (event.target instanceof Element && event.target.closest('button, label, input') !== null) {
      event.preventDefault();
    }
  });
  for (const button of [restore, notNow, reportClose]) {
    button.addEventListener('keydown', refuseHeldEnter);
  }

  /** @type {BannerPayload | null} */
  let banner = null;
  /** The boot the ticks are of ('' before any). */
  let tickedBoot = '';
  /** Each offered session's tick. @type {Map<string, boolean>} */
  let ticks = new Map();
  /** Each entry's label, by session, kept across renders (a checkbox keeps the keyboard). @type {Map<string, { label: HTMLElement, box: HTMLInputElement, text: HTMLElement }>} */
  const rows = new Map();
  let restoreWaits = false;
  let dismissWaits = false;
  /** The last refusal, shown as the banner's line ('' when none). */
  let refusal = '';
  /** The report's lines, and whether its last run has finished (its × is shown). @type {string[]} */
  let lines = [];
  let finished = false;

  /** Whether the offer is drawn: a banner that is shown, with something to show. */
  function offered() {
    return banner !== null && banner.shown && (banner.entries.length > 0 || banner.running);
  }

  /** @returns {string[]} the ticked sessions, in the banner's order */
  function ticked() {
    return (banner?.entries ?? [])
      .filter((entry) => ticks.get(entry.sessionId) === true)
      .map((entry) => entry.sessionId);
  }

  /**
   * @param {BannerEntryPayload} entry
   * @returns {{ label: HTMLElement, box: HTMLInputElement, text: HTMLElement }}
   */
  function rowOf(entry) {
    let row = rows.get(entry.sessionId);
    if (row === undefined) {
      const label = element('label', 'banner-entry');
      label.dataset['id'] = entry.sessionId;
      const box = /** @type {HTMLInputElement} */ (element('input', 'banner-check'));
      box.type = 'checkbox';
      const text = element('span', 'banner-entry-text');
      label.append(box, text);
      const sessionId = entry.sessionId;
      // A click on the label's text would give its checkbox the keyboard (Chromium's activation
      // of a label focuses its control): it ticks the box without that, as a click on the box.
      label.addEventListener('click', (event) => {
        if (event.target !== box) {
          event.preventDefault();
          box.click();
        }
      });
      box.addEventListener('change', () => {
        ticks.set(sessionId, box.checked);
        draw();
      });
      row = { label, box, text };
      rows.set(sessionId, row);
    }
    return row;
  }

  function draw() {
    const shownOffer = offered();
    setHidden(offer, !shownOffer);
    if (shownOffer && banner !== null) {
      const { entries, running: runs } = banner;
      const zone = deps.timeZone();
      setHidden(heading, entries.length === 0);
      setText(heading, entries.length === 0 ? '' : bannerHeading(banner, Date.now(), zone));
      const wanted = new Set(entries.map((entry) => entry.sessionId));
      for (const [sessionId, row] of rows) {
        if (!wanted.has(sessionId)) {
          row.label.remove();
          rows.delete(sessionId);
        }
      }
      entries.forEach((entry, index) => {
        const row = rowOf(entry);
        setText(row.text, entryText(entry, zone));
        const checked = ticks.get(entry.sessionId) === true;
        if (row.box.checked !== checked) {
          row.box.checked = checked;
        }
        if (row.box.disabled !== runs) {
          row.box.disabled = runs;
        }
        if (entriesBox.children[index] !== row.label) {
          // A label already placed is moved keeping its state (a checkbox keeps the keyboard).
          const before = entriesBox.children[index] ?? null;
          if (row.label.parentNode === entriesBox && typeof entriesBox.moveBefore === 'function') {
            entriesBox.moveBefore(row.label, before);
          } else {
            entriesBox.insertBefore(row.label, before);
          }
        }
      });
      setHidden(entriesBox, entries.length === 0);
      const count = ticked().length;
      setText(restore, restoreLabel(count));
      const disabled = count === 0 || banner.running;
      if (restore.disabled !== disabled) {
        restore.disabled = disabled;
      }
      setHidden(restore, banner.running || entries.length === 0);
      setHidden(notNow, banner.running || banner.bootId === null);
      setHidden(running, !banner.running);
    }
    setText(message, refusal);
    setHidden(message, refusal === '');
    setHidden(report, lines.length === 0);
    setHidden(reportClose, !finished);
    setHidden(root, !shownOffer && lines.length === 0);
  }

  /**
   * A refused act's line: the banner's while its offer is drawn, else the key bar's.
   * @param {string} text
   */
  function refused(text) {
    if (offered()) {
      refusal = text;
      draw();
    } else {
      deps.say(text);
    }
  }

  // The second click of a double click is no second press (review 2 of task 38): its first may
  // have been answered already, and its offer is about to go.
  restore.addEventListener('click', (event) => {
    const ids = ticked();
    if (event.detail > 1 || restoreWaits || banner === null || banner.running || ids.length === 0) {
      return;
    }
    restoreWaits = true;
    refusal = '';
    draw();
    void deps.act({ kind: 'restore', sessionIds: ids }).then((result) => {
      restoreWaits = false;
      if (!result.ok) {
        refused(result.error ?? 'skydeck could not start the restore');
      }
    });
  });

  notNow.addEventListener('click', (event) => {
    const bootId = banner?.bootId ?? null;
    if (event.detail > 1 || dismissWaits || bootId === null || banner?.running === true) {
      return;
    }
    dismissWaits = true;
    refusal = '';
    draw();
    void deps.act({ kind: 'dismiss-restore', bootId }).then((result) => {
      dismissWaits = false;
      if (!result.ok) {
        refused(result.error ?? 'skydeck could not do that');
      }
    });
  });

  reportClose.addEventListener('click', () => {
    lines = [];
    finished = false;
    reportLines.replaceChildren();
    draw();
  });

  /**
   * A line at the report's end; the report's first when the last one has ended.
   * @param {string} text
   */
  function append(text) {
    if (finished) {
      lines = [];
      finished = false;
      reportLines.replaceChildren();
    }
    lines.push(text);
    reportLines.append(element('div', 'banner-report-line', text));
    while (lines.length > REPORT_LINES) {
      lines.shift();
      reportLines.firstElementChild?.remove();
    }
  }

  // S2: the heading's day words follow the clock while it is shown, also when no list comes.
  setInterval(() => {
    if (offered() && banner !== null && banner.entries.length > 0) {
      setText(heading, bannerHeading(banner, Date.now(), deps.timeZone()));
    }
  }, HEADING_TICK_MS);

  return {
    /**
     * The banner of a `list` (S2 8.2.3, plan C9): null while nothing is offered and no restore
     * runs.
     * @param {BannerPayload | null} value
     */
    render(value) {
      const next = bannerOf(value);
      if (
        refusal !== '' &&
        (next?.running !== banner?.running || (next?.bootId ?? null) !== (banner?.bootId ?? null))
      ) {
        refusal = ''; // a run began or ended, or another boot is offered: the line no longer holds
      }
      banner = next;
      if (lines.length > 0 && !finished && banner?.running !== true) {
        // S1: no restore runs, and this report's finished line never came; it ends here.
        append(NOT_ARRIVED);
        finished = true;
      }
      if (banner !== null && banner.bootId !== null) {
        const previous = tickedBoot === banner.bootId ? ticks : new Map();
        ticks = new Map(
          banner.entries.map((entry) => [
            entry.sessionId,
            previous.get(entry.sessionId) ?? entry.preselected === true,
          ]),
        );
        tickedBoot = banner.bootId;
      }
      draw();
    },

    /**
     * One report line of a restore (`notice restore-progress`, plan C6, C10).
     * @param {string} text
     */
    progress(text) {
      if (typeof text !== 'string') {
        return;
      }
      append(text);
      finished = text.startsWith(FINISHED);
      draw();
    },
  };
}
