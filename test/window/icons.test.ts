// The page's own icon (S2 12.12; plan E14, task 94, and the follow-ups since): the picture
// scripts/icons/skydeck-source.png, the committed files of web/icons/ and
// web/manifest.webmanifest, read from the checkout. scripts/icons.ts drew the PNG and ICO files
// from the picture once; no test runs it, so these cases hold what it wrote, and (by drawing every
// file again from the picture in plain Node: the lines made bolder where the script makes them
// bolder, then the reduction) that each file is the picture's own drawing at its size.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import * as prettier from 'prettier';

import {
  BACKGROUND as SCRIPT_BACKGROUND,
  IN_ICO as SCRIPT_IN_ICO,
  LINE as SCRIPT_LINE,
  LINE_TARGET as SCRIPT_LINE_TARGET,
  MARGIN as SCRIPT_MARGIN,
  MASKABLE as SCRIPT_MASKABLE,
  MASKABLE_SCALE,
  RAISE as SCRIPT_RAISE,
  SIGN_MAX as SCRIPT_SIGN_MAX,
  SIZES as SCRIPT_SIZES,
  SOLID as SCRIPT_SOLID,
  SOURCE,
  STROKE as SCRIPT_STROKE,
  STROKE_TARGET as SCRIPT_STROKE_TARGET,
  WHITE_ALPHA as SCRIPT_WHITE_ALPHA,
  WHITE_CHANNEL as SCRIPT_WHITE_CHANNEL,
  bolderBy,
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
/** The images of favicon.ico: one for every size a panel of Windows or Edge shows the icon at
 *  (the taskbar at a display scale of 100, 125 and 150 % shows 24, 30 and 36 pixels; the title
 *  bar 16, 20 and 24), each drawn for its size. */
const IN_ICO = [16, 20, 24, 30, 32, 36, 40, 48, 64];

/** The picture: where it lives, its size in bytes and its sha256. Every file is drawn from it. */
const PICTURE = {
  path: 'scripts/icons/skydeck-source.png',
  bytes: 749_296,
  sha256: 'c3a5f0a80ad1b8c280803e292a6bfa9373b6b1f49d5af6ffe5d3f15df6a4ab57',
  width: 1076,
  height: 903,
} as const;

/** The share of a file's side left free on each side of the picture's longer side. */
const MARGIN = 0.02;
/** The maskable icons' full background. */
const BACKGROUND = [4, 9, 37];
/** The safe zone of a maskable icon: a circle of this radius, in parts of the icon's width. */
const SAFE_RADIUS = 0.4;
/** A pixel of a maskable file is the drawing's when it differs from the background by more than
 *  this (of 255) in some channel. */
const DRAWN = 40;

/** The picture's one solid piece is its pixels of alpha 32 or more; what is fainter is its soft
 *  edge, and lies within 2 pixels of it. */
const PIECE = 32;
const EDGE = 2;
/** A pixel of the picture's shape (what the bolder lines grow from): alpha 128 or more. */
const SOLID = 128;
/** A pixel of the white sign `>_`: alpha 224 or more and every channel 190 or more. */
const WHITE_ALPHA = 224;
const WHITE_CHANNEL = 190;
/** What the bolder small sizes aim at: the cloud's line at least 1.9 pixels wide, the sign's
 *  stroke at least 1.6; the sign grown by at most 11 picture pixels (the chevron and the
 *  underscore keep apart); the edge pixels' coverage raised by one fifth. */
const LINE_TARGET = 1.9;
const STROKE_TARGET = 1.6;
const SIGN_MAX = 11;
const RAISE = 1.2;
/** The amounts in picture pixels, from the widths measured below and the targets. */
const BOLDER: Record<number, { line: number; sign: number }> = {
  16: { line: 19, sign: 11 },
  20: { line: 6, sign: 7 },
};

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

/** The only chunks the drawn files and the picture may hold: no metadata (a text chunk could
 *  carry a name or a path of the machine that drew them, in a file the server serves). */
const CHUNKS = ['IHDR', 'IDAT', 'IEND'];

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

/** The picture, decoded once: its pixels are what the measurements and the drawing read. */
let decoded: Png | null = null;
function picture(): Png {
  decoded ??= decodePng(read(PICTURE.path));
  return decoded;
}

/** The `count` pixels of an image where `on` holds, as one byte (0 or 1) each. */
function maskOf(count: number, on: (i: number) => boolean): Uint8Array {
  const mask = new Uint8Array(count);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = on(i) ? 1 : 0;
  }
  return mask;
}

