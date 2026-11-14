// The page's connection to the server (S2 6.3, 8.2.2, 8.2.5, 15.3): the handshake — the server's
// proof checked before anything else is sent, shown or obeyed —, `start`, a ping every second,
// the server-gone state after 3 seconds without an answer or a closed socket, the reconnects
// (every second for 10 seconds, then every 5), the reload keys' own connection (a reload only
// after a server's proof), and `input` split into messages of at most 64 KiB.
//
// What makes the page stop for good (a `fatal` text, no more connections): a server that cannot
// prove itself or speaks no skydeck protocol, 4003, 4004, 4426, and a launch token that was
// presented and did not give the page its key (S2 8.2.2: a token is presented once). Everything
// else — a refused connection, a 503 at the upgrade (the server starts or stops), a close 1013
// at the hello (its database is busy), a close right after the challenge (a waiting connection
// evicted), a timeout — is a lost connection, retried, and never said to be someone else's.

/** @import { ServerMessage, WelcomeMessage } from '../src/window/protocol.ts' */
/** @import { Mode } from './auth.js' */
import {
  hmacKey,
  isNonce,
  newNonce,
  pageProof,
  serverProofMatches,
  storeKey,
  unwrapSecret,
} from './auth.js';

/** How a welcome relates to the previous one (S2 6.3). */
/** @typedef {'first' | 'same' | 'restarted' | 'wsl-restarted'} Change */
/** @typedef {'connecting' | 'open' | 'lost' | 'fatal'} State */

/**
 * @typedef {object} ConnectionEvents
 * @property {(state: State) => void} state
 * @property {(welcome: WelcomeMessage, change: Change, lostSince: Date | null) => void} welcome
 *   after the server's proof, once `start` is sent
 * @property {(message: ServerMessage) => void} message every message after `start` but `pong`
 * @property {(channel: number, bytes: Uint8Array) => void} output an output frame (S2 8.2.3)
 * @property {(since: Date) => void} lost the server stopped answering at `since`
 * @property {(text: string) => void} fatal the page stops; `text` says why
 * @property {(text: string) => void} warn something to tell that does not stop the page
 */

/**
 * @typedef {object} ConnectionOptions
 * @property {string} assetVersion the build the page was loaded with
 * @property {string} windowId 16 lower-case hex characters, this page's
 * @property {CryptoKey | null} key the stored key
 * @property {Uint8Array<ArrayBuffer> | null} token the launch token of the address
 * @property {() => { focused: boolean, theme: { fg: string, bg: string } }} start
 * @property {ConnectionEvents} events
 */

/**
 * @typedef {{ ok: true, welcome: WelcomeMessage, key: CryptoKey | null }
 *   | { ok: false, why: 'closed', code: number, helloSent: boolean }
 *   | { ok: false, why: 'timeout', helloSent: boolean }
 *   | { ok: false, why: 'not-skydeck' | 'protocol' | 'bad-key' }} Handshake
 */

const PROTOCOL = 1;
const PING_MS = 1000;
/** A tick of the checks that comes this much later than the one before was held (ruled, review 2). */
const LATE_MS = 1500;
/** S2 6.3: no answer for this long and the server counts as gone. */
const SILENT_MS = 3000;
const CHECK_MS = 250;
/** Each step of the handshake (the challenge, the welcome) within this. */
const HANDSHAKE_MS = 5000;
/** S2 6.3: try again every second for 10 seconds, then every 5 seconds. */
const FAST_MS = 1000;
const FAST_FOR_MS = 10_000;
const SLOW_MS = 5000;
/** S2 8.2.3: a page's `input.data` is at most 64 KiB of UTF-8. */
const INPUT_BYTES = 64 * 1024;

const OTHER_PROTOCOL = 4426;
const NOT_VALID = 4003;
const REUSED = 4004;
const TRY_LATER = 1013;
/** Session storage: the server's version the page last reloaded itself for. */
const RELOADED_FOR = 'skydeck-reloaded-for';

