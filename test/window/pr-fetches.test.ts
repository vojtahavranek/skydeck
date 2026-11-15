// The pull-request fetches the window's server runs in the background (plan D8, task 36): design
// 7.3's fetch of an attached pull request and the explicit refresh of a session's, one at a time
// per server, a request the running one covers joining it, the others waiting and running together
// when it ends; `changed()` when something was saved, a failure logged by kind, the server's stop
// aborting it. On testPlatform, with test/helpers/gh.ts answering `gh`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Deck } from '../../src/sessions/deck.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { attachManualPr } from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { createPrFetches } from '../../src/window/pr-fetches.ts';
import type { PrFetches } from '../../src/window/pr-fetches.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { ghRunner } from '../helpers/gh.ts';
import type { GhOptions, GhRunner } from '../helpers/gh.ts';
import { S1, S2, runResult } from '../helpers/platform.ts';
import { writeTranscript } from '../helpers/session-files.ts';

const PR1 = 'https://github.com/acme/web/pull/1';
const PR2 = 'https://github.com/acme/web/pull/2';
const PR3 = 'https://github.com/acme/api/pull/3';
/** A regression that leaves a fetch running or waiting fails its case instead of hanging the file. */
const LIMIT = { timeout: 10_000 };

interface Fixture {
  d: TestDeck;
  gh: GhRunner;
  prs: PrFetches;
  stop: AbortController;
  changes: () => number;
  logs: string[];
}

/** S1 with PR1 and PR2 attached, S2 with PR3; the fetches on a deck whose runner answers `gh`. */
function fixture(
  t: TestContext,
  options: GhOptions & { changed?: () => void; deck?: (deck: Deck) => Deck } = {},
): Fixture {
  const d = testDeck(t);
  writeTranscript(d, S1);
  writeTranscript(d, S2);
  refresh(d.deck); // the transcripts read: the sessions have rows
  attachManualPr(d.deck, S1, PR1);
  attachManualPr(d.deck, S1, PR2);
  attachManualPr(d.deck, S2, PR3);
  const gh = ghRunner(d.runner, options);
  const base = options.deck === undefined ? d.deck : options.deck(d.deck);
  const deck: Deck = { ...base, platform: { ...base.platform, runner: gh } };
  const stop = new AbortController();
  const logs: string[] = [];
  let changes = 0;
  const prs = createPrFetches({
    deck,
    signal: stop.signal,
    changed() {
      changes++;
      options.changed?.();
    },
    log: (line) => logs.push(line),
  });
  t.after(async () => {
    stop.abort();
    gh.release();
    await prs.idle();
  });
  return { d, gh, prs, stop, changes: () => changes, logs };
}

/** The level step 1 gives the pull request `url` on S1's or S2's row. */
function levelOf(d: TestDeck, url: string): string | undefined {
  return loadRows(d.deck)
    .flatMap((row) => row.prs)
    .find((pr) => pr.url === url)?.level;
}

test(
  'fetch: design 7.3 for exactly those pull requests, in the background; changed() once it saved them',
  LIMIT,
  async (t) => {
    const f = fixture(t);
    f.prs.fetch([PR1]);
    assert.equal(f.changes(), 0, 'nothing saved before gh answered');
    await f.prs.idle();
    assert.deepEqual(
      f.gh.runs.map((run) => run.prs),
      [['acme/web#1']],
    );
    assert.equal(levelOf(f.d, PR1), 'approved-green');
    assert.equal(levelOf(f.d, PR2), 'unfetched', 'only the one asked for');
    assert.equal(f.changes(), 1);
    assert.deepEqual(f.logs, []);
  },
);

test(
  "refresh: an explicit refresh of the session's pull requests (refreshPrs with force), whatever their age",
  LIMIT,
  async (t) => {
    const f = fixture(t);
    f.prs.refresh(S1);
    await f.prs.idle();
    f.prs.refresh(S1); // just read: an automatic refresh would leave them, an explicit one does not
    await f.prs.idle();
    assert.deepEqual(
      f.gh.runs.map((run) => run.prs),
      [
        ['acme/web#1', 'acme/web#2'],
        ['acme/web#1', 'acme/web#2'],
      ],
    );
    assert.equal(levelOf(f.d, PR3), 'unfetched', "S2's is not asked about");
    assert.equal(f.changes(), 2);
  },
);

