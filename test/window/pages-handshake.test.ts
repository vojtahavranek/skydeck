// The handshake of S2 8.2.2 and the checks at the upgrade (S2 8.2.1, 15.1), task 17: pages behind
// a real listener on 127.0.0.1 with the fake clock (testPlatform), `ws` as the page.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Store } from '../../src/store/store.ts';
import { isNonce, pageProof, serverProof } from '../../src/window/auth.ts';
import {
  SERVER_ID,
  challengeOf,
  connectPage,
  freshNonce,
  nonce,
  openKey,
  openPage,
  rawRequest,
  refusedUpgrade,
  roundTrip,
  startPages,
  until,
  windowId,
  within,
} from '../helpers/pages.ts';
import type { PageClient, PagesFixture } from '../helpers/pages.ts';

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function assertSecurityHeaders(
  headers: Record<string, string | string[] | undefined>,
  what: string,
): void {
  for (const [name, value] of Object.entries(SECURITY)) {
    assert.equal(headers[name], value, `${what}: ${name}`);
  }
  assert.match(String(headers['content-security-policy']), /default-src 'none'/, what);
  assert.match(String(headers['content-security-policy']), /frame-ancestors 'none'/, what);
  assert.equal(headers['cache-control'], 'no-store', `${what}: cache-control`);
  for (const name of Object.keys(headers)) {
    assert.ok(!name.startsWith('access-control-'), `${what}: no CORS header (${name})`);
  }
}