/** The texts of S2 8.2.2. */
export const TEXTS = {
  notValid: "this window's key is not valid; run skydeck window again",
  alarm:
    "this window's launch address was used by another program, which may now have skydeck's key; run skydeck window --new-secret",
  protocol: "skydeck's server speaks another protocol; run skydeck window again",
  /** S2 8.2.2 step 6, after the one reload (ruled, task 26); the recovery of S2 15.3. */
  stale:
    "this window's page is not the one skydeck's server serves, and reloading did not change that; close every skydeck window, delete the window's profile folder and run skydeck window --new-secret",
  /** The same, for a page that cannot remember a reload (no session storage): it does not reload. */
  staleUnknown:
    "this window's page is not the one skydeck's server serves, and it cannot tell whether it reloaded already; press Ctrl+Shift+R to reload it, or close it and run skydeck window",
  /** A launch whose key IndexedDB did not take: a reload would lose it (S2 8.2.2). */
  unstored:
    "this window's key could not be stored: the window works until it is reloaded or closed, and its reload keys do not reload it; run skydeck window again for a window that keeps its key",
  /** The same, when the server's asset version differs (S2 8.2.2 step 6): no reload either. */
  staleUnstored:
    "this window's page is not the one skydeck's server serves, and its key could not be stored, so it cannot reload itself; run skydeck window again",
  /** @param {string} port */
  notSkydeck: (port) =>
    `something answers on port ${port} that is not skydeck's server; nothing was sent to it`,
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} data
 * @returns {unknown}
 */
function parse(data) {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} message
 * @returns {message is WelcomeMessage}
 */
function isWelcome(message) {
  return (
    isObject(message) &&
    message['t'] === 'welcome' &&
    typeof message['proof'] === 'string' &&
    message['protocol'] === PROTOCOL &&
    typeof message['assetVersion'] === 'string' &&
    typeof message['serverId'] === 'string' &&
    typeof message['bootId'] === 'string' &&
    isObject(message['keepAlive'])
  );
}

/**
 * `data` (text the page types or pastes) as the `data` of `input` messages of at most 64 KiB of
 * UTF-8 each, in order; a surrogate pair is never split, and a lone surrogate becomes U+FFFD (the
 * server refuses text that is not well formed). With `binary` (a byte string), at most 65,536
 * characters each.
 * @param {string} data
 * @param {boolean} [binary]
 * @returns {string[]}
 */
export function splitInput(data, binary = false) {
  if (binary) {
    const parts = [];
    for (let at = 0; at < data.length; at += INPUT_BYTES) {
      parts.push(data.slice(at, at + INPUT_BYTES));
    }
    return parts;
  }
  const text = data.toWellFormed();
  const parts = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const pair = unit >= 0xd800 && unit <= 0xdbff;
    const size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > INPUT_BYTES) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    if (pair) {
      i++;
    }
  }
  if (start < text.length) {
    parts.push(text.slice(start));
  }
  return parts;
}

/**
 * S2 6.3: how long the page waits before it tries again, `sinceLostMs` after it lost the server:
 * every second for 10 seconds, then every 5 seconds.
 * @param {number} sinceLostMs
 * @returns {number}
 */
export function retryDelay(sinceLostMs) {
  return sinceLostMs < FAST_FOR_MS ? FAST_MS : SLOW_MS;
}

/**
 * The page's connection. It connects at once; `send` is for the messages of S2 8.2.3 once open
 * (false while not); `reload` is the reload keys' (S2 12.9, 15.3).
 * @param {ConnectionOptions} options
 */
