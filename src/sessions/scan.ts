// 5.6: the transcripts are read incrementally into the transcripts table, and the pull requests
// they name are attached (7.3 "Automatic"). Nothing that comes from one folder or one transcript
// stops the scan: the whole handling of one file (reading it and saving it) is guarded, what fails
// is recorded for doctor (problems.ts) and skipped, and nothing at or under what could not be read
// is taken for deleted. A failure of the database as a whole (isDatabaseFailure) ends the command
// at once.
import { listTranscriptFiles, readTranscript } from '../claude/transcripts.ts';
import type { TranscriptFacts, TranscriptFile, TranscriptRead } from '../claude/transcripts.ts';
import { prKey } from '../github.ts';
import type { Files, Ns } from '../platform/types.ts';
import { isDatabaseFailure } from '../store/store.ts';
import type { TranscriptRow } from '../store/types.ts';
import type { Deck } from './deck.ts';
import { describeError, recordProblems } from './problems.ts';

export interface ScanResult {
  read: number;
  skipped: number;
  missing: number;
  prsAttached: number;
}

/** The range of the database's INTEGER columns. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * 5.6. progress(done, total) is called after each file that is processed (total: the files that
 * changed), also one that could not be read, was gone or could not be recorded. Sets kv
 * first_scan_done.
 *
 * A listed file whose size or modification time differs from its row (or that has no row, or a
 * row marked missing) is read from the row's offset; its facts are saved and the pull requests its
 * `pr-link` records name are attached with origin `auto` (a detached one stays detached), in one
 * transaction. A row whose file was not listed is marked missing, unless its path is at or under a
 * path that could not be read (the listing is partial there); a file that disappears between
 * listing and reading is missing too. Never throws for one folder or file: one that cannot be read
 * or saved (any error the file causes, the store's included) is recorded in kv `scan_problems`
 * (replaced on every run) and keeps its row as it was. A failure of the database as a whole is
 * thrown at once.
 */
export function scanTranscripts(
  deck: Deck,
  progress?: (done: number, total: number) => void,
): ScanResult {
  const { store } = deck;
  const { files } = deck.platform;
  const now = deck.platform.clock.nowNs();
  // The rows before the listing: a row another skydeck saves in between is then neither in the
  // snapshot nor taken for deleted.
  const rows = new Map(store.transcripts().map((row) => [row.path, row]));
  const attached = new Set(store.sessionPrs().map((r) => pairKey(r.sessionId, r.url)));
  // listTranscriptFiles keeps only names that pass isSessionId, so every id below is valid.
  const listing = listTranscriptFiles(files, deck.places.claudeHome);
  const problems = listing.unreadable.map((u) => `cannot read ${u.path} (${u.reason})`);
  const present = new Set(listing.files.map((file) => file.path));
  const changed = listing.files.filter((file) => !isUnchanged(rows.get(file.path), file));
  const result: ScanResult = {
    read: 0,
    skipped: listing.files.length - changed.length,
    missing: 0,
    prsAttached: 0,
  };

  changed.forEach((file, index) => {
    const row = rows.get(file.path) ?? null;
    let read: TranscriptRead | null = null;
    try {
      read = readTranscript(
        files,
        file,
        row === null ? null : { facts: factsOf(row), sizeRead: row.sizeRead },
      );
    } catch (error) {
      if (isGone(files, file.path)) {
        present.delete(file.path); // deleted since it was listed: marked missing below
      } else {
        problems.push(`cannot read ${file.path} (${describeError(error)})`);
      }
    }
    if (read !== null) {
      if (!fitsDatabase(read.facts, file.mtimeNs)) {
        // Outside the years 1677–2262: said plainly rather than as the store's bind error.
        problems.push(`cannot record ${file.path}: a time is out of range`);
      } else {
        try {
          result.prsAttached += saveFile(deck, file, read, now, attached);
          result.read++;
        } catch (error) {
          if (isDatabaseFailure(error)) {
            throw error; // not about this file: every other one would wait and fail the same way
          }
          problems.push(`cannot record ${file.path} (${describeError(error)})`);
        }
      }
    }
    progress?.(index + 1, changed.length);
  });

  const unreadable = listing.unreadable.map((u) => u.path);
  const missing = [...rows.values()].filter(
    (row) =>
      row.missingSinceNs === null &&
      !present.has(row.path) &&
      !unreadable.some((path) => row.path === path || row.path.startsWith(`${path}/`)),
  );
  if (missing.length > 0) {
    store.transaction(() => {
      // A row from the database with a time from the clock: only the database itself can fail.
      for (const row of missing) {
        store.saveTranscript({ ...row, missingSinceNs: now });
      }
    });
  }
  result.missing = missing.length;

  if (store.getKv('first_scan_done') !== '1') {
    store.setKv('first_scan_done', '1');
  }
  recordProblems(store, 'scan_problems', problems);
  return result;
}

/**
 * Saves the row of a file that was read and attaches the pull requests it names, in one
 * transaction. Returns how many of those attachments are new (counted once each per scan).
 */
function saveFile(
  deck: Deck,
  file: TranscriptFile,
  read: TranscriptRead,
  now: Ns,
  attached: Set<string>,
): number {
  const { store } = deck;
  const added = store.transaction(() => {
    store.saveTranscript({
      path: file.path,
      sessionId: file.sessionId,
      sizeRead: read.sizeRead,
      fileSize: file.size,
      mtimeNs: file.mtimeNs,
      ...read.facts,
      missingSinceNs: null,
    });
    const pairs = new Set<string>();
    for (const url of read.prUrls) {
      const key = prKey(url);
      if (key === null) {
        continue;
      }
      store.ensurePr(key); // attachPr needs the prs row
      store.attachPr(file.sessionId, key.url, 'auto', now);
      const pair = pairKey(file.sessionId, key.url);
      if (!attached.has(pair)) {
        pairs.add(pair);
      }
    }
    return pairs;
  });
  // Only once committed: a rolled-back attachment is new again next time.
  for (const pair of added) {
    attached.add(pair);
  }
  return added.size;
}

/** Skipped: a row with the same size and modification time, not marked missing. */
function isUnchanged(row: TranscriptRow | undefined, file: TranscriptFile): boolean {
  return (
    row !== undefined &&
    row.fileSize === file.size &&
    row.mtimeNs === file.mtimeNs &&
    row.missingSinceNs === null
  );
}

function factsOf(row: TranscriptRow): TranscriptFacts {
  return {
    firstCwd: row.firstCwd,
    entrypoint: row.entrypoint,
    aiTitle: row.aiTitle,
    customTitle: row.customTitle,
    firstRecordNs: row.firstRecordNs,
    lastRecordNs: row.lastRecordNs,
    lastUserNs: row.lastUserNs,
    lastTurnRole: row.lastTurnRole,
  };
}

/** Whether every time of the row fits the database's 64-bit integers. */
function fitsDatabase(facts: TranscriptFacts, mtimeNs: Ns): boolean {
  return [facts.firstRecordNs, facts.lastRecordNs, facts.lastUserNs, mtimeNs].every(
    (ns: Ns | null) => ns === null || (ns >= INT64_MIN && ns <= INT64_MAX),
  );
}

/** Whether nothing is at `path` any more (a failure to look counts as "still there"). */
function isGone(files: Files, path: string): boolean {
  try {
    return files.lstat(path) === null;
  } catch {
    return false;
  }
}

const pairKey = (sessionId: string, url: string): string => `${sessionId} ${url}`;
