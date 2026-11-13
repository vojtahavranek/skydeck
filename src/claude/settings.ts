// Claude Code's user-level settings file as far as skydeck touches it: the two hook entries that
// `skydeck install` adds and `skydeck uninstall` removes (design 5.1, 8), and `cleanupPeriodDays`.
// Everything else in the file is carried through untouched, in its order.
import { join } from 'node:path';

import { SkydeckError } from '../platform/errors.ts';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd'] as const;
export type HookEvent = 'SessionStart' | 'SessionEnd';

/** <claudeHome>/settings.json */
export function settingsPath(claudeHome: string): string {
  return join(claudeHome, 'settings.json');
}

/** Exactly `'<hookPath>' <event> >/dev/null 2>&1 || true`. Throws SkydeckError when hookPath contains a quote. */
export function hookCommand(hookPath: string, event: HookEvent): string {
  if (hookPath.includes("'")) {
    throw new SkydeckError(
      `the hook path ${hookPath} contains a quote, which the hook command cannot quote`,
    );
  }
  return `'${hookPath}' ${event} >/dev/null 2>&1 || true`;
}

/** The matcher group of design 5.1: { hooks: [ { type: 'command', command, timeout: 5 } ] }. */
export function hookEntry(
  hookPath: string,
  event: HookEvent,
): { hooks: [{ type: 'command'; command: string; timeout: 5 }] } {
  return { hooks: [{ type: 'command', command: hookCommand(hookPath, event), timeout: 5 }] };
}

export interface SettingsEdit {
  /** The new file content; equal to the input when !changed. */
  text: string;
  changed: boolean;
  /** Events whose entries were added (add) or removed (remove). */
  events: HookEvent[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a settings file that has to be edited: a JSON object whose `hooks`, when present, is an
 * object, and whose `hooks.<event>`, when present, is an array.
 */
function parseForEdit(text: string): { settings: Json; hooks: Json | null } {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new SkydeckError(`settings.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(settings)) {
    throw new SkydeckError('settings.json must hold a JSON object');
  }
  const hooks = settings['hooks'];
  if (hooks === undefined) {
    return { settings, hooks: null };
  }
  if (!isObject(hooks)) {
    throw new SkydeckError('settings.json: "hooks" must be an object');
  }
  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new SkydeckError(`settings.json: "hooks.${event}" must be an array`);
    }
  }
  return { settings, hooks };
}

/** The top-level object of a settings file, or null when there is none or it cannot be read. */
function parseLoosely(text: string | null): Json | null {
  if (text === null) {
    return null;
  }
  try {
    const settings: unknown = JSON.parse(text);
    return isObject(settings) ? settings : null;
  } catch {
    return null;
  }
}

function isHookEvent(name: string): name is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

function serialize(settings: Json): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Every hook object of the matcher groups in `groups` that has a string `command`. Odd shapes are skipped. */
function commandsOf(groups: unknown): string[] {
  const commands: string[] = [];
  if (!Array.isArray(groups)) {
    return commands;
  }
  for (const group of groups as unknown[]) {
    if (isObject(group) && Array.isArray(group['hooks'])) {
      for (const hook of group['hooks'] as unknown[]) {
        if (isObject(hook) && typeof hook['command'] === 'string') {
          commands.push(hook['command']);
        }
      }
    }
  }
  return commands;
}

/**
 * Appends hookEntry to hooks.<event> for each event that has no hook whose command equals
 * hookCommand(hookPath, event). settingsText null = no file (start from {}). Output is
 * JSON.stringify(settings, null, 2) + '\n'; key order of the input is kept. Throws SkydeckError when
 * the text is not a JSON object, or `hooks` / `hooks.<event>` has the wrong type.
 */
export function addHookEntries(settingsText: string | null, hookPath: string): SettingsEdit {
  const { settings, hooks } = parseForEdit(settingsText ?? '{}');
  const added: HookEvent[] = [];
  const target: Json = hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const groups = target[event] as unknown[] | undefined;
    if (!commandsOf(groups).includes(hookCommand(hookPath, event))) {
      target[event] = [...(groups ?? []), hookEntry(hookPath, event)];
      added.push(event);
    }
  }
  if (added.length === 0 && settingsText !== null) {
    return { text: settingsText, changed: false, events: [] };
  }
  settings['hooks'] = target;
  return { text: serialize(settings), changed: true, events: added };
}

/**
 * Removes every hook object whose `command` contains hookPath, under any event; then drops matcher
 * groups left with no hooks, event arrays left empty, and `hooks` when left empty. Nothing else
 * changes: a group or array that was empty before stays. `events` names the hooked events that
 * lost an entry (HookEvent cannot name another event); `changed` is true when anything went.
 * Throws SkydeckError when hookPath is empty or blank, which would match every hook.
 */
export function removeHookEntries(settingsText: string, hookPath: string): SettingsEdit {
  if (hookPath.trim() === '') {
    throw new SkydeckError('the hook path is empty, so no hook entry can be told apart');
  }
  const { settings, hooks } = parseForEdit(settingsText);
  const removed: HookEvent[] = [];
  let changed = false;
  if (hooks !== null) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) {
        continue;
      }
      const kept: unknown[] = [];
      let touched = false;
      for (const group of groups as unknown[]) {
        if (!isObject(group) || !Array.isArray(group['hooks'])) {
          kept.push(group);
          continue;
        }
        const own = (group['hooks'] as unknown[]).filter(
          (hook) =>
            isObject(hook) &&
            typeof hook['command'] === 'string' &&
            hook['command'].includes(hookPath),
        );
        if (own.length === 0) {
          kept.push(group);
          continue;
        }
        touched = true;
        const left = (group['hooks'] as unknown[]).filter((hook) => !own.includes(hook));
        if (left.length > 0) {
          kept.push({ ...group, hooks: left });
        }
      }
      if (!touched) {
        continue;
      }
      changed = true;
      if (isHookEvent(event)) {
        removed.push(event);
      }
      if (kept.length > 0) {
        hooks[event] = kept;
      } else {
        delete hooks[event];
      }
    }
  }
  if (!changed) {
    return { text: settingsText, changed: false, events: [] };
  }
  if (hooks !== null && Object.keys(hooks).length === 0) {
    delete settings['hooks'];
  }
  return {
    text: serialize(settings),
    changed: true,
    events: HOOK_EVENTS.filter((event) => removed.includes(event)),
  };
}

/**
 * For each event: does an entry whose command equals hookCommand(hookPath, event) exist? Settings
 * that cannot be read, or whose hooks have the wrong shape, have no entries. Throws SkydeckError
 * like hookCommand when hookPath contains a quote.
 */
export function hookStatus(
  settingsText: string | null,
  hookPath: string,
): Record<HookEvent, boolean> {
  const status: Record<HookEvent, boolean> = { SessionStart: false, SessionEnd: false };
  const hooks = parseLoosely(settingsText)?.['hooks'];
  for (const event of HOOK_EVENTS) {
    const command = hookCommand(hookPath, event);
    status[event] = isObject(hooks) && commandsOf(hooks[event]).includes(command);
  }
  return status;
}

/**
 * cleanupPeriodDays when it is a positive safe integer, else 30 (task 10 turns it into a BigInt
 * duration). Unparsable or null text → 30.
 */
export function cleanupPeriodDays(settingsText: string | null): number {
  const days = parseLoosely(settingsText)?.['cleanupPeriodDays'];
  return typeof days === 'number' && Number.isSafeInteger(days) && days > 0 ? days : 30;
}
