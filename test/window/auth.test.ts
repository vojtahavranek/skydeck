import assert from 'node:assert/strict';
import crypto, { createDecipheriv, hkdfSync } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { inspect } from 'node:util';

import { StoreNewerError, openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import {
  createTokens,
  ensureSecret,
  isNonce,
  keyProofMatches,
  pageProof,
  raiseAlarm,
  replaceSecret,
  serverProof,
  wrapSecret,
} from '../../src/window/auth.ts';
import type { Tokens } from '../../src/window/auth.ts';
import { testDeck } from '../helpers/deck.ts';
import { SEC, T0, testPlatform } from '../helpers/platform.ts';
import type { FakeClock } from '../helpers/platform.ts';

// ---------------------------------------------------------------------------------------------
// The vector of S2 8.2.2, computed with Node.js's crypto; the page test (17.4) runs the same
// inputs through Web Crypto.

/** `length` bytes counting up from `from`. */
function counting(from: number, length = 32): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => from + i);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const SECRET = counting(0x00);
const TOKEN = counting(0x20);
const SN = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8';
const CN = 'YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8';
const ORIGIN = 'http://127.0.0.1:47613';
const IV = counting(0x80, 12);

const SECRET_TEXT = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const TOKEN_TEXT = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const KEY_PAGE = 'I2kfIbEbNedSunJ5O-iFTu1xMaucB1TaOXfPgule6rE';
const KEY_SERVER = 'PCSrj1ouBWLrjthlVwJEhf7wtjQVvd99qg30B5MzN9k';
const LAUNCH_PAGE = 'Cr2pbVrX3H03jJHuH4XHBB-cqsOPpzQCkE0JpYYrpm4';
const LAUNCH_SERVER = 'JM1U0NnH9f1h_LMtP3J9aBD6GWG7dyJX0cRhjXBHCUw';
const WRAPPED = 'gIGCg4SFhoeIiYqL8-uwKEfl-QQONxqvTE8BdkWwIYHdwQkWN6_IJiXkHtLOZknj-CrYjV5peDDAyWDo';

/** Two other nonces, for a second connection. */
const SN2 = b64(counting(0xa0));
const CN2 = b64(counting(0xc0));

/** What check gives for a used token presented again, when the alarm did not fail. */
const REUSED = { kind: 'reused', alarmFailure: null };

test("the vector's inputs are the bytes the design names", () => {
  assert.equal(b64(SECRET), SECRET_TEXT);
  assert.equal(b64(TOKEN), TOKEN_TEXT);
  assert.equal(b64(counting(0x40)), SN);
  assert.equal(b64(counting(0x60)), CN);
});

test('pageProof and serverProof in mode key equal the vector', () => {
  assert.equal(pageProof(SECRET, 'key', SN, CN, ORIGIN), KEY_PAGE);
  assert.equal(serverProof(SECRET, 'key', SN, CN, ORIGIN), KEY_SERVER);
});

test('pageProof and serverProof in mode launch, keyed by the token, equal the vector', () => {
  assert.equal(pageProof(TOKEN, 'launch', SN, CN, ORIGIN), LAUNCH_PAGE);
  assert.equal(serverProof(TOKEN, 'launch', SN, CN, ORIGIN), LAUNCH_SERVER);
});

test("wrapSecret with the vector's IV equals the vector", () => {
  assert.equal(wrapSecret(SECRET, TOKEN, SN, CN, IV), WRAPPED);
});

test('a proof depends on every input', () => {
  const proofs = [
    pageProof(SECRET, 'key', SN, CN, ORIGIN),
    pageProof(TOKEN, 'key', SN, CN, ORIGIN),
    pageProof(SECRET, 'launch', SN, CN, ORIGIN),
    pageProof(SECRET, 'key', SN2, CN, ORIGIN),
    pageProof(SECRET, 'key', SN, CN2, ORIGIN),
    pageProof(SECRET, 'key', CN, SN, ORIGIN),
    pageProof(SECRET, 'key', SN, CN, 'http://127.0.0.1:47614'),
    serverProof(SECRET, 'key', SN, CN, ORIGIN),
  ];
  assert.equal(new Set(proofs).size, proofs.length);
  for (const proof of proofs) {
    assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  }
});

test('the proofs and wrapSecret refuse a key, a nonce or an IV of the wrong size', () => {
  const refused = { name: 'RangeError' };
  for (const prove of [pageProof, serverProof]) {
    assert.throws(() => prove(new Uint8Array(0), 'key', SN, CN, ORIGIN), refused);
    assert.throws(() => prove(counting(0, 31), 'key', SN, CN, ORIGIN), refused);
    assert.throws(() => prove(counting(0, 33), 'key', SN, CN, ORIGIN), refused);
    assert.throws(() => prove(SECRET, 'key', SN.slice(1), CN, ORIGIN), refused);
    assert.throws(() => prove(SECRET, 'key', SN, `${CN}\n`, ORIGIN), refused);
  }
  assert.throws(() => wrapSecret(counting(0, 31), TOKEN, SN, CN, IV), refused);
  assert.throws(() => wrapSecret(SECRET, counting(0, 16), SN, CN, IV), refused);
  assert.throws(() => wrapSecret(SECRET, TOKEN, SN, CN, counting(0x80, 11)), refused);
  assert.throws(() => wrapSecret(SECRET, TOKEN, SN, CN, counting(0x80, 16)), refused);
  assert.throws(() => wrapSecret(SECRET, TOKEN, 'x', CN, IV), refused);
});

