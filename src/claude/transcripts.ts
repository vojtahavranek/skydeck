// Claude Code's transcripts, `<claudeHome>/projects/<folder>/<uuid>.jsonl` (design 5.6, 6.3, 14):
// which files count, and the few facts skydeck keeps from their records. Read-only (principle 2),
// and no message text is ever kept (principle 4): a record is parsed, the facts are taken from
// its metadata fields, and the record is dropped.
import { join } from 'node:path';

import { nsFromIso } from '../platform/time.ts';
import type { Files, Ns } from '../platform/types.ts';
import { isSessionId } from './live.ts';

export interface TranscriptFile {
  path: string;
  sessionId: string;
  size: number;
  mtimeNs: Ns;
}

const EXTENSION = '.jsonl';

/** A folder or file that could not be looked at or listed, and why (the error code, e.g. 'ELOOP'). */
export interface UnreadableEntry {
  path: string;
  reason: string;
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown error';
}

/** `look()`, or undefined (after noting `path` in `unreadable`) when it throws. */
function attempt<T>(unreadable: UnreadableEntry[], path: string, look: () => T): T | undefined {
  try {
    return look();
  } catch (error) {
    unreadable.push({ path, reason: reasonOf(error) });
    return undefined;
  }
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * <claudeHome>/projects/<folder>/<uuid>.jsonl, exactly two levels deep, name exactly a lowercase
 * UUID + '.jsonl' (`isSessionId`), regular files only (a symbolic link to a file is not one; a
 * symbolic link to a folder is followed, so that a relocated project folder still counts). `files`
 * is sorted by path. Folder names are never parsed.
 *
 * Never throws for one bad entry: a folder or file that cannot be looked at or listed (a symbolic
 * link loop, permissions), or an unreadable `projects` directory, is noted in `unreadable` (sorted
 * by path, each with the error code) and the rest is listed. A listing with anything in
 * `unreadable` is partial: what is missing from it must not be taken for deleted.
 */
export function listTranscriptFiles(
  files: Files,
  claudeHome: string,
): { files: TranscriptFile[]; unreadable: UnreadableEntry[] } {
  const root = join(claudeHome, 'projects');
  const found: TranscriptFile[] = [];
  const unreadable: UnreadableEntry[] = [];
  for (const folder of attempt(unreadable, root, () => files.list(root)) ?? []) {
    const folderPath = join(root, folder);
    const folderInfo = attempt(unreadable, folderPath, () => files.stat(folderPath));
    if (folderInfo?.kind !== 'dir') {
      continue;
    }
    for (const name of attempt(unreadable, folderPath, () => files.list(folderPath)) ?? []) {
      const sessionId = name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : '';
      if (!isSessionId(sessionId)) {
        continue;
      }
      const path = join(folderPath, name);
      const info = attempt(unreadable, path, () => files.lstat(path));
      if (info?.kind !== 'file') {
        continue;
      }
      found.push({ path, sessionId, size: info.size, mtimeNs: info.mtimeNs });
    }
  }
  // By the whole path (code units): 'a-b/x' sorts before 'a/x', though 'a' sorts before 'a-b'.
  return { files: found.sort(byPath), unreadable: unreadable.sort(byPath) };
}

export interface TranscriptFacts {
  firstCwd: string | null; // first record carrying a string cwd
  entrypoint: string | null; // first record carrying a string entrypoint
  aiTitle: string | null; // latest 'ai-title' record's aiTitle
  customTitle: string | null; // latest 'custom-title' record's customTitle
  firstRecordNs: Ns | null; // smallest parseable timestamp
  lastRecordNs: Ns | null; // largest parseable timestamp
  lastUserNs: Ns | null; // largest timestamp of a 'user' record that is the user's own input (see classifyUser)
  lastTurnRole: 'user' | 'assistant' | null; // type of the last (in file order) 'assistant' record or 'user' record that is a turn
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
 * What a `user` record that is not a turn opens its text with: a slash command and its output, a
 * command run from the prompt (`!`) and its output, and the marker Claude Code writes when the user
 * interrupts. Seen in real transcripts (design 5.6); the pairs (stderr, caveat) are the same family.
 */
const NON_TURN_TEXT_STARTS = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '[Request interrupted',
];

/** The first text of a message: its content when that is a string, else its first text block. */
function leadingText(message: unknown): string | null {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
      if (type === 'text' && typeof text === 'string') {
        return text;
      }
    }
  }
  return null;
}

