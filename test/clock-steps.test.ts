// The suite's tools for a wall clock that steps back (issue #202, S2 17): test/helpers/clock-step.ts
// steps it on purpose in every process of a test, test/helpers/clock-watch.ts says at the end of a
// run that it fell behind. The stepped clock is looked at in Node.js children started in the
// sandbox with an environment of their own, never in this process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { clockStepSeam } from './helpers/clock-step.ts';
import { fellBehindLine } from './helpers/clock-watch.ts';
import { sandbox } from './helpers/sandbox.ts';
import type { Sandbox } from './helpers/sandbox.ts';

const STEP = fileURLToPath(new URL('./helpers/clock-step.ts', import.meta.url));
const WATCH = fileURLToPath(new URL('./helpers/clock-watch.ts', import.meta.url));

/**
 * `node <args>` in the sandbox, with `env` over the sandbox's environment (this process's own
 * stepped clock, when a developer runs the suite under it, is not passed on); its exit code and
 * its stdout and stderr together, in the order they were written.
 */
async function node(
  s: Sandbox,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; output: string }> {
  const file = join(s.root, `output-${Math.random().toString(36).slice(2)}`);
  const fd = openSync(file, 'w');
  try {
    const child = spawn(process.execPath, args, {
      cwd: s.home,
      env: s.env({ SKYDECK_TEST_CLOCK_STEP: undefined, NODE_OPTIONS: undefined, ...env }),
      stdio: ['ignore', fd, fd],
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the child did not end within 60 s'));
      }, 60_000);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    return { code, output: readFileSync(file, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/**
 * A child that keeps the real `Date.now` aside, loads the tool (which steps `Date` while the
 * variable is set), writes the tool's `date` and `python3` wrappers into `bin` and, at about 0.3 s
 * and 2.0 s after the start, prints how far behind the real wall clock each reading is.
 */
const SAMPLER = `
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const realNow = Date.now.bind(Date);
const { clockStepSeam } = await import(process.argv[2]);
const bin = process.argv[3];
const seam = clockStepSeam();
for (const program of ['date', 'python3']) {
  writeFileSync(join(bin, program), seam.script(program), { mode: 0o755 });
}
writeFileSync(join(bin, 'now.py'), 'import time\\nprint(time.time_ns() // 1000000)\\n');
const env = { ...process.env, PATH: bin };
const start = BigInt(/@([0-9]+)$/.exec(process.env.SKYDECK_TEST_CLOCK_STEP)[1]);
const elapsedMs = () => Number((process.hrtime.bigint() - start) / 1000000n);
const behind = (run) => {
  const before = realNow();
  const value = run();
  return [before - value, realNow() - value];
};
const sample = () => ({
  at: elapsedMs(),
  node: behind(() => Date.now()),
  date: behind(() => new Date().getTime()),
  shell: behind(() => Number(BigInt(execFileSync(join(bin, 'date'), ['+%s%N'], { env }).toString()) / 1000000n)),
  python: behind(() => Number(execFileSync(join(bin, 'python3'), ['-I', join(bin, 'now.py')], { env }).toString())),
  done: elapsedMs(),
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(Math.max(0, 300 - elapsedMs()));
const first = sample();
await wait(Math.max(0, 2000 - elapsedMs()));
const second = sample();
console.log(JSON.stringify({ variable: process.env.SKYDECK_TEST_CLOCK_STEP, first, second }));
`;

describe('a wall clock stepped back on purpose (test/helpers/clock-step.ts)', () => {
  test('1000/1500: Node.js, the shell’s date and python3 are all 1 s behind after 1.5 s, none before, and the start is passed on', async (t) => {
    const s = sandbox(t);
    const sampler = join(s.root, 'sampler.mjs');
    writeFileSync(sampler, SAMPLER);
    const { code, output } = await node(s, [sampler, STEP, s.bin], {
      SKYDECK_TEST_CLOCK_STEP: '1000/1500',
    });
    assert.equal(code, 0, output);
    type Behind = [number, number];
    interface Sample {
      at: number;
      done: number;
      node: Behind;
      date: Behind;
      shell: Behind;
      python: Behind;
    }
    const result = JSON.parse(output) as { variable: string; first: Sample; second: Sample };
    assert.match(result.variable, /^1000\/1500@[0-9]+$/);
    for (const [name, sample, back, from, to] of [
      ['before the first step', result.first, 0, 0, 1500],
      ['after it', result.second, 1000, 1500, 3000],
    ] as const) {
      assert.ok(
        sample.at >= from && sample.done < to,
        `${name}: sampled between ${sample.at} and ${sample.done} ms`,
      );
      for (const reading of ['node', 'date', 'shell', 'python'] as const) {
        const [low, high] = sample[reading];
        assert.ok(
          low - 50 <= back && back <= high + 50,
          `${name}, ${reading}: ${low} to ${high} ms behind, not ${back}`,
        );
      }
    }
  });

  test('without the variable the tool changes nothing: no wrapper, Date untouched', async (t) => {
    const s = sandbox(t);
    const script = join(s.root, 'plain.mjs');
    writeFileSync(
      script,
      [
        'const before = Date;',
        'const { clockStepSeam } = await import(process.argv[2]);',
        'console.log(JSON.stringify([clockStepSeam(), Date === before, String(Date.now).includes("[native code]")]));',
        '',
      ].join('\n'),
    );
    const { code, output } = await node(s, [script, STEP], {});
    assert.equal(code, 0, output);
    assert.deepEqual(JSON.parse(output), [null, true, true]);
  });

  test('the sandbox writes the wrappers and passes the clock on exactly while the variable is set', (t) => {
    const s = sandbox(t);
    s.link('date', 'python3', 'cat');
    const seam = clockStepSeam();
    const env = s.env();
    if (seam === null) {
      for (const program of ['date', 'python3', 'cat']) {
        assert.equal(lstatSync(join(s.bin, program)).isSymbolicLink(), true, program);
      }
      assert.equal(env['NODE_OPTIONS'], undefined);
      assert.equal(env['SKYDECK_TEST_CLOCK_STEP'], undefined);
    } else {
      // The suite itself runs under the stepped clock.
      for (const program of ['date', 'python3']) {
        assert.equal(readFileSync(join(s.bin, program), 'utf8'), seam.script(program), program);
      }
      assert.equal(lstatSync(join(s.bin, 'cat')).isSymbolicLink(), true, 'cat');
      assert.equal(env['NODE_OPTIONS'], `--import=${STEP}`);
      assert.match(env['SKYDECK_TEST_CLOCK_STEP'] ?? '', /^[0-9]+\/[0-9]+@[0-9]+$/);
    }
  });

  test('a value that is not <step>/<period> with the step under the period is refused at the start', async (t) => {
    const s = sandbox(t);
    const script = join(s.root, 'empty.mjs');
    writeFileSync(script, '');
    for (const value of ['2700', '2700/2700', '3000/2000', '0/1000', 'a/b', '2700/5000@x']) {
      const { code, output } = await node(s, [`--import=${STEP}`, script], {
        SKYDECK_TEST_CLOCK_STEP: value,
      });
      assert.notEqual(code, 0, value);
      assert.match(
        output,
        /SKYDECK_TEST_CLOCK_STEP: not <step ms>\/<period ms> with step < period/,
      );
    }
  });
});

describe('the line at the end of a run (test/helpers/clock-watch.ts)', () => {
  test('said for a fall behind of more than a second, in tenths; nothing for a second or less', () => {
    assert.equal(fellBehindLine(0n), null);
    assert.equal(fellBehindLine(1_000_000_000n), null);
    assert.equal(
      fellBehindLine(2_740_000_000n),
      'the wall clock fell up to 2.7 s behind the clock that cannot step during this run: ' +
        'a red case that compares wall-clock times or waits on them may be that (issue #202)',
    );
    assert.match(fellBehindLine(1_001_000_000n) ?? '', /^the wall clock fell up to 1\.0 s behind/);
  });

  test('a run whose wall clock is stepped back by 1.2 s says so in its last line, after the summary', async (t) => {
    const s = sandbox(t);
    const waits = join(s.root, 'waits.test.mjs');
    writeFileSync(
      waits,
      "import { test } from 'node:test';\n" +
        "test('waits past a step', () => new Promise((resolve) => setTimeout(resolve, 2000)));\n",
    );
    const { code, output } = await node(
      s,
      ['--test', '--test-reporter=tap', `--test-global-setup=${WATCH}`, waits],
      { SKYDECK_TEST_CLOCK_STEP: '1200/1500' },
    );
    assert.equal(code, 0, output);
    const lines = output.trimEnd().split('\n');
    assert.match(
      lines.at(-1) ?? '',
      /^the wall clock fell up to [1-9][0-9]*\.[0-9] s behind the clock/,
    );
    assert.match(lines.at(-2) ?? '', /^# duration_ms /, 'after the summary');
  });
});
