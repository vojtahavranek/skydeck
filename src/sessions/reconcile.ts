// 5.4: sessions that no hook reported — started before `skydeck install`, or whose spool file was
// lost — are recorded from Claude Code's live-session files as `observed` events. Nothing that
// comes from one live process stops the reconcile: the whole handling of one (looking at it and
// saving its event) is guarded, and an error is recorded for doctor (problems.ts) and that process
// skipped. A failure of the database as a whole (isDatabaseFailure) ends the command at once.
import { absolutizePathFlags, storableArgv } from '../claude/launch.ts';
import { isLiveFileTrusted, readLiveFiles } from '../claude/live.ts';
import type { LiveFile } from '../claude/live.ts';
import { argvFromCmdline } from '../claude/procstat.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Ns, Platform } from '../platform/types.ts';
import { isDatabaseFailure } from '../store/store.ts';
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
 * prompt, removed flag or unknown flag's value is stored (principle 4).
 *
 * Never throws for one process: an error while looking at one or saving its event (the store's
 * included) is recorded in kv `reconcile_problems` (replaced on every run) and the next one is
 * looked at. A failure of the database as a whole is thrown at once. Without a boot id nothing is reconciled, and that is recorded too.
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
      if (isCandidate(platform, file, now) && recordObserved(deck, bootId, file, now)) {
        observed++;
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

/** Inserts the observed event of `file`'s process when 5.4 asks for one; whether it did. */
function recordObserved(deck: Deck, bootId: string, file: LiveFile, now: Ns): boolean {
  const { platform, store } = deck;
  const { pid, procStart } = file;
  const argv = launchCommand(platform, file);
  const needed = (atNs: Ns): boolean => {
    const latest = store.latestEventOfProcess(bootId, pid, procStart, atNs);
    return (
      latest === null ||
      latest.sessionId !== file.sessionId ||
      (argv !== null && !store.processHasLaunch(bootId, pid, procStart))
    );
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

/** The launch command to store, from /proc/<pid>/cmdline; null when it cannot be read or is empty. */
function launchCommand(platform: Platform, file: LiveFile): string[] | null {
  const bytes = platform.proc.cmdline(file.pid);
  const recorded = bytes === null ? [] : argvFromCmdline(bytes);
  if (recorded.length === 0) {
    return null;
  }
  const exists = (path: string): boolean => platform.files.stat(path) !== null;
  return storableArgv(absolutizePathFlags(recorded, file.cwd, exists));
}
