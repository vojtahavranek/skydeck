// `node scripts/icons.ts` (S2 12.12; plan E14, task 94; follow-ups F10 and F12): draws the owner's
// two pictures, scripts/icons/skydeck-source.png and scripts/icons/skydeck-source-small.png, into
// the PNG files of web/icons/ and web/icons/favicon.ico with the pinned Playwright's Chromium. Run
// it by hand after changing a picture or the numbers below, and commit what it wrote: there is no
// build step, and no test and no CI step runs it (test/window/icons.test.ts holds its output, and
// reduces the pictures again in Node to see that the files are the pictures').
//
// Which picture. The large one (a cloud and three stacked terminal windows) is drawn into the 192
// and 512 pixel files and the two maskable ones. At 48 pixels and below it blurs (at 16 into a
// ring with a spot), so the 16, 32 and 48 pixel files, and the three images of favicon.ico, are
// drawn from the small one: the same tile and cloud with one terminal window and a bold `>_`.
//
// How much of the small picture (F12). Not all of it, and not its tile. The window's taskbar
// button and title bar show these files small, on a taskbar that is dark, where the navy tile is
// nearly invisible; and the drawing is only 83 % of the tile's width and 70 % of its height, so
// the icon looked small and blurred beside the others. Each small file is a square crop of the
// picture, on the tile's navy, its corners rounded with the tile's own relative radius
// (CORNER_RADIUS): the corners are transparent, and along the straight sides alpha is 252 to 255,
// not always 255, because a picture pixel on the crop's edge counts in the mask and again in the
// area average. The crops:
//   - 32 and 48 pixels: the drawing, the box DRAWING_BOX (the cloud with the window in front)
//     and DRAWING_MARGIN of its width on each side, so that the drawing fills the square;
//   - 16 pixels (WINDOW_ONLY): the terminal window alone, WINDOW_BOX and WINDOW_MARGIN on each
//     side, and what of the cloud's strokes falls in the crop outside the window (beyond
//     WINDOW_CLEARANCE pixels of its outline, whose corners have the radius WINDOW_RADIUS) is
//     painted the tile's navy: at 16 pixels a cloud stroke is a smear, and the window with its
//     `>_` is what reads.
// The boxes, the navy and the radii were measured from the small picture; test/window/icons.test.ts
// measures them again from the picture and holds these numbers to what it finds. Every crop lies
// inside the tile, so the tile's own soft edge is never in a small file.
//
// How a size is made. Chromium decodes the picture; the script then averages, for each pixel of the
// icon, the picture's pixels under it, weighted by the area they cover, premultiplied and in linear
// light. That is the box filter at exactly the icon's pixel pitch: nothing aliases (no pixel is
// skipped), nothing rings, and no halo of the tile's edge spreads onto the transparent corners (a
// stepwise halving on a canvas with Chromium's high-quality smoothing, tried first, left a grey
// halo outside the tile on a light background and a duller 16 pixel icon). The large files that
// are not maskable are the whole large picture, transparent where it is (its rounded corners). The
// maskable ones are the large picture scaled by MASKABLE_SCALE into the middle of a full
// background of BACKGROUND, the tile's colour around the ring where the picture is faded out: it
// is drawn in full within FADE_FROM pixels of its middle, fades out to the background over the
// next ring and is not drawn beyond FADE_TO. The drawing is well inside; the tile's own edge (a
// lighter hairline, and a tile lighter at its top) would otherwise show as a faint frame, a tile
// inside a tile.
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
/** Of those, the sizes that show the terminal window alone; the others show the drawing. */
export const WINDOW_ONLY = [16];
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

/** A box of the small picture's pixels, both ends included. */
export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
/** The small picture's drawing (the cloud with the window in front) and its terminal window, as
 *  boxes of its pixels (of 1254): what is more than 40 (of 255) from the tile's navy in some
 *  channel, at least 60 pixels inside the tile; the window's along a column and five rows across
 *  its frame. test/window/icons.test.ts measures both again. */
