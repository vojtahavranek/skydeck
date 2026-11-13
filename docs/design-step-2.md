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
  conversation content. They exist only in memory — in the server's terminal models, in each
  keeper's parked snapshot and tail, in the page — and are never written to a file, the store or
  a log by skydeck. The server's log names terminals by id and never holds a byte of their output
  or input.
- **Principle 6 (nothing is destroyed or moved automatically; skydeck never stops a process)** is
  made precise: skydeck never stops a `claude` process or a keeper (stopping a keeper would end
  its session). It may stop its own server and its own keep-alive process (6.1). The window has no
  "kill" action: a session ends when the user ends it inside `claude`.
- **Principle 8 (local only)**: the server listens on the loopback interface only (15). The only
  network use is still `gh`.
- **Windows programs.** Step 2 is the first time skydeck starts Windows programs by itself, through
  WSL interop. It starts exactly two, and only these: `msedge.exe` (the window, 5.3, and links the
  user Ctrl+clicks, 9.6) and `wsl.exe` (the keep-alive, 6.1). Never `cmd.exe`, `powershell.exe` or
  a shell; arguments are passed as an argument list. skydeck **writes nothing on the Windows side**:
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
| size owner | The page whose size a terminal has (8.2.6). |
| needs you | A session the user should look at (12.4): it asks something, a turn finished and was not seen, or its window terminal ended unexpectedly. |
| seen | The user has looked at a session in a window (12.4). |
| runtime directory | `<runtimeDir>`, section 4.2. |

## 4. Process model and places

### 4.1 Processes

| Process | Started by | Lives | Code |
|---|---|---|---|
| `skydeck` commands | the user | as in step 1 | `src/cli/` |
| the server, `skydeck serve` | `skydeck window` (or a command that needs it, 11.4), detached in a session of its own | until `skydeck window --stop` or `--restart`, `uninstall`, a crash, or WSL stopping | `src/window/` |
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
| `<runtimeDir>` | `$XDG_RUNTIME_DIR/skydeck` when `XDG_RUNTIME_DIR` is set, an absolute path, a directory owned by the user and not readable by others; else `<stateDir>/run`. Created with mode 700. Holds `server.json`, `server.pid`, `interop`, `keepalive.pid`, `keepalive.interop` and `terms/`. `XDG_RUNTIME_DIR` is emptied when WSL stops; `<stateDir>/run` is not, so the server treats anything there from another boot as stale (6.3, 7.8). |
| `<runtimeDir>/server.json` | The running server: `pid`, `procStart`, `bootId`, `port`, `serverId` (random per start), `build` (16.5), `startedAt`. Mode 600. Written after the server listens, removed when it stops. |
| `<runtimeDir>/server.pid`, `keepalive.pid` | One pid each: the server's for the keep-alive script (6.1), which cannot read JSON; the script's own for the server. |
| `<runtimeDir>/keepalive.interop` | The keep-alive's `$WSL_INTEROP` (6.4). |
| `<runtimeDir>/terms/<terminal id>.sock` | A keeper's unix socket, mode 600, in a directory of mode 700. |
| `<runtimeDir>/terms/<terminal id>.pid` | The keeper's pid, written by the keeper, for the keep-alive script. |
| `<runtimeDir>/interop` | A symbolic link to a live WSL interop socket (6.4). |
| `<stateDir>/server.log` | The server's own diagnostics, one line each, never conversation content or the secret; at 1 MiB it is renamed to `server.log.1` (one older file is kept). |
| the store | Migration 2 (10.2) and the `kv` entries of 10.2. |
| the Edge profile folder | A Windows folder (5.4). Edge creates and writes it; skydeck never writes or removes it. |

A unix socket path must be shorter than 108 bytes. With the `<stateDir>/run` fallback and a long
home directory it can be longer; then the server refuses to open terminals and says why, and
`doctor` reports it.

### 4.3 Code layout

Added to design 11:

| Module | Job | May import |
|---|---|---|
| `bin/skydeck-keeper` | The keeper (7.1), python3. | — |
| `bin/skydeck-keepalive` | The keep-alive's inner script (6.1): `sh` builtins, `sleep` and `mv` only. | — |
| `src/claude/terminal.ts` | What Claude Code sets in its children's environment (7.4); the meaning of a live-file status change for a turn end (10.3). | platform |
| `src/window/` | The server: HTTP and WebSocket (8.2), authentication (15), keeper connections (8.1), screen sides (7.2), the view model of the page (12), the server's tick (10.1), Edge and the keep-alive (5, 6). | platform, text, store, claude, sessions, terminals, github |
| `src/window/view/` | The page's view model as pure functions: sections, rows, stacks, attention, the switcher's ranking, the filter (12). | sessions (types), text |
| `src/terminals/window.ts` | The terminal adapter `window` (11.3). | platform, text |
| `web/` | The page: `index.html`, plain JavaScript modules with JSDoc types (checked by `tsc`), CSS. No bundler, no build step: the files are served as they are. | `vendor/xterm/` |
| `web/keys.js` | The key table (12.9) and the terminal key mapping (9.1), as pure functions. | — |
| `vendor/xterm/` | The vendored xterm.js files (16.6). | — |

Nothing in `web/` decides a rule that the server also needs: the page renders what the server
sends and maps keys. Everything that orders, groups, filters or judges attention is in
`src/window/view/` and tested without a browser.

`src/platform/` gains what the server needs from the outside world, so that tests pass fakes:
starting a detached process with a given environment, a long-lived child with pipes, listening on
TCP, connecting to and listening on unix sockets, and reading `/proc/<pid>/stat` for a parent
pid. Design 11's rule stands: nothing outside `src/platform/` starts a program or opens a socket.

## 5. Starting the window

### 5.1 `skydeck window`

```
skydeck window [--print-url] [--new-window] [--restart] [--stop] [--new-secret]
```

Run inside WSL. Without options it:

1. makes sure the server runs (5.2): when `server.json` names a server that answers `/api/ping`
   (8.3) with the current boot id and the current build (16.5), that one is used; when it answers
   with another build, it is asked to stop and a new one is started (sessions keep running,
   16.5); otherwise a new one is started;
2. when no page is connected to the server, starts Edge (5.3) and waits up to 10 seconds for a page
   to connect;
3. prints one line: `skydeck window: http://127.0.0.1:<port>/ (server pid <n>)` — never the secret
   — and exits 0. When Edge was started but no page connected in time it says so, names
   `--print-url`, and exits 1.

When a page is already connected it starts nothing on Windows and says
`skydeck window: a window is already open`; `--new-window` opens another one anyway (several
windows are supported, 8.2.7). A command cannot bring an existing window to the front: Edge's
hand-off to its running instance opens a new window instead, which is what `--new-window` does.

Options:

- `--print-url`: make sure the server runs, then print the full URL with the secret
  (`http://127.0.0.1:<port>/#k=<secret>`) for any browser, and start nothing on Windows. In a
  normal browser tab the page works with fewer keys: the browser keeps Ctrl+W, Ctrl+T, Ctrl+N,
  Ctrl+Tab and their Shift forms (section 21), so the page shows a hint naming Ctrl+Shift+O for
  "previous session" and the "+ New" button.
- `--restart`: stop the running server (5.5) and start a new one. Sessions keep running.
- `--stop`: stop the server and start nothing. Sessions in the window keep running in their
  keepers; windows say that the server is gone (6.3).
- `--new-secret`: stop the server, replace the secret (15.2), start a server and a window. Windows
  opened before cannot connect any more and say so.

Exit codes as design 7.5: 0, 1 (failure), 2 (usage).

### 5.2 Starting the server; one server only

