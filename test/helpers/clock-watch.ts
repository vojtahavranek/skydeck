/**
 * The test runner's global setup (`node --test --test-global-setup=…`, package.json): watches the
 * wall clock against the clock that cannot step for the whole run, and says at its end, in one line
 * on stderr, when the wall clock fell behind by more than a second (issue #202). On a WSL 2 machine
 * the wall clock was seen to step back by 2.1 to 2.7 s every 32 s; a red case that compares
 * wall-clock times can then be read at once for what it is. Says nothing when the clock kept pace.
 *
 * It also loads test/helpers/clock-step.ts, which does nothing unless SKYDECK_TEST_CLOCK_STEP is
 * set: then the runner watches the same stepped clock as the tests, and every test file's process
 * steps at the same instants (the runner fixes the start before it starts them).
 */
import './clock-step.ts';

const NS_PER_MS = 1_000_000n;
/** A fall behind of more than this is said. */
const SAID_NS = 1_000n * NS_PER_MS;
/** How often the two clocks are compared (a step forward later must not hide a step back). */
const EVERY_MS = 500;

let started: { wallMs: number; monotonicNs: bigint } | null = null;
let worstNs = 0n;
let timer: NodeJS.Timeout | undefined;

/** How far the wall clock is behind the clock that cannot step, since the run began. */
function behindNs(): bigint {
  if (started === null) {
    return 0n;
  }
  const monotonic = process.hrtime.bigint() - started.monotonicNs;
  const wall = BigInt(Date.now() - started.wallMs) * NS_PER_MS;
  return monotonic - wall;
}

function look(): void {
  const behind = behindNs();
  if (behind > worstNs) {
    worstNs = behind;
  }
}

export function globalSetup(): void {
  started = { wallMs: Date.now(), monotonicNs: process.hrtime.bigint() };
  worstNs = 0n;
  timer = setInterval(look, EVERY_MS);
  timer.unref();
}

/** The line said at the end of a run whose wall clock fell `worstNs` behind; null for a second or less. */
export function fellBehindLine(worstNs: bigint): string | null {
  if (worstNs <= SAID_NS) {
    return null;
  }
  const seconds = (Number(worstNs / NS_PER_MS) / 1000).toFixed(1);
  return (
    `the wall clock fell up to ${seconds} s behind the clock that cannot step during this run: ` +
    'a red case that compares wall-clock times or waits on them may be that (issue #202)'
  );
}

export function globalTeardown(): void {
  clearInterval(timer);
  look();
  const line = fellBehindLine(worstNs);
  if (line !== null) {
    // At the exit, so that the line comes after the reporter's summary, which follows the teardown.
    process.once('exit', () => {
      process.stderr.write(`${line}\n`);
    });
  }
}
