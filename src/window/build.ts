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
 * Every file of the build, read once: path relative to the app root → its bytes, in the order of
 * the sorted paths, and the build computed over them. Links are followed (a link to a file counts
 * by its own name with the target's content); a directory already being walked, which a link
 * leads back to, is not walked again. A missing directory gives no files.
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
      const info = files.stat(join(appRoot, child)); // null: gone since listed, or a dangling link
      if (info === null || leftOut(name, info.kind)) {
        continue;
      }
      if (info.kind === 'dir') {
        walk(child, [...ancestors, real]);
      } else if (info.kind === 'file') {
        found.push([child, files.readBytes(join(appRoot, child), 0, info.size)]);
      }
    }
  };
  for (const dir of BUILD_DIRS) {
    if (files.stat(join(appRoot, dir))?.kind === 'dir') {
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
