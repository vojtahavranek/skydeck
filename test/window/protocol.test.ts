import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isSessionId } from '../../src/claude/launch.ts';
import {
  encodeOutputFrame,
  parseControlRequest,
  parsePageMessage,
} from '../../src/window/protocol.ts';
import { MAX_MESSAGE } from '../../src/window/websocket.ts';
import type {
  ActMessage,
  BannerEntryPayload,
  BannerPayload,
  ChipPayload,
  ByeMessage,
  ChallengeMessage,
  ControlRequest,
  ExitMessage,
  FocusMessage,
  KeepAlivePayload,
  LaunchAnswer,
  ListMessage,
  NewRequest,
  NoticeMessage,
  NotifyMessage,
  PageMessage,
  PingAnswer,
  PongMessage,
  RestoreOutcomeLine,
  RestoreRequest,
  RestoreStreamLine,
  ResultMessage,
  RowPayload,
  ServerMessage,
  SizeMessage,
  SnapMessage,
  StatusAnswer,
  TokenAnswer,
  TokenState,
  ViewMessage,
  WelcomeMessage,
} from '../../src/window/protocol.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const TERM = '0123456789ab';
const WINDOW = '0123456789abcdef';
const BOOT = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const NONCE = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8';
const PROOF = 'I2kfIbEbNedSunJ5O-iFTu1xMaucB1TaOXfPgule6rE';
const HEX32 = '0123456789abcdef0123456789abcdef';
const MARKER = 'MARKER-7f3a';

/** Asserts a refusal that quotes nothing of the input; returns its kind. */
function refused(result: { ok: boolean; kind?: string; value?: unknown }): string {
  assert.deepEqual(Object.keys(result), ['ok', 'kind'], `not refused: ${JSON.stringify(result)}`);
  assert.equal(result.ok, false);
  const kind = result.kind as string;
  assert.equal(typeof kind, 'string');
  assert.ok(kind.length > 0);
  assert.ok(!kind.includes(MARKER), `kind ${JSON.stringify(kind)} quotes the input`);
  return kind;
}

const page = (value: unknown): ReturnType<typeof parsePageMessage> =>
  parsePageMessage(JSON.stringify(value));

const VALID: Record<string, PageMessage> = {
  'hello, mode key': { t: 'hello', protocol: 1, mode: 'key', nonce: NONCE, proof: PROOF },
  'hello, mode launch': { t: 'hello', protocol: 1, mode: 'launch', nonce: NONCE, proof: PROOF },
  start: {
    t: 'start',
    assetVersion: '0123456789abcdef',
    windowId: WINDOW,
    focused: true,
    theme: { fg: '#d4d4d4', bg: '#1e1e1e' },
  },
  ping: { t: 'ping', n: 7 },
  view: { t: 'view', filter: 'orb', unfolded: ['earlier'], showDone: false, selected: S1 },
  'view, nothing selected': {
    t: 'view',
    filter: '',
    unfolded: [],
    showDone: true,
    selected: null,
  },
  focus: { t: 'focus', focused: true, selected: S1, area: { cols: 120, rows: 40 } },
  'focus, nothing selected': {
    t: 'focus',
    focused: false,
    selected: null,
    area: { cols: 2, rows: 1 },
  },
  attach: { t: 'attach', term: TERM, cols: 120, rows: 40 },
  detach: { t: 'detach', term: TERM },
  input: { t: 'input', term: TERM, data: 'ls -l\r' },
  'input, binary': { t: 'input', term: TERM, data: '\x1b[M #!\xff', binary: true },
  resize: { t: 'resize', term: TERM, cols: 100, rows: 30 },
  'act resume': { t: 'act', id: 1, kind: 'resume', sessionId: S1, cols: 120, rows: 40 },
  'act new': {
    t: 'act',
    id: 2,
    kind: 'new',
    dir: '/home/u/project',
    label: 'ORB-2107 fix',
    group: '',
    flags: "--model opus --append-system-prompt 'be brief'",
    cols: 120,
    rows: 40,
  },
  'act close-terminal': { t: 'act', id: 3, kind: 'close-terminal', term: TERM },
  'act open-link': { t: 'act', id: 0, kind: 'open-link', url: 'https://github.com/a/b/pull/1' },
  // Stage D (plan D 2.2).
  'act label': { t: 'act', id: 4, kind: 'label', sessionId: S1, text: 'ORB-2107 fix the login' },
  'act label, empty (clears it)': { t: 'act', id: 5, kind: 'label', sessionId: S1, text: '' },
  'act group': { t: 'act', id: 6, kind: 'group', sessionId: S1, text: 'ORB-2107' },
  'act note': {
    t: 'act',
    id: 7,
    kind: 'note',
    sessionId: S1,
    text: 'first line\nsecond\r\nthird',
    base: 'first line',
  },
  'act done': { t: 'act', id: 8, kind: 'done', sessionId: S1 },
  'act undone': { t: 'act', id: 9, kind: 'undone', sessionId: S1 },
  'act pr-refresh': { t: 'act', id: 10, kind: 'pr-refresh', sessionId: S1 },
  'act pr-add': {
    t: 'act',
    id: 11,
    kind: 'pr-add',
    sessionId: S1,
    url: 'https://github.com/a/b/pull/7',
  },
  'act pr-rm': {
    t: 'act',
    id: 12,
    kind: 'pr-rm',
    sessionId: S1,
    url: 'https://github.com/a/b/pull/7',
  },
};

/** The stage D act kinds that name a session (plan D 2.2), one valid message of each. */
const STAGE_D_ACTS = [
  'act label',
  'act group',
  'act note',
  'act done',
  'act undone',
  'act pr-refresh',
  'act pr-add',
  'act pr-rm',
] as const;

/** A value of another JSON type than `value`. */
function wrongType(value: unknown): unknown {
  if (typeof value === 'string') return 42;
  if (typeof value === 'number') return '42';
  if (typeof value === 'boolean') return 'true';
  if (value === null) return 42;
  if (Array.isArray(value)) return { 0: 'x' };
  return ['x'];
}

