/**
 * The messages between the page and the server (S2 8.2.2, 8.2.3) and the requests on
 * `server.sock` (S2 8.3): the TypeScript types every side codes against (the page reads them
 * through JSDoc `@import`), strict validators for what arrives from a page or a command, and the
 * binary output frame. Later stages add their messages and `act` kinds here: stage D's are label,
 * group, note, done, undone, pr-refresh, pr-add and pr-rm (plan D 2.2); stage C's are restore and
 * dismiss-restore, the banner, and `POST /resume`, `/new` and `/restore` (plan C 2.2).
 *
 * The validators read foreign input: they never throw and return `{ ok: false, kind }` with a fixed
 * kind that never quotes the input (plan A22), so a caller can log the kind. This module imports
 * nothing but the one session-id rule (`src/claude/session-id.ts`, which imports nothing; ruled by
 * the plan owner) and uses nothing the page's type check would not know (no `node:` modules).
 */
import { isSessionId } from '../claude/session-id.ts';

/** Nanoseconds since the Unix epoch, as a decimal string (messages never carry `bigint`). */
export type NsText = string;
/** The colours a page reports; the server uses one for OSC 10 / 11 only when it is `#rrggbb` (S2 7.2). */
export interface ThemePayload {
  fg: string;
  bg: string;
}
/** The keep-alive's state (S2 6.1, 6.2). */
export interface KeepAlivePayload {
  mode: 'wsl' | 'off';
  state: 'running' | 'starting' | 'failed' | 'off';
  since: NsText | null;
  error: string | null;
}

// ---------------------------------------------------------------------------------------------
// page → server
//
// Limits (the validator refuses more): sizes (`cols`, `rows`) are whole numbers 1–65535; strings
// are measured in UTF-8 bytes — paths and URLs at most 4096, other text 1024, `input.data` 64 KiB,
// a note's `text` and `base` 64 KiB each (plan D5); every string must be well formed (no lone
// surrogate). A restore names 1–1,000 distinct session ids (plan C 2.2). A view's `chips` are
// distinct chips, its `closed` at most MAX_CLOSED distinct entries (a section and a text), its
// `switcher` null or a text (plan E 2.3; `closed`: follow-up F3, ruled 2026-11-16).

/** The page's first message (S2 8.2.2). Any `protocol` number is read; the server closes with 4426
 *  for one it does not speak. `nonce`, `proof`: base64url, checked by the server's authentication. */
export interface HelloMessage {
  t: 'hello';
  protocol: number;
  mode: 'key' | 'launch';
  nonce: string;
  proof: string;
}
/** After the server's proof checked out (S2 8.2.2 step 6). `windowId`: 16 lower-case hex
 *  characters, random per page (plan A21). */
export interface StartMessage {
  t: 'start';
  assetVersion: string;
  windowId: string;
  focused: boolean;
  theme: ThemePayload;
}
/** `n`: a whole number from 0; `pong` answers with the same. */
export interface PingMessage {
  t: 'ping';
  n: number;
}
/** `unfolded`: section names ('earlier'), each once. `selected`: a session id (lower-case UUID) or
 *  null. Stage E's fields (plan E 2.3) are each optional: absent `chips` is none, absent `closed`
 *  is no block closed (E6 as ruled 2026-11-16: every block open), absent `switcher` is closed. */
export interface ViewMessage {
  t: 'view';
  filter: string;
  unfolded: string[];
  showDone: boolean;
  selected: string | null;
  /** E4: each once. */
  chips?: SearchChip[];
  /** E6 (ruled 2026-11-16): the blocks the user closed, each its section and its group; at most
   *  MAX_CLOSED, each once. */
  closed?: ClosedBlock[];
  /** E8: the switcher's text while it is shown; null while it is not. */
  switcher?: string | null;
}
/** E6 (ruled 2026-11-16): a block the user closed — the rows of `group` in `section` (S2 12.2). */
export interface ClosedBlock {
  section: SectionPayload['name'];
  /** The rows' group as the list sends it (sanitised), a text. */
  group: string;
}
/** E6: the most entries view.closed holds. */
export const MAX_CLOSED = 64;
/** Window focus, selection and the terminal area at the page's font (S2 8.2.3, 8.2.6). */
export interface FocusMessage {
  t: 'focus';
  focused: boolean;
  selected: string | null;
  area: { cols: number; rows: number };
}
/** `term`: a terminal id, 12 lower-case hex characters (plan A21). The size is a proposal (S2 8.2.6). */
export interface AttachMessage {
  t: 'attach';
  term: string;
  cols: number;
  rows: number;
}
export interface DetachMessage {
  t: 'detach';
  term: string;
}
/** Typed text, at most 64 KiB (65,536 bytes) as UTF-8: the page splits a larger paste, in order.
 *  With `binary`, `data` is a byte string from xterm.js's binary channel (mouse reports): every
 *  character U+0000–U+00FF, at most 65,536 of them. */
