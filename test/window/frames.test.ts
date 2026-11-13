import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isSessionId } from '../../src/claude/launch.ts';
import {
  KEEPER_PROTOCOL,
  MAX_PAYLOAD,
  decodeSnapshot,
  encodeFrame,
  encodeResize,
  encodeSnapshot,
  frameReader,
  parseExit,
  parseHello,
  parseResize,
  parseStarted,
} from '../../src/window/frames.ts';
import type { Frame, FrameType, KeeperExit, KeeperHello } from '../../src/window/frames.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const TERM = '0123456789ab';
const MARKER = 'MARKER-7f3a';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const json = (value: unknown): Uint8Array => utf8(JSON.stringify(value));

/** Every chunk of `bytes` of at most `size` bytes, in order. */
function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.slice(at, at + size));
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pushes every chunk; fails the test on an error; returns all frames. */
function readAll(parts: Uint8Array[]): Frame[] {
  const reader = frameReader();
  const frames: Frame[] = [];
  for (const part of parts) {
    const result = reader.push(part);
    assert.ok(Array.isArray(result), `unexpected ${JSON.stringify(result)}`);
    frames.push(...result);
  }
  return frames;
}

/** A frame header announcing `length` bytes of type `type`. */
function header(type: string, length: number): Uint8Array {
  const bytes = new Uint8Array(5);
  bytes[0] = type.charCodeAt(0);
  new DataView(bytes.buffer).setUint32(1, length);
  return bytes;
}

function refused(result: { ok: boolean; kind?: string }): string {
  assert.equal(result.ok, false);
  assert.equal(typeof result.kind, 'string');
  const kind = result.kind as string;
  assert.ok(kind.length > 0);
  assert.ok(!kind.includes(MARKER), `kind ${JSON.stringify(kind)} quotes the input`);
  return kind;
}

describe('constants', () => {
  test('protocol 1, payloads up to 16 MiB', () => {
    assert.equal(KEEPER_PROTOCOL, 1);
    assert.equal(MAX_PAYLOAD, 16 * 1024 * 1024);
  });
});

describe('encodeFrame', () => {
  test('type byte, 4-byte big-endian length, payload', () => {
    assert.deepEqual(
      encodeFrame('D', new Uint8Array([7, 8, 9])),
      new Uint8Array([0x44, 0, 0, 0, 3, 7, 8, 9]),
    );
  });

  test('a length above 255 is big-endian', () => {
    const frame = encodeFrame('I', new Uint8Array(0x0102));
    assert.deepEqual([...frame.subarray(0, 5)], [0x49, 0, 0, 1, 2]);
    assert.equal(frame.length, 5 + 0x0102);
  });

  test('no payload is an empty one', () => {
    assert.deepEqual(encodeFrame('C'), new Uint8Array([0x43, 0, 0, 0, 0]));
    assert.deepEqual(encodeFrame('A', new Uint8Array(0)), new Uint8Array([0x41, 0, 0, 0, 0]));
  });

  test('a payload of exactly MAX_PAYLOAD is allowed, one byte more is a RangeError', () => {
    assert.equal(encodeFrame('D', new Uint8Array(MAX_PAYLOAD)).length, 5 + MAX_PAYLOAD);
    assert.throws(() => encodeFrame('D', new Uint8Array(MAX_PAYLOAD + 1)), RangeError);
  });

  test('a type it does not know is a RangeError', () => {
    assert.throws(() => encodeFrame('Q' as FrameType), RangeError);
  });
});

