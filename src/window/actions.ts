/**
 * What a page can ask the server to do in stage A (S2 8.2.3 `act`): resume a session, start a new
 * one, close an ended terminal, open a link. Every field of an action is the page's — any page
 * that passed the handshake — so each one is checked here again and goes through step 1's own
 * rules: a resume names a session and nothing more (the guard, the lock and the command builder
 * decide the rest, S2 11.1), a new session's directory, label, group and flags are checked as
 * `skydeck new` checks them (design 7.7), a terminal is closed only once its program has ended
 * (principle 6), and a link is opened only when S2 9.6 allows it. No action carries a program or
 * an argument list (S2 8.3).
 */
import { SkydeckError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { launchPrepared } from '../sessions/launch.ts';
import type { LaunchOutcome } from '../sessions/launch.ts';
import { prepareNew } from '../sessions/resume.ts';
import type { PreparedLaunch } from '../sessions/resume.ts';
import { prepareResumeById } from '../sessions/resume-by-id.ts';
import type { Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import { splitFlags } from './flags.ts';
import type { ActionHandler, TerminalHub } from './hub.ts';
import { parsePageMessage } from './protocol.ts';
import type { ActMessage, ResultMessage } from './protocol.ts';
import { MAY_START } from './view/sections.ts';
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
}

/** A result without its `t` and `id`, which `act` adds. */
type Answer = Omit<ResultMessage, 't' | 'id'>;

const DONE: Answer = { ok: true, lines: [], error: null, sessionId: null };

/** Principle 6: skydeck never ends a program; the user ends it inside it. */
const STILL_RUNS = 'the program still runs; end it inside claude';
const NO_TERMINAL = 'this terminal is no longer there';
const NOT_A_LINK = 'skydeck opens only http and https links of at most 2,048 characters';
const LINK_FAILED = 'the link could not be opened: Edge could not be started';
const NOT_AN_ACTION = 'skydeck cannot do that action';

function refusal(message: string): Answer {
  return { ok: false, lines: [message], error: message, sessionId: null };
}

/** A launch's outcome as a result: its lines; the session only when it started (plan A25). */
function launched(prepared: PreparedLaunch, outcome: LaunchOutcome): Answer {
  const ok = outcome.code === 0;
  return { ok, lines: outcome.lines, error: null, sessionId: ok ? prepared.sessionId : null };
}

/**
 * A SkydeckError as the result's lines, as step 1's command line prints it (failureText): one line
 * per line of the message, each sanitised — a message can quote what the page sent (a flag as
 * typed) — and the same text as one line for `error`.
 */
function refusedBy(error: SkydeckError): Answer {
  const lines = error.message.replace(/\n$/, '').split('\n').map(sanitize);
  return { ok: false, lines, error: lines.join(' '), sessionId: null };
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
 *  S2 12.6): a form field the user may leave blank, where step 1's cleanLabel would refuse it. */
function orNone(text: string): string | null {
  return text.trim() === '' ? null : text;
}

/**
 * The ActionHandler of stage A. `resume` → `prepareResumeById` (the guard on refreshed rows, the
 * lock) → `launchPrepared` with `terminalFor` the action's size; `new` → `splitFlags` →
 * `prepareNew` with the form's directory, label and group → `launchPrepared`. A launch answers its
 * outcome's lines (`ok` when it started, with the session's id); a SkydeckError (the guard, the
 * lock, RefError, prepareNew's refusals) answers its message, sanitised. `close-terminal` → `hub.close`;
 * `open-link` → `linkToOpen`, then `openLink`. Before a resume opens its terminal, the session's
 * terminals that are over (ended, lost, not started) are closed: an ended terminal is dropped when
 * its session runs again (ruled, review of task 13).
 *
 * Never rejects (2.5): an action that is not well formed is refused with one log line (the
 * parser's kind), and an unexpected error is answered `ok: false` and logged by kind (failureKind)
 * — never its message, which can quote what the page sent or a path. A terminal whose `open()` rejects is answered as
 * an open that timed out (`guarded`): no command to run by hand, the lock and the label kept.
 */
export function createActions(deps: ActionDeps): ActionHandler {
  const { deck, hub, log } = deps;

  /**
   * `terminal` with a rejection (or a throw) of its `open()` turned into the result of an open that
   * timed out (ruled, review 1 of task 32): the window terminal may already have a keeper then, so
   * launchPrepared must print no command to run by hand (a hand-run claude could resume the
   * session twice) and keeps the lock and the label, as after a timeout. Logged once by kind; the
   * error's message goes nowhere.
   */
  function guarded(terminal: Terminal, kind: 'resume' | 'new'): Terminal {
    return {
      name: terminal.name,
      opensTabs: terminal.opensTabs,
      async open(spec) {
        try {
          return await terminal.open(spec);
        } catch (error) {
          const failure = failureKind(error);
          log(`act ${kind}: the terminal failed (${failure})`);
          return {
            ok: false,
            error: `the terminal failed unexpectedly (${failure})`,
            timedOut: true,
          };
        }
      },
    };
  }

  /** Best effort: a terminal left behind costs a slot and a row's place, never the resume itself. */
  function closeEnded(sessionId: string): void {
    try {
      const ended = hub
        .list()
        .filter(
          (terminal) =>
            !MAY_START.has(terminal.state) &&
            (terminal.sessionId ?? terminal.expectedSessionId) === sessionId,
        );
      for (const terminal of ended) hub.close(terminal.id);
    } catch (error) {
      log(`act resume: an ended terminal was not closed (${failureKind(error)})`);
    }
  }

  async function run(action: ActMessage): Promise<Answer> {
    switch (action.kind) {
      case 'resume': {
        // The terminal is made before anything is taken, so that a factory that throws leaves no
        // lock behind; prepareResumeById and closeEnded run before the first await, so two
        // resumes of one session meet at the lock.
        const terminal = guarded(
          deps.terminalFor({ cols: action.cols, rows: action.rows }),
          'resume',
        );
        const prepared = prepareResumeById(deck, action.sessionId);
        closeEnded(prepared.sessionId);
        return launched(prepared, await launchPrepared(deck, prepared, terminal));
      }
      case 'new': {
        const flags = splitFlags(action.flags);
        if (!flags.ok) return refusal(flags.error);
        // Made first for the same reason: a factory that throws leaves no label stored.
        const terminal = guarded(deps.terminalFor({ cols: action.cols, rows: action.rows }), 'new');
        const prepared = prepareNew(deck, {
          dir: action.dir,
          label: orNone(action.label),
          group: orNone(action.group),
          extra: flags.flags,
        });
        return launched(prepared, await launchPrepared(deck, prepared, terminal));
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
    }
  }

  return {
    async act(_page, given) {
      const id = idOf(given);
      const check = checked(given);
      if (!check.ok) {
        log(`act: refused an action that is not valid (${check.kind})`);
        return { t: 'result', id, ...refusal(NOT_AN_ACTION) };
      }
      const action = check.action;
      try {
        return { t: 'result', id, ...(await run(action)) };
      } catch (error) {
        if (error instanceof SkydeckError) {
          return { t: 'result', id, ...refusedBy(error) };
        }
        const kind = failureKind(error);
        log(`act ${action.kind}: failed (${kind})`);
        return { t: 'result', id, ...refusal(`the action failed unexpectedly (${kind})`) };
      }
    },
  };
}
