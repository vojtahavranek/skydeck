// S2 12.7, plan C9: the restore banner, decided by the view model (the page decides no rule, S2
// 4.3). Pure: it imports only types and the sanitiser.
import type { RestoreEntry, RestorePlan } from '../../sessions/restore.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { BannerEntryPayload, BannerPayload } from '../protocol.ts';

/**
 * The form of /proc/sys/kernel/random/boot_id, the only one `dismiss-restore` takes (plan C 2.2):
 * an offer for a boot of another form could never be dismissed. An event's boot id is any text of
 * a spool file, so it is checked here.
 */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RUNNING_ONLY: Readonly<BannerPayload> = {
  bootId: null,
  lastActivityNs: null,
  entries: [],
  shown: true,
  running: true,
};

/**
 * C9 over the plan of the tick's rows (null when it could not be made), the stored dismissal and
 * whether a restore runs. The offer is design 7.8's default set: the plan's entries of its latest
 * earlier boot, in the plan's (list) order, each session once (the switcher's offer counts them),
 * with every text sanitised as the list's are. No offer — no plan, no entries, or an earlier boot
 * whose id is not a lower-case UUID — gives null while no restore runs, else a banner that only
 * says one runs. `shown` is false once the user said "Not now" for that boot (`dismissedBootId`,
 * kv `window_restore_dismissed`): the page then shows nothing, stage E's switcher still offers it.
 */
export function bannerPayload(input: {
  plan: RestorePlan | null;
  dismissedBootId: string | null;
  running: boolean;
}): BannerPayload | null {
  const { plan, dismissedBootId, running } = input;
  const earlier = plan?.earlier ?? null;
  const entries =
    plan === null || earlier === null || !BOOT_ID.test(earlier.bootId)
      ? []
      : onceEach(plan.entries.filter((entry) => entry.bootId === earlier.bootId));
  if (earlier === null || entries.length === 0) {
    return running ? { ...RUNNING_ONLY } : null;
  }
  return {
    bootId: earlier.bootId,
    lastActivityNs: String(earlier.lastEventNs),
    entries: entries.map(entryPayload),
    shown: dismissedBootId !== earlier.bootId,
    running,
  };
}

/** The entries with each session once, at its first place. */
function onceEach(entries: readonly RestoreEntry[]): RestoreEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.row.id)) return false;
    seen.add(entry.row.id);
    return true;
  });
}

function entryPayload(entry: RestoreEntry): BannerEntryPayload {
  const { row } = entry;
  return {
    sessionId: row.id,
    shortId: row.shortId,
    title: sanitize(row.title),
    endedAtNs: entry.endedAtNs === null ? null : String(entry.endedAtNs),
    wasWorking: entry.wasWorking,
    preselected: entry.preselected,
  };
}
