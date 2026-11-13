import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { realPlatform } from '../../src/platform/real.ts';
import type { Proc } from '../../src/platform/types.ts';
import { parsePidLine, pidLineState } from '../../src/window/pidline.ts';
import type { Sandbox } from './sandbox.ts';

/** Asserts that `path` lies strictly inside the sandbox's root (which has no symlinks). */
function assertInside(s: Sandbox, path: string, what: string): void {
  assert.ok(
    path.startsWith(`${s.root}/`),
    `killKeepersIn: ${what} ${path} is not inside the sandbox ${s.root}; nothing was signalled`,
  );
}

/** The entry vanished meanwhile: a keeper removes its own `.pid` file when it ends (S2 4.2). */
function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Kills (SIGKILL) the keepers whose `terms/<id>.pid` line in `runtimeDir` is alive by design 5.5's
 * rule (A34, `pidLineState` of src/window/pidline.ts): the boot id, the pid and its process start
 * all match. A line whose process could not be read ('unknown') is not signalled; the others are,
 * and then the helper throws, naming the unknown pids. Before it reads a single line
 * it asserts that `runtimeDir`, its real path, the real path of `terms/` and of every `.pid` file
 * lie inside the sandbox's root, so that a wrongly resolved directory can never reach the user's
 * real keepers; every assertion is made before the first signal. A dead line, a garbled one, a
 * temporary file, an entry that vanished meanwhile or is not a file, and this process (or its
 * parent) are skipped. A directory that does not exist is nothing to do. Killing a keeper ends its program
 * (SIGHUP from its pty).
 */
export function killKeepersIn(s: Sandbox, runtimeDir: string): void {
  const given = resolve(runtimeDir);
  assertInside(s, given, 'the runtime directory');
  if (!existsSync(given)) {
    return;
  }
  assertInside(s, realpathSync(given), 'the real path of the runtime directory');
  const terms = join(given, 'terms');
  if (!existsSync(terms)) {
    return;
  }
  const realTerms = realpathSync(terms);
  assertInside(s, realTerms, 'the real path of terms/');
  const lines: string[] = [];
  for (const name of readdirSync(realTerms)) {
    if (name.startsWith('.') || !name.endsWith('.pid')) {
      continue; // `.<name>.tmp` while a keeper rewrites its line, sockets, anything else
    }
    let text: string;
    try {
      const file = realpathSync(join(realTerms, name));
      assertInside(s, file, 'the real path of');
      if (!statSync(file).isFile()) {
        continue; // a directory or a socket named *.pid: no line to read
      }
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (isGone(error)) {
        continue; // removed (or a link left dangling) since the listing: no keeper to signal here
      }
      throw error;
    }
    lines.push(text);
  }

  const { proc, processes } = realPlatform({ refuseWindows: true });
  const { kill, unknown } = keepersToKill(lines, proc, proc.bootId(), [process.pid, process.ppid]);
  for (const pid of kill) {
    processes.signal(pid, 'SIGKILL');
  }
  if (unknown.length > 0) {
    throw new Error(
      `killKeepersIn: could not tell whether ${unknown.join(', ')} still run; not signalled`,
    );
  }
}

/**
 * The decision of killKeepersIn, without signalling (pure but for `proc`): of the `.pid` lines'
 * texts, the pids alive by design 5.5's rule (`pidLineState` 'alive') are to kill, those it could
 * not tell are unknown. A dead, garbled or non-keeper line, pid 1 and the pids of `own` (this
 * process and its parent) are in neither. `bootId` is the current one, read once by the caller.
 */
export function keepersToKill(
  lines: readonly string[],
  proc: Proc,
  bootId: string | null,
  own: readonly number[],
): { kill: number[]; unknown: number[] } {
  const kill: number[] = [];
  const unknown: number[] = [];
  for (const text of lines) {
    const line = parsePidLine(text);
    if (line === null || line.pid <= 1 || own.includes(line.pid)) {
      continue;
    }
    const state = pidLineState(line, proc, bootId);
    if (state === 'alive') {
      kill.push(line.pid);
    } else if (state === 'unknown') {
      unknown.push(line.pid); // could not be read: never signalled, and the test is told
    }
  }
  return { kill, unknown };
}
