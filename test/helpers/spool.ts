/**
 * Spool files as `bin/skydeck-hook` writes them (plan 2.10.1), for the tests of ingest, the list
 * and restore. Values are copied verbatim, as the hook does: a test that needs a value with a
 * carriage return gets one, although a real hook would have written it empty.
 */
import { BOOT_A, statLine } from './platform.ts';

export interface SpoolFields {
  event: 'SessionStart' | 'SessionEnd';
  timeNs: bigint;
  /** null: `claude_pid` is empty (and so is `stat`, as the hook does when it has no process). */
  pid: number | null;
  /** An object is written as `JSON.stringify(input) + '\n'`; a string is written unchanged. */
  input: Record<string, unknown> | string;
  /** Default: `input.session_id` when it is a string, else ''. */
  sessionEnv?: string;
  /** Default 'cli'. */
  entrypointEnv?: string;
  /** Default BOOT_A. */
  bootId?: string;
  /** Field 22 of the stat line. Default 51234567; null: `stat` is empty. */
  procStart?: number | null;
  /** Default '/home/dev/projects/demo'. */
  pwd?: string;
  /**
   * The recorded launch command; written as `argv_b64` for SessionStart only (a SessionEnd never
   * has the line). Default ['claude']; null: `argv_b64` is empty.
   */
  argv?: readonly string[] | null;
}

/** `${timeNs}-${pid ?? 0}-${seq}.ev` */
export function spoolName(fields: SpoolFields, seq: number): string {
  return `${fields.timeNs}-${fields.pid ?? 0}-${seq}.ev`;
}

/** The text of a spool file: the keys in the hook's order, a line `--`, then the input. */
export function spoolText(fields: SpoolFields): string {
  const { input } = fields;
  const sessionEnv =
    fields.sessionEnv ??
    (typeof input === 'object' && typeof input['session_id'] === 'string'
      ? input['session_id']
      : '');
  const procStart = fields.procStart === undefined ? 51234567 : fields.procStart;
  const stat =
    fields.pid === null || procStart === null ? '' : statLine(fields.pid, procStart, 'claude');
  const lines = [
    'v=1',
    `event=${fields.event}`,
    `time_ns=${fields.timeNs}`,
    `claude_pid=${fields.pid ?? ''}`,
    `session_env=${sessionEnv}`,
    `entrypoint_env=${fields.entrypointEnv ?? 'cli'}`,
    `boot_id=${fields.bootId ?? BOOT_A}`,
    `stat=${stat}`,
    `pwd=${fields.pwd ?? '/home/dev/projects/demo'}`,
  ];
  if (fields.event === 'SessionStart') {
    const argv = fields.argv === undefined ? ['claude'] : fields.argv;
    const encoded =
      argv === null
        ? ''
        : Buffer.from(argv.map((a) => `${a}\0`).join(''), 'utf8').toString('base64');
    lines.push(`argv_b64=${encoded}`);
  }
  lines.push('--');
  const body = typeof input === 'string' ? input : `${JSON.stringify(input)}\n`;
  return `${lines.join('\n')}\n${body}`;
}

/** A hook input as the fixtures have it: session_id, transcript_path, cwd, hook_event_name, plus extra. */
export function hookInput(
  event: 'SessionStart' | 'SessionEnd',
  sessionId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: `/home/dev/.claude/projects/-home-dev-projects-demo/${sessionId}.jsonl`,
    cwd: '/home/dev/projects/demo',
    hook_event_name: event,
    ...extra,
  };
}
