# skydeck

skydeck is one developer's tool for working with many Claude Code sessions at once. It lists the
sessions that matter, says what each one is doing, carries a label, a group, a note and its pull
requests, and brings a session back with one action, also after a PC restart or a WSL shutdown.

It is a command line tool for the terminal (step 1). The window that step 2 adds is designed in
[docs/design-step-2.md](docs/design-step-2.md).

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
`bin/skydeck install`. [docs/install.md](docs/install.md) is the complete guide: prerequisites, what
install changes, `config.json`, WezTerm on WSL, updating, uninstalling.

## Is it tied to WezTerm?

No. Recording sessions, the list, labels, groups, notes, done and pull requests work in any
terminal, and so do `resume`, `new` and `restore`: by default they start `claude` in the terminal
you are in. WezTerm adds one thing, new tabs (`--tab`, or `"terminal": "wezterm"` in `config.json`),
and `restore` uses them to bring several sessions back at once. Without WezTerm, `--tab` prints the
command to run by hand, and `restore` resumes the first session in this terminal and prints a
`skydeck resume <id> --here` line for each of the others. Details are at the top of [docs/install.md](docs/install.md).

## Commands

| Command                                                                               | Effect                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skydeck`                                                                             | The interactive list on a terminal; otherwise the same as `skydeck ls`.                                                                                                                      |
| `skydeck ls [--all] [--json] [--refresh]`                                             | Print the list. `--all` includes sessions marked done; `--json` prints stable, versioned JSON; `--refresh` first reads the status of the pull requests that are not merged or closed (`gh`). |
| `skydeck show <ref> [--json] [--refresh]`                                             | One session: state, marks, project directory, launch command, links, note, pull requests, holders.                                                                                           |
| `skydeck label <ref> [<text>]` / `skydeck group <ref> [<text>]`                       | Set. Without text, clear. The text is all the arguments after `<ref>`, joined by one space.                                                                                                  |
| `skydeck note <ref> [--set <text>]`                                                   | Edit in `$VISUAL`, else `$EDITOR`, else `vi`; or set directly (`--set ''` clears).                                                                                                           |
| `skydeck done <ref>` / `skydeck undone <ref>`                                         | Hide / show. Never stops a process.                                                                                                                                                          |
| `skydeck pr add <ref> <url>` / `skydeck pr rm <ref> <url>` / `skydeck pr refresh`     | Attach and read the status now / detach / read the status of every pull request that is not merged or closed.                                                                                |
| `skydeck new [--label <text>] [--group <text>] [--here \| --tab] [-- <claude flags>]` | Start a new session in the current directory, with a label and a group from the start.                                                                                                       |
| `skydeck resume <ref> [--here \| --tab]`                                              | Resume a session that is not running, in its own directory and with the flags it was started with.                                                                                           |
| `skydeck restore [--all] [--dry-run] [--yes]`                                         | Bring back what was open before the last restart.                                                                                                                                            |
| `skydeck install` / `skydeck uninstall [--purge]` / `skydeck doctor`                  | Set up, undo and check the installation.                                                                                                                                                     |

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
- [docs/manual-checks.md](docs/manual-checks.md): the checks that need a real Claude Code session,
  run by hand.

## Development

Needs Node.js 24.12 or newer. TypeScript runs directly through Node's type stripping, so there is
no build step.

```sh
npm ci
npm run check   # format check, type check, then the tests
npm run format  # rewrite files with Prettier
```

Run the CLI from a checkout with `bin/skydeck --help`. If the `node` on your `PATH` is older than
24.12, point skydeck at a newer binary with `SKYDECK_NODE=/path/to/node`.

A command is one file, `src/cli/commands/<name>.ts`, that exports `command` (see
`src/cli/command.ts`); adding one does not edit any shared file. Tests mirror the source tree under
`test/`, and use the helpers in `test/helpers/`, which give every child process a temporary `HOME`
and `SKYDECK_HOME`.

The design is in [docs/design.md](docs/design.md).
