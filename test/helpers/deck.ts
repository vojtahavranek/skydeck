import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import type { Files, Proc } from '../../src/platform/types.ts';
import { openDeck, resolveDeckPlaces } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type { Store } from '../../src/store/store.ts';
import type { CaptureOptions } from './capture.ts';
import { testContext, testContextOn } from './context.ts';
import type { TestCtx } from './context.ts';
import { realTestPlatform } from './platform.ts';
import type { RealTestPlatform, TestPlatform, TestPlatformOptions } from './platform.ts';

export type TestDeck = TestCtx & TestPlatform & { deck: Deck };
/** testDeck(t, { real: true }): the deck on realTestPlatform (A36). */
export type RealTestDeck = TestCtx & RealTestPlatform & { deck: Deck };

type DeckOptions = CaptureOptions & { config?: Record<string, unknown> };

/**
 * testContext(t, options); writes `config` (if given) to config.json; mkdirp
 * <claudeHome>/projects and <claudeHome>/sessions; deck = openDeck(platform), closed in t.after.
 * <claudeHome> is the one the deck resolves, so a `claudeHome` in `config` is honoured.
 * With `real: true` the platform is realTestPlatform(t, { bootId, env }) instead.
 */
export function testDeck(
  t: TestContext,
  options: DeckOptions & { real: true; bootId?: string; env?: TestPlatformOptions['env'] },
): RealTestDeck;
export function testDeck(
  t: TestContext,
  options?: DeckOptions & Omit<TestPlatformOptions, 'realProcesses'> & { real?: false },
): TestDeck;
export function testDeck(
  t: TestContext,
  options: DeckOptions & Omit<TestPlatformOptions, 'realProcesses'> & { real?: boolean } = {},
): TestDeck | RealTestDeck {
  const { config, real, ...rest } = options;
  const context =
    real === true
      ? testContextOn(realTestPlatform(t, { bootId: rest.bootId, env: rest.env }), rest)
      : testContext(t, rest);
  if (config !== undefined) {
    mkdirSync(context.places.configDir, { recursive: true });
    writeFileSync(context.places.configPath, JSON.stringify(config));
  }
  const { claudeHome } = resolveDeckPlaces(context.platform).places;
  mkdirSync(join(claudeHome, 'projects'), { recursive: true });
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true });
  const deck = openDeck(context.platform);
  t.after(() => {
    deck.store.close();
  });
  return { ...context, deck };
}

/**
 * The deck with some methods of its `Files`, `Proc` or `Store` replaced, for tests that make one
 * file, process or save fail. The replacements may call the real ones through `deck`. The store's
 * own methods stay bound to it, so `transaction(fn)` still works, and `fn` sees the replacements.
 */
export function deckWith(
  deck: Deck,
  override: { files?: Partial<Files>; proc?: Partial<Proc>; store?: Partial<Store> },
): Deck {
  const storeOverride = override.store ?? {};
  const store = new Proxy(deck.store, {
    get(target, key) {
      if (Object.hasOwn(storeOverride, key)) {
        return storeOverride[key as keyof Store];
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return {
    ...deck,
    platform: {
      ...deck.platform,
      files: { ...deck.platform.files, ...override.files },
      proc: { ...deck.platform.proc, ...override.proc },
    },
    store,
  };
}
