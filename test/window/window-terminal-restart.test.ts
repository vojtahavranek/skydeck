// The window terminal opened for a restart (issue #166; S2 7.6, 11.2): with a restart's hold it
// takes the held number at its spawn, in place of the lowest free one, so the session comes back
// with the number its ended terminal had. Platform: realTestPlatform with a deck (the window-deck
// helper); real keepers through a registry; the stand-in as claudeCommand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { launchPrepared } from '../../src/sessions/launch.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import { windowTerminal } from '../../src/window/window-terminal.ts';
import { until } from '../helpers/keeper.ts';
import { info } from '../helpers/registry.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { windowDeck } from '../helpers/window-deck.ts';

const SIZE = { cols: 100, rows: 30 };

describe('window terminal: a restart’s hold', () => {
  test('the terminal opened with a hold takes the held number, not the lowest free one; without one it takes the lowest free', async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    w.resumable(S2);
    const r = w.registry();
    for (const id of [S1, S2]) {
      const { deps } = w.deps(r);
      const outcome = await launchPrepared(
        w.deck,
        prepareResumeById(w.deck, id),
        windowTerminal(deps, SIZE),
      );
      assert.equal(outcome.code, 0, JSON.stringify(outcome));
    }
    const first = r.registry.list().find((term) => term.expectedSessionId === S1);
    assert.ok(first !== undefined);
    assert.equal(first.slot, 1);
    await w.prompt(r, first.id, S1);
    const hold = r.registry.holdSlot(first.id);
    assert.ok(hold !== null);
    assert.equal(r.registry.end(first.id), 'ok');
    await until(() => info(r.registry, first.id).state === 'ended', 'S1’s program ended', 10_000);
    assert.equal(r.registry.nextSlot(), 3, 'number 1 is held');
    const { deps } = w.deps(r);
    const outcome = await launchPrepared(
      w.deck,
      prepareResumeById(w.deck, S1),
      windowTerminal(deps, SIZE, hold),
    );
    assert.equal(outcome.code, 0, JSON.stringify(outcome));
    const next = r.registry
      .list()
      .find((term) => term.expectedSessionId === S1 && term.id !== first.id);
    assert.ok(next !== undefined);
    assert.equal(next.slot, 1, 'the held number');
    assert.equal(info(r.registry, first.id).slot, null);
    hold.release();
    assert.equal(r.registry.nextSlot(), 3);
  });
});
