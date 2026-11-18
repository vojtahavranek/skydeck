// The page's own icon (S2 12.12; plan E14, task 94; follow-ups F10, F12 and F14): the owner's two
// pictures scripts/icons/skydeck-source.png and scripts/icons/skydeck-source-small.png, the
// committed files of web/icons/ and web/manifest.webmanifest, read from the checkout.
// scripts/icons.ts drew the PNG and ICO files from the pictures once; no test runs it, so these
// cases hold what it wrote, and (by reducing the pictures again in plain Node) that the files are
// the pictures'.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import * as prettier from 'prettier';

import {
  BACKGROUND as SCRIPT_BACKGROUND,
  CORNER_RADIUS as SCRIPT_CORNER_RADIUS,
  DRAWING_BOX as SCRIPT_DRAWING_BOX,
  DRAWING_MARGIN as SCRIPT_DRAWING_MARGIN,
  FADE_FROM as SCRIPT_FADE_FROM,
  FADE_TO as SCRIPT_FADE_TO,
  IN_ICO as SCRIPT_IN_ICO,
  MASKABLE as SCRIPT_MASKABLE,
  MASKABLE_SCALE,
  SIZES as SCRIPT_SIZES,
  SMALL as SCRIPT_SMALL,
  SOURCE,
  SOURCE_SMALL,
  TILE_NAVY as SCRIPT_TILE_NAVY,
} from '../../scripts/icons.ts';
import { readBuild } from '../../src/window/build.ts';
import { testPlatform } from '../helpers/platform.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const read = (path: string): Buffer => readFileSync(join(checkout, path));

const ICONS = 'web/icons';
/** The five drawn on a transparent background, and the two maskable ones on a full one. */
const TRANSPARENT = [16, 32, 48, 192, 512].map((size) => ({ file: `icon-${size}.png`, size }));
const MASKABLE = [192, 512].map((size) => ({ file: `icon-${size}-maskable.png`, size }));
const PNGS = [...TRANSPARENT, ...MASKABLE];
const IN_ICO = [16, 32, 48];
/** The sizes drawn from the small picture; every other file is drawn from the large one. */
const SMALL_SIZES = [16, 32, 48];

/** The owner's pictures, as received: where each lives, its size in bytes and its sha256. The
 *  large one is drawn into the 192 and 512 pixel files and the maskable ones; the small one, a
 *  simpler drawing of the same, into the 16, 32 and 48 pixel files and favicon.ico. */
const PICTURES = {
  large: {
    path: 'scripts/icons/skydeck-source.png',
    bytes: 1_691_903,
    sha256: 'fe94068db275c4d89b8e612ab2b9081fba7a571c6233ade6cf012af6a8dce12f',
  },
  small: {
    path: 'scripts/icons/skydeck-source-small.png',
    bytes: 1_372_751,
    sha256: '1f230e8060d7ba3fc33911dfc71104d47f92a9e18250cadcef10a22baaa62974',
  },
} as const;
type Which = keyof typeof PICTURES;
const WHICH: Which[] = ['large', 'small'];
const MASTER_SIZE = 1254;

/** The maskable icons' full background: the large picture's tile around the ring where it is
 *  faded out (`#040925`). */
const BACKGROUND = [4, 9, 37];
/** In a maskable icon the large picture is drawn in full within FADE_FROM pixels of its middle (of
 *  1254), fades out to the background over the next ring, and is not drawn beyond FADE_TO: the
 *  drawing reaches 540.8 pixels, the tile's own edge (a lighter hairline, a shade) starts 594 out. */
const FADE_FROM = 555;
const FADE_TO = 585;
/** The tile is at alpha 252 to 254 of 255 (the pictures' own, kept): "opaque" is from here up. */
const OPAQUE = 250;
/** The drawing is what differs from the background by more than this (of 255) in some channel,
 *  composited on it. */
const DRAWN = 40;
/** The safe zone of a maskable icon: a circle of this radius, in parts of the icon's width. */
const SAFE_RADIUS = 0.4;
/** The largest step between neighbouring pixels of a maskable file anywhere outside the drawing. */
const GLOBAL_STEP = 2;

/** A box of a picture's pixels, both ends included. */
interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * What the three small files show of the small picture (follow-ups F12 and F14: on a taskbar that
 * is dark the navy tile is nearly invisible, so the drawing has to fill the tile; and the owner
 * wants their one picture at every size). Each of them, 16, 32 and 48 pixels alike, is the same
 * square crop of the picture: centred on the drawing's box (the cloud with the window in front of
 * it, measured from the picture by `drawingBoxOf` below) and as wide as the box plus
 * DRAWING_MARGIN of it on each side, on the tile's navy, with rounded corners.
 */
const DRAWING_BOX: Box = { minX: 115, maxX: 1115, minY: 202, maxY: 1045 };
const DRAWING_MARGIN = 0.02;
/** The terminal window's box, measured from the picture by `windowBoxOf` below. No file is cropped
 *  to it (F12's 16 pixel file was; F14 drew that file from the drawing's crop again): the 16 pixel
 *  case finds by it where the crop puts the window, and the cloud above it. */
const WINDOW_BOX: Box = { minX: 306, maxX: 941, minY: 546, maxY: 1045 };
/** The tile's navy: the mean colour of the picture's pixels in a zone of the tile with nothing
 *  drawn in it (x 50 to 99, y 300 to 899), rounded. */
const NAVY = [1, 6, 43];
/** The tile's corner radius, in parts of its shorter side (1200 pixels): a circle fitted to its
 *  alpha edge is 273 pixels. The crop's rounded corners have the same relative radius. */
const CORNER = 273 / 1200;
/** The lowest alpha on the middle half of each side of a small file: a picture pixel on the crop's
 *  straight edge counts in the mask's coverage and again in the area average, so the outer rows and
 *  columns are 252 to 255 (the corners are transparent). */
const SIDE_OPAQUE = 252;
/** A pixel counts as the picture's drawing when it differs from the tile's navy by more than
 *  this (of 255) in some channel. */
const DRAWN_ON_NAVY = 40;
/** The tile's own soft edge is skipped when the picture is measured: this many pixels in. */
const TILE_INSET = 60;

/** The sha256 of the six files that follow-up F14 leaves as they were on main (65f4f15): the 32
 *  and 48 pixel files as F12 drew them, and the four large ones, as they were before F12 too. */
