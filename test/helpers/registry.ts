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
import { KEEPER, keeperSandbox, stillRuns, until } from './keeper.ts';
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
  /** A registry over the box's runtime directory; `platform` replaces the box's (its net is wrapped). */
  registry(options?: { platform?: Platform }): TestRegistry;
  /** A spec for the stand-in in this box (argv, env, record), as keeperSandbox makes it. */
  spec(overrides?: Partial<KeeperSpec>): KeeperSpec;
}

/**
 * Call first in a test. The cleanup is registered before keeperSandbox's (t.after runs first in,
 * first out): registries are stopped, keepers killed and programs waited for before the sandbox goes.
 */
export async function registrySandbox(t: TestContext): Promise<RegistryBox> {
  const registries: TestRegistry[] = [];
  const programs = new Map<number, number>();
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

  const registry = (options: { platform?: Platform } = {}): TestRegistry => {
    const base = options.platform ?? kb.tp.platform;
    const sockets: Socket[] = [];
    let refusing = false;
    const platform: Platform = {
      ...base,
      net: {
        ...base.net,
        async connectUnix(path) {
          if (refusing) {
            throw Object.assign(new Error('dropped registry'), { code: 'EDROPPED' });
          }
          const socket = await base.net.connectUnix(path);
          sockets.push(socket);
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
    }
    const events: Events = { hello: [], started: [], exited: [] };
    const log: string[] = [];
    const states = new Map<string, string[]>();
    const created = createRegistry({
      platform,
      files,
      xterm: { ...modules, Terminal: Spy },
      keeperFile,
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

  return { ...kb, files, keeperFile, modules, registry, spec: kb.spec };
}

// ---------------------------------------------------------------------------------------------
// What a page would show: a headless terminal fed a snapshot and the records after it

export interface Mirror extends StreamSink {
  term: Terminal;
  /** Every call the sink got, in order: 'o' output, 's' size, 'x' exit, 'n' notice. */
  calls: string[];
  outputs: Uint8Array[];
  notices: { kind: string; text: string }[];
  exits: { exit: KeeperExit; lost: boolean }[];
  /** Resolves when everything written so far has been parsed. */
  settled(): Promise<void>;
  text(): string;
}

/** A sink that builds the screen a page would show, starting from `snap`. */
export function mirror(
  modules: XtermModules,
  snap: { cols: number; rows: number; data: string } | null = null,
): Mirror & { start(snap: { cols: number; rows: number; data: string }): void } {
  let term: Terminal | null = null;
  const pending: (() => void)[] = [];
  let decoded = '';
  const decoder = new TextDecoder();
  const m = {
    calls: [] as string[],
    outputs: [] as Uint8Array[],
    notices: [] as { kind: string; text: string }[],
    exits: [] as { exit: KeeperExit; lost: boolean }[],
    get term(): Terminal {
      assert.ok(term, 'the mirror has no snapshot yet');
      return term;
    },
    start(first: { cols: number; rows: number; data: string }) {
      term = new modules.Terminal({
        cols: first.cols,
        rows: first.rows,
        scrollback: 5000,
        allowProposedApi: true,
      });
      term.loadAddon(new modules.UnicodeGraphemesAddon());
      term.write(first.data);
      for (const step of pending.splice(0)) step();
    },
    output(bytes: Uint8Array) {
      m.calls.push('o');
      const copy = bytes.slice();
      m.outputs.push(copy);
      decoded += decoder.decode(copy, { stream: true });
      run(() => m.term.write(copy));
    },
    size(cols: number, rows: number) {
      m.calls.push('s');
      run(() => m.term.resize(cols, rows));
    },
    exit(exit: KeeperExit, lost: boolean) {
      m.calls.push('x');
      m.exits.push({ exit, lost });
    },
    notice(kind: 'gap' | 'newer-keeper' | 'input-full', text: string) {
      m.calls.push('n');
      m.notices.push({ kind, text });
    },
    settled: () => new Promise<void>((resolve) => m.term.write('', resolve)),
    text: () => decoded,
  };
  const run = (step: () => void): void => {
    if (term === null) pending.push(step);
    else step();
  };
  if (snap !== null) m.start(snap);
  return m;
}

/** Attaches a mirror to a terminal of `registry`; resolves once its snapshot is written. */
export async function attachMirror(
  registry: Registry,
  modules: XtermModules,
  termId: string,
): Promise<Mirror & { detach(): void }> {
  const m = mirror(modules);
  const attached = await registry.attach(termId, m);
  assert.ok(attached, `attach ${termId} gave null`);
  m.start(attached);
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
