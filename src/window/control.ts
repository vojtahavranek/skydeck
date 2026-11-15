// server.sock (S2 8.3): the requests of the command line. The socket is mode 0o600 in a directory
// of mode 0o700 (S2 15.1), so only the user's own processes reach it and no request carries a
// secret. No request carries a program or an argument list to run: stage C's `POST /resume`, `/new`
// and `/restore` name a session, or a new session's directory, label, group and flags (plan C3),
// and the server prepares every launch itself (`ControlLaunch`, task 74). An asker keeps its side of
// the connection open until the answer has ended: Node.js's server ends its own side when the asker
// half-closes, so a half-closed `/resume` or `/new` gets no answer (its launch still runs), and a
// half-closed `/restore` is stopped as by an asker that went (C22).
import type { IncomingMessage, ServerResponse } from 'node:http';

import { failureKind } from './auth.ts';
import type { Tokens } from './auth.ts';
import { parseControlRequest } from './protocol.ts';
import type {
  ControlRequest,
  LaunchAnswer,
  NewRequest,
  PingAnswer,
  RestoreRequest,
  RestoreStreamLine,
  StatusAnswer,
  TokenAnswer,
  TokenState,
} from './protocol.ts';

/** A request body above this many bytes is refused with 413, and not read on. */
const BODY_LIMIT = 64 * 1024;
/** Stage C's routes, all `POST` (plan C 2.2). */
const LAUNCH_PATHS: ReadonlySet<string> = new Set(['/resume', '/new', '/restore']);
/** `POST /restore`'s answer: one JSON object per line (plan C5). */
const STREAM_TYPE = 'application/x-ndjson; charset=utf-8';

/** What the server does for stage C's routes (plan C 2.3; task 74 supplies it). */
export interface ControlLaunch {
  resume(sessionId: string): Promise<LaunchAnswer>;
  newSession(request: NewRequest): Promise<LaunchAnswer>;
  /** Calls `write` for each line, the outcome last; the answer ends when it resolves. `closed`
   *  fires when the asker's connection closes before the answer ended (C22) — also after the
   *  outcome line was written while the promise has not settled: the restorer stops a run only
   *  for a close before its outcome (plan C 2.3, `asker`). */
  restore(
    request: RestoreRequest,
    write: (line: RestoreStreamLine) => void,
    closed: AbortSignal,
  ): Promise<void>;
}

type LaunchRequest = Extract<ControlRequest, { route: 'resume' | 'new' | 'restore' }>;

export interface ControlDeps {
  ping(): PingAnswer;
  status(): StatusAnswer;
  tokens: Tokens;
  /**
   * S2 5.5; called once, when the first answer to a `POST /shutdown` has been handed to the
   * socket. What it throws is not caught (the server's uncaught error, S2 5.2); an asynchronous
   * shutdown handles its own failure, since its rejection would be no more than an unhandled one.
   */
  shutdown(): void;
  log: (line: string) => void;
  /** Absent: the stage C routes answer 404 { error: 'route: unknown' } — a server before stage C,
   *  as the command line sees it (the fake serve's default). */
  launch?: ControlLaunch;
  /** C4: 'starting' or 'stopping' while the routes answer 503 { error }; null when they act. */
  launchState?: () => 'starting' | 'stopping' | null;
}

interface Answer {
  status: number;
  value: unknown;
}

