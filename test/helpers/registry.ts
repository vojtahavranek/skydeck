/**
 * The terminal registry (plan task 16) under test: real keepers (python3, the repository's
 * `bin/skydeck-keeper` written as the runtime directory's keeper file) running the stand-in, in a
 * keeper sandbox (test/helpers/keeper.ts). Several registries can share one runtime directory, as
 * a restarted server does. Every registry is stopped, every keeper killed through `killKeepersIn`
 * (A34) and every program waited for before the sandbox is removed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';

import type { IBuffer, IBufferCell, Terminal } from '@xterm/headless';

import type { Platform } from '../../src/platform/types.ts';
import type {
  KeeperExit,
  KeeperHello,
  KeeperSpec,
  KeeperStarted,
} from '../../src/window/frames.ts';
import type { StreamSink, TerminalInfo } from '../../src/window/hub.ts';
import { runtimeFiles, writeKeeperFile } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import { createRegistry } from '../../src/window/terminals.ts';
import type { Registry } from '../../src/window/terminals.ts';
import { loadXterm } from '../../src/window/xterm.ts';
import type { XtermModules } from '../../src/window/xterm.ts';
import { frameReader, parseHello } from '../../src/window/frames.ts';
import { parsePidLine } from '../../src/window/pidline.ts';
import { KEEPER, keeperSandbox, procStartOf, stillRuns, until } from './keeper.ts';
import type { KeeperBox } from './keeper.ts';
import { killKeepersIn } from './kill.ts';

export interface Events {
  hello: { term: TerminalInfo; hello: KeeperHello; origin: 'spawned' | 'late' | 'found' }[];
  started: { term: TerminalInfo; started: KeeperStarted }[];
  exited: { term: TerminalInfo; exit: KeeperExit; lost: boolean }[];
}

export interface TestRegistry {
  registry: Registry;
  events: Events;
  log: string[];
  /** Every headless terminal the registry's screen sides made, in order. */
  terminals: Terminal[];
  /** The sockets the registry opened to keepers, in order. */
  sockets: Socket[];
  /** The pids of the keepers this registry started, in order. */
  spawned: number[];
  /**
   * The most bytes of output records handed to the screen sides and not yet applied (written to
   * their headless terminals), sampled after each read from a keeper socket.
   */
  maxBacklog(): number;
  /** Every state each terminal went through, as onChange saw it (consecutive repeats dropped). */
  states: Map<string, string[]>;
  /**
   * Drops the registry as a crashed server would leave it: every connection destroyed, nothing
   * parked; its further connects are refused. Its timers are stopped at the test's end.
   */
  drop(): void;
}

export interface RegistryBox extends KeeperBox {
  files: RuntimeFiles;
  keeperFile: string;
  modules: XtermModules;
  /**
   * A registry over the box's runtime directory; `platform` replaces the box's (its net is
   * wrapped). `slowWriteMs`: each write to a screen side's terminal completes that much later.
   * `keeperFile`: the keeper it spawns, instead of the repository's (F30: an older keeper's).
   */
  registry(options?: {
    platform?: Platform;
    slowWriteMs?: number;
    keeperFile?: string;
  }): TestRegistry;
  /** A spec for the stand-in in this box (argv, env, record), as keeperSandbox makes it. */
  spec(overrides?: Partial<KeeperSpec>): KeeperSpec;
  /**
   * The keeper of terminal `id`, checked before a test may signal it (hard rule): its .pid line
   * parses, its pid is a whole number above 1 that is neither this process nor its parent, it is a
   * keeper a registry of this box started, with the same process start, and it still runs.
   */
  keeperOf(id: string): { pid: number; procStart: number };
  /** Sends `signal` to a keeper `keeperOf` gave, after checking that it is still that process. */
  signalKeeper(
    keeper: { pid: number; procStart: number },
    signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL',
  ): void;
}

/**
 * Call first in a test. The cleanup is registered before keeperSandbox's (t.after runs first in,
 * first out): registries are stopped, keepers killed and programs waited for before the sandbox goes.
 */
