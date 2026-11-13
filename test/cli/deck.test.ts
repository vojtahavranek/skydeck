import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { refreshWithProgress, withDeck } from '../../src/cli/deck.ts';
import { ConfigError, SkydeckError } from '../../src/platform/errors.ts';
import { isoFromNs } from '../../src/platform/time.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type { Store } from '../../src/store/store.ts';
import { testContext } from '../helpers/context.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, SEC, T0 } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

/** What node:sqlite throws when the database is locked (SQLITE_BUSY = 5). */
const locked = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

const isClosed = (store: Store): boolean => {
  try {
    store.events();
    return false;
  } catch {
    return true;
  }
};

describe('withDeck', () => {
  test('hands fn an open deck, returns what fn returns and closes the store afterwards', async (t) => {
    const { ctx } = testContext(t);
    let seen: Deck | undefined;

    const result = await withDeck(ctx, { refresh: false }, async (deck) => {
      seen = deck;
      assert.equal(isClosed(deck.store), false);
      return 'value';
    });

    assert.equal(result, 'value');
    assert.ok(seen);
    assert.equal(isClosed(seen.store), true);
  });

  test('closes the store when fn throws, and rethrows that very error', async (t) => {
    const { ctx } = testContext(t);
    const failure = new SkydeckError('no');
    let seen: Deck | undefined;

    await assert.rejects(
      withDeck(ctx, { refresh: false }, async (deck) => {
        seen = deck;
        throw failure;
      }),
      (error: unknown) => error === failure,
    );

    assert.ok(seen);
    assert.equal(isClosed(seen.store), true);
  });

  test('refresh: true ingests the spool before fn, refresh: false does not', async (t) => {
    const c = testContext(t);
    mkdirSync(c.places.spoolDir, { recursive: true });
    const fields = {
      event: 'SessionStart' as const,
      timeNs: T0 - 20n * SEC,
      pid: 4242,
      input: hookInput('SessionStart', S1, { source: 'startup' }),
    };
    writeFileSync(join(c.places.spoolDir, spoolName(fields, 1)), spoolText(fields));

    const without = await withDeck(
      c.ctx,
      { refresh: false },
      async (deck) => deck.store.events().length,
    );
    const refreshed = await withDeck(
      c.ctx,
      { refresh: true },
      async (deck) => deck.store.events().length,
    );

    assert.equal(without, 0);
    assert.equal(refreshed, 1);
  });

  test('a config.json that is not valid rejects with a ConfigError and nothing runs', async (t) => {
    const c = testContext(t);
    mkdirSync(c.places.configDir, { recursive: true });
    writeFileSync(c.places.configPath, '{"colour":1}');
    let ran = false;

    await assert.rejects(
      withDeck(c.ctx, { refresh: true }, async () => {
        ran = true;
      }),
      ConfigError,
    );

    assert.equal(ran, false);
  });

  test('a failure of the database as a whole becomes one SkydeckError that names the database', async (t) => {
    const c = testContext(t);
    const original = locked();
    let seen: Deck | undefined;

    await assert.rejects(
      withDeck(c.ctx, { refresh: false }, async (deck) => {
        seen = deck;
        throw original;
      }),
      (error: unknown) =>
        error instanceof SkydeckError &&
        error.exitCode === 1 &&
        error.message === `the database ${c.places.dbPath} failed: database is locked` &&
        error.cause === original,
    );

    assert.ok(seen);
    assert.equal(isClosed(seen.store), true);
  });

  test('a database failure out of the refresh is named too, fn never runs and the store is closed', async (t) => {
    const c = testContext(t);
    c.proc.bootId = () => {
      throw locked(); // reconcile asks for it outside its per-item guard
    };
    let ran = false;

    await assert.rejects(
      withDeck(c.ctx, { refresh: true }, async () => {
        ran = true;
      }),
      (error: unknown) =>
        error instanceof SkydeckError &&
        error.message === `the database ${c.places.dbPath} failed: database is locked`,
    );

    assert.equal(ran, false);
    assert.equal(
      existsSync(`${c.places.dbPath}-wal`),
      false,
      'SQLite removes the WAL when the last connection closes',
    );
  });

  test('an error of one row, and an error that is not about the database, pass through unchanged', async (t) => {
    const c = testContext(t);
    const constraint = Object.assign(new Error('constraint failed'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 19, // SQLITE_CONSTRAINT: this row, not the database
    });
    const plain = new TypeError('bug');

    for (const error of [constraint, plain]) {
      await assert.rejects(
        withDeck(c.ctx, { refresh: false }, async () => {
          throw error;
        }),
        (thrown: unknown) => thrown === error,
      );
    }
  });
});

describe('refreshWithProgress', () => {
  const transcript = (d: TestDeck, sessionId: string): void => {
    const folder = join(d.deck.places.claudeHome, 'projects', 'demo');
    mkdirSync(folder, { recursive: true });
    const record = {
      type: 'user',
      sessionId,
      timestamp: isoFromNs(T0),
      cwd: '/w',
      entrypoint: 'cli',
    };
    writeFileSync(join(folder, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
  };

  test('on a terminal, the first scan shows its progress and clears the line at the end', (t) => {
    const d = testDeck(t, { stderrTTY: true });
    transcript(d, S1);

    refreshWithProgress(d.ctx, d.deck);

    assert.ok(d.stderr().includes('skydeck: reading transcripts 1/1'));
    assert.ok(d.stderr().startsWith('\rskydeck: reading transcripts'));
    assert.ok(d.stderr().endsWith('\r\x1b[K'));
  });

  test('once the first scan is done, nothing more is shown', (t) => {
    const d = testDeck(t, { stderrTTY: true });
    transcript(d, S1);
    refreshWithProgress(d.ctx, d.deck);
    const before = d.stderr();
    transcript(d, S2); // a changed file: the scan reports progress for it, the display must not

    const result = refreshWithProgress(d.ctx, d.deck);

    assert.equal(result.scan.read, 1);
    assert.equal(d.stderr(), before);
  });

  test('without a terminal on stderr nothing is ever written', (t) => {
    const d = testDeck(t, { stderrTTY: false });
    transcript(d, S1);

    const result = refreshWithProgress(d.ctx, d.deck);

    assert.equal(result.scan.read, 1);
    assert.equal(d.stderr(), '');
  });

  test('a first scan with nothing to read writes nothing, not even the clearing sequence', (t) => {
    const d = testDeck(t, { stderrTTY: true });

    refreshWithProgress(d.ctx, d.deck);

    assert.equal(d.stderr(), '');
  });

  test('the line is cleared when the scan fails half way', (t) => {
    const d = testDeck(t, { stderrTTY: true });
    transcript(d, S1);
    transcript(d, S2);
    let saves = 0;
    const failing = deckWith(d.deck, {
      store: {
        saveTranscript(row) {
          if (++saves === 2) throw locked();
          d.deck.store.saveTranscript(row);
        },
      },
    });

    assert.throws(() => refreshWithProgress(d.ctx, failing), /database is locked/);

    assert.ok(d.stderr().includes('reading transcripts 1/2'));
    assert.ok(d.stderr().endsWith('\r\x1b[K'));
  });
});
