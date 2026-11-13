import type { TestContext } from 'node:test';

import type { Context } from '../../src/cli/context.ts';
import type { Platform } from '../../src/platform/types.ts';
import { capture } from './capture.ts';
import type { CaptureOptions } from './capture.ts';
import { testPlatform } from './platform.ts';
import type { TestPlatform, TestPlatformOptions } from './platform.ts';

export interface TestCtx {
  ctx: Context;
  stdout: () => string;
  stderr: () => string;
  prompts: string[];
}

/** A platform whose every member throws: enough for `--help` and `--version`, nothing more. */
function noPlatform(): Platform {
  return new Proxy({} as Platform, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') {
        return undefined; // so that printing or awaiting a context does not throw
      }
      throw new Error(`ctx.platform.${key} used: pass t to testContext`);
    },
  });
}

/**
 * A `Context` for tests, with what was written to it readable afterwards.
 *
 * Without `t` (as the scaffold's tests call it) `ctx.platform` is a stub whose every member throws
 * "pass t to testContext" — enough for `--help` and `--version`. With `t` it is
 * `testPlatform(t, options)`: real files inside a sandbox, a fake clock, `/proc` and runner; the
 * result carries that test platform as well.
 */
export function testContext(): TestCtx;
export function testContext(
  t: TestContext,
  options?: TestPlatformOptions & CaptureOptions,
): TestCtx & TestPlatform;
export function testContext(
  t?: TestContext,
  options: TestPlatformOptions & CaptureOptions = {},
): TestCtx | (TestCtx & TestPlatform) {
  const captured = capture(options);
  const shared = { stdout: captured.stdout, stderr: captured.stderr, prompts: captured.prompts };
  if (t === undefined) {
    return { ctx: { io: captured.io, platform: noPlatform() }, ...shared };
  }
  const tp = testPlatform(t, options);
  return { ctx: { io: captured.io, platform: tp.platform }, ...shared, ...tp };
}
