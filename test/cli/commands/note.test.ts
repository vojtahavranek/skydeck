import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { loadRows } from '../../../src/sessions/load.ts';
import { refCases } from '../../helpers/command-cases.ts';
import { S1, S2, fakeRunner } from '../../helpers/platform.ts';
import { twoSessions, withRunner } from '../../helpers/session-files.ts';

refCases('note', 'skydeck note <ref> [--set <text>]', ['--set', 'x']);

test('note <ref> --set <text> stores the note', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['note', '0b5f', '--set', 'remember'], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e note saved\n');
  assert.equal(d.stderr(), '');
  assert.equal(d.deck.store.meta(S1)?.note, 'remember');
  assert.equal(d.deck.store.meta(S2), null);
  const row = loadRows(d.deck).find((r) => r.id === S1);
  assert.equal(row?.hasNote, true);
  assert.equal(row?.note, 'remember');
});

test('note --set removes a note file kept by a failed edit of that session, and no other', async (t) => {
  const d = twoSessions(t);
  const kept = join(d.places.stateDir, `note-${S1}.md`);
  const other = join(d.places.stateDir, `note-${S2}.md`);
  writeFileSync(kept, 'typed, never stored');
  writeFileSync(other, 'another session');

  assert.equal(await main(['note', '0b5f', '--set', 'the new text'], d.ctx), 0);

  assert.equal(d.deck.store.meta(S1)?.note, 'the new text');
  assert.equal(existsSync(kept), false, 'the user chose the new text over the kept one');
  assert.equal(existsSync(other), true);
});

test('note --set that fails to store leaves the kept note file alone', async (t) => {
  const d = twoSessions(t);
  const kept = join(d.places.stateDir, `note-${S1}.md`);
  writeFileSync(kept, 'typed, never stored');
  // a ref that matches nothing: nothing is stored, so nothing may be discarded
  assert.equal(await main(['note', 'nope1234', '--set', 'x'], d.ctx), 3);
  assert.equal(existsSync(kept), true);
});

test('a note set with --set is stored as typed, several lines included', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['note', '0b5f', '--set', '  first\nsecond\n'], d.ctx), 0);
  assert.equal(d.deck.store.meta(S1)?.note, '  first\nsecond\n');
});

test('note <ref> --set "" clears the note', async (t) => {
  const d = twoSessions(t);
  await main(['note', '0b5f', '--set', 'remember'], d.ctx);
  assert.equal(await main(['note', '0b5f', '--set', ''], d.ctx), 0);
  assert.equal(d.stdout(), '0b5f3c1e note saved\n0b5f3c1e note cleared\n');
  assert.equal(d.deck.store.meta(S1)?.note, null);
  assert.equal(loadRows(d.deck).find((r) => r.id === S1)?.hasNote, false);
});

test('note <ref> --set with no value, or with an extra argument, is a usage error', async (t) => {
  const d = twoSessions(t);
  assert.equal(await main(['note', '0b5f', '--set'], d.ctx), 2);
  assert.match(d.stderr(), /^skydeck: .*--set.*\nskydeck note <ref> \[--set <text>\]/s);
  assert.equal(await main(['note', '0b5f', 'extra', '--set', 'x'], d.ctx), 2);
  assert.match(d.stderr(), /skydeck: too many arguments\nskydeck note <ref>/);
  assert.equal(d.deck.store.meta(S1), null);
});

test('note <ref> without --set and with stdin that is not a terminal is a usage error (exit 2)', async (t) => {
  const d = twoSessions(t, { stdinTTY: false });
  assert.equal(await main(['note', '0b5f'], d.ctx), 2);
  assert.match(d.stderr(), /^skydeck: note: stdin is not a terminal/);
  assert.deepEqual(d.runner.interactiveCalls, []);
  assert.equal(d.deck.store.meta(S1), null);
});

test('note <ref> on a terminal runs the editor and stores what it wrote', async (t) => {
  const d = twoSessions(t, { stdinTTY: true, env: { EDITOR: 'fake-editor' } });
  const runner = fakeRunner(undefined, (call) => {
    writeFileSync(call.args.at(-1) ?? '', 'from the editor\nline two\n');
    return 0;
  });
  assert.equal(await main(['note', '0b5f'], withRunner(d, runner)), 0);
  assert.equal(d.stdout(), '0b5f3c1e note saved\n');
  assert.equal(d.deck.store.meta(S1)?.note, 'from the editor\nline two\n');
  assert.equal(runner.interactiveCalls.length, 1);
  assert.equal(runner.interactiveCalls[0]?.command, 'fake-editor');
});

test('an editor that leaves nothing clears the note and says so', async (t) => {
  const d = twoSessions(t, { stdinTTY: true, env: { EDITOR: 'fake-editor' } });
  await main(['note', '0b5f', '--set', 'old'], d.ctx);
  const runner = fakeRunner(undefined, (call) => {
    writeFileSync(call.args.at(-1) ?? '', '\n');
    return 0;
  });
  assert.equal(await main(['note', '0b5f'], withRunner(d, runner)), 0);
  assert.equal(d.stdout(), '0b5f3c1e note saved\n0b5f3c1e note cleared\n');
  assert.equal(d.deck.store.meta(S1)?.note, null);
});

test('an editor that fails leaves the note as it was and exits 1', async (t) => {
  const d = twoSessions(t, { stdinTTY: true, env: { EDITOR: 'fake-editor' } });
  await main(['note', '0b5f', '--set', 'old'], d.ctx);
  const runner = fakeRunner(undefined, () => 3);
  assert.equal(await main(['note', '0b5f'], withRunner(d, runner)), 1);
  assert.match(d.stderr(), /^skydeck: editor exited 3\n$/);
  assert.equal(d.deck.store.meta(S1)?.note, 'old');
});
