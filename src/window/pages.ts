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
 * recording the alarm gave; its failure is logged by kind); 1013 when the secret cannot be read
 * because another process keeps the store locked (ruled, task 23), else 1011.
 * After `start`, a message that is not valid (or binary) closes with 1008.
 *
 * Streams (S2 8.2.4, ruling-hub-attach): a page's `snap` goes out from its sink's `snapshot`, the
 * hub's first call on it; what follows (a terminal's exit or notice of the state it was already
 * in, then every later record) is forwarded as it comes.
 *
 * Attention (S2 12.4, 13; plan B 2.7). Each page's focus and selection (its `start`, then each
 * `focus`), its typing into a terminal (an `input` that `isTyping` takes: never binary, never a
 * report a terminal sends by itself) and its end are told to `seen`; nothing is told for a page
 * after its end. `notify` goes to the page that had focus last, and only while no page has it.
 *
 * Backpressure (S2 8.2.8, ruled at review 2): a page is behind once a record or its list finds
 * more than 1 MiB queued after its latest snap; its records are dropped and its list held until
 * the drain, when only the streams that lost something snap again. Above 64 MiB queued the
 * connection is dropped, what is still queued of the latest snap not counted. With 64
 * connections waiting for their hello, a newcomer drops the one that has waited longest.
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
import { isBusy } from './busy.ts';
import type { ActionHandler, PageInfo, StreamSink, TerminalHub } from './hub.ts';
import { encodeOutputFrame, parsePageMessage } from './protocol.ts';
import type {
  ActMessage,
  InputMessage,
  ListMessage,
  NoticeMessage,
  NotifyMessage,
  PageMessage,
  ResultMessage,
  ServerMessage,
  ThemePayload,
  ViewMessage,
  WelcomeMessage,
} from './protocol.ts';
import { isTyping } from './seen.ts';
import type { Seen } from './seen.ts';
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
  /** While it returns true the server is still starting (S2 5.2: its keepers not found yet): an
   *  upgrade with the right Host is answered 503, as after `bye` (ruled, task 23). Default false. */
  starting?: () => boolean;
  /** S2 12.4: told each page's focus and selection, its typing (an `input` for which isTyping is
   *  true: never a focus or mouse report) and its end. */
  seen?: Pick<Seen, 'focus' | 'typed' | 'gone'>;
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
  /** S2 13: while no page has focus, `message` to the page that had focus last; false when it was
   *  not sent (a page has focus, or none is open — none is once `bye` has run: nothing follows a
   *  `bye`). */
  notify(message: NotifyMessage): boolean;
  /** `bye` to every page that got `welcome`, then every connection closed with 1001; resolves once
   *  every socket has closed (a 'close' listener on the raw socket, ruled; at most CLOSE_WAIT_MS).
   *  From then on an upgrade with the right Host is answered 503 (ruled). */
  bye(reason: string): Promise<void>;
}

const PROTOCOL = 1;
/** S2 8.2.2 step 3: the page's hello comes within 5 seconds. */
const HELLO_MS = 5_000;
/** S2 8.2.8: above this many queued bytes (a snap's own not counted) a page gets no output and
 *  no list until its socket has drained. */
const BEHIND_BYTES = 1024 * 1024;
/** S2 8.2.8: above this many queued bytes, what is still queued of the latest snap not counted,
 *  the connection is dropped (ruled). */
const DROP_BYTES = 64 * 1024 * 1024;
/** S2 8.2.1: at most this many connections wait for their hello; a newcomer drops the oldest (ruled). */
const MAX_WAITING_HELLO = 64;
/** S2 8.2.3: `list` at most once a second per page. */
const LIST_MS = 1_000;

const GOING_AWAY = 1001;
const POLICY = 1008;
const INTERNAL = 1011;
const TRY_LATER = 1013;
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
  /** Something of it was dropped while the page was behind: it gets a fresh snap at the drain. */
  lost: boolean;
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
  /** S2 8.2.8: a record or a list found more than BEHIND_BYTES queued; none goes out until the drain. */
  behind: boolean;
  /** Bytes of every frame written to the socket so far, and that count before and after the
   *  latest snap: a snap's own bytes do not count toward BEHIND_BYTES, and what is still queued
   *  of the latest one not toward DROP_BYTES (ruled). */
  sent: number;
  snapStart: number;
  snapEnd: number;
  /** A list was held while behind (S2 8.2.8, ruled): the current one goes out at the drain;
   *  `listForced` when it answered a view (sent even when unchanged). */
  listHeld: boolean;
  listForced: boolean;
  /** Lists are sent only after the page's first view. */
  hasView: boolean;
  /** The last list sent, without its time; null before the first. */
  lastList: string | null;
  /** Ends the second after a list was sent; null when none runs. */
  stopListTimer: (() => void) | null;
  /** A pushList came within that second. */
  listDirty: boolean;
}