const KEPT_FILES = {
  'icon-32.png': '0b35b2cc74254b745362ad60fdc7844e0bc982718d98c1499da724fcacb6ef56',
  'icon-48.png': '53cc5b02f0dddbf60d211ad188f6803c1f9882c9e1871a6e1f111b690a0d289c',
  'icon-192.png': '9f3e27d105c2bab7c6330a8e18f6b920a450f81e58635968e4ac4d9c8520d34b',
  'icon-512.png': '7c7e0e9603dc7a9ef19f33cf9f6de834858c39ed070f6e090da39045f76212b1',
  'icon-192-maskable.png': '78df00e62defabd7f4712c913ad271a6db675c7bb02178898a1dab519d44531a',
  'icon-512-maskable.png': 'd10ada442eaf1eaf4d3a02373895c0b2ef411c1027b66876c26773400bade98a',
} as const;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Png {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  /** Row by row, 4 bytes (RGBA) or 3 (RGB) per pixel, the filters undone. */
  pixels: Buffer;
  channels: number;
  /** The chunk types in file order. */
  chunks: string[];
}

/** The only chunks the drawn files may hold: no metadata (a text chunk could carry a name or a
 *  path of the machine that drew them, in a file the server serves). */
const CHUNKS = ['IHDR', 'IDAT', 'IEND'];
/** The picture's: the same and `caBX`, the content credentials of the image service that made it. */
const MASTER_CHUNKS = ['IHDR', 'caBX', 'IDAT', 'IEND'];

/**
 * Just enough of PNG to look at the pixels: 8-bit RGB or RGBA, not interlaced, IHDR first, only
 * the chunks of `allowed`, and nothing after IEND.
 */
function decodePng(bytes: Buffer, allowed: readonly string[] = CHUNKS): Png {
  assert.deepEqual(bytes.subarray(0, 8), SIGNATURE, 'the PNG signature');
  let at = 8;
  let header: Buffer | null = null;
  const data: Buffer[] = [];
  const chunks: string[] = [];
  let ended = false;
  while (!ended) {
    assert.ok(at + 12 <= bytes.length, 'the file ends before IEND');
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    assert.ok(allowed.includes(type), `a chunk ${JSON.stringify(type)}`);
    chunks.push(type);
    if (header === null) {
      assert.equal(type, 'IHDR', 'IHDR comes first');
    }
    if (type === 'IHDR') {
      header = body;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      ended = true;
    }
    at += 12 + length;
  }
  assert.ok(header !== null, 'IHDR');
  assert.equal(at, bytes.length, 'nothing after IEND');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header.readUInt8(8);
  const colourType = header.readUInt8(9);
  assert.equal(header.readUInt8(12), 0, 'not interlaced');
  assert.equal(bitDepth, 8, '8 bits per channel');
  assert.ok(colourType === 6 || colourType === 2, `colour type ${colourType}`);
  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  assert.equal(raw.length, height * (stride + 1), 'the image data has every row');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          assert.fail(`filter ${filter} in row ${y}`);
      }
      pixels[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, bitDepth, colourType, pixels, channels, chunks };
}

/** The alpha of a pixel: 255 for an image without alpha. */
function alpha(png: Png, x: number, y: number): number {
  return png.channels === 4 ? (png.pixels[(y * png.width + x) * 4 + 3] ?? -1) : 255;
}

/** The colour of a pixel, without its alpha. */
function rgb(png: Png, x: number, y: number): number[] {
  const at = (y * png.width + x) * png.channels;
  return [...png.pixels.subarray(at, at + 3)];
}

function corners(png: Png): number[] {
  const last = png.width - 1;
  return [alpha(png, 0, 0), alpha(png, last, 0), alpha(png, 0, last), alpha(png, last, last)];
}

function cornerColours(png: Png): number[][] {
  const last = png.width - 1;
  return [rgb(png, 0, 0), rgb(png, last, 0), rgb(png, 0, last), rgb(png, last, last)];
}

/** A picture, decoded once: its pixels are what the measurements and the re-drawing read. */
const decoded = new Map<Which, Png>();
function picture(which: Which): Png {
  let png = decoded.get(which);
  if (png === undefined) {
    png = decodePng(read(PICTURES[which].path), MASTER_CHUNKS);
    decoded.set(which, png);
  }
  return png;
}

/** The box of a picture's opaque pixels (alpha 250 or more): its tile, without the transparent
 *  margin the picture has around it and without the tile's soft edge. */
function tileBox(png: Png): { minX: number; maxX: number; minY: number; maxY: number } {
  const box = { minX: png.width, maxX: -1, minY: png.height, maxY: -1 };
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (alpha(png, x, y) >= OPAQUE) {
        box.minX = Math.min(box.minX, x);
        box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y);
        box.maxY = Math.max(box.maxY, y);
      }
    }
  }
  return box;
}

const navies = new WeakMap<Png, number[]>();
/** The mean colour of the small picture's tile in a zone with nothing drawn in it, rounded. */
function navyOf(png: Png): number[] {
  let navy = navies.get(png);
  if (navy === undefined) {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 300; y < 900; y++) {
      for (let x = 50; x < 100; x++) {
        rgb(png, x, y).forEach((value, c) => {
          sum[c] = (sum[c] ?? 0) + value;
        });
        n++;
      }
    }
    navy = sum.map((value) => Math.round(value / n));
    navies.set(png, navy);
  }
  return navy;
}

/** Whether a pixel is drawn on the tile: opaque, and more than DRAWN_ON_NAVY from the navy (the
 *  picture's own, measured, or NAVY for a file). */
function drawnOnNavy(png: Png, x: number, y: number, navy: number[] = navyOf(png)): boolean {
  return (
    alpha(png, x, y) >= OPAQUE &&
    rgb(png, x, y).some((value, c) => Math.abs(value - (navy[c] ?? 0)) > DRAWN_ON_NAVY)
  );
}

/** The box of the small picture's drawing (the cloud and the window): what is drawn on the navy
 *  at least TILE_INSET pixels inside the tile's box. */
function drawingBoxOf(png: Png): Box {
  const tile = tileBox(png);
  const box = { minX: png.width, maxX: -1, minY: png.height, maxY: -1 };
  for (let y = tile.minY + TILE_INSET; y <= tile.maxY - TILE_INSET; y++) {
    for (let x = tile.minX + TILE_INSET; x <= tile.maxX - TILE_INSET; x++) {
      if (drawnOnNavy(png, x, y)) {
        box.minX = Math.min(box.minX, x);
        box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y);
        box.maxY = Math.max(box.maxY, y);
      }
    }
  }
  return box;
}

