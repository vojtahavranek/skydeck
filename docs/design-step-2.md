# skydeck — design of step 2: the window

Status: agreed design for step 2, to be built in the stages of section 19. Section 12 (what the
window shows) was approved by the user on 2026-11-13 after seeing the mockup. This document is the
source of truth for step 2, next to [design.md](design.md), which stays the source of truth for
everything step 1 built; when the code and either document disagree, one of them has a bug.
"Design 7.6" means section 7.6 of design.md; a bare section number means a section of this
document.

Every fact this design relies on carries its status in section 21: **verified** (on the
development machine, with a stand-in program, never the real `claude`; or by the user on their
PC, which says so), **documentation** (with the page), **inferred**, or **UNVERIFIED** (a person
must check it by hand; section 18).

## 1. Purpose

The user installed step 1 on 2026-11-13 and used it with about 105 sessions (8 running). Resume
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
  server can open terminals all the same. That a limit of 1 aborts the dump on this
  machine's kernel (6.18, not read) is **UNVERIFIED** (check W24).
- **Principle 6 (nothing is destroyed or moved automatically; skydeck never stops a process)** is
  made precise: skydeck never stops a `claude` process or a keeper (stopping a keeper would end
  its session). It may stop its own server and its own keep-alive process (6.1). The window has no
  "kill" action: a session ends when the user ends it inside `claude`.
- **Principle 8 (local only)**: the server listens on the loopback interface only (15). The only
  network use is still `gh`.
- **Windows programs.** Step 2 is the first time skydeck starts Windows programs by itself, through
  WSL interop. It starts exactly two, and only these: `msedge.exe` (the window, 5.3, and links the
  user Ctrl+clicks, 9.6) and `wsl.exe` (the keep-alive, 6.1). Never `cmd.exe`, `powershell.exe` or
  a shell; arguments are passed as an argument list. Every such start goes through one function
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
| `src/window/` | The server: HTTP and WebSocket (8.2), authentication (15), keeper connections (8.1), screen sides (7.2), the view model of the page (12), the server's tick (10.1), Edge and the keep-alive (5, 6), and the `window` terminal (11.2), which only the server uses. | platform, text, store, claude, sessions, terminals, github |
| `src/window/protocol.ts` | The messages of 8.2 and 8.3 as TypeScript types, with JSDoc the page's type check reads: the definition of every message's fields. | `src/claude/session-id.ts` only (the session-id rule; it imports nothing) |
| `src/window/frames.ts` | The keeper frames of 8.1: the byte layout the server and the keeper share, and parsers for the keeper's payloads. | `src/claude/session-id.ts` only |
| `src/window/view/` | The page's view model as pure functions: sections, rows, stacks, attention, the switcher's ranking, the filter (12). | sessions (types, and the pure `isListed` and `matchesFilter` of `src/sessions/list.ts`: stage A's filter is design 7.4's, with one implementation), text |
| `web/` | The page: `index.html`, plain JavaScript modules with JSDoc types (checked by `tsc`), CSS. No bundler, no build step: the files are served as they are. | `vendor/xterm/` |
| `web/keys.js` | The key table (12.9) and the terminal key mapping (9.1), as pure functions. | — |
| `vendor/xterm/` | The vendored xterm.js files (16.6). | — |

Nothing in `web/` decides a rule that the server also needs: the page renders what the server
sends and maps keys. Everything that orders, groups, filters or judges attention is in
`src/window/view/` and tested without a browser.

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
| `src/sessions/` | `launchPrepared` moves here from `src/cli/launching.ts` and takes the terminal as a parameter; `prepareNew` takes the directory (11.1). | A |
| `src/sessions/restore.ts` | Restore planning moves here from the `restore` command, and returns the earlier boot and its last event time (11.1). | C |
| `src/cli/commands/` | New: `window` and `serve` (5). `doctor`: the lines of 16.3. `install`: the python3 `info` line (16.1). `uninstall`: stops the server, names the profile folder, `--purge` refuses while keepers live (16.2). | A |
| `src/cli/commands/` | `resume` and `new`: `--window`; `restore` with `"terminal": "window"` (11.4). `show`: `(in the skydeck window)` (11.4). | C |
| the interactive list (`src/cli/tui/`) | `R` with `"terminal": "window"` sends `POST /resume` (11.4) and shows the answer's lines the way it shows a tab launch's lines today. Nothing else in the list changes. | C |
| `package.json`, `.prettierignore`, `tsconfig.json` | Development dependencies: `playwright`, `ws`, and the `@xterm/*` packages of 16.6 (exact versions); scripts `vendor`, `test:page`, `check` (17.5); `vendor/` added to `.prettierignore`, so that the vendored files are kept byte for byte; `web/tsconfig.json` beside the root one. | A |
| `.github/workflows/ci.yml` | 17.5: `shellcheck` by name, the page suite on one leg, the time limit. | A |

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
  `wsl.exe` ends only with it, is **UNVERIFIED** (check W14).

That a `wsl.exe` started from inside WSL counts as a Windows client is **UNVERIFIED** (section 21;
check W14). The design does not depend on it:

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
default colour is (foreground `#ffffff`, background `#000000`). It does not answer XTVERSION
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
  checks that the session's resume lock in the store is still exactly the spec's `lock` (no other
  skydeck has taken it over); for a new session, that no live process holds the session id. When
  all holds and the deadline has not passed, it sends `G`; otherwise `N` with the reason, which the
  window shows on the terminal ("not started: <reason>"). The lock is compared exactly: a renewal and
  a take-over of a stale lock with no new event look alike. Known limit, for the stage that brings
  restore into the window: restore renews its locks, so a restored keeper whose hello comes late, or
  after a reconnect, is refused ("its resume lock was renewed or taken over"; ruled by the plan
  owner, stage A's plan task 21).
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
  environment) and `CLAUDECODE` (in the environment of a Claude Code session's command, seen on the
  development machine on 2026-11-13); seen in the
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
  program yet;
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
starts them was updated. The server speaks every keeper protocol version that has shipped (they
are small); it refuses to attach a keeper with a newer protocol than it knows and shows "this
terminal was started by a newer skydeck; run skydeck window --restart" on it. Its program keeps
running.

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
  program may still run is never dropped this way;
- when the program ended **before its session reported a start** (`resumeStarted`, design 7.6,
  never became true for this launch — `exec` failed, `claude` was not found, it exited at once)
  and the session's lock is still the one this launch took, releases that lock, and for a new
  session removes the label and group it stored (design 7.6, 7.7): nothing runs, and the bar's
  Resume must not be refused for a minute. This differs **on purpose** from `settleFailedLaunch`,
  which releases only when no command could be printed (a printed command may yet be run by hand):
  the window prints nothing for the user to run (11.2), and the bar offers Resume itself. It is done
  for every exit, also of a terminal whose program was never started (an `X` with `notStarted`, a
  keeper lost before `T`); a new session's label and group are removed only while they are as
  `prepareNew` stored them (principle 6). Known limit, for the stage that brings restore into the
  window: restore renews its locks, so the store's lock is then no longer exactly the one the
  terminal took, and such a lock is not given back (it expires; 7.3 has the other half). Lock values
  then need a mark that a renewal keeps and a take-over changes.

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
| `GET /manifest.webmanifest`, `GET /favicon.ico` | The page's manifest and icon (12.12). |
| `GET /ws` with `Upgrade: websocket` | 8.2.2. |
| `OPTIONS` | 403. |
| any other method but `GET` (`HEAD` included) | 405 with `Allow: GET`. |
| any other `GET` | 404. |