describe('parsePageMessage: every page message of stages A and D', () => {
  for (const [name, message] of Object.entries(VALID)) {
    test(`${name} → ok and equal`, () => {
      assert.deepEqual(parsePageMessage(JSON.stringify(message)), { ok: true, value: message });
    });

    test(`${name} with an unknown field → refused`, () => {
      refused(page({ ...message, [MARKER]: 1 }));
    });

    for (const field of Object.keys(message)) {
      if (field !== 'binary') {
        test(`${name} without ${field} → refused`, () => {
          const copy: Record<string, unknown> = { ...message };
          delete copy[field];
          refused(page(copy));
        });
      }
      test(`${name} with ${field} of a wrong type → refused`, () => {
        refused(page({ ...message, [field]: wrongType((message as never)[field]) }));
      });
    }
  }

  test('nested objects are strict too', () => {
    const start = VALID['start'] as PageMessage & { t: 'start' };
    refused(page({ ...start, theme: { ...start.theme, [MARKER]: 1 } }));
    refused(page({ ...start, theme: { fg: '#ffffff' } }));
    refused(page({ ...start, theme: { fg: '#ffffff', bg: null } }));
    const focus = VALID['focus'] as FocusMessage;
    refused(page({ ...focus, area: { ...focus.area, [MARKER]: 1 } }));
    refused(page({ ...focus, area: { cols: 120 } }));
    refused(page({ ...focus, area: null }));
  });
});

describe('parsePageMessage: what is refused', () => {
  test('a type it does not know, or none', () => {
    refused(page({ t: MARKER }));
    refused(page({ t: 'notify', sessionId: S1 }));
    refused(page({ n: 1 }));
    refused(page({ t: 'welcome' }));
  });

  test('act kinds it does not know (stage D adds label, group, note, done, undone, pr-add, pr-rm and pr-refresh; stage C restore and dismiss-restore, at the end of this file)', () => {
    for (const kind of ['Label', 'Restore', MARKER]) {
      refused(page({ t: 'act', id: 1, kind, sessionId: S1, text: 'x' }));
      refused(page({ t: 'act', id: 1, kind, sessionId: S1 }));
    }
    refused(page({ t: 'act', id: 1, sessionId: S1, cols: 120, rows: 40 }));
  });

  test("a stage D act with another kind's fields: done carries no text, label no base, note needs its base", () => {
    refused(page({ ...VALID['act done'], text: 'x' }));
    refused(page({ ...VALID['act pr-refresh'], url: 'https://github.com/a/b/pull/7' }));
    refused(page({ ...VALID['act label'], base: '' }));
    refused(page({ ...VALID['act group'], url: 'https://github.com/a/b/pull/7' }));
    refused(page({ t: 'act', id: 1, kind: 'note', sessionId: S1, text: 'x' }));
    refused(page({ ...VALID['act pr-add'], text: 'https://github.com/a/b/pull/7' }));
    refused(page({ t: 'act', id: 1, kind: 'pr-rm', sessionId: S1 }));
  });

  test('every stage D act names a session by isSessionId exactly', () => {
    for (const name of STAGE_D_ACTS) {
      for (const sessionId of [BOOT.toUpperCase(), S1.slice(1), `${S1}\n`, `{${S1}}`, MARKER, '']) {
        refused(page({ ...VALID[name], sessionId }));
      }
      assert.equal(page({ ...VALID[name], sessionId: BOOT }).ok, true, name);
    }
  });

  test("a stage D act's text that is not well formed (a lone surrogate) is refused", () => {
    const lone = (field: string, name: string): string => {
      const message: Record<string, unknown> = { ...VALID[name], [field]: 'LONE' };
      return JSON.stringify(message).replace('"LONE"', '"a\\ud800b"');
    };
    for (const [name, field] of [
      ['act label', 'text'],
      ['act group', 'text'],
      ['act note', 'text'],
      ['act note', 'base'],
      ['act pr-add', 'url'],
      ['act pr-rm', 'url'],
    ] as const) {
      refused(parsePageMessage(lone(field, name)));
      assert.equal(parsePageMessage(lone(field, name).replace('\\ud800', 'x')).ok, true);
    }
  });

  test("stage A's view has no chips", () => {
    refused(page({ ...VALID['view'], chips: [] }));
  });

  test('invalid JSON, a JSON array and other values that are not objects', () => {
    for (const text of [
      `{"t":"${MARKER}`,
      `["${MARKER}"]`,
      'null',
      '1',
      '"ping"',
      '',
      `${MARKER}`,
    ]) {
      refused(parsePageMessage(text));
    }
  });

  test('a key named __proto__ is an unknown field', () => {
    refused(parsePageMessage('{"t":"ping","n":1,"__proto__":{"x":1}}'));
  });

  test('a string that is not well formed (a lone surrogate)', () => {
    refused(
      parsePageMessage(
        '{"t":"view","filter":"\\ud800","unfolded":[],"showDone":false,"selected":null}',
      ),
    );
    refused(parsePageMessage(`{"t":"input","term":"${TERM}","data":"a\\udc00"}`));
  });

  test('hello: any protocol number is read (the server answers 4426), only key and launch', () => {
    const hello = VALID['hello, mode key'];
    assert.deepEqual(page({ ...hello, protocol: 2 }), {
      ok: true,
      value: { ...hello, protocol: 2 },
    });
    refused(page({ ...hello, protocol: -1 }));
    refused(page({ ...hello, protocol: 1.5 }));
    refused(page({ ...hello, mode: MARKER }));
  });

  test('ids: terminal ids are 12 lower-case hex, window ids 16', () => {
    for (const term of [TERM.toUpperCase(), TERM.slice(1), `${TERM}0`, MARKER]) {
      refused(page({ ...VALID['attach'], term }));
      refused(page({ ...VALID['act close-terminal'], term }));
    }
    for (const windowId of [WINDOW.toUpperCase(), WINDOW.slice(1), MARKER]) {
      refused(page({ ...VALID['start'], windowId }));
    }
  });

  test('session ids follow isSessionId exactly', () => {
    const ids = [
      S1,
      BOOT,
      S1.toUpperCase(),
      S1.replaceAll('-', ''),
      `{${S1}}`,
      ` ${S1}`,
      `${S1}\n`,
      S1.slice(1),
      MARKER,
      '',
    ];
    for (const sessionId of ids) {
      const message = { ...VALID['act resume'], sessionId };
      const result = page(message);
      assert.equal(result.ok, isSessionId(sessionId), JSON.stringify(sessionId));
      if (!result.ok) refused(result);
      assert.equal(page({ ...VALID['view'], selected: sessionId }).ok, isSessionId(sessionId));
      assert.equal(page({ ...VALID['focus'], selected: sessionId }).ok, isSessionId(sessionId));
    }
  });

  test('sizes are whole numbers 1–65535', () => {
    for (const cols of [0, -1, 1.5, 65536]) {
      refused(page({ ...VALID['attach'], cols }));
      refused(page({ ...VALID['resize'], rows: cols }));
      refused(page({ ...VALID['act resume'], cols }));
      refused(page({ ...VALID['act new'], rows: cols }));
      refused(page({ ...VALID['focus'], area: { cols, rows: 40 } }));
    }
    assert.equal(page({ ...VALID['attach'], cols: 65535, rows: 1 }).ok, true);
  });

  test('counters are whole numbers from 0', () => {
    refused(page({ t: 'ping', n: -1 }));
    refused(page({ t: 'ping', n: 1.5 }));
    refused(page({ t: 'ping', n: 2 ** 53 }));
    refused(page({ ...VALID['act open-link'], id: -1 }));
  });

  test("every act's id is a whole number from 0 (stage A's and stage D's kinds alike)", () => {
    const acts = Object.entries(VALID).filter(([, message]) => message.t === 'act');
    assert.equal(acts.length, 13);
    for (const [name, message] of acts) {
      for (const id of [-1, 1.5, 2 ** 53]) {
        refused(page({ ...message, id }));
      }
      assert.equal(page({ ...message, id: Number.MAX_SAFE_INTEGER }).ok, true, name);
    }
  });

  test('unfolded holds section names, each once', () => {
    assert.equal(page({ ...VALID['view'], unfolded: ['open', 'week', 'earlier'] }).ok, true);
    refused(page({ ...VALID['view'], unfolded: [MARKER] }));
    refused(page({ ...VALID['view'], unfolded: ['earlier', 'earlier'] }));
    refused(page({ ...VALID['view'], unfolded: [1] }));
  });

  test('input: binary is true or absent; a binary string holds bytes only', () => {
    refused(page({ ...VALID['input'], binary: false }));
    refused(page({ ...VALID['input, binary'], data: 'éĀ' }));
  });
});