/** The headers of a raw HTTP answer, by lower-case name. */
function headersOf(answer: string): Record<string, string> {
  const [head = ''] = answer.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function upgradeTo(f: PagesFixture, method: string, path: string): string {
  return (
    `${method} ${path} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${f.port}\r\n` +
    `Origin: ${f.origin}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    '\r\n'
  );
}

/** Sends a hello in `mode` with a proof made with `key`; returns the nonces. */
async function hello(
  client: PageClient,
  f: PagesFixture,
  mode: 'key' | 'launch',
  key: Uint8Array,
  cN = freshNonce(),
): Promise<{ sN: string; cN: string }> {
  const sN = await challengeOf(client);
  client.send({
    t: 'hello',
    protocol: 1,
    mode,
    nonce: cN,
    proof: pageProof(key, mode, sN, cN, f.origin),
  });
  return { sN, cN };
}

async function closedWith(client: PageClient): Promise<number> {
  return (await within('the close', client.closed)).code;
}

function start(client: PageClient): void {
  client.send({
    t: 'start',
    assetVersion: 'build123',
    windowId: windowId(),
    focused: true,
    theme: { fg: '#ffffff', bg: '#000000' },
  });
}

describe('pages: the challenge', () => {
  test('is the first message, with a nonce of 32 bytes in base64url, new for every connection', async (t) => {
    const f = await startPages(t);
    const one = await connectPage(t, f);
    const two = await connectPage(t, f);
    const first = await one.nextText();
    const second = await two.nextText();
    assert.equal(first.t, 'challenge');
    assert.ok(first.t === 'challenge' && second.t === 'challenge');
    assert.equal(first.protocol, 1);
    assert.equal(first.nonce.length, 43);
    assert.ok(isNonce(first.nonce));
    assert.notEqual(first.nonce, second.nonce);
    assert.deepEqual(Object.keys(first).sort(), ['nonce', 'protocol', 't']);
  });
});

describe('pages: mode key', () => {
  test("a correct hello gets welcome with the server's proof of 2.8 and no key", async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    const { sN, cN } = await hello(client, f, 'key', f.secret);
    const welcome = await client.nextText('the welcome');
    assert.equal(welcome.t, 'welcome');
    assert.ok(welcome.t === 'welcome');
    assert.equal(welcome.proof, serverProof(f.secret, 'key', sN, cN, f.origin));
    assert.equal('key' in welcome, false);
    assert.deepEqual(
      { ...welcome, proof: undefined },
      { t: 'welcome', proof: undefined, ...f.welcome },
    );
    assert.equal(welcome.serverId, SERVER_ID);
  });

  test('a wrong proof closes with 4003', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    await hello(client, f, 'key', new Uint8Array(32).fill(7));
    assert.equal(await closedWith(client), 4003);
  });

  test("a proof made with the server's label closes with 4003", async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    const sN = await challengeOf(client);
    const cN = freshNonce();
    const proof = serverProof(f.secret, 'key', sN, cN, f.origin);
    client.send({ t: 'hello', protocol: 1, mode: 'key', nonce: cN, proof });
    assert.equal(await closedWith(client), 4003);
  });

  test("a page's proof replayed on a new connection (a new server nonce) closes with 4003", async (t) => {
    const f = await startPages(t);
    const first = await connectPage(t, f);
    const { sN, cN } = await hello(first, f, 'key', f.secret);
    assert.equal((await first.nextText()).t, 'welcome');
    const replayed = await connectPage(t, f);
    const sN2 = await challengeOf(replayed);
    assert.notEqual(sN2, sN);
    const proof = pageProof(f.secret, 'key', sN, cN, f.origin);
    replayed.send({ t: 'hello', protocol: 1, mode: 'key', nonce: cN, proof });
    assert.equal(await closedWith(replayed), 4003);
  });

  test('a proof made for another origin closes with 4003', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    const sN = await challengeOf(client);
    const cN = freshNonce();
    const proof = pageProof(f.secret, 'key', sN, cN, 'http://localhost:1');
    client.send({ t: 'hello', protocol: 1, mode: 'key', nonce: cN, proof });
    assert.equal(await closedWith(client), 4003);
  });

  test('a proof made with the secret in mode launch closes with 4003', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    await hello(client, f, 'launch', f.secret);
    assert.equal(await closedWith(client), 4003);
  });
});

describe('pages: mode launch', () => {
  test('a minted token gets welcome with a key that opens with the token and both nonces', async (t) => {
    const f = await startPages(t);
    const minted = f.tokens.mint(30);
    const client = await connectPage(t, f);
    const { sN, cN } = await hello(client, f, 'launch', minted.token);
    const welcome = await client.nextText('the welcome');
    assert.ok(welcome.t === 'welcome', welcome.t);
    assert.equal(welcome.proof, serverProof(minted.token, 'launch', sN, cN, f.origin));
    assert.equal(typeof welcome.key, 'string');
    assert.deepEqual(openKey(welcome.key ?? '', minted.token, sN, cN), f.secret);
    assert.equal(f.tokens.state(minted.id), 'used');
    assert.equal(f.store.getKv('window_alarm'), null);
  });

  test('the key opens with nothing else: not with another token, not with other nonces', async (t) => {
    const f = await startPages(t);
    const minted = f.tokens.mint(30);
    const client = await connectPage(t, f);
    const { sN, cN } = await hello(client, f, 'launch', minted.token);
    const welcome = await client.nextText('the welcome');
    assert.ok(welcome.t === 'welcome');
    const key = welcome.key ?? '';
    assert.throws(() => openKey(key, new Uint8Array(32), sN, cN));
    assert.throws(() => openKey(key, minted.token, cN, sN));
  });

  test('the same token presented by a second page closes with 4004 and raises the alarm', async (t) => {
    const f = await startPages(t);
    const minted = f.tokens.mint(30);
    const first = await connectPage(t, f);
    await hello(first, f, 'launch', minted.token);
    assert.equal((await first.nextText()).t, 'welcome');

    const second = await connectPage(t, f);
    await hello(second, f, 'launch', minted.token);
    assert.equal(await closedWith(second), 4004);
    assert.equal(f.store.getKv('window_alarm'), String(f.clock.nowNs()));
    assert.equal(f.tokens.state(minted.id), 'reused');
    assert.equal(first.isClosed(), false, 'the page that used it first stays');
  });

  test('4004 stands when the alarm cannot be recorded, and the failure is logged by its kind', async (t) => {
    const f = await startPages(t, {
      store: (store) =>
        new Proxy(store, {
          get(target, key) {
            if (key === 'setKv') {
              return (name: Parameters<Store['setKv']>[0], value: string) => {
                if (name === 'window_alarm') {
                  throw Object.assign(new Error('database is locked: SECRET-MESSAGE'), {
                    code: 'ERR_SQLITE_ERROR',
                  });
                }
                target.setKv(name, value);
              };
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
        }) as Store,
    });
    const minted = f.tokens.mint(30);
    const first = await connectPage(t, f);
    await hello(first, f, 'launch', minted.token);
    assert.equal((await first.nextText()).t, 'welcome');
    const second = await connectPage(t, f);
    await hello(second, f, 'launch', minted.token);
    assert.equal(await closedWith(second), 4004);
    assert.ok(
      f.logs.some((line) => line.includes('ERR_SQLITE_ERROR')),
      `the alarm's failure is logged: ${JSON.stringify(f.logs)}`,
    );
    assert.ok(!f.logs.some((line) => line.includes('SECRET-MESSAGE')), 'never its message');
  });

  test('an unknown token closes with 4003', async (t) => {
    const f = await startPages(t);
    f.tokens.mint(30);
    const client = await connectPage(t, f);
    await hello(client, f, 'launch', new Uint8Array(32).fill(9));
    assert.equal(await closedWith(client), 4003);
    assert.equal(f.store.getKv('window_alarm'), null);
  });

  test('a dropped token closes with 4003', async (t) => {
    const f = await startPages(t);
    const minted = f.tokens.mint(30);
    f.tokens.drop(minted.id);
    const client = await connectPage(t, f);
    await hello(client, f, 'launch', minted.token);
    assert.equal(await closedWith(client), 4003);
    assert.equal(f.tokens.state(minted.id), 'dropped');
  });

  test('an expired token closes with 4003', async (t) => {
    const f = await startPages(t);
    const minted = f.tokens.mint(30);
    f.clock.advanceMs(30_000);
    const client = await connectPage(t, f);
    await hello(client, f, 'launch', minted.token);
    assert.equal(await closedWith(client), 4003);
    assert.equal(f.tokens.state(minted.id), 'expired');
  });
});