// ---------------------------------------------------------------------------------------------
// wrapSecret opens with Node's AES-256-GCM under the HKDF key of the token and both nonces.

/** What a page does with `key` (S2 8.2.2): split off the IV, derive the key, open. Throws when it does not open. */
function unwrap(wrapped: string, token: Uint8Array, sN: string, cN: string): Uint8Array {
  const bytes = Buffer.from(wrapped, 'base64url');
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(bytes.length - 16);
  const sealed = bytes.subarray(12, bytes.length - 16);
  const key = Buffer.from(
    hkdfSync('sha256', token, Buffer.from(sN + cN, 'utf8'), Buffer.from('skydeck key 1'), 32),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(sealed), decipher.final()]));
}

test('wrapSecret is the IV, then the ciphertext, then the 16-byte tag', () => {
  const wrapped = Buffer.from(wrapSecret(SECRET, TOKEN, SN, CN, IV), 'base64url');
  assert.equal(wrapped.length, 12 + 32 + 16);
  assert.deepEqual(new Uint8Array(wrapped.subarray(0, 12)), IV);
});

test("wrapSecret's output opens with the token and both nonces", () => {
  assert.deepEqual(unwrap(WRAPPED, TOKEN, SN, CN), SECRET);
  const iv = counting(0x10, 12);
  const wrapped = wrapSecret(SECRET, TOKEN, SN2, CN2, iv);
  assert.deepEqual(new Uint8Array(Buffer.from(wrapped, 'base64url').subarray(0, 12)), iv);
  assert.deepEqual(unwrap(wrapped, TOKEN, SN2, CN2), SECRET);
});

test("wrapSecret's output does not open with another token or with the nonces swapped", () => {
  const wrapped = wrapSecret(SECRET, TOKEN, SN, CN, IV);
  assert.throws(() => unwrap(wrapped, counting(0x21), SN, CN));
  assert.throws(() => unwrap(wrapped, SECRET, SN, CN));
  assert.throws(() => unwrap(wrapped, TOKEN, CN, SN));
  assert.throws(() => unwrap(wrapped, TOKEN, SN2, CN));
});

// ---------------------------------------------------------------------------------------------
// isNonce

test('isNonce accepts 43 base64url characters of 32 bytes', () => {
  assert.equal(isNonce(SN), true);
  assert.equal(isNonce(CN), true);
  assert.equal(isNonce(b64(new Uint8Array(32).fill(0xff))), true);
  assert.equal(isNonce(b64(new Uint8Array(32))), true);
});

test('isNonce refuses 42 or 44 characters, +, /, = and a non-canonical last character', () => {
  assert.equal(isNonce(SN.slice(0, 42)), false);
  assert.equal(isNonce(`${SN}A`), false);
  assert.equal(isNonce(`${SN.slice(0, 10)}+${SN.slice(11)}`), false);
  assert.equal(isNonce(`${SN.slice(0, 10)}/${SN.slice(11)}`), false);
  assert.equal(isNonce(`${SN.slice(0, 42)}=`), false);
  assert.equal(isNonce(`${SN}=`), false);
  assert.equal(isNonce(''), false);
  assert.equal(isNonce(`${SN.slice(0, 42)}é`), false);
  assert.equal(isNonce(` ${SN.slice(1)}`), false);
  // 32 bytes leave two bits of the last character unused; only the encoding with zeros is one.
  assert.equal(isNonce(`${SN.slice(0, 42)}9`), false);
  assert.equal(b64(Buffer.from(`${SN.slice(0, 42)}9`, 'base64url')), SN);
});

// ---------------------------------------------------------------------------------------------
// The secret in kv (S2 10.2, 15.2)

/** A random source that counts its calls, as testPlatform's randomBytes does across calls. */
function countingRandom(t: TestContext): { random: (n: number) => Uint8Array; calls: number[] } {
  const { platform } = testPlatform(t);
  const calls: number[] = [];
  return {
    random: (n) => {
      calls.push(n);
      return platform.randomBytes(n);
    },
    calls,
  };
}

