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
import type { TestRegistry } from '../helpers/registry.ts';
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

  test("a restart's terminal carries its keeper meta's shell exactly when the held terminal had a shell (issue #199)", async (t) => {
    const w = await windowDeck(t);
    w.resumable(S1);
    w.resumable(S2);
    const r = w.registry();
    const opened = new Map<string, string>();
    for (const id of [S1, S2]) {
      const { deps } = w.deps(r);
      const outcome = await launchPrepared(
        w.deck,
        prepareResumeById(w.deck, id),
        windowTerminal(deps, SIZE),
      );
      assert.equal(outcome.code, 0, JSON.stringify(outcome));
      const term = r.registry.list().find((one) => one.expectedSessionId === id);
      assert.ok(term !== undefined);
      opened.set(id, term.id);
      await w.prompt(r, term.id, id);
    }
    const withShell = opened.get(S1) ?? '';
    const shell = w.shellSpec(r, withShell);
    await r.registry.spawnShell(shell);
    r.registry.start(shell.id);
    await until(() => r.registry.shells()[0]?.state === 'running', 'the shell runs');

    /** Restarts the session's terminal with a hold; the keeper meta's shell of the next one. */
    const restart = async (registry: TestRegistry, id: string): Promise<string | undefined> => {
      const termId = opened.get(id) ?? '';
      const hold = registry.registry.holdSlot(termId);
      assert.ok(hold !== null);
      assert.equal(registry.registry.end(termId), 'ok');
      await until(() => info(registry.registry, termId).state === 'ended', 'ended', 10_000);
      const { deps } = w.deps(registry);
      const outcome = await launchPrepared(
        w.deck,
        prepareResumeById(w.deck, id),
        windowTerminal(deps, SIZE, hold),
      );
      assert.equal(outcome.code, 0, JSON.stringify(outcome));
      hold.release();
      const next = registry.events.hello.find(
        (one) => one.hello.meta.sessionId === id && one.term.id !== termId,
      );
      assert.ok(next !== undefined, 'the next terminal said hello');
      return next.hello.meta.shell;
    };

    assert.equal(await restart(r, S1), shell.id, 'the held terminal had a shell');
    assert.equal(await restart(r, S2), undefined, 'it had none');
    assert.deepEqual(
      r.registry.shells().map((one) => one.id),
      [shell.id],
    );
  });
});
