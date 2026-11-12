import type { Context } from '../../src/cli/context.ts';
import { capture } from './capture.ts';

export interface TestCtx {
  ctx: Context;
  stdout: () => string;
  stderr: () => string;
}

/**
 * A `Context` for tests, with what was written to it readable afterwards. Later pull requests add
 * their fakes (clock, platform, ...) here, so that tests do not each build their own.
 */
export function testContext(): TestCtx {
  const captured = capture();
  return { ctx: { io: captured.io }, stdout: captured.stdout, stderr: captured.stderr };
}
