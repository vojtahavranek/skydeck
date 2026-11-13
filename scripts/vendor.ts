// `npm run vendor` (S2 16.6; plan A3): copies the files of xterm.js the window uses from the
// installed development dependencies into vendor/xterm/<package directory>/<path in the package>,
// writes a `.d.mts` shim beside each bundle and vendor/MANIFEST.json. Users run what is committed;
// nothing is fetched at install time. test/vendor/vendor.test.ts fails when the two drift apart.
//
// Usage: node scripts/vendor.ts [<directory>]   (writes <directory>/vendor/; the checkout by default)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ManifestEntry } from '../src/window/vendor.ts';

/** A package `@xterm/<dir>` and the paths inside it that are vendored (besides its licence). */
interface VendoredPackage {
  dir: string;
  files: string[];
}

const PACKAGES: VendoredPackage[] = [
  { dir: 'xterm', files: ['lib/xterm.mjs', 'css/xterm.css', 'typings/xterm.d.ts'] },
  { dir: 'headless', files: ['lib-headless/xterm-headless.mjs', 'typings/xterm-headless.d.ts'] },
  ...['addon-serialize', 'addon-fit', 'addon-search', 'addon-unicode-graphemes'].map((dir) => ({
    dir,
    files: [`lib/${dir}.mjs`, `typings/${dir}.d.ts`],
  })),
];

/** The package whose licence file stands in for a package that ships none (A3, ruling 1). */
const LICENSE_SOURCE = '@xterm/xterm';
const LICENSE_REASON = `no LICENSE in the package; its package.json declares MIT and the repository of ${LICENSE_SOURCE}`;

/**
 * Code that @xterm/addon-unicode-graphemes bundles without a notice of its own (ruling on #38):
 * the licence of each package exactly as its LICENSE file is published on npm. Checked for the
 * bundle of `UNICODE_GRAPHEMES_CHECKED`; another version must be checked again (the script
 * refuses it until then).
 */
