import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { processContext } from '../../src/cli/context.ts';
import { realPlatform } from '../../src/platform/real.ts';
import { sandbox } from '../helpers/sandbox.ts';

const CONTEXT_MODULE = pathToFileURL(
  new URL('../../src/cli/context.ts', import.meta.url).pathname,
).href;

/**
 * Runs `body` (the body of an async module, with `io` in scope) in a child Node.js process whose
 * standard streams are pipes, and returns what it printed with `print(...)`.
 */
async function inChild(t: TestContext, body: string, input: string) {
  const s = sandbox(t);
  const script = `
    import { processContext } from ${JSON.stringify(CONTEXT_MODULE)};
    const { io } = processContext();
    const print = (value) => process.stdout.write(JSON.stringify(value));
    ${body}
  `;
  const result = await realPlatform().runner.run(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { input, env: s.env(), timeoutMs: 20_000 },
  );
  assert.equal(result.timedOut, false, `the child did not exit: ${result.stderr}`);
  assert.equal(result.code, 0, result.stderr);
  return { out: JSON.parse(result.stdout) as unknown, stderr: result.stderr };
}

/**
 * Like `inChild`, but the input arrives in stages: stage 0 at once, stage n+1 after the child has
 * printed its n+1st line (`print` adds the newline). Returns the printed values.
 */
async function inChildStaged(t: TestContext, body: string, stages: string[]): Promise<unknown[]> {
  const s = sandbox(t);
  const script = `
    import { processContext } from ${JSON.stringify(CONTEXT_MODULE)};
    const { io } = processContext();
    const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    ${body}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    env: s.env(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const printed: unknown[] = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.stdin.write(stages[0] ?? '');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      printed.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      child.stdin.write(stages[printed.length] ?? '');
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });
  const deadline = new Promise<'timeout'>((resolve) => {
    setTimeout(() => {
      resolve('timeout');
    }, 15_000).unref();
  });
  const outcome = await Promise.race([exited, deadline]);
  assert.notEqual(
    outcome,
    'timeout',
    `the child hung after printing ${JSON.stringify(printed)}: ${stderr}`,
  );
  assert.equal(outcome, 0, stderr);
  return printed;
}

describe('processContext', () => {
  test('holds the real platform and an Io', () => {
    const ctx = processContext();

    assert.equal(typeof ctx.platform.clock.nowNs(), 'bigint');
    assert.equal(ctx.platform.nodePath, process.execPath);
    assert.equal(typeof ctx.io.stdout, 'function');
    assert.equal(typeof ctx.io.keys, 'function');
  });

  test('isTTY and size describe the streams: pipes are not terminals and give 80x24', async (t) => {
    const { out } = await inChild(t, 'print({ tty: io.isTTY, size: io.size() });', '');

    assert.deepEqual(out, {
      tty: { stdin: false, stdout: false, stderr: false },
      size: { columns: 80, rows: 24 },
    });
  });

  test('readLine writes the prompt to stderr and answers line after line, then null', async (t) => {
    const { out, stderr } = await inChild(
      t,
      `print([await io.readLine('Q1? '), await io.readLine('Q2? '), await io.readLine('Q3? '), await io.readLine('Q4? ')]);`,
      'one\ntwo\r\nlast without newline',
    );

    assert.deepEqual(out, ['one', 'two', 'last without newline', null]);
    assert.ok(stderr.includes('Q1? Q2? Q3? Q4? '), stderr);
  });

  test('readLine at once end of input is null and the process still exits', async (t) => {
    const { out } = await inChild(t, `print(await io.readLine('? '));`, '');

    assert.equal(out, null);
  });

  test('the process exits after readLine although stdin has more lines', async (t) => {
    const { out } = await inChild(t, `print(await io.readLine('? '));`, 'a\nb\nc\n');

    assert.equal(out, 'a');
  });

  test('keys yields what stdin delivers and ends at end of input', async (t) => {
    const { out } = await inChild(
      t,
      `const chunks = []; for await (const chunk of io.keys()) chunks.push(chunk); print(chunks.join(''));`,
      'jjq\u001b[A',
    );

    assert.equal(out, 'jjq\u001b[A');
  });

  test('leaving keys() early lets the process exit', async (t) => {
    const { out } = await inChild(
      t,
      `for await (const chunk of io.keys()) { print(chunk[0]); break; }`,
      'q'.repeat(10),
    );

    assert.equal(out, 'q');
  });
  test('keys works after readLine, and readLine after keys, on the same stdin', async (t) => {
    const printed = await inChildStaged(
      t,
      `
      print(await io.readLine(''));
      const keys = io.keys();
      print((await keys.next()).value);
      await keys.return();
      print(await io.readLine(''));
      `,
      ['first\n', 'j', 'second\n'],
    );

    assert.deepEqual(printed, ['first', 'j', 'second']);
  });

  test('keys after keys works', async (t) => {
    const printed = await inChildStaged(
      t,
      `
      const one = io.keys();
      print((await one.next()).value);
      await one.return();
      const two = io.keys();
      print((await two.next()).value);
      await two.return();
      print('done');
      `,
      ['a', 'b', ''],
    );

    assert.deepEqual(printed, ['a', 'b', 'done']);
  });
  test('readLine after keys has used up standard input gives null and the process exits', async (t) => {
    const { out } = await inChild(
      t,
      `for await (const chunk of io.keys()) {} print(await io.readLine('? '));`,
      'a\nb\n',
    );

    assert.equal(out, null);
  });
});
