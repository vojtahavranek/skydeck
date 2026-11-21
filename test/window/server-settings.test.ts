// The settings screen on the window's server (follow-up F36, issue #164; S2 12.13, 8.2.3): `act
// settings`, `setting-set` and `setting-default` from two pages of one server — the screen in the
// result, every page's screen following a change (`settings`), a refusal telling nobody and
// changing nothing, also for what a page sends by hand —, and every AT ONCE key changing what the
// RUNNING server does, with no restart: the rows' groups and ticket links at the next list, the
// next link, the next restore's batch, memory floor and wait. A key read at the server's start
// (window.keepAlive) changes the file only: nothing is started or stopped. The ticket reads and
// the pull-request refresh are in ticket-fetches.test.ts and tick.test.ts. In the test process
// (A19) on realTestPlatform, with real keepers running the stand-in; never a real home.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { Detached, Platform } from '../../src/platform/types.ts';
import type { ListMessage, SettingsPayload } from '../../src/window/protocol.ts';
import { sleep, until } from '../helpers/keeper.ts';
import { S1 } from '../helpers/platform.ts';
import { connectTestPage, rowsOf, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';
import { earlierId, postRestore, restoreSandbox } from '../helpers/window-restore.ts';
import type { RestoreSandbox } from '../helpers/window-restore.ts';

const RUNDLL32_EXE = '/mnt/c/Windows/System32/rundll32.exe';
const X1 = earlierId(1);
const X2 = earlierId(2);
const X3 = earlierId(3);

function configOf(d: ServerSandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(d.deck.places.configPath, 'utf8')) as Record<string, unknown>;
}

function valueOf(payload: SettingsPayload | undefined, key: string): unknown {
  return payload?.settings.find((one) => one.key === key)?.value;
}

/** The `settings` messages `page` received so far. */
function screens(page: TestPage): SettingsPayload[] {
  return page.all.flatMap((item) =>
    'text' in item && item.text.t === 'settings' ? [item.text.settings] : [],
  );
}

/** A server on `d` (S1 resumable) and two pages of it that list S1. */
async function twoPages(
  t: Parameters<typeof serverSandbox>[0],
  d: ServerSandbox,
  options: { platform?: (p: Platform) => Platform; selected?: boolean } = {},
): Promise<{ test: TestServer; a: TestPage; b: TestPage }> {
  d.resumable(S1);
  const test = await d.start(options.platform === undefined ? {} : { platform: options.platform });
  const view = options.selected === true ? { selected: S1 } : {};
  const a = await connectTestPage(t, d, test.server, { view });
  const b = await connectTestPage(t, d, test.server, { view });
  for (const page of [a, b]) {
    await page.list((list) => rowsOf(list).some((row) => row.id === S1), 'S1 listed');
  }
  return { test, a, b };
}

function rowOf(list: ListMessage): ListMessage['sections'][number]['rows'][number] | undefined {
  return rowsOf(list).find((row) => row.id === S1);
}

