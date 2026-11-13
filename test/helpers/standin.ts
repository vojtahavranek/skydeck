/**
 * The stand-in program of plan 2.4 (S2 17.1): what every test that starts a program puts into
 * `claudeCommand` instead of the real `claude`. The program is `test/fixtures/standin/standin.ts`.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sandbox } from './sandbox.ts';

const STANDIN = fileURLToPath(new URL('../fixtures/standin/standin.ts', import.meta.url));

/** The programs the stand-in's hook needs on PATH (design 5.1), and `sh` for the script. */
const PROGRAMS = ['sh', 'date', 'cat', 'base64', 'mkdir', 'mv'];

interface RecordBase {
  /** The stand-in's pid. */
  pid: number;
  /** Epoch milliseconds when the record was written. */
  ms: number;
}

/** One line of the stand-in's record file (`STANDIN_RECORD`). */
export type StandinRecord = RecordBase &
  (
    | {
        ev: 'start';
        /** The arguments it was given (the program's own name not included). */
        argv: string[];
        cwd: string;
        /** The sorted names of its environment. */
        envNames: string[];
        /** null: not set. */
        env: {
          TERM: string | null;
          COLORTERM: string | null;
          PWD: string | null;
          WSL_INTEROP: string | null;
        };
        /** The soft "Max core file size" of /proc/self/limits as written there ("0", "unlimited"). */
        coreSoft: string | null;
        /** The terminal's size at start; null when its output is not a terminal. */
        cols: number | null;
        rows: number | null;
      }
    /** The answer to DA1 at start; null when none came within 2 s. */
    | { ev: 'da1'; answer: string | null }
    /** The answer to CPR at start; null when none came (not waited for when DA1 had none). */
    | { ev: 'cpr'; answer: string | null }
    /** One chunk of input as it was read, in hex (answers to its queries are not input). */
    | { ev: 'input'; hex: string }
    /** An answer to a query of `/query`. */
    | {
        ev: 'answer';
        query:
          'DA1' | 'DA2' | 'CPR' | 'DECRQM 2026' | 'DECRQSS m' | 'XTVERSION' | 'OSC 10' | 'OSC 11';
        answer: string;
      }
    | { ev: 'resize'; cols: number; rows: number }
    | { ev: 'hup' }
    /** Always the last record. */
    | { ev: 'exit'; code: number }
  );

function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Writes `<s.root>/bin/claude-standin`, a `sh` script that runs the stand-in with this Node.js
 * (`exec`, so the stand-in replaces the script; with `wrapper: true` as the script's child, as a
 * wrapper `claudeCommand` would run it), links the programs its hook needs into the sandbox's
 * `bin` (those already there are kept) and returns the script's path. Calling it again rewrites
 * the script.
 */
export function standinCommand(s: Sandbox, options: { wrapper?: boolean } = {}): string {
  const run = `${shellWord(process.execPath)} ${shellWord(STANDIN)} "$@"`;
  const body = options.wrapper === true ? `${run}\nexit $?\n` : `exec ${run}\n`;
  const script = join(s.bin, 'claude-standin');
  writeFileSync(script, `#!/bin/sh\n${body}`);
  chmodSync(script, 0o755);
  s.link(...PROGRAMS.filter((program) => !present(join(s.bin, program))));
  return script;
}

/** Whether anything, a dangling link included, is at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The records in the file so far; [] when there is none. A line still being written is left out. */
export function readRecords(path: string): StandinRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  // The text after the last newline is a record not yet complete (or nothing).
  return lines.slice(0, -1).map((line) => JSON.parse(line) as StandinRecord);
}

/** The first record that `predicate` accepts, polling the file; rejects after `timeoutMs`. */
export function waitForRecord<R extends StandinRecord>(
  path: string,
  predicate: (record: StandinRecord) => record is R,
  timeoutMs: number,
): Promise<R>;
export function waitForRecord(
  path: string,
  predicate: (record: StandinRecord) => boolean,
  timeoutMs: number,
): Promise<StandinRecord>;
export async function waitForRecord(
  path: string,
  predicate: (record: StandinRecord) => boolean,
  timeoutMs: number,
): Promise<StandinRecord> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const records = readRecords(path);
    const found = records.find(predicate);
    if (found !== undefined) {
      return found;
    }
    if (performance.now() >= deadline) {
      const seen = records.map((record) => record.ev).join(' ');
      throw new Error(`no matching stand-in record within ${timeoutMs} ms; saw: [${seen}]`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
