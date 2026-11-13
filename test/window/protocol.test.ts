import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isSessionId } from '../../src/claude/launch.ts';
import {
  encodeOutputFrame,
  parseControlRequest,
  parsePageMessage,
} from '../../src/window/protocol.ts';
import type {
  ByeMessage,
  ChallengeMessage,
  ControlRequest,
  ExitMessage,
  FocusMessage,
  KeepAlivePayload,
  ListMessage,
  NoticeMessage,
  PageMessage,
  PingAnswer,
  PongMessage,
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
};

/** A value of another JSON type than `value`. */
function wrongType(value: unknown): unknown {
  if (typeof value === 'string') return 42;
  if (typeof value === 'number') return '42';
  if (typeof value === 'boolean') return 'true';
  if (value === null) return 42;
  if (Array.isArray(value)) return { 0: 'x' };
  return ['x'];
}

describe('parsePageMessage: every page message of stage A', () => {
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

  test("act kinds of later stages and kinds it does not know (A's are resume, new, close-terminal, open-link)", () => {
    for (const kind of ['label', 'restore', 'group', 'note', 'done', 'pr-add', MARKER]) {
      refused(page({ t: 'act', id: 1, kind, sessionId: S1, text: 'x' }));
    }
    refused(page({ t: 'act', id: 1, sessionId: S1, cols: 120, rows: 40 }));
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

  const noRoute: [string, string, string][] = [
    ['POST', '/resume', `{"sessionId":"${S1}"}`],
    ['POST', '/new', '{}'],
    ['POST', '/restore', '{}'],
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
      },
    ],
    chip: { level: 'green', count: 1 },
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
    ];
    assert.equal(misspelt.length, 3);
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
