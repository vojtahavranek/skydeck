/**
 * Authentication between the page and the server (S2 8.2.2, 15.2): the secret in `kv`
 * (`window_secret`, S2 10.2), launch tokens held in memory only, the HMAC proofs of both sides, the
 * wrapping of the secret for a launch (HKDF-SHA256, AES-256-GCM) and the alarm (`window_alarm`).
 *
 * Pure over a `Store`, a `Clock` and the random source the caller gives (`platform.randomBytes`):
 * no socket, no randomness of its own. The secret's bytes never appear in a string this module
 * returns or throws, except encrypted by `wrapSecret`; error messages name sizes, never values.
 *
 * Encodings (S2 8.2.2): keys (the secret, a launch token) are 32 raw bytes, base64url without
 * padding where they are stored; HMAC and HKDF take the raw bytes. Nonces and proofs are base64url
 * without padding; the HMAC input is the UTF-8 of `<label><mode>\n<sN>\n<cN>\n<origin>`, with the
 * nonces in their base64url form.
 */

import { createCipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { NS_PER_SECOND } from '../platform/time.ts';
import type { Clock, Ns } from '../platform/types.ts';
import type { Store } from '../store/store.ts';
import type { TokenState } from './protocol.ts';

/** The secret, a launch token, a nonce, a proof's HMAC: 32 bytes. */
const KEY_BYTES = 32;
/** AES-GCM's IV (S2 8.2.2: `key` is the 12-byte IV, the ciphertext, the 16-byte tag). */
const IV_BYTES = 12;
/** A token's id: 16 random bytes as 32 lower-case hex characters, what `server.sock`'s parser accepts. */
const ID_BYTES = 16;
/** 32 bytes in base64url without padding. */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** The length of a proof: an HMAC-SHA256 in base64url, 43 ASCII characters. */
const PROOF_LENGTH = 43;

/** The labels differ, so neither side's proof can be replayed as the other's. */
const PAGE_LABEL = 'skydeck page 1\n';
const SERVER_LABEL = 'skydeck server 1\n';
/** HKDF's info for the key that wraps the secret. */
const WRAP_INFO = 'skydeck key 1';

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * The 32 bytes `text` encodes, or null when it is not exactly their base64url form: 43 characters,
 * no padding, and the two bits the last character has to spare zero (the one encoding a base64url
 * encoder writes), so that one value has one text.
 */
function decodeKey(text: string): Uint8Array | null {
  if (typeof text !== 'string' || !KEY_TEXT.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === KEY_BYTES && bytes.toString('base64url') === text
    ? new Uint8Array(bytes)
    : null;
}

/** `count` bytes of the random source, copied; RangeError when the source gives another number. */
function draw(random: (n: number) => Uint8Array, count: number): Uint8Array {
  const bytes = random(count);
  if (bytes.length !== count) {
    throw new RangeError(`the random source gave ${bytes.length} bytes instead of ${count}`);
  }
  return Uint8Array.from(bytes);
}

function requireBytes(bytes: Uint8Array, count: number, what: string): void {
  if (bytes.length !== count) {
    throw new RangeError(`${what} must be ${count} bytes, not ${bytes.length}`);
  }
}

function requireNonce(text: string, what: string): void {
  if (!isNonce(text)) {
    throw new RangeError(`${what} is not 32 bytes in base64url`);
  }
}

/**
 * The secret (S2 15.2), created on first need: 32 random bytes, stored in `kv` `window_secret` as
 * base64url without padding. Read and created inside one transaction, so a second connection (a
 * `--print-url` racing the first server) gets the same secret. A stored value that is not 32 bytes
 * in that form is replaced as if absent: it could prove nothing, and a page that held a key from it
 * gets 4003 and is told to run `skydeck window` again.
 */
export function ensureSecret(store: Store, random: (n: number) => Uint8Array): Uint8Array {
  return store.transaction(() => {
    const stored = store.getKv('window_secret');
    const secret = stored === null ? null : decodeKey(stored);
    if (secret !== null) {
      return secret;
    }
    const created = draw(random, KEY_BYTES);
    store.setKv('window_secret', encode(created));
    return created;
  });
}

/**
 * `skydeck window --new-secret` (S2 5.1): a new secret, and `window_alarm` cleared, in one
 * transaction. The caller has stopped the server first (which forgets every token).
 */
export function replaceSecret(store: Store, random: (n: number) => Uint8Array): void {
  store.transaction(() => {
    store.setKv('window_secret', encode(draw(random, KEY_BYTES)));
    store.deleteKv('window_alarm');
  });
}

function proof(
  label: string,
  key: Uint8Array,
  mode: 'key' | 'launch',
  sN: string,
  cN: string,
  origin: string,
): string {
  requireBytes(key, KEY_BYTES, 'a key');
  if (mode !== 'key' && mode !== 'launch') {
    throw new RangeError('the mode is not key or launch');
  }
  requireNonce(sN, "the server's nonce");
  requireNonce(cN, "the page's nonce");
  return createHmac('sha256', key)
    .update(`${label}${mode}\n${sN}\n${cN}\n${origin}`, 'utf8')
    .digest('base64url');
}

/**
 * pP = HMAC-SHA256(K, "skydeck page 1\n" + mode + "\n" + sN + "\n" + cN + "\n" + origin), K the
 * secret (mode `key`) or the launch token (mode `launch`). RangeError for a key that is not 32
 * bytes or a nonce that is not one (isNonce).
 */
export function pageProof(
  key: Uint8Array,
  mode: 'key' | 'launch',
  sN: string,
  cN: string,
  origin: string,
): string {
  return proof(PAGE_LABEL, key, mode, sN, cN, origin);
}

/** pS: as pageProof with the label "skydeck server 1\n". */
export function serverProof(
  key: Uint8Array,
  mode: 'key' | 'launch',
  sN: string,
  cN: string,
  origin: string,
): string {
  return proof(SERVER_LABEL, key, mode, sN, cN, origin);
}

/**
 * The bytes of a page's proof, or null when nothing should be compared with it: it is not a
 * string of 43 bytes (an HMAC-SHA256 in base64url), or the nonces or the origin it was made over
 * are not what a proof can be made over.
 */
function proofBytes(given: unknown, sN: unknown, cN: unknown, origin: unknown): Buffer | null {
  return typeof given === 'string' &&
    Buffer.byteLength(given, 'utf8') === PROOF_LENGTH &&
    isNonce(sN as string) &&
    isNonce(cN as string) &&
    typeof origin === 'string'
    ? Buffer.from(given, 'utf8')
    : null;
}

/**
 * Mode `key` (S2 8.2.2 step 4): whether `proof` is the page's proof made with the secret, compared
 * in constant time (`timingSafeEqual` on two 43-byte buffers). False, without comparing anything
 * and without throwing, for a proof that is not a string of 43 bytes, an sN or cN that is not a
 * nonce (isNonce), or a secret that is not 32 bytes. The server never compares proofs itself.
 */
export function keyProofMatches(
  secret: Uint8Array,
  proof: string,
  sN: string,
  cN: string,
  origin: string,
): boolean {
  const given = proofBytes(proof, sN, cN, origin);
  if (given === null || !(secret instanceof Uint8Array) || secret.length !== KEY_BYTES) {
    return false;
  }
  return timingSafeEqual(given, Buffer.from(pageProof(secret, 'key', sN, cN, origin), 'utf8'));
}

/**
 * The welcome's `key` in mode `launch` (S2 8.2.2): the secret encrypted with AES-256-GCM under
 * HKDF-SHA256(token, salt = UTF-8 of sN + cN, info = "skydeck key 1", 32 bytes), as base64url of
 * the 12-byte IV, the ciphertext and the 16-byte tag. `iv` comes from the platform's random source
 * (a test passes the vector's). RangeError for a secret or token that is not 32 bytes, an IV that
 * is not 12, or a nonce that is not one.
 */
export function wrapSecret(
  secret: Uint8Array,
  token: Uint8Array,
  sN: string,
  cN: string,
  iv: Uint8Array,
): string {
  requireBytes(secret, KEY_BYTES, 'the secret');
  requireBytes(token, KEY_BYTES, 'a launch token');
  requireBytes(iv, IV_BYTES, 'the IV');
  requireNonce(sN, "the server's nonce");
  requireNonce(cN, "the page's nonce");
  const key = new Uint8Array(
    hkdfSync('sha256', token, Buffer.from(sN + cN, 'utf8'), Buffer.from(WRAP_INFO, 'utf8'), 32),
  );
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([iv, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  return sealed.toString('base64url');
}

/** Exactly 32 bytes in base64url without padding: 43 characters, the unused bits of the last zero. */
export function isNonce(text: string): boolean {
  return decodeKey(text) !== null;
}

export interface Tokens {
  /**
   * A launch token for one window (S2 8.2.2): 32 random bytes, valid once and for `seconds` (30,
   * or 600 for `--print-url`; RangeError for another number). `id` is 32 lower-case hex
   * characters. The token expires when its seconds have passed on a timer (which counts on a
   * clock that does not jump) or when the wall clock passes `expiresAtNs`, whichever comes first.
   */
  mint(seconds: 30 | 600): { id: string; token: Uint8Array; expiresAtNs: Ns };
  /**
   * S2 8.3 `GET /token/<id>`; null for an id this server never minted (or forgot). A used token
   * stays `used` (or `reused`) whatever happens later; an unused one is `dropped` once given up,
   * else `expired` once its time is out, else `waiting`.
   */
  state(id: string): TokenState | null;
  /**
   * Gives the token up (S2 8.3 `POST /token/drop`): a later proof with it is `none` — or `reused`
   * when it had been used, which stays known. False for an unknown id.
   */
  drop(id: string): boolean;
  /**
   * Constant-time check of `proof` against every token a proof can still reach (waiting, used or
   * reused; see createTokens); a match marks it used, a proof with a used token marks it reused
   * (and, on that token's first reuse, raises the alarm). Never throws: `alarmFailure` is the kind
   * of the alarm callback's failure (an error's name and code, never its message), else null.
   */
  check(
    proof: string,
    sN: string,
    cN: string,
    origin: string,
  ):
    | { kind: 'match'; token: Uint8Array }
    | { kind: 'reused'; alarmFailure: string | null }
    | { kind: 'none' };
  forgetAll(): void;
}

interface HeldToken {
  token: Uint8Array;
  expiresAtNs: Ns;
  use: 'unused' | 'used' | 'reused';
  dropped: boolean;
  /** Its timer ran out. */
  timedOut: boolean;
  /** onAlarm returned for this token's reuse (it is not called again for the token). */
  alarmRaised: boolean;
  /** Stops its timer; null once the token waits no longer. */
  stopTimer: (() => void) | null;
}

function stateOf(held: HeldToken, nowNs: Ns): TokenState {
  if (held.use !== 'unused') {
    return held.use;
  }
  if (held.dropped) {
    return 'dropped';
  }
  return held.timedOut || nowNs >= held.expiresAtNs ? 'expired' : 'waiting';
}

function stopTimer(held: HeldToken): void {
  held.stopTimer?.();
  held.stopTimer = null;
}

/**
 * The server's launch tokens, in memory only (S2 8.2.2): never in the store or a file, forgotten
 * when the server ends. A used token is remembered for the server's whole life (a few bytes each),
 * so that a second use is always recognised.
 *
 * The alarm: a proof with a used token marks it `reused` first; then, on that token's first reuse,
 * `onAlarm` is called (the server records the time with raiseAlarm). A later reuse of the same
 * token calls it again only when every earlier call failed, so a process that presents one used
 * token in a loop costs no store write per presentation. The verdict is `reused` whatever `onAlarm`
 * does: its failure (a refused store write, a locked database) comes back in the result by kind.
 *
 * `check` takes a page's proof in mode `launch`. A proof that is not a string of 43 bytes, or nonces
 * that are not nonces, match nothing and are compared with nothing. Otherwise the proof is compared,
 * with `timingSafeEqual` on two 43-byte buffers, against the proof of every token that a proof can
 * still reach — waiting, used or reused; one dropped or expired before its use can only be `none`
 * — and the comparison does not stop at a match.
 */
export function createTokens(
  clock: Clock,
  random: (n: number) => Uint8Array,
  onAlarm: () => void,
): Tokens {
  const held = new Map<string, HeldToken>();
  return {
    mint(seconds) {
      if (seconds !== 30 && seconds !== 600) {
        throw new RangeError(`a launch token lives 30 or 600 seconds, not ${String(seconds)}`);
      }
      const id = Buffer.from(draw(random, ID_BYTES)).toString('hex');
      if (held.has(id)) {
        throw new Error('the random source repeated a launch token id');
      }
      const token = draw(random, KEY_BYTES);
      const entry: HeldToken = {
        token,
        expiresAtNs: clock.nowNs() + BigInt(seconds) * NS_PER_SECOND,
        use: 'unused',
        dropped: false,
        timedOut: false,
        alarmRaised: false,
        stopTimer: null,
      };
      entry.stopTimer = clock.after(seconds * 1000, () => {
        entry.timedOut = true;
        entry.stopTimer = null;
      });
      held.set(id, entry);
      return { id, token: Uint8Array.from(token), expiresAtNs: entry.expiresAtNs };
    },
    state(id) {
      const entry = held.get(id);
      return entry === undefined ? null : stateOf(entry, clock.nowNs());
    },
    drop(id) {
      const entry = held.get(id);
      if (entry === undefined) {
        return false;
      }
      entry.dropped = true;
      stopTimer(entry);
      return true;
    },
    check(given, sN, cN, origin) {
      const givenBytes = proofBytes(given, sN, cN, origin);
      if (givenBytes === null) {
        return { kind: 'none' };
      }
      const nowNs = clock.nowNs();
      let found: HeldToken | null = null;
      for (const entry of held.values()) {
        const state = stateOf(entry, nowNs);
        if (state === 'dropped' || state === 'expired') {
          continue;
        }
        const expected = Buffer.from(pageProof(entry.token, 'launch', sN, cN, origin), 'utf8');
        if (timingSafeEqual(givenBytes, expected) && found === null) {
          found = entry;
        }
      }
      if (found === null) {
        return { kind: 'none' };
      }
      if (found.use === 'unused') {
        found.use = 'used';
        stopTimer(found);
        return { kind: 'match', token: Uint8Array.from(found.token) };
      }
      found.use = 'reused';
      if (found.alarmRaised) {
        return { kind: 'reused', alarmFailure: null };
      }
      try {
        onAlarm();
      } catch (error) {
        return { kind: 'reused', alarmFailure: failureKind(error) };
      }
      found.alarmRaised = true;
      return { kind: 'reused', alarmFailure: null };
    },
    forgetAll() {
      for (const entry of held.values()) {
        stopTimer(entry);
      }
      held.clear();
    },
  };
}

/** An error's name and, when it has one, its code, for a log line; never its message. */
function failureKind(error: unknown): string {
  try {
    if (!(error instanceof Error)) {
      return `a thrown ${error === null ? 'null' : typeof error}`;
    }
    const name: unknown = error.name;
    const kind = typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : 'Error';
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? `${kind} (${code})` : kind;
  } catch {
    return 'an error that cannot be read';
  }
}

/**
 * S2 8.2.2: a used launch token was presented again. `kv` `window_alarm` holds the time (ns,
 * decimal) of the first such presentation: a recorded time is kept (`--new-secret` clears it); a
 * value that is not one is replaced. Read and written in one transaction.
 */
export function raiseAlarm(store: Store, nowNs: Ns): void {
  store.transaction(() => {
    const recorded = store.getKv('window_alarm');
    if (recorded === null || !/^[0-9]+$/.test(recorded)) {
      store.setKv('window_alarm', nowNs.toString());
    }
  });
}
