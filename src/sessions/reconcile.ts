// 5.4: sessions that no hook reported — started before `skydeck install`, or whose spool file was
// lost — are recorded from Claude Code's live-session files as `observed` events. Nothing that
// comes from one live process stops the reconcile: the whole handling of one (looking at it and
// saving its event) is guarded, and an error is recorded for doctor (problems.ts) and that process
// skipped. A failure of the database as a whole (isDatabaseFailure) ends the command at once.
import { absolutizePathFlags, copiedSessionOf, storableArgv } from '../claude/launch.ts';
import { isLiveFileTrusted, readLiveFiles } from '../claude/live.ts';
import type { LiveFile, ProcessKey } from '../claude/live.ts';
import { argvFromCmdline } from '../claude/procstat.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Ns, Platform } from '../platform/types.ts';
import { isDatabaseFailure } from '../store/store.ts';
import { copyLinkTarget, linkCopy } from './copies.ts';
import type { Deck } from './deck.ts';
import { describeError, recordProblems } from './problems.ts';

/** A live file modified more recently than this may still be in the middle of a change (5.4). */
const SETTLE_NS = 2n * NS_PER_SECOND;

/**
 * 5.4. Inserts observed events (launch command = storableArgv of the recorded one); returns how
 * many. Kept: live files that are trusted (5.5), whose entrypoint is `cli` or absent, and that were
 * last modified more than 2 s before now. Such a process gets an observed event when its latest
 * event does not name the file's session, or when it has no event with a launch command and its
 * /proc/<pid>/cmdline can be read now. An observed event's time is the clock now (D21); its launch
 * command is storableArgv(absolutizePathFlags(cmdline, file.cwd)), as for a spooled one, so no
 * prompt, removed flag or unknown flag's value is stored (principle 4). F33: a process whose
 * command line makes a copy (`copiedSessionOf`) gets the copy link on its first event when it has
 * none yet (`linkCopy`), whether or not it got an observed event: so a copy recorded before skydeck
 * knew of copies is linked while its process still runs. Only the id is kept.
 *
 * Never throws for one process: an error while looking at one or saving its event (the store's
 * included) is recorded in kv `reconcile_problems` (replaced on every run) and the next one is
 * looked at. A failure of the database as a whole is thrown at once. Without a boot id nothing is
 * reconciled, and that is recorded too; a boot id that cannot be read for another reason than its
 * absence (Proc.bootId throws) is thrown, as is unknown liveness everywhere (design 5.5).
 */
export function reconcile(deck: Deck): { observed: number } {
  const { platform, store } = deck;
  const bootId = platform.proc.bootId();
  if (bootId === null) {
    recordProblems(store, 'reconcile_problems', ['cannot read the boot id: reconcile skipped']);
    return { observed: 0 };
  }
  const now = platform.clock.nowNs();
  const problems: string[] = [];
  let observed = 0;

  // readLiveFiles keeps only files whose session id passes isSessionId.
  for (const file of readLiveFiles(platform.files, deck.places.claudeHome)) {
    try {
      if (isCandidate(platform, file, now)) {
        const recorded = recordedCommand(platform, file);
        if (recordObserved(deck, bootId, file, now, storedCommand(platform, file, recorded))) {
          observed++;
        }
        const copyOf = recorded === null ? null : copiedSessionOf(recorded);
        if (copyOf !== null) {
          recordCopy(deck, { bootId, pid: file.pid, procStart: file.procStart }, copyOf);
        }
      }
    } catch (error) {
      if (isDatabaseFailure(error)) {
        throw error; // not about this process: every other one would wait and fail the same way
      }
      problems.push(`process ${file.pid}: ${describeError(error)}`);
    }
  }

  recordProblems(store, 'reconcile_problems', problems);
  return { observed };
}

/**
 * Inserts the observed event of `file`'s process when 5.4 asks for one, with `argv` as its launch
 * command; whether it did.
 */
function recordObserved(
  deck: Deck,
  bootId: string,
  file: LiveFile,
  now: Ns,
  argv: string[] | null,
): boolean {
  const { platform, store } = deck;
  const { pid, procStart } = file;
  const needed = (atNs: Ns): boolean => {
    const latest = store.latestEventOfProcess(bootId, pid, procStart, atNs);
    if (latest === null) {
      return true;
    }
    if (latest.sessionId === file.sessionId) {
      return argv !== null && !store.processHasLaunch(bootId, pid, procStart);
    }
    // The file names another session. It wins only when it was written after the latest event (the
    // hook of the change was lost); an event newer than the file is the hook speaking after the
    // file was last written (an in-session `/resume` or `/clear`), and the file is stale. An
    // `observed` event is not the hook: it is stamped with the clock at reconcile, later than the
    // file it was read from, and the file has changed since, so the file wins.
    return latest.kind === 'observed' || latest.timeNs <= file.mtimeNs;
  };
  if (!needed(now)) {
    return false;
  }
  return store.transaction(() => {
    // Asked again with the write lock held, and with the clock read now: another skydeck may have
    // recorded this process since, with a time after the `now` of this run.
    const atNs = platform.clock.nowNs();
    if (!needed(atNs)) {
      return false;
    }
    store.insertEvent({
      spoolName: null,
      timeNs: atNs,
      kind: 'observed',
      detail: '',
      rawDetail: null,
      sessionId: file.sessionId,
      bootId,
      pid,
      procStart,
      cwd: file.cwd,
      argv,
      name: file.name,
      payload: null,
    });
    return true;
  });
}

/** 5.4: trusted (5.5), entrypoint cli or absent, last modified more than 2 s ago. */
function isCandidate(platform: Platform, file: LiveFile, now: Ns): boolean {
  return (
    isLiveFileTrusted(file, platform.proc) &&
    (file.entrypoint === null || file.entrypoint === 'cli') &&
    file.mtimeNs < now - SETTLE_NS
  );
}

/** F33: the copy link of a copy's process when it has none yet (checked first, outside a write). */
function recordCopy(deck: Deck, process: ProcessKey, copyOf: string): void {
  const { store } = deck;
  if (copyLinkTarget(store, process, copyOf) !== null) {
    store.transaction(() => linkCopy(store, process, copyOf));
  }
}

/** The process's command line as recorded (/proc/<pid>/cmdline); null when unreadable or empty. */
function recordedCommand(platform: Platform, file: LiveFile): string[] | null {
  const bytes = platform.proc.cmdline(file.pid);
  const recorded = bytes === null ? [] : argvFromCmdline(bytes);
  return recorded.length === 0 ? null : recorded;
}

/** The launch command to store of a recorded one (5.3); null for none. */
function storedCommand(
  platform: Platform,
  file: LiveFile,
  recorded: string[] | null,
): string[] | null {
  if (recorded === null) {
    return null;
  }
  const exists = (path: string): boolean => platform.files.stat(path) !== null;
  return storableArgv(absolutizePathFlags(recorded, file.cwd, exists));
}