export async function registrySandbox(t: TestContext): Promise<RegistryBox> {
  const registries: TestRegistry[] = [];
  const programs = new Map<number, number>();
  /** pid → process start of every keeper a registry of this box started. */
  const keepers = new Map<number, number>();
  let box: KeeperBox | null = null;
  t.after(async () => {
    for (const r of registries) {
      r.drop();
      await r.registry.stopAll();
    }
    if (box === null) {
      return;
    }
    killKeepersIn(box.s, box.runtimeDir);
    for (const [pid, procStart] of programs) {
      await until(() => !stillRuns(pid, procStart), `program ${pid} ended`, 10_000);
    }
  });
  box = keeperSandbox(t);
  const kb = box;
  const files = runtimeFiles(kb.runtimeDir);
  writeKeeperFile(kb.tp.platform.files, files, 'test', readFileSync(KEEPER, 'utf8'));
  const keeperFile = files.keeperFile('test');
  const modules = await loadXterm(kb.tp.platform.appRoot);

  const remember = (term: TerminalInfo): void => {
    if (term.program !== null) {
      programs.set(term.program.pid, term.program.procStart);
    }
  };

  const registry = (
    options: { platform?: Platform; slowWriteMs?: number; keeperFile?: string } = {},
  ): TestRegistry => {
    const base = options.platform ?? kb.tp.platform;
    const sockets: Socket[] = [];
    const spawned: number[] = [];
    /** Bytes of output records handed to a screen side, and the newest record number per terminal. */
    let handed = 0;
    const newest = new Map<string, number>();
    let written = 0;
    let worst = 0;
    const slow = options.slowWriteMs ?? 0;
    let refusing = false;
    const platform: Platform = {
      ...base,
      processes: {
        ...base.processes,
        async startDetached(command, args, options) {
          const child = await base.processes.startDetached(command, args, options);
          spawned.push(child.pid);
          const start = procStartOf(child.pid);
          if (start !== null) keepers.set(child.pid, start);
          return child;
        },
      },
      net: {
        ...base.net,
        async connectUnix(path) {
          if (refusing) {
            throw Object.assign(new Error('dropped registry'), { code: 'EDROPPED' });
          }
          const socket = await base.net.connectUnix(path);
          sockets.push(socket);
          // The records this read hands to a screen side (numbered as the registry does, the ones
          // a reconnect's tail repeats left out), sampled after the registry's handler ran.
          // This is what the registry counts only for the D records of claims that continue the
          // screen, the one case a test relies on today. It differs in three cases:
          // - a claim that rebuilds the screen replays its tail onto the new one: the registry
          //   counts those records again, this spy (each position once per terminal) does not,
          //   while `written` counts their writes, so `maxBacklog` under-reports from then on;
          // - records still queued on a screen that a rebuild disposes never reach `write`,
          //   while the registry takes them off as applied: it over-reports by those bytes;
          // - R records: the registry counts their payloads until the resize is applied; this
          //   spy neither hands nor writes them.
          // Counting exactly would mean re-deriving the registry's skip rule, its resizes and its
          // screens' queues here (left out, test-unlink #62).
          const reader = frameReader();
          let position = 0;
          let id = '';
          const emit = socket.emit.bind(socket) as (event: string, ...args: unknown[]) => boolean;
          socket.emit = ((event: string, ...args: unknown[]) => {
            if (event === 'data' && args[0] instanceof Uint8Array) {
              const frames = reader.push(args[0].slice());
              for (const frame of 'error' in frames ? [] : frames) {
                if (frame.type === 'H') {
                  const hello = parseHello(frame.payload);
                  if (hello.ok) {
                    id = hello.value.id;
                    position = hello.value.tailFrom - 1;
                  }
                } else if (frame.type === 'D' || frame.type === 'R') {
                  position += 1;
                  if (position > (newest.get(id) ?? 0)) {
                    newest.set(id, position);
                    if (frame.type === 'D') handed += frame.payload.length;
                  }
                }
              }
            }
            const result = emit(event, ...args);
            if (event === 'data') worst = Math.max(worst, handed - written);
            return result;
          }) as typeof socket.emit;
          return socket;
        },
      },
    };
    const terminals: Terminal[] = [];
    const Base = modules.Terminal;
    class Spy extends Base {
      constructor(...args: ConstructorParameters<typeof Base>) {
        super(...args);
        terminals.push(this);
      }
      override write(data: string | Uint8Array, callback?: () => void): void {
        // Records arrive as bytes; a snapshot, as text, is not a record.
        const length = typeof data === 'string' ? 0 : data.length;
        super.write(data, () => {
          const done = (): void => {
            written += length;
            callback?.();
          };
          if (slow > 0) setTimeout(done, slow);
          else done();
        });
      }
    }
    const events: Events = { hello: [], started: [], exited: [] };
    const log: string[] = [];
    const states = new Map<string, string[]>();
    const created = createRegistry({
      platform,
      files,
      xterm: { ...modules, Terminal: Spy },
      keeperFile: options.keeperFile ?? keeperFile,
      keepersLog: kb.keepersLog,
      log: (line) => {
        log.push(line);
      },
      events: {
        hello(term, hello, origin) {
          remember(term);
          if (hello.pid !== null && hello.procStart !== null) {
            programs.set(hello.pid, hello.procStart);
          }
          events.hello.push({ term, hello, origin });
        },
        started(term, started) {
          programs.set(started.pid, started.procStart);
          events.started.push({ term, started });
        },
        exited(term, exit, lost) {
          events.exited.push({ term, exit, lost });
        },
      },
    });
    created.onChange(() => {
      for (const term of created.list()) {
        remember(term);
        const seen = states.get(term.id) ?? [];
        if (seen.at(-1) !== term.state) {
          seen.push(term.state);
        }
        states.set(term.id, seen);
      }
    });
    const tr: TestRegistry = {
      registry: created,
      events,
      log,
      terminals,
      sockets,
      spawned,
      maxBacklog: () => worst,
      states,
      drop() {
        refusing = true;
        for (const socket of sockets) {
          socket.destroy();
        }
      },
    };
    registries.push(tr);
    return tr;
  };

  const keeperOf = (id: string): { pid: number; procStart: number } => {
    const line = parsePidLine(readFileSync(files.termPid(id), 'utf8'));
    assert.ok(line, `terminal ${id} has no pid line`);
    const { pid, procStart } = line;
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `not a pid to signal: ${pid}`);
    assert.ok(pid !== process.pid && pid !== process.ppid, 'never this process or its parent');
    assert.equal(keepers.get(pid), procStart, `pid ${pid} is not a keeper this test started`);
    assert.ok(stillRuns(pid, procStart), `keeper ${pid} no longer runs`);
    return { pid, procStart };
  };
  const signalKeeper = (
    keeper: { pid: number; procStart: number },
    signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL',
  ): void => {
    assert.equal(keepers.get(keeper.pid), keeper.procStart, 'a keeper this test started');
    assert.ok(stillRuns(keeper.pid, keeper.procStart), `keeper ${keeper.pid} no longer runs`);
    process.kill(keeper.pid, signal);
  };

  return { ...kb, files, keeperFile, modules, registry, spec: kb.spec, keeperOf, signalKeeper };
}

