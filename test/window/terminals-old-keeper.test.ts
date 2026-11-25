// A13 (S2 7.7): this build meeting a keeper of the build before shells. The update that brings
// keeper version 4 must lose no terminal: a session terminal held by a version 3 keeper (the file
// as it was released, test/fixtures/keeper-v3/) is found again by this build's registry after a
// restart, takes input, shows output, is endable and ends. Version 2 is tested by
// terminals-end.test.ts. Real keepers running the stand-in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeKeeperFile } from '../../src/window/runtime.ts';
import { PROMPT, until } from '../helpers/keeper.ts';
import { attachMirror, info, registrySandbox } from '../helpers/registry.ts';
import type { Mirror } from '../helpers/registry.ts';
import { readRecords } from '../helpers/standin.ts';

const KEEPER_V3 = fileURLToPath(new URL('../fixtures/keeper-v3/skydeck-keeper', import.meta.url));

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const prompts = (m: Mirror): number => m.text().split(PROMPT).length - 1;

describe('registry: a keeper of the build before shells (version 3, A13)', () => {
  test('found after a restart by this build: running, input reaches it, its output the mirror, endable, and end ends it', async (t) => {
    const box = await registrySandbox(t);
    writeKeeperFile(box.tp.platform.files, box.files, 'v3', readFileSync(KEEPER_V3, 'utf8'));
    const first = box.registry({ keeperFile: box.files.keeperFile('v3') });
    const spec = box.spec();
    await first.registry.spawn(spec);
    const m0 = await attachMirror(first.registry, box.modules, spec.id);
    first.registry.start(spec.id);
    await until(() => prompts(m0) >= 1, 'the first prompt', 15_000);
    await first.registry.stopAll();

    const second = box.registry(); // this build: it spawns version 4, and finds version 3
    const found = await second.registry.rediscover();
    assert.deepEqual(
      found.map((term) => [term.id, term.state]),
      [[spec.id, 'running']],
    );
    assert.deepEqual(
      second.events.hello.map((one) => [one.hello.id, one.hello.keeper, one.origin]),
      [[spec.id, '3', 'found']],
    );

    const m = await attachMirror(second.registry, box.modules, spec.id);
    const before = prompts(m);
    assert.equal(second.registry.input(spec.id, utf8('typed-after-update\r')), 'ok');
    await until(() => prompts(m) > before, 'a prompt after the typed line', 10_000);
    const record = spec.env['STANDIN_RECORD'] as string;
    const typed = readRecords(record)
      .filter((one) => one.ev === 'input')
      .map((one) => Buffer.from(one.hex, 'hex').toString('utf8'))
      .join('');
    assert.ok(typed.includes('typed-after-update'), 'the line reached the program');
    assert.ok(m.text().includes('typed-after-update'), 'its echo reached the mirror');

    await until(() => info(second.registry, spec.id).endable === true, 'endable');
    assert.equal(second.registry.end(spec.id), 'ok');
    await until(() => info(second.registry, spec.id).state === 'ended', 'ended', 10_000);
    assert.deepEqual(
      second.events.exited.map((one) => [one.term.id, one.lost]),
      [[spec.id, false]],
    );
    assert.equal(readRecords(record).filter((one) => one.ev === 'hup').length, 1);
  });
});
