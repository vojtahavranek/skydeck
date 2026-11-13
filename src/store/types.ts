import type { Ns } from '../platform/types.ts';

export type EventKind = 'start' | 'end' | 'observed';
export type StartDetail = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown';
export type EndDetail = 'clear' | 'switch' | 'exit' | 'other';

export interface EventRow {
  id: number;
  spoolName: string | null; // null for observed events
  timeNs: Ns;
  kind: EventKind;
  detail: StartDetail | EndDetail | ''; // '' for observed
  rawDetail: string | null; // source / reason as received
  sessionId: string;
  bootId: string;
  pid: number; // 0 when the hook had no CLAUDE_PID (D7)
  procStart: number | null;
  cwd: string | null;
  argv: string[] | null; // start and observed only; stored as a JSON array
  name: string | null;
  payload: string | null; // hook input as received (start/end only)
}
export type NewEvent = Omit<EventRow, 'id'>;

export type LinkKind = 'clear' | 'switch' | 'fork';
export interface LinkRow {
  eventId: number;
  fromSession: string;
  toSession: string;
  kind: LinkKind;
  timeNs: Ns;
}

export interface SessionMeta {
  sessionId: string;
  label: string | null;
  group: string | null; // column group_name
  note: string | null;
  doneAtNs: Ns | null;
  createdNs: Ns;
  updatedNs: Ns;
}
/** A field that is present is set (null clears it); a field that is absent is left unchanged. */
export interface MetaPatch {
  label?: string | null;
  group?: string | null;
  note?: string | null;
  doneAtNs?: Ns | null;
}

export interface TranscriptRow {
  path: string;
  sessionId: string;
  sizeRead: number;
  fileSize: number;
  mtimeNs: Ns;
  firstCwd: string | null;
  entrypoint: string | null;
  aiTitle: string | null;
  customTitle: string | null;
  firstRecordNs: Ns | null;
  lastRecordNs: Ns | null;
  lastUserNs: Ns | null;
  lastTurnRole: 'user' | 'assistant' | null; // column last_turn_role
  missingSinceNs: Ns | null;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type PrReview = 'approved' | 'changes-requested' | 'review-required';
export type PrChecks = 'passing' | 'failing' | 'pending';

export interface PrRow {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  state: PrState | null; // null until the first successful fetch
  review: PrReview | null;
  checks: PrChecks | null;
  okAtNs: Ns | null;
  triedAtNs: Ns | null;
  error: string | null; // error of the last attempt; null after a success
}

/** Result of one fetch attempt for one pull request. */
export type PrFetchResult =
  | {
      ok: true;
      atNs: Ns;
      title: string;
      state: PrState;
      review: PrReview | null;
      checks: PrChecks | null;
    }
  | { ok: false; atNs: Ns; error: string };

export type PrOrigin = 'auto' | 'manual';
export interface SessionPrRow {
  sessionId: string;
  url: string;
  origin: PrOrigin;
  firstSeenNs: Ns;
  detachedAtNs: Ns | null;
}

/** Every key the kv table holds. */
export type KvKey =
  | 'schema_version' // "1"
  | 'dropped_scripted' // decimal count of scripted-run events dropped at ingest
  | 'settings_hash' // sha256 hex of settings.json as install left it
  | 'settings_backup' // absolute path of the backup, or "none" when there was no settings file
  | 'first_scan_done' // "1" after the first complete transcript scan
  | 'first_run_offered' // "1" after install made the first-run offer (D20)
  | 'doctor_probe' // written by doctor to prove the database is writable
  // What the last ingest / reconcile / scan skipped and why: a JSON array of one-line strings,
  // absent when it skipped nothing. Written by refresh (task 8) for doctor; holds no message text.
  | 'ingest_problems'
  | 'reconcile_problems'
  | 'scan_problems'
  // A resume lock (design 7.6, D16): the decimal time in ns it was taken; one per session id.
  | `resume_lock:${string}`;
