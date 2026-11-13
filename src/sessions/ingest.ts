// 5.3 step 1: the spool files the hook wrote become event rows (and links), then the spool is
// cleaned up. Nothing that comes from one spool file stops the ingest — reading, parsing and
// saving it are all guarded: a file that cannot be read or parsed is moved to spool/bad/, one
// whose row cannot be saved stays in the spool for the next refresh, and the reason is recorded
// for doctor (problems.ts). A failure of the database as a whole (isDatabaseFailure) is not about
// one file and ends the command at once.
import { join } from 'node:path';

import { SpoolParseError, parseSpoolFile } from '../claude/hookinput.ts';
import type { SpoolEvent } from '../claude/hookinput.ts';
import { NS_PER_DAY, NS_PER_MINUTE } from '../platform/time.ts';
import type { Files, Ns } from '../platform/types.ts';
import { isDatabaseFailure } from '../store/store.ts';
import type { LinkKind } from '../store/types.ts';
import type { Deck } from './deck.ts';
import { describeError, recordProblems } from './problems.ts';

export interface IngestResult {
  ingested: number;
  duplicates: number;
  bad: number;
  scripted: number;
}

/** Files in spool/bad/ are kept this long for diagnosis (design 5.3). */
const BAD_FILE_AGE_NS = 7n * NS_PER_DAY;
/** A younger leftover `.<name>.tmp` may belong to a hook that is still writing it (design 5.3). */
const TEMPORARY_FILE_AGE_NS = 60n * NS_PER_MINUTE;

/** A start event with one of these details links the process's previous session to its new one. */
const LINK_KINDS: Readonly<Partial<Record<SpoolEvent['detail'], LinkKind>>> = {
  clear: 'clear',
  resume: 'switch',
  fork: 'fork',
};

/**
 * 5.3 step 1. Reads <spoolDir>/*.ev in name order (dot files and bad/ ignored). Afterwards removes
 * the files in <badDir> older than seven days and the leftover `.<name>.tmp` files in <spoolDir>
 * older than one hour (age = modification time against the platform clock; a younger temporary
 * file may belong to a running hook). The removals are not counted in the result.
 *
 * Never throws for one file: a spool file that is not a regular file, cannot be read, or does not
 * parse (for any reason) is moved to spool/bad/; one whose row cannot be saved (any error the row
 * causes, the store's included), or that cannot be moved or removed, stays where it is. A failure
 * of the database as a whole is thrown at once, and the file stays. A scripted event that is
 * dropped (5.3: every one but the start of a process on a session skydeck knows) is counted once
 * its file is removed; a kept one counts as ingested. Each such problem is recorded in kv
 * `ingest_problems` (replaced on every run).
 */
export function ingestSpool(deck: Deck): IngestResult {
  const { files } = deck.platform;
  const { spoolDir } = deck.places;
  const result: IngestResult = { ingested: 0, duplicates: 0, bad: 0, scripted: 0 };
  const problems: string[] = [];
  const names = listOrNote(files, spoolDir, problems);
  const movedToBad = new Set<string>();
  const known: KnownSessions = { fromTranscripts: null };

  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.ev')) {
      continue;
    }
    const path = join(spoolDir, name);
    let event: SpoolEvent;
    try {
      const read = readSpoolFile(files, path);
      if (read === null) {
        continue; // gone: another skydeck took it
      }
      event = parseSpoolFile(name, read, (p) => files.stat(p) !== null);
    } catch (error) {
      result.bad++;
      if (moveToBad(deck, name, describeError(error), problems)) {
        movedToBad.add(name);
      }
      continue;
    }
    try {
      if (event.scripted && !holdsKnownSession(deck, event, known)) {
        // Counted once the file is gone, so that a file that cannot be removed is not counted again.
        if (removeOrNote(files, path, `spool file ${name}`, problems)) {
          deck.store.addToKv('dropped_scripted', 1);
          result.scripted++;
        }
        continue;
      }
      if (insert(deck, event) === null) {
        result.duplicates++;
      } else {
        result.ingested++;
      }
    } catch (error) {
      if (isDatabaseFailure(error)) {
        throw error; // not about this file: every other one would wait and fail the same way
      }
      problems.push(`spool file ${name} could not be recorded (${describeError(error)})`);
      continue;
    }
    // Only now, with the row committed: a file is never lost before its event is stored.
    removeOrNote(files, path, `spool file ${name}`, problems);
  }

  removeExpired(deck, names, movedToBad, problems);
  recordProblems(deck.store, 'ingest_problems', problems);
  return result;
}

