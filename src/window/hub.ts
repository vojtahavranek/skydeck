/**
 * The interfaces between the server's parts (plan A1, 2.5): pages (`src/window/pages.ts`) code
 * against `TerminalHub` and `ActionHandler`; the terminal registry implements `TerminalHub`, the
 * actions implement `ActionHandler`. Types only.
 */
import type { KeeperExit } from './frames.ts';
import type { ActMessage, ResultMessage, ThemePayload, ViewMessage } from './protocol.ts';

export type TerminalState =
  'starting' | 'running' | 'ended' | 'lost' | 'not-started' | 'reconnecting' | 'newer-keeper';

export interface TerminalInfo {
  id: string;
  slot: number | null;
  state: TerminalState;
  /** The session it was opened for (S2 7.5); the session it shows is decided by the mapping. */
  expectedSessionId: string;
  /** The session it shows now; null while starting. */
  sessionId: string | null;
  kind: 'resume' | 'new';
  label: string | null;
  dir: string;
  program: { pid: number; procStart: number } | null;
  openedNs: bigint;
  cols: number;
  rows: number;
  exit: KeeperExit | null;
  /** S2 7.5: no holder after restoreStartTimeoutSeconds. */
  notReported: boolean;
  /**
   * F30: its program can be ended from the window now — it runs, and its keeper knows `E` (a
   * keeper of version 3 or later) and is connected. Optional for the reader: absent (a terminal a
   * test made up, a hub without `end`) is false.
   */
  endable?: boolean;
  /**
   * Issue #166: a restart holds it (`TerminalHub.holdSlot`): it ends its program and opens the
   * session's next terminal. While held its number stays on it after the program's exit, and
   * neither Close nor a move takes it. Present (true) only while held.
   */
  restarting?: true;
  /**
   * Issue #166: where Open places it among the window's terminals without a number, in place of
   * `openedNs`: the place of the terminal a restart opened it for (in memory only). Absent: its
   * `openedNs`.
   */
  placeNs?: bigint;
}

/**
 * Issue #199 (S2 7.10): a session's shell, the second kind of terminal. It belongs to a session
 * terminal of the window and is never a `TerminalInfo`: no slot, no session, no row. Its stream is
 * served by id as a terminal's is (`attach`, `input`, `resize`).
 */
export interface ShellInfo {
  id: string;
  /** The session terminal it belongs to now (`TerminalInfo.id`). */
  of: string;
  state: 'starting' | 'running' | 'reconnecting';
  /** The folder it was started in: its session terminal's. */
  dir: string;
  program: { pid: number; procStart: number } | null;
  openedNs: bigint;
  cols: number;
  rows: number;
}

/**
 * Issue #166 (S2 7.6, 7.8): a restart's hold on its terminal's number, from before the hang-up to
 * the session's next terminal. Every rule that reads which numbers are taken sees the held one as
 * taken, so between the program's exit and the next terminal's spawn nobody else gets it.
 */
export interface SlotHold {
  /**
   * The number the terminal `newId` is opened with — the held terminal's (null: it had none) —
   * and, for the order of Open, the held terminal's place: called right before that terminal is
   * spawned, in the same synchronous step, so the number passes from one listed terminal to the
   * next with no moment in which it is free. A transfer, not a freeing. Null, and nothing taken,
   * while the held terminal's program still runs, once taken, and once let go.
   */
  take(newId: string): number | null;
  /**
   * Issue #199 (S2 7.10): right after `take(newId)`, in the same synchronous step: the held
   * terminal's shell (one that is not being ended) belongs to `newId` from now on, and its id is the
   * answer, for the new terminal's meta (`shell`). Null when the hold was not taken for `newId`, or
   * the terminal has no such shell. It announces no change: the spawn that follows does. Optional:
   * a hold of a hub without shells has none.
   */
  moveShell?(newId: string): string | null;
  /**
   * Ends the hold: the terminal is no longer `restarting`; a number nobody took is freed now when
   * its program is over (as F43 frees it at the exit), and the change is announced. Once only.
   */
  release(): void;
}

export interface StreamSink {
  /** Always the first call on a sink: the screen at the point of the terminal's chain where
   *  `attach` was called. Never called when the terminal is forgotten before it was made. */
  snapshot(cols: number, rows: number, data: string): void;
  /** One record of output, after the screen side applied it. */
  output(bytes: Uint8Array): void;
  /** A resize record, in stream order. */
  size(cols: number, rows: number): void;
  exit(exit: KeeperExit, lost: boolean): void;
  notice(kind: 'gap' | 'newer-keeper' | 'input-full', text: string): void;
}

export interface TerminalHub {
  list(): readonly TerminalInfo[];
  /** Registers `sink` at the current point of the terminal's chain. The sink gets `snapshot`
   *  for that point first, then every later record in stream order (S2 8.2.4), until `detach`.
   *  Nothing is called on the sink before `snapshot` or after `detach`. null for an unknown
   *  terminal. */
  attach(termId: string, sink: StreamSink): { detach(): void } | null;
  input(termId: string, data: Uint8Array): 'ok' | 'full' | 'ended' | 'unknown';
  /** Sends Z to the keeper; the size reaches every sink when the R record comes back (S2 8.2.6). */
  resize(termId: string, cols: number, rows: number): void;
  /** S2 8.2.3 `close-terminal`: forgets an ended, lost or not-started terminal. */
  close(termId: string): 'ok' | 'running' | 'unknown';
  /**
   * F30: tells the terminal's keeper to hang up its program (`E`, SIGHUP, as a closed terminal's
   * window would) — only while the terminal is `endable`; 'cannot' otherwise (an older keeper, no
   * connection, a program that is not running), when nothing is sent. Optional: a hub without it
   * ends nothing (the actions refuse the request).
   */
  end?(termId: string): 'ok' | 'cannot' | 'unknown';
  /**
   * Issue #166: a restart's hold on the terminal (`SlotHold`), null when it cannot be held — the
   * terminal is not known, its program is over, a hold is on it already, or the hub stopped.
   * Optional: a hub without it restarts nothing (the actions refuse the request).
   */
  holdSlot?(termId: string): SlotHold | null;
  /**
   * Issue #199 (S2 7.10): the sessions' shells, never in `list()`. Optional: a hub without it has
   * none.
   */
  shells?(): readonly ShellInfo[];
  /** The colours the last focused page reported, for OSC 10 and 11 (S2 7.2). Pages calls it when
   *  a page starts focused and when a page reports focus (with the theme of its start, or of its
   *  latest `theme` message; ruled), and when the page that had focus last sends `theme`
   *  (follow-up F13). */
  setTheme(theme: ThemePayload): void;
  /** Called after any change of `list()`; returns the function that unsubscribes. */
  onChange(listener: () => void): () => void;
}

export interface PageInfo {
  windowId: string;
  focused: boolean;
  area: { cols: number; rows: number } | null;
  /** F37: the page's last `view` (its filter and chips); absent for a caller that has none. */
  view?: ViewMessage;
}

export interface ActionHandler {
  /** Never rejects: a failure is `{ ok: false, error }`. */
  act(page: PageInfo, action: ActMessage): Promise<ResultMessage>;
}
