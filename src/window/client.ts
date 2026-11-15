// The command line's side of server.sock (S2 8.3): `skydeck window`, `doctor` and `uninstall` ask
// the window's server through this client, and so do `resume`, `new` and `restore` with the window
// (stage C's routes, S2 11.4). Every answer is checked against its type before a command sees it:
// the server at the socket may be of another build.
import { isSessionId } from '../claude/session-id.ts';
import { SkydeckError } from '../platform/errors.ts';
import { MAX_TIMER_MS } from '../platform/time.ts';
import type { Clock, Net } from '../platform/types.ts';
import { isNonce } from './auth.ts';
import type {
  LaunchAnswer,
  NewRequest,
  PingAnswer,
  RestoreOutcomeLine,
  RestoreRequest,
  StatusAnswer,
  TokenAnswer,
  TokenState,
} from './protocol.ts';

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
   * `signal` ends the request when it fires (Net.requestUnix): an abort is 'timeout', the server
   * not having answered in the time the caller gave it.
   */
  ping(timeoutMs?: number, signal?: AbortSignal): Promise<PingAnswer | 'refused' | 'timeout'>;
  /** The others wait 5 s and reject with a SkydeckError that says what went wrong. */
  status(): Promise<StatusAnswer>;
  /** RangeError, and nothing sent, for seconds other than 30 and 600. */
  token(seconds: 30 | 600): Promise<TokenAnswer>;
  /** RangeError, and nothing sent, for an id that is not 32 lower-case hex characters. */
  tokenState(id: string): Promise<TokenState>;
  /** Resolves also when the server did not know the token (`{ ok: false }`): nothing to give up. */
  dropToken(id: string): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * `POST /resume` (plan C2, C4, C11): waits `answerMs` (30 s by default) in all; a 503 `starting`
   * is asked again every 500 ms within it. 'unknown-route' for a 404 whose kind starts with
   * `route` (a server of a build before stage C). Rejects with a SkydeckError whose message is plan
   * 2.5's line: no answer in time (the server may have started the session), 503 `stopping`, a 400
   * or 413 (the refused request; a body over the server's 64 KiB is refused so before it is sent),
   * a 500 or a socket that fails after the request was sent (it may have started the session too),
   * the server still starting when the time is over (it started nothing), an answer that cannot be
   * read. A client made without a clock rejects with a TypeError, and an `answerMs` no timer can
   * wait with a RangeError, before anything is sent (ruled, task 76).
   */
  resume(sessionId: string, answerMs?: number): Promise<LaunchAnswer | 'unknown-route'>;
  /** `POST /new` with the request's four fields, as `resume`. */
  newSession(request: NewRequest, answerMs?: number): Promise<LaunchAnswer | 'unknown-route'>;
  /**
   * `POST /restore` (plan C5): each `{ line }` of the stream to `onLine` as it arrives (as the
   * server wrote it: the caller sanitises it); resolves with the outcome. A 503 `starting` is asked
   * again every 500 ms within `answerMs`, as for `resume`. Rejects with S2 11.4's "stopped
   * answering" line when `answerMs` pass without a line, the answer ends without an outcome, or
   * the socket fails after the first line; one that fails after the request was sent and before
   * the first line says that it may have started the restore (ruled, task 76). A line that is
   * neither `{ line }` nor `{ outcome }`, or one after the outcome, makes the answer one that cannot
   * be read, and no such line reaches `onLine` (a refusal's `{ error }` neither). The other refusals
   * as for `resume`.
   */
  restore(
    request: RestoreRequest,
    onLine: (line: string) => void,
    answerMs?: number,
  ): Promise<RestoreOutcomeLine | 'unknown-route'>;
}

const PING_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
/** Stage C's requests (plan C17: the commands' `answerMs`). */
const ANSWER_MS = 30_000;
/** How long a stage C request waits before it asks again a server that is starting (plan C4). */
const STARTING_RETRY_MS = 500;
/** A refusal's body before the status is known: a few lines are kept, the rest is not read. */
const REFUSAL_LINES = 4;
/** The server's limit of a request body (control.ts, S2 8.3): a larger one is not sent. */
const BODY_LIMIT = 64 * 1024;
/** Failures of a request on which nothing reached the server: no socket, refused, its queue full. */
const NOTHING_SENT: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOENT', 'EAGAIN', 'EACCES']);
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

/**
 * A client of server.sock at `sockPath`. `clock` (ruled, task 76): what stage C's requests pause
 * with between two answers of a server that is starting; stage A's requests need none.
 */
