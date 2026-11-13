// Whether skydeck can read Claude Code's two folders (design 8, 5.6), for `skydeck doctor`. A
// refresh skips what it cannot read without a word (an unreadable sessions folder reads as no live
// sessions), so doctor has to look itself; and the folders are Claude Code's layout, which only
// src/claude/ knows (design 11).
import { join } from 'node:path';

import type { Files } from '../platform/types.ts';
import { listTranscriptFiles } from './transcripts.ts';
import type { UnreadableEntry } from './transcripts.ts';

export interface FolderLook {
  path: string;
  /** It does not exist (yet): Claude Code creates it when it first needs it. */
  missing: boolean;
  /** What cannot be read, and why (an error code): the folder itself, or (projects) anything under it. */
  unreadable: UnreadableEntry[];
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown error';
}

/** `<claudeHome>/sessions`: it exists, is a folder (else ENOTDIR) and can be listed. */
function lookAtSessions(files: Files, path: string): FolderLook {
  try {
    const info = files.stat(path);
    if (info === null) {
      return { path, missing: true, unreadable: [] };
    }
    if (info.kind !== 'dir') {
      return { path, missing: false, unreadable: [{ path, reason: 'ENOTDIR' }] };
    }
    files.list(path);
    return { path, missing: false, unreadable: [] };
  } catch (error) {
    return { path, missing: false, unreadable: [{ path, reason: reasonOf(error) }] };
  }
}

/**
 * Never throws for something it cannot read. `sessions`: missing, or unreadable when it cannot be
 * looked at or listed or is not a folder. `projects`: missing, or what `listTranscriptFiles` could
 * not read (the folder itself included), with the number of transcript files it found.
 */
export function lookAtClaudeFolders(
  files: Files,
  claudeHome: string,
): { sessions: FolderLook; projects: FolderLook & { transcripts: number } } {
  const sessions = lookAtSessions(files, join(claudeHome, 'sessions'));
  const path = join(claudeHome, 'projects');
  let missing: boolean;
  try {
    missing = files.stat(path) === null;
  } catch {
    missing = false; // listTranscriptFiles names it with the reason
  }
  if (missing) {
    return { sessions, projects: { path, missing, unreadable: [], transcripts: 0 } };
  }
  const listing = listTranscriptFiles(files, claudeHome);
  return {
    sessions,
    projects: { path, missing, unreadable: listing.unreadable, transcripts: listing.files.length },
  };
}
