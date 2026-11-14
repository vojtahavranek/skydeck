// The command line's side of server.sock (S2 8.3): `skydeck window`, `doctor` and `uninstall` ask
// the window's server through this client. Every answer is checked against its type before a
// command sees it: the server at the socket may be of another build.
import { SkydeckError } from '../platform/errors.ts';
import type { Net } from '../platform/types.ts';
import { isNonce } from './auth.ts';
import type { PingAnswer, StatusAnswer, TokenAnswer, TokenState } from './protocol.ts';

export interface ControlClient {
  /**
   * `GET /ping` (S2 5.1), waiting `timeoutMs` (5 s by default). 'refused' when nothing listens on
   * the socket or it is missing (ECONNREFUSED, ENOENT); 'timeout' when the server does not answer
   * in time, or its queue of connections is full (EAGAIN: it lives, but does not answer now).
   * Rejects with a SkydeckError for any other failure — also while the server is closing (EPIPE,
   * ECONNRESET), which a caller that waits for a server must catch — another status or an answer
   * that cannot be read (one that is not HTTP included), and passes on the RangeError of a time no
   * timer can wait. An answer of another `protocol` cannot be read: whoever adds protocol 2 makes
   * ping accept both, since ping is how S2 5.1 recognises another build to restart it.
   */
  ping(timeoutMs?: number): Promise<PingAnswer | 'refused' | 'timeout'>;
  /** The others wait 5 s and reject with a SkydeckError that says what went wrong. */
  status(): Promise<StatusAnswer>;
  /** RangeError, and nothing sent, for seconds other than 30 and 600. */
  token(seconds: 30 | 600): Promise<TokenAnswer>;
  /** RangeError, and nothing sent, for an id that is not 32 lower-case hex characters. */
  tokenState(id: string): Promise<TokenState>;
  /** Resolves also when the server did not know the token (`{ ok: false }`): nothing to give up. */
  dropToken(id: string): Promise<void>;
  shutdown(): Promise<void>;
}

const PING_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const TOKEN_ID = /^[0-9a-f]{32}$/;
const NS_TEXT = /^(0|[1-9][0-9]*)$/;
const TOKEN_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'used',
  'reused',
  'expired',
  'dropped',
]);

