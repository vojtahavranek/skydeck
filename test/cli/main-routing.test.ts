import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

import { dispatch, main } from '../../src/cli/main.ts';
import { EXIT } from '../../src/cli/exit.ts';
import { testContext } from '../helpers/context.ts';
import { twoSessions } from '../helpers/session-files.ts';

const commandsWithoutLs = new URL('../fixtures/commands/', import.meta.url);

test('bare skydeck on two terminals opens the interactive list', async (t) => {
  const d = twoSessions(t, { stdinTTY: true, stdoutTTY: true, keys: ['q'] });

  assert.equal(await main([], d.ctx), EXIT.ok);

  assert.ok(d.stdout().startsWith('\x1b[?1049h'), JSON.stringify(d.stdout().slice(0, 20)));
});

for (const [stdinTTY, stdoutTTY] of [
  [true, false],
  [false, true],
  [false, false],
]) {
  test(`bare skydeck with stdin${stdinTTY ? '' : ' not'} a terminal and stdout${stdoutTTY ? '' : ' not'} one prints what skydeck ls prints`, async (t) => {
    const d = twoSessions(t, { stdinTTY, stdoutTTY, keys: ['q'] });

    assert.equal(await main([], d.ctx), EXIT.ok);
    const bare = d.stdout();
    assert.equal(await main(['ls'], d.ctx), EXIT.ok);

    assert.equal(bare, d.stdout().slice(bare.length));
    assert.ok(bare.includes('0b5f3c1e'), bare);
    assert.ok(!bare.includes('\x1b'), JSON.stringify(bare));
    assert.equal(d.stderr(), '');
  });
}

test('a failure of the list goes through the error mapping: one line, its exit code, no escape sequences', async (t) => {
  const c = testContext(t, { stdinTTY: true, stdoutTTY: true, keys: ['q'] });
  mkdirSync(c.places.configDir, { recursive: true });
  writeFileSync(c.places.configPath, JSON.stringify({ colour: 1 }));

  assert.equal(await main([], c.ctx), EXIT.failure);

  assert.match(c.stderr(), /^skydeck: [^\n]*colour[^\n]*\n$/);
  assert.equal(c.stdout(), '');
});

test('bare skydeck where the ls command cannot be found fails as an unknown command does', async () => {
  const c = testContext();

  assert.equal(await dispatch([], c.ctx, commandsWithoutLs), EXIT.usage);

  assert.match(c.stderr(), /^Usage:/);
  assert.equal(c.stdout(), '');
});
