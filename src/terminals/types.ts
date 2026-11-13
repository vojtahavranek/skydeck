export interface LaunchSpec {
  cwd: string;
  argv: readonly string[];
}

export type OpenResult = { ok: true } | { ok: false; error: string };

export interface Terminal {
  readonly name: 'here' | 'wezterm';
  /** true when open() starts the program in a new tab and returns; false for 'here'. */
  readonly opensTabs: boolean;
  open(spec: LaunchSpec): Promise<OpenResult>;
}
