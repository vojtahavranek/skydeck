export interface LaunchSpec {
  cwd: string;
  argv: readonly string[];
}

/**
 * `timedOut`: the adapter's call was killed for taking too long, so the program may have started
 * anyway (a WezTerm tab may have opened). A caller must not offer a command to run by hand then.
 */
export type OpenResult = { ok: true } | { ok: false; error: string; timedOut: boolean };

export interface Terminal {
  readonly name: 'here' | 'wezterm';
  /** true when open() starts the program in a new tab and returns; false for 'here'. */
  readonly opensTabs: boolean;
  open(spec: LaunchSpec): Promise<OpenResult>;
}