/** The runs, as [first, last], of the positions `0..length-1` where `on` holds. */
function runsOf(on: (t: number) => boolean, length: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let t = 0; t <= length; t++) {
    const here = t < length && on(t);
    if (here && start < 0) {
      start = t;
    } else if (!here && start >= 0) {
      runs.push([start, t - 1]);
      start = -1;
    }
  }
  return runs;
}

/**
 * The box of the terminal window in the small picture, from the runs of drawn pixels along
 * probes that cross its frame: the column x = 620 gives the top (the first run that starts
 * between y = 480 and 600, below the cloud's top) and the bottom (the end of the last run); the
 * rows y = 700, 710, ... 740 give the left (the run that holds x = 330) and the right (the run
 * that holds x = 915).
 */
function windowBoxOf(png: Png): Box {
  const column = runsOf((y) => drawnOnNavy(png, 620, y), png.height);
  const top = column.find(([start]) => start > 480 && start < 600);
  const bottom = column.at(-1);
  assert.ok(top !== undefined && bottom !== undefined, 'the window is found on the column 620');
  let minX = png.width;
  let maxX = -1;
  for (const y of [700, 710, 720, 730, 740]) {
    const row = runsOf((x) => drawnOnNavy(png, x, y), png.width);
    const left = row.find(([start, end]) => start <= 330 && end >= 330);
    const right = row.find(([start, end]) => start <= 915 && end >= 915);
    assert.ok(left !== undefined && right !== undefined, `the window's frame is found in row ${y}`);
    minX = Math.min(minX, left[0]);
    maxX = Math.max(maxX, right[1]);
  }
  return { minX, maxX, minY: top[0], maxY: bottom[1] };
}

/**
 * The radius, to a whole pixel from `from` to `to`, of the circle that a rounded corner's edge
 * follows best (least squares). `edge` holds, for each row down from the corner's top, the
 * row's middle (its distance from the top) and how far the edge is from the straight side there.
 */
function fitRadius(
  edge: ReadonlyArray<[number, number]>,
  from: number,
  to: number,
): { radius: number; rms: number } {
  let best = { radius: from, rms: Number.POSITIVE_INFINITY };
  for (let radius = from; radius <= to; radius++) {
    let sum = 0;
    for (const [y, offset] of edge) {
      const model = y >= radius ? 0 : radius - Math.sqrt(radius * radius - (radius - y) ** 2);
      sum += (model - offset) ** 2;
    }
    const rms = Math.sqrt(sum / edge.length);
    if (rms < best.rms) {
      best = { radius, rms };
    }
  }
  return best;
}

/** The corner radius of the small picture's tile (alpha 250 or more), top left. */
function tileRadiusOf(png: Png): { radius: number; rms: number } {
  const tile = tileBox(png);
  const edge: Array<[number, number]> = [];
  for (let y = tile.minY; y < tile.minY + 400; y++) {
    let x = 0;
    while (alpha(png, x, y) < OPAQUE) {
      x++;
    }
    edge.push([y - tile.minY + 0.5, x - tile.minX]);
  }
  return fitRadius(edge, 100, 400);
}

/** The distance, negative inside, from the point (px, py) to the outline of the rounded
 *  rectangle of half sides `halfW` and `halfH` and corner radius `radius`, centred on the origin. */
function outsideRounded(
  px: number,
  py: number,
  halfW: number,
  halfH: number,
  radius: number,
): number {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The crop of the small picture that the three small files show, in its pixels: a square, as wide
 *  as the drawing's box plus DRAWING_MARGIN of it each side, centred on the box. */
function cropOf(): { x: number; y: number; side: number } {
  const box = DRAWING_BOX;
  const side = (box.maxX - box.minX + 1) * (1 + 2 * DRAWING_MARGIN);
  return {
    x: (box.minX + box.maxX + 1) / 2 - side / 2,
    y: (box.minY + box.maxY + 1) / 2 - side / 2,
    side,
  };
}

/** How much of the large picture's pixel `r` pixels from its middle a maskable icon draws. */
function weight(r: number): number {
  return r <= FADE_FROM ? 1 : r >= FADE_TO ? 0 : (FADE_TO - r) / (FADE_TO - FADE_FROM);
}

/** The average colour, per channel, of the opaque pixels of a picture between FADE_FROM and
 *  FADE_TO pixels from its middle: where the tile meets the background in a maskable icon. */
function ringColour(png: Png): number[] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const r = Math.hypot(x + 0.5 - png.width / 2, y + 0.5 - png.height / 2);
      if (r >= FADE_FROM && r <= FADE_TO && alpha(png, x, y) >= OPAQUE) {
        rgb(png, x, y).forEach((value, c) => {
          sum[c] = (sum[c] ?? 0) + value;
        });
        n++;
      }
    }
  }
  assert.ok(n > 1000, 'the ring is on the tile');
  return sum.map((value) => value / n);
}

/** How far from the centre the drawing reaches, in pixels: the farthest pixel centre whose colour,
 *  composited on BACKGROUND, differs from it by more than DRAWN in some channel. */
function farthestDrawn(png: Png): number {
  let farthest = 0;
  const centre = png.width / 2;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const at = (y * png.width + x) * png.channels;
      const a = (png.channels === 4 ? (png.pixels[at + 3] ?? 0) : 255) / 255;
      let differs = false;
      for (let c = 0; c < 3; c++) {
        // The colour composited on the background, less the background: alpha times the difference.
        if (Math.abs(a * ((png.pixels[at + c] ?? 0) - (BACKGROUND[c] ?? 0))) > DRAWN) {
          differs = true;
        }
      }
      if (differs) {
        farthest = Math.max(farthest, Math.hypot(x + 0.5 - centre, y + 0.5 - centre));
      }
    }
  }
  return farthest;
}

/** sRGB bytes to linear light, and back. */
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const encode = (v: number): number =>
  Math.min(
    255,
    Math.max(0, Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055))),
  );

const premultiplied = new Map<string, Float32Array>();
/** The large picture's pixels as premultiplied linear light, 4 floats each (r, g, b, alpha);
 *  `faded`, as a maskable icon draws it (each pixel times `weight` of its distance from the
 *  middle). */
