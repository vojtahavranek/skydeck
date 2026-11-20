# skydeck — design of step 2: the window

Status: agreed design for step 2, to be built in the stages of section 19. Section 12 (what the
window shows) was approved on a mockup. This document is the
source of truth for step 2, next to [design.md](design.md), which stays the source of truth for
everything step 1 built; when the code and either document disagree, one of them has a bug.
"Design 7.6" means section 7.6 of design.md; a bare section number means a section of this
document.

Every fact this design relies on carries its status in section 21: **verified** (on a WSL
machine, with a stand-in program, never the real `claude`; or by hand on a Windows
PC, which says so), **documentation** (with the page), **inferred**, or **UNVERIFIED** (a person
must check it by hand; section 18).

## 1. Purpose

Step 1 is in use with many sessions, several of them running. Resume
works; but the overview is poor, the list is hard to move around in, and switching between
sessions is slow, because every running session still lives in a terminal tab of its own.

Step 2 adds **the window**: the session list on the left, the real terminal of the selected
session on the right, on top of step 1's data and rules. Sessions are opened, resumed and
started in the window, and keep running when the window, or skydeck's own server, is closed or
restarted.

The decisions that shape it:

1. The window is an **Edge app window** (`msedge.exe --app=<url>`, with a profile folder of its
   own) showing a page that skydeck serves from inside WSL. Step 2 builds no native Windows
   program (a native host stays a later option, section 20).
2. The page talks to **one Node.js server process** inside WSL: web server, WebSocket, the screen
   state of every terminal, and the store.
3. Each terminal is owned by a **keeper**: a small python3 process that holds the pty and the
   program. Restarting or updating the server never ends a session.
4. Nothing new is hooked: the end of a turn comes from Claude Code's live-session file (10.3).

## 2. Principles: what step 2 changes

Design 2 still holds, with these amendments. Each is a change to design 2 made by this document.

- **Principle 1 (the real Claude Code)** is unchanged: the terminal on the right is the real
  `claude` in a real pty, rendered by xterm.js.
- **Principle 3 (a broken skydeck never disturbs a session)** gets one honest exception: a session
  started in the window lives in a pty that its keeper owns, and when a keeper dies its program
  gets SIGHUP and ends (verified with a stand-in, section 21). The keeper is therefore kept
  minimal: python3 standard library only, no interpretation of what the program writes, a
  connection that misbehaves is closed but never ends the keeper, and a running keeper is never
  replaced by a newer one (7.7). The server, the page and Edge can all fail without touching a
  session.
- **Principle 4 (no conversation content)** is extended: the screens of the terminals are
  conversation content, and so is what the user types. They exist only in memory — in the
  server's terminal models, in each keeper's parked snapshot and tail, in the page — and are never
  written to a file, the store or a log by skydeck. Logs name terminals by id and record an error
  caused by a peer's data by its kind only, never by its message (5.2), because an error message
  can quote the data (Node.js's `JSON.parse` error quotes its input).
  **Crash dumps** are the one way memory can reach a file: on WSL a crashing process's core dump is
  piped to WSL's crash collector, which keeps the last ten in a Windows folder (`%Temp%\wsl-crashes`;
  documentation, section 21). A dump of the server would hold every screen, the secret and the
  server's environment; a keeper's, its snapshot, tail and the program's environment. Prevention,
  the cheapest that can be justified: a keeper makes itself non-dumpable (`prctl(PR_SET_DUMPABLE,
  0)` through `ctypes`), which the kernel checks before any dump, piped or not, and which `exec`
  resets, so the program it starts is unaffected. Node.js has no `prctl`, so the server is
  protected another way: a core limit of 0 does **not** stop a piped dump — in the kernel's pipe
  path only a soft limit of exactly 1 byte aborts the dump (`fs/coredump.c`, read for Linux 6.6) —
  and `sh`'s `ulimit -c` counts in blocks and cannot say 1 byte. So the launcher starts `serve`
  through a short program passed with `/usr/bin/python3 -I -S -c` (no file; python3 is already
  required for the window). It is the distribution's python3 and never one found on `PATH`: a
  version manager's shim there (pyenv, asdf) changes `PATH` and sets its own variables before it
  starts the real python3, and those would reach every program in the window. The program sets the soft core limit to 1 byte, keeps the hard limit, puts
  the soft limit it found into `SKYDECK_CORE_SOFT` (its number of bytes in decimal, or
  `unlimited`), and `exec`s Node.js. Node.js starts as it would without python3 in between: the
  program gives back the caller's `LC_CTYPE` (python3 sets it in its own environment under a C
  locale) and sets the two signals python3 ignores by itself (SIGPIPE, SIGXFSZ) back to what the
  caller had (an ignored signal stays ignored across `exec`), since the server's environment
  becomes every program's (7.4). Nothing in the program may keep Node.js from starting: every
  step but the `exec` is optional, and a closed stderr, a pipe nobody reads or a log over the
  file size limit stops none of them (the two signals are handed back only right before the
  `exec`). Keepers inherit the limit; each keeper's
  child sets the soft limit back to that value before it `exec`s the program, so `claude` keeps
  the user's own limit (7.1). When the program cannot set the limit (the hard limit is 0, or
  `setrlimit` fails), it still starts Node.js, without `SKYDECK_CORE_SOFT`, and writes one line
  saying so to `server.log` (to stderr when that file cannot be written). Without
  `/usr/bin/python3` (missing, or not executable) the launcher starts `serve` directly and writes
  one line saying that the server's dumps are not prevented to `server.log` (to stderr when that
  file cannot be written); a python3 elsewhere on `PATH` may still run the keepers, so the
  server can open terminals all the same. That a limit of 1 aborts the dump on WSL's
  kernel 6.18 (not read) is **UNVERIFIED** (check W24).
- **Principle 6 (nothing is destroyed or moved automatically; skydeck never stops a process by
  itself)** is made precise: skydeck never stops a `claude` process or a keeper by itself
  (stopping a keeper would end its session). It may stop its own server and its own keep-alive
  process (6.1). The window has no "kill" action. It ends a session's program only when the user
  asks for it, each time, in the dialog "Mark done" of a session running in a terminal of the
  window (follow-up F30, 12.10): its keeper sends that program SIGHUP and then SIGCONT, what the
  kernel sends when a terminal's window is closed, and nothing else — never SIGTERM or SIGKILL, and
  never to a session in another terminal. Every other session ends when the user ends it inside
  `claude`.
- **Principle 8 (local only)**: the server listens on the loopback interface only (15). The only
  network use is still `gh`.
- **Windows programs.** Step 2 is the first time skydeck starts Windows programs by itself, through
  WSL interop. It starts exactly three, and only these: `msedge.exe` (the window, 5.3, and the
  links the window opens when `window.links` is `"edge"`, 9.6), `rundll32.exe` (the links the
  window opens, handed to the Windows default browser, 9.6) and `wsl.exe` (the keep-alive, 6.1).
  Never `cmd.exe`, `powershell.exe`, `explorer.exe` or a shell; arguments are passed as an argument
  list. Every such start goes through one function
  (`startWindowsProgram`), which refuses an argument that is empty, holds a `"` or a control
  character, or ends with a backslash: the program receives one command line and splits it
  itself, and each of these can change how it does. A **control character**, here and wherever
  this document escapes or refuses one, is U+0000–U+001F, U+007F (DEL) or U+0080–U+009F (C1). skydeck **writes nothing on the Windows side**:
  Edge writes into the profile folder it is given (5.4). A Start-menu shortcut is only proposed
  (20), and needs the user's agreement.
- **"No runtime dependencies" (design 10) is amended, not dropped.** Step 2 adds:
  - `python3` 3.9 or newer from the distribution (Ubuntu ships it), standard library only, for the
    keeper;
  - vendored JavaScript: xterm.js 6.0.0 and its addons, MIT-licensed, committed under `vendor/`
    with their licence files and a manifest of hashes (16.6). They are served to the page and
    loaded by the server from the checkout.

  Nothing is fetched by npm (or anything else) at install time. Step 1's commands load none of
  these files and keep working without python3; only the window needs them, and `doctor` says
  what is missing (16.3).
- **Principle 9 (Claude Code formats in `src/claude/`)** covers the new facts too: which
  environment variables Claude Code sets for the programs it starts (7.4) and what a busy-to-idle
  change of the live-session file means (10.3).

## 3. Words used in this document

Design 3's words keep their meaning. New:

| Word | Meaning |
|---|---|
| window | An Edge app window showing skydeck's page. There can be several; each is one **page**. |
| page | skydeck's web page, loaded from the server, in a window or in any browser tab. |
| server | The one Node.js process (`skydeck serve`) that serves the page and owns the screen side of every terminal. |
| terminal | One pty with one program in it, started for the window. Identified by a **terminal id** (12 lowercase hex characters, random). A terminal is not a session: the session its program holds can change (`/clear`). |
| keeper | The python3 process that owns one terminal's pty and program (7.1). |
| screen side | The server's model of a terminal's screen: a headless xterm.js fed every byte the program writes (7.2). |
| snapshot | The screen side serialised: viewport, scrollback, cursor and modes, as escape sequences that rebuild it. |
| park | The server hands a snapshot to the keeper, which keeps the latest one. |
| tail | What the keeper has received since the parked snapshot: output chunks and resizes, in order. |
| record | One element of the stream a keeper produces: an output chunk or a resize. Records are numbered from 1. |
| attach | A page asks for a terminal's stream: it gets a snapshot, then every later record. |
| slot | A number 1–9 that a terminal keeps from the moment it is opened until it ends (7.6). |
| secret, launch token | The long-lived key page and server prove to each other, and the one-use key that lets a new window obtain it (8.2.2, 15.2). |
| size owner | The page whose size a terminal has (8.2.6). |
| needs you | A session the user should look at (12.4): it asks something, a turn finished and was not seen, or its window terminal ended unexpectedly. |
| seen | The user has looked at a session in a window (12.4). |
| runtime directory | `<runtimeDir>`, section 4.2. |
| pty | A pseudo-terminal: the pair of devices a terminal program runs on. The program reads its keys from it and writes its screen to it; whoever holds the other end (the "master") is its terminal. |
| terminal query | A sequence a program writes to ask its terminal something, and the answer it expects: DA1 and DA2 (what terminal are you), DSR and CPR (where is the cursor), DECRQM (is this mode on), DECRQSS (what is this setting), XTVERSION (your name and version), OSC 10 and 11 (your foreground and background colour). CUP is the sequence that moves the cursor. |

## 4. Process model and places

### 4.1 Processes

| Process | Started by | Lives | Code |
|---|---|---|---|
| `skydeck` commands | the user | as in step 1 | `src/cli/` |
| the server, `skydeck serve` | `skydeck window` only (5.2), detached in a session of its own | until `skydeck window --stop` or `--restart`, `uninstall`, a crash, or WSL stopping | `src/window/` |
| a keeper, one per terminal | the server, detached in a session of its own | until its program has ended and the end was read (7.8) | `bin/skydeck-keeper` (python3) |
| the program (`claude`) | its keeper, as the pty's child | until it exits | — |
| the keep-alive: `wsl.exe` on Windows and the `sh` it runs in WSL | the server, through interop | while the server or any keeper lives (6.1) | `bin/skydeck-keepalive` (sh) |
| Edge (`msedge.exe`) | `skydeck window`, through interop | until the user closes the window; outlives WSL | — |
| a link's opener: `rundll32.exe`, or Edge with `window.links` `"edge"` (9.6) | the server, through interop, when the page asks to open a link | not waited for | — |

A server restart leaves keepers, programs and the keep-alive running. A keeper never depends on
the server: it keeps its program, its pty and its stream while no server is connected.

### 4.2 Places

The places of design 9.1 stay. Step 2 adds:

| Place | Holds |
|---|---|
| `<runtimeDir>` | The server chooses it by the first rule that applies: `$SKYDECK_HOME/run` when `SKYDECK_HOME` counts (design 9.1: non-empty and absolute) — always, whatever `XDG_RUNTIME_DIR` says, so that a test or a trial installation never reaches the real server or the real keepers; else `$XDG_RUNTIME_DIR/skydeck-<store id>` when `XDG_RUNTIME_DIR` counts by the same rule, is a directory owned by the user and not readable by others, and systemd keeps it while the user has no login session (lingering: `/var/lib/systemd/linger/<user>` exists; without it, systemd removes the directory when the last terminal closes, and with it every keeper socket); else `<stateDir>/run-<store id>`. `<store id>` is the first 8 hex digits of the sha256 of the store's path, so two installations never share a runtime directory. The server records the directory it uses in the store (`kv` `window_runtime_dir`, 10.2) when it takes its lock, and leaves the record while any keeper lives. **A starting server follows the record first**: when it names a directory that exists and holds a keeper alive by its `.pid` line, the server uses that directory, whatever its own environment would give, so that it finds the keepers a server started with another environment left there; a record whose directory is missing or holds nothing alive is ignored, and the server chooses by the rule and replaces the record. **Commands follow the record**, not their own environment — a command run without `XDG_RUNTIME_DIR` (from cron, `wsl.exe --exec`, `sudo -u`) still finds the server and the keepers — and resolve the rule themselves only when there is no record. `uninstall --purge` looks in the recorded directory and in every directory the rule can give (16.2). The keep-alive script is given the directory as an argument (6.1). Created with mode 700. Holds `server.json`, `server.sock`, `server.pid`, `keeper-<build>.py`, `interop`, `keepalive.pid`, `keepalive.interop` and `terms/`. `XDG_RUNTIME_DIR` is emptied when WSL stops; the others are not, so the server treats anything there from another boot as stale (6.3, 7.8). A test asserts that with `SKYDECK_HOME` set nothing is created or opened outside it (17.3). |
| `<runtimeDir>/server.json` | The running server: `pid`, `procStart`, `bootId`, `port`, `serverId` (random per start), `build` (16.5), `checkout` (its `appRoot`), `startedAt`, and where its environment came from (5.2). Mode 600. Written after the server listens, removed when it stops. |
| `<runtimeDir>/server.sock` | The server's unix socket for the command line (8.3), mode 600. |
| `<runtimeDir>/server.pid`, `keepalive.pid`, `terms/<terminal id>.pid` | One line each, `<pid> <process start> <boot id>`, for the server, the keep-alive script and each keeper: the keep-alive script reads them (it cannot read JSON), and every reader judges them by design 5.5's liveness rule (boot id, pid and process start), never by the pid alone. A reader that cannot tell — the boot id cannot be read, or reading `/proc` fails — counts the line as unknown, not dead: nothing is ever removed, ended or given up on an unknown line; only a dead one allows removing a socket or a `.pid` file. A keeper's line has two more fields, its keeper version and `started` (0 or 1), so that `doctor` and `uninstall` need not connect to it (16.2, 16.3). Written through a temporary name and a rename; removed by their owner when it ends, and by the server together with a keeper's socket when it finds that keeper dead. |
| `<runtimeDir>/keeper-<build>.py` | The keeper's code as the server read it at start (16.5): what new keepers run. Written by the server at start through a temporary name and a rename, mode 600. A running keeper has read its code when it started, so the server removes the files of other builds at start. |
| `<runtimeDir>/keepalive.interop` | The keep-alive's `$WSL_INTEROP` (6.4). |
| `<runtimeDir>/terms/<terminal id>.sock` | A keeper's unix socket, mode 600, in a directory of mode 700. |
| `<runtimeDir>/interop` | A symbolic link to a live WSL interop socket (6.4). |
| `<stateDir>/server.log`, `<stateDir>/keepers.log` | The server's and the keepers' own diagnostics, one line each, never conversation content, typed text or the secret (2); at 1 MiB a file is copied to `.1` and emptied in place (one older file is kept): not renamed, because the server's own stdout and stderr and each keeper's stderr hold these files open and go on writing into them. A line written between the copy and the emptying can be lost. |
| the store | Migration 2 (10.2) and the `kv` entries of 10.2. |
| the Edge profile folder | A Windows folder (5.4). Edge creates and writes it; skydeck never writes or removes it. |

A unix socket path must be shorter than 108 bytes. With a fallback under `<stateDir>` or
`$SKYDECK_HOME` and a long home directory it can be longer. The longest is a keeper's,
`<runtimeDir>/terms/<terminal id>.sock`; when it would not fit, the server refuses to start
(`serve` exits 12, 5.2), says why, and `doctor` reports it. It does not start without terminals:
a server that can list sessions but open none is of no use, and one rule is easier to explain.

### 4.3 Code layout

Added to design 11:

| Module | Job | May import |
|---|---|---|
| `bin/skydeck-keeper` | The keeper (7.1), python3. | — |
| `bin/skydeck-keepalive` | The keep-alive's inner script (6.1): `sh` builtins, `sleep`, `mv` and `rm` only (`rm` for its own `keepalive.pid` and temporary file). | — |
| `src/claude/terminal.ts` | What Claude Code sets in its children's environment (7.4); the meaning of a live-file status change for a turn end (10.3). | platform |
| `src/window/` | The server: HTTP and WebSocket (8.2), authentication (15), keeper connections (8.1), screen sides (7.2), the view model of the page (12), the server's tick (10.1), Edge and the keep-alive (5, 6), and the `window` terminal (11.2), which only the server uses; from follow-up F19 the reads of a ticket's status (`ticket-fetches.ts`). | platform, text, store, claude, sessions, terminals, github, ticket-status (F19) |
| `src/window/protocol.ts` | The messages of 8.2 and 8.3 as TypeScript types, with JSDoc the page's type check reads: the definition of every message's fields. | `src/claude/session-id.ts` only (the session-id rule; it imports nothing) |
| `src/window/frames.ts` | The keeper frames of 8.1: the byte layout the server and the keeper share, and parsers for the keeper's payloads. | `src/claude/session-id.ts` only |
| `src/window/view/` | The page's view model as pure functions: sections, rows, the window's pull-request chip (12.3), attention, and through `search/` the blocks (the code's stacks), the switcher's ranking and the filter (12). | sessions (types, and the pure `isListed` of `src/sessions/list.ts`), text, and design 7.3's order of the pull-request states, `CHIP_ORDER` of `src/github.ts`, so that the order has one place (stage D, plan D4); design 7.4's `matchesFilter` stays for `ls` and the interactive list, and the window's filter is 12.8's (stage E, plan E1) |
| `src/window/view/search/` | The rules of search as pure functions (stage E, plan E1): the filter's words and chips (12.8), the blocks (12.2; the code calls them stacks), the switcher's ranking (12.8); `build.ts` calls them. No pattern is ever built from a search text. | values: its own files and `text`'s `sanitize` only; types: sessions, `protocol.ts`, `hub.ts`, `view/sections.ts` |
| `web/` | The page: `index.html`, plain JavaScript modules with JSDoc types (checked by `tsc`), CSS, and one classic script, `web/theme-early.js`, that puts the theme switch's stored choice on the page before its first paint (12.1; follow-up F13). No bundler, no build step: the files are served as they are. | `vendor/xterm/` |
| `web/keys.js` | The key table (12.9) and the terminal key mapping (9.1), as pure functions. | — |
| `vendor/xterm/` | The vendored xterm.js files (16.6). | — |

Nothing in `web/` decides a rule that the server also needs: the page renders what the server
sends and maps keys. Everything that orders, groups, filters or judges attention is in
`src/window/view/` and tested without a browser. One page module copies two rules of the server
to draw what the user types (follow-up F15, 12.6): `web/favourite-text.js` splits the new form's
flags as `src/window/flags.ts` does and judges which texts may be saved as a favourite as
`src/window/favourites.ts` does (but the flags design 7.7 refuses, the server's alone); the
server decides (it checks every action again), and a test holds the copies to the server's
words and refusals.

`src/platform/` gains what the server needs from the outside world, so that tests pass fakes:
starting a detached process in a session of its own with a given environment and signalling a
process (`Platform.processes`); an HTTP server on TCP or on a unix socket, connecting to a unix
socket and one JSON request over it (`Platform.net`); a one-shot timer (`Clock.after`); random
bytes (`Platform.randomBytes`); this process's pid, uid and user name; a file's permission bits and
owner (`FileInfo.mode`, `uid`); the target of a process's file descriptor and whether a TCP port
has a listener (`Proc.fdTarget`, `Proc.tcpListening`, read from `/proc/net/tcp` and `tcp6`). A
process's parent pid is read from `/proc/<pid>/stat` (`Proc.stat`) by a pure helper of
`src/claude/`. Design 11's rule stands, widened: nothing outside `src/platform/` starts a
program, signals another process, opens a socket, reads `/proc` or the process's environment, or
draws randomness. A long-lived child with pipes is not built in stage A, where nothing needs one
(the keeper, `serve`, Edge and `wsl.exe` are all detached); the stage that needs it adds it.

### 4.4 Changes to step 1's code

Every change step 2 makes to code that step 1 built, and the stage (19) that brings it. Nothing
else of step 1 changes; a command not named here behaves exactly as in step 1.

| Where | Change | Stage |
|---|---|---|
| `bin/skydeck` (launcher) | For `serve`: Node.js is started through a short program passed with `/usr/bin/python3 -I -S -c` (never a python3 from `PATH`) that sets the soft core limit to 1 byte and records the old one (2); without `/usr/bin/python3`, directly. For every command: `SKYDECK_LAUNCHER_CACHE` passed to Node.js beside a `NODE_COMPILE_CACHE` the launcher chose itself, so the server can drop the launcher's cache variable from the programs' environment and keep one the user set (5.2, 7.4); the program of the `--here` handoff gets no marker. Tests in `test/bin/` for both. | A |
| `src/platform/` | New interfaces: detached processes with a given environment, signals, TCP and unix sockets, a one-shot timer, random bytes, a process's parent pid (4.3). `paths.ts`: the runtime directory (4.2). `config.ts`: the `window` keys (16.4) in A; the value `"window"` of `terminal` in C. | A, C |
| `src/store/` | An option of the connection, used by the server's connection only: before every write transaction and every single-statement write it checks the schema version and refuses a write into a newer store (10.1). Commands' connections do not check: a command that migrates is the newer one. Migration 2 (10.2). | A (the guard), B (migration 2) |
| `src/terminals/types.ts` | `LaunchSpec` gains `sessionId`, `kind`, the lock value, the start deadline and the label; the `Terminal` names gain `window` (11.1, 11.2). | A |
| `src/sessions/` | `launchPrepared` moves here from `src/cli/launching.ts` and takes the terminal as a parameter; `prepareNew` takes the directory (11.1). In C, a renewal of a resume lock keeps the mark of its take in the last six digits of the lock's time, which are then not time (a lock's time is read to the millisecond); `sameTake` and `releaseLockOfTake` tell a renewal from a take-over (design 7.6; 7.3, 7.8). | A, C |
| `src/sessions/restore.ts` | Restore planning moves here from the `restore` command, and returns the earlier boot and its last event time (11.1). `runRestore` takes optional hooks, which only the server passes: a refusal before the guard, a session that can no longer start, a stop signal, and a stop after a batch in which no session started (11.1, 11.3); each report line names the session it ends and how. The command passes none, and its restore is unchanged. | C |
| `src/cli/commands/` | New: `window` and `serve` (5). `doctor`: the lines of 16.3. `install`: the python3 `info` line (16.1). `uninstall`: stops the server, names the profile folder, `--purge` refuses while keepers live (16.2). | A |
| `src/cli/commands/` | `resume` and `new`: `--window`; `restore` with `"terminal": "window"` (11.4). `show`: `(in the skydeck window)` (11.4). | C |
| the interactive list (`src/cli/tui/`) | `R` with `"terminal": "window"` sends `POST /resume` (11.4) and shows the answer's lines the way it shows a tab launch's lines today. Nothing else in the list changes. | C |
| `src/store/`, `src/sessions/`, `src/cli/` | Follow-up F18, a session's ticket (design 7.1, 12.5): migration 3 (10.2) adds `session_meta.ticket_url`; `readTicket`, `ticketText` and `setTicket`; a list row carries the ticket, which the expiry rule (design 7.2) and the filter (design 7.4) count; the new command `skydeck ticket set` / `clear`; `show` prints the ticket as `ticket:` and in `--json`; `t` in the interactive list. | F18 |
| `src/ticket-status.ts`, `src/github.ts`, `src/platform/config.ts`, `src/store/`, `src/sessions/list.ts`, `src/window/ticket-fetches.ts`, `tick.ts`, `actions.ts`, `protocol.ts`, `src/cli/`, `web/` | Follow-up F19, a ticket's status (design 7.3, 12.2, 12.3, 12.5): the provider of an address (a `ticketStatus` rule, else a GitHub issue: `statusProvider` in `src/github.ts`, beside the issues' key and batch), the configured program and its answer, the due rule and the fetch in `src/ticket-status.ts`; the keys `ticketStatus` and `ticketRefreshMinutes` (16.4); migration 4 (10.2) adds the table `ticket_status`; a list row and `list.selected` carry the status (8.2.3) and the filter finds its text (12.8); the server reads it in the background, one read at a time (10.1; the actions `ticket` and `ticket-refresh`); `skydeck ticket refresh` reads and prints it and `show` prints it (`ticket set` reads nothing, as F18); the page draws the header's chip, the row's small chip and the dialog's line and ↻ (12.2, 12.5). | F19 |
| `package.json`, `.prettierignore`, `tsconfig.json` | Development dependencies: `playwright`, `ws`, and the `@xterm/*` packages of 16.6 (exact versions); scripts `vendor`, `test:page`, `check` (17.5); `vendor/` added to `.prettierignore`, so that the vendored files are kept byte for byte; `web/tsconfig.json` beside the root one. | A |
| `.github/workflows/ci.yml` | 17.5: `shellcheck` by name, the jobs `lint`, `unit (i/n)` and `page (i/n)` side by side with Node's `--test-shard`, the page suite on the newest leg only, on a runner pin of its own, the time limits. | A |

## 5. Starting the window

### 5.1 `skydeck window`

```
skydeck window [--print-url] [--new-window] [--restart] [--stop] [--new-secret]
```

Run inside WSL, in a terminal of the user's own. It refuses (exit 1) when `CLAUDECODE` is set, with
every option (`--stop` included) —
`the window's server is not started from inside a Claude Code session: every session in the window
would inherit that session's environment; run skydeck window in a terminal of your own` — because
the server's environment becomes every program's (5.2, 7.4). Without options it:

1. makes sure the server runs (5.2). When `server.sock` answers `GET /ping` (8.3) within 5
   seconds with the current boot id, this checkout and the current build (16.5), that server is
   used. One of this checkout with another build is stopped as `--restart` stops it, and a new one
   is started (sessions keep running, 16.5), with one line that says what that means: `restarting
   the window's server for the new build; new sessions in the window get the environment of this
   shell (<directory>)` (5.2). `--restart` prints the same line. One of **another checkout** is not replaced:
   `the window's server runs from <checkout>; run skydeck window there, or skydeck window --restart
   here to replace it` (exit 1). One whose process is alive (`server.json`, design 5.5's rule) but
   that does not answer within 5 seconds is reported: `the window's server (pid <n>) does not
   answer; skydeck window --restart stops it` (exit 1). A socket that refuses, or a request that
   fails, is tried again every 100 ms within those 5 seconds — a server in its orderly stop (5.5)
   no longer accepts connections but still lives for a moment, and one that is starting listens a
   moment after it writes `server.json` — and a server that is gone meanwhile counts as none. A
   server that is **starting** holds the `window_server` lock (5.2) before it writes `server.json`:
   while `server.json` is missing or names a dead process, a holder of the lock alive by design
   5.5's rule is that server, and its `server.json` is waited for within the same 5 seconds, then
   it is pinged in what is left of them; one that has not recorded itself by then — or has, but
   gives no answer in what is left — is reported,
   `the window's server (pid <n>) is starting and did not finish within 5 s; run skydeck window
   again, or skydeck window --restart to replace it` (exit 1), never as "not running". A holder
   that cannot be judged stops the command with the error of a `server.json` that cannot be
   judged (`cannot tell whether the window's server (pid <n>) still runs: …`); nothing is signalled
   or taken over on it. Otherwise a new one is started, and the command goes on only once
   that server can be found by the next command, its `server.json` written (5.2; ruled by the plan
   owner, stage A's plan task 25 and the follow-up "server-findable"). A server it started that
   another command stops during its start (`--stop`, `uninstall`) gives, at once, `the window's
   server stopped before this command could use it; run skydeck window again (its log:
   <stateDir>/server.log)` (exit 1; 5.2; ruled by the plan owner, follow-up "server-findable",
   review 2).
2. when no page is connected to the server, asks it for a launch token (`POST /token`, 8.3),
   starts Edge with it (5.3), and waits up to 30 seconds — a cold Edge on a managed PC can take
   several (W1 records the real time) — for the token to be used by a page (`GET /token/<id>`).
   Once it is used, the command waits 2 seconds more for a second use (`reused`), so that a window
   that lost its token to another program is not reported as a success. When the wait ends —
   used, the alarm, or the 30 seconds gone — it gives the token up (`POST /token/drop`), so no
   unused token is left on Edge's command line. A command interrupted meanwhile (Ctrl+C) gives
   nothing up: its token lives out its 30 seconds (a known limit; ruled by the plan owner, stage
   A's plan task 25). On the alarm for its own token it says so, names
   `--new-secret` (8.2.2), and exits 1. An alarm set earlier (`window_alarm`) does not stop it: it
   goes on as usual and prints one more line, `skydeck's key may be known to another program since
   <time>; run skydeck window --new-secret`. Only one command starts Edge at a time: it
   holds the `kv` entry `window_launching` (taken in one transaction, stale after 45 seconds, longer than its wait) while
   it starts Edge and waits; a second `skydeck window` meanwhile waits for that one's page instead
   of starting another window. The entry names its holder — a mark of its own, the time, and the
   command's pid, process start and boot id — and holds nothing once that command is dead by
   design 5.5's rule, so that a command interrupted while it waited (Ctrl+C) does not make the next
   one wait for a page that never comes; a holder that cannot be judged counts as alive, and holds
   the 45 seconds. A command gives up only the value it wrote itself (ruled by the plan owner,
   stage A's plan task 25).
3. prints one line: `skydeck window: http://127.0.0.1:<port>/ (server pid <n>)` — never a key or a
   token — and exits 0. When Edge was started but no page connected in time it says so, names
   `--print-url`, and exits 1.

Standard output carries only the command's one result line (this one, `a window is already open`,
the address of `--print-url`, the line of `--stop`); every other line — the restart line, the
earlier alarm, a failure — is printed on standard error with the `skydeck: ` prefix of every
diagnostic line of skydeck (ruled by the plan owner, stage A's plan task 25).

After a restart (`--restart`, or a server of another build replaced in step 1) the windows of the
old server come back only once the new server's start is done (8.2.1 answers 503 until then; the
pages retry, 6.3), so step 2's "no page is connected", looked at right after the start, would open a
second window at every update. So before it stops a server the command reads that server's `pages`
(`GET /status`); when the server answered with more than 0 and the run is not `--new-secret` (the
old windows are refused then), `--new-window` or `--print-url`, it waits up to 7 seconds — the
page's longest retry interval is 5 (6.3) — for a page on the new server before it asks for a token.
The new server answers, and has written `server.json`, before its start is done (5.2), so the 7
seconds count from the end of its start: first the command waits while its `GET /status` says
`starting`, at most until the start wait (10 seconds, begun when it started that server) is over —
a server still starting then is not waited for any longer, and a new window's page waits out the
503 with its token (8.2.2) — and only then for the page (ruled by the plan owner, follow-up
"server-findable").
A page that comes back in that time is "a page is already connected" (below): the same line and
exit code, no token, no Edge. An old server that did not answer, or whose answer has no page count
that can be read, counts as none: no wait (ruled by the plan owner, stage A's plan task 25).

`skydeck update` (16.5) restarts the server for an update in another order: it reads the old
server's `pages` and stops it first, then fast-forwards the checkout, and only then runs the new
checkout's `skydeck window`, which finds no server, starts one and waits for the window through the
pages mark (below), so that no code of the new commit opens the database while the old server runs.

After a WSL restart, a crash of the server or `--stop`, no old server is there to tell its pages,
but the old window may still be open, and its page connects a few seconds after the new server's
start is done (6.3). So the server keeps the `kv` entry `window_pages_open` while pages are
connected (10.2), and a server that finds it at its start **expects a window back**: from the end
of its start until a page connects or 7 seconds have passed — counted on the server's monotonic
reading (`Clock.monotonicNs`), a clock that cannot step, so that a step of the wall clock neither
stretches nor shortens them (ruled by the plan owner, plan task 74) —, and says so in `GET /status`
(`windowExpectedMs`, 8.3). The wait is the server's fact, not each command's guess: unless
`--new-window`, `--print-url` or `--new-secret` (its old windows are refused, so none comes back),
step 2 first reads `GET /status`, and while the server is starting with `windowExpectedMs` set, or
`windowExpectedMs` is above 0, and no page is connected, it prints `skydeck: waiting up to 7 s
for the open window to come back; --new-window opens one now` on standard error once and looks again every 100
ms — every command that would open a window, a second `skydeck window` meanwhile too, so they wait
for one deadline. It waits at most the start wait (10 seconds) and 7 seconds more of its own, from
its first look, whatever the server says: a mark that is stale never leaves the user without a
window. A page that comes back is "a page is already connected" (below); otherwise it goes on as
step 2 says. After a restart this wait follows the one above. The cost: after a PC restart or
shutdown with the window left open the entry may still be there (WSL can end before the server's
next refresh sees the page go), and the first `skydeck window` then waits 7 seconds for a window
that cannot come; the entry a server that died left is removed by the next server's first refresh
without a page (plan C20). Three named limits (ruled by the plan owner, plan C20, task 81's review
2): a server replaced within its own expectation (`--restart`, a crash, another `wsl --shutdown`
within those 7 seconds) has removed the entry at its first refresh, so the next server expects
nothing and the command opens a second window — no worse than before; the 7 seconds rest on a page
that tries again at least every 5 seconds, but Chromium wakes a window hidden for more than 5
minutes only once a minute (6.3), so such a window can come back after the command has opened a
new one; and the waits add up when a start hangs: 10 and 17 seconds on a cold start, 10, 7 and 17
seconds after a restart with a page. At an orderly stop the server writes the entry once more as
its pages are; when it dies the entry stays as its last refresh left it. A fourth named limit
(ruled by the plan owner, plan task 74): the entry follows the server's refresh, one every 2
seconds, not the page's connect, so a server that dies within about 2 seconds of its first page's
connect has not written it, and the next server expects no window.

When a page is already connected it starts nothing on Windows and says
`skydeck window: a window is already open`; `--new-window` opens another one anyway (several
windows are supported, 8.2.7). A command cannot bring an existing window to the front: Edge's
hand-off to its running instance opens a new window instead, which is what `--new-window` does.

Options:

- `--print-url`: make sure the server runs, then print an address with a launch token that is
  valid once and for 10 minutes (`http://127.0.0.1:<port>/#t=<token>`, 8.2.2), for any browser,
  and start nothing on Windows. This token is not given up when the command ends: it is meant to be
  pasted later. It is never on a command line. In a normal browser tab the page works with fewer keys: the browser
  keeps Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and their Shift forms (section 21), so the page shows a
  hint naming Ctrl+Shift+O for "previous session" and the "+ New" button.
- `--restart`: stop the running server and start a new one; also a server of another checkout or
  one that does not answer. Stopping: a server that answers `GET /ping` is sent `POST /shutdown`
  (5.5) and waited for until its process is gone (at most 10 seconds); a server that gives no ping
  answer within the ping wait (5 seconds; a refused ping or a request that fails is tried again
  every 100 ms, as step 1 does — a server listens a moment after it writes `server.json` (5.2) and
  one in its orderly stop no longer accepts; a ping that times out is not tried again; a server
  gone meanwhile is stopped; ruled by the plan owner, follow-up "server-findable") is sent no
  request and gets SIGTERM at once (it would not answer the request
  either, and SIGTERM is the same orderly stop, 5.5); one that does not end in time gets SIGTERM
  too. Either one, still running 5 seconds after SIGTERM, gets SIGKILL — each signal only once its pid, process start
  and boot id from `server.json` are confirmed alive at that moment, so no other process is ever
  signalled. A server that is starting (step 1) is stopped the same way once it has recorded
  itself within the 5 seconds — it gets the request, and makes its stop as soon as its start is
  done (5.5); one that has not recorded itself by then, or that step 1 has just reported as
  starting, gets SIGTERM at once and SIGKILL 5 seconds later, each only once the pid, process
  start and boot id its `window_server` lock names are confirmed alive at that moment (ruled by
  the plan owner, follow-up "server-findable"). A `server.json` whose process cannot be judged (5.5's "unknown") stops the command
  with that error: nothing is signalled or given up on it. The server is skydeck's own process
  (2); keepers and their programs are never signalled and keep running.
- `--stop`: stop the server the same way and start nothing. Sessions in the window keep running in
  their keepers; windows say that the server is gone (6.3).
- `--new-secret`: stop the server (which forgets every token), replace the secret (15.2), clear the
  alarm (8.2.2), start a server and a window. Windows opened before cannot connect any more and say
  so; their stored key is replaced when the new window's token is used in the same profile. The
  secret is never replaced while a server of this installation lives: the replace, in one store
  transaction, first reads the `window_server` lock, and while it names a holder alive by design
  5.5's rule — a server another command started after the stop, whose tokens would outlive the
  key — or one that cannot be judged, nothing changes, neither the secret nor the alarm: `skydeck's
  key was not replaced: a window server (pid <n>) started meanwhile; run skydeck window
  --new-secret again` (or, for one that cannot be judged, `…: cannot tell whether the window's
  server (pid <n>) still runs: …`), exit 1 (ruled by the plan owner, follow-up "server-findable").

`--stop` combines with no other option, and `--print-url` not with `--new-window`: either is a
usage error (ruled by the plan owner, stage A's plan task 25).

Exit codes as design 7.5: 0, 1 (failure), 2 (usage).

### 5.2 Starting the server; one server only

Only `skydeck window` starts a server (the commands of 11.4 use a running one). It starts
`bin/skydeck serve` through the launcher (so the Node.js binary is chosen as for every command,
design 10), detached in a new session (it gets no SIGHUP when the terminal it was started from
closes), with stdin `/dev/null`, stdout and stderr appended to `<stateDir>/server.log`, and working
directory `/`. Whoever starts `serve` — `skydeck window`, or a person typing `skydeck serve
--foreground` — the same two rules hold, because they live in `serve` and in the launcher, not in
`skydeck window`: the launcher starts Node.js for `serve` with a soft core limit of 1 byte (2), and
`serve` refuses, as `skydeck window` does (5.1), when `CLAUDECODE` is set. Tests that start a
server remove `CLAUDECODE` (and the other names of 7.4) from its environment first, since the
tests may themselves run under Claude Code.

**How `skydeck window` learns what happened.** It keeps the handle of the `serve` process it
started and waits, at most 10 seconds, for the first of: `server.sock` answering `GET /ping` with
the current boot id, this checkout and the current build, as 5.1 compares them (two checkouts at
the same commit have the same build) — started; or the process exiting, whose code says why, and which
it turns into one fixed line:

| `serve` exits | `skydeck window` says (exit 1) |
|---|---|
| 0 | nothing: a server of this checkout holds the lock — another `skydeck window` started it at the same moment — and that one is used (it is waited for within the same 10 seconds). When neither `server.json` nor the lock names a process that is alive or cannot be judged — the server it started was stopped during its start by another command (`--stop`, `uninstall`), or ended — it does not wait: `the window's server stopped before this command could use it; run skydeck window again (its log: <stateDir>/server.log)` — it does not say who stopped it — (ruled by the plan owner, follow-up "server-findable", review 2) |
| 10 | `port <n> on 127.0.0.1 is used by another program; set window.port in <config path>` |
| 11 | `a window server already runs (pid <n>, from <checkout>)` (from `server.json`, or — while that server is starting and has written none yet — from its `window_server` lock; ruled by the plan owner, follow-up "server-findable"): a server of another checkout |
| 12 | `the runtime directory <dir> cannot be used: <reason>; see skydeck doctor` (mode, owner, or a socket path of 108 bytes or more) |
| 13 | `the window's server is not started from inside a Claude Code session` |
| anything else, or no answer in 10 seconds | `the window's server did not start (exit <n> / no answer in 10 s); see <stateDir>/server.log`; after a timeout the process is left running, and the next `skydeck window` finds it or reports it as not answering (5.1) |

A ping counts only once `server.json` names the server that answered it — the same pid, server id
and boot id, its process alive by design 5.5's rule — within the same 10 seconds: every other
command (`--stop`, `--restart`, `--new-secret`, `doctor`, `uninstall`) finds a server by
`server.json`, so a command that returned earlier would leave a server that the next command cannot
see. One that answers but has not recorded itself in that time gives `the window's server (pid <n>)
answers, but did not record itself in <server.json> within 10 s; see <stateDir>/server.log` (exit 1)
and is left running (ruled by the plan owner, stage A's plan task 25) — said only of a server
that still answers (it is asked once more). Of one that answered and is gone meanwhile the line is
that of exit 0 above (`… stopped before this command could use it …`); of one that lives but
answers no more, `the window's server (pid <n>) does not answer; skydeck window --restart stops
it` (follow-up "server-findable", review 2). Since a server writes
`server.json` before `server.sock` answers (below), a server of this build has always recorded
itself by the time it answers; the check stays for any server that does not (ruled by the plan
owner, follow-up "server-findable").

These codes are `serve`'s own; they never reach a user through another command. A store that
another process keeps write-locked for longer than the server's 250 ms (14) fails the start at
once — `the window's server cannot start: skydeck's database is busy (another skydeck holds it);
try again`, exit 1 (the table's last row), nothing left behind — rather than a server that would
freeze (ruled, plan task 23).

**Its environment** is that of the `skydeck window` command that started it, without
`SKYDECK_HANDOFF` and without the compile-cache variable the launcher sets for Node.js alone. When
the launcher chooses the cache itself (the caller has no `NODE_COMPILE_CACHE`, or an empty one),
it passes `SKYDECK_LAUNCHER_CACHE` with the same value beside it; a `NODE_COMPILE_CACHE` the
caller set is passed unchanged with no marker of its own, and a marker the caller has is left as
it is — that is how the `window` command's own cache and marker reach the `serve` it starts. The
server removes `NODE_COMPILE_CACHE` when it equals the marker, and the marker itself, so a cache
the user set stays.
The programs of the terminals inherit it (7.4), so it matters which shell started the server: one
with a project's `direnv`, virtual environment or `AWS_PROFILE` gives them to every session.
`server.json`, `GET /status` and `doctor` say where it came from (`environment of skydeck window
run in <directory> at <time>`), and a change reaches new terminals only after `skydeck window
--restart`. `serve` itself runs in `/`, so `skydeck window` passes its own working directory in
`SKYDECK_ENV_ORIGIN`; `serve` takes the variable out of its environment (no program inherits it)
and records that directory, with its own start time, as where its environment came from. A `serve`
started by hand, without the variable, records its own working directory.

**One server per installation.** The lock is the `kv` entry `window_server`
(`<pid>:<process start>:<boot id>:<checkout>`), taken in one store transaction when the server it
names is not alive by design 5.5's rule; so a second server of the same installation — another
port, `serve --foreground`, another checkout — does not start (`a window server already runs (pid
<n>, from <checkout>)` on stderr; exit 0 when the running one is of the same checkout, 11
otherwise), and only one server ever talks to the keepers of one runtime directory, which belongs
to one store (4.2). Holding the lock, it takes its runtime directory (the record first, 4.2) and records it, binds the port, removes
a `server.sock` that refuses connections (left by a dead server) — one that a process answers on
fails the start before anything is recorded — writes `server.json` and `server.pid`, listens on
`server.sock`, and removes the lock when it stops. A port held by anything else makes
it release the lock and exit 10; a start that fails after `server.json` was written removes it and
`server.pid` before it gives the lock back.

**A server that is starting can be found** from the moment it can answer (ruled by the plan owner,
follow-up "server-findable"). It writes `server.json` before `server.sock` answers — everything the
file holds is known once the port is bound — so a server that answers is always findable by its
`server.json`; the rest of its start (the python3 check, the keepers found, the interop link, the
first tick) follows, and pages are answered 503 until it is done (8.2.1). Before `server.json` is
written only the lock names it, so every command — `skydeck window` with any option, `doctor`,
`uninstall` — that finds no live process in `server.json` reads the lock: a holder alive by design
5.5's rule is a server that is starting, and is waited for within the command's ping wait (5.1);
one that cannot be judged is never taken for "no server" (the command stops with its error); a
holder that is dead, of another boot, or a value skydeck does not write is no server. No command
says that no server runs while a live server of this installation holds the lock.

The port (configuration `window.port`, default 47613) is fixed because what a page keeps is kept
per origin, and the origin includes the port: the notification permission (13) and the
IndexedDB where the page keeps its key (8.2.2). A changing port would ask for notification
permission again and lose every window's key. (Edge's taskbar identity of an app window is made of
the address's host and path and the profile folder, without the port; section 21.)

**Its log.** The server writes `server.log` itself, one line per event. An error caused by a
peer's data — a frame, a message, a request body that does not parse or does not fit — is logged
by its kind and where it came from (`page <window id>: malformed message`), never by its message,
because a message can quote the data: Node.js's `JSON.parse` error quotes its input, which could be
a proof, a typed prompt or a pasted text. An uncaught error is logged by its name and its stack
frames without the message, and ends the server (exit 1). A message can span several lines and
hold a line that looks like a frame (a pasted stack trace), so the stack's header —
`<name>: <message>` with as many lines as the message has, Node.js's `<name> [<code>]: <message>`,
or the name alone for an empty message — is removed exactly and only the lines after it that are
frames (`    at …`) are kept; a stack that does not begin with that header gives no frames at all
(ruled, plan task 23). The headless terminals of the
screen sides (7.2) log nothing: xterm.js's own log is turned off, because its messages quote the
program's output (a parsing error names the character and the parameters; section 21). What
reaches the log through stdout and stderr is only what Node.js itself writes there (its warnings).

`skydeck serve [--foreground]` is a command of its own, listed in `skydeck --help` as "the window's
server (started by skydeck window)". `--foreground` runs it in the terminal, logging to stderr, for
debugging; it takes the same lock.

### 5.3 Starting Edge

The program is configuration `window.edge`, default
`/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`. It is run directly (never
through a shell), detached, with stdio ignored and working directory `/mnt/c` (a Windows
directory, so no "UNC path" warning), and the arguments:

```
--app=http://127.0.0.1:<port>/#t=<launch token>
--user-data-dir=<profile folder>
--no-first-run
--no-default-browser-check
```

`msedge.exe` hands off to an Edge that already runs on the same profile folder and exits at once
(section 21), so its exit says nothing about the window; whether a page connected is what
`skydeck window` waits for. It always passes the same port and profile folder.

When the program does not exist, `skydeck window` says `Edge was not found at <path>; set
window.edge in <config path>, or open the window in any browser with skydeck window --print-url`
and exits 1. The server keeps running. A profile folder that would change how Edge splits its
command line (2: a `"`, a control character, a backslash at the end — `C:\Users\Me Name\x\`) is
not passed: `the Edge profile folder <folder> cannot be passed to Edge (a '"', a control
character or a backslash at the end); set window.profileDir in <config path>`, exit 1, where
`<folder>` is shown as the JSON string it is in `config.json`, which is what the user edits
(backslashes doubled; `"`, DEL and every control character, C1 included, escaped, so none
reaches the terminal: `"C:\\Users\\Me Name\\x\\"`). One that
cannot be derived (5.4) gives the derivation's error followed by ` in <config path>`; another
failure to start Edge, `Edge could not be started from <path> (<reason>); open the window in any
browser with skydeck window --print-url`.

### 5.4 The profile folder

Edge gets a profile folder of its own, so that the user's extensions do not run on the page (15.1)
and the window has its own taskbar identity. It is a Windows folder: one under WSL's file system
would be slow and would vanish with WSL, while the window must outlive WSL to say what happened
(6.3).

Configuration `window.profileDir` (an absolute Windows path such as
`C:\Users\me\AppData\Local\skydeck\edge-profile`) names it. When it is `null` (the default),
skydeck derives it without starting a Windows program: of the folders
`/mnt/c/Users/<name>/AppData/Local/Microsoft/Edge` that exist and can be read, exactly one must be
found, and the profile folder is `C:\Users\<name>\AppData\Local\skydeck\edge-profile` (a path
under `/mnt/<letter>/` maps to `<LETTER>:\`). None or several is an error that names
`window.profileDir`. skydeck never creates, writes or removes this folder: Edge creates it.
`uninstall` names it (16.2).

### 5.5 Stopping the server

On `POST /shutdown` (8.3), SIGTERM or SIGINT the server, in this order: stops its tick; closes
`server.sock` (no command reaches a server that is stopping; the file goes with it); sends every
page `bye` with the reason and then closes the port — after `bye` an upgrade with the right `Host`
is answered 503 (8.2.1); parks a snapshot in every keeper (7.3) and closes its keeper connections
(the keepers and their programs keep running); settles the terminals that ended since the last tick
(7.8); removes `server.json` and `server.pid`; releases the `window_server` lock (5.2); and exits 0.
A server whose start failed after it wrote `server.json` removes it and `server.pid` too before it
releases the lock (ruled by the plan owner, follow-up "server-findable").
The pages go before the park so that no page can type between the park and the close (ruled, plan
task 23). A stop asked for before the server can stop is made as soon as it can, and one asked during
its first tick starts the orderly stop at once; a second one during a stop is the same stop. It does not stop the keep-alive, which ends by itself
(6.1). The three are the same stop, so a command that stops a server (5.1 `--restart`) sends
SIGTERM instead of the request to one that does not answer `GET /ping`. A server that crashes
leaves `server.json` and its lock behind: whoever reads them checks the pid, process start and
boot id they name by design 5.5's rule before believing them. A server that is still starting is
stopped like one that runs (5.1 `--restart`): the request or SIGTERM it gets during its start is
made as soon as its start is done; one that has not written `server.json` yet is found, and
signalled, by the identity its lock names.

## 6. WSL lifetime

A WSL distribution stops `instanceIdleTimeout` (default 15 s) after its last Windows client
exits — `wsl.exe` sessions and programs that use the WSL API. Linux background processes do not
count, systemd included (section 21). When it stops, every process in it ends: the server, every
keeper, every `claude`. The window, an Edge process, stays.

### 6.1 The keep-alive

With configuration `window.keepAlive` `"wsl"` (the default), the server keeps one Windows client
of the distribution alive while the window has anything to keep:

- It starts `/mnt/c/Windows/System32/wsl.exe -d <$WSL_DISTRO_NAME> -u <user> --exec /bin/sh
  <checkout>/bin/skydeck-keepalive <runtimeDir>` through interop, detached, with stdio ignored,
  in `/mnt/c` as Edge (5.3) (`-u`: the distribution's default user need not be the user skydeck
  runs as). The keep-alive is `starting` until the script's line appears, with no time limit, so
  that no second `wsl.exe` is ever started beside a slow one; it is `starting` too before the
  server's first check. The script first
  writes its own line to `keepalive.pid` (pid, process start, boot id, 4.2) and its `$WSL_INTEROP`
  to `keepalive.interop` (6.4), each through a temporary name and a rename.
- The script loops: every 10 seconds it checks whether `server.pid` or any `terms/*.pid` names a
  process that is alive by design 5.5's rule — the boot id from `/proc/sys/kernel/random/boot_id`,
  the process start as field 22 of `/proc/<pid>/stat` after its last `)`, both read with `sh`
  builtins. A line it cannot judge (the boot id cannot be read; the stat cannot be read or holds
  no process start) counts as alive (4.2); it exits only when every line is known dead or gone,
  and `wsl.exe` with it. So it outlives a server restart (a new
  server finds `keepalive.pid` alive by the same rule and starts no second one, unless its
  Windows side is gone, below), and it holds WSL
  while terminals run even after `skydeck window --stop`. A stale file from an earlier boot or of a
  reused pid counts as dead.
- When the keep-alive ends while the server runs, the server starts it again after 5 s, 30 s, then
  every 5 minutes, and tells every page (`notice keepalive-lost`). A keep-alive that ran for 5
  minutes starts the schedule over at 5 s, so that one that dies right after each start is not
  restarted every 5 seconds for ever. It has ended when its `keepalive.pid` line is dead, or when
  its `wsl.exe` is gone while its script lives on — the script inside WSL can outlive a `wsl.exe`
  ended on the Windows side, and then nothing holds WSL. A `wsl.exe` this server started is gone
  when it has ended. A keep-alive this server did not start (one an earlier server started) is
  also judged by its `keepalive.interop`: when that file names an absolute path and a unix
  connection to it is refused or the path is not there (the socket of that `wsl.exe` session),
  its `wsl.exe` is gone; anything else — no file, one that cannot be read, another error, no
  answer within 2 seconds — is no judgement, and it counts as running. A socket that accepted is
  asked again after 3 seconds (each connection sends nothing; one a second would be 86,400 a day),
  one that gave any other answer at the next tick. The 3 seconds come from WSL's 15 (6): 3 s until
  the socket is asked again, up to 1 s to the tick that asks, the first 5 s retry and up to 1 s to
  the tick that starts give a new `wsl.exe` just under 10 s after the old one ended, with room left
  for its own start; a longer wait lets WSL stop first. Such a script is an orphan: its line no
  longer counts as a running keep-alive (the next one writes its own), and the server sends it one
  SIGTERM (it exits at once and removes its `keepalive.pid`) — skydeck ending its own helper (2,
  principle 6) — only when all of these hold: its line is alive by design 5.5's rule (its identity
  known, never on an unknown line); its command line (`/proc/<pid>/cmdline`) has an argument whose
  last path component is `skydeck-keepalive` and an argument that is this runtime directory, so
  the signal can never reach a keeper, `claude` or anything else, whatever `keepalive.pid` says;
  and the server knows its `wsl.exe` is gone — it saw the line while that `wsl.exe` ran, or the
  socket says refused. A line first seen at the tick that sees a started `wsl.exe` end is only
  inferred to be that `wsl.exe`'s script (another server's keep-alive can be the one seen): it no
  longer counts, but it is signalled only when its socket says refused. Then the schedule starts a
  new keep-alive. The limits that remain: a keep-alive this server did not start whose
  `keepalive.interop` gives no judgement counts as running, even when its `wsl.exe` is gone; an
  orphan whose line is unknown, or whose command line does not match, gets no SIGTERM (its line
  no longer counts, and a new keep-alive is started beside it). That the socket of a `wsl.exe`
  session goes when that `wsl.exe` ends on the Windows side, and that the Linux side of a
  `wsl.exe` ends only with it: the maintainer's check W14 is the check for both.

That a `wsl.exe` started from inside WSL counts as a Windows client is what the keep-alive rests
on; the maintainer's check W14 is the check for it (section 21). The design does not depend on it:

- the documented alternative is the user's own setting: `instanceIdleTimeout=-1` under `[general]`
  in `%USERPROFILE%\.wslconfig` (or "keep WSL running" in the WSL Settings app, which writes it).
  It takes effect at the next WSL restart by itself; `wsl --shutdown` restarts WSL at once but
  ends EVERY session and terminal in WSL, so it is run only when nothing is running that the user
  wants to keep — no skydeck output names `wsl --shutdown` without saying so (ruled by the plan
  owner, task 24). `[wsl2] vmIdleTimeout=-1` is not needed for this: the VM idles only after its
  last distribution has stopped. skydeck never writes that file (2);
- `doctor` reports which protection is in effect (16.3);
- the page notices when WSL has stopped anyway (6.3), and restore brings the sessions back (12.7).

`"off"` starts no keep-alive.

### 6.2 What the server watches

The server checks the keep-alive's pid every tick (10.1). `GET /status` (8.3) carries
`keepAlive: { mode, state: running|starting|failed|off, since, error }`, and so does the page's
`welcome` (8.2.2), so a window can show "WSL is not kept running" in its title bar.

### 6.3 The page notices that the server is gone

The page sends `ping` over the WebSocket every second (8.2.3). With no `pong` for 3 seconds, or a
closed WebSocket, it shows a bar across the window. The 3 seconds count only from a ping the page
really sent — no `pong` with that ping's `n` within 3 seconds — and are judged only at a check of
the page's that comes on time: one that comes late, because the page's timers were held (a hidden,
minimised or covered window, which Chromium wakes once a minute after 5 minutes; a frozen page; a
debugger), judges nothing, sends a ping, and the 3 seconds count from that ping. A closed socket
shows the bar at once (ruled, plan task 26's review 2):

> skydeck's server is not answering (since 14:02:11). Sessions in the window keep running unless
> WSL has stopped. To get back, open a WSL terminal and run: `skydeck window`

and tries to open the WebSocket again every second for 10 seconds, then every 5 seconds. A page
cannot tell a dead server from a stopped WSL while neither answers (both refuse the connection). An
answer counts only once the server has proven itself (8.2.2); then the page compares:

- **same boot id, same server id**: the connection had dropped (sleep, 6.5); it reconnects and
  re-attaches.
- **same boot id, new server id**: "skydeck's server restarted; your sessions kept running". It
  reconnects, re-attaches (every terminal gets a fresh snapshot), and reloads itself first when the
  server's asset version differs from its own (8.2.2).
- **new boot id**: "WSL has restarted since <time>: the sessions that were running have ended."
  The `welcome` carries no boot time, so `<time>` is the moment the page lost the old server, the
  time of the bar above; "restarted at" would state a time nobody knows (ruled, plan task 26). The
  terminal pane shows each ended terminal's last screen no longer (the server that held it is
  gone), the list shows the sessions `not-running` with their marks, and the restore banner offers
  them (12.7; before stage C: "run skydeck restore", or resume them one by one).

The page itself never starts WSL or a program; it says what to type. It stops trying altogether,
in either mode, once something answered that could not prove itself (8.2.2 step 5): trying again
every second would hand that program a `hello` each time; the warning stays until the page is
reloaded or closed (ruled, plan task 26). A 503 at the upgrade (the server starts or stops, 8.2.1),
a close 1013 at the `hello` (its database is busy, 8.2.2) and a close right after the challenge (a
waiting connection dropped for a newcomer, 8.2.1) are lost connections like any other: the page
tries again and never says that something else answers on the port. The two sentences of a
reconnect above ("restarted", "WSL has restarted since") stay in their notice until the user
dismisses it (ruled, plan task 26).

### 6.4 A stable interop socket for sessions

Claude Code on WSL pastes an image on Ctrl+V and Alt+V by reading the Windows clipboard through a
Windows program (section 21), which needs a working `WSL_INTEROP`. A process inherits the
`WSL_INTEROP` of the terminal it was started from, and that socket dies with that terminal's
`wsl.exe`. A keeper outlives the terminal that started the server, so its program would lose
interop.

Every terminal's program therefore gets `WSL_INTEROP=<runtimeDir>/interop`, a symbolic link the
server points, when it starts a terminal and every 30 seconds, at the first of these that accepts
a connection: `/run/WSL/1_interop`; the keep-alive's own `$WSL_INTEROP` (from `keepalive.interop`;
it lives as long as the keep-alive); the server's own `$WSL_INTEROP`. The link points at the socket
the candidate leads to, symbolic links resolved, so that it never points at another link or at
itself (the server's own `$WSL_INTEROP` is the link when the server was started from a terminal of
the window); when none accepts, the link is removed. The server uses the same link for the Windows
programs it starts. That the link works for the interop client, and survives the closing of the
first terminal, is **UNVERIFIED** (check W7). Without `WSL_INTEROP` (interop disabled) nothing is
linked and the window's Windows-side features (Edge, links, keep-alive, image paste) do not work;
`doctor` says so.

### 6.5 Sleep

When the PC sleeps, WSL is suspended with it and its clock jumps on wake. Keepers and programs are
unaffected. The page's timers stop while asleep; on wake its WebSocket either still works or is
closed, and 6.3 handles both. The server's timers use intervals, not deadlines, so a jump costs
one late tick. A resume lock taken just before sleep may be stale on wake (design 7.6 counts age by
the wall clock): the guard still refuses while the session's holder lives. WSL can hang after
hibernation (WSL issue #8696, section 21): then nothing in WSL answers and 6.3's bar stays.

## 7. Terminals

### 7.1 The keeper

`bin/skydeck-keeper` is one python3 file, standard library only (`pty`, `os`, `sys`, `select`,
`socket`, `struct`, `json`, `fcntl`, `termios`, `signal`, `ctypes`, `resource`, `collections`,
`time`; `sys` for the exception hook that keeps an error's message out of `keepers.log`, `ctypes`
for `prctl`, `resource` for the program's core limit, `collections` for the tail), about 810 lines
(about 700 without comments and blank lines; the first estimate counted the prototype's loop, and
the rules below — claim, start deadline, pid line, queues and caps, linger — and the checks of every
input it reads add the rest),
for python3 3.9 or newer (the newest thing it uses, `os.waitstatus_to_exitcode`, came with 3.9;
tested on 3.12 only, section 21). The server starts it as `python3 -I
<runtimeDir>/keeper-<build>.py` — the code it read at its own start (16.5), and isolated mode, so
that `PYTHONPATH`, the user's site packages and the script's own folder cannot put other modules
before the standard library — detached in a new session, working directory `/`, stdout
`/dev/null`, stderr appended to `<stateDir>/keepers.log` (the keeper writes only its own errors
there, one line each, never output or input; 2), and writes its **spec** to its stdin as one JSON
object, then closes stdin:

```json
{ "protocol": 1, "id": "<terminal id>", "socket": "<runtimeDir>/terms/<id>.sock",
  "cols": 120, "rows": 40, "cwd": "<directory>", "argv": ["claude", "--resume", "<id>"],
  "env": { "...": "the complete environment of the program (7.4)" },
  "startBy": "<ns>", "lock": "<the resume lock's value, or null for new>",
  "coreSoft": "<the soft core limit to give the program, from SKYDECK_CORE_SOFT, or null>",
  "meta": { "sessionId": "<uuid>", "kind": "resume|new", "slot": 3, "openedNs": "<ns>",
            "build": "<server build>" } }
```

`startBy` is the **start deadline**, no later than the resume lock holds: for a resume, the time
the lock was taken plus `LOCK_TTL_NS` minus `LOCK_START_TOLERANCE_NS` (55 s, design 7.6); for a
new session, the clock when `prepareNew` ran plus the same 55 s (it stores no row when there is
neither a label nor a group). Past it, the
guard's decision that allowed this launch is no longer protected by the lock: another skydeck may
have resumed the session since, and starting it then could run one session twice (principle 7).

The keeper:

1. makes itself non-dumpable (2) before it reads the spec — when `prctl` fails it writes
   `keeper -: dumpable` and goes on, dumpable, under the 1-byte soft core limit it inherits from
   `serve` (ruled, plan task 9) — creates its socket (mode 600; the directory is 700) and writes
   its `<id>.pid` line (4.2) with `started` 0. It does **not** start the program. A connection alone never starts it either: only the start message `G` of a
   screen side does (8.1), and only while the clock (`time.time_ns()`) is before `startBy`. Then it
   forks the program with `pty.fork()` at the current size, sends `T` with the program's pid and
   process start (8.1), and rewrites its `<id>.pid` line with
   `started` 1; the child changes to `cwd`, replaces its environment with `env` (in which `PWD` is
   `cwd`, 7.4), sets the soft core limit to `coreSoft` when that is not null (2), and `exec`s
   `argv`. The server that spawned the keeper sends `G`
   right after the first `hello` (one that finds it later checks first, 7.3); the start waits for a
   screen side because a TUI's first output is terminal queries that only a connected screen side
   can answer. When `chdir` or `exec` fails, the child writes one line naming the reason to the pty and
   exits 127.
2. never starts after `startBy`: a `G` that comes later, or a deadline that passes with no `G`,
   ends the terminal as **not started**: the keeper sends (now, or to the next screen side that
   claims it) `X` with `notStarted` and the reason, starts nothing, and ends as 7.8 says. A `N` from
   the server (it refused the start, 7.3) does the same. `hello` always says whether the program
   was started.
3. is connected to only by the server — nothing else ever connects to a keeper: `doctor` and
   `uninstall` read the `.pid` lines and `/proc`, or ask the server (16.2, 16.3). A connection is
   passive until its first frame, which must be `C` (**claim**, 8.1): it makes the connection the
   screen side, replacing an earlier one (a restarted server must not wait for a half-dead
   connection to time out). It accepts only a peer with its own user id (`SO_PEERCRED`).
4. reads the pty and keeps every chunk as a record in the tail; never interprets it, but for one
   rule: a record never ends inside a UTF-8 character. The first bytes (at most three) of a
   character the program has not finished writing wait for the next read and go in front of it;
   a resize record that comes meanwhile waits too, so it never stands between the two halves.
   Bytes that cannot begin a valid character are never held, and held bytes are sent as they are
   when the next read shows they do not go on as one, or when the program has ended: nothing is
   dropped or reordered. A snapshot is text, so a record boundary inside a character could not be
   reproduced by one (ruled, plan task 9).
5. applies input and resizes from the screen side (8.1). The pty's master is non-blocking: input
   goes into a queue that is written whenever the pty can take it, while the keeper goes on reading
   the program's output, so a large paste into a busy program never stops the keeper. The queue
   holds at most 4 MiB: an input frame that does not fit waits, unread, in the connection, and
   while it waits the keeper stops reading from the server's connection (a frame larger than the
   whole queue could never fit and closes the connection; the server sends at most 64 KiB), and
   the server, which then cannot write to the keeper, refuses further input for that terminal with
   `notice input-full` ("the program is not reading its input") rather than queue without end.
   Parks and resizes travel on the same connection and wait as well; the server makes no park
   while it cannot write to the keeper, so the tail may reach its cap and set gap (step 6, 7.3).
6. keeps at most 8 MiB of tail, counting 64 bytes for each record besides its own, so that many tiny
   records cannot outgrow it. When the tail would grow beyond that (no server parked for a long
   time while the program wrote a lot), it drops the oldest records and sets **gap**: the snapshot
   it holds no longer leads to the current screen (7.3).
7. sends to the server without blocking: when more than 8 MiB is queued for a connection, it closes
   that connection (the server reconnects and gets snapshot and tail) and keeps reading the pty.
   The program is never paused because a reader is slow.
8. ends as 7.8 says.

Memory: about 12 MB plus the snapshot and the tail (verified with the prototype, section 21).

### 7.2 The screen side

For each terminal the server keeps one `@xterm/headless` 6.0.0 terminal with
`@xterm/addon-serialize` 0.14.0 and `@xterm/addon-unicode-graphemes` 0.4.0 (the same width addon
as the page, 9.4), with 5,000 lines of scrollback. Every record from the keeper is applied to it in
stream order — output written, resizes applied — through one chain per terminal, and only after a
record has been applied is it forwarded to the pages (8.2.4), so a snapshot taken at any point in
the chain plus the records after it is exactly the stream.

It is the **only responder to terminal queries**: what the headless terminal answers (DA1, DA2,
DECRQM, CPR, DSR, DECRQSS) is sent to the keeper as input; the page never answers (9.3). It
answers OSC 10 and OSC 11 (foreground and background colour) itself, from the colours of the theme
the last focused page reports (the headless terminal has no colours); a reported colour is used
only when it is exactly `#rrggbb`, else — and until a page has sent its theme — xterm.js's
default colour is (foreground `#ffffff`, background `#000000`). A page reports its colours in
`start` (8.2.2) and, from follow-up F13, again in `theme` (8.2.3) whenever they change while it is
open: a click on the title bar's theme switch (12.1), the same choice made in another window of
the profile, or the system's scheme while the page follows it. The server keeps each page's latest
for that page's next `focus`, and answers from it at once while that page is the one that had
focus last, also when its window has lost the focus since (the system's scheme is changed in
Windows' settings, outside the window). So a program that asks after a change is told the colours
its terminal has then; before F13 the answer stayed the `start`'s until the page was loaded again,
also after a change of the system's scheme. It does not answer XTVERSION
in the first version (9.3). It never answers while it replays (7.3). The answers to a record's
queries go to the keeper once that record has been applied.

The serialise addon does not restore everything (section 21). The server adds what it misses at
the end of every snapshot, from state it tracks with parser hooks that follow xterm.js 6.0.0's own
handling of DECSET and DECRST, DECSCUSR, RIS and DECSTR: cursor visibility (mode 25), the mouse
encoding (SGR, mode 1006; SGR pixels, mode 1016), the cursor style (DECSCUSR) and the cursor's
blinking (mode 12, which xterm.js keeps as an option apart from DECSCUSR); and, read through
xterm.js's API, synchronized output (mode 2026) and new-line mode (mode 20); then the cursor
position. The addon puts the cursor one column too far left when the last row is full, so the
position is set with CUP — except when the cursor stands past the last column (a character was
just printed there and the next one wraps), which CUP cannot reach: then the last character of
that row is printed again with its own attributes, which leaves the cursor past it. Last comes the
pen (the attributes the next character gets), read from the headless terminal's own state — the
same internal the serialise addon reads for its pen, so a test pins it to the vendored version.
The addon turned bold off and dim off both with SGR 22, which turns off both, so a rebuilt cell
lost its bold after a dim one; its vendored bundle is patched (16.6). Two more of its defects are
corrected on its output, exactly, since no cell holds ESC: it serialises the alternate screen as
if the pen were the default, so SGR 0 goes before the alternate screen; and above a blank row
followed by a wrapped one it writes cursor moves of 0 columns, which move one and left a stray
`-`, so those moves are dropped.
A link (OSC 8) is not carried across a snapshot, whether it was closed or is still open: what was
written before the snapshot is not clickable after it (plain URLs still are, 9.6), and the rest of
a link still open at the snapshot comes out as plain text. xterm.js reports a cell or pen that
carries a link as underlined, so the pen takes only a real underline (SGR 4): a link's underline
never goes on after the program closes the link.

Known limits: a snapshot does not restore the scroll region (DECSTBM), the saved cursor (DECSC,
and so where leaving the alternate screen puts the cursor), the character sets (`ESC ( 0`) or tab
stops set by the program (HTS, TBC); xterm.js's API does not show them, and Claude Code's normal screen is not known to use them
(check W26). Nor are these rebuilt exactly, by the serialise addon:

- an alternate-screen line marked wrapped comes back unwrapped (its cells are equal, and the
  alternate screen never reflows);
- with autowrap off (DECAWM), a wide character overwritten at the right margin leaves a cell pair
  that is serialised one column too wide (Claude Code keeps autowrap on);
- a colour set as `38;5;n` with n below 16 comes back in its 16-colour form (it renders the same);
- the underline's style and colour (SGR 4:3, 58) are not kept, by the addon nor by the pen the
  screen side adds: an underlined cell, and what the program prints next, come back with a plain
  underline in the text's colour;
- the cells of a link come back with a plain underline, not the link's dashed one;
- rows erased with a background colour below the last row that has content (`CSI 48;5;n m CSI J`)
  come back with the default background: the addon writes rows only up to the last one with
  content or the cursor's row, whichever is lower;
- an erased cell left in inverse video by overwriting half of a wide character comes back without
  it: the addon steps over it with a cursor move.

A record can end inside an escape sequence or inside a UTF-8 character, and a snapshot taken
there would cut it: the next record's continuation would reach a screen rebuilt from the snapshot
as text. The keeper never ends a record inside a UTF-8 character (7.1; stage A's plan, task 9),
and the screen side follows the stream far enough to keep the escape sequence it stands inside
and appends it to every snapshot, last, so that the next record completes it (the snapshot's
seam; closed by task 33 of stage A's plan). A record that ends inside a grapheme cluster (between
an emoji and its skin tone, inside a ZWJ sequence, before a combining mark or VS16) is a known
limit: after a rebuild the rest of the cluster gets a cell of its own, until the program redraws
that row. xterm.js joins a character to the cluster before it through a state its parser keeps
across writes, and every CSI resets that state, so a snapshot (which ends with CUP and SGR) always
leaves it at its start; the keeper cuts records only between UTF-8 characters.

### 7.3 Attaching, parking, rebuilding

- **Attach.** On connecting to a keeper the server claims it (`C`) and receives `hello`, the
  parked snapshot if there is one, the tail, and the exit if the program has ended (8.1). It builds the screen side from the
  snapshot and applies the tail, answering no query while doing so (those were answered when they
  were new), and is then live. Measured with the prototype: about 40 ms for a parked screen and a
  short tail; parsing runs at about 10 MB/s.
- **A keeper that has not started its program.** The server that spawned it sends `G` at once:
  it has just run the guard and taken the lock (11.2). A server that **finds** such a keeper —
  after a restart, in `<runtimeDir>/terms/` — has not: before `G` it runs the guard again on
  freshly refreshed rows (`prepareResumeById`'s refresh and `checkResumable`, design 7.6) and
  checks that the session's resume lock in the store is still of the take of the spec's `lock` —
  that value, or a renewal of it (restore renews its locks while it waits) — and not one another
  skydeck has taken over (design 7.6's mark of a take: same event id, same mark, and never two
  different values a take wrote); for a new session, that no live process holds the session id.
  When all holds and the deadline has not passed, it sends `G`; otherwise `N` with the reason, which
  the window shows on the terminal ("not started: <reason>"; for the lock, "its resume lock was
  taken over"). So a restored keeper whose hello comes late, or after a reconnect, is started. A
  renewal an older skydeck wrote carries no mark and is refused as taken over, the cautious side
  (stage C's plan, C19, task 80; it replaces stage A's exact comparison, ruled in its task 21).
- **Park.** The server parks a snapshot when the tail has grown past 1 MiB, when 30 seconds have
  passed with output since the last park, and for every terminal when it stops (5.5). A park names
  the last record it covers; the keeper drops those from the tail. Serialising 5,000 lines takes
  about 75 ms (measured: 10,000 lines in 145–166 ms), so parking is rare by design. The keeper's
  first size is in no frame (a hello carries the current size), so the server that spawns a keeper
  parks its empty screen at record 0 right after the first `hello`: every later claim gets that
  size in `S`, and a rebuild without any other park starts at the right width (stage A's plan,
  task 16).
- **Reading.** The server reads a keeper no faster than its screen side applies the records: while
  more than 4 MiB of records wait for the screen side it stops reading that keeper's socket, and
  reads again below 1 MiB. The keeper then does what 7.1 step 7 designs for a slow reader: it
  closes the connection at its send cap and goes on reading the pty; the server reconnects and
  takes the rest from the tail (gap and redraw if the tail overflowed meanwhile). The memory of a
  terminal stays bounded, and the program is never paused (stage A's plan, task 16, review 2).
  Reconnections to one keeper are at most one a second, except after a claim that fell behind (the
  server had stopped reading it, and did not end it itself for a frame it refuses): that one is
  claimed again at once. A claim whose tail stops coming (no frame for 10 s while the server reads) counts as a
  lost connection. A gap found after such a cycle is shown as "part of this terminal's output was
  skipped: it came faster than skydeck could show it". Known limit: input written in the short
  moment between the keeper closing a claim and the server noticing it is lost, and `full` is
  answered while the next claim is being made; in a flood faster than the screen side, a key press
  may have to be repeated.
- **A claim that rebuilds.** A hello whose tail does not follow the screen the server holds (a
  first claim, or records lost for that screen) drops that screen at once; a page that attaches
  before the snapshot or the first record has made the new one waits for it, and gets the empty
  screen and the exit if the keeper is lost first. A hello whose tail does follow it (a reconnect)
  goes on with that screen and skips the records it has.
- **Gap.** A keeper that reports gap (7.1, step 6) has lost records. The server rebuilds from what
  is left, shows "part of this terminal's output was lost while skydeck's server was not running"
  on the terminal, and makes the program redraw by changing the pty's width by one column and back,
  with a pause of at least 50 ms between the two (two quick SIGWINCH collapse into one, and a
  program that reads its size when it handles the signal sees no change; measured with the
  stand-in, plan task 3). When the connection breaks inside that pause, the way back is sent on the
  next connection once its claim has settled; a page's resize that reaches the keeper meanwhile
  replaces it. The scrollback above the redraw may be wrong.

A server restart therefore shows every screen exactly as it was (verified with the prototype for
every viewport cell, colour, attribute, 119 lines of scrollback, wrap flags and modes after two
resizes, and after SIGKILL of the screen side with unparked records, section 21), within the
known limits of 7.2.

### 7.4 The environment of a terminal's program

The server's environment (5.2), with:

- removed: the variables that say which terminal or multiplexer a process runs in
  (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `WT_SESSION`, `WT_PROFILE_ID`, every `WEZTERM_*`,
  `TMUX`, `TMUX_PANE`, `STY`, `VTE_VERSION`, `KITTY_WINDOW_ID`, `ITERM_SESSION_ID`, `KONSOLE_*`,
  every `VSCODE_*`), and those that describe the terminal the server was started from rather than
  the new one: `GPG_TTY` and `SSH_TTY` (a pinentry would draw on that tty), and
  `CLAUDE_CODE_SSE_PORT` and `ENABLE_IDE_INTEGRATION` (an editor's Claude Code extension; every
  session would reach that editor), and `GIT_ASKPASS` when `VSCODE_GIT_ASKPASS_MAIN` is set beside
  it (it is then the editor's askpass script, which runs the `VSCODE_*` names removed here and
  would answer git with empty credentials; a `GIT_ASKPASS` the user set stays). `WEZTERM_`,
  `KONSOLE_` and `VSCODE_` are the only prefix rules: those programs set a family of variables
  whose names change between versions (an editor's integrated terminal sets many `VSCODE_*`,
  pointing at that editor's sockets); every other name is exact. Also removed:
  `SKYDECK_HANDOFF`, `SKYDECK_LAUNCHER_CACHE` and the launcher's `NODE_COMPILE_CACHE` (5.2),
  `SKYDECK_CORE_SOFT` (2; its value goes into the keeper's spec instead) and `SKYDECK_ENV_ORIGIN`
  (5.2: where the server's environment came from). The other `SKYDECK_*` variables pass:
  `SKYDECK_HOME` and `SKYDECK_NODE` are the user's settings, and the hook needs them;
- removed, as a second line of defence behind 5.1's refusal to start a server inside a Claude Code
  session: the variables Claude Code sets for the programs it runs, so that no program in the
  window looks like another session's child or carries its messaging token. The list lives in
  `src/claude/terminal.ts` and is **to be confirmed** (check W23): known today
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` (design 14, in a hook's
  environment) and `CLAUDECODE` (in the environment of a Claude Code session's command, seen on one
  machine on 2026-11-13); seen in the
  environment of a Claude Code session's command, origin not yet known, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
  `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_EFFORT`. Names only, never a prefix: `CLAUDE_CODE_USE_BEDROCK`
  or `CLAUDE_CONFIG_DIR` are the user's own and pass;
- set: `TERM=xterm-256color`, `COLORTERM=truecolor`, `PWD` = the program's directory, and
  `WSL_INTEROP=<runtimeDir>/interop` while that link points at a live socket (6.4; otherwise
  `WSL_INTEROP` is left as it is).

`TERM_PROGRAM=vscode` is never set: Claude Code would take the terminal for an editor's (section
21). The program runs directly (`exec`), as in step 1; no shell is started around it.

### 7.5 A terminal and its session

A terminal is opened for a session (resume) or for a new session id (`new`), and the server keeps
both in memory: the **expected session**. Which session it shows is decided again at every tick:

- the terminal's program is the process the keeper reported in `T` or `hello` (8.1): pid and
  process start, on the current boot. A terminal whose keeper has not reported a start has no
  program yet. A terminal whose keeper sent `exit` has none any more (the keeper reaped it, 7.8).
  A **lost** keeper's program (7.8) stays its terminal's while it may still run — its stat line
  names that pid and start, or cannot be read (design 5.5: what cannot be read is not taken for
  gone) — and for less than 60 seconds after the loss (the exit's time, on the server's wall
  clock: a clock that stepped back keeps it longer, one that stepped forward, as after a sleep of
  the host, ends it early):
  the server knows the loss at once, while the program, given SIGHUP, runs its end for a moment,
  so its session is not "running in another terminal" (7.9) meanwhile and the lost terminal is not
  dropped for it (7.8; stage B's plan, task 57). The same one rule holds back the settling of the
  lost exit and refuses a start of the session through the window while it holds (7.8; stage C's
  plan, task 82). The pid alone never counts: it may be another process's by then. Known limits:
  a program that has not ended 60 seconds after the loss counts as running in another terminal, as
  7.9 shows it, and the lost terminal is dropped, so its later end is not marked in the window;
  one that has not reported its session start by then is not seen at all any more, so a start of
  its session is no longer refused, and closing the lost terminal or restarting the server ends
  that refusal too (7.8); a wrapper `claudeCommand` that ends at the SIGHUP before its `claude`
  child leaves that child outside every terminal, so the lost terminal is dropped while the child
  runs its end;
- a holder of a session (design 6.1) **belongs to** a terminal when the holder's pid is the
  terminal's program or a descendant of it (parent pids read from `/proc/<pid>/stat`, at most 8
  steps up, each judged alive by design 5.5's rule). The descendant rule covers a `claudeCommand`
  that is a wrapper. A step whose `/proc` file cannot be read (design 5.5's "unknown") decides
  nothing: that holder's session is neither given to a terminal by it nor listed as running in
  another terminal (7.9), and while any holder is unknown no terminal newly becomes "started, not
  reported"; the server keeps the previous tick's answer for that session and acts on nothing that
  rests on it (stage A's plan, task 21, ruled);
- a terminal shows the session one of its holders holds. After `/clear` or an in-session `/resume`
  that is the new session; the old one becomes `not-running` (with no mark, design 6.3), and the
  terminal moves to the new session's row with its slot;
- a terminal whose program has no holder yet is **starting** (12.7 shows it on the expected
  session's row; a new session has no row yet, so the server shows the terminal as a row of its
  own, titled with the label or "new session in <directory>"). After `restoreStartTimeoutSeconds`
  without a holder it is shown as "started, not reported" and stays where it is.
  The row of a terminal opened for `new` has the new session's id (known from `prepareNew`), so
  that the page can select it, and is marked starting; the keeper's `meta` carries the label and
  the directory, so the row survives a server restart. When the session reports a start, the
  terminal moves to that session's ordinary row. A program that ends before its session reported a
  start leaves the row in place, no longer starting, with the ended terminal (7.8) until the
  terminal is closed.

### 7.6 Slots

A terminal gets the lowest slot 1–9 that no open terminal has, when it is opened, and keeps it
until it ends; the tenth and later terminals get none. The slot is part of the keeper's spec and
`hello`, so it survives a server restart. Slots are never reordered in the first version.

### 7.7 Keeper versions

The keeper file states its version and the protocol version it speaks (`hello`, 8.1). A running
keeper is never replaced: a new keeper version applies to terminals opened after the server that
starts them was updated. Version 2 added the hello's `tailFrom`; version 3 (follow-up F30) the
hang-up `E`, within protocol 1. The server sends `E` only to a keeper whose hello says version 3 or
later: a keeper of version 2 would close the connection on a type it does not know, so its terminal
is served as before and its session cannot be ended from the window (12.10). The server speaks every
keeper protocol version that has shipped (they are small); it refuses to attach a keeper with a
newer protocol than it knows and shows "this terminal was started by a newer skydeck; run skydeck
window --restart" on it. Its program keeps running.

### 7.8 When the program ends

The keeper reads the pty until it closes, reaps the program, and sends `exit` with the exit code or
signal. It then ends when the server has acknowledged the exit (8.1), or when no server has been
connected for 10 minutes since the program ended; it removes its socket and pid file. A terminal
that was not started (7.1, step 2) ends the same way, after its `X` with `notStarted`: nothing was
started, and the server gives back the resume's lock and a new session's label and group as below
(ruled by the plan owner, stage A's plan task 21: the window shows no command to run by hand for it,
11.2, so nothing waits for the lock to expire).

The server, on `exit`:

- keeps the terminal's last screen in memory and shows it in the terminal pane dimmed, under a bar
  `claude exited (status <n>) at <time> · Resume · Close` (12.6), until the user closes it,
  resumes the session, or the server restarts. When its session runs again the ended terminal is
  dropped — forgotten as `close-terminal` forgets it, its slot freed, its keeper allowed to end
  (ruled by the plan owner, review of plan task 13): a resume from the window closes the
  session's terminals whose program is over (ended, lost, not started) once the guard and the
  lock have let it through and before it opens the new one (a refused resume leaves them), and
  the tick closes an ended terminal whose session is seen running anywhere else. A terminal whose
  program may still run is never dropped this way — for a lost terminal, for 60 seconds after the
  loss (7.5);
- when the program ended **before its session reported a start** (`resumeStarted`, design 7.6,
  never became true for this launch — `exec` failed, `claude` was not found, it exited at once)
  and the session's lock is still of the take this launch made (the lock it took, or a renewal of
  it by restore: design 7.6's mark), releases that lock, and for a new
  session removes the label and group it stored (design 7.6, 7.7): nothing runs, and the bar's
  Resume must not be refused for a minute. This differs **on purpose** from `settleFailedLaunch`,
  which releases only when no command could be printed (a printed command may yet be run by hand):
  the window prints nothing for the user to run (11.2), and the bar offers Resume itself. It is done
  for every exit, also of a terminal whose program was never started (an `X` with `notStarted`, a
  keeper lost before `T`); a new session's label and group are removed only while they are as
  `prepareNew` stored them (principle 6). A lock another skydeck took over is left alone (stage C's
  plan, C19, task 80; 7.3 has the other half). Known limit (design 7.6): a take-over at a
  millisecond congruent to the take's (mod 999,999, about one in a million) by a restore that then
  renews it reads as a renewal of this launch's take; if this terminal ends while that restore
  waits, the restore's lock is given back and its next renewal finds it gone;
- for a **lost** keeper's exit (below) keeps the last screen under its bar as for any other, but
  holds back the point above — the lock given back, a new session's label and group removed —
  while its program may still run by 7.5's rule (the program its keeper reported, alive by
  design 5.5 or not readable, less than 60 seconds after the loss): the server made that exit up,
  nobody reaped the program, and a `claude` before its `SessionStart` holds nothing the guard
  could see. The lock stays and a new session
  keeps its label and group (the program may yet report its start; ruled by the plan owner, stage
  C's plan, task 82, for both kinds), and the window refuses every start of the session — the
  page's Resume, `POST /resume`, restore's own check (11.1) — with the guard's words,
  `<short> is running (pid <p>)`, `<p>` being that program (with a wrapper `claudeCommand` the
  guard names its `claude` instead, once that has reported its start). Once that program is gone,
  or 60 seconds after the loss, the exit is settled as above. Known limits: a program that still
  runs 60 seconds after the loss and never reported a start is no longer seen — its lock is given
  back and a start of its session starts a second one; a keeper lost when its launch is older than
  the lock's 60 seconds has no lock left to keep — the window still refuses for 60 seconds after
  the loss, but `skydeck resume` starts a second program, since its guard sees no holder and no
  lock; and closing a lost terminal (and a restart of the server) ends the window's refusal; the
  lock alone then refuses, until 60 seconds after the launch (ruled on the review of stage C's
  task 82). A server that stops while it holds such an exit back settles nothing more for it: the
  lock expires by itself, and a new session's label and group stay if its program never reports a
  start.

A keeper whose connection ends without `exit` is **lost** only when its process is dead by design
5.5's rule (its `.pid` line) or its socket refuses connections: then its program got SIGHUP
(section 21), and the bar says `the terminal's keeper ended unexpectedly; claude ended with it`. A
keeper that is alive but slow to answer is reconnected to, with the bar `reconnecting to this
terminal`, never declared lost. `keepers.log` holds the keeper's own last error, if it wrote one.

Socket files whose connect is refused, and their `.pid` lines (a keeper that died, files from
another boot under a runtime directory that survives one), are removed by the server when it
starts, and when the user closes a lost terminal whose line is dead; they are skydeck's own
transient files.

### 7.9 Sessions running outside the window

A session whose holder belongs to no terminal of the window runs in another terminal. The window
lists it with the mark "running in another terminal" and, when selected, shows a card with the
holder's pid, its terminal device (from `/proc/<pid>/fd/0`, when readable) and the project
directory. It cannot be shown or typed into: the pty belongs to the other terminal, and taking it
over would need `ptrace` or stealing input (section 21). It is never taken over. The resume guard
(design 7.6) is unchanged, so the window's Resume refuses it while it runs, with the guard's own
message. Once it has ended it is a session like any other and can be resumed into the window.

**A session moved to the background from a window terminal** (follow-up F11). Claude Code's agent
view can take a session out of its terminal: "In a session running in the foreground, one you
started in the terminal rather than attached to from agent view, pressing `←` on an empty prompt
backgrounds it and opens agent view with that row selected", and "In a fresh session with no
messages yet, `/bg` asks you to send a message first, while `←` works right away"
(code.claude.com/docs/en/agent-view, read 2026-11-17). The conversation then goes on in a
background session with a new id, whose program runs under a `claude bg-pty-host` process
re-parented to init, outside the terminal's process tree; the terminal's program shows agent view,
and what the user types there then goes to a background session (observed on Claude Code 2.1.311,
design.md 14). By the rule above the window lists the background session as running in another
terminal, with its turns "finished · not seen" (seen is kept for the session the terminal shows,
12.4), while the terminal's row keeps its own session, which never took that prompt. skydeck does
not follow such a session into the terminal: the fields that would tie the two (`parkedJobId` in
the live-session file of the terminal's program, `kind` `bg` and `jobId` in the background
session's) are not documented, and following them would change the mapping of 7.5. The key is
pressed by accident because ← also closes a group in the list (12.9). So `skydeck install` offers
to turn the shortcut off and `skydeck doctor` reports it (design.md 8). The switch is
`leftArrowOpensAgents`, "default `true`", a global config key that lives in `~/.claude.json`
("Claude Code ignores this key in settings.json"; with `CLAUDE_CONFIG_DIR` set, the file lives
under that directory); `false`: "Claude Code turns the shortcut off; in a session you attached to
from agent view, `←` on an empty prompt still detaches"; its `/config` label is "← opens agents",
and `/config` writes these keys "and you can also edit them by hand". skydeck cannot set it for the
window's terminals alone: `--settings` sets no global config key. The file is "Read at session
start", so the change holds for sessions started after it; whether a running session re-reads a
hand edit, or writes an older copy back when it saves the file, is not documented. Agent view
itself (`claude agents`, `/bg`) stays.

## 8. Protocols

### 8.1 Server and keeper

A stream of frames over the keeper's unix socket. A frame is one ASCII type byte, the payload
length as a 4-byte big-endian unsigned integer, and the payload; a payload is at most 16 MiB. A
frame the keeper cannot parse, or a type it does not know, closes that connection (never the
keeper). Protocol version 1:

| Type | Direction | Payload |
|---|---|---|
| `C` claim | server → keeper | Empty. The connection becomes the screen side (7.1, step 3). The first frame of every connection. |
| `H` hello | keeper → server | JSON: `protocol` (1), `keeper` (keeper version), `id`, `started` (whether the program was started), `startBy`, `lock`, `pid` and `procStart` (the program's, field 22 of its `/proc/<pid>/stat`; null before the start), `cols`, `rows`, `seq` (records so far), `snapSeq` (the last record the parked snapshot covers; 0 both for none and for the empty screen parked at record 0, 7.3 — see `S`), `tailFrom` (the number of the tail's first record: `snapSeq` + 1, or later when records were dropped, `seq` + 1 for an empty tail), `gap`, `meta` (the spec's), `exited` (null or as `X`). The answer to `C`. |
| `G` start | server → keeper | Empty. Starts the program, only before `startBy` and only once (7.1, steps 1 and 2). |
| `T` started | keeper → server | JSON `{ pid, procStart, atNs }`: the program was forked. Sent once, to the screen side, right after the fork and before the program's first output (when
`exec` then fails, `X` with code 127 follows); a server that claims the keeper later finds the same in `hello`. It is what `open()` waits for (11.2) and what ties the terminal to the holder the program becomes (7.5). |
| `N` do not start | server → keeper | UTF-8 reason, at most 1,024 bytes (a longer one closes the connection, as any frame the keeper cannot parse). The program is never started (7.1, step 2). |
| `S` snapshot | keeper → server | 8-byte record number, 2-byte cols, 2-byte rows, the parked snapshot (UTF-8). Right after `H`, only when one is parked. With `snapSeq` above 0 it always comes. With `snapSeq` 0 it comes only when the empty screen was parked at record 0 (7.3), and the server tells by the frame after `H`: `S` (the first size), or the tail's first record (never parked; the screen starts at the hello's size). When the tail is empty as well (`tailFrom` is `seq` + 1) the server makes the empty screen at the hello's size at once and ignores an `S` that follows: it can only be that empty screen, at an older size. |
| `D` output | keeper → server | One record: bytes as read from the pty, except that a record never ends inside a UTF-8 character: the first bytes of a character the program has not finished writing go with the next record (7.1 step 4). After `H` (and `S`) come the tail's records, then live ones. |
| `R` resize | keeper → server | One record: JSON `{cols, rows}`, the size the pty was set to. |
| `X` exit | keeper → server | JSON `{code, signal, atNs, notStarted}`: after the last `D`. `notStarted` is null, or the reason the program was never started (the deadline passed, or `N`). |
| `I` input | server → keeper | Bytes written to the pty. Dropped after the program has ended. |
| `Z` resize | server → keeper | `"<cols> <rows>"`: sets the pty size, appends an `R` record and sends it back, so the resize takes its place in the stream. |
| `P` park | server → keeper | 8-byte record number, 2-byte cols, 2-byte rows, snapshot. The keeper keeps it and drops the tail's records up to that number. |
| `A` acknowledge | server → keeper | The server has the exit; the keeper may end (7.8). |
| `E` hang up | server → keeper | Empty (a payload is never read). Keeper version 3 (follow-up F30): the keeper sends SIGHUP and then SIGCONT to the program it started — to its pid, which `pty.fork` made the leader of a session of its own whose controlling terminal is the pty, as the kernel signals that leader when a terminal's other end is closed (SIGCONT: a stopped program goes on, and gets its SIGHUP) — while it has not reaped it, and nothing else: it reads the output, reaps the program and sends `X` as for any end. Before the start, after the end, and to a program that ignores SIGHUP, nothing more happens. Each `E` is one hang-up; the server sends one per request (12.10). |

A connection whose first frame is not `C` is closed. The server closes a connection whose keeper
sends what the codec refuses, a first frame that is not `H`, a `hello` of another terminal, a
missing or wrong `S`, a frame no keeper sends, or a size above 1,000 columns or 500 rows in `H`,
`S` or `R` (a keeper is only ever given sizes within that, 8.2.6); it logs the kind once while the
same problem repeats. Records are numbered from 1 in the order the
keeper produced them. The server's position after an
attach is `seq`: the snapshot covers records up to `snapSeq` and the tail, records `tailFrom` to
`seq`, brings it to `seq`; after a gap the records between are lost, and the numbers still tell
the server where the tail ends and which record a park names.

### 8.2 Page and server

#### 8.2.1 HTTP

The server listens on `127.0.0.1:<port>` only. Every request must have the `Host` header exactly
`127.0.0.1:<port>` (15.1), else 421; for port 80 also `127.0.0.1`, which is what a browser sends
for its default port (and the upgrade's `Origin` is then `http://127.0.0.1`).

| Request | Answer |
|---|---|
| `GET /` | `web/index.html`, with the asset version put into its asset URLs by the server when it reads the file at start (there is no build step). No secret needed: the page holds no secret of its own. |
| `GET /assets/<asset version>/web/<path>`, `GET /assets/<asset version>/vendor/xterm/<path>` | A file of `web/` or `vendor/xterm/`; the layout mirrors the checkout, so `web/`'s modules import `../vendor/xterm/…` by relative URLs. Only files of a fixed list are served (no path is taken from the request beyond that list): every file of `web/` but `web/tsconfig.json` and `web/index.html` (served as `/` only), and the vendored `.mjs` and `.css` files of `vendor/MANIFEST.json`. `Cache-Control: max-age=31536000, immutable` under the versioned path. |
| `GET /manifest.webmanifest`, `GET /favicon.ico` | The page's manifest and icon (12.12): `web/manifest.webmanifest` with the asset version put into its icons' URLs as into `index.html`'s, `application/manifest+json`; and `web/icons/favicon.ico`'s bytes, `image/x-icon` (the same file is also served under the versioned path, which is the one `index.html` names). |
| `GET /ws` with `Upgrade: websocket` | 8.2.2. |
| `OPTIONS` | 403. |
| any other method but `GET` (`HEAD` included) | 405 with `Allow: GET`. |
| any other `GET` | 404. |

A query string is ignored and never used: `/?x` is `/`. Every path outside `/assets/` (`/`, the
manifest and the icon) and every refusal (404, 405, 421, 403) carry
`Cache-Control: no-store`, so that a page reloading after a server restart always gets the new
asset version.

The server reads every file it serves into memory when it starts, and its build (16.5) is the hash
of exactly those bytes: it serves what it hashed, never a file a `git pull` changed under it. It
does not start when a vendored file differs from the manifest (also one that changed between its
reads), or when `bin/skydeck-keeper` is missing or not UTF-8.

Every answer carries `Content-Security-Policy: default-src 'none'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; manifest-src 'self';
connect-src 'self' ws://127.0.0.1:<port>; base-uri 'none'; form-action 'none'; frame-ancestors
'none'`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and
no CORS header ever. `OPTIONS` is answered 403, any other method but `GET` 405. Nothing on the
TCP port acts on anything: the static files are not secret, and every action goes through the
WebSocket after the proof (8.2.2).

**Node.js's own answers.** A few requests never reach a handler of skydeck's: Node.js's HTTP server
answers them itself, with no body and without the headers above, and closes the connection
(measured on Node.js 24.19): 400 for an HTTP/1.1 request without `Host` (from its request parser),
and, through its default `clientError` handling, 400 for an unknown method, a request line it
cannot parse, `Content-Length` together with `Transfer-Encoding` or an HTTP/2 preface, and 431 for
headers above 16 KiB; `CONNECT` is closed without an answer. They only refuse, so the headers would
protect nothing there (ruled, plan task 17); server tests pin them, so that a Node.js release that
changes them is noticed. Every request with `Connection: Upgrade` and an `Upgrade` header goes to
the upgrade handler whatever its path, method or `Host`; that handler applies this section's checks
itself (421, 403, 405, 404) and its refusals carry the headers above and `no-store`. While the
server starts — until it has found its keepers (7.3) and run its first tick (10.1) — and after
`bye` (5.5), an upgrade with the right `Host` is answered 503 (ruled, plan tasks 17 and 23): no page
acts on a server that does not know its terminals yet, and a page tries again on a 503 as on any
lost connection. If that first tick's refresh failed (a busy database, 14), the first list comes
with the next tick; what matters is the terminals, which are all known by then. When 64
connections are waiting for their `hello` (8.2.2) and another upgrade passes the checks above, the
server drops the one that has waited longest and accepts the newcomer: a local process that holds
idle connections which prove nothing can neither use up the server's descriptors nor lock a new or
reconnecting window out, since a real page's `hello` takes milliseconds; a connection that has
proven itself is never dropped for this (ruled, plan task 17).

**Why `'unsafe-inline'` for styles, and only for styles.** xterm.js 6.0.0's DOM renderer creates
`<style>` elements at run time and writes the colour palette, cursor and selection rules into them
(verified: under `style-src 'self'` a red cell renders black; section 21). Inline styles cannot run
code; `script-src` stays `'self'` with no exception, and a page test checks a cell's computed
colour so that nobody loosens `script-src` to make colours work (17.4).

The WebSocket is the server's own RFC 6455 code on `node:http` (the prototype is about 100 lines
and passed every frame test, section 21): text and binary frames, fragmentation, ping and pong,
close codes; invalid UTF-8 closes with 1007, an unmasked client frame with 1002; a message over
1 MiB from a page closes with 1009. The page never sends one: it splits input (a large paste) into
`input` messages of at most 64 KiB, in order. While the socket to a page is backed up, only the
latest ping's pong is kept and sent when it drains (RFC 6455 5.5.3), so that a peer that pings
and never reads cannot grow the queue. The answers of the WebSocket endpoint itself (its 101 and
its 400 for a request that is not a valid upgrade) are not pages: they carry
`Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'` with the same other headers as every answer, and no CORS header. Once a
connection closes, whichever side began it, the server destroys its socket if the peer has not
closed its side a few seconds later: a peer that neither reads nor closes cannot hold a
connection. What a peer makes the server keep grows only with what it sent, however it splits
its frames into reads and its messages into fragments.

#### 8.2.2 Handshake, proof and versions

Two keys exist. The **secret** (15.2) is long-lived and stays in WSL and in the page. A **launch
token** is made for one window: 32 random bytes, valid once and for 30 seconds (10 minutes for
`--print-url`). The server mints it when a command asks over `server.sock` (`POST /token`, 8.3) and
keeps it in memory only — never in the store or a file; a server restart forgets every token. Only
a launch token is ever put on a command line or into an address (5.1, 5.3). The command that asked
for it gives it up (`POST /token/drop`) when its wait ends (5.1), whether or not a page used it, so
a token never outlives the moment it was made for. Neither key crosses a connection in
either direction: each side proves that it knows the key, and the page trusts a server only after
the server's proof.

1. The upgrade request must carry `Origin` exactly `http://127.0.0.1:<port>` (and the `Host` of
   8.2.1), else 403.
2. The server's first message, at once: `{ "t": "challenge", "protocol": 1, "nonce": "<sN>" }`,
   `sN` 32 random bytes in base64url, new for every connection.
3. The page's first message, within 5 seconds (else the server closes with 4001):
   `{ "t": "hello", "protocol": 1, "mode": "key|launch", "nonce": "<cN>", "proof": "<pP>" }`,
   where `cN` is 32 random bytes of the page's, `K` is the secret (`key`) or the launch token
   (`launch`) — a page that was given a token always uses mode `launch`, even when it holds a
   stored key, and replaces that key with the one it receives —, and `pP = HMAC-SHA256(K, "skydeck page 1\n" + mode + "\n" + sN + "\n" + cN + "\n" +
   origin)` (Web Crypto, available in a secure context). A `protocol` the server does not speak
   closes with 4426. Each side accepts the other's nonce only as exactly 32 bytes in base64url (43
   characters), in the canonical form an encoder writes (the two bits the last character has to
   spare are zero), so that one nonce has one text; anything else closes the connection (4001 from
   the server).
4. The server checks `pP` in constant time, against the secret or against each launch token it
   holds. A token that matches is marked **used** at once, in memory (the server is one process,
   so two pages racing with one token cannot both get it), and is remembered as used for the
   server's whole life (a few bytes each), so that a second use is always recognised. A proof made with a token that is already used closes with **4004** and
   raises the **alarm** (below). No match at all closes with 4003 and nothing else. Otherwise it
   answers:

   ```json
   { "t": "welcome", "proof": "<pS>", "key": "<only in mode launch>", "protocol": 1,
     "assetVersion": "<build>", "serverId": "<random>", "bootId": "<id>",
     "version": "<package version>", "keepAlive": { ... }, "nowNs": "<ns>" }
   ```

   with `pS = HMAC-SHA256(K, "skydeck server 1\n" + mode + "\n" + sN + "\n" + cN + "\n" +
   origin)`. In mode `launch`, `key` is the secret encrypted with AES-256-GCM under a key derived
   from the token and both nonces (HKDF-SHA256, salt `sN + cN`, info `skydeck key 1`), with a random
   IV: only a holder of the token can read it, and the token is now used up. The labels differ, so
   neither proof can be replayed as the other, and fresh nonces on both sides make an old proof
   worthless.
5. The page checks `pS`. Until it has, it sends nothing else, shows nothing the server sent, and
   does not reload itself on the server's word. A wrong `pS` makes it close the connection and say
   `something answers on port <n> that is not skydeck's server; nothing was sent to it`, and it
   opens no further connection until it is reloaded, in either mode (6.3; ruled, plan task 26) —
   but for a reload key's own, which reloads only after a proof (15.3).
   Once `pS` checks out, in mode `launch` it keeps the secret from `key` (below); later
   connections use mode `key`.
6. Only then the page sends `{ "t": "start", "assetVersion": "<the version it was loaded with>",
   "windowId": "<random per page>", "focused": true, "theme": { "fg": "…", "bg": "…" } }`, and the
   connection is open for 8.2.3's messages. `theme` is the terminal's foreground and background
   as the page draws them at that moment (the system's scheme, or the title bar's switch, 12.1);
   a later change is sent as 8.2.3's `theme` (follow-up F13). A page whose `assetVersion` is not the server's
   reloads itself (it was loaded from an older server), without sending `start`. It does so once
   per version of the server's (it remembers that version for the tab): a page that still differs
   after that reload is not served by that server at all — most likely something else answers the
   page's loads (15.3) — and reloading again would loop for ever, so it sends nothing more and says
   `this window's page is not the one skydeck's server serves, and reloading did not change that;
   close every skydeck window, delete the window's profile folder and run skydeck window
   --new-secret` (ruled, plan task 26). A page that cannot remember a reload (its session storage
   is not available) does not reload on its own: it sends nothing more and says `this window's page
   is not the one skydeck's server serves, and it cannot tell whether it reloaded already; press
   Ctrl+Shift+R to reload it, or close it and run skydeck window` (ruled, plan task 26's review 1;
   Ctrl+Shift+R is the page's reload in both zones, 12.9). Nor does a page whose key IndexedDB did
   not take (it lives only in the page's memory, and a reload would lose it): it says `this window's
   page is not the one skydeck's server serves, and its key could not be stored, so it cannot reload
   itself; run skydeck window again`.

**Reading the secret.** The server reads the secret from the store at every `hello`, so
`--new-secret` takes effect at once (ruled, plan task 17). While another process holds the store's
write lock, the server's connection waits at most 250 ms (14); a `hello` whose secret cannot be
read then is closed with 1013 (try again later) — never taken for a wrong proof, no 4003 and no
alarm — and the page tries again (ruled, plan task 23).

**Encodings.** Keys (the secret, a launch token) are 32 raw bytes, written as base64url without
padding wherever they are stored or printed; HMAC and HKDF take the raw bytes. Nonces, proofs and
`key` are base64url without padding in the messages. The HMAC input is the UTF-8 of the text
shown, with `sN` and `cN` in their base64url form and `\n` a single line feed. The HKDF salt is the
UTF-8 of `sN` and `cN` (base64url) concatenated, the info is the UTF-8 of `skydeck key 1`, the
output 32 bytes. `key` is the 12-byte IV, then the ciphertext, then the 16-byte tag — what Web
Crypto's `unwrapKey` with AES-GCM takes after the IV is split off. One vector, computed with
Node.js's `crypto`, is pinned by a server test (17.3) and by a page test that runs the same inputs
through Web Crypto (17.4); the same flow — HKDF, `unwrapKey` into a non-extractable HMAC key, a
proof equal to Node.js's — was run in headless Chromium in review (section 21):

| Input | Value |
|---|---|
| secret | bytes `0x00`…`0x1f`: `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` |
| launch token | bytes `0x20`…`0x3f`: `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8` |
| `sN`, `cN` | bytes `0x40`…`0x5f` and `0x60`…`0x7f`: `QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8`, `YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8` |
| origin, IV | `http://127.0.0.1:47613`; bytes `0x80`…`0x8b` |
| `pP`, `pS` in mode `key` | `I2kfIbEbNedSunJ5O-iFTu1xMaucB1TaOXfPgule6rE`, `PCSrj1ouBWLrjthlVwJEhf7wtjQVvd99qg30B5MzN9k` |
| `pP`, `pS` in mode `launch` | `Cr2pbVrX3H03jJHuH4XHBB-cqsOPpzQCkE0JpYYrpm4`, `JM1U0NnH9f1h_LMtP3J9aBD6GWG7dyJX0cRhjXBHCUw` |
| `key` | `gIGCg4SFhoeIiYqL8-uwKEfl-QQONxqvTE8BdkWwIYHdwQkWN6_IJiXkHtLOZknj-CrYjV5peDDAyWDo` |

**The alarm.** A second proof for a used token means that somebody else had the token, and so,
probably, now has the secret (15.2). The server then records the time in `kv` `window_alarm` —
once: the time of the first such proof stays until `--new-secret` clears it, and a token presented
again and again is recorded at its first reuse only, so a loop of proofs costs no store write; the
verdict (4004) stands even when the record cannot be written, which the server logs. The
page that got 4004 says `this window's launch address was used by another program, which may now
have skydeck's key; run skydeck window --new-secret`; a `skydeck window` still waiting for that
token (it asks the server, `GET /token/<id>`, 8.3) says the same and exits 1; and `doctor` reports
a `problem` until `--new-secret` clears the alarm (16.3).

A close with 4003 means that the page's key is not valid any more (after `--new-secret`), or that
its launch token was used already or has expired; the page says `this window's key is not valid;
run skydeck window again`.

**Where the page keeps its key.** At load, before it opens any connection, the page reads the
address's fragment (`#t=<launch token>`), keeps the token in memory, and removes it from the
address with `history.replaceState` (the address becomes `/`). After the first `welcome` it turns
`key` into a Web Crypto HMAC key with `unwrapKey` (AES-GCM, under the key derived from the token),
marked **not extractable**, stores that key object in the origin's IndexedDB, and forgets the token.
A page presents its token **once**: whatever happens after its one `hello` with that token — a
close, a timeout, a wrong server proof — it never sends a proof with that token again, and, unless
it received a key, says `run skydeck window again` instead of retrying (a second presentation by
the page itself would raise a false alarm); it does not fall back to a stored key either. Two ends
are no presentation (ruled, plan task 26): a connection that ended before the page sent its `hello`
(a 503 at the upgrade, a refused connection, a close before the challenge), and a close 1013 after
it — the server reads the secret before it looks at any token ("Reading the secret" above), so the
token still waits and no alarm can follow. After either the page tries again with the token, on
6.3's schedule; an expired or dropped token then answers 4003, which ends it.
A key that IndexedDB does not take lives in the page's memory only: the window works and says
`this window's key could not be stored: the window works until it is reloaded or closed, and its
reload keys do not reload it; run skydeck window again for a window that keeps its key`, and its
reload keys do nothing (review 2 of plan task 26).
The secret's bytes never reach the page's code: the page can make proofs with the key but cannot
read it, and neither can any other page at that origin. A reload, and a window opened later in the
same profile, find the key there. A page that has neither a token nor a stored key says `this
window has no key; run skydeck window (or skydeck window --print-url for a browser tab)`.

Page and server come from one checkout, so "same asset version" means "same protocol"; the
protocol number exists for the reload decision and for tests. Follow-up F9 (2026-11-17) followed
this rule: it changed the list message (8.2.3: a row's `stack` lost two fields, a section gained
`closedStacks`) and took no step of the protocol number; a page of the old build meets another
asset version and reloads itself (`test-page/shell.test.ts`, "a server with another asset version
→ the page reloads itself, once").

#### 8.2.3 Messages

JSON text frames, each with a type `t`. The fields of every message are defined once, as the
TypeScript types of `src/window/protocol.ts` (4.3), and pinned by the protocol tests (17.3); the
tables below name them. Times are nanoseconds as decimal strings. Every string the
server sends that comes from a transcript, a live-session file, GitHub, the user or the store has
passed the sanitiser (design 7.4), except a note's text (multi-line, sanitised line by line by the
page's renderer, which writes it as text, never as markup) and, from stage D, `selected.note`: the
note exactly as stored, so that an edit starts from it and its save names it as `base` (12.5); the
page puts it only into a text box's value, never into markup. From follow-up F15 `favourites` too:
each as stored, so that a chip puts it into the flags field and a removal names it (12.6); the page
sanitises it for show and writes it only as text or into the field's value.

Page → server (after `hello` and `start`, 8.2.2):

| `t` | Fields | Effect |
|---|---|---|
| `ping` | `n` | `pong` with the same `n`, `bootId`, `serverId`. |
| `view` | `filter`, `unfolded`, `showDone`, `selected` (null while the page's selection is a closed block's caption, 12.2: from follow-up F9 no session is selected then); from stage E, each optional (a page before stage E sends none): `chips` (12.8's Running, Open PR and Has note as `running`, `open-pr`, `note`, each once; Show done is `showDone`), `closed` (the blocks the user closed, 12.2: at most 64 entries, each exactly a `section` — `open`, `week` or `earlier` — and a `group`, a text, each section and group once; absent: no block closed. It replaced stage E's `opened` on 2026-11-16, follow-up F3: a view that still names `opened` is refused as any view with a field it does not know, and the server closes the page's connection, 1008 `message refused: view: unknown field`; the page and the server are one build, 8.2.2), `switcher` (the quick switcher's text while it is shown, else null; each change of it is a `view`) | The page's view state; the server answers with `list` at once and keeps sending `list` when it changes (12). |
| `focus` | `focused`, `selected` (null then too), `area` (`cols`, `rows`: what the terminal area holds at the page's font) | Window focus, selection and terminal area, for seen (12.4), notifications (13), the size owner and the first size of a terminal the command line or a restore opens (8.2.6). Sent on every change and after `start`. |
| `attach` | `term`, `cols`, `rows` | Start a terminal stream (8.2.4). The page's size is a proposal (8.2.6). |
| `detach` | `term` | Stop it. |
| `input` | `term`, `data` | Typed text (UTF-8) for the terminal; `binary: true` when `data` is a byte string from xterm.js's binary channel (mouse reports). Makes this page the size owner. |
| `resize` | `term`, `cols`, `rows` | The page's fitted size (8.2.6). |
| `theme` | `theme` (`fg`, `bg`: each a text, checked exactly as `start.theme`, 8.2.2) | From follow-up F13: the page's colours changed while it is open — a click on the title bar's theme switch, the same choice made in another window of the profile, or the system's scheme while the page follows it (12.1). The server keeps them for the page's next `focus`, and answers OSC 10 and 11 from them at once while the page is the one that had focus last (7.2). |
| `act` | `id`, `kind`, and the fields of the next table | An action (11, 12). The server answers `result` with the same `id`. |

| `act` kind | Fields | Effect |
|---|---|---|
| `resume` | `sessionId`, `cols`, `rows` | 11.3; the size is the new terminal's first size (8.2.6). |
| `new` | `dir`, `label`, `group`, `flags` (the text as typed), `cols`, `rows` | 11.3; the server splits `flags` by 12.6's rule and checks them as `skydeck new` does (design 7.7). |
| `restore` | `sessionIds` (1 to 1,000 distinct session ids) | 12.7, 11.3. The result comes at once: `ok` with no lines and no `sessionId` once the run has begun (a restore selects nothing, 12.7; its lines come as `notice restore-progress`), else the refusal as the result's error — `a restore is already running; wait until it has finished`, after the server's stop has begun `the window's server is stopping`, or the line of a run that cannot begin (plan C6). |
| `label`, `group` | `sessionId`, `text` (empty clears) | 12.5. |
| `note` | `sessionId`, `text`, `base` (the note the edit started from) | 12.5. |
| `done`, `undone` | `sessionId` | 12.5, 12.10. |
| `pr-add`, `pr-rm` | `sessionId`, `url` | 12.5. |
| `pr-refresh` | `sessionId` | An explicit refresh of that session's pull requests (design 7.3). |
| `ticket` | `sessionId`, `text` (a link or a key as typed; empty removes the ticket) | 12.5 (follow-up F18): the server reads `text` by design 7.1's rule (`readTicket`) and stores the address, replacing the ticket before; a refusal's words are the result's error, nothing stored. `text` is held to the URL limit, so that a link of 2,048 characters is sent whole. Every page's `list` follows. |
| `ticket-refresh` | `sessionId` | 12.5 (follow-up F19): reads the status of the session's ticket — the one set, else the group's link — now, whatever its age, in the background, answered `ok` at once; every page's `list` follows when the result is saved. Refused with `no status is read for this session's ticket` when no provider takes its address, or the session has none. `ticket` also asks for the read when a provider takes the new address. |
| `close-terminal` | `term` | Forgets an ended or not-started terminal's last screen (7.8). Refused for a terminal whose program runs (principle 6). |
| `end-session` | `term`, `sessionId` | Follow-up F30, 12.10: the dialog's `End session and mark done`. Refused, nothing done, unless the window's terminal `term` shows the session, its program runs and its keeper can be ended now (version 3, connected), the store knows the session, it is not marked done, it runs and a holder of it belongs to that terminal (7.5); and while a request for the same terminal waits (`skydeck is ending this session already`: no second signal). Then the session is marked done (as `done`), every page's list follows, and the keeper is sent `E`. The result comes when the program has ended — `ok` with `ended` true; the server records the end (12.10) and closes the terminal as `close-terminal` does — or 10 seconds later, `ok` with `ended` false: the session stays marked done and running, and the server goes on following that terminal until its program exits, then records the end and closes it the same way (it stops when the terminal is lost or forgotten). Once that result came, a new request for the terminal (the session undone and asked again) is taken as the first was. |
| `open-link` | `url` | 9.6. |
| `dismiss-restore` | `bootId` (the earlier boot the banner offers, a lower-case UUID: the form of `/proc/sys/kernel/random/boot_id`) | 12.7. |
| `favourite-add` | `text` (the flags field's whole text), and optional `at` (a whole number from 0 to 11: Undo's old place) | 12.6 (follow-up F15): the text, trimmed, becomes a favourite — last, or at place `at` (past the end: last) — unless 12.6's rule refuses it; the refusal's words are the result's error, nothing saved. Every page's `list` follows. |
| `favourite-remove` | `text` (a favourite's text as `list.favourites` carries it) | 12.6: the favourite with exactly that text goes; `ok` also when there is none (sent twice, or from two windows), and then nothing is written. |

An unknown kind or field is refused, and so is a string over its limit (in UTF-8 bytes: paths and
URLs 4,096 — a `ticket`'s `text` too —, `input.data` 64 KiB, a note's `text` and `base` 64 KiB
each, other text 1,024; the action of 9.6 then opens a URL only up to 2,048 characters), a size that is not a whole number
from 1 to 65,535, a session id that does not pass the session-id rule (a lower-case UUID, 4.3) —
in a `restore` each of its ids, which must also be distinct, at least one and at most 1,000 — or
a `dismiss-restore` boot id that is not a lower-case UUID (stage C, plan C 2.2), or a
`favourite-add` whose `at` is not a whole number from 0 to 11 (follow-up F15). A note may be any
length (design 7.1), so 1,024 bytes would refuse most notes;
at 65,536 bytes each the largest note `act`, every character escaped by JSON (six bytes for one),
stays under the 1 MiB a page's message may hold (8.2.1). A stored note longer than that is not
sent (`selected.note` null, `noteTooLong`) and the window does not edit it: it says `this note is
longer than the window edits; use skydeck note <short id>`; the page refuses a longer text before
sending it, since the server would close the connection for the message (stage D, plan D5). No action carries a program or an argument list to run (8.3):
`resume` names a session, and `new`'s directory, label, group and `claude` flags are the only
fields that become part of a launch, checked as `skydeck new` checks them. The actions check every
action again where they act on it, with the same parser — its kind, the types and limits of its
fields, well-formed text — and refuse one that does not pass ("skydeck cannot do that action", one
log line with the parser's kind; ruled by the plan owner, review of plan task 32). A refusal's
message is sanitised line by line, as the command line prints it: it can quote what the page sent.

Server → page:

| `t` | Fields |
|---|---|
| `challenge`, `welcome` | 8.2.2. |
| `pong` | `n`, `bootId`, `serverId`. |
| `list` | The view model (12), sent whole (about 50 KB for 100 sessions; from stage D up to 64 KiB more for the selected session's note, which JSON may escape to six times as many bytes, within 8.2.8's rule) when it changed, at most once a second: `counts`; `needYou` (`count`: the listed rows that need you, 12.4, whatever the filter or the fold, each counted in none of `counts`; `order`: the ids of the rows this page shows that need you — from follow-up F3 also those a closed block hides (12.2; since follow-up F9 its first session too, which the card no longer draws), so that `needYou` is the same whether a block is open or closed —, in Ctrl+Shift+J's order; stage B, 12.1); `sections` (`open`, `week`, `earlier`, each with `folded`, its time span, its `rows` and, from follow-up F9, `closedStacks`: its closed blocks in the section's order — a closed block has no row in `rows`, its first neither —, `[]` while the section is folded or the view is filtering and when it has none — always sent (ruled on review 1 of F9: no reader falls back for a list without it) —, each with `group`, `size` — its rows —, `needYou` — how many of its rows need you (12.4), all of them hidden —, `head`, the session id of its first row in the section's order, which → and Enter on its caption open and select, and `at`, its place: the caption is drawn right before `rows[at]` of the section, and after its last row when `at` is `rows.length`, captions at one place coming in the array's order); `doneHidden`; `banner` (12.7, the view model's, stage C: null while nothing is offered and no restore runs; else `bootId`, the latest earlier boot whose sessions are offered — what `dismiss-restore` names — and `lastActivityNs`, that boot's last event, both null only while a restore runs and nothing is offered; `entries`, design 7.8's default set in list order, each with `sessionId`, `shortId`, `title`, `endedAtNs` (null: no exit recorded), `wasWorking` and `preselected`; `shown`, false once the user said "Not now" for that boot, when the page shows no banner; `running`, true while a restore runs in the server, whoever asked for it); `terminals` (`id`, `slot`, `sessionId`, `state`, `notReported` (7.5's "started, not reported"), `cols`, `rows`, whether this page owns the size, and from stage D `openedNs`, when the window opened it: the header's "opened <time>", 12.5); `selected`: for the session the page's `view` names, what the resume card shows (12.6: the exact command, the flags that will not be passed on, how it ended, expiring or expired), from follow-up F16 `launchFlags`, the recorded flags a resume passes on again with their values, in the order recorded, each sanitised (`[]` without a recorded launch; the header's "started with", 12.5), and, from stage D, what the header and its dialogs need (12.5: `note`, the note exactly as stored while it holds at most 65,536 bytes of UTF-8, else null, with `noteTooLong` when it is longer; `ticketUrl`, the ticket address of the group, or null; from follow-up F18 `ticket`, the ticket set on the session — `url`, its address as stored, and `text`, its short name, sanitised — or null, and `ticketKeys`, true while `ticketUrl` is configured, so that a bare key sets a ticket; from follow-up F19 `ticketStatus`, null while no provider takes the address of the session's ticket — the one set, else its group's link (12.5) —, else `{ url, name, stored, status, category, okAtNs, triedAtNs, error }`: that address, the ticket's short name, whether it is the one set (false for the group's link), the last status read and its category (null until a read succeeded, and for no category), the time of the last read that succeeded and of the last attempt (nanosecond text, null when none) and the last attempt's failure in words (null after a success); absent, as in a list of a server before F19, is none), or null; `dirs`: the known project directories, most recent first (12.6's new form); from follow-up F15 `favourites`: the new form's favourite flags, each as stored, in their order (12.6, 10.2; at most 12 of at most 200 characters, none holding a control character: about 2.4 KB, at most about 9.4 KiB when every character takes four bytes; absent, as in a list of a server before F15, is none); from stage E, `filtering` (the view's words or chips are set, 12.8: the page draws its empty line and folds nothing), `switcher` (while `view.switcher` is a string, else null, 12.8: `query`, the text it answers as the page sent it; `command`, true when that text's first character is `>`, a command that lists no session; `items`, at most 50, each with its `rank` — `need`, `open`, `not-running` or `done` —, its `row` as the sections carry it without a stack, `found`, where the words are in its title, and `hiddenBy`, what this page's list would change to show it — `filter`, `done`, `folded`, in that order, none when the list shows it; `more`, how many matching sessions were left out; `restore`, stage C's offer, 12.7, null from the view model) and `selectedRow` (12.9: the row of the session `view.selected` names, as the sections would carry it without a stack, also when they leave it out — a filter, the chips, done sessions hidden, a folded Earlier; null when the view selects none or a session the view model does not list even with done ones shown; the page uses it only while its id is the page's own selection, since a list can answer the selection before). A row carries the list row's display fields (design 7.4: id, short id, title and its source, group and its source, state and detail, times, directory, marks, note mark and the note's first three lines, done, pull requests — each with its level, its error and, from stage D, `okAtNs`, its last successful read, for "checked 4m ago" and "last read 3h ago" —, and the window's chip of 12.3: `level`, `open` and `merged`, not design 7.3's chip of `ls`; from follow-up F19 `ticketStatus`, `{ name, status, category }` — the ticket's short name, the status' text (at most 40 characters) and its category, one of the six words or null — while the session's ticket has a known status (12.2), else null: 20 bytes a row without (`,"ticketStatus":null`), 76 with `{"name":"ABC-123","status":"In Progress","category":"doing"}`, at most about 105 plus the name's length with a 40-character status; absent, as in a list of a server before F19, is none) and the window's own: `terminal`, `slot`, `elsewhere` (running in another terminal), `attention` (null, or reason, detail and since), `stack` (null, or from stage E the block the row is drawn in — the protocol calls a block a stack —, 12.2: `group`, `size` — its rows, the first included —, `role` — `head` for the first row, `member` for the others —, and `head`, the first row's session id; since follow-up F9 only a row of an OPEN block has one, and it lost `open` and F3's `hiddenNeedYou` — the page draws every row of a card alike, and a closed block's rows are not carried, its count is the section's `closedStacks`). |
| `snap` | `term`, `ch` (the channel number for its output), `cols`, `rows`, `data` (the snapshot). |
| `size` | `term`, `cols`, `rows`, `owner` (this page or another): the terminal's size changed, in stream order. |
| `exit` | `term`, `code`, `signal`, `atNs`, `lost`, `notStarted` (null, or the reason the program was never started, 8.1). |
| `result` | `id`, `ok`, `lines` (what the command line would print, design 7.6), `error`, `sessionId` (the session a successful `resume` or `new` started, so that the page can select its row, 11.3; else null). |
| `notify` | `sessionId`, `title` (the row's, sanitised), `reason` (the kind: `asks`, `ended` or `finished`, 12.4; the page writes the words), `detail` (the row's attention detail, else null) (13). |
| `notice` | `kind` (`keepalive-lost`, `keepalive-back`, `gap`, `newer-keeper`, `input-full`, `tick-failed`, `restore-progress`), `term` (the terminal a `gap`, `newer-keeper` or `input-full` notice concerns; null for the others), `text`. `tick-failed` ("skydeck could not refresh the list: <reason>; it tries again") is sent once when a tick fails (10.1) and not again until a tick has succeeded. `restore-progress`: one report line of a restore, sanitised, to every page, whoever asked for the restore (11.3, 12.7; stage C). |
| `bye` | `reason` (5.5). |

Output is sent in binary frames: one byte 1, the channel number as a 4-byte big-endian integer,
then the bytes of one record. The channel number is the one `snap` gave; a page attached to
several terminals tells their output apart by it.

#### 8.2.4 Snapshot and stream

On `attach` the server takes a snapshot at the current point of the terminal's chain (7.2), sends
`snap`, and from then on forwards every record after that point to the page: output as binary
frames, resizes as `size`. The page resets its xterm.js to the snapshot's size, writes the
snapshot, then the stream. The snapshot is taken at a point where every earlier record has been
applied, so nothing is lost or doubled.

#### 8.2.5 Reconnect

A page that reconnects (6.3) goes through the whole handshake again — `challenge`, `hello`,
`welcome`, `start` (8.2.2) — in mode `key`, then sends its `view` and `focus` and attaches the
terminals it had attached; each starts over with a fresh `snap`. There is no resume from a position: a snapshot is cheap enough
(7.3) and always right.

#### 8.2.6 Size

A terminal has one size, the pty's. The server remembers, per terminal, the size each attached
page last proposed (`attach`, `resize`). The rules:

- **First size.** A terminal opened from a page (`act resume`, `act new`) starts at the size that
  page sent with the action: its terminal area less the right side's header, as shown or as last
  shown. A window that has shown no header yet sends its area whole, and that first terminal is
  resized once when it is shown (a known limit; ruled, Z1 of plan task 26). One opened by the command line or by a restore starts at the `area`
  the page that had focus last reported in `focus` (8.2.3), or 120 × 40 when no page is connected.
- **Owner.** The size owner is the page that last sent `input` for the terminal; before any input,
  the first page that attached. A page that attaches to a terminal without an owner becomes it.
- **Changes.** When a page becomes the owner, its remembered proposal applies at once; afterwards
  each `resize` of the owner applies, and those of other pages are only remembered. When the owner
  detaches or disconnects, ownership passes to the attached page that sent input last, else the one
  that attached last, and its remembered proposal applies; with no page attached the size stays.
- **Applying.** The server sends `Z` to the keeper, and when the `R` record comes back it applies
  it to the screen side and sends `size` to every attached page. A page sets its xterm.js size only
  from `snap` and `size` — never from its own fitting — so page and screen side reflow at the same
  point of the stream. A page that is not the owner shows the terminal at the owner's size (cut off
  or with a margin) and a hint "sized by another window"; typing makes it the owner (and so does a
  focus change while the program has focus reporting on, 9.2). A proposed size is first clamped
  to at most 1,000 columns and 500 rows (a wider one is not an error): 65,535 columns would make
  the screen side allocate gigabytes of scrollback (ruled, plan task 12's review). The page
  computes its proposal itself (not with the fit addon): the most columns and rows whose screen
  fits the terminal's area, the screen being cell × count rounded to whole pixels as xterm.js
  6.0.0 rounds it, and the room the addon gave its scroll bar (14 px) and the margin the page
  keeps around the terminal's text (12.6) counted out — read at every count from the element the
  style sheet gives it to, as lengths, so that the margin drawn and the margin counted cannot
  drift apart (whatever unit or element sets it); the answer does not depend on the terminal's
  current size. A first size the page asks for (an act's, `focus.area`) is counted by the same
  rule for the terminal area's box as it is laid out, not rounded to whole pixels: at a display
  scale of 125 % that box is a fraction, and the rounded one could hold one column more than the
  view proposes once the terminal is there (F2, review 2). The fit addon's does (it
  divides by the cell of the current size), so at some widths no size proposes itself — 104
  columns propose 103 and 103 propose 104 — and a terminal shown there was resized every second
  (ruled by the plan owner, M4 of plan task 28's review). The proposal is a function of the box,
  the pixel ratio and the cell only (the terminal takes the page's font size first, so its screen
  and its proposal are measured at the same font).

The page's xterm.js keeps 5,000 lines of scrollback, as the screen side does (7.2), so that both
reflow alike and find (9.7) sees what the snapshot holds.

#### 8.2.7 Several windows

Any number of pages may attach to one terminal; they share its ordered stream. Input from any of
them goes to the program in the order the server receives it. `list` goes to every page; each
page's `view` state is its own. Notifications go to one page only (13).

Attention (12.4, 13; stage B's plan, B20) is the server's, so it is the same in every window: the
marks, the title bar's count and the window title — but for what a window lists at all: a done
session that has stopped counts only in a window that shows done sessions (`showDone`, 12.8); and
`needYou.order` follows each window's own filter and fold. A session seen in any window that has focus is seen for all of them, and a typing
from any window counts. A notification goes to the one window that had focus last, and only while
no window has it.

#### 8.2.8 Backpressure

The server never pauses a program; it may stop reading a keeper's connection (7.3, Reading), which
only fills the keeper's send queue until the keeper closes that connection. When a record for a
page (output, a size, an exit) or its `list` finds more than 1 MiB queued on the page's socket,
the server stops forwarding records to that page, marks the terminals whose records it drops
**behind**, and holds the page's `list`. A `snap`'s own bytes do not count toward the 1 MiB: a
large screen is not a slow page, and counting it would make the fresh snap put the page behind
again. When the queue has drained (Node.js's `drain`: nothing is left queued, so below 64 KiB),
the server sends the page's current `list` at once and attaches each terminal that is behind
again: its fresh `snap` follows when the hub gives it, then the state the terminal is in (its
`exit`, a `gap` or `newer-keeper` notice), and records are forwarded again; a terminal that lost
nothing keeps its stream. With more than 64 MiB queued, not counting what is still queued of the
latest `snap`, the server drops the connection, and the page reconnects (6.3, 8.2.5). The latest
snap is left out because one screen can be that large: 5,000 lines of image-like output (each
cell its own colours) give a snap of about 40 MiB at 200 columns and 60 MiB at 300 (measured
with the screen side, 7.2), and counting it would make such a screen a reconnect loop; a page
that lets snap after snap pile up without reading is still cut. The snaps of several terminals
attached at the same moment count, all but the latest, so a page that attached about nine screens
of 7.5 MiB, or three of the image-like ones of 40–60 MiB, at once would be cut: the page therefore
attaches its visible terminal first and the others one at a time, each after the previous `snap`
has arrived (a named limit). These rules
were ruled in plan task 17. A page attaches only to terminals it shows or has shown recently
(12.6), so a hidden terminal costs nothing.

### 8.3 Command line and server

The command line talks to the server over `<runtimeDir>/server.sock`, a unix socket of mode 600 in
a directory of mode 700: only the user's own processes can connect, and no secret is needed or
sent. HTTP/1.1 over that socket, JSON bodies with fixed fields (an unknown field is 400).

**No request carries a program or an argument list to run.** The server prepares every launch
itself, through the guard and the lock (11.1): for a resume from a session id alone; for a new
session from a directory, a label, a group and `claude` flags, the only request fields that become
part of a launch, which the server checks as `skydeck new` checks them (design 7.7: the directory
absolute and existing, no flag that picks a session or names it). The program is always
`claudeCommand`, and the argument list is always built by `buildResumeCommand` or
`buildNewCommand`.

| Request | Answer |
|---|---|
| `GET /ping` | `{ serverId, bootId, build, protocol, pid, port, checkout }` (`checkout`: the checkout the server runs from, which 5.1 compares). |
| `GET /status` | `{ starting, pages, terminals: [{ id, slot, state, sessionId, pid }], keepAlive, python, build, checkout, startedAtNs, envOrigin, windowExpectedMs }` (`envOrigin`: where the server's environment came from and when, 5.2; `starting`: true while the server's start is not done and a page's upgrade is answered 503 (8.2.1) — a server answers before then, 5.2; a server of an older build sends none, which means false; ruled by the plan owner, follow-up "server-findable"; `windowExpectedMs`: the milliseconds left while the server expects a window back (5.1) — 7,000 while its start is not done, then counting down from its end —, else null; a server of an older build sends none, which means null; plan C20), for `skydeck window` and `doctor`. |
| `POST /resume` | `{ sessionId }` (a session id) → `prepareResumeById` and the window terminal (11.2) → `{ code, lines, sessionId }`: the exit code `skydeck resume` would end with and the lines it prints on stderr (design 7.6), refusals included, each as printed (`skydeck: …`); `sessionId`, the session it started, else null. |
| `POST /new` | `{ dir, label, group, flags }` (`label` and `group` null when the option was not given, and passed to `prepareNew` as the command passes them; `flags` the words after `--`, an array of strings, not split again) → `prepareNew` with `dir` (absolute, an existing directory) and the refusals of design 7.7 → `{ code, lines, sessionId }`. |
| `POST /restore` | `{ sessionIds, all }` (the ids the user selected, 1 to 1,000; `all` as `--all`) → 11.4. The answer (200, chunked) is a stream of JSON lines: `{ "line": … }` per report line of the run, `{ "line": "waiting for <n> sessions" }` (`waiting for 1 session` for one) after 10 s without one, and last `{ "outcome": { code, started, timedOut, failed, notStarted } }`. A request refused because a restore runs already is its one line, then an outcome with code 1. A run that cannot begin (the boot id cannot be read, the store is busy) is its line, `restore finished: nothing was started`, then an outcome with code 1. |
| `POST /token` | `{ seconds }` (30 for a window, 600 for `--print-url`) → `{ id, token, expiresAtNs }`: a launch token, minted and held in memory (8.2.2). |
| `GET /token/<id>` | `{ state }`: `waiting`, `used`, `reused` (a second proof came: the alarm, 8.2.2), `expired` or `dropped`. |
| `POST /token/drop` | `{ id }` → `{ ok }`: the token is given up; a later proof with it fails with 4003 (or 4004 when it had been used). |
| `POST /shutdown` | `{ ok: true }`, then 5.5. |

**Stage C's three routes** (plan C2–C5). Their bodies have fixed fields: every session id passes the
session-id rule (a lower-case UUID, 4.3), a restore's are distinct; strings are well formed; `dir`
holds at most 4,096 bytes and no NUL, `label` and `group` at most 1,024, `flags` at most 1,000
words, none with a NUL (the body's 64 KiB bounds the rest); an unknown or missing field is 400.
While the server starts (a page's upgrade is answered 503, 8.2.1: before its keepers are found it
does not know its terminals, so the "already open" rule of 11.1 could not see one) they answer 503
`{ error: 'starting' }`, and the command asks again every 500 ms within its 30 s; once its stop has
begun, 503 `{ error: 'stopping' }`, which the command reports. The `code` of `POST /resume` and
`/new` is the exit code the command would end with: 0 when it started; 1 for a failed launch, a busy
store (`skydeck: skydeck's database is busy; try again`) or a failure inside the server (`skydeck:
the window's server could not start it (<kind>)`, logged by kind); 2 for `prepareNew`'s refusals; 3
for a reference that names no session; 4 for the guard, the lock and the window's own "this session
is already open in the window" (11.1) — a command must print something, so none of these is a 500.
The `code` of a restore's outcome is design 7.8's: 5 when the run was stopped before it finished
(the memory check, the server's stop, its asker's connection closing, a batch in which no session
started while entries were left), else 1 when any selected session failed, was no longer offered or
timed out, else 0. A restore asked for here stops when the asker's connection closes before the
outcome: the sessions already opened go on, the rest are not started (11.4).

A refused request answers `{ error: <kind> }`: 404 for an unknown route (a server of a build before
stage C answers `/resume`, `/new` and `/restore` so, whatever text the body holds), 400 for a bad
body, 413 for a body over 64 KiB, which is not read on; `GET /token/<id>` is 404 for a token the
server does not know. When answering a request fails inside the server (`ping`, `status`, the tokens
or a launch throw or reject), the answer is 500 `{ error: 'failed' }` — a restore whose answer has
begun ends without an outcome instead — the log names the error and its code, never its message
(5.2), and the server goes on; a failure while stopping is the server's uncaught error. On the
command line, `ping` reports a socket that refuses or is missing as refused, and no answer in time —
or a full queue of connections, of a server that lives — as not answering (5.1); `POST /token/drop`
for a token the server does not know is no error.

## 9. Typing into and reading from a terminal

### 9.1 Keys the page maps

xterm.js 6.0.0 turns key presses into bytes, and cancels the browser's action for a key it sends.
Two facts of its keyboard code shape this table (verified in its source, section 21): it sends
**nothing** for Ctrl+Shift with a letter (it builds the control byte only without Shift) and then
cancels nothing, so the browser's default happens; and for a plain Ctrl+V it sends `\x16` **and
cancels the key**, so the browser would never paste. So the custom key handler
(`attachCustomKeyEventHandler`) returns `false` — xterm.js then neither sends nor cancels — for
every key in this table, and the page does what the table says:

| Key | The page | Why |
|---|---|---|
| Shift+Enter | sends `\n` and cancels the key | xterm.js 6.0.0 sends `\r` whatever Shift says; Claude Code inserts a newline on Ctrl+J (`\n`) in every terminal without setup (section 21). |
| Ctrl+V | leaves the key to the browser, which pastes; the page takes the paste before xterm.js does (in the capture phase of the terminal's element), cancels the browser's own action, takes every ESC out of the text and hands the rest to xterm.js's paste, which sends it as a bracketed paste (section 21: xterm.js 6.0.0 neither cancels a paste, so the text would stay in its hidden textarea, nor filters it, so a pasted `ESC [ 2 0 1 ~` would end its own bracketed paste) | Pasting text, as in the developer's terminal. No `\x16` is sent (a page test checks it, 17.4). |
| Ctrl+Shift+V | sends `\x16` (a raw Ctrl+V) and cancels the key | Claude Code's own image paste: on WSL it reads the Windows clipboard itself (6.4); the browser's clipboard is not involved. |
| Ctrl+Shift+C | copies the selection to the clipboard and cancels the key | Copy. |
| the window's own chords (12.9) | acts on them and cancels the key | xterm.js would send nothing for them anyway, so the window takes nothing from Claude Code. |
| Alt+F4 | nothing: neither sent nor cancelled | The window closes with it (12.9). |

Every other key goes to xterm.js as it is: the bytes it sends, and the cancelling it does, are
xterm.js's own. A Ctrl+Shift chord that the window does not use keeps Edge's default in an app
window (12.9). Keys are matched as section 12.9 says. AltGr and dead keys reach xterm.js unchanged
(section 21; check W8). No kitty keyboard protocol and no `modifyOtherKeys`: xterm.js 6.0.0 has
neither; 6.1 is re-evaluated when released (20).

### 9.2 Focus and mouse

Focus reports (mode 1004) and mouse reports are what the page's xterm.js produces, sent as
`input`. They are the user's own events, not query answers (9.3): xterm.js 6.0.0 also reports
the focus by itself the moment it parses `CSI ? 1004 h` (from the program or a snapshot), and
the page drops that report. With focus reporting on, a real focus change is `input`, so a window
becomes the size owner (8.2.6) by being clicked, not only by being typed in (ruled for stage A,
plan task 28's review).

### 9.3 Terminal queries

The program's queries are answered once, by the screen side (7.2). The page's xterm.js parses the
same stream and would answer them too, so the page registers parser handlers that swallow, without
answering: DA1, DA2, DSR and CPR, DECRQM, DECRQSS, XTVERSION, the window reports of `CSI t`, and
OSC 4, 10, 11 and 12 with `?`. A test checks that the page's terminal sends nothing for each of
them (17.4).

XTVERSION is not answered in the first version. Claude Code recognises xterm.js from a reply that
starts with `xterm.js` and then changes wheel scrolling, glyph-atlas resets and link clicks
(section 21); an honest answer `xterm.js(6.0.0)` would turn that on. Whether that helps is check
W5; the answer is a one-line change in the screen side.

The colours OSC 10 and 11 are answered with are the page's (7.2). From follow-up F13 a program that
asks after a click on the title bar's theme switch (12.1), or after a change of the system's scheme,
is told the colours its terminal has then. A program that asked before keeps what it was told until
it asks again: nothing tells a running program that the colours changed — no notification of a
theme change is sent to programs, which is not part of F13. Claude Code's `/theme` has an "Auto
(match terminal)" theme; its documentation (read 2026-11-18) says only "Selecting the auto option
detects your terminal's light or dark background, so the theme follows OS appearance changes
whenever your terminal does". How and when it detects — whether through OSC 11, at a session's
start or again while it runs — is not documented; W5 and W34 write down what is seen.

### 9.4 Widths

Claude Code measures text width with its runtime's `stringWidth`, ambiguous characters narrow
(section 21). The page and the screen side both use `@xterm/addon-unicode-graphemes` 0.4.0, which
gives emoji with VS16, ZWJ sequences and skin tones two columns; without a width addon 🙂 is one
column and the screen drifts. The addon is marked experimental by xterm.js; check W10 compares it
with Claude Code's own layout, and `addon-unicode11` 0.9.0 is the fallback.

### 9.5 Clipboard

A program may write the clipboard (OSC 52 with data): the page handles that with its own
write-only handler (`navigator.clipboard.writeText`), not `addon-clipboard`, and only for the
terminal that is shown in a focused window, and only up to 1 MiB of text — the up to eight hidden
terminals a page keeps attached (12.6) cannot replace the clipboard behind the user's back. A
request to read the clipboard (OSC 52 with `?`) is never answered (design 13: programs in a
terminal can write to the clipboard but not read it).

### 9.6 Links

Ctrl+click on a URL in a terminal (an OSC 8 link, or plain text that looks like `http://` or
`https://` followed by URL characters) and a click on a pull-request link in the list or header send
`act open-link` with the URL. An OSC 8 link's visible text can differ from where it leads, so for
one whose text is not its URL the page first shows the target and opens it only on a second click.
The server opens a URL only when it is at most 2,048 characters, parses as a URL with scheme `http`
or `https`, and is still at most 2,048 characters once the WHATWG URL parser has re-serialised it
(so it cannot start with `-`; percent-encoding can make it several times longer, and the
re-serialised URL is what the Windows program gets), and holds no `"` and no backslash: it becomes
one argument of a Windows program, and either can change how that program splits its command line.
Ruled by the lead: the server opens it in the user's
**Windows default browser**, where they are logged in, by running
`/mnt/c/Windows/System32/rundll32.exe` with exactly two arguments, `url.dll,FileProtocolHandler` and
the re-serialised URL (`explorer.exe <url>` is not used). That entry point opens what it is given as
the Windows shell would, a program or a `file:` address included, so the `http` and `https` check is
also what keeps a link from starting a program on the Windows side (15.5). `FileProtocolHandler`
takes the rest of the command line as it is, and WSL's interop quotes an argument only when it must,
so the URL must be one unquoted word: the re-serialised URL holds no white space and no control
character, whatever the page sent (and the server refuses one that would hold anything but printable
ASCII, so that this does not rest on the parser alone) — the parser removes tab and line breaks
everywhere and the C0 controls and spaces around the address, percent-encodes every other white
space and control character (and everything beyond ASCII) in the user name, password, path, query
and fragment, and fails a host (also once its escapes are decoded) or a port that would keep one
(IDNA maps most Unicode spaces in a host to a space, and drops U+FEFF and U+200B). With
`window.links` `"edge"` (16.4) it runs `window.edge` with that URL as its only argument instead (no
profile folder): it opens in the user's own Edge profile, not in the window's profile. When the
program cannot be started the action is refused with `the link could not be opened: the default
browser could not be started (window.links "edge" opens links in Edge)`, or, with `"edge"`, with
`the link could not be opened: Edge could not be started`. That covers only a start that fails on
the WSL side (the program is not there, interop is off): once interop has started it, what Windows
does is not seen, so a start that Windows refuses afterwards (privilege management) or a browser
that opens nothing leaves the action done and the key bar empty. The page itself never navigates
away: it cancels drag and drop over the window, which would otherwise open a dropped file in place
of the page. Whether a link opens in the user's default browser, logged in, is check W12.

### 9.7 Find

Ctrl+Shift+F opens a find bar over the terminal (`@xterm/addon-search`): it searches the page's
copy of the scrollback, which after a snapshot is the screen side's (5,000 lines).

## 10. What the server keeps

### 10.1 In memory, and the tick

In memory only:

- the latest rows (design 7.4's list model, through `loadRows`) and each page's view model;
- per terminal: the keeper connection, its `hello`, the screen side, the record number, the last
  park, the expected and the shown session, the slot, the state (starting, running, ended, lost),
  the exit, the attached pages and the size owner;
- per page: the socket, window id, focus, selection, view state, attached terminals, queue size,
  last input time;
- the last status the server saw in each live-session file (10.3);
- a running restore (12.7).

Nothing of a terminal is stored: a server restart rediscovers terminals from
`<runtimeDir>/terms/` and their keepers' `hello`.

The **tick**, every second: read the live-session files (`readLiveFiles`, cheap) for state changes
and turn ends (10.3); check the keep-alive. Every second tick: the refresh every command runs
(design 5.3: ingest, reconcile, transcript scan, lock sweep), the automatic pull-request refresh
(design 7.3) for the sessions the pages list, a round of the tickets' statuses (below, from
follow-up F19), and a reload of the rows when that refresh saved
something, a live file or its trust changed, another process committed to the store
(`Store.dataVersion()`), or a minute passed — the interactive list's rule — or when a row's last
holding that was alive at the last load is gone now (stage B, ruled 2026-11-15): a session's end
event can be ingested before its process exits, `ended-unexpectedly` (design 6.3) and a window end
judged on it (12.4) need that process gone, and an exit after the live file went moves no change
mark, so without it the mark would wait for the minute. A /proc read that fails, or a boot id that
cannot be read, is not taken for gone (design 5.5). The server then sends
`list` to every page whose view model changed. An edit a page made (12.5) does not wait for that:
the server's own writes move no change mark, so after one the server loads the rows again and
sends the lists at once, within the pages' once-a-second rule, and so does a pull-request fetch
of 12.5 that saved something or failed after it may have; a reload that fails is logged by kind
and left to the next refresh (stage D, plan D7). A tick that fails is logged and shown once to the
pages; the next tick tries again. The server's store connection checks the schema version at the
start of every write transaction, and before every write that is a single statement; when the
store is newer than the server knows (a command of an updated checkout migrated it, 16.5), the
write is not made and the server stops (5.5) with `bye "skydeck was updated; run skydeck window"`.
A tick between the migration and the next write therefore writes nothing into the migrated store.

**The tickets' statuses** (follow-up F19, design 7.3), in the same second tick, beside the pull
requests' refresh. The server keeps the sessions the pages listed since its last round and takes
their ticket addresses — each row's `ticketStatus.url`, there only when a provider takes the
address (12.5) —; while no read runs or waits it starts a round: it reads the cached rows again,
keeps the addresses that are due — never tried, or last attempted more than `ticketRefreshMinutes`
ago (10 by default), or, for a status whose category is `done` or `closed`, more than 12 hours ago
— and reads them: the GitHub issues first, in batches of their own through `gh`, then the
configured programs one after the other, at most 5 of them in a round (the rest is due again at the
next one). While a read runs or waits the listed sessions are kept for the next round. A read that
was asked for — a ticket set or changed (`act ticket`), the ticket dialog's ↻ (`act
ticket-refresh`) — does not wait for the tick: it runs in the background at once, whatever the
age, and so that no more than one status program runs in the server at a time, whoever asked, the
reads asked for while one runs wait for it and then run together. Each saved result makes the
server load the rows again and send the lists, as an edit does (within a second). Nothing is read
for a session no page lists, and nothing at all for an address no provider takes. The server reads
`ticketStatus` and `ticketRefreshMinutes` at its start only (16.4); its stop aborts a running read
and saves nothing more of it.

Cost, from step 1's measurements: an idle refresh is about 16 ms at 3,000 recorded sessions and
about 60 ms when 3,000 transcripts are listed; at one every 2 seconds that is under 3% of one core.
A headless terminal with 5,000 lines of scrollback is about 15 MB (measured: 25 MB at 10,000
lines), so ten terminals cost about 200 MB.

### 10.2 In the store

**Migration 2** (lands with stage B, 19):

```sql
CREATE TABLE attention (
  session_id      TEXT PRIMARY KEY,
  turn_ended_seq  INTEGER,  -- order of the latest turn end the server saw (10.3)
  turn_ended_ns   INTEGER,  -- its time, for display only
  seen_seq        INTEGER,  -- order of the latest moment the user saw the session (12.4)
  window_end_seq  INTEGER,  -- order of the latest end of a window terminal holding it, the
  window_end_ns   INTEGER   -- session then being marked ended-unexpectedly (12.4); its time
);
```

**Order is a counter, not a clock.** Whether a turn ended after the user last saw the session is
decided by the `*_seq` columns, never by times: `statusUpdatedAt` is Claude Code's clock and
`seen` would be the server's, and the wall clock of a WSL machine steps back (about 1.8 s every
32 s, design 7.6), so a short turn that ended right after a look could seem to have ended before
it. Each write takes the next value of the `kv` counter `attention_seq` in the same transaction.
The times are kept to show ("finished 2m ago") and for one test of identity: `turn_ended_ns` is
also compared with the time the session's idle status began, and a turn end older than that status
belongs to an earlier run (12.4). Within one run the two are the same value, so no order is ever
read from two clocks.

**The next value** (stage B's plan, B2) is one more than the larger of `attention_seq` and every
`*_seq` stored in `attention`: a counter that is missing, or whose value is not a canonical decimal
whole number below 2^53 (`abc`, `09`, ` 9 `, `1e3`), counts as 0, and after the write it holds the
last value given. So a counter that was deleted, damaged or set back can never make a later
observation look earlier than a `seen`. One write is one transaction, and inside it each session's
observations take their values in the order turn end, window end, seen (B3): a turn that ends while
the user looks at the session is seen after it ended, never "finished".

These are skydeck's own observations, not the user's data (design principle 6); a row is written
the first time one of them is known and never removed.

**Migration 3** (follow-up F18, the ticket of a session, design 7.1 and 12.5):

```sql
ALTER TABLE session_meta ADD COLUMN ticket_url TEXT;  -- F18: the ticket the user set, its address; NULL for none
```

The first `ALTER TABLE`: it adds one nullable column and nothing else, so every row keeps its values
(the column is NULL in each) and a reader of schema 2 still reads `session_meta` (its rows carry one
column more). The column holds the address as `readTicket` gave it (an `http` or `https` link the
window may open, a key already filled into `ticketUrl`), never the text as typed: a later change of
`ticketUrl` moves no stored ticket. Like every migration it runs in one transaction with its `kv`
update, the version read again inside the write lock. **An older skydeck refuses it**: from then on
an older skydeck refuses the database at its open ("written by a newer skydeck", exit 1), a server of
an older checkout still running stops at its next write (10.1's guard), and nothing removes the
column. The way back is the copy the store keeps before a migration (design 9.2, follow-up F21;
install.md, "Going back").

**Migration 4** (follow-up F19, a ticket's status, design 7.3 and 12.5):

```sql
CREATE TABLE ticket_status (
  url          TEXT PRIMARY KEY,  -- a ticket's address (F19), as a session's ticket gives it
  status       TEXT,              -- its status' text; NULL until a read succeeded
  category     TEXT,              -- todo | doing | review | blocked | done | closed; NULL for none
  ok_at_ns     INTEGER,           -- the last read that succeeded
  tried_at_ns  INTEGER NOT NULL,  -- the last attempt
  error        TEXT               -- the last attempt's failure; NULL after a success
);
```

It only adds a table, so every other table keeps its rows as they were and a reader of schema 3
still reads them. A row is made at the first attempt to read an address, and never removed: an
address no session uses any more keeps its row (a few bytes). A read that succeeded sets `status`,
`category`, `ok_at_ns` (equal to `tried_at_ns`) and a NULL `error`; one that failed sets only
`tried_at_ns` and `error`, so that the last status and the time of its read stay. Like every
migration it runs in one transaction with its `kv` update, the version read again inside the write
lock. **An older skydeck refuses it**, as for migration 3: from then on an older skydeck (one of
schema 3, F18's) refuses the database at its open ("written by a newer skydeck … update skydeck",
exit 1), a server of an older checkout still running stops at its next write (10.1's guard), and
nothing removes the table; the way back is the copy kept before the migration (design 9.2,
install.md "Going back").
`test/store/migration-4.test.ts` migrates a filled schema-3 database and compares every value.

`kv` entries (no migration; `kv` is free text):

| Key | Value |
|---|---|
| `window_secret` | The secret (15.2): 32 random bytes, base64url. Created on first need, inside one transaction (only one server runs, 5.2, but `--print-url` and the first server may race). A stored value that is not 32 bytes in canonical base64url is replaced as if absent: it could prove nothing, and a page that held a key from it gets 4003 and asks for a new launch (8.2.2). |
| `window_server` | The lock of the one server (5.2). |
| `window_runtime_dir` | The runtime directory the server uses (4.2); kept while any keeper lives, so that commands and the next server find it; a record whose directory is missing or holds nothing alive is replaced at the next server start. |
| `window_alarm` | The time a used launch token was presented a second time (8.2.2); cleared by `--new-secret`. Launch tokens themselves are never stored. |
| `window_launching` | The lock of the one command that starts Edge (5.1). |
| `attention_seq` | The counter above. |
| `window_restore_dismissed` | The boot id whose restore the user dismissed with "Not now" (12.7): written only when it is the earlier boot the banner offers; while it names that boot the banner is not shown. |
| `window_pages_open` | `1` while the server has pages connected (5.1, plan C20): each refresh that works makes it agree with the server's page count, the first one after the start whatever the store holds; at an orderly stop the server writes it once more as its pages are, and when it dies it stays as the last refresh left it, so that the next server knows that a window may come back (ruled by the plan owner, plan task 74). |
| `window_favourites` | The new form's favourite flags (12.6, follow-up F15): a JSON array of their texts, in the order they were added, at most 12; absent while there is none (the last one removed takes the entry away). One write is one transaction that reads the list first. A value that is not such an array is read as no favourite, and of an array only the entries 12.6's rule takes are read; the next save writes the list afresh. An older skydeck reads only the keys it knows and leaves this one alone. |

### 10.3 When a turn ends

A turn ends when a holder's live-session file changes its `status` from `busy` or `waiting` to
`idle`, the file still naming the same session and the same process (pid and process start). The
server sees that at its one-second look and records, for that session, the next `attention_seq` as
`turn_ended_seq` and, as `turn_ended_ns`, the idle file's status time: its `statusUpdatedAt`, else
its `updatedAt`, else the time the server saw the change. When the file has one of the two, that is
exactly the time the look keeps for the file (stage B's plan, contract 2.5's `sinceNs`), so that it
can be compared for equality with the status time the session shows (12.4), never across two clocks.
A session with several holders (a duplicate) records the latest status time among its idle holders
(stage B's plan, task 52): never earlier than the time the session shows, also when a look missed
one holder's idle file and sees it end later.
When the session is being seen at that moment (12.4), the same write sets `seen_seq` to a later
value, so a turn that ends in front of the user is never "finished".

`busy` to `waiting` is not a turn end (a dialog opened inside the turn). A file that names another
session than at the last look (`/clear`) starts over. A look that cannot read a file (it is being
rewritten, or the read fails) keeps the last status seen as the baseline; only a file read whole
and parsed moves it. The first look after the server starts only sets the baseline: a turn that
ended while no server was running is not recorded (a known limit; 12.4).

The look keeps one **baseline per pid** (stage B's plan, B4): the last file of that pid read whole,
parsed and trusted (design 5.5: its `pid` and `procStart` are a running process). A file not read at
a look — being rewritten, unreadable, untrusted, or `/proc` could not be read — keeps its baseline;
a file read is the new one. A baseline is dropped when its pid is gone and no file of it was read at
that look: `/proc` says the pid has no process, or a process with another start (a pid taken by
another program, whose baseline would otherwise keep a dead holder's `waiting`, so that the session
would ask until that program ends). The statuses attention reads (12.4) are the baselines', so a
file being rewritten does not make a mark blink. The rule is pure, `isTurnEnd` and `lookAt` of
`src/claude/terminal.ts` (4.3); the server reads the files and asks `/proc`.

**A busy store** (stage B's plan, B11; 14). The look writes this look's turn ends (12.4: with the
`seen` of a session being seen) in one transaction. A store another process keeps locked refuses it
after the server's 250 ms: the write is kept, and the next look tries the kept writes again first,
in their order, each as an entry of its own, then its own. Nothing is folded but two turn ends of
one session, the later kept: a kept `seen` folded into a later turn end would make that turn seen although the user
had left. The baselines move on, so a turn end is neither lost nor recorded twice. While writes are
kept, a refresh's window ends (12.4) and the `seen` that a hold or a typing brings are put behind
them, and the store is not tried again before the next look: a busy store costs its 250 ms once a
second at most, never at every key press. Any other refusal of a write — the counter at 2^53 − 1
(10.2), a damaged table — is logged by its kind and dropped, not kept; a `seen` that would still
clear a mark is made anew at the next look, or the next key that begins a seen, while the hold
lasts, and each such try is refused at once. A live file's time that no INTEGER column holds (past
2^63 − 1 ns, from the year 2262 on) is taken as unknown, so that one foreign file cannot make the
write of every session fail. The marks are read from the
store once, at the first look that can, and then follow from what each write returns; a read that
fails for another reason than a busy store (one damaged row makes every read of the table fail, and
so does a schema version 2 without the table) leaves no marks from the store, logged once by kind:
the list goes on, and a session that asks still shows it, from its live file. A store migrated under
the server stops it (10.1).

**Decided against: a `Stop` hook** (design 16 had planned turn hooks for step 2). The live-session
file already says when a turn ends, for every session, including those running outside the window,
and it needs no new settings entry. A `Stop` hook would add one hook run per turn, and since the
hook writes its input unchanged into the spool (design 5.1: it interprets nothing) and the input of
`Stop` carries `last_assistant_message`, the assistant's final text (documentation, section 21), it
would also need a second exception to principle 4: assistant text in the spool until ingest drops
it, at every turn, for a fact skydeck already has. So:

- `install` adds no hook entries in step 2; the settings entries stay `SessionStart` and
  `SessionEnd` (design 5.1);
- `uninstall` removes what it removed in step 1;
- `doctor`'s hook check is unchanged.

`Notification` and `UserPromptSubmit` are not hooked either: "asks something" is the live file's
`waiting` status (12.4), and the start of a turn is its `busy`.

## 11. Resume, new and restore in the window

### 11.1 One implementation

The window starts sessions through exactly the functions the commands use, so every rule of
design 7.6–7.8 holds unchanged: the session's own launch command rewritten by the flag table,
`claudeCommand`, never an added permission flag, the label passed as the name, the guard on
freshly refreshed rows (`prepareResumeById`), the refusal without a boot id, the lock and its
release and renewal rules, the start-event rule (`resumeStarted`), the memory check and batches of
restore.

One rule is added for the window's own terminals (ruled by the plan owner, review of plan task
32): a resume from the window is refused — "this session is already open in the window", before
the lock, nothing opened — while the window has a terminal for the session whose program may still
run (starting, running, reconnecting, a newer keeper), whatever the lock says. A terminal's session
is the one it shows, or while it shows none the one it was opened for. The lock alone does not
cover it: claude can wait at a dialog before its `SessionStart` for longer than the lock holds, and
the guard then sees no holder; step 1 accepts that hole only for terminals it cannot see.

Five changes to step 1's code make that possible, with no change of behaviour for the commands
(4.4 lists every change step 2 makes to step 1's code, with its stage):

- **Starting a prepared launch** (`launchPrepared`, in step 1 in `src/cli/launching.ts`) moves to
  `src/sessions/launch.ts` and takes the `Terminal` to open with as a parameter. The command line
  keeps choosing the terminal (`--here`, `--tab`, configuration: `launchWhere`, all that stays in
  `src/cli/launching.ts`) and printing the lines; the server passes the window terminal (11.2) and
  shows the lines (12.6). The flag warnings, the printable
  fallback command, and `settleFailedLaunch` (which releases the lock, and for `new` removes the
  label and group, only after a definite failure with nothing printable) are the same code.
- **`prepareNew`** takes the directory as a parameter instead of reading the current directory.
  The command passes `platform.cwd`; the window passes the directory chosen in the form (12.6).
  `prepareNew` refuses one that is not absolute or not an existing directory, as a usage error,
  before it stores anything.
- **`LaunchSpec`** (`src/terminals/types.ts`, in step 1 `{ cwd, argv }`) gains `sessionId`, `kind`
  (`resume` or `new`), the lock value the launch took (or null), the deadline of 7.1 and the label,
  which `launchPrepared` and `runRestore` fill in (`launchSpec`) and pass to `openSafely`. One
  function computes the deadline, `startDeadline` in `src/sessions/launch.ts`: for a resume, the
  time in the lock's value plus `LOCK_TTL_NS − LOCK_START_TOLERANCE_NS`; for a new session, the
  clock when `prepareNew` ran plus the same (`PreparedLaunch` records that time as `preparedAtNs`,
  and the label as `label`). The `here` and `wezterm` adapters ignore the new fields; the window
  terminal needs them for the keeper's spec (11.2).
- **Restore planning** moves out of `src/cli/commands/restore.ts`, where `plan()` is private (the
  boot-id refusal, `buildList`, `flatRows`, `planRestore`), into `src/sessions/restore.ts` as one
  function the command and the server share. It also returns the earlier boot and the time of its
  last event, which `planRestore` computes and today keeps to itself: the banner shows that time as
  the last activity before the restart (12.7) — the stop itself is not recorded.
- **`runRestore`'s hooks** (`src/sessions/restore.ts`), optional, which only the server passes;
  without them a restore runs as in step 1. `refuse` is asked before the guard: the window's
  "already open" above, so that a restore opens no second terminal for a session the window is
  starting. `gone` is asked at every look of the wait for each session whose start is not seen:
  a session whose window terminals have all ended, were lost, were not started or were closed is
  reported `failed <short>: <reason>` at once and restore's lock (its last renewed value) is
  given back, instead of being waited for until `restoreStartTimeoutSeconds`, as a tab must be.
  A `signal` lets the server end the run at its next step (its own stop, or the command that
  asked for it going, 11.4): no further entry is prepared or opened, the wait ends at its next
  look, the sessions still waited for are reported `timed out` (their locks stay: their terminals
  may still start them), then one line `stopped: <reason>`, then the rest `not started`. The
  signal stops the run only when it is seen while the stop changes something — a session the wait
  would still wait for, or an entry not opened; otherwise (every session started, or the wait's
  time ran out at that look, with no entry left) the run ends as it would have. The fourth hook, a stop after a batch in which no session started, is 11.3's. Each report line also
  names the session it ends and how (started, timed out, failed, not started, handed off,
  printed), and the outcome says whether a hook stopped the run.

### 11.2 The window terminal

`Terminal` (design 7.6 "Where") gets a third adapter, `window`, with `opensTabs: true`. It lives
in `src/window/` (4.3) and exists **only inside the server**: no other process opens a terminal of
the window, and nothing hands the server a launch to run (8.3); the `Terminal` type's names gain
`window`. Its `open(spec)` spawns a keeper (7.1) with the spec's launch, session id, kind, lock
value and start deadline (11.1), the first size (8.2.6) and the next free slot; claims it, sends
`G` on its `hello`, and resolves on what comes back:

- `T` (8.1): `{ ok: true }`; the program runs, and the terminal is tied to its pid and process start
  (7.5);
- a keeper that cannot be started at all (python3 missing, a socket path too long, a spawn error):
  `{ ok: false, timedOut: false }` with the reason — no keeper runs;
- `X` with `notStarted`, or a keeper that ends before `T`: `{ ok: false, timedOut: true }` with
  "not started: <reason>" — nothing was started, the terminal stays listed with its exit and offers
  Resume, and its exit gives back the lock (7.8);
- no `hello`, or no `T` after `G`, within 5 seconds, or the server stopping while the keeper starts:
  `{ ok: false, timedOut: true }`. The keeper may still start the program before its deadline; a
  later server that finds it runs the guard first (7.3), and this server keeps the terminal and
  shows it when `T` comes.

So a failure behaves as a failed tab does in step 1 (`settleFailedLaunch`), with one rule of the
window's own (ruled by the plan owner, stage A's plan task 21): `timedOut: false` (step 1 then
prints the command to run by hand) is answered only for a launch for which no keeper process was
ever started (python3 missing, the socket path too long, the registry refusing before it spawns) or
whose keeper is known dead with no terminal left (it ended at start). Every other failure takes the
timeout's path: no command — a keeper may run, and a hand-run `claude` could start the session
twice, or the terminal offers Resume itself — and the lock and the label stay; the terminal's exit
gives them back when its program never started (7.8).

### 11.3 In the window

- **Resume.** Enter on a selected session that is not running, a double click, "Resume here" on
  the resume card, or Enter in the switcher: `act resume` → `prepareResumeById` → `launchPrepared`
  with the window terminal. The new terminal gets the next free slot and is selected, with focus in
  the terminal. The answer's `lines` (flag warnings; on a refusal the guard's message, such as
  `<short> is running (pid <n>)` or `is being resumed (<n> s ago); try again in <m> s`) are shown
  on the card.
- **New.** The form (12.6) → `act new` → `prepareNew` with the chosen directory → `launchPrepared`.
- **A window terminal that fails unexpectedly** (its `open()` rejects or throws, for a resume or a
  new session) is answered as an open that timed out (11.2): the window terminal may already have
  a keeper, so no command to run by hand is shown — a hand-run `claude` could resume the session
  twice — and the lock and the label stay. The failure is logged once by its kind ("the terminal
  failed unexpectedly (<kind>)" on the card), never its message (ruled by the plan owner, review of
  plan task 32).
- **Restore.** The banner (12.7) → the shared restore planning (11.1: design 7.8's set and preselection, on rows
  refreshed just before) → `runRestore` with the window terminal: batches of `restoreBatch`, the
  memory check, the wait for start events with lock renewal, exactly as from the command line,
  and the hooks of 11.1. One more rule is the window's: once a batch that opened at least one
  terminal ends with none of its sessions started, while entries are left, the run stops —
  `stopped: no session of this batch started`, the rest `not started` —, because a `claudeCommand`
  that cannot start (the server's `PATH` after a boot) would otherwise open a keeper for every
  session in turn. A last (or only) batch that starts nothing ends the run as any run with
  failures. **One restore runs at a time** in the server, whoever asked for it (a page or a
  command, 11.4): another request meanwhile is refused with `a restore is already running; wait
  until it has finished`, and a refused request is no run — only its asker gets that line, no page
  does. Every report line of every run goes to every page (12.7), and **every run ends with exactly
  one line** `restore finished: <n> started, <n> timed out, <n> failed, <n> not started` (the parts
  that are 0 left out; `restore finished: nothing was started` when all are), also after a stop of
  any kind — its `timed out` lines for the sessions still waited for, the `stopped:` line and the
  `not started` lines come before it — and after a run that cannot begin (the boot id unreadable,
  the store busy: its line first). A run that a busy store ends says `stopped: skydeck's database
  is busy; press Restore again (or run skydeck restore) for the rest`; one that fails otherwise
  says `stopped unexpectedly (<kind>); the sessions it opened go on starting: run skydeck to see
  which`, logged by kind. Whatever ends a run, the terminals it opened go on starting their
  sessions, and a session it still waited for keeps its lock (its terminal may still start it).

### 11.4 `skydeck resume` (and `new`, `restore`) in a terminal while the window runs

- Without options they behave as in step 1: the configured `terminal` decides, `here` by default.
  A session resumed in a WSL terminal runs there; within two seconds the window lists it as
  "running in another terminal" (7.9). The guard sees every holder wherever it runs, so a session
  open in the window is refused as `running (pid <n>)` like any other running session; `show` adds
  `(in the skydeck window)` to a holder's line when the holder is a keeper's program or descends
  from it (7.5's walk: up to 8 parents below the program, so 9 below the keeper) and that keeper is
  alive by its `.pid` line in the runtime directory the store records (4.2, design 5.5's rule). It
  needs no running server: it creates nothing and connects to nothing, and with no runtime
  directory, no keeper line or no boot id there is no mark. `show --json` is unchanged.
- `--window` (new for `resume` and `new`; `--here`, `--tab` and `--window` exclude each other: two
  of them are a usage error, exit 2, `--here and --window cannot be used together`; plan C13), or
  configuration `"terminal": "window"`, sends the request to the server (8.3) instead of starting
  anything itself: `resume` sends the session id its `<ref>` resolved to, `new` sends its current
  directory, `--label`, `--group` and the flags after `--`. It never starts, restarts or signals a
  server: the server's environment becomes every session's (5.2), so only `skydeck window` starts
  one. It finds the server as `skydeck window` does (5.1) and uses one of this checkout whatever its
  build (the window's own Resume runs on that build too). With no server running it says `the
  window is not running; run skydeck window first, or use --here` and exits 1; a server that does
  not answer, or is still starting after the 5 seconds, gets 5.1's line; one of another checkout
  `the window's server runs from <checkout>, not from this checkout; skydeck window --restart here
  replaces it, or use --here`; one of a build before stage C (it answers the request 404) `the
  window's server is older than this command and cannot start sessions for it; run skydeck window
  to restart it, or use --here` — each exit 1, and none of them is refused under `CLAUDECODE`, since
  no server is started (plan C11). It prints the answer's lines on stderr, sanitised (the server may
  be of another build), and exits with the answer's code; then, when no page is connected, it
  starts a window as `skydeck window` does (5.1 step 2, the wait of a window the server expects
  back included; 5.3) — not after a code of 2 or 3, a refusal of usage or reference that started
  nothing. A window that cannot be opened is one line, `the window could not be opened: <reason>;
  run skydeck window`, and the exit code stays the answer's. **Under `CLAUDECODE` a command never
  opens a window** (5.1 refuses `skydeck window` there, and this must not be a second door): it may
  still ask a running server to start the session, and with no page connected it says `no window
  is open; run skydeck window in a terminal of your own` (plan C12). When the server does not
  answer within 30 seconds it says so and exits 1, printing no command (it prepared nothing; the
  server may have started the session: `skydeck` shows whether it runs); while the server is
  starting it asks again every 500 ms within those 30 seconds, and a server still starting after
  them started nothing; one that is stopping is reported with `, or use --here`, and a body the
  server refuses (a label over 1,024 bytes; a prompt after `--` over 64 KiB, which the command
  refuses so before it sends anything) with `; use --here` (plan C 2.5). A connection that fails
  after the request reached the server and before its answer says that the server may have
  started the session (or the restore), as the 30 seconds do. With `"terminal": "window"`, no
  option and `--tab` mean the window too and `--here` this terminal (plan C13; with `"here"` or
  `"wezterm"` only `--window` goes to the window), and so does `R` in the interactive list, whose
  lines end before `, or use --here`; `R` opens no window. `R` sends `POST /resume` (nothing is
  prepared or locked in the list) and shows the answer the way it shows a tab launch's: `opened
  <short> in the window` and the answer's lines — with `; no window is open; run skydeck window`
  when no page is connected; when the server's status cannot be read after the answer, nothing
  more is said —, a refusal (codes 2–4) or a line of plan C 2.5 as the message line, and for a
  failed launch `starting <short> in the window failed; the details are printed when the list
  ends`, its lines (sanitised) printed when the list ends; an answer without lines (a server of
  another build) names its code instead. Named limits (ruled, task 77's review 2): a line longer
  than the terminal is cut in the list's message line, the advice at its end with it (the command
  line prints it whole); and the list paints nothing while `R` waits for the answer — up to the
  30 seconds while the server is starting —, and a key typed meanwhile acts only after it.
- `restore` with `"terminal": "window"` plans and shows its list and asks as in design 7.8, then
  sends the selected session ids (and `--all`) to `POST /restore` — when no page is connected
  after opening a window first, as `resume` does above (none under `CLAUDECODE`), so that the
  terminals start at the window's size and a start dialog can be answered; a window that cannot be
  opened is its one line, and the request is sent all the same (plan C12). The server takes
  design 7.8's set from freshly refreshed rows, keeps the entries the user selected (an id no
  longer in the set is reported `failed <short>: no longer offered for restore`), and runs
  `runRestore` with the
  window terminal (11.3), the selected entries in the set's order. Each terminal starts at the area
  the page that had focus last reported (8.2.6), read when that terminal is opened; the
  configuration (`restoreBatch`, `restoreMinFreeMb`, `restoreStartTimeoutSeconds`, `claudeCommand`)
  is the one the server read at its start. The command prints each report line on stdout as it
  arrives (sanitised), heartbeats too, and exits with design 7.8's code for the outcome; with 5
  (the run was stopped) it adds `skydeck: restore stopped before it finished; see above` on stderr
  (plan C14). **A restore asked for so stops when its command
  goes**: when the command's connection closes before the outcome (Ctrl+C, as in step 1), the run
  stops at its next step — `stopped: the command that asked for it stopped`, the sessions already
  opened go on starting, the rest are `not started`, then the finished line (to the pages); the
  server lives on. A command that goes after its outcome changes nothing. `--dry-run` asks the
  server nothing. The command asks the server for `GET /ping` before it plans or prompts, so "the
  window is not running" comes before any question. While a restore runs, the server sends a line at least every 10 seconds (`waiting for
  <n> sessions` when nothing else happened, `n` the selected sessions without an outcome yet; to
  the command only, not to the pages); a command that hears nothing for 30 seconds says `the
  window's server stopped answering; run skydeck to see what started` and exits 1.

## 12. What the window shows

This section is the design of the step 2 UI research (the mockup kept with the research notes)
and its nine picks (12.11). The mockup was approved, and so was an Edge app window that runs like
it, so what the mockup shows is decided; the pull-request chip's rule for several open pull
requests (12.3) is the user's ruling. What the mockup cannot show — the key policy (12.9)
and a crashed terminal needing the user (12.4) — are the lead's decisions under the user's
go-ahead to proceed. Every rule that orders, groups, filters or judges attention is a
pure function in `src/window/view/` (4.3).

### 12.1 Layout and sections

A title bar, the list on the left, the selected session's header and terminal on the right, a key
bar at the bottom. The list has three sections:

- **Open**: every session that is running or starting, in the window or elsewhere.
  Never folded. Order: terminals of the window by slot, then terminals without a slot by opening
  time, then sessions running in another terminal by the time they started. The order does not
  change while the window is open except when a row joins or leaves; attention is a mark on the
  row (12.4), never a move.
- **Recent**: not running, last activity within 7 days (a rolling 7 days, not the calendar week),
  most recent first. Its title is `Recent`; its key in the code and the protocol is `week`. Its
  header's tooltip says `last active in the last 7 days` (follow-up F5); the other
  two headers have no tooltip.
- **Earlier**: the rest, folded by default; the folded header shows the count and the time span.
  A click on its header folds and unfolds it, as ← and → do, and leaves the keyboard on the list
  (ruled by the plan owner, plan task 27).

Each section's header is a band (follow-up F17, 2026-11-18, picked from six
pictures): across the whole width of the list column, edge to edge and square, on the page's own
background (`--bg`: a step darker than the list's `--panel`, so the band looks sunk into the list),
with a 1 px line above and below it in the line colour, 28 px high with them — within 1 px of the
header it replaced (27.85 px), and below the rows' scroll margin, so that a row or a caption the
keyboard scrolls into view is never left under it. Before the title a small bar (3 × 12 px, rounded)
marks the section: Open's in the accent colour, Recent's in `--dim`, Earlier's in `--faint`. The
title is 12 px, bold, in capitals: Open's and Recent's in the text colour, Earlier's in `--dim`
(`--faint` reads too weakly on the darker ground); the count follows it, dim; a folded Earlier's
span sits at the right end. Earlier's fold arrow keeps its place before the bar, at least 5 px apart
from it, so that the two never read as one sign. While its section scrolls, the band stays at the
top of the list and nothing of a row or a card shows through it. Two bands that meet (Open with no
row, right above the next section) share one line. A section's first row (no card before it) that
the keyboard brings into view from below rests right under its band, so that the band sits at the
list's top edge over the one stuck there, with no strip of that one above it (the other rows keep
their scroll margin). The bar is decoration: it is not announced, and it is no control of its own (a
click on it is a click on its header). Why a band: since F9 the cards of the blocks have a stronger
edge than a faint rule, and the old header — a small faint title with no line — was lost among them;
the band is the one thing
stronger than the cards, in the dark scheme too, and adds next to no height (half a pixel for the
three). Its words stay at least 4.5 : 1 against the band and Open's bar at least 3 : 1, in both
schemes (`test/web/section-band.test.ts`).

Done sessions are hidden (design 7.1), with a footer "17 done hidden · show". Filtering and the
switcher search done ones too (12.8).

**No session at all** (follow-up F22, for a new user's first window). While the list holds no
session at all — none in any section (a folded Earlier counts its own; done sessions hidden count
for none) and no filter or chip set — it says so under the Open band, in a short note muted in
`--dim` (at least 4.5 : 1 on the list, in each scheme; `--faint` is not) and in the list's own
type, line by line: `No session here yet.`, `Start claude in any terminal: it shows here as soon as
it starts.`, `Or start one here with Ctrl+Shift+N.` (in a browser tab, where the browser keeps that
key, `Or start one here with + New in the key bar.`: the page's app-only and tab-only rule picks
the line) and `Ctrl+Shift+H shows every key.`. It is a note (`role="note"`), no control and not in
the tab order, and it wraps inside the list's width. A filter or a chip that hides every session
keeps its own line, `No session matches the filter.` (12.8). It comes and goes with the lists, with
no reload: it goes when the first session is listed and comes back when the last one is done or
gone (the footer then says how many are done). With sessions it is not in the list at all, so
nothing of a list with sessions moves. The right side, blank before while nothing is selected
there, then has one line in the same colour above the empty cards, `The selected session shows
here.` (12.6): its terminal, its card or its resume card, once there is one; it is no card of a
session. Whether the list holds no session is one rule of the page's (`holdsNoSession`,
`web/list-text.js`), read by both. Ruled by the plan
owner: a session started in a terminal is listed from its start, before its first prompt (design
7.2: only one that ends before its first prompt has no transcript and drops out), so the note says
"as soon as it starts"; and the right side's line names no session to pick (it shows only while
there is none) and no terminal (a session started in another terminal shows its card there).

The title bar shows the counts, e.g. `● 3 need you · 3 working · 2 idle`, and the window title is
`(3) skydeck` while 3 sessions need you, so the taskbar shows it.

The `need you` count is every listed session that needs you (12.4), whatever the filter or the
fold; a session that needs you is counted there and in no other count, so that the parts add up
(3 + 3 + 2 above). The window title's `(3)` is the same count. Which rows need you, and in which
order Ctrl+Shift+J goes, the server sends with each `list` (8.2.3 `needYou`): the page decides no
rule (4.3; stage B, plan B7).

**The theme switch** (follow-up F13, 2026-11-18: so that the theme can also be chosen by
hand). The page is light or dark as the
system is (Windows' Settings, Personalization, Colors: the `prefers-color-scheme` media query), and
changes with it while it is open. A small button in the title bar, right before `Switch…` and drawn
as it is, shows a half circle and the state's word: `Auto` (the system's, the default), `Light` or
`Dark`. A click goes to the next (Auto → Light → Dark → Auto); its tooltip says the state and what
a click does (`Theme: follows the system. Click for light.`, `Theme: light. Click for dark.`,
`Theme: dark. Click to follow the system.`); its word keeps the room of the widest, so that a click
moves nothing. Forced dark is exactly the system's dark and forced light exactly the system's
light: every colour of the page and `color-scheme` (scroll bars, form controls); at a click every
terminal of the page is repainted in the new colours — background, text, the sixteen colours, the
selection —, a hidden one too, as after a change of the system's scheme. A click moves no keyboard
(the title bar takes none, 12.9) and changes no selection; there is no key chord, no `config.json`
key and no command-line flag for it. The choice is the page's: one key of its `localStorage`
(`skydeck-theme`, `light` or `dark`; none for Auto), so it holds across reloads and restarts of the
window and in every window of the profile, and another window of the profile follows a change at
once (the `storage` event). A stored value that is neither, or storage that throws or is missing,
is Auto; the button then still works for the life of the page. A classic script of its own
(`web/theme-early.js`, loaded in `<head>` ahead of the style sheets, which the policy allows as it
is, 8.2.1) puts the stored choice on `<html data-theme>` before the first paint, so that no frame
shows the other theme. Nothing of it is sent to or kept by the server but the colours, which the
page reports again for OSC 10 and 11 (8.2.3 `theme`; 7.2, 9.3). In each style sheet with a dark
scheme (`style.css`, `terminal-view.css`, `attention.css`) the dark values are written twice — the
system's, scoped to "not forced light", and a twin for forced dark — and a unit test holds the two
equal declaration by declaration. Check W34.

### 12.2 Rows

- A running session has two lines: the first as below, the second its state line (`working 4m`,
  `needs you · permission · Bash · 3m`, `finished · not seen · 2m`, `running in another
  terminal`, `starting…`).
- A row that needs you (12.4) has two lines whatever its state, an ended one that is not running
  too: the second is its reason, in place of the state line — `needs you · <detail> · 3m` (`needs
  you · 3m` without a detail), `finished · not seen · 2m`, `ended unexpectedly · not seen · 2m` —,
  its age from the time 12.4 names, left out while that time is not known; the first line then
  has no age (stage B, plan B13).
- A session that is not running has one line: state icon, the ticket key (dim, monospaced) and the
  title, marks (`crashed`, `crashed mid-turn`, `expires 3d`, `expired`, `done`: design 6.3's marks
  in words), the pull-request chip (12.3), `✎` when it has a note, and its age. Stage A shows every
  mark of design 6.3 in words (`continued` and `2 processes` too) and the expiring one as `expires
  soon`: the row carries only that the session is expiring, not when its transcript is deleted
  (ruled by the plan owner, plan task 27).
- **The ticket's status** (follow-up F19). While the session's ticket — the one set on it, else its
  group's link (12.5) — has a known status, a second small chip stands right after the
  pull-request chip: the status' text cut at 14 characters (13 and `…` when it is longer), in the
  tint of its category (12.3), in the pull-request chip's box (6 px of padding at each side, a 1 px
  border in `--line2`, a radius of 9 px, 11 px text on a 16 px line: 18 px high); its tooltip is
  `<name> · <status>`, the whole status. A ticket with no status known — one that was never read,
  or whose reads all failed — shows nothing: the chip is hidden and takes no room, so that a row
  without one is drawn exactly as before F19; with one, the title gives it the room (the title
  alone shrinks, as for the pull-request chip). The quick switcher's rows do not show it. The
  server sends the row's `ticketStatus` (8.2.3), the page cuts the text and draws the chip, and
  the filter finds the text (12.8).
- No group headers, except the caption of a block (below): most groups have one session. The
  group (design 7.1) is printed dim at the start of the title when the title does not already
  start with it. In every section the rows of one group sit together as a block, drawn as a card:
  a box with a caption line — the group's name and the number of its sessions — and its sessions
  inside as ordinary rows; open by default. A click on the caption, or ← on a session of the
  card, closes it to its caption alone; a click on the caption, or → on it, opens it again. A
  filter flattens every block: flat rows, each with its group, no card. (Ruled on 2026-11-16,
  follow-up F3: blocks in every section, open by default, grouped by the state and then by
  group; until then only Recent and Earlier stacked,
  closed by default, and running sessions never did. Drawn as a card since follow-up F9,
  2026-11-17, so that a group reads as one and no session looks like another's sub-session; before
  it the first session was the block's head, with `ORB-2107 ×4`, the
  others indented under it, and a closed block was its head and a line `+3 more`.)
- Slot numbers 1–9 show at the left of Open's rows.

The rule of blocks is the server's (4.3; stage E, plan E6 as ruled on 2026-11-16 for follow-up F3,
and follow-up F9). A block is what the code and the protocol call a stack (`stackRows`, the row's
`stack`, `data-stack`). In every section — Open, Recent and Earlier —, each on its own, the rows of
one group (the row's group as sanitised, compared as exact text) form a block when there are at
least two: Open holds only blocks of running sessions, Recent only of recent ones (not running, last
active within 7 days), and a group with rows in two sections is two blocks. Every row of the group
is in its block, one that a terminal of the window holds (running, starting or ended: it may hold a
slot) and one that needs you (12.4) too. A block sits where its first row sits in the section's
order (12.1), its other rows right after it in that order; the protocol calls that first row its
head (8.2.3), but in the card no row is special. A row whose group no other row of its section has,
and a row without a group, are drawn as before; while a filter or a chip is set (12.8) no block is
formed. A block is open unless the page's view names its section and group in `closed` (8.2.3): the
page remembers the blocks the user closed, per window, until a reload; a block the user closed stays
closed until it is opened or the page reloads, also when its rows leave and a block of that section
and group forms again later (ruled on 2026-11-16, review 2 of follow-up F3). A closed block is open
while the selected session is ANY of its sessions (its first too since follow-up F9, which hides the
first session of a closed block like the others), and the page then forgets that it was closed, so
that it stays open when the selection leaves (ruled): whatever selects a hidden session — a click, a
slot chord, Ctrl+Shift+J, Ctrl+Tab, a notification's click, a pick in the switcher, the server's own
selection after a resume (12.9, 12.8), → or Enter on its caption — opens its block, so the selection
is never on a row hidden in a block. A closed block is open too while any of its sessions — its
first too — is drawn with a terminal of the window that has not reported a session (7.5: a start not
yet reported, which may stay so, or a program that ended before it reported, until its terminal is
closed), so that such a row and its slot are on screen and its slot chord reaches it; the page
forgets that it was closed, as for a selection, and while such a session holds the block open ← on a
session of it and a click on its caption do nothing and the key bar says why (ruled on 2026-11-16;
two lines from follow-up F6): `this block holds a session that is still starting; it stays open`
while that session's terminal may still come to hold a session (it changes by itself), and `this
block holds a terminal that ended at its start; close it first` when it can no longer start one (it
ended, was lost or never started), since waiting never frees the block and the ended bar's Close
does; when both kinds hold one block, the first. The page's rule is a copy of the server's
(`build.ts` and `web/list.js` each say so): a terminal's `sessionId` null in `list.terminals` for
the terminal a session's row is drawn with; and which of the two lines is told by the terminal's
state, the page's set of the states that may still start, a copy of the server's `MAY_START`
(`sections.ts` and `web/pane.js` each say so, and a unit test holds them equal). A closed block
never hides that a session needs you: its caption says how many of its sessions need you (below),
Ctrl+Shift+J reaches them (`needYou.order` holds them, 8.2.3), and the title bar's counts (12.1) are
the same whether a block is open or closed. A section's count and time span are all its rows', a
closed block's included. A view without `closed` closes no block: the page and the server are one
build (8.2.2), and an open block hides no row.

How a block looks (stage E, plan E7 as ruled on 2026-11-16; as a card since follow-up F9,
2026-11-17). Each block is a card: a box of its own with a 1 px border (`--card-edge`, chosen so
that it is seen as an edge in the light and in the dark scheme), rounded corners, a background one
step off the list's (`--panel2`) and 8 px of room around it. Its first line is its caption: the fold
arrow (▾ while open, ▸ while closed), the group's name (cut with an ellipsis when it is long; it
reaches the page as text only), the number of its sessions (small and dim) and, while the block is
closed and sessions it hides need you, ` · 1 needs you` (` · 2 need you`), that part alone in the
colour of the title bar's `need you` count, with no bar and no bold, which stay the marks of a row
that needs you (12.4). The arrow, the count and that part always show; the name gives way. The count
is the server's (`needYou` of the closed block, 8.2.3), taken from the same fact as a row's own
mark, never from a text. An open card holds every session of the block as an ordinary row inside it:
no `×4`, no indent, no row is special, and the group — the row's ticket key, or its group text — is
not repeated on them, since the caption says it. A closed block is its caption alone: no row, its
first session hidden like the others (follow-up F3's line `+3 more in ORB-2107` and the head's `×4`
are gone). Which rows form a block, where it sits, their order and the slots are as before. With a
filter or a chip set there is no card: the rows are flat, each with its group (12.8).

How a block is used (plan E7 as ruled on 2026-11-16; follow-up F9). The caption of a CLOSED block
can hold the selection: it stands for the block, and no session is selected then — the page tells
the server `selected: null` in `view` and `focus` (8.2.3), so that nothing is seen (12.4), no
notification is held back and no resume card is shown — and the pane shows a small card of the group
(12.9). The caption of an OPEN block cannot hold it. A click on the caption line — the whole line is
the control — opens or closes the block; it leaves the keyboard where it was, and the second click
of a double click does nothing (12.9). A click never moves the selection (ruled on 2026-11-16,
review 2 of follow-up F3), with one exception: a click on the selected closed caption itself opens
the block and selects its first session, as → does (the list zone takes the keyboard first, so that
no terminal gets it). While the block holds the selected session — any of its sessions —, a click
that would close it leaves it open, and the selection, the focus and the right side as they are, and
the key bar says `this block holds the selected session; it stays open` (closing it would put the
selection on its caption, and a click moves no selection); ← on that session closes it (12.9). A
selected caption whose block opens without a key — a session starts into it (its terminal has not
reported a session, above), or the 65th closed block drops it from `closed` — or goes — fewer than
two sessions of its group are left in its section — leaves NOTHING selected, never a session that
the user did not choose; ↑ ↓ then start again from the first line. While a filter is typed a
selected caption stays selected, as a selected session that the filter hides does (12.9): the pane
keeps its card, and the caption is drawn selected again when the filter is cleared. The keys are
12.9's. The page sends `closed` in every view (`[]` at least), at most 64 entries, the oldest
dropped (that block opens again); a group the server would refuse — not well formed, or over 1,024
bytes (8.2.3) — is never sent, so its block cannot be closed: ← on a session of it and a click on
its caption do nothing, and it stays open (a named limit). A long group name is cut with an ellipsis
in the caption, and the arrow, the count and ` · 1 needs you` always show (F3's other named limit, a
`×4` pushed past the list's edge by a long group, ended with the card). `d` on a session of an open
card marks that session only: the others stay a card, or the last one stands alone as a plain row,
and stage D's selection after `d` (12.9) takes the row after it of those the list drew when `d` was
pressed. On a selected caption `d` does nothing (12.9). While filtering every row stands alone
(12.8).

### 12.3 The pull-request chip in the window

The window's chip differs from the list's (design 7.3), which stays as it is for `ls` and the
interactive list: open and finished pull requests are counted apart.

- **Open ones** are the attached pull requests not known to be merged or closed: open, draft,
  never fetched, and those that cannot be read (design 7.3 never fetches a merged or closed one
  again, so an unreadable one was last seen open, or never seen).
- **The chip** shows the number of open ones when there is more than one, and the state of the
  one that most needs the user, in design 7.3's order without merged and closed: can't read
  (`can't read`), not fetched (`not fetched`), checks failing (`failing`), changes requested
  (`changes`), checks pending (`pending`), review required (`review`), unresolved comments
  (`comments`), draft (`draft`), a required check not reported (`pending`), blocked (`blocked`),
  open (`open`), checks passing (`green`), approved and green (`approved`); what the five that
  follow-up F32 added mean: design 7.3.
  After it `+<n>` for the merged ones, when there are any: in the chip's
  tint (below), dim only on a grey chip. Closed ones are not counted.
- **With nothing open:** `<n> merged` (in merged's tint) when any is merged, else `closed` (dim);
  no chip when none is attached.
- A chip whose state is `can't read` is drawn dotted.
- **The tooltip** lists each open pull request with its own state (`repo #n · failing`, or `can't
  read · last read 3h ago`), then the merged and closed counts. The header (12.5) shows the open
  ones side by side on its one line for pull requests, as far as they fit, and the pull-request
  dialog each attached one on a line of its own.

| Attached | Chip |
|---|---|
| 1 open, review required | `PR · review` |
| 1 open, checks failing; 30 merged | `PR · failing +30` |
| 2 open: a draft and an approved, green one | `2 PRs · draft` |
| 2 open: one that cannot be read and one with changes requested; 4 merged | `2 PRs · can't read +4` (dotted) |
| 3 open, the worst failing; 30 merged | `3 PRs · failing +30` |
| none open; 3 merged, 1 closed | `3 merged` |
| none open; 1 closed | `closed` |

**Colours** (follow-up F4; the tints ruled by the lead). Each
state has one quiet tint: on a chip, its text colour and a faint background of the same hue
(`--pr-<tint>` and `--pr-<tint>-bg` in `web/style.css`, with values for both colour schemes), with
the size, border and weight of a grey chip — the header's chip looks as the list's, with the
neutral border (it had a red or amber border for failing, changes and pending before). Where a
state is named outside a chip — the header's open pull requests (`acme/web #7 · failing`), the
state on a line of the pull-request dialog, the quick switcher's chip — only the state's words take
the tint's colour, without a background. A chip that sums several takes the tint of the state its
text names, its `+<n>` too. The words stay, so the colour never says anything alone; an element
names its state by its level (design 7.3), the page's own name for it, never a text of the
server's. The tints stay below the attention marks (12.4), the user's one condition (needs
you and finished stay the stronger marks): only a row that needs you has a left bar and its
reason's line in the reason's colour, and its title is the boldest (700; a running session's is
600, any other row's 400); each tint is softer than the mark's colour of its family, and its text
is no stronger than an ordinary row's title (`--dim`): on `--panel` and on `--sel` its contrast is
at most `--dim`'s + 0.1 (ruled). Each tint's text has a contrast of at least 4.5 : 1 against its
own background and against every background its words stand on (a row, hovered or selected; the
header; the dialog; the switcher and its highlighted item), in both schemes
(`test/web/pr-tints.test.ts`).

| State | Tint |
|---|---|
| checks failing (`failing`), changes requested (`changes`) | red |
| checks pending (`pending`), a required check not reported (`pending`) | amber |
| review required (`review`), unresolved comments (`comments`), blocked (`blocked`) | blue |
| approved and green (`approved`), checks passing (`green`) | green |
| merged (`3 merged`, a merged line of the dialog) | purple |
| draft, open, closed, not fetched, can't read, a state the page does not know | grey, as before |

**A ticket's status** (follow-up F19) takes the same tints and no new colour, by its category — one
of six words, which the page checks against its own list (`knownCategory`; any other word, and no
category, is grey) —: its chip in the list's row (12.2) and the ticket's chip in the header (12.5)
carry the word in `data-category`, and the rule `:where(.row-ticket, .header-ticket)` of
`web/style.css` maps it to the variables of the pull requests' tints (`--pr-*` and `--pr-*-bg`,
which hold in the light scheme, the dark one and the forced themes alike).

| Category | Tint | The pull requests' level of that tint |
|---|---|---|
| `blocked` | red (`--pr-red`) | checks failing, changes requested |
| `review` | amber (`--pr-amber`) | checks pending, a required check not reported |
| `doing` | blue (`--pr-blue`) | review required, unresolved comments, blocked |
| `done` | green (`--pr-green`) | approved and green, checks passing |
| `todo`, `closed`, none, or a word the page does not know | grey (`--dim`), as a draft or a closed pull request's chip | draft, open, closed, not fetched, can't read |

Purple (merged) is not used. The words stay, so the colour never says anything alone. The two chips
stand on the grounds that `test/web/pr-tints.test.ts` measures (a row, hovered and selected; the
header), so the 4.5 : 1 rule above holds for them; `test/web/ticket-status-tints.test.ts` pins
the mapping — each category with a colour takes its tint's two `--pr-*` variables, and the rule
writes no colour of its own — and the rule itself for the six categories: each one's text (its
tint, or `--dim`) has at least 4.5 : 1 against its own background and every ground a chip stands
on (`--panel`, `--panel2`, `--sel`), light and dark; the page suite compares each chip, in the row
and in the header, with a pull request's chip of the same tint drawn beside it, light, dark and
under both forced themes.

### 12.4 Attention: needs you and seen

A session **needs you** for one of three reasons, in this order:

1. **asks**: a holder's live-session file has status `waiting` (a dialog is open: permission, a
   question); the detail is `waitingFor`. It ends when the status changes. (Design 6.2's state
   `waiting` also covers `idle`, so "asks" is decided on the raw status, not on the state.)
2. **ended**: a terminal of the window ended (7.8) and the session it held is marked
   `ended-unexpectedly` at the next refresh: `window_end_seq` is set (10.2). It ends when seen.
3. **finished**: `turn_ended_seq` is greater than `seen_seq`, and the session is running and idle.
   It ends when seen or when the next turn starts.

How the view model judges them (stage B, plan B5, B6, B13). "Running" is the row's state: anything
but not running (an ask and a finished turn need it; an end of the window does not). A session with
several holders (a duplicate) has one status: `waiting` when any holder waits, else `busy` when any
is busy, else `idle` when any is idle, else the first holder's; of several holders with that status,
the first one's detail and time. A session running without a readable live file is not finished; nor
is a turn end of an earlier run: "finished" also needs that the idle status the row shows did not
begin after the recorded turn end (`turn_ended_ns` and the status time both known, the status time
later). Within one run the look records the file's status time as `turn_ended_ns` and keeps that
file, so the two are the same value while the session stays idle; a session resumed elsewhere days
after a turn end nobody saw is therefore not `finished · not seen · 3d`, and nothing notifies. Its
limits: a live file with `updatedAt` but no `statusUpdatedAt`, rewritten while idle, loses its
"finished"; a turn that starts and ends between two looks is not recorded, and its later status time
drops the older mark (as the next turn's start does); and, not closed, `/resume X` inside a process
that has been idle since before X's last turn end keeps its status time, so X is still "finished".
An end counts while its `*_seq` is greater than `seen_seq`, or no `seen_seq` is stored; an equal
value is not later. The detail of an ask is the `waitingFor` sanitised (design 7.4), trimmed, and
cut to 120 UTF-16 units with `…`, never inside a surrogate pair (a `waitingFor` has no length limit,
and the list is sent whole); one that is blank once sanitised (empty, or only white space) is no
detail. The time a row shows is the file's `statusUpdatedAt` (else `updatedAt`) for an ask,
`window_end_ns` for an end of the window, `turn_ended_ns` for a finished turn. Ctrl+Shift+J's order,
in full: those that ask by that time, the longest-waiting first and an unknown time last; then those
that ended by `window_end_seq`; then those that finished by `turn_ended_seq`, the oldest first; ties
by session id.

**When a window end is recorded** (stage B's plan, B10). At each refresh that worked — after the
exits it settled (7.8) — each terminal of the window in state `ended` or `lost` (a keeper that died:
its exit time is the server's clock) that started its program is judged, once, at the first refresh
where its session's row no longer runs and that row's last holder is gone (a lost keeper's program
lives on its SIGHUP for a moment, and its end event can be ingested before it exits, while
`ended-unexpectedly` needs the holder gone, design 6.3; the rows are loaded again once that holder
is gone, 10.1):
its session, the one it shows or else the one it was opened for, gets `window_end_seq` and, as
`window_end_ns`, the exit's time when that row is marked `ended-unexpectedly`; nothing when the
session ended deliberately. A terminal that leaves the list is forgotten. It is the same end when the stored `window_end_ns` equals the exit's
time, so a server restart, which finds a lingering keeper again, never marks it twice; nothing is
judged before the server has read the marks. A session being seen at that moment gets its `seen` in
the same write. At the first start of a stage B server the table is empty, so each lingering keeper
of a session that ended unexpectedly gives `ended` once, with no notification (13).

Seen is a **condition that holds**, not a moment: a session **is being seen** while it is the
selected one in a window that has focus, from 1.5 seconds after it was selected; typing into its
terminal makes it seen at once. While it holds, the server sets `seen_seq` to the next counter
value (10.2) when that clears a mark, and always in the same write as a turn end that happens
meanwhile (10.3) — so a turn that ends in front of the user never shows "finished". Order is by
the counter, never by clock times (10.2). A turn that ended while no server ran is not recorded
(10.3), so it shows no "finished".

**When the hold starts, what typing is, when `seen` is written** (stage B's plan, B9; ruled by the
plan owner). A page holds a session from the moment that page has focus with that session selected;
any change of either starts the 1.5 s again, so a window that comes back to the front sees after
1.5 s too, and focus lost ends the hold at once. Several windows each hold their own; a session held
in any of them is seen. Typing is an `input` that is not `binary` and is not a report a terminal
sends by itself, told by its shape: focus reports (`ESC [ I`, `ESC [ O`), SGR mouse reports (`ESC [ <`
digits and `;`, then `M` or `m`) and the answers to queries (device attributes, cursor position and
status reports, mode reports, `CSI t`, the colours of OSC 4, 10 and 11, DECRQSS). A program that
asks for focus reports (9.2; Claude Code is expected to, not yet checked with the real program) gets
one at every click, chord and return to the window, and a mouse report is no key, so none of them is
typing (else every selection would clear its mark at once). The page swallows the queries (9.3), so
no answer arrives today; were one to come, it is still not typing (a false "typing" clears a mark
unread, a false "not typing" costs the user 1.5 s), and a key whose encoding has a report's shape,
such as Shift+F3 (F3 with any modifier has the bytes of a cursor position report), does not count as
typing either: the hold's 1.5 s apply. An OSC or DCS answer counts only when it is whole in one
message, and a paste holds no ESC (9.1) but its two brackets. The user's own acts on a terminal
without a key are typing: the wheel over a program in the alternate screen that asked for no mouse
reports and an Alt+click, both arrow keys, and an empty paste. Typing into the selected session's
terminal of a focused window completes the hold at once and it holds as long as the selection and
the focus do; typing into another terminal, or into the selected one's while the window has no
focus, makes the session it shows seen once. A `seen` is written only when it clears a mark — a hold
completes, a typing comes, or a mark of a session already being seen becomes known — and always in
the write of a turn end or window end of that session while the hold lasts; there is **no periodic
`seen` write**: nothing writes to the store every few seconds because a window has focus. It is
written on its own only for a session among the list's rows, so that a selection naming no session
leaves no row; one in the write of that session's own end goes with it all the same, since the end
makes the row. The hold is `src/window/seen.ts` on the server's clock (`Clock.after`, which a step of the wall
clock does not move).

Ctrl+Shift+J selects the next session that needs you: those that ask, the longest-waiting first;
then those that ended; then those that finished, oldest first. Pressed again it goes on; after the
last it starts over.

How the page goes (stage B, plan B14): Ctrl+Shift+J selects the id of the list's `needYou.order`
(8.2.3, the order above over the rows this page shows) after the selected one, else the first, and
after the last the first again, as a slot chord selects (the session's terminal takes the keyboard
when it has one, else the list). With none, the key bar says `no session needs you`; when only the
selected one needs you it stays selected and the key bar says `no other session needs you`. When
`needYou.count` is greater than the order — the filter or the folded Earlier hides some —, the key
bar says how many instead: `2 more that need you are hidden by the filter or the fold` (`1 more that
needs you is hidden …`), with none shown `2 that need you are hidden by the filter or the fold`.
While a dialog of stage D is shown it is a window chord like the others (12.9): it says `close the
edit first (Esc)` and selects nothing.

A row that needs you has a coloured left bar, a bold title and the reason on its second line.

The page's marks and words (stage B, plan B13): the bar and the reason's line are in the reason's
colour — an ask in the waiting colour, a finished turn in green, an end of the window in the crash
colour (the mockup's) —, the line is 12.2's, and the title bar's counts start with `3 need you`
(`1 needs you`), with a dot before it that the style sheet draws in the colour of an ask (a mark,
not a character of the text); the window title is `(3) skydeck`, and `skydeck` while none needs
you. A list without `needYou`, or a row without `attention` (a server of stage A), shows no count
and no mark.

### 12.5 The header

For the selected session: the title (a click edits the label, stage D), the group chip (dashed
`+ group` when none; its tooltip says when the group comes from the title; a ✎ beside it edits
it), the state pill, the project directory, "opened <time> · last active <age>", the short id (a
click copies the whole id), where the title comes from, from follow-up F16 the flags the session
was started with (below), and buttons Note and Done / Undone. Then
two lines, ruled by the lead on 2026-11-15 (the user may change it), so that the header keeps one
height from stage D on (the next paragraph): **one line for the pull requests** — from follow-up
F18 the session's ticket first (below, with its status from F19), then the window's chip (12.3),
then the open ones side by side as far as they fit (`repo #n · failing`; a click opens one, 9.6),
and at the line's right end
the ticket's button (`+ ticket`, `Ticket` while one is set) and a button that opens the
pull-request dialog (`+ PR` while none is attached) — and **one line for the note**: its first line (a click edits it), or a quiet hint
while there is none. Both lines are there for every session, with and without pull requests or a
note. What does not fit lies one click away in a dialog over the page, which never changes the
terminal's size: the pull-request dialog lists each attached pull request on a line of its own
(`repo #n · approved, green · checked 4m ago`, or `can't read · last read 3h ago · gh: HTTP 502`),
the merged and closed ones folded into `30 merged, 2 closed ▸`, with × to detach one, ↻ to read
their status now, and the field that attaches one; the note's dialog holds the whole note.

Stage A's header (19) has one height for every session and window width, so that the terminal
area under it does not jump between sessions and the page knows its size before a terminal is
shown: the directory is one line, cut with an ellipsis when it is long (the whole path stays in
the page, is selected and copied whole, and is its tooltip); the short id is never cut (ruled by
the plan owner, review of plan task 29).

**The flags it was started with** (follow-up F16; the details
ruled by the lead and on its reviews). The last item of the second line, after the short
id: the flags the session was started with as the hook recorded them (design 5.3) — first the ones
a resume passes on again (design 7.6; `passedOnFlags`) with their values, in the order recorded,
then the ones the recording knows only by name (in no table: a resume does not pass them on), bare,
as recorded (ruled: a session started with a flag never shows nothing) — as one text, `--model opus
--permission-mode plan`; a value is shown as recorded, one with spaces not quoted. They are the
flags of the latest start that has a recorded command line (a resume in another terminal with other
flags replaces them); a session whose start was never recorded shows nothing, as one started
without flags (its resume card says the original flags are unknown). The recording keeps neither a
prompt nor any flag a resume removes (design 7.6: the ones that pick, name, move or place the
session, such as `--resume`, `--continue`, `--session-id`, `--name`, `--worktree`, `--tmux` and
`--bg`), so those are never shown, also when they were typed into the New form. In the short id's
lighter grey (ruled: a side note, not the folder's grey) and its monospace font, with no label
before it and no box, the line's own gap before it whether "id copied" shows or not. At most 40
characters over the whole — characters as they are seen, a joined emoji or a letter with its mark
being one —, the last of them `…` beyond that; its tooltip holds the whole text uncut, `Started
with: <flags>`, and when there are names it does not know, a second line `Not recognised, not
passed again on resume: <names>`. "Started with": a model changed inside the session later
(`/model`) is not seen, and the tooltip claims no more. Not messy (the owner's condition): it never
adds a line and never moves what the line showed before it — it takes only the room the other parts
leave (its gap included), so when the line is short of room it is the first thing cut, down to
nothing before the directory or the short id lose a character; and it shows only once it has the
room of six characters (then six or more, the last of them `…` when cut, or all of a shorter text),
and nothing before, never a bare `-…`. A session with no recorded flag shows
nothing: no empty item, no separator left behind. It is shown for the session the pane shows,
whatever its state (running in the window, in another terminal, an ended terminal of the window, a
session not running), except while the resume card prints the command under "Will run" (12.6),
which holds the flags and names the ones it does not pass on: no flag is printed twice in one view.
A resume card without the command — a word skydeck cannot print or no known directory ("skydeck
cannot show the exact command"), or an expired session, whose card has no "Will run" — leaves the
item shown (ruled on review 2), so the flags are never shown nowhere either. The flags reach the
page as `list`'s `selected.launchFlags` and `selected.unknownFlags` (8.2.3), sanitised by the server
and again by the page, and are shown only as text; nothing new is stored, and `skydeck show`, `ls`
and the list's rows are unchanged.

Editing (stage D) uses the step 1 rules and functions: a label or group that design 7.1 refuses is
refused with the same message; a note is edited in a text box instead of `$VISUAL`, saved as typed
(an empty note is no note), and a save is refused when the stored note changed since the edit
began ("the note was changed elsewhere while you edited it; your text is still in the box"); `+ PR`
attaches with origin `manual` and fetches at once (design 7.3). Done shows an Undo toast. An edit
acts only on a session the store knows (a `new` session not started yet: "this session has not
started yet; edit it once it runs"); a note whose stored text already is the text sent, or whose
text stores nothing (empty or white space) while there is no note, is saved with nothing written (a
save sent again after its answer was lost, also one that cleared the note), and between two windows
label, group and done are last-write-wins, as two commands are. That fetch, and ↻'s explicit
refresh, run in the background on the server, so that the dialog answers at once: one at a time per
server, a request the running one already covers joining it and every other waiting to run
together when it ends, all of them ended by the server's stop; one that fails shows as `can't
read`, as after `pr add`. A note saved in the window removes the note file a failed editor kept,
as `note --set` does (design 7.1).

**The ticket link** (the details ruled by the lead).
The group stays only a group (design 7.1), and nothing in the core depends on one ticket system
(design 1): with `ticketUrl` set (16.4), the group chip opens the session's ticket. When the group
holds a ticket key — the text `groupPattern` matches in it, made of letters, digits, `-`, `_` and
`.` and starting with a letter or a digit (the default pattern matches nothing else) — the address
is `ticketUrl` with `{key}` replaced by exactly that text, as 9.6's rule re-serialises it, and only
while it has no user name or password and its host is the one the parser reads in `ticketUrl` with a
stand-in for `{key}`, and while `ticketUrl` holds no white space or control character and leaves no
percent-escape unfinished right before `{key}` (a key would finish it: `…/%2{key}` with `e.` makes
`..`). The chip then shows that it is a link (an arrow after the key, underlined), its tooltip is
the address, and a click on it that selected no text opens it where any link opens (9.6: `act
open-link`, which the server checks again; the default browser, or Edge with `window.links`
`"edge"`). Without a link the chip is plain text.
The chip never edits: the ✎ beside it and `g` edit the group, with and without a link, and while
there is no group the dashed `+ group` sets one. So nothing a program wrote into a title can add a
host, a path or a query: the key holds no `/`, `?`, `#`, `@`, `:`, `%` or white space, and the URL
parser, not the text, decides that `{key}` stands after the host (16.4). The address reaches the
page as a string of `list` and is shown only as text; it never becomes markup. skydeck itself reads
nothing from the ticket system: no API, no login (a status, when one is read, comes through `gh` or
through a program the user configures: "A ticket's status" below). `skydeck show` prints the
address as `ticket:` after `group:` while the session has no ticket of its own (below; its `--json`
does not hold the group's link), followed by its status when one is read (below).

**The ticket of a session** (follow-up F18, step 1;
the details ruled by the lead). A session has at most one ticket, which the user sets: a JIRA
issue, a GitHub issue, a ticket of any tracker — whatever has an `http` or `https` address. It is
set from one text (design 7.1): a whole link, taken as the window opens it (linkToOpen's form, 9.6:
the host in lower case, a default port dropped, a space encoded) when the window may open it, at
most 2,048 characters, with no control character and no user name or password; or a bare key
(the key rule above), which becomes `ticketUrl` with the key filled in by the rule above — the
address is what is stored, so a later `ticketUrl` moves no stored ticket —, refused without a
`ticketUrl` with what to do (`a ticket key needs ticketUrl in config.json: set ticketUrl, or give
the whole link`); an empty text removes it; anything else is refused with its reason (`a ticket
link must start with http:// or https://`, `a ticket must be one line`, `a ticket cannot contain
control characters`, `a ticket link is at most 2,048 characters`, `a ticket link cannot hold a user
name or a password`, `the window does not open this link: …`, `ticketUrl makes no link the window
may open from this key; give the whole link`, `not a ticket: give an http or https link, or a key
like ABC-123`). Setting one replaces the one before. It is stored (10.2, migration 3).

Its **chip** starts the header's third line, before the pull requests: a short name and ` ↗`, in
the accent colour with the name underlined, as the group chip's link; the whole address is its
tooltip, and a click on it that selected no text opens it as the group chip's link does (`act
open-link`). The name is worked out from the address by one function on the server and sent with
it: the key when the address is the configured `ticketUrl` with a key filled in; else `KEY` for a
path `/browse/KEY`; else `repo #n` for `github.com/owner/repo/issues/n` or `/pull/n`; else the last
part of the path that is not empty, decoded, at most 24 characters with `…`; else the host. It is
only ever text (sanitised by the server and again by the page). A session without a ticket shows
nothing there, and what the line shows today keeps its place; when the line is short of room the
open pull requests give way, whole, before the chip loses a pixel (it takes its room first). Below
that it is the room of the chip, the pull requests' chip and the two buttons that counts, measured
in the page suite's Chromium with the list 400 px wide and three open pull requests: the ticket's
chip is whole down to a window of about 760 px, then cut with an ellipsis (at 720 px its arrow
alone, at 700 px an empty pill); `Pull requests` is whole down to about 700 px with a ticket and
about 690 px without one (on `main` before F18, about 620 px: the new button takes about 70 px of
every session's line), and narrower the line is clipped at its end. The header's four lines and
their heights never change, at any width (ruled by the lead: no layout change in F18; a narrower
button or another place for it is the owner's later choice). The name is one part of the
chip, so that a status can stand beside it (follow-up F19, below; those widths are F18's, of a
chip without a status). The button
`+ ticket` (`Ticket` while one is set) stands just before the pull-request button, which keeps its
place at the line's end; it and `t` in the list (12.9) open the ticket's dialog: one field holding
the ticket's address (empty while there is none), its placeholder `a link`, and `, or a key like
ABC-123` only while `ticketUrl` is configured (`list.selected.ticketKeys`); Enter saves, Esc and
Cancel close, a refusal shows the server's words under the field and keeps the text, as in the
other dialogs. The group chip and its link are unchanged: the two stand side by side, the group's
link worked out from the group as above, the ticket the one the user set. The filter (12.8) finds a
session by its ticket's name and address, and by its status' text (F19); `skydeck show` prints the
ticket as `ticket:` (in place of the group's link) and in its `--json`; `skydeck ticket set <ref>
<link-or-key>` and `skydeck ticket clear <ref>` set and remove it, and `t` in the interactive list
(design 7.4). Nothing about a ticket is read from a transcript; its status, where a provider reads
one, is fetched and shown (below, follow-up F19), and nothing else about it is fetched.

**A ticket's status** (follow-up F19, step 2 of the ticket
field; the details ruled by the lead). *Whose.* The ticket whose status is read is the session's
own (above), else the address its group gives through `ticketUrl` (the group chip's link, above).
*By whom.* A status exists when a provider takes that address, tried in this order: the first rule
of `ticketStatus` (16.4) whose `match` is the start of the address — a program the user names —;
else, for an issue's address `https://github.com/<owner>/<repo>/issues/<n>` (a pull request's key
rules, with `issues` for `pull`: the host in any case, with or without `www.`, anything after the
number stripped), GitHub, through `gh`. The address of a pull request (`/pull/<n>`) gets no status,
even when a rule's `match` would take it, and an address no provider takes has none: everything is
then as F18 left it. One fetch and one cached row (10.2) belong to an address, however many
sessions share it. skydeck holds no tracker's own code but GitHub issues' and handles no
credential: a program reads its secret from a file its owner keeps, never from `config.json`.

*The program.* A rule is exactly `{ "match": …, "command": [ … ] }`. `command[0]` is the program — a
name looked up on `PATH`, or a path, a relative one being relative to the user's home directory —
and the rest are its arguments; in the arguments only, never in the program, every `{url}` becomes
the address and every `{key}` the ticket's KEY (ruled on review 2: never the chip's display name),
both in one pass, so that what was put in is not read again. The key (`ticketKeyOf`) is the part
the address holds in the place of the configured `ticketUrl`'s `{key}`; else the `KEY` of a path
`/browse/KEY`; else the last part of the path that is not empty, as written (not percent-decoded),
whole, when it passes the key rule above (letters, digits, `.`, `_`, `-`, starting with a letter or
a digit: never an option such as `--help`) and holds at most 128 characters. When a rule's command
uses `{key}` and the address gives none, the program is not run and the read fails with `the
ticket's address gives no key for {key}; use {url} in the rule`, the old status kept; a program
still checks what it is given. The runner starts it without a shell, as a list of words, so that
an address with spaces, quotes, `;` or `$(…)` arrives as one argument, unchanged; its standard
input is `/dev/null` (closed); it runs in the server's environment (the command's own for
`skydeck ticket refresh`; the launcher's variables that 7.4 strips for a terminal's program stay
in it) with the user's home directory as its working directory, for 10 seconds; of its standard
output and of its standard error the first 4 KiB (4,096 bytes) are kept, the rest is read and
dropped. skydeck kills only the program it started — at the 10 seconds and at the server's stop —,
not what that program started (ruled: a process group is a later choice of the owner's): a script
bounds what it starts (`curl --max-time 8`, `timeout 8 …`) or ends with `exec`. The first line of
standard error is kept in the database and shown (never logged): a program must not print its
secret.

*The answer's contract.* The first line of the program's standard output is the status' text: a
carriage return at its end dropped, escape sequences and control characters dropped and tabs turned
into spaces (design 7.4's sanitiser), trimmed, its first 40 characters kept. The second line, if
there is one, is the category, one of six words — `todo`, `doing`, `review`, `blocked`, `done`,
`closed` —, trimmed and compared in lower case; any other second line means no category (grey); the
lines after it are ignored. A **failure** keeps the status the address had and its age and saves
the failure's words, which the window shows: for a timeout, `the status command timed out after 10
s`; for a program that is not found, `the status command <its last path part> is not installed`;
for an exit other than 0, the first line of standard error that has anything on it once sanitised
(at most 200 characters, a cut one ending in `…`), else `the status command exited <n>` (`the
status command was killed by a signal` when a signal ended it); for an exit 0 with an empty first
line, `the status command printed no status`; for a program that cannot be started, `the status
command could not be run: <the first line of the reason>` (not executable: `… could not be run:
spawn <the program> EACCES`, the runner's words; test/ticket-status-programs.test.ts).

*GitHub issues.* `gh api graphql --hostname github.com`, in a batch of its own — the pull
requests' query is not changed —, one alias for each issue, `i<n>: repository(owner: …, name: …) {
issue(number: …) { state stateReason } }`, at most 50 to a call, 10 seconds, `gh` in the caller's
environment without `GH_HOST`, `GH_FORCE_TTY` and `CLICOLOR_FORCE` and with `GH_PROMPT_DISABLED=1`
and `NO_COLOR=1`, as for the pull requests. `OPEN` reads `open` (category `doing`); `CLOSED` as
`COMPLETED` reads `closed` (`done`), as `NOT_PLANNED` `not planned` (`closed`), as `DUPLICATE`
`duplicate` (`closed`), without a reason `closed` and no category; a reason or a state not known
here reads as its own words in lower case with `_` as spaces, and no category. A failure has the
pull requests' words: `gh timed out after 10 s`, `gh is not installed`, `gh returned output skydeck
could not read`, the first line of standard error (when `gh` is not logged in: `To get started
with GitHub CLI, please run:  gh auth login`), `gh exited <n>` (`gh was killed by a signal`), `gh
could not be run: <the first line of the reason>`, and, for an issue GitHub does not find,
GitHub's own message, else `not found`. Two addresses of one issue are asked once.

*When it is read.* At once, in the background, when a ticket is set or changed in the window (`act
ticket`) and a provider takes the new address (`skydeck ticket set` reads nothing, ruled by the
lead: F18's behaviour and output; the status then comes with the server's next round while a page
lists the session, or with `skydeck ticket refresh <ref>`); by the server's tick (10.1), for the sessions the pages list, when a
status is due — never tried, or its last attempt older than `ticketRefreshMinutes` (16.4; 10 by
default), or, when its category is `done` or `closed`, older than 12 hours instead —; and whatever
its age, on demand: the dialog's ↻ (below; `act ticket-refresh`, 8.2.3) and `skydeck ticket
refresh`. The server runs one read at a time, so one status program at a time, and starts at most
5 programs in a round of its tick (10.1); `skydeck ticket refresh` runs its own reads in its own
process, one after the other. A result the server saved reaches every page within a second, as an
edit does; one a command saved, with the server's next refresh (within 2 seconds, 10.1). Nothing is read for a session no page lists, and nothing at all for an address no
provider takes. The server reads `ticketStatus` and `ticketRefreshMinutes` at its start only:
after changing either, `skydeck window --restart`.

**The ticket's chip with its status.** Once a status is known the chip reads `<name> · <status> ↗`
in the category's tint (12.3: the text colour and the faint background of the tint; grey, `--dim`
with no tinted background, for `todo`, `closed` and no category) in place of F18's accent colour,
the name still underlined and the status not. Its tooltip holds the address, then `<status>,
checked <age> ago` (the age of the last attempt, which is the last read when it succeeded); after
a failure `status not read: <words>` and, under it, the last known status and its age (`<status>,
checked <age> ago`, the age of the last read that succeeded). While no status is known the chip is
F18's (accent colour, underlined name, ` ↗`), its tooltip the address and, after a failed first
attempt, `status not read: <words>` under it. A ticket that comes from the group (not stored) has
the chip only once a status is known or an attempt was made, so that a session whose ticket no
provider reads looks as F18 left it; and that chip shows the STATUS ALONE (ruled by the lead on
2026-11-19, amending T6: the group chip of line 1 already names that ticket in most sessions, so a
second `ABC-123` would name the key twice) — in the category's tint, with no name and no ` ↗` —,
or `status not read` in grey while every read failed; its tooltip holds the ticket's name first,
then the address and the status' age or the failure's words as above. A click on it opens its
address, the button stays `+ ticket` (it names the ticket the user set), and the group chip and
its link do not change. The header
keeps its four lines and their heights: when the line is short of room the open pull requests give
way first, then the status part is cut, with an ellipsis, before the name (it shrinks a thousand
times as fast), and only then the name; the chip may be up to 36em wide with a status (24em
without, as in F18).

**The ticket dialog's status line.** While a provider reads the session's ticket, the dialog (`t`,
the header's button) has, above its field, a line `In Progress · checked 3m ago` — after a
failure `status not read: <words> · last <status>, checked <age> ago`, or `status not read:
<words>` while no status is known, and `status not read yet` before any attempt —, in the
dialog's own grey (it takes no tint: the header's chip and the row's carry the colour), one line
cut with an ellipsis where the dialog ends and whole as its tooltip, and a ↻ at its right end (its
title is `read its status now`); without a provider the line and the ↻ are not
there. ↻ sends `act ticket-refresh`, is disabled while the answer is awaited, leaves the keyboard
in the field, and a refusal shows under the field as the dialog's other refusals do. The line is
drawn again by each `list`, so that a saved result shows in it.

**In the commands.** `skydeck show` prints its `ticket:` line with ` · <status>` after the address
and, after a failure, a line under it, `status not read: <words>`, indented to the values' column;
its `--json`'s `ticket` (still only the ticket the user set, F18) gains `status`, `category`,
`okAt` and `triedAt` (ISO times) and `error`, each null when not known, also when no provider reads
it. `skydeck ticket set` prints F18's line and reads nothing; `skydeck ticket refresh <ref>`
reads that session's ticket now — the one set, else its group's — and prints `<short id> ticket:
<address> · <status>` (after a failure ` (status not read: <words>)`), or `<short id>: no status is read for this session's ticket`;
without `<ref>` it reads the ticket of every session, done ones included (as `skydeck pr refresh`
reads every session's pull requests), each address once, one program after the other (in the
command's own process: the server's one-at-a-time rule is the server's), and prints `fetched <n>,
failed <m>`. `show`, `ls` and the interactive list print what is cached and run
nothing; `ls` is unchanged.

### 12.6 The right side

- **A session open in the window**: its terminal. The page attaches to the terminal it shows and
  keeps the terminals it has shown attached (their xterm.js instances live), up to 8, the least
  recently shown detached beyond that; while the window is hidden (minimised) it detaches all but
  the selected one. Switching between attached terminals is instant; switching to another costs one
  snapshot (7.3).
  The terminal's text keeps a margin in the terminal's own background: 8 px above and below,
  10 px at the left, and 10 px between the text and the scroll bar's room, which stays at the
  terminal's right edge and is always kept, whether the scroll bar shows or not (so without one
  the text ends 24 px or more from the edge; ruled by the plan owner, F2's review 1: the size must
  not depend on the scrollback). The size is in whole cells, so at the right and the bottom the
  margin is wider by what is left of a cell. The size the page proposes is counted inside it
  (8.2.6); what lies over the terminal (its bars, the hint, the find bar) keeps its place in the
  terminal's box. A wheel in the margin does what a wheel over the nearest cell of the text does,
  once: it scrolls the scrollback, or in the program's mouse mode reaches the program as one
  report (ruled, F2's review 2). The lines that frame the terminal — the list's right edge, the
  line under the header (in every pane: one header, one colour; and under an ended bar), the line
  over the key bar — have one colour of their own (`--edge`), softer than the page's other lines
  in both colour schemes; the focused zone's coloured top edge (12.9) is the focus sign and keeps
  its colour. The notice bars over the terminal keep their own line (`--line2`): they lie over
  the terminal, not on its frame, and must stand out from its text (ruled, F2's review 1). Follow-up F2:
  before it, the text touched the list and the header, and xterm.js's
  own style painted the 4 px and 2 px it had there black, which read as a hard border, above all
  in the light scheme.
  What the server says about a terminal is shown over that terminal, as the page's own text and
  never written into it (so that the page's screen stays the screen side's): the reconnecting bar
  (7.8) and "sized by another window" (8.2.6) while they hold; a gap or a newer keeper, which the
  server repeats after every snapshot, until a later snapshot is followed by the terminal's stream
  without it — and one the user dismissed is not shown again for a repeat; a dismissal is
  forgotten once a snapshot's repeat ends without that notice, and a notice that comes in the
  stream shows again (a new occasion). The page cannot tell a new occasion that comes right
  after a snapshot, before the terminal's stream goes on, from the repeat of one dismissed: it
  stays hidden then (a named limit). And `input-full` ("this terminal is not taking input at the
  moment: not all of what you typed or pasted reached the program", true of all three reasons the
  server takes no input) until input sent after it was taken (the server answers input it
  refuses at once; plan task 28). Of a paste that is refused in part, the program gets the parts
  that were taken and may be left inside the bracketed paste (no end marker): the server takes
  or refuses each `input` message on its own and answers only a refusal, and the page has sent
  every part of the paste before the first refusal can come, so it cannot hold back the rest or
  send the end marker later (a named limit).
- **A session running in another terminal**: the card of 7.9.
- **A session not running**: the **resume card**: how it ended (exited normally, ended
  unexpectedly, mid-turn), last activity, the directory, the exact command (design 7.6's), the flags
  that will not be passed on, a warning when the transcript is expiring; for an expired session the
  button is disabled. A single click on a row selects it and shows this card; it does not resume
  (a resume costs a process, and history is easy to misclick). Enter, a double click or "Resume
  here" resumes (11.3). Refusals and launch failures show their lines on the card.
- **An ended terminal**: its last screen, dimmed, under the bar of 7.8 (Resume, Close). Until
  the page has the terminal's exit the bar says `claude is not running in this terminal`. A
  selected session the list does not show (a filter, the chips, done sessions hidden, a folded
  Earlier; 12.9) has its row in the list's `selectedRow` (8.2.3, stage E): its terminal of the
  window is shown with its header and, once ended, under this bar with Resume and Close, as for a
  listed row. Known limit, narrowed by stage E: a session the view model does not list even with
  done ones shown (an ended terminal of a session without a transcript) has no `selectedRow`, so
  while the window shows its ended terminal the bar has no Resume, and Close only once the page
  has the terminal's exit — the bar is drawn from the row, not from the terminal (stage A's plan,
  contract 2.9 `endedBar(row, exit)`; accepted by the plan owner, review 2 of plan task 29).
- **New** (Ctrl+Shift+N or `+ New`): a form with the directory (a list of the known project
  directories, most recent first, defaulting to the selected session's — from stage E also one
  the list does not show while a terminal of the window shows it (12.9) —, or a typed absolute path),
  the label, the group and extra flags. A label or group left empty, or holding only white space,
  is none (ruled by the plan owner, review of plan task 32: `skydeck new --label ' '` is refused,
  a blank form field is not). A label that starts with a ticket key gives the group
  through `groupPattern` (design 7.1) unless a group is typed. Flags are words separated by
  any whitespace (spaces, tabs, line breaks, the no-break space of a pasted text: nothing can hide
  inside one word);
  `'…'` and `"…"` group words (no escapes, no variables); a NUL is refused (no program can be given
  it); design 7.7's refusals apply. It starts in
  the window (11.3). Esc in the form closes it: the form is the page's own, not the terminal's
  (12.9; accepted by the plan owner, review of plan task 26).
  **Favourite flags** (follow-up F15): a ★ at the end of the
  flags field saves the field's whole text as a favourite, and a row of chips under the field
  shows every favourite, in the order they were added. skydeck keeps them for the window, in the
  store (10.2): every window and every server after a restart see the same list; not in
  `config.json`, not in the browser, and no command manages them. A favourite is one text of one
  or more flags as typed, trimmed. It is refused, with words the form shows, when it is empty,
  when the rule above cannot split it, when it holds a line break (U+2028 and U+2029 too) or
  another control character or a bidirectional control (what design 7.4's sanitiser takes away or changes, so that a chip shows
  the favourite as it is; ruled on review 2 of F15), when it is longer than 200 characters, when
  it has the same words as a favourite already (however spaced or quoted), as a thirteenth (at
  most 12), and when
  it holds a flag design 7.7 refuses (`prepareNew`'s rule and words: a favourite never holds what
  Start would refuse). The ★ (title "Save these flags as a favourite") is enabled only when the
  page sees none of those reasons but the last, which the server alone judges (ruled by the plan
  owner, F15: the page holds no copy of the flag table): its refusal is the form's result line,
  nothing is saved and the field keeps its text; a disabled ★'s title names its reason. A disabled
  ★ keeps the keyboard and its place in the order of Tab (it is `aria-disabled`), so that pressing
  it never moves the keyboard (review 2 of F15). A save's chip comes with the server's list, which
  can follow the answer by up to a second (8.2.3: at most a list a second): the page asks for it
  with a `view` after the answer, and the ★ stays disabled until it comes. A chip
  shows its favourite in monospace, cut at 28 characters with `…`, the whole text in its title. It
  is on while the field's words hold the favourite's words as one run, both split by the rule
  above — the page's copy of the rule, held to the server's by a test —, and off otherwise, every
  chip while the field cannot be split; its state follows the field as one types. A click on an
  off chip adds its text at the end of the field, one space between; on an on chip it takes every
  run of its words out of the field (so that the chip is off after it), the rest as typed; the
  page sets the field's text, which the browser's own undo (Ctrl+Z) then does not take back (a
  named limit, ruled on review 2 of F15). A
  chip's × (title "Remove this favourite"), shown on hover and while the chip has the keyboard,
  removes the favourite without asking; the form's hint line then reads `Removed <text> · Undo`,
  the text cut as the chip's, the whole in its hover title (ruled, F15), until the form closes or
  the favourites change again, and Undo puts it back at its old place. A removal and an Undo show
  in the chips at once, before the server's list: the page keeps the lists its own changes lead
  to until the server's lists have caught up, and a list that is none of them — another window's
  change — takes the Undo away. Removing a favourite never changes the field, also when the
  Delete or Backspace that removed it is held: the key's repeats remove no second favourite, and
  the keyboard never lands in a text field because of these controls (a key pressed elsewhere acts
  only when pressed again, 12.9): the ★ keeps it while it saves and once it is disabled (ruled
  on review 2 of F15); when the row that had it goes away (its last chip removed) the ★ takes it;
  Undo pressed from the keyboard gives it to the chip it puts back.
  Keys: the ★ and then the chip row come after the
  flags field and before Start; the row is one Tab stop, ← → move between its chips, Space turns
  the one that has the keyboard on or off, Delete or Backspace removes it; Enter is Start on the
  fields, the ★ and the row alike (Undo, a button after Start, takes Enter as a button does);
  Esc closes the form. None of the row's keys is a list key or a window chord, and the window
  chords act from the row as from the form's fields (ruled, F15). A click on a chip, its ×, the ★
  or Undo takes no keyboard. The form opens with the flags field empty and every chip off, whatever was
  used before: no favourite is ever on without a click, and Start sends the field's text, as
  before.
  **The group of the selected session** (follow-up F28, the owner's request of 2026-11-19: a new
  session that belongs with one already open should land in its group). When the session the
  form takes its directory from (the rule above, the same session) is in a group — its stored
  group, or the key at the start of its title, as the list shows it —, one chip with that group's
  name stands right after the Group field, on its line: in the look of a favourite's chip, cut at
  28 characters with `…` and, short of room, at half the line, its hover title and its name for
  assistive technology `Use the group <name>` with the whole name. It costs the form no height
  (the line keeps the field's), and a form without it is the form as before, but that once the
  list has a group the Group field shows the browser's own arrow at its right end while it has the
  keyboard or the mouse, as Directory does (what a list of completions brings). A click on the
  chip, or Enter or Space on it (a button, the stop of Tab right after the field), puts the name
  into the Group field in place of what is there (the page sets the field's text, which the
  browser's own undo, Ctrl+Z, then does not take back: the favourites' named limit); it starts
  nothing, takes no keyboard on a click and stays. Nothing is filled in by itself (the owner's
  choice of a one-click suggestion over a filled-in field: a wrong group would misfile the
  session, and a related session is the rarer case), so without the click the field is empty as
  before; Start sends the field's text, so a group the session has only through its title's key
  becomes the new session's own stored group. The Group field offers as completions the groups of
  the list's sessions (a closed block's too), each once, as the list shows them, the selected
  session's first, then in the list's order — as the Directory field offers the known
  directories. The form takes both when it opens, as it takes its directory.
- **Nothing, while the list holds no session at all** (follow-up F22): one muted line above the
  empty cards, `The selected session shows here.` (12.1), also while a session the
  list no longer shows (the last one marked done) is still selected; the New form takes the right
  side, and the line goes while it is shown. With sessions, nothing shown on the right still shows
  nothing (12.9).

### 12.7 The restore banner

At the top of the list while design 7.8's default set is not empty and the user has not dismissed
it for that boot: "Before the restart (last activity yesterday at 18:02) 3 sessions were open", a
checkbox per session
preselected by design 7.8's rule, "Restore 3" and "Not now". Restore runs as in 11.3; the sessions
show under Open as `starting…` and the banner reports each line of the run (started, timed out,
failed, stopped for memory). "Not now" stores the boot id (10.2): the banner does not come back for
that boot, and the switcher still offers "Restore 3 sessions from <time>" until the next WSL
restart. The time is the page's (plan C18): `today at 18:02`, `yesterday at 18:02`, `on 12 Nov at
18:02`, and `on 12 Nov 2025 at 18:02` in another year than this one, in the page's time zone, on a
24-hour clock.

The banner is the view model's (4.3: the page decides no rule). It offers design 7.8's default set
of the latest earlier boot, in list order, each session once, every text sanitised as the list's
are; the last activity is that boot's last event (11.1). An earlier boot whose id is not of the
form of `/proc/sys/kernel/random/boot_id` (a lower-case UUID) gets no offer: "Not now" could not
name it. "Not now" names the boot the banner offers and is stored only when that is still the one
offered (otherwise `this offer to restore is no longer shown`, nothing stored); while it is, the
banner is not shown, and the switcher still finds the offer. The server makes the banner again only
when its rows, the dismissal or whether a restore runs changed. While a restore runs — asked for by
any page or command — the banner says so and nothing more can be started from it. It has no Stop
control: `skydeck window --stop` ends a restore started from it (the sessions it opened go on); a
Stop in the banner is a follow-up candidate.

The page keeps the report lines it receives (`notice restore-progress`), as text, at most the last
200, in a report under the banner's place. A report ends at its `restore finished:` line (11.3:
every run ends with exactly one); when that line never reaches the page — the connection dropped,
the server stopped, WSL restarted during the run — it ends at the first `list` that says no restore
runs, with one last line of the page's own, `the end of this report did not arrive; the list shows
what started` (ruled on review 2 of plan C task 75). A `list` that says a restore runs never ends a
report, and no other line is a boundary; the line after an ended report starts a new one. The
report is drawn while it holds lines, whatever the banner says — none, or not shown: a restore
asked for by a command, or from the switcher after "Not now", shows its report too — and once it
has ended it has a × that removes it. A page that connects during a run sees that one runs and the
lines from then on (a named limit). The heading's `today` and `yesterday` are the page's clock's,
also when no list comes: the page draws the heading again while it is shown (ruled on review 2 of
plan C task 75). The banner and the report together take at most 40 % of the list zone's
height and scroll inside it, so that the filter and the list keep their room. Their controls take
no keyboard on a mouse click, as the page's other controls; "Restore" and "Not now" act once — not
while their own `act` waits, not on a key's auto-repeat, not on the second click of a double click.
A click sequence that began on the banner acts on nothing outside it: when its first click takes
the offer or the report away and the list moves up under the pointer, the later clicks of a double
click select nothing there and resume nothing (ruled on review 2 of plan C task 75).

The banner lies in the list zone above the list, in the list's width: it takes height from the list
(the list scrolls under it), never width, so the right side, the header's one height and every
terminal's area stay as they are — its coming and going sends no `resize`. A restore selects
nothing and moves no keyboard, in any page, also while a dialog is shown: its sessions are listed
under Open, and a command's restore does not move the window's selection either.

**The offer in the switcher** (stage E, plan E12; ruled by the lead on 2026-11-15). A restore
starts a process per session, so it is never one Enter away: the switcher lists the offer only in
command form — a text whose first character is `>` (nothing trimmed before it) lists commands, never
a session, and the offer when what follows the `>`, trimmed and lower-cased, is a start of
`restore` of at least one letter (`>r`, `> rest`, `>Restore`); `>` alone and `> foo` list neither,
and any other text searches sessions only (`restore drill` never brings the offer, ` >restore` with
a space first searches sessions for the word `>restore`). It is listed only while the banner is not
shown (after "Not now"), holds preselected entries and no restore runs; whether it is, is the
server's answer (`list.switcher.restore`, 8.2.3), so no tick of the banner can disagree with its
sessions. Listed, it is the switcher's first entry, `Restore 3 sessions from yesterday at 18:02`
(`1 session`; the time as the banner says it, on the page's own clock and in its time zone), and
Enter on it — Enter only: a click on it does nothing (ruled by the lead on 2026-11-15) — sends `act
restore` with the preselected sessions in the banner's order; a refusal shows in the key bar, and
the run's report where the banner's report is (it is drawn while it holds lines). A command that names no offer says so in the switcher, with the one command
written without quote marks (`> restore`).

### 12.8 Search

- `/` filters the list: title, group, note, pull-request repository and number, the ticket (its
  name and address, F18, and the text of its status, F19), directory, short id; several words must
  all match; while a filter is set it includes done sessions, unfolds
  every section and flattens every block (12.2: flat rows, each with its group, no card). A filter that leaves no row says so: `No session matches the filter.`
  (ruled by the plan owner, plan task 27).
- Chips: Running, Open PR, Has note, Show done.
- Ctrl+Shift+P opens the quick switcher over all sessions, ranked: needs you, open (by slot), not
  running (most recent first), done. Enter switches to a running one and resumes one that is not
  running (11.3).

The rules are the server's (4.3: `src/window/view/search/`, stage E, plans E2–E5 and E9); the page
sends what it wants to see in its `view` and draws the `list` it gets (8.2.3), deciding no rule.
One rule matches for the filter and for the switcher:

- **Words.** A search text is split at white space (spaces, tabs, line breaks, the no-break
  space) into words, each lower-cased. A row matches when every word, in any order, is found in
  one of its fields — the title, the group, the note (sanitised line by line), the directory, of
  each attached pull request `owner/repo`, its number and `owner/repo#number`, and the ticket's
  name, address (F18) and status' text (F19) (design 7.4's fields) — or, for a word of at least 4
  characters, when the session's id starts with it (the short id, and the whole id). Four
  characters, so that `fix 2` does not match nearly every session through the hex digits of its
  id. A word is never found across two fields. (Stage A had design 7.4's filter: one text, the
  fields of 7.4.)
- **Bounds.** A search text is at most 1,024 bytes of UTF-8; at most 16 words count (the page cuts
  a longer text after its 16th word and says so), each in its first 64 UTF-16 units; each field
  is searched in its first 16,384 units (a note in the first 16,384 units of its raw text). No
  pattern is ever built from a search text. The cost is linear in the rows, the words and the
  units searched, on the server's one thread at each keystroke; the switcher adds where the words
  are in each of the at most 50 titles it lists.
- **Chips.** Running: the row is in Open (running or starting, in the window or elsewhere). Open
  PR: at least one attached pull request is not known to be merged or closed (open, draft, never
  fetched, can't read; 12.3's open ones). Has note. Every chip set must hold, with every word. Show
  done is the fourth chip and is the view's `showDone`, the same state as the list key `a` and the
  footer's `show`.
- **Filtering** is a word or one of the first three chips. While filtering, done sessions are
  listed (with their `done` mark), every section is unfolded, no block is formed (12.2) and the
  footer of done sessions is not shown; nothing folds. Whether a list is filtering is the server's
  answer (`list.filtering`). The title bar's counts and the `need you` count (12.1) are taken over
  the rows listed without the filter, so that neither the title bar nor `(n) skydeck` moves when
  a filter lists a done row.
- **The switcher's ranking.** While the switcher is shown its text is part of the page's `view`
  (each change one `view`, answered at once), and the `list` carries its items: every session the
  list lists with done ones shown — also those the page's filter, chips, folded Earlier or closed
  blocks leave out — whose fields match every word of its text (all of them for none), ranked:
  needs you (in 12.4's order), open (Open's order: slots, then by opening time, then those
  elsewhere), not running (most recent first), done (not running and done, most recent first). At
  most 50, with how many more match. Each item carries where the words are in its title (every
  occurrence, overlapping ones merged, at most 32) and what this page's list would have to change
  to show it: the filter cleared, done sessions shown, Earlier unfolded. A text whose first
  character is `>` is a command and lists no session (12.7).
- **The switcher on the page** (stage E, plan E10, E11). Ctrl+Shift+P, or the title bar's
  `Switch…`, shows a panel over the page with an empty field, the items under the headings
  `Needs you`, `Open`, `Not running` and `Done`, and a footer that names its keys
  (`↑ ↓ move · Enter switch · Esc close`; `Enter resume here` on a session Enter would resume,
  `Enter restore` on the offer, then `3 more: type to narrow` when items were left out). An item
  shows the state icon, the group dim before the title when the title does not start with it, the
  title with the words found in it marked, a second line (a running session's state line, else
  `not running · 3d`) with the directory, and at the right the chip, the slot and the short id.
  `No session matches.` when nothing does. The page cuts the field's text as it cuts the filter's
  (1,024 bytes, then 16 words) and the footer says `only the first 16 words are searched`, or `only
  the first 1,024 bytes are searched` when the cut of the bytes came first (ruled by the lead on
  2026-11-15); the filter's cut after 16 words is said in the key bar (`the filter is cut to its
  first 16 words`).
  The highlight starts on the first entry, follows ↑ ↓ (at each repeat of a held key) and PgUp
  PgDn, is scrolled into view, and stays on its session while a list keeps it.
- **A pick** (Enter on the highlighted item, or a click on one; plan E10). It acts only while the
  list drawn answers the text the page last sent: an Enter pressed before waits for that list and
  then acts on its highlighted item, and a click on an item of an older list does nothing (ruled:
  a fast `orb`, Enter never picks an item of the list for `or`). The waiting Enter is dropped when
  the text changes, the switcher closes or the connection is lost, and while the page is not
  connected — the panel then says `skydeck's server is not connected` in place of its items —
  Enter does nothing (ruled by the lead on 2026-11-15). A held Enter picks once. The switcher
  closes; when this page's list does not show the picked row, the page first changes its view so
  that it does, as the item says — the filter and the chips cleared (the key bar says `the filter
  was cleared to show 1a2b3c4d`), done sessions shown, Earlier unfolded; then it selects the row
  and does what Enter on that row in the list does (12.6): a session with a terminal of the window
  shows it (an open one with the keyboard, an ended one under its bar), a session elsewhere shows
  its card, one that is not running is resumed into the window (11.3), and a refusal shows on its
  card (an expired one too), or in the key bar for a session the list does not show (one that went
  away). Enter resumes exactly the sessions with no terminal of the window that do not run
  elsewhere, and the footer's `Enter resume here` says so for the highlighted one: one rule for
  both (ruled by the lead on 2026-11-15). A session of a closed block — its first too, since follow-up F9 —
  needs nothing more: the server opens the block of the selected session (12.2), so the switcher
  is the way to a session Ctrl+Tab skips (one that no terminal of the window holds, 12.9). The
  second click of a double click on an item acts on nothing — neither the item nor what lay under
  it once the switcher closed —, and one on `Switch…` opens the switcher once.
- Each window has its own filter, chips, closed blocks, folded Earlier, done shown, selection and
  switcher; what it shows of each session is the same in every window (8.2.7).

Named limits: a zero-width or control character in a search text is part of a word (as in stage
A's filter), so a text that looks empty can hide every session. While filtering, stage D's toast
after `d` (`Marked done: hidden from the list…`) is untrue for as long as the filter lists the row.
A done session that needs you and that a filter lists shows its mark and Ctrl+Shift+J reaches it,
but the `need you` count leaves it out (it is not listed without the filter), so the key bar's
count of those hidden by the filter (12.4) is then one too low for each such row. The switcher
marks no match in a title whose length lower-casing changes. The server's automatic refresh of
pull requests (design 7.3) follows the rows the sections carry, and a selected session the list
does not show while a terminal of the window holds it (its header shows its pull requests, 12.9),
so the sessions a closed block hides — Open's running sessions too, and since follow-up F9
(2026-11-17) its first session too, which the card no longer draws — get no automatic refresh
until the block is opened, and neither do the switcher's items, as a folded Earlier's rows never
did (ruled on 2026-11-16, follow-up F3: unchanged by F9 but for its first session).

### 12.9 Keys and focus

No leader key: an app window reserves no keys (section 21; on a Windows PC every chord tested
reached the page, Alt+Space excepted). The window takes only Ctrl+Shift chords with a letter or a
digit, and Ctrl+Tab; never Alt, a bare Ctrl+letter, a function key or Esc, which belong to Claude
Code and the shell. Ctrl+Shift+- stays with Claude Code (undo).

**What the page cancels.** Because the page gets every key first, it decides what Edge does: a key
whose default the page cancels (`preventDefault`) does nothing in Edge, even Alt+F4 (tested: the
window stayed open). So the page cancels exactly the keys it handles itself (this table, the list
keys below) and the keys it passes to the terminal (xterm.js cancels those it sends), and no
other. Alt+F4 is never passed to the terminal and never cancelled, in either focus zone, so the
window closes with it as any window does. Alt+Space never reaches the page (Windows keeps it for
the window menu). The reload keys are the page's own in the list zone: F5, Shift+F5, Ctrl+F5,
Ctrl+R, Ctrl+Shift+R and the keyboard's BrowserRefresh key (alone, with Shift, with Ctrl) make the
page open a new connection, wait for the server's proof, and only then reload (15.3); in the
terminal zone F5, Shift+F5, Ctrl+F5 and Ctrl+R go to the program like any key while xterm.js has
the keyboard, while Ctrl+Shift+R and BrowserRefresh — for which xterm.js sends nothing and cancels
nothing (9.1) — are the page's there too, so that Edge never reloads the page by itself. When
something of the page has the keyboard in the terminal zone (the find bar, the New form, a card,
the ended bar), F5, Shift+F5, Ctrl+F5 and Ctrl+R are the page's own reload too, after the
server's proof, exactly as in the list zone. That Chromium also reloads on Shift+F5
and BrowserRefresh is from memory of its accelerator table, not verified; the page handling them
is harmless if Edge does not. A key that neither zone uses
keeps Edge's default: in the list zone Ctrl+W closes the window, which ends no session.

| Key | Action |
|---|---|
| Ctrl+Shift+P | quick switcher |
| Ctrl+Shift+J | next session that needs you; again goes on |
| Ctrl+Tab or Ctrl+Shift+O | back to the previous session (most recently used order) |
| Ctrl+Shift+1 … 9 | the session in that slot |
| Ctrl+Shift+L | focus between list and terminal |
| Ctrl+Shift+N | new session |
| Ctrl+Shift+F | find in the scrollback |
| Ctrl+Shift+C / Ctrl+Shift+V | copy the selection / send a raw Ctrl+V (image paste) |
| Ctrl+Shift+H | the key help |
| Ctrl+V, Shift+Enter, Ctrl+click | paste text, newline, open a link (9) |

Letters are matched by the character the key types (Claude Code's own rule). A digit is matched by
the character typed when that is a digit — on a Czech layout Shift on the number row types the
digits — and otherwise by the physical key (`Digit1` … `Digit9`), because on a US layout Shift+1
types `!`. The Ctrl+Shift letter chords (and Ctrl+R, Ctrl+V) are matched by the typed Latin
character, so on a layout whose letters are not Latin (Russian, Greek) they do not match — those
chords do nothing (Ctrl+Shift+1–9 and Ctrl+Tab still work), Edge reloads on Ctrl+R by itself and
Ctrl+V does not paste: a known limit, US and Czech are not affected. No chord is matched by a physical key alone that could type something else on another
layout: that is why the help is Ctrl+Shift+H and not Ctrl+Shift+/, whose physical key types `-` on
a Czech layout and would take Claude Code's Ctrl+Shift+-. If the user turns on the kitty keyboard
protocol in a later xterm.js and binds a `ctrl+shift+<x>` in Claude Code, the window shadows that
binding; the help says so.

Two focus zones; the terminal is the default. Clicking a running row focuses its terminal;
clicking a row that is not running focuses the list (so Enter resumes). Ctrl+Shift+L toggles; Esc
never leaves the terminal — while xterm.js has the keyboard; Esc in the page's own new form closes
the form (12.6). In the list: as in step 1's interactive list, ↑ ↓ `j` `k` move, `/`
filters, `l` label, `g` group, `n` note, `t` ticket (follow-up F18, 12.5), `p` attach a pull
request, `d` done, `a` show done; new in the window, Home, End, PgUp, PgDn, ← → (fold, unfold), F2
(label) and Esc (clear the filter, then back to the terminal). `/` gives the keyboard to the filter's field, where every key but Enter and
Esc is text; Enter and Esc there end the entry and give the keyboard back to the list (Esc also
clears the field), so from the field the terminal is one more Esc away (ruled by the plan owner,
plan task 27). Folding Earlier (← or a click on its header) with the selection inside it first
selects the line above it that can hold the selection — a row, or a closed caption (12.2) —; while a
filter is set nothing folds. On a block (12.2; stage E, plan E7 as ruled on 2026-11-16; as cards
since follow-up F9, 2026-11-17): ↑ ↓ (`j` `k`, Home, End, PgUp, PgDn) move through the rows and the
closed captions in the list's order, over open captions, and with nothing selected they start at the
first of them. ← on any session of an open card closes the block and selects its caption, as folding
Earlier first selects the line above it (in the list zone, where the user sees the selection move; a
click on the caption never moves it, 12.2) — except on a block that a session's unreported terminal
holds open (its first session too), where ← does nothing, selects no caption and says one of 12.2's
two lines — `this block holds a session that is still starting; it stays open`, or `this block holds
a terminal that ended at its start; close it first` —, and on a block whose group is over 1,024
bytes, where ← does nothing (12.2: it cannot be closed). → on a session of a card is as before: it
unfolds Earlier. On a selected closed caption, → or Enter opens the block and selects its first
session (a real session, selected as by a click; the keyboard stays in the list and nothing is
typed), and ← folds Earlier — inside Earlier it selects the line above it, a row or a closed caption
—; an auto-repeat of ← does nothing there, so that a held ← that has just closed a block goes no
further and does not select a session the user did not choose, and a held Enter opens the block
once, its repeats never resuming that session. Each of these gestures reaches the server in ONE
view (ruled on 2026-11-17, rulings 1 and 3 of F9): ← sends the block's closing with `selected:
null`, and →, Enter and a click on the selected caption send the block's leaving `closed` with its
first session's selection, so that no view of theirs names a block closed while a session of it is
selected. Every other way a session of a closed block becomes selected — a click on a row of the
card still drawn open right after ←, a slot chord, Ctrl+Tab, Ctrl+Shift+J, a notification's click,
the switcher, a resume's answer — keeps the way it had before F9: its view may name the block closed
with that session selected, and the server opens the block for the selection (12.2). Until the list
that answers the view comes, the list's keys move from where the page last drew the selection:
right after ←, the card still drawn open counts as its caption (ruling 2); right after →, Enter or
the click — or a slot chord, Ctrl+Shift+J or a notification onto a closed block's FIRST session —,
that closed caption counts as the selected line, ↑ ↓ step from it, and ← closes the block again and
selects its caption, never folding a section (review 2 of F9). `d`, `l` and F2, `g`, `n`, `t` and
`p` do nothing on a selected caption: no session is selected, and the key bar says `no session selected`. The pane then shows a small card of the group — its name, `3 sessions`, ` · 1 needs
you` in the needs-you colour while any of its sessions needs you, and `→ or Enter opens the group`
—, no terminal, and nothing on it has the keyboard; the key help's line reads `fold or unfold
Earlier; close or open a group`. The mouse: a click on a caption line opens or closes its block
(12.2; the whole line is the control, and the second click of a double click does nothing); it never
moves the selection, except on the selected closed caption itself, where it opens the block and
selects its first session as → does — the list zone takes the keyboard first, so that no terminal
gets it —, and with the block holding the selected session, any of its sessions, the click to close
is refused with `this block holds the selected session; it stays open`. Ctrl+Shift+1–9 select the
session of that slot also while a closed block hides it, and its block opens (12.2); a session whose
terminal has not reported a session is never hidden (its block is drawn open, 12.2), so its slot
chord finds its row as any drawn row's. Ctrl+Tab skips a session of a closed block — its first too —
that no terminal of the window holds (the page never knows a closed block's sessions), as it skips a
row a filter or a folded Earlier hides; a session that a terminal of the window holds it selects,
and its block opens, as for every other selection of a hidden session (ruled on 2026-11-16).
Ctrl+Shift+J, the switcher, a notification's click and a resume are as before: they open the block
of a hidden session first, now also when it is the block's first. While filtering (a word or a chip,
12.8) nothing folds and no block is formed, so ← and → do nothing. The chips under the filter field
(12.8) take no keyboard on a click: the keyboard stays where it was (in the field, on the list, in
the terminal). They are buttons: Tab from the filter field reaches them, Enter or Space presses
one, and while one has the keyboard no list key acts, as on any button of the list zone. The selection is never on a row the
list does not show: when the selected row stops being shown otherwise (a filter, done sessions
hidden again, the row gone from the list), no row is selected — the right side shows a terminal
of the window that holds the session, else nothing (but 12.1's line while the list holds no
session at all) —, Enter does nothing, and ↑ ↓ start from the
first row shown (ruled by the plan owner, plan task 27); when the list shows the row again, it is
selected again. From stage E the right side takes such a session's row from the list's
`selectedRow` (8.2.3): its terminal is shown with its header (stage D's, so that the header's
controls and their dialogs edit that session) and its ended bar with Resume and Close (12.6); a
session without a terminal of the window shows nothing (but 12.1's line while the list holds no
session at all), never its card. The header's Done on such
a session takes its toast from the row, since it is in no section: `Marked done. Stays under Open
while it runs; …` while it runs or starts, else `Marked done: hidden from the list. …` (ruled by
the lead on 2026-11-15). The list keys (`l`, F2,
`g`, `n`, `t`, `p`, `d`) act only on a row the list shows: on a hidden selection, and on a selected
caption, they say `no session selected` and send nothing. A named limit: when Ctrl+Tab, a slot chord or a click on its
notification selects a session the list does not show that runs again in another terminal while an
ended terminal of the window still names it, the right side first shows that ended terminal as
stage A did (no header, no Resume), until the list that answers the new selection comes —
a few milliseconds —, then nothing, the focus zone still the terminal's: the server gives an ended
terminal to no session that runs again elsewhere, and such a session gets no card here (a
notification's session then counts as seen after 1.5 s, 12.4, though nothing of it was shown). One exception, ruled by the lead on 2026-11-15 (the user
may change it): when this page's own `d` in the list has marked the selected session done — its
answer came, and the list that holds its result (one that arrived since the act was sent — the
server sends it before the answer, unless a list went to the page within the last second — and no
longer shows the row as not done in its section, since one that still does is older than the write;
else the next one, which the page asks for with a `view`) no longer has the row, while that session is
still the selected one (moved away meanwhile, the selection stays where the user put it) — the row after it in the
same section is selected, else the one before it in that section, else none; never a row of Open.
The Undo of that `d` selects the session again once it is back in the list, if the selection is
still where that `d` left it (the row it selected, or none); if the user moved it meanwhile, it
stays (ruled for plan D task 37). That list decides once: a row it still has (running, under
Open) moves nothing later either; a run of `d` marks one row each time (ruled 2026-11-15 on review 2
of plan D task 37). The header's Done leaves the selection to the main rule. The second click of
a double click on a button of the header, or on a pull request's × in its dialog, does nothing
(ruled for plan D task 38), nor does it on a block's caption, wherever the list has moved under
it: such a double click opens or closes the block once, and its second click selects no row, takes
no keyboard and resumes nothing (ruled for plan E task 97; the caption since follow-up F9, before it
the `+n more` line and `×n`). A held
`d` acts once, at its first keydown, and not while its own action for that session waits. Enter changes meaning: it shows a running session's terminal, or resumes one
that is not running (12.6), where step 1 opened a detail view (the header is the detail). Step 1's
`R`, `r` and `q` have no use here: Enter resumes, the window refreshes by itself, and a window is
closed as any window. The focused zone has a
coloured top edge, and the key bar says `Focus: list` or `Focus: terminal`. The keyboard follows
the zone: where what had it goes away, or a click selects nothing, the page gives it to the zone's
holder (the terminal, else a form's first field, else the zone itself; never a button). But the
page never moves the keyboard by itself while visible text of the page is selected (a bar's
command, a notice, the header): giving the terminal's text control the keyboard would take the
selection away, and the Ctrl+C meant to copy it would reach the program. Meanwhile the keyboard may
be on nothing; the next plain click, a zone chord, or the next render once nothing is selected
gives it back. The user's own actions move it whatever is selected: a zone chord, Esc closing the
new form, and the terminal of a resume or new started from the page (11.3), unlike one that only
a list brought (ruled, plan task 26's review 2). That holds while the user waits for it: once they
select another session, or the connection is lost, its terminal is like one a list brought. A key
pressed while the keyboard was not on the program's own holder (in the list, the form, the help, a
text field, a button — the terminal's find bar too) reaches the program only when it is pressed again:
when that key moves the keyboard there (Enter on a running row or one that resumes, Esc back to
the terminal, the new form's Enter, the find bar's Esc or Enter), or anything else does while it
is held, its repeats and its release are the page's, and the next press is the program's; a held
Esc on the list with a filter only clears the filter. A held chord acts once, at its first
keydown. Ctrl+Shift+V sends its raw Ctrl+V only while the terminal has the keyboard — never from
the list, the form or the help; in a text field the browser's own Ctrl+Shift+V stands (ruled, Z1
of plan task 26).

**The dialogs** (stage D, plan D2; ruled by the lead on 2026-11-15 on the plan's review A). The
label, group, note and pull-request dialogs (12.5) lie over the page and are modal: a scrim covers
the window and takes clicks without acting, and the page under it takes no keyboard; a click inside
the dialog that selects no text gives the keyboard back to its field, and whenever nothing has the keyboard (a click on the key help or the toast, a disabled button) the next key gives it back to the field first, while a drag selects its text
as anywhere. While a
dialog is shown the page moves the keyboard nowhere by itself — not for a resume's or a new's
answer, a list or a render: the rest of a note must never be typed into Claude Code, whose line
breaks would submit it — and acts on no list key (`j` or `d` typed in the field are text). Every
window chord but Ctrl+Shift+H says `close the edit first (Esc)` and does nothing else; in a field
Ctrl+Shift+V stays the browser's paste. When the dialog closes, whatever closed it, a terminal that
this page's resume or new brought meanwhile takes the keyboard, else the zone's holder gets it, at
once (no list is waited for). Enter saves (Ctrl+Enter in the note, where Enter is a line break); a
held Enter saves once, and the key that opened a dialog types nothing into it while it is held. An Enter or Esc of an IME composition is the IME's: it neither saves nor closes. Esc
and Cancel (Close in the pull-request dialog) close; a note whose text was changed needs a second Esc (`Esc again discards your
text`; a held Esc is one Esc). The reload keys (F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R and
BrowserRefresh) say `save or cancel the edit first` while the dialog holds changed text, and do not
reload; otherwise they reload as anywhere. A held Enter or Esc that closes a dialog over a terminal
is a key pressed off the program's holder: its repeats and its release are the page's, and the next
press is the program's. Over the list, the auto-repeats of a key pressed in a dialog act on no list key once it is gone (an Enter must not resume a session); the next press does (review 2 of plan D task 37). A save keeps the dialog open with its text and its keyboard when it is
refused, the connection is lost or the page refuses it before sending (over a limit of 8.2.3, or
text that is not well formed); its `ok` closes the dialog, except Attach in the pull-request dialog,
which empties the field and keeps the dialog open so that the new pull request shows in its list
(ruled for plan D task 37).

After this page's own save of a label, group or note, its key waits for the list that holds the
result (one that arrived since the act was sent, else the next one: `the label is not here yet;
press l again`; a named limit: a list that the server pushed just before it read the act also
counts as holding it), so that the dialog never starts from the old text and an Enter never writes the
old label back (the pull-request dialog does not wait). When no list came by the answer, the page asks
for one (a `view`, which the server answers at once; it sends no list equal to the last one, so a
save that changed nothing shown would otherwise wait for good). A named limit: when the store was
busy at that save, the list asked for may come before the server could read the rows again, and the
dialog then starts from the old text (a note's save is then refused as a conflict). A refusal whose dialog was closed meanwhile
(Enter, then Esc at once) is shown as a toast, `not saved: <the error>`. While a dialog holds
changed text, leaving the page in a way the keys do not cover — the tab's reload button, closing
the window, the page's own reload when a reconnect meets a server of another build (15.3) — asks
first, with the browser's own prompt; staying keeps the dialog and its text. In the last case the
page then stays not connected (a save says `skydeck's server is not connected; try again`) until
it is reloaded: copy the text, then reload. Two named limits (ruled for plan D task 37): text typed between an F5 on an
unchanged dialog and the server's proof, and the page's own reload on another build, are not held
back as the reload keys are: with changed text, only that prompt stands between the reload and the
text.

**The quick switcher** (12.8; stage E, plan E11) is modal by the dialogs' rule: a scrim covers the
window, the page under it takes no keyboard, and while the switcher is shown the page moves the
keyboard nowhere by itself (not for a resume's answer, a list or a render) and acts on no list key
(`j`, `d` or `/` typed are text in its field). Ctrl+Shift+P closes it; every other window chord,
Ctrl+Shift+H too, says `close the switcher first (Esc)` and does nothing else (its footer names its
keys, and the help never covers its items); the reload keys reload as usual, since nothing typed
there is worth keeping. Opening it hides the help. Stage D's toast lies under its panel and over
its scrim, so that it never covers the items and its Undo can still be clicked. In its field ↑ ↓
move the highlight, PgUp PgDn by a page, Enter picks, Esc closes, Tab and Shift+Tab stay in the
field and do nothing; every other key is text. A mousedown in the panel anywhere but in the field
is cancelled, so that the keyboard never leaves the field, and when nothing has the keyboard (a
click on the toast) the next key gives it back to the field first. A click outside the panel
closes it. When it closes without a pick the keyboard goes back where it was (the terminal, the
list, the filter's field), and a terminal this page's resume brought meanwhile takes it then, as
after a dialog; after a pick: the session's terminal (also one this page's resume of it brings),
else the list — whatever the switcher was opened from, the filter's field too (ruled by the lead on
2026-11-15). A held Esc or Enter that closes it over a
terminal sends the program nothing (a key pressed off the program's holder); Esc while the New
form is open closes the switcher only. Ctrl+Shift+P, and a click on the title bar's `Switch…`
(which passes the same gate as a window chord), while a dialog is shown say `close the edit first
(Esc)` and open nothing. The switcher opens while the page is not connected and says so.

### 12.10 Done

A session marked done disappears as in design 7.1, except that a running session marked done
stays under Open with a `done` mark until it stops (then it is hidden). Marking done shows an Undo
toast.

**Ending it (follow-up F30).** A row carries `endable` while its session runs in the row's
terminal of the window and that terminal can be ended: its keeper is of version 3 or later (7.7)
and connected. `d` or the header's `Done` on such a session, not marked done, marks nothing yet: a
modal dialog over the list and the terminal asks, in the manner of 12.5's dialogs — `Mark done:
<title>` (the list's title, cut to 60 characters with `…`, whole in its tooltip, isolated from the
words around it), `This session is still running.`, and while it works `It is working: ending it
now stops the current turn.` —, with three buttons: `End session and mark done` (the primary one),
`Mark done, keep it running`, `Cancel`. Esc is Cancel; Tab and →, Shift+Tab and ←, walk the three
and stay inside; Enter or Space press the one that has the keyboard, at a fresh press only (the
`d` that opened it, an auto-repeat, or a key held since before it opened presses nothing). The
keyboard always starts on the second button, `Mark done, keep it running` (ruled at review: any
word ending in `d` typed into the list by mistake before Enter or Space must never end a session,
and no rule about typed characters or a dead time stops that); it comes to the End button only by
the user's own Tab, Shift+Tab, arrow or click, so `d`, ←, Enter ends a session. When the session
turns working while the dialog is shown, a keyboard on the End button moves back to the second
button, and nothing moves it by itself towards the End button. Ctrl+Shift+H is refused while the
dialog is shown (`close the dialog first (Esc)`), and opening it hides the key help: the help
would lie over it. The dialog belongs to the session and the
terminal it opened for: when that session stops running there, is marked done in another window or
leaves the list, it closes, nothing done, and the toast says why (`It stopped by itself: nothing
was marked done.`, `It was marked done in another window: nothing was ended.`, `It left the list:
nothing was marked done.`). Cancel changes nothing and gives the keyboard back where it was. `Mark
done, keep it running` is `d` as before. `End session and mark done` sends `end-session` (8.2.3);
the toast says `Ending the session…` until its answer: `Ended and marked done: hidden from the
list.` with Undo (which marks it undone: it shows under Recent and can be resumed; it does not
bring the program back), `Marked done. It has not ended yet: end it inside claude if it stays
open.` with Undo when it has not ended within 10 seconds, or `End session: <why>` for a refusal.
The terminal is closed by the server once the program ended (also after the 10 seconds), so the row
leaves Open and, done, is hidden; after `d` in the list the selection follows 12.9's rule for a row
gone after `d` (a row of Open: nothing else is selected).

A session ended so is an ordinary ended one: once its program has exited the server stores an `end`
of detail `exit` for each of its holders that belonged to the terminal (no spool file, raw detail
`skydeck-window`; no change of the schema), and design 6.3 reads that holding as a deliberate exit
whatever end Claude Code's own hook sends after its hang-up (reason `other`, design 14), before or
after it — also when the program ends only after the 10 seconds (the server follows the terminal
until then). So it is never `ended-unexpectedly` or `was-working`, never needs you as an ended
terminal (12.4), restore never offers it (design 7.8), and it resumes as any other, with its flags.
A known limit: what the server follows is held in its memory only, so when the server is restarted
(or stops) while a program it hung up is still ending, the end is not recorded and reads as
Claude Code's own hook reports it (`other`: ended unexpectedly).

A running session the window cannot end — in another terminal (7.9), or in a terminal of the window
whose keeper is older, lost or not connected — gets no dialog: `d` marks it done, and the toast says
`Marked done. skydeck cannot end this one: end it in its terminal. Hidden once it stops.` A session
that does not run, `d` on a session marked done, `Undone`, `close-terminal` and every command of the
command line are unchanged; nothing ends a session from the command line.

### 12.11 The nine picks

Approved with the mockup on 2026-11-13. Picks 5 and 8 cannot be seen in the mockup: they are the
lead's decisions under the user's go-ahead to proceed.

1. A stable Open section with attention marks, not a "Needs you" section that rows move into.
2. A single click on a session that is not running selects it and shows the resume card; it does
   not resume.
3. The ticket key inline, stacks in history, no group headers. (A "by ticket" view is not in the
   first version.)
4. The pull-request chip: the number of open ones when more than one, the state of the one that
   most needs the user, and a tally of merged ones (12.3).
5. Only Ctrl+Shift chords plus Ctrl+Tab; no leader key.
6. A running session marked done stays under Open until it stops.
7. Seen = selected for 1.5 seconds with the window focused, or typed into.
8. A session whose window terminal crashed needs you until seen.
9. Slots 1–9 in opening order, not reordered in the first version.

### 12.12 The icon

The page has an icon of its own, so that the window and its taskbar button need not show Edge's
default: a picture, and PNG files of 16, 32, 48, 192 and 512 pixels (the 192 and 512 also as
maskable icons) made from it and committed beside it in `web/icons/` (no build step: the PNGs are
made once from the picture and committed). `index.html` names the favicon (`<link rel="icon">`) and
the manifest (`<link rel="manifest">`), whose `name` and `short_name` are `skydeck`, `display`
`standalone`, and `icons` the PNGs. Whether Edge's app window and its taskbar button show it is
check W3. Low priority: stage E (19).

As built (stage E, plan E14; the picture changed by follow-up F10, 2026-11-17, to the owner's
picture, drawn at the sizes the window uses, and a second picture for the
small sizes; the small files redrawn by follow-up F12, 2026-11-18, and the 16 pixel one by
follow-up F14 the same day):

- **The pictures** are the owner's, two of them, 1254 × 1254 pixels, RGBA, transparent outside
  their dark navy rounded tile, in `scripts/icons/`, not under `web/`: they are not served and not
  part of the build. Their image data is kept exactly as it was received; the one metadata chunk
  each came with was removed (follow-up F27, 2026-11-19), so they hold IHDR, IDAT and IEND only,
  like the drawn files. `skydeck-source.png` (1,670,010 bytes) has
  a blue-to-violet cloud outline and three stacked terminal windows, the front one with three
  coloured dots and a prompt (`>_`). `skydeck-source-small.png` (1,349,085 bytes) was made after the
  first one turned out a blur at 16 pixels: the same tile and cloud outline with ONE terminal window
  and a bold white `>_`, no stacked windows, no dots. `test/window/icons.test.ts` pins both sha256.
  Until F10 the source was a drawing of shapes, `web/icons/skydeck.svg` (three cards on the page's
  accent colour); it is gone.
- **The files** are `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-192.png` and `icon-512.png`
  on a transparent background, `icon-192-maskable.png` and `icon-512-maskable.png`, and
  `favicon.ico` (the 16, 32 and 48 pixel PNGs in one ICO). They were drawn once by
  `scripts/icons.ts` with the page suite's pinned Chromium, headless and in an environment of its
  own, and committed; no test and no CI step runs the script. Nothing is fetched from outside, at
  build time or at run time. **The 16, 32 and 48 pixel files, and so the ICO, are drawn from the
  small picture; the 192 and 512 pixel files and both maskable files from the first one**: the
  detailed picture blurs at 48 pixels and below (at 16 it is a ring with a light spot), and the
  window's taskbar button and title bar show the small sizes.
- **How a size is reduced.** Chromium decodes the picture; for each pixel of an icon the script
  averages the picture's pixels under it, weighted by the area they cover, premultiplied and in
  linear light: a box filter at exactly the icon's pixel pitch, so that no pixel of the picture is
  skipped (nothing aliases), nothing rings, and the light of a thin line is kept. Halving on a
  canvas with Chromium's high-quality smoothing was tried first and rejected: it left a grey halo
  around the tile on a light background and a duller 16 pixel icon. The large files are the whole
  picture in their box, transparent where the picture is (its rounded corners; the tile itself is
  at alpha 251 to 254 of 255, the pictures' own).
- **The small files are not the whole small picture, and not its tile** (follow-up F12, on the
  owner's report that the icon on the taskbar looked small and blurred and, a day later, still
  smaller than the others). The taskbar is dark there, where the navy tile is nearly invisible, and
  the drawing is only 83 % of the tile's width and 70 % of its height (1001 × 844 of the tile's
  1200 pixels): drawn by its tile, as F10 first did, the icon looked small beside the others. Each
  small file is a square crop of the picture on the tile's navy (`#01062b`), its corners rounded
  by a mask of the tile's own relative radius, 273 / 1200 = 0.2275 of the crop's side (a circle
  fitted to the tile's corner): the corners transparent, and along the straight sides alpha 252 to
  255 (not always 255: a picture pixel on the crop's edge counts in the mask and again in the area
  average). The mask is laid on the picture's pixels before the reduction, so its edge is
  anti-aliased like the rest, and no pixel of the picture under a crop is less than opaque, so the
  picture's own soft edge and transparent corners are never in a small file.
  - **One rule for the three: the drawing, at 16, 32 and 48 pixels alike.** The drawing's box
    (what is more than 40 of 255 from the navy, at least 60 pixels inside the tile) is x 115 to
    1115 and y 202 to 1045, 1001 × 844 pixels. The crop is centred on it and its side is the width
    plus 2 % each side, 1041.04 pixels, so the drawing fills the square: at 32 pixels it covers
    96 % of the icon's width and 81 % of its height, and at every size it reaches the left and the
    right edge (at 48 to within one pixel), the cloud's outline at its top and the terminal window
    in front of it.
  - **Why one rule, and what it costs** (follow-up F14). F12 drew the 16 pixel file from the
    terminal window alone (its box x 306 to 941 and y 546 to 1045, plus 4 % each side, and what of
    the cloud's strokes fell in that crop painted the navy), so that the `>_` had more room. The
    owner asked for their picture there again, the cloud with the window: they want one picture
    at every size. The cost: in the whole drawing the window is 0.61 of the icon's width (alone it
    was 0.93), and the `>_` with it, so at 16 pixels the chevron and the bar are 10 white pixels,
    where the window alone gave 22 (and the picture's whole tile, before F12, 7). A taskbar button
    that Windows stretches from the 16 pixel file is therefore softer than with F12's file: the
    cloud and the window still read as shapes, the `>_` as a light mark in the window.
  - **The numbers are measured from the picture**, and `test/window/icons.test.ts` measures them
    again from it (the tile's navy, the drawing's box, the tile's corner radius) and holds the
    script's constants to what it finds; it measures the window's box too, to find the window in
    the 16 pixel file, whose top frame is its row 7, with 28 pixels of the cloud's blue to violet
    above it. The test re-derives every file from its picture in plain Node and compares (the
    three small files within one step of 255 on this build, every file within two); tells the two
    pictures apart by the white of the `>_` (the small picture's is bold: 3.8 to 3.9 % of a 16, 32
    or 48 pixel icon is white; the large one's is thin: about 0.5 % of a 192 or 512 pixel one); and
    pins the six files F14 left as they were byte for byte: the 32 and 48 pixel ones as F12 drew
    them, and the four large ones (192 and 512 pixels, and the two maskable ones), as they were
    before F12 too.
  - **What it looks like.** At 16, 32 and 48 pixels the same picture: on the navy, the cloud's
    outline in blue to violet with the terminal window in front of it and the `>_` in the window.
    At 32 and 48 pixels the three read; at 16 the cloud and the window's frame read and the `>_`
    is a light mark. **Which file the taskbar button takes is not verified. Most likely it is the
    16 pixel one**, stretched to about 24 pixels: the button shows the cloud with the window, soft
    (a stretched bitmap is never crisp), the `>_` hardly reading. The evidence is F12's review 2
    reading a screenshot of the taskbar taken before F12 (2026-11-17), in which the button's 24
    pixel icon matches the 16 pixel file of that day stretched to 24 far better than the 32 or 48
    pixel one reduced; not tried in Edge. After F12 the owner reported that the icon they saw was a
    different icon from their picture; the only small file F12 made different in kind was the 16
    pixel one, which is consistent with the button showing the 16 pixel file (not a confirmation:
    the report did not say where they looked). If Windows takes the 32 pixel file instead, the
    button shows the same picture, sharper. The title bar shows the 16 pixel file at a display
    scale of 100 %; at 125 or 150 % Edge may draw it from the 32 pixel one. **The taskbar's look
    was not tried in Edge or on Windows**: it is judged from sheets drawn with the same Chromium (a
    file resized as a browser does), and W3 asks the owner to write down what they see.
- **The maskable icons** have a full background of the large picture's tile colour, `#040925` (the
  average of its opaque pixels between 555 and 585 pixels from its middle), with the picture in the
  middle at 0.927 of the icon's width: drawn in full within 555 of its 1254 pixels from its middle,
  faded out to the background over the next 30 and not drawn beyond. The drawing reaches 540.8
  pixels from the middle, so nothing of it is touched; the tile's own edge (a lighter hairline and a
  shade, up to 36 steps from its colour, starting 594 pixels from the middle at the nearest, and a
  tile lighter at its top than at its bottom) is not drawn: left in, it showed as a faint frame
  inside the background, a tile inside a tile (the first build, a flat `#050925` and the whole
  picture, had steps of 22 between neighbouring pixels). 0.927 is the largest scale, to three
  decimals, at which everything of the drawing is inside the safe zone, the circle of 0.4 of the
  icon's width. The drawing is what differs from the background by more than 40 (of 255) in some
  channel, composited on it; the farthest of it from the picture's middle is 540.8 pixels, so the
  scale can be at most 0.4 × 1254 / 540.8 = 0.9275. No pixel of a maskable icon is transparent.
  In both files, outside the drawing, no step between neighbouring pixels is above 2
  (`test/window/icons.test.ts` measures it, also along ten lines across the circle where the picture
  fades out). `scripts/icons.ts` stops if the drawing, scaled, leaves the circle of 0.4 or reaches
  the fade.
- **The manifest and the page** are as before: `web/manifest.webmanifest` holds `name`,
  `short_name`, `display` and the seven PNGs, each `src` under the versioned path; it is served at
  `/manifest.webmanifest` with the build put in, and the ICO at `/favicon.ico` (8.2.1). `index.html`
  names the favicon by its versioned path (`/assets/<build>/web/icons/favicon.ico`,
  `sizes="16x16 32x32 48x48"`) and the manifest by `/manifest.webmanifest`; the policy's
  `img-src 'self'` and `manifest-src 'self'` let the page load both. The manifest has no
  `start_url`, `scope` or `id` (ruled, plan E task 94): the page is not meant to be installed as an
  app — Chromium counts it as not installable without `start_url`, and an installed app's shortcut
  would hold no launch token (5.1).

## 13. Notifications

- When a session starts to need you (12.4: a change from not needing you to needing you, for any
  of the three reasons) and no window has focus, the server sends `notify` to **one** page: the
  one that had focus last (several windows would otherwise each raise one).
- How the server judges it (stage B's plan, B12): over the rows a page without a filter lists,
  against its last judgement. A session whose reason changes does not start to need you; one that
  stops needing you and needs you again later does. The first judgement records and notifies
  nothing, so that a restart does not notify everything that already needed you, and it is made
  only once the server has read the marks and a refresh has worked, with that refresh's window
  ends stored (a busy store that keeps them makes it wait): a start whose first refresh fails must not notify all of it at the next one. A `notify`
  that no page takes (a window has focus, or none is open) is not sent again later.
- That page shows a desktop notification with the Notification API (allowed: `127.0.0.1` is a
  secure context, section 21): title = the session's title, body = the reason (`asks: permission ·
  Bash`, `finished`, `ended unexpectedly`), both plain text; `tag` = the session id, so a newer
  notification for a session replaces the older one. A click focuses the window and selects the
  session.
- How the page does it (stage B, plan B15, B16). The permission is asked only by a click on `Turn
  on notifications`, in the title bar while the API exists and its permission is `default`; the
  item follows a permission changed in the browser's settings when the window comes back to the
  front or a list comes. A held key asks once: its auto-repeats on the item do nothing. Pressed
  from the keyboard and answered at once (a policy that denies), the keyboard goes back to the
  zone's holder and a held Enter acts on nothing there (12.9). A `notify`
  is shown only with the permission `granted`, never for the session that is selected while the
  page has focus: its title is the session's title, its body `asks: <detail>` (`asks` without a
  detail), `finished` or `ended unexpectedly`, both sanitised and nothing added — the detail is the
  server's, cut at 120 units (12.4) —, and its `tag` the session id. A click calls `window.focus()`,
  closes the notification and goes through the gate of a window chord (12.9): it selects the
  session, or while a dialog is shown says `close the edit first (Esc)` and selects nothing. A
  session that this page's list does not show (the filter, the folded Earlier) and that has no
  terminal of the window is not selected either: the key bar says `that session is hidden by the
  filter, the fold or a closed block` (the closed block named from follow-up F6), and the selection,
  the right side and what the page reports stay as they
  were — the pane would be empty, and a focused page's selection is seen after 1.5 s, which would
  clear a mark the user never saw (ruled on review 2 of plan B task 55; showing a selected session
  the list hides is stage E's). A session a closed block hides — since follow-up F9 its first session
  too — is selected, also without a terminal of the window, and its block opens (12.2; follow-up
  F3): `needYou.order` holds it, while it
  holds no session the filter or the fold leaves out. So one case of a closed block is refused:
  a session that no longer needs you (its notification not yet closed), has no terminal of the
  window and sits in a closed block — the page cannot know a closed block's sessions, and
  `needYou.order` no longer holds it —, with the same line, which names the closed block for it
  (F6). The
  page closes a session's notification once that session no longer needs you: at a list that holds
  the session's row without attention, or in which nothing needs you (`needYou.count` 0); a session
  the list does not show (the filter, the folded Earlier) keeps its notification until a list shows
  its row (ruled). Best effort: what Windows does with a closed notification is check W11. Named
  limits: a notification whose session changes its reason (it asked, then finished) keeps the words
  it was shown with, since only a start notifies; and one shown before the page reloads is not
  closed by the new page. What a notification shows — the session's title and an ask's detail — is
  the user's to judge on a shared screen (ruled).
- No notification for the session that is selected in a focused window, and none while the page
  has no permission.
- Permission is asked once, on a user gesture: a "Turn on notifications" item in the title bar
  while the permission is `default`. It is asked per origin and profile (section 21), so it stays
  granted while the port and profile folder stay the same.
- Notifications may be blocked on a managed PC (check W11). Without them the window title
  `(n) skydeck` and the title bar's counts still show that something needs you.
- Nothing else notifies: terminal bells, OSC 9 and OSC 777 notifications from programs are ignored
  in the first version.

## 14. Failures

| What happens | What skydeck does |
|---|---|
| **The server dies** (crash, killed) | Keepers and their programs keep running; output collects in each keeper's tail (up to 8 MiB, 7.1). Terminal queries a program sends meanwhile go unanswered (it times out, as in a terminal that does not support them). Pages show 6.3's bar. `skydeck window` starts a new server, which finds the keepers in `<runtimeDir>/terms/`, rebuilds every screen from snapshot and tail (7.3), and pages reconnect with the same boot id. `server.log` keeps the reason when one was logged. |
| **A keeper dies** | Its program gets SIGHUP and ends (`SessionEnd` with reason `other`; the session is marked `ended-unexpectedly`, so restore offers it). The server marks the terminal lost (7.8) and the session needs you (12.4, "ended"). Nothing else is affected. |
| **python3 is missing** (or older than 3.9; tested on 3.12 only) | The server runs and the list works; opening a terminal fails at once with `python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)` on the resume card, and `doctor` reports a problem. The commands are unaffected. |
| **The port is taken** | By a skydeck server of this installation: it is used (5.2). By anything else: `serve` exits 10 and `skydeck window` exits 1 with the line that names the port and `window.port` (5.2). A program that holds the same port on the **Windows** side is not visible from WSL: then the window shows that program's answer or an error; check W1 and 15.3. |
| **Edge is missing** | 5.3: a message naming `window.edge` and `--print-url`; exit 1; the server keeps running. |
| **`skydeck window` is run twice** | The second run finds the server and, when a page is connected, starts no second window (5.1). Two at the same moment start one server (the lock, 5.2) and one window (`window_launching`, 5.1). |
| **The server hangs** (alive, not answering) | `skydeck window` says so and names `--restart`, which stops it with signals after checking its identity (5.1). |
| **A server of another checkout runs** | `skydeck window` does not replace it unless asked with `--restart` (5.1). |
| **A program does not read its input** | The keeper keeps reading its output; input waits in the keeper's queue (at most 4 MiB), then the server refuses more with a notice (7.1). |
| **The PC sleeps** | 6.5. |
| **WSL stops** | Every process in WSL ends, so every session in the window ends (marked `ended-unexpectedly`). The window stays and shows 6.3's bar; after `skydeck window` it shows the new boot and the restore banner (12.7). |
| **The keep-alive cannot start or dies** | The server retries (6.1), pages show `WSL is not kept running`, and `doctor` reports it. The window keeps working while any WSL terminal is open. |
| **A page falls behind** | 8.2.8: it gets a fresh snapshot instead of the bytes it missed. |
| **A program writes very fast** | The keeper keeps reading; the server parses about 10 MB/s and stops reading a keeper whose records its screen side has not applied (7.3), so the keeper closes that connection at its send cap and the server reconnects; pages that cannot keep up get snapshots (8.2.8). The program is never paused by skydeck. |
| **The store is locked or broken** | As for every command (design 5.3): the tick fails, is logged and shown once, and is retried; terminals and their streams do not depend on the store. The server's own connection waits at most 250 ms for another process's write lock (the commands wait 5 s), so a lock held for long never freezes the server: the piece of work that met it is given up and tried again — the tick's store work at the next tick, an action answers `skydeck's database is busy; try again`, a `hello` is closed with 1013 and the page tries again, and a found keeper's decision (7.3) is put off to the next refresh while its deadline allows; a start that meets it fails at once (5.2), leaving nothing behind (ruled, plan task 23). |
| **skydeck is updated** | 16.5. |
| **The key is wrong** (after `--new-secret`, a launch address used too late or given up, a stale bookmark) | The page says that its key is not valid and to run `skydeck window` again (8.2.2). |
| **A launch token is presented twice** | Another program may have the secret: the alarm (8.2.2) — the page, the waiting `skydeck window` and `doctor` all say to run `skydeck window --new-secret`. |
| **Something else answers on the port** (a program on the Windows side, 15.3) | An open window gets no server proof, sends nothing, and says `something answers on port <n> that is not skydeck's server`. |

## 15. Security

### 15.1 Threats

The server listens on `127.0.0.1` only, but loopback is reachable by every process on the PC, in
Windows and in WSL, of every user, and by every web page in every browser on the PC (a page can
make requests to `127.0.0.1`). The terminals it serves can run any command as the user. What the
TCP port offers is therefore small: the page's static files, which are not secret, and one
WebSocket, which does nothing until the other side has proven that it knows the secret (8.2.2).
Every request the command line makes goes over a unix socket instead (8.3). So:

- **Other pages in the user's browsers.**
  - Cross-site requests: there is no HTTP request that acts, and no answer carries a CORS header,
    so no other page can read one. A cross-site WebSocket is refused by the exact `Origin` check
    at the upgrade, and could not give the proof anyway.
  - DNS rebinding (a page whose own host name is made to point at `127.0.0.1`): its requests carry
    its own host name in `Host`, which is refused (421); only `Host: 127.0.0.1:<port>` is served
    (for port 80 also `127.0.0.1`, 8.2.1).
  - Framing (clickjacking): `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Other local processes.** The WebSocket needs the proof, checked in constant time, and the proof
  shows nothing of the secret, so watching loopback traffic does not reveal it. `server.sock` and
  the keeper sockets are in directories of mode 700 and are mode 600, and keepers also accept only a
  peer with their own user id (7.1). Processes of other users cannot read the secret from the
  store (mode 600), from the window's Edge profile (where it is not extractable) or from the wire;
  they can obtain it, or the use of it, in the two cases 15.2 and 15.3 describe. Who those "other
  users" are on a PC with one person: service accounts on Windows and in the distribution and
  whatever runs under them. For them
  the two cases are a small door to the developer's shell; root and administrators own the machine
  anyway. A process that runs as the user can read the secret — and can equally run `claude` itself, read the transcripts or reach
  the WSL files from Windows (`\\wsl.localhost\…`); defending against the user's own processes is
  not a goal.
- **Programs pretending to be the server.** A page trusts a server only after the server's proof
  (8.2.2): an open window sends nothing — no proof it could reuse, no keys, no view state — to a
  program that answers on the port and cannot prove itself, and says so. The proofs cover the
  handshake only; nothing binds the frames after it, so a program that sits between page and
  server could pass both proofs along and then read and type everything (15.3).
- **What a proven connection can do.** Plainly: **anything the user can do.** It can type into any
  session in the window, `!` commands included, and `new`'s flags can carry `--settings` or
  `--mcp-config` with inline JSON that names commands. The proof (8.2.2) and the unix socket's
  permissions (8.3) are what stand between other processes and the user's shell. The rule skydeck
  keeps is narrower and exact: **skydeck itself never executes a request's words.** No request
  carries a program or an argument list to run (8.2.3, 8.3); the server builds every launch itself,
  through the guard and the lock, with `claudeCommand` as the program and `buildResumeCommand` or
  `buildNewCommand` building the arguments — from a session id, or from `new`'s directory, label,
  group and `claude` flags after design 7.7's checks; keystrokes go to the program in the terminal
  as keystrokes. The only other argument skydeck passes to a program from a page is a link, and
  only as 9.6 allows.
- **Browser extensions.** An extension that may read `127.0.0.1` pages could read the terminals and
  the secret. The window runs in its own profile folder, so the user's extensions are not there.
  Extensions that an Edge policy forces into every profile still are: check W13 lists them
  (`edge://extensions` in the window's profile, `edge://policy`).

### 15.2 The secret and the launch tokens

- **The secret**: 32 random bytes, kept in `kv` (10.2); created on first need and kept across
  server restarts, so a window can reconnect to a restarted server, and to the server of a new
  boot, without being reopened. It never crosses a connection (page and server prove that they
  know it, 8.2.2), is never put on a command line or into an address, and is never logged. In the
  page it is a non-extractable Web Crypto key in the origin's IndexedDB (8.2.2): usable by code
  running at that origin, readable by none. `skydeck window --new-secret` replaces it (5.1).
- **A launch token** is what reaches Edge: in the `--app` address on `msedge.exe`'s command line,
  and in the window's first address until the page removes it. The server holds tokens in memory
  only; each works once, and the command that asked for one gives it up when its wait ends (5.1),
  so none is left usable after its window has connected or given up. Edge may record the first
  address in its history (and sync it, check W13): by then the token is used or given up.
- **The remaining exposure, accepted.** Inside WSL the command line of the interop process that
  runs `msedge.exe` is readable in `/proc` by every local account for as long as that Edge process
  lives. A process of another account that watches `/proc` reads a new token in microseconds, while
  Edge's page needs hundreds of milliseconds to present it: if such a process presents it first, it
  **gets the secret**, nearly every time it tries. It is not silent: the window's own attempt is
  then the second use of the token, and the alarm (8.2.2) makes the window, the waiting `skydeck
  window` and `doctor` say to run `skydeck window --new-secret`. So it takes an account in the
  distribution, acting at the moment a window opens, and the user is told. The other side of the
  same coin: an account that can read `/proc` can also raise the alarm at will, by presenting a
  token after the window has used it; the cost to the user is one `--new-secret`. A way to close it, not
  taken in step 2 because it adds unverified Edge behaviour (the taskbar identity, a `file:` address
  on a managed PC): give Edge a `file://wsl.localhost/…` page from the runtime directory that
  forwards to the real address, so that no command line holds a token.

### 15.3 Accepted risk: a program that holds the port

Edge reaches the server through WSL's localhost forwarding. If another program listens on
`127.0.0.1:<port>` before the server — on the Windows side, or inside WSL while no server runs —
Edge reaches that program instead.

- **A window opened** while that program holds the port runs that program's page, which receives
  the launch token: if the program can reach the real server while the token lives, it gets the
  secret. No alarm comes in this case: the window's own page is the program's, so nobody presents
  the token a second time; only the foreign or broken window shows it.
- **Its page runs at the window's origin.** It can register a service worker, which stays in the
  window's profile after that program is gone, answers later loads of the page itself, and can use
  the stored key in every later window — lasting control of the window's profile. The server
  answering the worker's script with 404 does **not** drop it, measured in Chromium (the page
  suite, 17.4; plan task 26): the worker goes on answering every load of the page after the real
  server is back, and an update check that gets the 404 fails and leaves it registered. Whether
  Edge behaves the same is W25. So the recovery is the only way out: close every window, **delete
  the window's profile folder** (5.4), and run `skydeck window --new-secret`: `--new-secret` alone
  does not remove a worker. Stage A builds no remedy of its own (no `Clear-Site-Data`, no
  unregistering by the page; ruled, plan task 26).
- **A window already open** sends nothing to a program that cannot prove itself (8.2.2). But that
  holds only while the program cannot reach the real server too: one that can — if, with the port
  taken on Windows' `127.0.0.1`, the WSL server still answers on the IPv6 loopback (check W25) —
  can pass both proofs along and then read and type everything, without ever learning the secret
  (15.1).
- **A reload** fetches the page from whoever holds the port at that moment. The page therefore
  handles F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R and the BrowserRefresh key (alone, with
  Shift, with Ctrl) itself in the list zone, and in the terminal zone Ctrl+Shift+R and
  BrowserRefresh always and the others while the page, not xterm.js, has the keyboard (12.9): it first opens a new connection, waits for the server's proof, and only then
  reloads. (Shift+F5 and BrowserRefresh as Chromium reload keys are from memory, not verified.)

Accepted: it takes a program that binds this one port at the moment a window is opened or
reloaded, the window then shows that program's page rather than skydeck's, and the worst case —
lasting control of the window's profile — has a recovery. It cannot be closed without encryption
between Edge and the server, which this design does not have. Processes of the user's own account
are no concern here (15.1); this is the second small door for other accounts.

### 15.4 What a program in a terminal can do to the page

A program's output is untrusted (it may print a hostile file):

- xterm.js renders it as cells, never as markup; the page never puts any server-provided string
  into `innerHTML` (only `textContent`), and the CSP forbids inline script.
- The clipboard: write only (9.5).
- Links: opened only on a Ctrl+click, only `http` and `https`, and in the default browser (or
  Edge), never in the page (9.6).
- The program's window title (OSC 0, 2) is ignored: the window shows skydeck's own titles.
- Query answers come only from the screen side (9.3), and the page's terminal answers nothing, so
  output cannot make the page type into the program.

### 15.5 What runs

The keeper runs the launch the server gives it: `claudeCommand` and the arguments design 7.6 and
7.7 build. The server runs `rundll32.exe` (links, 9.6), `window.edge` (links with `window.links`
`"edge"`), `wsl.exe` (the keep-alive) and `python3` (keepers), each with an argument list; `skydeck
window` runs `window.edge` (the window). `rundll32.exe url.dll,FileProtocolHandler` opens what it is
given as the Windows shell would, a program or a `file:` address included: 9.6's check (`http` or
`https` only, re-serialised, one word of printable ASCII) is what stands between a page's input
(a terminal's text, a program's output, a pull request's data) and a program start on the Windows
side. `openLink` applies it itself, whatever its caller checked, and it is not widened (another
scheme) without this in mind. So no input from a page becomes a program name or a shell string by
skydeck's hand, but a link does reach the Windows shell: only an `http` or `https` address that
check let through; a page's `new` flags become `claude` arguments only after design 7.7's refusals.

## 16. Install, uninstall, doctor, configuration, updating

### 16.1 Install

Unchanged in what it writes: the same two hook entries (10.3), the same links, nothing on the
Windows side. It adds one `info` line when `python3` 3.9 or newer is not found: `the window
(skydeck window) needs python3 3.9 or newer; the commands do not`. (3.9 is the oldest the keeper's
code allows; it is tested on 3.12, which Ubuntu 24.04 and the CI runners have.)

### 16.2 Uninstall

Before what it does in step 1:

- when a server runs, it stops it as `skydeck window --stop` does (5.1) and says `stopped skydeck's window server; <n>
  terminals in the window keep running` (for one: `1 terminal in the window keeps running`), where
  `<n>` counts the keepers whose `.pid` line is alive or cannot be judged (4.2), read before the
  stop: a server that does not answer cannot say how many it has. Keepers and their sessions are
  never stopped (2).
- it names the Edge profile folder — the configured one, or the derived one (5.4) — when that
  folder exists (Edge creates it at the window's first start): `the window's Edge profile is in
  <folder>; Edge wrote it and skydeck leaves it (delete it yourself)`.

`--purge` refuses (exit 1) while any keeper is alive — by its `.pid` line and design 5.5's rule,
never by connecting to it (7.1); a line that cannot be told dead counts as alive (4.2) — naming the
open terminals. It looks for `.pid` lines in every
directory that can be the runtime directory: the one the store records and each one the rule of
4.2 can give (`$SKYDECK_HOME/run`, `$XDG_RUNTIME_DIR/skydeck-<store id>`, `<stateDir>/run-<store
id>`), because the command may run with another environment than the server did. Purging
`<stateDir>` can remove keeper sockets under it, and the screens of those sessions could not be
shown again; the user ends those sessions first. A `terms/` of one of them that cannot be listed
refuses the purge the same way: what runs there cannot be told. Every check that can refuse the
uninstall comes before anything is undone or stopped, and such a refusal leaves the settings file, the links and a
running server as they are. One look can only come after the server's stop — a keeper the server
was starting as it stopped — and it refuses only the purge: the uninstall is then done, the data
stays, and the command says exactly that (`skydeck is uninstalled, but --purge removed no
directory: …`, exit 1). Otherwise it also removes every one of those directories that exists —
the recorded one with repeated and trailing slashes dropped, so that a symbolic link is seen as
one (`<link>/` would be followed) — one that is not a plain path (a `.` or `..` in it), is a
symbolic link, is another user's, holds a subdirectory (`terms/`) of another user, holds anything
a runtime directory does not (4.2) or an entry of another kind than skydeck writes there, or
cannot be looked at, is left alone, since the store's record is only a path and nothing of the
user's is destroyed (2, principle 6). Its removal goes entry by entry, each directory once it is
empty: one that fails, or an entry that came while it was purged (it stays), leaves that directory
too. The rest of the purge goes on, and the command ends with one line naming each directory left
and why — the entry in the way when there is one (`skydeck is uninstalled, but --purge did not
remove <dir>: it holds notes.txt, which skydeck did not write`) — and exit 1, as for skydeck's own
directories (design 8; ruled by the plan owner, purge-care). The list of what a runtime directory
holds is `RUNTIME_DIR` in `src/cli/purge.ts`.

### 16.3 Doctor

New lines, with `ok`, `info` or `problem` as in design 8. It still starts no program but those it
already runs (`gh`, `wezterm`, and for its first three lines git and `<claudeCommand> --version`,
design 8, follow-up F20) and `python3 --version`; it starts nothing on Windows, signals
nothing and creates nothing. While the window has never been used — no `window_secret`, or no
database to read it from — every line below that would be a `problem` is `info`, so that `doctor`
judges an installation that uses only the commands as step 1's did; once the window was used they
are problems.

| Check | `problem` when |
|---|---|
| python3 | `python3` is not found or is older than 3.9 (`info` instead when the window has never been used: no `window_secret`). A second line: `/usr/bin/python3`, through which the launcher sets the server's core limit (2), is missing or not executable. |
| server | never: `info` says whether a server runs (`GET /status` on `server.sock`), its pid, checkout, build, uptime, pages and terminals, and where its environment came from (5.2), or, while its `GET /status` says `starting`, `the window's server (pid <n>) is starting, from <checkout>, build <build>; run skydeck doctor again once it has started` (ruled by the plan owner, follow-up "server-findable"); `problem` when it runs another build of this checkout (`run skydeck window --restart`), runs from another checkout, is alive but does not answer, answers `GET /ping` but not `GET /status`, or is starting and did not finish within the 5 seconds of the ping wait — it has not written `server.json`, or wrote it late in the wait and has not answered in what was left (5.2: its `window_server` lock names it; `the window's server (pid <n>) is starting and did not finish within 5 s (it holds the window_server lock and has not answered yet); see <stateDir>/server.log; skydeck window --restart stops it`; ruled by the plan owner, follow-up "server-findable"). |
| port | something that is not this installation's server answers on `127.0.0.1:<window.port>`: `/proc/net/tcp` or `tcp6` lists a listener on that port and no server of this installation is alive: one that answers `GET /ping` holds it, and while one is alive but does not answer, or cannot be judged, the port is most likely its own (`info`; the server's own line is the problem). `doctor` never binds the port, not even for an instant (a server starting at that moment would exit 10), and sends nothing to a foreign program. |
| launch alarm | `window_alarm` is set: a launch token was presented twice at <time>, so another program may have skydeck's key (8.2.2); `run skydeck window --new-secret`. |
| keep-alive | a server or a keeper runs and neither protection is in effect — while the server's `GET /status` says `starting` and its keep-alive is still starting by the server's own word (`keepAlive.state` is `starting`), the line is `info` (`keep-alive: not confirmed yet: the window's server is starting, and its first check starts the keep-alive or takes over one that still runs`; ruled by the plan owner, follow-up "server-findable", review 2). A keep-alive that is `off`, or has `failed` (it cannot start: no `WSL_DISTRO_NAME`, …), stays the problem while the server starts too. The line names the one in effect: `.wslconfig has instanceIdleTimeout=-1 (WSL does not stop by itself)`, or `keep-alive wsl.exe running (pid <n>, since <time>)`. `.wslconfig` is read from the Windows profile folder found as in 5.4. Whether the keep-alive runs is the server's word when it answers; otherwise `doctor` judges it as the server judges one it did not start (6.1): its `keepalive.pid` line (one that cannot be read or judged is "cannot be told", never "not running"), and one connection, sending nothing, to the socket `keepalive.interop` names (refused or gone: its `wsl.exe` is gone; never a socket inside the runtime directory). The problem line names the setting and that it takes effect at the next WSL restart; it names `wsl --shutdown` only with what it does (6.1). |
| interop | `WSL_INTEROP` is not set or `<runtimeDir>/interop` points at nothing that answers. While the server's `GET /status` says `starting` the link is pointed later in that start, so a link that is missing or points at nothing that answers is `info` then (ruled by the plan owner, follow-up "server-findable"). |
| C: drive | the C: drive is not mounted at `/mnt/c`, where all of the window expects it (Edge's working directory, the keep-alive's `wsl.exe`, the users' folders of 5.4). |
| Edge | `window.edge` does not exist or is not a file (`info` when the window has never been used). |
| profile folder | it cannot be derived (5.4) and `window.profileDir` is not set. |
| runtime directory | it is not mode 700 or not the user's, or a socket path would be 108 bytes or longer. The line names the directory the store records, or else which rule chose it (4.2), and says `info` when `XDG_RUNTIME_DIR` was passed over because the user does not linger (systemd would remove it when the last terminal closes). |
| vendored files | a file of `vendor/MANIFEST.json` is missing or its hash differs (a broken checkout). |
| keepers | never: `info` counts them from their `.pid` lines (4.2), alive by design 5.5's rule, with their keeper versions and whether each program was started; it never connects to a keeper (7.1). When a server runs, `GET /status` adds what it knows. A `.pid` line of a dead keeper is `info` (removed at the next server start); a `.pid` file that cannot be read is named on its own, as one whose keeper cannot be judged. |

In a test sandbox (`SKYDECK_TEST_NO_WINDOWS=1`, 17) `doctor` and `uninstall` read nothing under
`/mnt/`: the directory `SKYDECK_TEST_MNT_C` names stands for `/mnt/c`, and without it the C: drive
counts as not mounted; the `/usr/bin/python3` line honours `SKYDECK_TEST_PYTHON3` as the launcher
does.

### 16.4 Configuration

New keys, all optional:

| Key | Default | What it does |
|---|---|---|
| `terminal` | `"here"` | Gains the value `"window"` (11.4): `resume` and `new` without an option or with `--tab`, `restore` and the interactive list's `R` start their sessions in the window, through its server, which `skydeck window` must have started; `--here` still starts one in this terminal (plan C13). Any other value is refused as every key of the file is: `<file>: "terminal" must be "here", "wezterm" or "window"`. `doctor` names it: `ok terminal: window (sessions start in the skydeck window; resume, new and restore need skydeck window to run)`. |
| `window.port` | `47613` | The server's port on `127.0.0.1` (5.2). A whole number from 1 to 65535: 0 ("the system picks") is not a setting; tests give it to the server directly (17). |
| `window.edge` | `"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"` | The Edge program (5.3; and links with `window.links` `"edge"`, 9.6). An absolute path. |
| `window.profileDir` | `null` | The Windows folder of the window's Edge profile (5.4). `null`: derived. An absolute Windows path (`<letter>:\…`). |
| `window.keepAlive` | `"wsl"` | `"wsl"` or `"off"` (6.1). |
| `window.links` | `"default"` | Ruled by the lead. Where the links the window opens go (9.6): `"default"`, the Windows default browser (`rundll32.exe url.dll,FileProtocolHandler <url>`), or `"edge"`, `window.edge` in the user's own Edge profile. Anything else is refused as every key of the file is: `<file>: "window.links" must be "default" or "edge"`. |
| `ticketUrl` | `null` | The details ruled by the lead. The address of a ticket, with `{key}` where its key goes (`"https://example.atlassian.net/browse/{key}"`): the group chip of the window's header opens it, and `skydeck show` prints it (12.5). `null`: no link. Accepted only with `{key}` exactly once, at most 2,048 characters, no white space, control character, `"` or backslash, and only when the URL parser, given two different keys in place of `{key}`, reads both as `http` or `https` without a user name or password (`skydeck show` would print it, and Edge's command line would carry it) and with the same host (a host the key went into would differ), and with no `%`, or `%` with one hex digit, right before `{key}` (a key would finish that escape): where the key stands among the address's parts is the parser's to decide, not the text's (`https:///{key}/x` and `https:{key}` are read with the key as the host, `https://{key}.example.net/` with it in the host, `https:///{key}@h/x` with it as the user name: all refused). Anything else is refused as every key of the file is: `<file>: "ticketUrl" must be null or an http or https address with {key} once, after its host`. |
| `ticketStatus` | `[]` | Follow-up F19; the details ruled by the lead. The programs that read a ticket's status (12.5): a list of at most 8 rules, each exactly `{ "match": "<the start of an address>", "command": ["<program>", "<argument>", …] }`; the first rule whose `match` is the start of a ticket's address takes it, before GitHub's own reading of an issue's address. `match`: an `http` or `https` address, printable ASCII with no white space, at most 2,048 characters, with no user name or password, that starts with `<scheme>://<host>/` exactly as the URL parser writes them — scheme and host in lower case, a default port left out —, so that `https://tickets.example.com/` never takes `https://tickets.example.com.other.net/…` and a rule whose scheme or host could never match a stored address is refused instead of silently doing nothing (the rest of its path is not checked). `command`: 1 to 16 non-empty strings without control characters; `command[0]` is the program (a name on `PATH` or a path; a relative path is relative to the home directory), and in the other words every `{url}` becomes the address and every `{key}` the ticket's key (12.5; a rule whose command uses `{key}` is not run for an address that gives none); the program is run without a shell. No credential or token belongs in a rule: a program reads its secret from a file its owner keeps. Anything else is refused as every key of the file is, after `<file>: `: `"ticketStatus" must be a list of at most 8 rules`; `"ticketStatus[N]" must be an object with "match" and "command"`; `unknown key "ticketStatus[N].<key>"`; `"ticketStatus[N].match" must be the start of an http or https address, its scheme and host in lower case and followed by "/", at most 2,048 characters`; `"ticketStatus[N].command" must be a list of 1 to 16 non-empty strings without control characters`. Read at the server's start: after a change, `skydeck window --restart`. |
| `ticketRefreshMinutes` | `10` | Follow-up F19. How long a ticket's status is left before the server reads it again (12.5, 10.1): a whole number of minutes from 1 to 1440, counted from the last attempt; a status whose category is `done` or `closed` is read again after 12 hours instead. Anything else is refused as every key of the file is: `<file>: "ticketRefreshMinutes" must be a whole number from 1 to 1440`. Read at the server's start. |

Unknown keys inside `window` are an error, as everywhere in `config.json`.

### 16.5 Updating skydeck while terminals are open

`git pull` changes the checkout — or `skydeck update`, which does it in an order that keeps the
window (below; follow-up F8, its decisions ruled by the plan
owner). Then:

- **Commands** run the new code at once, and the store migrates at the next command (design 9.2).
- **The server** keeps running the old code — and only its own: at start it reads into memory
  every file it will serve and the keeper's code, writes the keeper's code to
  `<runtimeDir>/keeper-<build>.py` for the keepers it starts, and never reads `web/`, `vendor/` or
  `bin/skydeck-keeper` from the checkout again. So an old server never serves new files under its
  old, immutable asset path, and never starts a new keeper it does not speak. Its **build** is a
  hash (sha256, first 16 hex characters) over the paths and contents of every file under `bin/`,
  `src/`, `web/` and `vendor/`, computed from what it read; names that start with `.` and
  `__pycache__` directories are left out at any depth, so that `python3 -m py_compile` writing
  `bin/__pycache__/` (or an editor's swap file) neither changes the build nor restarts the server
  for nothing, and they are not served either. `skydeck window` computes the same for
  the checkout and restarts a server of the same checkout whose build differs (5.1). A server whose
  store is migrated under it makes no further write and stops (10.1). Sessions keep running across
  the restart, every screen is rebuilt (7.3), and pages reload themselves for the new assets
  (8.2.2).
- **Keepers** keep running the code they started with (7.7). The server speaks their protocol.
- **Vendored xterm.js** changes for page and screen side together, at the server restart: the new
  screen side rebuilds each terminal from a snapshot written as escape sequences, which any version
  reads.

**`skydeck update [--check]`** (src/cli/commands/update.ts) updates the checkout it runs from
(`platform.appRoot`). It is a command the user types; nothing checks for an update or applies one by
itself, and there is no prompt, no `doctor` run at its end and no command to go back (the store
keeps a copy of the database before it migrates it, design 9.2; install.md, "Going back", gives the
steps by hand).

1. **It looks, and refuses** (exit 1, one line, nothing changed) in this order: `CLAUDECODE` set
   without `--check` (the server it restarts would give every session in the window that
   session's environment, 5.1); `git` not on `PATH`; the root not the top of a work tree of its own
   (`rev-parse --show-toplevel` fails or names another real path); a detached HEAD; a branch that
   follows no branch of a remote (no upstream, or a local one); a tracked file changed, staged or
   unmerged (`status --porcelain --untracked-files=no`; untracked files do not count); the fetch
   failing; HEAD not an ancestor of the fetched upstream (ahead or diverged). git always runs as
   `git -C <root> …`, an argument list through the runner — never a shell, never a change of
   directory —, in the command's environment without the variables that would point it at another
   repository (git's own `rev-parse --local-env-vars` list and `GIT_NAMESPACE`), each call with
   10 seconds (the fast-forward 60) and formats that depend neither on the locale nor on the user's
   git settings (`status --porcelain -z`, `for-each-ref` and `log` with NUL-separated fields,
   `rev-list --count`, `ls-tree -z`; `--no-optional-locks` on the status, a look). The fetch is the
   exception: `fetch --quiet -- <remote>` in the user's own terminal with no timeout, as `git pull`
   would be (a passphrase prompt works; Ctrl+C ends it, nothing changed). `--check` fetches too:
   that changes the checkout's remote-tracking refs and nothing else.
2. **It reports** on standard output: `skydeck is up to date (<branch> at <id>, as <upstream>)`
   (exit 0, and nothing else happens: no server is looked at), or `<n> new commits on <upstream>
   (<old>..<new>):` and one line per commit, newest first, at most 20 (`… and <m> more`). Ids are
   the first 7 hexadecimal digits of the commit's id, for reading only; the fast-forward uses the
   whole id. When `src/store/migrations.ts` differs between HEAD and the new commit (or is gone),
   one more line says that the update may upgrade the database, that a copy of it as it was is kept
   first (design 9.2), and that install.md ("Going back") says how to return to HEAD's commit,
   which it names (`SCHEMA_VERSION` is computed, so
   the file's change is the fact that can be known without running the new code; no file of the
   new commit is run or imported to learn more). `--check` ends with `run skydeck update to apply
   it`.
3. **It applies**, in exactly this order. First two looks that change nothing: the index lock
   (`rev-parse --git-path index.lock`, against the root) must not exist — else `this checkout's
   git index is locked (<path>): …; nothing was changed`, before the server is looked at, so that
   an update that must fail at the merge does not stop the server first —, and the untracked files
   are listed (`ls-files -z --others --exclude-standard`) (ruled by the plan owner, review 2).
   (a) The window's server of this checkout (`findServer`, 5.1) — `ours` or another build of it —
   has its `pages` read from `GET /status`, then is stopped as `--stop` stops it (5.5), with
   `--stop`'s line on standard error; one of another checkout is left as it is (one line says so);
   one that does not answer refuses the update (the window's line and `nothing was changed`); a
   database written by a newer skydeck is no refusal (its message asks for this command): the
   server is not looked at, and (a) and (c) are left out (ruled by the plan owner). (b) `merge
   --ff-only --no-squash <the commit the report named>`, by its id — no second fetch, no `pull`;
   `--no-squash` because a `branch.<name>.mergeOptions` of `--squash` would make it exit 0 with HEAD
   unmoved — in a session of its own (`RunOptions.newSession`), so that the terminal's Ctrl+C and
   hang-up do not reach it; after an exit 0 HEAD must be the new commit. (c) Only when (a) stopped
   a server that had a page: the new checkout's own `bin/skydeck window`, run as a new process with
   the command's own environment, working directory and terminal. It upgrades the database (16.5
   above), starts the server of the new code, and waits for the open window: the stopped server
   kept its pages mark (5.1, plan C20), so the new one expects the window back, and the page, which
   tries again for ever (6.3), reloads itself for the new build (8.2.2) and counts as the open
   window; no second window is opened. When the stopped server had no page nothing is started
   (`skydeck window starts it again`); windows are left as they were, and one that does not come
   back within the 7 seconds is replaced as `skydeck window` replaces it. (d) `updated to <id>`,
   exit 0; exit 1 when the child ended otherwise.

   A fast-forward that git refused (it ended with a code), or that could not be started, is looked
   at: HEAD, the tracked files' status and the untracked files against the list read before. As it
   was, (c) brings the window back and the command ends with `the update could not be applied:
   <git's line>; the checkout is as it was`. Not as it was — or not to be told, or a merge that did
   not end by itself (the 60 seconds: `git merge timed out`; a signal), which is never taken for
   "as it was" whatever HEAD and the status say (a cut-off fast-forward leaves HEAD old, the tracked
   status clean, new files untracked and the index lock), or an exit 0 with HEAD elsewhere —
   nothing is started on the files on disk, and the line names where the recovery is described
   (`set it right as docs/install.md says ("Updating"), then run skydeck window`; ruled by the plan
   owner, review 2).

   **Signals** (ruled by the plan owner, review 2 and its re-check): from the moment stopServer is
   called — or, when no server is stopped, from the merge's start — until the last line, SIGINT
   and SIGTERM do not end the command (`Io.holdSignals`), so that it never ends silently with the
   server stopped or the checkout being written. One that came before the merge was started ends
   the update there, once the stop is done: no merge, (c) as for a refused merge, `interrupted
   before the update was applied; the checkout was not changed`, exit 1. One that comes from the
   merge's start on abandons nothing: the merge ends, (c) runs, the result line is printed. The
   merge and every git call after it (the looks at HEAD, the status and the untracked files) run
   in a session of their own, so that the terminal's Ctrl+C cannot cut a look and fake "not as it
   was". After the two lines that follow a bring-back (`interrupted …` and `… the checkout is as it
   was`) a child that did not end with 0 is said as after an update: `…, but skydeck window ended
   with exit <n>; run skydeck window` (or `could not be started or was ended by a signal`). SIGHUP
   is not held: with the terminal gone nobody would read the lines; the merge, in its own session,
   ends by itself. Before the hold starts Ctrl+C ends the command as before (the fetch above all),
   and nothing has changed. install.md's recovery for "may not be as it was" reads the reason
   first, and its default is no reset: only for the command's own three reasons (`git merge timed
   out`, `git merge was ended by a signal`, `git merge ended, but HEAD is not at <id>`) or a line of
   git's saying that it could not write, create or remove a file, the four steps with `git reset
   --hard <upstream>`; any other line of git's is a refusal that wrote nothing (`git status`, move
   away what git names, `skydeck window`, `skydeck update` again; ruled by the plan owner).

   The fetch can wait at a prompt while the checkout is used, so the branch, HEAD and the status
   are read again after it: a changed status is refusal 6's line, a branch switched or HEAD moved
   `this checkout changed while git fetch ran (<branch> at <id>); run skydeck update again`.
   Subjects are shown up to 200 characters (a longer one ends with `…`).

So the old server is stopped **before** any code of the new commit opens the database: the case
`skydeck window` alone cannot make certain (it opens, and so upgrades, the database before it asks
the old server for its pages, and the old server stops by itself at its next write, 10.1) does not
arise, and the window may stay open across an update that upgrades the database.

**The process that runs `update` is the old code.** After (b) the files on disk are the new code,
so from then on it loads nothing: every module it needs for (c), (d) and its way out is imported
statically at its start, no `import()` and no read of `src/`, `web/` or `bin/` follows the merge,
and everything the new code must do is done by the child. The launcher `bin/skydeck` is a shell
script that `sh` is still reading while git replaces it; that is safe because git never rewrites a
file in place — it removes the old file and creates a new one (a new inode), so `sh` reads on in the
old file it holds open —, and after node has ended the launcher only runs a handoff when there is
one (`update` writes none) and exits with node's status.

### 16.6 Vendored files

`vendor/xterm/` holds, at exact versions, each with its `LICENSE`: `@xterm/xterm` 6.0.0 (with its
CSS), `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0, `@xterm/addon-fit` 0.11.0,
`@xterm/addon-search` 0.16.0 (published together with xterm.js 6.0.0 on 2025-12-22, and its
latest release on 2026-11-13; npm registry), `@xterm/addon-unicode-graphemes`
0.4.0, and their type declarations for `tsc`. Only what is used is vendored, at
`vendor/xterm/<package directory>/<path in the package>` (`vendor/xterm/xterm/lib/xterm.mjs`,
`vendor/xterm/headless/lib-headless/xterm-headless.mjs`): each package's ES module bundle
(`.mjs`), its `typings/*.d.ts` and its `LICENSE`, and `@xterm/xterm`'s `css/xterm.css` — no UMD
`.js`, no source maps, no sources. `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0
ship no `LICENSE` file: for them `npm run vendor` writes `@xterm/xterm`'s, and only after checking
that the package's `package.json` declares `MIT` and the repository of `@xterm/xterm`
(`github.com/xtermjs/xterm.js`; a `#branch` or a path inside the repository is ignored), and fails
otherwise. Beside each bundle it writes a declaration file `<name>.d.mts` that re-exports the
package's typings by the package's name, so that `tsc` for `web/` never reads a bundle; the
typings themselves are vendored beside the bundles, within a type checker's reach.
`@xterm/addon-unicode-graphemes` bundles adapted copies of tiny-inflate and unicode-trie (both
MIT) without their notices, so the script also writes `vendor/xterm/THIRD-PARTY-NOTICES`, which
names that bundle and holds both licences as their packages publish them on npm. One vendored
file is changed: `@xterm/addon-serialize` 0.14.0's `_diffStyle` turns bold off and dim off both
with SGR 22, which turns off both, so a snapshot rebuilt a bold cell after a dim one without its
bold (section 21; unfixed on xterm.js's master on 2026-11-13). `npm run vendor` checks that the
installed bundle is the one the patch was written for (its version and sha256), replaces the two
clauses — each text must occur exactly once — so that SGR 22 comes first whenever bold or dim
goes off, followed by SGR 1 and 2 for what the cell keeps, and refuses otherwise; the notices
file says the bundle is modified and how. The patch is dropped when a release fixes it.
`vendor/MANIFEST.json` lists every file with its
package, version and sha256 — paths relative to the checkout, the shims and the notices under
the package `skydeck` with version `-`, a borrowed licence with `licenseFrom` (`@xterm/xterm`) and
`licenseReason`, the patched bundle with `upstreamSha256` (the file as the package ships it) and
`patch` (what was changed and why). The same packages at the same versions are development dependencies;
`npm run vendor` copies them into `vendor/` and writes the manifest, and a test fails when
`vendor/` and the installed packages differ, so they are updated only together. `addon-webgl` is
not vendored in the first version: the DOM renderer is enough for Claude Code's output, and WebGL
in a managed Edge is one more unknown.

## 17. Testing

Design 12's rules hold: tests are written before the code they test, never start the real
`claude`, never read or write the real `~/.claude`, never use the network, run under a temporary
`SKYDECK_HOME` and `claudeHome`. Added: tests never start a Windows program, and a server under
test listens on a port the system picks (port 0, given to the server directly; `window.port`
accepts 1–65535 only, 16.4).

**No Windows program, enforced.** A WSL machine has a real `msedge.exe`, `wsl.exe`,
`rundll32.exe` and `/run/WSL/1_interop`, so the rule is built in rather than only asked for. The test sandbox's
environment carries `SKYDECK_TEST_NO_WINDOWS=1`; while it is set — in skydeck's own environment or
in the one given to the child — the real platform refuses to start a program that is under `/mnt/`,
ends in `.exe` (any case) or starts with `MZ` (what WSL interop runs), also when the name reaches
such a file through `PATH` or a symbolic link: the start fails with the code `EWINDOWS` and nothing
runs. A test platform that can start a real process refuses them always, whatever any environment
says; the pure fake starts nothing: it records the start and returns what the test scripts, also for
a Windows program, so that a test can check the command line Edge or the keep-alive would get. Every
test that starts a server gives it a sandbox `config.json` whose `window.edge` is a stub that
records its arguments, whose `keepAlive` is `off` and whose `links` is `"edge"` (so that every link
reaches the stub; the default would hand it to `rundll32.exe`, which is refused), unless the test is
about them, and points the first interop candidate (6.4) into the sandbox. A test of the default
browser stands in for `rundll32.exe` in its own platform and never passes it on. Without the
variable nothing is refused: the rule belongs to the tests, not to skydeck.

**Two test platforms.** Logic is tested on a platform with a fake clock, a fake `/proc` and fake
processes. Every test that starts a keeper, the stand-in or a server, or judges a real process
alive, uses the second one: the real clock, the real `/proc` (only the boot id it reports can be
overridden, to show the server what a WSL restart looks like, 6.3), this process's pid, real
processes that refuse Windows programs always, and the programs a keeper, the stand-in, the hook
and the launcher need linked into the sandbox. With the fake clock a keeper's start deadline would
lie in its real past and its `.pid` line would count as dead. A test that starts keepers ends them
itself, and only after checking that the runtime directory lies inside its sandbox.

### 17.1 The stand-in program

`test/fixtures/standin/` is a Node.js program that the tests configure as `claudeCommand`. It
behaves like the parts of Claude Code that skydeck depends on, and nothing else:

- as a terminal program: on start it sends DA1 and waits for the answer (and says so on screen if
  none comes), asks for the cursor position, uses colours, the alternate screen and mouse mode on
  request, redraws on SIGWINCH, echoes input in a way the test can check (`\n` versus `\r`, a
  bracketed paste, `\x16`);
- as a session: it reads `--session-id` or `--resume`, writes a live-session file into the
  temporary `claudeHome` with status changes (`idle`, `busy`, `waiting`) on command, and runs the
  real `bin/skydeck-hook` with `SessionStart` and `SessionEnd` inputs and `CLAUDE_PID` set, so
  ingest sees it as it sees `claude`; it exits on `/exit` (reason `prompt_input_exit`) and on
  SIGHUP (reason `other`).

### 17.2 The keeper

Driven over its socket by `node:test` with real python3 (CI has it):

- the program never starts on a connection alone; it starts on `G` before `startBy`,
  once; a `G` after `startBy`, a deadline that passes with no `G`, and `N` each end the terminal
  not started, with `X` `notStarted`, and the program is never run (the stand-in records every
  start in a file the test reads); `hello` says `started` truly before and after;
- the `.pid` line: written at start with `started` 0, rewritten with 1 at the start, removed at
  the end; non-dumpable — the kernel then gives the process's `/proc/<pid>/` files to root, so
  the check is that its `status` is owned by uid 0 and that the same user cannot open its
  `environ` (`EACCES`), while its program's files are the user's again after `exec` (`status` has
  no `Dumpable` line on this kernel, 6.18; checked by both plan reviews);
- input: a paste of 8 MiB into a stand-in that does not read for a while neither stops the
  keeper's output nor loses bytes; the queue limit and the server's `input-full`;
- output, input, resize as records in order; `R` echoed;
- park, the tail trimmed to the snapshot, reconnect giving snapshot plus exactly the tail;
- a new claim replacing the old screen side; a first frame other than `C` closes the
  connection; a peer with another user id refused (where the test can arrange it);
- a frame it cannot parse closes the connection and the keeper lives on;
- the tail cap and `gap`; the send queue cap;
- exit status after a normal exit, a signal, and `exec` failing (127); `A` ending the keeper; the
  10-minute linger (shortened through an environment variable that only tests set);
- killing the keeper ends the program (SIGHUP), and the stand-in reports `SessionEnd` `other`;
- `T` comes once after `G`, before the first output, with the program's pid and process start;
  with a failing `exec`, `T` then `X` 127.

**The keep-alive script** (`bin/skydeck-keepalive`), with real `sh` and real processes: it stays
while a `.pid` line names a live process; it ends when every line names a dead one, one of another
boot id, or a live pid with another process start (a reused pid); it writes its own two files
atomically. `wsl.exe` is replaced by running the script directly.

### 17.3 The server

With real sockets on `127.0.0.1` and real keepers running the stand-in:

- the WebSocket: the frame tests of the prototype (0 bytes to 1 MiB, fragments, ping and pong,
  close codes, invalid UTF-8, unmasked frames), with `ws` as a development dependency for the client;
- authentication: a wrong page proof, a proof replayed on a new connection (fresh nonce), a proof
  made with the server's label, a missing `hello`; wrong `Origin`, wrong `Host`, `OPTIONS`; CORS
  headers never present; the secret's bytes appear in no frame and no log line the tests capture;
- the handshake's vector (8.2.2): the server's proofs and `key` for the fixed inputs;
- `T` resolves `open()`; a holder whose pid is the program, or descends from it, maps to the
  terminal at once, without a server restart;
- nobody but the server connects to a keeper: `doctor` and `uninstall --purge` run against keepers
  whose sockets record every connection, a not-started one included, and none is recorded; the
  not-started keeper stays not started;
- `skydeck resume --window` and `new --window` with no server running print `the window is not
  running…` and exit 1, and start nothing; `restore` says it before its prompt;
- `serve` refuses with `CLAUDECODE` set (exit 13); the `serve` process has a soft core limit of 1
  byte and the old hard limit (`/proc/<pid>/limits`), and a keeper's program has the soft limit the
  launcher found; `skydeck window` prints each fixed message of 5.2 for each exit code of a
  fake `serve`;
- launch tokens: minted over `server.sock` and never written to the store or a file; one works
  once — two pages racing with the same token, one gets `welcome`, the other 4004 and the alarm
  is raised (`window_alarm`, `GET /token/<id>` says `reused`, `doctor` reports it) —; an expired or
  dropped one fails with 4003; a page holding a stored key and given a token uses mode `launch` and
  ends with the new key; `skydeck window` drops its token when its wait ends, used or not;
  `--new-secret` clears the alarm; `key` opens only with the token and both nonces; a nonce that is
  not exactly 32 bytes of base64url closes the connection;
- the runtime directory: a command run without `XDG_RUNTIME_DIR` finds the server and the keepers
  through the store's record; a server started without `XDG_RUNTIME_DIR` while keepers live in the
  recorded directory uses that directory and finds them; a record whose directory is missing or
  empty of live keepers is replaced; `uninstall --purge` sees a live keeper in any candidate
  directory;
- the waiting command: it reports success only after 2 more seconds without a second use, and
  reports the alarm when the second use comes in that time; with `window_alarm` already set it
  goes on and prints the `--new-secret` line; a page that failed once with its token never
  presents it again;
- the lock (5.2): a second server of the same installation refuses, on another port, from another
  checkout and in the foreground; a stale lock of a dead server is taken over; `--restart` waits for
  the old process, signals only a process whose identity it confirmed, and never a keeper; the
  `window_launching` lock gives one Edge start for two commands;
- the environment: `skydeck window` refuses with `CLAUDECODE` set; a program's environment lacks
  the removed variables (7.4) and the launcher's cache variable, and has `PWD`;
- logs: a malformed `hello`, `start` and `input` carrying marker text leave the marker in no log
  line (the error is logged by kind, 2);
- updating: after the checkout's `web/` and keeper file change on disk, a running server still
  serves and starts what it hashed; a migration made by a command makes the server write nothing
  more and stop;
- the unix socket: mode 600 in a directory of mode 700; a body with an unknown field is refused
  and starts nothing; a field that tries to name the program or a whole argument list (`argv`,
  `cwd`, `command` on `/resume`; `--resume`, `-c`, `-n`, `--session-id` among `/new`'s flags; a
  relative or missing directory) is refused and starts nothing; a valid `/new` starts
  `claudeCommand` with exactly `buildNewCommand`'s arguments (the stand-in records them);
- places: with `SKYDECK_HOME` set, the runtime directory is `$SKYDECK_HOME/run` whatever
  `XDG_RUNTIME_DIR` says, and the server, the keepers and the keep-alive script create and open
  nothing outside `SKYDECK_HOME` and the test's temporary directories;
- protocol: `challenge`, `hello`, `welcome`, `start`, the 5-second limit, the protocol and asset
  version decisions;
- rediscovery: a server restarted between spawning a keeper and `G` runs the guard and the lock
  check before `G`, and sends `N` when the session runs elsewhere, the lock is someone else's, or
  the deadline passed;
- screen side: exact rebuild cell by cell after a restart of the server with unparked records and
  resizes; the modes the serialise addon misses (25, 1006, cursor style) and the cursor fix; each
  query answered exactly once and none while replaying; OSC 10 and 11 from the page's theme;
- several pages on one terminal: shared order, the size owner rule, `size` in stream order;
- backpressure: a page that does not read gets `snap` after draining, and the keeper is never
  paused;
- the terminal–session mapping (7.5): resume, `/clear` emulated by the stand-in, a wrapper as
  `claudeCommand`, starting and "started, not reported";
- resume, new and restore through the window terminal: the guard, the lock, `settleFailedLaunch`,
  restore's batches and wait — the same cases as step 1's tests, with the window terminal;
- turn ends (10.3) and attention (12.4) with a fake clock and live files the test writes;
- the failures of section 14 that can happen inside Linux: server killed and restarted, keeper
  killed, python3 missing (a `PATH` without it), port taken, store locked;
- the keep-alive and Edge with a fake runner: the arguments, the profile folder derivation, the
  retry schedule, `--print-url`, a connected page preventing a second window.

### 17.4 The page

The view model (`src/window/view/`) and the key table (`web/keys.js`) are pure and tested with
`node:test`, like the interactive list's `reduce` and `render`: sections, order, stacks, the chip,
attention and its order, the switcher's ranking, the filter, every key of 12.9 on a US and a Czech
layout (as `KeyboardEvent`-like objects), and which keys are cancelled (Alt+F4 never).

**A headless browser as a development dependency: for.** What breaks in a page — xterm.js
integration, that the page's terminal answers no query, the Shift+Enter and Ctrl+Shift+V mapping
reaching the server as bytes, the CSP not blocking the page's own files, reconnecting after the
server restarts, notifications asked only on a gesture — is only real in a browser, and the UI
research already drove its mockup in headless Chromium. The cost is a development dependency and
a browser download in CI, never at install time. So `playwright` (pinned exactly: 1.60.0, the
version whose Chromium is build 1223)
drives Chromium headless against a real server and keepers running the stand-in, in a small suite
(`npm run test:page`). Chromium is not Edge: what only Edge decides (keys an app window keeps,
its policy, notifications on the PC) stays a manual check.

In the browser suite, besides those:

- the content security policy: a cell written red has the computed colour red (xterm.js's own
  `<style>` elements work), and an inline script does not run;
- keys: Ctrl+Shift+P sends nothing to the terminal (xterm.js 6.0.0); a paste with Ctrl+V reaches
  the server as a bracketed paste and never as `\x16`; Ctrl+Shift+V as `\x16`; Shift+Enter as
  `\n`; Alt+F4 is not cancelled; a paste of 2 MiB arrives whole, in messages of at most 64 KiB;
- the handshake's vector (8.2.2) through Web Crypto: the page's proofs and the unwrapped key's
  proofs equal the pinned values;
- the key: the launch token leaves the address before any connection opens; after a reload the
  stored key works and its bytes cannot be exported (`exportKey` fails); the page sends nothing
  after `hello` until the server's proof checks out, and against a stand-in server with a wrong
  proof it sends nothing at all and shows the warning;
- a dropped file does not navigate the window; OSC 52 from a hidden terminal does not reach the
  clipboard;
- reload: F5, Shift+F5, Ctrl+R, Ctrl+Shift+R and Ctrl+F5 in the list zone, Ctrl+Shift+R in the
  terminal zone, BrowserRefresh in both if Playwright can send it, and F5 and Ctrl+R in the
  terminal zone while the page, not xterm.js, has the keyboard, reload only after a server's
  proof, and not at all against
  a stand-in server without one;
- a stand-in server holding the port serves a page that registers a service worker; after the real
  server is back, whether the worker still answers the next load (the 404 of 15.3) is recorded, so
  that W25 and 15.3 can be settled. Recorded in Chromium (plan task 26): it does — the worker
  answers the next loads, and an update check that gets the 404 fails and leaves it registered.

No test shows a desktop notification or asks for a permission (stage B, plan B17), whatever a
server sends: every browser context of the suite is made by `newContext` of
`test-page/helpers/browser.ts` (and `newPage` with it), which gives its pages an inert
`Notification` — its permission `denied`, `requestPermission` answers `denied` and asks nothing, a
notification made anyway shows nothing — unless a recording double is there, and in any case a
service worker's `showNotification` that refuses. The cases about notifications install one, and a double of
`document.hasFocus` (`test-page/helpers/notification.ts`); the double sets a marker, so that either
order of the two init scripts ends with it (Playwright orders a context's and a page's init scripts
in no defined way). A case pins that no context is made elsewhere under `test-page/`, and no test
grants a permission through Playwright.

### 17.5 Where the tests are, and what CI runs

- `node:test` tests stay under `test/` and are what `npm test` runs (`test/**/*.test.ts`). The
  browser suite lives in `test-page/`, outside that glob, and runs with `npm run test:page`
  (`test-page/**/*.test.ts`). It is `node:test` files that use the `playwright` library
  (`chromium.launch()`), not `@playwright/test`: the repository keeps one test runner. Each of its
  files launches one headless Chromium (`test-page/helpers/browser.ts`) with a test sandbox's
  environment (another home, no display), with its and Playwright's temporary files (the
  profile, the artifacts) inside the sandbox, so that even a killed run leaves them nowhere else
  (the tests read the browser's home, temporary directory and profile from `/proc`, and a launch
  that fails leaves nothing outside its sandbox), and with its pages in the UTC time zone and the
  language `en-US` (Chromium itself runs with another zone and language, so that a page made
  otherwise shows). A page under test reaches
  nothing but `127.0.0.1`: no host name resolves, not even `localhost`, and neither `fetch`, a
  WebSocket nor WebRTC reaches another loopback address; the smoke test proves it against
  listeners on `127.0.0.2`. Its TypeScript is type-checked with the root project; the plain
  JavaScript of the pages it serves (`test-page/fixtures/`) runs in the browser and is not.
- `web/` has its own `web/tsconfig.json` (the DOM library, `checkJs`, the vendored type
  declarations); `npm run typecheck` runs `tsc` for the root project and for `web/`.
- `npm run check` runs format check, both type checks, `npm test` and `npm run test:page`. Without
  an installed Chromium the page suite fails with the one command that installs it — exactly
  `Chromium for Playwright is not installed; run: npx playwright install chromium`, which a test
  pins — so that a local check does not pass where CI would fail.
- CI, on every pull request and every push to `main`, runs the newest leg of the Node matrix
  (Node 24). The oldest leg (Node 24.12) runs only when the workflow is started by hand
  (`workflow_dispatch`: the owner's decision, to save CI minutes), and a run started by hand runs
  both legs. The work is split into three kinds of job that run side by side, so that a pull
  request waits for its slowest job (about 10 minutes) and not for the sum of them (about 32
  minutes when they ran in one job). The jobs are named `lint (node 24)`, `unit (node 24, 1/3)` and
  `page (1/3)`: the Node version is in the name of the first two because a run started by hand has
  both legs of them. `lint` runs format check, type checks,
  `python3 -m py_compile bin/skydeck-keeper` and `shellcheck` on the shell scripts by name —
  `bin/skydeck`, `bin/skydeck-hook`, `bin/skydeck-keepalive` — because today's `shellcheck
  bin/skydeck*` would also match the python keeper; it also checks the shard lists (below).
  `unit (i/n)` runs `npm test` (keeper and
  server tests included; Ubuntu runners have python3; the vendored-files check of 16.6,
  `test/vendor/vendor.test.ts`, is a test in `npm test` that needs the packages `npm ci`
  installed, so it has no step of its own). `page (i/n)` runs the page suite. CI does not run
  `npm run check` (format check, both type checks and the two suites in a row; it has neither
  `shellcheck` nor `py_compile`). A suite runs in n shards, each a job of its own (three for each
  suite; the job's `shard` list in the workflow holds `1/n` to `n/n`, each entry naming the count
  too, so a wrong list, an entry added or left out, would leave files unrun or run twice with
  every job still green; a step of `lint` therefore reads the workflow as text and fails unless
  every `shard` list is exactly `1/n` to `n/n` for one n, there are as many lists as steps that
  give Node a shard, and no line of the workflow opens a matrix `include` or `exclude`, which could
  add or drop a shard without touching a list): Node's
  `--test-shard=i/n` cuts the sorted list of test files into n parts by taking every n-th file,
  so the shards together run every file once, no file is named in the workflow, and a new test
  file needs no upkeep there. The workflow gives the option as `NODE_OPTIONS` and not as
  `npm test -- --test-shard=i/n`: npm puts that argument after the glob in `package.json`, where
  `node --test` ignores it without a word and every shard would run the whole suite. The suites'
  sandbox (`test/helpers/sandbox.ts`) builds the environment of its child processes from nothing,
  so it drops `NODE_OPTIONS` and the nested `node --test` runs of `test-page/smoke.test.ts` stay
  whole; a test that started `node --test` with the inherited environment would take the shard
  too and could pass with no test at all. The commands
  in `package.json` and `npm run check` stay as they are. A job has a time limit of its own: 10
  minutes for `lint`, 25 for a shard; the test step of a shard has 20 minutes of its own, because a
  job that reaches its limit is only cancelled, which not every reader of the checks takes for a
  failure, while a step that reaches its limit fails its job; so a pull request is good when every
  one of its checks reads pass (a cancelled job is not a pass), not when a command's exit code is
  0. A failing shard does not stop the others (`fail-fast` is
  off), so one run shows every failure. Only the newest leg (Node 24) runs the page suite, and it
  runs on Ubuntu 24.04 while the other leg runs on the newest
  Ubuntu (26.04), because Playwright 1.60.0 has no Chromium for Ubuntu 26.04; the page job's
  runner pin, and with it the Node 24 leg's, is dropped when Playwright is upgraded. A run started by hand runs `lint` and
  `unit` on both legs (the oldest leg's `unit` is in shards too, so that the one workflow has one
  shape) and `page` on the newest leg only. Each `page` shard reads the installed Playwright's
  version and the system's (`ID-VERSION_ID` of `/etc/os-release`), restores
  `~/.cache/ms-playwright` from the cache keyed by both, runs `npx playwright install --with-deps
  chromium` (the browser is downloaded only when the cache missed; the system libraries it needs
  are installed every time) and then `npm run test:page` with its shard.

## 18. Manual checks for step 2

What only the real Claude Code or the Windows desktop can settle: the lists of the three research
tracks (terminals, window, UI), merged. Each check names the stage that needs it (19) and the
sections it can change. They join [manual-checks.md](manual-checks.md) when their stage is built;
the research's check kit (an Edge key-test page, a lifetime script for a throwaway distribution) is
in the repository, in `docs/check-kit/` (ruled by the plan owner, stage A's plan task 30). Items
marked **real claude** use a real session in a throwaway folder, as in manual-checks.md.

| # | Check | Stage | Decides |
|---|---|---|---|
| W1 | `skydeck window` opens an Edge app window that loads the page and connects. (That Edge reaches a server on `127.0.0.1` in WSL was verified on a Windows PC on 2026-11-13; this checks the command itself: the profile folder, the start, the wait for the page.) Write down how long Edge took from the command to the page's connection, cold and warm: the token and the command's wait last 30 seconds (5.1). | A | 5, 8.2.2 |
| W2 | The chords of 12.9 that the key test of 2026-11-13 did not press reach the page and the browser does nothing: Ctrl+Shift+P, J, L, F, C, H and 1–9; and Alt+F4 still closes the window once the page is built (12.9). Whether Edge reloads on Shift+F5 and on the BrowserRefresh key (alone, with Shift, with Ctrl) when the page does not cancel them, and whether a cancelled BrowserRefresh still reloads (through `WM_APPCOMMAND`) (12.9, 15.3). In a normal tab (`--print-url`), which chords the browser keeps. | A | 12.9 |
| W3 | The window has its own taskbar button with skydeck's icon (12.12), the same one after `skydeck window --restart` and after a WSL restart (looked at only when WSL restarts anyway: a restart ends every session; else written down as left out), and the title `(n) skydeck`; a second `skydeck window` opens no second window. Whether Edge's menu offers to install the page as an app (it has a manifest, 12.12): written down, never done. | A, B, E | 5.1, 12.1, 12.12 |
| W4 | **Real claude** in a window terminal: status line, subagent display, spinner, redraw on resize. Then `skydeck window --restart`: the screen is exactly what it was. | A | 7.2, 7.3 |
| W5 | **Real claude**, the screen side answering alone: does Claude Code use synchronized output; does the OSC 11 answer make its automatic theme right; with an XTVERSION answer `xterm.js(6.0.0)` (a one-line change), any visible effect? | A | 9.3 |
| W6 | **Real claude**: Shift+Enter inserts a newline; Ctrl+V pastes text; Ctrl+Shift+V pastes a Windows screenshot; Ctrl+Shift+C copies a selection, and a program's OSC 52 write reaches the Windows clipboard. | A | 9.1, 9.5 |
| W7 | W6's Ctrl+Shift+V again after closing the WSL terminal `skydeck window` was run from (the interop link of 6.4). | A | 6.4 |
| W8 | Czech layout in Edge: AltGr characters (`\ [ ] { } @ # ~ \|`) and dead keys (háček, čárka) in a terminal; Ctrl+Shift+digit and Ctrl+Shift+H chords; Ctrl+Shift+- reaches Claude Code (undo). | A | 9.1, 12.9 |
| W9 | Cascadia and Segoe draw Claude Code's `⏺ ⎿ ⏵` (headless Linux showed empty boxes). | A | the page's font list |
| W10 | **Real claude**: rows with emoji, ZWJ and skin-tone sequences line up; `unicode-graphemes` against `unicode11`, compared with Claude Code's own layout. | A | 9.4 |
| W11 | Desktop notifications are allowed on the PC: the permission prompt, a toast, a click that selects the session; and they still come when the window has been minimised for half an hour (Chromium throttles hidden pages and Edge may put them to sleep). | B | 13 |
| W12 | Ctrl+click on a link opens it in the user's default browser, logged in; with `window.links` `"edge"` (set only if the user wants to try it) in their main Edge window. The check copies the user's `config.json` aside first and gives it back at the end, and removes no file. | A | 9.6, 16.4 |
| W13 | `edge://policy` (any `URLBlocklist`, `BrowserSignin`, `SyncDisabled`, `WebApp*`, `Extension*` entry), `edge://extensions` in the window's profile (which extensions are forced in), and whether the window's profile is signed in and syncs its history (`edge://settings/profiles`). | A | 15.1, 15.2 |
| W14 | WSL lifetime: the lifetime script against a throwaway distribution measures the idle rule; then, with the window open and every WSL terminal closed, WSL is still running after a minute (`wsl -l -v` in PowerShell). Without the keep-alive (`"off"`) it stops. | A | 6.1 |
| W15 | Sleep: with the window open, lock or sleep the PC for a few minutes. The page recovers by itself, keys work, the terminal repaints, sessions still run. | A | 6.5 |
| W16 | WSL stop drill: `wsl --shutdown` with the window open and three throwaway sessions in it (and no real session running). The bar of 6.3 appears; after `skydeck window` the old window comes back (no second one) and says WSL restarted, and the banner offers the three; "Restore 3" brings them back into the window. Optional: with the window minimised for more than 5 minutes, whether a second window opens (5.1's named limit), and Not now survives a server restart; `resume --window` opens the window by itself; after a PC restart with the window left open, whether `skydeck window` waits. | C | 5.1, 6.3, 12.7, 11.4 |
| W17 | **Real claude**, `/tui fullscreen`: the alternate screen and the mouse mode come back after `skydeck window --restart`. | A | 7.2 |
| W18 | **Real claude**: a terminal query answered late (the server stopped for a few seconds while Claude Code starts) — does the answer leak into the prompt? | A | 7.1, 14 |
| W19 | **Real claude**: does `waitingFor` tell a permission prompt from a question? | B | 12.4 |
| W20 | Privilege management does not block or prompt for `msedge.exe`, `wsl.exe` and `rundll32.exe` (with `window.links` `"default"` the server starts it for every link) started through interop; a silent block of `rundll32.exe` shows as a link that opens nowhere with an empty key bar. | A | 2, 5.3, 6.1, 9.6 |
| W21 | **Real claude**: a turn that ends in a session that is not selected shows "finished · not seen"; selecting it for 1.5 s clears it; a permission dialog shows "asks". | B | 10.3, 12.4 |
| W22 | **Real claude**: a session started in a WSL terminal shows "running in another terminal", Resume is refused with the guard's message, and after `/exit` it resumes into the window. | A | 7.9 |
| W23 | **Real claude**: which `CLAUDE*` variables Claude Code sets for the programs it runs — print the variable names (never their values) in a session's `!env` against a plain shell's — to confirm 7.4's list. And `skydeck window` run from a session's `!` command refuses (5.1). | A | 5.1, 7.4 |
| W24 | Crash dumps: kill a stand-in keeper, and a throwaway `node` started through the launcher's `/usr/bin/python3 -I -S -c` program (soft core limit 1 byte), by SIGSEGV; does a dump appear in WSL's crash folder (`%Temp%\wsl-crashes`, or `crashDumpFolder` in `.wslconfig`)? Neither should. | A | 2 |
| W25 | A Windows program holding the port: with a small Windows program listening on `127.0.0.1:<port>` before skydeck's server starts, does the WSL server still answer from Windows on `[::1]:<port>`? If it does, a program between page and server is possible (15.3). Also: does Edge drop a service worker whose script the real server answers with 404? Answered for Chromium by the page suite (17.4, plan task 26): no, the worker keeps answering and stays registered; Edge itself is still to be checked here. | A | 15.3 |
| W26 | **Real claude**, using the alternate screen (`/tui fullscreen`, or a full-screen program it runs): `skydeck window --restart` while it is showing, compare the screen before and after, then leave the alternate screen and compare again. What a snapshot does not restore (7.2: scroll region, saved cursor, character sets) would show as a misplaced cursor or wrongly scrolled or drawn lines. | A | 7.2, 7.3 |
| W27 | With `ticketUrl` set to the user's ticket system's address and the throwaway session labelled with one of their ticket keys, the group chip shows `↗` and a click opens that ticket where links open (W12), logged in; without `ticketUrl` the chip is plain text. The check copies the user's `config.json` aside first when there is one and gives it back at the end only when the file holds no change since but the check's own line (else the user mends it by hand); when there was none, it removes the file it created; it clears the label it set. | D | 12.5, 9.6 |
| W28 | `+ PR` with a pull request of the user's own on the throwaway session: its item and its line in the pull-request dialog show its state within seconds (their `gh` login), the list's chip agrees, `skydeck show` agrees; the state agrees with what GitHub's page waits for (F32); × detaches it. | D | 12.3, 12.5 |
| W29 | **Real claude**, on two layouts (US, Czech): `l`, F2, `g`, `n`, `p` and `d` in the list; Enter saves a label, Ctrl+Enter a note, Esc twice discards a changed note; Undo in the toast brings the session back; `skydeck show <short id>` in a WSL terminal shows the same label, group and note. With changed text in the note's dialog, F5 and the keyboard's refresh key do not reload the window; if one does, the text is lost — write down which key, and report it (the reload guard of 12.9 does not hold in Edge for it). Every step uses the throwaway session and checks the header's short id or the dialog's heading first; after `d`, Undo before the next key; at the end the check clears the label, group and note it set. | D | 12.5, 12.9 |
| W30 | On the user's own sessions, without Enter: two words of a ticket in the filter, a short id's first characters, each chip, a block's card closed with ← and opened again with → (blocks are open by default from follow-up F3, drawn as cards with a selectable caption from follow-up F9), a click on a caption, the switcher opened, typed into, moved through with ↑ ↓ and closed with Esc. Whether any answer comes late enough to notice, and whether the order of the switcher is the one wanted. Then **real claude**, the throwaway session only: found in the switcher by the first characters of its short id, the highlighted item's short id checked, and Enter: it resumes into the window (its terminal shows when it runs there). Text is typed only into a field that shows its caret, and no real session is resumed, typed into or marked. | E | 12.2, 12.8 |
| W31 | Czech and US layouts in the filter's and the switcher's fields: AltGr characters and dead keys type; Ctrl+Shift+P opens and closes the switcher on both. | E | 12.8, 12.9 |
| W32 | `skydeck update` on the user's own installation, typed in a WSL terminal of the user's own with the window open: `--check` first (the list of new commits, or "up to date"; the window and the sessions stay as they are); then, only when it listed commits, the update itself: the window says for a few seconds that the server is not answering, then reloads itself; every session is there; no second window; `skydeck doctor` has no `problem` line that was not there before. It types into no session and presses no key in the window. | F8 | 16.5, 5.1 |
| W33 | **Real claude**: `skydeck install` asks whether to turn Claude Code's ← shortcut off (three lines and `Turn the shortcut off? [y/N]`); `y` sets only `leftArrowOpensAgents` to `false` in `~/.claude.json`, after a backup, and `skydeck doctor` then says the shortcut is off; in a throwaway session of the window started after it, ← on its empty prompt leaves the terminal as it is (no agent view). It changes that one key of the user's on purpose and prints neither file. | F11 | 7.9 |
| W34 | **Real claude**: the title bar's theme switch in the user's Edge: `Auto`, `Light`, `Dark` — what the page and a terminal show in each, under the Windows mode of the moment and, optionally, the other one; the choice after a reload and after the window is closed and opened again, with no flash of the other theme; with Claude Code's theme "Auto (match terminal)" (looked at in `/theme`, never in its files), a new throwaway session started in each forced state picks the matching one, and whether one already running changes its theme at a switch is written down (not documented). At the end the switch, Windows' mode and Claude Code's theme are as they were. | F13 | 12.1, 7.2, 9.3 |
| W35 | **Real claude**, a throwaway session started from the New form with `--model` and one more flag: the header's second line ends in those flags, in the short id's grey, after the short id, nothing else of the line moved; its tooltip says `Started with: …`; in a narrower window they are cut first; once it ended and was closed, the resume card's "Will run" has them and the header not; resumed, the header shows them again. | F16 | 12.5 |
| W36 | The new form's favourite flags on a throwaway folder: a favourite saved with the ★ is there when the form is opened again, also after `skydeck window --restart`; a session started with its chip on runs with those flags (the header's flags, F16, and `skydeck show`); removed with ×, `Undo` puts it back at its place; with a session of the user's in a group selected, the form shows that group's chip, and a click puts the name into the Group field (nothing started). It types no prompt and changes no real session. | F15, F28 | 12.6, 10.2 |
| W37 | A ticket on a throwaway session (follow-up F18): set by a whole link (`https://example.com/browse/TRY-1`, a host that opens nothing private), the header's third line starts with its chip `TRY-1 ↗`, its tooltip the address, a click opens it where links open (W12); set by a key only while `ticketUrl` is configured (else that step is skipped); removed with an empty text, the chip gone and `+ ticket` back; `skydeck show` prints `ticket:` while one is set. Every step checks the header's short id or the dialog's heading first; at the end the session has no ticket. | F18 | 12.5, 10.2 |
| W38 | A ticket's status on the throwaway session (follow-up F19), asking no real tracker: a stand-in program the owner writes in a throwaway folder (`~/skydeck-try/status`, its three lines given) answers for a `ticketStatus` rule whose `match` is `https://example.com/try/`; the ticket `https://example.com/try/TRY-1` on the throwaway session shows `TRY-1 · In Progress ↗` in blue in the header and `In Progress` in the row's small chip; the answer changed to each category and ↻ pressed in the ticket dialog: `blocked` red, `review` amber, `doing` blue, `done` green, `todo` and `closed` grey; a failure (the program made not executable) keeps the old status and its tooltip says `status not read: …`; `skydeck show` prints `ticket:` with ` · <status>`. Every step checks the header's short id or the dialog's heading first; at the end the ticket is removed, `config.json` is as it was (restored from a copy), and the stand-in is deleted. | F19 | 12.5, 12.2, 12.3, 10.2 |
| W39 | **Real claude**, a throwaway session started after the update: `d` on it while it waits shows the dialog with the keyboard on `Mark done, keep it running`, Esc changes nothing; `d`, ←, Enter ends it (`Ending the session…`, then `Ended and marked done: hidden from the list.`), the row leaves Open; with `a` it is done and not ended unexpectedly, `skydeck show` shows no such mark (so restore does not offer it); undone and resumed, its conversation is there; `d` while it works shows the warning with the keyboard on `Mark done, keep it running`, and Enter keeps it running, marked done. | F30 | 12.10, 7.7 |

Checked by tests rather than by hand (17.4): that xterm.js 6.0.0 sends nothing for a
Ctrl+Shift+letter, that a paste with Ctrl+V gives a bracketed paste and no `\x16`, that the page's
terminal answers no query, and that colours survive the content security policy.

## 19. Staged delivery

Each stage is a set of pull requests (design 15) and is usable on its own: after stage A the window
is a working tool. B, C and D each add to A without depending on one another. E uses B's
attention and C's restore when they are there and works without them: its switcher then ranks
open sessions, sessions that are not running and done ones, and offers no restore.

**Stage A — the window.** The smallest slice that removes the user's pain: one place to see the
sessions and to switch between their real terminals.

- `skydeck window` with `--print-url`, `--new-window`, `--restart`, `--stop`, `--new-secret`;
  `skydeck serve`; the lock, `server.sock` and its `ping`, `status` and `shutdown`; Edge and the
  profile folder; launch tokens; the keep-alive and the interop link; the server-gone bar and
  reconnect (5, 6, 8.3).
- The keeper, the screen side, the protocols, authentication (7, 8, 15).
- The list with its three sections and rows (12.1, 12.2; design 7.3's chip; no stacks). Rows and
  the title bar show states only — `working`, `waiting`, `running`, `not-running`, "running in
  another terminal", "starting…" — and the counts per state; "needs you" and "finished" come with
  B. The read-only header (title, group, state, directory, short id, chip). The footer's "show"
  and the list key `a` show done sessions.
- Terminals in the window: attach and switch by click, Ctrl+Shift+1–9, Ctrl+Tab and Ctrl+Shift+O,
  Ctrl+Shift+L; the keys of 9.1, find (9.7), links (9.6), the clipboard (9.5); the ended bar; the
  card for sessions running in another terminal; the key help.
- Every key of 12.9 is the window's from stage A on, also those whose action comes in a later
  stage, so that a key never means Edge's action in one stage and the window's in the next:
  Ctrl+Shift+J (B), Ctrl+Shift+P (E) and, in the list, `l`, `g`, `n`, `p`, `d` and F2 (D) are
  cancelled and show `<key>: comes in a later stage` in the key bar; the key help lists them as
  coming later.
- Resume into the window (resume card, Enter, double click) and New (12.6), through the shared code
  of 11.1.
- Design 7.4's filter (`/`).
- Configuration, `doctor`, `install` and `uninstall` changes (16) — `terminal` gains `"window"`
  only in C — vendored files, CI (17.5).
- Manual checks W1–W10, W12–W15, W17, W18, W20, W22–W26.

**Stage B — attention and notifications.** Migration 2 (10.2), turn ends (10.3), seen, the three
reasons and their marks (12.4), Ctrl+Shift+J, the title bar's `needs you` count and `(n) skydeck`,
desktop notifications (13). Checks W11, W19, W21, and W3's title `(n) skydeck` on the taskbar
button.

**Stage C — restore in the window.** The restore banner (12.7) and restore run by the window's
server, one at a time (11.3); the commands' `--window`, configuration `"terminal": "window"` with
`restore`, the interactive list's `R` and `doctor`'s `terminal` line (11.4, 16.3, 16.4), and
`POST /resume`, `/new` and `/restore` (8.3, 11.4); `show`'s `(in the skydeck window)`. Also three
settlements that the plan of stage C added (its C19, C20 and C24): a renewal of a resume lock keeps
the mark of its take, so that restore in the window can renew the lock of a window terminal (7.3,
7.8; design.md 7.6); the server keeps a mark in the store while windows are connected, so that
`skydeck window` after a WSL restart, a crash or `--stop` waits for the old window instead of
opening a second one (5.1, 10.2); and a start of a session is refused while the program of its lost
terminal may still run (7.5, 7.8). Check W16.

**Stage D — header editing and pull-request detail.** Label, group, note, done and undone, `+ PR`
and removing one, in the window (12.5) with the Undo toast; the window's chip (12.3), the header's
one line for the pull requests and the pull-request dialog that lists each on a line of its own;
the list keys `l`, `g`, `n`, `p`, `d` and F2; the ticket link of
the group chip and `ticketUrl` (12.5, 16.4; the details
ruled by the lead). Also two parts of 12.5 that no stage named before (plan D's D11): ↻
in the pull-request dialog, which reads the session's pull requests now (`pr-refresh`, 8.2.3), and
the header's "opened <time> · last active <age>" with where the title comes from. Checks
W27–W29.

**Stage E — search.** Several words and the short id in the filter, done sessions while filtering,
the chips, the quick switcher Ctrl+Shift+P, the blocks of one group (12.2, 12.8; in Recent and Earlier until follow-up F3, in every section and open by default since, drawn as cards since follow-up F9). The
page's own icon (12.12). Checks W30, W31, and W3's icon on the taskbar button.

## 20. Left out of step 2 on purpose

- **A native window program.** The window research ranked: (1) the Edge app window, chosen; (2) a
  WebView2 host in C#, built on the PC with the `csc.exe` that ships with Windows — one unsigned
  program, and whether a managed PC runs it is unknown (privilege-management software
  may stop it); (3) Electron, Tauri or Wails — the same unsigned-program question with more weight
  or toolchains (the official Electron build is not signed). A native host stays a later option on
  top of the same server and page. A WebView2 window hosted through PowerShell is **not an option
  at all**: choosing it because it passes under application control that would stop the same
  program as an exe would be working around an organisation's control, not being allowed.
- **A Linux window through WSLg** (design 13: it vanishes with WSL, scales badly on mixed-DPI
  screens, and has a known input freeze after sleep).
- **Other ways to hold terminals**, as the terminal research ranked them: one Node.js holder with
  node-pty for all terminals (the same fidelity, but a crash or an update of that holder ends every
  session; Microsoft's node-pty has no Linux prebuilt binary); tmux in control mode (the program's
  terminal is tmux, a reconnect is not exact, two width models); tmux attached through a pty (no
  scrollback in the page); a bounded byte log (scrollback lost); `script` (cannot resize); Claude
  Code's own `--bg` and `claude attach` (attached sessions render fullscreen, background sessions
  move into a worktree). A node-pty keeper where python3 is missing is a later option.
- **Showing or taking over a terminal started elsewhere** (7.9), and jumping to its WezTerm tab
  (`wezterm cli activate-pane`, untested).
- **An XTVERSION answer** until W5 decides; the **kitty keyboard protocol** and `modifyOtherKeys`
  (xterm.js 6.1, re-evaluated when it is released); **WebGL rendering**.
- **A leader key.**
- **Turn hooks** (`Stop`, `UserPromptSubmit`, `Notification`): 10.3.
- **Turn ends while no server runs** (10.3).
- **A "by ticket" view, reordering slots, more than nine slots.**
- **Stopping a session from the window** (principle 6).
- **Bells and program notifications** (OSC 9, OSC 777).
- **Rotating the secret by itself** (`--new-secret` does it on request).
- **A Start-menu shortcut — proposed, needs the user's agreement.** `skydeck window --shortcut`
  would write `skydeck.lnk` into the user's Start menu, running `wsl.exe -d <distribution> --exec
  <checkout>/bin/skydeck window`, so that the window, and WSL with it, can be started from Windows
  after a restart. It is a write on the Windows side (2), so it is built only after the user agrees,
  and only as that explicit command, never by `install`. (Edge's own "install this site as an app"
  writes nothing for skydeck, but cannot start WSL.)
- **Several users, other machines, macOS** (design 16).

## 21. Facts this design relies on

Status: **verified** here with prototypes and a stand-in program (never the real `claude`);
**documentation** (page given); **inferred**; **UNVERIFIED** (a manual check settles it, 18).
"The terminal research", "the window research" and "the UI research" are the three step 2 research
tracks of 2026-11-13; their prototypes and evidence are kept with the research notes.

| Fact | Status |
|---|---|
| A busy Claude Code session's live-session file changes `status` from `busy` to `idle` when the turn ends, and is `waiting` while a dialog is open. | observed in step 1 (design 14) |
| The input of the `Stop` hook carries `last_assistant_message`, the final assistant text of the turn. | documentation (code.claude.com/docs/en/hooks, read 2026-11-13) |
| When the owner of a pty's master ends, the program gets SIGHUP and exits; for Claude Code that fires `SessionEnd` with reason `other`. | verified with a stand-in (terminal research T6); Claude Code's side observed in step 1 (design 14) |
| A python3 keeper's output equals node-pty's cell for cell; snapshot plus tail rebuilds the screen exactly (every viewport cell, colour, attribute, 119 scrollback lines, wrap flags, modes, after two resizes; after SIGKILL of the screen side with 9 unparked records including a resize, no query answered twice, exit status delivered). Keeper about 12 MB. | verified (T1, T4, T10) |
| `@xterm/addon-serialize` 0.14.0 restores modes 1, 66, 2004, 4, 6, 45, 1004, 7 and mouse modes 9/1000/1002/1003, but not cursor visibility (25), SGR mouse encoding (1006), the cursor style or OSC 8 link ids; the cursor lands one column left when the last row is full width. | verified |
| `@xterm/addon-serialize` 0.14.0's `_diffStyle` writes SGR 22 both for "bold off" and for "dim off", and 22 turns off both: a dim cell followed by a bold one serialises as `1;22` and the bold is lost; bold and dim followed by only one of them loses that one too. It serialises the alternate screen as if the pen were the default, so after a pen is set the alternate screen's cells take it; above a blank row before a wrapped one its wrap trick writes CUF 0 and CUB 0, which move one column, and leaves a stray `-`. All three unfixed on xterm.js's master on 2026-11-13 (the first patched in the vendored bundle, the other two corrected on the addon's output, 7.2). An alternate-screen line marked wrapped comes back unwrapped; with DECAWM off a wide character overwritten at the right margin is serialised one column too wide; `38;5;n` with n below 16 comes back as the 16-colour form. Nor does it restore modes 2026, 20 and 1016, mode 12, the scroll region, the saved cursor, the character sets or tab stops. Rows erased with a background colour below the last row with content come back with the default background (it serialises rows only up to the last with content or the cursor's row); an erased cell left in inverse video by overwriting half a wide character comes back without it (it writes `CSI 1 C` for it); the underline's style and colour are not kept. | verified (task 12; the last three in task 33) |
| xterm.js 6.0.0's parser keeps the state that joins a character to the grapheme cluster before it (`precedingJoinState`) across writes; an executed control, a CSI, an ESC sequence and the end of an OSC or DCS reset it. | read in xterm.js 6.0.0's source, verified with the vendored bundle (task 33) |
| xterm.js 6.0.0 logs to the console (`console.error` and the rest, prefixed `xterm.js: `) at its default log level `info`: a parsing error, which a program's malformed sequence causes (a character above U+009F inside an APC, after ESC), prints the character's code, the parser's state and the parameters. With `logLevel: 'off'` it prints nothing. | verified with the vendored bundle (task 33) |
| xterm.js 6.0.0's terminal has an internal `_core.writeSync` that parses a write at once, the same chunk as `write` without its timer; it warns that it "will be removed soon". The tests of the snapshot's seam (stage A's plan, task 33) parse through it, thousands of snapshots per sweep; a test fails clearly when an upgrade removes it. | verified with the vendored bundle (task 33) |
| xterm.js 6.0.0 reports a cell or pen that carries an OSC 8 link as underlined (`isUnderline`, for its dashed link underline); `getUnderlineStyle` is non-zero only for a real SGR 4. | read in xterm.js 6.0.0's source, verified with the vendored bundle (task 33) |
| xterm.js 6.0.0's parser, where it differs from the VT500 diagram: an ESC ends an OSC or a DCS at once (its handler runs) and begins a new sequence; a C1 control inside a string leaves for the ground state or a new sequence without ending the string; a character above U+009F ends an ESC sequence, a CSI or DCS head and SOS, PM or APC; a DEL in a DCS payload reaches the handler only inside a run that began in the same write (its read-ahead loop), although its table ignores DEL there. Its UTF-8 decoder loses a character cut between two writes after a continuation byte 0x80. | read in xterm.js 6.0.0's source; the parser verified against the vendored bundle (task 33) |
| xterm.js 6.0.0 in the browser leaves synchronized output (mode 2026) by itself: a held-back refresh starts a 1-second timer that turns the mode off and renders. The headless terminal has no renderer and keeps the mode until `?2026l`, RIS or DECSTR. | read in the vendored bundles (task 12) |
| A headless terminal with 10,000 lines of 120 columns is about 25 MB; serialising it 145–166 ms (1.24 MB); the last 1,000 lines 18–41 ms; parsing about 10 MB/s. | verified |
| The headless terminal answers DA1, DA2, DECRQM 2026, CPR, DSR and DECRQSS; it cannot answer OSC 10/11; xterm.js 6.0.0 has no XTVERSION answer. Starting the program before a screen side is connected makes its first probe time out and swallow the first keys. | verified (T9) |
| xterm.js 6.0.0 sends `\r` for Shift+Enter; Ctrl+J inserts a newline in Claude Code in every terminal. | verified (xterm.js) / documentation (Claude Code terminal setup page) |
| On WSL Claude Code pastes an image on Ctrl+V and Alt+V, reading the Windows clipboard itself through a Windows program; a dead `WSL_INTEROP` breaks it. | inferred (strings in the Claude Code 2.1.323 binary) |
| `/run/WSL/1_interop` exists on a WSL machine with systemd on; a symbolic link to a live interop socket works as `WSL_INTEROP` for processes that outlive their terminal. | first part verified; second UNVERIFIED (W7) |
| Claude Code recognises xterm.js only from an XTVERSION reply starting `xterm.js` (or `TERM_PROGRAM=vscode`) and then changes wheel scrolling, glyph-atlas resets and link clicks. Under tmux it turns off synchronized output and its extended-keys path. | inferred (strings in the binary) |
| Claude Code measures widths with `Bun.stringWidth(…, {ambiguousIsNarrow: true})`; `addon-unicode-graphemes` 0.4.0 gives VS16, ZWJ and skin-tone sequences two columns. | inferred (binary) / verified (addon) |
| A hand-written RFC 6455 server on `node:http` of about 100 lines passes frames from 0 bytes to 1 MiB, fragments, ping and pong, close codes, invalid UTF-8 (1007), unmasked frames (1002), and refuses a wrong token or Origin. | verified (T7, with `ws` 8.23.0 as the client) |
| In a Chromium `--app` window no key is reserved: every key reaches the page first, and `preventDefault` cancels the browser's action. | verified in Chromium's source (window research) |
| In an Edge 157 app window with its own profile folder, every chord of the key test reached the page and was cancelled by it: Ctrl+W, N, T, Shift+T, Tab, Shift+Tab, R, P, F, L, J, H, O, B, G, D, U, K, E, Z, S, Q; F5, F10, F11, F12; Ctrl+Shift+V, N, W, I, S, E, Y, M, O; Ctrl+PageDown; Alt+Left, Alt+B, Alt+F, Alt+V; and Alt+F4, after which the window stayed open. Alt+Space did not reach the page (Windows keeps it for the window menu). The page loaded once and never reloaded (164 key presses, one load); `display-mode` was `standalone`; it was a secure context. | verified on a Windows PC, 2026-11-13 |
| In a normal tab the browser keeps Ctrl+W, Ctrl+F4, Ctrl+Shift+W, Alt+F4, Ctrl+N, Ctrl+Shift+N, Ctrl+T, Ctrl+Shift+T, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgDn and Ctrl+PgUp. A page never sees Alt+Tab or Win chords. | verified in Chromium's source; not tested in Edge (W2) |
| `http://127.0.0.1:<port>` is a secure context (verified on a Windows PC, 2026-11-13): Notification and the async clipboard are allowed; notification permission is per origin and profile. Whether a managed PC lets notifications and clipboard writes through is not tested yet (W6, W11). | documentation |
| An app window's taskbar identity is made of an app name generated from the address's host and path (`GenerateApplicationNameFromURL`: host, `_`, path; no port) and the profile path. | verified in Chromium's source (review, 2026-11-13); whether Edge shows skydeck's icon is W3 |
| xterm.js 6.0.0 sends nothing for Ctrl+Shift with a letter and then does not cancel the key (it builds the control byte only without Shift); for a plain Ctrl+V it sends `\x16` and cancels the key, so the browser does not paste unless the custom key handler returns false. | verified in xterm.js 6.0.0's source (`Keyboard.ts`, `CoreBrowserTerminal`) |
| xterm.js 6.0.0's paste handler sends the pasted text and empties its hidden textarea, but does not cancel the paste event, so the browser then puts the whole text into that textarea: after a paste of 10 MiB in headless Chromium the page sent its input at about 0.4 MB/s and answered a script in seconds; with the paste cancelled after xterm.js took it (the first fix; the page now takes the paste itself, 9.1), the same paste reached the server in under a second (plan task 28). | verified (headless Chromium 1223; the bundle's `handlePasteEvent`) |
| xterm.js 6.0.0 wraps pasted text unfiltered (`ESC [ 2 0 0 ~`, the text, `ESC [ 2 0 1 ~`): a pasted text that holds `ESC [ 2 0 1 ~` ends its own bracketed paste, and what follows reaches the program as typed keys, Enter included. | verified (headless Chromium 1223; plan task 28's review 2) |
| xterm.js 6.0.0's DOM renderer writes its colours, cursor and selection rules into `<style>` elements it creates at run time: under `style-src 'self'` a red cell renders black; with `'unsafe-inline'` it renders red. | verified in headless Chromium (review, 2026-11-13) |
| On WSL a crashing process's core dump is piped to WSL's crash collector (`core_pattern` is `\|/wsl-capture-crash …`), which keeps up to `maxCrashDumpCount` (default 10) dumps in `crashDumpFolder` (default `%Temp%\wsl-crashes`). A non-dumpable process (`PR_SET_DUMPABLE` 0) produces no dump, piped or not. For a piped dump the kernel ignores a core limit of 0 and aborts only on a soft limit of exactly 1 byte (`fs/coredump.c` of Linux 6.6). | `core_pattern` verified; documentation (learn.microsoft.com/windows/wsl/wsl-config, `prctl(2)`); kernel source read for 6.6 in review; 6.18 UNVERIFIED (W24) |
| `/run/user/<uid>` outlives the user's last terminal only when the user lingers; on one machine the user does. | verified |
| The keeper's code needs python3 3.9 or newer (`os.waitstatus_to_exitcode`); it was run on 3.12 only. | inferred (3.9) / verified (3.12) |
| The Web Crypto flow of 8.2.2 works in Chromium: HKDF-SHA256 from the token, AES-256-GCM `unwrapKey` into a non-extractable HMAC key, a proof equal to Node.js's HMAC over the same bytes; `exportKey` fails; the key survives a round trip through IndexedDB and still signs; the page is a secure context. | verified in headless Chromium (review, 2026-11-13) |
| `@xterm/addon-search` 0.16.0 was published with xterm.js 6.0.0 (2025-12-22) and is its latest release. | documentation (npm registry, 2026-11-13) |
| `CLAUDECODE` is set in the environment of a command a Claude Code session runs. | verified (one machine, 2026-11-13) |
| Which `CLAUDE*` variables Claude Code sets for the programs it runs, beyond `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`. | UNVERIFIED (W23) |
| `msedge.exe` started while an Edge on the same profile folder runs hands off and exits at once. | verified in Chromium's source |
| Started through interop with stdio ignored and a Windows working directory, a Windows program shows no console window. | verified in WSL's source |
| A WSL distribution stops `instanceIdleTimeout` (default 15 s) after its last Windows client exits; Linux background processes and systemd do not count; the VM stops `vmIdleTimeout` (default 60 s) after the last distribution. `.wslconfig` `[general] instanceIdleTimeout=-1` keeps it. | verified in WSL's source; not measured (W14) |
| A `wsl.exe` started from inside WSL through interop counts as such a client. | UNVERIFIED (W14) |
| In WSL's NAT mode a port bound to `127.0.0.1` inside WSL is reachable from Windows. From an Edge app window on a Windows PC, `http://127.0.0.1:<port>` in WSL answered 132 pings of 132, in about 7 ms. | documentation; verified on a Windows PC, 2026-11-13 |
| An Edge window started through interop survives a WSL stop. | inferred (W16) |
| WSL can hang after hibernation (issue #8696); new `wsl.exe` sessions can time out on WSL 3.0.3 (#42006). | documentation (WSL issues) |
| On one Windows PC: the Edge WebView2 runtime is installed; WSL 3.0.5 with systemd, no `.wslconfig`, NAT networking, interop on; python3 3.12. Whether a managed PC runs unsigned programs from user folders is unknown. | verified (read-only look under `/mnt/c`) |
| Sessions started in another terminal cannot be shown: their pty master belongs to that terminal; `reptyr` needs ptrace (`ptrace_scope` is 1); reading `/dev/pts/N` steals input. | verified |
| `←` on the empty prompt of a session started in a terminal backgrounds it into a session with a new id, run under a `claude bg-pty-host` re-parented to init (outside the terminal's process tree), and opens agent view in the terminal; `leftArrowOpensAgents` `false` in the global config file turns that shortcut off for sessions started later; `--settings` cannot set that key (7.9; design.md 14). | documentation (code.claude.com/docs/en/agent-view and the settings reference, 2026-11-17); the process tree and the new id observed (Claude Code 2.1.311, follow-up F11) |

