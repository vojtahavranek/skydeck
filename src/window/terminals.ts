/**
 * The server's side of every keeper (S2 7.1–7.8, 8.1, 8.2.4, 10.1, 14; plan task 16): spawning
 * keepers, claiming them, rebuilding each screen from snapshot and tail, keeping each screen side
 * live, forwarding records to attached sinks in stream order, parking, and what a gap, an exit, a
 * lost keeper and a reconnection mean. It implements `TerminalHub` for the pages (A1).
 *
 * It never decides whether a program may start (`start` and `refuse` are for the window terminal,
 * task 21) and knows nothing of sessions beyond the keeper's `meta` and what `setSession` tells it.
 *
 * Record numbers: the keeper numbers its records from 1 (S2 8.1). After a claim the snapshot
 * covers records up to `snapSeq` and the tail brings the stream to the hello's `seq`. The server
 * counts every record it hands to the screen side; a park names the last record its snapshot
 * covers. When the keeper reports a gap the tail starts at a number the hello does not give, so the
 * count is not exact: such a terminal is not parked until a later claim gives an exact position.
 */
import { dirname } from 'node:path';

import type { Platform } from '../platform/types.ts';
import {
  decodeSnapshot,
  encodeResize,
  encodeSnapshot,
  KEEPER_PROTOCOL,
  MAX_PAYLOAD,
} from './frames.ts';
import { parseExit, parseHello, parseResize, parseStarted } from './frames.ts';
import type { Frame, KeeperExit, KeeperHello, KeeperSpec, KeeperStarted } from './frames.ts';
import type { StreamSink, TerminalHub, TerminalInfo, TerminalState } from './hub.ts';
import { claimKeeper } from './keeper-link.ts';
import type { KeeperLink } from './keeper-link.ts';
import { parsePidLine, pidLineState } from './pidline.ts';
import type { ThemePayload } from './protocol.ts';
import { listKeeperLines, removeDeadKeeperFiles } from './runtime.ts';
import type { RuntimeFiles } from './runtime.ts';
import { createScreen } from './screen.ts';
import type { ScreenSide } from './screen.ts';
import type { XtermModules } from './xterm.ts';

export interface RegistryEvents {
  /** A hello arrived. `origin`: 'spawned' — the hello that resolved spawn() within its 5 s (the
   *  caller of spawn decides about G); 'late' — after spawn() rejected with 'no-hello'; 'found' —
   *  after rediscover() or a reconnect. Only 'late' and 'found' hellos with started false go
   *  through decideFoundKeeper (task 23). */
  hello(term: TerminalInfo, hello: KeeperHello, origin: 'spawned' | 'late' | 'found'): void;
  started(term: TerminalInfo, started: KeeperStarted): void;
  exited(term: TerminalInfo, exit: KeeperExit, lost: boolean): void;
}

export interface RegistryDeps {
  platform: Platform;
  files: RuntimeFiles;
  xterm: XtermModules;
  /** S2 16.5: <runtimeDir>/keeper-<build>.py. */
  keeperFile: string;
  keepersLog: string;
  log: (line: string) => void;
  events: RegistryEvents;
}

export interface Registry extends TerminalHub {
  /** S2 7.1: `python3 -I <keeperFile>`, detached, cwd /, stdout /dev/null, stderr appended to
   *  keepers.log, the spec on stdin; then claim and attach. Resolves after `hello`; rejects with
   *  KeeperStartError: kind 'python-missing' (S2 14's message), 'path-too-long', 'spawn-failed' —
   *  nothing was started, the terminal is forgotten — or 'no-hello' (none within 5 s): the keeper
   *  may still be starting, so the registry KEEPS the terminal, goes on claiming its socket, and
   *  reports its hello through `events.hello` when it comes. Sends no G. */
  spawn(spec: KeeperSpec): Promise<TerminalInfo>;
  /** S2 7.3: connects to every keeper of terms/ whose .pid line is alive; removes dead ones' files. */
  rediscover(): Promise<TerminalInfo[]>;
  start(termId: string): void; // G
  refuse(termId: string, reason: string): void; // N
  /** The lowest free slot 1–9, or null (S2 7.6). */
  nextSlot(): number | null;
  /** From the mapping (task 21): the session the terminal shows, and "started, not reported". */
  setSession(termId: string, sessionId: string | null, notReported: boolean): void;
  /** S2 5.5: park every terminal, close every connection; keepers keep running. */
  stopAll(): Promise<void>;
}

export class KeeperStartError extends Error {
  readonly kind: 'python-missing' | 'path-too-long' | 'spawn-failed' | 'no-hello';
  constructor(kind: KeeperStartError['kind'], message: string) {
    super(message);
    this.name = 'KeeperStartError';
    this.kind = kind;
  }
}