export interface InputMessage {
  t: 'input';
  term: string;
  data: string;
  binary?: true;
}
export interface ResizeMessage {
  t: 'resize';
  term: string;
  cols: number;
  rows: number;
}
/** An action (S2 8.2.3); the server answers `result` with the same `id` (a whole number from 0).
 *  `new.dir` is a path, `open-link.url` is held to the path limit (S2 9.6 opens up to 2,048
 *  characters); `label`, `group` and `flags` (the text as typed) are text.
 *
 *  Stage D (plan D 2.2): `label` and `group` set the session's label or group (`text`, at most
 *  1,024 bytes; empty clears it); `note` sets its note (`text` as typed) when the stored note is
 *  still `base`, the note the edit started from (each at most 65,536 bytes, D5); `done`, `undone`
 *  and `pr-refresh` name only the session; `pr-add` and `pr-rm` attach or detach the pull request
 *  `url` (the URL limit, 4,096 bytes). `sessionId` is a session id (isSessionId).
 *
 *  Stage C (plan C 2.2): `restore` restores the sessions `sessionIds` names (1–1,000 distinct
 *  session ids) of the banner's offer (S2 12.7); `dismiss-restore` is "Not now" for the earlier
 *  boot `bootId` (a lower-case UUID, the form of /proc/sys/kernel/random/boot_id). */
export type ActMessage =
  | { t: 'act'; id: number; kind: 'resume'; sessionId: string; cols: number; rows: number }
  | {
      t: 'act';
      id: number;
      kind: 'new';
      dir: string;
      label: string;
      group: string;
      flags: string;
      cols: number;
      rows: number;
    }
  | { t: 'act'; id: number; kind: 'close-terminal'; term: string }
  | { t: 'act'; id: number; kind: 'open-link'; url: string }
  | { t: 'act'; id: number; kind: 'label' | 'group'; sessionId: string; text: string }
  | { t: 'act'; id: number; kind: 'note'; sessionId: string; text: string; base: string }
  | { t: 'act'; id: number; kind: 'done' | 'undone' | 'pr-refresh'; sessionId: string }
  | { t: 'act'; id: number; kind: 'pr-add' | 'pr-rm'; sessionId: string; url: string }
  | { t: 'act'; id: number; kind: 'restore'; sessionIds: string[] }
  | { t: 'act'; id: number; kind: 'dismiss-restore'; bootId: string };
/** Follow-up F13: the page's colours changed while it is open — the title bar's theme switch was
 *  clicked here or in another window of the profile, or the system's scheme changed while the page
 *  follows it. The same colours as `start.theme`, checked the same way; the server answers OSC 10
 *  and 11 from the latest the page that had focus last reported (S2 7.2). */
export interface ThemeMessage {
  t: 'theme';
  theme: ThemePayload;
}
export type PageMessage =
  | HelloMessage
  | StartMessage
  | PingMessage
  | ViewMessage
  | FocusMessage
  | AttachMessage
  | DetachMessage
  | InputMessage
  | ResizeMessage
  | ActMessage
  | ThemeMessage;

// ---------------------------------------------------------------------------------------------
// server → page

export interface ChallengeMessage {
  t: 'challenge';
  protocol: 1;
  nonce: string;
}
/** `key` only in mode `launch` (S2 8.2.2 step 4). */
export interface WelcomeMessage {
  t: 'welcome';
  proof: string;
  key?: string;
  protocol: 1;
  assetVersion: string;
  serverId: string;
  bootId: string;
  version: string;
  keepAlive: KeepAlivePayload;
  nowNs: NsText;
}
export interface PongMessage {
  t: 'pong';
  n: number;
  bootId: string;
  serverId: string;
}
export interface PrPayload {
  url: string;
  repo: string;
  number: number;
  title: string | null;
  level: string;
  error: string | null;
  /** The last successful read (design 7.3), null before one. */
  okAtNs: NsText | null;
}
/** S2 12.3's chip, made by windowChip (plan D 2.3) over a row's attached pull requests. */
export interface ChipPayload {
  /** The open one that most needs the user, in design 7.3's order without merged and closed;
   *  with none open, `merged` when one is merged, else `closed`. */
  level: string;
  /** Attached and not known to be merged or closed: open, draft, never fetched, can't read. */
  open: number;
  merged: number;
}
/** A session running in another terminal (S2 7.9). */
export interface ElsewherePayload {
  pid: number;
  tty: string | null;
  dir: string | null;
}
/** A list row: the display fields of design 7.4's row and the window's own (S2 8.2.3). */
export interface RowPayload {
  id: string;
  shortId: string;
  title: string;
  titleSource: string;
  group: string | null;
  groupSource: string | null;
  state: 'working' | 'waiting' | 'running' | 'not-running';
  stateDetail: string | null;
  sinceNs: NsText;
  lastActivityNs: NsText;
  dir: string | null;
  marks: string[];
  hasNote: boolean;
  noteHead: string[];
  done: boolean;
  prs: PrPayload[];
  /** S2 12.3's chip (plan D4); null when no pull request is attached. */
  chip: ChipPayload | null;
  terminal: string | null;
  slot: number | null;
  elsewhere: ElsewherePayload | null;
  /** S2 7.5: a terminal of the window whose program holds no session yet. */
  starting: boolean;
  /** S2 12.4: why the row needs you, null when it needs nothing (stage B, plan B 2.3). */
  attention: AttentionPayload | null;
  /** S2 12.2's block the row is drawn in (plan E6; the code calls a block a stack), null in none
   *  (always while filtering). */
  stack: StackPayload | null;
}
export interface SectionPayload {
  name: 'open' | 'week' | 'earlier';
  folded: boolean;
  firstNs: NsText | null;
  lastNs: NsText | null;
  count: number;
  rows: RowPayload[];
  /** F9: the section's closed blocks, in the section's order; [] while it is folded or the view is
   *  filtering, and when it has none. Always sent. */
  closedStacks: ClosedStackPayload[];
}
/** `state`: a TerminalState of 2.5 (`reconnecting` shows S2 7.8's bar); `notReported`: S2 7.5's "started, not reported". */
export interface TerminalPayload {
  id: string;
  slot: number | null;
  sessionId: string | null;
  state: string;
  notReported: boolean;
  cols: number;
  rows: number;
  ownsSize: boolean;
  /** When the window opened it: the header's "opened <time>" (S2 12.5, plan D6). */
  openedNs: NsText;
}
/** For the selected session only: what the resume card shows (S2 12.6), and what the header and
 *  the dialogs of stage D need (plan D6). */
