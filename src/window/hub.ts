/**
 * The interfaces between the server's parts (plan A1, 2.5): pages (`src/window/pages.ts`) code
 * against `TerminalHub` and `ActionHandler`; the terminal registry implements `TerminalHub`, the
 * actions implement `ActionHandler`. Types only.
 */
import type { KeeperExit } from './frames.ts';
import type { ActMessage, ResultMessage, ThemePayload } from './protocol.ts';

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
  /** The colours the last focused page reported, for OSC 10 and 11 (S2 7.2). Pages calls it when
   *  a page starts focused and when a page reports focus (with the theme of its start; ruled). */
  setTheme(theme: ThemePayload): void;
  /** Called after any change of `list()`; returns the function that unsubscribes. */
  onChange(listener: () => void): () => void;
}

export interface PageInfo {
  windowId: string;
  focused: boolean;
  area: { cols: number; rows: number } | null;
}

export interface ActionHandler {
  /** Never rejects: a failure is `{ ok: false, error }`. */
  act(page: PageInfo, action: ActMessage): Promise<ResultMessage>;
}