const isSolid = (pixels: Uint8Array | Buffer, i: number): boolean =>
  (pixels[i * 4 + 3] ?? 0) >= SOLID;
const isWhite = (pixels: Uint8Array | Buffer, i: number): boolean =>
  (pixels[i * 4 + 3] ?? 0) >= WHITE_ALPHA &&
  Math.min(pixels[i * 4] ?? 0, pixels[i * 4 + 1] ?? 0, pixels[i * 4 + 2] ?? 0) >= WHITE_CHANNEL;

/** The pieces (4-neighbours) of a mask: each pixel's piece (0 for none) and each piece's size
 *  (index 0 unused). */
function piecesOf(mask: Uint8Array, width: number): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(mask.length);
  const sizes = [0];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || label[start] !== 0) {
      continue;
    }
    const id = sizes.length;
    let n = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop() ?? 0;
      n++;
      const x = p % width;
      const near = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p - width,
        p + width < mask.length ? p + width : -1,
      ];
      for (const q of near) {
        if (q >= 0 && mask[q] === 1 && label[q] === 0) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

/** The box of the pixels of a mask's piece `id`, both ends included. */
function boxOf(
  label: Int32Array,
  width: number,
  id: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const box = { minX: width, maxX: -1, minY: Number.MAX_SAFE_INTEGER, maxY: -1 };
  label.forEach((value, i) => {
    if (value === id) {
      const x = i % width;
      const y = (i - x) / width;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
    }
  });
  return box;
}

/**
 * The cloud's line, measured where it runs straight across a probe: at its top (down the column
 * through the middle of the topmost row's solid pixels), at its left and at its right (along the
 * row through the middle of the outermost column's solid pixels); each is the run of solid pixels
 * from the outside in.
 */
function lineWidths(png: Png): { top: number; left: number; right: number } {
  const solid = (x: number, y: number): boolean => alpha(png, x, y) >= SOLID;
  const middleOf = (hits: number[]): number =>
    Math.floor(((hits[0] ?? 0) + (hits.at(-1) ?? 0)) / 2);
  const run = (x: number, y: number, dx: number, dy: number): number => {
    while (!solid(x, y)) {
      x += dx;
      y += dy;
    }
    let n = 0;
    while (x >= 0 && y >= 0 && x < png.width && y < png.height && solid(x, y)) {
      n++;
      x += dx;
      y += dy;
    }
    return n;
  };
  const hitsOfRow = (y: number): number[] =>
    Array.from({ length: png.width }, (_, x) => x).filter((x) => solid(x, y));
  const hitsOfColumn = (x: number): number[] =>
    Array.from({ length: png.height }, (_, y) => y).filter((y) => solid(x, y));
  let topY = 0;
  while (hitsOfRow(topY).length === 0) {
    topY++;
  }
  let leftX = 0;
  while (hitsOfColumn(leftX).length === 0) {
    leftX++;
  }
  let rightX = png.width - 1;
  while (hitsOfColumn(rightX).length === 0) {
    rightX--;
  }
  return {
    top: run(middleOf(hitsOfRow(topY)), 0, 0, 1),
    left: run(0, middleOf(hitsOfColumn(leftX)), 1, 0),
    right: run(png.width - 1, middleOf(hitsOfColumn(rightX)), -1, 0),
  };
}

/** The white sign: its pieces (the chevron and the underscore), the underscore's height down
 *  each column of the middle half of its box, and the shortest distance between the two pieces
 *  (between pixel middles). */
function sign(png: Png): { pieces: number; heights: number[]; gap: number } {
  const { label, sizes } = piecesOf(
    maskOf(png.width * png.height, (i) => isWhite(png.pixels, i)),
    png.width,
  );
  const boxes = [1, 2].map((id) => boxOf(label, png.width, id));
  const underscore = boxes.findIndex((box) => box.maxX - box.minX > box.maxY - box.minY) + 1;
  const box = boxes[underscore - 1] ?? assert.fail('the underscore');
  const quarter = (box.maxX - box.minX + 1) / 4;
  const heights: number[] = [];
  for (let x = Math.ceil(box.minX + quarter); x <= Math.floor(box.maxX - quarter); x++) {
    let n = 0;
    for (let y = box.minY; y <= box.maxY; y++) {
      if (label[y * png.width + x] === underscore) {
        n++;
      }
    }
    heights.push(n);
  }
  const edge = (id: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    label.forEach((value, i) => {
      const x = i % png.width;
      if (
        value === id &&
        [i - 1, i + 1, i - png.width, i + png.width].some(
          (q) => label[q] !== id || (q === i - 1 && x === 0),
        )
      ) {
        out.push([x, (i - x) / png.width]);
      }
    });
    return out;
  };
  let gap = Number.POSITIVE_INFINITY;
  const other = edge(3 - underscore);
  for (const [x, y] of edge(underscore)) {
    for (const [u, v] of other) {
      gap = Math.min(gap, Math.hypot(x - u, y - v));
    }
  }
  return { pieces: sizes.length - 1, heights, gap };
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Picture pixels per pixel of a file of `size` that is not maskable. */
const perPixel = (size: number): number =>
  Math.max(PICTURE.width, PICTURE.height) / ((1 - 2 * MARGIN) * size);

/** How many picture pixels the shape and the sign grow by for a file of `size`: what brings the
 *  line and the stroke, measured as `widths`, to their targets, to the nearest whole pixel, never
 *  less than none, the sign at most SIGN_MAX. */
function amounts(
  size: number,
  widths: { line: number; stroke: number },
): { line: number; sign: number } {
  const k = perPixel(size);
  return {
    line: Math.max(0, Math.round((LINE_TARGET * k - widths.line) / 2)),
    sign: Math.max(0, Math.min(SIGN_MAX, Math.round((STROKE_TARGET * k - widths.stroke) / 2))),
  };
}

/** A picture to reduce: RGBA bytes, its size, and where its pixel (0, 0) lies in the picture's
 *  own pixels (a grown picture has a border around the picture). */
interface Image {
  width: number;
  height: number;
  pixels: Uint8Array;
  origin: number;
}

/**
 * The chamfer distance (3 a step straight, 4 diagonal) of every pixel to the nearest pixel of
 * `mask`, and which pixel that is: two passes, as scripts/icons.ts makes it.
 */
function chamfer(
  mask: Uint8Array,
  width: number,
  height: number,
): { d: Int32Array; from: Int32Array } {
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
}

const grown = new Map<string, Image>();
/**
 * The picture with bolder lines: on a border of `line` pixels around it, every pixel that is not
 * solid within `line` pixels (chamfer) of a solid one becomes opaque in that one's colour; then
 * every solid pixel that is not white within `sign` pixels of a white one becomes white.
 */
function thickened(line: number, signBy: number): Image {
  const key = `${line} ${signBy}`;
  let image = grown.get(key);
  if (image === undefined) {
    const png = picture();
    const width = png.width + 2 * line;
    const height = png.height + 2 * line;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < png.height; y++) {
      pixels.set(
        png.pixels.subarray(y * png.width * 4, (y + 1) * png.width * 4),
        ((y + line) * width + line) * 4,
      );
    }
    const solid = new Uint8Array(width * height);
    const white = new Uint8Array(width * height);
    for (let p = 0; p < width * height; p++) {
      solid[p] = isSolid(pixels, p) ? 1 : 0;
      white[p] = isWhite(pixels, p) ? 1 : 0;
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
    if (signBy > 0) {
      const { d } = chamfer(white, width, height);
      for (let p = 0; p < width * height; p++) {
        if (solid[p] === 1 && white[p] === 0 && (d[p] ?? 0) <= 3 * signBy) {
          pixels.set([255, 255, 255, 255], p * 4);
        }
      }
    }
    image = { width, height, pixels, origin: -line };
    grown.set(key, image);
  }
  return image;
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

const premultiplied = new WeakMap<Image, Float32Array>();
/** An image's pixels as premultiplied linear light, 4 floats each (r, g, b, alpha). */
function linear(image: Image): Float32Array {
  let out = premultiplied.get(image);
  if (out === undefined) {
    out = new Float32Array(image.width * image.height * 4);
    for (let i = 0; i < image.width * image.height; i++) {
      const a = (image.pixels[i * 4 + 3] ?? 0) / 255;
      for (let c = 0; c < 3; c++) {
        out[i * 4 + c] = (LINEAR[image.pixels[i * 4 + c] ?? 0] ?? 0) * a;
      }
      out[i * 4 + 3] = a;
    }
    premultiplied.set(image, out);
  }
  return out;
}

/** The image's pixels that the output pixel `t` (one axis) covers, with their weights: pixel `i`
 *  lies from `offset + i * k` to `offset + (i + 1) * k`. */
function axis(t: number, count: number, k: number, offset: number): [number, number[]] {
  const first = Math.max(0, Math.floor((t - offset) / k));
  const last = Math.min(count - 1, Math.ceil((t + 1 - offset) / k) - 1);
  const weights: number[] = [];
  for (let i = first; i <= last; i++) {
    weights.push(Math.max(0, Math.min(t + 1, offset + (i + 1) * k) - Math.max(t, offset + i * k)));
  }
  return [first, weights];
}

/** A drawing: straight RGBA, 8 bits, and each pixel's coverage before rounding. */
interface Drawing {
  rgba: Uint8Array;
  covered: Float64Array;
}

/**
 * The picture (`image`, the picture or a grown one) reduced into a square of `size`, centred, its
 * longer side `scale` of the square's, in plain Node: each pixel the average of the picture's
 * pixels under it, weighted by the area they cover, premultiplied and in linear light; what the
 * picture does not cover is transparent, or, with `maskable`, BACKGROUND (opaque). With `raise`,
 * each alpha is then raised by RAISE (at most 255). This is what scripts/icons.ts does in
 * Chromium, written again here so that the committed files can be compared to it.
 */
function reduce(
  image: Image,
  size: number,
  scale: number,
  options: { maskable?: boolean; raise?: boolean } = {},
): Drawing {
  const k = (scale * size) / Math.max(PICTURE.width, PICTURE.height);
  const offsetX = (size - k * PICTURE.width) / 2 + image.origin * k;
  const offsetY = (size - k * PICTURE.height) / 2 + image.origin * k;
  const source = linear(image);
  const columns = Array.from({ length: size }, (_, t) => axis(t, image.width, k, offsetX));
  const rows = Array.from({ length: size }, (_, t) => axis(t, image.height, k, offsetY));
  const rgba = new Uint8Array(size * size * 4);
  const coveredAll = new Float64Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    const [y0, wy] = rows[ty] ?? [0, []];
    for (let tx = 0; tx < size; tx++) {
      const [x0, wx] = columns[tx] ?? [0, []];
      const sum = [0, 0, 0, 0];
      wy.forEach((weightY, j) => {
        wx.forEach((weightX, i) => {
          const at = ((y0 + j) * image.width + x0 + i) * 4;
          const w = weightX * weightY;
          for (let c = 0; c < 4; c++) {
            sum[c] = (sum[c] ?? 0) + w * (source[at + c] ?? 0);
          }
        });
      });
      const o = (ty * size + tx) * 4;
      const covered = sum[3] ?? 0;
      coveredAll[ty * size + tx] = covered;
      if (options.maskable === true) {
        for (let c = 0; c < 3; c++) {
          rgba[o + c] = encode((sum[c] ?? 0) + (1 - covered) * (LINEAR[BACKGROUND[c] ?? 0] ?? 0));
        }
        rgba[o + 3] = 255;
      } else if (covered > 0) {
        for (let c = 0; c < 3; c++) {
          rgba[o + c] = encode((sum[c] ?? 0) / covered);
        }
        const a = Math.round(covered * 255);
        rgba[o + 3] = options.raise === true ? Math.min(255, Math.round(a * RAISE)) : a;
      }
    }
  }
  return { rgba, covered: coveredAll };
}

const drawings = new Map<string, Drawing>();
/** What a file of `size` is: the picture, bolder by `amounts` at that size (with its coverage
 *  raised when it is), reduced; a maskable one at MASKABLE_SCALE on the background. */
function drawingOf(size: number, maskable: boolean): Drawing {
  const key = `${size} ${maskable}`;
  let drawing = drawings.get(key);
  if (drawing === undefined) {
    if (maskable) {
      drawing = reduce(thickened(0, 0), size, MASKABLE_SCALE, { maskable: true });
    } else {
      const by = BOLDER[size] ?? { line: 0, sign: 0 };
      const bolder = by.line > 0 || by.sign > 0;
      drawing = reduce(thickened(by.line, by.sign), size, 1 - 2 * MARGIN, { raise: bolder });
    }
    drawings.set(key, drawing);
  }
  return drawing;
}

/** The largest difference, premultiplied, between a file's pixels and a drawing's, of 255. */
function worstStep(png: Png, drawing: Drawing): number {
  let worst = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const a = alpha(png, x, y);
      const b = drawing.rgba[i + 3] ?? 0;
      worst = Math.max(worst, Math.abs(a - b));
      rgb(png, x, y).forEach((value, c) => {
        worst = Math.max(
          worst,
          Math.abs((value * a) / 255 - ((drawing.rgba[i + c] ?? 0) * b) / 255),
        );
      });
    }
  }
  return worst;
}

