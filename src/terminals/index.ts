import type { Config } from '../platform/config.ts';
import type { Platform } from '../platform/types.ts';
import { hereTerminal } from './here.ts';
import type { Terminal } from './types.ts';
import { weztermTerminal } from './wezterm.ts';

export type { LaunchSpec, OpenResult, Terminal } from './types.ts';

/** 'here' → hereTerminal; 'wezterm' → weztermTerminal(config.wezterm.domain). */
export function terminalFor(
  name: 'here' | 'wezterm',
  platform: Platform,
  config: Config,
): Terminal {
  return name === 'here'
    ? hereTerminal({ files: platform.files, env: platform.env })
    : weztermTerminal({ runner: platform.runner, env: platform.env }, config.wezterm.domain);
}
