/**
 * The keeper frames of S2 8.1: the byte layout the server and the python keeper
 * (`bin/skydeck-keeper`) share, and parsers for the keeper's JSON payloads. Pure: no socket, no
 * clock. The keeper's tests drive it through this codec, so both sides are tested against one
 * definition (plan A2).
 *
 * The parsers read foreign input: they never throw and return `{ ok: false, kind }` with a fixed
 * kind that never quotes the payload (plan A22). A field they do not know is ignored, so that a
 * newer keeper's `hello` still reads and the server can tell it is newer (S2 7.7). Every rule they
 * apply is listed in plan 2.3.
 */
import { isSessionId } from '../claude/session-id.ts';

export type FrameType =
  'C' | 'H' | 'G' | 'T' | 'N' | 'S' | 'D' | 'R' | 'X' | 'I' | 'Z' | 'P' | 'A' | 'E';
export const MAX_PAYLOAD = 16 * 1024 * 1024;
export const KEEPER_PROTOCOL = 1;
/**
 * F30: the first keeper version (the hello's `keeper`, a decimal whole number) that knows `E`, the
 * hang-up. A keeper of an older version closes a connection that sends it one (a type it does not
 * know): the server never sends `E` to such a keeper.
 */
export const KEEPER_ENDS_FROM = 3;

/** F30: whether a keeper of this version (the hello's `keeper`) takes `E`. */
export function keeperEnds(version: string): boolean {
  return /^[1-9][0-9]{0,5}$/.test(version) && Number(version) >= KEEPER_ENDS_FROM;
}

export interface Frame {
  type: FrameType;
  payload: Uint8Array;
}

const TYPES: ReadonlySet<string> = new Set('CHGTNSDRXIZPAE');
const HEADER = 5;
const SNAPSHOT_HEADER = 12;
const SIZE_MAX = 0xffff;
const INT64_MAX = 9_223_372_036_854_775_807n;
const NS_TEXT = /^(?:0|[1-9][0-9]{0,18})$/;
const TERMINAL_ID = /^[0-9a-f]{12}$/;
const STATUS_MAX = 255;

/** type byte, 4-byte big-endian length, payload. RangeError above MAX_PAYLOAD. */
export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!TYPES.has(type) || type.length !== 1) throw new RangeError('unknown frame type');
  if (payload.length > MAX_PAYLOAD) throw new RangeError('frame payload above 16 MiB');
  const frame = new Uint8Array(HEADER + payload.length);
  frame[0] = type.charCodeAt(0);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, HEADER);
  return frame;
}

/**
 * Incremental reader; `push` returns the complete frames so far. A type it does not know or a
 * length above MAX_PAYLOAD makes `push` return { error: 'unknown-type' | 'too-long' } and the
 * reader is unusable afterwards (the caller closes the connection). The type is judged as soon as
 * its byte arrives and the length as soon as the header is complete, before any payload. Frames
 * completed earlier in the same push are not returned with an error. Each payload is a copy, and
 * the part of a chunk not yet consumed is copied before `push` returns: the caller may reuse a
 * chunk once `push` returns.
 */
export function frameReader(): {
  push(chunk: Uint8Array): Frame[] | { error: 'unknown-type' | 'too-long' };
} {
  const queue: Uint8Array[] = [];
  let offset = 0; // into queue[0]
  let buffered = 0;
  let current: { type: FrameType; length: number } | null = null;
  let failed: { error: 'unknown-type' | 'too-long' } | null = null;

  function take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = queue[0] as Uint8Array;
      const count = Math.min(chunk.length - offset, n - filled);
      out.set(chunk.subarray(offset, offset + count), filled);
      filled += count;
      offset += count;
      if (offset === chunk.length) {
        queue.shift();
        offset = 0;
      }
    }
    buffered -= n;
    return out;
  }

  function fail(error: 'unknown-type' | 'too-long'): { error: 'unknown-type' | 'too-long' } {
    failed = { error };
    queue.length = 0;
    buffered = 0;
    return failed;
  }

  return {
    push(chunk) {
      if (failed !== null) return failed;
      if (chunk.length > 0) {
        queue.push(chunk);
        buffered += chunk.length;
      }
      const frames: Frame[] = [];
      for (;;) {
        if (current === null) {
          if (buffered === 0) break;
          const type = String.fromCharCode((queue[0] as Uint8Array)[offset] as number);
          if (!TYPES.has(type)) return fail('unknown-type');
          if (buffered < HEADER) break;
          const head = take(HEADER);
          const length = new DataView(head.buffer).getUint32(1);
          if (length > MAX_PAYLOAD) return fail('too-long');
          current = { type: type as FrameType, length };
        }
        if (buffered < current.length) break;
        frames.push({ type: current.type, payload: take(current.length) });
        current = null;
      }
      // Keep no reference to the caller's chunk: copy what is left of it (earlier entries of the
      // queue are such copies already).
      const last = queue.length - 1;
      if (last >= 0 && queue[last] === chunk) {
        queue[last] = last === 0 ? chunk.slice(offset) : chunk.slice();
        if (last === 0) offset = 0;
      }
      return frames;
    },
  };
}

