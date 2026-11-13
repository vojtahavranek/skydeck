import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { isatty } from 'node:tty';

import { realPlatform } from '../platform/real.ts';
import type { Platform } from '../platform/types.ts';

/** Where the CLI writes and reads. Tests pass a recording one; the real process uses {@link processContext}. */
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** Terminal size; 80×24 when stdout is not a terminal. */
  size(): { columns: number; rows: number };
  /** Writes `prompt` to stderr, reads one line of stdin without its newline; null at end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Raw-mode input, one string per chunk read (task 19 splits chunks into keys). return() restores the terminal. */
  keys(): AsyncIterableIterator<string>;
};

/** Everything a command may reach for, passed in so tests can substitute fakes. */
export type Context = { io: Io; platform: Platform };

/** The real standard streams and realPlatform(). */
export function processContext(): Context {
  return { io: processIo(), platform: realPlatform() };
}

/**
 * The standard streams. Standard input is touched only when something reads it, and is paused
 * again afterwards, so that a command that has finished is never kept alive by it. `readLine` and
 * `keys` read the same stream: one after the other is fine, two at once is not.
 */
function processIo(): Io {
  let lines: AsyncIterator<string> | undefined;
  let reader: Interface | undefined;
  let closed = false; // the interface closed itself at end of input: it cannot be paused or resumed
  let ended = false; // and every line it held has been handed out
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    isTTY: { stdin: isatty(0), stdout: isatty(1), stderr: isatty(2) },
    size: () => {
      if (!isatty(1)) {
        return { columns: 80, rows: 24 };
      }
      return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
    },
    async readLine(prompt) {
      process.stderr.write(prompt);
      if (ended || process.stdin.readableEnded) {
        return null; // nothing more will come, and a new interface on an ended stream never answers
      }
      // One reader for the whole process: a second one would not see lines the first already took.
      if (reader === undefined) {
        reader = createInterface({ input: process.stdin, terminal: false });
        reader.once('close', () => {
          closed = true;
        });
      }
      lines ??= reader[Symbol.asyncIterator]();
      if (!closed) {
        reader.resume();
      }
      const next = await lines.next();
      if (next.done === true) {
        ended = true;
        return null;
      }
      if (!closed) {
        reader.pause();
      }
      return next.value;
    },
    keys() {
      const stdin = process.stdin;
      // A readLine reader still listens on stdin: let it go, or it would take the keys as lines
      // (lines it had read ahead are lost).
      if (reader !== undefined) {
        reader.close();
        reader = undefined;
        lines = undefined;
        closed = false;
      }
      const wasRaw = stdin.isTTY && stdin.isRaw;
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.setEncoding('utf8');
      let chunks: AsyncIterator<unknown> | undefined;
      let finished = false;
      const nextTick = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));
      const finish = async (): Promise<void> => {
        if (finished) {
          return;
        }
        finished = true;
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw);
        }
        // Letting go of the iterator makes the stream resume reading on the next tick; a pause
        // before that is undone, and an open stdin would keep the process alive.
        await chunks?.return?.();
        await nextTick();
        stdin.pause();
      };
      return {
        async next() {
          if (chunks === undefined) {
            // A stdin.pause() (by readLine, or the end of an earlier keys()) stops the handle on
            // the next tick; start reading only after that, or the read is never requested.
            await nextTick();
            chunks = stdin.iterator({ destroyOnReturn: false });
          }
          const next: IteratorResult<unknown> = await chunks.next();
          if (next.done === true) {
            await finish();
            return { done: true, value: undefined };
          }
          return { done: false, value: String(next.value) };
        },
        async return() {
          await finish();
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}
