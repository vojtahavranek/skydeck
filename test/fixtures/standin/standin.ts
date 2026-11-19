/**
 * The stand-in for Claude Code in tests (plan 2.4, S2 17.1): a terminal program that sends the
 * queries Claude Code sends, draws, reacts to resizes and input, and a session that writes a
 * live-session file and runs the real hook, all under the control of typed commands; and, given
 * `--version` alone, one line naming its version (follow-up F20). Nothing else.
 *
 * It refuses to run outside a sandbox: STANDIN_RECORD, SKYDECK_HOME and CLAUDE_CONFIG_DIR must be
 * absolute paths (A33). It writes nothing but its record file, `<CLAUDE_CONFIG_DIR>/sessions/` and
 * what the hook writes under SKYDECK_HOME, and it ends itself when its record file's directory is
 * gone (a crashed test) or after 10 minutes (STANDIN_MAX_SECONDS, 1 to 600, can only shorten
 * that; any other value is refused). It always runs the repository's `bin/skydeck-hook`.
 *
 * The test helper `test/helpers/standin.ts` starts it and reads its records.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import type { StandinRecord } from '../../helpers/standin.ts';

// ---------------------------------------------------------------------------------------------
// The sandbox check comes first: nothing above this line may write anything.

const REQUIRED = ['STANDIN_RECORD', 'SKYDECK_HOME', 'CLAUDE_CONFIG_DIR'] as const;
const missing = REQUIRED.filter((name) => !isAbsolute(process.env[name] ?? ''));
// The 10 minutes can only be shortened (A33): a larger value could keep a stand-in alive for
// days, and one above 2^31 ms would overflow Node's timer and end it at once.
const maxText = process.env['STANDIN_MAX_SECONDS'];
const maxSeconds = maxText === undefined ? 600 : secondsUpTo600(maxText);
const problems = [
  ...(missing.length > 0 ? [`${missing.join(', ')} must be set to an absolute path`] : []),
  ...(maxSeconds === null ? ['STANDIN_MAX_SECONDS must be a number of seconds from 1 to 600'] : []),
];
if (problems.length > 0) {
  process.stderr.write(`standin: ${problems.join('; ')}; refusing to run\n`);
  process.exit(2);
}

// `--version` alone (follow-up F20: what `skydeck doctor` asks the program it starts sessions
// with): one line in the form Claude Code prints its version, and nothing else is done or written.
// A write to a pipe or a file is synchronous on Linux, so the line is out before the exit.
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('0.0.0-standin (Claude Code)\n');
  process.exit(0);
}

const RECORD = process.env['STANDIN_RECORD'] as string;
const RECORD_DIR = dirname(RECORD);
const CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'] as string;
const HOOK = fileURLToPath(new URL('../../../bin/skydeck-hook', import.meta.url));
const MAX_SECONDS = maxSeconds as number;
const ANSWER_WAIT_MS = 2000;

const ESC = '\x1b';
const ST = `${ESC}\\`;

/** A decimal number of seconds from 1 to 600, else null. */
function secondsUpTo600(text: string): number | null {
  const value = /^[0-9]+(\.[0-9]+)?$/.test(text) ? Number(text) : NaN;
  return value >= 1 && value <= 600 ? value : null;
}

