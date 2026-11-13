// 5.6: the transcripts are read incrementally into the transcripts table, and the pull requests
// they name are attached (7.3 "Automatic"). Nothing that comes from one folder or one transcript
// stops the scan: what cannot be read is recorded for doctor (problems.ts) and skipped, and nothing
// at or under it is taken for deleted. An error of the database itself ends the command.
import { listTranscriptFiles, readTranscript } from '../claude/transcripts.ts';
import type { TranscriptFacts, TranscriptFile, TranscriptRead } from '../claude/transcripts.ts';
import { prKey } from '../github.ts';
import type { Files, Ns } from '../platform/types.ts';
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
 * 5.6. progress(done, total) is called after each file that is read (total: the files that
 * changed). Sets kv first_scan_done.
 *
 * A listed file whose size or modification time differs from its row (or that has no row, or a
 * row marked missing) is read from the row's offset; its facts are saved and the pull requests its
 * `pr-link` records name are attached with origin `auto` (a detached one stays detached). A row
 * whose file was not listed is marked missing, unless its path is at or under a path that could not
 * be read (the listing is partial there); a file that disappears between listing and reading is
 * missing too. Never throws for one folder or file: what cannot be read is recorded in kv
 * `scan_problems` (replaced on every run) and keeps its row as it was.
 */
export function scanTranscripts(
  deck: Deck,
  progress?: (done: number, total: number) => void,
): ScanResult {
  const { store } = deck;
  const { files } = deck.platform;
  const now = deck.platform.clock.nowNs();
  // listTranscriptFiles keeps only names that pass isSessionId, so every id below is valid.
  const listing = listTranscriptFiles(files, deck.places.claudeHome);
  const problems = listing.unreadable.map((u) => `cannot read ${u.path} (${u.reason})`);
  const rows = new Map(store.transcripts().map((row) => [row.path, row]));
  const attached = new Set(store.sessionPrs().map((r) => pairKey(r.sessionId, r.url)));
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
    let read: TranscriptRead;
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
      progress?.(index + 1, changed.length);
      return;
    }
    if (!fitsDatabase(read.facts)) {
      // A timestamp the database cannot hold (outside the years 1677–2262) would make the save
      // throw; the file is left unrecorded rather than stopping every command.
      problems.push(`cannot record ${file.path}: a time is out of range`);
    } else {
      store.transaction(() => {
        store.saveTranscript({
          path: file.path,
          sessionId: file.sessionId,
          sizeRead: read.sizeRead,
          fileSize: file.size,
          mtimeNs: file.mtimeNs,
          ...read.facts,
          missingSinceNs: null,
        });
        for (const url of read.prUrls) {
          const key = prKey(url);
          if (key === null) {
            continue;
          }
          store.ensurePr(key); // attachPr needs the prs row
          store.attachPr(file.sessionId, key.url, 'auto', now);
          const pair = pairKey(file.sessionId, key.url);
          if (!attached.has(pair)) {
            attached.add(pair);
            result.prsAttached++;
          }
        }
      });
      result.read++;
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

function fitsDatabase(facts: TranscriptFacts): boolean {
  return [facts.firstRecordNs, facts.lastRecordNs, facts.lastUserNs].every(
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
