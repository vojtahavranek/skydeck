import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  HOOK_EVENTS,
  addHookEntries,
  cleanupPeriodDays,
  hookCommand,
  hookEntry,
  hookStatus,
  removeHookEntries,
  rewriteReport,
  settingsPath,
} from '../../src/claude/settings.ts';
import type { HookEvent } from '../../src/claude/settings.ts';
import { SkydeckError } from '../../src/platform/errors.ts';

const H = '/home/dev/.local/share/skydeck/skydeck-hook';
const E = (event: HookEvent) => hookEntry(H, event);

const FOREIGN_GROUP = { matcher: '', hooks: [{ type: 'command', command: 'other' }] };
const FOREIGN_INPUT = JSON.stringify({ model: 'opus', hooks: { SessionStart: [FOREIGN_GROUP] } });

/** Parses the text of an edit, which must be valid JSON. */
function parse(text: string): unknown {
  return JSON.parse(text);
}

describe('settings: the constants and the command', () => {
  test('HOOK_EVENTS lists the two hooked events in order', () => {
    assert.deepEqual([...HOOK_EVENTS], ['SessionStart', 'SessionEnd']);
  });

  test('settingsPath is settings.json in the Claude home', () => {
    assert.equal(settingsPath('/c'), '/c/settings.json');
  });

  test('hookCommand quotes the path, names the event and silences the hook', () => {
    assert.equal(
      hookCommand(H, 'SessionStart'),
      "'/home/dev/.local/share/skydeck/skydeck-hook' SessionStart >/dev/null 2>&1 || true",
    );
  });

  test('hookCommand refuses a path with a quote in it', () => {
    assert.throws(() => hookCommand("/a'b", 'SessionEnd'), SkydeckError);
  });

  test('hookEntry is one matcher group with one command hook and a timeout of 5', () => {
    assert.deepEqual(hookEntry(H, 'SessionEnd'), {
      hooks: [{ type: 'command', command: hookCommand(H, 'SessionEnd'), timeout: 5 }],
    });
  });
});

describe('settings: addHookEntries', () => {
  test('creates the whole file when there is none', () => {
    const edit = addHookEntries(null, H);

    assert.equal(edit.changed, true);
    assert.deepEqual(edit.events, ['SessionStart', 'SessionEnd']);
    assert.deepEqual(parse(edit.text), {
      hooks: { SessionStart: [E('SessionStart')], SessionEnd: [E('SessionEnd')] },
    });
    assert.equal(edit.text, JSON.stringify(parse(edit.text), null, 2) + '\n');
  });

  test('foreign settings and foreign hooks survive, in their order', () => {
    const edit = addHookEntries(FOREIGN_INPUT, H);

    const parsed = parse(edit.text) as { hooks: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed), ['model', 'hooks']);
    assert.deepEqual(parsed.hooks['SessionStart'], [FOREIGN_GROUP, E('SessionStart')]);
    assert.deepEqual(parsed.hooks['SessionEnd'], [E('SessionEnd')]);
  });

  test('installing twice changes the file once', () => {
    const first = addHookEntries(null, H);

    const second = addHookEntries(first.text, H);

    assert.equal(second.changed, false);
    assert.equal(second.text, first.text);
    assert.deepEqual(second.events, []);
  });

  test('a half-installed file gets only the missing entry', () => {
    const half = JSON.stringify({ hooks: { SessionStart: [E('SessionStart')] } });

    const edit = addHookEntries(half, H);

    assert.equal(edit.changed, true);
    assert.deepEqual(edit.events, ['SessionEnd']);
    assert.deepEqual(parse(edit.text), {
      hooks: { SessionStart: [E('SessionStart')], SessionEnd: [E('SessionEnd')] },
    });
  });

  test('an unchanged file is returned byte for byte, not re-formatted', () => {
    const installed = addHookEntries(null, H).text;
    const compact = JSON.stringify(parse(installed));

    const edit = addHookEntries(compact, H);

    assert.equal(edit.changed, false);
    assert.equal(edit.text, compact);
  });

  test('our command inside a group that has a matcher counts as installed', () => {
    const grouped = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [E('SessionStart').hooks[0]] }],
        SessionEnd: [E('SessionEnd')],
      },
    });

    const edit = addHookEntries(grouped, H);

    assert.equal(edit.changed, false);
  });

  for (const text of ['not json', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}']) {
    test(`malformed settings ${text} throw a SkydeckError`, () => {
      assert.throws(() => addHookEntries(text, H), SkydeckError);
    });
  }

  test('a file that is not valid JSON says so', () => {
    assert.throws(() => addHookEntries('{"hooks":', H), /not valid JSON/);
  });

  test('a hooks object holding other events is kept', () => {
    const text = JSON.stringify({ hooks: { Stop: [FOREIGN_GROUP] } });

    const edit = addHookEntries(text, H);

    const parsed = parse(edit.text) as { hooks: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed.hooks), ['Stop', 'SessionStart', 'SessionEnd']);
  });
});

