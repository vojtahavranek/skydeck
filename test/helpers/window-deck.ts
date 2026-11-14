/**
 * The window terminal (plan task 21) under test: a deck and terminal registries in ONE sandbox —
 * registrySandbox's real keepers (python3, the repository's keeper) and a deck on the same
 * realTestPlatform, as testDeck(t, { real: true }) makes one — so that the stand-in's hook and
 * live file land where the deck refreshes from. `claudeCommand` is the stand-in unless a test gives
 * another program; the real `claude` is never run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { resolveConfigDir } from '../../src/platform/paths.ts';
import { isoFromNs } from '../../src/platform/time.ts';
import { openDeck, resolveDeckPlaces } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { serverEnvironment } from '../../src/window/env.ts';
import type { WindowTerminalDeps } from '../../src/window/window-terminal.ts';
import { PROMPT, until } from './keeper.ts';
import { attachMirror, registrySandbox } from './registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from './registry.ts';
import type { Sandbox } from './sandbox.ts';
import { standinCommand } from './standin.ts';

export interface WindowDeck extends RegistryBox {
  deck: Deck;
  /** The stand-in's script (claudeCommand of the config unless the test chose another). */
  standin: string;
  /**
   * Makes `sessionId` resumable: a transcript of one user record a minute ago whose directory is
   * `dir` (created; default a project directory in the sandbox's home). Returns the directory.
   */
  resumable(sessionId: string, dir?: string): string;
  /**
   * WindowTerminalDeps over registry `r`: the server environment is the sandbox's with
   * STANDIN_RECORD set to a fresh record file and `env` over it, as serverEnvironment returns it
   * (SKYDECK_CORE_SOFT 1 unless `env` says otherwise); `over` replaces any member.
   */
  deps(
    r: TestRegistry,
    options?: { env?: Record<string, string | undefined>; over?: Partial<WindowTerminalDeps> },
  ): { deps: WindowTerminalDeps; record: string };
  /** Attaches a mirror to the terminal and waits for the stand-in's prompt of `sessionId`. */
  prompt(r: TestRegistry, termId: string, sessionId?: string): Promise<Mirror>;
}

let records = 0;

/**
 * Call first in a test. `claudeCommand(s)`: the program the config names (default the stand-in);
 * `config`: further keys of config.json. The deck's store is closed first at the test's end, then
 * registryBox's cleanup stops the registries and kills the keepers, then the sandbox goes.
 */
export async function windowDeck(
  t: TestContext,
  options: { claudeCommand?: (s: Sandbox) => string; config?: Record<string, unknown> } = {},
): Promise<WindowDeck> {
  let deck: Deck | null = null;
  t.after(() => {
    deck?.store.close();
  });
  const box = await registrySandbox(t);
  const { s } = box;
  const platform = box.tp.platform;
  const standin = standinCommand(s);
  const claudeCommand = options.claudeCommand?.(s) ?? standin;
  const configDir = resolveConfigDir(platform.env, platform.homeDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ claudeCommand, ...options.config }),
  );
  const { places } = resolveDeckPlaces(platform);
  mkdirSync(join(places.claudeHome, 'projects'), { recursive: true });
  mkdirSync(join(places.claudeHome, 'sessions'), { recursive: true });
  const opened = openDeck(platform);
  deck = opened;

  const resumable = (sessionId: string, dir = join(s.home, 'project')): string => {
    mkdirSync(dir, { recursive: true });
    const folder = join(places.claudeHome, 'projects', 'project');
    mkdirSync(folder, { recursive: true });
    const record = {
      type: 'user',
      sessionId,
      timestamp: isoFromNs(platform.clock.nowNs() - 60_000_000_000n),
      cwd: dir,
      entrypoint: 'cli',
    };
    writeFileSync(join(folder, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
    return dir;
  };

  const deps: WindowDeck['deps'] = (r, more = {}) => {
    records += 1;
    const record = join(s.root, 'records', `window-${process.pid}-${records}.jsonl`);
    const server = serverEnvironment(
      s.env({ STANDIN_RECORD: record, SKYDECK_CORE_SOFT: '1', ...more.env }),
    );
    return {
      record,
      deps: {
        registry: r.registry,
        files: box.files,
        platform,
        serverEnv: server.env,
        coreSoft: server.coreSoft,
        interop: () => null,
        build: 'test-build',
        ...more.over,
      },
    };
  };

  const prompt: WindowDeck['prompt'] = async (r, termId, sessionId) => {
    const m = await attachMirror(r.registry, box.modules, termId);
    const text = sessionId === undefined ? PROMPT : `standin ${sessionId.slice(0, 8)}> `;
    await until(
      () => m.text().includes(text),
      () => `${JSON.stringify(text)} in ${JSON.stringify(m.text().slice(-300))}`,
      15_000,
    );
    return m;
  };

  return { ...box, deck: opened, standin, resumable, deps, prompt };
}
