// The one way to start preparing a resume (design 7.6): the guard owns the freshness of what it
// decides on. A start event another skydeck's claude has written is a file in the spool until a
// refresh ingests it, and a row loaded before that does not show it.
import { RefError } from '../platform/errors.ts';
import { sanitize } from '../text/sanitize.ts';
import type { Deck } from './deck.ts';
import { loadRows } from './load.ts';
import { refresh } from './refresh.ts';
import { prepareResume } from './resume.ts';
import type { PreparedLaunch } from './resume.ts';

/**
 * refresh(deck) (ingest, reconcile, scan, sweep), loadRows(deck), the row whose id is `sessionId`,
 * then prepareResume on it — in this order, with nothing in between, so the guard decides on what
 * is on disk now. The command, the interactive list and restore resolve what the user pointed at
 * to a session id however they like, and call this with the id, never with a row they loaded
 * earlier. `sessionId` must be a whole session id: a prefix or a label names nothing here. Throws
 * RefError when the refreshed deck has no such session, and what prepareResume throws.
 */
export function prepareResumeById(deck: Deck, sessionId: string): PreparedLaunch {
  refresh(deck);
  const row = loadRows(deck).find((candidate) => candidate.id === sessionId);
  if (row === undefined) {
    throw new RefError(`no session matches '${sanitize(sessionId)}'`, []);
  }
  return prepareResume(deck, row);
}