export interface SelectedPayload {
  sessionId: string;
  command: string | null; // printableCommand of the command a resume would run, null when it cannot be printed
  flagsKnown: boolean;
  unknownFlags: string[];
  /** Follow-up F16: the flags of the session's recorded launch that a resume passes on again, with
   *  their values, in the order recorded, each token sanitised (`passedOnFlags`); [] without a
   *  recorded launch. The header shows them, then `unknownFlags`, as the flags it was started
   *  with (S2 12.5). */
  launchFlags: string[];
  ended: 'exited' | 'unexpectedly' | 'mid-turn' | null;
  expiring: boolean;
  expired: boolean;
  /** The note exactly as stored — not sanitised: the page puts it only into a text box's value
   *  and sends it back as `base` — when it holds at most 65,536 bytes of UTF-8; null when there
   *  is none or it is longer (plan D5). */
  note: string | null;
  /** The stored note is longer than the window edits (plan D5): `note` is null. */
  noteTooLong: boolean;
  /** S2 12.5's ticket address (`ticketAddress`, plan D 2.3), null without one. Task 34 sends
   *  null; task 36 fills it. */
  ticketUrl: string | null;
}
/** The view model (S2 12), sent whole when it changed, at most once a second. */
export interface ListMessage {
  t: 'list';
  nowNs: NsText;
  counts: {
    working: number;
    waiting: number;
    running: number;
    starting: number;
    elsewhere: number;
    notRunning: number;
  };
  /** Plan B7: `count`, the listed rows that need you, whatever the filter or the fold (the title
   *  bar's count and the window title's `(n)`; such a row is in no field of `counts`); `order`, the
   *  ids of the rows this page shows that need you, in Ctrl+Shift+J's order (B6). */
  needYou: { count: number; order: string[] };
  sections: SectionPayload[];
  doneHidden: number;
  /** S2 12.7, the view model's (plan C9): null while nothing is offered and no restore runs. */
  banner: BannerPayload | null;
  terminals: TerminalPayload[];
  selected: SelectedPayload | null;
  /** Known project directories, most recent first (S2 12.6, the new form). */
  dirs: string[];
  // Stage E (plan E 2.3): optional for the reader — a list without them (a scripted list of the
  // test helpers, a server before stage E) counts as false and null.
  /** E5: the view's words or chips are set (the page draws its empty line and folds nothing). */
  filtering?: boolean;
  /** E8, E9: while view.switcher is a string; else null. */
  switcher?: SwitcherPayload | null;
  /** E13: the row of the session view.selected names, as the sections would carry it (its
   *  `stack` null), also when they leave it out; null when the view selects none or a session
   *  the view model does not list even with done ones shown. The page uses it only when its id
   *  is the page's selection. */
  selectedRow?: RowPayload | null;
}

// Stage E (plan E 2.2, 2.3): search's message types, made by `src/window/view/search/`.

/** E4: the chips that narrow the list (S2 12.8); Show done is `view.showDone`. */
export type SearchChip = 'running' | 'open-pr' | 'note';
/** RowPayload.stack (E6; since F9 an OPEN block only, a closed one has no row in `rows`): the
 *  block of one group in one section (S2 12.2) the row is drawn in, as a card. */
export interface StackPayload {
  /** The group the block is of (the rows' group, as sanitised). */
  group: string;
  /** Its rows, the first included: at least 2. */
  size: number;
  /** `head`: the block's first row in the section's order (the card's caption is drawn above it);
   *  `member`: one of the rows after it. Every row of a card is drawn alike (F9). */
  role: 'head' | 'member';
  /** The first row's session id. */
  head: string;
}
/** SectionPayload.closedStacks (F9): a CLOSED block — `view.closed` names its section and group,
 *  and none of its rows is selected or drawn with a terminal of the window that has not reported a
 *  session (S2 12.2). It is drawn as its caption alone: none of its rows is in the section's
 *  `rows`, its first neither. */