export const DRAWING_BOX: Box = { minX: 115, maxX: 1115, minY: 202, maxY: 1045 };
export const WINDOW_BOX: Box = { minX: 306, maxX: 941, minY: 546, maxY: 1045 };
/** The crops are as wide as their box plus this part of it on each side. */
export const DRAWING_MARGIN = 0.02;
export const WINDOW_MARGIN = 0.04;
/** The small picture's tile colour: the mean of a zone of the tile with nothing drawn in it. */
export const TILE_NAVY = '#01062b';
/** The crops' corner radius in parts of their side: the tile's own (a circle of 273 pixels fits
 *  the edge of its 1200 pixel side). */
export const CORNER_RADIUS = 273 / 1200;
/** The terminal window's outer corner radius, in pixels of the small picture (a circle fitted to
 *  its left edge), and how far beyond its outline the cloud is painted out at 16 pixels. */
export const WINDOW_RADIUS = 107;
export const WINDOW_CLEARANCE = 3;

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

/** What of the small picture a small file shows: the drawing, or the terminal window alone. */
type View = 'drawing' | 'window';

/** A square of the small picture, in its pixels. */
interface Crop {
  x: number;
  y: number;
  side: number;
}

/** The crop that is as wide as `box` plus `margin` of its width each side, centred on `box`. */
function cropOf(box: Box, margin: number): Crop {
  const side = (box.maxX - box.minX + 1) * (1 + 2 * margin);
  return {
    x: (box.minX + box.maxX + 1) / 2 - side / 2,
    y: (box.minY + box.maxY + 1) / 2 - side / 2,
    side,
  };
}

/** One PNG to draw from `picture`: `size` pixels. From the large picture: at `scale` of that in
 *  the middle, on the background (and faded out as above) or on nothing. From the small one
 *  (`scale` and `onBackground` do not apply): the crop of `view`. */
