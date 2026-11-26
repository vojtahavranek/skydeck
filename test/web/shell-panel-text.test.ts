import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RowPayload, ShellPayload, TerminalPayload } from '../../src/window/protocol.ts';
import type { Pane } from '../../web/pane.js';
import { SHELL_TEXTS, shellPress, shellRefusedText } from '../../web/shell-panel-text.js';

const TERM = 'aaaaaaaaaaaa';
const SHELL: ShellPayload = {
  id: 'bbbbbbbbbbbb',
  of: TERM,
  state: 'running',
  cols: 80,
  rows: 12,
  ownsSize: true,
};

const term = {
  id: TERM,
  slot: 1,
  sessionId: '11111111-1111-4111-8111-111111111111',
  state: 'running',
  notReported: false,
  cols: 80,
  rows: 24,
  ownsSize: true,
  openedNs: '1',
} as TerminalPayload;

function row(more: Partial<RowPayload> = {}): RowPayload {
  return { id: '11111111-1111-4111-8111-111111111111', elsewhere: null, ...more } as RowPayload;
}

const terminal = (ended = false): Pane => ({ kind: 'terminal', row: row(), term, ended });

describe("shellPress (issue #199, S2 12.9): every row of the key's table", () => {
  const cases: [string, Parameters<typeof shellPress>[0], ReturnType<typeof shellPress>][] = [
    [
      'nothing selected',
      { pane: { kind: 'none' }, selected: false, shell: null, shown: false, inShell: false },
      { toast: SHELL_TEXTS.noSession },
    ],
    [
      'a caption selected',
      {
        pane: { kind: 'group', section: 'open', group: 'g', size: 2, needYou: 0 },
        selected: false,
        shell: null,
        shown: false,
        inShell: false,
      },
      { toast: SHELL_TEXTS.noSession },
    ],
    [
      'a selection the list hides (s), with its terminal shown',
      { pane: terminal(), selected: false, shell: null, shown: false, inShell: false },
      { toast: SHELL_TEXTS.noSession },
    ],
    [
      'a session that does not run',
      {
        pane: { kind: 'resume', row: row() },
        selected: true,
        shell: null,
        shown: false,
        inShell: false,
      },
      { toast: SHELL_TEXTS.openFirst },
    ],
    [
      'the new form over the pane',
      { pane: { kind: 'new' }, selected: true, shell: null, shown: false, inShell: false },
      { toast: SHELL_TEXTS.openFirst },
    ],
    [
      'a session that runs in another terminal',
      {
        pane: { kind: 'elsewhere', row: row({ elsewhere: { pid: 1, tty: null, dir: null } }) },
        selected: true,
        shell: null,
        shown: false,
        inShell: false,
      },
      { toast: SHELL_TEXTS.elsewhere },
    ],
    [
      "a session in Claude Code's background",
      {
        pane: {
          kind: 'elsewhere',
          row: row({ elsewhere: { pid: 1, tty: null, dir: null, background: true } }),
        },
        selected: true,
        shell: null,
        shown: false,
        inShell: false,
      },
      { toast: SHELL_TEXTS.background },
    ],
    [
      'an ended terminal',
      { pane: terminal(true), selected: true, shell: null, shown: false, inShell: false },
      { toast: SHELL_TEXTS.ended },
    ],
    [
      'an ended terminal whose shell the list still has',
      { pane: terminal(true), selected: true, shell: SHELL, shown: false, inShell: false },
      { toast: SHELL_TEXTS.ended },
    ],
    [
      'a terminal without a shell',
      { pane: terminal(), selected: true, shell: null, shown: false, inShell: false },
      { do: 'act' },
    ],
    [
      'a shell, the panel hidden',
      { pane: terminal(), selected: true, shell: SHELL, shown: false, inShell: false },
      { do: 'show' },
    ],
    [
      'the panel shown, the keyboard in the shell',
      { pane: terminal(), selected: true, shell: SHELL, shown: true, inShell: true },
      { do: 'hide' },
    ],
    [
      'the panel shown, the keyboard elsewhere',
      { pane: terminal(), selected: true, shell: SHELL, shown: true, inShell: false },
      { do: 'focus' },
    ],
  ];
  for (const [name, press, expected] of cases) {
    test(name, () => {
      assert.deepEqual(shellPress(press), expected);
    });
  }

  test("the words of D7's table", () => {
    assert.equal(SHELL_TEXTS.noSession, 'no session selected');
    assert.equal(
      SHELL_TEXTS.openFirst,
      "a shell opens under a session's terminal in this window: open the session first (Enter)",
    );
    assert.equal(
      SHELL_TEXTS.elsewhere,
      "a shell opens under a session's terminal in this window; this one runs in another terminal",
    );
    assert.equal(
      SHELL_TEXTS.background,
      "a shell opens under a session's terminal in this window; this one runs in Claude Code's background",
    );
    assert.equal(SHELL_TEXTS.ended, 'this session has ended: resume it first, then open a shell');
    assert.equal(
      shellRefusedText('the shell ended at once (status 3)'),
      'Shell: the shell ended at once (status 3)',
    );
  });
});
