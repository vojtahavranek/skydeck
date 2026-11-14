// Run by test-page/smoke.test.ts with `node --test` and PLAYWRIGHT_BROWSERS_PATH at an empty
// directory: one test that asks for the browser, as every file of the page suite does.
import { test } from 'node:test';

import { browser } from '../helpers/browser.ts';

test('a page test', async (t) => {
  await browser(t);
});
