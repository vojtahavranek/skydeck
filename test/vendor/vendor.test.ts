// The vendored-files check (S2 16.6, 17.5; plan A3, A5, A13): `vendor/` is exactly what
// `npm run vendor` makes from the installed development dependencies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import pkg from '../../package.json' with { type: 'json' };
import { applyPatch, vendor } from '../../scripts/vendor.ts';
import type { ManifestEntry } from '../../src/window/vendor.ts';
import { sandbox } from '../helpers/sandbox.ts';

const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const script = join(checkout, 'scripts/vendor.ts');

const NOTICES = 'vendor/xterm/THIRD-PARTY-NOTICES';

/**
 * The code @xterm/addon-unicode-graphemes 0.4.0 bundles without a notice (ruling on #38), and the
 * sha256 of the LICENSE file each package publishes on npm: from `npm pack tiny-inflate@1.0.3`
 * and `npm pack unicode-trie@2.0.0` (unicode-trie 1.0.0 and 3.0.0 publish the same bytes).
 */
const THIRD_PARTY = [
  {
    header: '======== tiny-inflate 1.0.3 (npm), its LICENSE file ========',
    sha256: 'c0df7f551401f8f80197ff31bf69b8cd23727d127423403282514d242a3ab132',
  },
  {
    header: '======== unicode-trie 2.0.0 (npm), its LICENSE file ========',
    sha256: '43439dbd4f43837aadab215cdbe5a422cc6323a50c4ea84d8d6bbc3671666a1d',
  },
];

const LICENSE_REASON =
  'no LICENSE in the package; its package.json declares MIT and the repository of @xterm/xterm';

/** A3: the vendored files, by package directory, and the third-party notices. */
const EXPECTED_FILES = [
  'vendor/xterm/THIRD-PARTY-NOTICES',
  'vendor/xterm/addon-fit/LICENSE',
  'vendor/xterm/addon-fit/lib/addon-fit.d.mts',
  'vendor/xterm/addon-fit/lib/addon-fit.mjs',
  'vendor/xterm/addon-fit/typings/addon-fit.d.ts',
  'vendor/xterm/addon-search/LICENSE',
  'vendor/xterm/addon-search/lib/addon-search.d.mts',
  'vendor/xterm/addon-search/lib/addon-search.mjs',
  'vendor/xterm/addon-search/typings/addon-search.d.ts',
  'vendor/xterm/addon-serialize/LICENSE',
  'vendor/xterm/addon-serialize/lib/addon-serialize.d.mts',
  'vendor/xterm/addon-serialize/lib/addon-serialize.mjs',
  'vendor/xterm/addon-serialize/typings/addon-serialize.d.ts',
  'vendor/xterm/addon-unicode-graphemes/LICENSE',
  'vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.d.mts',
  'vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs',
  'vendor/xterm/addon-unicode-graphemes/typings/addon-unicode-graphemes.d.ts',
  'vendor/xterm/headless/LICENSE',
  'vendor/xterm/headless/lib-headless/xterm-headless.d.mts',
  'vendor/xterm/headless/lib-headless/xterm-headless.mjs',
  'vendor/xterm/headless/typings/xterm-headless.d.ts',
  'vendor/xterm/xterm/LICENSE',
  'vendor/xterm/xterm/css/xterm.css',
  'vendor/xterm/xterm/lib/xterm.d.mts',
  'vendor/xterm/xterm/lib/xterm.mjs',
  'vendor/xterm/xterm/typings/xterm.d.ts',
];

/** A5: the exact development dependencies of this task. */
const PINNED: Record<string, string> = {
  '@xterm/xterm': '6.0.0',
  '@xterm/headless': '6.0.0',
  '@xterm/addon-serialize': '0.14.0',
  '@xterm/addon-fit': '0.11.0',
  '@xterm/addon-search': '0.16.0',
  '@xterm/addon-unicode-graphemes': '0.4.0',
  ws: '8.23.0',
  '@types/ws': '8.18.2',
};

/** Every file under `dir`, as paths relative to `base`, sorted. */
function tree(dir: string, base: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        out.push(relative(base, path));
      }
    }
  };
  walk(dir);
  return out.sort();
}