`skydeck window` starts `bin/skydeck serve` through the launcher (so the Node.js binary is chosen
as for every command, design 10), detached in a new session (it gets no SIGHUP when the terminal
it was started from closes), with stdin `/dev/null`, stdout and stderr appended to
`<stateDir>/server.log`, working directory `/`, and the environment of the `skydeck window`
command without `SKYDECK_HANDOFF`. The programs of the terminals inherit this environment (7.4),
so a change to the user's shell profile reaches new terminals only after `skydeck window
--restart`.

The fixed port (configuration `window.port`, default 47613) is the lock that keeps one server per
machine. A server that cannot bind the port asks whoever holds it for `/api/ping` with the secret:
a skydeck server that answers makes it exit 0 quietly (two `skydeck window` at once start one
server); anything else makes it exit 1 with `port <n> on 127.0.0.1 is used by another program; set
window.port in <config path>`, which `skydeck window` prints. The port is fixed because Edge's
taskbar identity of an app window includes the host and port (section 21): a changing port would
be a new app each time.

`skydeck serve [--foreground]` is a command of its own, listed in `skydeck --help` as "the window's
server (started by skydeck window)". `--foreground` runs it in the terminal, logging to stderr, for
debugging.

### 5.3 Starting Edge

The program is configuration `window.edge`, default
`/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`. It is run directly (never
through a shell), detached, with stdio ignored and working directory `/mnt/c` (a Windows
directory, so no "UNC path" warning), and the arguments:

```
--app=http://127.0.0.1:<port>/#k=<secret>
--user-data-dir=<profile folder>
--no-first-run
--no-default-browser-check
```

`msedge.exe` hands off to an Edge that already runs on the same profile folder and exits at once
(section 21), so its exit says nothing about the window; whether a page connected is what
`skydeck window` waits for. It always passes the same port and profile folder.

When the program does not exist, `skydeck window` says `Edge was not found at <path>; set
window.edge in <config path>, or open the window in any browser with skydeck window --print-url`
and exits 1. The server keeps running.

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

On `/api/shutdown` (8.3), SIGTERM or SIGINT the server: stops accepting connections; parks a
snapshot in every keeper (7.3); closes its keeper connections (the keepers and their programs keep
running); sends every page `bye` with the reason; removes `server.json` and `server.pid`; and
exits 0. It does not stop the keep-alive, which ends by itself (6.1). A server that crashes leaves
`server.json` behind: anything that reads it checks that its pid and process start are alive on
the current boot (design 5.5) before believing it.

## 6. WSL lifetime

A WSL distribution stops `instanceIdleTimeout` (default 15 s) after its last Windows client
exits — `wsl.exe` sessions and programs that use the WSL API. Linux background processes do not
count, systemd included (section 21). When it stops, every process in it ends: the server, every
keeper, every `claude`. The window, an Edge process, stays.

### 6.1 The keep-alive

With configuration `window.keepAlive` `"wsl"` (the default), the server keeps one Windows client
of the distribution alive while the window has anything to keep:

- It starts `/mnt/c/Windows/System32/wsl.exe -d <$WSL_DISTRO_NAME> --exec /bin/sh
  <checkout>/bin/skydeck-keepalive <runtimeDir>` through interop, detached, with stdio ignored.
  The script first writes its own pid to `keepalive.pid` and its `$WSL_INTEROP` to
  `keepalive.interop` (6.4), through a temporary name and a rename.
- The script loops: every 10 seconds it checks with `kill -0` whether the pid in `server.pid` or
  any pid in `terms/*.pid` is alive; when none is, it exits, and `wsl.exe` with it. So it outlives
  a server restart (the new server finds `keepalive.pid` alive and starts no second one), and it
  holds WSL while terminals run even after `skydeck window --stop`. A reused pid only delays its
  end.
- When the keep-alive ends while the server runs, the server starts it again after 5 s, 30 s, then
  every 5 minutes, and tells every page (`notice keepalive-lost`).

That a `wsl.exe` started from inside WSL counts as a Windows client is **UNVERIFIED** (section 21;
check W14). The design does not depend on it:

- the documented alternative is the user's own setting: `instanceIdleTimeout=-1` under `[general]`
  in `%USERPROFILE%\.wslconfig` (or "keep WSL running" in the WSL Settings app, which writes it),
  then one `wsl --shutdown`. skydeck never writes that file (2);
- `doctor` reports which protection is in effect (16.3);
- the page notices when WSL has stopped anyway (6.3), and restore brings the sessions back (12.7).

`"off"` starts no keep-alive.

### 6.2 What the server watches

The server checks the keep-alive's pid every tick (10.1). `/api/status` (8.3) carries
`keepAlive: { mode, state: running|starting|failed|off, since, error }`, and so does the page's
`hello` answer, so a window can show "WSL is not kept running" in its title bar.

### 6.3 The page notices that the server is gone

The page sends `ping` over the WebSocket every second (8.2.3). With no `pong` for 3 seconds, or a
closed WebSocket, it shows a bar across the window:

> skydeck's server is not answering (since 14:02:11). Sessions in the window keep running unless
> WSL has stopped. To get back, open a WSL terminal and run: `skydeck window`

and tries `GET /api/ping` (8.3) every second for 10 seconds, then every 5 seconds. A page cannot
tell a dead server from a stopped WSL while neither answers (both refuse the connection). When an
answer comes, it compares:

- **same boot id, same server id**: the connection had dropped (sleep, 6.5); it reconnects and
  re-attaches.
- **same boot id, new server id**: "skydeck's server restarted; your sessions kept running". It
  reconnects, re-attaches (every terminal gets a fresh snapshot), and reloads itself first when the
  server's asset version differs from its own (8.2.2).
- **new boot id**: "WSL restarted at <time>: the sessions that were running have ended." The
  terminal pane shows each ended terminal's last screen no longer (the server that held it is
  gone), the list shows the sessions `not-running` with their marks, and the restore banner offers
  them (12.7; before stage C: "run skydeck restore", or resume them one by one).

The page itself never starts WSL or a program; it says what to type.

### 6.4 A stable interop socket for sessions

Claude Code on WSL pastes an image on Ctrl+V and Alt+V by reading the Windows clipboard through a
Windows program (section 21), which needs a working `WSL_INTEROP`. A process inherits the
`WSL_INTEROP` of the terminal it was started from, and that socket dies with that terminal's
`wsl.exe`. A keeper outlives the terminal that started the server, so its program would lose
interop.

Every terminal's program therefore gets `WSL_INTEROP=<runtimeDir>/interop`, a symbolic link the
server points, when it starts a terminal and every 30 seconds, at the first of these that accepts
a connection: `/run/WSL/1_interop`; the keep-alive's own `$WSL_INTEROP` (from `keepalive.interop`;
it lives as long as the keep-alive); the server's own `$WSL_INTEROP`. The server uses the same link for the Windows
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

`bin/skydeck-keeper` is one python3 file, standard library only (`pty`, `os`, `select`,
`socket`, `struct`, `json`, `fcntl`, `termios`, `signal`), about 200 lines. The server starts it
as `python3 <checkout>/bin/skydeck-keeper`, detached in a new session, working directory `/`,
stdout and stderr `/dev/null`, and writes its **spec** to its stdin as one JSON object, then closes
stdin:

```json
{ "protocol": 1, "id": "<terminal id>", "socket": "<runtimeDir>/terms/<id>.sock",
  "cols": 120, "rows": 40, "cwd": "<directory>", "argv": ["claude", "--resume", "<id>"],
  "env": { "...": "the complete environment of the program (7.4)" },
  "meta": { "sessionId": "<uuid>", "kind": "resume|new", "slot": 3, "openedNs": "<ns>",
            "build": "<server build>" } }
```

The keeper:

1. creates its socket (mode 600; the directory is 700), writes `<id>.pid`, and forks the program
   with `pty.fork()` at the spec's size. The child changes to `cwd`, replaces its environment with
   `env` and `exec`s `argv` — not before a first screen side has connected (7.3), because a TUI's
   first output is terminal queries that only a connected screen side can answer. When `chdir` or
   `exec` fails, the child writes one line naming the reason to the pty and exits 127.
2. accepts one connection at a time; a new one replaces the old (a restarted server must not wait
   for a half-dead connection to time out). It accepts only a peer with its own user id
   (`SO_PEERCRED`).
3. reads the pty and keeps every chunk as a record in the tail; never interprets it.
4. applies input and resizes from the connected server (8.1).
5. keeps at most 8 MiB of tail. When the tail would grow beyond that (no server parked for a long
   time while the program wrote a lot), it drops the oldest records and sets **gap**: the snapshot
   it holds no longer leads to the current screen (7.3).
6. sends to the server without blocking: when more than 8 MiB is queued for a connection, it closes
   that connection (the server reconnects and gets snapshot and tail) and keeps reading the pty.
   The program is never paused because a reader is slow.
7. ends as 7.8 says.

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
the last focused page reports (the headless terminal has no colours). It does not answer XTVERSION
in the first version (9.3). It never answers while it replays (7.3).

The serialise addon does not restore everything (section 21). The server adds what it misses at
the end of every snapshot, from state it tracks with parser hooks: cursor visibility (mode 25),
SGR mouse encoding (mode 1006) and the cursor style (DECSCUSR); and a cursor position (CUP)
always, because the addon puts the cursor one column too far left when the last row is full.
Hyperlinks (OSC 8) written before a snapshot are not clickable after it; plain URLs still are
(9.6).

### 7.3 Attaching, parking, rebuilding

- **Attach.** On connecting to a keeper the server receives `hello`, the parked snapshot if there
  is one, the tail, and the exit if the program has ended (8.1). It builds the screen side from the
  snapshot and applies the tail, answering no query while doing so (those were answered when they
  were new), and is then live. Measured with the prototype: about 40 ms for a parked screen and a
  short tail; parsing runs at about 10 MB/s.
- **Park.** The server parks a snapshot when the tail has grown past 1 MiB, when 30 seconds have
  passed with output since the last park, and for every terminal when it stops (5.5). A park names
  the last record it covers; the keeper drops those from the tail. Serialising 5,000 lines takes
  about 75 ms (measured: 10,000 lines in 145–166 ms), so parking is rare by design.
- **Gap.** A keeper that reports gap (7.1, step 5) has lost records. The server rebuilds from what
  is left, shows "part of this terminal's output was lost while skydeck's server was not running"
  on the terminal, and makes the program redraw by changing the pty's width by one column and back.
  The scrollback above the redraw may be wrong.

A server restart therefore shows every screen exactly as it was (verified with the prototype for
every viewport cell, colour, attribute, 119 lines of scrollback, wrap flags and modes after two
resizes, and after SIGKILL of the screen side with unparked records, section 21).

### 7.4 The environment of a terminal's program

The server's environment (5.2), with:

- removed: the variables that say which terminal or multiplexer a process runs in
  (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `WT_SESSION`, `WT_PROFILE_ID`, every `WEZTERM_*`,
  `TMUX`, `TMUX_PANE`, `STY`, `VTE_VERSION`, `KITTY_WINDOW_ID`, `ITERM_SESSION_ID`, `KONSOLE_*`),
  `SKYDECK_HANDOFF`, and the variables Claude Code sets for the programs it runs (`CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`; the list lives in
  `src/claude/terminal.ts`), so that a server started from inside a Claude Code session does not
  make its programs look like that session's children;
- set: `TERM=xterm-256color`, `COLORTERM=truecolor`, and `WSL_INTEROP=<runtimeDir>/interop`
  while that link points at a live socket (6.4; otherwise `WSL_INTEROP` is left as it is).

`TERM_PROGRAM=vscode` is never set: Claude Code would take the terminal for an editor's (section
21). The program runs directly (`exec`), as in step 1; no shell is started around it.

### 7.5 A terminal and its session

A terminal is opened for a session (resume) or for a new session id (`new`), and the server keeps
both in memory: the **expected session**. Which session it shows is decided again at every tick:

- a holder of a session (design 6.1) **belongs to** a terminal when the holder's pid is the
  terminal's program or a descendant of it (parent pids read from `/proc/<pid>/stat`, at most 8
  steps up), on the current boot. The descendant rule covers a `claudeCommand` that is a wrapper;
- a terminal shows the session one of its holders holds. After `/clear` or an in-session `/resume`
  that is the new session; the old one becomes `not-running` (with no mark, design 6.3), and the
  terminal moves to the new session's row with its slot;
- a terminal whose program has no holder yet is **starting** (12.7 shows it on the expected
  session's row; a new session has no row yet, so the server shows the terminal as a row of its
  own, titled with the label or "new session in <directory>"). After `restoreStartTimeoutSeconds`
  without a holder it is shown as "started, not reported" and stays where it is.

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
connected for 10 minutes since the program ended; it removes its socket and pid file. A keeper
whose spec never got a screen side connected within 10 minutes ends too, without starting the
program (nothing started; the resume's lock expires by design 7.6).

The server, on `exit`: keeps the terminal's last screen in memory and shows it in the terminal pane
dimmed, under a bar `claude exited (status <n>) at <time> · Resume · Close` (12.6), until the user
closes it, resumes the session, or the server restarts. A keeper whose connection ends without
`exit` and that does not answer a reconnect (it died) is **lost**: its program got SIGHUP (section
21), and the bar says `the terminal's keeper ended unexpectedly; claude ended with it`.

Socket files whose connect is refused (a keeper that died, a file from another boot under
`<stateDir>/run`) are removed by the server; they are skydeck's own transient files.

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
| `H` hello | keeper → server | JSON: `protocol` (1), `keeper` (keeper version), `id`, `pid` (the program's), `cols`, `rows`, `seq` (records so far), `snapSeq` (the last record the parked snapshot covers, 0 for none), `gap`, `meta` (the spec's), `exited` (null or as `X`). First frame of every connection. |
| `S` snapshot | keeper → server | 8-byte record number, 2-byte cols, 2-byte rows, the parked snapshot (UTF-8). Right after `H`, only when one is parked. |
| `D` output | keeper → server | One record: bytes as read from the pty. After `H` (and `S`) come the tail's records, then live ones. |
| `R` resize | keeper → server | One record: JSON `{cols, rows}`, the size the pty was set to. |
| `X` exit | keeper → server | JSON `{code, signal, atNs}`: after the last `D`. |
| `I` input | server → keeper | Bytes written to the pty. Dropped after the program has ended. |
| `Z` resize | server → keeper | `"<cols> <rows>"`: sets the pty size, appends an `R` record and sends it back, so the resize takes its place in the stream. |
| `P` park | server → keeper | 8-byte record number, 2-byte cols, 2-byte rows, snapshot. The keeper keeps it and drops the tail's records up to that number. |
| `A` acknowledge | server → keeper | The server has the exit; the keeper may end (7.8). |

Records are numbered from 1 in the order the keeper produced them. The server's position after an
attach is `seq`: the snapshot covers records up to `snapSeq` and the tail brings it to `seq`.

### 8.2 Page and server

#### 8.2.1 HTTP

The server listens on `127.0.0.1:<port>` only. Every request must have the `Host` header exactly
`127.0.0.1:<port>` (15.1), else 421.

| Request | Answer |
|---|---|
| `GET /` | `web/index.html`. No secret needed: the page holds no secret of its own. |
| `GET /assets/<asset version>/<path>` | A file of `web/` or `vendor/xterm/`, from a fixed list (no path is taken from the request beyond that list). `Cache-Control: immutable` under the versioned path. |
| `GET /manifest.webmanifest`, `GET /favicon.ico` | The page's manifest and icon (12.12). |
| `GET /api/ping`, `GET /api/status`, `POST /api/open`, `POST /api/shutdown` | 8.3; they need the secret. |
| `GET /ws` with `Upgrade: websocket` | 8.2.2. |
| anything else | 404. |

Every answer carries `Content-Security-Policy: default-src 'none'; script-src 'self';
style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; connect-src 'self'
ws://127.0.0.1:<port>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and
no CORS header ever. `OPTIONS` is answered 403, so a cross-origin request with a custom header
(15.1) fails its preflight.

The WebSocket is the server's own RFC 6455 code on `node:http` (the prototype is about 100 lines
and passed every frame test, section 21): text and binary frames, fragmentation, ping and pong,
close codes; invalid UTF-8 closes with 1007, an unmasked client frame with 1002; a message over
1 MiB from a page closes with 1009.

#### 8.2.2 Handshake and versions

- The upgrade request must carry `Origin` exactly `http://127.0.0.1:<port>`, else 403.
- The page's first message is `hello` within 5 seconds, else the server closes with 4001:

  ```json
  { "t": "hello", "protocol": 1, "secret": "<from the URL fragment>",
    "assetVersion": "<the version the page was loaded with>", "windowId": "<random per page>",
    "focused": true, "theme": { "fg": "#cccccc", "bg": "#1e1e1e" } }
  ```

- A wrong secret closes with 4003 ("this window's key is not valid any more; run skydeck window").
  Compared in constant time.
- A `protocol` the server does not speak closes with 4426. A page whose `assetVersion` is not the
  server's reloads itself (it was loaded from an older server); the server's answer says which:

  ```json
  { "t": "welcome", "protocol": 1, "assetVersion": "<build>", "serverId": "<random>",
    "bootId": "<id>", "version": "<package version>", "keepAlive": { ... }, "nowNs": "<ns>" }
  ```

Page and server come from one checkout, so "same asset version" means "same protocol"; the
protocol number exists for the reload decision and for tests.

#### 8.2.3 Messages

JSON text frames, each with a type `t`. Times are nanoseconds as decimal strings. Every string the
server sends that comes from a transcript, a live-session file, GitHub, the user or the store has
passed the sanitiser (design 7.4), except a note's text (multi-line, sanitised line by line by the
page's renderer, which writes it as text, never as markup).

Page → server:

| `t` | Fields | Effect |
|---|---|---|
| `ping` | `n` | `pong` with the same `n`, `bootId`, `serverId`. |
| `view` | `filter`, `chips`, `unfolded`, `showDone`, `selected` | The page's view state; the server answers with `list` and keeps sending `list` when it changes (12). |
| `focus` | `focused`, `selected` | Window focus and selection, for seen (12.4), notifications (13) and the size owner. |
| `attach` | `term`, `cols`, `rows` | Start a terminal stream (8.2.4). The page's size is a proposal (8.2.6). |
| `detach` | `term` | Stop it. |
| `input` | `term`, `data` | Typed text (UTF-8) for the terminal; `binary: true` when `data` is a byte string from xterm.js's binary channel (mouse reports). Makes this page the size owner. |
| `resize` | `term`, `cols`, `rows` | The page's fitted size (8.2.6). |
| `act` | `id`, `kind`, … | An action (11, 12): `resume`, `new`, `restore`, `label`, `group`, `note`, `done`, `undone`, `pr-add`, `pr-rm`, `pr-refresh`, `close-terminal`, `open-link`, `dismiss-restore`. |

Server → page:

| `t` | Fields |
|---|---|
| `welcome` | 8.2.2. |
| `pong` | `n`, `bootId`, `serverId`. |
| `list` | The view model (12): sections, rows, counts, the restore banner, terminals with slot and state. Sent whole (about 50 KB for 100 sessions) when it changed, at most once a second. |
| `snap` | `term`, `ch` (the channel number for its output), `cols`, `rows`, `data` (the snapshot). |
| `size` | `term`, `cols`, `rows`, `owner` (this page or another): the terminal's size changed, in stream order. |
| `exit` | `term`, `code`, `signal`, `atNs`, `lost`. |
| `result` | `id`, `ok`, `lines` (what the command line would print, design 7.6), `error`. |
| `notify` | `sessionId`, `title`, `reason` (13). |
| `notice` | `kind` (`keepalive-lost`, `keepalive-back`, `gap`, `newer-keeper`, `restore-progress`), `text`. |
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

A page that reconnects (6.3) sends `hello` again and attaches the terminals it had attached; each
starts over with a fresh `snap`. There is no resume from a position: a snapshot is cheap enough
(7.3) and always right.

#### 8.2.6 Size

A terminal has one size, the pty's. Its **size owner** is the page that last sent `input` for it,
or, before any input, the first page that attached. Only the owner's `resize` changes the size:
the server sends `Z` to the keeper, and when the `R` record comes back it applies it to the screen
side and sends `size` to every attached page. A page sets its xterm.js size only from `snap` and
`size` — never from its own fitting — so page and screen side reflow at the same point of the
stream. A page that is not the owner shows the terminal at the owner's size (cut off or with a
margin) and a hint "sized by another window"; typing makes it the owner and its fitted size
applies.

#### 8.2.7 Several windows

Any number of pages may attach to one terminal; they share its ordered stream. Input from any of
them goes to the program in the order the server receives it. `list` goes to every page; each
page's `view` state is its own. Notifications go to one page only (13).

#### 8.2.8 Backpressure

The server never pauses a keeper for a slow page. When more than 1 MiB is queued on a page's
socket, the server stops forwarding output to that page and marks its attached terminals
**behind**; when the queue has drained below 64 KiB, it sends a fresh `snap` for each of them and
forwards again. A page attaches only to terminals it shows or has shown recently (12.6), so a
hidden terminal costs nothing.

### 8.3 Command line and server

The command line uses the same HTTP server with the secret in the header `X-Skydeck-Key` (it
reads it from the store, 10.2). A request that carries an `Origin` header must carry the exact
one; requests with a body must be `Content-Type: application/json`.

| Request | Answer |
|---|---|
| `GET /api/ping` | `{ serverId, bootId, build, protocol, pid }`. |
| `GET /api/status` | `{ pages, terminals: [{ id, slot, state, sessionId, pid }], keepAlive, python }`, for `skydeck window` and `doctor`. |
| `POST /api/open` | `{ sessionId, kind, cwd, argv }`: opens a terminal for a launch the command line has already prepared (and locked, design 7.6). `{ ok: true, terminal }` once the keeper has said `hello`; `{ ok: false, error, timedOut }` otherwise (11.3). |
| `POST /api/shutdown` | `{ ok: true }`, then 5.5. |

A request without the right key gets 401.

## 9. Typing into and reading from a terminal

### 9.1 Keys the page maps

xterm.js 6.0.0 turns key presses into bytes. The page changes these, in
`attachCustomKeyEventHandler`, and lets every other key through:

| Key | Sends | Why |
|---|---|---|
| Shift+Enter | `\n` | xterm.js 6.0.0 sends `\r` whatever Shift says; Claude Code inserts a newline on Ctrl+J (`\n`) in every terminal without setup (section 21). |
| Ctrl+V | nothing itself: the browser pastes, xterm.js sends the text as a bracketed paste | Pasting text, as in the developer's terminal. |
| Ctrl+Shift+V | `\x16` (a raw Ctrl+V) | Claude Code's own image paste: on WSL it reads the Windows clipboard itself (6.4), the browser's clipboard is not involved. |
| Ctrl+Shift+C | nothing: copies the selection to the clipboard | Copy. |
| the window's own chords (12.9) | nothing: the page acts on them | They are Ctrl+Shift chords that without the kitty keyboard protocol send the same byte as the plain Ctrl chord, so Claude Code could not tell them apart anyway (section 21). |

Keys are matched as section 12.9 says (letters by the character typed, digits and `/` by the
physical key). Alt+F4 is let through to Edge (12.9). AltGr and dead keys reach xterm.js
unchanged (section 21; check W8). No kitty
keyboard protocol and no `modifyOtherKeys`: xterm.js 6.0.0 has neither; 6.1 is re-evaluated when
released (20).

### 9.2 Focus and mouse

Focus reports (mode 1004) and mouse reports are what the page's xterm.js produces, sent as
`input`. They are the user's own events, not query answers (9.3).

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
write-only handler (`navigator.clipboard.writeText`), not `addon-clipboard`. A request to read
the clipboard (OSC 52 with `?`) is never answered (design 13: programs in a terminal can write to
the clipboard but not read it).

### 9.6 Links

Ctrl+click on a URL in a terminal (an OSC 8 link, or plain text that looks like `http://` or
`https://` followed by URL characters) and a click on a pull-request link in the list or header
send `act open-link` with the URL. The server opens it only when it parses as a URL with scheme
`http` or `https`, re-serialised by the WHATWG URL parser (so it cannot start with `-`), by running
`window.edge` with that URL as its only argument (no profile folder): it opens in the user's own
Edge profile, where they are logged in, not in the window's profile. The page itself never
navigates away. Whether it opens in the user's main Edge window is check W12.

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
pages; the next tick tries again. The server also checks the store's schema version every tick and
stops (5.5) with `bye "skydeck was updated; run skydeck window"` when the store is newer than it
knows (16.5).

Cost, from step 1's measurements: an idle refresh is about 16 ms at 3,000 recorded sessions and
about 60 ms when 3,000 transcripts are listed; at one every 2 seconds that is under 3% of one core.
A headless terminal with 5,000 lines of scrollback is about 15 MB (measured: 25 MB at 10,000
lines), so ten terminals cost about 200 MB.

### 10.2 In the store

**Migration 2** (lands with stage B, 19):

```sql
CREATE TABLE attention (
  session_id      TEXT PRIMARY KEY,
  turn_ended_ns   INTEGER,  -- the latest end of a turn the server saw (10.3)
  seen_ns         INTEGER,  -- the latest time the user saw the session in a window (12.4)
  window_end_ns   INTEGER   -- the latest time a window terminal holding it ended, the session
                            -- then being marked ended-unexpectedly (12.4)
);
```

These are skydeck's own observations, not the user's data (design principle 6); a row is written
the first time one of them is known and never removed. Writes are single statements.

`kv` entries (no migration; `kv` is free text):

| Key | Value |
|---|---|
| `window_secret` | The secret (15.2): 32 random bytes, base64url. Created on first need, inside one transaction, so two servers starting at once agree. |
| `window_restore_dismissed` | The boot id whose restore the user dismissed (12.7). |

### 10.3 When a turn ends

A turn ends when a holder's live-session file changes its `status` from `busy` or `waiting` to
`idle`, the file still naming the same session and the same process (pid and process start).
The server sees that at its one-second look and records `turn_ended_ns` = the file's
`statusUpdatedAt` (else the time it saw the change) for that session.

`busy` to `waiting` is not a turn end (a dialog opened inside the turn). A file that names another
session than at the last look (`/clear`) starts over. The first look after the server starts only
sets the baseline: a turn that ended while no server was running is not recorded (a known limit;
12.4).

**Decided against: a `Stop` hook** (design 16 had planned turn hooks for step 2). The hook
writes its input unchanged into the spool (design 5.1: the hook interprets nothing), and the input
of `Stop` carries `last_assistant_message`, the assistant's final text (documentation, section
21). Recording it would put conversation content into the spool and into `events.payload`, against
principle 4. The live-session file already says when a turn ends, for every session, including
those running outside the window; it needs no new settings entry. So:

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

Two changes to step 1's code make that possible, with no change of behaviour for the commands:

- **Starting a prepared launch** (`launchPrepared`, today in `src/cli/launching.ts`) moves to
  `src/sessions/launch.ts` and takes the `Terminal` to open with as a parameter. The command line
  keeps choosing the terminal (`--here`, `--tab`, configuration) and printing the lines; the server
  passes the window terminal (11.2) and shows the lines (12.6). The flag warnings, the printable
  fallback command, and `settleFailedLaunch` (which releases the lock, and for `new` removes the
  label and group, only after a definite failure with nothing printable) are the same code.
- **`prepareNew`** takes the directory as a parameter instead of reading the current directory.
  The command passes `platform.cwd`; the window passes the directory chosen in the form (12.6),
  refused unless it is absolute and an existing directory.

### 11.2 The window terminal

`Terminal` (design 7.6 "Where", `src/terminals/`) gets a third adapter, `window`, with
`opensTabs: true`. Its `open({ cwd, argv })`:

- inside the server: spawns a keeper (7.1) with the launch, the session id and kind, and the next
  free slot, connects, and resolves `{ ok: true }` on `hello`. A keeper that cannot be started
  (python3 missing, a socket path too long, a spawn error) is `{ ok: false, timedOut: false }`
  with the reason; no `hello` within 5 seconds is `{ ok: false, timedOut: true }` (the program may
  start yet, design 7.6);
- in a command: makes sure the server runs (5.2), sends `POST /api/open` (10-second timeout:
  `timedOut: true`), and when no page is connected starts Edge as `skydeck window` does (5.3). A
  server that cannot be started is a definite failure.

So a failure behaves as a failed tab does in step 1: the command prints the command line to run
by hand and exits 1, the window shows the same lines on the resume card (12.6); after a timeout no
command is offered.

### 11.3 In the window

- **Resume.** Enter on a selected session that is not running, a double click, "Resume here" on
  the resume card, or Enter in the switcher: `act resume` → `prepareResumeById` → `launchPrepared`
  with the window terminal. The new terminal gets the next free slot and is selected, with focus in
  the terminal. The answer's `lines` (flag warnings; on a refusal the guard's message, such as
  `<short> is running (pid <n>)` or `is being resumed (<n> s ago); try again in <m> s`) are shown
  on the card.
- **New.** The form (12.6) → `act new` → `prepareNew` with the chosen directory → `launchPrepared`.
- **Restore.** The banner (12.7) → `planRestore` (design 7.8's set and preselection, on rows
  refreshed just before) → `runRestore` with the window terminal: batches of `restoreBatch`, the
  memory check, the wait for start events with lock renewal, exactly as from the command line. Its
  report lines go to the banner. One restore runs at a time.

### 11.4 `skydeck resume` (and `new`, `restore`) in a terminal while the window runs

- Without options they behave as in step 1: the configured `terminal` decides, `here` by default.
  A session resumed in a WSL terminal runs there; within two seconds the window lists it as
  "running in another terminal" (7.9). The guard sees every holder wherever it runs, so a session
  open in the window is refused as `running (pid <n>)` like any other running session; `show` adds
  `(in the skydeck window)` to a holder whose parent is a keeper.
- `--window` (new for `resume` and `new`; `restore` follows the configuration) opens it in the
  window through 11.2, starting the server and a window when needed. `--here`, `--tab` and
  `--window` exclude each other.
- Configuration `"terminal": "window"` makes the window the default for `resume`, `new`, `restore`
  and `R` in the interactive list; `--tab` then also means the window, the adapter that opens tabs.
  `restore` from the command line then opens its sessions in the window, waiting for their start
  events itself as in design 7.8.

## 12. What the window shows

This section is the design of the step 2 UI research (the mockup kept with the research notes)
and its nine picks (12.11). The user looked at the mockup on 2026-11-13 and approved it ("the list
looks ok", "overall I like it"; an Edge app window that runs like the mockup is "completely ok"),
so these are decisions; the pull-request chip's rule for several open pull requests (12.3) is the
user's ruling of the same day. Every rule that orders, groups, filters or judges attention is a
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
  in words), the pull-request chip (12.3), `✎` when it has a note, and its age.
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
   `ended-unexpectedly` at the next refresh: `window_end_ns` is set (10.2). It ends when seen.
3. **finished**: `turn_ended_ns` is later than `seen_ns`, and the session is running and idle. It
   ends when seen or when the next turn starts.

A session is **seen** when it has been the selected one for 1.5 seconds while its window had
focus, or when the user typed into its terminal; the server then sets `seen_ns` (at most one write
per session per 5 seconds). A turn that ended while no server ran is not recorded (10.3), so it
shows no "finished".

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
- **A session running in another terminal**: the card of 7.9.
- **A session not running**: the **resume card**: how it ended (exited normally, ended
  unexpectedly, mid-turn), last activity, the directory, the exact command (design 7.6's), the flags
  that will not be passed on, a warning when the transcript is expiring; for an expired session the
  button is disabled. A single click on a row selects it and shows this card; it does not resume
  (a resume costs a process, and history is easy to misclick). Enter, a double click or "Resume
  here" resumes (11.3). Refusals and launch failures show their lines on the card.
- **An ended terminal**: its last screen, dimmed, under the bar of 7.8 (Resume, Close).
- **New** (Ctrl+Shift+N or `+ New`): a form with the directory (a list of the known project
  directories, most recent first, defaulting to the selected session's, or a typed absolute path),
  the label, the group and extra flags. A label that starts with a ticket key gives the group
  through `groupPattern` (design 7.1) unless a group is typed. Flags are words separated by spaces;
  `'…'` and `"…"` group words (no escapes, no variables); design 7.7's refusals apply. It starts in
  the window (11.3).

### 12.7 The restore banner

At the top of the list while design 7.8's default set is not empty and the user has not dismissed
it for that boot: "WSL stopped yesterday at 18:02 with 3 sessions open", a checkbox per session
preselected by design 7.8's rule, "Restore 3" and "Not now". Restore runs as in 11.3; the sessions
show under Open as `starting…` and the banner reports each line of the run (started, timed out,
failed, stopped for memory). "Not now" stores the boot id (10.2): the banner does not come back for
that boot, and the switcher still offers "Restore 3 sessions from <time>" until the next WSL
restart.

### 12.8 Search

- `/` filters the list: title, group, note, pull-request repository and number, directory, short
  id; several words must all match; while a filter is set it includes done sessions and unfolds
  every section and stack. (Stage A has design 7.4's filter: one text, the fields of 7.4.)
- Chips: Running, Open PR, Has note, Show done.
- Ctrl+Shift+P opens the quick switcher over all sessions, ranked: needs you, open (by slot), not
  running (most recent first), done. Enter switches to a running one and resumes one that is not
  running (11.3).

### 12.9 Keys and focus

No leader key: an app window reserves no keys (section 21; on the user's PC every chord tested
reached the page, Alt+Space excepted). The window takes only Ctrl+Shift chords with a letter, a
digit or `/`, and Ctrl+Tab; never Alt, a bare Ctrl+letter, a function key or Esc, which belong to
Claude Code and the shell. Ctrl+Shift+- stays with Claude Code (undo).

**What the page cancels.** Because the page gets every key first, it decides what Edge does: a key
whose default the page cancels (`preventDefault`) does nothing in Edge, even Alt+F4 (tested: the
window stayed open). So the page cancels exactly the keys it handles itself (this table, the list
keys below) and the keys it passes to the terminal (xterm.js cancels those it sends), and no
other. Alt+F4 is never passed to the terminal and never cancelled, in either focus zone, so the
window closes with it as any window does. Alt+Space never reaches the page (Windows keeps it for
the window menu). A key that neither zone uses keeps Edge's default: in the list zone Ctrl+W closes
the window and F5 reloads the page, both harmless — closing the window ends no session, and a
reload reconnects (8.2.5).

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
| Ctrl+Shift+/ | the key help |
| Ctrl+V, Shift+Enter, Ctrl+click | paste text, newline, open a link (9) |

Letters are matched by the character the key types (Claude Code's own rule); digits and `/` by the
physical key (`event.code`), because a Czech layout types ě š č ř ž ý á í é on the unshifted digit
row. If the user turns on the kitty keyboard protocol in a later xterm.js and binds a
`ctrl+shift+<x>` in Claude Code, the window shadows that binding; the help says so.

Two focus zones; the terminal is the default. Clicking a running row focuses its terminal;
clicking a row that is not running focuses the list (so Enter resumes). Ctrl+Shift+L toggles; Esc
never leaves the terminal. In the list, step 1's keys: ↑ ↓ `j` `k`, Home, End, PgUp, PgDn, Enter,
← → (fold, unfold), `/` filter, F2 or `l` label, `g` group, `n` note, `p` attach a pull request,
`d` done, `a` show done, Esc (clear the filter, then back to the terminal). The focused zone has a
coloured top edge, and the key bar says `Focus: list` or `Focus: terminal`.

### 12.10 Done

A session marked done disappears as in design 7.1, except that a running session marked done
stays under Open with a `done` mark until it stops (then it is hidden). Marking done shows an Undo
toast.

### 12.11 The nine picks, approved by the user on 2026-11-13

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
| **python3 is missing** (or older than 3.9) | The server runs and the list works; opening a terminal fails at once with `python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)` on the resume card, and `doctor` reports a problem. The commands are unaffected. |
| **The port is taken** | By a skydeck server of this installation: it is used (5.2). By anything else: `skydeck window` and `serve` exit 1 naming the port and `window.port`. A program that holds the same port on the **Windows** side is not visible from WSL: then the window shows that program's answer or an error; check W3 and 15.3. |
| **Edge is missing** | 5.3: a message naming `window.edge` and `--print-url`; exit 1; the server keeps running. |
| **`skydeck window` is run twice** | The second run finds the server and, when a page is connected, starts no second window (5.1). Two at the same moment start one server (5.2). |
| **The PC sleeps** | 6.5. |
| **WSL stops** | Every process in WSL ends, so every session in the window ends (marked `ended-unexpectedly`). The window stays and shows 6.3's bar; after `skydeck window` it shows the new boot and the restore banner (12.7). |
| **The keep-alive cannot start or dies** | The server retries (6.1), pages show `WSL is not kept running`, and `doctor` reports it. The window keeps working while any WSL terminal is open. |
| **A page falls behind** | 8.2.8: it gets a fresh snapshot instead of the bytes it missed. |
| **A program writes very fast** | The keeper keeps reading; the server parses about 10 MB/s; pages that cannot keep up get snapshots (8.2.8). The program is never paused by skydeck. |
| **The store is locked or broken** | As for every command (design 5.3): the tick fails, is logged and shown once, and is retried; terminals and their streams do not depend on the store. |
| **skydeck is updated** | 16.5. |
| **The secret is wrong** (after `--new-secret`, or a stale bookmark) | The page says that its key is not valid any more and to run `skydeck window` (8.2.2). |

## 15. Security

### 15.1 Threats

The server listens on `127.0.0.1` only, but loopback is reachable by every process on the PC, in
Windows and in WSL, of every user, and by every web page in every browser on the PC (a page can
make requests to `127.0.0.1`). The terminals it serves can run any command as the user. So:

- **Other pages in the user's browsers.**
  - Cross-site requests: every API request needs the secret in the header `X-Skydeck-Key`. A
    cross-origin request with a custom header needs a preflight, which the server refuses (8.2.1),
    and no answer carries a CORS header, so no other page can read one. A cross-site WebSocket is
    refused by the exact `Origin` check at the upgrade, and the secret is required as the first
    message anyway.
  - DNS rebinding (a page whose own host name is made to point at `127.0.0.1`): its requests carry
    its own host name in `Host`, which is refused (421); only `Host: 127.0.0.1:<port>` is served.
  - Framing (clickjacking): `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Other local processes.** Everything but the static files needs the secret, compared in
  constant time. Processes of other users cannot read it: it is in the store (mode 600) and in the
  Edge profile folder (the user's own Windows profile). Keeper sockets are in a directory of mode
  700, are mode 600, and keepers accept only a peer with their own user id (7.1). A process that
  runs as the user can read the secret — and can equally run `claude` itself, read the transcripts
  or reach the WSL files from Windows (`\\wsl.localhost\…`); defending against the user's own
  processes is not a goal.
- **Browser extensions.** An extension that may read `127.0.0.1` pages could read the terminals and
  the secret. The window runs in its own profile folder, so the user's extensions are not there.
  Extensions that company policy forces into every profile still are: check W13 lists them
  (`edge://extensions` in the window's profile, `edge://policy`).

### 15.2 The secret

32 random bytes, base64url, kept in `kv` (10.2); created on first need and kept across server
restarts, so a window can reconnect to a restarted server and to the server of a new boot without
being reopened. It reaches the page only in the URL fragment (`#k=…`), which browsers never send
to a server; the page keeps the fragment in its URL, so a reload still has it. It is therefore in
the window's history in the Edge profile folder, and in Edge's command line while `msedge.exe`
starts (readable by the user's own processes only). `skydeck window --new-secret` replaces it
(5.1). The server never logs it; `skydeck window` prints it only with `--print-url`.

### 15.3 Accepted risk: the port on the Windows side

Edge reaches the server through WSL's localhost forwarding. If another Windows program listens on
`127.0.0.1:<port>` first, Edge reaches that program instead, and a page it serves reads the secret
from the fragment. With the secret alone it cannot reach the real server: the forwarding to WSL is
what it took away. The user sees a broken window. Accepted: any Windows program that can do this
runs on the user's PC and, as the user, could read the secret directly (15.1).

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
(skydeck window) needs python3 3.9 or newer; the commands do not`.

### 16.2 Uninstall

Before what it does in step 1:

- when a server runs, it asks it to stop (5.5) and says `stopped skydeck's window server; <n>
  terminals in the window keep running`. Keepers and their sessions are never stopped (2).
- it names the Edge profile folder when one is configured or can be derived: `the window's Edge
  profile is in <folder>; Edge wrote it and skydeck leaves it (delete it yourself)`.

`--purge` refuses (exit 1) while any keeper answers, naming the open terminals: purging
`<stateDir>` can remove the keeper sockets of the `<stateDir>/run` fallback, and the screens of
those sessions could not be shown again. The user ends those sessions first. Otherwise it also
removes `<runtimeDir>`.

### 16.3 Doctor

New lines, with `ok`, `info` or `problem` as in design 8. It still starts no program but those it
already runs (`gh`, `wezterm`) and `python3 --version`; it starts nothing on Windows.

| Check | `problem` when |
|---|---|
| python3 | `python3` is not found or is older than 3.9 (`info` instead when the window has never been used: no `window_secret`). |
| server | never: `info` says whether a server runs, its pid, build, uptime, pages and terminals; `problem` only when it runs with another build than the checkout (`run skydeck window --restart`). |
| port | something that is not this installation's server answers on `127.0.0.1:<window.port>`. |
| keep-alive | a server or a keeper runs and neither protection is in effect. The line names the one in effect: `.wslconfig has instanceIdleTimeout=-1 (WSL does not stop by itself)`, or `keep-alive wsl.exe running (pid <n>, since <time>); that it keeps WSL running is unverified (manual check W14)`. `.wslconfig` is read from the Windows profile folder found as in 5.4. |
| interop | `WSL_INTEROP` is not set or `<runtimeDir>/interop` points at nothing that answers. |
| Edge | `window.edge` does not exist (`info` when the window has never been used). |
| profile folder | it cannot be derived (5.4) and `window.profileDir` is not set. |
| runtime directory | it is not mode 700 or not the user's, or a socket path would be 108 bytes or longer. |
| vendored files | a file of `vendor/MANIFEST.json` is missing or its hash differs (a broken checkout). |
| keepers | never: `info` counts them, with their keeper versions; a socket that refuses connections is `info` (removed at the next server start). |

### 16.4 Configuration

New keys, all optional:

| Key | Default | What it does |
|---|---|---|
| `terminal` | `"here"` | Gains the value `"window"` (11.4). |
| `window.port` | `47613` | The server's port on `127.0.0.1` (5.2). A positive integer below 65536. |
| `window.edge` | `"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"` | The Edge program (5.3, 9.6). An absolute path. |
| `window.profileDir` | `null` | The Windows folder of the window's Edge profile (5.4). `null`: derived. An absolute Windows path (`<letter>:\…`). |
| `window.keepAlive` | `"wsl"` | `"wsl"` or `"off"` (6.1). |

Unknown keys inside `window` are an error, as everywhere in `config.json`.

### 16.5 Updating skydeck while terminals are open

`git pull` changes the checkout. Then:

- **Commands** run the new code at once, and the store migrates at the next command (design 9.2).
- **The server** keeps running the old code. Its **build** is a hash (sha256, first 16 hex
  characters) over the paths and contents of every file under `bin/`, `src/`, `web/` and
  `vendor/`, computed when it starts; `skydeck window` computes the same for the checkout and
  restarts a server whose build differs (5.1). A server that finds the store newer than it knows
  stops by itself (10.1). Sessions keep running across the restart, every screen is rebuilt (7.3),
  and pages reload themselves for the new assets (8.2.2).
- **Keepers** keep running the code they started with (7.7). The server speaks their protocol.
- **Vendored xterm.js** changes for page and screen side together, at the server restart: the new
  screen side rebuilds each terminal from a snapshot written as escape sequences, which any version
  reads.

### 16.6 Vendored files

`vendor/xterm/` holds, at exact versions, each with its `LICENSE`: `@xterm/xterm` 6.0.0 (with its
CSS), `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0, `@xterm/addon-fit` 0.11.0,
`@xterm/addon-search` (the release made for xterm.js 6.0.0), `@xterm/addon-unicode-graphemes`
0.4.0, and their type declarations for `tsc`. `vendor/MANIFEST.json` lists every file with its
package, version and sha256. The same packages at the same versions are development dependencies;
`npm run vendor` copies them into `vendor/` and writes the manifest, and a test fails when
`vendor/` and the installed packages differ, so they are updated only together. `addon-webgl` is
not vendored in the first version: the DOM renderer is enough for Claude Code's output, and WebGL
in a managed Edge is one more unknown.

## 17. Testing

Design 12's rules hold: tests are written before the code they test, never start the real
`claude`, never read or write the real `~/.claude`, never use the network, run under a temporary
`SKYDECK_HOME` and `claudeHome`. Added: tests never start a Windows program, and a server under
test listens on a port the system picks (`window.port` 0 in tests only).

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

- the program starts only after the first connection;
- output, input, resize as records in order; `R` echoed;
- park, the tail trimmed to the snapshot, reconnect giving snapshot plus exactly the tail;
- a new connection replacing the old one; a peer with another user id refused (where the test can
  arrange it);
- a frame it cannot parse closes the connection and the keeper lives on;
- the tail cap and `gap`; the send queue cap;
- exit status after a normal exit, a signal, and `exec` failing (127); `A` ending the keeper; the
  10-minute linger (shortened through an environment variable that only tests set);
- killing the keeper ends the program (SIGHUP), and the stand-in reports `SessionEnd` `other`.

### 17.3 The server

With real sockets on `127.0.0.1` and real keepers running the stand-in:

- the WebSocket: the frame tests of the prototype (0 bytes to 1 MiB, fragments, ping and pong,
  close codes, invalid UTF-8, unmasked frames), with `ws` as a development dependency for the client;
- authentication: wrong or missing secret, wrong `Origin`, wrong `Host`, `OPTIONS`, an API request
  without the header, CORS headers never present;
- protocol: `hello` and `welcome`, the 5-second limit, the protocol and asset version decisions;
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
layout (as `KeyboardEvent`-like objects).

**A headless browser as a development dependency: for.** What breaks in a page — xterm.js
integration, that the page's terminal answers no query, the Shift+Enter and Ctrl+Shift+V mapping
reaching the server as bytes, the CSP not blocking the page's own files, reconnecting after the
server restarts, notifications asked only on a gesture — is only real in a browser, and the UI
research already drove its mockup in headless Chromium. The cost is a development dependency and
a browser download in CI, never at install time. So `playwright` (pinned exactly) drives Chromium
headless against a real server and keepers running the stand-in, in a small suite
(`npm run test:page`). Chromium is not Edge: what only Edge decides (keys an app window keeps, its
policy, notifications on the PC) stays a manual check.

### 17.5 What CI runs

On every pull request, for both Node versions of the matrix: format check, type check (including
`web/` through JSDoc and the vendored type declarations), all `node:test` tests (keeper and server
tests included; Ubuntu runners have python3), `npm run test:page` (with `npx playwright install
chromium` first), `python3 -m py_compile bin/skydeck-keeper`, the vendored-files check (16.6), and
`shellcheck` on the shell scripts by name — `bin/skydeck`, `bin/skydeck-hook`,
`bin/skydeck-keepalive` — because today's `shellcheck bin/skydeck*` would also match the python
keeper.

## 18. Manual checks for step 2

What only the real Claude Code or the Windows desktop can settle: the lists of the three research
tracks (terminals, window, UI), merged. Each check names the stage that needs it (19) and the
sections it can change. They join [manual-checks.md](manual-checks.md) when their stage is built;
the research's check kit (an Edge key-test page, a lifetime script for a throwaway distribution) is
kept with the research notes. Items marked **real claude** use a real session in a throwaway
folder, as in manual-checks.md.

| # | Check | Stage | Decides |
|---|---|---|---|
| W1 | `skydeck window` opens an Edge app window that loads the page and connects. (That Edge reaches a server on `127.0.0.1` in WSL was verified by the user on 2026-11-13; this checks the command itself: the profile folder, the start, the wait for the page.) | A | 5 |
| W2 | The chords of 12.9 that the key test of 2026-11-13 did not press reach the page and the browser does nothing: Ctrl+Shift+P, J, L, F, C, 1–9 and `/`; and Alt+F4 still closes the window once the page is built (12.9). In a normal tab (`--print-url`), which chords the browser keeps. | A | 12.9 |
| W3 | The window has its own taskbar button with skydeck's icon (12.12), and the title `(n) skydeck`; a second `skydeck window` opens no second window. | A, B, E | 5.1, 12.1, 12.12 |
| W4 | **Real claude** in a window terminal: status line, subagent display, spinner, redraw on resize. Then `skydeck window --restart`: the screen is exactly what it was. | A | 7.2, 7.3 |
| W5 | **Real claude**, the screen side answering alone: does Claude Code use synchronized output; does the OSC 11 answer make its automatic theme right; with an XTVERSION answer `xterm.js(6.0.0)` (a one-line change), any visible effect? | A | 9.3 |
| W6 | **Real claude**: Shift+Enter inserts a newline; Ctrl+V pastes text; Ctrl+Shift+V pastes a Windows screenshot; Ctrl+Shift+C copies a selection, and a program's OSC 52 write reaches the Windows clipboard. | A | 9.1, 9.5 |
| W7 | W6's Ctrl+Shift+V again after closing the WSL terminal `skydeck window` was run from (the interop link of 6.4). | A | 6.4 |
| W8 | Czech layout in Edge: AltGr characters (`\ [ ] { } @ # ~ \|`) and dead keys (háček, čárka) in a terminal; Ctrl+Shift+digit and Ctrl+Shift+/ chords. | A | 9.1, 12.9 |
| W9 | Cascadia and Segoe draw Claude Code's `⏺ ⎿ ⏵` (headless Linux showed empty boxes). | A | the page's font list |
| W10 | **Real claude**: rows with emoji, ZWJ and skin-tone sequences line up; `unicode-graphemes` against `unicode11`, compared with Claude Code's own layout. | A | 9.4 |
| W11 | Desktop notifications are allowed on the managed PC: the permission prompt, a toast, a click that selects the session. | B | 13 |
| W12 | Ctrl+click on a link opens it in the user's main Edge window, logged in. | A | 9.6 |
| W13 | `edge://policy` (any `URLBlocklist`, `BrowserSignin`, `WebApp*`, `Extension*` entry) and `edge://extensions` in the window's profile: which extensions are forced in. | A | 15.1 |
| W14 | WSL lifetime: the lifetime script against a throwaway distribution measures the idle rule; then, with the window open and every WSL terminal closed, WSL is still running after a minute (`wsl -l -v` in PowerShell). Without the keep-alive (`"off"`) it stops. | A | 6.1 |
| W15 | Sleep: with the window open, lock or sleep the PC for a few minutes. The page recovers by itself, keys work, the terminal repaints, sessions still run. | A | 6.5 |
| W16 | WSL stop drill: `wsl --shutdown` with the window open and three sessions in it. The bar of 6.3 appears; after `skydeck window` the window says WSL restarted and the banner offers the three; "Restore 3" brings them back into the window. | C | 6.3, 12.7 |
| W17 | **Real claude**, `/tui fullscreen`: the alternate screen and the mouse mode come back after `skydeck window --restart`. | A | 7.2 |
| W18 | **Real claude**: a terminal query answered late (the server stopped for a few seconds while Claude Code starts) — does the answer leak into the prompt? | A | 7.1, 14 |
| W19 | **Real claude**: does `waitingFor` tell a permission prompt from a question? | B | 12.4 |
| W20 | Privilege management does not block or prompt for `msedge.exe` and `wsl.exe` started through interop. | A | 2, 5.3, 6.1 |
| W21 | **Real claude**: a turn that ends in a session that is not selected shows "finished · not seen"; selecting it for 1.5 s clears it; a permission dialog shows "asks". | B | 10.3, 12.4 |
| W22 | **Real claude**: a session started in a WSL terminal shows "running in another terminal", Resume is refused with the guard's message, and after `/exit` it resumes into the window. | A | 7.9 |

Checked by tests rather than by hand: that xterm.js sends a Ctrl+Shift+letter as the plain Ctrl
byte (17.4), and that the page's terminal answers no query (17.4).

## 19. Staged delivery

Each stage is a set of pull requests (design 15) and is usable on its own: after stage A the window
is a working tool, and B to E each add to A without depending on one another.

**Stage A — the window.** The smallest slice that removes the user's pain: one place to see the
sessions and to switch between their real terminals.

- `skydeck window` with `--print-url`, `--new-window`, `--restart`, `--stop`, `--new-secret`;
  `skydeck serve`; Edge and the profile folder; the keep-alive and the interop link; the server-gone
  bar and reconnect (5, 6).
- The keeper, the screen side, the protocols, authentication (7, 8, 15).
- The list with its three sections and rows (12.1, 12.2; design 7.3's chip; no stacks), the
  read-only header (title, group, state, directory, short id, chip), the counts.
- Terminals in the window: attach and switch by click, Ctrl+Shift+1–9, Ctrl+Tab and Ctrl+Shift+O,
  Ctrl+Shift+L; the keys of 9.1, find (9.7), links (9.6), the clipboard (9.5); the ended bar; the
  card for sessions running in another terminal.
- Resume into the window (resume card, Enter, double click) and New (12.6), through the shared code
  of 11.1.
- Design 7.4's filter (`/`).
- Configuration, `doctor`, `install` and `uninstall` changes (16), vendored files, CI (17.5).
- Manual checks W1–W10, W12–W15, W17, W18, W20, W22.

**Stage B — attention and notifications.** Migration 2 (10.2), turn ends (10.3), seen, the three
reasons and their marks (12.4), Ctrl+Shift+J, the title bar counts and `(n) skydeck`, desktop
notifications (13). Checks W11, W19, W21.

**Stage C — restore in the window.** The restore banner (12.7); the `window` terminal for commands
(`--window`, `"terminal": "window"`, `POST /api/open`, 11.2, 11.4); `show`'s `(in the skydeck
window)`. Check W16.

**Stage D — header editing and pull-request detail.** Label, group, note, done and undone, `+ PR`
and removing one, in the window (12.5) with the Undo toast; the window's chip (12.3) and the
pull-request lines of the header; the list keys `l`, `g`, `n`, `p`, `d`, `a`.

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
| An app window's taskbar identity is made of the app name from the URL (host and port) and the profile path. | verified in Chromium's source |
| `msedge.exe` started while an Edge on the same profile folder runs hands off and exits at once. | verified in Chromium's source |
| Started through interop with stdio ignored and a Windows working directory, a Windows program shows no console window. | verified in WSL's source |
| A WSL distribution stops `instanceIdleTimeout` (default 15 s) after its last Windows client exits; Linux background processes and systemd do not count; the VM stops `vmIdleTimeout` (default 60 s) after the last distribution. `.wslconfig` `[general] instanceIdleTimeout=-1` keeps it. | verified in WSL's source; not measured (W14) |
| A `wsl.exe` started from inside WSL through interop counts as such a client. | UNVERIFIED (W14) |
| In WSL's NAT mode a port bound to `127.0.0.1` inside WSL is reachable from Windows. From the Edge app window on the user's PC, `http://127.0.0.1:<port>` in WSL answered 132 pings of 132, in about 7 ms. | documentation; verified by the user on their PC, 2026-11-13 |
| An Edge window started through interop survives a WSL stop. | inferred (W16) |
| WSL can hang after hibernation (issue #8696); new `wsl.exe` sessions can time out on WSL 3.0.3 (#42006). | documentation (WSL issues) |
| On the development PC: BeyondTrust privilege management is installed (policy unreadable); the Edge WebView2 runtime is installed; WSL 3.0.5 with systemd, no `.wslconfig`, NAT networking, interop on; python3 3.12. Whether unsigned programs run from user folders is unknown. | verified (read-only look under `/mnt/c`) |
| Sessions started in another terminal cannot be shown: their pty master belongs to that terminal; `reptyr` needs ptrace (`ptrace_scope` is 1); reading `/dev/pts/N` steals input. | verified |