/** How far from the centre a maskable file's drawing reaches, in pixels: the farthest pixel
 *  centre whose colour differs from the background by more than DRAWN in some channel. */
function farthestDrawn(png: Png): number {
  let farthest = 0;
  const centre = png.width / 2;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (rgb(png, x, y).some((value, c) => Math.abs(value - (BACKGROUND[c] ?? 0)) > DRAWN)) {
        farthest = Math.max(farthest, Math.hypot(x + 0.5 - centre, y + 0.5 - centre));
      }
    }
  }
  return farthest;
}

/** The farthest corner of any pixel of the picture that is not transparent, from its middle. */
function farthestOfPicture(): number {
  const png = picture();
  let farthest = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (alpha(png, x, y) > 0) {
        for (const [cx, cy] of [
          [x, y],
          [x + 1, y],
          [x, y + 1],
          [x + 1, y + 1],
        ] as const) {
          farthest = Math.max(farthest, Math.hypot(cx - png.width / 2, cy - png.height / 2));
        }
      }
    }
  }
  return farthest;
}

/** favicon.ico's images: for each, its directory entry and its bytes. */
function icoImages(): Array<{
  width: number;
  height: number;
  palette: number;
  reserved: number;
  planes: number;
  bits: number;
  offset: number;
  png: Buffer;
}> {
  const ico = read(`${ICONS}/favicon.ico`);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const entry = ico.subarray(6 + 16 * i, 6 + 16 * (i + 1));
    const length = entry.readUInt32LE(8);
    const offset = entry.readUInt32LE(12);
    return {
      width: entry.readUInt8(0),
      height: entry.readUInt8(1),
      palette: entry.readUInt8(2),
      reserved: entry.readUInt8(3),
      planes: entry.readUInt16LE(4),
      bits: entry.readUInt16LE(6),
      offset,
      png: ico.subarray(offset, offset + length),
    };
  });
}

