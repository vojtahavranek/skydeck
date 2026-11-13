import type { Ns } from '../platform/types.ts';

/**
 * A prepared launch as a terminal gets it (S2 11.1). The `here` and `wezterm` adapters use only
 * `cwd` and `argv`; the window terminal needs the rest for its keeper's spec (S2 7.1, 11.2).
 */
export interface LaunchSpec {
  cwd: string;
  argv: readonly string[];
  sessionId: string;
  kind: 'resume' | 'new';
  /** The resume lock's value this launch took; null for `new`. */
  lock: string | null;
  /** S2 7.1 `startBy` (A20). */
  startByNs: Ns;
  label: string | null;
}

/**
 * `timedOut`: the adapter's call was killed for taking too long, so the program may have started
 * anyway (a WezTerm tab may have opened). A caller must not offer a command to run by hand then.
 */
export type OpenResult = { ok: true } | { ok: false; error: string; timedOut: boolean };

export interface Terminal {
  /** 'window' exists only inside the server (S2 11.2); terminalFor never returns it. */
  readonly name: 'here' | 'wezterm' | 'window';
  /** true when open() starts the program in a new tab and returns; false for 'here'. */
  readonly opensTabs: boolean;
  open(spec: LaunchSpec): Promise<OpenResult>;
}