describe('settings: removeHookEntries', () => {
  test('removing what was added leaves an empty object', () => {
    const edit = removeHookEntries(addHookEntries(null, H).text, H);

    assert.equal(edit.changed, true);
    assert.equal(edit.text, '{}\n');
    assert.deepEqual(edit.events, ['SessionStart', 'SessionEnd']);
  });

  test('foreign entries survive removal exactly as they were', () => {
    const added = addHookEntries(FOREIGN_INPUT, H);

    const edit = removeHookEntries(added.text, H);

    assert.deepEqual(parse(edit.text), parse(FOREIGN_INPUT));
    assert.deepEqual(Object.keys(parse(edit.text) as object), ['model', 'hooks']);
  });

  test('a group holding a foreign hook and ours keeps the foreign one', () => {
    const mixed = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'other' }, E('SessionStart').hooks[0]],
          },
        ],
      },
    });

    const edit = removeHookEntries(mixed, H);

    assert.equal(edit.changed, true);
    assert.deepEqual(edit.events, ['SessionStart']);
    assert.deepEqual(parse(edit.text), {
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'other' }] }] },
    });
  });

  test('when nothing is ours the text is returned unchanged', () => {
    const text =
      '{"model":"opus",  "hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"other"}]}]}}';

    const edit = removeHookEntries(text, H);

    assert.equal(edit.changed, false);
    assert.equal(edit.text, text);
    assert.deepEqual(edit.events, []);
  });

  test('an entry whose command merely contains the path is not ours and stays', () => {
    // Not what hookCommand writes: a different quote, no silencing, a longer file name.
    const text = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `"${H}" SessionStart` }] },
          { hooks: [{ type: 'command', command: `${hookCommand(H, 'SessionStart')} # mine` }] },
          { hooks: [{ type: 'command', command: `'${H}-notify.sh' SessionStart` }] },
        ],
      },
    });

    const edit = removeHookEntries(text, H);

    assert.equal(edit.changed, false);
    assert.equal(edit.text, text);
    assert.deepEqual(edit.events, []);
  });

  test("a user's own hooks that name the hook path survive, in any event, next to ours", () => {
    const notify = { type: 'command', command: `${H}-notify.sh` };
    const mention = { type: 'command', command: `echo see '${H}' >>/tmp/log` };
    const text = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [notify] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [mention] }],
        SessionStart: [{ hooks: [notify, E('SessionStart').hooks[0], mention] }],
        SessionEnd: [{ hooks: [mention] }, E('SessionEnd')],
      },
    });

    const edit = removeHookEntries(text, H);

    assert.equal(edit.changed, true);
    assert.deepEqual(edit.events, ['SessionStart', 'SessionEnd']);
    assert.deepEqual(parse(edit.text), {
      hooks: {
        Stop: [{ hooks: [notify] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [mention] }],
        SessionStart: [{ hooks: [notify, mention] }],
        SessionEnd: [{ hooks: [mention] }],
      },
    });
  });

  test('an entry written by an install with another hook path is left alone', () => {
    const older = hookEntry('/home/dev/old-checkout/skydeck-hook', 'SessionStart');
    const text = JSON.stringify({ hooks: { SessionStart: [older, E('SessionStart')] } });

    const edit = removeHookEntries(text, H);

    assert.deepEqual(parse(edit.text), { hooks: { SessionStart: [older] } });
  });

  test('a hook path with a quote in it cannot be ours: nothing is removed, nothing throws', () => {
    const text = JSON.stringify({ hooks: { Stop: [FOREIGN_GROUP] } });

    const edit = removeHookEntries(text, "/a'b/skydeck-hook");

    assert.equal(edit.changed, false);
    assert.equal(edit.text, text);
  });

  test('install, doctor and uninstall agree on what is ours', () => {
    // The same command, in the event it names and in the other one, in the shapes people write.
    const commands = [
      hookCommand(H, 'SessionStart'),
      hookCommand(H, 'SessionEnd'),
      `'${H}' SessionStart`,
      `"${H}" SessionStart >/dev/null 2>&1 || true`,
      `${hookCommand(H, 'SessionStart')} extra`,
      `${H}-notify.sh`,
      `echo '${H}' SessionStart`,
      ` ${hookCommand(H, 'SessionStart')}`,
    ];
    for (const event of HOOK_EVENTS) {
      for (const command of commands) {
        const text = JSON.stringify({
          hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] },
        });

        const installed = !addHookEntries(text, H).events.includes(event);
        const reported = hookStatus(text, H)[event];
        const removed = removeHookEntries(text, H).changed;

        assert.equal(reported, installed, `${event}: ${command}`);
        assert.equal(removed, installed, `${event}: ${command}`);
        assert.equal(installed, command === hookCommand(H, event), `${event}: ${command}`);
      }
    }
  });

  test('other events that already were empty are not touched', () => {
    const text = JSON.stringify({
      hooks: { Stop: [], SessionStart: [E('SessionStart')] },
    });

    const edit = removeHookEntries(text, H);

    assert.deepEqual(parse(edit.text), { hooks: { Stop: [] } });
  });

  test('events come in the order of HOOK_EVENTS whatever the order in the file', () => {
    const reversed = JSON.stringify({
      hooks: { SessionEnd: [E('SessionEnd')], SessionStart: [E('SessionStart')] },
    });

    assert.deepEqual(removeHookEntries(reversed, H).events, ['SessionStart', 'SessionEnd']);
  });

  test('our command under an event it does not name is not ours either', () => {
    const text = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand(H, 'SessionEnd') }] }],
        PreToolUse: [FOREIGN_GROUP],
      },
    });

    const edit = removeHookEntries(text, H);

    assert.equal(edit.changed, false);
    assert.equal(edit.text, text);
  });

  test('a foreign group that was empty already is left alone', () => {
    const emptyGroup = { matcher: 'x', hooks: [] };
    const text = JSON.stringify({
      hooks: { SessionStart: [emptyGroup, E('SessionStart')], Stop: [emptyGroup] },
    });

    const edit = removeHookEntries(text, H);

    assert.deepEqual(edit.events, ['SessionStart']);
    assert.deepEqual(parse(edit.text), {
      hooks: { SessionStart: [emptyGroup], Stop: [emptyGroup] },
    });
  });

  test('an event whose value is not an array is left alone', () => {
    const text = JSON.stringify({ hooks: { Stop: 'x', SessionStart: [E('SessionStart')] } });

    const edit = removeHookEntries(text, H);

    assert.deepEqual(parse(edit.text), { hooks: { Stop: 'x' } });
  });

  test('an empty or blank hook path is refused instead of matching every hook', () => {
    const text = JSON.stringify({ hooks: { Stop: [FOREIGN_GROUP] } });

    assert.throws(() => removeHookEntries(text, ''), SkydeckError);
    assert.throws(() => removeHookEntries(text, '  '), SkydeckError);
  });

  test('settings that are not valid JSON throw a SkydeckError', () => {
    assert.throws(() => removeHookEntries('not json', H), SkydeckError);
    assert.throws(() => removeHookEntries('[]', H), SkydeckError);
    assert.throws(() => removeHookEntries('{"hooks":{"SessionEnd":"x"}}', H), SkydeckError);
  });
});

