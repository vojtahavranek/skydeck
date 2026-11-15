// The page's own icon (S2 12.12; plan E14, task 94): the committed files of web/icons/ and
// web/manifest.webmanifest, read from the checkout. scripts/icons.ts made the PNG and ICO files
// once from web/icons/skydeck.svg; no test runs it, so these cases hold what it wrote.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import * as prettier from 'prettier';

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
/** The tile's colour (the page's accent, `#2f6fde`): the maskable icons' full background. */
const TILE = [0x2f, 0x6f, 0xde];
/** How far a pixel may differ from the background and still count as background: at 153.6 and
 *  409.6 pixels the tile's edge leaves a seam one step off the background, which no eye sees. */
const SEAM = 2;

/** The sha256 of web/icons/skydeck.svg as scripts/icons.ts last drew it. */
const SVG_SHA256 = '0544fd2a8abb4a2ab523c4a57c815953499442afd3a24973ad8323ae4c2e10a8';

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

/** The only chunks the files may hold: no metadata (a text chunk could carry a name or a path of
 *  the machine that drew them, in a file the server serves). */
const CHUNKS = ['IHDR', 'IDAT', 'IEND'];

/**
 * Just enough of PNG to look at the pixels: 8-bit RGB or RGBA, not interlaced, IHDR first, only
 * the chunks of CHUNKS, and nothing after IEND.
 */