function manifest(root: string): ManifestEntry[] {
  return (JSON.parse(readFileSync(join(root, 'vendor/MANIFEST.json'), 'utf8')) as {
    files: ManifestEntry[];
  }).files;
}

const committed = manifest(checkout);

/**
 * cpSync's filter for copying `base`: leaves out the packages' `src/` and source maps, judged by
 * the path inside `base` (the checkout itself may lie under a directory called `src`).
 */
function withoutSources(base: string): (src: string) => boolean {
  return (src) => {
    const inside = relative(base, src);
    return !/(^|\/)src(\/|$)/.test(inside) && !inside.endsWith('.map');
  };
}

/** A copy of the installed `node_modules/@xterm` in a sandbox (without sources and maps). */
function fixtureModules(t: TestContext): string {
  const root = sandbox(t).root;
  const installed = join(checkout, 'node_modules/@xterm');
  cpSync(installed, join(root, 'from/node_modules/@xterm'), {
    recursive: true,
    filter: withoutSources(installed),
  });
  return root;
}

/** Asserts that `<root>/vendor/` holds exactly the committed files, byte for byte. */
function assertCommittedVendor(root: string): void {
  const files = tree(join(root, 'vendor'), root);
  assert.deepEqual(files, tree(join(checkout, 'vendor'), checkout));
  for (const path of files) {
    assert.ok(
      readFileSync(join(root, path)).equals(readFileSync(join(checkout, path))),
      `${path} differs from the committed one`,
    );
  }
}

