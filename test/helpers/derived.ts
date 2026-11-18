/**
 * Builders for the tests of the list model and of what is built on it: a derived session, a
 * transcript, a meta row and a pull request, each with defaults a test overrides piece by piece.
 */
import { DEFAULT_CONFIG } from '../../src/platform/config.ts';
import { buildRows } from '../../src/sessions/list.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import type { DerivedSession } from '../../src/sessions/types.ts';
import type { PrRow, SessionMeta, SessionPrRow, TranscriptRow } from '../../src/store/types.ts';
import { BOOT_A, T0 } from './platform.ts';

/** A transcript of a `cli` session without a title. */
export function transcriptRow(sessionId: string, over: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    path: `/home/dev/.claude/projects/demo/${sessionId}.jsonl`,
    sessionId,
    sizeRead: 100,
    fileSize: 100,
    mtimeNs: T0,
    firstCwd: '/home/dev/projects/demo',
    entrypoint: 'cli',
    aiTitle: null,
    customTitle: null,
    firstRecordNs: T0,
    lastRecordNs: T0,
    lastUserNs: T0,
    lastTurnRole: 'assistant',
    missingSinceNs: null,
    ...over,
  };
}

/**
 * A not-running session with a transcript, last active and first seen at T0, in
 * /home/dev/projects/demo. `transcript` given as a partial row is merged over `transcriptRow`;
 * `null` means there is no transcript.
 */
export function ds(
  over: Partial<Omit<DerivedSession, 'transcript'>> & {
    id: string;
    transcript?: Partial<TranscriptRow> | null;
  },
): DerivedSession {
  const { transcript, ...rest } = over;
  return {
    state: 'not-running',
    stateDetail: null,
    sinceNs: T0,
    lastActivityNs: T0,
    firstSeenNs: T0,
    holders: [],
    marks: [],
    continuedFrom: null,
    dir: '/home/dev/projects/demo',
    launch: null,
    transcript: transcript === null ? null : transcriptRow(over.id, transcript),
    lastHolding: null,
    lastEventId: null,
    bootId: BOOT_A,
    doneAtNs: null,
    hidden: false,
    ...rest,
  };
}

export function meta(sessionId: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    label: null,
    group: null,
    note: null,
    doneAtNs: null,
    ticket: null,
    createdNs: T0,
    updatedNs: T0,
    ...over,
  };
}

/** A fetched, open pull request `https://github.com/<repo>/pull/<number>`; `repo` is "<owner>/<repo>". */
export function prRow(repo: string, number: number, over: Partial<PrRow> = {}): PrRow {
  const [owner = '', name = ''] = repo.split('/');
  return {
    url: `https://github.com/${repo}/pull/${number}`,
    owner,
    repo: name,
    number,
    title: 'A pull request',
    state: 'open',
    review: null,
    checks: null,
    okAtNs: T0,
    triedAtNs: T0,
    error: null,
    ...over,
  };
}

/** `pr` attached to the session, as the scan attaches it. */
export function attached(
  sessionId: string,
  pr: PrRow,
  over: Partial<SessionPrRow> = {},
): SessionPrRow {
  return {
    sessionId,
    url: pr.url,
    origin: 'auto',
    firstSeenNs: T0,
    detachedAtNs: null,
    ...over,
  };
}

/** `buildRows` with nothing else known (no meta, no pull request), the default group pattern
 *  and no ticketUrl (the defaults). */
export function rows(
  sessions: readonly DerivedSession[],
  extra: {
    metas?: readonly SessionMeta[];
    prs?: readonly PrRow[];
    sessionPrs?: readonly SessionPrRow[];
    groupPattern?: string;
    ticketUrl?: string | null;
  } = {},
): ListRow[] {
  return buildRows({
    sessions,
    metas: extra.metas ?? [],
    prs: extra.prs ?? [],
    sessionPrs: extra.sessionPrs ?? [],
    groupPattern: extra.groupPattern ?? DEFAULT_CONFIG.groupPattern,
    ticketUrl: extra.ticketUrl === undefined ? DEFAULT_CONFIG.ticketUrl : extra.ticketUrl,
  });
}

/** The one row of `rows([session], extra)`. */
export function rowOf(session: DerivedSession, extra: Parameters<typeof rows>[1] = {}): ListRow {
  const [row] = rows([session], extra);
  if (row === undefined) {
    throw new Error('buildRows dropped the session');
  }
  return row;
}
