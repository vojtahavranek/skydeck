import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WindowConfig } from '../../src/platform/config.ts';
import type { Sandbox } from './sandbox.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `text` quoted for sh. */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Writes `<s.skydeckHome>/config/config.json` for a test that starts a server (A32): `window.edge`
 * is a stub script in the sandbox that records its arguments instead of starting Edge, and
 * `keepAlive` is `off`; `window` is merged over them (it may hold keys the configuration refuses,
 * for a test that wants them refused; a key given as undefined is left out). A config.json already there keeps its other keys and its
 * other `window` keys. `edgeCalls()` gives the arguments of every run of the stub, in order.
 */
export function writeWindowConfig(
  s: Sandbox,
  window: Partial<WindowConfig> & Record<string, unknown> = {},
): { edgeStub: string; edgeCalls(): string[][] } {
  const stubDir = join(s.root, 'edge-stub');
  mkdirSync(stubDir, { recursive: true });
  const edgeStub = join(stubDir, 'msedge');
  const record = join(stubDir, 'calls');
  // Each argument as `a<text>\0` and the end of a run as `e\0`: arguments cannot hold a NUL, so
  // any text (spaces, newlines, an empty argument) is recorded exactly. sh builtins only.
  writeFileSync(
    edgeStub,
    [
      '#!/bin/sh',
      `{ for a in "$@"; do printf 'a%s\\0' "$a"; done; printf 'e\\0'; } >> ${shQuote(record)}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const configDir = join(s.skydeckHome, 'config');
  const configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true });
  const existing: unknown = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {};
  assert.ok(isObject(existing), `${configPath} does not hold an object`);
  const own = isObject(existing['window']) ? existing['window'] : {};
  // A key given as undefined is left out: JSON would drop it, and with it the stub.
  const given = Object.fromEntries(
    Object.entries(window).filter(([, value]) => value !== undefined),
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...existing, window: { ...own, edge: edgeStub, keepAlive: 'off', ...given } }, null, 2)}\n`,
  );

  return {
    edgeStub,
    edgeCalls(): string[][] {
      if (!existsSync(record)) {
        return [];
      }
      const runs: string[][] = [];
      let args: string[] = [];
      for (const token of readFileSync(record, 'utf8').split('\0').slice(0, -1)) {
        if (token === 'e') {
          runs.push(args);
          args = [];
        } else {
          args.push(token.slice(1));
        }
      }
      return runs;
    },
  };
}