export interface ClosedStackPayload {
  /** The group the block is of (the rows' group, as sanitised). */
  group: string;
  /** Its rows: at least 2. */
  size: number;
  /** G5: how many of its rows need you (12.4) — every one of them is hidden. */
  needYou: number;
  /** The session id of its first row in the section's order: → and Enter on the caption open the
   *  block and select it. */
  head: string;
  /** Its place: the caption is drawn right before `rows[at]` of its section, `rows.length` after
   *  the last row. Captions at one place come in the array's order. */
  at: number;
}
export type SwitchRank = 'need' | 'open' | 'not-running' | 'done';
/** E10: what the page changes so that its list shows the row, in this order of meaning:
 *  `filter` — its words or chips do not match the row; `done` — the row is done and not open and
 *  the view shows no done sessions once the filter is cleared; `folded` — the row is in Earlier
 *  and Earlier is folded once the filter is cleared. [] when the list shows the row. */
export type HiddenBy = 'filter' | 'done' | 'folded';
export interface SwitchItem {
  rank: SwitchRank;
  row: RowPayload;
  /** foundIn(row.title, words). */
  found: [number, number][];
  hiddenBy: HiddenBy[];
}
/** E12: stage C's offer, listed in the switcher. */
export interface RestoreOffer {
  /** The preselected entries: at least 1. */
  count: number;
  /** The banner's `lastActivityNs`. */
  lastActivityNs: NsText | null;
  /** The preselected entries' ids, in the banner's order. */
  sessionIds: string[];
}
export interface SwitcherPayload {
  /** The text it answers (view.switcher), as the page sent it; E10's picks compare it. */
  query: string;
  /** E12 (ruled): the text is in command form — its first character is `>` — so `items` is []
   *  and `more` 0; the page says so from this field and never tests the text itself. */
  command: boolean;
  items: SwitchItem[];
  /** How many matching sessions were left out after MAX_ITEMS. */
  more: number;
  /** E12: switcherPayload gives null; the server's listFor sets it (task 98). */
  restore: RestoreOffer | null;
}
/** One session the banner offers (design 7.8's entry). */
export interface BannerEntryPayload {
  sessionId: string;
  shortId: string;
  title: string;
  /** null: no exit recorded. */
  endedAtNs: NsText | null;
  wasWorking: boolean;
  preselected: boolean;
}
/** S2 12.7, made by bannerPayload (plan C 2.3). */
export interface BannerPayload {
  /** The latest earlier boot (design 7.8) whose sessions are offered: what `dismiss-restore`
   *  names. null only while a restore runs and nothing is offered. */
  bootId: string | null;
  /** That boot's last event: "last activity" (S2 11.1). null with `bootId`. */
  lastActivityNs: NsText | null;
  /** The default set, in list order; [] while a restore runs and nothing is left to offer. */
  entries: BannerEntryPayload[];
  /** The view model's decision (plan C9): false after "Not now" for this boot; the page shows
   *  nothing. */
  shown: boolean;
  /** A restore runs in the server, from any page or command: nothing more can be started. */
  running: boolean;
}
/** S2 12.4's three reasons, in their order. */
export type AttentionReason = 'asks' | 'ended' | 'finished';
/** S2 12.4: why a row needs you. `detail`: for `asks` the live file's waitingFor, sanitised,
 *  trimmed and cut to 120 UTF-16 units with `…` (plan B13; null without one, or when it is blank
 *  once sanitised); else null. `sinceNs`: asks — the file's statusUpdatedAt, else updatedAt;
 *  ended — window_end_ns; finished — turn_ended_ns; null when not known. Display only (S2 10.2):
 *  the order is decided by the counter. */
export interface AttentionPayload {
  reason: AttentionReason;
  detail: string | null;
  sinceNs: NsText | null;
}
/** `ch`: the channel number of this terminal's output frames for this page (S2 8.2.4). */
export interface SnapMessage {
  t: 'snap';
  term: string;
  ch: number;
  cols: number;
  rows: number;
  data: string;
}
/** The terminal's size changed, in stream order; `owner`: this page owns the size (S2 8.2.6). */
export interface SizeMessage {
  t: 'size';
  term: string;
  cols: number;
  rows: number;
  owner: boolean;
}
export interface ExitMessage {
  t: 'exit';
  term: string;
  code: number | null;
  signal: number | null;
  atNs: NsText;
  lost: boolean;
  notStarted: string | null;
}
/** `sessionId`: the session a successful resume or new started (plan A25), else null. */
export interface ResultMessage {
  t: 'result';
  id: number;
  ok: boolean;
  lines: string[];
  error: string | null;
  sessionId: string | null;
}
/** `term`: the terminal a `gap`, `newer-keeper` or `input-full` notice concerns; null for the
 *  keep-alive, tick and restore notices. `restore-progress` (plan C6): `text` is one report line of
 *  a restore, whoever asked for it, sanitised. */
export interface NoticeMessage {
  t: 'notice';
  kind:
    | 'keepalive-lost'
    | 'keepalive-back'
    | 'gap'
    | 'newer-keeper'
    | 'input-full'
    | 'tick-failed'
    | 'restore-progress';
  term: string | null;
  text: string;
}
export interface ByeMessage {
  t: 'bye';
  reason: string;
}
/** S2 13, plan B8: a session started to need you while no window had focus; sent to one page.
 *  `title`: the row's title (sanitised); `detail` as the row's attention's; the page writes the
 *  words of the notification. */