function linearPicture(faded: boolean): Float32Array {
  const key = faded ? 'large faded' : 'large';
  let out = premultiplied.get(key);
  if (out === undefined) {
    const png = picture('large');
    out = new Float32Array(png.width * png.height * 4);
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = y * png.width + x;
        const w = faded ? weight(Math.hypot(x + 0.5 - png.width / 2, y + 0.5 - png.height / 2)) : 1;
        const a = ((png.pixels[i * 4 + 3] ?? 0) / 255) * w;
        for (let c = 0; c < 3; c++) {
          out[i * 4 + c] = (LINEAR[png.pixels[i * 4 + c] ?? 0] ?? 0) * a;
        }
        out[i * 4 + 3] = a;
      }
    }
    premultiplied.set(key, out);
  }
  return out;
}

/**
 * What a small file shows of the small picture, as premultiplied linear light, 4 floats a pixel:
 * the picture on the tile's navy (every pixel of the picture, solid or not, is the picture's own
 * colour where the tile is opaque and NAVY elsewhere) under the rounded square of the crop: alpha
 * is the square's coverage of the pixel (1 inside, 0 outside, a ramp of one pixel across the edge,
 * from the distance of the pixel's middle to the rounded outline), and the colour is multiplied by
 * it.
 */
function smallSource(): Float32Array {
  const key = 'small';
  let out = premultiplied.get(key);
  if (out === undefined) {
    const png = picture('small');
    const crop = cropOf();
    out = new Float32Array(png.width * png.height * 4);
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = y * png.width + x;
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
                CORNER * crop.side,
              ),
          ),
        );
        const solid = alpha(png, x, y) >= OPAQUE;
        for (let c = 0; c < 3; c++) {
          const value = solid ? (png.pixels[i * 4 + c] ?? 0) : (NAVY[c] ?? 0);
          out[i * 4 + c] = (LINEAR[value] ?? 0) * coverage;
        }
        out[i * 4 + 3] = coverage;
      }
    }
    premultiplied.set(key, out);
  }
  return out;
}

/** The picture's pixels that the output pixel `t` (one axis) covers, with their weights. */
function axis(t: number, count: number, inner: number, offset: number): [number, number[]] {
  const k = inner / count;
  const first = Math.max(0, Math.floor((t - offset) / k));
  const last = Math.min(count - 1, Math.ceil((t + 1 - offset) / k) - 1);
  const weights: number[] = [];
  for (let i = first; i <= last; i++) {
    weights.push(Math.max(0, Math.min(t + 1, offset + (i + 1) * k) - Math.max(t, offset + i * k)));
  }
  return [first, weights];
}

/**
 * A picture reduced to `size * scale` pixels in the middle of a box of `size`, in plain Node: each
 * pixel of the box is the average of the picture's pixels under it, weighted by the area they
 * cover, premultiplied and in linear light; what the picture does not cover is transparent, or,
 * with `maskable`, BACKGROUND (opaque; the picture faded out as a maskable icon draws it). Straight
 * RGBA, 8 bits. This is what scripts/icons.ts does in Chromium, written again here so that the
 * committed files can be compared to it. The small picture is not drawn whole: its crop
 * (`cropOf`, `smallSource`) is scaled to the icon (`scale` is for the others).
 */
function reduced(size: number, scale: number, which: Which, maskable: boolean): Uint8Array {
  const count = picture(which).width;
  let source: Float32Array;
  let inner = size * scale;
  let offsetX = (size - inner) / 2;
  let offsetY = offsetX;
  if (which === 'small') {
    const crop = cropOf();
    source = smallSource();
    inner = (size * count) / crop.side;
    offsetX = (-crop.x * size) / crop.side;
    offsetY = (-crop.y * size) / crop.side;
  } else {
    source = linearPicture(maskable);
  }
  const columns = Array.from({ length: size }, (_, t) => axis(t, count, inner, offsetX));
  const rows = Array.from({ length: size }, (_, t) => axis(t, count, inner, offsetY));
  const out = new Uint8Array(size * size * 4);
  for (let ty = 0; ty < size; ty++) {
    const [y0, wy] = rows[ty] ?? [0, []];
    for (let tx = 0; tx < size; tx++) {
      const [x0, wx] = columns[tx] ?? [0, []];
      const sum = [0, 0, 0, 0];
      wy.forEach((weightY, j) => {
        wx.forEach((weightX, i) => {
          const at = ((y0 + j) * count + x0 + i) * 4;
          const w = weightX * weightY;
          for (let c = 0; c < 4; c++) {
            sum[c] = (sum[c] ?? 0) + w * (source[at + c] ?? 0);
          }
        });
      });
      const o = (ty * size + tx) * 4;
      const covered = sum[3] ?? 0;
      if (maskable) {
        for (let c = 0; c < 3; c++) {
          out[o + c] = encode((sum[c] ?? 0) + (1 - covered) * (LINEAR[BACKGROUND[c] ?? 0] ?? 0));
        }
        out[o + 3] = 255;
      } else if (covered > 0) {
        for (let c = 0; c < 3; c++) {
          out[o + c] = encode((sum[c] ?? 0) / covered);
        }
        out[o + 3] = Math.round(covered * 255);
      }
    }
  }
  return out;
}

/** The picture a file is drawn from: the small one for the 16, 32 and 48 pixel files. */
const sourceOf = (file: string, size: number): Which =>
  !file.includes('maskable') && SMALL_SIZES.includes(size) ? 'small' : 'large';

/** How many pixels of a file are white: opaque, and each channel 200 or more. */
function whites(png: Png): number {
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (alpha(png, x, y) >= OPAQUE && rgb(png, x, y).every((value) => value >= 200)) {
        n++;
      }
    }
  }
  return n;
}

/** The number of white pixels (see `whites`) the 16 pixel file has at least: what its build has. */
const MIN_WHITE_16 = 10;
/** The number of pixels of the cloud's blue to violet (see `cloudHue`) above the window's top edge
 *  that the 16 pixel file has at least: what its build has. */
const MIN_CLOUD_16 = 28;

/**
 * Whether a pixel of a file is of the cloud's blue to violet: at least a quarter opaque (the
 * pixels at the crop's rounded corners are partly transparent), its blue its strongest channel,
 * 128 or more, and at least 60 above the weaker of its red and green: not the navy, the white of
 * the `>_` or a grey. The window's frame has the same colours.
 */