function positive(text: string | undefined): number | null {
  const value = Number(text);
  return text !== undefined && text !== '' && Number.isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Records, and ending at once when the test's directory is gone.

type Body<R = StandinRecord> = R extends unknown ? Omit<R, 'pid' | 'ms'> : never;

function gone(): boolean {
  return !existsSync(RECORD_DIR);
}

/**
 * The test that started it is gone with its sandbox: end now and write nothing, since the hook
 * would create `$SKYDECK_HOME/state/spool` again and leave a directory behind.
 */
function vanish(): never {
  process.exit(0);
}

function record(body: Body): void {
  if (gone()) {
    vanish();
  }
  const line = `${JSON.stringify({ pid: process.pid, ms: Date.now(), ...body })}\n`;
  try {
    appendFileSync(RECORD, line);
  } catch (error) {
    if (gone()) {
      vanish();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The screen. Lines end with "\n": raw mode keeps the terminal's ONLCR, as it does for Claude
// Code, so the terminal receives "\r\n".

let screen = '';

function draw(text: string): void {
  screen += text;
}

function flush(): void {
  if (screen !== '') {
    const text = screen;
    screen = '';
    process.stdout.write(text);
  }
}

// After a hangup every write fails; that is not worth a crash.
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});

function size(): { cols: number | null; rows: number | null } {
  return process.stdout.isTTY
    ? { cols: process.stdout.columns, rows: process.stdout.rows }
    : { cols: null, rows: null };
}

// ---------------------------------------------------------------------------------------------
// The session.

const cwd = process.cwd();
const startedAt = Date.now();
const args = process.argv.slice(2);
const given = argument(['--session-id']) ?? argument(['--resume', '-r']);
const resumed = argument(['--resume', '-r']) !== null;
let sessionId = given ?? randomUUID();
let name = argument(['-n']);
let status = 'idle';
let waitingFor: string | null = null;
let statusUpdatedAt = startedAt;
const procStart = ownProcStart();
const SESSIONS = join(CONFIG_DIR, 'sessions');
const LIVE = join(SESSIONS, `${process.pid}.json`);

/** The value after the first of `flags` in the arguments, or null. */
function argument(flags: string[]): string | null {
  const at = args.findIndex((arg) => flags.includes(arg));
  return at === -1 ? null : (args[at + 1] ?? null);
}

/** Field 22 of /proc/self/stat (the process start), as a decimal string. */
function ownProcStart(): string | null {
  const line = readFileSync('/proc/self/stat', 'utf8');
  const fields = line
    .slice(line.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  return fields[19] ?? null;
}

/** The soft "Max core file size" of /proc/self/limits as written there. */
function coreSoft(): string | null {
  const limits = readFileSync('/proc/self/limits', 'utf8');
  return /^Max core file size\s+(\S+)/m.exec(limits)?.[1] ?? null;
}

/** `<claudeHome>/sessions/<pid>.json` in the shape of Claude Code's (written whole, by rename). */
function writeLive(): void {
  if (gone()) {
    vanish();
  }
  try {
    mkdirSync(SESSIONS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const file = {
    pid: process.pid,
    sessionId,
    cwd,
    startedAt,
    procStart,
    version: 'standin',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    status,
    updatedAt: Date.now(),
    statusUpdatedAt,
    ...(name !== null ? { name } : {}),
    ...(waitingFor !== null ? { waitingFor } : {}),
  };
  const temporary = join(SESSIONS, `.${process.pid}.json.tmp`);
  writeFileSync(temporary, `${JSON.stringify(file)}\n`);
  renameSync(temporary, LIVE);
}

function removeLive(): void {
  if (gone()) {
    vanish();
  }
  rmSync(LIVE, { force: true });
}

function setStatus(next: string, what: string | null): void {
  status = next;
  waitingFor = what;
  statusUpdatedAt = Date.now();
  writeLive();
}

/** Runs the real hook as Claude Code does: the input on stdin, CLAUDE_PID set (design 5.1). */
function runHook(event: 'SessionStart' | 'SessionEnd', extra: Record<string, string>): void {
  if (gone()) {
    vanish();
  }
  const input = {
    session_id: sessionId,
    transcript_path: join(
      CONFIG_DIR,
      'projects',
      cwd.replace(/[^A-Za-z0-9]/g, '-'),
      `${sessionId}.jsonl`,
    ),
    cwd,
    hook_event_name: event,
    ...extra,
  };
  spawnSync(HOOK, [event], {
    cwd,
    input: `${JSON.stringify(input)}\n`,
    env: {
      ...process.env,
      CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 10_000,
  });
}

/**
 * Ends the program: the end event, the live file removed, the exit record last. When the test's
 * directory is gone meanwhile, each of these ends it at once instead, writing nothing (A33).
 */
function finish(code: number, endReason: string | null, removeLiveFile: boolean): never {
  flush();
  if (endReason !== null) {
    runHook('SessionEnd', { reason: endReason });
  }
  if (removeLiveFile) {
    removeLive();
  }
  record({ ev: 'exit', code });
  process.exit(code);
}

// ---------------------------------------------------------------------------------------------
// Queries to the terminal and their answers.

type QueryName = Extract<StandinRecord, { ev: 'answer' }>['query'];

const QUERIES: Record<QueryName, { send: string; answer: RegExp }> = {
  DA1: { send: `${ESC}[c`, answer: /\x1b\[\?[0-9;]*c/ },
  DA2: { send: `${ESC}[>c`, answer: /\x1b\[>[0-9;]*c/ },
  CPR: { send: `${ESC}[6n`, answer: /\x1b\[[0-9]+;[0-9]+R/ },
  'DECRQM 2026': { send: `${ESC}[?2026$p`, answer: /\x1b\[\?2026;[0-9]+\$y/ },
  'DECRQSS m': { send: `${ESC}P$qm${ST}`, answer: /\x1bP[01]\$r[^\x1b]*\x1b\\/ },
  XTVERSION: { send: `${ESC}[>0q`, answer: /\x1bP>\|[^\x1b]*\x1b\\/ },
  'OSC 10': { send: `${ESC}]10;?${ST}`, answer: /\x1b\]10;[^\x07\x1b]*(?:\x07|\x1b\\)/ },
  'OSC 11': { send: `${ESC}]11;?${ST}`, answer: /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/ },
};

interface Asked {
  answers: Map<QueryName, string>;
  /** What arrived meanwhile that answers nothing: input, handed on by the caller. */
  rest: Buffer;
}

/** While a question is open, everything read goes to it. */
let asking: ((chunk: Buffer) => void) | null = null;

/**
 * Sends the queries and collects their answers, in any order, until each has one or `waitMs`
 * passed. `before` is what was read before and not yet handed on.
 */
function ask(names: QueryName[], waitMs: number, before: Buffer): Promise<Asked> {
  return new Promise((resolve) => {
    const answers = new Map<QueryName, string>();
    const open = [...names];
    // latin1 keeps every byte as one character, so that the rest goes back unchanged.
    let heard = '';
    const done = (): void => {
      clearTimeout(timer);
      asking = null;
      resolve({ answers, rest: Buffer.from(heard, 'latin1') });
    };
    const hear = (chunk: Buffer): void => {
      heard += chunk.toString('latin1');
      for (const query of [...open]) {
        const match = QUERIES[query].answer.exec(heard);
        if (match !== null) {
          answers.set(query, Buffer.from(match[0], 'latin1').toString('utf8'));
          heard = heard.slice(0, match.index) + heard.slice(match.index + match[0].length);
          open.splice(open.indexOf(query), 1);
        }
      }
      if (open.length === 0) {
        done();
      }
    };
    const timer = setTimeout(done, waitMs);
    asking = hear;
    draw(names.map((query) => QUERIES[query].send).join(''));
    flush();
    if (before.length > 0) {
      hear(before);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Input: every chunk is recorded; printable text is echoed; "\r" ends a line; a line that starts
// with "/" is a command; "\n" is echoed as ⏎; any other control character in caret notation
// (ESC as ^[, so a bracketed paste shows its markers).

const decoder = new StringDecoder('utf8');
let pending = '';
/** True while no prompt is up: at start, during /stall and /query. Input waits in `pending`. */
let blocked = true;
let line = '';
let lineEcho = '';
let onAlt = false;

process.stdin.on('data', (chunk: Buffer) => {
  if (asking !== null) {
    asking(chunk);
  } else {
    receive(chunk);
  }
});

function receive(chunk: Buffer): void {
  if (chunk.length > 0) {
    record({ ev: 'input', hex: chunk.toString('hex') });
    pending += decoder.write(chunk);
  }
  pump();
}

function caret(char: string): string {
  const code = char.charCodeAt(0);
  return code === 0x7f ? '^?' : `^${String.fromCharCode(code + 64)}`;
}

function pump(): void {
  while (!blocked && pending !== '') {
    const control = /[\x00-\x1f\x7f]/.exec(pending);
    const end = control === null ? pending.length : control.index;
    if (end > 0) {
      const text = pending.slice(0, end);
      pending = pending.slice(end);
      line += text;
      lineEcho += text;
      draw(text);
      continue;
    }
    const char = pending[0] as string;
    pending = pending.slice(1);
    if (char === '\r') {
      const entered = line;
      line = '';
      lineEcho = '';
      draw('\n');
      enter(entered);
    } else if (char === '\n') {
      line += '\n';
      lineEcho += '⏎';
      draw('⏎');
    } else {
      line += char;
      lineEcho += caret(char);
      draw(caret(char));
    }
  }
  flush();
}

function promptText(): string {
  return `standin ${sessionId.slice(0, 8)}> `;
}

/** Puts the prompt up and handles the input that waited. */
function unblock(): void {
  blocked = false;
  draw(promptText());
  pump();
}

function enter(text: string): void {
  if (text.startsWith('/')) {
    command(text);
  } else {
    draw(promptText());
  }
}

// ---------------------------------------------------------------------------------------------
// Commands.

function command(text: string): void {
  const space = text.indexOf(' ');
  const word = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? '' : text.slice(space + 1);
  switch (word) {
    case '/exit':
      draw(`${onAlt ? `${ESC}[?1049l` : ''}${ESC}[?2004l`);
      finish(0, 'prompt_input_exit', true);
    case '/fail':
      // An exit status is one byte: record the one the process really ends with.
      finish(/^[0-9]+$/.test(rest) ? Number(rest) % 256 : 1, null, false);
    case '/clear':
      runHook('SessionEnd', { reason: 'clear' });
      sessionId = randomUUID();
      name = null;
      runHook('SessionStart', { source: 'clear' });
      writeLive();
      break;
    case '/busy':
      setStatus('busy', null);
      break;
    case '/idle':
      setStatus('idle', null);
      break;
    case '/waiting':
      setStatus('waiting', rest);
      break;
    case '/alt':
      onAlt = true;
      draw(`${ESC}[?1049h${frame()}`);
      break;
    case '/main':
      onAlt = false;
      draw(`${ESC}[?1049l`);
      break;
    case '/mouse':
      draw(`${ESC}[?1000h${ESC}[?1006h`);
      break;
    case '/hide-cursor':
      draw(`${ESC}[?25l`);
      break;
    case '/cursor':
      draw(`${ESC}[${/^[0-9]+$/.test(rest) ? rest : '0'} q`);
      break;
    case '/red':
      draw(`${ESC}[31m${rest}${ESC}[0m\n`);
      break;
    case '/lines':
      draw(numbered(rest));
      break;
    case '/flood':
      flood(/^[0-9]+$/.test(rest) ? Number(rest) : 0);
      break;
    case '/stall':
      stall(positive(rest) ?? 0);
      return;
    case '/osc52':
      draw(`${ESC}]52;c;${Buffer.from(rest, 'utf8').toString('base64')}${ST}`);
      break;
    case '/link': {
      const gap = rest.indexOf(' ');
      const url = gap === -1 ? rest : rest.slice(0, gap);
      const label = gap === -1 ? rest : rest.slice(gap + 1);
      draw(`${ESC}]8;;${url}${ST}${label}${ESC}]8;;${ST}\n`);
      break;
    }
    case '/query':
      query();
      return;
    case '/title':
      draw(`${ESC}]2;${rest}${ST}`);
      break;
    case '/wide':
      // A plain emoji, a ZWJ sequence (woman technologist) and one with a skin tone.
      draw('wide 🙂 👩‍💻 👍🏽 end\n');
      break;
    default:
      draw(`unknown command: ${word}\n`);
  }
  draw(promptText());
}

/** A box around the whole screen with its size in it; the prompt goes inside. */
function frame(): string {
  const { cols, rows } = size();
  const width = Math.max(cols ?? 80, 4);
  const height = Math.max(rows ?? 24, 4);
  let text = `${ESC}[2J${ESC}[H┌${'─'.repeat(width - 2)}┐`;
  for (let row = 2; row < height; row++) {
    text += `${ESC}[${row};1H│${ESC}[${row};${width}H│`;
  }
  text += `${ESC}[${height};1H└${'─'.repeat(width - 2)}┘`;
  return `${text}${ESC}[2;3Halt screen ${width}x${height}${ESC}[3;3H`;
}

function numbered(count: string): string {
  const n = /^[0-9]+$/.test(count) ? Number(count) : 0;
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`line ${i}\n`);
  }
  return lines.join('');
}

/** Exactly `total` bytes of numbered lines, written as fast as the terminal takes them. */
function flood(total: number): void {
  flush();
  let written = 0;
  let chunk = '';
  for (let n = 1; written < total; n++) {
    let text = `flood ${String(n).padStart(8, '0')} ${'.'.repeat(64)}\n`;
    if (written + text.length > total) {
      text = text.slice(0, total - written);
    }
    chunk += text;
    written += text.length;
    if (chunk.length >= 65536) {
      process.stdout.write(chunk);
      chunk = '';
    }
  }
  draw(chunk);
}

/** Reads no input for `seconds`; what arrives meanwhile is read afterwards. */
function stall(seconds: number): void {
  blocked = true;
  process.stdin.pause();
  draw(`stalling ${seconds} s\n`);
  flush();
  setTimeout(() => {
    process.stdin.resume();
    unblock();
  }, seconds * 1000);
}

const ORDER: QueryName[] = [
  'DA1',
  'DA2',
  'CPR',
  'DECRQM 2026',
  'DECRQSS m',
  'XTVERSION',
  'OSC 10',
  'OSC 11',
];

function query(): void {
  blocked = true;
  flush();
  void ask(ORDER, ANSWER_WAIT_MS, Buffer.alloc(0)).then(({ answers, rest }) => {
    for (const asked of ORDER) {
      const answer = answers.get(asked);
      if (answer !== undefined) {
        record({ ev: 'answer', query: asked, answer });
      }
    }
    unblock();
    receive(rest);
  });
}

// ---------------------------------------------------------------------------------------------
// Signals and timers.

process.stdout.on('resize', () => {
  const { cols, rows } = size();
  if (cols === null || rows === null) {
    return;
  }
  record({ ev: 'resize', cols, rows });
  const prompt = blocked ? '' : `${promptText()}${lineEcho}`;
  draw(onAlt ? `${frame()}${prompt}` : `\r${ESC}[2Ksize ${cols}x${rows}\n${prompt}`);
  flush();
});

process.on('SIGHUP', () => {
  screen = '';
  record({ ev: 'hup' });
  finish(129, 'other', true);
});

setInterval(() => {
  if (gone()) {
    vanish();
  }
}, 1000);

setTimeout(() => {
  finish(0, 'other', true);
}, MAX_SECONDS * 1000);

// ---------------------------------------------------------------------------------------------
// Start.

async function main(): Promise<void> {
  record({
    ev: 'start',
    argv: args,
    cwd,
    envNames: Object.keys(process.env).sort(),
    env: {
      TERM: process.env['TERM'] ?? null,
      COLORTERM: process.env['COLORTERM'] ?? null,
      PWD: process.env['PWD'] ?? null,
      WSL_INTEROP: process.env['WSL_INTEROP'] ?? null,
    },
    coreSoft: coreSoft(),
    ...size(),
  });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const da1 = await ask(['DA1'], ANSWER_WAIT_MS, Buffer.alloc(0));
  const da1Answer = da1.answers.get('DA1') ?? null;
  record({ ev: 'da1', answer: da1Answer });
  let rest = da1.rest;
  if (da1Answer === null) {
    // A terminal that does not answer DA1 answers nothing: CPR is sent, not waited for.
    draw(`no answer to DA1\n${QUERIES.CPR.send}`);
    flush();
    record({ ev: 'cpr', answer: null });
  } else {
    const cpr = await ask(['CPR'], ANSWER_WAIT_MS, rest);
    record({ ev: 'cpr', answer: cpr.answers.get('CPR') ?? null });
    rest = cpr.rest;
  }

  runHook('SessionStart', {
    source: resumed ? 'resume' : 'startup',
    ...(name !== null ? { session_title: name } : {}),
  });
  writeLive();
  // Bracketed paste on, as Claude Code has it, so that a terminal wraps a paste in its markers.
  draw(`${ESC}[?2004h`);
  unblock();
  receive(rest);
}

void main();
