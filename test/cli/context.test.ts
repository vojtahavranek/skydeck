import assert from 'node:assert/strict';
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
});