/** The store, with every call of a kv method recorded, and whether it ran inside `transaction`. */
function watched(store: Store): { store: Store; calls: string[] } {
  const calls: string[] = [];
  let depth = 0;
  const proxy = new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (key === 'transaction') {
        return <T>(fn: () => T): T => {
          depth += 1;
          try {
            return target.transaction(fn);
          } finally {
            depth -= 1;
          }
        };
      }
      return (...args: unknown[]): unknown => {
        if (typeof key === 'string' && key.endsWith('Kv')) {
          calls.push(`${key} ${depth > 0 ? 'inside' : 'outside'}`);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

test('ensureSecret creates 32 bytes once and stores them base64url without padding', (t) => {
  const { deck } = testDeck(t);
  const { random, calls } = countingRandom(t);
  const first = ensureSecret(deck.store, random);
  assert.equal(first.length, 32);
  assert.deepEqual(calls, [32]);
  const stored = deck.store.getKv('window_secret');
  assert.equal(stored, b64(first));
  assert.match(stored ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(ensureSecret(deck.store, random), first);
  assert.deepEqual(calls, [32], 'the second call draws nothing');
});

test("a second connection's call in between returns the first's secret", (t) => {
  const { deck } = testDeck(t);
  const other = openStore(deck.store.path);
  t.after(() => {
    other.close();
  });
  const { random } = countingRandom(t);
  const first = ensureSecret(deck.store, random);
  assert.deepEqual(ensureSecret(other, random), first);
  assert.deepEqual(ensureSecret(deck.store, random), first);
});

test('ensureSecret reads and creates inside one transaction', (t) => {
  const { deck } = testDeck(t);
  const { random } = countingRandom(t);
  const { store, calls } = watched(deck.store);
  ensureSecret(store, random);
  assert.deepEqual(calls, ['getKv inside', 'setKv inside']);
  calls.length = 0;
  ensureSecret(store, random);
  assert.deepEqual(calls, ['getKv inside']);
});

test('ensureSecret replaces a stored value that is not a secret', (t) => {
  const { deck } = testDeck(t);
  const { random } = countingRandom(t);
  for (const bad of [
    'x',
    '',
    `${SECRET_TEXT}=`,
    SECRET_TEXT.slice(1),
    `${SECRET_TEXT.slice(0, 42)}9`,
  ]) {
    deck.store.setKv('window_secret', bad);
    const secret = ensureSecret(deck.store, random);
    assert.equal(secret.length, 32);
    assert.equal(deck.store.getKv('window_secret'), b64(secret));
  }
});

test('ensureSecret keeps a stored secret it did not create', (t) => {
  const { deck } = testDeck(t);
  const { random, calls } = countingRandom(t);
  deck.store.setKv('window_secret', SECRET_TEXT);
  assert.deepEqual(ensureSecret(deck.store, random), SECRET);
  assert.deepEqual(calls, []);
});

test('ensureSecret refuses a random source that gives the wrong number of bytes, and stores nothing', (t) => {
  const { deck } = testDeck(t);
  assert.throws(() => ensureSecret(deck.store, () => new Uint8Array(31)), { name: 'RangeError' });
  assert.equal(deck.store.getKv('window_secret'), null);
});

test('replaceSecret changes the secret and clears window_alarm, in one transaction', (t) => {
  const { deck } = testDeck(t);
  const { random } = countingRandom(t);
  const before = ensureSecret(deck.store, random);
  raiseAlarm(deck.store, T0);
  const { store, calls } = watched(deck.store);
  replaceSecret(store, random);
  assert.deepEqual(calls.toSorted(), ['deleteKv inside', 'setKv inside']);
  const after = ensureSecret(deck.store, random);
  assert.equal(after.length, 32);
  assert.notDeepEqual(after, before);
  assert.equal(deck.store.getKv('window_secret'), b64(after));
  assert.equal(deck.store.getKv('window_alarm'), null);
});

test('replaceSecret with a short random source throws and changes nothing', (t) => {
  const { deck } = testDeck(t);
  const { random } = countingRandom(t);
  const before = ensureSecret(deck.store, random);
  raiseAlarm(deck.store, T0);
  assert.throws(() => replaceSecret(deck.store, () => new Uint8Array(31)), {
    name: 'RangeError',
  });
  assert.equal(deck.store.getKv('window_secret'), b64(before));
  assert.equal(deck.store.getKv('window_alarm'), String(T0));
});

test('replaceSecret with a guard (ruled, server-findable): the guard runs inside the one transaction, first; when it throws nothing changes', (t) => {
  const { deck } = testDeck(t);
  const { random } = countingRandom(t);
  const before = ensureSecret(deck.store, random);
  raiseAlarm(deck.store, T0);
  const refusal = new Error('a server runs');
  assert.throws(
    () =>
      replaceSecret(deck.store, random, () => {
        deck.store.setKv('window_launching', 'written by the guard'); // rolled back with it
        throw refusal;
      }),
    (error) => error === refusal,
  );
  assert.equal(deck.store.getKv('window_secret'), b64(before));
  assert.equal(deck.store.getKv('window_alarm'), String(T0));
  assert.equal(deck.store.getKv('window_launching'), null, 'the guard ran inside the transaction');

  const { store, calls } = watched(deck.store);
  replaceSecret(store, random, () => {
    store.getKv('window_server'); // what the guard of --new-secret reads
    calls.push('guard done');
  });
  assert.deepEqual(calls, ['getKv inside', 'guard done', 'setKv inside', 'deleteKv inside']);
  assert.notEqual(deck.store.getKv('window_secret'), b64(before));
  assert.equal(deck.store.getKv('window_alarm'), null);
});

test('replaceSecret creates a secret where there was none', (t) => {
  const { deck } = testDeck(t);
  const { random } = countingRandom(t);
  replaceSecret(deck.store, random);
  assert.match(deck.store.getKv('window_secret') ?? '', /^[A-Za-z0-9_-]{43}$/);
});

test('raiseAlarm writes the time in ns as a decimal string and keeps the first one', (t) => {
  const { deck } = testDeck(t);
  raiseAlarm(deck.store, T0 + 5n);
  assert.equal(deck.store.getKv('window_alarm'), String(T0 + 5n));
  raiseAlarm(deck.store, T0 + 9n);
  assert.equal(deck.store.getKv('window_alarm'), String(T0 + 5n));
});

test('raiseAlarm reads and writes inside one transaction, and writes nothing when an alarm is recorded', (t) => {
  const { deck } = testDeck(t);
  const { store, calls } = watched(deck.store);
  raiseAlarm(store, T0);
  assert.deepEqual(calls, ['getKv inside', 'setKv inside']);
  calls.length = 0;
  raiseAlarm(store, T0 + 1n);
  assert.deepEqual(calls, ['getKv inside']);
});

test('raiseAlarm replaces a recorded value that is not a time', (t) => {
  const { deck } = testDeck(t);
  for (const bad of ['', 'x', '-5', '1.5', ' 5']) {
    deck.store.setKv('window_alarm', bad);
    raiseAlarm(deck.store, T0);
    assert.equal(deck.store.getKv('window_alarm'), String(T0), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------
// Launch tokens (fake clock)

interface TokenRig {
  tokens: Tokens;
  clock: FakeClock;
  alarms: () => number;
}

function tokenRig(t: TestContext): TokenRig {
  const { platform, clock } = testPlatform(t);
  let alarms = 0;
  const tokens = createTokens(clock, platform.randomBytes, () => {
    alarms += 1;
  });
  return { tokens, clock, alarms: () => alarms };
}

/** The page's proof with a launch token, on the first connection's nonces unless given others. */
function launchProof(token: Uint8Array, sN = SN, cN = CN): string {
  return pageProof(token, 'launch', sN, cN, ORIGIN);
}

test('mint(30) gives a 32-hex id, 32 random bytes, an expiry 30 s on, and the state waiting', (t) => {
  const { tokens } = tokenRig(t);
  const minted = tokens.mint(30);
  assert.match(minted.id, /^[0-9a-f]{32}$/);
  assert.equal(minted.token.length, 32);
  assert.equal(minted.expiresAtNs, T0 + 30n * SEC);
  assert.equal(tokens.state(minted.id), 'waiting');
  const second = tokens.mint(30);
  assert.notEqual(second.id, minted.id);
  assert.notDeepEqual(second.token, minted.token);
});

test('a proof made with a waiting token matches, and the token is used at once', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const result = tokens.check(launchProof(token), SN, CN, ORIGIN);
  assert.equal(result.kind, 'match');
  assert.deepEqual(result.kind === 'match' ? result.token : null, token);
  assert.equal(tokens.state(id), 'used');
  assert.equal(alarms(), 0);
});

test('the same proof again is reused and raises the alarm once', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), REUSED);
  assert.equal(alarms(), 1);
  assert.equal(tokens.state(id), 'reused');
});

test('a used token presented again and again is reused each time, the alarm raised on the first only', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  assert.deepEqual(tokens.check(launchProof(token, SN2, CN2), SN2, CN2, ORIGIN), REUSED);
  assert.deepEqual(tokens.check(launchProof(token, CN2, SN2), CN2, SN2, ORIGIN), REUSED);
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), REUSED);
  assert.equal(alarms(), 1);
  assert.equal(tokens.state(id), 'reused');
});

test('each token raises the alarm on its own first reuse', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const first = tokens.mint(30);
  const second = tokens.mint(600);
  for (const { token } of [first, second]) {
    tokens.check(launchProof(token), SN, CN, ORIGIN);
    tokens.check(launchProof(token), SN, CN, ORIGIN);
    tokens.check(launchProof(token), SN, CN, ORIGIN);
  }
  assert.equal(alarms(), 2);
});