/** The bytes a server frame of `payload` bytes takes (RFC 6455 5.2: no mask, one frame). */
function frameBytes(payload: number): number {
  return payload + (payload < 126 ? 2 : payload < 65_536 ? 4 : 10);
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

  /** For work on a page that is gone already: a failure is logged and the next step goes on. */
  const attempt = (work: () => void): void => {
    try {
      work();
    } catch (error) {
      log(`page: ${failureKind(error)}`);
    }
  };

  /**
   * Writes one frame (text or binary) and counts its bytes; `snap` marks where the latest snap
   * starts and ends. Above DROP_BYTES queued, what is still queued of the latest snap not counted
   * (one screen can be that large), the connection is dropped at once (the page reconnects, S2
   * 8.2.5): nothing a page does by not reading can make the server keep more.
   */
  const write = (conn: Connection, frame: string | Uint8Array, snap = false): void => {
    if (snap) conn.snapStart = conn.sent;
    if (typeof frame === 'string') {
      conn.ws.sendText(frame);
      conn.sent += frameBytes(Buffer.byteLength(frame, 'utf8'));
    } else {
      conn.ws.sendBinary(frame);
      conn.sent += frameBytes(frame.length);
    }
    if (snap) conn.snapEnd = conn.sent;
    const buffered = conn.ws.buffered;
    const flushed = conn.sent - buffered;
    const snapQueued = Math.max(0, conn.snapEnd - Math.max(conn.snapStart, flushed));
    if (conn.phase !== 'closed' && buffered - snapQueued > DROP_BYTES) {
      log('page: more than 64 MiB queued; the connection is dropped');
      conn.ws.destroy();
    }
  };

  const send = (conn: Connection, message: ServerMessage): void => {
    write(conn, JSON.stringify(message));
  };

  /** What is queued behind the latest snap: a snap's own bytes do not count (ruled). */
  const queuedAfterSnap = (conn: Connection): number =>
    Math.min(conn.ws.buffered, conn.sent - conn.snapEnd);

  /** Whether the page is behind, once a record or a list finds the queue over the limit. */
  const isBehind = (conn: Connection): boolean => {
    if (!conn.behind && queuedAfterSnap(conn) > BEHIND_BYTES) conn.behind = true;
    return conn.behind;
  };

  /**
   * S2 8.2.8, judged when a record of a stream is about to go out: false while the page is
   * behind, and from the moment a record finds more than BEHIND_BYTES queued; the stream is then
   * marked lost, and only lost streams get a fresh snap at the drain. A snap never makes a page
   * behind by itself, so a large screen does not snap again and again.
   */
  const mayForward = (conn: Connection, attachment: Attachment): boolean => {
    if (!isBehind(conn)) return true;
    attachment.lost = true;
    return false;
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

  /**
   * Sends the page its list when it changed (always when `force`), and starts its second. While
   * the page is behind the list is held, and the current one goes out at the drain (ruled).
   */
  const sendList = (conn: Connection, force: boolean): void => {
    if (isBehind(conn)) {
      conn.listHeld = true;
      conn.listForced ||= force;
      return;
    }
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
    if (stopping) return; // bye closes every page: no size is handed over, no list sent
    if (apply !== null) hub.resize(term, apply.cols, apply.rows);
    if (state.owner !== before.owner) pushList(); // the lists' ownsSize changed
  };

  // --- streams (S2 8.2.4) -----------------------------------------------------------------------

  const sinkFor = (conn: Connection, attachment: Attachment): StreamSink => {
    const { term } = attachment;
    // While the page is behind (S2 8.2.8) a stream's snap, output, sizes and exit are dropped and
    // the stream is marked lost: once the socket has drained it is attached again, and the fresh
    // snap (with what the hub tells after it) holds them.
    return {
      snapshot(cols, rows, data) {
        if (!attachment.live) return;
        if (conn.behind) {
          attachment.lost = true;
          return;
        }
        guard(conn, () =>
          write(
            conn,
            JSON.stringify({ t: 'snap', term, ch: attachment.channel, cols, rows, data }),
            true,
          ),
        );
      },
      output(bytes) {
        if (!attachment.live || !mayForward(conn, attachment)) return;
        guard(conn, () => write(conn, encodeOutputFrame(attachment.channel, bytes)));
      },
      size(cols, rows) {
        if (!attachment.live || !mayForward(conn, attachment)) return;
        guard(conn, () =>
          send(conn, { t: 'size', term, cols, rows, owner: sizes.get(term)?.owner === conn.id }),
        );
      },
      exit(exit, lost) {
        if (!attachment.live || !mayForward(conn, attachment)) return;
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
    const attachment: Attachment = {
      term,
      channel: ++conn.channels,
      detach: () => {},
      live: true,
      lost: false,
    };
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

  /**
   * S2 8.2.8: the socket drained (Node.js's 'drain': nothing queued, so below 64 KiB); a fresh
   * snap (a new attach, a new channel) for each stream that lost something. The others go on.
   */
  const caughtUp = (conn: Connection): void => {
    if (!conn.behind || conn.phase !== 'open') return;
    conn.behind = false;
    for (const attachment of [...conn.attachments.values()]) {
      if (!attachment.lost) continue;
      conn.attachments.delete(attachment.term);
      endStream(attachment);
      if (openStream(conn, attachment.term) === null) sizeEvent(conn, 'detach', attachment.term);
    }
    if (conn.listHeld) {
      const force = conn.listForced;
      conn.listHeld = false;
      conn.listForced = false;
      sendList(conn, force);
    }
  };

  const onInput = (conn: Connection, input: InputMessage): void => {
    const bytes = Buffer.from(input.data, input.binary === true ? 'latin1' : 'utf8');
    if (hub.input(input.term, bytes) === 'full') {
      send(conn, { t: 'notice', kind: 'input-full', term: input.term, text: INPUT_FULL });
    }
    sizeEvent(conn, 'input', input.term);
    // S2 12.4 (B9): typing makes the session the terminal shows seen; a focus or mouse report the
    // terminal sends by itself is no typing (F1).
    if (deps.seen !== undefined && isTyping(input.data, input.binary === true)) {
      const shown = hub.list().find((term) => term.id === input.term)?.sessionId ?? null;
      if (shown !== null) deps.seen.typed(conn, shown);
    }
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
      // Ruled (task 23, review 2): a store another process keeps locked is no wrong proof: 1013
      // (try again later), and the page tries again.
      if (isBusy(error)) {
        closeWith(
          conn,
          TRY_LATER,
          `the secret cannot be read: the database is busy (${failureKind(error)})`,
        );
      } else {
        closeWith(conn, INTERNAL, `the secret cannot be read: ${failureKind(error)}`);
      }
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
    deps.seen?.focus(conn, start.focused, null);
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
        deps.seen?.focus(conn, message.focused, message.selected);
        return;
      case 'theme':
        // Follow-up F13: the page's colours changed while it is open. Kept for its next focus;
        // the hub answers OSC 10 / 11 from them at once while it is the page that had focus last
        // (S2 7.2), also when its window has lost the focus since.
        conn.theme = { fg: message.theme.fg, bg: message.theme.bg };
        if (conn.focusedAt !== 0 && conn.focusedAt === focusOrder) hub.setTheme(conn.theme);
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
    // Every stream is detached first, then the sizes are handed over, each step on its own: a
    // step that throws leaves no stream attached and no closed page owning a size.
    const attachments = [...conn.attachments.values()];
    conn.attachments.clear();
    for (const attachment of attachments) attempt(() => endStream(attachment));
    for (const attachment of attachments) attempt(() => sizeEvent(conn, 'detach', attachment.term));
    attempt(() => deps.seen?.gone(conn));
  };

  /**
   * S2 8.2.1 (ruled): once a newcomer was accepted, if more than MAX_WAITING_HELLO connections
   * wait for their hello, the one that has waited longest is dropped, so that idle connections
   * that prove nothing cannot lock a window out (a real page says hello within milliseconds). One
   * that has proven itself is never dropped; an upgrade that is no WebSocket drops nobody.
   */
  const dropOldestWaiting = (): void => {
    let oldest: Connection | null = null;
    let waiting = 0;
    for (const conn of connections) {
      if (conn.phase !== 'hello') continue;
      waiting++;
      oldest ??= conn; // the set keeps the order of acceptance
    }
    if (waiting <= MAX_WAITING_HELLO || oldest === null) return;
    log('page: 64 connections wait for their hello; the oldest is dropped');
    oldest.ws.destroy();
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
      sent: 0,
      snapStart: 0,
      snapEnd: 0,
      listHeld: false,
      listForced: false,
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
        const refusal = refusalOf(req, port, stopping || deps.starting?.() === true);
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
        if (ws === null) return; // not a WebSocket request: answered 400, nobody is dropped
        accept(ws, req.headers.origin as string, closed);
        dropOldestWaiting();
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
    notify(message) {
      if (stopping) return false;
      let last: Connection | null = null;
      for (const conn of open) {
        if (conn.focused) return false;
        if (last === null || conn.focusedAt >= last.focusedAt) last = conn;
      }
      if (last === null) return false;
      const to = last;
      let sent = false;
      guard(to, () => {
        send(to, message);
        sent = true;
      });
      return sent;
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