describe('pages: what closes the connection before start', () => {
  test('no hello within 5 seconds closes with 4001', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    await challengeOf(client);
    f.clock.advanceMs(4_999);
    await delay(50);
    assert.equal(client.isClosed(), false, 'still open after 4.999 s');
    f.clock.advanceMs(1);
    assert.equal(await closedWith(client), 4001);
  });

  test('a hello in time stops the 5 seconds', async (t) => {
    const f = await startPages(t);
    const { client } = await openPage(t, f);
    f.clock.advanceMs(60_000);
    assert.deepEqual(await roundTrip(client), []);
    assert.equal(client.isClosed(), false);
  });

  test('a nonce of 42 characters closes with 4001', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    const sN = await challengeOf(client);
    const cN = freshNonce().slice(0, 42);
    client.send({ t: 'hello', protocol: 1, mode: 'key', nonce: cN, proof: 'x'.repeat(43) });
    assert.equal(await closedWith(client), 4001);
    assert.equal(typeof sN, 'string');
  });

  test('a nonce not in the canonical form (spare bits set) closes with 4001', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    await challengeOf(client);
    const canonical = nonce(0x10); // its last character carries two spare bits, zero
    const spare = canonical.slice(0, 42) + 'B';
    assert.notEqual(spare, canonical);
    client.send({ t: 'hello', protocol: 1, mode: 'key', nonce: spare, proof: 'x'.repeat(43) });
    assert.equal(await closedWith(client), 4001);
  });

  test('protocol 2 closes with 4426', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f);
    const sN = await challengeOf(client);
    const cN = freshNonce();
    const proof = pageProof(f.secret, 'key', sN, cN, f.origin);
    client.send({ t: 'hello', protocol: 2, mode: 'key', nonce: cN, proof });
    assert.equal(await closedWith(client), 4426);
  });

  test('any message before hello closes with 4001', async (t) => {
    const f = await startPages(t);
    for (const message of [
      { t: 'ping', n: 1 },
      {
        t: 'start',
        assetVersion: 'b',
        windowId: windowId(),
        focused: true,
        theme: { fg: '', bg: '' },
      },
      { t: 'hello', protocol: 1, mode: 'other', nonce: freshNonce(), proof: 'x' },
    ]) {
      const client = await connectPage(t, f);
      await challengeOf(client);
      client.send(message);
      assert.equal(await closedWith(client), 4001, JSON.stringify(message));
    }
    const binary = await connectPage(t, f);
    await challengeOf(binary);
    binary.ws.send(Buffer.from('hello'));
    assert.equal(await closedWith(binary), 4001, 'a binary message');
  });

  test('a message other than start after welcome closes with 4001; nothing else is sent', async (t) => {
    const f = await startPages(t);
    for (const message of [
      { t: 'ping', n: 1 },
      { t: 'view', filter: '', unfolded: [], showDone: false, selected: null },
      { t: 'hello', protocol: 1, mode: 'key', nonce: freshNonce(), proof: 'x'.repeat(43) },
    ]) {
      const client = await connectPage(t, f);
      await hello(client, f, 'key', f.secret);
      assert.equal((await client.nextText()).t, 'welcome');
      client.send(message);
      assert.equal(await closedWith(client), 4001, JSON.stringify(message));
      assert.deepEqual(client.pending(), []);
    }
  });

  test('a store that fails while the secret is read closes with 1011 and uses no token', async (t) => {
    const f = await startPages(t, {
      store: (store) =>
        new Proxy(store, {
          get(target, key) {
            if (key === 'transaction') {
              return () => {
                throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
              };
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
        }) as Store,
    });
    const minted = f.tokens.mint(30);
    const client = await connectPage(t, f);
    await hello(client, f, 'launch', minted.token);
    assert.equal(await closedWith(client), 1011);
    assert.equal(f.tokens.state(minted.id), 'waiting');
    assert.ok(
      f.logs.some((line) => line.includes('ERR_SQLITE_ERROR')),
      JSON.stringify(f.logs),
    );
  });

  test('a busy store while the secret is read closes with 1013 (try again later), no alarm, no token used (ruled, task 23)', async (t) => {
    const f = await startPages(t, {
      store: (store) =>
        new Proxy(store, {
          get(target, key) {
            if (key === 'transaction') {
              return () => {
                throw Object.assign(new Error('database is locked'), {
                  code: 'ERR_SQLITE_ERROR',
                  errcode: 5,
                });
              };
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
        }) as Store,
    });
    const minted = f.tokens.mint(30);
    const client = await connectPage(t, f);
    await hello(client, f, 'launch', minted.token);
    assert.equal(await closedWith(client), 1013);
    assert.equal(f.tokens.state(minted.id), 'waiting');
    assert.ok(
      f.logs.some((line) => line.includes('busy')),
      JSON.stringify(f.logs),
    );
  });

  test('starting: an upgrade with the right Host is answered 503, a wrong Host still 421 (ruled, task 23)', async (t) => {
    let starting = true;
    const f = await startPages(t, { starting: () => starting });
    assert.equal((await refusedUpgrade(t, f)).status, 503);
    assert.equal((await refusedUpgrade(t, f, { host: 'localhost' })).status, 421);
    starting = false;
    const client = await connectPage(t, f);
    assert.equal((await client.nextText('the challenge')).t, 'challenge');
  });

  test('after start the page counts; before it, it does not', async (t) => {
    const f = await startPages(t);
    assert.equal(f.pages.count(), 0);
    const client = await connectPage(t, f);
    await hello(client, f, 'key', f.secret);
    assert.equal((await client.nextText()).t, 'welcome');
    assert.equal(f.pages.count(), 0);
    start(client);
    await roundTrip(client);
    assert.equal(f.pages.count(), 1);
    client.ws.close();
    await until('the page is gone', () => f.pages.count() === 0);
  });
});

describe('pages: the checks at the upgrade', () => {
  test('Origin http://localhost:<port> is refused with 403', async (t) => {
    const f = await startPages(t);
    const answer = await refusedUpgrade(t, f, { origin: `http://localhost:${f.port}` });
    assert.equal(answer.status, 403);
    assertSecurityHeaders(answer.headers, '403');
  });

  test('a missing Origin is refused with 403', async (t) => {
    const f = await startPages(t);
    assert.equal((await refusedUpgrade(t, f, { origin: null })).status, 403);
  });

  test('an Origin on another port, https, or with a path is refused with 403', async (t) => {
    const f = await startPages(t);
    for (const origin of [
      `http://127.0.0.1:${f.port + 1}`,
      `https://127.0.0.1:${f.port}`,
      `http://127.0.0.1:${f.port}/`,
      `HTTP://127.0.0.1:${f.port}`,
      'null',
    ]) {
      assert.equal((await refusedUpgrade(t, f, { origin })).status, 403, origin);
    }
  });

  test('a wrong Host is refused with 421', async (t) => {
    const f = await startPages(t);
    for (const host of [
      `localhost:${f.port}`,
      `127.0.0.1:${f.port + 1}`,
      '127.0.0.1',
      'evil.example',
    ]) {
      const answer = await refusedUpgrade(t, f, { host });
      assert.equal(answer.status, 421, host);
      assertSecurityHeaders(answer.headers, `421 for ${host}`);
    }
  });

  test('an upgrade without Host is refused with 421', async (t) => {
    const f = await startPages(t);
    const request = upgradeTo(f, 'GET', '/ws').replace(`Host: 127.0.0.1:${f.port}\r\n`, '');
    const answer = await rawRequest(t, f.port, request);
    assert.match(answer, /^HTTP\/1\.1 421 /);
  });

  test('an upgrade to another path is refused with 404', async (t) => {
    const f = await startPages(t);
    for (const path of ['/', '/ws/', '/WS', '/assets/x', '/ws2']) {
      const answer = await rawRequest(t, f.port, upgradeTo(f, 'GET', path));
      assert.match(answer, /^HTTP\/1\.1 404 /, path);
      assertSecurityHeaders(headersOf(answer), `404 for ${path}`);
    }
  });

  test('a query string is ignored: /ws?x is /ws', async (t) => {
    const f = await startPages(t);
    const client = await connectPage(t, f, { path: '/ws?x=1' });
    assert.equal((await client.nextText()).t, 'challenge');
  });

  test('OPTIONS is refused with 403, any other method but GET with 405 and Allow: GET', async (t) => {
    const f = await startPages(t);
    const options = await rawRequest(t, f.port, upgradeTo(f, 'OPTIONS', '/ws'));
    assert.match(options, /^HTTP\/1\.1 403 /);
    assertSecurityHeaders(headersOf(options), 'OPTIONS');
    for (const method of ['POST', 'PUT', 'HEAD', 'DELETE']) {
      const answer = await rawRequest(t, f.port, upgradeTo(f, method, '/ws'));
      assert.match(answer, /^HTTP\/1\.1 405 /, method);
      const headers = headersOf(answer);
      assert.equal(headers['allow'], 'GET', method);
      assertSecurityHeaders(headers, method);
    }
  });

  test('the Host is checked before the method and the path', async (t) => {
    const f = await startPages(t);
    const request = upgradeTo(f, 'POST', '/other').replace(
      `Host: 127.0.0.1:${f.port}`,
      'Host: evil.example',
    );
    assert.match(await rawRequest(t, f.port, request), /^HTTP\/1\.1 421 /);
  });

  test('an upgrade to something other than a WebSocket is refused with 400', async (t) => {
    const f = await startPages(t);
    const request = upgradeTo(f, 'GET', '/ws').replace('Upgrade: websocket', 'Upgrade: h2c');
    assert.match(await rawRequest(t, f.port, request), /^HTTP\/1\.1 400 /);
  });

  test('for port 80 the Host 127.0.0.1 and the Origin http://127.0.0.1 are accepted', async (t) => {
    const f = await startPages(t, { portSeen: 80 });
    for (const [host, origin] of [
      ['127.0.0.1', 'http://127.0.0.1'],
      ['127.0.0.1:80', 'http://127.0.0.1:80'],
      ['127.0.0.1', 'http://127.0.0.1:80'],
    ] as const) {
      const client = await connectPage(t, f, { host, origin });
      assert.equal((await client.nextText()).t, 'challenge', `${host} ${origin}`);
    }
  });

  test('for port 80 localhost stays refused, as Host and as Origin', async (t) => {
    const f = await startPages(t, { portSeen: 80 });
    assert.equal(
      (await refusedUpgrade(t, f, { host: 'localhost', origin: 'http://127.0.0.1' })).status,
      421,
    );
    assert.equal(
      (await refusedUpgrade(t, f, { host: '127.0.0.1', origin: 'http://localhost' })).status,
      403,
    );
    assert.equal(
      (await refusedUpgrade(t, f, { host: '127.0.0.1', origin: 'http://localhost:80' })).status,
      403,
    );
  });

  test('the proof is made over the Origin the page sent (port 80 without the port)', async (t) => {
    const f = await startPages(t, { portSeen: 80 });
    const client = await connectPage(t, f, { host: '127.0.0.1', origin: 'http://127.0.0.1' });
    const sN = await challengeOf(client);
    const cN = freshNonce();
    const proof = pageProof(f.secret, 'key', sN, cN, 'http://127.0.0.1');
    client.send({ t: 'hello', protocol: 1, mode: 'key', nonce: cN, proof });
    const welcome = await client.nextText();
    assert.ok(welcome.t === 'welcome', welcome.t);
    assert.equal(welcome.proof, serverProof(f.secret, 'key', sN, cN, 'http://127.0.0.1'));
  });

  test('an upgrade that fails inside is dropped and logged; the next one works', async (t) => {
    let fail = true;
    const f = await startPages(t, {
      platform: (platform) => ({
        ...platform,
        randomBytes: (count) => {
          if (fail) {
            fail = false;
            throw new RangeError('no randomness');
          }
          return platform.randomBytes(count);
        },
      }),
    });
    const broken = await connectPage(t, f);
    assert.equal((await within('the close', broken.closed)).code, 1006);
    assert.deepEqual(f.logs, ['page: the upgrade failed: RangeError']);
    const client = await connectPage(t, f);
    assert.equal((await client.nextText()).t, 'challenge');
  });

  test('with 64 connections waiting for their hello, a 65th is accepted and the oldest dropped', async (t) => {
    const f = await startPages(t);
    const waiting: PageClient[] = [];
    for (let i = 0; i < 64; i++) {
      const client = await connectPage(t, f);
      await challengeOf(client);
      waiting.push(client);
    }
    const newcomer = await connectPage(t, f);
    assert.equal((await newcomer.nextText()).t, 'challenge');
    assert.equal((await within('the oldest closed', (waiting[0] as PageClient).closed)).code, 1006);
    assert.ok(
      waiting.slice(1).every((client) => !client.isClosed()),
      'only the oldest',
    );
    assert.deepEqual(f.logs, ['page: 64 connections wait for their hello; the oldest is dropped']);
    // The newcomer is a page like any other: it can prove itself.
    const another = await connectPage(t, f);
    assert.equal((await another.nextText()).t, 'challenge');
    assert.equal((await within('the next oldest', (waiting[1] as PageClient).closed)).code, 1006);
  });

  test('with 64 connections waiting, an upgrade that is no WebSocket drops nobody', async (t) => {
    const f = await startPages(t);
    const waiting: PageClient[] = [];
    for (let i = 0; i < 64; i++) {
      const client = await connectPage(t, f);
      await challengeOf(client);
      waiting.push(client);
    }
    const request = upgradeTo(f, 'GET', '/ws').replace('Upgrade: websocket', 'Upgrade: h2c');
    assert.match(await rawRequest(t, f.port, request), /^HTTP\/1\.1 400 /);
    await delay(50);
    assert.ok(
      waiting.every((client) => !client.isClosed()),
      'all 64 still wait',
    );
    assert.deepEqual(f.logs, []);
  });

  test('a connection that has proven itself is never dropped for a newcomer', async (t) => {
    const f = await startPages(t);
    const proven = await openPage(t, f);
    const welcomed = await connectPage(t, f);
    await hello(welcomed, f, 'key', f.secret);
    assert.equal((await welcomed.nextText()).t, 'welcome');
    const waiting: PageClient[] = [];
    for (let i = 0; i < 64; i++) {
      const client = await connectPage(t, f);
      await challengeOf(client);
      waiting.push(client);
    }
    const newcomer = await connectPage(t, f);
    assert.equal((await newcomer.nextText()).t, 'challenge');
    await within('the oldest waiting closed', (waiting[0] as PageClient).closed);
    assert.deepEqual(await roundTrip(proven.client), [], 'the open page stays');
    assert.equal(welcomed.isClosed(), false, 'a welcomed page waiting for start stays');
    assert.equal(f.pages.count(), 1);
  });

  test('after bye an upgrade is refused with 503', async (t) => {
    const f = await startPages(t);
    await f.pages.bye('stopping');
    const answer = await rawRequest(t, f.port, upgradeTo(f, 'GET', '/ws'));
    assert.match(answer, /^HTTP\/1\.1 503 /);
    assertSecurityHeaders(headersOf(answer), '503');
  });
});

describe("pages: Node.js's own answers (ruled, task 17)", () => {
  // S2 8.2.1: these never reach a handler of skydeck's; Node.js answers them itself, with no body
  // and the connection closed. Pinned so that a Node.js release that changes them is noticed.
  const cases: [string, (f: PagesFixture) => string, RegExp][] = [
    ['an HTTP/1.1 request without Host', () => 'GET / HTTP/1.1\r\n\r\n', /^HTTP\/1\.1 400 /],
    [
      'an unknown method',
      (f) => `FOO / HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\n\r\n`,
      /^HTTP\/1\.1 400 /,
    ],
    ['a request line that cannot be parsed', () => 'garbage\r\n\r\n', /^HTTP\/1\.1 400 /],
    [
      'headers above 16 KiB',
      (f) => `GET / HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nX: ${'a'.repeat(17_000)}\r\n\r\n`,
      /^HTTP\/1\.1 431 /,
    ],
    [
      'Content-Length with Transfer-Encoding',
      (f) =>
        `POST / HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Length: 5\r\n` +
        'Transfer-Encoding: chunked\r\n\r\n',
      /^HTTP\/1\.1 400 /,
    ],
    ['an HTTP/2 preface', () => 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', /^HTTP\/1\.1 400 /],
  ];
  for (const [what, request, status] of cases) {
    test(`${what}: Node's 4xx with an empty body, the socket closed, no handler called`, async (t) => {
      const f = await startPages(t);
      const answer = await rawRequest(t, f.port, request(f));
      assert.match(answer, status);
      const end = answer.indexOf('\r\n\r\n');
      assert.ok(end !== -1, 'a whole head');
      // Empty: nothing after the head, or (Node's answer to a request without Host) one chunk of
      // zero bytes.
      const chunked = /\r\ntransfer-encoding: chunked\r\n/i.test(answer.slice(0, end + 2));
      assert.equal(answer.slice(end + 4), chunked ? '0\r\n\r\n' : '', 'an empty body');
      assert.deepEqual(f.served, { requests: 0, upgrades: 0 });
    });
  }

  test('CONNECT is closed without an answer, and no handler is called', async (t) => {
    const f = await startPages(t);
    const answer = await rawRequest(
      t,
      f.port,
      `CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\n\r\n`,
    );
    assert.equal(answer, '');
    assert.deepEqual(f.served, { requests: 0, upgrades: 0 });
  });

  test('a request with Connection: Upgrade and Upgrade reaches the upgrade handler whatever its Host', async (t) => {
    const f = await startPages(t);
    const answer = await rawRequest(
      t,
      f.port,
      'GET /x HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n',
    );
    assert.match(answer, /^HTTP\/1\.1 421 /);
    assert.deepEqual(f.served, { requests: 0, upgrades: 1 });
  });
});

describe('pages: nothing secret is logged or sent', () => {
  test("the secret's base64url is in no frame and no log line", async (t) => {
    const f = await startPages(t);
    const secretText = Buffer.from(f.secret).toString('base64url');
    const clients: PageClient[] = [];
    const key = await openPage(t, f);
    clients.push(key.client);
    const minted = f.tokens.mint(30);
    const launch = await connectPage(t, f);
    clients.push(launch);
    await hello(launch, f, 'launch', minted.token);
    assert.equal((await launch.nextText()).t, 'welcome');
    const again = await connectPage(t, f);
    clients.push(again);
    await hello(again, f, 'launch', minted.token);
    assert.equal(await closedWith(again), 4004);
    const wrong = await connectPage(t, f);
    clients.push(wrong);
    await hello(wrong, f, 'key', new Uint8Array(32));
    assert.equal(await closedWith(wrong), 4003);

    for (const client of clients) {
      for (const item of client.all) {
        const text =
          'text' in item ? JSON.stringify(item.text) : Buffer.from(item.binary).toString('latin1');
        assert.ok(!text.includes(secretText), `a frame holds the secret: ${text}`);
        assert.ok(!Buffer.from(text, 'latin1').includes(Buffer.from(f.secret)), 'the raw bytes');
      }
    }
    for (const line of f.logs) {
      assert.ok(!line.includes(secretText), `a log line holds the secret: ${line}`);
    }
  });

  test('a malformed hello, start and input carrying a marker leave it in no log line', async (t) => {
    const f = await startPages(t);
    const MARKER = 'MARKER-7f3a';
    const sends: ((client: PageClient) => Promise<void>)[] = [
      // hello: wrong types, an unknown field named with the marker, too long, not JSON
      async (client) => {
        await challengeOf(client);
        client.send({ t: 'hello', protocol: MARKER, mode: 'key', nonce: MARKER, proof: MARKER });
      },
      async (client) => {
        await challengeOf(client);
        client.send({
          t: 'hello',
          protocol: 1,
          mode: 'key',
          nonce: freshNonce(),
          proof: 'x',
          [MARKER]: MARKER,
        });
      },
      async (client) => {
        await challengeOf(client);
        client.send({ t: 'hello', protocol: 1, mode: MARKER, nonce: MARKER, proof: MARKER });
      },
      async (client) => {
        await challengeOf(client);
        client.sendRaw(`{"t":"hello","proof":"${MARKER}`);
      },
      async (client) => {
        await challengeOf(client);
        client.send({
          t: 'hello',
          protocol: 1,
          mode: 'key',
          nonce: MARKER.repeat(5),
          proof: MARKER,
        });
      },
      // start
      async (client) => {
        await hello(client, f, 'key', f.secret);
        await client.nextText('the welcome');
        client.send({
          t: 'start',
          assetVersion: MARKER,
          windowId: MARKER,
          focused: true,
          theme: { fg: MARKER, bg: '' },
        });
      },
      async (client) => {
        await hello(client, f, 'key', f.secret);
        await client.nextText('the welcome');
        client.send({ t: MARKER, assetVersion: MARKER });
      },
    ];
    for (const send of sends) {
      const client = await connectPage(t, f);
      await send(client);
      await within('the close', client.closed);
    }
    // input, after start: a bad term, data of a wrong type, an unknown field, bytes above U+00FF
    for (const message of [
      { t: 'input', term: MARKER, data: MARKER },
      { t: 'input', term: '0123456789ab', data: { [MARKER]: MARKER } },
      { t: 'input', term: '0123456789ab', data: MARKER, [MARKER]: true },
      { t: 'input', term: '0123456789ab', data: `${MARKER}Ā`, binary: true },
    ]) {
      const { client } = await openPage(t, f);
      client.send(message);
      await within('the close', client.closed);
    }
    assert.ok(f.logs.length >= 11, `every refusal is logged: ${JSON.stringify(f.logs)}`);
    for (const line of f.logs) {
      assert.ok(!line.includes(MARKER), `a log line holds the marker: ${line}`);
    }
  });
});

describe('pages: welcome', () => {
  test('carries the fields welcome() gives, read when the hello is answered', async (t) => {
    const f = await startPages(t);
    f.welcome.nowNs = '12345';
    f.welcome.keepAlive = { mode: 'wsl', state: 'running', since: '1', error: null };
    const { welcome } = await openPage(t, f);
    assert.equal(welcome.nowNs, '12345');
    assert.deepEqual(welcome.keepAlive, { mode: 'wsl', state: 'running', since: '1', error: null });
    assert.equal(welcome.assetVersion, 'build123');
    assert.equal(welcome.protocol, 1);
  });
});
