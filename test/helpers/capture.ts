import type { Io } from '../../src/cli/context.ts';

export interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

/** An `Io` that records what is written to it. */
export function capture(): Captured {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}