// ---------------------------------------------------------------------------------------------
// What a page would show: a headless terminal built from the sink's snapshot and the records after it

export interface Mirror extends StreamSink {
  /** The headless terminal; asserted to exist (the snapshot came). */
  term: Terminal;
  /** Every call the sink got, in order: 'S' snapshot, 'o' output, 's' size, 'x' exit, 'n' notice. */
  calls: string[];
  outputs: Uint8Array[];
  notices: { kind: string; text: string }[];
  exits: { exit: KeeperExit; lost: boolean }[];
  /** Resolves when everything written so far has been parsed. */
  settled(): Promise<void>;
  /** Every output record so far, as UTF-8. */
  text(): string;
}

/** A sink that builds the screen a page would show: `snapshot` must be its first call. */
export function mirror(modules: XtermModules): Mirror {
  let term: Terminal | null = null;
  let decoded = '';
  const decoder = new TextDecoder();
  const m: Mirror = {
    calls: [],
    outputs: [],
    notices: [],
    exits: [],
    get term(): Terminal {
      assert.ok(term, 'the mirror has no snapshot yet');
      return term;
    },
    snapshot(cols, rows, data) {
      assert.equal(m.calls.length, 0, 'snapshot is the first call on a sink');
      m.calls.push('S');
      term = new modules.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
      term.loadAddon(new modules.UnicodeGraphemesAddon());
      term.write(data);
    },
    output(bytes) {
      m.calls.push('o');
      const copy = bytes.slice();
      m.outputs.push(copy);
      decoded += decoder.decode(copy, { stream: true });
      m.term.write(copy);
    },
    size(cols, rows) {
      m.calls.push('s');
      m.term.resize(cols, rows);
    },
    exit(exit, lost) {
      m.calls.push('x');
      m.exits.push({ exit, lost });
    },
    notice(kind, text) {
      m.calls.push('n');
      m.notices.push({ kind, text });
    },
    settled: () => new Promise<void>((resolve) => m.term.write('', resolve)),
    text: () => decoded,
  };
  return m;
}

/** Attaches a mirror to a terminal of `registry`; resolves once its snapshot came. */
export async function attachMirror(
  registry: Registry,
  modules: XtermModules,
  termId: string,
): Promise<Mirror & { detach(): void }> {
  const m = mirror(modules);
  const attached = registry.attach(termId, m);
  assert.ok(attached, `attach ${termId} gave null`);
  await until(() => m.calls.length > 0, 'the snapshot reached the sink');
  return Object.assign(m, { detach: attached.detach });
}

/** Resolves once `term` has parsed everything written to it so far. */
export function settledTerm(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', resolve));
}

function cellKey(cell: IBufferCell): string {
  return [
    cell.getChars() || ' ',
    cell.getWidth(),
    cell.getFgColorMode(),
    cell.getFgColor(),
    cell.getBgColorMode(),
    cell.getBgColor(),
    cell.isBold(),
    cell.isItalic(),
    cell.isDim(),
    cell.isUnderline(),
    cell.isBlink(),
    cell.isInverse(),
    cell.isInvisible(),
    cell.isStrikethrough(),
    cell.isOverline(),
  ].join('|');
}

