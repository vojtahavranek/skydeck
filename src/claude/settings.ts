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
 * A JSON.parse reviver. Node 24.12 and later pass the source text of a primitive value as the
 * third argument; the TypeScript library has no type for it yet.
 */
type Reviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

/** The top-level object of a settings file that has to be edited; SkydeckError when it is not one. */
function parseObject(text: string, reviver?: Reviver): Json {
  let settings: unknown;
  try {
    settings = JSON.parse(text, reviver);
  } catch (error) {
    throw new SkydeckError(`settings.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(settings)) {
    throw new SkydeckError('settings.json must hold a JSON object');
  }
  return settings;
}

/**
 * Parses a settings file that has to be edited: a JSON object whose `hooks`, when present, is an
 * object, and whose `hooks.<event>`, when present, is an array.
 */
function parseForEdit(text: string): { settings: Json; hooks: Json | null } {
  const settings = parseObject(text);
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

export interface RewriteReport {
  /** Writing the file back unchanged would not give the same bytes: the rest of it is reformatted. */
  reformatted: boolean;
  /**
   * Where the numbers are that would not come back with their digits (content, not formatting):
   * integers a double cannot hold, decimals with more digits than it keeps, numbers too large for
   * it. Each place once, in file order, as a path: `env.TOKEN_ID`, `a.b[1]`; a key that is empty or
   * holds a dot, a bracket, a quote or white space is written as a JSON string (`""`, `x."a.b"`).
   */
  lossyPaths: string[];
}

/** A key as a segment of a path: as it is when it is plain, else as a JSON string. */
function segment(key: string): string {
  return /^[^\s.[\]"]+$/.test(key) ? key : JSON.stringify(key);
}

/** The path of `key` in `holder`, which is at `holderPath` (the root is at ''). */
function childPath(holder: unknown, holderPath: string, key: string): string {
  if (Array.isArray(holder)) {
    return `${holderPath}[${key}]`;
  }
  return holderPath === '' ? segment(key) : `${holderPath}.${segment(key)}`;
}

/** The path of every object and array in `root`. */
function pathsOf(root: unknown): Map<object, string> {
  const paths = new Map<object, string>();
  const visit = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    paths.set(node, path);
    for (const [key, child] of Object.entries(node)) {
      visit(child, childPath(node, path, key));
    }
  };
  visit(root, '');
  return paths;
}

/** A number literal as sign, digits without zeros at either end, and exponent: equal literals are equal numbers. */
function canonicalNumber(literal: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (match === null) {
    return null;
  }
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  const digits = (whole + fraction).replace(/^0+/, '');
  const trimmed = digits.replace(/0+$/, '');
  if (trimmed === '') {
    return '0';
  }
  return `${sign}${trimmed}e${Number(exponent) - fraction.length + (digits.length - trimmed.length)}`;
}

/**
 * What `serialize(parse(text))`, which is what install and uninstall write, would change besides
 * the entries: the bytes of the rest of the file (indentation, a missing newline at the end,
 * number spellings, a duplicate key that collapses), and the numbers whose digits would not
 * survive. Throws SkydeckError like the editing functions when the text is not a JSON object.
 */
export function rewriteReport(text: string): RewriteReport {
  const lossy: { holder: unknown; key: string }[] = [];
  const settings = parseObject(text, function (key, value, context) {
    const source = context?.source;
    if (
      typeof value === 'number' &&
      source !== undefined &&
      canonicalNumber(JSON.stringify(value)) !== canonicalNumber(source)
    ) {
      lossy.push({ holder: this, key }); // `this` is the object or array that holds the number
    }
    return value;
  });
  const paths = pathsOf(settings);
  const lossyPaths = new Set<string>();
  for (const { holder, key } of lossy) {
    const holderPath =
      typeof holder === 'object' && holder !== null ? paths.get(holder) : undefined;
    if (holderPath !== undefined) {
      lossyPaths.add(childPath(holder, holderPath, key));
    }
  }
  return { reformatted: serialize(settings) !== text, lossyPaths: [...lossyPaths] };
}

/** The hook objects of the matcher groups in `groups`. Odd shapes are skipped. */
function hooksIn(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return (groups as unknown[]).flatMap((group) =>
    isObject(group) && Array.isArray(group['hooks']) ? (group['hooks'] as unknown[]) : [],
  );
}

/**
 * Is `hook`, found under `event`, one that install wrote: its command is exactly
 * hookCommand(hookPath, event), the whole command and not a part of it? The one test behind
 * install's "already installed", doctor's "present" and uninstall's removal, so that the three can
 * never disagree about what is skydeck's (principle 2: nothing else is ever touched). Throws
 * SkydeckError like hookCommand when hookPath contains a quote.
 */
function isOwnHook(hook: unknown, event: string, hookPath: string): boolean {
  return isHookEvent(event) && isObject(hook) && hook['command'] === hookCommand(hookPath, event);
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
    if (!hooksIn(groups).some((hook) => isOwnHook(hook, event, hookPath))) {
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
 * Removes, from each hooked event, the hook objects that install wrote (isOwnHook: the command is
 * exactly hookCommand(hookPath, event)); then drops matcher groups left with no hooks, event arrays
 * left empty, and `hooks` when left empty. Nothing else changes: another hook that merely names
 * the path, a hook under another event, a group or array that was empty before, all stay. `events`
 * names the events that lost an entry; `changed` is true when anything went. Throws SkydeckError
 * when hookPath is empty or blank. A hookPath with a quote cannot be in any command install wrote,
 * so nothing is removed.
 */
export function removeHookEntries(settingsText: string, hookPath: string): SettingsEdit {
  if (hookPath.trim() === '') {
    throw new SkydeckError('the hook path is empty, so no hook entry can be told apart');
  }
  const { settings, hooks } = parseForEdit(settingsText);
  const unchanged: SettingsEdit = { text: settingsText, changed: false, events: [] };
  if (hooks === null || hookPath.includes("'")) {
    return unchanged;
  }
  const removed: HookEvent[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event] as unknown[] | undefined;
    if (groups === undefined) {
      continue;
    }
    const kept: unknown[] = [];
    let touched = false;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const all = group['hooks'] as unknown[];
      const left = all.filter((hook) => !isOwnHook(hook, event, hookPath));
      if (left.length === all.length) {
        kept.push(group);
        continue;
      }
      touched = true;
      if (left.length > 0) {
        kept.push({ ...group, hooks: left });
      }
    }
    if (!touched) {
      continue;
    }
    removed.push(event);
    if (kept.length > 0) {
      hooks[event] = kept;
    } else {
      delete hooks[event];
    }
  }
  if (removed.length === 0) {
    return unchanged;
  }
  if (Object.keys(hooks).length === 0) {
    delete settings['hooks'];
  }
  return { text: serialize(settings), changed: true, events: removed };
}

/**
 * For each event: does an entry that install wrote (isOwnHook) exist? Settings that cannot be
 * read, or whose hooks have the wrong shape, have no entries. When hookPath contains a quote,
 * hookCommand's SkydeckError is thrown as soon as a hook of one of the two events is compared with
 * it: for settings that have no such hook the answer is false and nothing is thrown.
 */
export function hookStatus(
  settingsText: string | null,
  hookPath: string,
): Record<HookEvent, boolean> {
  const status: Record<HookEvent, boolean> = { SessionStart: false, SessionEnd: false };
  const hooks = parseLoosely(settingsText)?.['hooks'];
  for (const event of HOOK_EVENTS) {
    status[event] =
      isObject(hooks) && hooksIn(hooks[event]).some((hook) => isOwnHook(hook, event, hookPath));
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
