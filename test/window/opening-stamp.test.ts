// The opening stamp of a window terminal (S2 7.1, issue #213): `openedNs` of its keeper's meta is
// later than every opening stamp the server knows — those it gave, and those of the terminals it
// found again after a restart — so no two terminals share one and they rise in opening order, also
// while the clock holds; with a clock that moves it is the clock's value. Platform:
// realTestPlatform with a deck (the window-deck helper) and a clock of the test's; real keepers
// through registries; the stand-in as claudeCommand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { launchSpec } from '../../src/sessions/launch.ts';
import { readLock } from '../../src/sessions/resume.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import type { Platform } from '../../src/platform/types.ts';
import { windowTerminal } from '../../src/window/window-terminal.ts';
import { info } from '../helpers/registry.ts';
import type { TestRegistry } from '../helpers/registry.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { windowDeck } from '../helpers/window-deck.ts';
import type { WindowDeck } from '../helpers/window-deck.ts';

const SIZE = { cols: 100, rows: 30 };
const NS_PER_SECOND = 1_000_000_000n;

/** `base` with a wall clock that answers `nowNs()` (its timers are base's). */
function withClock(base: Platform, nowNs: () => bigint): Platform {
  return { ...base, clock: { ...base.clock, nowNs } };
}

/** Opens a terminal for `sessionId` through registry `r` on `platform`; its opening stamp. */
async function openFor(
  w: WindowDeck,
  r: TestRegistry,
  platform: Platform,
  sessionId: string,
): Promise<bigint> {
  w.resumable(sessionId);
  const spec = launchSpec(prepareResumeById(w.deck, sessionId), readLock(w.deck, sessionId));
  const { deps } = w.deps(r, { over: { platform } });
  const result = await windowTerminal(deps, SIZE).open(spec);
  assert.deepEqual(result, { ok: true }, `the terminal of ${sessionId.slice(0, 8)} started`);
  const term = r.registry.list().find((one) => one.expectedSessionId === sessionId);
  assert.ok(term !== undefined, `a terminal of ${sessionId.slice(0, 8)}`);
  return info(r.registry, term.id).openedNs;
}

describe('the opening stamp (S2 7.1, #213)', () => {
  test('a clock that holds: terminals opened one after another get rising stamps, in opening order, the first the clock’s value', async (t) => {
    const w = await windowDeck(t);
    const heldNs = w.tp.platform.clock.nowNs();
    const platform = withClock(w.tp.platform, () => heldNs);
    const r = w.registry({ platform });
    const stamps = [
      await openFor(w, r, platform, S1),
      await openFor(w, r, platform, S2),
      await openFor(w, r, platform, S3),
    ];
    assert.deepEqual(stamps, [heldNs, heldNs + 1n, heldNs + 2n]);
  });

  test('a clock that moves: each stamp is exactly the clock’s value', async (t) => {
    const w = await windowDeck(t);
    let nowNs = w.tp.platform.clock.nowNs();
    const platform = withClock(w.tp.platform, () => nowNs);
    const r = w.registry({ platform });
    const first = nowNs;
    assert.equal(await openFor(w, r, platform, S1), first);
    nowNs += 3n; // a few nanoseconds later is later all the same
    assert.equal(await openFor(w, r, platform, S2), first + 3n);
    nowNs += 2n * NS_PER_SECOND;
    assert.equal(await openFor(w, r, platform, S3), first + 3n + 2n * NS_PER_SECOND);
  });

  test('a spawn’s meta stamped ahead of the clock counts from the spawn on, before its hello', async (t) => {
    const w = await windowDeck(t);
    const heldNs = w.tp.platform.clock.nowNs();
    const r = w.registry({ platform: withClock(w.tp.platform, () => heldNs) });
    const spec = w.spec();
    const aheadNs = heldNs + NS_PER_SECOND;
    const spawning = r.registry.spawn({
      ...spec,
      meta: { ...spec.meta, openedNs: String(aheadNs) },
    });
    // In the same step as the spawn: no hello can have come yet.
    const next = r.registry.nextOpenedNs();
    await spawning;
    assert.equal(next, aheadNs + 1n);
    assert.equal(r.registry.nextOpenedNs(), aheadNs + 2n, 'and after its hello');
  });

  for (const ahead of [0n, NS_PER_SECOND]) {
    test(`after a restart: a terminal kept with a stamp ${ahead === 0n ? 'at' : 'a second ahead of'} the clock’s value is found with it, and the next terminal opened is later`, async (t) => {
      const w = await windowDeck(t);
      const heldNs = w.tp.platform.clock.nowNs();
      const before = withClock(w.tp.platform, () => heldNs + ahead);
      const r1 = w.registry({ platform: before });
      const keptNs = await openFor(w, r1, before, S1);
      assert.equal(keptNs, heldNs + ahead);
      const keptId = r1.registry.list()[0]?.id;
      // The server stops (its keepers live on); the next one runs on a clock that holds at heldNs.
      await r1.registry.stopAll();
      const after = withClock(w.tp.platform, () => heldNs);
      const r2 = w.registry({ platform: after });
      const found = await r2.registry.rediscover();
      assert.deepEqual(
        found.map((one) => [one.id, one.openedNs]),
        [[keptId, keptNs]],
        'found with its stamp',
      );
      assert.equal(await openFor(w, r2, after, S2), keptNs + 1n);
    });
  }
});
