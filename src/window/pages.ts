/**
 * Every page's connection, from the upgrade to `bye` (S2 8.2.2–8.2.8, 15.1): the checks at the
 * upgrade, the handshake and its proofs, the messages of S2 8.2.3, the terminal streams, the size
 * owner (S2 8.2.6, `size.ts`), several pages (8.2.7) and backpressure (8.2.8). It codes against
 * `TerminalHub` and `ActionHandler` (plan A1) and knows nothing of what a list holds (`listFor`).
 *
 * The upgrade. Node.js hands every request with `Connection: Upgrade` and an `Upgrade` header to
 * the upgrade listener, whatever its path, method or Host, so all three are checked here, in the
 * order of the HTTP handler (task 14): a wrong Host 421, OPTIONS 403, another method than GET 405
 * with `Allow: GET`, a path other than `/ws` (the query ignored) 404, then an Origin other than
 * `http://127.0.0.1:<port>` (for port 80 also `http://127.0.0.1`) 403. Each refusal carries the
 * headers of every answer (`securityHeaders`) and `Cache-Control: no-store`. Once `bye` has run,
 * an upgrade with the right Host is answered 503 (a wrong Host still 421). What Node.js answers
 * before any listener (a request without Host, an unknown method, headers above 16 KiB …) stays
 * Node.js's own (ruled, task 17; S2 8.2.1).
 *
 * The handshake (S2 8.2.2). A proof is checked only through `auth.ts` (ruled, task 11): mode `key`
 * with `keyProofMatches`, mode `launch` with `tokens.check`, never by a comparison of its own; the
 * page's nonce passes `isNonce` before any proof function sees it. Close codes: 4001 for a missing
 * hello (5 s), a bad nonce, or anything else than `hello` and then `start`; 4426 for another
 * protocol; 4003 when no key or token matches; 4004 for a used token presented again (whatever
 * recording the alarm gave; its failure is logged by kind); 1011 when the secret cannot be read.
 * After `start`, a message that is not valid (or binary) closes with 1008.
 *
 * Streams (S2 8.2.4, ruling-hub-attach): a page's `snap` goes out from its sink's `snapshot`, the
 * hub's first call on it; what follows (a terminal's exit or notice of the state it was already
 * in, then every later record) is forwarded as it comes.
 *
 * Logs carry fixed text and the validators' kinds, never what a page sent and never a key.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Platform } from '../platform/types.ts';
import type { Store } from '../store/store.ts';
import { hostOk, securityHeaders } from './assets.ts';
import {
  ensureSecret,
  failureKind,
  isNonce,
  keyProofMatches,
  serverProof,
  wrapSecret,
} from './auth.ts';
import type { Tokens } from './auth.ts';
import type { ActionHandler, PageInfo, StreamSink, TerminalHub } from './hub.ts';
import { encodeOutputFrame, parsePageMessage } from './protocol.ts';
import type {
  ActMessage,
  InputMessage,
  ListMessage,
  NoticeMessage,
  PageMessage,
  ResultMessage,
  ServerMessage,
  ThemePayload,
  ViewMessage,
  WelcomeMessage,
} from './protocol.ts';
import { sizeAfter } from './size.ts';
import type { SizeState } from './size.ts';
import { acceptWebSocket } from './websocket.ts';
import type { WebSocketConnection } from './websocket.ts';

export interface PageState {
  windowId: string;
  focused: boolean;
  /** Orders the pages by when they last reported focus: the highest had it last (0: never). */
  focusedAt: number;
  area: { cols: number; rows: number } | null;
  view: ViewMessage;
  attached: ReadonlySet<string>;
}

export interface PagesDeps {
  /** Its clock times the hello and the lists; its random bytes make nonces and IVs. */
  platform: Platform;
  /** The bound port, read when an upgrade comes (known only after listenHttp resolves). */
  port: () => number;
  store: Store;
  tokens: Tokens;
  hub: TerminalHub;
  actions: ActionHandler;
  welcome(): Omit<WelcomeMessage, 't' | 'proof' | 'key'>;
  /** The page's list, built when its view changes and when pushList runs; pages then sets each
   *  terminal's `ownsSize` from its own size state, whatever `listFor` put there. */
  listFor(page: PageState): ListMessage;
  log: (line: string) => void;
}

