// The build of a checkout (S2 16.5): the hash that tells a running server from the code on disk.
// `skydeck window` computes it for the checkout; the server computes it over the bytes it read at
// start and serves exactly those bytes (`assets.ts`), so the two meet only when nothing changed.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Files } from '../platform/types.ts';

/** The directories of the app root whose files make the build. */
const BUILD_DIRS = ['bin', 'src', 'web', 'vendor'];

/**
 * Left out at any depth (A12): names starting with '.', and `__pycache__` directories, which
 * `python3 -m py_compile` writes into bin/ and which would change the build for nothing.
 */
function leftOut(name: string, kind: string): boolean {
  return name.startsWith('.') || (kind === 'dir' && name === '__pycache__');
}

/**
 * `fn()`, or null when the path is not there: gone (ENOENT, ENOTDIR; a file git or an editor
 * replaces is unlinked, then created) or a link that leads nowhere (ELOOP). Such a file is no file
 * of the build, whether it went before its stat or before its read; any other error is thrown.
 */
function unlessGone<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      return null;
    }
    throw error;
  }
}

/**
 * Every file of the build, read once: path relative to the app root → its bytes, in the order of
 * the sorted paths, and the build computed over them. Links are followed (a link to a file counts
 * by its own name with the target's content); a directory already being walked, which a link
 * leads back to, is not walked again. A missing directory, a dangling link, a link to itself and a
 * file removed while it is read give no files.
 */
export function readBuild(
  files: Files,
  appRoot: string,
): { build: string; files: Map<string, Uint8Array> } {
  const found: Array<[string, Uint8Array]> = [];
  const walk = (path: string, ancestors: readonly string[]): void => {
    const real = files.realpath(join(appRoot, path));
    if (real === null || ancestors.includes(real)) {
      return;
    }
    for (const name of files.list(join(appRoot, path))) {
      const child = `${path}/${name}`;
      const info = unlessGone(() => files.stat(join(appRoot, child)));
      if (info === null || leftOut(name, info.kind)) {
        continue;
      }
      if (info.kind === 'dir') {
        walk(child, [...ancestors, real]);
      } else if (info.kind === 'file') {
        const bytes = unlessGone(() => files.readBytes(join(appRoot, child), 0, info.size));
        if (bytes !== null) {
          found.push([child, bytes]);
        }
      }
    }
  };
  for (const dir of BUILD_DIRS) {
    if (unlessGone(() => files.stat(join(appRoot, dir)))?.kind === 'dir') {
      walk(dir, []);
    }
  }
  found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // by UTF-16 code unit, as Files.list
  const hash = createHash('sha256');
  for (const [path, bytes] of found) {
    // A path holds no NUL, and the length bounds the content: no two trees hash the same input.
    hash.update(`${path}\0${bytes.byteLength}\0`).update(bytes);
  }
  return { build: hash.digest('hex').slice(0, 16), files: new Map(found) };
}

/** sha256 over the sorted paths and contents of every file under bin/, src/, web/, vendor/ (A12), first 16 hex. */
export function computeBuild(files: Files, appRoot: string): string {
  return readBuild(files, appRoot).build;
}