test('three refreshes of one session at once: gh ran once and changed() once', LIMIT, async (t) => {
  const f = fixture(t, { hold: 'held' });
  f.prs.refresh(S1);
  f.prs.refresh(S1);
  f.prs.refresh(S1);
  await f.gh.started(1);
  f.gh.release();
  await f.prs.idle();
  assert.equal(f.gh.runs.length, 1);
  assert.equal(f.changes(), 1);
});

test(
  'a fetch the running one covers joins it; the others wait and run together, once, when it ends',
  LIMIT,
  async (t) => {
    const f = fixture(t, { hold: 'held' });
    f.prs.fetch([PR1]);
    await f.gh.started(1);
    f.prs.fetch([PR2]); // another pull request: it waits
    f.prs.fetch([PR1]); // covered by the one running: it joins it
    f.prs.fetch([PR3, PR2]); // waits with the other
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.gh.runs.length, 1, 'one gh at a time');
    f.gh.release();
    await f.gh.started(2);
    assert.deepEqual(f.gh.runs[1]?.prs.toSorted(), ['acme/api#3', 'acme/web#2']);
    f.gh.release();
    await f.prs.idle();
    assert.equal(f.gh.runs.length, 2);
    for (const url of [PR1, PR2, PR3]) assert.equal(levelOf(f.d, url), 'approved-green', url);
    assert.equal(f.changes(), 2, 'once for each run that saved something');
  },
);

test(
  'a fetch the running one covers only in part waits, and asks about all of its pull requests',
  LIMIT,
  async (t) => {
    const f = fixture(t, { hold: 'held' });
    f.prs.fetch([PR1]);
    await f.gh.started(1);
    f.prs.fetch([PR1, PR2]);
    f.gh.release();
    await f.gh.started(2);
    f.gh.release();
    await f.prs.idle();
    assert.deepEqual(f.gh.runs[1]?.prs, ['acme/web#1', 'acme/web#2']);
    assert.equal(levelOf(f.d, PR2), 'approved-green');
  },
);

test(
  'idle() waits for the run that waited, not only for the one that ran when it was called',
  LIMIT,
  async (t) => {
    const f = fixture(t, { hold: 'held' });
    f.prs.fetch([PR1]);
    await f.gh.started(1);
    f.prs.fetch([PR2]);
    let idle = false;
    const waited = f.prs.idle().then(() => {
      idle = true;
    });
    f.gh.release();
    await f.gh.started(2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idle, false, 'the second run still runs');
    f.gh.release();
    await waited;
    assert.equal(levelOf(f.d, PR2), 'approved-green', 'it resolved once that run had saved');
  },
);

test(
  'while a refresh runs, a refresh of another session and a fetch both wait: one gh at a time',
  LIMIT,
  async (t) => {
    const f = fixture(t, { hold: 'held' });
    f.prs.refresh(S1);
    await f.gh.started(1);
    f.prs.refresh(S2);
    f.prs.fetch([PR1]); // the running refresh is not known to cover it: it waits too
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.gh.runs.length, 1);
    f.gh.release();
    await f.gh.started(2);
    f.gh.release();
    await f.gh.started(3);
    f.gh.release();
    await f.prs.idle();
    assert.deepEqual(
      f.gh.runs.map((run) => run.prs),
      [['acme/web#1', 'acme/web#2'], ['acme/api#3'], ['acme/web#1']],
      "the waiting refresh and fetch run one after the other, never beside each other's gh",
    );
  },
);

test(
  'a failed gh: one log line with the counts, nothing of the address or of what gh said; the pull request is "can\'t read"',
  LIMIT,
  async (t) => {
    const f = fixture(t, {
      answer: runResult({ code: 1, stderr: 'HTTP 502 for acme/web#1 (marker-secret)\n' }),
    });
    f.prs.fetch([PR1]);
    await f.prs.idle();
    assert.equal(levelOf(f.d, PR1), 'cant-read');
    assert.equal(f.changes(), 1, 'a failure is saved too');
    assert.deepEqual(f.logs, ['prs: 1 of 1 pull requests could not be read']);
  },
);