export interface Pages {
  /** Host and Origin checks (403), then the WebSocket and the handshake. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  count(): number;
  /** The page that had focus last (S2 8.2.6 first size, S2 13 later). */
  lastFocused(): PageState | null;
  /** Sends `list` to every page whose list differs from the last one it got, at most once a second each. */
  pushList(): void;
  notice(kind: NoticeMessage['kind'], text: string): void;
  /** `bye` to every page that got `welcome`, then every connection closed with 1001; resolves once
   *  every socket has closed (a 'close' listener on the raw socket, ruled; at most CLOSE_WAIT_MS).
   *  From then on an upgrade with the right Host is answered 503 (ruled). */
  bye(reason: string): Promise<void>;
}

const PROTOCOL = 1;
/** S2 8.2.2 step 3: the page's hello comes within 5 seconds. */
const HELLO_MS = 5_000;
/** S2 8.2.8: above this many queued bytes a page gets no output until its socket has drained. */
const BEHIND_BYTES = 1024 * 1024;
/** S2 8.2.3: `list` at most once a second per page. */
const LIST_MS = 1_000;

const GOING_AWAY = 1001;
const POLICY = 1008;
const INTERNAL = 1011;
const NO_HELLO = 4001;
const NOT_VALID = 4003;
const REUSED = 4004;
const OTHER_PROTOCOL = 4426;

const INPUT_FULL = 'the program is not reading its input';
const NO_VIEW: ViewMessage = {
  t: 'view',
  filter: '',
  unfolded: [],
  showDone: false,
  selected: null,
};
const NO_SIZE: SizeState = { owner: null, proposals: new Map() };
const REASONS: Readonly<Record<number, string>> = {
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  421: 'Misdirected Request',
  503: 'Service Unavailable',
};

/** One stream of one terminal to one page (S2 8.2.4), from its attach until it is detached. */
interface Attachment {
  readonly term: string;
  /** The channel of its output frames, new for every attach. */
  readonly channel: number;
  detach: () => void;
  /** False once detached: what the hub still gives its sink is dropped. */
  live: boolean;
}

/** A connection from its upgrade; a page (PageState) once it has sent `start`. */
interface Connection extends PageState {
  /** Tells pages apart for the size rule (window ids come from the page). */
  readonly id: string;
  readonly ws: WebSocketConnection;
  readonly origin: string;
  /** The server's nonce of this connection (sN). */
  readonly nonce: string;
  phase: 'hello' | 'start' | 'open' | 'closed';
  /** Resolves when the socket has closed (for bye). */
  readonly closed: Promise<void>;
  stopHelloTimer: (() => void) | null;
  theme: ThemePayload | null;
  readonly attachments: Map<string, Attachment>;
  channels: number;
  /** S2 8.2.8: more than BEHIND_BYTES were queued; no output until the socket drained. */
  behind: boolean;
  /** Lists are sent only after the page's first view. */
  hasView: boolean;
  /** The last list sent, without its time; null before the first. */
  lastList: string | null;
  /** Ends the second after a list was sent; null when none runs. */
  stopListTimer: (() => void) | null;
  /** A pushList came within that second. */
  listDirty: boolean;
}

/** S2 8.2.2 step 1: exactly `http://127.0.0.1:<port>`; for port 80 also `http://127.0.0.1`. */
function originOk(origin: string | undefined, port: number): origin is string {
  return origin === `http://127.0.0.1:${port}` || (port === 80 && origin === 'http://127.0.0.1');
}

/** The refusal an upgrade request gets, or null when it may become a WebSocket. */
function refusalOf(req: IncomingMessage, port: number, stopping: boolean): number | null {
  if (!hostOk(req.headers.host, port)) return 421;
  if (stopping) return 503;
  if (req.method === 'OPTIONS') return 403;
  if (req.method !== 'GET') return 405;
  const target = req.url ?? '';
  const query = target.indexOf('?');
  if ((query === -1 ? target : target.slice(0, query)) !== '/ws') return 404;
  if (!originOk(req.headers.origin, port)) return 403;
  return null;
}