function checkSize(cols: number, rows: number): void {
  if (!isSize(cols) || !isSize(rows)) throw new RangeError('a terminal size is 1–65535');
}

/** S and P: 8-byte record number (big-endian), 2-byte cols, 2-byte rows, the snapshot (UTF-8). */
export function encodeSnapshot(seq: number, cols: number, rows: number, data: string): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('a record number is whole');
  checkSize(cols, rows);
  const text = new TextEncoder().encode(data);
  const payload = new Uint8Array(SNAPSHOT_HEADER + text.length);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, BigInt(seq));
  view.setUint16(8, cols);
  view.setUint16(10, rows);
  payload.set(text, SNAPSHOT_HEADER);
  return payload;
}

/** null for a payload shorter than 12 bytes, a record number beyond a safe integer, a size of 0
 *  or a snapshot that is not UTF-8. */
export function decodeSnapshot(
  payload: Uint8Array,
): { seq: number; cols: number; rows: number; data: string } | null {
  if (payload.length < SNAPSHOT_HEADER) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const seq = view.getBigUint64(0);
  const cols = view.getUint16(8);
  const rows = view.getUint16(10);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER) || cols === 0 || rows === 0) return null;
  const data = utf8(payload.subarray(SNAPSHOT_HEADER));
  if (data === null) return null;
  return { seq: Number(seq), cols, rows, data };
}

/** Z: "<cols> <rows>" in ASCII. */
export function encodeResize(cols: number, rows: number): Uint8Array {
  checkSize(cols, rows);
  return new TextEncoder().encode(`${cols} ${rows}`);
}

export interface KeeperMeta {
  sessionId: string;
  kind: 'resume' | 'new';
  /** 1–9 (S2 7.6), null for the tenth and later terminals. */
  slot: number | null;
  openedNs: string;
  build: string;
  label: string | null;
  dir: string; // for a new session's own row after a server restart (S2 7.5)
}

/** Written to the keeper's stdin (S2 7.1). */
export interface KeeperSpec {
  protocol: 1;
  id: string;
  socket: string;
  cols: number;
  rows: number;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  startBy: string;
  lock: string | null;
  coreSoft: string | null;
  meta: KeeperMeta;
}

export interface KeeperExit {
  code: number | null;
  signal: number | null;
  atNs: string;
  notStarted: string | null;
}

export interface KeeperHello {
  protocol: number;
  keeper: string;
  id: string;
  started: boolean;
  startBy: string;
  lock: string | null;
  pid: number | null;
  procStart: number | null;
  cols: number;
  rows: number;
  seq: number;
  snapSeq: number;
  /** The number of the first record the tail holds: `snapSeq + 1` unless records were dropped
   *  (then `gap`), `seq + 1` for an empty tail (ruled, task 16). */
  tailFrom: number;
  gap: boolean;
  meta: KeeperMeta;
  exited: KeeperExit | null;
}

export interface KeeperStarted {
  pid: number;
  procStart: number;
  atNs: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; kind: string };

/** Thrown inside the parsers only, caught at their edge; carries a fixed kind. */
class Refusal {
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isSize(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SIZE_MAX;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNsText(value: unknown): value is string {
  return typeof value === 'string' && NS_TEXT.test(value) && BigInt(value) <= INT64_MAX;
}

type Fields = Record<string, unknown>;

/** The payload as a JSON object, or a Refusal named after `where`. */
function payloadObject(where: string, payload: Uint8Array): Fields {
  const text = utf8(payload);
  if (text === null) throw new Refusal(`${where}: not UTF-8`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refusal(`${where}: not JSON`);
  }
  return object(where, value);
}

function object(where: string, value: unknown): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Refusal(`${where}: not an object`);
  }
  return value as Fields;
}

/** Reads one field: missing, wrong type or wrong value become a Refusal. */
function field<T>(
  where: string,
  fields: Fields,
  name: string,
  type: 'string' | 'number' | 'boolean' | 'object',
  valid: (value: never) => boolean = () => true,
  nullable = false,
): T {
  if (!Object.hasOwn(fields, name)) throw new Refusal(`${where}.${name}: missing`);
  const value = fields[name];
  if (value === null && nullable) return null as T;
  const actual = Array.isArray(value) || value === null ? 'other' : typeof value;
  if (actual !== type) throw new Refusal(`${where}.${name}: wrong type`);
  if (!valid(value as never)) throw new Refusal(`${where}.${name}: wrong value`);
  return value as T;
}

function parse<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, kind: error.kind };
    throw error;
  }
}

function isStatus(min: number): (value: number) => boolean {
  return (value) => Number.isInteger(value) && value >= min && value <= STATUS_MAX;
}

/** Exactly one of `code` and `signal` for a program that ran; neither, and a non-empty reason,
 *  for one that never started. */