function cloudHue(png: Png, x: number, y: number): boolean {
  const [r = 0, g = 0, b = 0] = rgb(png, x, y);
  return alpha(png, x, y) >= 64 && b >= 128 && b >= Math.max(r, g) && b - Math.min(r, g) >= 60;
}

/** Where the crop puts the terminal window in a small file of `size` pixels: its left and right
 *  sides and its top edge, in the file's pixels (not whole numbers). */
function windowInFile(size: number): { left: number; right: number; top: number } {
  const crop = cropOf();
  const scale = size / crop.side;
  return {
    left: (WINDOW_BOX.minX - crop.x) * scale,
    right: (WINDOW_BOX.maxX + 1 - crop.x) * scale,
    top: (WINDOW_BOX.minY - crop.y) * scale,
  };
}

for (const which of WHICH) {
  describe(`the ${which} picture, ${PICTURES[which].path}`, () => {
    test("is the owner's file, byte for byte: its size and sha256", () => {
      const bytes = read(PICTURES[which].path);

      assert.equal(bytes.length, PICTURES[which].bytes);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        PICTURES[which].sha256,
        "the picture changed: it is the owner's file, kept as it is; a new one needs a new run of scripts/icons.ts and new numbers here",
      );
    });

    test('is square, 8-bit RGBA, with the chunks IHDR, caBX, IDAT and IEND and nothing else', () => {
      const png = picture(which);

      assert.equal(png.width, MASTER_SIZE);
      assert.equal(png.height, MASTER_SIZE);
      assert.equal(png.colourType, 6);
      assert.deepEqual(png.chunks, MASTER_CHUNKS);
    });

    test('is transparent outside its rounded tile and opaque in its middle', () => {
      const png = picture(which);

      assert.deepEqual(corners(png), [0, 0, 0, 0]);
      assert.ok(alpha(png, MASTER_SIZE >> 1, MASTER_SIZE >> 1) >= OPAQUE);
    });

    test('is not under web/: the server does not serve it', (t) => {
      const { platform } = testPlatform(t);
      const built = [...readBuild(platform.files, checkout).files.keys()];

      assert.equal(existsSync(join(checkout, ICONS, basename(PICTURES[which].path))), false);
      assert.deepEqual(
        built.filter((path) => path.endsWith(basename(PICTURES[which].path))),
        [],
        'the build does not hold it',
      );
    });
  });
}

