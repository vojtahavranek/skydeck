// The interactive list on a terminal (design 7.4): the pure model and renderer (model.ts,
// render.ts) fed with the keys the user types, and the effects `reduce` asks for carried out on the
// deck. It paints from the cache, fetches the pull requests in the background and repaints (design
// 7.3); leaving the list never waits for `gh`.
import { refreshPrs } from '../../github.ts';
import { SkydeckError } from '../../platform/errors.ts';
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
  setGroup,
  setLabel,
} from '../../sessions/meta.ts';
import { describeError } from '../../sessions/problems.ts';
import { prepareResumeById } from '../../sessions/resume-by-id.ts';
import type { PreparedLaunch } from '../../sessions/resume.ts';
import { terminalFor } from '../../terminals/index.ts';
import type { Context } from '../context.ts';
import { refreshWithProgress, withDeck } from '../deck.ts';
import { EXIT } from '../exit.ts';
import { launchPrepared } from '../launching.ts';
import { editNote } from '../notes.ts';
import { decodeKeys } from './keys.ts';
import { initModel, reduce, visibleRows, withMessage, withRows } from './model.ts';
import type { TuiEffect, TuiModel } from './model.ts';
import { render, scrolled } from './render.ts';

/** The alternate screen, with the cursor hidden; and back to the normal screen and cursor. */
const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l';
const LEAVE_SCREEN = '\x1b[?25h\x1b[?1049l';
/** Cursor home, screen cleared: every frame is painted whole. */
const CLEAR = '\x1b[H\x1b[2J';
const SAVED = 'saved';
const REFRESHING = 'refreshing pull requests…';
const OWN_PREFIX = 'skydeck: ';

type Size = { columns: number; rows: number };
type Change = Extract<TuiEffect, { kind: 'label' | 'group' | 'done' | 'pr-add' | 'pr-rm' }>;

/** Opens the deck (withDeck, refresh: true) and runs the list until quit or a --here resume; returns the exit code. */
export function runInteractiveList(ctx: Context): Promise<number> {
  return withDeck(ctx, { refresh: true }, (deck) => new TerminalList(ctx, deck).run());
}

/**
 * Lines that skydeck would print on stderr, as one message line: each without the "skydeck: " a
 * line on stderr needs (the list is skydeck) and without its line break, joined by two spaces.
 * `render` sanitises the message.
 */
