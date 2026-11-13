import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Command } from './command.ts';
import type { Context } from './context.ts';
import { EXIT } from './exit.ts';
import pkg from '../../package.json' with { type: 'json' };
import { RefError, SkydeckError } from '../platform/errors.ts';
import { sanitize } from '../text/sanitize.ts';

/** A command name: the file name, without `.ts`, of a file in the commands directory. */
const COMMAND_NAME = /^[a-z][a-z-]*$/;

const COMMANDS_DIR = new URL('./commands/', import.meta.url);

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[], ctx: Context): Promise<number> {
  return dispatch(argv, ctx, COMMANDS_DIR);
}

/**
 * `main` with the commands directory as a parameter, so tests can use a directory of fixtures.
 * A command is `<commandsDir>/<name>.ts`; adding one never edits this file.
 */
export async function dispatch(argv: string[], ctx: Context, commandsDir: URL): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    // Becomes the interactive list (design 7.5); until that command exists it is the usage.
    ctx.io.stdout(await usage(commandsDir));
    return EXIT.ok;
  }
  if ((first === '--help' || first === '-h') && rest.length === 0) {
    ctx.io.stdout(await usage(commandsDir));
    return EXIT.ok;
  }
  if ((first === '--version' || first === '-V') && rest.length === 0) {
    ctx.io.stdout(`${pkg.version}\n`);
    return EXIT.ok;
  }
  if (COMMAND_NAME.test(first)) {
    const command = await loadCommand(first, commandsDir);
    if (command !== undefined) {
      return runCommand(command, rest, ctx);
    }
  }
  ctx.io.stderr(await usage(commandsDir));
  return EXIT.usage;
}

/**
 * Runs a command and turns what it throws into an exit code (design 7.5): a `SkydeckError` prints
 * its message and exits with its `exitCode`; anything else is a bug and exits 1.
 */
async function runCommand(command: Command, args: string[], ctx: Context): Promise<number> {
  try {
    return await command.run(args, ctx);
  } catch (error) {
    ctx.io.stderr(failureText(error));
    return error instanceof SkydeckError ? error.exitCode : EXIT.failure;
  }
}

/**
 * What a command's failure looks like on stderr. A message and a candidate's title may carry text
 * from the disk or from GitHub, so every line goes through the sanitiser; the line breaks of a
 * `SkydeckError` message are kept (a usage text follows its reason on lines of its own).
 */
function failureText(error: unknown): string {
  if (!(error instanceof SkydeckError)) {
    return `skydeck: internal error: ${sanitize(messageOf(error))}\n`;
  }
  const lines = error.message.replace(/\n$/, '').split('\n');
  if (error instanceof RefError) {
    for (const { id, title } of error.candidates) {
      lines.push(`  ${id.slice(0, 8)}  ${title}`);
    }
  }
  return `skydeck: ${lines.map(sanitize).join('\n')}\n`;
}

/** The message of anything that was thrown, also of a value that has no text (`Object.create(null)`). */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return 'unprintable value';
  }
}

/** Loads `<name>.ts`; undefined when there is no such file. A file that is broken throws. */
async function loadCommand(name: string, commandsDir: URL): Promise<Command | undefined> {
  const file = new URL(`${name}.ts`, commandsDir);
  if (!(await isFile(file))) {
    return undefined;
  }
  const loaded: unknown = await import(file.href);
  const command = (loaded as { command?: Command }).command;
  if (command === undefined || typeof command.run !== 'function' || command.name !== name) {
    throw new Error(`${fileURLToPath(file)} must export \`command\` named "${name}" with a run()`);
  }
  return command;
}

async function isFile(file: URL): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** All commands in the directory, by name. */
async function listCommands(commandsDir: URL): Promise<Command[]> {
  let files: string[];
  try {
    files = await readdir(commandsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const names = files
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -'.ts'.length))
    .filter((name) => COMMAND_NAME.test(name))
    .sort();
  const commands: Command[] = [];
  for (const name of names) {
    const command = await loadCommand(name, commandsDir);
    if (command !== undefined) {
      commands.push(command);
    }
  }
  return commands;
}

async function usage(commandsDir: URL): Promise<string> {
  const commands = await listCommands(commandsDir);
  let text = 'Usage:\n  skydeck [options]\n  skydeck <command> [arguments]\n';
  if (commands.length > 0) {
    const width = Math.max(...commands.map((c) => c.name.length));
    const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
    text += `\nCommands:\n${lines.join('\n')}\n`;
  }
  text += '\nOptions:\n  -h, --help     Show this help\n  -V, --version  Show the version\n';
  if (commands.length > 0) {
    text += "\nRun 'skydeck <command> --help' for the options of a command.\n";
  }
  return text;
}