test('the alarm callback sees the token already reused', (t) => {
  const { platform, clock } = testPlatform(t);
  const seen: (string | null)[] = [];
  let id = '';
  const tokens = createTokens(clock, platform.randomBytes, () => {
    seen.push(tokens.state(id));
  });
  const minted = tokens.mint(30);
  id = minted.id;
  tokens.check(launchProof(minted.token), SN, CN, ORIGIN);
  tokens.check(launchProof(minted.token), SN, CN, ORIGIN);
  assert.deepEqual(seen, ['reused']);
});

/** Tokens whose alarm callback throws `failures[i]` on its i-th call while there is one, else returns. */
function failingAlarms(
  t: TestContext,
  failures: unknown[],
): { tokens: Tokens; calls: () => number } {
  const { platform, clock } = testPlatform(t);
  let calls = 0;
  const tokens = createTokens(clock, platform.randomBytes, () => {
    calls += 1;
    if (calls <= failures.length) {
      throw failures[calls - 1];
    }
  });
  return { tokens, calls: () => calls };
}

test('a failing alarm callback does not change the verdict: reused, and the failure by kind', (t) => {
  const locked = Object.assign(new Error('database is locked: SELECT 1 FROM kv'), {
    code: 'ERR_SQLITE_ERROR',
  });
  const { tokens, calls } = failingAlarms(t, [locked]);
  const { id, token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  const result = tokens.check(launchProof(token), SN, CN, ORIGIN);
  assert.deepEqual(result, { kind: 'reused', alarmFailure: 'Error (ERR_SQLITE_ERROR)' });
  assert.equal(tokens.state(id), 'reused');
  assert.equal(calls(), 1);
});

test('after a failed alarm the next reuse tries again; once raised, it is not raised again', (t) => {
  const { tokens, calls } = failingAlarms(t, [new StoreNewerError('the store is newer'), 'x']);
  const { token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  const again = () => tokens.check(launchProof(token, SN2, CN2), SN2, CN2, ORIGIN);
  assert.deepEqual(again(), { kind: 'reused', alarmFailure: 'StoreNewerError' });
  assert.deepEqual(again(), { kind: 'reused', alarmFailure: 'a thrown string' });
  assert.deepEqual(again(), REUSED);
  assert.deepEqual(again(), REUSED);
  assert.equal(calls(), 3);
});

test("an alarm failure's kind never carries its message", (t) => {
  const marker = 'MARKER-8f3a';
  const unreadable = new Error(marker);
  Object.defineProperty(unreadable, 'name', {
    get() {
      throw new Error(marker);
    },
  });
  const failures = [
    new Error(marker),
    Object.assign(new TypeError(marker), { code: 42 }),
    Object.assign(new Error(marker), { code: `E ${marker}` }),
    Object.assign(new Error(marker), { name: `Bad ${marker}` }),
    Object.assign(new Error(marker), { name: { toString: () => 'Plausible' } }),
    unreadable,
    marker,
    { message: marker },
    null,
  ];
  const { tokens } = failingAlarms(t, failures);
  const { token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  const kinds: unknown[] = [];
  for (let i = 0; i < failures.length; i += 1) {
    const result = tokens.check(launchProof(token), SN, CN, ORIGIN);
    assert.equal(result.kind, 'reused');
    kinds.push(result.kind === 'reused' ? result.alarmFailure : null);
  }
  assert.deepEqual(kinds, [
    'Error',
    'TypeError',
    'Error',
    'Error',
    'Error',
    'an error that cannot be read',
    'a thrown string',
    'a thrown object',
    'a thrown null',
  ]);
});

test('changing the token that check returned changes nothing the tokens hold', (t) => {
  const { tokens } = tokenRig(t);
  const minted = tokens.mint(30);
  const copy = Uint8Array.from(minted.token);
  minted.token.fill(0);
  const result = tokens.check(launchProof(copy), SN, CN, ORIGIN);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') {
    result.token.fill(0);
  }
  assert.deepEqual(tokens.check(launchProof(copy), SN, CN, ORIGIN), REUSED);
});

test('after 30 s an unused token is expired and its proof matches nothing', (t) => {
  const { tokens, clock, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  clock.advanceMs(29_999);
  assert.equal(tokens.state(id), 'waiting');
  clock.advanceMs(1);
  assert.equal(tokens.state(id), 'expired');
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), { kind: 'none' });
  assert.equal(tokens.state(id), 'expired');
  assert.equal(alarms(), 0);
});

test('a token is expired when the wall clock stands exactly at expiresAtNs', (t) => {
  const { tokens, clock } = tokenRig(t);
  const { id, token, expiresAtNs } = tokens.mint(30);
  clock.setNs(expiresAtNs - 1n);
  assert.equal(tokens.state(id), 'waiting');
  clock.setNs(expiresAtNs);
  assert.equal(tokens.state(id), 'expired');
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), { kind: 'none' });
});

