// The python3 the window's keepers run (S2 2, 7.1): the one found on PATH, asked for its version
// with `python3 --version` — the only program install starts, and the one doctor starts besides
// gh and wezterm (S2 16.1, 16.3). 3.9 is the oldest the keeper's code allows.
import type { Env, Platform } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';

const TIMEOUT_MS = 10_000;
/** `Python 3.12.3`: what `--version` prints (python 3 on stdout, python 2 on stderr). */
const VERSION = /^Python ([0-9]+)\.([0-9]+)(?:\.[0-9A-Za-z+.-]*)?\s*$/m;

export type Python3 =
  | { kind: 'found'; version: string } // 3.9 or newer
  | { kind: 'old'; version: string } // older than 3.9
  | { kind: 'missing' } // not on PATH
  | { kind: 'failed'; why: string }; // it ran but gave no version: an exit status, a timeout

/** The environment a program runs in: the platform's, without unset entries. */
function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * `python3 --version` in the platform's environment, and what it says. Never throws: a python3 the
 * system refuses to start (EACCES: no execute bit, a PATH directory that cannot be searched) is
 * `failed`, with the error's code (describeError, never a message that could quote anything).
 */
export async function probePython3(platform: Platform): Promise<Python3> {
  let result: Awaited<ReturnType<Platform['runner']['run']>>;
  try {
    result = await platform.runner.run('python3', ['--version'], {
      timeoutMs: TIMEOUT_MS,
      env: definedEnv(platform.env),
    });
  } catch (error) {
    return { kind: 'failed', why: describeError(error) };
  }
  if (result.notFound) {
    return { kind: 'missing' };
  }
  if (result.timedOut) {
    return { kind: 'failed', why: 'timed out' };
  }
  if (result.code !== 0) {
    const line = (result.stderr.split('\n')[0] ?? '').trim();
    return {
      kind: 'failed',
      why:
        line !== ''
          ? line
          : result.code === null
            ? 'ended without a status'
            : `exit ${result.code}`,
    };
  }
  const match = VERSION.exec(`${result.stdout}\n${result.stderr}`);
  if (match === null) {
    return { kind: 'failed', why: 'its answer names no version' };
  }
  const version = match[0].slice('Python '.length).trim();
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const newEnough = major > 3 || (major === 3 && minor >= 9);
  return { kind: newEnough ? 'found' : 'old', version };
}

/** S2 16.1's line, printed by install when the window could not run its keepers. */
export const PYTHON3_NEEDED =
  'the window (skydeck window) needs python3 3.9 or newer; the commands do not';
