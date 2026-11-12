/** Where the CLI writes. Tests pass a recording one; the real process uses {@link processContext}. */
export type Io = { stdout(text: string): void; stderr(text: string): void };

/** Everything a command may reach for, passed in so tests can substitute fakes. */
export type Context = { io: Io };

/** The context of the running process: the real standard streams. */
export function processContext(): Context {
  return {
    io: {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    },
  };
}
