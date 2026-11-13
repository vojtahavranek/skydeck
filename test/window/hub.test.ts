import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ActionHandler,
  PageInfo,
  StreamSink,
  TerminalHub,
  TerminalInfo,
} from '../../src/window/hub.ts';
import type { ActMessage, ResultMessage } from '../../src/window/protocol.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const TERM = '0123456789ab';

test('a fake hub and action handler satisfy hub.ts (pages code against these, A1)', async () => {
  const info: TerminalInfo = {
    id: TERM,
    slot: 1,
    state: 'running',
    expectedSessionId: S1,
    sessionId: S1,
    kind: 'resume',
    label: null,
    dir: '/home/u/project',
    program: { pid: 4243, procStart: 51234567 },
    openedNs: 1_700_000_000_000_000_000n,
    cols: 120,
    rows: 40,
    exit: null,
    notReported: false,
  };
  const sinks = new Set<StreamSink>();
  const hub: TerminalHub = {
    list: () => [info],
    attach(termId, sink) {
      if (termId !== TERM) return null;
      sinks.add(sink);
      return { cols: info.cols, rows: info.rows, data: '', detach: () => sinks.delete(sink) };
    },
    input: (termId) => (termId === TERM ? 'ok' : 'unknown'),
    resize() {},
    close: (termId) => (termId === TERM ? 'running' : 'unknown'),
    setTheme() {},
    onChange: () => () => {},
  };
  const actions: ActionHandler = {
    act: async (_page: PageInfo, action: ActMessage): Promise<ResultMessage> => ({
      t: 'result',
      id: action.id,
      ok: true,
      lines: [],
      error: null,
      sessionId: action.kind === 'resume' ? action.sessionId : null,
    }),
  };

  const output: string[] = [];
  const attached = hub.attach(TERM, {
    output: (bytes) => output.push(new TextDecoder().decode(bytes)),
    size() {},
    exit() {},
    notice() {},
  });
  assert.ok(attached);
  for (const sink of sinks) sink.output(new TextEncoder().encode('hi'));
  attached.detach();
  assert.deepEqual(output, ['hi']);
  assert.equal(sinks.size, 0);
  assert.equal(hub.attach('ffffffffffff', [...sinks][0] as StreamSink), null);
  assert.equal(hub.close(TERM), 'running');

  const page: PageInfo = { windowId: '0123456789abcdef', focused: true, area: null };
  const result = await actions.act(page, {
    t: 'act',
    id: 5,
    kind: 'resume',
    sessionId: S1,
    cols: 120,
    rows: 40,
  });
  assert.deepEqual(result, { t: 'result', id: 5, ok: true, lines: [], error: null, sessionId: S1 });
});
