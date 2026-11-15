// The page's own icon (S2 12.12; plan E14, task 94): the committed files of web/icons/ and
// web/manifest.webmanifest, read from the checkout. scripts/icons.ts made the PNG and ICO files
// once from web/icons/skydeck.svg; no test runs it, so these cases hold what it wrote.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import * as prettier from 'prettier';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const read = (path: string): Buffer => readFileSync(join(checkout, path));

const ICONS = 'web/icons';
/** The five drawn on a transparent background, and the two maskable ones on a full one. */
const TRANSPARENT = [16, 32, 48, 192, 512].map((size) => ({ file: `icon-${size}.png`, size }));
const MASKABLE = [192, 512].map((size) => ({ file: `icon-${size}-maskable.png`, size }));
const PNGS = [...TRANSPARENT, ...MASKABLE];
const IN_ICO = [16, 32, 48];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Png {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  /** Row by row, 4 bytes (RGBA) or 3 (RGB) per pixel, the filters undone. */
  pixels: Buffer;
  channels: number;
}

/** Just enough of PNG to look at the pixels: 8-bit RGB or RGBA, not interlaced. */
function decodePng(bytes: Buffer): Png {
  assert.deepEqual(bytes.subarray(0, 8), SIGNATURE, 'the PNG signature');
  let at = 8;
  let header: Buffer | null = null;
  const data: Buffer[] = [];
  let ended = false;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
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
  assert.ok(header !== null && ended, 'IHDR and IEND');
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
  return { width, height, bitDepth, colourType, pixels, channels };
}

/** The alpha of a pixel: 255 for an image without alpha. */
function alpha(png: Png, x: number, y: number): number {
  return png.channels === 4 ? (png.pixels[(y * png.width + x) * 4 + 3] ?? -1) : 255;
}

function corners(png: Png): number[] {
  const last = png.width - 1;
  return [alpha(png, 0, 0), alpha(png, last, 0), alpha(png, 0, last), alpha(png, last, last)];
}

describe('the PNG files', () => {
  test('each has its size, 8 bits per channel; the five on a transparent background have alpha', () => {
    for (const { file, size } of PNGS) {
      const png = decodePng(read(`${ICONS}/${file}`));
      assert.equal(png.width, size, file);
      assert.equal(png.height, size, file);
      assert.equal(png.bitDepth, 8, file);
      if (TRANSPARENT.some((t) => t.file === file)) {
        assert.equal(png.colourType, 6, `${file}: RGBA`);
      }
    }
  });

  test('the five are transparent at the corners and opaque in the middle', () => {
    for (const { file, size } of TRANSPARENT) {
      const png = decodePng(read(`${ICONS}/${file}`));
      assert.deepEqual(corners(png), [0, 0, 0, 0], file);
      assert.equal(alpha(png, size >> 1, size >> 1), 255, file);
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

  test('web/icons/ holds exactly the source, the seven PNGs and favicon.ico', () => {
    assert.deepEqual(
      readdirSync(join(checkout, ICONS)).sort(),
      ['favicon.ico', 'skydeck.svg', ...PNGS.map((p) => p.file)].sort(),
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

describe('web/manifest.webmanifest', () => {
  const manifest = (): unknown => JSON.parse(read('web/manifest.webmanifest').toString('utf8'));

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

/**
 * What the SVG must not hold (plan task 94): a script, an `on…` attribute, a foreignObject, an
 * image, a reference outside the file (`href`, `xlink:href` or `url(` to anything but `#…`), an
 * `@import`, a DOCTYPE or an entity (a comment is allowed). Lower-cased first, so that no spelling
 * slips past.
 */
function forbidden(svg: string): string[] {
  const text = svg.toLowerCase();
  const found: string[] = [];
  for (const [what, pattern] of [
    ['a script', /<script/],
    ['an on… attribute', /\son[a-z]*\s*=/],
    ['a foreignObject', /<foreignobject/],
    ['an image', /<image/],
    ['an href outside the file', /href\s*=(?!\s*["']?\s*#)/],
    ['a url( outside the file', /url\((?!\s*["']?\s*#)/],
    ['an @import', /@import/],
    ['a DOCTYPE or an entity', /<!(?!--)/],
  ] as const) {
    if (pattern.test(text)) {
      found.push(what);
    }
  }
  return found;
}

describe('web/icons/skydeck.svg', () => {
  test('holds no script, no reference outside the file, no image', () => {
    assert.deepEqual(forbidden(read(`${ICONS}/skydeck.svg`).toString('utf8')), []);
  });

  test('is square and in the SVG namespace', () => {
    const svg = read(`${ICONS}/skydeck.svg`).toString('utf8');
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? assert.fail('no <svg> element');

    assert.match(root, /\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const viewBox = /\sviewBox="0 0 (\d+) (\d+)"/.exec(root) ?? assert.fail('no viewBox');
    assert.equal(viewBox[1], viewBox[2]);
  });

  test('the check finds each thing it looks for', () => {
    const svg = (inner: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${inner}</svg>`;

    assert.deepEqual(
      forbidden(
        svg('<!-- a note --><rect fill="url(#g)"/><use href = " #a"/><use xlink:href=\'#b\'/>'),
      ),
      [],
    );
    for (const [inner, what] of [
      ['<script>alert(1)</script>', 'a script'],
      ['<SCRIPT/>', 'a script'],
      ['<rect onload="x()"/>', 'an on… attribute'],
      ['<rect\nONCLICK="x()"/>', 'an on… attribute'],
      ['<foreignObject/>', 'a foreignObject'],
      ['<image href="#a"/>', 'an image'],
      ['<use href="https://example.com/a.svg#a"/>', 'an href outside the file'],
      ['<use xlink:href="data:image/svg+xml,x"/>', 'an href outside the file'],
      ['<use href=a.svg#x />', 'an href outside the file'],
      ['<rect fill="url(https://example.com/x)"/>', 'a url( outside the file'],
      ['<rect style="fill:url( \'x.svg#g\')"/>', 'a url( outside the file'],
      ['<style>@import "x.css";</style>', 'an @import'],
      ['<!ENTITY x SYSTEM "file:///etc/passwd">', 'a DOCTYPE or an entity'],
      ['<!DOCTYPE svg>', 'a DOCTYPE or an entity'],
    ] as const) {
      assert.ok(forbidden(svg(inner)).includes(what), `${inner}: ${what}`);
    }
  });
});