test('mint(600) lives 10 minutes', (t) => {
  const { tokens, clock } = tokenRig(t);
  const { id, token, expiresAtNs } = tokens.mint(600);
  assert.equal(expiresAtNs, T0 + 600n * SEC);
  clock.advanceMs(599_999);
  assert.equal(tokens.state(id), 'waiting');
  clock.advanceMs(1);
  assert.equal(tokens.state(id), 'expired');
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), { kind: 'none' });
});

test('a token lives no longer than its seconds when the wall clock steps back', (t) => {
  const { tokens, clock } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  clock.advanceMs(10_000);
  clock.setNs(clock.nowNs() - 10n * SEC); // WSL's clock steps back (design 7.6)
  clock.advanceMs(19_999);
  assert.equal(tokens.state(id), 'waiting');
  clock.advanceMs(1);
  assert.ok(clock.nowNs() < T0 + 30n * SEC, 'the wall clock is still before the expiry');
  assert.equal(tokens.state(id), 'expired');
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), { kind: 'none' });
});

test('a token expires at once when the wall clock jumps past its expiry (the PC slept)', (t) => {
  const { tokens, clock } = tokenRig(t);
  const { id, token } = tokens.mint(600);
  clock.setNs(T0 + 3_600n * SEC);
  assert.equal(tokens.state(id), 'expired');
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), { kind: 'none' });
});

test('drop gives a waiting token up; a later proof with it matches nothing', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  assert.equal(tokens.drop(id), true);
  assert.equal(tokens.state(id), 'dropped');
  assert.deepEqual(tokens.check(launchProof(token), SN, CN, ORIGIN), { kind: 'none' });
  assert.equal(tokens.state(id), 'dropped');
  assert.equal(alarms(), 0);
});

test('a used token that was dropped is still recognised: a later proof is reused', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  assert.equal(tokens.drop(id), true);
  assert.equal(tokens.state(id), 'used');
  assert.deepEqual(tokens.check(launchProof(token, SN2, CN2), SN2, CN2, ORIGIN), REUSED);
  assert.equal(tokens.state(id), 'reused');
  assert.equal(alarms(), 1);
});

test('drop and state of an id never minted', (t) => {
  const { tokens } = tokenRig(t);
  assert.equal(tokens.state('0123456789abcdef0123456789abcdef'), null);
  assert.equal(tokens.drop('0123456789abcdef0123456789abcdef'), false);
});

test('an expired token that is dropped is dropped', (t) => {
  const { tokens, clock } = tokenRig(t);
  const { id } = tokens.mint(30);
  clock.advanceMs(31_000);
  assert.equal(tokens.drop(id), true);
  assert.equal(tokens.state(id), 'dropped');
});

