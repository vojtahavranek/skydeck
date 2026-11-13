import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export interface Sandbox {
  /** The temporary directory everything below lives in. Its real path, with no symlinks. */
  root: string;
  home: string;
  /** `SKYDECK_HOME`: the data, state and config directories are `data`, `state`, `config` in it. */
  skydeckHome: string;
  /** A stand-in for `~/.claude`, reached through `CLAUDE_CONFIG_DIR`. */
  claudeHome: string;
  /** The only directory on the sandbox's `PATH`; empty until a test links programs into it. */
  bin: string;
  /** Links system programs (found in /usr/bin or /bin) into `bin`; one already there is kept. */
  link: (...programs: string[]) => void;
  /**
   * The complete environment for a child process. Nothing is inherited from the developer's
   * shell. Extra entries override the defaults; an entry set to `undefined` removes one. It
   * carries SKYDECK_TEST_NO_WINDOWS=1, so a skydeck started with it refuses Windows programs (A32).
   */
  env: (extra?: Record<string, string | undefined>) => Record<string, string>;
}

function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

/**
 * A temporary home, `SKYDECK_HOME` and Claude home, removed when the test ends. Every child
 * process a test starts takes its environment from `env()`, so a test can never touch the
 * developer's real `HOME`, `~/.claude` or `~/.local`.
 */
export function sandbox(t: TestContext): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skydeck-test-')));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const skydeckHome = join(root, 'skydeck-home');
  const claudeHome = join(root, 'claude-home');
  const bin = join(root, 'bin');
  for (const dir of [home, skydeckHome, claudeHome, bin]) {
    mkdirSync(dir);
  }
  return {
    root,
    home,
    skydeckHome,
    claudeHome,
    bin,
    link: (...programs) => {
      for (const program of programs) {
        if (lstatOrNull(join(bin, program)) !== null) {
          continue;
        }
        const real = ['/usr/bin', '/bin'].map((d) => join(d, program)).find((p) => existsSync(p));
        assert.ok(real, `${program} not found on this machine`);
        symlinkSync(real, join(bin, program));
      }
    },
    env: (extra = {}) => {
      const merged: Record<string, string | undefined> = {
        HOME: home,
        SKYDECK_HOME: skydeckHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        PATH: bin,
        SKYDECK_TEST_NO_WINDOWS: '1',
        ...extra,
      };
      return Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
    },
  };
}