describe('the settings through the server (S2 12.13, 8.2.3)', () => {
  test("act settings: the screen in the result — the file's path, every setting, the sandbox's values", async (t) => {
    const d = serverSandbox(t, { config: { prRefreshMinutes: 7 } });
    const { a } = await twoPages(t, d);
    const result = await a.act({ kind: 'settings' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.settings?.path, d.deck.places.configPath);
    assert.equal(valueOf(result.settings, 'prRefreshMinutes'), 7);
    assert.equal(valueOf(result.settings, 'claudeCommand'), d.standin);
    assert.equal(result.settings?.problem, null);
  });

  test("a change from page A: the file holds it, A's result and B's screen say so, B's next list follows; Default removes it", async (t) => {
    const d = serverSandbox(t, { config: { prRefreshMinutes: 7 } });
    const { a, b } = await twoPages(t, d);
    const result = await a.act({ kind: 'setting-set', key: 'prRefreshMinutes', value: 9 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(valueOf(result.settings, 'prRefreshMinutes'), 9);
    assert.equal(configOf(d)['prRefreshMinutes'], 9);
    assert.equal(configOf(d)['claudeCommand'], d.standin, 'every other key stays');
    await until(
      () => screens(b).some((screen) => valueOf(screen, 'prRefreshMinutes') === 9),
      "B's screen follows",
      WAIT_MS,
    );
    const reset = await b.act({ kind: 'setting-default', key: 'prRefreshMinutes' });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(Object.hasOwn(configOf(d), 'prRefreshMinutes'), false);
    await until(
      () => screens(a).some((screen) => valueOf(screen, 'prRefreshMinutes') === 5),
      "A's screen follows",
      WAIT_MS,
    );
  });

  test('what a page sends by hand is refused and changes nothing: a shown-only key, an unknown key, a wrong type, a value config.json refuses (a link with a password, a bad pattern, a number out of range)', async (t) => {
    const d = serverSandbox(t, { config: { prRefreshMinutes: 7 } });
    const { a, b } = await twoPages(t, d);
    const before = readFileSync(d.deck.places.configPath, 'utf8');
    const refusals: [Record<string, unknown>, string | RegExp][] = [
      [{ key: 'claudeCommand', value: '/bin/sh' }, /in the file only/],
      [{ key: 'window.edge', value: '/bin/sh' }, /in the file only/],
      [{ key: 'ticketStatus', value: null }, /in the file only/],
      [{ key: 'window.port', value: 80 }, /in the file only/],
      [{ key: 'claudeHome', value: '/' }, /in the file only/],
      [{ key: 'window.profileDir', value: 'C:\\' }, /in the file only/],
      [{ key: 'nonsense', value: 1 }, /no setting/],
      [{ key: 'window', value: null }, /no setting/],
      [{ key: 'prRefreshMinutes', value: '9' }, '"prRefreshMinutes" must be a positive integer'],
      [
        { key: 'ticketUrl', value: 'https://user:secret@example.com/browse/{key}' },
        '"ticketUrl" must be null or an http or https address with {key} once, after its host',
      ],
      [{ key: 'groupPattern', value: '(' }, /^"groupPattern" is not a valid regular expression/],
      [{ key: 'restoreBatch', value: 0 }, '"restoreBatch" must be a positive integer'],
      [{ key: 'ticketRefreshMinutes', value: 1441 }, /from 1 to 1440/],
    ];
    for (const [fields, error] of refusals) {
      const result = await a.act({ kind: 'setting-set', ...fields } as never);
      assert.equal(result.ok, false, JSON.stringify(fields));
      if (typeof error === 'string') assert.equal(result.error, error, JSON.stringify(fields));
      else assert.match(result.error ?? '', error, JSON.stringify(fields));
      assert.ok(result.settings !== undefined, 'the screen as it is comes with a refusal');
    }
    for (const key of ['claudeHome', 'nonsense']) {
      const result = await a.act({ kind: 'setting-default', key });
      assert.equal(result.ok, false, key);
    }
    assert.equal(readFileSync(d.deck.places.configPath, 'utf8'), before);
    await sleep(300);
    assert.deepEqual(screens(b), [], 'a refusal tells nobody');
    assert.deepEqual(screens(a), []);
  });

  test("a message no page sends — a whole configuration, a list, a boolean, an over-long value, a field more — is refused by the page messages' parser: the connection is closed (1008), nothing changed", async (t) => {
    const d = serverSandbox(t, { config: { prRefreshMinutes: 7 } });
    const { test: server, b } = await twoPages(t, d);
    const before = readFileSync(d.deck.places.configPath, 'utf8');
    for (const fields of [
      { kind: 'setting-set', key: 'prRefreshMinutes', value: { prRefreshMinutes: 1 } },
      { kind: 'setting-set', key: 'window', value: { links: 'edge' } },
      { kind: 'setting-set', key: 'prRefreshMinutes', value: [1] },
      { kind: 'setting-set', key: 'prRefreshMinutes', value: true },
      {
        kind: 'setting-set',
        key: 'ticketUrl',
        value: `https://example.com/${'a'.repeat(4096)}{key}`,
      },
      { kind: 'setting-set', key: 'k'.repeat(1025), value: 1 },
      { kind: 'setting-set', key: 'prRefreshMinutes', value: 9, path: '/tmp/x' },
      { kind: 'setting-set', key: 'prRefreshMinutes' },
      { kind: 'setting-default', key: 7 },
      { kind: 'settings', key: 'prRefreshMinutes' },
    ]) {
      const page = await connectTestPage(t, d, server.server);
      page.send({ t: 'act', id: 1, ...fields });
      const closed = await page.closed;
      assert.equal(closed.code, 1008, JSON.stringify(fields));
    }
    // JSON reads 1e999 as Infinity, which JSON.stringify would write as null (ticketUrl takes
    // null): refused as a number that is not finite, nothing written.
    for (const number of ['1e999', '-1e999']) {
      const page = await connectTestPage(t, d, server.server);
      page.sendRaw(`{"t":"act","id":1,"kind":"setting-set","key":"ticketUrl","value":${number}}`);
      assert.equal((await page.closed).code, 1008, number);
    }
    assert.equal(readFileSync(d.deck.places.configPath, 'utf8'), before);
    assert.deepEqual(screens(b), []);
  });

  test('every refusal is sanitised: a key that quotes an escape sequence or a line break reaches the page without it', async (t) => {
    const d = serverSandbox(t);
    const { a } = await twoPages(t, d);
    const result = await a.act({ kind: 'setting-set', key: 'x\u001b[31m\ny', value: 1 });
    assert.equal(result.ok, false);
    for (const line of [...result.lines, result.error ?? '']) {
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line), JSON.stringify(line));
    }
  });
});

describe('AT ONCE: the running server uses the new value from its next use (G4)', () => {
  test('groupPattern: the next list takes the group from the title by the new pattern, in every page', async (t) => {
    const d = serverSandbox(t);
    const { a, b } = await twoPages(t, d);
    assert.equal(
      (await a.act({ kind: 'label', sessionId: S1, text: 'abc-12 fix the retry' })).ok,
      true,
    );
    const before = await b.list(
      (list) => rowOf(list)?.title === 'abc-12 fix the retry',
      'labelled',
    );
    assert.equal(rowOf(before)?.group, null, 'the default pattern takes upper case keys only');
    const result = await a.act({
      kind: 'setting-set',
      key: 'groupPattern',
      value: '^[a-z]+-[0-9]+',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await b.list((list) => rowOf(list)?.group === 'abc-12', "the group in B's next list", 5000);
  });

  test("ticketUrl: the selected session's ticket link at the next list, and a bare key is taken as a ticket", async (t) => {
    const d = serverSandbox(t);
    const { a } = await twoPages(t, d, { selected: true });
    assert.equal((await a.act({ kind: 'label', sessionId: S1, text: 'ABC-12 try' })).ok, true);
    await a.list((list) => list.selected?.ticketKeys === false, 'no ticketUrl yet');
    const refused = await a.act({ kind: 'ticket', sessionId: S1, text: 'ABC-13' });
    assert.equal(refused.ok, false, 'a bare key needs ticketUrl');
    const result = await a.act({
      kind: 'setting-set',
      key: 'ticketUrl',
      value: 'https://tickets.example.com/browse/{key}',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await a.list(
      (list) => list.selected?.ticketUrl === 'https://tickets.example.com/browse/ABC-12',
      'the ticket link',
      5000,
    );
    const taken = await a.act({ kind: 'ticket', sessionId: S1, text: 'ABC-13' });
    assert.equal(taken.ok, true, JSON.stringify(taken));
    assert.equal(d.deck.store.meta(S1)?.ticket, 'https://tickets.example.com/browse/ABC-13');
  });

  test('window.links: the next link goes where the new value says', async (t) => {
    const d = serverSandbox(t, { window: { links: 'edge' } });
    const rundll32: (readonly string[])[] = [];
    const platform = (p: Platform): Platform => ({
      ...p,
      processes: {
        ...p.processes,
        startDetached(command, args, options) {
          if (command === RUNDLL32_EXE) {
            rundll32.push(args);
            return Promise.resolve<Detached>({ pid: 4_000_001, exited: new Promise(() => {}) });
          }
          return p.processes.startDetached(command, args, options);
        },
      },
    });
    const { a } = await twoPages(t, d, { platform });
    assert.equal((await a.act({ kind: 'open-link', url: 'https://example.com/one' })).ok, true);
    await until(() => d.edgeCalls().length === 1, 'the Edge stub ran', WAIT_MS);
    const set = await a.act({ kind: 'setting-set', key: 'window.links', value: 'default' });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal((await a.act({ kind: 'open-link', url: 'https://example.com/two' })).ok, true);
    assert.deepEqual(rundll32, [['url.dll,FileProtocolHandler', 'https://example.com/two']]);
    await sleep(200);
    assert.deepEqual(d.edgeCalls(), [['https://example.com/one']]);
  });
});

describe('AT ONCE: the next restore (G4)', () => {
  /** X1, X2, X3 of the earlier boot, none with an end: all three offered, preselected. */
  function threeSessions(r: RestoreSandbox): void {
    const baseNs = r.d.platform.clock.nowNs() - 90n * 60_000_000_000n;
    r.earlierBoot([
      { sessionId: X1, startNs: baseNs + 20n * 60_000_000_000n },
      { sessionId: X2, startNs: baseNs + 10n * 60_000_000_000n },
      { sessionId: X3, startNs: baseNs },
    ]);
  }

  test('restoreBatch 2 changed to 1: the next restore opens one session at a time', async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    threeSessions(r);
    const test = await r.d.start();
    const page = await connectTestPage(t, r.d, test.server);
    const set = await page.act({ kind: 'setting-set', key: 'restoreBatch', value: 1 });
    assert.equal(set.ok, true, JSON.stringify(set));
    const answer = postRestore(r.d, { sessionIds: [X1, X2, X3], all: false });
    await until(() => r.waiting(X1), 'the first at its gate', WAIT_MS);
    await sleep(500);
    assert.equal(r.waiting(X2), false, 'restoreBatch 1: the second is not opened yet');
    r.openAll();
    assert.equal((await answer.ended).status, 200);
    assert.equal(answer.texts().at(-1), 'restore finished: 3 started');
  });

  test('restoreMinFreeMb 1 changed to 999999999: the next restore stops before its first batch', async (t) => {
    const r = restoreSandbox(t);
    threeSessions(r);
    const test = await r.d.start();
    const page = await connectTestPage(t, r.d, test.server);
    const set = await page.act({
      kind: 'setting-set',
      key: 'restoreMinFreeMb',
      value: 999_999_999,
    });
    assert.equal(set.ok, true, JSON.stringify(set));
    const answer = postRestore(r.d, { sessionIds: [X1, X2], all: false });
    assert.equal((await answer.ended).status, 200);
    assert.match(
      answer.texts()[0] ?? '',
      /^stopped: only [0-9]+ MiB of memory available, less than restoreMinFreeMb \(999999999 MiB\)$/,
    );
    assert.equal(r.waiting(X1) || r.waiting(X2), false, 'no program');
  });

  test('restoreStartTimeoutSeconds 120 changed to 1: the next restore gives up on a session that does not start', async (t) => {
    const r = restoreSandbox(t, { config: { restoreStartTimeoutSeconds: 120 } });
    threeSessions(r);
    const test = await r.d.start();
    const page = await connectTestPage(t, r.d, test.server);
    const set = await page.act({
      kind: 'setting-set',
      key: 'restoreStartTimeoutSeconds',
      value: 1,
    });
    assert.equal(set.ok, true, JSON.stringify(set));
    const answer = postRestore(r.d, { sessionIds: [X1], all: false });
    // Its gate is never opened: with 120 s the restore would still wait when WAIT_MS is over.
    assert.equal((await within(answer.ended)).status, 200);
    assert.match(answer.texts()[0] ?? '', new RegExp(`^timed out ${X1.slice(0, 8)} `));
  });
});

describe('a key read at the start changes the file only (G4)', () => {
  test('window.keepAlive: the file says "wsl", the running keep-alive stays as it is, and the screen says it applies after the window restarts', async (t) => {
    const d = serverSandbox(t); // keepAlive "off" (writeWindowConfig)
    const { test: server, a } = await twoPages(t, d);
    assert.equal(a.welcome.keepAlive.mode, 'off');
    const result = await a.act({ kind: 'setting-set', key: 'window.keepAlive', value: 'wsl' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((configOf(d)['window'] as Record<string, unknown>)['keepAlive'], 'wsl');
    const keepAlive = result.settings?.settings.find((one) => one.key === 'window.keepAlive');
    assert.deepEqual([keepAlive?.pending, keepAlive?.runningText], [true, '"off"']);
    const c = await connectTestPage(t, d, server.server);
    assert.deepEqual(c.welcome.keepAlive, a.welcome.keepAlive, 'nothing was started or stopped');
  });
});

/** The promise, or a failure once WAIT_MS is over. */
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not within ${WAIT_MS} ms`)), WAIT_MS);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
