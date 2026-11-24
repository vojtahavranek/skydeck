// The registry's side of restarting a session from the window (issue #166; S2 7.6, 7.8): a
// restart holds its terminal's number while it ends the program and opens the next terminal. While
// held the terminal reads `restarting`; its number stays on it after its program's exit (the slot
// is not freed as F43 frees it), so `nextSlot` never hands it out and no move takes it; Close
// refuses it. The next terminal takes the number at its spawn (`take`), and with it the old
// terminal's place among the terminals without a number; a hold let go without a take frees the
// number as F43 would. Real keepers running the stand-in.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { KeeperSpec } from '../../src/window/frames.ts';
import { PROMPT, until } from '../helpers/keeper.ts';
import { attachMirror, info, registrySandbox } from '../helpers/registry.ts';
import type { RegistryBox, TestRegistry } from '../helpers/registry.ts';

/** Spawns the stand-in with meta slot `slot`, sends G and waits for its first prompt; its id. */
async function running(box: RegistryBox, r: TestRegistry, slot: number | null): Promise<string> {
  const spec: KeeperSpec = box.spec({ meta: { ...box.spec().meta, slot } });
  await r.registry.spawn(spec);
  const m = await attachMirror(r.registry, box.modules, spec.id);
  r.registry.start(spec.id);
  await until(
    () => m.text().includes(PROMPT),
    () => `the prompt in ${JSON.stringify(m.text())}`,
    15_000,
  );
  await until(() => info(r.registry, spec.id).endable === true, 'endable once it runs');
  m.detach();
  return spec.id;
}

/** Hangs the program of `id` up and waits until its terminal has ended. */
async function endIt(r: TestRegistry, id: string): Promise<void> {
  assert.equal(r.registry.end(id), 'ok');
  await until(() => info(r.registry, id).state === 'ended', `terminal ${id} ended`, 10_000);
}

describe('registry: a restart holds its terminal’s number (#166)', () => {
  test('held: `restarting`; after the exit the number stays on it, nextSlot passes it by, Close and a move refuse it; the next terminal takes it at its spawn, and the hold let go lets Close take the old one', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const id = await running(box, r, 1);
    const second = await running(box, r, 3);
    assert.equal(info(r.registry, id).restarting, undefined, 'absent before a hold');
    const hold = r.registry.holdSlot(id);
    assert.ok(hold !== null);
    assert.equal(info(r.registry, id).restarting, true);
    assert.equal(r.registry.holdSlot(id), null, 'one hold at a time');
    await endIt(r, id);
    const ended = info(r.registry, id);
    assert.deepEqual([ended.slot, ended.restarting], [1, true], 'its number stays on it');
    assert.equal(r.registry.nextSlot(), 2, 'number 1 is not free');
    assert.equal(r.registry.close(id), 'running', 'Close refuses it while held');
    // A swap of two numbers, which the move's own rules take for two running terminals: refused.
    assert.equal(
      r.registry.setSlots(
        new Map([
          [id, 3],
          [second, 1],
        ]),
      ),
      'changed',
      'no move gives or takes its number',
    );
    assert.deepEqual([info(r.registry, id).slot, info(r.registry, second).slot], [1, 3]);
    // The next terminal takes the number at its spawn.
    const next = box.spec();
    const slot = hold.take(next.id);
    assert.equal(slot, 1);
    assert.equal(info(r.registry, id).slot, null, 'the old terminal has none once it is taken');
    assert.equal(hold.take('ffffffffffff'), null, 'taken once');
    await r.registry.spawn({ ...next, meta: { ...next.meta, slot } });
    assert.equal(info(r.registry, next.id).slot, 1);
    assert.equal(info(r.registry, next.id).placeNs, ended.openedNs, 'the old one’s place');
    assert.equal(r.registry.nextSlot(), 2);
    hold.release();
    assert.equal(info(r.registry, id).restarting, undefined);
    assert.equal(info(r.registry, id).slot, null);
    hold.release(); // once only
    assert.equal(r.registry.close(id), 'ok');
    assert.equal(info(r.registry, next.id).slot, 1);
  });

  test('a hold let go after the exit, nothing taken: the number is free at once, announced; the terminal stays an ordinary ended one', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const id = await running(box, r, 1);
    const hold = r.registry.holdSlot(id);
    assert.ok(hold !== null);
    await endIt(r, id);
    assert.equal(info(r.registry, id).slot, 1);
    let changes = 0;
    const off = r.registry.onChange(() => {
      changes += 1;
    });
    hold.release();
    off();
    assert.ok(changes >= 1, 'announced');
    const term = info(r.registry, id);
    assert.deepEqual([term.slot, term.restarting, term.state], [null, undefined, 'ended']);
    assert.equal(r.registry.nextSlot(), 1);
    assert.equal(r.registry.setSlots(new Map([[id, 1]])), 'changed', 'F43: it never gains one');
    assert.equal(r.registry.close(id), 'ok');
  });

  test('a hold let go while the program runs (the restart was given up): the number stays, and its later exit frees it as F43 does', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const id = await running(box, r, 1);
    const hold = r.registry.holdSlot(id);
    assert.ok(hold !== null);
    assert.equal(hold.take('ffffffffffff'), null, 'nothing is taken while its program runs');
    assert.equal(info(r.registry, id).slot, 1);
    hold.release();
    assert.deepEqual([info(r.registry, id).slot, info(r.registry, id).restarting], [1, undefined]);
    await endIt(r, id);
    assert.equal(info(r.registry, id).slot, null);
    assert.equal(r.registry.nextSlot(), 1);
  });

  test('no hold on a terminal that is not known, has ended, or whose registry stopped', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const id = await running(box, r, 1);
    assert.equal(r.registry.holdSlot('ffffffffffff'), null);
    await endIt(r, id);
    assert.equal(r.registry.holdSlot(id), null, 'ended');
    const other = await running(box, r, 2);
    await r.registry.stopAll();
    assert.equal(r.registry.holdSlot(other), null, 'stopped');
  });

  test('a terminal without a number: the next one takes none, and its place among those without', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const id = await running(box, r, null);
    const hold = r.registry.holdSlot(id);
    assert.ok(hold !== null);
    await endIt(r, id);
    const next = box.spec();
    assert.equal(hold.take(next.id), null);
    await r.registry.spawn({ ...next, meta: { ...next.meta, slot: null } });
    assert.equal(info(r.registry, next.id).slot, null);
    assert.equal(info(r.registry, next.id).placeNs, info(r.registry, id).openedNs);
    hold.release();
    assert.equal(r.registry.nextSlot(), 1);
  });
});