describe('the large picture, as the maskable icons use it', () => {
  test('the SVG it replaced is gone, and the build holds no drawing', (t) => {
    const { platform } = testPlatform(t);

    assert.equal(existsSync(join(checkout, 'web/icons/skydeck.svg')), false);
    assert.deepEqual(
      [...readBuild(platform.files, checkout).files.keys()].filter((path) => path.endsWith('.svg')),
      [],
    );
  });

  test("the background is the tile's colour around the ring where the picture fades out", () => {
    const hex = `#${BACKGROUND.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

    assert.equal(SCRIPT_BACKGROUND, hex);
    assert.equal(SCRIPT_FADE_FROM, FADE_FROM);
    assert.equal(SCRIPT_FADE_TO, FADE_TO);
    // The average over the ring is within one step of the colour chosen (whole numbers).
    ringColour(picture('large')).forEach((value, c) => {
      assert.ok(Math.abs(value - (BACKGROUND[c] ?? 0)) <= 1, `channel ${c}: ${value}`);
    });
  });

  test('MASKABLE_SCALE is the largest scale, to three decimals, that keeps the drawing inside the circle', () => {
    const png = picture('large');
    const farthest = farthestDrawn(png);
    const bound = SAFE_RADIUS * png.width;

    assert.ok(farthest > 0.3 * png.width, `the drawing is found (it reaches ${farthest} pixels)`);
    assert.ok(farthest < FADE_FROM, `the fade starts at ${FADE_FROM}, inside the drawing`);
    assert.ok(
      MASKABLE_SCALE * farthest <= bound,
      `the drawing reaches ${farthest} of ${png.width / 2} pixels: at ${MASKABLE_SCALE} it is out`,
    );
    assert.ok(
      (MASKABLE_SCALE + 0.001) * farthest > bound,
      `${MASKABLE_SCALE + 0.001} would still hold: the scale is not the largest`,
    );
  });
});

describe('the small picture, as the three small files use it', () => {
  test("the tile's navy and the drawing's box are measured from the picture: the numbers the crop is made from; and the window's box, by which the 16 pixel case finds the window", () => {
    // A pixel is "drawn" when it is opaque and more than DRAWN_ON_NAVY (40 of 255) from the navy in
    // some channel; the drawing's box is what is drawn at least TILE_INSET (60) pixels inside the
    // tile's box, the window's is read along the probes of `windowBoxOf`.
    const png = picture('small');

    assert.deepEqual(tileBox(png), { minX: 18, maxX: 1232, minY: 29, maxY: 1228 });
    assert.deepEqual(navyOf(png), NAVY);
    assert.deepEqual(drawingBoxOf(png), DRAWING_BOX);
    assert.deepEqual(windowBoxOf(png), WINDOW_BOX);
  });

  test("the crop: the drawing's width plus 2 % each side, centred on the drawing", () => {
    const crop = cropOf();

    assert.ok(Math.abs(crop.side - 1001 * 1.04) < 1e-9, `${crop.side}`);
    assert.ok(Math.abs(crop.x + crop.side / 2 - 615.5) < 1e-9);
    assert.ok(Math.abs(crop.y + crop.side / 2 - 624) < 1e-9);
    // It lies inside the tile, so that the picture's own soft edge is never in a small file.
    const tile = tileBox(picture('small'));
    assert.ok(crop.x >= tile.minX && crop.y >= tile.minY);
    assert.ok(crop.x + crop.side <= tile.maxX + 1 && crop.y + crop.side <= tile.maxY + 1);
  });

  test("no pixel of the picture that the crop covers at all is less than opaque: the tile's soft edge and its transparent corners are in no small file", () => {
    // The crop lies inside the tile's box, but the tile is rounded: a square crop's corner can lie
    // outside the tile's corner arc, and it holds only because the crop's own rounding cuts it off.
    const png = picture('small');
    const source = smallSource();
    const { side } = cropOf();
    let covered = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      if ((source[i * 4 + 3] ?? 0) > 0) {
        covered++;
        assert.ok(
          (png.pixels[i * 4 + 3] ?? 0) >= OPAQUE,
          `pixel ${i % png.width},${Math.floor(i / png.width)} is at alpha ${png.pixels[i * 4 + 3]}`,
        );
      }
    }
    assert.ok(covered > 0.8 * side * side, `${covered} pixels covered of ${side * side}`);
  });

  test("the rounded corners: the tile's radius is 273 of its 1200 pixel side (to 6 pixels: the fit depends on the alpha taken for the edge)", () => {
    // A circle fitted by least squares to the corner's edge: where the edge is taken (alpha 250 or
    // more here; the crop's radius, 0.2275 of its side, came from a fit at another alpha) moves
    // the radius by a few pixels of 1200, which is a tenth of a pixel at 32.
    const tile = tileRadiusOf(picture('small'));

    assert.ok(Math.abs(tile.radius - 273) <= 6, `the tile's corner fits ${tile.radius}`);
    assert.ok(tile.rms < 4, `rms ${tile.rms} of 1200`);
    assert.equal(CORNER * 1200, 273);
  });

  test("scripts/icons.ts holds these numbers: the drawing's box, the margin, the corners' radius and the navy", () => {
    assert.deepEqual(SCRIPT_DRAWING_BOX, DRAWING_BOX);
    assert.equal(SCRIPT_DRAWING_MARGIN, DRAWING_MARGIN);
    assert.equal(SCRIPT_CORNER_RADIUS, CORNER);
    assert.equal(
      SCRIPT_TILE_NAVY,
      `#${NAVY.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
    );
  });
});

describe('the PNG files', () => {
  test('each has its size, 8 bits per channel; the five on a transparent background have alpha', () => {
    for (const { file, size } of PNGS) {
      const png = decodePng(read(`${ICONS}/${file}`));
      assert.equal(png.width, size, file);
      assert.equal(png.height, size, file);
      assert.equal(png.bitDepth, 8, file);
      assert.deepEqual(
        png.chunks.filter((type) => type !== 'IDAT'),
        ['IHDR', 'IEND'],
        file,
      );
      if (TRANSPARENT.some((t) => t.file === file)) {
        assert.equal(png.colourType, 6, `${file}: RGBA`);
      }
    }
  });

  test('the five are transparent at the corners and opaque in the middle', () => {
    for (const { file, size } of TRANSPARENT) {
      const png = decodePng(read(`${ICONS}/${file}`));
      assert.deepEqual(corners(png), [0, 0, 0, 0], file);
      assert.ok(alpha(png, size >> 1, size >> 1) >= OPAQUE, `${file}: the middle is opaque`);
    }
  });

  test('the maskable ones are opaque at every pixel: a full background', () => {
    for (const { file, size } of MASKABLE) {
      const png = decodePng(read(`${ICONS}/${file}`));
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (alpha(png, x, y) !== 255) {
            assert.fail(`${file}: pixel ${x},${y} is not opaque`);
          }
        }
      }
    }
  });

  test("the maskable ones: the drawing on the tile's colour, inside the safe zone (a circle of 0.4 of the size)", () => {
    for (const { file, size } of MASKABLE) {
      const png = decodePng(read(`${ICONS}/${file}`));

      assert.deepEqual(
        cornerColours(png),
        [BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND],
        `${file}: the corners are the background`,
      );
      assert.ok(
        rgb(png, size >> 1, size >> 1).some(
          (value, i) => Math.abs(value - (BACKGROUND[i] ?? 0)) > DRAWN,
        ),
        `${file}: the drawing is there`,
      );
      const farthest = farthestDrawn(png);
      // One pixel for the resampling: the picture's farthest pixel is 0.3 of a pixel inside.
      assert.ok(
        farthest <= SAFE_RADIUS * size + 1,
        `${file}: drawn ${farthest / size} of the size out`,
      );
      assert.ok(
        farthest >= SAFE_RADIUS * size - 3,
        `${file}: the drawing stops at ${farthest / size} of the size: not the largest that holds`,
      );
    }
  });

  test('the maskable ones: the tile does not show as a shape: no step above 2 along a line across the circle where the picture fades out, none above the limit anywhere outside the drawing', () => {
    // Outside the drawing: both pixels of a pair farther from the middle than 0.41 of the size.
    const step = (png: Png, x: number, y: number, x2: number, y2: number): number => {
      const size = png.width;
      const outside = (px: number, py: number): boolean =>
        Math.hypot(px + 0.5 - size / 2, py + 0.5 - size / 2) > 0.41 * size;
      if (!outside(x, y) || !outside(x2, y2)) {
        return 0;
      }
      const a = rgb(png, x, y);
      const b = rgb(png, x2, y2);
      return Math.max(...a.map((value, c) => Math.abs(value - (b[c] ?? 0))));
    };

    for (const { file, size } of MASKABLE) {
      const png = decodePng(read(`${ICONS}/${file}`));
      // The circle where the picture has faded out, in the icon's pixels.
      const faded = (FADE_TO * MASKABLE_SCALE * size) / MASTER_SIZE;
      let lines = 0;
      for (const fraction of [0.12, 0.27, 0.5, 0.78, 0.9]) {
        const line = Math.floor(fraction * size);
        assert.ok(
          Math.abs(line + 0.5 - size / 2) < faded,
          `${file}: line ${line} crosses the circle of ${faded}`,
        );
        for (const across of ['row', 'column'] as const) {
          let worst = 0;
          for (let t = 0; t < size - 1; t++) {
            worst = Math.max(
              worst,
              across === 'row' ? step(png, t, line, t + 1, line) : step(png, line, t, line, t + 1),
            );
          }
          assert.ok(worst <= 2, `${file}: the ${across} ${line}: a step of ${worst}`);
          lines++;
        }
      }
      assert.equal(lines, 10);
      let worst = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          worst = Math.max(
            worst,
            x + 1 < size ? step(png, x, y, x + 1, y) : 0,
            y + 1 < size ? step(png, x, y, x, y + 1) : 0,
          );
        }
      }
      assert.ok(worst <= GLOBAL_STEP, `${file}: a step of ${worst} outside the drawing`);
    }
  });

  test('the three small files fill their square: the middle half of each side is at alpha 252 or more, the corners are transparent', () => {
    // Each is a rounded square cropped from the picture, so that the outer rows and columns are
    // covered whole: one pixel of a 16 pixel file is 65 of the picture's, and a soft grey rim on a
    // light taskbar is what a partly covered edge gives.
    for (const size of SMALL_SIZES) {
      const png = decodePng(read(`${ICONS}/icon-${size}.png`));
      for (let t = Math.ceil(size / 4); t < Math.floor((3 * size) / 4); t++) {
        for (const [x, y] of [
          [t, 0],
          [t, size - 1],
          [0, t],
          [size - 1, t],
        ] as const) {
          assert.ok(
            alpha(png, x, y) >= SIDE_OPAQUE,
            `icon-${size}.png: pixel ${x},${y} is at alpha ${alpha(png, x, y)}`,
          );
        }
      }
      assert.deepEqual(corners(png), [0, 0, 0, 0], `icon-${size}.png`);
    }
  });

  test('16, 32 and 48 pixels: the drawing reaches the left and the right edge (at 48 pixels, to within 1 pixel)', () => {
    // The crop is the drawing's width plus 2 % each side: 0.3 of a pixel at 16, 0.6 at 32 and 0.9
    // at 48 are navy before the cloud's outline starts, so the drawing starts and ends at the edge
    // at 16 and 32 (0 pixels away) and one pixel from it at 48. A pixel is the drawing's when it
    // is opaque and more than DRAWN_ON_NAVY from the navy in some channel. The bound is that and no
    // more: one pixel at 16 is the whole difference between the crop and the picture's whole tile
    // (1.5 pixels of navy each side at 16, its drawing one pixel from each edge).
    for (const size of SMALL_SIZES) {
      const bound = size === 48 ? 1 : 0;
      const png = decodePng(read(`${ICONS}/icon-${size}.png`));
      let left = size;
      let right = -1;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (drawnOnNavy(png, x, y, NAVY)) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      assert.ok(
        left <= bound,
        `icon-${size}.png: the drawing starts ${left} pixels from the left edge, more than ${bound}`,
      );
      assert.ok(
        size - 1 - right <= bound,
        `icon-${size}.png: the drawing ends ${size - 1 - right} pixels from the right edge, more than ${bound}`,
      );
    }
  });

  test('every one is its picture, reduced: the same pixels as an average of it written again here', () => {
    // The script averages the picture's pixels under each pixel, in linear light, in Chromium;
    // `reduced` does the same in Node. Only rounding and the premultiplying of the canvas differ:
    // compared premultiplied, alpha and each channel within 3 of 255 (the worst seen is under 2).
    for (const { file, size } of PNGS) {
      const maskable = MASKABLE.some((m) => m.file === file);
      const png = decodePng(read(`${ICONS}/${file}`));
      const expected = reduced(size, maskable ? MASKABLE_SCALE : 1, sourceOf(file, size), maskable);
      let worst = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const a = alpha(png, x, y);
          const b = expected[i + 3] ?? 0;
          worst = Math.max(worst, Math.abs(a - b));
          rgb(png, x, y).forEach((value, c) => {
            worst = Math.max(
              worst,
              Math.abs((value * a) / 255 - ((expected[i + c] ?? 0) * b) / 255),
            );
          });
        }
      }
      assert.ok(worst <= 3, `${file}: ${worst} steps from the picture reduced`);
    }
  });

  test('the 16, 32 and 48 pixel files are drawn from the small picture and the others from the large one: told apart by the white of the `>_`', () => {
    // The small picture's `>_` is one bold white mark in a window of its own (near white in 2.9 %
    // of a 512 pixel box); the large picture's is a thin one in a front window of three (0.55 %).
    // A pixel is white when it is opaque and each channel is 200 or more.
    for (const { file, size } of PNGS) {
      const share = whites(decodePng(read(`${ICONS}/${file}`))) / (size * size);
      if (sourceOf(file, size) === 'small') {
        assert.ok(share >= 0.015, `${file}: ${share} white: not the small picture's bold \`>_\``);
      } else {
        assert.ok(share <= 0.01, `${file}: ${share} white: not the large picture's thin \`>_\``);
      }
    }
  });

  test('16 pixels: the `>_` has at least 10 white pixels (the window alone of F12 had 22, the whole tile of F10 7)', () => {
    // With the cloud around it the window is 0.61 of the icon's width (alone it was 0.93), and the
    // `>_` with it: 10 pixels are opaque and 200 or more in every channel in the file as built.
    const n = whites(decodePng(read(`${ICONS}/icon-16.png`)));

    assert.ok(n >= MIN_WHITE_16, `${n} white pixels, fewer than ${MIN_WHITE_16}`);
  });

  test("16 pixels: the cloud is there, above the window where the crop puts it: the window's top frame is row 7, and above it at least 28 pixels of the cloud's blue to violet", () => {
    // The crop puts the window's top edge 6.8 pixels down and its sides 3.2 and 13.0 pixels from
    // the left: its top frame is row 7, and rows 0 to 5 lie wholly above the window, where only
    // the cloud is drawn (its top is 1.5 pixels down). The file as built has 28 such pixels. In
    // F12's file, the window alone, row 7 is inside the window, at its `>_`, and the rows above
    // hold the window's own frame (its top in row 2): there the frame's row fails, while the count
    // alone would pass (36 pixels of that hue in rows 0 to 5, the window's own frame). The two
    // hold only together: the window where the crop puts it, and the cloud above it.
    const png = decodePng(read(`${ICONS}/icon-16.png`));
    const win = windowInFile(16);
    const frame = Math.ceil(win.top);

    assert.equal(frame, 7);
    for (let x = Math.ceil(win.left); x < Math.floor(win.right); x++) {
      assert.ok(
        cloudHue(png, x, frame),
        `row ${frame}, column ${x} (${rgb(png, x, frame).join(', ')}) is not the window's top frame: the window is not where the drawing's crop puts it`,
      );
    }
    let cloud = 0;
    for (let y = 0; y + 1 <= win.top; y++) {
      for (let x = 0; x < png.width; x++) {
        if (cloudHue(png, x, y)) {
          cloud++;
        }
      }
    }
    assert.ok(
      cloud >= MIN_CLOUD_16,
      `${cloud} pixels of the cloud above the window, fewer than ${MIN_CLOUD_16}`,
    );
  });

  test("the six files F14 leaves are main's, byte for byte (follow-up F14 changes icon-16.png and favicon.ico only)", () => {
    for (const [file, sha256] of Object.entries(KEPT_FILES)) {
      assert.equal(
        createHash('sha256')
          .update(read(`${ICONS}/${file}`))
          .digest('hex'),
        sha256,
        file,
      );
    }
  });

  test('of web/icons/ the server reads exactly the seven PNGs and favicon.ico', (t) => {
    const { platform } = testPlatform(t);

    // What the build holds and the server serves; an editor's `.icon-16.png.swp` is neither.
    const served = [...readBuild(platform.files, checkout).files.keys()]
      .filter((path) => path.startsWith(`${ICONS}/`))
      .map((path) => path.slice(ICONS.length + 1));

    assert.deepEqual(
      served.sort(),
      ['favicon.ico', ...PNGS.map((p) => p.file)].sort(),
      'a file left by scripts/icons.ts, or one added by hand: every file of web/ is served (S2 8.2.1)',
    );
  });
});

