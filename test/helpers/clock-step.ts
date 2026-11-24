/**
 * A wall clock that steps back, for finding the tests that a stepping wall clock breaks (issue
 * #202). On a WSL 2 machine the wall clock was seen to step back by 2.1 to 2.7 s every 32 s; a
 * test that compares two wall-clock times, or holds a deadline on the wall clock, then fails by
 * chance. This makes such steps happen on purpose, often, in every process of a test:
 *
 *   SKYDECK_TEST_CLOCK_STEP=2700/5000 NODE_OPTIONS=--import=./test/helpers/clock-step.ts \
 *     node --test test/window/<file>.test.ts
 *
 * `<step>/<period>` in milliseconds: from the moment this module is first loaded, the wall clock
 * steps back by `step` once every `period` (timed on the clock that cannot step, CLOCK_MONOTONIC,
 * which every process of the machine shares), and runs at its normal pace between the steps.
 * Loaded first, this module adds `@<start>` (that moment, on the same clock) to the variable, so
 * that every process started later steps at the same instants and by the same amounts.
 *
 * What sees the stepped clock: every Node.js process that loads this module (`Date.now()` and
 * `new Date()`; the suite's sandbox passes `NODE_OPTIONS` on to its children while the variable is
 * set, see `clockStepSeam`), and the sandbox's `date` and `python3` (the hook's time stamps, the
 * keeper's `time.time_ns()`), which `Sandbox.link` then writes as wrappers instead of links. What
 * does not: timers (as with a real step), file times (the kernel's), `performance.now()` and
 * `process.hrtime`. Without the variable nothing changes. Never the machine's own clock.
 */
import { fileURLToPath } from 'node:url';

const VARIABLE = 'SKYDECK_TEST_CLOCK_STEP';
const NS_PER_MS = 1_000_000n;

/** The steps of the variable: by how much, how often, and from when (CLOCK_MONOTONIC), in ns. */
export interface ClockSteps {
  stepNs: bigint;
  periodNs: bigint;
  startNs: bigint;
}

/** The steps `value` asks for; null when it is not `<step>/<period>[@<start>]` with step < period. */
function parse(
  value: string | undefined,
): (Omit<ClockSteps, 'startNs'> & { startNs: bigint | null }) | null {
  const match = /^([0-9]{1,7})\/([0-9]{1,7})(?:@([0-9]{1,20}))?$/.exec(value ?? '');
  if (match === null) {
    return null;
  }
  const stepNs = BigInt(match[1]!) * NS_PER_MS;
  const periodNs = BigInt(match[2]!) * NS_PER_MS;
  if (stepNs <= 0n || periodNs <= stepNs) {
    return null; // a clock that went back on the whole would never reach any time
  }
  return { stepNs, periodNs, startNs: match[3] === undefined ? null : BigInt(match[3]) };
}

/** How far the wall clock has been stepped back at `monotonicNs`. */
function backNs(steps: ClockSteps, monotonicNs: bigint): bigint {
  if (monotonicNs < steps.startNs) {
    return 0n;
  }
  return steps.stepNs * ((monotonicNs - steps.startNs) / steps.periodNs);
}

/** The steps in force in this process (the variable completed with its start), or null. */
function inForce(): ClockSteps | null {
  const value = process.env[VARIABLE];
  if (value !== undefined && parse(value) === null) {
    throw new Error(`${VARIABLE}: not <step ms>/<period ms> with step < period: ${value}`);
  }
  const parsed = parse(value);
  if (parsed === null) {
    return null;
  }
  const startNs = parsed.startNs ?? process.hrtime.bigint();
  process.env[VARIABLE] = `${parsed.stepNs / NS_PER_MS}/${parsed.periodNs / NS_PER_MS}@${startNs}`;
  return { ...parsed, startNs };
}

const INSTALLED = Symbol.for('skydeck.test.clockStep');

/** Puts the stepped clock into `Date` of this process, once. */
function install(steps: ClockSteps): void {
  const global = globalThis as typeof globalThis & { [INSTALLED]?: true };
  if (global[INSTALLED] === true) {
    return;
  }
  global[INSTALLED] = true;
  const RealDate = Date;
  const realNow = Date.now.bind(Date);
  const now = (): number => realNow() - Number(backNs(steps, process.hrtime.bigint()) / NS_PER_MS);
  const SteppedDate = new Proxy(RealDate, {
    construct(target, args: unknown[], newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget) as object;
    },
    apply() {
      return new RealDate(now()).toString(); // Date() called without new
    },
    get(target, key, receiver) {
      return key === 'now' ? now : (Reflect.get(target, key, receiver) as unknown);
    },
  });
  globalThis.Date = SteppedDate;
}

const steps = inForce();
if (steps !== null) {
  install(steps);
}

const HERE = fileURLToPath(import.meta.url);

/** The python code that steps `time.time()` and `time.time_ns()` as this module steps `Date`. */
const PYTHON_CLOCK = `import os, re, time
_m = re.match(r'^([0-9]+)/([0-9]+)@([0-9]+)$', os.environ.get('${VARIABLE}', ''))
_step, _period, _start = (int(_m.group(1)) * 1000000, int(_m.group(2)) * 1000000, int(_m.group(3))) if _m else (0, 1, 0)
_real_time_ns = time.time_ns
def _back():
    m = time.monotonic_ns()
    return 0 if m < _start else _step * ((m - _start) // _period)
def _time_ns():
    return _real_time_ns() - _back()
time.time_ns = _time_ns
time.time = lambda: _time_ns() / 1e9
`;

/** `python3 -I <script> ...` with the stepped clock; anything else is the real python3 unchanged. */
const PYTHON_WRAPPER = `${PYTHON_CLOCK}import runpy, sys
args = sys.argv[1:]
rest = list(args)
while rest and rest[0] in ('-I', '-E', '-s', '-S', '-B', '-u'):
    rest.pop(0)
if not rest or rest[0].startswith('-'):
    os.execv('/usr/bin/python3', ['python3'] + args)
sys.argv = rest
runpy.run_path(rest[0], run_name='__main__')
`;

/** `date` at the stepped time; with a time or a file of its own to show, the real `date` unchanged. */
const DATE_WRAPPER = `${PYTHON_CLOCK}import sys
args = sys.argv[1:]
own = ('-d', '--date', '-r', '--reference', '-f', '--file', '-s', '--set')
if any(arg in own or arg.split('=')[0] in own or re.match(r'^-[^-]*[drfs]', arg) for arg in args):
    os.execv('/usr/bin/date', ['date'] + args)
ns = _time_ns()
os.execv('/usr/bin/date', ['date', '-d', '@%d.%09d' % (ns // 1000000000, ns % 1000000000)] + args)
`;

function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * What the suite's sandbox does while the variable is set (null without it): `env`, the entries
 * that pass the stepped clock on to a child (the variable, and `NODE_OPTIONS` loading this module);
 * `script(program)`, the text of the wrapper written instead of a link for `python3` and `date`
 * (null for any other program).
 */
export function clockStepSeam(): {
  env: Record<string, string>;
  script: (program: string) => string | null;
} | null {
  const value = process.env[VARIABLE];
  if (steps === null || value === undefined) {
    return null;
  }
  const wrappers: Record<string, string> = { python3: PYTHON_WRAPPER, date: DATE_WRAPPER };
  return {
    env: { [VARIABLE]: value, NODE_OPTIONS: `--import=${HERE}` },
    script: (program) => {
      const code = wrappers[program];
      return code === undefined
        ? null
        : `#!/bin/sh\nexec /usr/bin/python3 -I -c ${shellWord(code)} "$@"\n`;
    },
  };
}
