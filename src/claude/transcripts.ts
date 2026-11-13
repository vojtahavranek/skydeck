// Claude Code's transcripts, `<claudeHome>/projects/<folder>/<uuid>.jsonl` (design 5.6, 6.3, 14):
// which files count, and the few facts skydeck keeps from their records. Read-only (principle 2),
// and no message text is ever kept (principle 4): a record is parsed, the facts are taken from
// its metadata fields, and the record is dropped.
import { join } from 'node:path';

import { nsFromIso } from '../platform/time.ts';
import type { Files, Ns } from '../platform/types.ts';

export interface TranscriptFile {
  path: string;
  sessionId: string;
  size: number;
  mtimeNs: Ns;
}

/** Exactly a lowercase UUID and `.jsonl`: nested folders (subagents) and set-aside copies are not. */
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const EXTENSION_LENGTH = '.jsonl'.length;

/**
 * <claudeHome>/projects/<folder>/<uuid>.jsonl, exactly two levels deep, name exactly a lowercase
 * UUID + '.jsonl', regular files only (a symbolic link to a file is not one; a symbolic link to a
 * folder is followed, so that a relocated project folder still counts). Sorted by path. Folder
 * names are never parsed.
 */
export function listTranscriptFiles(files: Files, claudeHome: string): TranscriptFile[] {
  const root = join(claudeHome, 'projects');
  const found: TranscriptFile[] = [];
  for (const folder of files.list(root)) {
    const folderPath = join(root, folder);
    if (files.stat(folderPath)?.kind !== 'dir') {
      continue;
    }
    for (const name of files.list(folderPath)) {
      if (!TRANSCRIPT_NAME.test(name)) {
        continue;
      }
      const path = join(folderPath, name);
      const info = files.lstat(path);
      if (info?.kind !== 'file') {
        continue;
      }
      found.push({
        path,
        sessionId: name.slice(0, -EXTENSION_LENGTH),
        size: info.size,
        mtimeNs: info.mtimeNs,
      });
    }
  }
  // By the whole path (code units): 'a-b/x' sorts before 'a/x', though 'a' sorts before 'a-b'.
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface TranscriptFacts {
  firstCwd: string | null; // first record carrying a string cwd
  entrypoint: string | null; // first record carrying a string entrypoint
  aiTitle: string | null; // latest 'ai-title' record's aiTitle
  customTitle: string | null; // latest 'custom-title' record's customTitle
  firstRecordNs: Ns | null; // smallest parseable timestamp
  lastRecordNs: Ns | null; // largest parseable timestamp
  lastUserNs: Ns | null; // largest timestamp of a record with type 'user'
  lastTurnRole: 'user' | 'assistant' | null; // type of the last (in file order) 'user' or 'assistant' record
}

export const EMPTY_FACTS: TranscriptFacts = Object.freeze({
  firstCwd: null,
  entrypoint: null,
  aiTitle: null,
  customTitle: null,
  firstRecordNs: null,
  lastRecordNs: null,
  lastUserNs: null,
  lastTurnRole: null,
});

/** The record a line holds, or null when the line is not a JSON object. */
function parseRecord(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * Folds complete JSONL lines into facts. Lines that are not JSON objects are skipped. Returns the
 * prUrl of every 'pr-link' record with a string prUrl, in order. Keeps no message text. The facts
 * given are not changed.
 *
 * A first cwd or entrypoint must be a non-empty string; a title is kept as found, an empty one
 * included (a cleared name replaces the one before it) and unsanitised (that is the list's job).
 * The last turn follows file order; the times follow the timestamps, which are not in order.
 */
export function foldLines(
  facts: TranscriptFacts,
  lines: readonly string[],
): { facts: TranscriptFacts; prUrls: string[] } {
  let { firstCwd, entrypoint, aiTitle, customTitle } = facts;
  let { firstRecordNs, lastRecordNs, lastUserNs, lastTurnRole } = facts;
  const prUrls: string[] = [];
  for (const line of lines) {
    const record = parseRecord(line);
    if (record === null) {
      continue;
    }
    const type = record.type;
    const ns = typeof record.timestamp === 'string' ? nsFromIso(record.timestamp) : null;
    if (ns !== null) {
      if (firstRecordNs === null || ns < firstRecordNs) {
        firstRecordNs = ns;
      }
      if (lastRecordNs === null || ns > lastRecordNs) {
        lastRecordNs = ns;
      }
      if (type === 'user' && (lastUserNs === null || ns > lastUserNs)) {
        lastUserNs = ns;
      }
    }
    if (type === 'user' || type === 'assistant') {
      lastTurnRole = type;
    }
    if (firstCwd === null && typeof record.cwd === 'string' && record.cwd !== '') {
      firstCwd = record.cwd;
    }
    if (entrypoint === null && typeof record.entrypoint === 'string' && record.entrypoint !== '') {
      entrypoint = record.entrypoint;
    }
    if (type === 'ai-title' && typeof record.aiTitle === 'string') {
      aiTitle = record.aiTitle;
    } else if (type === 'custom-title' && typeof record.customTitle === 'string') {
      customTitle = record.customTitle;
    } else if (type === 'pr-link' && typeof record.prUrl === 'string') {
      prUrls.push(record.prUrl);
    }
  }
  return {
    facts: {
      firstCwd,
      entrypoint,
      aiTitle,
      customTitle,
      firstRecordNs,
      lastRecordNs,
      lastUserNs,
      lastTurnRole,
    },
    prUrls,
  };
}

export interface TranscriptRead {
  facts: TranscriptFacts;
  sizeRead: number;
  prUrls: string[];
}

/** One read of a file is at most this many bytes, so that a transcript of any size is never held whole. */
const READ_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const utf8 = new TextDecoder('utf-8');

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/**
 * Reads bytes [previous.sizeRead, file.size) — or from 0 with EMPTY_FACTS when previous is null or
 * file.size < previous.sizeRead (shrunk) — splits on byte 0x0A, folds the complete lines, and
 * leaves a last line without a newline for the next read (sizeRead stops after the last 0x0A).
 * `prUrls` are those of the lines read now. Throws what `Files.readBytes` throws, for example when
 * the file has disappeared since it was listed.
 *
 * The file is read in pieces of a few megabytes and every line is decoded on its own, so that
 * a multi-byte character is never split, and only the lines of one piece are in memory at once.
 */
export function readTranscript(
  files: Files,
  file: TranscriptFile,
  previous: { facts: TranscriptFacts; sizeRead: number } | null,
): TranscriptRead {
  const resumed = previous !== null && file.size >= previous.sizeRead;
  let facts = resumed ? previous.facts : EMPTY_FACTS;
  const start = resumed ? previous.sizeRead : 0;
  let sizeRead = start;
  const prUrls: string[] = [];
  // Bytes after the last newline seen so far: the start of a line whose end is not read yet.
  let pending: Uint8Array[] = [];

  for (let offset = start; offset < file.size;) {
    const bytes = files.readBytes(file.path, offset, Math.min(offset + READ_BYTES, file.size));
    if (bytes.length === 0) {
      break; // the file is shorter than its recorded size
    }
    const lastNewline = bytes.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      pending.push(bytes);
    } else {
      const head = bytes.subarray(0, lastNewline + 1);
      const complete = pending.length === 0 ? head : concat([...pending, head]);
      pending = lastNewline + 1 < bytes.length ? [bytes.slice(lastNewline + 1)] : [];
      sizeRead = offset + lastNewline + 1;
      const lines: string[] = [];
      let from = 0;
      for (let end = complete.indexOf(NEWLINE); end !== -1; end = complete.indexOf(NEWLINE, from)) {
        if (end > from) {
          lines.push(utf8.decode(complete.subarray(from, end)));
        }
        from = end + 1;
      }
      const folded = foldLines(facts, lines);
      facts = folded.facts;
      for (const url of folded.prUrls) {
        prUrls.push(url);
      }
    }
    offset += bytes.length;
  }
  return { facts, sizeRead, prUrls };
}