/**
 * The request handler of server.sock. Bodies are JSON with fixed fields (parseControlRequest):
 * a kind that starts with `route` is 404, a bad body 400, a body over 64 KiB 413, a dependency
 * that throws 500. A refusal answers `{ error: <kind> }` and is logged by its kind, never by the
 * request's text (S2 5.2); a failure by the error's name and, when it has one, its code
 * (failureKind), never its message.
 *
 * Stage C's routes (plan C2–C5, C22): without `deps.launch` they are 404 `route: unknown` whatever
 * text the body holds, as a server before stage C answers them (413 and `body: not UTF-8` stay as
 * for every route). With it, a body the parser refuses is 400;
 * then, while `launchState()` is not null, 503 `{ error: 'starting' | 'stopping' }` (not logged:
 * a command asks again every 500 ms while the server starts); otherwise `POST /resume` and `/new`
 * answer 200 with what `launch` resolves with, and `POST /restore` answers 200, chunked, with one
 * JSON line per `write`, ended when its promise settles; its `closed` signal fires when the asker's
 * connection closes before then. A launch that rejects (or throws) is 500 `{ error: 'failed' }`
 * and one log line by kind; a restore that rejects after its first line ends the answer without an
 * outcome (the command then says that the server stopped answering).
 *
 * `POST /token` answers the token in base64url and `expiresAtNs` as decimal text; tokens stay in
 * `deps.tokens`, in memory (S2 15.2). `GET /token/<id>` is 404 for an id the tokens do not know.
 * `POST /token/drop` answers `{ ok }`, false for such an id. `POST /shutdown` answers
 * `{ ok: true }`; `deps.shutdown` is called once, when the first such answer has been handed to
 * the socket (or its asker went away), and every other request for it calls nothing. What
 * `deps.shutdown` throws is not caught: the server's uncaught error (S2 5.2) is what then ends it.
 */
