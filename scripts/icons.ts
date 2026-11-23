// `node scripts/icons.ts` (S2 12.12; plan E14, task 94, and the follow-ups since): draws the
// picture scripts/icons/skydeck-source.png into the PNG files of web/icons/ and the images of
// web/icons/favicon.ico with the pinned Playwright's Chromium. Run it by hand after changing the
// picture or the numbers below, and commit what it wrote: there is no build step, and no test and
// no CI step runs it (test/window/icons.test.ts holds its output, and draws every file again from
// the picture in Node to see that the files are the picture's).
//
// The picture. One, 1076 x 903 pixels, on a transparent background: a cloud drawn as a line, with
// a terminal box in front of it and a white `>_` in the box, in a blue-to-violet gradient. It is
// kept clean: one solid piece (alpha 32 or more) and its soft edge (fainter pixels within 2
// pixels of it), nothing else; faint pixels scattered over the transparent parts would put a haze
// on every file. Every file is drawn from it, at its own size.
//
// The files. icon-16, icon-32, icon-48, icon-192 and icon-512 (SIZES) are the picture on a
// transparent square: no tile, no crop, the picture centred, its longer side filling the square
// but for MARGIN of the side on each side. favicon.ico holds an image for each size the taskbar
// and a title bar show at most display scales (IN_ICO): Windows' taskbar shows 24 pixels times the
// scale (24, 30, 36 and 48 at 100, 125, 150 and 200 %), a title bar 16 times it (16, 20, 24, 32,
// 36 and 40 at 100, 125, 150, 200, 225 and 250 %). An icon of a size the file does not hold is a
// neighbour resized, which blurs it: so it still is at 175 % (the taskbar's 42, the title bar's
// 28) and on the taskbar from 225 % up (54, 60). Each image is drawn from the picture for its size
// (the 16, 32 and 48 pixel ones are the PNG files' bytes), never resized from another. The two
// maskable ones (MASKABLE) are the picture inside the safe zone, a circle of 0.4 of the side, on a
// full background of BACKGROUND; MASKABLE_SCALE is the largest scale, to three decimals, at which
// every pixel of the picture that is not transparent lies inside the circle (checked below). No
// fade: the picture has no tile to hide.
//
// Bolder lines below 24 pixels. Reduced as it is, the cloud's line (LINE, 95 picture pixels) is
// 1.4 pixels wide at 16 and the sign's stroke (STROKE, 76) 1.1: faint and blurred. So for a size
// whose line falls short of LINE_TARGET pixels, or whose stroke falls short of STROKE_TARGET, the
// picture is first made bolder (`bolderBy`): its solid shape (alpha SOLID or more) grown outward
// by the picture pixels that bring the line to its target, each new pixel opaque in the colour of
// the nearest solid one (a chamfer distance, 3 a step straight and 4 diagonal), on a border around
// the picture so that the growth is not cut where the drawing touches the picture's edge (the
// cloud at its top, left and right, the box at its bottom); then the white sign (alpha
// WHITE_ALPHA or more, every channel WHITE_CHANNEL or more) grown inside the box, by at most
// SIGN_MAX; then the reduction; then each pixel's coverage raised by RAISE (one fifth; full pixels
// stay full). That is 16 and 20 pixels: at 24 both reach their targets as drawn. The two widths
// are measured from the picture; test/window/icons.test.ts measures them again and holds these
// numbers to what it finds.
//
// How a size is made. Chromium decodes the picture; the script then averages, for each pixel of
// the icon, the picture's pixels under it, weighted by the area they cover, premultiplied and in
// linear light. That is the box filter at exactly the icon's pixel pitch: nothing aliases (no pixel
// is skipped), nothing rings, and the light of a thin line is kept (a stepwise halving on a canvas
// with Chromium's high-quality smoothing, tried first, left a grey halo on a light background and a
// duller 16 pixel icon).
//
// Chromium is launched by the rules the page suite's test-page/helpers/browser.ts follows (whose
// `browser(t)` needs a test context, so the script launches by itself): headless, with an
// environment of its own (no DISPLAY; HOME, TMPDIR and an empty PATH in a new temporary directory
// that the script removes at its end), so that the user's own profile is never touched and no
// window opens on the desktop; no host name resolves, and every request but the one data: URL the
// page is loaded from is aborted. The picture reaches the page as an argument, not as a request.
// It writes only under this checkout's web/icons/.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'playwright';

/** The picture, relative to the checkout; not under web/ (it is not served and not part of the
 *  build). */
export const SOURCE = 'scripts/icons/skydeck-source.png';
/** The sizes drawn on a transparent background, as PNG files. */
export const SIZES = [16, 32, 48, 192, 512];
/** The sizes of favicon.ico's images: those the taskbar and a title bar show at most display
 *  scales (above), and 64. */
