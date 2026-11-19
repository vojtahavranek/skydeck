# skydeck

skydeck is one developer's tool for working with many Claude Code sessions at once. It lists the
sessions that matter, says what each one is doing, carries a label, a group, a note and its pull
requests, and brings a session back with one action, also after a PC restart or a WSL shutdown.

It is a command line tool for the terminal (step 1) and, since step 2, a window: `skydeck window`
opens an Edge app window with the session list on the left and the real terminal of the selected
session on the right, where sessions are resumed, started and switched between. A session's label,
group, note and done mark are edited there too, its pull requests attached and detached, and with
`ticketUrl` in `config.json` its group chip opens the session's ticket. A session that needs you
(it asks, its turn finished while you were not looking, or its terminal ended unexpectedly) is
marked in the list and counted in the title bar and on the taskbar, Ctrl+Shift+J goes to the next
one, and a desktop notification says so while no skydeck window has the focus. After a WSL or PC
restart the window offers to restore the sessions that were open, into the window, and `skydeck
resume --window`, `skydeck new --window` (or `"terminal": "window"` in `config.json`) start
sessions there from any terminal. The list's filter finds a session by several words or the first
characters of its short id, chips narrow the list to the running sessions, those with an open pull
request or those with a note, the sessions of one group sit together as a block in every section (open until you close it), and Ctrl+Shift+P
opens a quick switcher over every session. The window's sessions run in terminals of skydeck's own
inside WSL, so they keep running when the window or its server is closed or restarted
([docs/install.md](docs/install.md), "The window (step 2)"; design in
[docs/design-step-2.md](docs/design-step-2.md)).

```
ABC-123
  working     ABC-123 add retries    4m  4f9d7a5c

no group
  not-running 2026-11-12 08:45 web   15m  ended-unexpectedly,was-working,continued  2d7b5e3a
  not-running Fix retry loop   25m  ended-unexpectedly,was-working  1pr:unfetched  0b5f3c1e
  not-running quick check    9m  3e8c6f4b
```

## Install

Needs Linux or WSL2, Node.js 24.12 or newer, Claude Code, and `gh` logged in. The repository is
private: cloning needs `gh auth login` (or an SSH key).

```sh
gh repo clone vojtahavranek/skydeck ~/skydeck
cd ~/skydeck
bin/skydeck install
```

If the default `node` is older than 24.12, put `SKYDECK_NODE=/path/to/node` in front of
`bin/skydeck install`. The window also needs python3 3.9 or newer inside WSL and Microsoft Edge on
the Windows side; then `skydeck window`. [docs/install.md](docs/install.md) is the complete guide: prerequisites, what
install changes, `config.json`, WezTerm on WSL, updating, uninstalling.

## Is it tied to WezTerm?

No. Recording sessions, the list, labels, groups, notes, done and pull requests work in any
terminal, and so do `resume`, `new` and `restore`: by default they start `claude` in the terminal
you are in. WezTerm adds one thing, new tabs (`--tab`, or `"terminal": "wezterm"` in `config.json`),
and `restore` uses them to bring several sessions back at once. Without WezTerm, `--tab` prints the
command to run by hand, and `restore` resumes the first session in this terminal and prints a
`skydeck resume <id> --here` line for each of the others. Details are at the top of [docs/install.md](docs/install.md).

## Commands