/** The text of a spool file; null when it is gone. Throws when it is not a regular file. */
function readSpoolFile(files: Files, path: string): string | null {
  const info = files.lstat(path);
  if (info === null) {
    return null;
  }
  if (info.kind !== 'file') {
    throw new SpoolParseError('not a regular file');
  }
  return files.readText(path);
}

/** The sessions a transcript makes known, read once per ingest and only when a scripted run needs them. */
interface KnownSessions {
  fromTranscripts: ReadonlySet<string> | null;
}

/**
 * 5.3 "Scripted runs": whether a scripted event is kept — a start of a process (a pid and a process
 * start time: without them it could never be found alive) on a session skydeck already knows, from
 * an event or from a transcript that the list would show (entry point `cli`, or none); and the end
 * of the session such a kept start holds (an SDK host or an editor extension can clear or switch
 * inside one process). A scripted run that starts its own session, and any other end, is dropped.
 */
function holdsKnownSession(deck: Deck, event: SpoolEvent, known: KnownSessions): boolean {
  if (event.pid === 0 || event.procStart === null) {
    return false;
  }
  const { store } = deck;
  if (event.kind === 'end') {
    const held = store.latestEventOfProcess(event.bootId, event.pid, event.procStart, event.timeNs);
    return held?.kind === 'scripted' && held.sessionId === event.sessionId;
  }
  if (store.latestEventIdOfSession(event.sessionId) !== null) {
    return true;
  }
  known.fromTranscripts ??= new Set(
    store
      .transcripts()
      .filter((row) => row.entrypoint === null || row.entrypoint === 'cli')
      .map((row) => row.sessionId),
  );
  return known.fromTranscripts.has(event.sessionId);
}

/**
 * Inserts the event and, for a start that clears, resumes or forks, the link from the session the
 * same process held before (5.3 "Links"), in one transaction. Returns the new id, or null when the
 * spool file was ingested before. A scripted start (of a known session) is stored as an event of
 * kind `scripted`, which says only that its process holds the session, and its end as one of kind
 * `scripted-end`, which says only that the process no longer does: no detail, launch command or
 * name, and no link.
 */
function insert(deck: Deck, event: SpoolEvent): number | null {
  const { store } = deck;
  if (event.scripted) {
    return store.insertEvent({
      spoolName: event.spoolName,
      timeNs: event.timeNs,
      kind: event.kind === 'start' ? 'scripted' : 'scripted-end',
      detail: '',
      rawDetail: event.rawDetail,
      sessionId: event.sessionId,
      bootId: event.bootId,
      pid: event.pid,
      procStart: event.procStart,
      cwd: event.cwd,
      argv: null,
      name: null,
      payload: event.payload,
    });
  }
  const linkKind = event.kind === 'start' ? LINK_KINDS[event.detail] : undefined;
  return store.transaction(() => {
    // Before inserting, so that the new event is not its own predecessor. pid 0: no process (D7).
    const previous =
      linkKind !== undefined && event.pid !== 0
        ? store.latestEventOfProcess(event.bootId, event.pid, event.procStart, event.timeNs)
        : null;
    const argv = (event.kind === 'start' ? storedLaunch(deck, event) : null) ?? event.argv;
    const id = store.insertEvent({
      spoolName: event.spoolName,
      timeNs: event.timeNs,
      kind: event.kind,
      detail: event.detail,
      rawDetail: event.rawDetail,
      sessionId: event.sessionId,
      bootId: event.bootId,
      pid: event.pid,
      procStart: event.procStart,
      cwd: event.cwd,
      argv,
      name: event.name,
      payload: event.payload,
    });
    if (
      id !== null &&
      linkKind !== undefined &&
      previous !== null &&
      previous.sessionId !== event.sessionId
    ) {
      store.insertLink({
        eventId: id,
        fromSession: previous.sessionId,
        toSession: event.sessionId,
        kind: linkKind,
        timeNs: event.timeNs,
      });
    }
    return id;
  });
}

