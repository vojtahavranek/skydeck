// Headless Chromium for the page suite (S2 17.4, 17.5; plan A15): the `playwright` library driven
// from node:test, not @playwright/test.
import type { TestContext } from 'node:test';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { sandbox } from '../../test/helpers/sandbox.ts';

/** What the page suite fails with when the pinned Playwright's Chromium is not installed (S2 17.5). */
export const NOT_INSTALLED =
  'Chromium for Playwright is not installed; run: npx playwright install chromium';

/**
 * Launches headless Chromium and closes it in `t.after`. Call it once per test file, from the
 * test that holds the file's cases as subtests, and give each case its own page (`newPage`).
 *
 * Chromium gets a sandbox's environment (its home, an empty PATH, no display), so that it writes
 * nothing into the developer's home and can never open a window on the desktop. No host name
 * resolves in it: a page under test reaches nothing but an address, and the tests serve only
 * 127.0.0.1. When the pinned Playwright's Chromium is missing, it fails with NOT_INSTALLED.
 */
export async function browser(t: TestContext): Promise<Browser> {
  let launched: Browser | undefined;
  // Registered before the sandbox, whose own t.after removes its directory: hooks run first in,
  // first out, so Chromium is gone before its home is.
  t.after(async () => {
    await launched?.close();
  });
  const s = sandbox(t);
  try {
    launched = await chromium.launch({
      headless: true,
      env: s.env(),
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
  } catch (error) {
    // Playwright's own wording for a browser it cannot find (its registry's executablePathOrDie).
    if (error instanceof Error && error.message.includes("Executable doesn't exist at ")) {
      throw new Error(NOT_INSTALLED);
    }
    throw error;
  }
  return launched;
}

/** A page in a fresh browser context (no storage shared with another case), closed in `t.after`. */
export async function newPage(t: TestContext, chromium: Browser): Promise<Page> {
  const context = await chromium.newContext();
  t.after(() => context.close());
  return context.newPage();
}
