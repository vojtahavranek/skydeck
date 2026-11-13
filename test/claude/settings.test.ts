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

  test('an entry whose command merely contains the path is removed too', () => {
    const text = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '"/home/dev/.local/share/skydeck/skydeck-hook" SessionStart',
              },
            ],
          },
        ],
      },
    });

    const edit = removeHookEntries(text, H);

    assert.equal(edit.changed, true);
    assert.equal(edit.text, '{}\n');
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

  test('an entry under any other event that names the hook path is removed too', () => {
    const text = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand(H, 'SessionEnd') }] }],
        PreToolUse: [FOREIGN_GROUP],
      },
    });

    const edit = removeHookEntries(text, H);

    assert.equal(edit.changed, true);
    assert.deepEqual(edit.events, []);
    assert.deepEqual(parse(edit.text), { hooks: { PreToolUse: [FOREIGN_GROUP] } });
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