/**
 * The launch command the FIRST `start` of the same process that stored one stored, null when none
 * did (the first start ran where the process was launched). A process's
 * command line never changes, but a later start (after `/clear`, an in-session `/resume`, or once
 * the session changed directory) resolves its relative path flags against the hook input's cwd of
 * that moment, which need not be where the process was launched. A process is known only with a pid
 * and a process start time: without them two processes could not be told apart.
 */
function storedLaunch(deck: Deck, event: SpoolEvent): string[] | null {
  if (event.pid === 0 || event.procStart === null) {
    return null;
  }
  // Walks the process's events back to its first, keeping the earliest start with a command.
  let first: string[] | null = null;
  let beforeNs = event.timeNs;
  for (;;) {
    const earlier = deck.store.latestEventOfProcess(
      event.bootId,
      event.pid,
      event.procStart,
      beforeNs,
    );
    if (earlier === null) {
      return first;
    }
    if (earlier.kind === 'start' && earlier.argv !== null) {
      first = earlier.argv;
    }
    // Two events of one process in the same nanosecond are not told apart here: at worst the one
    // skipped is not considered.
    beforeNs = earlier.timeNs - 1n;
  }
}

/** Moves <spoolDir>/<name> to <badDir>/<name> (creating badDir), noting what happened. */
function moveToBad(deck: Deck, name: string, reason: string, problems: string[]): boolean {
  const { files } = deck.platform;
  const { spoolDir, badDir } = deck.places;
  const path = join(spoolDir, name);
  try {
    files.mkdirp(badDir, 0o700);
    files.rename(path, join(badDir, name));
    problems.push(`spool file ${name} moved to spool/bad/: ${reason}`);
    return true;
  } catch (error) {
    problems.push(
      `cannot move spool file ${name} to spool/bad/ (${describeError(error)}): ${reason}`,
    );
    return false;
  }
}

/**
 * Design 5.3 retention. A bad file's age is the time since the hook wrote it (a move keeps the
 * modification time), but one moved in this run stays until the next, so that what the problem
 * line says is there is there. Directories are never removed.
 */
function removeExpired(
  deck: Deck,
  spoolNames: readonly string[],
  movedToBad: ReadonlySet<string>,
  problems: string[],
): void {
  const { files } = deck.platform;
  const { spoolDir, badDir } = deck.places;
  const now = deck.platform.clock.nowNs();
  for (const name of spoolNames) {
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      removeIfOlder(files, join(spoolDir, name), now - TEMPORARY_FILE_AGE_NS, problems);
    }
  }
  for (const name of listOrNote(files, badDir, problems)) {
    if (!movedToBad.has(name)) {
      removeIfOlder(files, join(badDir, name), now - BAD_FILE_AGE_NS, problems);
    }
  }
}

function removeIfOlder(files: Files, path: string, beforeNs: Ns, problems: string[]): void {
  try {
    const info = files.lstat(path);
    if (info === null || info.kind === 'dir' || info.mtimeNs >= beforeNs) {
      return;
    }
    files.remove(path);
  } catch (error) {
    problems.push(`cannot remove ${path} (${describeError(error)})`);
  }
}

/** Removes the file; false (and noted) when that fails. */
function removeOrNote(files: Files, path: string, what: string, problems: string[]): boolean {
  try {
    files.remove(path);
    return true;
  } catch (error) {
    problems.push(`cannot remove ${what} (${describeError(error)})`);
    return false;
  }
}

/** The names in `dir` ([] when it does not exist); a directory that cannot be listed is noted. */
function listOrNote(files: Files, dir: string, problems: string[]): string[] {
  try {
    return files.list(dir);
  } catch (error) {
    problems.push(`cannot list ${dir} (${describeError(error)})`);
    return [];
  }
}
