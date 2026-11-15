/**
 * What a page can ask the server to do (S2 8.2.3 `act`): in stage A resume a session, start a new
 * one, close an ended terminal, open a link; from stage D edit a session (S2 12.5): its label,
 * group and note, done and undone, its pull requests; from stage C restore the banner's sessions
 * and dismiss its offer (S2 12.7). Every field of an action is the page's — any page that passed
 * the handshake — so each one is checked here again and goes through step 1's own rules: a resume
 * names a session and nothing more (the guard, the lock and the command builder decide the rest,
 * S2 11.1), a new session's directory, label, group and flags are checked as `skydeck new` checks
 * them (design 7.7) — both through `launches.ts`, the one way the window starts a session (plan
 * C1) —, a terminal is closed only once its program has ended (principle 6), a link is opened only
 * when S2 9.6 allows it, and an edit is made by step 1's own functions (design 7.1, 7.3) on a
 * session the store knows. No action carries a program or an argument list (S2 8.3).
 */
import { RefError, SkydeckError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { cleanGroup, cleanLabel } from '../sessions/labels.ts';
import { loadRows } from '../sessions/load.ts';
import {
  attachManualPr,
  detachSessionPr,
  discardKeptNote,
  markDone,
  markUndone,
  setGroup,
  setLabel,
  setNote,
} from '../sessions/meta.ts';
import type { Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
import { splitFlags } from './flags.ts';
import type { ActionHandler, TerminalHub } from './hub.ts';
import { createLaunches } from './launches.ts';
import type { Launched } from './launches.ts';
import type { PrFetches } from './pr-fetches.ts';
import { parsePageMessage } from './protocol.ts';
import type { ActMessage, ResultMessage } from './protocol.ts';
import { linkToOpen } from './windows.ts';

export interface ActionDeps {
  deck: Deck;
  hub: TerminalHub;
  /**
   * The terminal to open a launch of this size with (task 23 passes task 21's windowTerminal). It
   * only BUILDS the object: nothing is spawned and no slot is taken before its `open()` (ruled,
   * review 1 of task 32; tasks 21 and 23 keep it so). The actions build it before the guard and
   * the lock, so that a factory that throws leaves nothing taken; a refused action never opens it.
   */
  terminalFor(size: { cols: number; rows: number }): Terminal;
  /** Task 19's openLink, bound to the configuration and the interop link. */
  openLink(url: string): Promise<boolean>;
  log: (line: string) => void;
  /** The store was written on the server's own connection: rows again and lists now (D7). */
  changed(): void;
  /** task 36's PrFetches (the server passes one). */
  prs: Pick<PrFetches, 'fetch' | 'refresh'>;
  /** Plan C 2.3: `act restore` (task 73's restorer, wired by task 74), which answers once the run
   *  has begun or with its refusal. Absent: the kind answers "skydeck cannot do that action". */
  restore?(sessionIds: readonly string[]): { ok: true } | { ok: false; error: string };
  /** Plan C 2.3, C9: `act dismiss-restore`. Absent: as `restore`. */
  dismissRestore?(bootId: string): { ok: true } | { ok: false; error: string };
}

/** A result without its `t` and `id`, which `act` adds. */
type Answer = Omit<ResultMessage, 't' | 'id'>;

/** Stage D's actions (S2 12.5): each names a session the store knows. */
type EditAction = Extract<
  ActMessage,
  { kind: 'label' | 'group' | 'note' | 'done' | 'undone' | 'pr-refresh' | 'pr-add' | 'pr-rm' }
>;

const DONE: Answer = { ok: true, lines: [], error: null, sessionId: null };

/** Principle 6: skydeck never ends a program; the user ends it inside it. */
const STILL_RUNS = 'the program still runs; end it inside claude';
const NO_TERMINAL = 'this terminal is no longer there';
const NOT_A_LINK = 'skydeck opens only http and https links of at most 2,048 characters';
const LINK_FAILED = 'the link could not be opened: Edge could not be started';
const NOT_AN_ACTION = 'skydeck cannot do that action';
/** Plan D 2.5: the row of a `new` terminal whose session the store does not know yet (A28). */
const NOT_STARTED = 'this session has not started yet; edit it once it runs';
/** S2 12.5: a note's save whose `base` is no longer the stored note. */
const NOTE_CHANGED =
  'the note was changed elsewhere while you edited it; your text is still in the box';
const BUSY = "skydeck's database is busy; try again";

function refusal(message: string): Answer {
  return { ok: false, lines: [message], error: message, sessionId: null };
}

/**
 * A launch (launches.ts) as a result. Refused: its message's lines, as step 1's command line prints
 * them (failureText: one line per line of the message, sanitised — a message can quote what the
 * page sent, a flag as typed), and the same text as one line for `error`. Otherwise its outcome's
 * lines, and the session only when it started (plan A25).
 */
function answerOf(launch: Launched): Answer {
  if (launch.refused) {
    return { ok: false, lines: launch.lines, error: launch.lines.join(' '), sessionId: null };
  }
  const ok = launch.code === 0;
  return { ok, lines: launch.lines, error: null, sessionId: ok ? launch.sessionId : null };
}

/**
 * A SkydeckError thrown by an action as its result, as answerOf answers a refusal: one line per
 * line of the message (`act` sanitises each), and the same text as one line for `error`.
 */
function refusedBy(error: SkydeckError): Answer {
  const lines = error.message.replace(/\n$/, '').split('\n');
  return { ok: false, lines, error: lines.join(' '), sessionId: null };
}

/** A restore dep's answer (plan C 2.3): `ok` with no lines and no session (C21), or its error. */
function answered(outcome: { ok: true } | { ok: false; error: string }): Answer {
  return outcome.ok ? DONE : refusal(outcome.error);
}

/** The action's id, to answer with; 0 when it has none (parsePageMessage lets no such action through). */
function idOf(action: unknown): number {
  const id: unknown = (action as { id?: unknown } | null)?.id;
  return Number.isSafeInteger(id) && (id as number) >= 0 ? (id as number) : 0;
}

/**
 * The action checked again where it is acted on (ruled, review 1 of task 32), by the one parser of
 * page messages (S2 8.2.3: its kind, the types and the limits of its fields, well-formed text),
 * so that the rule has one place: the checked copy, or the parser's kind (fixed text) for one
 * that fails.
 */
function checked(
  action: ActMessage,
): { ok: true; action: ActMessage } | { ok: false; kind: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(action) as string | undefined;
  } catch {
    text = undefined;
  }
  if (text === undefined) return { ok: false, kind: 'act: cannot be read' };
  const parsed = parsePageMessage(text);
  if (!parsed.ok) return parsed;
  return parsed.value.t === 'act'
    ? { ok: true, action: parsed.value }
    : { ok: false, kind: 't: not an action' };
}

/** A label or group left empty, or holding only white space, is none (ruled, review 1 of task 32;
 *  S2 12.6): a form field the user may leave blank, where step 1's cleanLabel would refuse it —
 *  the expression of `skydeck label` and `group`, and setNote's rule for a note that clears. */
function orNone(text: string): string | null {
  return text.trim() === '' ? null : text;
}

/**
 * The ActionHandler of stage A. `resume` → `launches.resume` with the action's size (plan C1: the
 * window's "already open" refusal, `prepareResumeById` — the guard on refreshed rows, the lock —,
 * the session's terminals that are over closed, `launchPrepared` with `terminalFor`); `new` →
 * `splitFlags` → `launches.newSession` with the form's directory, label and group (a blank one is
 * none, `orNone`) → `prepareNew` → `launchPrepared`. A launch answers its outcome's lines (`ok` when
 * it started, with the session's id); a refusal (the window's, the guard, the lock, RefError,
 * prepareNew's) answers its message. `close-terminal` → `hub.close`; `open-link` → `linkToOpen`,
 * then `openLink`. Stage D's kinds (label, group, note, done, undone, pr-refresh, pr-add, pr-rm) →
 * `edit` on a session the store knows (`requireKnown`); every write calls `changed()` once, a
 * refusal never. A resume is refused while the window has a terminal of the session whose program
 * may still run (ruled, review 2 of task 32), and before it opens its terminal it closes the
 * session's terminals that are over (ended, lost, not started): an ended terminal is dropped when
 * its session runs again (ruled, review of task 13). Stage C's kinds: `restore` →
 * `deps.restore(sessionIds)`, `dismiss-restore` → `deps.dismissRestore(bootId)`, each answering
 * `ok` with no lines or its error; without the dep the kind answers `skydeck cannot do that
 * action`, nothing done.
 *
 * Never rejects (2.5): an action that is not well formed is refused with one log line (the
 * parser's kind), and an unexpected error is answered `ok: false` and logged by kind (failureKind)
 * — never its message, which can quote what the page sent or a path; when it came after a resume's
 * lock was taken and before its terminal was opened, the lock is given back. A terminal whose
 * `open()` rejects is answered as an open that timed out: no command to run by hand, the lock and
 * the label kept. Every text of a result is sanitised.
 */
export function createActions(deps: ActionDeps): ActionHandler {
  const { deck, hub, log } = deps;
  // The window's one way to start a session (plan C1); its log lines get the actions' prefix.
  const launches = createLaunches({
    deck,
    hub,
    terminalFor: (size) => deps.terminalFor(size),
    log: (line) => log(`act ${line}`),
  });

  /**
   * Plan D9: an edit acts only on a session the store knows, a row of loadRows — the id is whole,
   * so nothing is resolved and no refresh runs first. The row of a `new` terminal whose session
   * the store does not know yet (A28) is refused as not started (2.5); any other id is RefError's,
   * as for `act resume`.
   */
  function requireKnown(sessionId: string): void {
    if (loadRows(deck).some((row) => row.id === sessionId)) return;
    const waits = hub
      .list()
      .some((terminal) => terminal.kind === 'new' && terminal.expectedSessionId === sessionId);
    if (waits) throw new SkydeckError(NOT_STARTED);
    throw new RefError(`no session matches '${sanitize(sessionId)}'`, []);
  }

  /** A write on the server's own connection: every window's list follows now (D7). */
  function wrote(): Answer {
    deps.changed();
    return DONE;
  }

  /**
   * S2 12.5, plan D9, D10: in one store transaction the stored note ('' for none) is read; when it
   * is already the text sent (a save sent again after its answer was lost, also one that cleared
   * the note) nothing is written; when it is not `base`, the note changed since the edit began and
   * the save is refused; else setNote. After a write, the note file a failed editor kept goes.
   */
  function saveNote(action: Extract<EditAction, { kind: 'note' }>): Answer {
    const { sessionId, text, base } = action;
    const outcome = deck.store.transaction(() => {
      const stored = deck.store.meta(sessionId)?.note ?? '';
      if (stored === text || (stored === '' && orNone(text) === null)) return 'stored';
      if (stored !== base) return 'changed';
      setNote(deck, sessionId, text);
      return 'saved';
    });
    if (outcome === 'changed') return refusal(NOTE_CHANGED);
    if (outcome === 'stored') return DONE;
    discardKeptNote(deck, sessionId);
    return wrote();
  }

  /**
   * Stage D's edits (S2 12.5) through step 1's functions, as the commands make them: `label` and
   * `group` are none when blank, else cleanLabel / cleanGroup (their refusals are the commands'),
   * then setLabel / setGroup; `note` saveNote; `done`, `undone` markDone, markUndone; `pr-add`
   * attachManualPr (origin manual, an earlier detach cleared), then the fetch in the background
   * (D8), answered `attached <url>` without waiting for it; `pr-rm` detachSessionPr; `pr-refresh`
   * the explicit refresh in the background, `ok` at once.
   */
  function edit(action: EditAction): Answer {
    const { sessionId } = action;
    requireKnown(sessionId);
    switch (action.kind) {
      case 'label': {
        const text = orNone(action.text);
        setLabel(deck, sessionId, text === null ? null : cleanLabel(text));
        return wrote();
      }
      case 'group': {
        const text = orNone(action.text);
        setGroup(deck, sessionId, text === null ? null : cleanGroup(text));
        return wrote();
      }
      case 'note':
        return saveNote(action);
      case 'done':
        markDone(deck, sessionId);
        return wrote();
      case 'undone':
        markUndone(deck, sessionId);
        return wrote();
      case 'pr-add': {
        const key = attachManualPr(deck, sessionId, action.url);
        deps.changed();
        deps.prs.fetch([key.url]);
        return { ok: true, lines: [`attached ${key.url}`], error: null, sessionId: null };
      }
      case 'pr-rm':
        detachSessionPr(deck, sessionId, action.url);
        return wrote();
      case 'pr-refresh':
        deps.prs.refresh(sessionId);
        return DONE;
    }
  }

  async function run(action: ActMessage): Promise<Answer> {
    switch (action.kind) {
      case 'resume':
        return answerOf(
          await launches.resume(action.sessionId, { cols: action.cols, rows: action.rows }),
        );
      case 'new': {
        const flags = splitFlags(action.flags);
        if (!flags.ok) return refusal(flags.error);
        const request = {
          dir: action.dir,
          label: orNone(action.label),
          group: orNone(action.group),
          flags: flags.flags,
        };
        return answerOf(
          await launches.newSession(request, { cols: action.cols, rows: action.rows }),
        );
      }
      case 'close-terminal': {
        const closed = hub.close(action.term);
        if (closed === 'ok') return DONE;
        return refusal(closed === 'running' ? STILL_RUNS : NO_TERMINAL);
      }
      case 'open-link': {
        const link = linkToOpen(action.url);
        if (link === null) return refusal(NOT_A_LINK);
        return (await deps.openLink(link)) ? DONE : refusal(LINK_FAILED);
      }
      case 'label':
      case 'group':
      case 'note':
      case 'done':
      case 'undone':
      case 'pr-refresh':
      case 'pr-add':
      case 'pr-rm':
        return edit(action);
      case 'restore':
        return deps.restore === undefined
          ? refusal(NOT_AN_ACTION)
          : answered(deps.restore(action.sessionIds));
      case 'dismiss-restore':
        return deps.dismissRestore === undefined
          ? refusal(NOT_AN_ACTION)
          : answered(deps.dismissRestore(action.bootId));
    }
  }

  async function answer(given: ActMessage): Promise<Answer> {
    const check = checked(given);
    if (!check.ok) {
      log(`act: refused an action that is not valid (${check.kind})`);
      return refusal(NOT_AN_ACTION);
    }
    const action = check.action;
    try {
      return await run(action);
    } catch (error) {
      if (error instanceof SkydeckError) return refusedBy(error);
      const kind = failureKind(error);
      if (isBusy(error)) {
        // Ruled (task 23, review 2): another process keeps the store locked; nothing was done.
        log(`act ${action.kind}: the database is busy (${kind})`);
        return refusal(BUSY);
      }
      log(`act ${action.kind}: failed (${kind})`);
      return refusal(`the action failed unexpectedly (${kind})`);
    }
  }

  return {
    async act(_page, given) {
      const { ok, lines, error, sessionId } = await answer(given);
      // Every text of a result passes the sanitiser step 1 prints with (ruled, review 2 of task
      // 32): whatever a message quotes, no escape sequence or line break reaches the page.
      return {
        t: 'result',
        id: idOf(given),
        ok,
        lines: lines.map(sanitize),
        error: error === null ? null : sanitize(error),
        sessionId,
      };
    },
  };
}
