// The automatic pull-request refresh (design 7.3) and a selected session the list does not show
// (plan E13, task 95; review 2's S1, ruled): the header of a hidden selection with a terminal of
// the window shows its pull requests, so the server asks about them as about a listed session's
// (`listFor`'s `tick.listed`); a hidden selection without a terminal shows nothing and is not
// asked about. In the test process on realTestPlatform, with real keepers running the stand-in
// and test/helpers/gh.ts answering `gh`.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { attachManualPr, setGroup } from '../../src/sessions/meta.ts';
import { ghRunner } from '../helpers/gh.ts';
import type { GhRunner } from '../helpers/gh.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox, TestServer } from '../helpers/window.ts';

const PR1 = 'https://github.com/acme/web/pull/1';
const PR2 = 'https://github.com/acme/web/pull/2';
const PR3 = 'https://github.com/acme/web/pull/3';

/** S1 in `alpha-dir` and S2 in `omega-dir`, each with a pull request never fetched (so due), and
 *  a server whose runner holds every `gh` it is asked for. */
async function world(
  t: Parameters<typeof serverSandbox>[0],
): Promise<{ d: ServerSandbox; test: TestServer; gh: GhRunner }> {
  const d = serverSandbox(t);
  d.resumable(S1, join(d.s.home, 'alpha-dir'));
  d.resumable(S2, join(d.s.home, 'omega-dir'));
  attachManualPr(d.deck, S1, PR1);
  attachManualPr(d.deck, S2, PR2);
  let gh: GhRunner | null = null;
  const test = await d.start({
    platform: (platform) => {
      gh = ghRunner(platform.runner, { hold: 'held' });
      return { ...platform, runner: gh };
    },
  });
  assert.ok(gh !== null);
  return { d, test, gh };
}

test('a hidden selection with a terminal of the window: the automatic refresh asks about its pull requests', async (t) => {
  const { d, test: server, gh } = await world(t);
  // The filter hides both sessions: no listed row, so nothing is asked until S1 has a terminal.
  const page = await connectTestPage(t, d, server.server, {
    view: { filter: 'nothing-matches', selected: S1 },
  });
  const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const list = await page.list(
    (candidate) => (candidate.selectedRow?.terminal ?? null) !== null,
    "S1's selectedRow with its terminal",
  );
  assert.deepEqual(rowsOf(list), [], 'the list shows no row');
  await gh.started(1, 20_000);
  assert.deepEqual(gh.runs[0]?.prs, ['acme/web#1']);
});

test('a hidden selection without a terminal is not asked about; the listed session is', async (t) => {
  const { d, test: server, gh } = await world(t);
  const page = await connectTestPage(t, d, server.server, {
    view: { filter: 'omega', selected: S1 },
  });
  const list = await page.list(
    (candidate) => rowsOf(candidate).length === 1 && candidate.selectedRow?.id === S1,
    'S2 listed, S1 the hidden selection',
  );
  assert.equal(rowsOf(list)[0]?.id, S2);
  assert.equal(list.selectedRow?.terminal, null);
  await gh.started(1, 20_000);
  // Both are due: had S1 been asked about, it would be in the same run.
  assert.deepEqual(gh.runs[0]?.prs, ['acme/web#2']);
});

test('a closed block hides every row of it, the first too (F9): none is asked about; a listed session is', async (t) => {
  const d = serverSandbox(t);
  d.resumable(S1, join(d.s.home, 'alpha-dir'));
  d.resumable(S2, join(d.s.home, 'omega-dir'));
  d.resumable(S3, join(d.s.home, 'gamma-dir'));
  attachManualPr(d.deck, S1, PR1);
  attachManualPr(d.deck, S2, PR2);
  attachManualPr(d.deck, S3, PR3);
  setGroup(d.deck, S1, 'G');
  setGroup(d.deck, S2, 'G');
  let gh: GhRunner | null = null;
  const server = await d.start({
    platform: (platform) => {
      gh = ghRunner(platform.runner, { hold: 'held' });
      return { ...platform, runner: gh };
    },
  });
  assert.ok(gh !== null);
  const runner: GhRunner = gh;
  const page = await connectTestPage(t, d, server.server, {
    view: { closed: [{ section: 'week', group: 'G' }] },
  });
  const list = await page.list(
    (candidate) =>
      (candidate.sections.find((s) => s.name === 'week')?.closedStacks.length ?? 0) === 1,
    "Recent's closed block of G",
  );
  assert.deepEqual(
    rowsOf(list).map((row) => row.id),
    [S3],
  );
  await runner.started(1, 20_000);
  // All three are due: had a row of the closed block been asked about, it would be in this run.
  assert.deepEqual(runner.runs[0]?.prs, ['acme/web#3']);
});
