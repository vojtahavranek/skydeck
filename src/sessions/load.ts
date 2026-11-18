// The deck's sessions as the list shows them: derived state (design 6) put through the list model.
import { isAlive, isLiveFileTrusted, readLiveFiles } from '../claude/live.ts';
import { cleanupPeriodDays, settingsPath } from '../claude/settings.ts';
import type { SessionMeta } from '../store/types.ts';
import type { Deck } from './deck.ts';
import { deriveSessions } from './derive.ts';
import { buildRows } from './list.ts';
import type { ListRow } from './list.ts';
import type { DerivedSession } from './types.ts';

/**
 * Claude Code's `cleanupPeriodDays`, 30 when the settings file is missing, has none, or cannot be
 * read: that file belongs to Claude Code, and the list must not stop for it (`doctor` looks at it).
 */
function retentionDays(deck: Deck): number {
  let text: string | null = null;
  try {
    text = deck.platform.files.readText(settingsPath(deck.places.claudeHome));
  } catch {
    // unreadable: the default
  }
  return cleanupPeriodDays(text);
}

function derive(deck: Deck, metas: readonly SessionMeta[]): DerivedSession[] {
  const { platform, store } = deck;
  const bootId = platform.proc.bootId();
  return deriveSessions({
    events: store.events(),
    links: store.links(),
    transcripts: store.transcripts(),
    metas,
    liveFiles: readLiveFiles(platform.files, deck.places.claudeHome),
    bootId,
    isAlive: (key) => isAlive(key, platform.proc, bootId),
    isTrusted: (file) => isLiveFileTrusted(file, platform.proc),
    nowNs: platform.clock.nowNs(),
    retentionDays: retentionDays(deck),
  });
}

/**
 * Builds DeriveInput from the store (events, links, transcripts, allMeta), readLiveFiles,
 * isAlive/isLiveFileTrusted with proc and proc.bootId(), clock now, and
 * cleanupPeriodDays(content of settingsPath(claudeHome)); returns deriveSessions(input).
 * Reads only: it does not refresh.
 */
export function loadSessions(deck: Deck): DerivedSession[] {
  return derive(deck, deck.store.allMeta());
}

/** loadSessions + store allMeta/prs/sessionPrs + buildRows with config.groupPattern and
 *  config.ticketUrl. */
export function loadRows(deck: Deck): ListRow[] {
  const metas = deck.store.allMeta();
  return buildRows({
    sessions: derive(deck, metas),
    metas,
    prs: deck.store.prs(),
    sessionPrs: deck.store.sessionPrs(),
    groupPattern: deck.config.groupPattern,
    ticketUrl: deck.config.ticketUrl,
  });
}
