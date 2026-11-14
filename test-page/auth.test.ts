// The page's key (S2 8.2.2 "where the page keeps its key", 15.2, 17.4; plan task 26): the vector
// of S2 8.2.2 through Web Crypto, a launch, the stored key, the token used once, and a server that
// cannot prove itself. Pages from real test servers (realTestPlatform, test/helpers/window.ts) and
// from stand-in servers (helpers/shell.ts).
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Page } from 'playwright';

import { controlClient } from '../src/window/client.ts';
import { sleep } from '../test/helpers/keeper.ts';
import { startTestServer } from '../test/helpers/window.ts';
import type { StartedServer } from '../test/helpers/window.ts';
import { browser, newPage } from './helpers/browser.ts';
import {
  assetBase,
  escape,
  connection,
  logOf,
  holdWriteLock,
  honest,
  PAGE_WAIT_MS,
  pageUrl,
  RECORDER,
  shownText,
  showsText,
  standinServer,
  storedKeyIs,
  storeKey,
  wrongProof,
} from './helpers/shell.ts';
import type { Logged } from './helpers/shell.ts';

/** The vector of S2 8.2.2 (pinned by test/window/auth.test.ts with Node.js's crypto). */
const VECTOR = {
  secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  token: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  sN: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
  cN: 'YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8',
  origin: 'http://127.0.0.1:47613',
  keyPage: 'I2kfIbEbNedSunJ5O-iFTu1xMaucB1TaOXfPgule6rE',
  keyServer: 'PCSrj1ouBWLrjthlVwJEhf7wtjQVvd99qg30B5MzN9k',
  launchPage: 'Cr2pbVrX3H03jJHuH4XHBB-cqsOPpzQCkE0JpYYrpm4',
  launchServer: 'JM1U0NnH9f1h_LMtP3J9aBD6GWG7dyJX0cRhjXBHCUw',
  wrapped: 'gIGCg4SFhoeIiYqL8-uwKEfl-QQONxqvTE8BdkWwIYHdwQkWN6_IJiXkHtLOZknj-CrYjV5peDDAyWDo',
};

/** The texts of S2 8.2.2 the page shows. */
const NO_KEY =
  'this window has no key; run skydeck window (or skydeck window --print-url for a browser tab)';
const NOT_VALID = "this window's key is not valid; run skydeck window again";
const ALARM =
  "this window's launch address was used by another program, which may now have skydeck's key; run skydeck window --new-secret";
const notSkydeck = (port: number): string =>
  `something answers on port ${port} that is not skydeck's server; nothing was sent to it`;

/** The modes of the hellos the page sent, in order. */
function hellos(log: Logged[]): (string | undefined)[] {
  return log.filter((entry) => entry.e === 'out' && entry.t === 'hello').map((entry) => entry.mode);
}