function assertSameBuffer(a: IBuffer, b: IBuffer, cols: number, label: string): void {
  assert.equal(b.length, a.length, `${label}: number of lines`);
  assert.equal(b.baseY, a.baseY, `${label}: scrollback lines`);
  for (let y = 0; y < a.length; y++) {
    const la = a.getLine(y);
    const lb = b.getLine(y);
    assert.ok(la && lb, `${label}: line ${y} missing`);
    const show = `${label} line ${y}: ${JSON.stringify(la.translateToString(true))} vs ${JSON.stringify(lb.translateToString(true))}`;
    assert.equal(lb.isWrapped, la.isWrapped, `${show}: wrap flag`);
    for (let x = 0; x < cols; x++) {
      const ca: IBufferCell | undefined = la.getCell(x);
      const cb: IBufferCell | undefined = lb.getCell(x);
      assert.ok(ca && cb);
      assert.equal(cellKey(cb), cellKey(ca), `${show}: cell ${x}`);
    }
  }
}

/** `b` shows what `a` shows: size, both buffers cell by cell, the cursor and the public modes. */
export function assertSameScreen(a: Terminal, b: Terminal): void {
  assert.deepEqual([b.cols, b.rows], [a.cols, a.rows], 'size');
  assert.equal(b.buffer.active.type, a.buffer.active.type, 'active buffer');
  assertSameBuffer(a.buffer.normal, b.buffer.normal, a.cols, 'normal buffer');
  if (a.buffer.active.type === 'alternate') {
    assertSameBuffer(a.buffer.alternate, b.buffer.alternate, a.cols, 'alternate buffer');
  }
  assert.deepEqual(
    [b.buffer.active.cursorX, b.buffer.active.cursorY],
    [a.buffer.active.cursorX, a.buffer.active.cursorY],
    'cursor position',
  );
  assert.deepEqual({ ...b.modes }, { ...a.modes }, 'modes');
}

/** The terminal's entry in `list()`, asserted to exist. */
export function info(registry: Registry, termId: string): TerminalInfo {
  const found = registry.list().find((term) => term.id === termId);
  assert.ok(found, `terminal ${termId} is not listed`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Keepers a test's server starts (plan task 28): the same checks as registrySandbox's

/** What `serverKeepers` gives: the platform to start a server on, and the checked signal. */
export interface ServerKeepers {
  /** `base` with its processes wrapped: every program the server starts is noted (pid, start). */
  platform(base: Platform): Platform;
  /** As RegistryBox.keeperOf, for terminal `id` of the server's runtime directory `files`. */
  keeperOf(files: RuntimeFiles, id: string): { pid: number; procStart: number };
  /** As RegistryBox.signalKeeper. */
  signalKeeper(
    keeper: { pid: number; procStart: number },
    signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL',
  ): void;
}

/**
 * The one way a test signals a keeper that its SERVER started (hard rule; as `keeperOf` and
 * `signalKeeper` of registrySandbox, which start their keepers themselves): give the server
 * `platform(…)`; `keeperOf` checks that the terminal's .pid line parses, its pid is a whole number
 * above 1 that is neither this process nor its parent, that the server started that process (the
 * same process start) and that it still runs; `signalKeeper` checks the last two again.
 */
export function serverKeepers(): ServerKeepers {
  /** pid → process start of every program the server started. */
  const started = new Map<number, number>();
  const keeperOf = (files: RuntimeFiles, id: string): { pid: number; procStart: number } => {
    const line = parsePidLine(readFileSync(files.termPid(id), 'utf8'));
    assert.ok(line, `terminal ${id} has no pid line`);
    const { pid, procStart } = line;
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `not a pid to signal: ${pid}`);
    assert.ok(pid !== process.pid && pid !== process.ppid, 'never this process or its parent');
    assert.equal(
      started.get(pid),
      procStart,
      `pid ${pid} is not a keeper this test's server started`,
    );
    assert.ok(stillRuns(pid, procStart), `keeper ${pid} no longer runs`);
    return { pid, procStart };
  };
  return {
    platform: (base) => ({
      ...base,
      processes: {
        ...base.processes,
        async startDetached(command, args, options) {
          const child = await base.processes.startDetached(command, args, options);
          const start = procStartOf(child.pid);
          if (start !== null) started.set(child.pid, start);
          return child;
        },
      },
    }),
    keeperOf,
    signalKeeper(keeper, signal) {
      assert.equal(
        started.get(keeper.pid),
        keeper.procStart,
        "a keeper this test's server started",
      );
      assert.ok(stillRuns(keeper.pid, keeper.procStart), `keeper ${keeper.pid} no longer runs`);
      process.kill(keeper.pid, signal);
    },
  };
}