export interface NotifyMessage {
  t: 'notify';
  sessionId: string;
  title: string;
  reason: AttentionReason;
  detail: string | null;
}
export type ServerMessage =
  | ChallengeMessage
  | WelcomeMessage
  | PongMessage
  | ListMessage
  | SnapMessage
  | SizeMessage
  | ExitMessage
  | ResultMessage
  | NoticeMessage
  | ByeMessage
  | NotifyMessage;

/** Output frames (S2 8.2.3): byte 1, the channel as 4-byte big-endian, the record's bytes.
 *  RangeError for a channel that is not a whole number 0–2³²−1. */
export function encodeOutputFrame(channel: number, bytes: Uint8Array): Uint8Array {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff_ffff) {
    throw new RangeError('a channel is a 32-bit unsigned whole number');
  }
  const frame = new Uint8Array(5 + bytes.length);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(1, channel);
  frame.set(bytes, 5);
  return frame;
}

// ---------------------------------------------------------------------------------------------
// The page messages' validator

/** A field's check: null when the value is good, else the kind (`<where>: <problem>`). */
type Check = (value: unknown, where: string) => string | null;
type Fields = Record<string, unknown>;

const TEXT_LIMIT = 1024;
const PATH_LIMIT = 4096;
const DATA_LIMIT = 64 * 1024;
/** A note's `text` and `base` (plan D5): its largest `act`, every character escaped by JSON (six
 *  bytes), stays under the WebSocket's message limit of 1 MiB. */
const NOTE_LIMIT = 64 * 1024;
const SIZE_MAX = 0xffff;
/** At most this many session ids in a restore, and flags in a new session (plan C 2.2, C3). */
const LIST_LIMIT = 1000;
const TERMINAL_ID = /^[0-9a-f]{12}$/;
const WINDOW_ID = /^[0-9a-f]{16}$/;
/** The form of /proc/sys/kernel/random/boot_id (plan C 2.2). */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECTIONS: ReadonlySet<string> = new Set(['open', 'week', 'earlier']);

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 length of a well-formed string. */
function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      length += 4; // a surrogate pair: the low half follows
      i++;
    } else length += 3;
  }
  return length;
}

const ANY: Check = () => null;

function text(limit: number): Check {
  return (value, where) => {
    if (typeof value !== 'string') return `${where}: wrong type`;
    if (!value.isWellFormed()) return `${where}: wrong value`;
    return utf8Length(value) > limit ? `${where}: too long` : null;
  };
}
const TEXT = text(TEXT_LIMIT);
const PATH = text(PATH_LIMIT);
const NOTE = text(NOTE_LIMIT);

/** A byte string (S2 8.2.3 `binary`): each character U+0000–U+00FF. */
function bytes(limit: number): Check {
  return (value, where) => {
    if (typeof value !== 'string') return `${where}: wrong type`;
    if (value.length > limit) return `${where}: too long`;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) > 0xff) return `${where}: wrong value`;
    }
    return null;
  };
}

function matching(pattern: RegExp): Check {
  return (value, where) => {
    if (typeof value !== 'string') return `${where}: wrong type`;
    return pattern.test(value) ? null : `${where}: wrong value`;
  };
}
const SESSION: Check = (value, where) => {
  if (typeof value !== 'string') return `${where}: wrong type`;
  return isSessionId(value) ? null : `${where}: wrong value`;
};
const TERM = matching(TERMINAL_ID);
const WINDOW = matching(WINDOW_ID);
const BOOT = matching(BOOT_ID);

/** Text that becomes part of a launch holds no NUL (plan C3: `dir` and each flag). */
function noNul(check: Check): Check {
  return (value, where) =>
    check(value, where) ?? ((value as string).includes('\0') ? `${where}: wrong value` : null);
}
/** A well-formed string of any length: the body's 64 KiB bounds it. */
const WELL_FORMED: Check = (value, where) => {
  if (typeof value !== 'string') return `${where}: wrong type`;
  return value.isWellFormed() ? null : `${where}: wrong value`;
};

/** An array of 1 (`nonEmpty`) or 0 up to `max` items, each passing `item`; `distinct`: no item
 *  twice. */
function list(item: Check, nonEmpty: boolean, distinct: boolean, max = LIST_LIMIT): Check {
  return (value, where) => {
    if (!Array.isArray(value)) return `${where}: wrong type`;
    if (value.length > max) return `${where}: too long`;
    if (nonEmpty && value.length === 0) return `${where}: wrong value`;
    const seen = new Set<unknown>();
    for (const one of value as unknown[]) {
      const problem = item(one, where);
      if (problem !== null) return problem;
      if (distinct) {
        if (seen.has(one)) return `${where}: wrong value`;
        seen.add(one);
      }
    }
    return null;
  };
}
const SESSION_IDS = list(SESSION, true, true);

function oneOf(...values: string[]): Check {
  return (value, where) => {
    if (typeof value !== 'string') return `${where}: wrong type`;
    return values.includes(value) ? null : `${where}: wrong value`;
  };
}