| Command                                                                                           | Effect                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skydeck`                                                                                         | The interactive list on a terminal; otherwise the same as `skydeck ls`.                                                                                                                                                                                              |
| `skydeck ls [--all] [--json] [--refresh]`                                                         | Print the list. `--all` includes sessions marked done; `--json` prints stable, versioned JSON; `--refresh` first reads the status of the pull requests that are not merged or closed (`gh`).                                                                         |
| `skydeck show <ref> [--json] [--refresh]`                                                         | One session: state, marks, ticket, project directory, launch command, links, note, pull requests, holders.                                                                                                                                                           |
| `skydeck label <ref> [<text>]` / `skydeck group <ref> [<text>]`                                   | Set. Without text, clear. The text is all the arguments after `<ref>`, joined by one space.                                                                                                                                                                          |
| `skydeck note <ref> [--set <text>]`                                                               | Edit in `$VISUAL`, else `$EDITOR`, else `vi`; or set directly (`--set ''` clears).                                                                                                                                                                                   |
| `skydeck ticket set <ref> <link-or-key>` / `skydeck ticket clear <ref>`                           | Set the session's one ticket from a whole `http`/`https` link, or a key like `ABC-123` that `ticketUrl` turns into its link (the address is stored); remove it.                                                                                                      |
| `skydeck done <ref>` / `skydeck undone <ref>`                                                     | Hide / show. Never stops a process.                                                                                                                                                                                                                                  |
| `skydeck pr add <ref> <url>` / `skydeck pr rm <ref> <url>` / `skydeck pr refresh`                 | Attach and read the status now / detach / read the status of every pull request that is not merged or closed.                                                                                                                                                        |
| `skydeck new [--label <text>] [--group <text>] [--here \| --tab \| --window] [-- <claude flags>]` | Start a new session in the current directory, with a label and a group from the start; `--window` starts it in the skydeck window (its server must run).                                                                                                             |
| `skydeck resume <ref> [--here \| --tab \| --window]`                                              | Resume a session that is not running, in its own directory and with the flags it was started with; `--window` resumes it in the skydeck window (its server must run).                                                                                                |
| `skydeck restore [--all] [--dry-run] [--yes]`                                                     | Bring back what was open before the last restart.                                                                                                                                                                                                                    |
| `skydeck install` / `skydeck uninstall [--purge]` / `skydeck doctor`                              | Set up, undo and check the installation.                                                                                                                                                                                                                             |
| `skydeck window [--print-url] [--new-window] [--restart] [--stop] [--new-secret]`                 | Open the window: start its server when none runs, and an Edge window when none is open. `--print-url` prints an address for any browser instead; `--restart` and `--stop` restart or stop the server (sessions keep running); `--new-secret` replaces skydeck's key. |
| `skydeck update [--check]`                                                                        | Bring this checkout up to date (`git fetch`, then a fast-forward of its branch) and restart the window's server for the new code: the window stays open and reloads itself, sessions keep running. `--check` only lists the new commits.                             |
| `skydeck serve [--foreground]`                                                                    | The window's server, started by `skydeck window`; `--foreground` runs it in the terminal, logging to stderr, for debugging.                                                                                                                                          |

`skydeck --help` lists the commands, `skydeck <command> --help` shows the options of one, and
`skydeck --version` prints the version.

`<ref>` is a full session id, a unique id prefix of at least 4 characters, or a label equal to the
text. More than one match is an error that lists the candidates; no match is an error too (both
exit 3).

Exit codes: 0 success; 1 failure, or `doctor` found a problem; 2 usage error; 3 reference not found
or ambiguous; 4 resume refused; 5 restore stopped before finishing. Also: 141 when a write to
standard output failed because its reader had closed it (`skydeck doctor | head -1`) and the command
had succeeded; 127 when the launcher finds no `node`; and once `resume`, `new` or `restore` has handed the terminal to `claude`, the status
is `claude`'s own.

In the interactive list: `j`/`k` or the arrows move, `Enter` shows the detail, `l` label, `g` group,
`n` note, `d` done or undo, `p` pull requests, `R` resume, `/` filter, `a` show all, `r` refresh,
`q` quit. The list refreshes itself every 5 seconds without reordering the rows (the cursor
moves only when its own session leaves the list, and the last line says so); the title line counts the sessions per state; `r` refreshes at once, reorders, and reads the
pull requests again.

## Documents

- [docs/install.md](docs/install.md): setting skydeck up on another machine.
- [docs/design.md](docs/design.md): the design, the source of truth for the behaviour.
- [docs/design-step-2.md](docs/design-step-2.md): the design of step 2, the window.
- [docs/manual-checks.md](docs/manual-checks.md): the checks that need a real Claude Code session
  or the Windows desktop, run by hand; [docs/check-kit/](docs/check-kit/) holds what some of them
  use.

## Development

Needs Node.js 24.12 or newer. TypeScript runs directly through Node's type stripping, so there is
no build step.

```sh
npm ci
npm run check      # format check, type check, the tests, then the page tests
npm test           # the tests only
npm run test:page  # the page tests only (web/, in headless Chromium)
npm run format     # rewrite files with Prettier
```

The page tests need Playwright's Chromium in `~/.cache/ms-playwright` (Playwright is pinned to
1.60.0, whose Chromium is build 1223). When they say `Chromium for Playwright is not installed`,
download it once, without `sudo`:

```sh
npx playwright install chromium
```

Run the CLI from a checkout with `bin/skydeck --help`. If the `node` on your `PATH` is older than
24.12, point skydeck at a newer binary with `SKYDECK_NODE=/path/to/node`.

A command is one file, `src/cli/commands/<name>.ts`, that exports `command` (see
`src/cli/command.ts`); adding one does not edit any shared file. Tests mirror the source tree under
`test/`, and use the helpers in `test/helpers/`, which give every child process a temporary `HOME`
and `SKYDECK_HOME`.

The design is in [docs/design.md](docs/design.md).