describe('settings: rewriteReport', () => {
  const in2 = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  test("a file in skydeck's own formatting would come back as it is", () => {
    const text = in2({ model: 'opus', hooks: { Stop: [FOREIGN_GROUP] }, n: 1.5, big: 1e21 });

    assert.deepEqual(rewriteReport(text), { reformatted: false, lossyPaths: [] });
  });

  for (const [why, text] of [
    ['4-space indentation', JSON.stringify({ model: 'opus', hooks: {} }, null, 4) + '\n'],
    ['no newline at the end', '{\n  "model": "opus"\n}'],
    ['a compact file', '{"model":"opus"}'],
    ['a duplicate key, which collapses', '{\n  "a": 1,\n  "a": 2\n}\n'],
    ['1.50, which comes back as 1.5', '{\n  "price": 1.50\n}\n'],
    ['1E+5, which comes back as 100000', '{\n  "n": 1E+5\n}\n'],
  ] as const) {
    test(`${why}: the bytes would change, no number loses a digit`, () => {
      assert.deepEqual(rewriteReport(text), { reformatted: true, lossyPaths: [] });
    });
  }

  for (const [why, literal] of [
    ['an integer beyond the safe range', '12345678901234567890'],
    ['the first integer a double cannot hold', '9007199254740993'],
    ['a negative one', '-12345678901234567890'],
    ['a decimal with more digits than a double keeps', '0.1000000000000000055511151231257827'],
    ['a number too large for a double, which would be written as null', '1e999'],
  ] as const) {
    test(`${why}: the key is named`, () => {
      const report = rewriteReport(`{\n  "env": {\n    "id": ${literal}\n  }\n}\n`);

      assert.deepEqual(report, { reformatted: true, lossyPaths: ['env.id'] });
    });
  }

  test('an integer a double holds exactly is not lossy, whatever its size', () => {
    for (const literal of ['9007199254740992', '1000000000000000000000', '-0', '0.5e1']) {
      const report = rewriteReport(`{\n  "n": ${literal}\n}\n`);

      assert.deepEqual(report.lossyPaths, [], literal);
    }
  });

  test('a number is named by its path, each once, in file order', () => {
    const big = (n: number): string => `1234567890123456789${n}`;
    const text = `{"a":${big(0)},"b":{"a":${big(1)},"c":[1,{"d":${big(2)}},${big(3)}]},"e":[${big(4)}]}`;

    assert.deepEqual(rewriteReport(text).lossyPaths, ['a', 'b.a', 'b.c[1].d', 'b.c[2]', 'e[0]']);
  });

  test('an empty key is named "" and a key with a dot, a bracket or a quote is quoted', () => {
    const big = '12345678901234567890';
    const text = `{"":${big},"x":{"":${big},"a.b":${big},"c[0]":${big},"q\\"r":${big},"ok-1_$":${big}}}`;

    assert.deepEqual(rewriteReport(text).lossyPaths, [
      '""',
      'x.""',
      'x."a.b"',
      'x."c[0]"',
      'x."q\\"r"',
      'x.ok-1_$',
    ]);
  });

  test('text that is not a JSON object throws like the editing functions do', () => {
    assert.throws(() => rewriteReport('not json'), SkydeckError);
    assert.throws(() => rewriteReport('[]'), SkydeckError);
  });
});