function wholeNumber(min: number, max: number): Check {
  return (value, where) => {
    if (typeof value !== 'number') return `${where}: wrong type`;
    return Number.isSafeInteger(value) && value >= min && value <= max
      ? null
      : `${where}: wrong value`;
  };
}
const SIZE = wholeNumber(1, SIZE_MAX);
const COUNT = wholeNumber(0, Number.MAX_SAFE_INTEGER);

const BOOLEAN: Check = (value, where) =>
  typeof value === 'boolean' ? null : `${where}: wrong type`;
const STRING: Check = (value, where) => (typeof value === 'string' ? null : `${where}: wrong type`);
const TRUE: Check = (value, where) => {
  if (typeof value !== 'boolean') return `${where}: wrong type`;
  return value ? null : `${where}: wrong value`;
};

function nullable(check: Check): Check {
  return (value, where) => (value === null ? null : check(value, where));
}

/** An object with exactly these fields (those in `optional` may be absent). */
function object(fields: Record<string, Check>, optional: readonly string[] = []): Check {
  return (value, where) => {
    if (!isObject(value)) return `${where}: wrong type`;
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(fields, name)) return `${where}: unknown field`;
    }
    for (const [name, check] of Object.entries(fields)) {
      if (!Object.hasOwn(value, name)) {
        if (optional.includes(name)) continue;
        return `${where}.${name}: missing`;
      }
      const problem = check(value[name], `${where}.${name}`);
      if (problem !== null) return problem;
    }
    return null;
  };
}

const UNFOLDED: Check = (value, where) => {
  if (!Array.isArray(value)) return `${where}: wrong type`;
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== 'string') return `${where}: wrong type`;
    if (!SECTIONS.has(name) || seen.has(name)) return `${where}: wrong value`;
    seen.add(name);
  }
  return null;
};

/** E4's chips. A record over the type, so that the compiler holds that it names every chip and no
 *  other; `SEARCH_CHIPS` of the view model is the same list (a case of the protocol's tests ties
 *  them: this module imports nothing of the view model). */
const CHIPS: Readonly<Record<SearchChip, true>> = { running: true, 'open-pr': true, note: true };

const CHIP: Check = (value, where) => {
  if (typeof value !== 'string') return `${where}: wrong type`;
  return Object.hasOwn(CHIPS, value) ? null : `${where}: wrong value`;
};
const VIEW_CHIPS = list(CHIP, false, true, Object.keys(CHIPS).length);
const CLOSED_ENTRY = object({ section: oneOf('open', 'week', 'earlier'), group: TEXT });
/** E6 (ruled 2026-11-16): at most MAX_CLOSED entries, each exactly a section and a text, each
 *  section and group once. */
const CLOSED: Check = (value, where) => {
  if (!Array.isArray(value)) return `${where}: wrong type`;
  if (value.length > MAX_CLOSED) return `${where}: too long`;
  const seen = new Map<string, Set<string>>();
  for (const one of value as unknown[]) {
    const problem = CLOSED_ENTRY(one, where);
    if (problem !== null) return problem;
    const { section, group } = one as ClosedBlock;
    const groups = seen.get(section) ?? new Set<string>();
    if (groups.has(group)) return `${where}: wrong value`;
    groups.add(group);
    seen.set(section, groups);
  }
  return null;
};

const AREA = object({ cols: SIZE, rows: SIZE });
/** A page's colours (`start.theme`, and follow-up F13's `theme`): exactly fg and bg, each a text. */
const THEME = object({ fg: TEXT, bg: TEXT });

/** `t` and `kind` were read before a message's own check runs. */
const ACTS: Readonly<Record<string, Check>> = {
  resume: object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION, cols: SIZE, rows: SIZE }),
  new: object({
    t: ANY,
    id: COUNT,
    kind: ANY,
    dir: PATH,
    label: TEXT,
    group: TEXT,
    flags: TEXT,
    cols: SIZE,
    rows: SIZE,
  }),
  'close-terminal': object({ t: ANY, id: COUNT, kind: ANY, term: TERM }),
  'open-link': object({ t: ANY, id: COUNT, kind: ANY, url: PATH }),
  // Stage D (plan D 2.2).
  label: object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION, text: TEXT }),
  group: object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION, text: TEXT }),
  note: object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION, text: NOTE, base: NOTE }),
  done: object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION }),
  undone: object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION }),
  'pr-refresh': object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION }),
  'pr-add': object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION, url: PATH }),
  'pr-rm': object({ t: ANY, id: COUNT, kind: ANY, sessionId: SESSION, url: PATH }),
  // Stage C (plan C 2.2).
  restore: object({ t: ANY, id: COUNT, kind: ANY, sessionIds: SESSION_IDS }),
  'dismiss-restore': object({ t: ANY, id: COUNT, kind: ANY, bootId: BOOT }),
};

const INPUT_SHAPE = object({ t: ANY, term: TERM, data: STRING, binary: TRUE }, ['binary']);
const TEXT_DATA = text(DATA_LIMIT);
const BYTE_DATA = bytes(DATA_LIMIT);