interface Ask {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** The answer read as the type it should have; null when it is not one. */
type Reader<T> = (body: unknown) => T | null;

export function controlClient(net: Net, sockPath: string): ControlClient {
  /** The request's answer read by `read`, or a SkydeckError naming what went wrong. */
  const request = async <T>(ask: Ask, read: Reader<T>): Promise<T> => {
    const what = `${ask.method} ${ask.path}`;
    let answer: { status: number; body: unknown };
    try {
      answer = await net.requestUnix(sockPath, { ...ask, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (error) {
      const code = systemCode(error);
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        throw new SkydeckError(`the window's server does not run (nothing answers on ${sockPath})`);
      }
      if (code === 'ETIMEDOUT') {
        throw new SkydeckError(
          `the window's server did not answer ${what} within ${REQUEST_TIMEOUT_MS / 1000} s`,
        );
      }
      throw transportError(error, code, sockPath, what);
    }
    return readAnswer(answer, what, read);
  };

  return {
    async ping(timeoutMs = PING_TIMEOUT_MS) {
      let answer: { status: number; body: unknown };
      try {
        answer = await net.requestUnix(sockPath, { method: 'GET', path: '/ping', timeoutMs });
      } catch (error) {
        const code = systemCode(error);
        if (code === 'ECONNREFUSED' || code === 'ENOENT') {
          return 'refused';
        }
        if (code === 'ETIMEDOUT' || code === 'EAGAIN') {
          return 'timeout';
        }
        throw transportError(error, code, sockPath, 'GET /ping');
      }
      return readAnswer(answer, 'GET /ping', readPing);
    },
    status() {
      return request({ method: 'GET', path: '/status' }, readStatus);
    },
    async token(seconds) {
      if (seconds !== 30 && seconds !== 600) {
        throw new RangeError(`a launch token lives 30 or 600 seconds, not ${String(seconds)}`);
      }
      return request({ method: 'POST', path: '/token', body: { seconds } }, readToken);
    },
    async tokenState(id) {
      requireTokenId(id);
      return request({ method: 'GET', path: `/token/${id}` }, readTokenState);
    },
    async dropToken(id) {
      requireTokenId(id);
      await request({ method: 'POST', path: '/token/drop', body: { id } }, readDropped);
    },
    async shutdown() {
      await request({ method: 'POST', path: '/shutdown' }, readOk);
    },
  };
}

function requireTokenId(id: string): void {
  if (typeof id !== 'string' || !TOKEN_ID.test(id)) {
    throw new RangeError('a launch token id is 32 lower-case hex characters');
  }
}

/** A system error's code (ECONNREFUSED, ETIMEDOUT …); null for anything else. */
function systemCode(error: unknown): string | null {
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : null;
}

/**
 * What a failed request becomes: an answer Node's HTTP parser refused (`HPE_…`, a peer that does
 * not speak HTTP) cannot be read; a system error is a SkydeckError naming its code; any other
 * error (a RangeError of the caller) passes unchanged.
 */
function transportError(
  error: unknown,
  code: string | null,
  sockPath: string,
  what: string,
): unknown {
  const raw: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof raw === 'string' && raw.startsWith('HPE_')) {
    return unreadable(what);
  }
  return code === null
    ? error
    : new SkydeckError(`the window's server cannot be asked on ${sockPath} (${code})`);
}

function unreadable(what: string): SkydeckError {
  return new SkydeckError(`the window's server gave an answer to ${what} that cannot be read`);
}

function readAnswer<T>(
  answer: { status: number; body: unknown },
  what: string,
  read: Reader<T>,
): T {
  if (answer.status !== 200) {
    const kind = refusalKind(answer.body);
    const detail = kind === null ? String(answer.status) : `${answer.status}: ${kind}`;
    throw new SkydeckError(`the window's server refused ${what} (${detail})`);
  }
  const value = read(answer.body);
  if (value === null) {
    throw unreadable(what);
  }
  return value;
}

/** The `error` of a refusal's `{ error }`, as printable ASCII of at most 200 characters. */
function refusalKind(body: unknown): string | null {
  if (!isObject(body) || typeof body['error'] !== 'string') {
    return null;
  }
  const kind = body['error'].replace(/[^ -~]/g, '').slice(0, 200);
  return kind === '' ? null : kind;
}

// ---------------------------------------------------------------------------------------------
// The answers. Each reader rebuilds the value from the fields it knows: a field that a newer
// server adds is left out.

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isWhole(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function isNsText(value: unknown): value is string {
  return typeof value === 'string' && NS_TEXT.test(value);
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

const readPing: Reader<PingAnswer> = (body) => {
  if (!isObject(body)) {
    return null;
  }
  const { serverId, bootId, build, protocol, pid, port, checkout } = body;
  if (
    !isText(serverId) ||
    !isText(bootId) ||
    !isText(build) ||
    protocol !== 1 ||
    !isWhole(pid, 1) ||
    !isWhole(port, 1) ||
    port > 65535 ||
    !isText(checkout)
  ) {
    return null;
  }
  return { serverId, bootId, build, protocol, pid, port, checkout };
};

type StatusTerminal = StatusAnswer['terminals'][number];

function readTerminal(value: unknown): StatusTerminal | null {
  if (!isObject(value)) {
    return null;
  }
  const { id, slot, state, sessionId, pid } = value;
  if (
    !isText(id) ||
    !(slot === null || isWhole(slot, 1)) ||
    !isText(state) ||
    !(sessionId === null || isText(sessionId)) ||
    !(pid === null || isWhole(pid, 1))
  ) {
    return null;
  }
  return { id, slot, state, sessionId, pid };
}

function readKeepAlive(value: unknown): StatusAnswer['keepAlive'] | null {
  if (!isObject(value)) {
    return null;
  }
  const { mode, state, since, error } = value;
  if (
    (mode !== 'wsl' && mode !== 'off') ||
    (state !== 'running' && state !== 'starting' && state !== 'failed' && state !== 'off') ||
    !(since === null || isNsText(since)) ||
    !isTextOrNull(error)
  ) {
    return null;
  }
  return { mode, state, since, error };
}

const readStatus: Reader<StatusAnswer> = (body) => {
  if (!isObject(body)) {
    return null;
  }
  const { pages, terminals, python, build, checkout, startedAtNs, envOrigin } = body;
  if (
    !isWhole(pages, 0) ||
    !Array.isArray(terminals) ||
    !isObject(python) ||
    typeof python['found'] !== 'boolean' ||
    !isTextOrNull(python['version']) ||
    !isText(build) ||
    !isText(checkout) ||
    !isNsText(startedAtNs) ||
    !isObject(envOrigin) ||
    !isText(envOrigin['dir']) ||
    !isNsText(envOrigin['atNs'])
  ) {
    return null;
  }
  const keepAlive = readKeepAlive(body['keepAlive']);
  const read = terminals.map(readTerminal);
  if (keepAlive === null || read.some((terminal) => terminal === null)) {
    return null;
  }
  return {
    pages,
    terminals: read as StatusTerminal[],
    keepAlive,
    python: { found: python['found'], version: python['version'] },
    build,
    checkout,
    startedAtNs,
    envOrigin: { dir: envOrigin['dir'], atNs: envOrigin['atNs'] },
  };
};

const readToken: Reader<TokenAnswer> = (body) => {
  if (!isObject(body)) {
    return null;
  }
  const { id, token, expiresAtNs } = body;
  if (
    typeof id !== 'string' ||
    !TOKEN_ID.test(id) ||
    typeof token !== 'string' ||
    !isNonce(token) || // a token has the form of a nonce: 32 bytes of canonical base64url
    !isNsText(expiresAtNs)
  ) {
    return null;
  }
  return { id, token, expiresAtNs };
};

const readTokenState: Reader<TokenState> = (body) => {
  if (!isObject(body) || typeof body['state'] !== 'string' || !TOKEN_STATES.has(body['state'])) {
    return null;
  }
  return body['state'] as TokenState;
};

const readDropped: Reader<boolean> = (body) =>
  isObject(body) && typeof body['ok'] === 'boolean' ? body['ok'] : null;

const readOk: Reader<true> = (body) => (isObject(body) && body['ok'] === true ? true : null);
