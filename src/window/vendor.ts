// The vendored xterm.js files and their manifest (S2 16.6; plan A3). `scripts/vendor.ts` writes
// both; `doctor` and the server check the files against the manifest before using them.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Files } from '../platform/types.ts';

/** One file of `vendor/MANIFEST.json`. */
export interface ManifestEntry {
  /** Relative to the checkout (the app root), always under `vendor/xterm/`. */
  path: string;
  /** The npm package the file comes from; `skydeck` for the `.d.mts` shims the script writes. */
  package: string;
  /** The package's exact version; `-` for the shims. */
  version: string;
  /** Lowercase hex. */
  sha256: string;
  /** The package whose licence file this is, when the package itself ships none (A3). */
  licenseFrom?: string;
  /** Why the licence file was taken from `licenseFrom`. */
  licenseReason?: string;
  /**
   * For a file skydeck patches (S2 16.6): the sha256 of the file as the package ships it, which
   * the script checks before patching; `sha256` is the patched file's. Always with `patch`.
   */
  upstreamSha256?: string;
  /** For a patched file: what the patch changes and why. Always with `upstreamSha256`. */
  patch?: string;
}

const MANIFEST = 'vendor/MANIFEST.json';

type Loaded =
  | { ok: true; entries: ManifestEntry[] }
  | { ok: false; problem: 'missing' | 'invalid' | 'unreadable'; code?: string };

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'error';
}

/**
 * A path relative to the checkout, under `vendor/xterm/`, whose segments are made of ASCII
 * letters, digits, `.`, `_` and `-` only and are not `.` or `..`: no backslash, space or control
 * character of any kind, so a problem line can name it as it is.
 */
function isVendoredPath(path: string): boolean {
  return (
    path.startsWith('vendor/xterm/') &&
    path.split('/').every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..')
  );
}

const isString = (value: unknown): value is string => typeof value === 'string';

function entryOf(value: unknown): ManifestEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const {
    path,
    package: name,
    version,
    sha256,
    licenseFrom,
    licenseReason,
    upstreamSha256,
    patch,
  } = value as Record<string, unknown>;
  if (
    !isString(path) ||
    !isVendoredPath(path) ||
    !isString(name) ||
    !isString(version) ||
    !isString(sha256) ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    (licenseFrom !== undefined && !isString(licenseFrom)) ||
    (licenseReason !== undefined && !isString(licenseReason)) ||
    (upstreamSha256 === undefined) !== (patch === undefined) ||
    (upstreamSha256 !== undefined &&
      !(isString(upstreamSha256) && /^[0-9a-f]{64}$/.test(upstreamSha256))) ||
    (patch !== undefined && !isString(patch))
  ) {
    return null;
  }
  const entry: ManifestEntry = { path, package: name, version, sha256 };
  if (licenseFrom !== undefined) {
    entry.licenseFrom = licenseFrom;
  }
  if (licenseReason !== undefined) {
    entry.licenseReason = licenseReason;
  }
  if (isString(upstreamSha256) && isString(patch)) {
    entry.upstreamSha256 = upstreamSha256;
    entry.patch = patch;
  }
  return entry;
}

function load(files: Files, appRoot: string): Loaded {
  let text: string | null;
  try {
    text = files.readText(join(appRoot, MANIFEST));
  } catch (error) {
    return { ok: false, problem: 'unreadable', code: errorCode(error) };
  }
  if (text === null) {
    return { ok: false, problem: 'missing' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'invalid' }; // the error would quote the text; it says nothing more
  }
  const list: unknown =
    typeof json === 'object' && json !== null ? (json as { files?: unknown }).files : undefined;
  if (!Array.isArray(list)) {
    return { ok: false, problem: 'invalid' };
  }
  const entries: ManifestEntry[] = [];
  const paths = new Set<string>();
  for (const value of list) {
    const entry = entryOf(value);
    if (entry === null || paths.has(entry.path)) {
      return { ok: false, problem: 'invalid' };
    }
    paths.add(entry.path);
    entries.push(entry);
  }
  return { ok: true, entries };
}

/** The entries of `vendor/MANIFEST.json`; null when it is missing, unreadable or not a manifest. */
export function readManifest(files: Files, appRoot: string): ManifestEntry[] | null {
  const loaded = load(files, appRoot);
  return loaded.ok ? loaded.entries : null;
}

/** What is wrong with one listed file, or null when its bytes have the listed hash. */
function fileProblem(files: Files, appRoot: string, entry: ManifestEntry): string | null {
  const path = join(appRoot, entry.path);
  try {
    const info = files.stat(path);
    if (info === null) {
      return `${entry.path} is missing`;
    }
    if (info.kind !== 'file') {
      return `${entry.path} is not a file`;
    }
    const sha256 = createHash('sha256')
      .update(files.readBytes(path, 0, info.size))
      .digest('hex');
    return sha256 === entry.sha256 ? null : `${entry.path} differs from ${MANIFEST}`;
  } catch (error) {
    return `${entry.path} cannot be read (${errorCode(error)})`;
  }
}

/** One line per problem: a listed file missing, or its sha256 different; [] when all match. */
export function verifyVendored(files: Files, appRoot: string): string[] {
  const loaded = load(files, appRoot);
  if (!loaded.ok) {
    switch (loaded.problem) {
      case 'missing':
        return [`${MANIFEST} is missing`];
      case 'invalid':
        return [`${MANIFEST} is not a valid manifest`];
      case 'unreadable':
        return [`${MANIFEST} cannot be read (${loaded.code})`];
    }
  }
  if (loaded.entries.length === 0) {
    return [`${MANIFEST} lists no files`];
  }
  return loaded.entries
    .map((entry) => fileProblem(files, appRoot, entry))
    .filter((problem) => problem !== null);
}