function messageOf(lines: readonly string[]): string {
  return lines
    .flatMap((text) => text.split('\n'))
    .map((line) => (line.startsWith(OWN_PREFIX) ? line.slice(OWN_PREFIX.length) : line))
    .filter((line) => line !== '')
    .join('  ');
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
  #onScreen = false;
  #keys: AsyncIterableIterator<string> | null = null;
  /** The pull-request fetches running in the background. */
  readonly #fetches = new Set<Promise<void>>();
  /** Fired when the list ends or hands the terminal to `claude`: every fetch stops, saving nothing more. */
  readonly #stop = new AbortController();

  constructor(ctx: Context, deck: Deck) {
    this.#ctx = ctx;
    this.#deck = deck;
    this.#size = ctx.io.size();
    this.#model = scrolled(initModel(loadRows(deck), this.#now()), this.#size);
  }

  async run(): Promise<number> {
    const unsubscribe = this.#ctx.io.onResize(() => {
      this.#repaintIfResized();
    });
    try {
      this.#enterScreen();
      this.#paint();
      this.#fetchInBackground({ force: false });
      this.#keys = this.#ctx.io.keys();
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
      unsubscribe();
      this.#stop.abort();
      this.#leaveScreen();
      await this.#releaseKeys();
      await Promise.all(this.#fetches);
    }
  }

  /** One key: the next model, its effect, a new frame. A number ends the list with that exit code. */
  async #press(key: string): Promise<number | null> {
    const { model, effect } = reduce(this.#model, key);
    this.#setModel(model);
    const exit = await this.#perform(effect);
    if (exit === null) {
      this.#paint();
    }
    return exit;
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

  /** Label, group, done and pull requests: written at once, the rows loaded again in the same order. */
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
      case 'done':
        if (effect.done) {
          markDone(deck, effect.id);
        } else {
          markUndone(deck, effect.id);
        }
        return null;
      case 'pr-add':
        attachManualPr(deck, effect.id, effect.url);
        return SAVED;
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
    this.#reload(false);
    this.#setModel(withMessage(this.#model, messageOf([...said, outcome])));
    this.#enterScreen();
  }

  /**
   * `R`. The guard refreshes and loads the rows by itself (design 7.6), so the decision is made on
   * what is on disk now, not on the row this list shows. A refusal is the message. With an adapter
   * that opens tabs the session opens in one and the list stays; otherwise the list ends and the
   * launcher starts the session in this terminal.
   */
  async #resume(id: string): Promise<number | null> {
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
      const { lines } = await launchPrepared(this.#deck, prepared, 'tab');
      const opened = `opened ${id.slice(0, SHORT_ID_LENGTH)} in a new tab`;
      this.#reload(false);
      this.#setModel(withMessage(this.#model, lines.length === 0 ? opened : messageOf(lines)));
      return null;
    }
    this.#stop.abort(); // the terminal goes to `claude`: nothing may hold the launcher's exec back
    this.#leaveScreen();
    await this.#releaseKeys();
    const { code, lines } = await launchPrepared(this.#deck, prepared, 'here');
    for (const line of lines) {
      this.#ctx.io.stderr(`${line}\n`);
    }
    return code;
  }

  #opensTabs(): boolean {
    const { config, platform } = this.#deck;
    return terminalFor(config.terminal, platform, config).opensTabs;
  }

  /**
   * `r`: what changed on disk is read in (design 5) and the order is computed again, at once; then
   * every pull request of the sessions now shown is asked about, whatever its age (design 7.3: an
   * explicit refresh), in the background, so that keys are read meanwhile and `q` never waits for
   * `gh`. A pull request that cannot be read is saved as such, not thrown.
   */
  #refresh(): void {
    refreshWithProgress(this.#ctx, this.#deck);
    this.#reload(true);
    this.#setModel(withMessage(this.#model, REFRESHING));
    this.#fetchInBackground(
      { force: true, sessionIds: visibleRows(this.#model).map((row) => row.id) },
      true,
    );
  }

  /** Starts a fetch of pull requests that runs while the list goes on; `run` stops it at the end. */
  #fetchInBackground(
    options: { force: boolean; sessionIds?: readonly string[] },
    explicit = false,
  ): void {
    const fetch = this.#fetchPrs(options, explicit);
    this.#fetches.add(fetch);
    void fetch.then(() => this.#fetches.delete(fetch));
  }

  /**
   * One fetch (design 7.3): automatic when the list opens (`force` false: the pull requests that
   * are due), explicit for `r`. When it saved something, the rows are loaded again, in the order
   * shown, and painted; an explicit one also takes away its "refreshing" message. It never
   * rejects: a failure is the message. After the list has ended (or the signal fired) nothing is
   * done with its result.
   */
  async #fetchPrs(
    options: { force: boolean; sessionIds?: readonly string[] },
    explicit: boolean,
  ): Promise<void> {
    let saved = 0;
    let failure: string | null = null;
    try {
      const { fetched, failed } = await refreshPrs(this.#ghDeps(), {
        ...options,
        refreshMinutes: this.#deck.config.prRefreshMinutes,
        signal: this.#stop.signal,
      });
      saved = fetched + failed;
    } catch (error) {
      failure = `the pull requests could not be refreshed: ${describeError(error)}`;
    }
    if (this.#stop.signal.aborted) {
      return; // the list has ended, or handed the terminal over
    }
    try {
      let repaint = false;
      if (saved > 0 || failure !== null) {
        this.#reload(false);
        repaint = true;
      }
      if (failure !== null) {
        this.#setModel(withMessage(this.#model, failure));
      } else if (explicit && this.#model.message === REFRESHING) {
        this.#setModel(withMessage(this.#model, null));
        repaint = true;
      }
      if (repaint) {
        this.#paint();
      }
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

  /** Every model goes through `scrolled`: after a key, after new rows, after a resize. */
  #setModel(model: TuiModel): void {
    this.#model = scrolled(model, this.#size);
  }

  /** New rows from the deck, the order kept (`reorder` false) or computed again. */
  #reload(reorder: boolean): void {
    this.#setModel(withRows(this.#model, loadRows(this.#deck), this.#now(), reorder));
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

  #paint(): void {
    if (!this.#onScreen) {
      return;
    }
    this.#takeSize();
    this.#ctx.io.stdout(CLEAR + render(this.#model, this.#size).join('\r\n'));
  }

  #enterScreen(): void {
    this.#ctx.io.stdout(ENTER_SCREEN);
    this.#onScreen = true;
  }

  #leaveScreen(): void {
    if (this.#onScreen) {
      this.#onScreen = false;
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
