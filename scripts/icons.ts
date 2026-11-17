// `node scripts/icons.ts` (S2 12.12; plan E14, task 94; follow-up F10): draws the owner's two
// pictures, scripts/icons/skydeck-source.png and scripts/icons/skydeck-source-small.png, into the PNG
// files of web/icons/ and web/icons/favicon.ico with the pinned Playwright's Chromium. Run it by
// hand after changing a picture or the numbers below, and commit what it wrote: there is no build
// step, and no test and no CI step runs it (test/window/icons.test.ts holds its output, and reduces
// the pictures again in Node to see that the files are the pictures').
//
// Which picture. The large one (a cloud and three stacked terminal windows) is drawn into the 192
// and 512 pixel files and the two maskable ones. At 48 pixels and below it blurs (at 16 into a
// ring with a spot), so the 16, 32 and 48 pixel files, and the three images of favicon.ico, are
// drawn from the small one: the same tile and cloud with one terminal window and a bold `>_`. The
// small picture has a transparent margin of 18 to 29 pixels (of 1254) around its tile, and one
// pixel of a 16 pixel file is 78 of them: drawn whole, the outer rows and columns would be only
// partly covered, a soft rim on a light title bar. So the small files are drawn from the tile's box
// (the pixels of alpha 250 or more): its shorter side, scaled to the icon and centred on the tile,
// so that the tile fills the box; the rounded corners stay transparent.
//
// How a size is made. Chromium decodes the picture; the script then averages, for each pixel of the
// icon, the picture's pixels under it, weighted by the area they cover, premultiplied and in linear
// light. That is the box filter at exactly the icon's pixel pitch: nothing aliases (no pixel is
// skipped), nothing rings, and no halo of the tile's edge spreads onto the transparent corners (a
// stepwise halving on a canvas with Chromium's high-quality smoothing, tried first, left a grey
// halo outside the tile on a light background and a duller 16 pixel icon). The transparent icons
// are the whole picture in their box. The maskable ones are the large picture scaled by
// MASKABLE_SCALE into the middle of a full background of BACKGROUND, the tile's colour around the
// ring where the picture is faded out: it is drawn in full within FADE_FROM pixels of its middle,
// fades out to the background over the next ring and is not drawn beyond FADE_TO. The drawing
// is well inside; the tile's own edge (a lighter hairline, and a tile lighter at its top) would
// otherwise show as a faint frame, a tile inside a tile.
//
// Chromium is launched by the rules the page suite's test-page/helpers/browser.ts follows (whose
// `browser(t)` needs a test context, so the script launches by itself): headless, with an
// environment of its own (no DISPLAY; HOME, TMPDIR and an empty PATH in a new temporary directory
// that the script removes at its end), so that the user's own profile is never touched and no
// window opens on the desktop; no host name resolves, and every request but the one data: URL the
// page is loaded from is aborted. The pictures reach the page as an argument, not as a request.
// It writes only under this checkout's web/icons/.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'playwright';

/** The owner's pictures, relative to the checkout: kept as they were received, and not under web/
 *  (they are not served and not part of the build). */
export const SOURCE = 'scripts/icons/skydeck-source.png';
export const SOURCE_SMALL = 'scripts/icons/skydeck-source-small.png';
/** The sizes drawn on a transparent background, and those of them that go into favicon.ico. */
export const SIZES = [16, 32, 48, 192, 512];
export const IN_ICO = [16, 32, 48];
/** The sizes drawn from the small picture; the others are drawn from the large one. */
export const SMALL = [16, 32, 48];
/** The maskable ones: the large picture in the middle, on the full background. */
export const MASKABLE = [192, 512];
/** The maskable icons' background: the large picture's tile around the ring between FADE_FROM and
 *  FADE_TO (the average of its opaque pixels there; test/window/icons.test.ts measures it). */
export const BACKGROUND = '#040925';
/** In a maskable icon the large picture is drawn in full within FADE_FROM pixels of its middle (of
 *  1254), fades out to the background over the next ring, and is not drawn beyond FADE_TO. The
 *  drawing reaches 540.8 pixels (checked below) and the tile's own edge starts 594 out. */
export const FADE_FROM = 555;
export const FADE_TO = 585;
/** How much of the icon's width the large picture takes in a maskable icon: the largest scale, to
 *  three decimals, at which everything of the drawing is inside the safe zone (checked below). */
export const MASKABLE_SCALE = 0.927;

/** The safe zone of a maskable icon: a circle of this radius, in parts of the icon's width. */
const SAFE_RADIUS = 0.4;
/** The drawing is what differs from the background by more than this (of 255) in some channel,
 *  composited on it. */
const DRAWN = 40;
/** A pixel from this alpha up is opaque (the tiles are at 251 to 254 of 255). */
const OPAQUE = 250;

/** What a page under the page suite can reach (test-page/helpers/browser.ts): nothing. */
const ISOLATION = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** One PNG to draw from `picture`: `size` pixels, the picture at `scale` of that in the middle, on
 *  the background (and faded out as above) or on nothing. */
