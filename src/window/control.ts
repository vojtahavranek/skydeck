// server.sock (S2 8.3, stage A): the requests of the command line. The socket is mode 0o600 in a
// directory of mode 0o700 (S2 15.1), so only the user's own processes reach it and no request
// carries a secret. No request carries a program or an argument list to run.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { failureKind } from './auth.ts';
import type { Tokens } from './auth.ts';
import { parseControlRequest } from './protocol.ts';
import type {
  ControlRequest,
  PingAnswer,
  StatusAnswer,
  TokenAnswer,
  TokenState,
} from './protocol.ts';

/** A request body above this many bytes is refused with 413, and not read on. */
const BODY_LIMIT = 64 * 1024;

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
}

interface Answer {
  status: number;
  value: unknown;
}

/**
 * The request handler of server.sock. Bodies are JSON with fixed fields (parseControlRequest):
 * a kind that starts with `route` is 404 (stage C's `/resume`, `/new`, `/restore` included), a
 * bad body 400, a body over 64 KiB 413, a dependency that throws 500. A refusal answers
 * `{ error: <kind> }` and is logged by its kind, never by the request's text (S2 5.2); a failure
 * by the error's name and, when it has one, its code (failureKind), never its message.
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

  const answerTo = (request: ControlRequest, res: ServerResponse): Answer => {
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
    const parsed = parseControlRequest(req.method ?? '', req.url ?? '', text);
    if (!parsed.ok) {
      send(res, refusal(parsed.kind.startsWith('route') ? 404 : 400, parsed.kind));
      return;
    }
    let answer: Answer;
    let body: Buffer;
    try {
      answer = answerTo(parsed.value, res);
      body = Buffer.from(JSON.stringify(answer.value), 'utf8');
    } catch (error) {
      deps.log(`server.sock: ${parsed.value.route} failed (${failureKind(error)})`);
      send(res, { status: 500, value: { error: 'failed' } });
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