describe(`the picture, ${PICTURE.path}`, () => {
  test('its size and sha256', () => {
    const bytes = read(PICTURE.path);

    assert.equal(bytes.length, PICTURE.bytes);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      PICTURE.sha256,
      'the picture changed: a new one needs a new run of scripts/icons.ts and new numbers here',
    );
  });

  test('is 1076 x 903 pixels, 8-bit RGBA, with the chunks IHDR, IDAT and IEND and nothing else (no metadata)', () => {
    const png = picture();

    assert.equal(png.width, PICTURE.width);
    assert.equal(png.height, PICTURE.height);
    assert.equal(png.colourType, 6);
    assert.deepEqual(png.chunks, CHUNKS);
  });

  test('is clean: one solid piece (alpha 32 or more), and no fainter pixel further than 2 pixels from it', () => {
    // Faint pixels (alpha 1 to 31) scattered over a picture's transparent parts are invisible on
    // their own and add a haze to the reduced files.
    const png = picture();
    const { label, sizes } = piecesOf(
      maskOf(png.width * png.height, (i) => (png.pixels[i * 4 + 3] ?? 0) >= PIECE),
      png.width,
    );

    assert.equal(sizes.length - 1, 1, `${sizes.length - 1} pieces of alpha ${PIECE} or more`);
    let faint = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const a = alpha(png, x, y);
        if (a === 0 || a >= PIECE) {
          continue;
        }
        faint++;
        let near = false;
        for (let dy = -EDGE; dy <= EDGE && !near; dy++) {
          for (let dx = -EDGE; dx <= EDGE && !near; dx++) {
            const u = x + dx;
            const v = y + dy;
            near =
              Math.abs(dx) + Math.abs(dy) <= EDGE &&
              u >= 0 &&
              v >= 0 &&
              u < png.width &&
              v < png.height &&
              label[v * png.width + u] === 1;
          }
        }
        assert.ok(near, `pixel ${x},${y} (alpha ${a}) is more than ${EDGE} pixels from the piece`);
      }
    }
    assert.ok(faint > 0, 'the soft edge is kept');
  });

  test('is the only file of scripts/icons/: every icon file is drawn from it', () => {
    assert.equal(SOURCE, PICTURE.path);
    assert.deepEqual(readdirSync(join(checkout, 'scripts/icons')), [basename(PICTURE.path)]);
  });

  test('is not under web/: the server does not serve it', (t) => {
    const { platform } = testPlatform(t);
    const built = [...readBuild(platform.files, checkout).files.keys()];

    assert.equal(existsSync(join(checkout, ICONS, basename(PICTURE.path))), false);
    assert.deepEqual(
      built.filter((path) => path.endsWith(basename(PICTURE.path))),
      [],
      'the build does not hold it',
    );
  });

  test('the SVG of the first icon is gone, and the build holds no drawing', (t) => {
    const { platform } = testPlatform(t);

    assert.equal(existsSync(join(checkout, 'web/icons/skydeck.svg')), false);
    assert.deepEqual(
      [...readBuild(platform.files, checkout).files.keys()].filter((path) => path.endsWith('.svg')),
      [],
    );
  });
});