test("a used token stays known for the server's life, long after its expiry", (t) => {
  const { tokens, clock, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  tokens.check(launchProof(token), SN, CN, ORIGIN);
  clock.advanceMs(7 * 24 * 3_600_000);
  // testPlatform's random source repeats after 256 bytes, so after 16 tokens an id would recur.
  for (let i = 0; i < 10; i += 1) {
    tokens.drop(tokens.mint(30).id);
  }
  assert.equal(tokens.state(id), 'used');
  assert.deepEqual(tokens.check(launchProof(token, SN2, CN2), SN2, CN2, ORIGIN), REUSED);
  assert.equal(alarms(), 1);
});

test('forgetAll empties everything', (t) => {
  const { tokens, clock, alarms } = tokenRig(t);
  const used = tokens.mint(30);
  const waiting = tokens.mint(600);
  tokens.check(launchProof(used.token), SN, CN, ORIGIN);
  tokens.forgetAll();
  assert.equal(tokens.state(used.id), null);
  assert.equal(tokens.state(waiting.id), null);
  assert.deepEqual(tokens.check(launchProof(used.token), SN, CN, ORIGIN), { kind: 'none' });
  assert.deepEqual(tokens.check(launchProof(waiting.token), SN, CN, ORIGIN), { kind: 'none' });
  assert.equal(alarms(), 0);
  assert.equal(clock.timers(), 0);
});

test('a token holds a timer only while it waits', (t) => {
  const { tokens, clock } = tokenRig(t);
  const used = tokens.mint(30);
  const dropped = tokens.mint(30);
  tokens.mint(30);
  assert.equal(clock.timers(), 3);
  tokens.check(launchProof(used.token), SN, CN, ORIGIN);
  tokens.drop(dropped.id);
  assert.equal(clock.timers(), 1);
  clock.advanceMs(30_000);
  assert.equal(clock.timers(), 0);
});

test('a proof made with the server label, another mode, another origin or other nonces never matches', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const wrong = [
    serverProof(token, 'launch', SN, CN, ORIGIN),
    pageProof(token, 'key', SN, CN, ORIGIN),
    pageProof(token, 'launch', SN, CN, 'http://127.0.0.1:47614'),
    pageProof(token, 'launch', CN, SN, ORIGIN),
    pageProof(token, 'launch', SN2, CN, ORIGIN),
    pageProof(SECRET, 'launch', SN, CN, ORIGIN),
  ];
  for (const proof of wrong) {
    assert.deepEqual(tokens.check(proof, SN, CN, ORIGIN), { kind: 'none' });
  }
  assert.equal(tokens.state(id), 'waiting');
  assert.equal(alarms(), 0);
  assert.equal(tokens.check(launchProof(token), SN, CN, ORIGIN).kind, 'match');
});

test('the whole proof is compared: one character changed anywhere matches nothing', (t) => {
  const { tokens, alarms } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const proof = launchProof(token);
  for (const at of [0, 1, 21, 41, 42]) {
    const other = proof[at] === 'A' ? 'B' : 'A';
    const changed = `${proof.slice(0, at)}${other}${proof.slice(at + 1)}`;
    assert.equal(changed.length, 43);
    assert.deepEqual(tokens.check(changed, SN, CN, ORIGIN), { kind: 'none' }, `position ${at}`);
  }
  assert.equal(tokens.state(id), 'waiting');
  assert.equal(alarms(), 0);
  assert.equal(tokens.check(proof, SN, CN, ORIGIN).kind, 'match');
});

test('check uses the origin it is given', (t) => {
  const { tokens } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const origin = 'http://127.0.0.1:47614';
  const proof = pageProof(token, 'launch', SN, CN, origin);
  assert.deepEqual(tokens.check(proof, SN, CN, ORIGIN), { kind: 'none' });
  assert.equal(tokens.state(id), 'waiting');
  assert.equal(tokens.check(proof, SN, CN, origin).kind, 'match');
});

test('check with a nonce that is not one matches nothing and throws nothing', (t) => {
  const { tokens } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const proof = launchProof(token);
  assert.deepEqual(tokens.check(proof, SN.slice(1), CN, ORIGIN), { kind: 'none' });
  assert.deepEqual(tokens.check(proof, SN, `${CN}=`, ORIGIN), { kind: 'none' });
  assert.equal(tokens.state(id), 'waiting');
});

test('check with a proof, nonce or origin that is not a string matches nothing and throws nothing', (t) => {
  const { tokens } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const proof = launchProof(token);
  for (const notText of [42, null, undefined, {}, ['x'], Buffer.from(proof), Symbol('x')]) {
    const value = notText as unknown as string;
    assert.deepEqual(tokens.check(value, SN, CN, ORIGIN), { kind: 'none' });
    assert.deepEqual(tokens.check(proof, value, CN, ORIGIN), { kind: 'none' });
    assert.deepEqual(tokens.check(proof, SN, value, ORIGIN), { kind: 'none' });
    assert.deepEqual(tokens.check(proof, SN, CN, value), { kind: 'none' });
  }
  assert.equal(tokens.state(id), 'waiting');
});

test('mint refuses seconds other than 30 and 600', (t) => {
  const { tokens } = tokenRig(t);
  assert.throws(() => tokens.mint(31 as 30), { name: 'RangeError' });
  assert.throws(() => tokens.mint(0 as 30), { name: 'RangeError' });
});

test('mint refuses a random source that repeats an id or gives the wrong number of bytes', (t) => {
  const { clock } = testPlatform(t);
  const same = createTokens(
    clock,
    (n) => new Uint8Array(n),
    () => {},
  );
  same.mint(30);
  assert.throws(() => same.mint(30));
  const short = createTokens(
    clock,
    (n) => new Uint8Array(n - 1),
    () => {},
  );
  assert.throws(() => short.mint(30), { name: 'RangeError' });
});

// ---------------------------------------------------------------------------------------------
// Constant time: crypto.timingSafeEqual on equal-length buffers, nothing compared for a proof of
// another length.