const MESSAGES: Readonly<Record<string, Check>> = {
  hello: object({
    t: ANY,
    protocol: COUNT,
    mode: oneOf('key', 'launch'),
    nonce: TEXT,
    proof: TEXT,
  }),
  start: object({
    t: ANY,
    assetVersion: TEXT,
    windowId: WINDOW,
    focused: BOOLEAN,
    theme: THEME,
  }),
  ping: object({ t: ANY, n: COUNT }),
  view: object(
    {
      t: ANY,
      filter: TEXT,
      unfolded: UNFOLDED,
      showDone: BOOLEAN,
      selected: nullable(SESSION),
      // Stage E (plan E 2.3), each optional: a page before stage E sends none of them.
      chips: VIEW_CHIPS,
      closed: CLOSED,
      switcher: nullable(TEXT),
    },
    ['chips', 'closed', 'switcher'],
  ),
  focus: object({ t: ANY, focused: BOOLEAN, selected: nullable(SESSION), area: AREA }),
  attach: object({ t: ANY, term: TERM, cols: SIZE, rows: SIZE }),
  detach: object({ t: ANY, term: TERM }),
  input: (value, where) => {
    const problem = INPUT_SHAPE(value, where);
    if (problem !== null) return problem;
    const fields = value as Fields;
    return (fields['binary'] === true ? BYTE_DATA : TEXT_DATA)(fields['data'], `${where}.data`);
  },
  resize: object({ t: ANY, term: TERM, cols: SIZE, rows: SIZE }),
  act: (value, where) => {
    const fields = value as Fields;
    if (!Object.hasOwn(fields, 'kind')) return `${where}.kind: missing`;
    const kind = fields['kind'];
    if (typeof kind !== 'string') return `${where}.kind: wrong type`;
    const check = Object.hasOwn(ACTS, kind) ? ACTS[kind] : undefined;
    if (check === undefined) return `${where}.kind: unknown`;
    return check(value, `${where}.${kind}`);
  },
  // Follow-up F13.
  theme: object({ t: ANY, theme: THEME }),
};

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Strict: a type, kind or field it does not know, a wrong type, a string over its limit (paths
 *  and URLs 4096, text fields 1024, `input.data` and a note's `text` and `base` 64 KiB) is
 *  { ok: false, kind }. Never throws. */
export function parsePageMessage(
  text: string,
): { ok: true; value: PageMessage } | { ok: false; kind: string } {
  const json = parseJson(text);
  if (!json.ok) return { ok: false, kind: 'not JSON' };
  const value = json.value;
  if (!isObject(value)) return { ok: false, kind: 'not an object' };
  if (!Object.hasOwn(value, 't')) return { ok: false, kind: 't: missing' };
  const t = value['t'];
  if (typeof t !== 'string') return { ok: false, kind: 't: wrong type' };
  const check = Object.hasOwn(MESSAGES, t) ? MESSAGES[t] : undefined;
  if (check === undefined) return { ok: false, kind: 't: unknown' };
  const problem = check(value, t);
  // Every field was checked and no other exists: the parsed object is the message.
  return problem === null
    ? { ok: true, value: value as unknown as PageMessage }
    : { ok: false, kind: problem };
}

// ---------------------------------------------------------------------------------------------
// server.sock (S2 8.3): stage A's routes, and stage C's below

/** `checkout`: the checkout the server runs from (plan A26; S2 5.1 compares it). */
export interface PingAnswer {
  serverId: string;
  bootId: string;
  build: string;
  protocol: 1;
  pid: number;
  port: number;
  checkout: string;
}
export interface StatusAnswer {
  /** Ruled (follow-up "server-findable"): true while the server's start is not done — the same
   *  flag that answers a page's upgrade with 503 (S2 8.2.1); it answers, and has written
   *  server.json, before then. Optional for the reader: a server of an older build sends none, and
   *  that means false. */
  starting?: boolean;
  pages: number;
  terminals: {
    id: string;
    slot: number | null;
    state: string;
    sessionId: string | null;
    pid: number | null;
  }[];
  keepAlive: KeepAlivePayload;
  python: { found: boolean; version: string | null };
  build: string;
  checkout: string;
  startedAtNs: NsText;
  envOrigin: { dir: string; atNs: NsText };
  /** Plan C20: the milliseconds left while the server expects a window back; absent (a server of
   *  an older build) and null mean that it expects none. */
  windowExpectedMs?: number | null;
}
export interface TokenAnswer {
  id: string;
  token: string;
  expiresAtNs: NsText;
}
export type TokenState = 'waiting' | 'used' | 'reused' | 'expired' | 'dropped';

// server.sock, stage C (plan C 2.2): the requests that start sessions in the window. No field is a
// program, an argument list or a path that is run (S2 8.3).

/** `POST /new` (plan C3): `label` and `group` null when the option was not given; `flags` the
 *  words after `--`, as given (no splitting). */
export interface NewRequest {
  dir: string;
  label: string | null;
  group: string | null;
  flags: string[];
}
/** `POST /restore` (plan C3): 1–1,000 distinct session ids; `all` as `restore --all`. */
export interface RestoreRequest {
  sessionIds: string[];
  all: boolean;
}
export type ControlRequest =
  | { route: 'ping' }
  | { route: 'status' }
  | { route: 'shutdown' }
  | { route: 'token'; seconds: 30 | 600 }
  | { route: 'token-state'; id: string }
  | { route: 'token-drop'; id: string }
  | { route: 'resume'; sessionId: string }
  | ({ route: 'new' } & NewRequest)
  | ({ route: 'restore' } & RestoreRequest);
/** POST /resume and POST /new (plan C2): the exit code and the lines the command prints on stderr,
 *  each as printed (`skydeck: …`); `sessionId`: the session it started, null when none. */
export interface LaunchAnswer {
  code: number;
  lines: string[];
  sessionId: string | null;
}
export interface RestoreOutcomeLine {
  code: 0 | 1 | 5;
  started: number;
  timedOut: number;
  failed: number;
  notStarted: number;
}
/** POST /restore (plan C5): one JSON object per line, the outcome last. */
export type RestoreStreamLine = { line: string } | { outcome: RestoreOutcomeLine };

type ControlResult = { ok: true; value: ControlRequest } | { ok: false; kind: string };

/** A token's id: 32 lower-case hex characters. */
const TOKEN_ID = /^[0-9a-f]{32}$/;
const TOKEN_STATE_PATH = /^\/token\/([0-9a-f]{32})$/;

const SECONDS: Check = (value, where) => {
  if (typeof value !== 'number') return `${where}: wrong type`;
  return value === 30 || value === 600 ? null : `${where}: wrong value`;
};

/** A request that carries no body: exactly the empty string. */
function noBody(request: ControlRequest): (body: string) => ControlResult {
  return (body) =>
    body === '' ? { ok: true, value: request } : { ok: false, kind: 'body: not empty' };
}

/** A JSON object body with exactly `fields`; `make` builds the request from it. */
function jsonBody(
  fields: Record<string, Check>,
  make: (body: Fields) => ControlRequest,
): (body: string) => ControlResult {
  const check = object(fields);
  return (body) => {
    const json = parseJson(body);
    if (!json.ok) return { ok: false, kind: 'body: not JSON' };
    if (!isObject(json.value)) return { ok: false, kind: 'body: not an object' };
    const problem = check(json.value, 'body');
    return problem === null ? { ok: true, value: make(json.value) } : { ok: false, kind: problem };
  };
}

const SHUTDOWN_JSON = jsonBody({}, () => ({ route: 'shutdown' }));

/** `POST /new`'s fields (plan C3): the directory a path without NUL, the label and the group text
 *  or null, at most LIST_LIMIT flags, each well formed without NUL. */
const NEW_FIELDS: Record<string, Check> = {
  dir: noNul(PATH),
  label: nullable(TEXT),
  group: nullable(TEXT),
  flags: list(noNul(WELL_FORMED), false, false),
};

const ROUTES: Readonly<Record<string, Readonly<Record<string, (body: string) => ControlResult>>>> =
  {
    '/ping': { GET: noBody({ route: 'ping' }) },
    '/status': { GET: noBody({ route: 'status' }) },
    '/shutdown': {
      POST: (body) =>
        body === '' ? { ok: true, value: { route: 'shutdown' } } : SHUTDOWN_JSON(body),
    },
    '/token': {
      POST: jsonBody({ seconds: SECONDS }, (body) => ({
        route: 'token',
        seconds: body['seconds'] as 30 | 600,
      })),
    },
    '/token/drop': {
      POST: jsonBody({ id: matching(TOKEN_ID) }, (body) => ({
        route: 'token-drop',
        id: body['id'] as string,
      })),
    },
    // Stage C (plan C3).
    '/resume': {
      POST: jsonBody({ sessionId: SESSION }, (body) => ({
        route: 'resume',
        sessionId: body['sessionId'] as string,
      })),
    },
    '/new': {
      POST: jsonBody(NEW_FIELDS, (body) => ({
        route: 'new',
        dir: body['dir'] as string,
        label: body['label'] as string | null,
        group: body['group'] as string | null,
        flags: body['flags'] as string[],
      })),
    },
    '/restore': {
      POST: jsonBody({ sessionIds: SESSION_IDS, all: BOOLEAN }, (body) => ({
        route: 'restore',
        sessionIds: body['sessionIds'] as string[],
        all: body['all'] as boolean,
      })),
    },
  };

/**
 * Method, path and JSON body to a request; an unknown field or route is { ok: false, kind }.
 * A kind that starts with `route` means that no route matches the method and path; one that
 * starts with `body` means a bad body (stage C's bodies with plan C3's limits). A request without a
 * body (`GET`, and `POST /shutdown`, which also takes `{}`) has the empty body. Never throws.
 */
export function parseControlRequest(
  method: string,
  path: string,
  body: string,
): { ok: true; value: ControlRequest } | { ok: false; kind: string } {
  const tokenState = TOKEN_STATE_PATH.exec(path);
  const methods =
    tokenState !== null
      ? { GET: noBody({ route: 'token-state', id: tokenState[1] as string }) }
      : Object.hasOwn(ROUTES, path)
        ? ROUTES[path]
        : undefined;
  if (methods === undefined) return { ok: false, kind: 'route: unknown' };
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (handler === undefined) return { ok: false, kind: 'route: method' };
  return handler(body);
}
