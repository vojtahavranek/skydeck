import pkg from '../../package.json' with { type: 'json' };

/** Where the CLI writes. Tests pass fakes; the real process uses {@link processIo}. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  skydeck [options]

Options:
  -h, --help     Show this help
  -V, --version  Show the version
`;

/** Runs the CLI and returns the process exit code. */
export function main(argv: readonly string[], io: Io): number {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
    io.stdout(USAGE);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    io.stdout(`${pkg.version}\n`);
    return 0;
  }
  io.stderr(USAGE);
  return 2;
}

/** The real standard streams. */
export function processIo(): Io {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}
