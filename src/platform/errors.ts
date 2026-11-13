/** Process exit codes of the errors below; they equal `EXIT` in src/cli/exit.ts. */
export type ExitCode = 1 | 2 | 3 | 4 | 5;

/** An error that ends a command. `dispatch` prints its message and exits with `exitCode`. */
export class SkydeckError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = 1) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** config.json cannot be used. */
export class ConfigError extends SkydeckError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** The command line is wrong. */
export class UsageError extends SkydeckError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** A session reference matched nothing, or too much; `candidates` are what it could have meant. */
export class RefError extends SkydeckError {
  readonly candidates: readonly { id: string; title: string }[];
  constructor(message: string, candidates: readonly { id: string; title: string }[]) {
    super(message, 3);
    this.candidates = candidates;
  }
}

/** The resume guard refused. */
export class ResumeRefusedError extends SkydeckError {
  constructor(message: string) {
    super(message, 4);
  }
}

/** Restore stopped before starting everything it was asked to. */
export class RestoreStoppedError extends SkydeckError {
  constructor(message: string) {
    super(message, 5);
  }
}