describe('frameReader', () => {
  const three: Frame[] = [
    { type: 'H', payload: json({ protocol: 1, id: TERM }) },
    { type: 'C', payload: new Uint8Array(0) },
    { type: 'D', payload: new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256)) },
  ];
  const stream = concat(...three.map((f) => encodeFrame(f.type, f.payload)));

  for (const size of [1, 3, 1000]) {
    test(`three frames pushed in chunks of ${size} bytes come out whole`, () => {
      assert.deepEqual(readAll(chunks(stream, size)), three);
    });
  }

  test('a frame split across pushes comes out once, when complete', () => {
    const reader = frameReader();
    const frame = encodeFrame('D', utf8('hello'));
    assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
    assert.deepEqual(reader.push(frame.subarray(2, 7)), []);
    assert.deepEqual(reader.push(frame.subarray(7)), [{ type: 'D', payload: utf8('hello') }]);
  });

  test('an empty push returns no frames', () => {
    assert.deepEqual(frameReader().push(new Uint8Array(0)), []);
  });

  test('every type of protocol 1 is read', () => {
    const types: FrameType[] = ['C', 'H', 'G', 'T', 'N', 'S', 'D', 'R', 'X', 'I', 'Z', 'P', 'A'];
    const frames = readAll([concat(...types.map((t) => encodeFrame(t, utf8(t))))]);
    assert.deepEqual(
      frames.map((f) => f.type),
      types,
    );
  });

  test('an unknown type byte is an error as soon as it arrives', () => {
    assert.deepEqual(frameReader().push(new Uint8Array([0x51])), { error: 'unknown-type' });
  });

  test('a length above MAX_PAYLOAD is an error before the payload arrives', () => {
    assert.deepEqual(frameReader().push(header('D', MAX_PAYLOAD + 1)), { error: 'too-long' });
  });

  test('a length of exactly MAX_PAYLOAD waits for the payload', () => {
    assert.deepEqual(frameReader().push(header('D', MAX_PAYLOAD)), []);
  });

  test('the reader stays unusable after an error', () => {
    const reader = frameReader();
    assert.deepEqual(reader.push(new Uint8Array([0x51, 0, 0, 0, 0])), { error: 'unknown-type' });
    assert.deepEqual(reader.push(encodeFrame('C')), { error: 'unknown-type' });
    const long = frameReader();
    assert.deepEqual(long.push(header('D', MAX_PAYLOAD + 1)), { error: 'too-long' });
    assert.deepEqual(long.push(encodeFrame('C')), { error: 'too-long' });
  });

  test('an error after a complete frame in the same push is still an error', () => {
    const reader = frameReader();
    assert.deepEqual(reader.push(concat(encodeFrame('C'), new Uint8Array([0x51]))), {
      error: 'unknown-type',
    });
  });

  test('a chunk reused after push returns does not change a frame still incomplete', () => {
    const frame = encodeFrame('D', utf8('hello'));
    const buffer = new Uint8Array(frame.length);
    const reader = frameReader();
    buffer.set(frame.subarray(0, 7));
    assert.deepEqual(reader.push(buffer.subarray(0, 7)), []);
    buffer.fill(0x5a);
    buffer.set(frame.subarray(7));
    assert.deepEqual(reader.push(buffer.subarray(0, frame.length - 7)), [
      { type: 'D', payload: utf8('hello') },
    ]);
  });

  test('a chunk reused after only part of a header was pushed does not change the header', () => {
    const frames = concat(encodeFrame('D', utf8('hi')), encodeFrame('C'));
    const buffer = new Uint8Array(frames.length);
    const reader = frameReader();
    buffer.set(frames.subarray(0, 4));
    assert.deepEqual(reader.push(buffer.subarray(0, 4)), []);
    buffer.fill(0xff);
    buffer.set(frames.subarray(4));
    assert.deepEqual(reader.push(buffer.subarray(0, frames.length - 4)), [
      { type: 'D', payload: utf8('hi') },
      { type: 'C', payload: new Uint8Array(0) },
    ]);
  });

  test('chunks left over from earlier pushes stay intact when the latest is reused', () => {
    const frame = encodeFrame('D', utf8('abcdefgh'));
    const reader = frameReader();
    const parts = [frame.slice(0, 3), frame.slice(3, 6), frame.slice(6, 9)];
    for (const part of parts) {
      assert.deepEqual(reader.push(part), []);
      part.fill(0);
    }
    assert.deepEqual(reader.push(frame.slice(9)), [{ type: 'D', payload: utf8('abcdefgh') }]);
  });

  test('a payload does not change when the pushed chunk is changed later', () => {
    const reader = frameReader();
    const chunk = encodeFrame('D', new Uint8Array([1, 2, 3]));
    const frames = reader.push(chunk);
    chunk.fill(0);
    assert.deepEqual(frames, [{ type: 'D', payload: new Uint8Array([1, 2, 3]) }]);
  });
});

