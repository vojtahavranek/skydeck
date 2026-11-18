// The interactive list on a terminal (design 7.4): the pure model and renderer (model.ts,
// render.ts) fed with the keys the user types, and the effects `reduce` asks for carried out on the
// deck. It paints from the cache, refreshes itself and the pull requests in the background and
// repaints (design 7.3, 7.4); leaving the list never waits for `gh`.
import { isLiveFileTrusted, readLiveFiles } from '../../claude/live.ts';
import { fetchPrs, refreshPrs } from '../../github.ts';
import { SkydeckError } from '../../platform/errors.ts';
import { NS_PER_SECOND } from '../../platform/time.ts';
import type { Ns } from '../../platform/types.ts';
import type { Deck } from '../../sessions/deck.ts';
import { cleanGroup, cleanLabel } from '../../sessions/labels.ts';
import { SHORT_ID_LENGTH } from '../../sessions/list.ts';
import { loadRows } from '../../sessions/load.ts';
import {
  attachManualPr,
  detachSessionPr,
  markDone,
  markUndone,
  requireTicket,
  setGroup,
  setLabel,
  setTicket,
} from '../../sessions/meta.ts';
import { describeError } from '../../sessions/problems.ts';
import { refresh } from '../../sessions/refresh.ts';
import type { RefreshResult } from '../../sessions/refresh.ts';
import { prepareResumeById } from '../../sessions/resume-by-id.ts';
import type { PreparedLaunch } from '../../sessions/resume.ts';
import { terminalFor } from '../../terminals/index.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { Context } from '../context.ts';
import { refreshWithProgress, withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { launchWhere, whereFor } from '../launching.ts';
import { editNote } from '../notes.ts';
import { windowTimes } from '../window-open.ts';
import { requestResume, windowServer } from '../window-requests.ts';
import type { WindowServer } from '../window-requests.ts';
import { decodeKeys } from './keys.ts';
import { initModel, reduce, visibleRows, withMessage, withRows } from './model.ts';
import type { TuiEffect, TuiModel } from './model.ts';
import { render, scrolled } from './render.ts';

/**
 * The alternate screen, the cursor hidden, autowrap off: a row wider than the terminal (wide
 * characters take two cells, `clip` counts one) is cut by the terminal instead of wrapping and
 * scrolling the frame. LEAVE_SCREEN undoes all three.
 */
const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l';
const LEAVE_SCREEN = '\x1b[?7h\x1b[?25h\x1b[?1049l';
/** Cursor home, screen cleared: every frame is painted whole. */
const CLEAR = '\x1b[H\x1b[2J';
const SAVED = 'saved';
const REFRESHING = 'refreshing pull requests…';
const OWN_PREFIX = 'skydeck: ';
/** Plan C12: `R` opens no window; the user is told when none is open. */
const NO_WINDOW = 'no window is open; run skydeck window';
/** How often the list refreshes by itself while it is on screen (design 7.4). */
const BACKGROUND_REFRESH_MS = 5000;
/**
 * The background refresh loads the rows again at least this often, even when it found nothing new:
 * what the change check does not see (the time a session expires, a holder that has no live file
 * ending, Claude Code's settings) is shown a minute late at most.
 */
const FULL_RELOAD_NS = 60n * NS_PER_SECOND;

type Size = { columns: number; rows: number };
type Fetched = { fetched: number; failed: number };
/**
 * Why pull requests are fetched: `automatic` when the list opens and in the background (the due
 * ones, design 7.3), `explicit` for `r`, `attached` for the one `p` attached.
 */
type FetchKind = 'automatic' | 'explicit' | 'attached';
/** The work in the background whose failures are said once (see #backgroundOutcome). */
type BackgroundWork = 'refresh' | 'automatic fetch';
/**
 * What tells the background refresh that the rows can have changed although its own refresh saved
 * nothing: the live-session files with whether each is trusted (a status, a process that ended),
 * and the database's data version (what another skydeck saved: it may have ingested the spool
 * first, set a label, marked a session done).
 */
type ChangeMarks = { live: string; data: number };
type Change = Extract<
  TuiEffect,
  { kind: 'label' | 'group' | 'ticket' | 'done' | 'pr-add' | 'pr-rm' }
>;

/** Opens the deck (withDeck, refresh: true) and runs the list until quit or a --here resume; returns the exit code. */
export function runInteractiveList(ctx: Context): Promise<number> {
  return withDeck(ctx, { refresh: true }, (deck) => new TerminalList(ctx, deck).run());
}

/**
 * Lines that skydeck would print on stderr, as one message line: each without the "skydeck: " a
 * line on stderr needs (the list is skydeck) and without its line break, joined by two spaces.
 * Callers put the outcome first: the line is cut at the terminal's width. `render` sanitises it.
 */
function messageOf(lines: readonly string[]): string {
  return lines
    .flatMap((text) => text.split('\n'))
    .map((line) => (line.startsWith(OWN_PREFIX) ? line.slice(OWN_PREFIX.length) : line))
    .filter((line) => line !== '')
    .join('  ');
}

/**
 * When the selected session is no longer visible after new rows came in (`withRows` has moved the
 * cursor to the row that takes its place), the line that says so, naming it by its label, else
 * its short id; null when the cursor stayed.
 */
function leftNotice(before: TuiModel, after: TuiModel): string | null {
  const id = before.selected;
  if (id === null || after.selected === id) {
    return null;
  }
  const row = before.rows.get(id);
  const name = row?.label == null ? id.slice(0, SHORT_ID_LENGTH) : `"${row.label}"`;
  return `session ${name} left the list`;
}

/** Whether a refresh saved anything that a row shows. */
function savedSomething({ ingest, observed, scan }: RefreshResult): boolean {
  return ingest.ingested + observed + scan.read + scan.missing + scan.prsAttached > 0;
}

/** The message of a SkydeckError (a refusal, a usage error, a failed editor); anything else is rethrown. */
function failureMessage(error: unknown): string {
  if (error instanceof SkydeckError) {
    return error.message;
  }
  throw error;
}

/**
 * One run of the list. Every effect reads the model again after it awaited something: a fetch in
 * the background may have replaced it in the meantime.
 */
class TerminalList {
  readonly #ctx: Context;
  readonly #deck: Deck;
  #model: TuiModel;
  #size: Size;
  /** When the rows were last loaded from the deck. */
  #loadedAtNs: Ns;
  /** The change marks the last background refresh (or the opening) saw. */
  #marks: ChangeMarks;
  /**
   * A background refresh failed: it may have saved something (ingest commits before reconcile
   * runs) without loading the rows, and the next one would find nothing new; it loads them.
   */
  #reloadOwed = false;
  #onScreen = false;
  /** The frame last painted on the screen now; null when the screen holds none of ours. */
  #painted: string | null = null;
  /** A key's effect is being carried out: the background refresh waits for the next key. */
  #busy = false;
  #keys: AsyncIterableIterator<string> | null = null;
  /** Stops the timer of the background refresh. */
  #stopRefreshing: () => void = () => {};
  /** The failure of each kind of background work last said in the message line (said once). */
  readonly #failures = new Map<BackgroundWork, string>();
  /** The pull-request fetches running in the background. */
  readonly #fetches = new Set<Promise<void>>();
  /** Whether the fetch of the refresh key is one of them: `r` starts no second one meanwhile. */
  #explicitFetchRunning = false;
  /** The message `r` showed while its fetch runs, and what is left of it when the fetch ends. */
  #refreshing: { shown: string; after: string | null } | null = null;
  /** Lines for the user that the message line could not hold (a failed launch): printed when the list ends. */
  #atExit: string[] = [];
  /** Fired when the list ends or hands the terminal to `claude`: every fetch stops, saving nothing more. */
  readonly #stop = new AbortController();

  constructor(ctx: Context, deck: Deck) {
    this.#ctx = ctx;
    this.#deck = deck;
    this.#size = ctx.io.size();
    this.#marks = this.#marksNow();
    this.#loadedAtNs = this.#now();
    this.#model = scrolled(initModel(loadRows(deck), this.#loadedAtNs), this.#size);
  }

  async run(): Promise<number> {
    const stopResizing = this.#ctx.io.onResize(() => {
      this.#repaintIfResized();
    });
    // SIGTERM, SIGHUP or an outside SIGINT end the process: the terminal is given back first.
    const stopTerminating = this.#ctx.io.onTerminate(() => {
      void this.#giveBack();
    });
    try {
      // Keys first: raw mode is on before anything is painted, so a key typed now is not echoed
      // into the frame, and ctrl-c is a key, not a signal that leaves the alternate screen on.
      this.#keys = this.#ctx.io.keys();
      this.#enterScreen();
      this.#paint();
      this.#fetchDue();
      this.#stopRefreshing = this.#deck.platform.clock.every(BACKGROUND_REFRESH_MS, () => {
        this.#refreshInBackground();
      });
      for (;;) {
        const chunk: IteratorResult<string> = await (this.#keys?.next() ?? { done: true });
        if (chunk.done === true) {
          return EXIT.ok;
        }
        for (const key of decodeKeys(chunk.value)) {
          const exit = await this.#press(key);
          if (exit !== null) {
            return exit;
          }
        }
      }
    } finally {
      // Whatever ended the list (q, the end of the keys, a --here resume, an error), the terminal
      // is given back as it was. The fetches are stopped, not waited for: an aborted one ends at
      // once and saves nothing, and the store stays open until it has.
      stopResizing();
      stopTerminating();
      await this.#giveBack();
      await Promise.all(this.#fetches);
    }
  }

  /** One key: the next model, its effect, a new frame. A number ends the list with that exit code. */
  async #press(key: string): Promise<number | null> {
    this.#busy = true;
    try {
      const { model, effect } = reduce(this.#model, key);
      this.#setModel(model);
      const exit = await this.#perform(effect);
      if (exit === null) {
        this.#paint();
      }
      return exit;
    } finally {
      this.#busy = false;
    }
  }

  async #perform(effect: TuiEffect): Promise<number | null> {
    switch (effect.kind) {
      case 'none':
        return null;
      case 'quit':
        return EXIT.ok;
      case 'refresh':
        this.#refresh();
        return null;
      case 'note':
        await this.#editNote(effect.id);
        return null;
      case 'resume':
        return this.#resume(effect.id);
      default:
        this.#change(effect);
        return null;
    }
  }

  /** Label, group, ticket, done and pull requests: written at once, the rows loaded again in the same order. */
  #change(effect: Change): void {
    let message: string | null;
    try {
      message = this.#apply(effect);
    } catch (error) {
      message = failureMessage(error);
    }
    this.#reload(false);
    this.#setModel(withMessage(this.#model, message));
  }

  #apply(effect: Change): string | null {
    const deck = this.#deck;
    switch (effect.kind) {
      case 'label':
        setLabel(deck, effect.id, effect.text.trim() === '' ? null : cleanLabel(effect.text));
        return SAVED;
      case 'group':
        setGroup(deck, effect.id, effect.text.trim() === '' ? null : cleanGroup(effect.text));
        return SAVED;
      case 'ticket':
        // F18: as `skydeck ticket set` reads it; a refusal is the message, nothing written.
        setTicket(deck, effect.id, requireTicket(effect.text, deck.config.ticketUrl));
        return SAVED;
      case 'done':
        if (effect.done) {
          markDone(deck, effect.id);
        } else {
          markUndone(deck, effect.id);
        }
        return null;
      case 'pr-add': {
        // As `pr add` does: a fresh attachment shows its status, not "not fetched".
        const { url } = attachManualPr(deck, effect.id, effect.url);
        this.#fetchInBackground(
          (signal) => fetchPrs(this.#ghDeps(), [url], { signal }),
          'attached',
        );
        return SAVED;
      }
      case 'pr-rm':
        detachSessionPr(deck, effect.id, effect.url);
        return SAVED;
    }
  }

  /**
   * The editor needs the terminal: the list leaves the alternate screen and stops reading keys
   * (which gives the terminal its mode back) while it runs. What editNote would print on stderr is
   * shown in the message line once the list is back.
   */
  async #editNote(id: string): Promise<void> {
    this.#leaveScreen();
    await this.#releaseKeys();
    const said: string[] = [];
    const io = {
      ...this.#ctx.io,
      stderr: (text: string): void => {
        said.push(text);
      },
    };
    let outcome: string;
    try {
      await editNote({ ...this.#ctx, io }, this.#deck, id);
      outcome = SAVED;
    } catch (error) {
      outcome = failureMessage(error);
    }
    this.#keys = this.#ctx.io.keys();
    const left = this.#reload(false);
    this.#setModel(
      withMessage(this.#model, messageOf([outcome, ...said, ...(left === null ? [] : [left])])),
    );
    this.#enterScreen();
  }

  /**
   * `R`. The guard refreshes and loads the rows by itself (design 7.6), so the decision is made on
   * what is on disk now, not on the row this list shows. A refusal is the message. With an adapter
   * that opens tabs the session opens in one and the list stays; otherwise the list ends and the
   * launcher starts the session in this terminal. With `"terminal": "window"` the window's server
   * decides and starts it, and the list stays (#resumeInWindow).
   */
  async #resume(id: string): Promise<number | null> {
    if (whereFor(this.#deck.config, null) === 'window') {
      await this.#resumeInWindow(id);
      return null;
    }
    let prepared: PreparedLaunch;
    try {
      prepared = prepareResumeById(this.#deck, id);
    } catch (error) {
      const message = failureMessage(error);
      this.#reload(false);
      this.#setModel(withMessage(this.#model, message));
      return null;
    }
    if (this.#opensTabs()) {
      const short = id.slice(0, SHORT_ID_LENGTH);
      const { code, lines } = await launchWhere(this.#deck, prepared, 'tab');
      let outcome = `opened ${short} in a new tab`;
      if (code !== EXIT.ok) {
        // What to do instead (the command to run) does not fit one line: it goes to the scrollback.
        this.#atExit.push(...lines);
        outcome = `opening ${short} in a new tab failed; the details are printed when the list ends`;
      }
      this.#reload(false);
      this.#setModel(withMessage(this.#model, messageOf([outcome, ...lines])));
      return null;
    }
    await this.#giveBack(); // the terminal goes to `claude`: nothing may hold the launcher's exec back
    const { code, lines } = await launchWhere(this.#deck, prepared, 'here');
    for (const line of lines) {
      this.#ctx.io.stderr(`${line}\n`);
    }
    return code;
  }

  /**
   * `R` with `"terminal": "window"` (S2 11.4, plan C13): `POST /resume` to the window's server,
   * which prepares the resume itself; nothing is prepared or locked here. Its answer is shown as a
   * tab launch's: `opened <short> in the window` and its lines — with C12's words when no page is
   * connected, since the list opens no window —, a refusal (codes 2–4) and a line of plan 2.5 as
   * the message, a failed launch's lines kept for the end; an answer without lines (a server of
   * another build) is named by its code. The server's lines are sanitised before they are
   * printed (it may be of another build); the message line is sanitised by `render`.
   */
  async #resumeInWindow(id: string): Promise<void> {
    const short = id.slice(0, SHORT_ID_LENGTH);
    let message: string;
    try {
      const times = windowTimes(this.#deck.platform.env);
      const server = await windowServer(this.#deck, times, false);
      const { code, lines } = await requestResume(server, id, times);
      if (code === EXIT.ok) {
        const opened = `opened ${short} in the window`;
        const shown = (await this.#pageConnected(server)) ? opened : `${opened}; ${NO_WINDOW}`;
        message = messageOf([shown, ...lines]);
      } else if (messageOf(lines) === '') {
        // An answer that says nothing (a server of another build): its code, and no promise.
        message =
          code >= 2 && code <= 4
            ? `the window's server refused to resume ${short} (code ${code})`
            : `starting ${short} in the window failed (code ${code})`;
      } else if (code >= 2 && code <= 4) {
        message = messageOf(lines);
      } else {
        // What the server said does not fit one line: it goes to the scrollback.
        this.#atExit.push(...lines.map(sanitize));
        message = messageOf([
          `starting ${short} in the window failed; the details are printed when the list ends`,
          ...lines,
        ]);
      }
    } catch (error) {
      message = failureMessage(error);
    }
    this.#reload(false);
    this.#setModel(withMessage(this.#model, message));
  }

  /**
   * Whether a page of the window is connected; true when the server's status cannot be read, so
   * that nothing is said that is not known.
   */
  async #pageConnected(server: WindowServer): Promise<boolean> {
    try {
      return (await server.client.status()).pages > 0;
    } catch (error) {
      if (!(error instanceof SkydeckError)) throw error;
      return true;
    }
  }

  #opensTabs(): boolean {
    const { config, platform } = this.#deck;
    return config.terminal !== 'window' && terminalFor(config.terminal, platform, config).opensTabs;
  }

  /**
   * `r`: what changed on disk is read in (design 5) and the order is computed again, at once; then
   * every pull request of the sessions now shown is asked about, whatever its age (design 7.3: an
   * explicit refresh), in the background, so that keys are read meanwhile and `q` never waits for
   * `gh`. While that fetch runs, `r` starts no second one and says that it runs. A pull request
   * that cannot be read is saved as such, not thrown. When the selected session left the list, the
   * message says that first, and keeps saying it when the fetch has ended.
   */
  #refresh(): void {
    refreshWithProgress(this.#ctx, this.#deck);
    const left = this.#reload(true);
    const shown = left === null ? REFRESHING : `${left}  ${REFRESHING}`;
    this.#refreshing = { shown, after: left };
    this.#setModel(withMessage(this.#model, shown));
    if (this.#explicitFetchRunning) {
      return;
    }
    const sessionIds = visibleRows(this.#model).map((row) => row.id);
    this.#explicitFetchRunning = true;
    this.#fetchInBackground(
      (signal) =>
        refreshPrs(this.#ghDeps(), {
          force: true,
          refreshMinutes: this.#deck.config.prRefreshMinutes,
          sessionIds,
          signal,
        }),
      'explicit',
    );
  }

  /**
   * The background refresh (design 7.3, 7.4), every BACKGROUND_REFRESH_MS: what changed on disk is
   * read in (the refresh every command starts with, design 5.3), the rows are loaded again in the
   * order shown (the cursor stays on its session, a new one goes to the end of its group) and the
   * frame is painted when it changed. Loading the rows costs time in proportion to everything ever
   * recorded, so it is done only when they can have changed — the refresh saved something, or the
   * change marks moved — and at least every FULL_RELOAD_NS; otherwise only the time moves on, for
   * the times shown (ruled in fix 4). Then, unless a fetch runs, the pull requests that are due are
   * fetched (automatic, design 7.3). That part is the one that takes time: a fetch still running at
   * the next tick is not joined by another one, while reading the disk again (synchronous, so it
   * can never overlap itself) goes on at every tick.
   *
   * It runs only between keys: not while a key's effect is carried out (a tab being opened, the
   * editor, which is the only time the list is off screen before it ends), never after the list
   * has given the terminal back (the timer is stopped first), and not while an input is open (a
   * reload could close it under the user's fingers; the next tick after it does the refresh). A
   * failure is the message line, once.
   */
  #refreshInBackground(): void {
    if (this.#busy || this.#model.mode === 'input') {
      return;
    }
    let failure: string | null = null;
    try {
      const result = refresh(this.#deck); // not refreshWithProgress: nothing under the list
      const marks = this.#marksNow();
      const now = this.#now();
      const changed =
        this.#reloadOwed ||
        savedSomething(result) ||
        marks.live !== this.#marks.live ||
        marks.data !== this.#marks.data ||
        now - this.#loadedAtNs >= FULL_RELOAD_NS;
      this.#marks = marks;
      if (changed) {
        this.#reload(false);
      } else {
        this.#setModel(withRows(this.#model, [...this.#model.rows.values()], now, false));
      }
    } catch (error) {
      failure = `the list could not be refreshed: ${describeError(error)}`;
      this.#reloadOwed = true;
    }
    this.#backgroundOutcome('refresh', failure);
    try {
      this.#paint(true);
    } catch {
      // A timer has nobody to report to; the next key paints and meets the same failure.
    }
    if (failure === null && this.#fetches.size === 0) {
      this.#fetchDue();
    }
  }

  /** The automatic fetch (design 7.3): the pull requests never tried or last tried more than prRefreshMinutes ago. */
  #fetchDue(): void {
    this.#fetchInBackground(
      (signal) =>
        refreshPrs(this.#ghDeps(), {
          force: false,
          refreshMinutes: this.#deck.config.prRefreshMinutes,
          signal,
        }),
      'automatic',
    );
  }

  /**
   * The outcome of work the list does by itself. A failure is said in the message line once: the
   * same failure of the same work again says nothing more (the user has seen it, and a key took it
   * away). A success (`failure` null) takes that work's failure away from the message line if it
   * is still there, and makes a later failure new again.
   */
  #backgroundOutcome(work: BackgroundWork, failure: string | null): void {
    const said = this.#failures.get(work);
    if (failure === null) {
      this.#failures.delete(work);
      if (said !== undefined && this.#model.message === said) {
        this.#setModel(withMessage(this.#model, null));
      }
    } else if (said !== failure) {
      this.#failures.set(work, failure);
      this.#setModel(withMessage(this.#model, failure));
    }
  }

  /** Starts a fetch of pull requests that runs while the list goes on; the list stops it when it ends. */
  #fetchInBackground(work: (signal: AbortSignal) => Promise<Fetched>, kind: FetchKind): void {
    const fetch = this.#fetchPrs(work, kind);
    this.#fetches.add(fetch);
    void fetch.then(() => this.#fetches.delete(fetch));
  }

  /**
   * One fetch (design 7.3): automatic (the pull requests that are due: when the list opens and in
   * the background), the one pull request `p` attached, or explicit for `r`. When it saved
   * something, the rows are loaded again, in the order shown, and painted if that changed the
   * frame; an explicit one also takes its "refreshing" away from the message. It never rejects: a failure
   * is the message (an automatic one's once, as for the background refresh). Once the list has
   * ended or handed the terminal over (the signal fired), nothing is done with its result.
   */
  async #fetchPrs(work: (signal: AbortSignal) => Promise<Fetched>, kind: FetchKind): Promise<void> {
    let saved = 0;
    let failure: string | null = null;
    try {
      const { fetched, failed } = await work(this.#stop.signal);
      saved = fetched + failed;
    } catch (error) {
      failure = `the pull requests could not be refreshed: ${describeError(error)}`;
    } finally {
      if (kind === 'explicit') {
        this.#explicitFetchRunning = false;
      }
    }
    if (this.#stop.signal.aborted) {
      return; // the list has ended, or handed the terminal over
    }
    try {
      if (saved > 0 || failure !== null) {
        this.#reload(false);
      }
      const refreshing = kind === 'explicit' ? this.#refreshing : null;
      if (kind === 'explicit') {
        this.#refreshing = null;
      }
      if (kind === 'automatic') {
        this.#backgroundOutcome('automatic fetch', failure);
      } else if (failure !== null) {
        this.#setModel(withMessage(this.#model, failure));
      } else if (refreshing !== null && this.#model.message === refreshing.shown) {
        this.#setModel(withMessage(this.#model, refreshing.after));
      }
      this.#paint(true);
    } catch {
      // The next key loads and paints again, and meets the same failure where it can end the list.
    }
  }

  #ghDeps() {
    const { runner, clock, env } = this.#ctx.platform;
    return { runner, clock, env, store: this.#deck.store };
  }

  #now(): Ns {
    return this.#deck.platform.clock.nowNs();
  }

  /**
   * The change marks now (see ChangeMarks): a few small files and one PRAGMA. Every field of a live
   * file counts, its modification time included (derive takes it as the last sign of a process
   * that is gone), with whether the file is trusted.
   */
  #marksNow(): ChangeMarks {
    const { platform, places, store } = this.#deck;
    const live = readLiveFiles(platform.files, places.claudeHome).map((file) =>
      JSON.stringify([file, isLiveFileTrusted(file, platform.proc)], (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    );
    return { live: live.join('\n'), data: store.dataVersion() };
  }

  /** Every model goes through `scrolled`: after a key, after new rows, after a resize. */
  #setModel(model: TuiModel): void {
    this.#model = scrolled(model, this.#size);
  }

  /**
   * New rows from the deck, the order kept (`reorder` false) or computed again. When the selected
   * session is no longer visible, the cursor has gone to the row that takes its place (withRows)
   * and the message line says which session left, so that the move is seen before a key acts on
   * the new row (ruled in fix 4). Returns that notice; null when the cursor stayed.
   */
  #reload(reorder: boolean): string | null {
    const before = this.#model;
    const rows = loadRows(this.#deck);
    this.#loadedAtNs = this.#now();
    this.#reloadOwed = false;
    this.#setModel(withRows(before, rows, this.#loadedAtNs, reorder));
    const left = leftNotice(before, this.#model);
    if (left !== null) {
      this.#setModel(withMessage(this.#model, left));
    }
    return left;
  }

  /** Takes the terminal's size; true when it changed (the model is scrolled for the new one). */
  #takeSize(): boolean {
    const size = this.#ctx.io.size();
    if (size.columns === this.#size.columns && size.rows === this.#size.rows) {
      return false;
    }
    this.#size = size;
    this.#setModel(this.#model);
    return true;
  }

  /** The terminal was resized (Io.onResize): a frame at the new size, without waiting for a key. */
  #repaintIfResized(): void {
    if (!this.#onScreen) {
      return; // the next paint takes the size
    }
    try {
      if (this.#takeSize()) {
        this.#paint();
      }
    } catch {
      // An event handler has nobody to report to; the next key paints and meets the same failure.
    }
  }

  /** A frame, unless the list is off screen; with `onlyIfChanged`, only when it differs from the one shown. */
  #paint(onlyIfChanged = false): void {
    if (!this.#onScreen) {
      return;
    }
    this.#takeSize();
    const frame = render(this.#model, this.#size).join('\r\n');
    if (onlyIfChanged && frame === this.#painted) {
      return;
    }
    this.#painted = frame;
    this.#ctx.io.stdout(CLEAR + frame);
  }

  /**
   * Gives the terminal back for good: the background refresh and the fetches stop, the normal
   * screen, cursor and autowrap come back, the keys are no longer read, and what was kept for the
   * end is printed. Everything that
   * matters happens before the first await (the keys' return() turns raw mode off at once), so
   * that it also works on a signal, after which the process ends.
   */
  #giveBack(): Promise<void> {
    this.#stopRefreshing();
    this.#stop.abort();
    this.#leaveScreen();
    const released = this.#releaseKeys();
    for (const line of this.#atExit) {
      this.#ctx.io.stderr(`${line}\n`);
    }
    this.#atExit = [];
    return released;
  }

  #enterScreen(): void {
    this.#ctx.io.stdout(ENTER_SCREEN);
    this.#onScreen = true;
    this.#painted = null; // a fresh alternate screen is blank
  }

  #leaveScreen(): void {
    if (this.#onScreen) {
      this.#onScreen = false;
      this.#painted = null;
      this.#ctx.io.stdout(LEAVE_SCREEN);
    }
  }

  /** Stops reading keys, which gives the terminal its mode back. */
  async #releaseKeys(): Promise<void> {
    const keys = this.#keys;
    this.#keys = null;
    await keys?.return?.();
  }
}