export const IN_ICO = [16, 20, 24, 30, 32, 36, 40, 48, 64];
/** The maskable ones: the picture inside the safe zone, on the full background. */
export const MASKABLE = [192, 512];
/** The share of a transparent file's side left free on each side of the picture's longer side. */
export const MARGIN = 0.02;
/** The maskable icons' background. */
export const BACKGROUND = '#040925';
/** How much of a maskable icon's side the picture's longer side takes (checked below). */
export const MASKABLE_SCALE = 0.786;

/** A pixel of the picture's shape: alpha this or more. */
export const SOLID = 128;
/** A pixel of the white sign: alpha WHITE_ALPHA or more, and every channel WHITE_CHANNEL or
 *  more. */
export const WHITE_ALPHA = 224;
export const WHITE_CHANNEL = 190;
/** The cloud's line, in picture pixels: the mean of its width at its top (93), its left (93) and
 *  its right (99), each the run of solid pixels across it there. */
export const LINE = 95;
/** The sign's stroke, in picture pixels: the underscore's mean height (75 to 76) across the
 *  middle half of it, in white pixels. */
export const STROKE = 76;
/** The widths, in pixels of the file, that the bolder small sizes bring the line and the stroke
 *  to. */
export const LINE_TARGET = 1.9;
export const STROKE_TARGET = 1.6;
/** The sign grows by at most this many picture pixels: its chevron and its underscore are 39.8
 *  apart where they come closest, and grown by the 18 each that STROKE_TARGET asks at 16 pixels
 *  they would be 3.8 apart, a twentieth of a pixel of the file: one mark. */
export const SIGN_MAX = 11;
/** A bolder size's coverage is raised by this factor (at most 255). */
export const RAISE = 1.2;

/** How many picture pixels the shape (`line`) and the sign (`sign`) grow by for a transparent file
 *  of `size`, the picture's longer side being `longer` pixels: what brings the line to LINE_TARGET
 *  and the stroke to STROKE_TARGET pixels, to the nearest whole pixel, never less than none, the
 *  sign at most SIGN_MAX. For the picture (1076 pixels wide): 16 pixels, +19 and +11; 20, +6 and
 *  +7; 24 and up, none. */
export function bolderBy(size: number, longer: number): { line: number; sign: number } {
  const perPixel = longer / ((1 - 2 * MARGIN) * size);
  return {
    line: Math.max(0, Math.round((LINE_TARGET * perPixel - LINE) / 2)),
    sign: Math.max(0, Math.min(SIGN_MAX, Math.round((STROKE_TARGET * perPixel - STROKE) / 2))),
  };
}

/** What the safe zone of a maskable icon is: a circle of this radius, in parts of its side. */
const SAFE_RADIUS = 0.4;

/** What a page under the page suite can reach (test-page/helpers/browser.ts): nothing. */
const ISOLATION = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** One drawing of the picture: `size` pixels, its longer side `scale` of that, centred; on the
 *  background (opaque) or on nothing; its lines grown by `line` and `sign` picture pixels first,
 *  and its coverage raised by RAISE then, when either is more than none. */
interface Job {
  name: string;
  size: number;
  scale: number;
  onBackground: boolean;
  line: number;
  sign: number;
}

function colourOf(hex: string): number[] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (match === null) {
    throw new Error(`${hex} is not a colour of the form #rrggbb`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 16));
}

/**
 * Draws every job in the page: decodes the picture (Chromium), checks that MASKABLE_SCALE keeps
 * it inside the safe zone and that no drawing loses a part of it outside its square, and returns
 * each PNG (Chromium's encoder: IHDR, IDAT and IEND, no metadata) as base64.
 */
