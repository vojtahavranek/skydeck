// The page's own icon (S2 12.12; plan E14, task 94; follow-up F10): the owner's two pictures
// scripts/icons/skydeck-source.png and scripts/icons/skydeck-source-small.png, the committed files of
// web/icons/ and web/manifest.webmanifest, read from the checkout. scripts/icons.ts drew the PNG and
// ICO files from the pictures once; no test runs it, so these cases hold what it wrote, and (by
// reducing the pictures again in plain Node) that the files are the pictures'.
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
  FADE_FROM as SCRIPT_FADE_FROM,
  FADE_TO as SCRIPT_FADE_TO,
  IN_ICO as SCRIPT_IN_ICO,
  MASKABLE as SCRIPT_MASKABLE,
  MASKABLE_SCALE,
  SIZES as SCRIPT_SIZES,
  SMALL as SCRIPT_SMALL,
  SOURCE,
  SOURCE_SMALL,
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
/** A picture's pixels as premultiplied linear light, 4 floats each (r, g, b, alpha); `faded`, as
 *  a maskable icon draws it (each pixel times `weight` of its distance from the middle). */
function linearPicture(which: Which, faded: boolean): Float32Array {
  const key = `${which}${faded ? ' faded' : ''}`;
  let out = premultiplied.get(key);
  if (out === undefined) {
    const png = picture(which);
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
 * committed files can be compared to it. The small picture is not drawn whole: its tile's box
 * (`tileBox`), the shorter side of it, is scaled to the icon and centred on the tile, so that the
 * tile fills the box (`scale` is for the others).
 */
function reduced(size: number, scale: number, which: Which, maskable: boolean): Uint8Array {
  const source = linearPicture(which, maskable);
  const count = picture(which).width;
  let inner = size * scale;
  let offsetX = (size - inner) / 2;
  let offsetY = offsetX;
  if (which === 'small') {
    const box = tileBox(picture('small'));
    inner = (size * count) / Math.min(box.maxX - box.minX + 1, box.maxY - box.minY + 1);
    offsetX = size / 2 - (((box.minX + box.maxX + 1) / 2) * inner) / count;
    offsetY = size / 2 - (((box.minY + box.maxY + 1) / 2) * inner) / count;
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

  test("the small picture's tile is drawn to fill the box: its opaque box is x 18 to 1232, y 29 to 1228, the middle half of each side of the three small files is opaque, the corners are not", () => {
    // The small picture has a transparent margin of 18 to 29 pixels (of 1254) around its tile; one
    // pixel of a 16 pixel file is 78 of them, so drawn whole the outer rows and columns were only
    // partly covered (alpha 162 to 199 at 16, an empty top row at 48): a soft grey rim on a light
    // bar. The files take the shorter side of the tile's box (1200 pixels), centred on the tile.
    assert.deepEqual(tileBox(picture('small')), { minX: 18, maxX: 1232, minY: 29, maxY: 1228 });
    for (const size of SMALL_SIZES) {
      const png = decodePng(read(`${ICONS}/icon-${size}.png`));
      for (let t = Math.ceil(size / 4); t < Math.floor((3 * size) / 4); t++) {
        for (const [x, y] of [
          [t, 0],
          [t, size - 1],
          [0, t],
          [size - 1, t],
        ] as const) {
          assert.ok(alpha(png, x, y) >= OPAQUE, `icon-${size}.png: pixel ${x},${y} is not opaque`);
        }
      }
      assert.deepEqual(corners(png), [0, 0, 0, 0], `icon-${size}.png`);
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