/** Changes fields of the fixture's `package.json` of `dir` (`@xterm/<dir>`). */
function alterPackage(root: string, dir: string, fields: Record<string, unknown>): void {
  const path = join(root, 'from/node_modules/@xterm', dir, 'package.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...json, ...fields }));
}

/**
 * Every import specifier in `text` that a browser could not resolve: a static `import`/`export …
 * from`, a side-effect `import '…'` or a dynamic `import('…')` whose specifier does not start
 * with `./`, `../` or `/`.
 */
function bareImports(text: string): string[] {
  const patterns = [
    /\bfrom\s*(['"`])([^'"`]*)\1/g,
    /\bimport\s*(['"`])([^'"`]*)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`]*)\1/g,
  ];
  return patterns
    .flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[2] ?? ''))
    .filter((specifier) => !/^(\.\/|\.\.\/|\/)/.test(specifier));
}

describe('npm run vendor', () => {
  test('reproduces the committed vendor/ byte for byte', (t) => {
    const s = sandbox(t);

    const run = spawnSync(process.execPath, [script, s.root], { encoding: 'utf8', env: s.env() });

    assert.equal(run.status, 0, run.stderr);
    assertCommittedVendor(s.root);
  });

  test('the vendored files are exactly those of A3, and the manifest lists each of them', () => {
    assert.deepEqual(tree(join(checkout, 'vendor/xterm'), checkout), EXPECTED_FILES);
    assert.deepEqual(
      committed.map((e) => e.path),
      EXPECTED_FILES,
    );
  });

  test('replaces what was there before: a stale file is gone', (t) => {
    const s = sandbox(t);
    mkdirSync(join(s.root, 'vendor/xterm/xterm/lib'), { recursive: true });
    writeFileSync(join(s.root, 'vendor/xterm/xterm/lib/xterm.mjs.map'), '{}');

    vendor({ from: checkout, to: s.root });

    assertCommittedVendor(s.root);
  });
});

describe('the manifest', () => {
  test('is sorted by path', () => {
    const paths = committed.map((e) => e.path);
    assert.deepEqual(paths, [...paths].sort());
  });

  test("every version but the shims' is the installed one and package.json's exact one", () => {
    const devDependencies: Record<string, string> = pkg.devDependencies;
    for (const entry of committed.filter((e) => e.package !== 'skydeck')) {
      const installed = JSON.parse(
        readFileSync(join(checkout, 'node_modules', entry.package, 'package.json'), 'utf8'),
      ) as { version: string };
      assert.equal(entry.version, installed.version, entry.path);
      assert.equal(devDependencies[entry.package], entry.version, entry.path);
    }
  });

  test('package.json pins the development dependencies of A5 exactly', () => {
    const devDependencies: Record<string, string> = pkg.devDependencies;
    for (const [name, version] of Object.entries(PINNED)) {
      assert.equal(devDependencies[name], version, name);
    }
    for (const [name, version] of Object.entries(devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is not pinned to an exact version`);
    }
  });

  test('the shims and the notices: package skydeck, version -; one .d.mts beside each .mjs', () => {
    const shims = committed.filter((e) => e.path.endsWith('.d.mts'));
    const bundles = committed.filter((e) => e.path.endsWith('.mjs'));
    assert.deepEqual(
      shims.map((e) => e.path),
      bundles.map((e) => e.path.replace(/\.mjs$/, '.d.mts')),
    );
    for (const shim of shims) {
      assert.equal(shim.package, 'skydeck', shim.path);
      assert.equal(shim.version, '-', shim.path);
    }
    assert.deepEqual(
      committed.filter((e) => e.package === 'skydeck').map((e) => e.path),
      [NOTICES, ...shims.map((e) => e.path)].sort(),
    );
    const notices = committed.find((e) => e.path === NOTICES);
    assert.equal(notices?.package, 'skydeck');
    assert.equal(notices?.version, '-');
  });

  test('every package directory has a LICENSE', () => {
    const dirs = readdirSync(join(checkout, 'vendor/xterm'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.equal(dirs.length, 6);
    for (const dir of dirs) {
      const path = `vendor/xterm/${dir}/LICENSE`;
      assert.ok(existsSync(join(checkout, path)), path);
      assert.ok(
        committed.some((e) => e.path === path),
        `${path} is not in the manifest`,
      );
    }
  });

  test("headless and addon-serialize carry @xterm/xterm's LICENSE, with the reason", () => {
    const xtermLicense = readFileSync(join(checkout, 'node_modules/@xterm/xterm/LICENSE'));
    for (const [dir, name] of [
      ['headless', '@xterm/headless'],
      ['addon-serialize', '@xterm/addon-serialize'],
    ] as const) {
      const path = `vendor/xterm/${dir}/LICENSE`;
      const entry = committed.find((e) => e.path === path);
      assert.equal(entry?.package, name);
      assert.equal(entry?.licenseFrom, '@xterm/xterm');
      assert.equal(entry?.licenseReason, LICENSE_REASON);
      assert.ok(readFileSync(join(checkout, path)).equals(xtermLicense), path);
    }
  });

  test('no other entry carries licenseFrom or licenseReason', () => {
    const borrowed = committed.filter(
      (e) => e.licenseFrom !== undefined || e.licenseReason !== undefined,
    );
    assert.deepEqual(
      borrowed.map((e) => e.path),
      ['vendor/xterm/addon-serialize/LICENSE', 'vendor/xterm/headless/LICENSE'],
    );
  });
});

describe('the licence check', () => {
  test('refuses a package without LICENSE whose package.json declares another licence', (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'headless', { license: 'ISC' });

    assert.throws(() => vendor({ from: join(root, 'from'), to: root }), /@xterm\/headless.*licen/);
    assert.equal(existsSync(join(root, 'vendor')), false);
  });

  test('refuses a package without LICENSE that declares no licence', (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'addon-serialize', { license: undefined });

    assert.throws(() => vendor({ from: join(root, 'from'), to: root }), /@xterm\/addon-serialize/);
    assert.equal(existsSync(join(root, 'vendor')), false);
  });

  test('refuses a package without LICENSE from another repository', (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'addon-serialize', {
      repository: 'https://github.com/someone/xterm.js/tree/master/addons/addon-serialize',
    });

    assert.throws(
      () => vendor({ from: join(root, 'from'), to: root }),
      /@xterm\/addon-serialize.*repository/,
    );
    assert.equal(existsSync(join(root, 'vendor')), false);
  });

  test('refuses a package without LICENSE that names no repository', (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'headless', { repository: undefined });

    assert.throws(() => vendor({ from: join(root, 'from'), to: root }), /@xterm\/headless/);
  });

  test('the fixture copy judges sources and maps by the path inside the copied directory', () => {
    const keep = withoutSources('/home/u/src/skydeck/node_modules/@xterm');

    assert.equal(keep('/home/u/src/skydeck/node_modules/@xterm'), true);
    assert.equal(keep('/home/u/src/skydeck/node_modules/@xterm/xterm/lib/xterm.mjs'), true);
    assert.equal(keep('/home/u/src/skydeck/node_modules/@xterm/xterm/src'), false);
    assert.equal(keep('/home/u/src/skydeck/node_modules/@xterm/xterm/src/a/b.ts'), false);
    assert.equal(keep('/home/u/src/skydeck/node_modules/@xterm/xterm/lib/xterm.mjs.map'), false);
  });

  for (const [name, breakIt] of [
    ['a licence it cannot vouch for', (root: string) => alterPackage(root, 'headless', { license: 'ISC' })],
    ['a missing file', (root: string) => rmSync(join(root, 'from/node_modules/@xterm/addon-fit/typings/addon-fit.d.ts'))],
  ] as const) {
    test(`a refusal for ${name} leaves an existing vendor/ as it was, byte for byte`, (t) => {
      const root = fixtureModules(t);
      cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
      breakIt(root);

      assert.throws(() => vendor({ from: join(root, 'from'), to: root }));
      assertCommittedVendor(root);
    });
  }

  test('refuses a package without LICENSE from another repository of the same owner', (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'headless', { repository: 'https://github.com/xtermjs/xterm.js-other' });

    assert.throws(() => vendor({ from: join(root, 'from'), to: root }), /@xterm\/headless.*repository/);
  });

  test("refuses when @xterm/xterm itself has no LICENSE (there is none to borrow)", (t) => {
    const root = fixtureModules(t);
    rmSync(join(root, 'from/node_modules/@xterm/xterm/LICENSE'));

    assert.throws(() => vendor({ from: join(root, 'from'), to: root }), /@xterm\/xterm.*LICENSE/);
  });

  test("accepts the registry's form of the same repository (git+https, .git, #branch)", (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'addon-serialize', {
      repository: { type: 'git', url: 'git+https://github.com/xtermjs/xterm.js.git#master' },
    });

    const entries = vendor({ from: join(root, 'from'), to: root });

    assert.equal(
      entries.find((e) => e.path === 'vendor/xterm/addon-serialize/LICENSE')?.licenseFrom,
      '@xterm/xterm',
    );
  });

  test('refuses when a file of A3 is missing in the package, naming it', (t) => {
    const root = fixtureModules(t);
    rmSync(join(root, 'from/node_modules/@xterm/addon-fit/lib/addon-fit.mjs'));

    assert.throws(
      () => vendor({ from: join(root, 'from'), to: root }),
      /@xterm\/addon-fit.*lib\/addon-fit\.mjs/,
    );
    assert.equal(existsSync(join(root, 'vendor')), false);
  });
});

const SERIALIZE = 'vendor/xterm/addon-serialize/lib/addon-serialize.mjs';

/**
 * The patch of addon-serialize 0.14.0, restated as the specification: the vendored bundle must be
 * the installed one with exactly these replacements. The screen side's tests show what they fix;
 * its other two defects (review 2's re-check, N1 and N2) are corrected by the screen side on the
 * serialised text, not here.
 */
const REPLACEMENTS: Array<[string, string]> = [
  // _diffStyle: SGR 22 turns off both bold and dim (#48, review 2, finding 1).
  [
    'e.isBold()!==r.isBold()&&t.push(e.isBold()?1:22),',
    '(e.isBold()!==r.isBold()||e.isDim()!==r.isDim())&&(!e.isBold()&&r.isBold()||!e.isDim()&&r.isDim()?(t.push(22),e.isBold()&&t.push(1),e.isDim()&&t.push(2)):(e.isBold()!==r.isBold()&&t.push(1),e.isDim()!==r.isDim()&&t.push(2))),',
  ],
  [',e.isDim()!==r.isDim()&&t.push(e.isDim()?2:22)', ''],
];

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe("the patch of addon-serialize's bundle (ruled on #48)", () => {
  const installed = readFileSync(join(checkout, 'node_modules/@xterm', SERIALIZE.slice(13)));
  const vendored = readFileSync(join(checkout, SERIALIZE));
  const entry = committed.find((e) => e.path === SERIALIZE);

  test('the manifest keeps the upstream hash and pins the patched one', () => {
    assert.equal(entry?.upstreamSha256, sha256Of(installed));
    assert.equal(entry?.sha256, sha256Of(vendored));
    assert.notEqual(entry?.sha256, entry?.upstreamSha256);
    assert.match(entry?.patch ?? '', /_diffStyle/);
    assert.match(entry?.patch ?? '', /22/);
  });

  test('the bundle is the installed one with exactly the replacements of the patch', () => {
    const before = installed.toString('utf8');
    const after = vendored.toString('utf8');

    for (const [old, replacement] of REPLACEMENTS) {
      assert.equal(before.split(old).length, 2, `not once in the installed bundle: ${old}`);
      if (!replacement.includes(old)) {
        assert.equal(after.includes(old), false, `still in the vendored bundle: ${old}`);
      }
    }
    assert.equal(after, applyPatch(before, REPLACEMENTS));
  });

  test('no other entry carries upstreamSha256 or patch', () => {
    assert.deepEqual(
      committed
        .filter((e) => e.upstreamSha256 !== undefined || e.patch !== undefined)
        .map((e) => e.path),
      [SERIALIZE],
    );
  });

  test('running the script twice gives the same bytes', (t) => {
    const s = sandbox(t);

    vendor({ from: checkout, to: s.root });
    const first = tree(join(s.root, 'vendor'), s.root).map((p) => readFileSync(join(s.root, p)));
    vendor({ from: checkout, to: s.root });
    const second = tree(join(s.root, 'vendor'), s.root).map((p) => readFileSync(join(s.root, p)));

    assert.deepEqual(second, first);
    assertCommittedVendor(s.root);
  });

  test('applyPatch replaces each text that occurs exactly once, and refuses any other count', () => {
    assert.equal(
      applyPatch('a-b-c', [
        ['a', 'x'],
        ['-c', ''],
      ]),
      'x-b',
    );
    assert.throws(() => applyPatch('a-b-a', [['a', 'x']]), /2 times/);
    assert.throws(() => applyPatch('a-b', [['c', 'x']]), /0 times/);
  });

  for (const [name, breakIt, error] of [
    [
      'a bundle that is not the one the patch was written for',
      (root: string) =>
        appendFileSync(join(root, 'from/node_modules/@xterm', SERIALIZE.slice(13)), '\n'),
      /addon-serialize.*not the file/,
    ],
    [
      'another version of addon-serialize',
      (root: string) => alterPackage(root, 'addon-serialize', { version: '0.15.0' }),
      /@xterm\/addon-serialize 0\.15\.0.*patch/,
    ],
  ] as const) {
    test(`refuses ${name}, and leaves an existing vendor/ as it was`, (t) => {
      const root = fixtureModules(t);
      cpSync(join(checkout, 'vendor'), join(root, 'vendor'), { recursive: true });
      breakIt(root);

      assert.throws(() => vendor({ from: join(root, 'from'), to: root }), error);
      assertCommittedVendor(root);
    });
  }
});

describe('the third-party notices', () => {
  const text = readFileSync(join(checkout, NOTICES), 'utf8');

  test("say that addon-serialize's bundle is modified, how, and why", () => {
    assert.ok(text.includes(SERIALIZE), text);
    assert.match(text, /modified/);
    assert.match(text, /SGR 22/);
  });

  test('name the bundle that contains the code, and its package and version', () => {
    assert.ok(
      text.includes('vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs'),
      text,
    );
    assert.ok(text.includes('@xterm/addon-unicode-graphemes 0.4.0'), text);
    assert.ok(text.includes('tiny-inflate') && text.includes('unicode-trie'), text);
  });

  for (const { header, sha256 } of THIRD_PARTY) {
    test(`hold the published licence verbatim: ${header}`, () => {
      const start = text.indexOf(`\n${header}\n`);
      assert.ok(start >= 0, `no line ${header}`);
      const body = text.slice(start + header.length + 2);
      const next = body.indexOf('\n======== ');
      const license = next < 0 ? body : body.slice(0, next); // a blank line separates the sections
      assert.equal(createHash('sha256').update(license).digest('hex'), sha256, license);
      assert.match(license, /Copyright/);
    });
  }

  test('the script refuses another version of addon-unicode-graphemes: its bundle must be checked again', (t) => {
    const root = fixtureModules(t);
    alterPackage(root, 'addon-unicode-graphemes', { version: '0.5.0' });

    assert.throws(
      () => vendor({ from: join(root, 'from'), to: root }),
      /@xterm\/addon-unicode-graphemes 0\.5\.0.*THIRD-PARTY-NOTICES/,
    );
    assert.equal(existsSync(join(root, 'vendor')), false);
  });
});

describe('the vendored bundles', () => {
  test('the bare-import check finds bare specifiers and passes relative ones', () => {
    assert.deepEqual(bareImports(`import{a}from"x";export*from'y';import'z';import("w")`), [
      'x',
      'y',
      'z',
      'w',
    ]);
    assert.deepEqual(bareImports(`import{a}from"./x";import("../y");import"/z"`), []);
  });

  for (const path of EXPECTED_FILES.filter((p) => p.endsWith('.mjs'))) {
    test(`${path} imports nothing by a bare name`, () => {
      assert.deepEqual(bareImports(readFileSync(join(checkout, path), 'utf8')), []);
    });
  }

  test('the shims give tsc the vendored typings, with nothing but vendor/ in reach', (t) => {
    const s = sandbox(t);
    cpSync(join(checkout, 'vendor'), join(s.root, 'vendor'), { recursive: true });
    const web = join(s.root, 'web');
    mkdirSync(web);
    const paths = Object.fromEntries(
      committed
        .filter((e) => e.path.endsWith('.d.ts'))
        .map((e) => [e.package, [`../${e.path}`]]),
    );
    writeFileSync(
      join(web, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es2025',
          lib: ['es2025', 'dom'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          strict: true,
          noEmit: true,
          allowJs: true,
          checkJs: true,
          paths,
        },
        include: ['.'],
      }),
    );
    writeFileSync(join(web, 'package.json'), '{ "type": "module" }');
    writeFileSync(
      join(web, 'app.js'),
      [
        "import { Terminal } from '../vendor/xterm/xterm/lib/xterm.mjs';",
        "import { FitAddon } from '../vendor/xterm/addon-fit/lib/addon-fit.mjs';",
        "import { SearchAddon } from '../vendor/xterm/addon-search/lib/addon-search.mjs';",
        "import { SerializeAddon } from '../vendor/xterm/addon-serialize/lib/addon-serialize.mjs';",
        "import { UnicodeGraphemesAddon } from '../vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs';",
        "/** @import { Terminal as Headless } from '../vendor/xterm/headless/lib-headless/xterm-headless.mjs' */",
        'const term = new Terminal({ scrollback: 100 });',
        'const fit = new FitAddon();',
        'term.loadAddon(fit);',
        'term.loadAddon(new SearchAddon());',
        'term.loadAddon(new UnicodeGraphemesAddon());',
        '/** @type {string} */',
        'const text = new SerializeAddon().serialize();',
        '/** @type {number} */',
        'const cols = term.cols;',
        '/** @param {Headless} h @returns {number} */',
        'const rows = (h) => h.rows;',
        '// @ts-expect-error: the types are real, not any',
        'term.noSuchMethod();',
        'export { text, cols, rows };',
        '',
      ].join('\n'),
    );
    const tsc = join(checkout, 'node_modules/typescript/bin/tsc');

    const run = spawnSync(process.execPath, [tsc, '-p', web, '--listFilesOnly'], {
      encoding: 'utf8',
      env: s.env(),
    });
    const check = spawnSync(process.execPath, [tsc, '-p', web], { encoding: 'utf8', env: s.env() });

    assert.equal(check.status, 0, check.stdout + check.stderr);
    const read = run.stdout.split('\n').filter((line) => line.startsWith(s.root));
    assert.ok(read.every((path) => !path.endsWith('.mjs')), 'tsc read a bundle');
    assert.ok(read.includes(join(s.root, 'vendor/xterm/xterm/typings/xterm.d.ts')), run.stdout);
  });
});