async function drawAll(page: Page, picture: Buffer, jobs: Job[]): Promise<Map<string, Buffer>> {
  const drawn = await page.evaluate(
    async ({ picture, jobs, background, safeRadius, maskableScale, solidFrom, white, raise }) => {
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

      /** An image to reduce: its pixel (0, 0) lies at (`origin`, `origin`) in the picture's own
       *  pixels (a grown one has a border around the picture). */
      interface Image {
        width: number;
        height: number;
        pixels: Uint8ClampedArray;
        origin: number;
      }

      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(picture), (c) => c.charCodeAt(0))], { type: 'image/png' }),
      );
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext('2d', { willReadFrequently: true });
      if (context === null) {
        throw new Error('the page has no 2d canvas');
      }
      context.drawImage(bitmap, 0, 0);
      const plain: Image = {
        width: bitmap.width,
        height: bitmap.height,
        pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
        origin: 0,
      };
      const longer = Math.max(plain.width, plain.height);

      // The scale holds: every pixel that is not transparent, its farthest corner, is inside the
      // circle.
      let farthest = 0;
      for (let y = 0; y < plain.height; y++) {
        for (let x = 0; x < plain.width; x++) {
          if ((plain.pixels[(y * plain.width + x) * 4 + 3] ?? 0) > 0) {
            const dx = Math.max(Math.abs(x - plain.width / 2), Math.abs(x + 1 - plain.width / 2));
            const dy = Math.max(Math.abs(y - plain.height / 2), Math.abs(y + 1 - plain.height / 2));
            farthest = Math.max(farthest, Math.hypot(dx, dy));
          }
        }
      }
      if ((maskableScale * farthest) / longer > safeRadius) {
        throw new Error(
          `the picture reaches ${farthest} pixels from its middle: at ${maskableScale} it leaves the circle of ${safeRadius}; the largest scale is ${(safeRadius * longer) / farthest}`,
        );
      }

      // The chamfer distance (3 a step straight, 4 diagonal) of every pixel to the nearest pixel
      // of `mask`, and which pixel that is: two passes.
      const chamfer = (
        mask: Uint8Array,
        width: number,
        height: number,
      ): { d: Int32Array; from: Int32Array } => {
        const d = new Int32Array(width * height).fill(1 << 28);
        const from = new Int32Array(width * height).fill(-1);
        mask.forEach((on, p) => {
          if (on === 1) {
            d[p] = 0;
            from[p] = p;
          }
        });
        const relax = (p: number, q: number, w: number): void => {
          if ((d[q] ?? 0) + w < (d[p] ?? 0)) {
            d[p] = (d[q] ?? 0) + w;
            from[p] = from[q] ?? -1;
          }
        };
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (x > 0) relax(p, p - 1, 3);
            if (y > 0) relax(p, p - width, 3);
            if (x > 0 && y > 0) relax(p, p - width - 1, 4);
            if (x < width - 1 && y > 0) relax(p, p - width + 1, 4);
          }
        }
        for (let y = height - 1; y >= 0; y--) {
          for (let x = width - 1; x >= 0; x--) {
            const p = y * width + x;
            if (x < width - 1) relax(p, p + 1, 3);
            if (y < height - 1) relax(p, p + width, 3);
            if (x < width - 1 && y < height - 1) relax(p, p + width + 1, 4);
            if (x > 0 && y < height - 1) relax(p, p + width - 1, 4);
          }
        }
        return { d, from };
      };

      // The picture with bolder lines: on a border of `line` pixels around it, every pixel that
      // is not solid within `line` pixels of a solid one becomes opaque in that one's colour;
      // then every solid pixel that is not white within `sign` pixels of a white one, white.
      const thicken = (line: number, sign: number): Image => {
        const width = plain.width + 2 * line;
        const height = plain.height + 2 * line;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < plain.height; y++) {
          pixels.set(
            plain.pixels.subarray(y * plain.width * 4, (y + 1) * plain.width * 4),
            ((y + line) * width + line) * 4,
          );
        }
        const solid = new Uint8Array(width * height);
        const whites = new Uint8Array(width * height);
        for (let p = 0; p < width * height; p++) {
          const a = pixels[p * 4 + 3] ?? 0;
          solid[p] = a >= solidFrom ? 1 : 0;
          whites[p] =
            a >= white.alpha &&
            Math.min(pixels[p * 4] ?? 0, pixels[p * 4 + 1] ?? 0, pixels[p * 4 + 2] ?? 0) >=
              white.channel
              ? 1
              : 0;
        }
        if (line > 0) {
          const { d, from } = chamfer(solid, width, height);
          for (let p = 0; p < width * height; p++) {
            if (solid[p] === 0 && (d[p] ?? 0) <= 3 * line) {
              const q = (from[p] ?? 0) * 4;
              pixels.set([pixels[q] ?? 0, pixels[q + 1] ?? 0, pixels[q + 2] ?? 0, 255], p * 4);
            }
          }
        }
        if (sign > 0) {
          const { d } = chamfer(whites, width, height);
          for (let p = 0; p < width * height; p++) {
            if (solid[p] === 1 && whites[p] === 0 && (d[p] ?? 0) <= 3 * sign) {
              pixels.set([255, 255, 255, 255], p * 4);
            }
          }
        }
        return { width, height, pixels, origin: -line };
      };

      // An image's pixels as premultiplied linear light, 4 floats a pixel.
      const premultiply = ({ width, height, pixels }: Image): Float32Array => {
        const out = new Float32Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const a = (pixels[i * 4 + 3] ?? 0) / 255;
          for (let c = 0; c < 3; c++) {
            out[i * 4 + c] = (lut[pixels[i * 4 + c] ?? 0] ?? 0) * a;
          }
          out[i * 4 + 3] = a;
        }
        return out;
      };

      // The image's pixels that the output pixel `t` (one axis) covers, with their weights: pixel
      // `i` lies from `offset + i * k` to `offset + (i + 1) * k`.
      const axis = (t: number, count: number, k: number, offset: number): [number, number[]] => {
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

      const backgroundLinear = background.map((value) => lut[value] ?? 0);
      const sources = new Map<string, { image: Image; linear: Float32Array }>();
      const out: Record<string, string> = {};
      for (const job of jobs) {
        const { size } = job;
        const key = `${job.line} ${job.sign}`;
        let source = sources.get(key);
        if (source === undefined) {
          const image = job.line > 0 || job.sign > 0 ? thicken(job.line, job.sign) : plain;
          source = { image, linear: premultiply(image) };
          sources.set(key, source);
        }
        const { image, linear } = source;
        const k = (job.scale * size) / longer;
        const offsetX = (size - k * plain.width) / 2 + image.origin * k;
        const offsetY = (size - k * plain.height) / 2 + image.origin * k;
        // Nothing of the image that is not transparent falls outside the square.
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            if (
              (image.pixels[(y * image.width + x) * 4 + 3] ?? 0) > 0 &&
              (offsetX + x * k < 0 ||
                offsetY + y * k < 0 ||
                offsetX + (x + 1) * k > size ||
                offsetY + (y + 1) * k > size)
            ) {
              throw new Error(`${job.name}: the picture's pixel ${x},${y} is outside its square`);
            }
          }
        }
        const columns = Array.from({ length: size }, (_, t) => axis(t, image.width, k, offsetX));
        const rows = Array.from({ length: size }, (_, t) => axis(t, image.height, k, offsetY));
        const bolder = job.line > 0 || job.sign > 0;
        const rgba = new Uint8ClampedArray(size * size * 4);
        for (let ty = 0; ty < size; ty++) {
          const [y0, wy] = rows[ty] ?? [0, []];
          for (let tx = 0; tx < size; tx++) {
            const [x0, wx] = columns[tx] ?? [0, []];
            const sum = [0, 0, 0, 0];
            wy.forEach((weightY, j) => {
              wx.forEach((weightX, i) => {
                const from = ((y0 + j) * image.width + x0 + i) * 4;
                const weight = weightX * weightY;
                for (let c = 0; c < 4; c++) {
                  sum[c] = (sum[c] ?? 0) + weight * (linear[from + c] ?? 0);
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
              const a = Math.round(covered * 255);
              rgba[o + 3] = bolder ? Math.min(255, Math.round(a * raise)) : a;
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
      picture: picture.toString('base64'),
      jobs,
      background: colourOf(BACKGROUND),
      safeRadius: SAFE_RADIUS,
      maskableScale: MASKABLE_SCALE,
      solidFrom: SOLID,
      white: { alpha: WHITE_ALPHA, channel: WHITE_CHANNEL },
      raise: RAISE,
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

/** The PNG file of a transparent drawing of `size`, or the name of one only favicon.ico holds. */
const nameOf = (size: number): string =>
  SIZES.includes(size) ? `icon-${size}.png` : `favicon-${size}`;

async function main(): Promise<void> {
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  const icons = join(checkout, 'web/icons/');
  mkdirSync(icons, { recursive: true });
  const picture = readFileSync(join(checkout, SOURCE));
  // The picture's size, from its IHDR (the first chunk, at byte 8: its width at 16, its height at
  // 20); Chromium decodes the rest.
  const longer = Math.max(picture.readUInt32BE(16), picture.readUInt32BE(20));

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
      const transparent = [...new Set([...SIZES, ...IN_ICO])].sort((a, b) => a - b);
      const jobs: Job[] = [
        ...transparent.map((size) => ({
          name: nameOf(size),
          size,
          scale: 1 - 2 * MARGIN,
          onBackground: false,
          ...bolderBy(size, longer),
        })),
        ...MASKABLE.map((size) => ({
          name: `icon-${size}-maskable.png`,
          size,
          scale: MASKABLE_SCALE,
          onBackground: true,
          line: 0,
          sign: 0,
        })),
      ];
      const drawn = await drawAll(page, picture, jobs);
      const images = IN_ICO.map((size) => {
        const png = drawn.get(nameOf(size));
        if (png === undefined) {
          throw new Error(`favicon.ico needs the drawing of ${size} pixels`);
        }
        return { size, png };
      });
      const written = new Map([...drawn].filter(([name]) => name.endsWith('.png')));
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
