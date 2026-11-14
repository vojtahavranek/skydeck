// The page with web/'s REAL modules (ruled by the plan owner, the review of the pinned shell tests):
// the page shell's own tests run on pinned copies of the placeholders (helpers/shell.ts
// `pinModules`), so this one case keeps the real list, terminal view, cards and help under the
// shell's check that a page of a real server loads, connects and reports no problem. It relies on
// nothing a module draws, so it stays true when tasks 27–29 replace them; each of those tasks also
// asserts an empty `problems` in its own file.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { securityHeaders } from '../src/window/assets.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { browser } from './helpers/browser.ts';
import { launched, zone } from './helpers/shell.ts';

test('the page with the real modules of web/', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "a real server's page with web/'s own modules loads under the server's policy, connects and reports no problem",
    async (t) => {
      const l = await launched(t, chromium); // no `modules`: nothing pinned
      await sleep(1500);

      const response = await l.page.reload();
      await l.page.waitForSelector('html[data-connection="open"]', { state: 'attached' });
      await sleep(1500);

      assert.equal(
        response?.headers()['content-security-policy'],
        securityHeaders(l.server.port)['Content-Security-Policy'],
      );
      assert.deepEqual(l.problems, []);
      assert.match(await zone(l.page), /^Focus: terminal$/, 'the terminal is the default zone');
    },
  );
});
