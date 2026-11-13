// The three steps every skydeck command except `hook` starts with (design 5.3).
import type { Deck } from './deck.ts';
import { ingestSpool } from './ingest.ts';
import type { IngestResult } from './ingest.ts';
import { reconcile } from './reconcile.ts';
import { scanTranscripts } from './scan.ts';
import type { ScanResult } from './scan.ts';

export interface RefreshResult {
  ingest: IngestResult;
  observed: number;
  scan: ScanResult;
}

/**
 * ingestSpool, reconcile, scanTranscripts — in this order (5.3). Task 16 adds sweepLocks at the end.
 * Never throws for one spool file, live process or transcript, whatever fails while it is read or
 * saved: that one is skipped and recorded in kv (`ingest_problems`, `reconcile_problems`,
 * `scan_problems`). A failure of the database itself (isDatabaseFailure) ends the command.
 */
export function refresh(
  deck: Deck,
  progress?: (done: number, total: number) => void,
): RefreshResult {
  const ingest = ingestSpool(deck);
  const { observed } = reconcile(deck);
  const scan = scanTranscripts(deck, progress);
  return { ingest, observed, scan };
}
