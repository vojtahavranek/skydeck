import type { Io, TerminateSignal } from '../../src/cli/context.ts';

export interface CaptureOptions {
  /** Whether each stream reports itself as a terminal; default false. */
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  /** Answers for readLine, in order; null once exhausted. */
  lines?: readonly string[];
  /**
   * Chunks yielded by keys(), then the iterator ends. A function is called when the iterator
   * reaches it (so a test can change the world between keys) and its result is yielded.
   */
  keys?: readonly (string | (() => string))[];
  /** Default 80×24. */
  size?: { columns: number; rows: number };
}

export interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  /** The prompt of every readLine call, in order. */
  prompts: string[];
  /** Resizes the fake terminal: size() answers `size` from now on, and every onResize callback is called. */
  resize: (size: { columns: number; rows: number }) => void;
  /**
   * How many keys() readers are open: made and neither given back with return() nor read to the end.
   * The real one holds the terminal in raw mode and keeps the process alive until then.
   */
  openKeys: () => number;
  /** Calls every onTerminate callback with `signal`, as the real one does when the process gets it. */
  terminate: (signal: TerminateSignal) => void;
}

/** An `Io` that records what is written to it and answers reads from `options`. */
export function capture(options: CaptureOptions = {}): Captured {
  let out = '';
  let err = '';
  const prompts: string[] = [];
  let nextLine = 0;
  let nextKey = 0;
  const chunks = options.keys ?? [];
  let size = options.size ?? { columns: 80, rows: 24 };
  const resized = new Set<() => void>();
  let openKeys = 0;
  const terminating = new Set<(signal: TerminateSignal) => void>();
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      isTTY: {
        stdin: options.stdinTTY ?? false,
        stdout: options.stdoutTTY ?? false,
        stderr: options.stderrTTY ?? false,
      },
      size: () => size,
      readLine: (prompt) => {
        prompts.push(prompt);
        err += prompt;
        return Promise.resolve(options.lines?.[nextLine++] ?? null);
      },
      // One cursor for all calls, like the one standard input they stand for.
      keys() {
        let open = true;
        openKeys++;
        const close = (): IteratorResult<string> => {
          if (open) {
            open = false;
            openKeys--;
          }
          return { done: true, value: undefined };
        };
        const iterator: AsyncIterableIterator<string> = {
          next: async () => {
            if (!open || nextKey >= chunks.length) {
              return close();
            }
            const chunk = chunks[nextKey++];
            return { done: false, value: typeof chunk === 'function' ? chunk() : (chunk ?? '') };
          },
          return: async () => close(),
          [Symbol.asyncIterator]: () => iterator,
        };
        return iterator;
      },
      onTerminate: (callback) => {
        const listener = (signal: TerminateSignal): void => {
          callback(signal);
        };
        terminating.add(listener);
        return () => {
          terminating.delete(listener);
        };
      },
      onResize: (callback) => {
        // A wrapper per subscription, so that subscribing the same function twice is two subscriptions.
        const listener = (): void => {
          callback();
        };
        resized.add(listener);
        return () => {
          resized.delete(listener);
        };
      },
    },
    stdout: () => out,
    stderr: () => err,
    prompts,
    openKeys: () => openKeys,
    terminate: (signal) => {
      for (const listener of [...terminating]) {
        listener(signal);
      }
    },
    resize: (next) => {
      size = next;
      for (const listener of [...resized]) {
        listener();
      }
    },
  };
}
