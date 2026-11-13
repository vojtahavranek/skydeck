import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isAlive } from '../../src/claude/live.ts';
import { realPlatform } from '../../src/platform/real.ts';
import type { Sandbox } from './sandbox.ts';

/** Asserts that `path` lies strictly inside the sandbox's root (which has no symlinks). */
function assertInside(s: Sandbox, path: string, what: string): void {
  assert.ok(
    path.startsWith(`${s.root}/`),
    `killKeepersIn: ${what} ${path} is not inside the sandbox ${s.root}; nothing was signalled`,
  );
}

/** `<pid> <process start> <boot id>`, and for a keeper `<version> <started>` (S2 4.2); null if not that. */
function parseLine(text: string): { pid: number; procStart: number; bootId: string } | null {
  const fields = text.replace(/\n$/, '').split(' ');
  if (fields.length !== 3 && fields.length !== 5) {
    return null;
  }
  const [pid, procStart, bootId] = fields;
  if (!/^[0-9]+$/.test(pid ?? '') || !/^[0-9]+$/.test(procStart ?? '') || !bootId) {
    return null;
  }
  return { pid: Number(pid), procStart: Number(procStart), bootId };
}

/**
 * Kills (SIGKILL) the keepers whose `terms/<id>.pid` line in `runtimeDir` is alive by design 5.5's
 * rule (A34): the boot id, the pid and its process start all match. Before it reads a single line
 * it asserts that `runtimeDir`, its real path, the real path of `terms/` and of every `.pid` file
 * lie inside the sandbox's root, so that a wrongly resolved directory can never reach the user's
 * real keepers. A dead line, a garbled one, a temporary file and this process (or its parent) are
 * skipped. A directory that does not exist is nothing to do. Killing a keeper ends its program
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
    const file = realpathSync(join(realTerms, name));
    assertInside(s, file, 'the real path of');
    lines.push(readFileSync(file, 'utf8'));
  }

  const { proc, processes } = realPlatform({ refuseWindows: true });
  const bootId = proc.bootId();
  for (const text of lines) {
    const line = parseLine(text);
    if (
      line === null ||
      line.pid <= 1 ||
      line.pid === process.pid ||
      line.pid === process.ppid ||
      !isAlive(line, proc, bootId)
    ) {
      continue;
    }
    processes.signal(line.pid, 'SIGKILL');
  }
}