describe('snapshots (S and P)', () => {
  test('8-byte record number, 2-byte cols, 2-byte rows, UTF-8, all big-endian', () => {
    assert.deepEqual(
      encodeSnapshot(2 ** 40, 120, 40, 'é'),
      new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0, 0, 120, 0, 40, 0xc3, 0xa9]),
    );
  });

  test('round-trips through decodeSnapshot', () => {
    assert.deepEqual(decodeSnapshot(encodeSnapshot(2 ** 40, 120, 40, 'é')), {
      seq: 2 ** 40,
      cols: 120,
      rows: 40,
      data: 'é',
    });
    assert.deepEqual(decodeSnapshot(encodeSnapshot(0, 1, 1, '')), {
      seq: 0,
      cols: 1,
      rows: 1,
      data: '',
    });
    const big = Number.MAX_SAFE_INTEGER;
    assert.equal(decodeSnapshot(encodeSnapshot(big, 65535, 65535, 'x'))?.seq, big);
  });

  test('decodes a payload that is a view into a larger buffer (a frame read off a socket)', () => {
    const frame = encodeFrame('S', encodeSnapshot(2 ** 40, 120, 40, 'é'));
    assert.deepEqual(decodeSnapshot(frame.subarray(5)), {
      seq: 2 ** 40,
      cols: 120,
      rows: 40,
      data: 'é',
    });
  });

  test('a payload shorter than 12 bytes is null', () => {
    assert.equal(decodeSnapshot(new Uint8Array(0)), null);
    assert.equal(decodeSnapshot(new Uint8Array(11)), null);
  });

  test('a record number beyond a safe integer is null', () => {
    const bytes = encodeSnapshot(1, 80, 24, '');
    new DataView(bytes.buffer).setBigUint64(0, 2n ** 53n);
    assert.equal(decodeSnapshot(bytes), null);
  });

  test('a size of 0 is null', () => {
    assert.equal(decodeSnapshot(concat(new Uint8Array(8), new Uint8Array([0, 0, 0, 24]))), null);
    assert.equal(decodeSnapshot(concat(new Uint8Array(8), new Uint8Array([0, 80, 0, 0]))), null);
  });

  test('a snapshot that is not UTF-8 is null', () => {
    const bytes = concat(encodeSnapshot(1, 80, 24, ''), new Uint8Array([0xff, 0xfe]));
    assert.equal(decodeSnapshot(bytes), null);
  });

  test('encodeSnapshot refuses what the layout cannot hold', () => {
    assert.throws(() => encodeSnapshot(-1, 80, 24, ''), RangeError);
    assert.throws(() => encodeSnapshot(1.5, 80, 24, ''), RangeError);
    assert.throws(() => encodeSnapshot(2 ** 53, 80, 24, ''), RangeError);
    assert.throws(() => encodeSnapshot(1, 0, 24, ''), RangeError);
    assert.throws(() => encodeSnapshot(1, 80, 65536, ''), RangeError);
  });
});

describe('encodeResize (Z)', () => {
  test('"<cols> <rows>" in ASCII', () => {
    assert.deepEqual(encodeResize(120, 40), utf8('120 40'));
  });

  test('a size outside 1–65535 or not whole is a RangeError', () => {
    assert.throws(() => encodeResize(0, 40), RangeError);
    assert.throws(() => encodeResize(120, 65536), RangeError);
    assert.throws(() => encodeResize(12.5, 40), RangeError);
  });
});

const META = {
  sessionId: S1,
  kind: 'resume',
  slot: 3,
  openedNs: '1700000000000000000',
  build: '0123456789abcdef',
  label: 'ORB-2107 fix',
  dir: '/home/u/project',
} as const;

const HELLO: KeeperHello = {
  protocol: 1,
  keeper: '1',
  id: TERM,
  started: true,
  startBy: '1700000055000000000',
  lock: '1700000000000000000:42',
  pid: 4242,
  procStart: 51234567,
  cols: 120,
  rows: 40,
  seq: 17,
  snapSeq: 12,
  gap: false,
  meta: { ...META },
  exited: null,
};

const EXIT: KeeperExit = { code: 0, signal: null, atNs: '1700000100000000000', notStarted: null };

