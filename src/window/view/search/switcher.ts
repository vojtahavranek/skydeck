/**
 * The quick switcher's ranking (S2 12.8, plan E9) and the rule of stage C's restore offer in it
 * (S2 12.7, plan E12). Pure.
 *
 * Matching is task 90's (`searchWords`, `matchesWords`, `foundIn`): this file adds no rule of
 * what a word is or where it is found. Nothing here knows stage B or C: whether a row needs you,
 * and in which order, is given (`need`, `needOrder`), and the offer reads only the four fields of
 * a banner it names. A search text is foreign input, typed at every keystroke and ranked on the
 * server's one thread: nothing here builds a pattern from it, and the cost is linear in the
 * candidates (each matched once, as `matchesWords` costs) and in `needOrder`, plus one `foundIn`
 * for each of at most MAX_ITEMS titles, whatever the number of candidates.
 *
 * Imports (plan 2.1): values only from this directory; types from `protocol.ts`.
 */
import type {
  HiddenBy,
  NsText,
  RestoreOffer,
  RowPayload,
  SwitchItem,
  SwitchRank,
  SwitcherPayload,
} from '../../protocol.ts';
import { foundIn, matchesWords, searchWords } from './filter.ts';
import type { Searchable } from './filter.ts';

export const MAX_ITEMS = 50;

/** The one command of the switcher's command form (E12). */
const RESTORE = 'restore';
/** What starts the command form (E12, ruled): the text's first character, nothing trimmed
 *  before it. */
const COMMAND = '>';

/** E12 (ruled): a text whose first character is `>` is a command, whatever follows; it lists no
 *  session. Any other text searches sessions only. */
function isCommand(query: string): boolean {
  return query.startsWith(COMMAND);
}

/**
 * E12, over stage C's banner payload (structurally: only these fields are read): an offer when
 * the text is in command form and names the restore — its first character is `>` (nothing
 * trimmed before it) and what follows, trimmed and lower-cased with `toLowerCase()`, is a start
 * of `restore` of at least one letter (`>r`, `> rest`, `>Restore`, `> RESTORE`) — the banner is
 * not null, `shown` and `running` are false and at least one entry is preselected; else null.
 * `>` alone and `> foo` give none. A text without `>` as its first character searches sessions
 * only, so that a session's name never brings the offer; never for an empty text.
 *
 * The offer starts programs, so what is not positively known gives none (ruled): `shown` and
 * `running` must be `false` itself, and an entry counts only when its `preselected` is `true`.
 */
export function restoreOffer(
  query: string,
  banner: {
    readonly entries: readonly { readonly sessionId: string; readonly preselected: boolean }[];
    readonly lastActivityNs: NsText | null;
    readonly shown: boolean;
    readonly running: boolean;
  } | null,
): RestoreOffer | null {
  if (!isCommand(query)) {
    return null;
  }
  const command = query.slice(COMMAND.length).trim();
  if (command === '') {
    return null;
  }
  if (!RESTORE.startsWith(command.toLowerCase())) {
    return null;
  }
  if (banner === null || banner.shown !== false || banner.running !== false) {
    return null;
  }
  const sessionIds = banner.entries
    .filter((entry) => entry.preselected === true)
    .map((entry) => entry.sessionId);
  if (sessionIds.length === 0) {
    return null;
  }
  return { count: sessionIds.length, lastActivityNs: banner.lastActivityNs, sessionIds };
}

export interface SwitchCandidate {
  row: RowPayload;
  searchable: Searchable;
  /** In Open (running, or starting in a terminal of the window). */
  open: boolean;
  /** The row needs you (stage B's attention); false without stage B. */
  need: boolean;
  hiddenBy: HiddenBy[];
}

/** A candidate's rank: needing you wins over open, open over done. */
function rankOf(candidate: SwitchCandidate): SwitchRank {
  if (candidate.need) {
    return 'need';
  }
  if (candidate.open) {
    return 'open';
  }
  return candidate.row.done ? 'done' : 'not-running';
}

/**
 * Those that need you in needOrder's order (an id counts at its first place in it; one that is no
 * candidate is passed over), then those it lacks, in the candidates' order. Linear: each id is
 * looked up once in a map, and each candidate put in its place's bucket.
 */
function inNeedOrder(
  needing: readonly SwitchCandidate[],
  needOrder: readonly string[],
): SwitchCandidate[] {
  const place = new Map<string, number>();
  for (const id of needOrder) {
    if (!place.has(id)) {
      place.set(id, place.size);
    }
  }
  const placed: SwitchCandidate[][] = Array.from({ length: place.size }, () => []);
  const lacking: SwitchCandidate[] = [];
  for (const candidate of needing) {
    const at = place.get(candidate.row.id);
    if (at === undefined) {
      lacking.push(candidate);
    } else {
      placed[at]?.push(candidate);
    }
  }
  return [...placed.flat(), ...lacking];
}

/**
 * E9. `candidates`: every session the list lists with done ones shown, in S2 12.1's order —
 * Open's rows in Open's order, then the others most recent first (build.ts sorts them). Those
 * whose row matches every word of searchWords(query) — all of them for none — ranked: `need`
 * (in needOrder's order, then any that needOrder lacks in the candidates' order), `open`,
 * `not-running` (not open, not done), `done` (not open, done); inside each rank in the
 * candidates' order. The first MAX_ITEMS; `more` the rest; `restore` null. A text in command
 * form (its first character `>`, E12, ruled) lists no session: `command` true, `items` [] and
 * `more` 0, whatever follows the `>`; any other text gives `command` false.
 */
export function switcherPayload(
  query: string,
  candidates: readonly SwitchCandidate[],
  needOrder: readonly string[],
): SwitcherPayload {
  if (isCommand(query)) {
    return { query, command: true, items: [], more: 0, restore: null };
  }
  const words = searchWords(query);
  const byRank: Record<SwitchRank, SwitchCandidate[]> = {
    need: [],
    open: [],
    'not-running': [],
    done: [],
  };
  for (const candidate of candidates) {
    if (matchesWords(candidate.searchable, words)) {
      byRank[rankOf(candidate)].push(candidate);
    }
  }
  const ranked: [SwitchRank, readonly SwitchCandidate[]][] = [
    ['need', inNeedOrder(byRank.need, needOrder)],
    ['open', byRank.open],
    ['not-running', byRank['not-running']],
    ['done', byRank.done],
  ];
  const items: SwitchItem[] = [];
  let matching = 0;
  for (const [rank, group] of ranked) {
    matching += group.length;
    for (const candidate of group) {
      if (items.length === MAX_ITEMS) {
        break;
      }
      items.push({
        rank,
        row: candidate.row,
        found: foundIn(candidate.row.title, words),
        hiddenBy: candidate.hiddenBy,
      });
    }
  }
  return { query, command: false, items, more: matching - items.length, restore: null };
}