describe('the bolder lines of the 16 and 20 pixel files', () => {
  test("the cloud's line is 95 picture pixels: the mean of its width at its top (93), its left (93) and its right (99)", () => {
    const widths = lineWidths(picture());

    assert.deepEqual(widths, { top: 93, left: 93, right: 99 });
    assert.equal(SCRIPT_LINE, Math.round(mean([widths.top, widths.left, widths.right])));
    assert.equal(SCRIPT_SOLID, SOLID);
  });

  test("the sign's stroke is 76 picture pixels: the underscore's mean height across the middle half of it (75 to 76)", () => {
    const { pieces, heights } = sign(picture());

    assert.equal(pieces, 2, 'the sign is two white pieces, the chevron and the underscore');
    assert.ok(Math.min(...heights) >= 75 && Math.max(...heights) <= 76, heights.join(' '));
    assert.equal(SCRIPT_STROKE, Math.round(mean(heights)));
    assert.equal(SCRIPT_WHITE_ALPHA, WHITE_ALPHA);
    assert.equal(SCRIPT_WHITE_CHANNEL, WHITE_CHANNEL);
  });

  test('the amounts: +19 and +11 picture pixels at 16, +6 and +7 at 20, none from 24 pixels up, derived from the two widths and the targets, as the script derives them', () => {
    const { top, left, right } = lineWidths(picture());
    const widths = {
      line: Math.round(mean([top, left, right])),
      stroke: Math.round(mean(sign(picture()).heights)),
    };

    assert.equal(SCRIPT_LINE_TARGET, LINE_TARGET);
    assert.equal(SCRIPT_STROKE_TARGET, STROKE_TARGET);
    assert.equal(SCRIPT_SIGN_MAX, SIGN_MAX);
    assert.equal(SCRIPT_RAISE, RAISE);
    assert.equal(SCRIPT_MARGIN, MARGIN);
    for (const size of new Set([...IN_ICO, ...TRANSPARENT.map((t) => t.size)])) {
      const expected = BOLDER[size] ?? { line: 0, sign: 0 };
      assert.deepEqual(amounts(size, widths), expected, `${size} pixels`);
      assert.deepEqual(
        bolderBy(size, Math.max(PICTURE.width, PICTURE.height)),
        expected,
        `${size} pixels: the script's`,
      );
    }
    // What they give, in pixels of the file: at 20 the line and the stroke at their targets; at
    // 16 the line at its target to the nearest picture pixel (1.899) and the stroke held at 1.4
    // by SIGN_MAX; at 24, with nothing grown, both are at their targets already.
    const at = (size: number, width: number): number => width / perPixel(size);
    const by16 = BOLDER[16] ?? assert.fail('16 pixels');
    const by20 = BOLDER[20] ?? assert.fail('20 pixels');
    assert.ok(at(20, widths.line + 2 * by20.line) >= LINE_TARGET);
    assert.ok(at(20, widths.stroke + 2 * by20.sign) >= STROKE_TARGET);
    assert.ok(Math.abs(at(16, widths.line + 2 * by16.line) - LINE_TARGET) < 0.005);
    assert.ok(Math.abs(at(16, widths.stroke + 2 * by16.sign) - 1.4) < 0.005);
    assert.ok(at(24, widths.line) >= LINE_TARGET && at(24, widths.stroke) >= STROKE_TARGET);
  });

  test('grown by at most 11, the sign stays two pieces: the chevron and the underscore are 39.8 picture pixels apart where they come closest', () => {
    // At 16 pixels the stroke's target asks for 18 each: the gap would close but for 3.8 picture
    // pixels, a twentieth of a pixel of the file, and the two would read as one mark.
    const { gap, heights } = sign(picture());
    const by = BOLDER[16] ?? assert.fail('16 pixels');
    const grownSign = thickened(by.line, by.sign);
    const asked = Math.round((STROKE_TARGET * perPixel(16) - Math.round(mean(heights))) / 2);

    assert.ok(Math.abs(gap - 39.8) < 0.05, `${gap}`);
    assert.equal(asked, 18);
    assert.ok(gap - 2 * asked < 4 && gap - 2 * SIGN_MAX > 17);
    const white = maskOf(grownSign.width * grownSign.height, (i) => isWhite(grownSign.pixels, i));
    assert.equal(piecesOf(white, grownSign.width).sizes.length - 1, 2);
  });

  test('the grown drawing still fits its square: the shape grows by 19 picture pixels at 16, the margin is 22.4', () => {
    for (const size of [16, 20]) {
      const by = BOLDER[size] ?? assert.fail(`${size}`);
      const margin = MARGIN * Math.max(PICTURE.width, PICTURE.height) * (1 / (1 - 2 * MARGIN));
      assert.ok(by.line < margin, `${size}: grown by ${by.line}, the margin is ${margin}`);
      // Nothing of the grown picture falls outside the file: its coverage is all there.
      const drawing = drawingOf(size, false);
      const image = thickened(by.line, by.sign);
      const k = 1 / perPixel(size);
      let total = 0;
      for (let i = 0; i < image.width * image.height; i++) {
        total += ((image.pixels[i * 4 + 3] ?? 0) / 255) * k * k;
      }
      const covered = drawing.covered.reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(covered - total) < 1e-5 * total, `${size}: ${covered} of ${total}`);
    }
  });

  test("16 and 20 pixels: down the column through the cloud's top the line covers at least 1.9 pixels of the file, where the picture reduced as it is covers less", () => {
    const png = picture();
    let topY = 0;
    const hits = (y: number): number[] =>
      Array.from({ length: png.width }, (_, x) => x).filter((x) => alpha(png, x, y) >= SOLID);
    while (hits(topY).length === 0) {
      topY++;
    }
    const topX = ((hits(topY)[0] ?? 0) + (hits(topY).at(-1) ?? 0) + 1) / 2;
    // The first run of covered pixels down a column, from the top: the sum of their alpha.
    const lineDown = (alphaAt: (y: number) => number): number => {
      let y = 0;
      while (alphaAt(y) === 0) {
        y++;
      }
      let line = 0;
      while (alphaAt(y) > 0) {
        line += alphaAt(y) / 255;
        y++;
      }
      return line;
    };
    for (const size of [16, 20]) {
      const file = size === 16 ? decodePng(read(`${ICONS}/icon-16.png`)) : frame(size);
      const column = Math.floor(MARGIN * size + topX / perPixel(size));
      const line = lineDown((y) => alpha(file, column, y));
      const plain = reduce(thickened(0, 0), size, 1 - 2 * MARGIN);
      const plainLine = lineDown((y) => plain.rgba[(y * size + column) * 4 + 3] ?? 0);

      assert.ok(line >= LINE_TARGET, `${size} pixels: the line covers ${line}`);
      assert.ok(plainLine < LINE_TARGET, `${size} pixels, as it is: ${plainLine}`);
    }
  });
});

