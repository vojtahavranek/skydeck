/**
 * S2 6.4: a stable interop socket for the programs of the window. `<runtimeDir>/interop` is a
 * symbolic link the server points at the first candidate that accepts a unix connection:
 * `/run/WSL/1_interop`, the keep-alive's own `$WSL_INTEROP` (`keepalive.interop`, which lives as
 * long as the keep-alive), the server's own `$WSL_INTEROP`. Every terminal's program gets
 * `WSL_INTEROP=<runtimeDir>/interop`, and the Windows programs skydeck starts use it too.
 */

import type { Platform } from '../platform/types.ts';
import type { RuntimeFiles } from './runtime.ts';

/** The first candidate of S2 6.4: the interop socket of the distribution's init. */
const FIRST_CANDIDATE = '/run/WSL/1_interop';
/** How long a connection to a socket may take before the probe says nothing (a local socket answers at once). */
const PROBE_MS = 2_000;

export interface Interop {
  /**
   * Points the link at the first candidate that accepts a connection now and resolves to the
   * link's path; with none, removes the link and resolves to null. A refresh asked for while one
   * runs gets that one's answer. Rejects when the link cannot be written or removed.
   */
  refresh(): Promise<string | null>;
  /** What the last refresh resolved to: the link's path, or null (also before the first). */
  current(): string | null;
}

/** S2 6.4's interop link in `files.interop`. */
export function createInterop(platform: Platform, files: RuntimeFiles): Interop {
  return createInteropFrom(platform, files, FIRST_CANDIDATE);
}

/** A path a candidate may be: absolute, one line, no NUL. */
function isSocketPath(text: string | null | undefined): text is string {
  return typeof text === 'string' && text.startsWith('/') && !/[\0\n\r]/.test(text);
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

/**
 * One unix connection to `path`, closed at once: 'accepts'; 'refused' when the connection is
 * refused or the path is gone (ECONNREFUSED, ENOENT) — nothing listens there any more; 'unknown'
 * for anything else (another error, no answer within 2 s, a `path` that is not an absolute
 * one-line path): no judgement. The interop link (S2 6.4) and the keep-alive (S2 6.1) both judge
 * a socket by it.
 */
export function probeSocket(
  platform: Platform,
  path: string | null,
): Promise<'accepts' | 'refused' | 'unknown'> {
  if (!isSocketPath(path)) {
    return Promise.resolve('unknown');
  }
  return new Promise((resolve) => {
    let settled = false;
    let cancel = (): void => {};
    const settle = (answer: 'accepts' | 'refused' | 'unknown'): void => {
      if (!settled) {
        settled = true;
        cancel();
        resolve(answer);
      }
    };
    cancel = platform.clock.after(PROBE_MS, () => {
      settle('unknown');
    });
    platform.net.connectUnix(path).then(
      (connection) => {
        connection.destroy();
        settle('accepts');
      },
      (error: unknown) => {
        const code = errorCode(error);
        settle(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'refused' : 'unknown');
      },
    );
  });
}

/**
 * createInterop with S2 6.4's first candidate given instead of `/run/WSL/1_interop`: `runServer`'s
 * `interopFirst` (A32), so that a test points it into its sandbox.
 */
export function createInteropFrom(platform: Platform, files: RuntimeFiles, first: string): Interop {
  let current: string | null = null;
  let running: Promise<string | null> | null = null;

  /** keepalive.interop's content; nothing when it cannot be read (no keep-alive, or not yet). */
  const keepAliveInterop = (): string | null => {
    try {
      return platform.files.readText(files.keepaliveInterop);
    } catch {
      return null;
    }
  };

  /**
   * The socket a candidate leads to, symbolic links resolved — so that the link never points at
   * another link, and never at itself: the server's own WSL_INTEROP is the link when the server
   * was started from a terminal of the window. null when it leads nowhere.
   */
  const socketOf = (candidate: string): string | null => {
    try {
      return platform.files.realpath(candidate);
    } catch {
      return null;
    }
  };

  /** The first socket, in S2 6.4's order, that accepts a connection now. */
  const choose = async (): Promise<string | null> => {
    const candidates = [first, keepAliveInterop(), platform.env.WSL_INTEROP].filter(isSocketPath);
    for (const candidate of candidates) {
      const socket = socketOf(candidate);
      if (
        socket !== null &&
        socket !== files.interop &&
        (await probeSocket(platform, socket)) === 'accepts'
      ) {
        return socket;
      }
    }
    return null;
  };

  const point = async (): Promise<string | null> => {
    const socket = await choose();
    current = null;
    if (socket === null) {
      if (platform.files.lstat(files.interop)?.kind === 'symlink') {
        platform.files.remove(files.interop);
      }
      return null;
    }
    if (platform.files.readlink(files.interop) !== socket) {
      platform.files.symlink(socket, files.interop);
    }
    current = files.interop;
    return current;
  };

  return {
    refresh() {
      running ??= point().finally(() => {
        running = null;
      });
      return running;
    },
    current: () => current,
  };
}
