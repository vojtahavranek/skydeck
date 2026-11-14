// Headless Chromium for the page suite (S2 17.4, 17.5; plan A15): the `playwright` library driven
// from node:test, not @playwright/test.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { sandbox } from '../../test/helpers/sandbox.ts';

/** What the page suite fails with when the pinned Playwright's Chromium is not installed (S2 17.5). */
export const NOT_INSTALLED =
  'Chromium for Playwright is not installed; run: npx playwright install chromium';

/** What a page under test can reach (S2 17.5; smoke.test.ts pins both). */
const ISOLATION = [
  // No host name resolves, and no address but 127.0.0.1 (the rule covers address literals too).
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  // WebRTC sends UDP past the resolver (a STUN request to 127.0.0.2 arrived without this).
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/**
 * Launches headless Chromium and closes it in `t.after`. Call it once per test file, from the
 * test that holds the file's cases as subtests, and give each case its own page (`newPage`).
 *
 * Chromium gets a sandbox's environment (its home, an empty PATH, no display), so that it writes
 * nothing into the developer's home and can never open a window on the desktop. Playwright's own
 * temporary directories (the browser's profile, its artifacts) and Chromium's are made in the
 * sandbox too, so that even a killed run leaves them nowhere else. A page under test reaches
 * nothing but 127.0.0.1 (ISOLATION). When the pinned Playwright's Chromium is missing, it fails
 * with NOT_INSTALLED.
 *
 * Playwright makes the profile in this process's temporary directory, so TMPDIR points into the
 * sandbox while it launches: call it before anything else of its file runs.
 */
export async function browser(t: TestContext): Promise<Browser> {
  let launched: Browser | undefined;
  let closeFailure: { error: unknown } | null = null;
  // Registered before the sandbox, whose own t.after removes its directory: hooks run first in,
  // first out, so Chromium is gone before its home is. node:test runs no hook after one that
  // throws, so a failed close is kept and thrown only once the sandbox is removed.
  t.after(async () => {
    try {
      await launched?.close();
    } catch (error) {
      closeFailure = { error };
    }
  });
  const s = sandbox(t);
  t.after(() => {
    if (closeFailure !== null) {
      throw closeFailure.error;
    }
  });
  const tmp = join(s.root, 'tmp');
  mkdirSync(tmp);
  const caller = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    launched = await chromium.launch({
      headless: true,
      // A time zone and a language no machine is likely to have: a page that is not made by
      // newPage, which pins both, shows them at once.
      env: s.env({ TMPDIR: tmp, TZ: 'Pacific/Kiritimati', LANG: 'cs_CZ.UTF-8' }),
      args: ISOLATION,
    });
  } catch (error) {
    // Playwright's own wording for a browser it cannot find (its registry's executablePathOrDie).
    if (error instanceof Error && error.message.includes("Executable doesn't exist at ")) {
      throw new Error(NOT_INSTALLED);
    }
    throw error;
  } finally {
    if (caller === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = caller;
    }
  }
  return launched;
}

/**
 * A page in a fresh browser context (no storage shared with another case), closed in `t.after`.
 * Its time zone is UTC and its language en-US, whatever the machine's, so that times and ages a
 * page shows are the same on every machine.
 */
export async function newPage(t: TestContext, chromium: Browser): Promise<Page> {
  const context = await chromium.newContext({ timezoneId: 'UTC', locale: 'en-US' });
  t.after(() => context.close());
  return context.newPage();
}