interface Job {
  name: string;
  picture: 'large' | 'small';
  view: View | null;
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

/** What the page needs of the small picture's numbers, for the crops of both views. */
interface SmallNumbers {
  views: Record<View, { crop: Crop; erase: boolean }>;
  navy: number[];
  cornerRadius: number;
  window: { box: Box; radius: number; clearance: number };
}

/**
 * Draws every job in the page: decodes the pictures (Chromium), checks that the numbers above hold
 * (for the large picture, and that the small picture's crops lie inside it), and returns each PNG
 * (Chromium's encoder: IHDR, IDAT and IEND, no metadata) as base64.
 */
async function drawAll(
  page: Page,
  pictures: { large: Buffer; small: Buffer },
  jobs: Job[],
  numbers: SmallNumbers,
): Promise<Map<string, Buffer>> {
  const drawn = await page.evaluate(
    async ({
      pictures,
      jobs,
      numbers,
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

      // The small picture's crops lie inside it (a crop that left it would be partly transparent).
      for (const { crop } of Object.values(numbers.views)) {
        if (
          crop.x < 0 ||
          crop.y < 0 ||
          crop.x + crop.side > small.count ||
          crop.y + crop.side > small.count
        ) {
          throw new Error(`a crop of the small picture leaves it: ${JSON.stringify(crop)}`);
        }
      }

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
        faded: premultiply(large, (r) =>
          r <= fadeFrom ? 1 : r >= fadeTo ? 0 : (fadeTo - r) / (fadeTo - fadeFrom),
        ),
      };

      // The distance, negative inside, from the point (px, py) to the outline of the rounded
      // rectangle of half sides halfW and halfH and corner radius `radius`, centred on the origin.
      const outsideRounded = (
        px: number,
        py: number,
        halfW: number,
        halfH: number,
        radius: number,
      ): number => {
        const qx = Math.abs(px) - (halfW - radius);
        const qy = Math.abs(py) - (halfH - radius);
        return (
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
        );
      };

      // What a small file shows, premultiplied linear light, 4 floats a pixel: the picture on the
      // tile's navy (a pixel that is not opaque is the navy, and so is, with `erase`, one outside
      // the window's outline grown by the clearance) under the rounded square of the crop. Alpha
      // is the square's coverage of the pixel: from the distance of the pixel's middle to the
      // outline, 1 inside, 0 outside, a ramp of one pixel across the edge.
      const navyLinear = numbers.navy.map((value) => lut[value] ?? 0);
      const winBox = numbers.window.box;
      const winCentreX = (winBox.minX + winBox.maxX + 1) / 2;
      const winCentreY = (winBox.minY + winBox.maxY + 1) / 2;
      const winHalfW = (winBox.maxX - winBox.minX + 1) / 2 + numbers.window.clearance;
      const winHalfH = (winBox.maxY - winBox.minY + 1) / 2 + numbers.window.clearance;
      const smallSources = new Map<string, Float32Array>();
      const smallSource = (view: View): Float32Array => {
        let out = smallSources.get(view);
        if (out === undefined) {
          const { crop, erase } = numbers.views[view];
          out = new Float32Array(small.count * small.count * 4);
          for (let y = 0; y < small.count; y++) {
            for (let x = 0; x < small.count; x++) {
              const i = y * small.count + x;
              const coverage = Math.min(
                1,
                Math.max(
                  0,
                  0.5 -
                    outsideRounded(
                      x + 0.5 - crop.x - crop.side / 2,
                      y + 0.5 - crop.y - crop.side / 2,
                      crop.side / 2,
                      crop.side / 2,
                      numbers.cornerRadius * crop.side,
                    ),
                ),
              );
              const painted =
                erase &&
                outsideRounded(
                  x + 0.5 - winCentreX,
                  y + 0.5 - winCentreY,
                  winHalfW,
                  winHalfH,
                  numbers.window.radius + numbers.window.clearance,
                ) > 0;
              const solid = (small.pixels[i * 4 + 3] ?? 0) >= opaque && !painted;
              for (let c = 0; c < 3; c++) {
                out[i * 4 + c] =
                  (solid ? (lut[small.pixels[i * 4 + c] ?? 0] ?? 0) : (navyLinear[c] ?? 0)) *
                  coverage;
              }
              out[i * 4 + 3] = coverage;
            }
          }
          smallSources.set(view, out);
        }
        return out;
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
        let source: Float32Array;
        let span = size * job.scale;
        let offsetX = (size - span) / 2;
        let offsetY = offsetX;
        if (job.picture === 'small') {
          if (job.view === null) {
            throw new Error(`${job.name} is drawn from the small picture and names no view`);
          }
          // The crop is scaled to the icon: its side is `size` pixels.
          const { crop } = numbers.views[job.view];
          source = smallSource(job.view);
          span = (size * count) / crop.side;
          offsetX = (-crop.x * size) / crop.side;
          offsetY = (-crop.y * size) / crop.side;
        } else {
          source = job.onBackground ? sources.faded : sources.large;
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
      numbers,
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
          view: SMALL.includes(size)
            ? WINDOW_ONLY.includes(size)
              ? ('window' as const)
              : ('drawing' as const)
            : null,
          size,
          scale: 1,
          onBackground: false,
        })),
        ...MASKABLE.map((size) => ({
          name: `icon-${size}-maskable.png`,
          picture: 'large' as const,
          view: null,
          size,
          scale: MASKABLE_SCALE,
          onBackground: true,
        })),
      ];
      const numbers: SmallNumbers = {
        views: {
          drawing: { crop: cropOf(DRAWING_BOX, DRAWING_MARGIN), erase: false },
          window: { crop: cropOf(WINDOW_BOX, WINDOW_MARGIN), erase: true },
        },
        navy: colourOf(TILE_NAVY),
        cornerRadius: CORNER_RADIUS,
        window: { box: WINDOW_BOX, radius: WINDOW_RADIUS, clearance: WINDOW_CLEARANCE },
      };
      const written = await drawAll(page, pictures, jobs, numbers);
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