describe('settings: hookStatus', () => {
  test('no file means neither event is installed', () => {
    assert.deepEqual(hookStatus(null, H), { SessionStart: false, SessionEnd: false });
  });

  test('after an add both are installed', () => {
    assert.deepEqual(hookStatus(addHookEntries(null, H).text, H), {
      SessionStart: true,
      SessionEnd: true,
    });
  });

  test('foreign entries only mean neither is installed', () => {
    assert.deepEqual(hookStatus(FOREIGN_INPUT, H), { SessionStart: false, SessionEnd: false });
  });

  test('half installed is reported per event', () => {
    const half = JSON.stringify({ hooks: { SessionEnd: [E('SessionEnd')] } });

    assert.deepEqual(hookStatus(half, H), { SessionStart: false, SessionEnd: true });
  });

  test('an entry for the other event does not count', () => {
    const swapped = JSON.stringify({ hooks: { SessionStart: [E('SessionEnd')] } });

    assert.deepEqual(hookStatus(swapped, H), { SessionStart: false, SessionEnd: false });
  });

  test('unreadable or oddly shaped settings mean nothing is installed', () => {
    for (const text of ['bad', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}']) {
      assert.deepEqual(hookStatus(text, H), { SessionStart: false, SessionEnd: false }, text);
    }
  });
});

describe('settings: cleanupPeriodDays', () => {
  test('is 30 without a file', () => {
    assert.equal(cleanupPeriodDays(null), 30);
  });

  test('reads a positive number', () => {
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":14}'), 14);
  });

  test('falls back to 30 for zero, a negative number, a string or garbage', () => {
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":0}'), 30);
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":-3}'), 30);
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":7.5}'), 30);
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":1e400}'), 30);
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":1e21}'), 30);
    assert.equal(cleanupPeriodDays('{"cleanupPeriodDays":"9"}'), 30);
    assert.equal(cleanupPeriodDays('bad'), 30);
    assert.equal(cleanupPeriodDays('[]'), 30);
    assert.equal(cleanupPeriodDays('null'), 30);
    assert.equal(cleanupPeriodDays('{}'), 30);
  });
});