const UNICODE_GRAPHEMES_CHECKED = '0.4.0';
const NOTICES_PATH = 'vendor/xterm/THIRD-PARTY-NOTICES';
const THIRD_PARTY: Array<{ header: string; license: string }> = [
  {
    header: '======== tiny-inflate 1.0.3 (npm), its LICENSE file ========',
    license: `MIT License

Copyright (c) 2015-present Devon Govett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  },
  {
    header: '======== unicode-trie 2.0.0 (npm), its LICENSE file ========',
    license: `Copyright 2018

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

`,
  },
];
const NOTICES = [
  'Third-party code in the vendored xterm.js files',
  '',
  'vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs, the bundle of',
  `@xterm/addon-unicode-graphemes ${UNICODE_GRAPHEMES_CHECKED}, contains adapted copies of two packages by Devon Govett:`,
  'tiny-inflate and unicode-trie (in xterm.js: addons/addon-unicode-graphemes/src/third-party/).',
  'The package ships no notice for them; its LICENSE names only the xterm.js authors. Their',
  'licences follow, each exactly as the package publishes its LICENSE file on npm. unicode-trie',
  'is cited at 2.0.0, the line that decompresses with tiny-inflate as the copy does; every',
  'published version of unicode-trie has the same LICENSE. tiny-inflate says in its readme that',
  "it is a port of Joergen Ibsen's tinf.",
  '',
  'Written by scripts/vendor.ts.',
  '',
  ...THIRD_PARTY.flatMap(({ header, license }) => [header, license]),
].join('\n');

export interface VendorOptions {
  /** The directory whose `node_modules/@xterm/*` is copied. */
  from: string;
  /** The directory that receives `vendor/`. */
  to: string;
}

interface PackageJson {
  version: string;
  license?: unknown;
  repository?: unknown;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * `host/owner/repository` of a package.json `repository` (a string or `{ url }`), lowercase, or
 * null. Ignores `git+`, the scheme, a user, `.git`, a `#branch` and a path inside the repository,
 * so `https://github.com/o/r/tree/master/addons/a` and `git+https://github.com/o/r.git#master`
 * are both `github.com/o/r`.
 */
function repositoryKey(repository: unknown): string | null {
  const url =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? repository.url
        : null;
  if (typeof url !== 'string') {
    return null;
  }
  const rest = url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/#.*$/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
    .replace(/^[^@/]+@/, '') // user
    .replace(/^([^/:]+):/, '$1/') // git@host:owner/repository
    .replace(/^www\./, '');
  const [host, owner, repo] = rest.split('/');
  const name = repo?.replace(/\.git$/, '');
  return host && owner && name ? `${host}/${owner}/${name}` : null;
}

/** The manifest entries and bytes of everything `vendor/` will hold, checked, nothing written. */
function collect(from: string): Array<{ entry: ManifestEntry; bytes: Uint8Array }> {
  const read = (name: string, path: string): Uint8Array | null => {
    try {
      return readFileSync(join(from, 'node_modules', name, path));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  };
  const needed = (name: string, path: string): Uint8Array => {
    const bytes = read(name, path);
    if (bytes === null) {
      throw new Error(`${name} has no ${path}; run npm ci`);
    }
    return bytes;
  };
  const packageJson = (name: string): PackageJson => {
    const json = JSON.parse(Buffer.from(needed(name, 'package.json')).toString('utf8')) as unknown;
    if (typeof json !== 'object' || json === null || !('version' in json)) {
      throw new Error(`${name}: package.json has no version`);
    }
    return json as PackageJson;
  };
  const sourceRepository = repositoryKey(packageJson(LICENSE_SOURCE).repository);

  const out: Array<{ entry: ManifestEntry; bytes: Uint8Array }> = [];
  const add = (path: string, bytes: Uint8Array, name: string, version: string): ManifestEntry => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry: ManifestEntry = { path, package: name, version, sha256 };
    out.push({ entry, bytes });
    return entry;
  };

  for (const { dir, files } of PACKAGES) {
    const name = `@xterm/${dir}`;
    const { version, license, repository } = packageJson(name);
    const base = `vendor/xterm/${dir}`;
    const typings = files.find((f) => f.endsWith('.d.ts'));
    for (const file of files) {
      add(`${base}/${file}`, needed(name, file), name, version);
      if (file.endsWith('.mjs') && typings !== undefined) {
        // The bundle's types are the package's typings, re-exported by the package's name (the
        // typings of the addons import '@xterm/xterm' by name and augment their own module, so a
        // relative re-export would find nothing). A tsconfig can map each name to the vendored
        // typings with "paths"; without that, tsc finds the same bytes in node_modules.
        const shim = file.replace(/\.mjs$/, '.d.mts');
        const text = [
          `// Written by scripts/vendor.ts. The types of ${basename(file)}, so that tsc never reads the bundle:`,
          `// the package's typings, by its name; they are vendored in ${relative(dirname(shim), typings)}.`,
          `export * from '${name}';`,
          '',
        ].join('\n');
        add(`${base}/${shim}`, Buffer.from(text, 'utf8'), 'skydeck', '-');
      }
    }
    const own = read(name, 'LICENSE');
    if (own !== null) {
      add(`${base}/LICENSE`, own, name, version);
      continue;
    }
    if (name === LICENSE_SOURCE) {
      throw new Error(`${name} has no LICENSE`);
    }
    if (license !== 'MIT') {
      throw new Error(
        `${name} has no LICENSE and its package.json does not declare the MIT licence`,
      );
    }
    if (sourceRepository === null || repositoryKey(repository) !== sourceRepository) {
      throw new Error(
        `${name} has no LICENSE and its package.json does not name the repository of ${LICENSE_SOURCE}`,
      );
    }
    const entry = add(`${base}/LICENSE`, needed(LICENSE_SOURCE, 'LICENSE'), name, version);
    entry.licenseFrom = LICENSE_SOURCE;
    entry.licenseReason = LICENSE_REASON;
  }
  const graphemes = packageJson('@xterm/addon-unicode-graphemes').version;
  if (graphemes !== UNICODE_GRAPHEMES_CHECKED) {
    throw new Error(
      `@xterm/addon-unicode-graphemes ${graphemes} is not the version whose bundle ${NOTICES_PATH} was written for (${UNICODE_GRAPHEMES_CHECKED}): check the third-party code it bundles and update the notices in scripts/vendor.ts`,
    );
  }
  add(NOTICES_PATH, Buffer.from(NOTICES, 'utf8'), 'skydeck', '-');
  return out.sort((a, b) =>
    a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0,
  );
}

/**
 * Replaces `<to>/vendor/xterm/` and `<to>/vendor/MANIFEST.json` with the files of A3 from
 * `<from>/node_modules`. Throws, before writing anything, when a file is missing or a licence
 * cannot be vouched for. Returns the manifest's entries.
 */
export function vendor({ from, to }: VendorOptions): ManifestEntry[] {
  const files = collect(from);
  rmSync(join(to, 'vendor/xterm'), { recursive: true, force: true });
  for (const { entry, bytes } of files) {
    const path = join(to, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const entries = files.map((f) => f.entry);
  writeFileSync(
    join(to, 'vendor/MANIFEST.json'),
    `${JSON.stringify({ files: entries }, null, 2)}\n`,
  );
  return entries;
}

if (import.meta.main) {
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error('usage: node scripts/vendor.ts [<directory>]');
    process.exitCode = 2;
  } else {
    const to = resolve(args[0] ?? checkout);
    try {
      const entries = vendor({ from: checkout, to });
      console.log(
        `vendor: wrote ${entries.length} files and the manifest to ${join(to, 'vendor')}`,
      );
    } catch (error) {
      console.error(`vendor: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