export function controlClient(net: Net, sockPath: string, clock?: Clock): ControlClient {
  /** The request's answer read by `read`, or a SkydeckError naming what went wrong. */
  const request = async <T>(ask: Ask, read: Reader<T>): Promise<T> => {
    const what = `${ask.method} ${ask.path}`;
    let answer: { status: number; body: unknown };
    try {
      answer = await net.requestUnix(sockPath, { ...ask, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (error) {
      if (systemCode(error) === 'ETIMEDOUT') {
        throw new SkydeckError(
          `the window's server did not answer ${what} within ${REQUEST_TIMEOUT_MS / 1000} s`,
        );
      }
      throw askFailure(error, sockPath, what);
    }
    return readAnswer(answer, what, read);
  };

  /**
   * The clock and the answer time of a stage C request, and its body within the server's limit;
   * thrown before anything is sent. A body over the limit is the 413 row's line (ruled, task 76):
   * sent, it could fail while the server refuses it and closes, and then read as one that may have
   * acted.
   */
  const launchTimes = (answerMs: number, body: unknown): Clock => {
    if (clock === undefined) {
      throw new TypeError(
        "the window's server is asked to start sessions only by a client made with a clock",
      );
    }
    if (!Number.isSafeInteger(answerMs) || answerMs < 0 || answerMs > MAX_TIMER_MS) {
      throw new RangeError(`not a whole number of milliseconds a timer can wait: ${answerMs}`);
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > BODY_LIMIT) {
      throw new SkydeckError(refusedRequest('body: too large'));
    }
    return clock;
  };

  /** POST /resume and POST /new: the answer, read as a LaunchAnswer. */
  const launch = async (
    path: '/resume' | '/new',
    body: Record<string, unknown>,
    answerMs: number,
  ): Promise<LaunchAnswer | 'unknown-route'> => {
    const what = `POST ${path}`;
    const answer = await askedWhileStarting(launchTimes(answerMs, body), answerMs, what, sockPath, {
      send: (signal) =>
        net.requestUnix(sockPath, { method: 'POST', path, body, timeoutMs: answerMs, signal }),
      silence: () => new SkydeckError(noAnswer(answerMs)),
      cut: (code) => new SkydeckError(`${cannotBeAsked(sockPath, code)}; ${MAY_HAVE_STARTED}`),
    });
    if (answer.status === 200) {
      const value = readLaunch(answer.body);
      if (value === null) throw unreadable(what);
      return value;
    }
    return refusedLaunch(answer, what, MAY_HAVE_STARTED);
  };

  return {
    async ping(timeoutMs = PING_TIMEOUT_MS, signal) {
      let answer: { status: number; body: unknown };
      try {
        answer = await net.requestUnix(sockPath, {
          method: 'GET',
          path: '/ping',
          timeoutMs,
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return 'timeout';
        }
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
    resume(sessionId, answerMs = ANSWER_MS) {
      return launch('/resume', { sessionId }, answerMs);
    },
    newSession({ dir, label, group, flags }, answerMs = ANSWER_MS) {
      return launch('/new', { dir, label, group, flags }, answerMs);
    },
    async restore({ sessionIds, all }, onLine, answerMs = ANSWER_MS) {
      const what = 'POST /restore';
      const body = { sessionIds, all };
      const answer = await askedWhileStarting(
        launchTimes(answerMs, body),
        answerMs,
        what,
        sockPath,
        {
          send: (signal, begun) =>
            restoreStream(net, sockPath, body, answerMs, signal, begun, onLine),
          silence: () => new SkydeckError(STOPPED_ANSWERING),
          // Before its first line (after it, restoreStream says that the server stopped answering).
          cut: (code) =>
            new SkydeckError(
              `${cannotBeAsked(sockPath, code)}; it may have started the restore: run skydeck to see what started`,
            ),
        },
      );
      if (answer.status === 200) {
        if (answer.stream === 'unreadable') throw unreadable(what);
        if (answer.stream === null) throw new SkydeckError(STOPPED_ANSWERING);
        return answer.stream;
      }
      return refusedLaunch(answer, what, 'run skydeck to see what started');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stage C's requests (plan C2–C5, C11; the lines of plan 2.5)

const MAY_HAVE_STARTED = 'it may have started the session: run skydeck to see whether it runs';
const STOPPED_ANSWERING = "the window's server stopped answering; run skydeck to see what started";

/** `ms` in seconds as the lines say it: 30, 0.3, 1.2. */
function secondsOf(ms: number): string {
  return String(ms / 1000);
}

function noAnswer(answerMs: number): string {
  return `the window's server did not answer within ${secondsOf(answerMs)} s; ${MAY_HAVE_STARTED}`;
}

function cannotBeAsked(sockPath: string, code: string): string {
  return `the window's server cannot be asked on ${sockPath} (${code})`;
}

/** Plan 2.5's line for a body the server refuses (400, 413). */
function refusedRequest(kind: string): string {
  return `the window's server refused the request (${kind}); use --here`;
}

/** What a stage C request's answer is read from: its status, and its body (null when none). */
interface Asked {
  status: number;
  body: unknown;
}

/**
 * Plan C4: `send`s the request, and again STARTING_RETRY_MS after each 503 `starting`, within
 * `answerMs` in all — measured on `clock` from the first send, until `begun` says that an answer
 * is streaming (a restore runs as long as its lines keep coming). A request that gets no answer
 * by then is `silence()` (it may have acted); a server that still answers `starting` when the time
 * is over started nothing. A failure of the socket after the request may have reached the server
 * and before its answer is complete (a reset, a broken pipe) is `cut(code)`: it may have acted
 * (ruled, task 76). One on which nothing was sent (no socket, refused, a full queue) is a
 * SkydeckError as for stage A's requests: nothing started.
 */
async function askedWhileStarting<T extends Asked>(
  clock: Clock,
  answerMs: number,
  what: string,
  sockPath: string,
  ask: {
    send(signal: AbortSignal, begun: () => void): Promise<T>;
    silence(): SkydeckError;
    cut(code: string): SkydeckError;
  },
): Promise<T> {
  const deadline = new AbortController();
  const over = new Promise<void>((resolve) => {
    deadline.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const cancel = clock.after(answerMs, () => deadline.abort());
  try {
    for (;;) {
      let answer: T;
      try {
        answer = await ask.send(deadline.signal, cancel);
      } catch (error) {
        if (error instanceof SkydeckError) throw error;
        const code = systemCode(error);
        if (isAbort(error) || code === 'ETIMEDOUT') throw ask.silence();
        if (code !== null && !NOTHING_SENT.has(code)) throw ask.cut(code);
        throw askFailure(error, sockPath, what);
      }
      if (answer.status !== 503 || refusalKind(answer.body) !== 'starting') return answer;
      await Promise.race([clock.sleep(STARTING_RETRY_MS), over]);
      if (deadline.signal.aborted) {
        throw new SkydeckError(
          `the window's server did not finish its start within ${secondsOf(answerMs)} s; it started nothing: run skydeck window again, or use --here`,
        );
      }
    }
  } finally {
    cancel();
  }
}

/**
 * A stage C answer that is not 200: 'unknown-route' for a 404 of a `route` kind; else plan 2.5's
 * line — `afterFailure` ends the one of a 500, which comes after the server may have acted.
 */
function refusedLaunch(answer: Asked, what: string, afterFailure: string): 'unknown-route' {
  const kind = refusalKind(answer.body);
  const detail = kind === null ? String(answer.status) : `${answer.status}: ${kind}`;
  if (answer.status === 404 && kind !== null && kind.startsWith('route')) return 'unknown-route';
  if (answer.status === 400 || answer.status === 413) {
    throw new SkydeckError(refusedRequest(kind ?? String(answer.status)));
  }
  if (answer.status === 503 && kind === 'stopping') {
    throw new SkydeckError("the window's server is stopping; run skydeck window, or use --here");
  }
  if (answer.status === 500) {
    throw new SkydeckError(
      `the window's server failed while it answered the request (${detail}); ${afterFailure}`,
    );
  }
  throw new SkydeckError(`the window's server refused ${what} (${detail})`);
}

/** A restore's answer: the status, a refusal's body, and the stream read from a 200. */
interface RestoreAsked extends Asked {
  /** The outcome; null when none came; 'unreadable' for a line of another shape. */
  stream: RestoreOutcomeLine | null | 'unreadable';
}

/**
 * One `POST /restore`. Its status comes only when the answer has ended (Net.requestUnix), so every
 * line is judged as it comes: a stream line (`{ line }`, `{ outcome }`) begins the stream (`begun`)
 * and its `line` goes to `onLine`; any other line is kept as a refusal's body while no stream line
 * came, and makes the stream unreadable after one (and so does a line after the outcome). A
 * transport failure once the stream has begun is a server that stopped answering.
 */
async function restoreStream(
  net: Net,
  sockPath: string,
  body: RestoreRequest,
  answerMs: number,
  signal: AbortSignal,
  begun: () => void,
  onLine: (line: string) => void,
): Promise<RestoreAsked> {
  let streaming = false;
  let bad = false;
  let outcome: RestoreOutcomeLine | null = null;
  const other: string[] = [];
  const take = (text: string): void => {
    const read = readStreamLine(text);
    if (read === null || outcome !== null) {
      if (streaming) bad = true;
      else if (other.length < REFUSAL_LINES) other.push(text);
      return;
    }
    if (!streaming) {
      streaming = true;
      begun();
      if (other.length > 0) bad = true; // a refusal's body never comes with stream lines
    }
    if (bad) return;
    if ('outcome' in read) outcome = read.outcome;
    else onLine(read.line);
  };
  let answer: { status: number; body: unknown };
  try {
    answer = await net.requestUnix(sockPath, {
      method: 'POST',
      path: '/restore',
      body,
      timeoutMs: answerMs,
      onLine: take,
      signal,
    });
  } catch (error) {
    if (streaming && systemCode(error) !== null) throw new SkydeckError(STOPPED_ANSWERING);
    throw error;
  }
  return {
    status: answer.status,
    body: other.length === 1 ? parsed(other[0] ?? '') : null,
    stream: bad || other.length > 0 ? 'unreadable' : outcome,
  };
}

/** `text` as JSON; null when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

/** A request that failed before an answer: refused or missing → the server does not run; else
 *  transportError. */
function askFailure(error: unknown, sockPath: string, what: string): unknown {
  const code = systemCode(error);
  if (code === 'ECONNREFUSED' || code === 'ENOENT') {
    return new SkydeckError(`the window's server does not run (nothing answers on ${sockPath})`);
  }
  return transportError(error, code, sockPath, what);
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
  const { starting, pages, terminals, python, build, checkout, startedAtNs, envOrigin } = body;
  const { windowExpectedMs } = body;
  if (
    (starting !== undefined && typeof starting !== 'boolean') ||
    // Plan C20: a whole number of ms or null; absent from a server of an older build.
    !(
      windowExpectedMs === undefined ||
      windowExpectedMs === null ||
      isWhole(windowExpectedMs, 0)
    ) ||
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
    starting: starting === true, // absent: a server of an older build, which is done when it answers
    pages,
    terminals: read as StatusTerminal[],
    keepAlive,
    python: { found: python['found'], version: python['version'] },
    build,
    checkout,
    startedAtNs,
    envOrigin: { dir: envOrigin['dir'], atNs: envOrigin['atNs'] },
    // Left out when the server sent none: absent and null both mean that it expects no window.
    ...(windowExpectedMs === undefined ? {} : { windowExpectedMs }),
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

/** Plan C2: a LaunchAnswer — `code` a whole number, `lines` texts, `sessionId` a session id or null. */
const readLaunch: Reader<LaunchAnswer> = (body) => {
  if (!isObject(body)) {
    return null;
  }
  const { code, lines, sessionId } = body;
  if (
    typeof code !== 'number' ||
    !Number.isSafeInteger(code) ||
    !Array.isArray(lines) ||
    !lines.every((line) => typeof line === 'string') ||
    !(sessionId === null || (typeof sessionId === 'string' && isSessionId(sessionId)))
  ) {
    return null;
  }
  return { code, lines: [...(lines as string[])], sessionId };
};

const OUTCOME_CODES: ReadonlySet<unknown> = new Set([0, 1, 5]);

function readOutcome(value: unknown): RestoreOutcomeLine | null {
  if (!isObject(value)) {
    return null;
  }
  const { code, started, timedOut, failed, notStarted } = value;
  if (
    !OUTCOME_CODES.has(code) ||
    !isWhole(started, 0) ||
    !isWhole(timedOut, 0) ||
    !isWhole(failed, 0) ||
    !isWhole(notStarted, 0)
  ) {
    return null;
  }
  return { code: code as 0 | 1 | 5, started, timedOut, failed, notStarted };
}

/** Plan C5: one line of a restore's stream; null for a line of another shape. */
function readStreamLine(text: string): { line: string } | { outcome: RestoreOutcomeLine } | null {
  const value = parsed(text);
  if (!isObject(value) || Object.hasOwn(value, 'line') === Object.hasOwn(value, 'outcome')) {
    return null;
  }
  if (Object.hasOwn(value, 'line')) {
    return typeof value['line'] === 'string' ? { line: value['line'] } : null;
  }
  const outcome = readOutcome(value['outcome']);
  return outcome === null ? null : { outcome };
}
