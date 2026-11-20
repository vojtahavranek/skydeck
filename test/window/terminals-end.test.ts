// The registry's side of ending a session from the window (follow-up F30; S2 7.1, 8.1): `endable`
// in the terminal's info, and `end`, which sends `E` only to a keeper that knows it (version 3) and
// is connected, while its program runs. A keeper of version 2 — every session started before an
// update — is served exactly as before and is never sent `E`. Real keepers running the stand-in;
// the version 2 keeper is the file as it was released (test/fixtures/keeper-v2/).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeKeeperFile } from '../../src/window/runtime.ts';
import { PROMPT, sleep, until } from '../helpers/keeper.ts';
import { attachMirror, info, registrySandbox } from '../helpers/registry.ts';
import type { Mirror, RegistryBox, TestRegistry } from '../helpers/registry.ts';
import { readRecords } from '../helpers/standin.ts';

const KEEPER_V2 = fileURLToPath(new URL('../fixtures/keeper-v2/skydeck-keeper', import.meta.url));

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const prompts = (m: Mirror): number => m.text().split(PROMPT).length - 1;

/** Spawns the stand-in, attaches a mirror, sends G and waits for its first prompt. */
async function startStandin(
  box: RegistryBox,
  r: TestRegistry,
): Promise<{ id: string; record: string; mirror: Mirror & { detach(): void } }> {
  const spec = box.spec();
  await r.registry.spawn(spec);
  const m = await attachMirror(r.registry, box.modules, spec.id);
  r.registry.start(spec.id);
  await until(
    () => prompts(m) >= 1,
    () => `the prompt in ${JSON.stringify(m.text())}`,
    15_000,
  );
  return { id: spec.id, record: spec.env['STANDIN_RECORD'] as string, mirror: m };
}

/** The version 2 keeper written into the box's runtime directory, as an older build's file. */
function keeperV2(box: RegistryBox): string {
  writeKeeperFile(box.tp.platform.files, box.files, 'v2', readFileSync(KEEPER_V2, 'utf8'));
  return box.files.keeperFile('v2');
}

describe('registry: ending a program (F30)', () => {
  test('a version 3 keeper: endable while its program runs; end() hangs it up; its exit ends the terminal as any exit', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const spec = box.spec();
    await r.registry.spawn(spec);
    assert.equal(info(r.registry, spec.id).endable, false, 'not before its program started');
    assert.equal(r.registry.end(spec.id), 'cannot');
    const m = await attachMirror(r.registry, box.modules, spec.id);
    r.registry.start(spec.id);
    await until(() => prompts(m) >= 1, 'the prompt', 15_000);
    await until(() => info(r.registry, spec.id).endable === true, 'endable once it runs');
    const record = spec.env['STANDIN_RECORD'] as string;
    assert.equal(r.registry.end(spec.id), 'ok');
    await until(() => info(r.registry, spec.id).state === 'ended', 'the terminal ended', 10_000);
    const term = info(r.registry, spec.id);
    assert.deepEqual([term.exit?.code, term.exit?.signal], [129, null]);
    assert.equal(term.endable, false);
    assert.equal(r.registry.end(spec.id), 'cannot', 'nothing more to end');
    assert.equal(readRecords(record).filter((one) => one.ev === 'hup').length, 1);
    assert.deepEqual(
      r.events.exited.map((one) => one.lost),
      [false],
    );
    assert.ok(r.log.includes(`terminal ${spec.id}: hang-up sent`), r.log.join('\n'));
    assert.equal(r.registry.close(spec.id), 'ok', 'Close takes it as any ended terminal');
    assert.equal(r.registry.end(spec.id), 'unknown');
  });

  test('a version 2 keeper is served as before and never sent E: not endable, end() sends nothing', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ keeperFile: keeperV2(box) });
    const { id, record, mirror: m } = await startStandin(box, r);
    assert.equal(r.events.hello[0]?.hello.keeper, '2');
    await sleep(300);
    assert.equal(info(r.registry, id).state, 'running');
    assert.equal(info(r.registry, id).endable, false);
    assert.equal(r.registry.end(id), 'cannot');
    assert.equal(r.registry.end(id), 'cannot');
    await sleep(500);
    // Its connection is the one it had: no refusal in the keepers' log, no reconnection.
    assert.deepEqual(r.states.get(id), ['starting', 'running']);
    assert.deepEqual(box.logLines(), []);
    assert.equal(r.sockets.length, 1, 'one connection, never closed by the keeper');
    assert.equal(
      readRecords(record).some((one) => one.ev === 'hup'),
      false,
      'its program got no hang-up',
    );
    // Input, output and the end are what they were.
    const before = prompts(m);
    assert.equal(r.registry.input(id, utf8('hello\r')), 'ok');
    await until(() => prompts(m) > before, 'a prompt after hello', 10_000);
    assert.equal(r.registry.input(id, utf8('/exit\r')), 'ok');
    await until(() => info(r.registry, id).state === 'ended', 'the terminal ended', 10_000);
    assert.deepEqual(
      [info(r.registry, id).exit?.code, info(r.registry, id).exit?.signal],
      [0, null],
    );
  });

  test('a version 2 keeper found by a new server (an update while it ran): served, never endable', async (t) => {
    const box = await registrySandbox(t);
    const first = box.registry({ keeperFile: keeperV2(box) });
    const { id } = await startStandin(box, first);
    await first.registry.stopAll();
    const second = box.registry(); // the updated server spawns version 3; it finds version 2
    const found = await second.registry.rediscover();
    assert.deepEqual(
      found.map((term) => [term.id, term.state]),
      [[id, 'running']],
    );
    assert.equal(info(second.registry, id).endable, false);
    assert.equal(second.registry.end(id), 'cannot');
    await sleep(500);
    assert.equal(info(second.registry, id).state, 'running');
    assert.deepEqual(box.logLines(), []);
    const m = await attachMirror(second.registry, box.modules, id);
    const before = prompts(m);
    assert.equal(second.registry.input(id, utf8('again\r')), 'ok');
    await until(() => prompts(m) > before, 'a prompt after again', 10_000);
  });

  test('not endable while the keeper is not connected; endable again once it is claimed again', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry();
    const { id } = await startStandin(box, r);
    await until(() => info(r.registry, id).endable === true, 'endable');
    const keeper = box.keeperOf(id);
    box.signalKeeper(keeper, 'SIGSTOP');
    try {
      // The connection to a stopped keeper is still open: a dropped one is the case here.
      for (const socket of r.sockets) socket.destroy();
      await until(() => info(r.registry, id).state === 'reconnecting', 'reconnecting');
      assert.equal(info(r.registry, id).endable, false);
      assert.equal(r.registry.end(id), 'cannot');
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(() => info(r.registry, id).state === 'running', 'running again', 10_000);
    assert.equal(info(r.registry, id).endable, true);
  });
});