/** The image of favicon.ico of `size` pixels, decoded. */
function frame(size: number): Png {
  const image = icoImages().find((entry) => entry.width === size) ?? assert.fail(`${size}`);
  return decodePng(image.png);
}

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

  test('the five are the picture on a transparent square: no tile; the corners, and every pixel the picture does not cover, fully transparent', () => {
    for (const { file, size } of TRANSPARENT) {
      const png = decodePng(read(`${ICONS}/${file}`));
      const { covered } = drawingOf(size, false);
      assert.deepEqual(corners(png), [0, 0, 0, 0], file);
      let outside = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if ((covered[y * size + x] ?? 0) === 0) {
            outside++;
            assert.equal(alpha(png, x, y), 0, `${file}: pixel ${x},${y}`);
          }
        }
      }
      // Above and below the picture (it is wider than tall) and inside the cloud.
      assert.ok(outside > 0.15 * size * size, `${file}: ${outside} pixels outside the drawing`);
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

  test('the maskable ones: the whole drawing inside the safe zone (a circle of 0.4 of the size), as large as it can be, on the background', () => {
    for (const { file, size } of MASKABLE) {
      const png = decodePng(read(`${ICONS}/${file}`));
      const { covered } = drawingOf(size, true);

      assert.deepEqual(
        cornerColours(png),
        [BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND],
        `${file}: the corners are the background`,
      );
      // No tile and no fade: where the picture puts nothing, the background, exactly.
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if ((covered[y * size + x] ?? 0) === 0) {
            assert.deepEqual(rgb(png, x, y), BACKGROUND, `${file}: pixel ${x},${y}`);
          }
        }
      }
      const farthest = farthestDrawn(png);
      assert.ok(
        farthest <= SAFE_RADIUS * size,
        `${file}: drawn ${farthest / size} of the size out`,
      );
      assert.ok(
        farthest >= SAFE_RADIUS * size - 2,
        `${file}: the drawing stops at ${farthest / size} of the size: not the largest that holds`,
      );
    }
  });

  test("MASKABLE_SCALE is the largest scale, to three decimals, at which every pixel of the picture that is not transparent lies inside the circle (the picture's longer side, in parts of the icon's)", () => {
    const farthest = farthestOfPicture();
    const longer = Math.max(PICTURE.width, PICTURE.height);

    assert.ok(Math.abs(farthest - 547.2) < 0.05, `the picture reaches ${farthest} pixels out`);
    assert.ok((MASKABLE_SCALE * farthest) / longer <= SAFE_RADIUS, `${MASKABLE_SCALE} is out`);
    assert.ok(
      ((MASKABLE_SCALE + 0.001) * farthest) / longer > SAFE_RADIUS,
      `${MASKABLE_SCALE + 0.001} would still hold: the scale is not the largest`,
    );
  });

  test('every PNG and every image of favicon.ico is the picture drawn for its size: the same pixels as a drawing written again here (bolder at 16 and 20)', () => {
    // The script draws in Chromium, `drawingOf` in Node. Only rounding and the premultiplying of
    // the canvas differ: compared premultiplied, alpha and each channel within 3 of 255 (the worst
    // seen is 2.0). An image resized from the one of another size is 59 to 157 steps off, and a
    // 16 or 20 pixel one not made bolder 79 to 127.
    const drawn: Array<{ name: string; png: Png; size: number; maskable: boolean }> = [
      ...PNGS.map(({ file, size }) => ({
        name: file,
        png: decodePng(read(`${ICONS}/${file}`)),
        size,
        maskable: MASKABLE.some((m) => m.file === file),
      })),
      ...IN_ICO.map((size) => ({
        name: `favicon.ico, ${size} pixels`,
        png: frame(size),
        size,
        maskable: false,
      })),
    ];
    for (const { name, png, size, maskable } of drawn) {
      const worst = worstStep(png, drawingOf(size, maskable));
      assert.ok(worst <= 3, `${name}: ${worst} steps from the picture drawn`);
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

test('favicon.ico: a directory of nine images, 16, 20, 24, 30, 32, 36, 40, 48 and 64 pixels, each a PNG of its size; the 16, 32 and 48 pixel ones are the PNG files', () => {
  const ico = read(`${ICONS}/favicon.ico`);

  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
  assert.equal(ico.readUInt16LE(4), IN_ICO.length, 'the number of images');
  const images = icoImages();
  let end = 6 + 16 * IN_ICO.length;
  IN_ICO.forEach((size, i) => {
    const image = images[i] ?? assert.fail(`image ${i}`);
    assert.deepEqual(
      { ...image, png: null, offset: null },
      {
        width: size,
        height: size,
        palette: 0,
        reserved: 0,
        planes: 1,
        bits: 32,
        png: null,
        offset: null,
      },
      `the entry of ${size} pixels`,
    );
    assert.equal(image.offset, end, `image ${size} follows the one before`);
    const png = decodePng(image.png);
    assert.equal(png.width, size, `image ${size}: its width`);
    assert.equal(png.height, size, `image ${size}: its height`);
    assert.equal(png.colourType, 6, `image ${size}: RGBA`);
    if (TRANSPARENT.some((t) => t.size === size)) {
      assert.deepEqual(image.png, read(`${ICONS}/icon-${size}.png`), `image ${size} is the file`);
    }
    end = image.offset + image.png.length;
  });
  assert.equal(ico.length, end, 'nothing after the last image');
});

describe('scripts/icons.ts and what it wrote', () => {
  test('the script draws the sizes the manifest names, puts the nine of IN_ICO into favicon.ico, and index.html names those nine', () => {
    assert.deepEqual(
      SCRIPT_SIZES,
      TRANSPARENT.map((t) => t.size),
    );
    assert.deepEqual(
      SCRIPT_MASKABLE,
      MASKABLE.map((m) => m.size),
    );
    assert.deepEqual(SCRIPT_IN_ICO, IN_ICO);
    assert.equal(
      SCRIPT_BACKGROUND,
      `#${BACKGROUND.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
    );
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
    assert.deepEqual(
      icoImages().map((image) => image.width),
      SCRIPT_IN_ICO,
    );
    assert.match(
      read('web/index.html').toString('utf8'),
      new RegExp(
        `<link\\s+rel="icon"[^>]*\\ssizes="${SCRIPT_IN_ICO.map((s) => `${s}x${s}`).join(' ')}"`,
      ),
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