describe('parsePageMessage: string limits, in UTF-8 bytes', () => {
  const cases: [string, PageMessage, string, number][] = [
    ['view.filter', VALID['view'] as PageMessage, 'filter', 1024],
    ['hello.nonce', VALID['hello, mode key'] as PageMessage, 'nonce', 1024],
    ['hello.proof', VALID['hello, mode key'] as PageMessage, 'proof', 1024],
    ['start.assetVersion', VALID['start'] as PageMessage, 'assetVersion', 1024],
    ['act new.dir (a path)', VALID['act new'] as PageMessage, 'dir', 4096],
    ['act new.label', VALID['act new'] as PageMessage, 'label', 1024],
    ['act new.group', VALID['act new'] as PageMessage, 'group', 1024],
    ['act new.flags', VALID['act new'] as PageMessage, 'flags', 1024],
    [
      'act open-link.url (S2 9.6 opens up to 2,048 characters)',
      VALID['act open-link'] as PageMessage,
      'url',
      4096,
    ],
    ['act label.text', VALID['act label'] as PageMessage, 'text', 1024],
    ['act group.text', VALID['act group'] as PageMessage, 'text', 1024],
    ['act note.text (plan D5)', VALID['act note'] as PageMessage, 'text', 65536],
    ['act note.base (plan D5)', VALID['act note'] as PageMessage, 'base', 65536],
    ['act pr-add.url (a URL)', VALID['act pr-add'] as PageMessage, 'url', 4096],
    ['act pr-rm.url (a URL)', VALID['act pr-rm'] as PageMessage, 'url', 4096],
  ];
  for (const [name, message, field, limit] of cases) {
    test(`${name}: ${limit} bytes ok, one more refused`, () => {
      assert.equal(page({ ...message, [field]: 'a'.repeat(limit) }).ok, true);
      refused(page({ ...message, [field]: MARKER.repeat(Math.ceil((limit + 1) / MARKER.length)) }));
      refused(page({ ...message, [field]: 'a'.repeat(limit + 1) }));
      // Two bytes per character: half the limit in characters is the whole limit in bytes.
      assert.equal(page({ ...message, [field]: 'é'.repeat(limit / 2) }).ok, true);
      refused(page({ ...message, [field]: 'é'.repeat(limit / 2 + 1) }));
      // Three bytes per character (€, CJK): the limit is exact, never a count of characters.
      const threes = Math.floor(limit / 3);
      const exact = '€'.repeat(threes) + 'a'.repeat(limit - 3 * threes);
      assert.equal(page({ ...message, [field]: exact }).ok, true);
      refused(page({ ...message, [field]: '€'.repeat(threes + 1) }));
      // Four bytes per character (a surrogate pair).
      assert.equal(page({ ...message, [field]: '🙂'.repeat(limit / 4) }).ok, true);
      refused(page({ ...message, [field]: `${'🙂'.repeat(limit / 4)}a` }));
    });
  }

  test('a note act with text and base both at their limit, every character escaped by JSON (U+0001: six bytes), is under the WebSocket message limit (plan D5)', () => {
    const full = '\u0001'.repeat(65536);
    const message = { ...VALID['act note'], text: full, base: full };
    const json = JSON.stringify(message);
    assert.ok(Buffer.byteLength(json, 'utf8') >= 2 * 6 * 65536, 'JSON escapes U+0001 in six bytes');
    assert.ok(Buffer.byteLength(json, 'utf8') <= MAX_MESSAGE, `${Buffer.byteLength(json)} bytes`);
    assert.deepEqual(parsePageMessage(json), { ok: true, value: message });
  });

  test('theme colours are text fields', () => {
    const start = VALID['start'] as PageMessage & { t: 'start' };
    refused(page({ ...start, theme: { fg: 'a'.repeat(1025), bg: '#000000' } }));
  });

  test('input.data: 64 KiB of UTF-8 ok, 64 KiB + 1 byte refused', () => {
    const input = VALID['input'] as PageMessage;
    assert.equal(page({ ...input, data: 'a'.repeat(65536) }).ok, true);
    refused(page({ ...input, data: `${'a'.repeat(65536)}b` }));
    assert.equal(page({ ...input, data: 'é'.repeat(32768) }).ok, true);
    refused(page({ ...input, data: 'é'.repeat(32769) }));
    assert.equal(page({ ...input, data: '🙂'.repeat(16384) }).ok, true);
    refused(page({ ...input, data: `${'🙂'.repeat(16384)}a` }));
  });

  test('input.data with binary: 65,536 bytes ok, one more refused', () => {
    const input = VALID['input, binary'] as PageMessage;
    assert.equal(page({ ...input, data: '\xff'.repeat(65536) }).ok, true);
    refused(page({ ...input, data: '\xff'.repeat(65537) }));
  });
});