describe('parseHello', () => {
  test('the fields of 2.3 → ok', () => {
    assert.deepEqual(parseHello(json(HELLO)), { ok: true, value: HELLO });
  });

  test('a keeper that never started, with its exit', () => {
    const hello: KeeperHello = {
      ...HELLO,
      started: false,
      lock: null,
      pid: null,
      procStart: null,
      seq: 0,
      snapSeq: 0,
      meta: { ...META, kind: 'new', slot: null, label: null },
      exited: { code: null, signal: null, atNs: '1', notStarted: 'the deadline passed' },
    };
    assert.deepEqual(parseHello(json(hello)), { ok: true, value: hello });
  });

  test('protocol 2 → ok: the caller decides (S2 7.7)', () => {
    assert.deepEqual(parseHello(json({ ...HELLO, protocol: 2 })), {
      ok: true,
      value: { ...HELLO, protocol: 2 },
    });
  });

  test('a field it does not know is ignored, for later keeper versions', () => {
    const result = parseHello(json({ ...HELLO, later: MARKER, meta: { ...META, later: 1 } }));
    assert.deepEqual(result, { ok: true, value: HELLO });
  });

  const bad: [string, unknown][] = [
    ['pid a string', { ...HELLO, pid: MARKER }],
    ['meta missing', { ...HELLO, meta: undefined }],
    ['meta not an object', { ...HELLO, meta: [MARKER] }],
    ['protocol missing', { ...HELLO, protocol: undefined }],
    ['protocol not whole', { ...HELLO, protocol: 1.5 }],
    ['an id that is not a terminal id', { ...HELLO, id: MARKER }],
    ['an upper-case id', { ...HELLO, id: TERM.toUpperCase() }],
    ['started not a boolean', { ...HELLO, started: 1 }],
    ['startBy not decimal', { ...HELLO, startBy: `1${MARKER}` }],
    ['startBy a number', { ...HELLO, startBy: 1700000055000000000 }],
    ['startBy beyond 64 bits', { ...HELLO, startBy: '9223372036854775808' }],
    ['startBy with a leading zero', { ...HELLO, startBy: '01' }],
    ['lock a number', { ...HELLO, lock: 42 }],
    ['pid 0', { ...HELLO, pid: 0 }],
    ['started without a pid', { ...HELLO, pid: null, procStart: null }],
    ['a pid without started', { ...HELLO, started: false }],
    ['a pid without procStart', { ...HELLO, procStart: null }],
    ['procStart negative', { ...HELLO, procStart: -1 }],
    ['cols 0', { ...HELLO, cols: 0 }],
    ['rows above 65535', { ...HELLO, rows: 65536 }],
    ['seq negative', { ...HELLO, seq: -1 }],
    ['snapSeq beyond seq', { ...HELLO, snapSeq: 18 }],
    ['gap missing', { ...HELLO, gap: undefined }],
    ['meta.sessionId not a session id', { ...HELLO, meta: { ...META, sessionId: MARKER } }],
    ['meta.kind unknown', { ...HELLO, meta: { ...META, kind: MARKER } }],
    ['meta.slot 0', { ...HELLO, meta: { ...META, slot: 0 } }],
    ['meta.slot 10', { ...HELLO, meta: { ...META, slot: 10 } }],
    ['meta.openedNs a number', { ...HELLO, meta: { ...META, openedNs: 1 } }],
    ['meta.build missing', { ...HELLO, meta: { ...META, build: undefined } }],
    ['meta.label a number', { ...HELLO, meta: { ...META, label: 1 } }],
    ['meta.dir null', { ...HELLO, meta: { ...META, dir: null } }],
    ['exited not an object', { ...HELLO, exited: MARKER }],
    ['exited.atNs missing', { ...HELLO, exited: { ...EXIT, atNs: undefined } }],
    [
      'started, but exited as not started',
      { ...HELLO, exited: { code: null, signal: null, atNs: '1', notStarted: 'x' } },
    ],
    [
      'never started, exited with an empty reason',
      {
        ...HELLO,
        started: false,
        pid: null,
        procStart: null,
        exited: { code: null, signal: null, atNs: '1', notStarted: '' },
      },
    ],
    [
      'never started, but exited with a code',
      { ...HELLO, started: false, pid: null, procStart: null, exited: EXIT },
    ],
  ];
  for (const [name, value] of bad) {
    test(`${name} → refused`, () => {
      refused(parseHello(json(value)));
    });
  }

  test('meta.sessionId follows isSessionId exactly', () => {
    for (const sessionId of [S1, S1.toUpperCase(), S1.replaceAll('-', ''), `${S1}\n`, '']) {
      const result = parseHello(json({ ...HELLO, meta: { ...META, sessionId } }));
      assert.equal(result.ok, isSessionId(sessionId), JSON.stringify(sessionId));
    }
  });

  test('invalid UTF-8, invalid JSON, a JSON array, null → refused, quoting nothing', () => {
    refused(parseHello(concat(utf8(`{"id":"${MARKER}`), new Uint8Array([0xff]), utf8('"}'))));
    refused(parseHello(utf8(`{"id":"${MARKER}`)));
    refused(parseHello(json([MARKER])));
    refused(parseHello(utf8('null')));
    refused(parseHello(new Uint8Array(0)));
  });
});

