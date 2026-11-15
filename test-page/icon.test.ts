// The page's own icon (S2 12.12, 8.2.1; plan E task 97, E14): index.html links the versioned
// favicon.ico and the manifest, and a real server's page loads both under the server's policy.
// Task 94 made the files and their routes (test/window/icons.test.ts, test/window/assets.test.ts);
// this holds what the page itself asks for.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { sleep } from '../test/helpers/keeper.ts';
import { browser } from './helpers/browser.ts';
import { buildOf, launched } from './helpers/shell.ts';

const ICO = readFileSync(new URL('../web/icons/favicon.ico', import.meta.url));

/** What the page's own fetch of `href` gives: its status, its type and its body (bytes). */
interface Fetched {
  status: number;
  type: string;
  bytes: number[];
}

test("the page's icon", async (t) => {
  const chromium = await browser(t);

  await t.test(
    'the icon link names /assets/<build>/web/icons/favicon.ico (16, 32 and 48 pixels), which answers 200 image/x-icon with the committed bytes; the manifest link loads the manifest, Chromium parses it without an error, and each of its icons answers 200; the page reports no problem',
    async (t) => {
      const l = await launched(t, chromium);
      const { page } = l;
      const build = await buildOf(page);

      const links = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel~="icon"], link[rel="manifest"]')].map((link) => ({
          rel: link.getAttribute('rel'),
          href: link.getAttribute('href'),
          sizes: link.getAttribute('sizes'),
        })),
      );
      assert.deepEqual(links, [
        {
          rel: 'icon',
          href: `/assets/${build}/web/icons/favicon.ico`,
          sizes: '16x16 32x32 48x48',
        },
        { rel: 'manifest', href: '/manifest.webmanifest', sizes: null },
      ]);

      const fetched = (href: string): Promise<Fetched> =>
        page.evaluate(async (href) => {
          const response = await fetch(href);
          return {
            status: response.status,
            type: response.headers.get('content-type') ?? '',
            bytes: [...new Uint8Array(await response.arrayBuffer())],
          };
        }, href);

      const icon = await fetched(`/assets/${build}/web/icons/favicon.ico`);
      assert.equal(icon.status, 200);
      assert.equal(icon.type, 'image/x-icon');
      assert.deepEqual(Buffer.from(icon.bytes), ICO);

      // Chromium's own load of the manifest through the link (its manifest-src): parsed, no error.
      const cdp = await page.context().newCDPSession(page);
      const manifest = await cdp.send('Page.getAppManifest');
      await cdp.detach();
      assert.equal(manifest.url, `http://127.0.0.1:${l.server.port}/manifest.webmanifest`);
      assert.deepEqual(manifest.errors, []);
      const data = JSON.parse(manifest.data ?? '') as {
        name: string;
        icons: { src: string; type: string }[];
      };
      assert.equal(data.name, 'skydeck');
      assert.equal(data.icons.length, 7);

      // The manifest as the page's own fetch gets it, and every icon it names.
      const served = await fetched('/manifest.webmanifest');
      assert.equal(served.status, 200);
      assert.equal(served.type, 'application/manifest+json');
      assert.deepEqual(JSON.parse(Buffer.from(served.bytes).toString('utf8')), data);
      for (const entry of data.icons) {
        assert.match(entry.src, new RegExp(`^/assets/${build}/web/icons/icon-[0-9a-z-]+\\.png$`));
        const png = await fetched(entry.src);
        assert.equal(png.status, 200, entry.src);
        assert.equal(png.type, 'image/png', entry.src);
      }

      // Whatever Chromium asks for by itself meanwhile is answered too (no CSP refusal, no 404).
      await sleep(500);
      assert.deepEqual(l.problems, [], 'the page reports no problem');
    },
  );
});