describe('parseControlRequest', () => {
  const routes: [string, string, string, ControlRequest][] = [
    ['GET', '/ping', '', { route: 'ping' }],
    ['GET', '/status', '', { route: 'status' }],
    ['POST', '/shutdown', '', { route: 'shutdown' }],
    ['POST', '/shutdown', '{}', { route: 'shutdown' }],
    ['POST', '/token', '{"seconds":30}', { route: 'token', seconds: 30 }],
    ['POST', '/token', '{"seconds":600}', { route: 'token', seconds: 600 }],
    ['GET', `/token/${HEX32}`, '', { route: 'token-state', id: HEX32 }],
    ['POST', '/token/drop', `{"id":"${HEX32}"}`, { route: 'token-drop', id: HEX32 }],
  ];
  for (const [method, path, body, value] of routes) {
    test(`${method} ${path} ${body} → ${value.route}`, () => {
      assert.deepEqual(parseControlRequest(method, path, body), { ok: true, value });
    });
  }

  // Stage C's /resume, /new and /restore are routes: their cases are at the end of this file.
  const noRoute: [string, string, string][] = [
    ['GET', '/', ''],
    ['GET', '/ping/', ''],
    ['GET', '/ping?x=1', ''],
    ['GET', `/${MARKER}`, ''],
    ['GET', `/token/${HEX32.toUpperCase()}`, ''],
    ['GET', `/token/${HEX32.slice(1)}`, ''],
    ['GET', `/token/${HEX32}0`, ''],
    ['GET', `/token/${MARKER}`, ''],
    ['GET', '/token/drop', ''],
    ['POST', '/ping', ''],
    ['GET', '/shutdown', ''],
    ['GET', '/token', ''],
    ['DELETE', `/token/${HEX32}`, ''],
    ['get', '/ping', ''],
    [MARKER, '/ping', ''],
  ];
  for (const [method, path, body] of noRoute) {
    test(`${method} ${path} → refused, kind route…`, () => {
      assert.match(refused(parseControlRequest(method, path, body)), /^route\b/);
    });
  }

  const badBody: [string, string, string][] = [
    ['POST', '/token', '{"seconds":60}'],
    ['POST', '/token', '{"seconds":"30"}'],
    ['POST', '/token', '{"seconds":30.0001}'],
    ['POST', '/token', '{}'],
    ['POST', '/token', `{"seconds":30,"${MARKER}":1}`],
    ['POST', '/token', `{"seconds":30,"x":"${MARKER}"}`],
    ['POST', '/token', `{"seconds":30`],
    ['POST', '/token', ''],
    ['POST', '/token', '[30]'],
    ['POST', '/token', 'null'],
    ['POST', '/token/drop', `{"id":"${MARKER}"}`],
    ['POST', '/token/drop', `{"id":"${HEX32.toUpperCase()}"}`],
    ['POST', '/token/drop', '{}'],
    ['POST', '/token/drop', `{"id":"${HEX32}","seconds":30}`],
    ['GET', '/ping', '{}'],
    ['GET', '/status', MARKER],
    ['GET', `/token/${HEX32}`, '{}'],
    ['POST', '/shutdown', '{"now":true}'],
    ['POST', '/shutdown', 'null'],
    ['POST', '/shutdown', `{"${MARKER}`],
  ];
  for (const [method, path, body] of badBody) {
    test(`${method} ${path} ${body.slice(0, 40)} → refused, kind body…`, () => {
      assert.match(refused(parseControlRequest(method, path, body)), /^body\b/);
    });
  }
});

describe('encodeOutputFrame', () => {
  test('byte 1, the channel as 4-byte big-endian, the bytes', () => {
    assert.deepEqual(
      encodeOutputFrame(7, new Uint8Array([9, 8, 7])),
      new Uint8Array([1, 0, 0, 0, 7, 9, 8, 7]),
    );
    assert.deepEqual(
      encodeOutputFrame(0x01020304, new Uint8Array(0)),
      new Uint8Array([1, 1, 2, 3, 4]),
    );
    assert.deepEqual(
      encodeOutputFrame(2 ** 32 - 1, new Uint8Array(0)).subarray(1),
      new Uint8Array([255, 255, 255, 255]),
    );
  });

  test('a channel that is not a 32-bit unsigned whole number is a RangeError', () => {
    for (const channel of [-1, 2 ** 32, 1.5, Number.NaN]) {
      assert.throws(() => encodeOutputFrame(channel, new Uint8Array(0)), RangeError);
    }
  });
});