/** An HMAC-SHA256 signature with the server's secret, as base64url. */
function signer(started: StartedServer): (data: string) => string {
  const stored = started.d.deck.store.getKv('window_secret');
  assert.ok(stored !== null, 'the server made its secret');
  const secret = Buffer.from(stored, 'base64url');
  return (data) => createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

/** A launch token of the server, as `skydeck window` asks for one. */
async function mint(started: StartedServer): Promise<{ id: string; token: string }> {
  return controlClient(started.d.platform.net, started.d.files.serverSock).token(30);
}

/** A page with the recorder, made before the server so that it closes first. */
async function recordedPage(
  t: Parameters<typeof newPage>[0],
  chromium: Parameters<typeof newPage>[1],
): Promise<Page> {
  const page = await newPage(t, chromium);
  await page.addInitScript(RECORDER);
  return page;
}

test('the page and its key (S2 8.2.2)', async (t) => {
  const chromium = await browser(t);

  await t.test(
    "the vector of S2 8.2.2 through Web Crypto: the page's proofs and the unwrapped key's proofs are the pinned values",
    async (t) => {
      const standin = await standinServer(t);
      const page = await newPage(t, chromium);
      await page.goto(standin.url);
      const base = await assetBase(page);

      const got = await page.evaluate(
        async ({ base, v }) => {
          const auth = (await import(`${base}auth.js`)) as AuthModule;
          const bytes = (text: string): Uint8Array<ArrayBuffer> => {
            const decoded = auth.decodeKey(text);
            if (decoded === null) throw new Error(`not a key: ${text}`);
            return decoded;
          };
          const secret = await auth.hmacKey(bytes(v.secret));
          const token = await auth.hmacKey(bytes(v.token));
          const unwrapped = await auth.unwrapSecret(bytes(v.token), v.sN, v.cN, v.wrapped);
          if (unwrapped === null) return 'the key did not unwrap';
          const changedTag = `${v.wrapped.slice(0, -2)}AA`;
          return {
            keyPage: await auth.pageProof(secret, 'key', v.sN, v.cN, v.origin),
            keyServer: await auth.serverProofMatches(
              secret,
              'key',
              v.sN,
              v.cN,
              v.origin,
              v.keyServer,
            ),
            keyServerOfLaunch: await auth.serverProofMatches(
              secret,
              'key',
              v.sN,
              v.cN,
              v.origin,
              v.launchServer,
            ),
            launchPage: await auth.pageProof(token, 'launch', v.sN, v.cN, v.origin),
            launchServer: await auth.serverProofMatches(
              token,
              'launch',
              v.sN,
              v.cN,
              v.origin,
              v.launchServer,
            ),
            unwrappedPage: await auth.pageProof(unwrapped, 'key', v.sN, v.cN, v.origin),
            unwrappedServer: await auth.serverProofMatches(
              unwrapped,
              'key',
              v.sN,
              v.cN,
              v.origin,
              v.keyServer,
            ),
            unwrappedKind: [unwrapped.type, unwrapped.algorithm.name, unwrapped.extractable],
            exported: await crypto.subtle.exportKey('raw', unwrapped).then(
              () => true,
              () => false,
            ),
            changedTag: await auth.unwrapSecret(bytes(v.token), v.sN, v.cN, changedTag),
            otherNonces: await auth.unwrapSecret(bytes(v.token), v.cN, v.sN, v.wrapped),
            nonces: [
              auth.isNonce(v.sN),
              auth.isNonce(auth.newNonce()),
              auth.isNonce(`${v.sN.slice(0, -1)}9`), // the two spare bits set: not canonical
              auth.isNonce(`${v.sN}=`),
              auth.isNonce(v.sN.slice(1)),
            ],
          };
        },
        { base, v: VECTOR },
      );

      assert.deepEqual(got, {
        keyPage: VECTOR.keyPage,
        keyServer: true,
        keyServerOfLaunch: false,
        launchPage: VECTOR.launchPage,
        launchServer: true,
        unwrappedPage: VECTOR.keyPage,
        unwrappedServer: true,
        unwrappedKind: ['secret', 'HMAC', false],
        exported: false,
        changedTag: null,
        otherNonces: null,
        nonces: [true, true, false, false, false],
      });
    },
  );

  await t.test(
    'a launch: the token leaves the address before the first WebSocket; the key is stored, cannot be exported, survives a reload and still signs',
    async (t) => {
      const page = await recordedPage(t, chromium);
      const started = await startTestServer(t);
      const { id, token } = await mint(started);
      const port = started.server.port;

      await page.goto(pageUrl(port, token));
      await connection(page, 'open');

      assert.equal(page.url(), pageUrl(port));
      const log = await logOf(page);
      const sockets = log.filter((entry) => entry.e === 'ws');
      assert.ok(sockets.length > 0);
      for (const socket of sockets) assert.equal(socket.href, pageUrl(port), 'no token left');
      assert.deepEqual(hellos(log), ['launch']);
      const client = controlClient(started.d.platform.net, started.d.files.serverSock);
      assert.equal(await client.tokenState(id), 'used');
      const sign = signer(started);
      assert.deepEqual(await storedKeyIs(page, sign), {
        signs: true,
        extractable: false,
        exported: false,
      });

      await page.reload();
      await connection(page, 'open');
      assert.deepEqual(hellos(await logOf(page)), ['launch', 'key']);
      assert.deepEqual(await storedKeyIs(page, sign), {
        signs: true,
        extractable: false,
        exported: false,
      });
    },
  );

  await t.test(
    'a page that holds a stored key and is given a token uses mode launch and ends up with the new key',
    async (t) => {
      const page = await recordedPage(t, chromium);
      const started = await startTestServer(t);
      const port = started.server.port;
      await page.goto(pageUrl(port));
      await storeKey(page, randomBytes(32)); // an old key, of a secret that was replaced
      const { token } = await mint(started);
      await page.goto('about:blank'); // a new load, not a change of the fragment only

      await page.goto(pageUrl(port, token));
      await connection(page, 'open');

      assert.deepEqual(hellos(await logOf(page)), ['launch']);
      assert.deepEqual(await storedKeyIs(page, signer(started)), {
        signs: true,
        extractable: false,
        exported: false,
      });
    },
  );

  await t.test(
    'a token the server does not know: the page says its key is not valid and never presents the token, or its stored key, again',
    async (t) => {
      const page = await recordedPage(t, chromium);
      const started = await startTestServer(t);
      const port = started.server.port;
      await page.goto(pageUrl(port));
      await storeKey(
        page,
        Buffer.from(started.d.deck.store.getKv('window_secret') ?? '', 'base64url'),
      );
      await page.goto('about:blank');

      await page.goto(pageUrl(port, randomBytes(32).toString('base64url')));
      await showsText(page, '#problem', new RegExp(`^${escape(NOT_VALID)}$`));
      await connection(page, 'fatal');
      await sleep(3000); // three reconnect intervals

      assert.deepEqual(hellos(await logOf(page)), ['launch']);
    },
  );

  await t.test(
    'a token another page used first: the alarm text, and the token is never presented again',
    async (t) => {
      const first = await recordedPage(t, chromium);
      const second = await recordedPage(t, chromium);
      const started = await startTestServer(t);
      const { token } = await mint(started);
      await first.goto(pageUrl(started.server.port, token));
      await connection(first, 'open');

      await second.goto(pageUrl(started.server.port, token));
      await showsText(second, '#problem', new RegExp(`^${escape(ALARM)}$`));
      await sleep(3000);

      assert.deepEqual(hellos(await logOf(second)), ['launch']);
    },
  );

  await t.test(
    'a page with neither a token nor a stored key says so and opens no connection',
    async (t) => {
      const page = await recordedPage(t, chromium);
      const standin = await standinServer(t);

      await page.goto(standin.url);
      await showsText(page, '#problem', new RegExp(`^${escape(NO_KEY)}$`));
      await connection(page, 'fatal');

      assert.deepEqual(
        (await logOf(page)).filter((entry) => entry.e === 'ws'),
        [],
      );
      assert.equal(standin.upgrades(), 0);
    },
  );

  await t.test(
    'mode launch: a hello closed 1013 while the store is locked is tried again with the same token; once the store is free the page is welcomed and keeps its key, and no alarm is raised (ruled, task 26)',
    async (t) => {
      const page = await recordedPage(t, chromium);
      const started = await startTestServer(t);
      const { id, token } = await mint(started);
      const lock = holdWriteLock(t, join(started.d.s.skydeckHome, 'data', 'skydeck.db'));
      await lock.held;

      await page.goto(pageUrl(started.server.port, token));
      const deadline = performance.now() + PAGE_WAIT_MS;
      while (!(await logOf(page)).some((entry) => entry.e === 'close' && entry.code === 1013)) {
        assert.ok(performance.now() < deadline, 'a close 1013 at the hello');
        await sleep(100);
      }
      lock.release();
      await connection(page, 'open');

      const modes = hellos(await logOf(page));
      assert.ok(modes.length >= 2, JSON.stringify(modes));
      assert.ok(
        modes.every((mode) => mode === 'launch'),
        JSON.stringify(modes),
      );
      const client = controlClient(started.d.platform.net, started.d.files.serverSock);
      assert.equal(await client.tokenState(id), 'used');
      assert.equal(started.d.deck.store.getKv('window_alarm'), null);
      assert.equal(await shownText(page, '#problem'), '');
      assert.deepEqual(await storedKeyIs(page, signer(started)), {
        signs: true,
        extractable: false,
        exported: false,
      });
    },
  );

  await t.test(
    'mode launch: a 503 at the upgrade presented no token, so the page tries again with it and gets its key',
    async (t) => {
      const secret = randomBytes(32);
      const token = randomBytes(32);
      const page = await recordedPage(t, chromium);
      const standin = await standinServer(t, {
        refuse: 2,
        socket: honest(secret, { token }),
      });

      await page.goto(pageUrl(standin.port, token.toString('base64url')));
      await connection(page, 'open');

      assert.equal(standin.upgrades(), 3);
      assert.deepEqual(hellos(await logOf(page)), ['launch']);
      assert.deepEqual(
        await storedKeyIs(page, (data) =>
          createHmac('sha256', secret).update(data, 'utf8').digest('base64url'),
        ),
        { signs: true, extractable: false, exported: false },
      );
    },
  );

  await t.test(
    'mode launch: a connection that ends after the hello was sent ends it — "run skydeck window again", and the token is never presented again',
    async (t) => {
      const token = randomBytes(32);
      const page = await recordedPage(t, chromium);
      const standin = await standinServer(t, {
        socket: honest(randomBytes(32), { token, before: () => 'drop-after-hello' }),
      });

      await page.goto(pageUrl(standin.port, token.toString('base64url')));
      await showsText(page, '#problem', new RegExp(`^${escape(NOT_VALID)}$`));
      await connection(page, 'fatal');
      await sleep(3000);

      assert.deepEqual(hellos(await logOf(page)), ['launch']);
      assert.equal(standin.connections.length, 1);
    },
  );

  for (const mode of ['key', 'launch'] as const) {
    await t.test(
      `mode ${mode} against a stand-in server whose proof is wrong: the page sends nothing after its hello and shows the warning with the port`,
      async (t) => {
        const page = await recordedPage(t, chromium);
        const standin = await standinServer(t, { socket: wrongProof });
        await page.goto(pageUrl(standin.port));
        await storeKey(page, randomBytes(32));
        await sleep(500);
        standin.connections.length = 0; // what the page did before it held a key
        await page.goto('about:blank');

        await page.goto(
          mode === 'key'
            ? standin.url
            : pageUrl(standin.port, randomBytes(32).toString('base64url')),
        );
        await showsText(page, '#problem', new RegExp(`^${escape(notSkydeck(standin.port))}$`));
        await connection(page, 'fatal');
        await sleep(3000);

        assert.equal(standin.connections.length, 1, 'no second connection');
        const [conn] = standin.connections;
        assert.ok(conn !== undefined);
        assert.deepEqual(
          conn.received.map((text) => {
            const message = JSON.parse(text) as { t: string; mode?: string };
            return [message.t, message.mode];
          }),
          [['hello', mode]],
        );
      },
    );
  }
});

/** The functions of web/auth.js these tests call in the page. */
interface AuthModule {
  decodeKey(text: string): Uint8Array<ArrayBuffer> | null;
  isNonce(text: string): boolean;
  newNonce(): string;
  hmacKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey>;
  pageProof(key: CryptoKey, mode: string, sN: string, cN: string, origin: string): Promise<string>;
  serverProofMatches(
    key: CryptoKey,
    mode: string,
    sN: string,
    cN: string,
    origin: string,
    proof: string,
  ): Promise<boolean>;
  unwrapSecret(
    token: Uint8Array<ArrayBuffer>,
    sN: string,
    cN: string,
    wrapped: string,
  ): Promise<CryptoKey | null>;
}