const MiB = 1024 * 1024;
/** S2 7.1: the hello a spawned keeper must send within this time. */
const HELLO_MS = 5000;
/** How often a spawned keeper's socket is tried while it starts. */
const SOCKET_POLL_MS = 50;
/** S2 7.8: a keeper alive but not answering is reconnected to every second. */
const RECONNECT_MS = 1000;
/** S2 7.3, plan task 16: park past 1 MiB of tail, or 30 s after output, since the last park. */
const PARK_BYTES = MiB;
const PARK_MS = 30_000;
/** No park while more than this waits unwritten to the keeper. */
const PARK_UNWRITTEN = MiB;
/** S2 7.1 step 5: input is refused while more than this waits unwritten to the keeper. */
const INPUT_UNWRITTEN = 4 * MiB;
/** S2 7.1 step 5: the server sends at most 64 KiB per input frame. */
const INPUT_CHUNK = 64 * 1024;
/** Plan 2.3: an N reason is at most 1,024 bytes of UTF-8 (the keeper closes on a longer one). */
const MAX_REASON = 1024;
/** Ruled (task 12's review): a requested size is clamped before it reaches keeper and screen. */
const MAX_COLS = 1000;
const MAX_ROWS = 500;
/** A unix socket path must be shorter than this many bytes (S2 4.2). */
const SOCKET_PATH_LIMIT = 108;
/** The forced redraw's two resizes need a pause between them (stand-in review, #40: ≥ 50 ms). */
const REDRAW_PAUSE_MS = 100;
/** How long stopAll waits for a connection to take its park before it is closed anyway. */
const STOP_WAIT_MS = 2000;

const PYTHON_MISSING =
  'python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)';
const GAP_TEXT = "part of this terminal's output was lost while skydeck's server was not running";
const NEWER_TEXT = 'this terminal was started by a newer skydeck; run skydeck window --restart';
/** A lost keeper that had not started its program: nothing ran (S2 7.8). */
const LOST_BEFORE_START = 'the keeper ended before the program started';
/** SIGHUP: what a lost keeper's program got from its pty (S2 7.8, section 21). */
const SIGHUP = 1;

/** A test setting (A31): a whole number of at least 1 from `SKYDECK_TEST_<name>`, else `fallback`. */
function testNumber(platform: Platform, name: string, fallback: number): number {
  const text = platform.env[`SKYDECK_TEST_${name}`];
  return text !== undefined && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : fallback;
}

/** A requested size within 1–1000 columns and 1–500 rows; null for one that is not whole numbers. */
function clampSize(cols: number, rows: number): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  return {
    cols: Math.min(Math.max(cols, 1), MAX_COLS),
    rows: Math.min(Math.max(rows, 1), MAX_ROWS),
  };
}