test("favicon.ico: a directory of three images, 16, 32 and 48 pixels, whose bytes are the PNGs'", () => {
  const ico = read(`${ICONS}/favicon.ico`);

  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
  assert.equal(ico.readUInt16LE(4), IN_ICO.length, 'the number of images');
  let end = 6 + 16 * IN_ICO.length;
  IN_ICO.forEach((size, i) => {
    const entry = ico.subarray(6 + 16 * i, 6 + 16 * (i + 1));
    const png = read(`${ICONS}/icon-${size}.png`);
    assert.equal(entry.readUInt8(0), size, `width ${size}`);
    assert.equal(entry.readUInt8(1), size, `height ${size}`);
    assert.equal(entry.readUInt8(2), 0, `no palette ${size}`);
    assert.equal(entry.readUInt8(3), 0, `reserved ${size}`);
    assert.equal(entry.readUInt16LE(4), 1, `planes ${size}`);
    assert.equal(entry.readUInt16LE(6), 32, `bits per pixel ${size}`);
    const length = entry.readUInt32LE(8);
    const offset = entry.readUInt32LE(12);
    assert.equal(offset, end, `image ${size} follows the one before`);
    assert.deepEqual(
      ico.subarray(offset, offset + length),
      png,
      `image ${size} is icon-${size}.png`,
    );
    end = offset + length;
  });
  assert.equal(ico.length, end, 'nothing after the last image');
});

