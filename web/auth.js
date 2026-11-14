// The page's side of the handshake (S2 8.2.2 steps 3–6) and of "where the page keeps its key":
// the HMAC proofs, the launch token taken out of the address, HKDF and `unwrapKey` into an HMAC
// key that cannot be extracted, and that key in the origin's IndexedDB. Web Crypto only: the
// secret's bytes never reach this code, and nothing here sends anything.
//
// Encodings (S2 8.2.2): keys, nonces and proofs are base64url without padding; a nonce or a key is
// accepted only in its canonical form (43 characters for 32 bytes, the spare bits zero), so that
// one value has one text (the rule of src/window/auth.ts's isNonce; ruled, task 11).

/** @typedef {'key' | 'launch'} Mode */

const PAGE_LABEL = 'skydeck page 1\n';
const SERVER_LABEL = 'skydeck server 1\n';
const WRAP_INFO = 'skydeck key 1';
/** The secret, a launch token, a nonce, an HMAC-SHA256: 32 bytes. */
const KEY_BYTES = 32;
/** `key` of a welcome: the 12-byte IV, the 32 bytes of ciphertext, the 16-byte tag. */
const IV_BYTES = 12;
const SEALED_BYTES = IV_BYTES + KEY_BYTES + 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const HMAC = { name: 'HMAC', hash: 'SHA-256' };

/** Where the key lives: one entry of one object store of the origin's IndexedDB. */
const DATABASE = 'skydeck';
const STORE = 'keys';
const ENTRY = 'secret';

const utf8 = new TextEncoder();

/**
 * base64url without padding.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encode(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The bytes of a canonical base64url text without padding; null for anything else (another
 * alphabet, padding, a length no encoder writes, spare bits that are not zero).
 * @param {unknown} text
 * @returns {Uint8Array<ArrayBuffer> | null}
 */
export function decode(text) {
  if (typeof text !== 'string' || !BASE64URL.test(text) || text.length % 4 === 1) {
    return null;
  }
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  let binary;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return encode(bytes) === text ? bytes : null;
}

/**
 * 32 bytes in canonical base64url (a key, a launch token, a nonce, a proof), or null.
 * @param {unknown} text
 * @returns {Uint8Array<ArrayBuffer> | null}
 */
export function decodeKey(text) {
  const bytes = decode(text);
  return bytes !== null && bytes.length === KEY_BYTES ? bytes : null;
}

/**
 * Exactly 32 bytes in canonical base64url: 43 characters, the two spare bits of the last zero.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isNonce(text) {
  return decodeKey(text) !== null;
}

/**
 * The page's nonce of one connection: 32 random bytes, canonically encoded.
 * @returns {string}
 */
export function newNonce() {
  return encode(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/**
 * An HMAC-SHA256 key of `bytes` that cannot be extracted (the launch token's, for mode launch).
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @returns {Promise<CryptoKey>}
 */
export function hmacKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, HMAC, false, ['sign', 'verify']);
}

/**
 * @param {string} label
 * @param {Mode} mode
 * @param {string} sN
 * @param {string} cN
 * @param {string} origin
 * @returns {Uint8Array<ArrayBuffer>}
 */
function proofInput(label, mode, sN, cN, origin) {
  return utf8.encode(`${label}${mode}\n${sN}\n${cN}\n${origin}`);
}

/**
 * pP = HMAC-SHA256(K, "skydeck page 1\n" + mode + "\n" + sN + "\n" + cN + "\n" + origin).
 * @param {CryptoKey} key the stored key (mode key) or the launch token's (mode launch)
 * @param {Mode} mode
 * @param {string} sN
 * @param {string} cN
 * @param {string} origin
 * @returns {Promise<string>}
 */
export async function pageProof(key, mode, sN, cN, origin) {
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    proofInput(PAGE_LABEL, mode, sN, cN, origin),
  );
  return encode(new Uint8Array(signature));
}

/**
 * Whether `proof` is pS, the server's proof with the label "skydeck server 1\n" (Web Crypto's
 * verify compares). False for anything that is not 32 bytes in canonical base64url.
 * @param {CryptoKey} key
 * @param {Mode} mode
 * @param {string} sN
 * @param {string} cN
 * @param {string} origin
 * @param {unknown} proof
 * @returns {Promise<boolean>}
 */
export async function serverProofMatches(key, mode, sN, cN, origin, proof) {
  const given = decodeKey(proof);
  if (given === null) {
    return false;
  }
  return crypto.subtle.verify('HMAC', key, given, proofInput(SERVER_LABEL, mode, sN, cN, origin));
}

/**
 * The secret of a welcome's `key` as an HMAC key that cannot be extracted: AES-256-GCM under
 * HKDF-SHA256(token, salt = UTF-8 of sN + cN, info = "skydeck key 1"), `unwrapKey` of the
 * ciphertext and tag after the 12-byte IV. null when `wrapped` is not that, or does not open.
 * @param {Uint8Array<ArrayBuffer>} token the launch token's bytes
 * @param {string} sN
 * @param {string} cN
 * @param {unknown} wrapped
 * @returns {Promise<CryptoKey | null>}
 */
export async function unwrapSecret(token, sN, cN, wrapped) {
  const sealed = decode(wrapped);
  if (sealed === null || sealed.length !== SEALED_BYTES) {
    return null;
  }
  try {
    const base = await crypto.subtle.importKey('raw', token, 'HKDF', false, ['deriveKey']);
    const wrapping = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(sN + cN), info: utf8.encode(WRAP_INFO) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['unwrapKey'],
    );
    return await crypto.subtle.unwrapKey(
      'raw',
      sealed.subarray(IV_BYTES),
      wrapping,
      { name: 'AES-GCM', iv: sealed.subarray(0, IV_BYTES) },
      HMAC,
      false,
      ['sign', 'verify'],
    );
  } catch {
    return null;
  }
}

/**
 * The launch token of the address's fragment (`#t=<token>`, S2 5.1), taken out of the address at
 * once with `history.replaceState` (the address becomes `/`). Any other fragment is removed too.
 * The token as written, or null when there is none.
 * @returns {string | null}
 */
export function takeToken() {
  const fragment = location.hash;
  if (fragment === '') {
    return null;
  }
  history.replaceState(null, '', '/');
  return fragment.startsWith('#t=') ? fragment.slice(3) : null;
}

/** @returns {Promise<IDBDatabase>} */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the key store is blocked'));
  });
}

/**
 * The key the page stored, or null when there is none or it cannot be read.
 * @returns {Promise<CryptoKey | null>}
 */
export async function loadKey() {
  let database;
  try {
    database = await openDatabase();
  } catch {
    return null;
  }
  try {
    /** @type {unknown} */
    const value = await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(ENTRY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return value instanceof CryptoKey &&
      value.algorithm.name === 'HMAC' &&
      value.usages.includes('sign')
      ? value
      : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/**
 * Stores `key` as the page's key, in place of any earlier one; resolves once it is written.
 * @param {CryptoKey} key
 * @returns {Promise<void>}
 */
export async function storeKey(key) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(key, ENTRY);
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