describe('types (checked by npm run typecheck)', () => {
  const KEEP_ALIVE: KeepAlivePayload = { mode: 'wsl', state: 'running', since: '1', error: null };
  const ROW: RowPayload = {
    id: S1,
    shortId: S1.slice(0, 8),
    title: 'ORB-2107 fix',
    titleSource: 'label',
    group: 'ORB-2107',
    groupSource: 'title',
    state: 'not-running',
    stateDetail: null,
    sinceNs: '1700000000000000000',
    lastActivityNs: '1700000000000000000',
    dir: '/home/u/project',
    marks: ['crashed'],
    hasNote: true,
    noteHead: ['first line'],
    done: false,
    prs: [
      {
        url: 'https://github.com/a/b/pull/1',
        repo: 'a/b',
        number: 1,
        title: 'Fix',
        level: 'green',
        error: null,
        okAtNs: '1700000000000000000',
      },
    ],
    chip: { level: 'green', open: 1, merged: 0 },
    terminal: null,
    slot: null,
    elsewhere: null,
    starting: false,
    attention: null,
    stack: null,
  };
  const LIST: ListMessage = {
    t: 'list',
    nowNs: '1700000000000000000',
    counts: { working: 0, waiting: 0, running: 1, starting: 0, elsewhere: 0, notRunning: 1 },
    needYou: { count: 0, order: [] },
    sections: [
      { name: 'open', folded: false, firstNs: null, lastNs: null, count: 0, rows: [] },
      { name: 'week', folded: false, firstNs: '1', lastNs: '2', count: 1, rows: [ROW] },
    ],
    doneHidden: 3,
    banner: null,
    terminals: [
      {
        id: TERM,
        slot: 1,
        sessionId: S1,
        state: 'running',
        notReported: false,
        cols: 120,
        rows: 40,
        ownsSize: true,
        openedNs: '1700000000000000000',
      },
    ],
    selected: {
      sessionId: S1,
      command: 'cd /home/u/project && claude --resume 11111111-1111-4111-8111-111111111111',
      flagsKnown: true,
      unknownFlags: [],
      ended: 'exited',
      expiring: false,
      expired: false,
      note: 'first line\nsecond',
      noteTooLong: false,
      ticketUrl: null,
    },
    dirs: ['/home/u/project'],
  };

  test('an object of each ServerMessage type compiles and is plain JSON', () => {
    const messages: ServerMessage[] = [
      { t: 'challenge', protocol: 1, nonce: NONCE } satisfies ChallengeMessage,
      {
        t: 'welcome',
        proof: PROOF,
        key: 'gIGCg4SFhoeIiYqL',
        protocol: 1,
        assetVersion: '0123456789abcdef',
        serverId: WINDOW,
        bootId: BOOT,
        version: '0.1.0',
        keepAlive: KEEP_ALIVE,
        nowNs: '1700000000000000000',
      } satisfies WelcomeMessage,
      { t: 'pong', n: 1, bootId: BOOT, serverId: WINDOW } satisfies PongMessage,
      LIST,
      { t: 'snap', term: TERM, ch: 1, cols: 120, rows: 40, data: 'x' } satisfies SnapMessage,
      { t: 'size', term: TERM, cols: 100, rows: 30, owner: false } satisfies SizeMessage,
      {
        t: 'exit',
        term: TERM,
        code: 0,
        signal: null,
        atNs: '1',
        lost: false,
        notStarted: null,
      } satisfies ExitMessage,
      {
        t: 'result',
        id: 2,
        ok: true,
        lines: [],
        error: null,
        sessionId: S1,
      } satisfies ResultMessage,
      {
        t: 'notice',
        kind: 'tick-failed',
        term: null,
        text: 'skydeck could not refresh the list',
      } satisfies NoticeMessage,
      { t: 'bye', reason: 'stopped' } satisfies ByeMessage,
      {
        t: 'notify',
        sessionId: S1,
        title: 'ORB-2107 fix',
        reason: 'asks',
        detail: 'permission · Bash',
      } satisfies NotifyMessage,
    ];
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), messages);
    assert.deepEqual(
      new Set(messages.map((m) => m.t)),
      new Set([
        'challenge',
        'welcome',
        'pong',
        'list',
        'snap',
        'size',
        'exit',
        'result',
        'notice',
        'bye',
        'notify',
      ]),
    );
  });

  test('a misspelt field does not compile', () => {
    const misspelt = [
      {
        t: 'pong',
        n: 1,
        bootId: BOOT,
        // @ts-expect-error serverID is not a field of pong
        serverID: WINDOW,
      } satisfies PongMessage,
      {
        t: 'result',
        id: 1,
        ok: true,
        lines: [],
        error: null,
        // @ts-expect-error sessionID is not a field of result
        sessionID: S1,
      } satisfies ResultMessage,
      {
        t: 'view',
        filter: '',
        unfolded: [],
        showDone: false,
        selected: null,
        // @ts-expect-error stage A's view has no chips
        chips: [],
      } satisfies ViewMessage,
      {
        level: 'checks-failing',
        open: 1,
        merged: 30,
        // @ts-expect-error stage A's chip had a count; stage D's counts open and merged apart
        count: 31,
      } satisfies ChipPayload,
      {
        t: 'act',
        id: 1,
        kind: 'note',
        sessionId: S1,
        text: 'x',
        // @ts-expect-error a note act's base is `base`
        baseText: '',
      } satisfies ActMessage,
    ];
    assert.equal(misspelt.length, 5);
  });

  test("stage D's act kinds compile with exactly plan D 2.2's fields", () => {
    const acts: ActMessage[] = [
      { t: 'act', id: 1, kind: 'label', sessionId: S1, text: 'x' },
      { t: 'act', id: 2, kind: 'group', sessionId: S1, text: '' },
      { t: 'act', id: 3, kind: 'note', sessionId: S1, text: 'new', base: 'old' },
      { t: 'act', id: 4, kind: 'done', sessionId: S1 },
      { t: 'act', id: 5, kind: 'undone', sessionId: S1 },
      { t: 'act', id: 6, kind: 'pr-refresh', sessionId: S1 },
      { t: 'act', id: 7, kind: 'pr-add', sessionId: S1, url: 'https://github.com/a/b/pull/1' },
      { t: 'act', id: 8, kind: 'pr-rm', sessionId: S1, url: 'https://github.com/a/b/pull/1' },
    ];
    for (const act of acts) {
      assert.deepEqual(parsePageMessage(JSON.stringify(act)), { ok: true, value: act });
    }
  });

  test('the answers of server.sock compile', () => {
    const ping: PingAnswer = {
      serverId: WINDOW,
      bootId: BOOT,
      build: '0123456789abcdef',
      protocol: 1,
      pid: 4242,
      port: 47613,
      checkout: '/home/u/skydeck',
    };
    const status: StatusAnswer = {
      pages: 1,
      terminals: [{ id: TERM, slot: 1, state: 'running', sessionId: S1, pid: 4243 }],
      keepAlive: KEEP_ALIVE,
      python: { found: true, version: '3.12.3' },
      build: '0123456789abcdef',
      checkout: '/home/u/skydeck',
      startedAtNs: '1',
      envOrigin: { dir: '/home/u', atNs: '1' },
    };
    const token: TokenAnswer = { id: HEX32, token: NONCE, expiresAtNs: '1' };
    const states: TokenState[] = ['waiting', 'used', 'reused', 'expired', 'dropped'];
    assert.deepEqual(JSON.parse(JSON.stringify([ping, status, token, states])), [
      ping,
      status,
      token,
      states,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Stage C (plan C 2.2, C3, C9)

/** `n` distinct session ids. */
function sessionIds(n: number): string[] {
  return Array.from(
    { length: n },
    (_, at) => `${at.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
  );
}

/** One valid message of each stage C act kind. */
const STAGE_C_ACTS: Record<string, PageMessage> = {
  'act restore': { t: 'act', id: 13, kind: 'restore', sessionIds: [S1, BOOT] },
  'act dismiss-restore': { t: 'act', id: 14, kind: 'dismiss-restore', bootId: BOOT },
};

describe("parsePageMessage: stage C's acts (plan C 2.2)", () => {
  for (const [name, message] of Object.entries(STAGE_C_ACTS)) {
    test(`${name} → ok and equal`, () => {
      assert.deepEqual(parsePageMessage(JSON.stringify(message)), { ok: true, value: message });
    });

    test(`${name} with an unknown field → refused`, () => {
      refused(page({ ...message, [MARKER]: 1 }));
    });

    for (const field of Object.keys(message)) {
      test(`${name} without ${field} → refused`, () => {
        const copy: Record<string, unknown> = { ...message };
        delete copy[field];
        refused(page(copy));
      });
      test(`${name} with ${field} of a wrong type → refused`, () => {
        refused(page({ ...message, [field]: wrongType((message as never)[field]) }));
      });
    }

    test(`${name}: its id is a whole number from 0`, () => {
      for (const id of [-1, 1.5, 2 ** 53]) {
        refused(page({ ...message, id }));
      }
      assert.equal(page({ ...message, id: Number.MAX_SAFE_INTEGER }).ok, true);
    });
  }

  test('act restore: 1 to 1,000 distinct session ids; none, 1,001 or a repeated one is refused', () => {
    const restore = STAGE_C_ACTS['act restore'] as PageMessage;
    for (const ids of [[S1], sessionIds(1000)]) {
      const message = { ...restore, sessionIds: ids };
      assert.deepEqual(page(message), { ok: true, value: message }, `${ids.length} ids`);
    }
    refused(page({ ...restore, sessionIds: sessionIds(1001) }));
    refused(page({ ...restore, sessionIds: [] }));
    refused(page({ ...restore, sessionIds: [S1, BOOT, S1] }));
    refused(
      page({
        ...restore,
        sessionIds: [...sessionIds(999), '00000000-1111-4111-8111-111111111111'],
      }),
    );
  });

  test('act restore: every id passes isSessionId exactly', () => {
    const restore = STAGE_C_ACTS['act restore'] as PageMessage;
    for (const id of [
      BOOT.toUpperCase(),
      S1.slice(1),
      `${S1}\n`,
      `{${S1}}`,
      ` ${S1}`,
      MARKER,
      '',
    ]) {
      assert.equal(isSessionId(id), false);
      refused(page({ ...restore, sessionIds: [BOOT, id] }));
      refused(page({ ...restore, sessionIds: [id] }));
    }
    for (const id of [7, null, [S1], { id: S1 }]) {
      refused(page({ ...restore, sessionIds: [S1, id] }));
    }
  });

  test('act dismiss-restore: the boot id is a lower-case UUID, the form of /proc/sys/kernel/random/boot_id', () => {
    const dismiss = STAGE_C_ACTS['act dismiss-restore'] as PageMessage;
    const other = '0f1e2d3c-4b5a-0968-f776-a5b4c3d2e1f0'; // any hex digit where a UUID's version goes
    assert.deepEqual(page({ ...dismiss, bootId: other }), {
      ok: true,
      value: { ...dismiss, bootId: other },
    });
    for (const bootId of [
      BOOT.toUpperCase(),
      BOOT.slice(1),
      `${BOOT}0`,
      `${BOOT}\n`,
      `{${BOOT}}`,
      BOOT.replaceAll('-', ''),
      MARKER,
      '',
    ]) {
      refused(page({ ...dismiss, bootId }));
    }
  });

  test("a stage C act with another kind's fields is refused", () => {
    refused(page({ t: 'act', id: 1, kind: 'restore', sessionId: S1 }));
    refused(page({ t: 'act', id: 1, kind: 'restore', sessionIds: [S1], all: true }));
    refused(page({ t: 'act', id: 1, kind: 'restore', sessionIds: [S1], bootId: BOOT }));
    refused(page({ t: 'act', id: 1, kind: 'dismiss-restore', sessionIds: [S1] }));
    refused(page({ t: 'act', id: 1, kind: 'dismiss-restore', bootId: BOOT, sessionId: S1 }));
  });
});

describe("parseControlRequest: stage C's routes (plan C3)", () => {
  const RESUME = { sessionId: S1 };
  const NEW = {
    dir: '/home/u/project',
    label: 'ORB-2107 fix',
    group: 'ORB-2107',
    flags: ['--model', 'opus', '--append-system-prompt', 'be brief'],
  };
  const RESTORE = { sessionIds: [S1, BOOT], all: false };
  const bodies: [string, Record<string, unknown>][] = [
    ['/resume', RESUME],
    ['/new', NEW],
    ['/restore', RESTORE],
  ];
  const post = (path: string, body: unknown): ReturnType<typeof parseControlRequest> =>
    parseControlRequest('POST', path, JSON.stringify(body));

  test('POST /resume { sessionId } → resume', () => {
    assert.deepEqual(post('/resume', RESUME), {
      ok: true,
      value: { route: 'resume', sessionId: S1 },
    });
  });

  test('POST /new { dir, label, group, flags } → new, every field as given: the flags not split, a repeated word kept, a blank or padded label and group kept', () => {
    assert.deepEqual(post('/new', NEW), { ok: true, value: { route: 'new', ...NEW } });
    const words = { ...NEW, flags: ['--append-system-prompt', "be brief, 'really'", ''] };
    assert.deepEqual(post('/new', words), { ok: true, value: { route: 'new', ...words } });
    const none = { ...NEW, flags: [] };
    assert.deepEqual(post('/new', none), { ok: true, value: { route: 'new', ...none } });
    // `-- --add-dir /a --add-dir /b -v -v`: the same word twice is the user's.
    const repeated = { ...NEW, flags: ['--add-dir', '/a', '--add-dir', '/b', '-v', '-v'] };
    assert.deepEqual(post('/new', repeated), { ok: true, value: { route: 'new', ...repeated } });
    // C3: `--label ' '` reaches prepareNew as typed, whose refusal (exit 2) is the answer; as
    // null it would start a session without a label. Nothing is trimmed.
    for (const [label, group] of [
      [' ', ''],
      ['', ' '],
      ['  ORB-2107 fix  ', '\tORB-2107 '],
    ]) {
      const blank = { ...NEW, label, group };
      assert.deepEqual(
        post('/new', blank),
        { ok: true, value: { route: 'new', ...blank } },
        JSON.stringify([label, group]),
      );
    }
  });

  test('POST /restore { sessionIds, all } → restore', () => {
    for (const all of [false, true]) {
      const body = { ...RESTORE, all };
      assert.deepEqual(post('/restore', body), { ok: true, value: { route: 'restore', ...body } });
    }
  });

  test('POST /new: label and group null are accepted (the option was not given), absent refused', () => {
    const plain = { ...NEW, label: null, group: null };
    assert.deepEqual(post('/new', plain), { ok: true, value: { route: 'new', ...plain } });
    for (const field of ['label', 'group']) {
      const copy: Record<string, unknown> = { ...NEW };
      delete copy[field];
      assert.match(refused(post('/new', copy)), /^body\b/, field);
    }
  });

  test('the stage C routes refuse every field they do not define (argv, program, cwd, command, env)', () => {
    const foreign: Record<string, unknown> = {
      argv: ['/bin/sh', '-c', MARKER],
      program: `/tmp/${MARKER}`,
      cwd: `/tmp/${MARKER}`,
      command: MARKER,
      env: { PATH: `/tmp/${MARKER}` },
      [MARKER]: 1,
    };
    for (const [path, body] of bodies) {
      for (const [field, value] of Object.entries(foreign)) {
        assert.match(
          refused(post(path, { ...body, [field]: value })),
          /^body\b/,
          `${path} ${field}`,
        );
      }
    }
  });

  test('each route refuses a missing field, a field of a wrong type and a body that is no JSON object', () => {
    for (const [path, body] of bodies) {
      for (const field of Object.keys(body)) {
        const copy: Record<string, unknown> = { ...body };
        delete copy[field];
        assert.match(refused(post(path, copy)), /^body\b/, `${path} without ${field}`);
        const wrong = { ...body, [field]: wrongType(body[field]) };
        assert.match(refused(post(path, wrong)), /^body\b/, `${path} ${field} of a wrong type`);
      }
      for (const text of ['', 'null', '[]', `{"${MARKER}`, `"${MARKER}"`]) {
        assert.match(
          refused(parseControlRequest('POST', path, text)),
          /^body\b/,
          `${path} ${text}`,
        );
      }
    }
    // A wrong type that holds the marker: the kind quotes none of it.
    for (const [path, body] of bodies) {
      for (const field of Object.keys(body)) {
        const value = typeof body[field] === 'string' ? [MARKER] : MARKER;
        assert.match(
          refused(post(path, { ...body, [field]: value })),
          /^body\b/,
          `${path} ${field}`,
        );
      }
    }
    // Arrays hold strings only.
    assert.match(refused(post('/new', { ...NEW, flags: ['--model', 7] })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, flags: [null] })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, flags: ['--model', [MARKER]] })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, flags: [{ [MARKER]: 1 }] })), /^body\b/);
    assert.match(refused(post('/restore', { ...RESTORE, sessionIds: [S1, [MARKER]] })), /^body\b/);
    assert.match(refused(post('/restore', { ...RESTORE, all: 'false' })), /^body\b/);
  });

  test('POST /new: dir 4,096 bytes ok, 4,097 refused; label and group 1,024 ok, 1,025 refused; 1,000 flags ok, 1,001 refused', () => {
    const dir = `/${'é'.repeat(2047)}a`; // 4,096 bytes
    assert.equal(Buffer.byteLength(dir), 4096);
    assert.equal(post('/new', { ...NEW, dir }).ok, true);
    assert.match(refused(post('/new', { ...NEW, dir: `${dir}a` })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, dir: `/${MARKER.repeat(400)}` })), /^body\b/);
    for (const field of ['label', 'group']) {
      assert.equal(post('/new', { ...NEW, [field]: '€'.repeat(341) + 'a' }).ok, true, field);
      assert.match(refused(post('/new', { ...NEW, [field]: 'a'.repeat(1025) })), /^body\b/);
      assert.match(refused(post('/new', { ...NEW, [field]: MARKER.repeat(100) })), /^body\b/);
    }
    const flags = Array.from({ length: 1000 }, (_, at) => `--f${at}`);
    assert.equal(post('/new', { ...NEW, flags }).ok, true);
    assert.match(refused(post('/new', { ...NEW, flags: [...flags, '--one-more'] })), /^body\b/);
    // A flag has no limit of its own: the body's 64 KiB bounds it (the handler's 413).
    assert.equal(
      post('/new', { ...NEW, flags: ['--append-system-prompt', 'x'.repeat(60_000)] }).ok,
      true,
    );
  });

  test('POST /new: a NUL in dir or in a flag is refused, and a lone surrogate in any text', () => {
    assert.match(refused(post('/new', { ...NEW, dir: '/home/u\u0000/x' })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, dir: `/home/${MARKER}\u0000/x` })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, flags: ['--model', 'op\u0000us'] })), /^body\b/);
    assert.match(refused(post('/new', { ...NEW, flags: [`${MARKER}\u0000`] })), /^body\b/);
    const lone = (field: string, flag = false): string => {
      const body = flag ? { ...NEW, flags: ['--model', 'LONE'] } : { ...NEW, [field]: 'LONE' };
      return JSON.stringify(body).replace('"LONE"', `"${MARKER}\\ud800b"`);
    };
    for (const [field, flag] of [
      ['dir', false],
      ['label', false],
      ['group', false],
      ['flags', true],
    ] as const) {
      assert.match(
        refused(parseControlRequest('POST', '/new', lone(field, flag))),
        /^body\b/,
        field,
      );
      const whole = lone(field, flag).replace('\\ud800', 'x');
      assert.equal(parseControlRequest('POST', '/new', whole).ok, true, field);
    }
  });

  test('POST /resume and /restore name sessions by isSessionId exactly; /restore 1 to 1,000 distinct ids', () => {
    for (const id of [
      BOOT.toUpperCase(),
      S1.slice(1),
      `${S1}\n`,
      `{${S1}}`,
      ` ${S1}`,
      MARKER,
      '',
    ]) {
      assert.match(refused(post('/resume', { sessionId: id })), /^body\b/, JSON.stringify(id));
      assert.match(refused(post('/restore', { ...RESTORE, sessionIds: [S1, id] })), /^body\b/);
    }
    assert.equal(post('/restore', { ...RESTORE, sessionIds: [S1] }).ok, true);
    assert.deepEqual(post('/restore', { sessionIds: sessionIds(1000), all: true }), {
      ok: true,
      value: { route: 'restore', sessionIds: sessionIds(1000), all: true },
    });
    for (const ids of [[], sessionIds(1001), [S1, BOOT, S1]]) {
      assert.match(refused(post('/restore', { ...RESTORE, sessionIds: ids })), /^body\b/);
    }
  });

  test('a stage C route with another method is no route', () => {
    for (const [path] of bodies) {
      for (const method of ['GET', 'PUT', 'post']) {
        assert.match(
          refused(parseControlRequest(method, path, '')),
          /^route\b/,
          `${method} ${path}`,
        );
      }
    }
    assert.match(refused(post('/resume/', RESUME)), /^route\b/);
    assert.match(refused(post('/restore?all=1', RESTORE)), /^route\b/);
  });
});

