// `node scripts/icons.ts` (S2 12.12; plan E14, task 94): draws web/icons/skydeck.svg into the PNG
// files of web/icons/ and web/icons/favicon.ico with the pinned Playwright's Chromium. Run it by
// hand after changing the SVG, and commit what it wrote: there is no build step, and no test and no
// CI step runs it (test/window/icons.test.ts holds its output).
//
// Chromium is launched by the rules the page suite's test-page/helpers/browser.ts follows (whose
// `browser(t)` needs a test context, so the script launches by itself): headless, with an
// environment of its own (no DISPLAY; HOME, TMPDIR and an empty PATH in a new temporary directory
// that the script removes at its end), so that the user's own profile is never touched and no
// window opens on the desktop; no host name resolves, and every request but the one data: URL the
// page is loaded from is aborted. It writes only under this checkout's web/icons/.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

/** The sizes drawn on a transparent background, and those of them that go into favicon.ico. */
const SIZES = [16, 32, 48, 192, 512];
const IN_ICO = [16, 32, 48];
/** The maskable ones: the drawing in the middle 80 % (the safe zone) on the full background. */
const MASKABLE = [192, 512];
const SAFE_ZONE = 0.8;
/** The tile's colour in the SVG (the page's accent, web/style.css `--accent`): the maskable icons'
 *  background, so that the tile does not show as a square inside a square. */
const BACKGROUND = '#2f6fde';

/** What a page under the page suite can reach (test-page/helpers/browser.ts): nothing. */
const ISOLATION = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** The page that draws: the SVG as an image, sized and placed by `draw`. */
function pageHtml(svg: Buffer): string {
  const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<style>',
    'html, body { margin: 0; background: transparent; }',
    '#box { position: absolute; left: 0; top: 0; }',
    '#box img { position: absolute; display: block; }',
    '</style>',
    `<div id="box"><img alt="" src="${src}"></div>`,
  ].join('\n');
}

/** One PNG of `size` pixels: the image fills the box, or SAFE_ZONE of it on BACKGROUND. */
async function draw(page: Page, size: number, maskable: boolean): Promise<Buffer> {
  await page.evaluate(
    ({ size, inner, background }) => {
      const box = document.getElementById('box');
      const img = box?.querySelector('img');
      if (!box || !img) {
        throw new Error('the drawing page has no image');
      }
      const offset = (size - inner) / 2;
      box.style.width = box.style.height = `${size}px`;
      box.style.background = background;
      img.style.width = img.style.height = `${inner}px`;
      img.style.left = img.style.top = `${offset}px`;
    },
    {
      size,
      inner: maskable ? size * SAFE_ZONE : size,
      background: maskable ? BACKGROUND : 'transparent',
    },
  );
  return page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: !maskable,
  });
}

/** favicon.ico: the ICO directory (6 bytes, 16 per image) followed by the PNGs as they are. */
function ico(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // an icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size, at); // width; 0 would mean 256
    header.writeUInt8(size, at + 1); // height
    header.writeUInt8(0, at + 2); // no palette
    header.writeUInt8(0, at + 3); // reserved
    header.writeUInt16LE(1, at + 4); // planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

async function main(): Promise<void> {
  const icons = fileURLToPath(new URL('../web/icons/', import.meta.url));
  const svg = readFileSync(join(icons, 'skydeck.svg'));
  if (!svg.toString('utf8').includes(`fill="${BACKGROUND}"`)) {
    throw new Error(`web/icons/skydeck.svg has no tile of ${BACKGROUND}: change BACKGROUND too`);
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skydeck-icons-')));
  try {
    const home = join(root, 'home');
    const tmp = join(root, 'tmp');
    const bin = join(root, 'bin');
    for (const dir of [home, tmp, bin]) {
      mkdirSync(dir);
    }
    // Playwright makes the browser's profile in this process's temporary directory.
    const caller = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: true,
        env: { HOME: home, TMPDIR: tmp, PATH: bin, LANG: 'C.UTF-8', TZ: 'UTC' },
        args: ISOLATION,
      });
    } finally {
      if (caller === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = caller;
      }
    }
    try {
      const context = await browser.newContext({
        viewport: { width: 512, height: 512 },
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
      });
      const url = `data:text/html;base64,${Buffer.from(pageHtml(svg)).toString('base64')}`;
      await context.route('**/*', (route) =>
        route.request().url() === url ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(url);
      await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());

      // Everything is drawn first and written last, so that a run that stops writes nothing.
      const pngs = new Map<number, Buffer>();
      const written = new Map<string, Buffer>();
      for (const size of SIZES) {
        const png = await draw(page, size, false);
        pngs.set(size, png);
        written.set(`icon-${size}.png`, png);
      }
      for (const size of MASKABLE) {
        written.set(`icon-${size}-maskable.png`, await draw(page, size, true));
      }
      const images = IN_ICO.map((size) => {
        const png = pngs.get(size);
        if (png === undefined) {
          throw new Error(`favicon.ico needs icon-${size}.png, which SIZES does not draw`);
        }
        return { size, png };
      });
      written.set('favicon.ico', ico(images));
      for (const [name, bytes] of written) {
        writeFileSync(join(icons, name), bytes);
      }
      console.log(`icons: wrote ${[...written.keys()].join(', ')} to ${icons}`);
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`icons: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