export function controlHandler(
  deps: ControlDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  let shutdownAsked = false;
  let shutdownCalled = false;

  const refusal = (status: number, kind: string): Answer => {
    deps.log(`server.sock: refused a request (${kind})`);
    return { status, value: { error: kind } };
  };

  /** A route whose dependency threw or rejected: 500, logged by kind (failureKind). */
  const failed = (route: string, error: unknown, res: ServerResponse): void => {
    deps.log(`server.sock: ${route} failed (${failureKind(error)})`);
    send(res, { status: 500, value: { error: 'failed' } });
  };

  /** POST /restore: the answer begins with the first line, so that a run that fails before any
   *  is still a 500; what is written once the run settled, or after the asker went, goes nowhere. */
  const restoreStream = (
    launch: ControlLaunch,
    request: Extract<LaunchRequest, { route: 'restore' }>,
    res: ServerResponse,
  ): void => {
    const closed = new AbortController();
    let over = false;
    let begun = false;
    const begin = (): void => {
      if (!begun) {
        begun = true;
        res.writeHead(200, { 'Content-Type': STREAM_TYPE });
      }
    };
    res.once('close', () => {
      if (!over) closed.abort();
    });
    const write = (line: RestoreStreamLine): void => {
      if (over || res.destroyed) return;
      const text = `${JSON.stringify(line)}\n`;
      begin();
      res.write(text);
    };
    attempt(() =>
      launch.restore({ sessionIds: request.sessionIds, all: request.all }, write, closed.signal),
    ).then(
      () => {
        over = true;
        begin();
        res.end();
      },
      (error: unknown) => {
        over = true;
        if (!begun) {
          failed('restore', error, res);
          return;
        }
        deps.log(`server.sock: restore failed (${failureKind(error)})`);
        res.end();
      },
    );
  };

  const launchRoute = (
    launch: ControlLaunch,
    request: LaunchRequest,
    res: ServerResponse,
  ): void => {
    let state: 'starting' | 'stopping' | null;
    try {
      state = deps.launchState?.() ?? null;
    } catch (error) {
      failed(request.route, error, res);
      return;
    }
    if (state !== null) {
      send(res, { status: 503, value: { error: state } });
      return;
    }
    if (request.route === 'restore') {
      restoreStream(launch, request, res);
      return;
    }
    attempt(() =>
      request.route === 'resume'
        ? launch.resume(request.sessionId)
        : launch.newSession({
            dir: request.dir,
            label: request.label,
            group: request.group,
            flags: request.flags,
          }),
    ).then(
      (answer) => {
        let body: Buffer;
        try {
          body = Buffer.from(JSON.stringify(answer), 'utf8');
        } catch (error) {
          failed(request.route, error, res);
          return;
        }
        sendBytes(res, 200, body, false);
      },
      (error: unknown) => {
        failed(request.route, error, res);
      },
    );
  };

  const answerTo = (
    request: Exclude<ControlRequest, LaunchRequest>,
    res: ServerResponse,
  ): Answer => {
    switch (request.route) {
      case 'ping':
        return { status: 200, value: deps.ping() };
      case 'status':
        return { status: 200, value: deps.status() };
      case 'token': {
        const minted = deps.tokens.mint(request.seconds);
        const value: TokenAnswer = {
          id: minted.id,
          token: Buffer.from(minted.token).toString('base64url'),
          expiresAtNs: minted.expiresAtNs.toString(),
        };
        return { status: 200, value };
      }
      case 'token-state': {
        const state: TokenState | null = deps.tokens.state(request.id);
        return state === null ? refusal(404, 'token: unknown') : { status: 200, value: { state } };
      }
      case 'token-drop':
        return { status: 200, value: { ok: deps.tokens.drop(request.id) } };
      case 'shutdown':
        if (!shutdownAsked) {
          shutdownAsked = true;
          deps.log('server.sock: shutdown asked for');
        }
        // 'close' follows 'finish', when the answer has been handed to the socket; it also comes
        // when the asker went away first, and the server stops all the same. Every request waits
        // for its own answer, and the first answer out calls: one asker that does not read its
        // answers cannot keep the next one waiting.
        res.once('close', () => {
          if (!shutdownCalled) {
            shutdownCalled = true;
            deps.shutdown();
          }
        });
        return { status: 200, value: { ok: true } };
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse, bytes: Buffer): void => {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      send(res, refusal(400, 'body: not UTF-8'));
      return;
    }
    const method = req.method ?? '';
    const path = req.url ?? '';
    const parsed = parseControlRequest(method, path, text);
    if (!parsed.ok) {
      // Without `launch`, a stage C route is unknown whatever text its body holds (a server before
      // stage C; a body over 64 KiB is 413 and one that is not UTF-8 is 400, as there).
      const kind =
        deps.launch === undefined && method === 'POST' && LAUNCH_PATHS.has(path)
          ? 'route: unknown'
          : parsed.kind;
      send(res, refusal(kind.startsWith('route') ? 404 : 400, kind));
      return;
    }
    const request = parsed.value;
    if (request.route === 'resume' || request.route === 'new' || request.route === 'restore') {
      if (deps.launch === undefined) {
        send(res, refusal(404, 'route: unknown'));
      } else {
        launchRoute(deps.launch, request, res);
      }
      return;
    }
    let answer: Answer;
    let body: Buffer;
    try {
      answer = answerTo(request, res);
      body = Buffer.from(JSON.stringify(answer.value), 'utf8');
    } catch (error) {
      failed(request.route, error, res);
      return;
    }
    sendBytes(res, answer.status, body, false);
  };

  return (req, res) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > BODY_LIMIT) {
      send(res, refusal(413, 'body: too large'), true);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) {
        return;
      }
      size += chunk.byteLength;
      if (size > BODY_LIMIT) {
        // A body sent without Content-Length (chunked) that grows too big.
        refused = true;
        chunks.length = 0;
        send(res, refusal(413, 'body: too large'), true);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!refused) {
        handle(req, res, Buffer.concat(chunks));
      }
    });
  };
}

/** `run`'s promise; a throw is its rejection. */
function attempt<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  });
}

/** `close`: the connection ends after the answer (a body that is not read on). */
function send(res: ServerResponse, answer: Answer, close = false): void {
  sendBytes(res, answer.status, Buffer.from(JSON.stringify(answer.value), 'utf8'), close);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, close: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(body);
}
