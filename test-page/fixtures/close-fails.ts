// Run by test-page/smoke.test.ts with `node --test` and TMPDIR at an empty directory of its
// sandbox: a page test whose browser fails to close. Its sandbox must be removed all the same,
// and the failure must fail the test.
import { test } from 'node:test';

import { browser } from '../helpers/browser.ts';

test('a page test whose browser fails to close', async (t) => {
  const chromium = await browser(t);
  const close = chromium.close.bind(chromium);
  chromium.close = async (options) => {
    await close(options);
    throw new Error('the close failed on purpose');
  };
});