function decodePng(bytes: Buffer): Png {
  assert.deepEqual(bytes.subarray(0, 8), SIGNATURE, 'the PNG signature');
  let at = 8;
  let header: Buffer | null = null;
  const data: Buffer[] = [];
  let ended = false;
  while (!ended) {
    assert.ok(at + 12 <= bytes.length, 'the file ends before IEND');
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    assert.ok(CHUNKS.includes(type), `a chunk ${JSON.stringify(type)}`);
    if (header === null) {
      assert.equal(type, 'IHDR', 'IHDR comes first');
    }
    if (type === 'IHDR') {
      header = body;
    } else if (type === 'IDAT') {
      data.push(body);
    } else {
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
  return { width, height, bitDepth, colourType, pixels, channels };
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

  test("the maskable ones: the drawing on the tile's colour, inside the safe zone (a circle of 0.4 of the size)", () => {
    for (const { file, size } of MASKABLE) {
      const png = decodePng(read(`${ICONS}/${file}`));
      const background = rgb(png, 0, 0);
      const drawn = (x: number, y: number): boolean =>
        rgb(png, x, y).some((value, i) => Math.abs(value - (background[i] ?? 0)) > SEAM);

      assert.deepEqual(background, TILE, `${file}: the background is the tile's colour`);
      assert.ok(drawn(size >> 1, size >> 1), `${file}: the drawing is there`);
      let farthest = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (drawn(x, y)) {
            farthest = Math.max(farthest, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
          }
        }
      }
      assert.ok(farthest <= 0.4 * size, `${file}: drawn ${farthest / size} of the size out`);
    }
  });

  test('of web/icons/ the server reads exactly the source, the seven PNGs and favicon.ico', (t) => {
    const { platform } = testPlatform(t);

    // What the build holds and the server serves; an editor's `.skydeck.svg.swp` is neither.
    const served = [...readBuild(platform.files, checkout).files.keys()]
      .filter((path) => path.startsWith(`${ICONS}/`))
      .map((path) => path.slice(ICONS.length + 1));

    assert.deepEqual(
      served.sort(),
      ['favicon.ico', 'skydeck.svg', ...PNGS.map((p) => p.file)].sort(),
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

/** The elements and attributes a drawing of shapes needs; nothing in them runs, loads or names a
 *  file. */
const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'rect',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'linearGradient',
  'radialGradient',
  'stop',
]);
const SVG_ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'id',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'd',
  'points',
  'x1',
  'y1',
  'x2',
  'y2',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'transform',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
]);
/** A paint: a colour, none, or a gradient of the file itself. */
const PAINT = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|none|url\(#[A-Za-z][\w-]*\))$/;

/**
 * What in the SVG is outside what a self-contained drawing may hold (plan task 94: no script, no
 * `on…` attribute, no foreignObject, no reference outside the file, no `@import`). It allows
 * rather than forbids, so that no spelling slips past: only the elements and attributes above, no
 * prefixed name (`s:script`, `xml:base`, `inkscape:…`), the SVG namespace only, a paint for
 * `fill` and `stroke`, no `url(` elsewhere, no `&` (no character reference can spell anything),
 * no `<!` but a comment, no `<?`, and no text between the tags. One line per thing found; none
 * for a clean file.
 */
function outsideAllowed(svg: string): string[] {
  const found: string[] = [];
  const text = svg.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const [what, pattern] of [
    ['a DOCTYPE, an entity or a CDATA section', /<!/],
    ['a processing instruction', /<\?/],
    ['a character or entity reference', /&/],
  ] as const) {
    if (pattern.test(text)) {
      found.push(what);
    }
  }
  const tag = /<\/?([^\s/>]+)([^>]*)>/g;
  const between = text.replace(tag, '').trim();
  if (between !== '') {
    found.push(`text outside the tags: ${JSON.stringify(between.slice(0, 40))}`);
  }
  for (const [, name = '', rest = ''] of text.matchAll(tag)) {
    if (!SVG_ELEMENTS.has(name)) {
      found.push(`the element ${name}`);
    }
    const attribute = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const [, attr = '', double, single] of rest.matchAll(attribute)) {
      const value = double ?? single ?? '';
      if (!SVG_ATTRIBUTES.has(attr)) {
        found.push(`the attribute ${attr} of ${name}`);
      } else if (attr === 'fill' || attr === 'stroke') {
        if (!PAINT.test(value)) {
          found.push(`the paint ${JSON.stringify(value)} of ${name}`);
        }
      } else if (attr === 'xmlns') {
        if (value !== 'http://www.w3.org/2000/svg') {
          found.push(`the namespace ${JSON.stringify(value)}`);
        }
      } else if (/url\(/i.test(value)) {
        found.push(`a url( in ${attr} of ${name}`);
      }
    }
    const left = rest.replace(attribute, '').replace(/\/$/, '').trim();
    if (left !== '') {
      found.push(`${JSON.stringify(left.slice(0, 40))} in the tag ${name}`);
    }
  }
  return found;
}

describe('web/icons/skydeck.svg', () => {
  test('holds only shapes: no script, no reference outside the file, no image', () => {
    assert.deepEqual(outsideAllowed(read(`${ICONS}/skydeck.svg`).toString('utf8')), []);
  });

  test('is the drawing the committed PNG files were made from', () => {
    // Nothing draws in a test (ruled): this hash notices an edit of the SVG without a new run.
    assert.equal(
      createHash('sha256')
        .update(read(`${ICONS}/skydeck.svg`))
        .digest('hex'),
      SVG_SHA256,
      'web/icons/skydeck.svg changed: run node scripts/icons.ts, commit what it wrote, then put the new hash here',
    );
  });

  test('is square and in the SVG namespace', () => {
    const svg = read(`${ICONS}/skydeck.svg`).toString('utf8');
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? assert.fail('no <svg> element');

    assert.match(root, /\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const viewBox = /\sviewBox="0 0 (\d+) (\d+)"/.exec(root) ?? assert.fail('no viewBox');
    assert.equal(viewBox[1], viewBox[2]);
  });

  test('the check refuses each thing a drawing must not hold, in every spelling tried', () => {
    const svg = (inner: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${inner}</svg>`;

    assert.deepEqual(
      outsideAllowed(
        svg(
          '<!-- a note --><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/>' +
            '</linearGradient></defs><rect fill=\'url(#g)\' stroke="none"/>',
        ),
      ),
      [],
    );
    for (const inner of [
      '<script>alert(1)</script>',
      '<SCRIPT/>',
      '<rect onload="x()"/>',
      '<rect\nONCLICK="x()"/>',
      '<foreignObject/>',
      '<image href="#a"/>',
      '<use href="https://example.com/a.svg#a"/>',
      '<use xlink:href="data:image/svg+xml,x"/>',
      '<use href=a.svg#x />',
      '<rect fill="url(https://example.com/x)"/>',
      '<rect style="fill:url( \'x.svg#g\')"/>',
      '<style>@import "x.css";</style>',
      '<!ENTITY x SYSTEM "file:///etc/passwd">',
      '<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>',
      '<s:foreignObject xmlns:s="http://www.w3.org/2000/svg"/>',
      '<s:image xmlns:s="http://www.w3.org/2000/svg" href="x.png"/>',
      '<a><set attributeName="href" to="https://example.com/"/></a>',
      '<animate attributeName="xlink:href" values="https://example.com/a.svg#x"/>',
      '<rect style="fill:u\\72l(https://example.com/x.svg#g)"/>',
      '<style>@\\69mport "https://example.com/x.css";</style>',
      '<iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/"/>',
      '<g xml:base="https://example.com/"/>',
      '<metadata><x inkscape:export-filename="/home/u/icon.png"/></metadata>',
      '<!DOCTYPE svg>',
      '<rect fill="url(https://example.com/x.svg#g)"/>',
      '<rect fill="u&#114;l(x.svg#g)"/>',
      '<rect fill="red"/>',
      '<rect x="1" onload="x()"/>',
      '<rect x=1 />',
      '<rect transform="url(x)"/>',
      '<title>a</title>',
      'text',
      '<?xml-stylesheet href="x.css"?>',
      '<![CDATA[x]]>',
    ]) {
      assert.notDeepEqual(outsideAllowed(svg(inner)), [], inner);
    }
    assert.notDeepEqual(
      outsideAllowed('<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 64 64"></svg>'),
      [],
      'another namespace',
    );
  });
});