/** Records the lengths timingSafeEqual is called with, for the duration of the test. */
function spyTimingSafeEqual(t: TestContext): [number, number][] {
  const lengths: [number, number][] = [];
  const original = crypto.timingSafeEqual;
  t.mock.method(
    crypto,
    'timingSafeEqual',
    (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      lengths.push([a.byteLength, b.byteLength]);
      return original(a, b);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return lengths;
}

test('check compares with timingSafeEqual on equal-length buffers, against every token', (t) => {
  const { tokens } = tokenRig(t);
  const first = tokens.mint(30);
  tokens.mint(30);
  tokens.mint(600);
  const lengths = spyTimingSafeEqual(t);
  assert.equal(tokens.check(launchProof(first.token), SN, CN, ORIGIN).kind, 'match');
  assert.equal(lengths.length, 3, 'one comparison per token, the match does not stop it');
  for (const [a, b] of lengths) {
    assert.equal(a, b);
  }
  lengths.length = 0;
  assert.deepEqual(tokens.check(KEY_PAGE, SN, CN, ORIGIN), { kind: 'none' });
  assert.equal(lengths.length, 3);
});

test('a proof of another length is none without comparing', (t) => {
  const { tokens } = tokenRig(t);
  const { id, token } = tokens.mint(30);
  const lengths = spyTimingSafeEqual(t);
  const proof = launchProof(token);
  for (const other of [
    proof.slice(0, 42),
    `${proof}A`,
    `${proof}=`,
    '',
    `${proof.slice(0, 42)}é`,
  ]) {
    assert.deepEqual(tokens.check(other, SN, CN, ORIGIN), { kind: 'none' });
  }
  assert.deepEqual(lengths, []);
  assert.equal(tokens.state(id), 'waiting');
});

// ---------------------------------------------------------------------------------------------
// Mode key: keyProofMatches, with check's rules.

test("keyProofMatches accepts the page's proof of the vector", () => {
  assert.equal(keyProofMatches(SECRET, KEY_PAGE, SN, CN, ORIGIN), true);
  const proof = pageProof(SECRET, 'key', SN2, CN2, 'http://127.0.0.1:47614');
  assert.equal(keyProofMatches(SECRET, proof, SN2, CN2, 'http://127.0.0.1:47614'), true);
});

test('keyProofMatches refuses the server label, mode launch, another origin, other nonces or key', () => {
  for (const proof of [
    KEY_SERVER,
    pageProof(SECRET, 'launch', SN, CN, ORIGIN),
    pageProof(SECRET, 'key', SN, CN, 'http://127.0.0.1:47614'),
    pageProof(SECRET, 'key', CN, SN, ORIGIN),
    pageProof(SECRET, 'key', SN2, CN, ORIGIN),
    pageProof(TOKEN, 'key', SN, CN, ORIGIN),
  ]) {
    assert.equal(keyProofMatches(SECRET, proof, SN, CN, ORIGIN), false);
  }
  assert.equal(keyProofMatches(TOKEN, KEY_PAGE, SN, CN, ORIGIN), false);
  assert.equal(keyProofMatches(SECRET, KEY_PAGE, SN2, CN, ORIGIN), false);
  assert.equal(keyProofMatches(SECRET, KEY_PAGE, SN, CN, 'http://127.0.0.1:47614'), false);
});

test('keyProofMatches compares the whole proof: one character changed anywhere is refused', () => {
  for (const at of [0, 1, 21, 41, 42]) {
    const other = KEY_PAGE[at] === 'A' ? 'B' : 'A';
    const changed = `${KEY_PAGE.slice(0, at)}${other}${KEY_PAGE.slice(at + 1)}`;
    assert.equal(keyProofMatches(SECRET, changed, SN, CN, ORIGIN), false, `position ${at}`);
  }
});

test('keyProofMatches compares once, with timingSafeEqual on equal-length buffers', (t) => {
  const lengths = spyTimingSafeEqual(t);
  assert.equal(keyProofMatches(SECRET, KEY_PAGE, SN, CN, ORIGIN), true);
  assert.equal(keyProofMatches(SECRET, KEY_SERVER, SN, CN, ORIGIN), false);
  assert.deepEqual(lengths, [
    [43, 43],
    [43, 43],
  ]);
});

test('keyProofMatches refuses, without comparing or throwing, what is not a proof, a nonce or a secret', (t) => {
  const lengths = spyTimingSafeEqual(t);
  const notText = [42, null, undefined, {}, ['x'], Buffer.from(KEY_PAGE), Symbol('x')].map(
    (value) => value as unknown as string,
  );
  for (const proof of [
    KEY_PAGE.slice(0, 42),
    `${KEY_PAGE}A`,
    `${KEY_PAGE}=`,
    '',
    `${KEY_PAGE.slice(0, 42)}é`,
    'x'.repeat(1_024),
    ...notText,
  ]) {
    assert.equal(keyProofMatches(SECRET, proof, SN, CN, ORIGIN), false);
  }
  for (const nonce of [SN.slice(1), `${SN}=`, `${SN.slice(0, 42)}9`, ...notText]) {
    assert.equal(keyProofMatches(SECRET, KEY_PAGE, nonce, CN, ORIGIN), false);
    assert.equal(keyProofMatches(SECRET, KEY_PAGE, SN, nonce, ORIGIN), false);
  }
  for (const origin of notText) {
    assert.equal(keyProofMatches(SECRET, KEY_PAGE, SN, CN, origin), false);
  }
  for (const secret of [
    SECRET.subarray(1),
    new Uint8Array(0),
    Uint8Array.from([...SECRET, 0]),
    ...[null, SECRET_TEXT, Array.from(SECRET)].map((value) => value as unknown as Uint8Array),
  ]) {
    assert.equal(keyProofMatches(secret, KEY_PAGE, SN, CN, ORIGIN), false);
  }
  assert.deepEqual(lengths, []);
});

// ---------------------------------------------------------------------------------------------
// The secret's bytes never appear in a string the module returns.

/** Every text form a byte string takes when it is encoded or interpolated: base64url, base64 with and
 *  without padding, hex in both cases, a Buffer's inspection, `String(bytes)` (the decimals joined
 *  by commas) and the decimals joined by ", " (an array's inspection) or by spaces. */
function textForms(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  const hex = buffer.toString('hex');
  const decimals = Array.from(bytes, String);
  return [
    buffer.toString('base64url'),
    buffer.toString('base64'),
    buffer.toString('base64').replace(/=+$/, ''),
    hex,
    hex.toUpperCase(),
    (hex.match(/../g) ?? []).join(' '),
    String(bytes),
    decimals.join(', '),
    decimals.join(' '),
  ];
}

/** Bytes that look random, so that no form of them turns up in a text by chance. */
function arbitrary(seed: string): Uint8Array {
  return new Uint8Array(crypto.createHash('sha256').update(seed).digest());
}

test('no form of the secret or a token appears in a string the module returns or throws', (t) => {
  const { deck } = testDeck(t);
  const { clock } = testPlatform(t);
  deck.store.setKv('window_secret', b64(arbitrary('the secret')));
  const secret = ensureSecret(deck.store, () => assert.fail('the secret exists'));
  const token = arbitrary('a launch token');
  const iv = arbitrary('an IV').subarray(0, 12);
  const returned: string[] = [];
  const keep = (value: string | null): void => {
    returned.push(String(value));
  };
  const thrown: string[] = [];
  const fails = (what: string, act: () => unknown): void => {
    try {
      act();
    } catch (error) {
      assert.ok(error instanceof Error, what);
      thrown.push(error.message, String(error.stack));
      return;
    }
    assert.fail(`${what}: expected a throw`);
  };

  for (const mode of ['key', 'launch'] as const) {
    for (const key of [secret, token]) {
      keep(pageProof(key, mode, SN, CN, ORIGIN));
      keep(serverProof(key, mode, SN, CN, ORIGIN));
    }
  }
  keep(wrapSecret(secret, token, SN, CN, iv)); // ciphertext: the one exception the plan allows
  const { tokens } = tokenRig(t);
  const minted = tokens.mint(30);
  keep(minted.id);
  keep(tokens.state(minted.id));
  keep(tokens.check(launchProof(minted.token), SN, CN, ORIGIN).kind);
  keep(tokens.state(minted.id));
  keep(tokens.check(launchProof(minted.token), SN, CN, ORIGIN).kind);
  keep(tokens.state(minted.id));

  // Every thrown case of contract 2.8, with the secret or a token as an argument.
  for (const prove of [pageProof, serverProof]) {
    for (const key of [secret, token]) {
      fails('a bad mode', () => prove(key, 'other' as 'key', SN, CN, ORIGIN));
      fails('a bad sN', () => prove(key, 'key', 'x', CN, ORIGIN));
      fails('a bad cN', () => prove(key, 'launch', SN, `${CN}=`, ORIGIN));
      fails('a short key', () => prove(key.subarray(1), 'key', SN, CN, ORIGIN));
      fails('a long key', () => prove(Uint8Array.from([...key, 0]), 'key', SN, CN, ORIGIN));
    }
  }
  fails('a short secret', () => wrapSecret(secret.subarray(1), token, SN, CN, iv));
  fails('a short token', () => wrapSecret(secret, token.subarray(1), SN, CN, iv));
  fails('a short IV', () => wrapSecret(secret, token, SN, CN, iv.subarray(1)));
  fails('a bad sN', () => wrapSecret(secret, token, 'x', CN, iv));
  fails('a bad cN', () => wrapSecret(secret, token, SN, 'x', iv));
  fails('a short random source', () => replaceSecret(deck.store, () => secret.subarray(1)));
  fails('seconds', () => tokens.mint(31 as 30));
  fails('a short random source', () =>
    createTokens(
      clock,
      () => token.subarray(1),
      () => {},
    ).mint(30),
  );
  const repeating = createTokens(
    clock,
    (n) => token.subarray(0, n),
    () => {},
  );
  repeating.mint(30);
  fails('a repeated id', () => repeating.mint(30));

  assert.equal(thrown.length, 2 * (2 * 2 * 5 + 9));
  const needles = [...textForms(secret), ...textForms(token)];
  for (const text of [...returned, ...thrown]) {
    for (const needle of needles) {
      assert.ok(
        !text.includes(needle),
        `${JSON.stringify(needle)} appears in ${JSON.stringify(text)}`,
      );
    }
  }
});

test('the leak search finds bytes where code would interpolate or encode them', () => {
  const bytes = arbitrary('x');
  const buffer = Buffer.from(bytes);
  const found = (text: string): boolean => textForms(bytes).some((form) => text.includes(form));
  assert.ok(found(`a key of ${bytes}`));
  assert.ok(found(`a key ${inspect(buffer)}`));
  assert.ok(found(`a key ${buffer.toString('hex')}`));
  assert.ok(found(`a key ${buffer.toString('base64')}`));
  assert.ok(found(`a key ${buffer.toString('base64url')}`));
  assert.ok(!found('a key must be 32 bytes, not 31'));
});
