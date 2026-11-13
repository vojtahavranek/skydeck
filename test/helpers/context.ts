import type { TestContext } from 'node:test';

import type { Context, TerminateSignal } from '../../src/cli/context.ts';
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
  /** Resizes the fake terminal (see `capture`). */
  resize: (size: { columns: number; rows: number }) => void;
  /** The keys() readers still open (see `capture`). */
  openKeys: () => number;
  /** Calls the onTerminate callbacks (see `capture`). */
  terminate: (signal: TerminateSignal) => void;
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
  options?: Omit<TestPlatformOptions, 'realProcesses'> & CaptureOptions,
): TestCtx & TestPlatform;
export function testContext(
  t?: TestContext,
  options: Omit<TestPlatformOptions, 'realProcesses'> & CaptureOptions = {},
): TestCtx | (TestCtx & TestPlatform) {
  if (t === undefined) {
    const captured = capture(options);
    return { ctx: { io: captured.io, platform: noPlatform() }, ...recorded(captured) };
  }
  return testContextOn(testPlatform(t, options), options);
}

/** A `Context` like testContext's, on a test platform the caller built (realTestPlatform). */
export function testContextOn<T extends { platform: Platform }>(
  tp: T,
  options: CaptureOptions = {},
): TestCtx & T {
  const captured = capture(options);
  return { ctx: { io: captured.io, platform: tp.platform }, ...recorded(captured), ...tp };
}

/** What a test reads back from the captured io. */
function recorded(captured: ReturnType<typeof capture>): Omit<TestCtx, 'ctx'> {
  return {
    stdout: captured.stdout,
    stderr: captured.stderr,
    prompts: captured.prompts,
    resize: captured.resize,
    openKeys: captured.openKeys,
    terminate: captured.terminate,
  };
}