/** `text` cut to at most `limit` bytes of UTF-8, at a character boundary. */
function cutUtf8(text: string, limit: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return bytes;
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A sink and where its stream starts: records after `from` (the internal count) reach it. */
interface Attached {
  sink: StreamSink;
  from: number;
  /** Records held back until the attach's promise has been answered (then delivered in order). */
  held: (() => void)[] | null;
}

/** One connection's progress through the claim's answer (S2 8.1). */
interface Claim {
  link: KeeperLink;
  hello: KeeperHello | null;
  /** 'hello': nothing yet; 'snapshot': S must come next; 'maybe': S may come next; 'records'. */
  phase: 'hello' | 'snapshot' | 'maybe' | 'records';
  /** Whether a snapshot that comes rebuilds the screen (false: the screen is built already). */
  useS: boolean;
  /** The keeper's number of the last record read on this connection (exact only without gap). */
  position: number;
  /** Records up to this keeper number are on the screen already (a reconnect continues it). */
  skipUntil: number;
  /** Resolves when the hello came and the tail is on the screen; the claim's answer. */
  settle: ((ok: boolean) => void) | null;
}

interface Term {
  info: TerminalInfo;
  hello: KeeperHello | null;
  claim: Claim | null;
  screen: ScreenSide | null;
  /** Records handed to the screen side so far (internal count, never reset). */
  count: number;
  /** The keeper's number of the last record handed to the screen side, when exact. */
  keeperSeq: number;
  exact: boolean;
  /** Query answers go to the keeper (false while a claim's tail is replayed). */
  answering: boolean;
  /** The last forwarding step, so that what comes after a record waits for it. */
  last: Promise<void>;
  sinks: Set<Attached>;
  /** Payload bytes of records since the start and at the last park's point. */
  bytes: number;
  parkedAt: number;
  /** The park in progress, if any. */
  parking: Promise<void> | null;
  gap: boolean;
  reconnect: (() => void) | null;
  forgotten: boolean;
  /** The 'late' or 'found' origin the next hello is reported with ('spawned' while spawn waits). */
  origin: 'spawned' | 'late' | 'found';
}

export function createRegistry(deps: RegistryDeps): Registry {
  const { platform, files, events } = deps;
  const clock = platform.clock;
  const terms = new Map<string, Term>();
  const listeners = new Set<() => void>();
  let theme: ThemePayload | null = null;
  let stopped = false;
  const parkBytes = testNumber(platform, 'PARK_BYTES', PARK_BYTES);
  const parkMs = testNumber(platform, 'PARK_MS', PARK_MS);
  const finding = new Set<string>();

  const log = (id: string, kind: string): void => {
    deps.log(`terminal ${id}: ${kind}`);
  };

  function changed(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        deps.log(
          `terminal registry: a change listener failed (${(error as Error)?.name ?? 'error'})`,
        );
      }
    }
  }

  const copy = (term: Term): TerminalInfo => ({
    ...term.info,
    program: term.info.program === null ? null : { ...term.info.program },
    exit: term.info.exit === null ? null : { ...term.info.exit },
  });

  /** Calls an event handler; one that throws is logged by name and changes nothing here. */
  function emit(name: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      deps.log(
        `terminal registry: the ${name} handler failed (${(error as Error)?.name ?? 'error'})`,
      );
    }
  }

  function setState(term: Term, state: TerminalState): void {
    if (term.info.state !== state) {
      term.info.state = state;
      changed();
    }
  }

  const isOver = (state: TerminalState): boolean =>
    state === 'ended' || state === 'lost' || state === 'not-started';

  // -------------------------------------------------------------------------------------------
  // Sinks

  /** Hands `deliver` to every sink whose stream includes record `n`, held ones in their queue. */
  function toSinks(term: Term, n: number, deliver: (sink: StreamSink) => void): void {
    for (const entry of term.sinks) {
      if (n <= entry.from) continue;
      if (entry.held !== null) entry.held.push(() => deliver(entry.sink));
      else callSink(term, () => deliver(entry.sink));
    }
  }

  /** What is not a record (exit, notices) goes to every sink, after the records before it. */
  function toAllSinks(term: Term, deliver: (sink: StreamSink) => void): void {
    for (const entry of term.sinks) {
      if (entry.held !== null) entry.held.push(() => deliver(entry.sink));
      else callSink(term, () => deliver(entry.sink));
    }
  }

  function callSink(term: Term, call: () => void): void {
    try {
      call();
    } catch (error) {
      log(term.info.id, `a sink failed (${(error as Error)?.name ?? 'error'})`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The screen side

  function newScreen(term: Term, cols: number, rows: number, snapshot: string | null): void {
    term.screen?.dispose();
    const screen = createScreen(deps.xterm, { cols, rows, snapshot }, (bytes) => {
      // Only answers of records the program sent while a screen side was there (S2 7.3).
      if (term.answering && term.screen === screen) {
        term.claim?.link.send('I', bytes);
      }
    });
    screen.goLive();
    screen.setTheme(theme);
    term.screen = screen;
    term.last = Promise.resolve();
  }

  /** One record from the keeper, in stream order: applied, then forwarded. */
  function record(term: Term, frame: Frame): void {
    const screen = term.screen;
    if (screen === null) return;
    term.count += 1;
    const n = term.count;
    term.bytes += frame.payload.length;
    if (frame.type === 'D') {
      const bytes = frame.payload;
      const applied = screen.output(bytes);
      term.last = applied.then(
        () => forwardOutput(term, n, bytes),
        () => forwardOutput(term, n, bytes), // answer failed: the record was applied all the same
      );
      return;
    }
    const size = parseResize(frame.payload);
    if (!size.ok) {
      log(term.info.id, `bad resize record (${size.kind})`);
      return;
    }
    const { cols, rows } = size.value;
    term.last = screen.resize(cols, rows).then(
      () => {
        if (term.screen !== screen) return;
        if (term.info.cols !== cols || term.info.rows !== rows) {
          term.info.cols = cols;
          term.info.rows = rows;
          changed();
        }
        toSinks(term, n, (sink) => {
          sink.size(cols, rows);
        });
      },
      () => {
        log(term.info.id, 'resize record refused by the screen side');
      },
    );
  }

  function forwardOutput(term: Term, n: number, bytes: Uint8Array): void {
    toSinks(term, n, (sink) => {
      sink.output(bytes);
    });
    if (term.bytes - term.parkedAt > parkBytes) {
      void park(term);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Parking (S2 7.3)

  function park(term: Term): Promise<void> {
    const claim = term.claim;
    const screen = term.screen;
    if (term.parking !== null) return term.parking;
    if (
      !term.exact ||
      claim === null ||
      claim.phase !== 'records' ||
      screen === null ||
      !claim.link.isOpen() ||
      claim.link.unwritten() > PARK_UNWRITTEN ||
      isOver(term.info.state)
    ) {
      return Promise.resolve();
    }
    const seq = term.keeperSeq;
    const bytes = term.bytes;
    const run = screen
      .snapshot()
      .then((snap) => {
        if (
          term.claim !== claim ||
          !claim.link.isOpen() ||
          claim.link.unwritten() > PARK_UNWRITTEN
        ) {
          return;
        }
        const payload = encodeSnapshot(seq, snap.cols, snap.rows, snap.data);
        if (payload.length > MAX_PAYLOAD) {
          log(term.info.id, 'snapshot too large to park');
          return;
        }
        claim.link.send('P', payload);
        term.parkedAt = bytes;
      })
      .catch(() => {
        log(term.info.id, 'park failed');
      })
      .finally(() => {
        term.parking = null;
      });
    term.parking = run;
    return run;
  }

  const parkTimer = clock.every(parkMs, () => {
    for (const term of terms.values()) {
      if (term.bytes > term.parkedAt) {
        void park(term);
      }
    }
  });

  // -------------------------------------------------------------------------------------------
  // Claims: the hello, the snapshot, the tail (S2 7.3, 8.1)

  function newTerm(id: string, meta: KeeperSpec['meta'], cols: number, rows: number): Term {
    return {
      info: {
        id,
        slot: meta.slot,
        state: 'starting',
        expectedSessionId: meta.sessionId,
        sessionId: null,
        kind: meta.kind,
        label: meta.label,
        dir: meta.dir,
        program: null,
        openedNs: BigInt(meta.openedNs),
        cols,
        rows,
        exit: null,
        notReported: false,
      },
      hello: null,
      claim: null,
      screen: null,
      count: 0,
      keeperSeq: 0,
      exact: true,
      answering: false,
      last: Promise.resolve(),
      sinks: new Set(),
      bytes: 0,
      parkedAt: 0,
      parking: null,
      gap: false,
      reconnect: null,
      forgotten: false,
      origin: 'found',
    };
  }

  /**
   * Connects to `term`'s keeper and claims it. Resolves true once the hello came and the tail is
   * on the screen (or the keeper is newer), false when the connection ended or no hello came within
   * `helloMs`. Rejects as connectUnix does.
   */
  async function connect(term: Term, helloMs: number): Promise<boolean> {
    const id = term.info.id;
    let claim: Claim | null = null;
    let settled = false;
    let resolveClaim: (ok: boolean) => void = () => {};
    const answered = new Promise<boolean>((resolve) => {
      resolveClaim = resolve;
    });
    const settle = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolveClaim(ok);
      }
    };
    const link = await claimKeeper(
      platform.net,
      files.termSock(id),
      {
        frame: (frame) => {
          if (claim !== null) onFrame(term, claim, frame);
        },
        refused: (kind) => {
          log(id, `keeper sent a frame the codec refuses (${kind})`);
        },
        closed: () => {
          settle(false);
          if (claim !== null) onClosed(term, claim);
        },
      },
      (error) => {
        log(id, `frame handling failed (${(error as Error)?.name ?? 'error'})`);
      },
    );
    claim = { link, hello: null, phase: 'hello', useS: true, position: 0, skipUntil: 0, settle };
    if (stopped || term.forgotten) {
      link.destroy();
      return false;
    }
    const previous = term.claim;
    term.claim = claim;
    previous?.link.destroy();
    const cancel = clock.after(helloMs, () => {
      if (claim !== null && claim.hello === null && term.claim === claim) {
        log(id, 'no hello');
        settle(false);
        link.destroy();
      }
    });
    const ok = await answered;
    cancel();
    return ok;
  }

  function onFrame(term: Term, claim: Claim, frame: Frame): void {
    if (term.claim !== claim || term.forgotten) return;
    const id = term.info.id;
    if (claim.phase === 'hello') {
      if (frame.type !== 'H') {
        log(id, 'first frame not a hello');
        claim.link.destroy();
        return;
      }
      const parsed = parseHello(frame.payload);
      if (!parsed.ok) {
        log(id, `bad hello (${parsed.kind})`);
        claim.link.destroy();
        return;
      }
      onHello(term, claim, parsed.value);
      return;
    }
    if (frame.type === 'S' && (claim.phase === 'snapshot' || claim.phase === 'maybe')) {
      const hello = claim.hello as KeeperHello;
      const snap = decodeSnapshot(frame.payload);
      if (snap === null || snap.seq !== hello.snapSeq) {
        log(id, 'bad snapshot');
        claim.link.destroy();
        return;
      }
      claim.phase = 'records';
      if (claim.useS) {
        newScreen(term, snap.cols, snap.rows, snap.data);
        setSize(term, snap.cols, snap.rows);
      }
      replayed(term, claim);
      return;
    }
    if (claim.phase === 'snapshot') {
      log(id, 'snapshot missing');
      claim.link.destroy();
      return;
    }
    if (claim.phase === 'maybe') {
      claim.phase = 'records';
      if (claim.useS) {
        // No snapshot was ever parked: the tail starts from the first record, at the hello's
        // size. The first size is in no frame (the server parks record 0 at once, so this is a
        // keeper that lost its first server before that park): the hello's is the best known.
        const hello = claim.hello as KeeperHello;
        newScreen(term, hello.cols, hello.rows, null);
        setSize(term, hello.cols, hello.rows);
      }
    }
    switch (frame.type) {
      case 'D':
      case 'R':
        claim.position += 1;
        if (!(term.exact && claim.position <= claim.skipUntil)) {
          // (records up to skipUntil are on the screen already: a reconnect continues it)
          if (term.exact) term.keeperSeq = claim.position;
          record(term, frame);
        }
        replayed(term, claim);
        return;
      case 'T': {
        const parsed = parseStarted(frame.payload);
        if (!parsed.ok) {
          log(id, `bad started (${parsed.kind})`);
          return;
        }
        onStarted(term, parsed.value);
        return;
      }
      case 'X': {
        const parsed = parseExit(frame.payload);
        if (!parsed.ok) {
          log(id, `bad exit (${parsed.kind})`);
          return;
        }
        onExit(term, claim, parsed.value);
        return;
      }
      default:
        log(id, `unexpected frame ${frame.type}`);
        claim.link.destroy();
    }
  }

  function onHello(term: Term, claim: Claim, hello: KeeperHello): void {
    const id = term.info.id;
    if (hello.id !== id) {
      log(id, 'hello of another terminal');
      claim.link.destroy();
      return;
    }
    claim.hello = hello;
    term.hello = hello;
    const info = term.info;
    info.slot = hello.meta.slot;
    info.expectedSessionId = hello.meta.sessionId;
    info.kind = hello.meta.kind;
    info.label = hello.meta.label;
    info.dir = hello.meta.dir;
    info.openedNs = BigInt(hello.meta.openedNs);
    info.program =
      hello.pid !== null && hello.procStart !== null
        ? { pid: hello.pid, procStart: hello.procStart }
        : null;
    const origin = term.origin;
    term.origin = 'found';
    stopReconnecting(term);
    if (!terms.has(id) && !stopped) {
      terms.set(id, term); // a found keeper is listed from its hello on
    }
    if (hello.protocol > KEEPER_PROTOCOL) {
      // S2 7.7: never attached; its program keeps running.
      log(id, 'newer keeper');
      info.cols = hello.cols;
      info.rows = hello.rows;
      claim.phase = 'records';
      setState(term, 'newer-keeper');
      toAllSinks(term, (sink) => {
        sink.notice('newer-keeper', NEWER_TEXT);
      });
      term.claim = null;
      claim.link.destroy();
      emit('hello', () => events.hello(copy(term), hello, origin));
      claim.settle?.(true);
      return;
    }
    const continues =
      term.screen !== null &&
      term.exact &&
      !hello.gap &&
      term.keeperSeq >= hello.snapSeq &&
      term.keeperSeq <= hello.seq;
    // Answers wait until the tail is on the screen: its queries were answered when they were new,
    // or went unanswered while no server was there (S2 7.3, 14).
    term.answering = false;
    claim.position = hello.snapSeq;
    claim.phase = hello.snapSeq > 0 ? 'snapshot' : 'maybe';
    if (continues) {
      // The screen holds every record up to keeperSeq: the snapshot and those are skipped.
      claim.useS = false;
      claim.skipUntil = term.keeperSeq;
    } else {
      claim.useS = true;
      term.exact = !hello.gap;
      term.keeperSeq = hello.snapSeq;
      if (hello.seq === 0) {
        // Nothing written yet: the screen is empty at the hello's size. Park that at once
        // (record 0), so that every later claim learns the first size from its snapshot.
        claim.useS = false;
        newScreen(term, hello.cols, hello.rows, null);
        setSize(term, hello.cols, hello.rows);
        if (hello.snapSeq === 0) {
          claim.link.send('P', encodeSnapshot(0, hello.cols, hello.rows, ''));
        }
      }
    }
    const state: TerminalState = hello.started ? 'running' : 'starting';
    if (!isOver(info.state)) setState(term, state);
    changed();
    if (hello.gap) {
      term.gap = true;
      log(id, 'gap');
      toAllSinks(term, (sink) => {
        sink.notice('gap', GAP_TEXT);
      });
      redraw(term, claim, hello.cols, hello.rows);
    }
    emit('hello', () => events.hello(copy(term), hello, origin));
    replayed(term, claim);
  }

  function setSize(term: Term, cols: number, rows: number): void {
    if (term.info.cols !== cols || term.info.rows !== rows) {
      term.info.cols = cols;
      term.info.rows = rows;
      changed();
    }
  }

  /** Once the claim's tail is on the screen: answers go to the keeper again; the claim settles. */
  function replayed(term: Term, claim: Claim): void {
    const hello = claim.hello;
    if (hello === null || claim.settle === null || term.screen === null) return;
    if (claim.phase === 'snapshot') return;
    if (claim.phase === 'maybe' && hello.seq > hello.snapSeq) return;
    if (term.exact && claim.position < hello.seq) return;
    if (hello.exited !== null && term.info.exit === null) return; // its X follows the tail
    const settle = claim.settle;
    claim.settle = null;
    void term.last.then(() => {
      if (term.claim === claim) {
        term.answering = true;
        settle(true);
      }
    });
  }

  /** S2 7.3: makes the program redraw by changing the width by one column and back. */
  function redraw(term: Term, claim: Claim, cols: number, rows: number): void {
    const narrow = cols > 1 ? cols - 1 : cols + 1;
    claim.link.send('Z', encodeResize(narrow, rows));
    clock.after(REDRAW_PAUSE_MS, () => {
      if (term.claim === claim) claim.link.send('Z', encodeResize(cols, rows));
    });
  }

  function onStarted(term: Term, started: KeeperStarted): void {
    term.info.program = { pid: started.pid, procStart: started.procStart };
    if (term.info.state === 'starting') term.info.state = 'running';
    changed();
    emit('started', () => events.started(copy(term), started));
  }

  function onExit(term: Term, claim: Claim, exit: KeeperExit): void {
    term.info.exit = exit;
    void term.last.then(() => {
      if (term.forgotten) return;
      term.info.state = exit.notStarted === null ? 'ended' : 'not-started';
      changed();
      toAllSinks(term, (sink) => {
        sink.exit(exit, false);
      });
      emit('exited', () => events.exited(copy(term), exit, false));
      // S2 8.1: the server has the exit; the keeper may end (7.8).
      claim.link.send('A');
      replayed(term, claim);
    });
  }

  // -------------------------------------------------------------------------------------------
  // A connection that ended without X (S2 7.8)

  function onClosed(term: Term, claim: Claim): void {
    if (term.claim === claim) term.claim = null;
    if (stopped || term.forgotten || term.claim !== null) return;
    if (isOver(term.info.state) || term.info.state === 'newer-keeper') return;
    if (term.hello === null) return; // a spawn or a find still waits for its first hello
    startReconnecting(term);
  }

  function startReconnecting(term: Term): void {
    if (term.reconnect !== null) return;
    setState(term, 'reconnecting');
    let busy = false;
    const attempt = (): void => {
      if (busy || term.forgotten || stopped) return;
      busy = true;
      void tryReconnect(term).finally(() => {
        busy = false;
      });
    };
    term.reconnect = clock.every(RECONNECT_MS, attempt);
    attempt();
  }

  function stopReconnecting(term: Term): void {
    term.reconnect?.();
    term.reconnect = null;
  }

  /** One reconnection attempt: lost when the pid line is dead or the socket refuses. */
  async function tryReconnect(term: Term): Promise<void> {
    if (keeperState(term.info.id) === 'dead') {
      lose(term);
      return;
    }
    try {
      await connect(term, HELLO_MS);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ECONNREFUSED' || code === 'ENOENT') lose(term);
    }
  }

  /** Design 5.5 on the terminal's .pid line: 'dead' also when the file is gone. */
  function keeperState(id: string): 'alive' | 'dead' | 'unknown' {
    let text: string | null;
    try {
      text = platform.files.readText(files.termPid(id));
    } catch {
      return 'unknown';
    }
    if (text === null) return 'dead';
    const line = parsePidLine(text);
    if (line === null) return 'unknown';
    let bootId: string | null;
    try {
      bootId = platform.proc.bootId();
    } catch {
      bootId = null;
    }
    return pidLineState(line, platform.proc, bootId);
  }

  function lose(term: Term): void {
    stopReconnecting(term);
    if (term.forgotten || isOver(term.info.state)) return;
    const exit: KeeperExit =
      term.info.program !== null
        ? { code: null, signal: SIGHUP, atNs: String(clock.nowNs()), notStarted: null }
        : { code: null, signal: null, atNs: String(clock.nowNs()), notStarted: LOST_BEFORE_START };
    term.info.exit = exit;
    void term.last.then(() => {
      if (term.forgotten) return;
      term.info.state = 'lost';
      changed();
      toAllSinks(term, (sink) => {
        sink.exit(exit, true);
      });
      emit('exited', () => events.exited(copy(term), exit, true));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Spawning (S2 7.1)

  function startError(kind: KeeperStartError['kind'], detail = ''): KeeperStartError {
    const messages: Record<KeeperStartError['kind'], string> = {
      'python-missing': PYTHON_MISSING,
      'path-too-long': `the terminal's socket path would be ${detail} bytes; a unix socket path must be shorter than ${SOCKET_PATH_LIMIT} bytes`,
      'spawn-failed': `the terminal's keeper could not be started${detail === '' ? '' : ` (${detail})`}`,
      'no-hello': `the terminal's keeper did not answer within ${HELLO_MS / 1000} seconds`,
    };
    return new KeeperStartError(kind, messages[kind]);
  }

  async function spawn(spec: KeeperSpec): Promise<TerminalInfo> {
    const pathBytes = Buffer.byteLength(spec.socket);
    if (pathBytes >= SOCKET_PATH_LIMIT) {
      throw startError('path-too-long', String(pathBytes));
    }
    if (stopped) throw startError('spawn-failed', 'the server is stopping');
    if (terms.has(spec.id)) throw startError('spawn-failed', 'the terminal id is taken');
    const size = clampSize(spec.cols, spec.rows) ?? { cols: 120, rows: 40 };
    const sent: KeeperSpec = { ...spec, ...size };
    const term = newTerm(spec.id, spec.meta, size.cols, size.rows);
    term.origin = 'spawned';
    terms.set(spec.id, term);
    changed();
    const forget = (): void => {
      if (terms.get(spec.id) === term) {
        term.forgotten = true;
        terms.delete(spec.id);
        changed();
      }
    };
    let keeper: Awaited<ReturnType<Platform['processes']['startDetached']>>;
    try {
      keeper = await platform.processes.startDetached('python3', ['-I', deps.keeperFile], {
        cwd: '/',
        env: Object.fromEntries(
          Object.entries(platform.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        input: JSON.stringify(sent),
        stderrTo: deps.keepersLog,
      });
    } catch (error) {
      forget();
      const code = errorCode(error);
      if (code === 'ENOENT' && platform.files.stat(dirname(deps.keepersLog))?.kind === 'dir') {
        throw startError('python-missing');
      }
      throw startError('spawn-failed', code ?? (error as Error)?.name ?? 'error');
    }
    let keeperEnded = false;
    void keeper.exited.then(() => {
      keeperEnded = true;
    });

    // The 5 s count on the platform's timer; a claim still waiting for its hello then is dropped.
    let timedOut = false;
    const cancelWait = clock.after(HELLO_MS, () => {
      timedOut = true;
      if (term.hello === null) term.claim?.link.destroy();
    });
    try {
      while (!timedOut && term.hello === null) {
        if (term.forgotten) throw startError('spawn-failed', 'closed');
        if (keeperEnded) {
          forget();
          throw startError('spawn-failed', 'the keeper ended at start');
        }
        try {
          await connect(term, HELLO_MS);
        } catch {
          await clock.sleep(SOCKET_POLL_MS); // not listening yet
        }
      }
    } finally {
      cancelWait();
    }
    if (term.hello === null) {
      term.origin = 'late';
      void findLate(term, () => keeperEnded);
      throw startError('no-hello');
    }
    return copy(term);
  }

  /** After 'no-hello': goes on claiming the keeper's socket until its hello comes (origin 'late'). */
  async function findLate(term: Term, keeperEnded: () => boolean): Promise<void> {
    while (!stopped && !term.forgotten && term.hello === null) {
      if (keeperEnded()) {
        lose(term);
        return;
      }
      try {
        if (await connect(term, HELLO_MS)) return;
      } catch {
        // not listening yet
      }
      if (term.hello === null) await clock.sleep(RECONNECT_MS);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rediscovery (S2 7.3)

  /** A terminal known only by its id until its hello comes. */
  const unknownMeta: KeeperSpec['meta'] = {
    sessionId: '',
    kind: 'resume',
    slot: null,
    openedNs: '0',
    build: '',
    label: null,
    dir: '',
  };

  async function rediscover(): Promise<TerminalInfo[]> {
    try {
      for (const id of await removeDeadKeeperFiles(platform, files)) {
        log(id, 'removed the files of a dead keeper');
      }
    } catch (error) {
      deps.log(`terminal registry: dead keeper files not removed (${errorCode(error) ?? 'error'})`);
    }
    // 'unknown' lines too: nothing is removed for them, and connecting to a keeper that ended is
    // refused at once (with an unreadable boot id every line is 'unknown').
    const ids = listKeeperLines(platform, files)
      .filter((keeper) => keeper.state !== 'dead' && !terms.has(keeper.id))
      .map((keeper) => keeper.id);
    const found = await Promise.all(ids.map((id) => find(id)));
    return found.filter((term): term is Term => term !== null).map(copy);
  }

  /** Claims a keeper found in terms/; it is listed once its hello came (origin 'found'). */
  async function find(id: string): Promise<Term | null> {
    if (finding.has(id)) return null;
    finding.add(id);
    const term = newTerm(id, unknownMeta, 1, 1);
    try {
      await connect(term, HELLO_MS);
    } catch {
      finding.delete(id);
      return null; // gone, or refusing: removeDeadKeeperFiles removes it next time
    }
    if (term.hello !== null) {
      finding.delete(id);
      return term;
    }
    // Connected, but no hello within 5 s (a keeper that is stopped or slow): go on trying.
    void (async () => {
      while (!stopped && term.hello === null && keeperState(id) !== 'dead') {
        await clock.sleep(RECONNECT_MS);
        try {
          await connect(term, HELLO_MS);
        } catch (error) {
          const code = errorCode(error);
          if (code === 'ECONNREFUSED' || code === 'ENOENT') break;
        }
      }
      finding.delete(id);
    })();
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // The hub

  function forget(term: Term): void {
    term.forgotten = true;
    stopReconnecting(term);
    term.claim?.link.destroy();
    term.claim = null;
    term.screen?.dispose();
    term.screen = null;
    term.sinks.clear();
    if (terms.get(term.info.id) === term) {
      terms.delete(term.info.id);
      changed();
    }
  }

  /** The claim a frame can be sent on: hello received, connection open. */
  function usable(term: Term): Claim | null {
    const claim = term.claim;
    return claim !== null && claim.hello !== null && claim.link.isOpen() ? claim : null;
  }

  /**
   * Ruled (task 16, wave 3): the sink is registered at the current point of the chain and its
   * first call is `snapshot` for that point; records, exits and notices that arise before the
   * snapshot is made wait for it, in order. A terminal forgotten, or a sink detached, before the
   * snapshot is made gets no call at all.
   */
  function attach(termId: string, sink: StreamSink): { detach(): void } | null {
    const term = terms.get(termId);
    if (term === undefined) return null;
    // Not records, but what the terminal shows now: a page that attaches later still sees them.
    // (An exit that came before the attach is in list(), so it is not repeated; ruled.)
    const shown = (): (() => void)[] => [
      ...(term.info.state === 'newer-keeper'
        ? [() => sink.notice('newer-keeper', NEWER_TEXT)]
        : []),
      ...(term.gap ? [() => sink.notice('gap', GAP_TEXT)] : []),
    ];
    const entry: Attached = { sink, from: term.count, held: shown() };
    term.sinks.add(entry);
    const deliver = (snap: { cols: number; rows: number; data: string }): void => {
      if (term.forgotten || !term.sinks.has(entry)) return;
      const held = entry.held ?? [];
      entry.held = null;
      callSink(term, () => sink.snapshot(snap.cols, snap.rows, snap.data));
      for (const step of held) {
        if (!term.sinks.has(entry)) return; // detached by one of the calls
        callSink(term, step);
      }
    };
    const take = (): void => {
      const screen = term.screen;
      if (screen === null) {
        // No screen yet (a keeper whose hello has not come): an empty one at the known size.
        const empty = { cols: term.info.cols, rows: term.info.rows, data: '' };
        void Promise.resolve().then(() => deliver(empty));
        return;
      }
      screen.snapshot().then(deliver, () => {
        // The screen was replaced meanwhile (a rebuild): start over from the new one's point;
        // what was held belonged to the old one.
        if (term.forgotten || !term.sinks.has(entry)) return;
        entry.from = term.count;
        entry.held = shown();
        take();
      });
    };
    take();
    return {
      detach() {
        term.sinks.delete(entry);
      },
    };
  }

  const registry: Registry = {
    list: () => [...terms.values()].map(copy),
    attach,
    input(termId, data) {
      const term = terms.get(termId);
      if (term === undefined) return 'unknown';
      if (isOver(term.info.state)) return 'ended';
      const claim = usable(term);
      // S2 7.1 step 5: while the keeper does not take what waits, input is refused.
      if (claim === null || claim.link.unwritten() > INPUT_UNWRITTEN) return 'full';
      for (let at = 0; at < data.length; at += INPUT_CHUNK) {
        claim.link.send('I', data.subarray(at, at + INPUT_CHUNK));
      }
      return 'ok';
    },
    resize(termId, cols, rows) {
      const term = terms.get(termId);
      const size = clampSize(cols, rows);
      const claim = term === undefined ? null : usable(term);
      if (claim !== null && size !== null && !isOver(term?.info.state ?? 'ended')) {
        claim.link.send('Z', encodeResize(size.cols, size.rows));
      }
    },
    close(termId) {
      const term = terms.get(termId);
      if (term === undefined) return 'unknown';
      if (!isOver(term.info.state)) return 'running';
      forget(term);
      return 'ok';
    },
    setTheme(next) {
      theme = next;
      for (const term of terms.values()) term.screen?.setTheme(next);
    },
    onChange(listener) {
      const own = (): void => {
        listener();
      };
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    spawn,
    rediscover,
    start(termId) {
      const term = terms.get(termId);
      const claim = term === undefined ? null : usable(term);
      if (term !== undefined && claim === null) log(termId, 'G without a connection');
      claim?.link.send('G');
    },
    refuse(termId, reason) {
      const term = terms.get(termId);
      const claim = term === undefined ? null : usable(term);
      if (term !== undefined && claim === null) log(termId, 'N without a connection');
      claim?.link.send('N', cutUtf8(reason, MAX_REASON));
    },
    nextSlot() {
      const taken = new Set([...terms.values()].map((term) => term.info.slot));
      for (let slot = 1; slot <= 9; slot++) {
        if (!taken.has(slot)) return slot;
      }
      return null;
    },
    setSession(termId, sessionId, notReported) {
      const term = terms.get(termId);
      if (term === undefined) return;
      if (term.info.sessionId !== sessionId || term.info.notReported !== notReported) {
        term.info.sessionId = sessionId;
        term.info.notReported = notReported;
        changed();
      }
    },
    async stopAll() {
      stopped = true;
      parkTimer();
      await Promise.all(
        [...terms.values()].map(async (term) => {
          stopReconnecting(term);
          await park(term); // one in progress
          await park(term); // the records since
          const claim = term.claim;
          if (claim !== null) {
            const cancel = clock.after(STOP_WAIT_MS, () => {
              claim.link.destroy();
            });
            await claim.link.end();
            cancel();
          }
          term.screen?.dispose();
          term.screen = null;
        }),
      );
    },
  };
  return registry;
}