describe('scripts/icons.ts and what it wrote', () => {
  test('the script draws the sizes the manifest names, and puts the three of IN_ICO into favicon.ico', () => {
    assert.equal(SOURCE, PICTURES.large.path);
    assert.equal(SOURCE_SMALL, PICTURES.small.path);
    assert.deepEqual(
      SCRIPT_SIZES,
      TRANSPARENT.map((t) => t.size),
    );
    assert.deepEqual(SCRIPT_SMALL, SMALL_SIZES);
    assert.deepEqual(
      SCRIPT_MASKABLE,
      MASKABLE.map((m) => m.size),
    );
    assert.deepEqual(SCRIPT_IN_ICO, IN_ICO);
    const { icons } = JSON.parse(read('web/manifest.webmanifest').toString('utf8')) as {
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    const named = (purpose: string | undefined): string[] =>
      icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
    assert.deepEqual(
      named(undefined),
      SCRIPT_SIZES.map((size) => `${size}x${size}`),
    );
    assert.deepEqual(
      named('maskable'),
      SCRIPT_MASKABLE.map((size) => `${size}x${size}`),
    );
    const ico = read(`${ICONS}/favicon.ico`);
    assert.deepEqual(
      SCRIPT_IN_ICO.map((_, i) => ico.readUInt8(6 + 16 * i)),
      SCRIPT_IN_ICO,
    );
    assert.match(
      read('web/index.html').toString('utf8'),
      new RegExp(`<link rel="icon"[^>]*sizes="${SCRIPT_IN_ICO.map((s) => `${s}x${s}`).join(' ')}"`),
    );
  });
});

describe('web/manifest.webmanifest', () => {
  const manifest = (): unknown => JSON.parse(read('web/manifest.webmanifest').toString('utf8'));

  test('no start_url, scope or id: the page is not to be installed as an app (ruled)', () => {
    const value = manifest() as Record<string, unknown>;

    // Without start_url Chromium counts the page as not installable (start-url-not-valid), and
    // an installed app's shortcut would hold no launch token (S2 5.1).
    for (const key of ['start_url', 'scope', 'id']) {
      assert.equal(Object.hasOwn(value, key), false, key);
    }
  });

  test('name, short_name, display and icons, and nothing else', () => {
    const value = manifest() as Record<string, unknown>;

    assert.deepEqual(Object.keys(value), ['name', 'short_name', 'display', 'icons']);
    assert.equal(value.name, 'skydeck');
    assert.equal(value.short_name, 'skydeck');
    assert.equal(value.display, 'standalone');
  });

  test('seven icons under /assets/__VERSION__/, each a file of the checkout with its size and type', () => {
    const { icons } = manifest() as { icons: Array<Record<string, unknown>> };

    assert.deepEqual(
      icons.map((icon) => icon.src),
      PNGS.map(({ file }) => `/assets/__VERSION__/${ICONS}/${file}`),
    );
    icons.forEach((icon, i) => {
      const { file, size } = PNGS[i] ?? assert.fail('an icon too many');
      const maskable = MASKABLE.some((m) => m.file === file);
      assert.deepEqual(
        icon,
        {
          src: `/assets/__VERSION__/${ICONS}/${file}`,
          sizes: `${size}x${size}`,
          type: 'image/png',
          ...(maskable ? { purpose: 'maskable' } : {}),
        },
        file,
      );
      assert.ok(existsSync(join(checkout, ICONS, file)), file);
      assert.equal(decodePng(read(`${ICONS}/${file}`)).width, size, file);
    });
  });

  test('is formatted as Prettier formats JSON, so that npm run format:check reads it', async () => {
    const path = join(checkout, 'web/manifest.webmanifest');

    const info = await prettier.getFileInfo(path, {
      ignorePath: join(checkout, '.prettierignore'),
    });
    const options = await prettier.resolveConfig(path);

    assert.equal(info.ignored, false);
    assert.equal(info.inferredParser, 'json');
    assert.ok(
      await prettier.check(read('web/manifest.webmanifest').toString('utf8'), {
        ...options,
        filepath: path,
      }),
    );
  });
});