/** A tool result: the model's own tool call answered, not something the user wrote. */
function isToolResult(record: Record<string, unknown>): boolean {
  if (record.toolUseResult !== undefined) {
    return true;
  }
  const content = (record.message as { content?: unknown } | null | undefined)?.content;
  return (
    Array.isArray(content) &&
    (content as unknown[]).some(
      (block) => (block as { type?: unknown } | null)?.type === 'tool_result',
    )
  );
}

/**
 * The exclusions that apply to a `user` record without a `turnOrigin`: a record marked meta, a
 * compaction summary, a sidechain record, and what a command typed at the prompt leaves (a slash
 * command, a `!` command, their output, an interrupt marker). The text is compared with the markers
 * above and dropped (principle 4).
 */
function passesTurnExclusions(record: Record<string, unknown>): boolean {
  if (record.isMeta === true || record.isCompactSummary === true || record.isSidechain === true) {
    return false;
  }
  const text = leadingText(record.message);
  return text === null || !NON_TURN_TEXT_STARTS.some((start) => text.startsWith(start));
}

/**
 * What a `user` record is, for two different questions (design 5.6).
 *
 * `turn`: the model answers it or is working on it (a prompt, a message from another agent, a
 * scheduled wakeup, a tool result). A record that carries a `turnOrigin` of any value is a turn:
 * Claude Code writes one for every record it sends to the model, and the meta flag alone would hide
 * the messages of other agents and the wakeups. A record without one (an older version) is a turn
 * unless an exclusion above applies. What is not recognised is a turn, so that a session is never
 * taken for idle when it may be working.
 *
 * `input`: the user did it themselves, which is what brings a done session back. A `turnOrigin` of
 * `human` is; any other origin (peer, scheduled, task notification, ...) is not. Without one (an
 * older version), a turn is input unless it is a tool result or its `promptSource` is `system`
 * (what Claude Code wrote itself, such as the notification of a finished background task).
 */
function classifyUser(record: Record<string, unknown>): { turn: boolean; input: boolean } {
  const origin = record.turnOrigin;
  if (typeof origin === 'string') {
    return { turn: true, input: origin === 'human' };
  }
  const turn = passesTurnExclusions(record);
  return { turn, input: turn && !isToolResult(record) && record.promptSource !== 'system' };
}

/**
 * Folds complete JSONL lines into facts. Lines that are not JSON objects are skipped. Returns the
 * prUrl of every 'pr-link' record with a string prUrl, in order. Keeps no message text. The facts
 * given are not changed.
 *
 * A first cwd or entrypoint must be a non-empty string; a title is kept as found, an empty one
 * included (a cleared name replaces the one before it) and unsanitised (that is the list's job).
 * The last turn follows file order; the times follow the timestamps, which are not in order. A
 * `user` record counts for `lastTurnRole` when it is a turn and for `lastUserNs` when it is the
 * user's own input (`classifyUser`); either way it counts for the record times, the cwd and the
 * entrypoint.
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
    }
    if (type === 'user') {
      const { turn, input } = classifyUser(record);
      if (turn) {
        lastTurnRole = 'user';
      }
      if (input && ns !== null && (lastUserNs === null || ns > lastUserNs)) {
        lastUserNs = ns;
      }
    } else if (type === 'assistant') {
      lastTurnRole = 'assistant';
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
 * Whether the byte before `offset` is a newline, as it is in the file the offset was taken from
 * (`sizeRead` stops after a 0x0A). When it is not, the file was replaced, and an offset into the
 * old one would land in the middle of a line.
 */
function endsALine(files: Files, path: string, offset: number): boolean {
  if (offset === 0) {
    return true;
  }
  const byte = files.readBytes(path, offset - 1, offset);
  return byte.length === 1 && byte[0] === NEWLINE;
}

/**
 * Reads bytes [previous.sizeRead, file.size) — or from 0 with EMPTY_FACTS when previous is null or
 * file.size < previous.sizeRead (shrunk) — splits on byte 0x0A, folds the complete lines, and
 * leaves a last line without a newline for the next read (sizeRead stops after the last 0x0A).
 * A file whose byte before `previous.sizeRead` is not a newline was replaced: it is read from the
 * start too. `prUrls` are those of the lines read now. Throws what `Files.readBytes` throws, for example when
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
  const resumed =
    previous !== null &&
    file.size >= previous.sizeRead &&
    (file.size === previous.sizeRead || endsALine(files, file.path, previous.sizeRead));
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
