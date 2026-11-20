// What skydeck knows about one session once events, live-session files and the transcript have been
// put together (design 6). Computed by `deriveSessions`; none of it is stored.
import type { LiveFile, ProcessKey } from '../claude/live.ts';
import type { Ns } from '../platform/types.ts';
import type { EndDetail, TranscriptRow } from '../store/types.ts';

export type State = 'working' | 'waiting' | 'running' | 'not-running';
export type Mark =
  | 'ended-unexpectedly'
  | 'was-working'
  | 'continued'
  | 'empty-copy'
  | 'expired'
  | 'expiring'
  | 'duplicate';

/** Display and JSON order of marks (design 6.3 table order). */
export const MARK_ORDER: readonly Mark[] = [
  'ended-unexpectedly',
  'was-working',
  'continued',
  'empty-copy',
  'expired',
  'expiring',
  'duplicate',
];

export interface Holder {
  process: ProcessKey;
  sinceNs: Ns; // time of the process's latest event
  live: LiveFile | null; // its trusted live file naming this session, if any
  /** The process is a scripted run (`claude -p`, an SDK run) holding a session skydeck knew (5.3). */
  scripted: boolean;
}

export interface LastHolding {
  process: ProcessKey;
  alive: boolean;
  /** time of the end event that closed the holding; null when the process held it at its last event */
  endedAtNs: Ns | null;
  /** detail of that end; 'moved-on' when the process's later events name another session without an end; null when still held */
  endDetail: EndDetail | 'moved-on' | null;
}

export interface DerivedSession {
  id: string;
  state: State;
  stateDetail: string | null; // waitingFor when waiting, raw (the list model sanitises)
  sinceNs: Ns;
  lastActivityNs: Ns;
  firstSeenNs: Ns;
  holders: Holder[]; // live holders, latest event first
  marks: Mark[]; // in MARK_ORDER
  continuedFrom: string | null;
  /**
   * Follow-up F33: the session this one began as a copy of (its latest `copy` link, design 5.3),
   * present exactly when it has one; absent for every other session.
   */
  copyOf?: string;
  dir: string | null;
  launch: string[] | null;
  transcript: TranscriptRow | null;
  lastHolding: LastHolding | null;
  /** The highest id among the events that name the session; null when it is known only from a transcript. */
  lastEventId: number | null;
  /**
   * The boot id the holders were judged against (a process is alive only on the boot it was
   * recorded in); null when it could not be read, and then no process looked alive.
   */
  bootId: string | null;
  doneAtNs: Ns | null;
  hidden: boolean; // done, and no activity after doneAtNs (7.1)
}