/** An answer on the raw socket, then the socket is closed. */
function refuse(socket: Duplex, port: number, status: number): void {
  const reason = REASONS[status] ?? 'Error';
  const body = `${reason.toLowerCase()}\n`;
  const headers: Record<string, string> = {
    ...securityHeaders(port),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    Connection: 'close',
    ...(status === 405 ? { Allow: 'GET' } : {}),
  };
  const head = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${head}\r\n${body}`, () => {
    socket.destroy();
  });
}

export function createPages(deps: PagesDeps): Pages {
  const { platform, hub, log } = deps;
  const { clock } = platform;
  /** Every connection whose socket has not closed yet. */
  const connections = new Set<Connection>();
  /** The pages: connections that sent `start` and are not closed, in that order. */
  const open = new Set<Connection>();
  const sizes = new Map<string, SizeState>();
  let ids = 0;
  /** `at` of the size rule: only goes up. */
  let sizeOrder = 0;
  let focusOrder = 0;
  let stopping = false;

  /** Runs a listener's work: a listener must not throw (task 10), so a failure closes the page. */
  const guard = (conn: Connection, work: () => void): void => {
    try {
      work();
    } catch (error) {
      log(`page: ${failureKind(error)}`);
      try {
        conn.ws.close(INTERNAL);
      } catch {
        conn.ws.destroy();
      }
    }
  };

  const behindCheck = (conn: Connection): void => {
    if (!conn.behind && conn.ws.buffered > BEHIND_BYTES) conn.behind = true;
  };

  const send = (conn: Connection, message: ServerMessage): void => {
    conn.ws.sendText(JSON.stringify(message));
    behindCheck(conn);
  };

  const sendBinary = (conn: Connection, frame: Uint8Array): void => {
    conn.ws.sendBinary(frame);
    behindCheck(conn);
  };

  const closeWith = (conn: Connection, code: number, line: string): void => {
    log(`page: ${line}`);
    conn.ws.close(code);
  };

  // --- the list ---------------------------------------------------------------------------------

  const withOwnership = (list: ListMessage, conn: Connection): ListMessage => ({
    ...list,
    terminals: list.terminals.map((term) => ({
      ...term,
      ownsSize: sizes.get(term.id)?.owner === conn.id,
    })),
  });

  /** Sends the page its list when it changed (always when `force`), and starts its second. */
  const sendList = (conn: Connection, force: boolean): void => {
    let list: ListMessage;
    try {
      list = withOwnership(deps.listFor(conn), conn);
    } catch (error) {
      log(`page: the list cannot be built: ${failureKind(error)}`);
      return;
    }
    const key = JSON.stringify({ ...list, nowNs: '' });
    if (!force && key === conn.lastList) return;
    send(conn, list);
    conn.lastList = key;
    conn.listDirty = false;
    conn.stopListTimer?.();
    conn.stopListTimer = clock.after(LIST_MS, () => {
      guard(conn, () => {
        conn.stopListTimer = null;
        if (conn.listDirty && conn.phase === 'open') sendList(conn, false);
      });
    });
  };

  const pushList = (): void => {
    for (const conn of open) {
      if (!conn.hasView) continue;
      guard(conn, () => {
        if (conn.stopListTimer !== null) conn.listDirty = true;
        else sendList(conn, false);
      });
    }
  };

  // --- size (S2 8.2.6) --------------------------------------------------------------------------

  const sizeEvent = (
    conn: Connection,
    kind: 'attach' | 'resize' | 'input' | 'detach',
    term: string,
    cols?: number,
    rows?: number,
  ): void => {
    const before = sizes.get(term) ?? NO_SIZE;
    const { state, apply } = sizeAfter(before, {
      kind,
      page: conn.id,
      cols,
      rows,
      at: ++sizeOrder,
    });
    if (state.proposals.size === 0) sizes.delete(term);
    else sizes.set(term, state);
    if (apply !== null) hub.resize(term, apply.cols, apply.rows);
    if (state.owner !== before.owner) pushList(); // the lists' ownsSize changed
  };

  // --- streams (S2 8.2.4) -----------------------------------------------------------------------

  const sinkFor = (conn: Connection, attachment: Attachment): StreamSink => {
    const { term } = attachment;
    // While the page is behind (S2 8.2.8) its snap, output, sizes and exit are dropped: once its
    // socket has drained it is attached again, and that fresh snap (and exit) holds them.
    return {
      snapshot(cols, rows, data) {
        if (!attachment.live || conn.behind) return;
        guard(conn, () =>
          send(conn, { t: 'snap', term, ch: attachment.channel, cols, rows, data }),
        );
      },
      output(bytes) {
        if (!attachment.live || conn.behind) return;
        guard(conn, () => sendBinary(conn, encodeOutputFrame(attachment.channel, bytes)));
      },
      size(cols, rows) {
        if (!attachment.live || conn.behind) return;
        guard(conn, () =>
          send(conn, { t: 'size', term, cols, rows, owner: sizes.get(term)?.owner === conn.id }),
        );
      },
      exit(exit, lost) {
        if (!attachment.live || conn.behind) return;
        guard(conn, () =>
          send(conn, {
            t: 'exit',
            term,
            code: exit.code,
            signal: exit.signal,
            atNs: exit.atNs,
            lost,
            notStarted: exit.notStarted,
          }),
        );
      },
      notice(kind, text) {
        if (!attachment.live) return;
        guard(conn, () => send(conn, { t: 'notice', kind, term, text }));
      },
    };
  };

  /**
   * Attaches the page to the terminal; its snap goes out from the sink's `snapshot`, the hub's
   * first call on it. null when the hub does not know the terminal.
   */
  const openStream = (conn: Connection, term: string): Attachment | null => {
    const attachment: Attachment = { term, channel: ++conn.channels, detach: () => {}, live: true };
    const got = hub.attach(term, sinkFor(conn, attachment));
    if (got === null) {
      attachment.live = false;
      return null;
    }
    attachment.detach = () => {
      got.detach();
    };
    conn.attachments.set(term, attachment);
    return attachment;
  };

  const endStream = (attachment: Attachment): void => {
    attachment.live = false;
    attachment.detach();
  };

  const onAttach = (conn: Connection, term: string, cols: number, rows: number): void => {
    const previous = conn.attachments.get(term);
    if (previous !== undefined) {
      conn.attachments.delete(term);
      endStream(previous);
    }
    if (openStream(conn, term) === null) {
      if (previous !== undefined) sizeEvent(conn, 'detach', term);
      return;
    }
    sizeEvent(conn, 'attach', term, cols, rows);
  };

  const onDetach = (conn: Connection, term: string): void => {
    const attachment = conn.attachments.get(term);
    if (attachment === undefined) return;
    conn.attachments.delete(term);
    endStream(attachment);
    sizeEvent(conn, 'detach', term);
  };

  /** S2 8.2.8: the socket drained; a fresh snap (a new attach, a new channel) for each terminal. */
  const caughtUp = (conn: Connection): void => {
    if (!conn.behind || conn.phase !== 'open') return;
    conn.behind = false;
    for (const attachment of [...conn.attachments.values()]) {
      conn.attachments.delete(attachment.term);
      endStream(attachment);
      if (openStream(conn, attachment.term) === null) sizeEvent(conn, 'detach', attachment.term);
    }
  };

  const onInput = (conn: Connection, input: InputMessage): void => {
    const bytes = Buffer.from(input.data, input.binary === true ? 'latin1' : 'utf8');
    if (hub.input(input.term, bytes) === 'full') {
      send(conn, { t: 'notice', kind: 'input-full', term: input.term, text: INPUT_FULL });
    }
    sizeEvent(conn, 'input', input.term);
  };

  const onAct = (conn: Connection, action: ActMessage): void => {
    const page: PageInfo = { windowId: conn.windowId, focused: conn.focused, area: conn.area };
    let answer: Promise<ResultMessage>;
    try {
      answer = deps.actions.act(page, action);
    } catch (error) {
      answer = Promise.reject(error instanceof Error ? error : new Error('not an Error'));
    }
    answer.then(
      (result) => {
        guard(conn, () => send(conn, { ...result, t: 'result', id: action.id }));
      },
      (error: unknown) => {
        log(`page: the action ${action.kind} failed: ${failureKind(error)}`);
        guard(conn, () =>
          send(conn, {
            t: 'result',
            id: action.id,
            ok: false,
            lines: [],
            error: `skydeck could not ${action.kind === 'open-link' ? 'open the link' : `do ${action.kind}`}`,
            sessionId: null,
          }),
        );
      },
    );
  };

  // --- the handshake (S2 8.2.2) -----------------------------------------------------------------

  const welcome = (conn: Connection, proof: string, key: string | undefined): void => {
    const fields = deps.welcome();
    const message: WelcomeMessage = {
      t: 'welcome',
      proof,
      ...(key === undefined ? {} : { key }),
      protocol: fields.protocol,
      assetVersion: fields.assetVersion,
      serverId: fields.serverId,
      bootId: fields.bootId,
      version: fields.version,
      keepAlive: fields.keepAlive,
      nowNs: fields.nowNs,
    };
    conn.phase = 'start';
    send(conn, message);
  };

  const onHello = (conn: Connection, parsed: Parsed): void => {
    conn.stopHelloTimer?.();
    conn.stopHelloTimer = null;
    if (!parsed.ok) {
      closeWith(conn, NO_HELLO, `hello refused: ${parsed.kind}`);
      return;
    }
    const hello = parsed.value;
    if (hello.t !== 'hello') {
      closeWith(conn, NO_HELLO, `hello refused: ${hello.t} before hello`);
      return;
    }
    if (hello.protocol !== PROTOCOL) {
      closeWith(conn, OTHER_PROTOCOL, 'hello refused: another protocol');
      return;
    }
    const sN = conn.nonce;
    const cN = hello.nonce;
    if (!isNonce(cN)) {
      closeWith(conn, NO_HELLO, 'hello refused: the nonce is not 32 bytes of base64url');
      return;
    }
    // Read before a token is looked at: a store that fails uses up no token.
    let secret: Uint8Array;
    try {
      secret = ensureSecret(deps.store, platform.randomBytes);
    } catch (error) {
      closeWith(conn, INTERNAL, `the secret cannot be read: ${failureKind(error)}`);
      return;
    }
    if (hello.mode === 'key') {
      if (!keyProofMatches(secret, hello.proof, sN, cN, conn.origin)) {
        closeWith(conn, NOT_VALID, 'hello refused: the key does not match');
        return;
      }
      welcome(conn, serverProof(secret, 'key', sN, cN, conn.origin), undefined);
      return;
    }
    const verdict = deps.tokens.check(hello.proof, sN, cN, conn.origin);
    if (verdict.kind === 'reused') {
      if (verdict.alarmFailure !== null) {
        log(`page: the alarm could not be recorded: ${verdict.alarmFailure}`);
      }
      closeWith(conn, REUSED, 'hello refused: a used launch token was presented again');
      return;
    }
    if (verdict.kind === 'none') {
      closeWith(conn, NOT_VALID, 'hello refused: no launch token matches');
      return;
    }
    const key = wrapSecret(secret, verdict.token, sN, cN, platform.randomBytes(12));
    welcome(conn, serverProof(verdict.token, 'launch', sN, cN, conn.origin), key);
  };

  const onStart = (conn: Connection, parsed: Parsed): void => {
    if (!parsed.ok) {
      closeWith(conn, NO_HELLO, `start refused: ${parsed.kind}`);
      return;
    }
    const start = parsed.value;
    if (start.t !== 'start') {
      closeWith(conn, NO_HELLO, `start refused: ${start.t} before start`);
      return;
    }
    conn.windowId = start.windowId;
    conn.focused = start.focused;
    conn.theme = { fg: start.theme.fg, bg: start.theme.bg };
    conn.phase = 'open';
    open.add(conn);
    if (start.focused) {
      conn.focusedAt = ++focusOrder;
      hub.setTheme(conn.theme);
    }
  };

  const onMessage = (conn: Connection, parsed: Parsed): void => {
    if (!parsed.ok) {
      closeWith(conn, POLICY, `message refused: ${parsed.kind}`);
      return;
    }
    const message = parsed.value;
    switch (message.t) {
      case 'hello':
      case 'start':
        closeWith(conn, POLICY, `message refused: a second ${message.t}`);
        return;
      case 'ping': {
        const { bootId, serverId } = deps.welcome();
        send(conn, { t: 'pong', n: message.n, bootId, serverId });
        return;
      }
      case 'view':
        conn.view = message;
        conn.hasView = true;
        sendList(conn, true);
        return;
      case 'focus':
        conn.focused = message.focused;
        conn.area = { cols: message.area.cols, rows: message.area.rows };
        if (message.focused) {
          conn.focusedAt = ++focusOrder;
          if (conn.theme !== null) hub.setTheme(conn.theme);
        }
        return;
      case 'attach':
        onAttach(conn, message.term, message.cols, message.rows);
        return;
      case 'detach':
        onDetach(conn, message.term);
        return;
      case 'input':
        onInput(conn, message);
        return;
      case 'resize':
        sizeEvent(conn, 'resize', message.term, message.cols, message.rows);
        return;
      case 'act':
        onAct(conn, message);
        return;
    }
  };

  /** The socket closed or the connection ended: every stream ends, the page gives up its sizes. */
  const gone = (conn: Connection): void => {
    if (conn.phase === 'closed') return;
    conn.phase = 'closed';
    conn.stopHelloTimer?.();
    conn.stopHelloTimer = null;
    conn.stopListTimer?.();
    conn.stopListTimer = null;
    open.delete(conn);
    for (const attachment of [...conn.attachments.values()]) {
      conn.attachments.delete(attachment.term);
      endStream(attachment);
      sizeEvent(conn, 'detach', attachment.term);
    }
  };

  const accept = (ws: WebSocketConnection, origin: string, closed: Promise<void>): void => {
    const attachments = new Map<string, Attachment>();
    const conn: Connection = {
      id: String(++ids),
      ws,
      origin,
      nonce: Buffer.from(platform.randomBytes(32)).toString('base64url'),
      phase: 'hello',
      closed,
      stopHelloTimer: null,
      windowId: '',
      focused: false,
      focusedAt: 0,
      area: null,
      view: NO_VIEW,
      get attached(): ReadonlySet<string> {
        return new Set(attachments.keys());
      },
      theme: null,
      attachments,
      channels: 0,
      behind: false,
      hasView: false,
      lastList: null,
      stopListTimer: null,
      listDirty: false,
    };
    connections.add(conn);
    void closed.then(() => {
      connections.delete(conn);
    });
    ws.onText((text) => {
      guard(conn, () => {
        const parsed = parsePageMessage(text);
        if (conn.phase === 'hello') onHello(conn, parsed);
        else if (conn.phase === 'start') onStart(conn, parsed);
        else if (conn.phase === 'open') onMessage(conn, parsed);
      });
    });
    ws.onBinary(() => {
      guard(conn, () => {
        if (conn.phase === 'open') closeWith(conn, POLICY, 'message refused: binary');
        else if (conn.phase !== 'closed') closeWith(conn, NO_HELLO, 'hello refused: binary');
      });
    });
    ws.onDrain(() => {
      guard(conn, () => caughtUp(conn));
    });
    ws.onClose(() => {
      guard(conn, () => gone(conn));
    });
    guard(conn, () => {
      send(conn, { t: 'challenge', protocol: PROTOCOL, nonce: conn.nonce });
      conn.stopHelloTimer = clock.after(HELLO_MS, () => {
        guard(conn, () => {
          conn.stopHelloTimer = null;
          if (conn.phase === 'hello') closeWith(conn, NO_HELLO, 'no hello within 5 seconds');
        });
      });
    });
  };

  return {
    upgrade(req, socket, head) {
      // node:http's 'upgrade' listener: a throw here would end the server.
      try {
        const port = deps.port();
        const refusal = refusalOf(req, port, stopping);
        if (refusal !== null) {
          refuse(socket, port, refusal);
          return;
        }
        // For bye: resolves when this socket has closed. A listener only (ruled): every write and
        // every close goes through the WebSocket connection.
        const closed = socket.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              socket.once('close', () => resolve());
            });
        const ws = acceptWebSocket(req, socket, head, clock);
        if (ws !== null) accept(ws, req.headers.origin as string, closed);
      } catch (error) {
        log(`page: the upgrade failed: ${failureKind(error)}`);
        socket.destroy();
      }
    },
    count: () => open.size,
    lastFocused() {
      let last: Connection | null = null;
      for (const conn of open) {
        if (last === null || conn.focusedAt >= last.focusedAt) last = conn;
      }
      return last;
    },
    pushList,
    notice(kind, text) {
      for (const conn of open) {
        guard(conn, () => send(conn, { t: 'notice', kind, term: null, text }));
      }
    },
    async bye(reason) {
      stopping = true;
      const all = [...connections];
      for (const conn of all) {
        guard(conn, () => {
          if (conn.phase === 'start' || conn.phase === 'open') send(conn, { t: 'bye', reason });
          conn.ws.close(GOING_AWAY);
        });
      }
      await Promise.all(all.map((conn) => conn.closed));
    },
  };
}

type Parsed = { ok: true; value: PageMessage } | { ok: false; kind: string };
