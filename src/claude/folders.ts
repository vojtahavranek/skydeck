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
  /** Nothing is there (yet): Claude Code creates the folder when it first needs it. */
  missing: boolean;
  /** What cannot be read, and why (an error code): the folder itself, or (projects) anything under it. */
  unreadable: UnreadableEntry[];
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown error';
}

/**
 * Missing only when nothing at all is at `path`. A symbolic link that leads nowhere (ENOENT: Claude
 * Code cannot create the folder through it either) and something that is not a folder (ENOTDIR) are
 * unreadable, as is a folder that cannot be looked at or, when `list` is set, listed.
 */
function lookAtFolder(files: Files, path: string, list: boolean): FolderLook {
  const unreadable = (reason: string): FolderLook => ({
    path,
    missing: false,
    unreadable: [{ path, reason }],
  });
  try {
    if (files.lstat(path) === null) {
      return { path, missing: true, unreadable: [] };
    }
    const info = files.stat(path);
    if (info === null) {
      return unreadable('ENOENT');
    }
    if (info.kind !== 'dir') {
      return unreadable('ENOTDIR');
    }
    if (list) {
      files.list(path);
    }
    return { path, missing: false, unreadable: [] };
  } catch (error) {
    return unreadable(reasonOf(error));
  }
}

/**
 * Never throws for something it cannot read. `sessions`: missing, or unreadable when it leads
 * nowhere, is not a folder, or cannot be looked at or listed. `projects`: the same, and when it is a
 * folder, what `listTranscriptFiles` could not read under it, with the number of transcripts found.
 */
export function lookAtClaudeFolders(
  files: Files,
  claudeHome: string,
): { sessions: FolderLook; projects: FolderLook & { transcripts: number } } {
  const sessions = lookAtFolder(files, join(claudeHome, 'sessions'), true);
  const projects = lookAtFolder(files, join(claudeHome, 'projects'), false);
  if (projects.missing || projects.unreadable.length > 0) {
    return { sessions, projects: { ...projects, transcripts: 0 } };
  }
  const listing = listTranscriptFiles(files, claudeHome);
  return {
    sessions,
    projects: { ...projects, unreadable: listing.unreadable, transcripts: listing.files.length },
  };
}
