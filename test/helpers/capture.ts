import type { Io } from '../../src/cli/context.ts';

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
}

/** An `Io` that records what is written to it and answers reads from `options`. */
export function capture(options: CaptureOptions = {}): Captured {
  let out = '';
  let err = '';
  const prompts: string[] = [];
  let nextLine = 0;
  let nextKey = 0;
  const chunks = options.keys ?? [];
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
      size: () => options.size ?? { columns: 80, rows: 24 },
      readLine: (prompt) => {
        prompts.push(prompt);
        err += prompt;
        return Promise.resolve(options.lines?.[nextLine++] ?? null);
      },
      // One cursor for all calls, like the one standard input they stand for.
      async *keys() {
        while (nextKey < chunks.length) {
          const chunk = chunks[nextKey++];
          yield typeof chunk === 'function' ? chunk() : (chunk ?? '');
        }
      },
    },
    stdout: () => out,
    stderr: () => err,
    prompts,
  };
}
