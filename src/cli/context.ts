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
  /**
   * Calls `callback` whenever the terminal is resized (`size()` then gives the new size); never when
   * stdout is no terminal. Returns the function that unsubscribes it.
   */
  onResize(callback: () => void): () => void;
  /**
   * Calls `callback` when the process is asked to end (SIGTERM, or SIGINT sent from outside: in raw
   * mode ctrl-c is a key) or its terminal went away (SIGHUP), so that it can give the terminal back;
   * the process then ends as the signal would have ended it. Returns the function that unsubscribes it.
   */
  onTerminate(callback: (signal: TerminateSignal) => void): () => void;
};

/** The signals `Io.onTerminate` reports. */
export type TerminateSignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT';

/** Everything a command may reach for, passed in so tests can substitute fakes. */
export type Context = { io: Io; platform: Platform };

/** The real standard streams and realPlatform(). */
export function processContext(): Context {
  return { io: processIo(), platform: realPlatform() };
}

/**
 * What the process exits with when standard output was closed by its reader (`skydeck ls | head -1`)
 * and the command itself succeeded: 128 + 13, the status a shell reports for a program that SIGPIPE
 * killed, as `ls` or `cat` would be in the same pipeline. A command that failed keeps its own code.
 */
export const EXIT_STDOUT_CLOSED = 141;

/**
 * A write to `stream` that does not fail when the reader has gone (EPIPE): from then on nothing is
 * written, nothing is said, and the command carries on to its end, so that what it must finish (a
 * state change, closing the database) is finished. `onClosed` runs once, when the failure arrives.
 * Any other error of the stream is thrown as it always was.
 */
function writeQuietlyWhenClosed(
  stream: () => NodeJS.WriteStream,
  onClosed: () => void,
): (text: string) => void {
  let listening = false;
  let closed = false;
  return (text) => {
    if (closed) {
      return;
    }
    const out = stream();
    if (!listening) {
      listening = true;
      out.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          throw error;
        }
        closed = true;
        onClosed();
      });
    }
    out.write(text);
  };
}

/**
 * Standard output closed by its reader: only the exit status tells, EXIT_STDOUT_CLOSED after a
 * command that returned 0. The failure can arrive after the command has returned (it comes on a
 * later tick), so the status is decided when the process ends.
 */
function stdoutClosed(): void {
  process.once('exit', (code) => {
    if (code === 0) {
      process.exitCode = EXIT_STDOUT_CLOSED;
    }
  });
}

/**
 * The standard streams. Standard input is touched only when something reads it, and is paused
 * again afterwards, so that a command that has finished is never kept alive by it. `readLine` and
 * `keys` read the same stream: one after the other is fine, two at once is not.
 */
function processIo(): Io {
  const stdout = writeQuietlyWhenClosed(() => process.stdout, stdoutClosed);
  // A closed standard error changes nothing, the exit code least of all.
  const stderr = writeQuietlyWhenClosed(
    () => process.stderr,
    () => {},
  );
  let lines: AsyncIterator<string> | undefined;
  let reader: Interface | undefined;
  let closed = false; // the interface closed itself at end of input: it cannot be paused or resumed
  let ended = false; // and every line it held has been handed out
  return {
    stdout,
    stderr,
    isTTY: { stdin: isatty(0), stdout: isatty(1), stderr: isatty(2) },
    size: () => {
      if (!isatty(1)) {
        return { columns: 80, rows: 24 };
      }
      return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
    },
    async readLine(prompt) {
      stderr(prompt);
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
    onResize(callback) {
      // Node updates columns and rows on SIGWINCH, then emits this (only on a terminal).
      const listener = (): void => {
        callback();
      };
      process.stdout.on('resize', listener);
      return () => {
        process.stdout.off('resize', listener);
      };
    },
    onTerminate(callback) {
      const signals: TerminateSignal[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
      const listeners = signals.map((signal) => {
        const listener = (): void => {
          try {
            callback(signal);
          } finally {
            // A listener replaces Node's own handling of the signal, which ends the process: once
            // nobody listens any more, end it the way the signal would have.
            unsubscribe();
            if (process.listenerCount(signal) === 0) {
              process.kill(process.pid, signal);
            }
          }
        };
        process.on(signal, listener);
        return { signal, listener };
      });
      const unsubscribe = (): void => {
        for (const { signal, listener } of listeners) {
          process.off(signal, listener);
        }
      };
      return unsubscribe;
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