describe("stage C's types (checked by npm run typecheck)", () => {
  const ENTRY: BannerEntryPayload = {
    sessionId: S1,
    shortId: S1.slice(0, 8),
    title: 'ORB-2107 fix',
    endedAtNs: '1700000000000000000',
    wasWorking: true,
    preselected: true,
  };
  const BANNER: BannerPayload = {
    bootId: BOOT,
    lastActivityNs: '1700000000000000000',
    entries: [ENTRY, { ...ENTRY, sessionId: BOOT, endedAtNs: null, preselected: false }],
    shown: true,
    running: false,
  };

  test('a list with a banner, and a restore-progress notice, compile and are plain JSON', () => {
    const list: ListMessage = {
      t: 'list',
      nowNs: '1700000000000000000',
      counts: { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 2 },
      needYou: { count: 0, order: [] },
      sections: [],
      doneHidden: 0,
      banner: BANNER,
      terminals: [],
      selected: null,
      dirs: [],
    };
    const running: ListMessage = {
      ...list,
      banner: { bootId: null, lastActivityNs: null, entries: [], shown: true, running: true },
    };
    const none: ListMessage = { ...list, banner: null };
    const notice: NoticeMessage = {
      t: 'notice',
      kind: 'restore-progress',
      term: null,
      text: 'restore finished: 2 started',
    };
    const messages: ServerMessage[] = [list, running, none, notice];
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), messages);
  });

  test("stage C's acts compile with exactly plan C 2.2's fields", () => {
    const acts: ActMessage[] = [
      { t: 'act', id: 1, kind: 'restore', sessionIds: [S1] },
      { t: 'act', id: 2, kind: 'dismiss-restore', bootId: BOOT },
    ];
    for (const act of acts) {
      assert.deepEqual(parsePageMessage(JSON.stringify(act)), { ok: true, value: act });
    }
    const misspelt = [
      // @ts-expect-error a restore names its sessions in `sessionIds`
      { t: 'act', id: 3, kind: 'restore', sessionId: S1 } satisfies ActMessage,
      {
        sessionId: S1,
        shortId: S1.slice(0, 8),
        title: 'x',
        endedAtNs: null,
        wasWorking: false,
        // @ts-expect-error an entry's preselection is `preselected`
        selected: true,
      } satisfies BannerEntryPayload,
    ];
    assert.equal(misspelt.length, 2);
  });

  test("server.sock's stage C requests and answers compile; windowExpectedMs is optional", () => {
    const request: NewRequest = {
      dir: '/home/u',
      label: null,
      group: 'g',
      flags: ['--model', 'opus'],
    };
    const restore: RestoreRequest = { sessionIds: [S1], all: false };
    const requests: ControlRequest[] = [
      { route: 'resume', sessionId: S1 },
      { route: 'new', ...request },
      { route: 'restore', ...restore },
    ];
    const answer: LaunchAnswer = { code: 4, lines: ['skydeck: refused'], sessionId: null };
    const outcome: RestoreOutcomeLine = {
      code: 5,
      started: 1,
      timedOut: 0,
      failed: 0,
      notStarted: 2,
    };
    const stream: RestoreStreamLine[] = [{ line: 'started 11111111 ORB-2107 fix' }, { outcome }];
    const status: StatusAnswer = {
      pages: 0,
      terminals: [],
      keepAlive: { mode: 'off', state: 'off', since: null, error: null },
      python: { found: true, version: '3.12.3' },
      build: '0123456789abcdef',
      checkout: '/home/u/skydeck',
      startedAtNs: '1',
      envOrigin: { dir: '/home/u', atNs: '1' },
    };
    const statuses: StatusAnswer[] = [
      status, // a server of an older build: no windowExpectedMs
      { ...status, windowExpectedMs: 6500 },
      { ...status, windowExpectedMs: null },
    ];
    const wrong = [
      // @ts-expect-error the outcome's codes are design 7.8's 0, 1 and 5
      { ...outcome, code: 2 } satisfies RestoreOutcomeLine,
      // @ts-expect-error windowExpectedMs is a number of milliseconds
      { ...status, windowExpectedMs: '6500' } satisfies StatusAnswer,
      // @ts-expect-error a new session's flags are an array of words
      { ...request, flags: '--model opus' } satisfies NewRequest,
    ];
    assert.equal(wrong.length, 3);
    const all = [requests, answer, stream, statuses];
    assert.deepEqual(JSON.parse(JSON.stringify(all)), all);
  });
});