A query string is ignored and never used: `/?x` is `/`. Every path outside `/assets/` (`/`, and
later the icon and the manifest) and every refusal (404, 405, 421, 403) carry
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
   connection is open for 8.2.3's messages. A page whose `assetVersion` is not the server's
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
protocol number exists for the reload decision and for tests.

#### 8.2.3 Messages

JSON text frames, each with a type `t`. The fields of every message are defined once, as the
TypeScript types of `src/window/protocol.ts` (4.3), and pinned by the protocol tests (17.3); the
tables below name them. Times are nanoseconds as decimal strings. Every string the
server sends that comes from a transcript, a live-session file, GitHub, the user or the store has
passed the sanitiser (design 7.4), except a note's text (multi-line, sanitised line by line by the
page's renderer, which writes it as text, never as markup).

Page → server (after `hello` and `start`, 8.2.2):

| `t` | Fields | Effect |
|---|---|---|
| `ping` | `n` | `pong` with the same `n`, `bootId`, `serverId`. |
| `view` | `filter`, `chips` (from stage E; stage A's `view` has none), `unfolded`, `showDone`, `selected` | The page's view state; the server answers with `list` and keeps sending `list` when it changes (12). |
| `focus` | `focused`, `selected`, `area` (`cols`, `rows`: what the terminal area holds at the page's font) | Window focus, selection and terminal area, for seen (12.4), notifications (13), the size owner and the first size of a terminal the command line or a restore opens (8.2.6). Sent on every change and after `start`. |
| `attach` | `term`, `cols`, `rows` | Start a terminal stream (8.2.4). The page's size is a proposal (8.2.6). |
| `detach` | `term` | Stop it. |
| `input` | `term`, `data` | Typed text (UTF-8) for the terminal; `binary: true` when `data` is a byte string from xterm.js's binary channel (mouse reports). Makes this page the size owner. |
| `resize` | `term`, `cols`, `rows` | The page's fitted size (8.2.6). |
| `act` | `id`, `kind`, and the fields of the next table | An action (11, 12). The server answers `result` with the same `id`. |

| `act` kind | Fields | Effect |
|---|---|---|
| `resume` | `sessionId`, `cols`, `rows` | 11.3; the size is the new terminal's first size (8.2.6). |
| `new` | `dir`, `label`, `group`, `flags` (the text as typed), `cols`, `rows` | 11.3; the server splits `flags` by 12.6's rule and checks them as `skydeck new` does (design 7.7). |
| `restore` | `sessionIds` | 12.7. |
| `label`, `group` | `sessionId`, `text` (empty clears) | 12.5. |
| `note` | `sessionId`, `text`, `base` (the note the edit started from) | 12.5. |
| `done`, `undone` | `sessionId` | 12.5, 12.10. |
| `pr-add`, `pr-rm` | `sessionId`, `url` | 12.5. |
| `pr-refresh` | `sessionId` | An explicit refresh of that session's pull requests (design 7.3). |
| `close-terminal` | `term` | Forgets an ended or not-started terminal's last screen (7.8). Refused for a terminal whose program runs (principle 6). |
| `open-link` | `url` | 9.6. |
| `dismiss-restore` | `bootId` | 12.7. |

An unknown kind or field is refused, and so is a string over its limit (in UTF-8 bytes: paths and
URLs 4,096, `input.data` 64 KiB, other text 1,024; the action of 9.6 then opens a URL only up to
2,048 characters) or a size that is not a whole number from 1 to 65,535. No action carries a program or an argument list to run (8.3):
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
| `list` | The view model (12), sent whole (about 50 KB for 100 sessions) when it changed, at most once a second: `counts`; `sections` (`open`, `week`, `earlier`, each with `folded`, its time span and its `rows`); `doneHidden`; `banner` (12.7, or null); `terminals` (`id`, `slot`, `sessionId`, `state`, `notReported` (7.5's "started, not reported"), `cols`, `rows`, whether this page owns the size); `selected`: for the session the page's `view` names, what the resume card shows (12.6: the exact command, the flags that will not be passed on, how it ended, expiring or expired), or null; `dirs`: the known project directories, most recent first (12.6's new form). A row carries the list row's display fields (design 7.4: id, short id, title and its source, group and its source, state and detail, times, directory, marks, note mark and the note's first three lines, done, pull requests, chip) and the window's own: `terminal`, `slot`, `elsewhere` (running in another terminal), `attention` (null, or reason, detail and since), `stack`. |
| `snap` | `term`, `ch` (the channel number for its output), `cols`, `rows`, `data` (the snapshot). |
| `size` | `term`, `cols`, `rows`, `owner` (this page or another): the terminal's size changed, in stream order. |
| `exit` | `term`, `code`, `signal`, `atNs`, `lost`, `notStarted` (null, or the reason the program was never started, 8.1). |
| `result` | `id`, `ok`, `lines` (what the command line would print, design 7.6), `error`, `sessionId` (the session a successful `resume` or `new` started, so that the page can select its row, 11.3; else null). |
| `notify` | `sessionId`, `title`, `reason` (13). |
| `notice` | `kind` (`keepalive-lost`, `keepalive-back`, `gap`, `newer-keeper`, `input-full`, `tick-failed`, `restore-progress`), `term` (the terminal a `gap`, `newer-keeper` or `input-full` notice concerns; null for the others), `text`. `tick-failed` ("skydeck could not refresh the list: <reason>; it tries again") is sent once when a tick fails (10.1) and not again until a tick has succeeded. |
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
  page sent with the action. One opened by the command line or by a restore starts at the `area`
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
  6.0.0 rounds it, and the room the addon gave its scroll bar (14 px) and xterm.js's padding
  counted out; the answer does not depend on the terminal's current size. The fit addon's does (it
  divides by the cell of the current size), so at some widths no size proposes itself — 104
  columns propose 103 and 103 propose 104 — and a terminal shown there was resized every second
  (ruled by the plan owner, M4 of plan task 28's review). For an unchanged area, pixel ratio and
  cell the page's answer stays what it was.

The page's xterm.js keeps 5,000 lines of scrollback, as the screen side does (7.2), so that both
reflow alike and find (9.7) sees what the snapshot holds.

#### 8.2.7 Several windows

Any number of pages may attach to one terminal; they share its ordered stream. Input from any of
them goes to the program in the order the server receives it. `list` goes to every page; each
page's `view` state is its own. Notifications go to one page only (13).

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
| `GET /status` | `{ starting, pages, terminals: [{ id, slot, state, sessionId, pid }], keepAlive, python, build, checkout, startedAtNs, envOrigin }` (`envOrigin`: where the server's environment came from and when, 5.2; `starting`: true while the server's start is not done and a page's upgrade is answered 503 (8.2.1) — a server answers before then, 5.2; a server of an older build sends none, which means false; ruled by the plan owner, follow-up "server-findable"), for `skydeck window` and `doctor`. |
| `POST /resume` | `{ sessionId }` → `prepareResumeById` and the window terminal (11.2) → `{ code, lines }`: the exit code and the lines `skydeck resume` prints (design 7.6), refusals included. |
| `POST /new` | `{ dir, label, group, flags }` (`flags` an array of strings) → `prepareNew` with `dir` (absolute, an existing directory) and the refusals of design 7.7 → `{ code, lines, sessionId }`. |
| `POST /restore` | `{ sessionIds, all }` → 11.4. The answer is a stream of JSON lines: one per report line of the run, the last one the outcome. |
| `POST /token` | `{ seconds }` (30 for a window, 600 for `--print-url`) → `{ id, token, expiresAtNs }`: a launch token, minted and held in memory (8.2.2). |
| `GET /token/<id>` | `{ state }`: `waiting`, `used`, `reused` (a second proof came: the alarm, 8.2.2), `expired` or `dropped`. |
| `POST /token/drop` | `{ id }` → `{ ok }`: the token is given up; a later proof with it fails with 4003 (or 4004 when it had been used). |
| `POST /shutdown` | `{ ok: true }`, then 5.5. |

A refused request answers `{ error: <kind> }`: 404 for an unknown route (stage C's `/resume`,
`/new`, `/restore` until that stage), 400 for a bad body, 413 for a body over 64 KiB, which is not
read on; `GET /token/<id>` is 404 for a token the server does not know. When answering a request
fails inside the server (`ping`, `status` or the tokens throw), the answer is 500
`{ error: 'failed' }`, the log names the error and its code, never its message (5.2), and the
server goes on; a failure while stopping is the server's uncaught error. On the command line,
`ping` reports a socket that refuses or is missing as refused, and no answer in time — or a full
queue of connections, of a server that lives — as not answering (5.1); `POST /token/drop` for a
token the server does not know is no error.

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
`https://` followed by URL characters) and a click on a pull-request link in the list or header
send `act open-link` with the URL. An OSC 8 link's visible text can differ from where it leads, so
for one whose text is not its URL the page first shows the target and opens it only on a second
click. The server opens a URL only when it is at most 2,048 characters, parses as a URL with scheme
`http` or `https`, and is still at most 2,048 characters once the WHATWG URL parser has
re-serialised it (so it cannot start with `-`; percent-encoding can make it several times longer,
and the re-serialised URL is what Edge gets), and holds no `"` and no backslash: it becomes one
argument of a Windows program, and either can change how that program splits its command line. It
opens it by running
`window.edge` with that URL as its only argument (no profile folder): it opens in the user's own
Edge profile, where they are logged in, not in the window's profile. The page itself never
navigates away: it cancels drag and drop over the window, which would otherwise open a dropped file
in place of the page. Whether a link opens in the user's main Edge window is check W12.

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
(design 7.3) for the sessions the pages list, and a reload of the rows when that refresh saved
something, a live file or its trust changed, another process committed to the store
(`Store.dataVersion()`), or a minute passed — the interactive list's rule. The server then sends
`list` to every page whose view model changed. A tick that fails is logged and shown once to the
pages; the next tick tries again. The server's store connection checks the schema version at the
start of every write transaction, and before every write that is a single statement; when the
store is newer than the server knows (a command of an updated checkout migrated it, 16.5), the
write is not made and the server stops (5.5) with `bye "skydeck was updated; run skydeck window"`.
A tick between the migration and the next write therefore writes nothing into the migrated store.

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
The times are kept only to show ("finished 2m ago").

These are skydeck's own observations, not the user's data (design principle 6); a row is written
the first time one of them is known and never removed.

`kv` entries (no migration; `kv` is free text):

| Key | Value |
|---|---|
| `window_secret` | The secret (15.2): 32 random bytes, base64url. Created on first need, inside one transaction (only one server runs, 5.2, but `--print-url` and the first server may race). A stored value that is not 32 bytes in canonical base64url is replaced as if absent: it could prove nothing, and a page that held a key from it gets 4003 and asks for a new launch (8.2.2). |
| `window_server` | The lock of the one server (5.2). |
| `window_runtime_dir` | The runtime directory the server uses (4.2); kept while any keeper lives, so that commands and the next server find it; a record whose directory is missing or holds nothing alive is replaced at the next server start. |
| `window_alarm` | The time a used launch token was presented a second time (8.2.2); cleared by `--new-secret`. Launch tokens themselves are never stored. |
| `window_launching` | The lock of the one command that starts Edge (5.1). |
| `attention_seq` | The counter above. |
| `window_restore_dismissed` | The boot id whose restore the user dismissed (12.7). |

### 10.3 When a turn ends

A turn ends when a holder's live-session file changes its `status` from `busy` or `waiting` to
`idle`, the file still naming the same session and the same process (pid and process start).
The server sees that at its one-second look and records, for that session, the next
`attention_seq` as `turn_ended_seq` and the file's `statusUpdatedAt` (else the time it saw the
change) as `turn_ended_ns`. When the session is being seen at that moment (12.4), the same write
sets `seen_seq` to a later value, so a turn that ends in front of the user is never "finished".

`busy` to `waiting` is not a turn end (a dialog opened inside the turn). A file that names another
session than at the last look (`/clear`) starts over. A look that cannot read a file (it is being
rewritten, or the read fails) keeps the last status seen as the baseline; only a file read whole
and parsed moves it. The first look after the server starts only sets the baseline: a turn that
ended while no server was running is not recorded (a known limit; 12.4).

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

Four changes to step 1's code make that possible, with no change of behaviour for the commands
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
  memory check, the wait for start events with lock renewal, exactly as from the command line. Its
  report lines go to the banner. One restore runs at a time.

### 11.4 `skydeck resume` (and `new`, `restore`) in a terminal while the window runs

- Without options they behave as in step 1: the configured `terminal` decides, `here` by default.
  A session resumed in a WSL terminal runs there; within two seconds the window lists it as
  "running in another terminal" (7.9). The guard sees every holder wherever it runs, so a session
  open in the window is refused as `running (pid <n>)` like any other running session; `show` adds
  `(in the skydeck window)` to a holder that descends from a keeper (7.5's rule).
- `--window` (new for `resume` and `new`; `--here`, `--tab` and `--window` exclude each other), or
  configuration `"terminal": "window"`, sends the request to the server (8.3) instead of starting
  anything itself: `resume` sends the session id its `<ref>` resolved to, `new` sends its current
  directory, `--label`, `--group` and the flags after `--`. It never starts a server: the server's
  environment becomes every session's (5.2), so only `skydeck window` starts one. With no server
  running it says `the window is not running; run skydeck window first, or use --here` and exits 1.
  It prints the answer's lines on stderr and exits with the answer's code; then, when no page is
  connected, it starts a window as `skydeck window` does (5.3). When the server does not answer
  within 30 seconds it says so and exits 1, printing no command (it prepared nothing; the server may
  have started the session: `skydeck` shows whether it runs). With `"terminal": "window"`, `--tab` means the window too, and so does
  `R` in the interactive list.
- `restore` with `"terminal": "window"` plans and shows its list and asks as in design 7.8, then
  sends the selected session ids (and `--all`) to `POST /restore`. The server takes design 7.8's
  set from freshly refreshed rows, keeps the entries the user selected (an id no longer in the set
  is reported `failed <short>: no longer offered for restore`), and runs `runRestore` with the
  window terminal (11.3). The command prints each report line as it arrives and exits with design
  7.8's code for the outcome. `--dry-run` asks the server nothing. The command asks the server for
  `GET /ping` before it plans or prompts, so "the window is not running" comes before any
  question. While a restore runs, the server sends a line at least every 10 seconds (`waiting for
  <n> sessions` when nothing else happened); a command that hears nothing for 30 seconds says `the
  window's server stopped answering; run skydeck to see what started` and exits 1.

## 12. What the window shows

This section is the design of the step 2 UI research (the mockup kept with the research notes)
and its nine picks (12.11). The user looked at the mockup on 2026-11-13 and approved it ("the list
looks ok", "overall I like it"; an Edge app window that runs like the mockup is "completely ok"),
so what the mockup shows is decided; the pull-request chip's rule for several open pull requests
(12.3) is the user's ruling of the same day. What the mockup cannot show — the key policy (12.9)
and a crashed terminal needing the user (12.4) — are the lead's decisions under the user's
go-ahead to proceed. Every rule that orders, groups, filters or judges attention is a
pure function in `src/window/view/` (4.3).

### 12.1 Layout and sections

A title bar, the list on the left, the selected session's header and terminal on the right, a key
bar at the bottom. The list has three sections:

- **Open**: every session that is running or starting, in the window or elsewhere (about 8).
  Never folded. Order: terminals of the window by slot, then terminals without a slot by opening
  time, then sessions running in another terminal by the time they started. The order does not
  change while the window is open except when a row joins or leaves; attention is a mark on the
  row (12.4), never a move.
- **This week**: not running, last activity within 7 days, most recent first.
- **Earlier**: the rest, folded by default; the folded header shows the count and the time span.
  A click on its header folds and unfolds it, as ← and → do, and leaves the keyboard on the list
  (ruled by the plan owner, plan task 27).

Done sessions are hidden (design 7.1), with a footer "17 done hidden · show". Filtering and the
switcher search done ones too (12.8).

The title bar shows the counts, e.g. `● 3 need you · 3 working · 2 idle`, and the window title is
`(3) skydeck` while 3 sessions need you, so the taskbar shows it.

### 12.2 Rows

- A running session has two lines: the first as below, the second its state line (`working 4m`,
  `needs you · permission · Bash · 3m`, `finished · not seen · 2m`, `running in another
  terminal`, `starting…`).
- A session that is not running has one line: state icon, the ticket key (dim, monospaced) and the
  title, marks (`crashed`, `crashed mid-turn`, `expires 3d`, `expired`, `done`: design 6.3's marks
  in words), the pull-request chip (12.3), `✎` when it has a note, and its age. Stage A shows every
  mark of design 6.3 in words (`continued` and `2 processes` too) and the expiring one as `expires
  soon`: the row carries only that the session is expiring, not when its transcript is deleted
  (ruled by the plan owner, plan task 27).
- No group headers: most groups have one member. The group (design 7.1) is printed dim at the
  start of the title when the title does not already start with it. In This week and Earlier the
  members of one group stack under the newest (`ORB-2107 ×4 … +3 more`); a click or → expands
  the stack. Running sessions never stack; a filter flattens every stack.
- Slot numbers 1–9 show at the left of Open's rows.

### 12.3 The pull-request chip in the window

The window's chip differs from the list's (design 7.3), which stays as it is for `ls` and the
interactive list: open and finished pull requests are counted apart.

- **Open ones** are the attached pull requests not known to be merged or closed: open, draft,
  never fetched, and those that cannot be read (design 7.3 never fetches a merged or closed one
  again, so an unreadable one was last seen open, or never seen).
- **The chip** shows the number of open ones when there is more than one, and the state of the
  one that most needs the user, in design 7.3's order without merged and closed: can't read
  (`can't read`), not fetched (`not fetched`), checks failing (`failing`), changes requested
  (`changes`), checks pending (`pending`), review required (`review`), draft (`draft`), approved
  and green (`approved`). After it, dim, `+<n>` for the merged ones, when there are any. Closed
  ones are not counted.
- **With nothing open:** `<n> merged` (dim) when any is merged, else `closed` (dim); no chip when
  none is attached.
- A chip whose state is `can't read` is drawn dotted.
- **The tooltip** lists each open pull request with its own state (`repo #n · failing`, or `can't
  read · last read 3h ago`), then the merged and closed counts. The header (12.5) shows each open
  one on a line of its own.

| Attached | Chip |
|---|---|
| 1 open, review required | `PR · review` |
| 1 open, checks failing; 30 merged | `PR · failing +30` |
| 2 open: a draft and an approved, green one | `2 PRs · draft` |
| 2 open: one that cannot be read and one with changes requested; 4 merged | `2 PRs · can't read +4` (dotted) |
| 3 open, the worst failing; 30 merged | `3 PRs · failing +30` |
| none open; 3 merged, 1 closed | `3 merged` |
| none open; 1 closed | `closed` |

### 12.4 Attention: needs you and seen

A session **needs you** for one of three reasons, in this order:

1. **asks**: a holder's live-session file has status `waiting` (a dialog is open: permission, a
   question); the detail is `waitingFor`. It ends when the status changes. (Design 6.2's state
   `waiting` also covers `idle`, so "asks" is decided on the raw status, not on the state.)
2. **ended**: a terminal of the window ended (7.8) and the session it held is marked
   `ended-unexpectedly` at the next refresh: `window_end_seq` is set (10.2). It ends when seen.
3. **finished**: `turn_ended_seq` is greater than `seen_seq`, and the session is running and idle.
   It ends when seen or when the next turn starts.

Seen is a **condition that holds**, not a moment: a session **is being seen** while it is the
selected one in a window that has focus, from 1.5 seconds after it was selected; typing into its
terminal makes it seen at once. While it holds, the server sets `seen_seq` to the next counter
value (10.2) at every tick — written at most once per 5 seconds per session, and always in the
same write as a turn end that happens meanwhile (10.3) — so a turn that ends in front of the user
never shows "finished". Order is by the counter, never by clock times (10.2). A turn that ended
while no server ran is not recorded (10.3), so it shows no "finished".

Ctrl+Shift+J selects the next session that needs you: those that ask, the longest-waiting first;
then those that ended; then those that finished, oldest first. Pressed again it goes on; after the
last it starts over.

A row that needs you has a coloured left bar, a bold title and the reason on its second line.

### 12.5 The header

For the selected session: the title (a click edits the label, stage D), the group chip (dashed
`+ group` when none; its tooltip says when the group comes from the title), the state pill, the
project directory, "opened <time> · last active <age>", the short id (a click copies the whole
id), where the title comes from. Each open pull request on a line of its own
(`repo #n · approved, green · checked 4m ago`, or `can't read · last read 3h ago · gh: HTTP 502`);
merged and closed ones fold into `30 merged ▸`; `+ PR`. The note's first three lines (a click
edits it). Buttons Note and Done / Undone.

Stage A's header (19) has one height for every session and window width, so that the terminal
area under it does not jump between sessions and the page knows its size before a terminal is
shown: the directory is one line, cut with an ellipsis when it is long (the whole path stays in
the page, is selected and copied whole, and is its tooltip); the short id is never cut (ruled by
the plan owner, review of plan task 29).

Editing (stage D) uses the step 1 rules and functions: a label or group that design 7.1 refuses is
refused with the same message; a note is edited in a text box instead of `$VISUAL`, saved as typed
(an empty note is no note), and a save is refused when the stored note changed since the edit
began ("the note was changed elsewhere while you edited it; your text is still in the box"); `+ PR`
attaches with origin `manual` and fetches at once (design 7.3). Done shows an Undo toast.

### 12.6 The right side

- **A session open in the window**: its terminal. The page attaches to the terminal it shows and
  keeps the terminals it has shown attached (their xterm.js instances live), up to 8, the least
  recently shown detached beyond that; while the window is hidden (minimised) it detaches all but
  the selected one. Switching between attached terminals is instant; switching to another costs one
  snapshot (7.3).
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
  the page has the terminal's exit the bar says `claude is not running in this terminal`. Known
  limit of stage A: when the selected session's row is not in the list (a filter excludes it)
  while the window shows its ended terminal, the bar has no Resume, and Close only once the page
  has the terminal's exit — the bar is drawn from the row, not from the terminal (stage A's plan,
  contract 2.9 `endedBar(row, exit)`; accepted by the plan owner, review 2 of plan task 29).
- **New** (Ctrl+Shift+N or `+ New`): a form with the directory (a list of the known project
  directories, most recent first, defaulting to the selected session's, or a typed absolute path),
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

### 12.7 The restore banner

At the top of the list while design 7.8's default set is not empty and the user has not dismissed
it for that boot: "Before the restart (last activity yesterday at 18:02) 3 sessions were open", a
checkbox per session
preselected by design 7.8's rule, "Restore 3" and "Not now". Restore runs as in 11.3; the sessions
show under Open as `starting…` and the banner reports each line of the run (started, timed out,
failed, stopped for memory). "Not now" stores the boot id (10.2): the banner does not come back for
that boot, and the switcher still offers "Restore 3 sessions from <time>" until the next WSL
restart.

### 12.8 Search

- `/` filters the list: title, group, note, pull-request repository and number, directory, short
  id; several words must all match; while a filter is set it includes done sessions and unfolds
  every section and stack. (Stage A has design 7.4's filter: one text, the fields of 7.4.) A
  filter that leaves no row says so: `No session matches the filter.` (ruled by the plan owner,
  plan task 27).
- Chips: Running, Open PR, Has note, Show done.
- Ctrl+Shift+P opens the quick switcher over all sessions, ranked: needs you, open (by slot), not
  running (most recent first), done. Enter switches to a running one and resumes one that is not
  running (11.3).

### 12.9 Keys and focus

No leader key: an app window reserves no keys (section 21; on the user's PC every chord tested
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
filters, `l` label, `g` group, `n` note, `p` attach a pull request, `d` done, `a` show done; new in
the window, Home, End, PgUp, PgDn, ← → (fold, unfold), F2 (label) and Esc (clear the filter, then
back to the terminal). `/` gives the keyboard to the filter's field, where every key but Enter and
Esc is text; Enter and Esc there end the entry and give the keyboard back to the list (Esc also
clears the field), so from the field the terminal is one more Esc away (ruled by the plan owner,
plan task 27). Folding Earlier (← or a click on its header) with the selection inside it first
selects the row above it; while a filter is set nothing folds. The selection is never on a row the
list does not show: when the selected row stops being shown otherwise (a filter, done sessions
hidden again, the row gone from the list), no row is selected — the right side shows a terminal
that holds the session, else nothing —, Enter does nothing, and ↑ ↓ start from the first row shown
(ruled by the plan owner, plan task 27). Enter changes meaning: it shows a running session's terminal, or resumes one
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
a list brought (ruled, plan task 26's review 2).

### 12.10 Done

A session marked done disappears as in design 7.1, except that a running session marked done
stays under Open with a `done` mark until it stops (then it is hidden). Marking done shows an Undo
toast.

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
default: an SVG drawn for skydeck as the source, and PNG files of 16, 32, 48, 192 and 512 pixels
(the 192 and 512 also as maskable icons) committed beside it in `web/icons/` (no build step:
the PNGs are made once from the SVG and committed). `index.html` names the favicon
(`<link rel="icon">`) and the manifest (`<link rel="manifest">`), whose `name` and `short_name`
are `skydeck`, `display` `standalone`, and `icons` the PNGs. Whether Edge's app window and its
taskbar button show it is check W3. Low priority: stage E (19).

## 13. Notifications

- When a session starts to need you (12.4: a change from not needing you to needing you, for any
  of the three reasons) and no window has focus, the server sends `notify` to **one** page: the
  one that had focus last (several windows would otherwise each raise one).
- That page shows a desktop notification with the Notification API (allowed: `127.0.0.1` is a
  secure context, section 21): title = the session's title, body = the reason (`asks: permission ·
  Bash`, `finished`, `ended unexpectedly`), both plain text; `tag` = the session id, so a newer
  notification for a session replaces the older one. A click focuses the window and selects the
  session.
- No notification for the session that is selected in a focused window, and none while the page
  has no permission.
- Permission is asked once, on a user gesture: a "Turn on notifications" item in the title bar
  while the permission is `default`. It is asked per origin and profile (section 21), so it stays
  granted while the port and profile folder stay the same.
- Notifications may be blocked on the managed PC (check W11). Without them the window title
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
  users" are on this PC: no second person, but service accounts on Windows and in the distribution
  (a local database, a web server of a development stack) and whatever runs under them. For them
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
  Extensions that company policy forces into every profile still are: check W13 lists them
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
- Links: opened only on a Ctrl+click, only `http` and `https`, and in Edge, never in the page (9.6).
- The program's window title (OSC 0, 2) is ignored: the window shows skydeck's own titles.
- Query answers come only from the screen side (9.3), and the page's terminal answers nothing, so
  output cannot make the page type into the program.

### 15.5 What runs

The keeper runs the launch the server gives it: `claudeCommand` and the arguments design 7.6 and
7.7 build. The server runs `window.edge` (the window, links), `wsl.exe` (the keep-alive) and
`python3` (keepers), each with an argument list. No input from a page becomes a program name or a
shell string; a page's `new` flags become `claude` arguments only after design 7.7's refusals.

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
already runs (`gh`, `wezterm`) and `python3 --version`; it starts nothing on Windows, signals
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
| keep-alive | a server or a keeper runs and neither protection is in effect — while the server's `GET /status` says `starting` and its keep-alive is still starting by the server's own word (`keepAlive.state` is `starting`), the line is `info` (`keep-alive: not confirmed yet: the window's server is starting, and its first check starts the keep-alive or takes over one that still runs`; ruled by the plan owner, follow-up "server-findable", review 2). A keep-alive that is `off`, or has `failed` (it cannot start: no `WSL_DISTRO_NAME`, …), stays the problem while the server starts too. The line names the one in effect: `.wslconfig has instanceIdleTimeout=-1 (WSL does not stop by itself)`, or `keep-alive wsl.exe running (pid <n>, since <time>); that it keeps WSL running is unverified (manual check W14)`. `.wslconfig` is read from the Windows profile folder found as in 5.4. Whether the keep-alive runs is the server's word when it answers; otherwise `doctor` judges it as the server judges one it did not start (6.1): its `keepalive.pid` line (one that cannot be read or judged is "cannot be told", never "not running"), and one connection, sending nothing, to the socket `keepalive.interop` names (refused or gone: its `wsl.exe` is gone; never a socket inside the runtime directory). The problem line names the setting and that it takes effect at the next WSL restart; it names `wsl --shutdown` only with what it does (6.1). |
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
| `terminal` | `"here"` | Gains the value `"window"` (11.4). |
| `window.port` | `47613` | The server's port on `127.0.0.1` (5.2). A whole number from 1 to 65535: 0 ("the system picks") is not a setting; tests give it to the server directly (17). |
| `window.edge` | `"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"` | The Edge program (5.3, 9.6). An absolute path. |
| `window.profileDir` | `null` | The Windows folder of the window's Edge profile (5.4). `null`: derived. An absolute Windows path (`<letter>:\…`). |
| `window.keepAlive` | `"wsl"` | `"wsl"` or `"off"` (6.1). |

Unknown keys inside `window` are an error, as everywhere in `config.json`.

### 16.5 Updating skydeck while terminals are open

`git pull` changes the checkout. Then:

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

**No Windows program, enforced.** The development machine has a real `msedge.exe`, `wsl.exe` and
`/run/WSL/1_interop`, so the rule is built in rather than only asked for. The test sandbox's
environment carries `SKYDECK_TEST_NO_WINDOWS=1`; while it is set — in skydeck's own environment or
in the one given to the child — the real platform refuses to start a program that is under `/mnt/`,
ends in `.exe` (any case) or starts with `MZ` (what WSL interop runs), also when the name reaches
such a file through `PATH` or a symbolic link: the start fails with the code `EWINDOWS` and nothing
runs. A test platform that can start a real process refuses them always, whatever any environment
says; the pure fake starts nothing: it records the start and returns what the test scripts, also for
a Windows program, so that a test can check the command line Edge or the keep-alive would get. Every
test that starts a server gives it a sandbox `config.json` whose `window.edge` is a stub that
records its arguments and whose `keepAlive` is `off`, unless the test is about them, and points the
first interop candidate (6.4) into the sandbox. Without the variable nothing is refused: the rule
belongs to the tests, not to skydeck.

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
version whose Chromium is build 1223, the build already installed on the development machine)
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
- CI, on every pull request: both legs of the Node matrix run format check, type checks, `npm
  test` (keeper and server tests included; Ubuntu runners have python3), `python3 -m py_compile
  bin/skydeck-keeper`, the vendored-files check (16.6: `test/vendor/vendor.test.ts`, a test in
  `npm test` that needs the packages `npm ci` installed, so it has no step of its own), and
  `shellcheck` on the shell scripts by
  name — `bin/skydeck`, `bin/skydeck-hook`, `bin/skydeck-keepalive` — because today's `shellcheck
  bin/skydeck*` would also match the python keeper. Each is a step of its own: CI does not run
  `npm run check`, which ends with the page suite. Only the newest leg (Node 24) runs the page
  suite, and it runs on Ubuntu 24.04 (the development machine's system) while the other leg runs
  on the newest Ubuntu (26.04), because Playwright 1.60.0 has no Chromium for Ubuntu 26.04; the pin
  of that leg's runner is dropped when Playwright is upgraded. The leg reads the installed
  Playwright's version and the system's (`ID-VERSION_ID` of `/etc/os-release`), restores
  `~/.cache/ms-playwright` from the cache keyed by both, runs `npx playwright install --with-deps
  chromium` (the browser is downloaded only when the cache missed; the system libraries it needs
  are installed every time) and then `npm run test:page`. The job's time limit goes from 10 to 20
  minutes.

## 18. Manual checks for step 2

What only the real Claude Code or the Windows desktop can settle: the lists of the three research
tracks (terminals, window, UI), merged. Each check names the stage that needs it (19) and the
sections it can change. They join [manual-checks.md](manual-checks.md) when their stage is built;
the research's check kit (an Edge key-test page, a lifetime script for a throwaway distribution) is
kept with the research notes. Items marked **real claude** use a real session in a throwaway
folder, as in manual-checks.md.

| # | Check | Stage | Decides |
|---|---|---|---|
| W1 | `skydeck window` opens an Edge app window that loads the page and connects. (That Edge reaches a server on `127.0.0.1` in WSL was verified by the user on 2026-11-13; this checks the command itself: the profile folder, the start, the wait for the page.) Write down how long Edge took from the command to the page's connection, cold and warm: the token and the command's wait last 30 seconds (5.1). | A | 5, 8.2.2 |
| W2 | The chords of 12.9 that the key test of 2026-11-13 did not press reach the page and the browser does nothing: Ctrl+Shift+P, J, L, F, C, H and 1–9; and Alt+F4 still closes the window once the page is built (12.9). Whether Edge reloads on Shift+F5 and on the BrowserRefresh key (alone, with Shift, with Ctrl) when the page does not cancel them, and whether a cancelled BrowserRefresh still reloads (through `WM_APPCOMMAND`) (12.9, 15.3). In a normal tab (`--print-url`), which chords the browser keeps. | A | 12.9 |
| W3 | The window has its own taskbar button with skydeck's icon (12.12), the same one after `skydeck window --restart` and after a WSL restart, and the title `(n) skydeck`; a second `skydeck window` opens no second window. | A, B, E | 5.1, 12.1, 12.12 |
| W4 | **Real claude** in a window terminal: status line, subagent display, spinner, redraw on resize. Then `skydeck window --restart`: the screen is exactly what it was. | A | 7.2, 7.3 |
| W5 | **Real claude**, the screen side answering alone: does Claude Code use synchronized output; does the OSC 11 answer make its automatic theme right; with an XTVERSION answer `xterm.js(6.0.0)` (a one-line change), any visible effect? | A | 9.3 |
| W6 | **Real claude**: Shift+Enter inserts a newline; Ctrl+V pastes text; Ctrl+Shift+V pastes a Windows screenshot; Ctrl+Shift+C copies a selection, and a program's OSC 52 write reaches the Windows clipboard. | A | 9.1, 9.5 |
| W7 | W6's Ctrl+Shift+V again after closing the WSL terminal `skydeck window` was run from (the interop link of 6.4). | A | 6.4 |
| W8 | Czech layout in Edge: AltGr characters (`\ [ ] { } @ # ~ \|`) and dead keys (háček, čárka) in a terminal; Ctrl+Shift+digit and Ctrl+Shift+H chords; Ctrl+Shift+- reaches Claude Code (undo). | A | 9.1, 12.9 |
| W9 | Cascadia and Segoe draw Claude Code's `⏺ ⎿ ⏵` (headless Linux showed empty boxes). | A | the page's font list |
| W10 | **Real claude**: rows with emoji, ZWJ and skin-tone sequences line up; `unicode-graphemes` against `unicode11`, compared with Claude Code's own layout. | A | 9.4 |
| W11 | Desktop notifications are allowed on the managed PC: the permission prompt, a toast, a click that selects the session; and they still come when the window has been minimised for half an hour (Chromium throttles hidden pages and Edge may put them to sleep). | B | 13 |
| W12 | Ctrl+click on a link opens it in the user's main Edge window, logged in. | A | 9.6 |
| W13 | `edge://policy` (any `URLBlocklist`, `BrowserSignin`, `SyncDisabled`, `WebApp*`, `Extension*` entry), `edge://extensions` in the window's profile (which extensions are forced in), and whether the window's profile is signed in and syncs its history (`edge://settings/profiles`). | A | 15.1, 15.2 |
| W14 | WSL lifetime: the lifetime script against a throwaway distribution measures the idle rule; then, with the window open and every WSL terminal closed, WSL is still running after a minute (`wsl -l -v` in PowerShell). Without the keep-alive (`"off"`) it stops. | A | 6.1 |
| W15 | Sleep: with the window open, lock or sleep the PC for a few minutes. The page recovers by itself, keys work, the terminal repaints, sessions still run. | A | 6.5 |
| W16 | WSL stop drill: `wsl --shutdown` with the window open and three sessions in it. The bar of 6.3 appears; after `skydeck window` the window says WSL restarted and the banner offers the three; "Restore 3" brings them back into the window. | C | 6.3, 12.7 |
| W17 | **Real claude**, `/tui fullscreen`: the alternate screen and the mouse mode come back after `skydeck window --restart`. | A | 7.2 |
| W18 | **Real claude**: a terminal query answered late (the server stopped for a few seconds while Claude Code starts) — does the answer leak into the prompt? | A | 7.1, 14 |
| W19 | **Real claude**: does `waitingFor` tell a permission prompt from a question? | B | 12.4 |
| W20 | Privilege management does not block or prompt for `msedge.exe` and `wsl.exe` started through interop. | A | 2, 5.3, 6.1 |
| W21 | **Real claude**: a turn that ends in a session that is not selected shows "finished · not seen"; selecting it for 1.5 s clears it; a permission dialog shows "asks". | B | 10.3, 12.4 |
| W22 | **Real claude**: a session started in a WSL terminal shows "running in another terminal", Resume is refused with the guard's message, and after `/exit` it resumes into the window. | A | 7.9 |
| W23 | **Real claude**: which `CLAUDE*` variables Claude Code sets for the programs it runs — print the variable names (never their values) in a session's `!env` against a plain shell's — to confirm 7.4's list. And `skydeck window` run from a session's `!` command refuses (5.1). | A | 5.1, 7.4 |
| W24 | Crash dumps: kill a stand-in keeper, and a throwaway `node` started through the launcher's `/usr/bin/python3 -I -S -c` program (soft core limit 1 byte), by SIGSEGV; does a dump appear in WSL's crash folder (`%Temp%\wsl-crashes`, or `crashDumpFolder` in `.wslconfig`)? Neither should. | A | 2 |
| W25 | A Windows program holding the port: with a small Windows program listening on `127.0.0.1:<port>` before skydeck's server starts, does the WSL server still answer from Windows on `[::1]:<port>`? If it does, a program between page and server is possible (15.3). Also: does Edge drop a service worker whose script the real server answers with 404? Answered for Chromium by the page suite (17.4, plan task 26): no, the worker keeps answering and stays registered; Edge itself is still to be checked here. | A | 15.3 |
| W26 | **Real claude**, using the alternate screen (`/tui fullscreen`, or a full-screen program it runs): `skydeck window --restart` while it is showing, compare the screen before and after, then leave the alternate screen and compare again. What a snapshot does not restore (7.2: scroll region, saved cursor, character sets) would show as a misplaced cursor or wrongly scrolled or drawn lines. | A | 7.2, 7.3 |

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
desktop notifications (13). Checks W11, W19, W21.

**Stage C — restore in the window.** The restore banner (12.7); the commands' `--window`,
configuration `"terminal": "window"`, and `POST /resume`, `/new` and `/restore` (11.4); `show`'s
`(in the skydeck window)`. Check W16.

**Stage D — header editing and pull-request detail.** Label, group, note, done and undone, `+ PR`
and removing one, in the window (12.5) with the Undo toast; the window's chip (12.3) and the
pull-request lines of the header; the list keys `l`, `g`, `n`, `p`, `d` and F2.

**Stage E — search.** Several words and the short id in the filter, done sessions while filtering,
the chips, the quick switcher Ctrl+Shift+P, stacks in This week and Earlier (12.2, 12.8). The
page's own icon (12.12).

## 20. Left out of step 2 on purpose

- **A native window program.** The window research ranked: (1) the Edge app window, chosen; (2) a
  WebView2 host in C#, built on the PC with the `csc.exe` that ships with Windows — one unsigned
  program, and whether the managed PC runs it is unknown (privilege-management software is
  installed); (3) Electron, Tauri or Wails — the same unsigned-program question with more weight
  or toolchains (the official Electron build is not signed). A native host stays a later option on
  top of the same server and page. A WebView2 window hosted through PowerShell is **not an option
  at all**: choosing it because it passes under application control that would stop the same
  program as an exe would be working around the company's control, not being allowed.
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
| `/run/WSL/1_interop` exists on the development machine (systemd on); a symbolic link to a live interop socket works as `WSL_INTEROP` for processes that outlive their terminal. | first part verified; second UNVERIFIED (W7) |
| Claude Code recognises xterm.js only from an XTVERSION reply starting `xterm.js` (or `TERM_PROGRAM=vscode`) and then changes wheel scrolling, glyph-atlas resets and link clicks. Under tmux it turns off synchronized output and its extended-keys path. | inferred (strings in the binary) |
| Claude Code measures widths with `Bun.stringWidth(…, {ambiguousIsNarrow: true})`; `addon-unicode-graphemes` 0.4.0 gives VS16, ZWJ and skin-tone sequences two columns. | inferred (binary) / verified (addon) |
| A hand-written RFC 6455 server on `node:http` of about 100 lines passes frames from 0 bytes to 1 MiB, fragments, ping and pong, close codes, invalid UTF-8 (1007), unmasked frames (1002), and refuses a wrong token or Origin. | verified (T7, with `ws` 8.23.0 as the client) |
| In a Chromium `--app` window no key is reserved: every key reaches the page first, and `preventDefault` cancels the browser's action. | verified in Chromium's source (window research) |
| In an Edge 157 app window with its own profile folder, every chord of the key test reached the page and was cancelled by it: Ctrl+W, N, T, Shift+T, Tab, Shift+Tab, R, P, F, L, J, H, O, B, G, D, U, K, E, Z, S, Q; F5, F10, F11, F12; Ctrl+Shift+V, N, W, I, S, E, Y, M, O; Ctrl+PageDown; Alt+Left, Alt+B, Alt+F, Alt+V; and Alt+F4, after which the window stayed open. Alt+Space did not reach the page (Windows keeps it for the window menu). The page loaded once and never reloaded (164 key presses, one load); `display-mode` was `standalone`; it was a secure context. | verified by the user on their PC, 2026-11-13 |
| In a normal tab the browser keeps Ctrl+W, Ctrl+F4, Ctrl+Shift+W, Alt+F4, Ctrl+N, Ctrl+Shift+N, Ctrl+T, Ctrl+Shift+T, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgDn and Ctrl+PgUp. A page never sees Alt+Tab or Win chords. | verified in Chromium's source; not tested in Edge (W2) |
| `http://127.0.0.1:<port>` is a secure context (verified by the user, 2026-11-13): Notification and the async clipboard are allowed; notification permission is per origin and profile. Whether the managed PC lets notifications and clipboard writes through is not tested yet (W6, W11). | documentation |
| An app window's taskbar identity is made of an app name generated from the address's host and path (`GenerateApplicationNameFromURL`: host, `_`, path; no port) and the profile path. | verified in Chromium's source (review, 2026-11-13); whether Edge shows skydeck's icon is W3 |
| xterm.js 6.0.0 sends nothing for Ctrl+Shift with a letter and then does not cancel the key (it builds the control byte only without Shift); for a plain Ctrl+V it sends `\x16` and cancels the key, so the browser does not paste unless the custom key handler returns false. | verified in xterm.js 6.0.0's source (`Keyboard.ts`, `CoreBrowserTerminal`) |
| xterm.js 6.0.0's paste handler sends the pasted text and empties its hidden textarea, but does not cancel the paste event, so the browser then puts the whole text into that textarea: after a paste of 10 MiB in headless Chromium the page sent its input at about 0.4 MB/s and answered a script in seconds; with the paste cancelled after xterm.js took it (the first fix; the page now takes the paste itself, 9.1), the same paste reached the server in under a second (plan task 28). | verified (headless Chromium 1223; the bundle's `handlePasteEvent`) |
| xterm.js 6.0.0 wraps pasted text unfiltered (`ESC [ 2 0 0 ~`, the text, `ESC [ 2 0 1 ~`): a pasted text that holds `ESC [ 2 0 1 ~` ends its own bracketed paste, and what follows reaches the program as typed keys, Enter included. | verified (headless Chromium 1223; plan task 28's review 2) |
| xterm.js 6.0.0's DOM renderer writes its colours, cursor and selection rules into `<style>` elements it creates at run time: under `style-src 'self'` a red cell renders black; with `'unsafe-inline'` it renders red. | verified in headless Chromium (review, 2026-11-13) |
| On WSL a crashing process's core dump is piped to WSL's crash collector (`core_pattern` is `\|/wsl-capture-crash …`), which keeps up to `maxCrashDumpCount` (default 10) dumps in `crashDumpFolder` (default `%Temp%\wsl-crashes`). A non-dumpable process (`PR_SET_DUMPABLE` 0) produces no dump, piped or not. For a piped dump the kernel ignores a core limit of 0 and aborts only on a soft limit of exactly 1 byte (`fs/coredump.c` of Linux 6.6). | `core_pattern` verified; documentation (learn.microsoft.com/windows/wsl/wsl-config, `prctl(2)`); kernel source read for 6.6 in review; this machine's 6.18 UNVERIFIED (W24) |
| `/run/user/<uid>` outlives the user's last terminal only when the user lingers; on the development machine the user does. | verified |
| The keeper's code needs python3 3.9 or newer (`os.waitstatus_to_exitcode`); it was run on 3.12 only. | inferred (3.9) / verified (3.12) |
| The Web Crypto flow of 8.2.2 works in Chromium: HKDF-SHA256 from the token, AES-256-GCM `unwrapKey` into a non-extractable HMAC key, a proof equal to Node.js's HMAC over the same bytes; `exportKey` fails; the key survives a round trip through IndexedDB and still signs; the page is a secure context. | verified in headless Chromium (review, 2026-11-13) |
| `@xterm/addon-search` 0.16.0 was published with xterm.js 6.0.0 (2025-12-22) and is its latest release. | documentation (npm registry, 2026-11-13) |
| `CLAUDECODE` is set in the environment of a command a Claude Code session runs. | verified (the development machine, 2026-11-13) |
| Which `CLAUDE*` variables Claude Code sets for the programs it runs, beyond `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`. | UNVERIFIED (W23) |
| `msedge.exe` started while an Edge on the same profile folder runs hands off and exits at once. | verified in Chromium's source |
| Started through interop with stdio ignored and a Windows working directory, a Windows program shows no console window. | verified in WSL's source |
| A WSL distribution stops `instanceIdleTimeout` (default 15 s) after its last Windows client exits; Linux background processes and systemd do not count; the VM stops `vmIdleTimeout` (default 60 s) after the last distribution. `.wslconfig` `[general] instanceIdleTimeout=-1` keeps it. | verified in WSL's source; not measured (W14) |
| A `wsl.exe` started from inside WSL through interop counts as such a client. | UNVERIFIED (W14) |
| In WSL's NAT mode a port bound to `127.0.0.1` inside WSL is reachable from Windows. From the Edge app window on the user's PC, `http://127.0.0.1:<port>` in WSL answered 132 pings of 132, in about 7 ms. | documentation; verified by the user on their PC, 2026-11-13 |
| An Edge window started through interop survives a WSL stop. | inferred (W16) |
| WSL can hang after hibernation (issue #8696); new `wsl.exe` sessions can time out on WSL 3.0.3 (#42006). | documentation (WSL issues) |
| On the development PC: BeyondTrust privilege management is installed (policy unreadable); the Edge WebView2 runtime is installed; WSL 3.0.5 with systemd, no `.wslconfig`, NAT networking, interop on; python3 3.12. Whether unsigned programs run from user folders is unknown. | verified (read-only look under `/mnt/c`) |
| Sessions started in another terminal cannot be shown: their pty master belongs to that terminal; `reptyr` needs ptrace (`ptrace_scope` is 1); reading `/dev/pts/N` steals input. | verified |

