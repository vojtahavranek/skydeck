import type { Ns } from '../platform/types.ts';

/**
 * `scripted`: a scripted run (`claude -p`, an SDK run) started on a session skydeck already knew
 * (design 5.3). It says only that its process holds the session while it is alive.
 * `scripted-end`: that process ended its holding (it cleared or switched); it holds nothing more.
 */
export type EventKind = 'start' | 'end' | 'observed' | 'scripted' | 'scripted-end';
export type StartDetail = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown';
export type EndDetail = 'clear' | 'switch' | 'exit' | 'other';
/**
 * F30: the `raw_detail` of the `end` event (detail `exit`, no spool file) the window's server
 * records once the program of a session the user ended in the window has exited: that process's
 * holding of the session ended by the user's own exit, whatever end Claude Code's hook sends for
 * it, before or after (design 6.1).
 */
export const ENDED_IN_WINDOW = 'skydeck-window';

export interface EventRow {
  id: number;
  spoolName: string | null; // null for observed events
  timeNs: Ns;
  kind: EventKind;
  detail: StartDetail | EndDetail | ''; // '' for observed and scripted
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
  /** F18: the ticket's address (column ticket_url, migration 3), null for none. */
  ticket: string | null;
  createdNs: Ns;
  updatedNs: Ns;
}
/** A field that is present is set (null clears it); a field that is absent is left unchanged. */
export interface MetaPatch {
  label?: string | null;
  group?: string | null;
  note?: string | null;
  doneAtNs?: Ns | null;
  ticket?: string | null;
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

/** F19 (T3): the six categories a ticket's status can have; each is drawn in a pull request's tint. */
export const TICKET_CATEGORIES = ['todo', 'doing', 'review', 'blocked', 'done', 'closed'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** F19 (T5; S2 10.2): the cached status of a ticket's address (table ticket_status, migration 4). */
export interface TicketStatusRow {
  url: string;
  status: string | null; // null until a read succeeded
  category: TicketCategory | null; // null for none, or one this skydeck does not know
  okAtNs: Ns | null;
  triedAtNs: Ns;
  error: string | null; // the failure of the last attempt; null after a success
}

/** F19: the result of one attempt to read a ticket's status. */
export type TicketStatusResult =
  | { ok: true; atNs: Ns; status: string; category: TicketCategory | null }
  | { ok: false; atNs: Ns; error: string };

export type PrOrigin = 'auto' | 'manual';
export interface SessionPrRow {
  sessionId: string;
  url: string;
  origin: PrOrigin;
  firstSeenNs: Ns;
  detachedAtNs: Ns | null;
}

/** S2 10.2: one row of `attention`. */
export interface AttentionRow {
  sessionId: string;
  turnEndedSeq: number | null;
  turnEndedNs: Ns | null;
  seenSeq: number | null;
  windowEndSeq: number | null;
  windowEndNs: Ns | null;
}
/** One session's part of a write (B3): at least one of the three. */
export interface AttentionWrite {
  sessionId: string;
  /** A turn end: turn_ended_seq = the next value, turn_ended_ns = this. */
  turnEndedNs?: Ns;
  /** A window end judged ended-unexpectedly (B10): window_end_seq = the next value, window_end_ns = this. */
  windowEndNs?: Ns;
  /** seen_seq = the next value, after this write's other values for the session. */
  seen?: true;
}

/** Every key the kv table holds. */
export type KvKey =
  | 'schema_version' // decimal: how many migrations ran ("2")
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
  // The window (S2 10.2):
  | 'window_secret' // the secret (S2 15.2): 32 random bytes, base64url
  | 'window_server' // the lock of the one server (S2 5.2)
  | 'window_runtime_dir' // the runtime directory the server uses (S2 4.2)
  | 'window_alarm' // when a used launch token was presented a second time (S2 8.2.2)
  | 'window_launching' // the lock of the one command that starts Edge (S2 5.1)
  | 'attention_seq' // S2 10.2's counter, decimal
  | 'window_restore_dismissed' // the earlier boot whose restore offer the user dismissed (S2 12.7, plan C9)
  | 'window_pages_open' // "1" while the server has pages connected (plan C20)
  | 'window_favourites' // the new form's favourite flags: a JSON array of texts (S2 12.6, F15)
  // A resume lock (design 7.6, D16): the decimal time in ns it was taken, then `:<id>` of the
  // session's latest event at that moment (0 when it had none; a bare time is a lock an earlier
  // version wrote); one per session id.
  | `resume_lock:${string}`;
