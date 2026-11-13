import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { openDeck, resolveDeckPlaces } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type { CaptureOptions } from './capture.ts';
import { testContext } from './context.ts';
import type { TestCtx } from './context.ts';
import type { TestPlatform, TestPlatformOptions } from './platform.ts';

export type TestDeck = TestCtx & TestPlatform & { deck: Deck };

/**
 * testContext(t, options); writes `config` (if given) to config.json; mkdirp
 * <claudeHome>/projects and <claudeHome>/sessions; deck = openDeck(platform), closed in t.after.
 * <claudeHome> is the one the deck resolves, so a `claudeHome` in `config` is honoured.
 */
export function testDeck(
  t: TestContext,
  options: TestPlatformOptions & CaptureOptions & { config?: Record<string, unknown> } = {},
): TestDeck {
  const { config, ...rest } = options;
  const context = testContext(t, rest);
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