export function createConnection(options) {
  const { events } = options;
  const origin = location.origin;
  const port = location.port === '' ? '80' : location.port;
  const url = `ws://${location.host}/ws`;
  let key = options.key;
  let token = options.token;
  // S2 8.2.2: the page forgets the token once it is used; nothing keeps it but `token`.
  options.token = null;
  /** Whether `key` is in IndexedDB: a page whose key is only in memory must not reload. */
  let keyStored = options.key !== null;
  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {State} */
  let state = 'connecting';
  /** @type {{ bootId: string, serverId: string } | null} */
  let last = null;
  /** @type {number | null} */
  let lostAt = null;
  /** @type {Date | null} */
  let lostSince = null;
  let pings = 0;
  /** @type {ReturnType<typeof setInterval>[]} */
  let timers = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retry = null;
  let probing = false;

  /** @param {State} next */
  const setState = (next) => {
    state = next;
    events.state(next);
  };

  const stopTimers = () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
    timers = [];
  };

  /**
   * S2 8.2.2 steps 2–5 on `ws`: the challenge, the page's hello, the server's welcome and its
   * proof. Nothing but the hello is sent; `ws` keeps no handler of it afterwards.
   * @param {WebSocket} ws
   * @param {Mode} mode
   * @param {CryptoKey} proofKey
   * @returns {Promise<Handshake>}
   */
  const handshake = (ws, mode, proofKey) =>
    new Promise((resolve) => {
      let done = false;
      let helloSent = false;
      /** @type {string | null} */
      let sN = null;
      let cN = '';
      let chain = Promise.resolve();
      /** @param {Handshake} result */
      const finish = (result) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        ws.onmessage = null;
        ws.onclose = null;
        resolve(result);
      };
      let timer = setTimeout(() => finish({ ok: false, why: 'timeout', helloSent }), HANDSHAKE_MS);
      ws.onerror = () => {};
      ws.onclose = (event) => finish({ ok: false, why: 'closed', code: event.code, helloSent });
      /** @param {unknown} data */
      const step = async (data) => {
        if (done) {
          return;
        }
        const message = parse(data);
        if (sN === null) {
          if (!isObject(message) || message['t'] !== 'challenge') {
            finish({ ok: false, why: 'not-skydeck' });
            return;
          }
          if (message['protocol'] !== PROTOCOL) {
            finish({ ok: false, why: 'protocol' });
            return;
          }
          const nonce = message['nonce'];
          if (typeof nonce !== 'string' || !isNonce(nonce)) {
            finish({ ok: false, why: 'not-skydeck' });
            return;
          }
          sN = nonce;
          cN = newNonce();
          const proof = await pageProof(proofKey, mode, sN, cN, origin);
          if (done || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, mode, nonce: cN, proof }));
          helloSent = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish({ ok: false, why: 'timeout', helloSent }), HANDSHAKE_MS);
          return;
        }
        if (
          !isWelcome(message) ||
          !(await serverProofMatches(proofKey, mode, sN, cN, origin, message.proof))
        ) {
          finish({ ok: false, why: 'not-skydeck' });
          return;
        }
        if (mode === 'key' || token === null) {
          finish({ ok: true, welcome: message, key: null });
          return;
        }
        const unwrapped = await unwrapSecret(token, sN, cN, message.key);
        finish(
          unwrapped === null
            ? { ok: false, why: 'bad-key' }
            : { ok: true, welcome: message, key: unwrapped },
        );
      };
      ws.onmessage = (event) => {
        chain = chain.then(() => step(event.data));
      };
    });

  /** @param {string} text */
  const fail = (text) => {
    stopTimers();
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    const ws = socket;
    socket = null;
    if (ws !== null) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    }
    setState('fatal');
    events.fatal(text);
  };

  /** The connection is gone: the bar (once), and the next attempt by S2 6.3's schedule. */
  const lost = () => {
    stopTimers();
    if (state === 'fatal') {
      return;
    }
    if (lostAt === null) {
      lostAt = performance.now();
      lostSince = new Date();
      setState('lost');
      events.lost(lostSince);
    }
    retry = setTimeout(attempt, retryDelay(performance.now() - lostAt));
  };

  /** @param {WebSocket} ws */
  const drop = (ws) => {
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
    if (socket === ws) {
      socket = null;
      lost();
    }
  };

  /**
   * A failed handshake: stop for good, or try again.
   * @param {Handshake & { ok: false }} result
   * @param {Mode} mode
   */
  const failed = (result, mode) => {
    if (result.why === 'not-skydeck') {
      fail(TEXTS.notSkydeck(port));
      return;
    }
    if (result.why === 'protocol' || (result.why === 'closed' && result.code === OTHER_PROTOCOL)) {
      fail(TEXTS.protocol);
      return;
    }
    if (result.why === 'closed' && result.code === REUSED) {
      fail(TEXTS.alarm);
      return;
    }
    if (result.why === 'bad-key' || (result.why === 'closed' && result.code === NOT_VALID)) {
      fail(TEXTS.notValid);
      return;
    }
    // S2 8.2.2: a token is presented once. A close 1013 is the server's database being busy,
    // before it looked at any token (pages.ts): that one is tried again.
    const busy = result.why === 'closed' && result.code === TRY_LATER;
    const helloSent = (result.why === 'closed' || result.why === 'timeout') && result.helloSent;
    if (mode === 'launch' && helloSent && !busy) {
      fail(TEXTS.notValid);
      return;
    }
    lost();
  };

  /**
   * The open connection: its messages, and S2 6.3's silence (ruled, review 2). The server is
   * silent only when a ping the page really sent has had no pong (the pong carries the ping's
   * `n`) for 3 seconds, judged at a tick that comes on time. A tick that comes late — the page's
   * timers were held: a hidden, minimised or covered window, a frozen page, a debugger — judges
   * nothing: it pings, and the 3 seconds count from that ping. A closed socket is gone at once.
   * @param {WebSocket} ws
   */
  const open = (ws) => {
    /** The pings without their pong yet, the oldest first: `n` → when it was sent. */
    const unanswered = new Map();
    let lastTick = performance.now();
    let lastPing = -Infinity;
    /** @param {number} now */
    const ping = (now) => {
      const n = pings++;
      unanswered.set(n, now);
      lastPing = now;
      ws.send(JSON.stringify({ t: 'ping', n }));
    };
    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        const message = parse(data);
        if (!isObject(message) || typeof message['t'] !== 'string') {
          return;
        }
        if (message['t'] === 'pong') {
          const n = message['n'];
          for (const sent of [...unanswered.keys()]) {
            if (typeof n === 'number' && sent <= n) {
              unanswered.delete(sent);
            }
          }
          return;
        }
        events.message(/** @type {ServerMessage} */ (/** @type {unknown} */ (message)));
        return;
      }
      if (data instanceof ArrayBuffer && data.byteLength >= 5) {
        const view = new DataView(data);
        if (view.getUint8(0) === 1) {
          events.output(view.getUint32(1), new Uint8Array(data, 5));
        }
      }
    };
    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
        lost();
      }
    };
    timers.push(
      setInterval(() => {
        const now = performance.now();
        const late = now - lastTick > LATE_MS;
        lastTick = now;
        if (ws.readyState !== WebSocket.OPEN) {
          // It closed while nobody listened (between the handshake and open: a launch storing
          // its key): gone, as a closed socket is.
          drop(ws);
          return;
        }
        if (late) {
          unanswered.clear();
          ping(now);
          return;
        }
        for (const sentAt of unanswered.values()) {
          if (now - sentAt > SILENT_MS) {
            drop(ws);
            return;
          }
          break;
        }
        if (now - lastPing >= PING_MS) {
          ping(now);
        }
      }, CHECK_MS),
    );
  };

  /**
   * S2 8.2.2 step 6: a page whose asset version is not the server's reloads itself — once per
   * version of the server's (ruled, task 26): a page that has reloaded and still differs would
   * otherwise reload for ever. 'same'; 'reload'; 'stuck' when it reloaded for that version
   * already; 'unknown' when it cannot remember a reload (session storage throws), so that it
   * does not reload on its own.
   * @param {string} version the server's
   * @returns {'same' | 'reload' | 'stuck' | 'unknown'}
   */
  const versionStep = (version) => {
    try {
      if (version === options.assetVersion) {
        sessionStorage.removeItem(RELOADED_FOR);
        return 'same';
      }
      if (sessionStorage.getItem(RELOADED_FOR) === version) {
        return 'stuck';
      }
      sessionStorage.setItem(RELOADED_FOR, version);
      return 'reload';
    } catch {
      return version === options.assetVersion ? 'same' : 'unknown';
    }
  };

  async function attempt() {
    retry = null;
    if (state === 'fatal') {
      return;
    }
    const mode = token !== null ? 'launch' : 'key';
    const proofKey = token !== null ? await hmacKey(token) : key;
    if (proofKey === null) {
      fail(TEXTS.notValid);
      return;
    }
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    const result = await handshake(ws, mode, proofKey);
    if (socket !== ws) {
      ws.close();
      return;
    }
    if (!result.ok) {
      socket = null;
      ws.onclose = null;
      ws.close();
      failed(result, mode);
      return;
    }
    if (result.key !== null) {
      key = result.key;
      token = null;
      try {
        await storeKey(key);
        keyStored = true;
      } catch {
        // The key lives in this page's memory for its reconnects, and is lost by a reload.
        keyStored = false;
      }
    }
    if (ws.readyState !== WebSocket.OPEN) {
      // It ended while the key was being stored (the token is used up: mode key from now on).
      socket = null;
      lost();
      return;
    }
    const { welcome } = result;
    const step = versionStep(welcome.assetVersion);
    if ((step === 'reload' || step === 'unknown') && !keyStored) {
      socket = null;
      ws.onclose = null;
      ws.close();
      fail(TEXTS.staleUnstored);
      return;
    }
    if (step === 'reload') {
      location.reload();
      return;
    }
    if (step === 'stuck' || step === 'unknown') {
      socket = null;
      ws.onclose = null;
      ws.close();
      fail(step === 'stuck' ? TEXTS.stale : TEXTS.staleUnknown);
      return;
    }
    /** @type {Change} */
    const change =
      last === null
        ? 'first'
        : welcome.bootId !== last.bootId
          ? 'wsl-restarted'
          : welcome.serverId !== last.serverId
            ? 'restarted'
            : 'same';
    last = { bootId: welcome.bootId, serverId: welcome.serverId };
    ws.send(
      JSON.stringify({
        t: 'start',
        assetVersion: options.assetVersion,
        windowId: options.windowId,
        ...options.start(),
      }),
    );
    const since = lostSince;
    lostAt = null;
    lostSince = null;
    open(ws);
    setState('open');
    events.welcome(welcome, change, since);
    if (!keyStored) {
      events.warn(TEXTS.unstored);
    }
  }

  /**
   * S2 12.9, 15.3: a new connection, the server's proof on it, and only then the reload. Against
   * a server that cannot prove itself nothing is reloaded.
   */
  const reload = async () => {
    if (probing || key === null) {
      return;
    }
    if (!keyStored) {
      events.warn(TEXTS.unstored);
      return;
    }
    probing = true;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const result = await handshake(ws, 'key', key);
    probing = false;
    ws.close();
    if (result.ok) {
      location.reload();
    } else if (result.why === 'not-skydeck') {
      events.warn(TEXTS.notSkydeck(port));
    }
  };

  void attempt();

  return {
    /**
     * Sends a message of S2 8.2.3 when the connection is open; `input` goes as messages of at most
     * 64 KiB. False when it is not open (the message is dropped).
     * @param {Record<string, unknown> & { t: string }} message
     * @returns {boolean}
     */
    send(message) {
      const ws = socket;
      if (ws === null || state !== 'open') {
        return false;
      }
      if (message.t === 'input' && typeof message['data'] === 'string') {
        for (const data of splitInput(message['data'], message['binary'] === true)) {
          ws.send(JSON.stringify({ ...message, data }));
        }
        return true;
      }
      ws.send(JSON.stringify(message));
      return true;
    },
    reload,
  };
}