describe('parseStarted (T)', () => {
  const started = { pid: 4242, procStart: 51234567, atNs: '1700000001000000000' };

  test('{ pid, procStart, atNs } → ok', () => {
    assert.deepEqual(parseStarted(json(started)), { ok: true, value: started });
  });

  for (const [name, value] of [
    ['pid 0', { ...started, pid: 0 }],
    ['pid missing', { ...started, pid: undefined }],
    ['procStart missing', { ...started, procStart: undefined }],
    ['procStart a string', { ...started, procStart: MARKER }],
    ['atNs a number', { ...started, atNs: 1 }],
    ['not an object', [MARKER]],
  ] as [string, unknown][]) {
    test(`${name} → refused`, () => {
      refused(parseStarted(json(value)));
    });
  }

  test('invalid JSON → refused', () => {
    refused(parseStarted(utf8(MARKER)));
  });
});

describe('parseExit (X)', () => {
  test('an exit code → ok', () => {
    assert.deepEqual(parseExit(json(EXIT)), { ok: true, value: EXIT });
  });

  test('a signal → ok', () => {
    const exit = { ...EXIT, code: null, signal: 15 };
    assert.deepEqual(parseExit(json(exit)), { ok: true, value: exit });
  });

  test('never started, with the reason → ok', () => {
    const exit = { code: null, signal: null, atNs: '5', notStarted: 'the server refused' };
    assert.deepEqual(parseExit(json(exit)), { ok: true, value: exit });
  });

  for (const [name, value] of [
    ['code a string', { ...EXIT, code: MARKER }],
    ['code negative', { ...EXIT, code: -15 }],
    ['signal not whole', { ...EXIT, signal: 1.5 }],
    ['atNs negative', { ...EXIT, atNs: '-5' }],
    ['atNs missing', { ...EXIT, atNs: undefined }],
    ['notStarted a number', { ...EXIT, notStarted: 1 }],
    ['notStarted missing', { ...EXIT, notStarted: undefined }],
    ['code above 255', { ...EXIT, code: 256 }],
    ['signal 0', { ...EXIT, code: null, signal: 0 }],
    ['signal above 255', { ...EXIT, code: null, signal: 256 }],
    ['both code and signal', { ...EXIT, code: 0, signal: 15 }],
    ['neither code nor signal, though started', { ...EXIT, code: null }],
    ['not started, with a code', { ...EXIT, notStarted: 'the deadline passed' }],
    ['not started, with a signal', { ...EXIT, code: null, signal: 9, notStarted: 'x' }],
    ['not started, with an empty reason', { ...EXIT, code: null, notStarted: '' }],
  ] as [string, unknown][]) {
    test(`${name} → refused`, () => {
      refused(parseExit(json(value)));
    });
  }
});

describe('parseResize (R)', () => {
  test('JSON { cols, rows } → ok', () => {
    assert.deepEqual(parseResize(json({ cols: 100, rows: 30 })), {
      ok: true,
      value: { cols: 100, rows: 30 },
    });
  });

  for (const [name, payload] of [
    ['cols 0', json({ cols: 0, rows: 30 })],
    ['rows not whole', json({ cols: 100, rows: 1.5 })],
    ['rows missing', json({ cols: 100 })],
    ['cols a string', json({ cols: MARKER, rows: 30 })],
    ["Z's text form", utf8('100 30')],
  ] as [string, Uint8Array][]) {
    test(`${name} → refused`, () => {
      refused(parseResize(payload));
    });
  }
});
