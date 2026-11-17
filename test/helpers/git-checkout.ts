/**
 * Throwaway git repositories for the tests of `skydeck update` (F8, hazard 1): a checkout under a
 * test's sandbox and, beside it, the bare repository that is its only remote, plus a second clone
 * of that remote through which a test adds the commits the update is to bring. Every test that
 * runs the real git goes through here, and so does every root `skydeck update` is run on:
 *
 * - a path that is not inside the sandbox's root is refused (thrown) before git is run on it, so
 *   that no test can reach this repository's own `.git` (the test platforms' default appRoot is
 *   the repository itself) or a checkout of the user's;
 * - the only remotes are paths inside the sandbox: nothing reaches the network;
 * - git sees no configuration of this machine: HOME is the sandbox's, GIT_CONFIG_NOSYSTEM=1, no
 *   XDG_CONFIG_HOME, and GIT_CEILING_DIRECTORIES stops a search for a repository at the sandbox's
 *   root; the identity of a test commit is given with the call (`-c user.name=…`), and the
 *   branch name with `init -b`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sandbox } from './sandbox.ts';

/** This repository: what a checkout that holds skydeck itself is copied from (never written). */
const REPOSITORY = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

/** What a copy of skydeck needs to run: what `computeBuild` hashes, and package.json. */
const SKYDECK_FILES = ['bin', 'src', 'web', 'vendor', 'package.json'];

/** The identity of every commit a test makes, given with the call. */
const IDENTITY = ['-c', 'user.name=skydeck test', '-c', 'user.email=test@skydeck.invalid'];

/** git's environment in a test: the sandbox's, without any configuration of this machine. */
export function gitTestEnv(s: Sandbox): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: s.root,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * `path` resolved, when it lies inside the sandbox's root (not the root itself); otherwise an
 * Error, and nothing is run. A path that exists is judged by its real path, so that a symbolic
 * link cannot lead out of the sandbox.
 */
export function insideSandbox(s: Sandbox, path: string): string {
  const absolute = resolve(path);
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // Not there yet: judged by its own path (its parents are checked when it is made).
  }
  for (const candidate of [absolute, real]) {
    const rel = relative(s.root, candidate);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`refused: ${path} is not inside the test sandbox ${s.root}`);
    }
  }
  return absolute;
}

export interface GitCheckout {
  /** The checkout `skydeck update` is run on (its app root): a real path inside the sandbox. */
  root: string;
  /** The bare repository the checkout's branch follows. */
  remote: string;
  /** The remote's name in the checkout (`origin` unless the test chose another). */
  remoteName: string;
  /** The branch of the checkout and of the remote. */
  branch: string;
  /** A second clone of the remote: commits made there and pushed are what the update brings. */
  other: string;
  /** git's environment (sandbox.env with gitTestEnv). */
  env: Record<string, string>;
  /** The absolute path of the real git. */
  gitPath: string;
  /** `git -C <dir> <args>`; its stdout. Throws when git fails. `dir` must be inside the sandbox. */
  git(dir: string, ...args: string[]): string;
  /** The full id of `rev` in `dir` (default: HEAD of the checkout). */
  id(rev?: string, dir?: string): string;
  /**
   * Writes `files` (a path relative to `dir` → its content; null removes it), commits them all in
   * `dir` with `message`, and returns the commit's full id.
   */
  commit(dir: string, message: string, files: Record<string, string | null>): string;
  /** commit() in `other`, then pushed to the remote; returns the new commit's id. */
  push(message: string, files: Record<string, string | null>): string;
}

export interface GitCheckoutOptions {
  /** The checkout's directory name under the sandbox's root; default `checkout`. */
  name?: string;
  /** Default `main`. */
  branch?: string;
  /** The remote's name in the checkout; default `origin`. */
  remoteName?: string;
  /**
   * What the first commit holds: `skydeck` copies this repository's bin, src, web, vendor and
   * package.json (a checkout whose launcher and server can run); a record is path → content.
   * Default: one README.
   */
  content?: 'skydeck' | Record<string, string>;
}

/**
 * A checkout `<sandbox>/<name>` with one commit on `branch`, pushed to the bare repository
 * `<sandbox>/<name>-remote.git`, which the branch follows as `<remoteName>/<branch>`, and a second
 * clone `<sandbox>/<name>-other` of that remote. Git must be linked into the sandbox's bin (it is,
 * here): the command under test finds it on the sandbox's PATH.
 */
export function gitCheckout(s: Sandbox, options: GitCheckoutOptions = {}): GitCheckout {
  const name = options.name ?? 'checkout';
  const branch = options.branch ?? 'main';
  const remoteName = options.remoteName ?? 'origin';
  s.link('git');
  const gitPath = realpathSync(join(s.bin, 'git'));
  const env = s.env(gitTestEnv(s));
  const root = insideSandbox(s, join(s.root, name));
  const remote = insideSandbox(s, join(s.root, `${name}-remote.git`));
  const other = insideSandbox(s, join(s.root, `${name}-other`));

  const git = (dir: string, ...args: string[]): string => {
    const inside = insideSandbox(s, dir);
    const r = spawnSync(gitPath, ['-C', inside, ...args], { env, encoding: 'utf8' });
    if (r.error !== undefined) throw r.error;
    if (r.status !== 0) {
      throw new Error(`git -C ${inside} ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
    }
    return r.stdout;
  };
  const id = (rev = 'HEAD', dir = root): string =>
    git(dir, 'rev-parse', '--verify', `${rev}^{commit}`).trim();
  const commit = (dir: string, message: string, files: Record<string, string | null>): string => {
    const inside = insideSandbox(s, dir);
    for (const [path, content] of Object.entries(files)) {
      const file = insideSandbox(s, join(inside, path));
      if (content === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
    git(inside, 'add', '--all');
    git(inside, ...IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', message);
    return id('HEAD', inside);
  };

  mkdirSync(root);
  if (options.content === 'skydeck') {
    for (const entry of SKYDECK_FILES) {
      cpSync(join(REPOSITORY, entry), join(root, entry), { recursive: true });
    }
  }
  git(root, 'init', '--quiet', '-b', branch);
  const first = options.content === 'skydeck' ? {} : (options.content ?? { 'README.md': 'one\n' });
  commit(root, 'the first commit', first);
  mkdirSync(remote);
  git(remote, 'init', '--quiet', '--bare', '-b', branch);
  git(root, 'remote', 'add', remoteName, remote);
  git(root, 'push', '--quiet', '--set-upstream', remoteName, branch);
  mkdirSync(other);
  git(other, 'clone', '--quiet', '--branch', branch, remote, '.');
  const push = (message: string, files: Record<string, string | null>): string => {
    const made = commit(other, message, files);
    git(other, 'push', '--quiet', 'origin', branch);
    return made;
  };
  return { root, remote, remoteName, branch, other, env, gitPath, git, id, commit, push };
}