interface Job {
  name: string;
  picture: 'large' | 'small';
  size: number;
  scale: number;
  onBackground: boolean;
}

function colourOf(hex: string): number[] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (match === null) {
    throw new Error(`${hex} is not a colour of the form #rrggbb`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 16));
}

/**
 * Draws every job in the page: decodes the pictures (Chromium), checks that the numbers above hold
 * for the large one, and returns each PNG (Chromium's encoder: IHDR, IDAT and IEND, no metadata) as
 * base64.
 */
async function drawAll(
  page: Page,
  pictures: { large: Buffer; small: Buffer },
  jobs: Job[],
): Promise<Map<string, Buffer>> {
  const drawn = await page.evaluate(
    async ({
      pictures,
      jobs,
      background,
      fadeFrom,
      fadeTo,
      safeRadius,
      drawn,
      opaque,
      maskableScale,
    }) => {
      // sRGB bytes to linear light, and back.
      const lut = Float64Array.from({ length: 256 }, (_, i) => {
        const v = i / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      const encode = (v: number): number =>
        Math.min(
          255,
          Math.max(
            0,
            Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)),
          ),
        );

      const load = async (
        base64: string,
      ): Promise<{ count: number; pixels: Uint8ClampedArray }> => {
        const bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }),
        );
        const count = bitmap.width;
        if (bitmap.height !== count) {
          throw new Error(`a picture is ${count} x ${bitmap.height} pixels, not square`);
        }
        const surface = new OffscreenCanvas(count, count);
        const context = surface.getContext('2d', { willReadFrequently: true });
        if (context === null) {
          throw new Error('the page has no 2d canvas');
        }
        context.drawImage(bitmap, 0, 0);
        return { count, pixels: context.getImageData(0, 0, count, count).data };
      };

      // A picture's pixels as premultiplied linear light, 4 floats a pixel, each times `weightAt`
      // of its distance from the picture's middle.
      const premultiply = (
        { count, pixels }: { count: number; pixels: Uint8ClampedArray },
        weightAt: (r: number) => number,
      ): Float32Array => {
        const out = new Float32Array(count * count * 4);
        for (let y = 0; y < count; y++) {
          for (let x = 0; x < count; x++) {
            const i = y * count + x;
            const w = weightAt(Math.hypot(x + 0.5 - count / 2, y + 0.5 - count / 2));
            const a = ((pixels[i * 4 + 3] ?? 0) / 255) * w;
            for (let c = 0; c < 3; c++) {
              out[i * 4 + c] = (lut[pixels[i * 4 + c] ?? 0] ?? 0) * a;
            }
            out[i * 4 + 3] = a;
          }
        }
        return out;
      };

      const large = await load(pictures.large);
      const small = await load(pictures.small);

      // The small picture's tile: the box of its opaque pixels.
      let minX = small.count;
      let maxX = -1;
      let minY = small.count;
      let maxY = -1;
      for (let i = 0; i < small.count * small.count; i++) {
        if ((small.pixels[i * 4 + 3] ?? 0) >= opaque) {
          const x = i % small.count;
          const y = Math.floor(i / small.count);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      if (maxX < minX || maxY < minY) {
        throw new Error('the small picture has no opaque pixel');
      }
      // The small files show the shorter side of the tile's box, centred on the tile.
      const tileSide = Math.min(maxX - minX + 1, maxY - minY + 1);

      // The scale holds for the large picture: the drawing, scaled, stays inside the circle, and
      // it is clear of the ring where the maskable icons fade the picture out.
      let farthest = 0;
      for (let i = 0; i < large.count * large.count; i++) {
        const a = (large.pixels[i * 4 + 3] ?? 0) / 255;
        if (
          [0, 1, 2].some(
            (c) => Math.abs(a * ((large.pixels[i * 4 + c] ?? 0) - (background[c] ?? 0))) > drawn,
          )
        ) {
          const x = (i % large.count) + 0.5 - large.count / 2;
          const y = Math.floor(i / large.count) + 0.5 - large.count / 2;
          farthest = Math.max(farthest, Math.hypot(x, y));
        }
      }
      if (maskableScale * farthest > safeRadius * large.count) {
        throw new Error(
          `the drawing reaches ${farthest} of ${large.count / 2} pixels: at ${maskableScale} it leaves the circle of ${safeRadius}; the largest scale is ${(safeRadius * large.count) / farthest}`,
        );
      }
      if (farthest >= fadeFrom) {
        throw new Error(`the drawing reaches ${farthest} pixels: the fade starts at ${fadeFrom}`);
      }

      const sources = {
        large: premultiply(large, () => 1),
        small: premultiply(small, () => 1),
        faded: premultiply(large, (r) =>
          r <= fadeFrom ? 1 : r >= fadeTo ? 0 : (fadeTo - r) / (fadeTo - fadeFrom),
        ),
      };
      const backgroundLinear = background.map((value) => lut[value] ?? 0);

      // The picture's pixels that the output pixel `t` (one axis) covers, with their weights.
      const axis = (t: number, count: number, span: number, offset: number): [number, number[]] => {
        const k = span / count;
        const first = Math.max(0, Math.floor((t - offset) / k));
        const last = Math.min(count - 1, Math.ceil((t + 1 - offset) / k) - 1);
        const weights: number[] = [];
        for (let i = first; i <= last; i++) {
          weights.push(
            Math.max(0, Math.min(t + 1, offset + (i + 1) * k) - Math.max(t, offset + i * k)),
          );
        }
        return [first, weights];
      };

      const base64Of = (bytes: Uint8Array): string => {
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(text);
      };

      const out: Record<string, string> = {};
      for (const job of jobs) {
        const { size } = job;
        const count = (job.picture === 'small' ? small : large).count;
        const source = job.onBackground ? sources.faded : sources[job.picture];
        let span = size * job.scale;
        let offsetX = (size - span) / 2;
        let offsetY = offsetX;
        if (job.picture === 'small') {
          span = (size * count) / tileSide;
          offsetX = size / 2 - (((minX + maxX + 1) / 2) * span) / count;
          offsetY = size / 2 - (((minY + maxY + 1) / 2) * span) / count;
        }
        const columns = Array.from({ length: size }, (_, t) => axis(t, count, span, offsetX));
        const rows = Array.from({ length: size }, (_, t) => axis(t, count, span, offsetY));
        const rgba = new Uint8ClampedArray(size * size * 4);
        for (let ty = 0; ty < size; ty++) {
          const [y0, wy] = rows[ty] ?? [0, []];
          for (let tx = 0; tx < size; tx++) {
            const [x0, wx] = columns[tx] ?? [0, []];
            const sum = [0, 0, 0, 0];
            wy.forEach((weightY, j) => {
              wx.forEach((weightX, i) => {
                const from = ((y0 + j) * count + x0 + i) * 4;
                const weight = weightX * weightY;
                for (let c = 0; c < 4; c++) {
                  sum[c] = (sum[c] ?? 0) + weight * (source[from + c] ?? 0);
                }
              });
            });
            const o = (ty * size + tx) * 4;
            const covered = sum[3] ?? 0;
            if (job.onBackground) {
              for (let c = 0; c < 3; c++) {
                rgba[o + c] = encode((sum[c] ?? 0) + (1 - covered) * (backgroundLinear[c] ?? 0));
              }
              rgba[o + 3] = 255;
            } else if (covered > 0) {
              for (let c = 0; c < 3; c++) {
                rgba[o + c] = encode((sum[c] ?? 0) / covered);
              }
              rgba[o + 3] = Math.round(covered * 255);
            }
          }
        }
        const canvas = new OffscreenCanvas(size, size);
        const target = canvas.getContext('2d');
        if (target === null) {
          throw new Error('the page has no 2d canvas');
        }
        target.putImageData(new ImageData(rgba, size, size), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        out[job.name] = base64Of(new Uint8Array(await blob.arrayBuffer()));
      }
      return out;
    },
    {
      pictures: {
        large: pictures.large.toString('base64'),
        small: pictures.small.toString('base64'),
      },
      jobs,
      background: colourOf(BACKGROUND),
      fadeFrom: FADE_FROM,
      fadeTo: FADE_TO,
      safeRadius: SAFE_RADIUS,
      drawn: DRAWN,
      opaque: OPAQUE,
      maskableScale: MASKABLE_SCALE,
    },
  );
  return new Map(
    Object.entries(drawn).map(([name, base64]) => [name, Buffer.from(base64, 'base64')]),
  );
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
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  const icons = join(checkout, 'web/icons/');
  mkdirSync(icons, { recursive: true });
  const pictures = {
    large: readFileSync(join(checkout, SOURCE)),
    small: readFileSync(join(checkout, SOURCE_SMALL)),
  };

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
    // Loaded here, so that the unit test that imports this file's constants loads no playwright.
    const { chromium } = await import('playwright');
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
      const context = await browser.newContext({ deviceScaleFactor: 1, serviceWorkers: 'block' });
      const url = `data:text/html;base64,${Buffer.from('<!doctype html>\n<meta charset="utf-8">').toString('base64')}`;
      await context.route('**/*', (route) =>
        route.request().url() === url ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(url);

      // Everything is drawn first and written last, so that a run that stops writes nothing.
      const jobs: Job[] = [
        ...SIZES.map((size) => ({
          name: `icon-${size}.png`,
          picture: SMALL.includes(size) ? ('small' as const) : ('large' as const),
          size,
          scale: 1,
          onBackground: false,
        })),
        ...MASKABLE.map((size) => ({
          name: `icon-${size}-maskable.png`,
          picture: 'large' as const,
          size,
          scale: MASKABLE_SCALE,
          onBackground: true,
        })),
      ];
      const written = await drawAll(page, pictures, jobs);
      const images = IN_ICO.map((size) => {
        const png = written.get(`icon-${size}.png`);
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