test(
  'a store that fails while the fetch saves: one log line by kind, never its message, and the next request still runs',
  LIMIT,
  async (t) => {
    let failing = true;
    const f = fixture(t, {
      deck: (deck) =>
        deckWith(deck, {
          store: {
            savePrResult(url, result) {
              if (failing) {
                throw Object.assign(new Error(`database is locked at ${url} (marker-secret)`), {
                  code: 'ERR_SQLITE_ERROR',
                  errcode: 5,
                });
              }
              deck.store.savePrResult(url, result);
            },
          },
        }),
    });
    f.prs.fetch([PR1]);
    await f.prs.idle();
    assert.deepEqual(f.logs, ['prs: the fetch failed (Error (ERR_SQLITE_ERROR))']);
    assert.equal(levelOf(f.d, PR1), 'unfetched', 'nothing saved');
    assert.equal(
      f.changes(),
      1,
      'told all the same: a run that throws may have saved a batch first',
    );
    failing = false;
    f.prs.fetch([PR1]);
    await f.prs.idle();
    assert.equal(levelOf(f.d, PR1), 'approved-green');
    assert.equal(f.changes(), 2);
  },
);

test(
  'a refresh that throws after it saved a batch still tells the lists (ruled on #90, review 2)',
  LIMIT,
  async (t) => {
    let saves = 0;
    const f = fixture(t, {
      deck: (deck) =>
        deckWith(deck, {
          store: {
            savePrResult(url, result) {
              if (++saves > 50) {
                throw Object.assign(new Error(`database is locked at ${url}`), {
                  code: 'ERR_SQLITE_ERROR',
                  errcode: 5,
                });
              }
              deck.store.savePrResult(url, result);
            },
          },
        }),
    });
    for (let n = 10; n < 70; n++)
      attachManualPr(f.d.deck, S1, `https://github.com/acme/web/pull/${n}`);
    f.prs.refresh(S1);
    await f.prs.idle();
    const levels = loadRows(f.d.deck)
      .flatMap((row) => row.prs)
      .map((pr) => pr.level);
    assert.equal(
      levels.filter((level) => level === 'approved-green').length,
      50,
      'the first batch saved',
    );
    assert.equal(f.changes(), 1);
    assert.deepEqual(f.logs, ['prs: the fetch failed (Error (ERR_SQLITE_ERROR))']);
  },
);

test(
  'a changed() that throws is logged by kind, and the next request still runs',
  LIMIT,
  async (t) => {
    let throws = true;
    const f = fixture(t, {
      changed() {
        if (throws) throw new RangeError('marker-secret');
      },
    });
    f.prs.fetch([PR1]);
    await f.prs.idle();
    assert.deepEqual(f.logs, ['prs: the lists were not told (RangeError)']);
    throws = false;
    f.prs.fetch([PR2]);
    await f.prs.idle();
    assert.equal(f.gh.runs.length, 2);
    assert.equal(f.changes(), 2);
  },
);

test(
  'the signal aborted while one runs: idle() resolves, the one waiting and any later request never start',
  LIMIT,
  async (t) => {
    let reads = 0;
    const f = fixture(t, {
      hold: 'signal',
      deck: (deck) =>
        deckWith(deck, {
          store: {
            prs() {
              reads++; // every run reads the pull requests first, before it asks gh
              return deck.store.prs();
            },
          },
        }),
    });
    f.prs.fetch([PR1]);
    await f.gh.started(1);
    f.prs.refresh(S2);
    f.stop.abort();
    const readsAtAbort = reads;
    await f.prs.idle();
    f.prs.fetch([PR3]);
    f.prs.refresh(S1);
    await f.prs.idle();
    assert.equal(
      reads,
      readsAtAbort,
      'no run started after the abort, not even one that gh would refuse',
    );
    assert.equal(f.gh.runs.length, 1);
    assert.equal(levelOf(f.d, PR1), 'unfetched', 'nothing saved after the abort');
    assert.equal(f.changes(), 0);
    assert.deepEqual(f.logs, [], 'an abort is no failure');
  },
);

test(
  'the signal aborted while a refresh runs: idle() resolves, nothing saved, nothing logged',
  LIMIT,
  async (t) => {
    const f = fixture(t, { hold: 'signal' });
    f.prs.refresh(S1);
    await f.gh.started(1);
    f.stop.abort();
    await f.prs.idle();
    assert.equal(levelOf(f.d, PR1), 'unfetched');
    assert.equal(f.changes(), 0);
    assert.deepEqual(f.logs, []);
  },
);

test('idle() with nothing to do resolves at once', LIMIT, async (t) => {
  const f = fixture(t);
  await f.prs.idle();
  assert.equal(f.gh.runs.length, 0);
});