function readExit(where: string, fields: Fields): KeeperExit {
  const exit: KeeperExit = {
    code: field(where, fields, 'code', 'number', isStatus(0), true),
    signal: field(where, fields, 'signal', 'number', isStatus(1), true),
    atNs: field(where, fields, 'atNs', 'string', isNsText),
    notStarted: field(where, fields, 'notStarted', 'string', (v: string) => v !== '', true),
  };
  const ran = exit.notStarted === null;
  if (
    ran
      ? (exit.code === null) === (exit.signal === null)
      : exit.code !== null || exit.signal !== null
  ) {
    throw new Refusal(`${where}.code: wrong value`);
  }
  return exit;
}

function readMeta(fields: Fields): KeeperMeta {
  const where = 'hello.meta';
  return {
    sessionId: field(where, fields, 'sessionId', 'string', isSessionId),
    kind: field(where, fields, 'kind', 'string', (v: string) => v === 'resume' || v === 'new'),
    slot: field(
      where,
      fields,
      'slot',
      'number',
      (v: number) => Number.isInteger(v) && v >= 1 && v <= 9,
      true,
    ),
    openedNs: field(where, fields, 'openedNs', 'string', isNsText),
    build: field(where, fields, 'build', 'string'),
    label: field(where, fields, 'label', 'string', () => true, true),
    dir: field(where, fields, 'dir', 'string'),
  };
}

export function parseHello(
  payload: Uint8Array,
): { ok: true; value: KeeperHello } | { ok: false; kind: string } {
  return parse(() => {
    const where = 'hello';
    const fields = payloadObject(where, payload);
    const hello: KeeperHello = {
      protocol: field(where, fields, 'protocol', 'number', isCount),
      keeper: field(where, fields, 'keeper', 'string'),
      id: field(where, fields, 'id', 'string', (v: string) => TERMINAL_ID.test(v)),
      started: field(where, fields, 'started', 'boolean'),
      startBy: field(where, fields, 'startBy', 'string', isNsText),
      lock: field(where, fields, 'lock', 'string', () => true, true),
      pid: field(where, fields, 'pid', 'number', (v: number) => isCount(v) && v > 0, true),
      procStart: field(where, fields, 'procStart', 'number', isCount, true),
      cols: field(where, fields, 'cols', 'number', isSize),
      rows: field(where, fields, 'rows', 'number', isSize),
      seq: field(where, fields, 'seq', 'number', isCount),
      snapSeq: field(where, fields, 'snapSeq', 'number', isCount),
      tailFrom: field(where, fields, 'tailFrom', 'number', isCount),
      gap: field(where, fields, 'gap', 'boolean'),
      meta: readMeta(object(`${where}.meta`, field(where, fields, 'meta', 'object'))),
      exited: null,
    };
    const exited = field<object | null>(where, fields, 'exited', 'object', () => true, true);
    if (exited !== null)
      hello.exited = readExit(`${where}.exited`, object(`${where}.exited`, exited));
    // pid and procStart exist exactly when the program was started (S2 8.1).
    if (
      (hello.pid === null) !== (hello.procStart === null) ||
      hello.started !== (hello.pid !== null)
    ) {
      throw new Refusal(`${where}.pid: wrong value`);
    }
    if (hello.snapSeq > hello.seq) throw new Refusal(`${where}.snapSeq: wrong value`);
    // The tail starts right after the snapshot, or later exactly when records were dropped (gap).
    if (
      hello.tailFrom <= hello.snapSeq ||
      hello.tailFrom > hello.seq + 1 ||
      hello.gap !== hello.tailFrom > hello.snapSeq + 1
    ) {
      throw new Refusal(`${where}.tailFrom: wrong value`);
    }
    // A program that started cannot end as not started, nor one that never started otherwise.
    if (hello.exited !== null && hello.started !== (hello.exited.notStarted === null)) {
      throw new Refusal(`${where}.exited: wrong value`);
    }
    return hello;
  });
}

export function parseStarted(
  payload: Uint8Array,
): { ok: true; value: KeeperStarted } | { ok: false; kind: string } {
  return parse(() => {
    const where = 'started';
    const fields = payloadObject(where, payload);
    return {
      pid: field(where, fields, 'pid', 'number', (v: number) => isCount(v) && v > 0),
      procStart: field(where, fields, 'procStart', 'number', isCount),
      atNs: field(where, fields, 'atNs', 'string', isNsText),
    };
  });
}

export function parseExit(
  payload: Uint8Array,
): { ok: true; value: KeeperExit } | { ok: false; kind: string } {
  return parse(() => readExit('exit', payloadObject('exit', payload)));
}

export function parseResize(
  payload: Uint8Array,
): { ok: true; value: { cols: number; rows: number } } | { ok: false; kind: string } {
  return parse(() => {
    const where = 'resize';
    const fields = payloadObject(where, payload);
    return {
      cols: field(where, fields, 'cols', 'number', isSize),
      rows: field(where, fields, 'rows', 'number', isSize),
    };
  });
}
