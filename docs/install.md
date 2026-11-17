# Installing skydeck on another machine

This guide is enough on its own. It covers the prerequisites, the install, what the install changes,
the configuration, the window of step 2, updating and uninstalling. The design is in
[design.md](design.md) (step 2: [design-step-2.md](design-step-2.md)); the checks to run by hand
after an install are in [manual-checks.md](manual-checks.md).

Commands are shown as typed. Paths such as `/home/you/...` are examples: skydeck prints yours.

## Is skydeck tied to WezTerm?

No. skydeck works in any terminal. Only one thing needs a terminal program: starting a session in a
**new tab**.

| What you do | Needs terminal support? |
|---|---|
| Recording sessions (the hook) | No. It is a Claude Code hook. It records a session whatever terminal `claude` runs in. |
| `skydeck`, `ls`, `show`, `label`, `group`, `note`, `done`, `undone`, `pr ...` | No. They read and write skydeck's own database and call `gh`. |
| `install`, `uninstall`, `doctor` | No. (`doctor` runs a WezTerm check only when the configuration says `"terminal": "wezterm"`.) |
| `resume`, `new`, `restore`, and `R` in the interactive list | They start `claude`. By default they do it in the terminal you are in: skydeck ends and `claude` takes its place. That works in any terminal. With `--window` (`resume`, `new`) or `"terminal": "window"` the window's server starts it in the skydeck window instead ("Starting sessions in the window from a terminal (stage C)"). |
| Starting a session in a **new tab** (`--tab`, or `"terminal": "wezterm"`) | Yes. WezTerm is the only terminal skydeck can open tabs in. There are two adapters, `here` and `wezterm`, in `src/terminals/`. |

What WezTerm adds is tabs: `resume --tab`, `new --tab`, `R` in the list, and `restore`, which brings
back several sessions at once in tabs (three at a time).

What happens without WezTerm, with the default `"terminal": "here"`:

- `skydeck resume <ref>` and `skydeck new` run `claude` in this terminal. `--here` does the same
  whatever the configuration says.
- `skydeck restore` resumes the first selected session in this terminal. For each of the others
  it prints a line that names the session and, under it, `skydeck resume <full session id> --here`,
  to run in another terminal (`--dry-run` shows the real `cd ... && claude --resume ...` lines
  instead). After the hand-off the exit status is `claude`'s own; when some session could not be
  resumed, one line `skydeck: <n> of <m> selected sessions could not be resumed; see above` says
  so before `claude` takes over.
- `--tab` opens nothing. It prints the command to run by hand, and exits 1.

What happens when WezTerm is configured but cannot open the tab (no WezTerm window is open,
`wezterm` is not found, or it exits with an error): `resume` and `new` print the command to run by
hand and exit 1. `restore` reports that session as failed. If WezTerm does not answer within 10
seconds, a tab may have opened anyway; skydeck then prints no command (running it could resume the
session a second time) and tells you to run `skydeck` again to see whether the session is running.
The commands skydeck prints are quoted for `sh`, `bash` and `zsh`; `fish` is not covered.

See "WezTerm on WSL" below for the configuration.

The window of step 2 needs no terminal program either: it is an Edge window on the Windows side,
and every session started in it — also by `resume --window`, `new --window` and, with `"terminal":
"window"`, by `restore` and `R` — runs in a terminal of skydeck's own (see "The window (step 2)").

## Prerequisites

- **Linux, or Windows with WSL2 (Ubuntu).** skydeck reads `/proc`. Native Windows and macOS are not
  supported. On Windows, run everything below inside the WSL distribution.
- **Node.js 24.12 or newer.** Check with `node --version`. If there is none, or the default `node` is
  older, see "On a fresh WSL" below, and "Install", step 2, for a newer one beside an older default.
  skydeck has no runtime dependencies.
- **Claude Code, installed on this Linux side and started at least once**, so that `~/.claude`
  exists. skydeck relies on the file formats of Claude Code 2.1.3xx (design section 14).
- **`git`** to clone the repository.
- **`gh`, the GitHub command line, logged in** (`gh auth login`; check with `gh auth status`). The
  repository is private, so the clone needs it (or an SSH key that GitHub accepts). skydeck also uses it later to read pull-request status. Without it
  everything else works; pull requests stay "not fetched" or show "can't read", and `skydeck doctor`
  reports a problem.
- **WezTerm, optional.** Only for tabs; see above.
- **For the window only: python3 3.9 or newer and Microsoft Edge.** python3 from the distribution
  (Ubuntu ships it) inside WSL, and Edge on the Windows side. The commands do not need either. See
  "The window (step 2)".

The hook uses `sh`, `date`, `cat`, `base64`, `mkdir` and `mv`, which a standard Ubuntu has.

## On a fresh WSL

Skip what you already have. Do this before the first `bin/skydeck` command, which needs Node.js.

`git` and `curl`, from Ubuntu's own packages, and `python3` for the window:

```sh
sudo apt update
sudo apt install git curl python3
```

Node.js 24 with nvm (the version number in the URL is nvm's latest release as of this writing; see
github.com/nvm-sh/nvm for the current one). Open a new terminal when the script has finished, so
that `nvm` is loaded:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
```

Then, in the new terminal:

```sh
nvm install 24
node --version
```

`node --version` should print `v24.12.0` or newer. The first version nvm installs becomes the default
of new terminals; when you already had another default, `nvm alias default 24` changes it. With a
default of 24.12 or newer you never need `SKYDECK_NODE`.

`gh`, from GitHub's own apt repository (the commands of cli.github.com's Linux instructions), and
then the login:

```sh
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y
```

```sh
gh auth login
```

`gh` asks a few questions. Let it set up Git's credentials when it offers (or choose SSH), or an
HTTPS clone of the private repository asks for a password.

Claude Code itself: install it as Anthropic's setup page describes (code.claude.com/docs/en/setup;
for Linux and WSL it gives `curl -fsSL https://claude.ai/install.sh | bash`), and run `claude` once.

## Install

**1. Clone the repository.** Keep it where it can stay: the links that install makes point into it.

```sh
gh auth login     # skip if you did it above
gh repo clone vojtahavranek/skydeck ~/skydeck
cd ~/skydeck
```

Without `gh`: `git clone git@github.com:vojtahavranek/skydeck.git ~/skydeck`, with an SSH key that is
registered on a GitHub account that can read the repository.

**2. Check that skydeck starts.**

```sh
bin/skydeck --version
```

It prints `0.1.0`. With a `node` older than 24.12 it prints one line and exits 1:

```
skydeck needs Node.js 24.12 or newer but found 20.20.2; set SKYDECK_NODE to the path of a newer node binary.
```

Then name the newer binary (adjust the path) and try again:

```sh
SKYDECK_NODE="$HOME/.nvm/versions/node/v24.19.0/bin/node" bin/skydeck --version
```

Put the same `SKYDECK_NODE=...` in front of `bin/skydeck install` in the next step. `install` links
that binary as `<dataDir>/node`. You do not need the variable again: whenever `SKYDECK_NODE` is not
set, the launcher runs the node that link points at (and `skydeck doctor` prints which one that is),
and only when the link is gone does it fall back to `node` on `PATH`.

**3. Install.**

```sh
bin/skydeck install
```

It shows the exact change to Claude Code's settings file and asks once. This goes to stderr (cut
here to one of the two events):

```
skydeck will add these hook entries to /home/you/.claude/settings.json:
{
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "'/home/you/.local/share/skydeck/skydeck-hook' SessionStart >/dev/null 2>&1 || true",
          "timeout": 5
        }
      ]
    }
  ],
  "SessionEnd": [ ... the same, with SessionEnd ... ]
}
Add them? [y/N]
```

Answer `y` (or `yes`). Anything else, or the end of input, is a no: install prints
`settings not changed`, exits 1 and leaves no skydeck folder, database or link behind (the launcher's
compile cache, `~/.cache/skydeck`, is made by every run). After a yes, with an existing settings
file:

```
linked /home/you/.local/share/skydeck/skydeck-hook -> /home/you/skydeck/bin/skydeck-hook
linked /home/you/.local/bin/skydeck -> /home/you/skydeck/bin/skydeck
linked /home/you/.local/share/skydeck/node -> /home/you/.nvm/versions/node/v24.19.0/bin/node
added the hook entries to /home/you/.claude/settings.json; the file as it was is kept in /home/you/.claude/settings.json.skydeck-backup-20261113T090105Z
skydeck is installed
```

When there is no settings file yet (only Claude Code's folder, as can be the case on a fresh machine), the question
is the same, no backup is made, and the line reads
`added the hook entries to /home/you/.claude/settings.json (a new file)`. Uninstall later removes
that file again, as long as nobody changed it since: `removed /home/you/.claude/settings.json: there
was none before skydeck install`.

When Claude Code already has sessions with old transcripts, install asks one more question,
**once** (a later install never asks again, whatever you answered):

```
Mark 3 sessions older than 7 days as done? [y/N]
```

"Done" only hides a session from the list. `skydeck ls --all` still shows it, `skydeck undone <ref>`
brings it back, and a session with new activity shows again by itself. Nothing is stopped or deleted.

The first run also reads all existing transcripts once, which takes some seconds; on a terminal it
shows `reading transcripts n/m`.

Running `install` again changes nothing: it prints `hook entries already present` and makes no
backup.

**4. Put `~/.local/bin` on `PATH`.** Install creates the folder and the link `~/.local/bin/skydeck`.

```sh
command -v skydeck
```

If that prints nothing, open a new login shell (the default Ubuntu profile adds `~/.local/bin` when
the folder exists) or add this line to `~/.bashrc` (or `~/.zshrc`):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

**5. Check the installation.**

```sh
skydeck doctor
```

On a healthy machine every line is `ok` or `info`, and the exit code is 0:

```
ok       hook entries present in /home/you/.claude/settings.json
ok       /home/you/.local/share/skydeck/skydeck-hook -> /home/you/skydeck/bin/skydeck-hook
ok       Node.js 24.19.0 (/home/you/.nvm/versions/node/v24.19.0/bin/node)
ok       database /home/you/.local/share/skydeck/skydeck.db is writable
info     spool: 0 events waiting to be read
info     no events yet
ok       /home/you/.local/state/skydeck/spool/bad: no files that could not be read
info     hook.log is empty
info     scripted runs dropped: 0
ok       the last refresh skipped nothing
ok       /home/you/.claude/sessions can be read
ok       transcripts: 12 files under /home/you/.claude/projects
ok       gh version 2.69.0 (2025-03-19)
ok       gh is logged in
ok       terminal: here (sessions start in the terminal skydeck runs in)
```

`doctor` exits 1 when any line starts with `problem`. "Checking" below says what each check means.
A `gh` that is not logged in is not healthy either: `doctor` prints
`problem  gh is not logged in, or GitHub cannot be reached (gh auth status: exit 1); run gh auth status to see why`
and exits 1. That happens, for example, after a clone with an SSH key and no `gh auth login`.

**6. Look at it work.** Start `claude` in some project folder, then, in another terminal:

```sh
skydeck ls
```

The steps to try by hand are in [manual-checks.md](manual-checks.md).

**7. Optional: check that this machine can run the tests.** `npm ci` is needed for development only:
it installs TypeScript, Prettier, `@types/node`, `ws`, Playwright and the `@xterm/*` packages,
which `npm run check` (format check, type check, tests, the page tests) uses. skydeck itself, the
window included, has no runtime dependencies and runs without it (the window's xterm.js files are
committed under `vendor/`). `npm` runs the tests with the `node` on your `PATH`, which therefore
must be 24.12 or newer here (`SKYDECK_NODE` is not used). The page tests need Playwright's
Chromium in `~/.cache/ms-playwright`; when they say it is missing, `npx playwright install
chromium` downloads it (no `sudo`).

```sh
npm ci
npm run check
```

## What install changes

| Where | What |
|---|---|
| `<claudeHome>/settings.json` (default `~/.claude/settings.json`) | Two hook entries are added: `SessionStart` and `SessionEnd`, each running `'<dataDir>/skydeck-hook' <event> >/dev/null 2>&1 \|\| true` with a timeout of 5 seconds. Everything else in the file keeps its key order, and its content except a number that cannot be written back exactly (the question names it; the backup has it). The file is parsed and written back in skydeck's formatting (two-space indentation, a newline at the end); when that changes more than the entries, the question has one more line (below). If the file does not exist but the folder does, install creates it. Hook entries that belong to something else are never touched. |
| `<claudeHome>/settings.json.skydeck-backup-<YYYYMMDDTHHMMSSZ>` | The file as it was before, readable by you only. The time is UTC; a second backup in the same second gets `-2`, and so on. Every install that changes the settings makes a new one. skydeck never removes one, not even with `uninstall --purge`. |
| `<dataDir>/skydeck-hook` | Symbolic link to `<checkout>/bin/skydeck-hook`. |
| `~/.local/bin/skydeck` | Symbolic link to `<checkout>/bin/skydeck`. The folder is created when missing. |
| `<dataDir>/node` | Symbolic link to the Node.js binary that ran `install`. |
| `<dataDir>/skydeck.db` | The database, mode 600. |
| `<stateDir>/spool/`, `<stateDir>/locks/`, `<configDir>/` | Empty folders (mode 700). The hook writes to the spool; `locks/` is unused; `config.json` is yours to write (see "Configuration"). |

The defaults of `<dataDir>`, `<stateDir>`, `<configDir>` and `<claudeHome>` are in "Configuration".

Install **refuses**, before it creates anything, when:

- a path it wants to link already holds something that is not a symbolic link
  (`... exists and is not a symbolic link; move it away and run skydeck install again`);
- the settings file cannot be read or is not JSON (`settings.json is not valid JSON: ...`);
- the settings path is a symbolic link to nothing
  (`<path> is a symbolic link to <target>, which does not exist; create that file or remove the link,
  then run skydeck install again`);
- there is no settings file and Claude Code's folder does not exist either
  (`Claude Code's directory ... does not exist; run claude once, or set claudeHome`). It never
  creates Claude Code's folder.

When the settings file is not already in skydeck's formatting (indented with four spaces, no newline
at the end, a number written another way), install does not refuse: it adds one line to the question,
which names the backup it is going to keep. A number that could not be written back exactly, such as
an integer above 2^53, is named by its key:

```
the rest of the file will be rewritten in skydeck's formatting and big would lose digits; the file as it is now is kept in /home/you/.claude/settings.json.skydeck-backup-20261113T120727Z
```

After your `y` it stops, and writes nothing, when the settings file is no longer what it showed
(you or Claude Code saved it while the question was open): `... changed while the question was open,
so skydeck left it as it is; run skydeck install again`.

skydeck never writes to transcripts or to Claude Code's live-session files. The settings file is the
only thing of Claude Code's that it changes. A settings file that is a symbolic link (into a
dotfiles folder, say) stays a link; the file it points to is changed.

## Configuration

### Places

| Name | Default | Holds |
|---|---|---|
| `dataDir` | `${XDG_DATA_HOME:-~/.local/share}/skydeck` | `skydeck.db`, the links `node` and `skydeck-hook`. |
| `stateDir` | `${XDG_STATE_HOME:-~/.local/state}/skydeck` | `spool/`, `hook.log`, `locks/` (unused), a note while it is being edited, and `note-<session id>.md` after an editor that failed having changed it (`editor exited <n>; your text is in <path>`). |
| `configDir` | `${XDG_CONFIG_HOME:-~/.config}/skydeck` | `config.json`. |
| `claudeHome` | the key `claudeHome` of `config.json`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude` | Claude Code's own files, including the settings file and the backups. |

### `config.json`

The file is `<configDir>/config.json` (default `~/.config/skydeck/config.json`). It does not exist
until you write it, and every key is optional. Unknown keys are an error, so a typo is not silently
ignored.

| Key | Default | What it does |
|---|---|---|
| `terminal` | `"here"` | Where `resume`, `new`, `restore` and `R` start `claude` when you give none of `--here`, `--tab` and `--window`: `"here"` (this terminal), `"wezterm"` (a new WezTerm tab) or `"window"` (the skydeck window, through its server; `--tab` then means the window too, and `--here` this terminal: "Starting sessions in the window from a terminal (stage C)"). |
| `wezterm.domain` | `null` | The WezTerm domain a tab opens in (`--domain-name`). `null` passes no domain. |
| `groupPattern` | `"^[A-Z][A-Z0-9]+-[0-9]+"` | A JavaScript regular expression (the source, no flags). When a session has no group, the text it matches in the session's title is the group. The default takes a ticket key such as `ABC-123` at the start of the title. |
| `firstRunDoneAfterDays` | `7` | install's one-time offer to mark sessions as done: those not running whose last activity is older than this many days. |
| `prRefreshMinutes` | `5` | The least time between two automatic attempts to read a pull request's status. |
| `restoreBatch` | `3` | How many sessions `restore` opens at a time. |
| `restoreMinFreeMb` | `4096` | `restore` stops (exit 5) before a batch when less memory than this (MiB, `MemAvailable`) is free. |
| `restoreStartTimeoutSeconds` | `120` | How long `restore` waits for the sessions of a batch to report their start. |
| `claudeHome` | `null` | Claude Code's folder. `null` means `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Must be an absolute path (no `~`). |
| `claudeCommand` | `"claude"` | The program `resume`, `new` and `restore` (and `R` in the list) run. One word: a name on `PATH` or an absolute path. It is not split into arguments. The window runs it too. |
| `ticketUrl` | `null` | A ticket's address with `{key}` where the ticket key goes, for Jira `"https://example.atlassian.net/browse/{key}"`. The group chip of the window's header then opens the session's ticket, and `skydeck show` prints its address as a `ticket:` line. `null`: no link. What it accepts, and its line when it is refused: "The ticket link", in "The window (step 2)". |
| `window` | see the window's section | The window's keys `window.port`, `window.edge`, `window.profileDir` and `window.keepAlive`: "The window (step 2)", "The `window` keys". |

The numbers must be positive integers. An example that uses WezTerm tabs and a lower-case ticket key:

```json
{
  "terminal": "wezterm",
  "wezterm": { "domain": "WSL:Ubuntu" },
  "groupPattern": "^[a-z]+-[0-9]+",
  "restoreBatch": 2,
  "restoreMinFreeMb": 2048
}
```

A mistake in the file makes every command fail with exit 1 and a line that names the file and the key:

```
skydeck: /home/you/.config/skydeck/config.json: unknown key "terminall"
skydeck: /home/you/.config/skydeck/config.json: "claudeHome" must be an absolute path
```

(`doctor` reports it as one problem line and still runs the checks that do not need the file.)

### Environment variables

| Variable | Effect |
|---|---|
| `SKYDECK_NODE` | The `node` binary the launcher runs. It wins over the link `<dataDir>/node`, which wins over `node` on `PATH`. |
| `SKYDECK_HOME` | Replaces the three skydeck folders with `$SKYDECK_HOME/data`, `/state` and `/config`. Meant for tests. It moves skydeck's own folders only. To try skydeck out without touching your real setup, point all three of `SKYDECK_HOME`, `HOME` (the link `~/.local/bin/skydeck`, the compile cache) and `CLAUDE_CONFIG_DIR` (the settings file and its backups) into a scratch folder. |
| `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` | Move the folders of the same names (to `.../skydeck`), unless `SKYDECK_HOME` is set. |
| `CLAUDE_CONFIG_DIR` | Claude Code's folder, when `config.json` has no `claudeHome`. |
| `NODE_COMPILE_CACHE`, `XDG_CACHE_HOME` | Where the cache of compiled modules is kept: `$NODE_COMPILE_CACHE`, else `$XDG_CACHE_HOME/skydeck/compile-cache`, else `~/.cache/skydeck/compile-cache`. |
| `TMPDIR` | Where the launcher puts the short-lived file it uses to hand `claude` the terminal (`--here`). `/tmp` when it is not an existing absolute path. |
| `VISUAL`, `EDITOR` | The editor of `skydeck note <ref>`: `$VISUAL`, else `$EDITOR`, else `vi`. |
| `XDG_RUNTIME_DIR` | Where the window's server keeps its sockets (`$XDG_RUNTIME_DIR/skydeck-<id>`), when it is yours, not readable by others, and kept while you have no login session (you linger); else `<stateDir>/run-<id>`, and with `SKYDECK_HOME` set always `$SKYDECK_HOME/run`. `skydeck doctor` names the one in use. |
| `SKYDECK_TEST_*` | The tests' own. Do not set them. |

`SKYDECK_HOME`, the `XDG_*` variables and `CLAUDE_CONFIG_DIR` count only when they are non-empty and
an absolute path; otherwise they are treated as unset. The hook is started by Claude Code and reads
`SKYDECK_HOME` and `XDG_STATE_HOME` from Claude Code's environment, so set them (if you set them at
all) in your shell's startup file, where Claude Code is started from. skydeck asks `gh` about
`github.com` only; `GH_HOST` is ignored.

## WezTerm on WSL

Skip this if you do not use tabs. In `config.json`:

```json
{ "terminal": "wezterm", "wezterm": { "domain": "WSL:Ubuntu" } }
```

With it, `resume`, `new` and `R` open a new tab, and `restore` opens its sessions in tabs. What
skydeck runs for each one is:

```
wezterm cli --no-auto-start spawn --domain-name <domain> --cwd <session directory> -- claude --resume <id> ...
```

- `--domain-name` is left out when `wezterm.domain` is `null`, which is the place to start: WezTerm
  then uses the domain of the pane skydeck runs in. skydeck passes the value as it is, so it must
  be a domain name WezTerm knows. For a WSL distribution WezTerm's own documentation names the
  domains it makes `WSL:` followed by the distribution's name (its example is `WSL:Ubuntu-18.04`).
  The distribution's name is in `$WSL_DISTRO_NAME` (and in `wsl -l -v` on Windows), so
  `echo "WSL:$WSL_DISTRO_NAME"` prints the usual value. If your WezTerm configuration defines its
  own `wsl_domains`, use the names it gives them. This has not been checked on a live WezTerm; if the
  tab does not open, try without `wezterm.domain`.
- `--no-auto-start` is deliberate. With no WezTerm window open the call fails, and skydeck takes its
  fallback (it prints the command). Without the flag WezTerm would start a hidden server, and the
  session would run where nobody can see it. So open a WezTerm window first, and run skydeck from it.
- In WSL, when `wezterm` is not found and `$WSL_DISTRO_NAME` is set (WSL sets it), skydeck runs the
  same call with `wezterm.exe`. WSL normally appends the Windows `PATH` to yours; check with
  `command -v wezterm.exe`.
- The call has 10 seconds. When it times out, skydeck assumes that the tab may have opened (see the
  top of this guide).
- `skydeck doctor` runs `wezterm cli --no-auto-start list` and prints `terminal: wezterm answers`,
  or a `problem` line with the reason.

What WezTerm does with the call (which domain, how it reads a Linux `--cwd` handed to `wezterm.exe`)
is WezTerm's business and depends on your WezTerm configuration. Whether a tab opens on your setup is
what item 5 of [manual-checks.md](manual-checks.md) tests. When it does not, leave `terminal` at
`"here"`: nothing else in skydeck depends on it.

## The window (step 2)

`skydeck window` opens **the window**: an Edge app window on the Windows side, showing a page that
skydeck's own server serves from inside WSL. The session list is on the left, the selected
session's real terminal on the right. Sessions are resumed and started in the window, and they keep
running when the window or skydeck's server is closed or restarted: each terminal is held by a small
python3 process of its own, its **keeper**. A session ends only when you end it inside `claude`; the
window has no action that stops one.

This is stages A, D, B, C and E of step 2 ([design-step-2.md](design-step-2.md), section 19):
the list, the terminals, resume and new (A); editing in the window — the label, group, note, done
mark and pull requests, and the ticket link (D); which sessions need you, with desktop
notifications (B); restore in the window after a restart, with `--window` and `"terminal":
"window"` for the commands (C); and search — several words and the short id in the filter, the
chips, the blocks of one group and the quick switcher — with the page's own icon (E). The commands of step 1 stay
as they are, also while the window runs: `skydeck resume`, `new` and `restore` start `claude` in
the terminal you type them in, not in the window — unless you give `resume` or `new` the option
`--window`, or set `"terminal": "window"` ("Starting sessions in the window from a terminal (stage
C)" below).

### Before you rely on it

Two things only you can check decide whether the window is safe for real work:

- **WSL stops 15 seconds after its last Windows client ends**, and with it every session in the
  window. The keep-alive ("Keeping WSL running" below) is meant to prevent that, but that it does is
  **not verified** until manual check W14 of [manual-checks.md](manual-checks.md). Until W14 has
  passed, keep one WSL terminal of your own open while the window runs, or set
  `instanceIdleTimeout=-1` (below).
- **Try it first with a throwaway session** in a throwaway folder: W1 (the window opens), W20 (the
  PC's privilege management lets Edge and `wsl.exe` start) and W4 (Claude Code in the window). Then
  resume real sessions into it.

### What it needs

- **python3 3.9 or newer**, the distribution's (Ubuntu ships it): it runs the keepers. Check with
  `python3 --version`; when it is missing, `sudo apt install python3`. The commands do not need it.
  Without it the window still lists the sessions, but no terminal opens (the resume card says
  `python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)`),
  and `skydeck install` prints `the window (skydeck window) needs python3 3.9 or newer; the
  commands do not`. The server itself is started through `/usr/bin/python3`, which keeps it from
  writing crash dumps (a dump would hold every screen); without that file it starts all the same,
  and `skydeck doctor` says so.
- **Microsoft Edge** on the Windows side, at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  (`window.edge` names another place). Without Edge, `skydeck window --print-url` gives an address
  for any browser.
- **WSL with the C: drive at `/mnt/c` and interop on**, as WSL sets it up by default: skydeck starts
  three Windows programs, and only these, through interop: `msedge.exe` (the window),
  `rundll32.exe` (the links the window opens: it hands them to your default browser; with
  `window.links` `"edge"` they open with `msedge.exe` instead) and `wsl.exe` (the keep-alive). It
  writes nothing on the Windows side; Edge writes its profile folder (below).

Nothing is fetched or installed for the window. xterm.js, the terminal in the page, and its addons
are committed in the repository under `vendor/`, with their licences and a list of their hashes
(`vendor/MANIFEST.json`, which `doctor` checks). `npm ci` is still for development only. An
installation of step 1 needs no `skydeck install` again: the hook entries are unchanged.

### Starting it: `skydeck window`

In a WSL terminal of your own:

```sh
skydeck window
```

Not as a `!` command inside a Claude Code session: every session in the window would inherit that
session's environment, so the command refuses there (exit 1):

```
skydeck: the window's server is not started from inside a Claude Code session: every session in the window would inherit that session's environment; run skydeck window in a terminal of your own
```

What it does:

1. It starts the window's server when none runs (`skydeck serve`, in the background; its log is
   `<stateDir>/server.log`), or uses the one that runs.
2. When no window is open, it starts Edge with a launch address that works once, and waits up to 30
   seconds for the window's page to connect. A cold Edge on a managed PC can take several of them.
   Before that, when the server expects a window back — a window was open when the server before
   it ended: a WSL restart, a crash of the server, `--stop` — it waits up to 7 seconds for that
   window to connect again, and says so (`skydeck: waiting up to 7 s for the open window to come
   back; --new-window opens one now`); when it comes, Edge is not started ("Restore after a
   restart (stage C)" below).
3. It prints one line and exits 0:

   ```
   skydeck window: http://127.0.0.1:47613/ (server pid 12345)
   ```

   When a window is already open, it starts nothing: `skydeck window: a window is already open`.
   Edge cannot be asked to bring an open window to the front; `--new-window` opens another one.

**The server's environment becomes every session's.** The server gets the environment of the shell
you ran `skydeck window` in, and every program started in the window inherits it: a shell with a
project's `direnv`, a Python virtual environment or an `AWS_PROFILE` gives them to every session.
Run it from a plain shell. `skydeck doctor` says where the environment came from
(`environment of skydeck window run in <directory> at <time>`). A change reaches new sessions only
after `skydeck window --restart`, which says so:

```
skydeck: restarting the window's server for the new build; new sessions in the window get the environment of this shell (/home/you)
```

(the same line comes after an update, below). Sessions that run keep their environment.

| Option | What it does |
|---|---|
| (none) | As above. |
| `--print-url` | Makes sure the server runs and prints an address for any browser, `http://127.0.0.1:<port>/#t=<token>`, valid once and for 10 minutes; starts nothing on Windows. Paste it into a browser on this PC. In a normal browser tab the browser keeps Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and their Shift forms, so the page names Ctrl+Shift+O for the previous session and shows a `+ New` button. |
| `--new-window` | Opens another window, also when one is open. Several windows can be open at once. |
| `--restart` | Stops the server and starts a new one; also a server of another checkout, or one that does not answer. Sessions keep running, and open windows reconnect by themselves: `skydeck's server restarted; your sessions kept running`. |
| `--stop` | Stops the server and starts nothing: `stopped skydeck's window server; 2 terminals in the window keep running` (or `the window's server is not running`). Sessions keep running in their keepers; open windows say that the server is not answering. |
| `--new-secret` | Replaces skydeck's key, then opens a window as without options. Windows opened before cannot connect any more and say so: close them. For when skydeck says that its key may be known to another program (below). |

`--stop` goes with no other option, and `--print-url` not with `--new-window`: either is a usage
error (exit 2). Exit codes: 0, 1 (a failure; the line says what), 2 (usage). Standard output carries
only the one result line; every other line goes to standard error, with the `skydeck: ` prefix.

Closing the window (its ×, Alt+F4) ends nothing: the server and every session keep running, and
`skydeck window` opens a new window onto them. The server runs until `skydeck window --stop` or
`--restart`, `skydeck uninstall`, or WSL stopping. When it is gone, an open window says

```
skydeck's server is not answering (since 14:02:11). Sessions in the window keep running unless WSL has stopped. To get back, open a WSL terminal and run: skydeck window
```

and connects again by itself once a server runs.

### The profile folder

Edge runs the window with a profile folder of its own, so that your extensions do not run on the
page and the window has its own taskbar button. It is a Windows folder, by default
`C:\Users\<you>\AppData\Local\skydeck\edge-profile`, where `<you>` is the one Windows user under
`/mnt/c/Users` that has an Edge folder (`AppData/Local/Microsoft/Edge`). skydeck finds it without
starting a Windows program. With none or several such users, `skydeck window` and `doctor` say so
and name `window.profileDir`: set it (below). A folder with a `"`, a control character or a
backslash at its end cannot be passed to Edge and is refused with a line that names
`window.profileDir`.

Edge creates the folder at the window's first start and writes it; skydeck never creates, writes
or removes it, also not on `uninstall` (which names it). The window keeps its key there, as a key
that cannot be read out. `skydeck doctor` prints the folder:

```
ok       the window's Edge profile folder: C:\Users\you\AppData\Local\skydeck\edge-profile (derived)
```

### The `window` keys

In `config.json` ("Configuration" above), all optional:

| Key | Default | What it does |
|---|---|---|
| `window.port` | `47613` | The server's port on `127.0.0.1`: a whole number from 1 to 65535. Keep it unchanged once windows were opened: a window keeps its key per port, so after a change the old windows cannot connect (close them) and `skydeck window` opens a new one. |
| `window.edge` | `"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"` | The Edge program: an absolute path in WSL. With `window.links` `"edge"` the links the window opens open with it too, in your own Edge profile. |
| `window.profileDir` | `null` | The window's Edge profile folder: an absolute Windows path (`C:\…`, every backslash doubled in JSON). `null`: found as above. |
| `window.keepAlive` | `"wsl"` | `"wsl"`: the server keeps WSL running while the window has anything running (below). `"off"`: it does not; for use with `instanceIdleTimeout=-1`. |
| `window.links` | `"default"` | Where the links the window opens go — a Ctrl+click on an address in a terminal, a pull request in the list or the header, the ticket chip. `"default"`: your Windows default browser, where you are logged in (skydeck runs `rundll32.exe url.dll,FileProtocolHandler <address>`). `"edge"`: your own Edge profile (`window.edge`). Anything else: `<file>: "window.links" must be "default" or "edge"`. When `rundll32.exe` cannot be started from WSL at all (the file is missing, interop is off), the key bar says `the link could not be opened: the default browser could not be started (window.links "edge" opens links in Edge)`; when Windows stops it afterwards (privilege management), nothing opens and nothing is said: then set `"edge"`. On a managed PC, security monitoring may record or flag each start of `rundll32.exe url.dll,FileProtocolHandler`; `"edge"` avoids it. |

With `"terminal": "window"` (stage C) the commands start their sessions in the window too:
"Starting sessions in the window from a terminal (stage C)" below. An example, for a PC with two
Windows users that have Edge (so the profile folder cannot be found by itself) and another program
on port 47613:

```json
{
  "window": {
    "port": 47614,
    "profileDir": "C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile"
  }
}
```

A key inside `window` that skydeck does not know is an error, as everywhere in the file
(`skydeck: /home/you/.config/skydeck/config.json: unknown key "window.prot"`). The server reads the
file when it starts: after a change, run `skydeck window --restart`.

### Keeping WSL running

WSL stops a distribution 15 seconds (`instanceIdleTimeout`) after its last Windows client has
ended, the last WSL terminal or other `wsl.exe`; processes inside WSL do not count, systemd
included. When it stops, every process in it ends: the window's server, every keeper and every
`claude` in the window. The window itself, an Edge window, stays and says what happened.

So with `window.keepAlive` `"wsl"` (the default) the server starts one hidden `wsl.exe` through
interop, the **keep-alive**: it runs a small script of skydeck's (`bin/skydeck-keepalive`) as long
as the server or any terminal of the window runs, also after `skydeck window --stop`, and ends by
itself when nothing is left. It shows in the Task Manager as `wsl.exe`. When it ends while the
server runs, the server starts it again after 5 seconds, 30 seconds, then every 5 minutes, and the
window says `WSL is not kept running: <reason>; skydeck tries again` (its title bar shows `WSL is
not kept running` meanwhile). **That a `wsl.exe` started from inside WSL keeps WSL running is not
verified yet**: manual check W14.

The alternative does not depend on it: WSL's own setting, which skydeck never writes. In
`%USERPROFILE%\.wslconfig` on Windows (`C:\Users\<you>\.wslconfig`; create the file when there is
none):

```ini
[general]
instanceIdleTimeout=-1
```

It takes effect at the next WSL restart by itself (a restart of the PC). `wsl --shutdown` in
PowerShell restarts WSL at once, but it ends EVERY session and terminal in WSL: run it only when
nothing is running that you want to keep. With the setting in effect `window.keepAlive` can be
`"off"`. `skydeck doctor` says which protection is in effect:

```
ok       .wslconfig has instanceIdleTimeout=-1 (WSL does not stop by itself)
info     keep-alive wsl.exe running (pid 4242, since 2026-11-14T09:12:03.000Z); that it keeps WSL running is unverified (manual check W14)
```

and a `problem` line that names the setting while a server or a terminal runs and neither is in
effect.

### Using the window

- **The list**, on the left, has three sections: **Open** (running or starting, in the window or in
  another terminal; the window's terminals carry the slots 1–9), **Recent** (not running, last
  active in the last 7 days) and **Earlier** (folded; a click on its header unfolds it). Done
  sessions are hidden: the footer's `show`, or `a`, shows them.
- **A session that is not running**: one click selects it and shows its resume card, with the
  exact command it will run. Enter, a double click or `Resume here` resumes it into the window.
- **A running session** of the window: a click shows its terminal. A session that runs in another
  terminal shows a card instead: it cannot be shown in the window. Once you `/exit` it there, it
  can be resumed here.
- **A new session**: Ctrl+Shift+N (in a browser tab the browser keeps Ctrl+Shift+N for itself:
  use the `+ New` button there), with its directory,
  label, group and `claude` flags.
- **A session that ended** keeps its last screen, dimmed, under a bar with Resume and Close.
- **Keys**: **Ctrl+Shift+H shows every key of the window**. The window takes only Ctrl+Shift
  chords with a letter or a digit, and Ctrl+Tab, besides the list's own keys while the list has the
  keyboard; every other key goes to Claude Code (Alt chords, Ctrl with a letter, function keys, Esc
  in the terminal). Three to know from the start: Ctrl+Shift+L moves the keyboard between list and
  terminal, Ctrl+Shift+C copies from the terminal (plain Ctrl+C interrupts the program), and
  Ctrl+Shift+V is Claude Code's own image paste (it reads the Windows clipboard itself; Ctrl+V
  pastes text). The key bar at the bottom says where the keyboard is (`Focus: list`,
  `Focus: terminal`).

#### Editing a session (stage D)

The label, group, note, done mark and pull requests of the selected session are edited in the
window, by step 1's rules: what `skydeck label`, `group`, `note`, `done` and `pr add` refuse is
refused with the same message, and every open window shows the change within a second. Each edit
has a key in the list (while the list has the keyboard: `Focus: list`) and a control in the
header:

| Edit | In the list | In the header |
|---|---|---|
| the label | `l` or F2 | a click on the title |
| the group | `g` | ✎ beside the group chip, or `+ group` while there is none |
| the note | `n` | `Note`, or a click on the note's line |
| the pull requests | `p` | `Pull requests` (`+ PR` while none is attached) |
| done, undone | `d` | `Done` (`Undone` for a session marked done) |

With no session selected, a key says `no session selected`.

**The header** has four lines, the same height for every session and every window width; each
is one line, cut with an ellipsis when it is long:

1. the title, the group chip with its ✎ (or `+ group`), the state, `Note` and `Done`;
2. the directory (whole in its tooltip), `opened today at 14:02 · last active 3m` (`opened` while
   the window shows the session's terminal), where the title comes from (`title: your label`,
   `title: Claude Code's name`, `title: Claude Code's summary` or `title: start time and
   folder`), and the short id, which a click copies whole (`id copied`);
3. the pull requests: the window's chip (below), the open ones side by side as far as they fit
   (`acme/web #7 · failing`; a click opens one in your default browser), and `Pull requests`;
   while none is attached, `no pull request` and `+ PR`;
4. the note's first line, with ` …` after it when there is more, or `no note`.

The title, the group chip, a pull request and the note's line act on a click that selected no
text: a drag over them selects their text to copy, as anywhere in the header. A click on a button
leaves the keyboard where it was.

**The dialogs** lie over the page, which takes no click and no key while one is open. Their
heading names the session (`Label — <title>`, `Group — …`, `Note — …`, `Pull requests — …`):
look at it before you save.

- The label's field holds your label; it is empty, with the title as its hint, while you have set
  none. An empty label clears yours. The label is also the session's name for Claude
  Code at its next start or resume.
- The group's field holds the group you set; it is empty, with the title's ticket key as its
  hint, while the group comes from the title. An empty group gives the session the ticket key at
  the start of its title again.
- The note's box holds the whole note. An empty note removes it.
- **Enter** saves (`Save`); in the note Enter is a line break and **Ctrl+Enter** saves. A refused
  save keeps the dialog open with your text and says why under the field: for a label that
  `skydeck label` refuses, the same line; for a note that another window or `skydeck note`
  changed since the dialog opened, `the note was changed elsewhere while you edited it; your text
  is still in the box`; for a session started in the window that has not started yet, `this
  session has not started yet; edit it once it runs`.
- **Esc** or `Cancel` closes without saving. A note whose text you changed takes Esc twice: the
  first says `Esc again discards your text`.
- While a dialog is open, every window chord but Ctrl+Shift+H says `close the edit first (Esc)`
  in the key bar and does nothing else. The reload keys (F5, Ctrl+R, …) reload as anywhere while
  you have changed nothing, and say `save or cancel the edit first` once you have. Closing the
  window, or Edge's own reload, with changed text asks first (Edge's own prompt). Ctrl+V and
  Ctrl+Shift+V paste into the field.
- Right after this window saved a label, group or note of a session, its dialogs wait for the
  list that holds the new text (within a second). Until it has come, whichever of the three was
  saved, each of these on that session only says so: `l` `the label is not here yet; press l
  again`, F2 `the label is not here yet; press F2 again`, `g` `the group is not here yet; press g
  again`, `n` `the note is not here yet; press n again`; the header's controls say the same with
  the list's key (`press l again`, …). `p` never waits. Right after you select a session, `n`
  can also say `the note is not here yet; press n again`. A refusal that comes after you closed
  its dialog shows in the toast as `not saved: <why>`.

**Done.** `d` or `Done` marks the session done and shows a toast with `Undo` for 5 seconds:
`Marked done: hidden from the list. It comes back on new activity.`, or for a session under Open
(it runs) `Marked done. Stays under Open while it runs; hidden once it stops.` — such a row stays
under Open with a `done` mark until the session stops. `Undo` marks it undone again: a click
presses it, or Tab until it has the keyboard and then Enter.
After `d` in the list, once the row is gone, the row after it in the same section is selected,
else the one before it, else none; never a row of Open. That row is another session, and the
next key acts on it: to take the `d` back, click `Undo` first. `Undo` selects the session again,
unless you moved the selection meanwhile. `Done` in the header selects nothing in its place.
`d` on a session marked done (shown with `a`), and `Undone`, mark it undone, without a toast. A
held `d` acts once, and so does a double click on a button of the header.

**The pull-request dialog** (`p`, `Pull requests` or `+ PR`) lists every attached pull request on
a line of its own: `acme/web #7 · approved, green · checked 4m ago` (or `checks failing`, `changes
requested`, `checks pending`, `review required`, `draft`; `not fetched` until it is first read),
and one that cannot be read with when it was last read and its error, `acme/web #7 · can't read ·
last read 3h ago · gh: HTTP 502` (`never read` when it never was; a long error is cut, and the
line's tooltip has it whole, after the pull request's title). The merged and closed ones are
folded into `30 merged, 2 closed ▸`; a click unfolds them (they show no age: they are never read
again). On a line:

- a click that selected no text opens the pull request in your default browser (`window.links`);
- `×` detaches it and shows the toast `Detached acme/web #7` with `Undo`, which attaches it again.

`↻`, under the open ones, reads the status of the session's pull requests that are not merged or
closed from GitHub now, in the background; the lines follow. The field takes a pull request's
address (`https://github.com/owner/repo/pull/123`): Enter or `Attach` attaches it, as `skydeck pr
add` does, empties the field and keeps the dialog open, where the new line shows `not fetched`
(or its last state, when skydeck has read that pull request before), then within seconds its
state read now, through your `gh`; an address that is not a pull request's is
refused (`not a GitHub pull-request URL: <the text>`). `Close` or Esc closes the dialog. With
none attached it says `no pull request attached`. Pull requests a session touched are still
attached by themselves (design.md 7.3).

**The window's chip**, in the list and on the header's third line, counts the open pull requests
and the merged ones apart: `PR · failing` for one open pull request, `3 PRs · failing` for three,
named by the one that most needs you (in this order: `can't read`, `not fetched`, `failing`,
`changes`, `pending`, `review`, `draft`, `approved`), with `+30` after it for 30 merged ones;
with none open, `3 merged`, or a dim `closed`. It is dotted while it says `can't read`, and its
tooltip lists each open one with its state. `skydeck ls` and the interactive list keep the command
line's chip (design.md 7.3).

The chip has a quiet colour for its state, in both colour schemes: red for `failing` and
`changes`, amber for `pending`, blue for `review`, green for `approved`, purple for `3 merged`;
`draft`, `closed`, `not fetched` and `can't read` stay grey. Its `+30` has the chip's colour (dim
on a grey chip). The header's open pull requests, the state on a line of the pull-request dialog
and the quick switcher's chip show the state's words in the same colour. Sessions that need you
stay the strongest in the list: only they have a coloured bar at the left and their reason's line
in its colour, and their titles are the boldest (a running session's title is semibold, any other
row's regular); no chip's text is brighter than an ordinary row's title.

#### The ticket link

With `ticketUrl` in `config.json` ("Configuration" above), the group chip opens the session's
ticket. For Jira, a file with only this key (in a file with others, add the key beside them):

```json
{
  "ticketUrl": "https://example.atlassian.net/browse/{key}"
}
```

When the session's group holds a ticket key — the text `groupPattern` matches in it, made of
letters, digits, `-`, `_` and `.` and starting with a letter or a digit; with the default pattern
a key such as `ABC-123` at its start — the chip shows the group with `↗` after it (`ABC-123 ↗`,
`ABC-123 cleanup ↗`), underlined, with the ticket's address as its tooltip, and a click on it that
selected no text opens the ticket in your default browser (`window.links`). Without such a key,
or without `ticketUrl`, the chip is plain text. The chip never edits: ✎ and `g` edit the group.
skydeck reads nothing from the ticket system.

`ticketUrl` must be an `http` or `https` address with `{key}` exactly once, after its host, with
no user name or password, no white space, control character, `"` or backslash, no `%` (or `%` and
one hex digit) right before `{key}`, and at most 2,048 characters. Anything else is a mistake in
the file, as for every key: every command fails with exit 1 and

```
skydeck: /home/you/.config/skydeck/config.json: "ticketUrl" must be null or an http or https address with {key} once, after its host
```

The window's server reads the file when it starts: after you set or change `ticketUrl`, run
`skydeck window --restart`. `skydeck show <ref>` reads it at once and prints the address after the
group (`--json` is unchanged):

```
group:     ABC-123
ticket:    https://example.atlassian.net/browse/ABC-123
```

#### Which sessions need you (stage B)

A session **needs you** for one of three reasons. Its row then has a coloured bar at its left, a
bold title and the reason on its second line, in the reason's colour, with how long ago it began;
an ended row that is not running has the two lines too:

| The second line | Why | It goes |
|---|---|---|
| `needs you · <detail> · 3m` (`needs you · 3m` without a detail), in the waiting colour | Claude Code asks: a permission prompt or a question is open in the session. The detail is what Claude Code says it waits for, cut at 120 characters with `…`. | when the prompt or the question is closed, wherever you answer it |
| `finished · not seen · 2m`, in green | its turn ended while you were not looking at it, and it is idle | when you have seen it (below), when its next turn starts, or when it stops running |
| `ended unexpectedly · not seen · 2m`, in the crash colour | the program of its terminal in the window ended, but not the normal way (as `/exit` ends it): `claude` crashed or was killed, or the terminal's keeper died | when you have seen it |

The age is left out while skydeck does not know when the reason began.

**Seen.** You have seen a session once it has been the selected one for 1.5 seconds in a skydeck
window that has the focus (in front: the one you work in), or at once when you type into its
terminal. Selecting it is enough, also for a session that runs in another terminal (its card
shows). A turn that ends while you look at its session never shows `finished`, and a terminal
that ends while you look at its session never shows `ended unexpectedly`: both are seen as they
happen. Selecting another session, or the window losing the focus, ends the looking; when the
window comes back to the front, the session selected in it is seen after 1.5 seconds or a little
more.

Asks and finished turns come from the files Claude Code itself keeps for every running session,
so they show for the sessions that run in another terminal too; `ended unexpectedly` is only for
the window's own terminals.

**The title bar** starts with the count, `3 need you` (`1 needs you`), after a dot in the waiting
colour, before the counts per state: `3 need you · 2 working · 1 waiting · 14 not running`. A
session that needs you is counted there and in no other count. The count takes in every session
the list lists, also those the filter or the folded Earlier hides; a done session that has stopped
is counted only while done sessions are shown (`show`, `a`). The window's title, which the taskbar
button shows, is `(3) skydeck`, and `skydeck` while none needs you.

**Ctrl+Shift+J** selects the next session that needs you: first those that ask, the one that has
waited longest first; then those that ended unexpectedly; then those that finished, the oldest
first. Pressed again it goes on, and after the last it starts over. As with Ctrl+Shift+1…9, the
session's terminal takes the keyboard, or the list when it has none. The key bar says
`no session needs you` when none does, and `no other session needs you` when only the selected one
does (it stays selected). It goes only through the rows the list shows: when the filter or the
folded Earlier hides some, the key bar says how many, `2 more that need you are hidden by the
filter or the fold` (`1 more that needs you is hidden by the filter or the fold`), or with none
shown `2 that need you are hidden by the filter or the fold`; clear the filter (Esc) or unfold
Earlier. While a dialog is open it says `close the edit first (Esc)` and selects nothing.

**Several windows** show the same marks, the same count and the same title, but for what each
lists (the done sessions it shows); Ctrl+Shift+J follows each window's own filter and fold. A
session seen in one window is seen in all of them.

**Desktop notifications.** At the right of the title bar, `Turn on notifications` shows until Edge
has your answer. Click it once: Edge asks whether the page may show notifications (its own
prompt). Allow, or Block: either way the button goes, and it comes back only when that answer is
reset in Edge's settings for the site. Closed without an answer, the prompt leaves the button
there. When Edge or the company's policy refuses (the button is not there at all, or it goes at
once without a prompt), or you chose Block, nothing else changes: the count in the title bar and
`(3) skydeck` on the taskbar still show what needs you.

The window's own Edge profile (its profile folder, above) keeps the answer, not your own Edge's,
and keeps it per address: after a change of `window.port` the button shows again. To see or
change it, open a normal Edge window on that profile folder, as manual check W13 does, in
PowerShell (with the folder `skydeck doctor` names):

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir="C:\Users\<you>\AppData\Local\skydeck\edge-profile"
```

and in its address bar `edge://settings/content/notifications`; close that window afterwards, the
skydeck window stays. Windows' own Settings › System › Notifications › Microsoft Edge turns
notifications off for every Edge window, yours too.

With notifications allowed, a session that **starts** to need you while no skydeck window has the
focus shows one desktop notification: its title is the session's title, its text `asks: <detail>`
(`asks` without a detail), `finished` or `ended unexpectedly`. It goes to one window, the one that
had the focus last. None comes while you work in a skydeck window (the marks and the count say it
there), none when its reason only changes (it asked, then finished), and none for what already
needed you when the window's server started. A newer notification of a session replaces the older
one, and the page closes a session's notification once that session no longer needs you. A click
on one brings the window to the front and selects the session. While a dialog is open it only
brings the window to the front, and the key bar says `close the edit first (Esc)`. A session the
list does not show (the filter, the folded Earlier) and that has no terminal in the window is not
selected: the key bar says `that session is hidden by the filter, the fold or a closed block`. A
session that a closed block hides is selected, terminal or not, and its block opens — but not one
that no longer needs you, has no terminal in the window and sits in a closed block (the window
cannot know a closed block's sessions): that click is refused with the same line; open the block
to see it. Whether a
notification pops up is also Windows' own business (its Do not disturb, its settings for Edge),
which skydeck does not touch.

Nothing is installed for any of this: turn ends are read from Claude Code's own files, so the hook
entries stay as they were, `skydeck install` is not run again, and `skydeck doctor` says what it
said before.

#### Restore after a restart (stage C)

When WSL stops — `wsl --shutdown`, a restart of the PC, or WSL's own stop after its last client
("Keeping WSL running" above) — every `claude` of the window ends with it. The window, an Edge
window, stays (not after a PC restart) and says `skydeck's server is not answering (since …)`. In
a WSL terminal of your own, run `skydeck window`:

- It starts the window's server. When the server before it ended while a window was open, the new
  server expects that window back: the command says `skydeck: waiting up to 7 s for the open
  window to come back; --new-window opens one now`, and once the old window has connected again,
  `skydeck window: a window is already open`; it opens no second one. When none comes, it opens a
  window after the wait. After a PC restart with the window left open it can wait those 7 seconds
  for a window that cannot come, then it opens one.
- The old window says `WSL has restarted since <time>: the sessions that were running have ended.`
  (`<time>`: when it lost the old server).
- **The banner**, at the top of the list, offers the sessions that `skydeck restore` offers
  (design.md 7.8): every session of the last boot before this one that ended unexpectedly, not done
  — those still open when WSL stopped, and those that had ended unexpectedly earlier in that boot.
  `Before the restart (last activity today at 18:02) 3 sessions were open`, then a checkbox per
  session, `<short id>  <title> · no exit recorded` (or `· ended 17:58`, with `· was working` after
  it when a turn was cut off), ticked as `skydeck restore` preselects them (those still open, and
  those that ended within two minutes of that boot's last event; the others are listed unticked),
  and the buttons `Restore 3` (the number counts the ticked ones) and `Not now`. The time reads
  `today at 18:02`, `yesterday at 18:02`, `on 12 Nov at 18:02` or `on 12 Nov 2025 at 18:02`, in the
  page's (Windows') time zone, and follows the clock: `today` becomes `yesterday` at midnight.
- **`Restore 3`** starts the ticked sessions as `skydeck restore` does — each through the same
  checks, `restoreBatch` at a time, the memory check before each batch — but in the window: they
  show under Open as `starting…`, then run, each in the next free slot. Nothing is selected and the
  keyboard stays where it is, in every window. A double click acts once.
- **The report**, under the banner's place, shows the lines of the run as they come, those that
  `skydeck restore` prints: `started <short id> <title>`, `timed out <short id> <title>`, `failed
  <short id>: <why>`, `not started <short id> <title>`, a `stopped: …` line when the run stopped,
  and last one line `restore finished: 3 started` (the counts of `started`, `timed out`, `failed`
  and `not started` that are not 0; `restore finished: nothing was started` when all are). While
  the run goes, the banner shows `A restore is running.` in place of its buttons, and its
  checkboxes are disabled. The report keeps the last 200 lines; once it has ended, its × removes
  it. Every open window shows it, also for a restore that `skydeck restore` asked for. When a run's
  last line never reaches the page (the connection dropped, the server stopped), the report ends at
  the next list with `the end of this report did not arrive; the list shows what started`. The
  banner and the report take at most 40 % of the list's height and scroll inside it; they resize no
  terminal.
- **One restore runs at a time**, whoever asked: another one, from a window or a command, is
  refused with `a restore is already running; wait until it has finished`.
- **What stops a run**: too little memory before a batch (`stopped: only <n> MiB of memory
  available, less than restoreMinFreeMb (<m> MiB)`, as in step 1); a batch in which no session
  started while sessions are left (`stopped: no session of this batch started`: a `claudeCommand`
  that the server cannot start would otherwise open a terminal for every session); a busy database
  (`stopped: skydeck's database is busy; press Restore again (or run skydeck restore) for the
  rest`). After the first two, the sessions it did not open are reported `not started`. A session
  whose terminal in the window ended before its start was reported is `failed` at once.
- **A restore started from the banner cannot be stopped in the window**: `skydeck window --stop`
  ends it (`stopped: the window's server is stopping`); the sessions it already opened go on
  starting, the rest are `not started`. One that `skydeck restore` asked for stops with Ctrl+C in
  its terminal, as in step 1.
- **`Not now`** hides the banner for this restart, also across `skydeck window --restart`;
  `skydeck restore` still offers the sessions, and so does the quick switcher (stage E: `>restore`,
  "The quick switcher (stage E)" below); the banner comes back after the next restart.
  When the offer changed meanwhile, it says `this offer to restore is no longer shown`.
- **The settings are the server's.** A restore in the window uses the `restoreBatch`,
  `restoreMinFreeMb`, `restoreStartTimeoutSeconds` and `claudeCommand` that the server read when it
  started, and its sessions get the server's environment ("Starting it" above): after a change of
  `config.json`, run `skydeck window --restart`.

#### Starting sessions in the window from a terminal (stage C)

`skydeck resume <ref> --window` and `skydeck new --window` (with `--label`, `--group` and `--
<claude flags>` as always) ask the window's server to start the session in the window, as the
window's own Resume and New do: through the same checks, with the same refusals and exit codes
(`skydeck: <short id> is running (pid <n>)` or `skydeck: this session is already open in the
window`: exit 4; what `skydeck new` refuses: exit 2). The command prints on stderr the lines
`skydeck resume` or `new` would print (such as `skydeck: original flags unknown; resuming with
defaults`), and exits with its code. `--here`, `--tab` and `--window` exclude each other: two of
them are a usage error, exit 2 (`skydeck: --here and --window cannot be used together`).

- **It never starts the window's server**: run `skydeck window` first (the lines when it is not
  running are below). A server of this checkout is used also when it runs an older build; one from
  before stage C cannot take the request (below).
- **A session started so gets the server's environment, not your shell's**: that of the shell
  `skydeck window` ran in ("Starting it" above; `skydeck doctor` names it). To change it, run
  `skydeck window --restart` from the shell you want.
- In the window the session is listed under Open, in the next free slot. Nothing selects it, and
  the keyboard stays where it is.
- **When no window is open**, the command opens one after the server's answer, as `skydeck window`
  does (the 7-second wait above included) — not after a usage or reference error (exit 2 or 3),
  which started nothing. A window that cannot be opened is one line, `skydeck: the window could not
  be opened: <reason>; run skydeck window`, and the exit code stays the answer's.
- **Inside a Claude Code session** (a `!` command, or Claude Code's own tools) it never opens a
  window, as `skydeck window` does not run there either. It can still start the session in your
  window while the server runs, and with no window open it says `skydeck: no window is open; run
  skydeck window in a terminal of your own`. So an agent's shell can start a session in your
  window.

**`"terminal": "window"`** in `config.json` (create the file as `{ "terminal": "window" }` when
there is none) makes the window the place for every command:

- `resume` and `new` with no option, and with `--tab`, go to the window; `--here` still starts
  `claude` in this terminal. With `"here"` or `"wezterm"`, only `--window` goes to the window.
- `restore` looks for the window's server before anything else, so that `skydeck: the window is
  not running; run skydeck window first` comes before its list and its question. It then lists and
  asks as in step 1, opens a window first when none is open (so that the sessions start at the
  window's size, and a question Claude Code asks at its start can be answered there; a window that
  cannot be opened is its one line, and the restore goes on), and hands the chosen sessions to the
  server, which runs them as the banner's Restore does. It prints each line
  of the run on stdout as it comes, and `waiting for <n> sessions` when nothing else came for 10
  seconds; after 30 seconds without a line, `skydeck: the window's server stopped answering; run
  skydeck to see what started`, exit 1. The exit code is the run's (design.md 7.8): 0; 1 when a
  session failed, timed out or was no longer offered, or the run could not go on (a busy database);
  5 when it was stopped (for memory, after a batch in which no session started while others were
  left, by the server's stop); with 5 its last line is `skydeck: restore stopped before it
  finished; see above`. Ctrl+C ends the command at once, and the server then stops the run that it
  asked for: the window's report says `stopped: the command that asked for it stopped`, and the
  sessions already opened go on starting. `--dry-run` asks the server nothing.
- `R` in the interactive list asks the server to resume the session: `opened <short id> in the
  window`, with `; no window is open; run skydeck window` after it when no window is open (`R` opens
  none); a refusal is the message line; a start that failed says `starting <short id> in the window
  failed; the details are printed when the list ends`.
- `skydeck doctor` says `ok       terminal: window (sessions start in the skydeck window; resume,
  new and restore need skydeck window to run)`.
- A value other than the three is refused as every mistake in the file: `skydeck:
  /home/you/.config/skydeck/config.json: "terminal" must be "here", "wezterm" or "window"`.

**When the window cannot take it**, the command starts nothing itself and exits 1 with one line
(`restore` and `R` leave out the ending `, or use --here`, and `; use --here`):

| When | The line |
|---|---|
| No server runs | `skydeck: the window is not running; run skydeck window first, or use --here` |
| The server does not answer | `skydeck: the window's server (pid <n>) does not answer; skydeck window --restart stops it` |
| It is still starting after 5 seconds | `skydeck: the window's server (pid <n>) is starting and did not finish within 5 s; run skydeck window again, or skydeck window --restart to replace it` |
| It runs from another checkout | `skydeck: the window's server runs from <checkout>, not from this checkout; skydeck window --restart here replaces it, or use --here` |
| It is of a build before stage C | `skydeck: the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it, or use --here` |
| It is stopping | `skydeck: the window's server is stopping; run skydeck window, or use --here` |
| It is still starting after 30 seconds | `skydeck: the window's server did not finish its start within 30 s; it started nothing: run skydeck window again, or use --here` |
| No answer within 30 seconds | `skydeck: the window's server did not answer within 30 s; it may have started the session: run skydeck to see whether it runs` |
| It failed while it answered | `skydeck: the window's server failed while it answered the request (500: failed); it may have started the session: run skydeck to see whether it runs` |
| The connection broke after the request reached it | `skydeck: the window's server cannot be asked on <socket> (<code>); it may have started the session: run skydeck to see whether it runs` |
| A label or group over 1,024 bytes, or a request over 64 KiB (a long prompt after `--`) | `skydeck: the window's server refused the request (<kind>); use --here` |

For `restore`, 30 seconds without a line is the `stopped answering` line above, a failure while
the server answered ends `(500: failed); run skydeck to see what started`, and a connection that
broke before the first line ends `it may have started the restore: run skydeck to see what
started`.

**`skydeck show <ref>`** marks a holder that is the program of a terminal of the window, or runs
under it: `holder:    pid 4242 since 2026-11-12T08:58:00.000Z (in the skydeck window)`. It needs no
running server and asks it nothing; `--json` is unchanged.

#### Search, the chips and blocks (stage E)

**The filter** is the field at the top of the list, `Filter: title, group, note, PR, directory,
short id   /` while it is empty. A click into it, or `/` while the list has the keyboard
(`Focus: list`), gives it the keyboard: its border takes the selection's colour and the caret
blinks in it. What you type there is text, and the list follows each keystroke; but Enter ends
the entry and gives the keyboard back to the list, Esc does the same and clears the field, Tab
goes on to the chips below, and the window's keys (its Ctrl+Shift chords and Ctrl+Tab) and the
reload keys act as anywhere, but Ctrl+Shift+V, which pastes into the field as the browser does. With the keyboard on the list, Esc clears the filter, and the next Esc goes to the
terminal.

- **Words.** The text is split at white space into words, and a session is listed when every
  word, in any order and in either case, is found in one of its fields: the title, the group, the
  note, the directory, or an attached pull request (`owner/repo`, its number, or
  `owner/repo#number`). `orb login` lists a session titled `ORB-2107 fix login`, and `web#7` one
  with `acme/web #7` attached. A word is never found across two fields.
- **The short id.** A word of at least 4 characters also lists the session whose id starts with
  it: the first characters of the short id in the header (or in `skydeck ls`'s last column), or
  the whole id. A shorter word is looked for in the fields only, so that `fix 2` does not list
  nearly every session through the digits of its id.
- **While filtering** — a word in the field, or one of the chips below but `Show done` — done
  sessions are listed too, with their `done` mark; every section is unfolded and every block flat
  (below); the footer `17 done hidden · show` is not shown; and nothing folds: ← and → do nothing,
  nor does a click on Earlier's header. A filter that leaves no session says `No session matches
  the filter.` A text of white space only is no filter. The title bar's counts, the `need you`
  count and `(3) skydeck` do not change with the filter: they count what the list lists without
  it.

**The chips**, under the field: `Running` (the sessions under Open), `Open PR` (those with a pull
request that is not merged or closed: open, draft, `not fetched` or `can't read`), `Has note`, and
`Show done`. A click turns one on or off, drawn pressed while it is on, and leaves the keyboard
where it was. Every chip that is on must hold, with every word: `Running` with `Has note` lists
the running sessions that have a note. `Show done` is the same switch as the list key `a` and the
footer's `show` (`done sessions shown · hide`): each turns the others on and off, and it shows
done sessions without filtering. Esc clears the words, not the chips: a chip stays on until it is
clicked again, the page reloads, or the switcher (below) clears it to show a session it hides.
The chips are buttons: Tab from the field reaches them, Enter or Space presses the one that has
the keyboard, and while one has it no list key acts.

**Blocks.** In every section — Open, Recent and Earlier —, each on its own, the sessions of one
group sit together as a block when there are at least two: under Open only running ones, under
Recent only recent ones (not running, last active in the last 7 days), so a group with sessions
in two sections is two blocks. Every session of the group is in its block, one that has a
terminal of the window and one that needs you too. A block sits where its first session sits in
the section's order (under Open: by slot), and the others follow it in that order, indented, so
the slot numbers under Open can run `1 3 2`. That first session is the block's head: it shows
`×4` after its ticket key (or its group). A block is open until you close it. Closed, it shows
only its head and the line `+3 more in ORB-2107`, which is no row: it is never selected, and ↑
↓ pass over it and the sessions it hides. When sessions it hides need you the line says so, `+3
more in ORB-2107 · 1 needs you`, that part in the colour of the title bar's `need you` count;
the head's own mark is on its row, and the title bar counts the same whether a block is open or
closed. A group is its exact text: `ORB-1` and `orb-1` are two. A session whose group no other
session of its section has, or that has no group, is listed as before. A section's count counts
every session in it, those of a closed block too.

- A click on `×4` closes or opens the block, and a click on the `+3 more` line opens it. A click
  selects nothing and leaves the keyboard where it was. While a session of the block other than
  its head is selected, a click on `×4` does not close it: the selection, the keyboard and the
  right side stay, and the key bar says `this block holds the selected session; it stays open`
  (← in the list closes it, selecting the head first). A double click on either acts once.
- In the list (`Focus: list`): ← on the head or on another session of an open block closes it (on
  another session it selects the head first), → on a closed head opens it. Otherwise ← and → fold
  and unfold Earlier as before: on a session in no block, and also ← on a closed head and → on an
  open head or on another session of a block.
- A block you closed stays closed until you open it or reload the page, also when its sessions
  leave and the block forms again later.
- A closed block opens by itself while one of its sessions other than its head has a terminal of
  the window whose program has not reported its session yet (a start, or a program that ended
  before it reported, until you close its terminal), so that its row and its slot number show and
  its slot chord reaches it; it then stays open. While such a session holds it open, ← and a click
  on `×n` do nothing, and the key bar says why: `this block holds a session that is still
  starting; it stays open` while its terminal may still start (wait, and the block can be closed
  once the session is known), or `this block holds a terminal that ended at its start; close it
  first` when its program ended before its session was known (select that session and press
  Close on its ended bar).
- Whatever selects a session that a closed block hides opens the block, and it stays open when
  the selection leaves, until you close it again: Ctrl+Shift+1–9 on its slot, Ctrl+Shift+J when it
  needs you, a click on its notification, a pick in the switcher, a resume that brings it, or a
  newer session of its group that makes the selected one a hidden member. Ctrl+Tab skips a session
  a closed block hides when no terminal of the window holds it (the page does not know a closed
  block's sessions), as it skips a session that the filter or the folded Earlier hides and that no
  terminal of the window holds; one that a terminal of the window holds it selects, and its block
  opens.
- `d` on a closed block's head marks that session only: the next one becomes the head (or the
  last one stands alone), and the selection goes to the row after the block (stage D's rule takes
  the row after it among those the list drew, and the block's other sessions were not drawn).
  With done sessions shown the session stays listed, still the head, and stays selected.
- While filtering, every session stands alone.

(Until 2026-11-16 only Recent and Earlier stacked, closed by default, and running sessions
never did; the owner asked for blocks in every section, open by default.)

Each window has its own filter, chips, closed blocks, folded Earlier and done shown. A reload (F5)
forgets all of them: the page starts again with an empty filter, no chip on, Earlier folded, done
sessions hidden and every block open. What a window shows of a session is the same in every
window.

#### The quick switcher (stage E)

**Ctrl+Shift+P**, or `Switch…` at the right of the title bar (the key bar's hint is `Ctrl+Shift+P
switch`), opens the quick switcher over the window: a field with the keyboard in it, `Switch to a
session…  (title, group, note, PR, directory, short id)` while it is empty, and under it every
session the list lists with done ones shown — also those that the filter, the chips, the folded
Earlier or a closed block leave out of the list — under those of four headings that have a
session: `Needs you` (in Ctrl+Shift+J's order), `Open` (in Open's order, the slots first), `Not
running` (the most recent first) and `Done` (the done sessions that are not running, the most
recent first). Each session
shows its title, its state (`not running · 3h` for one that is not running) and its directory,
its pull-request chip, its slot and, at the right, its short id. Type to narrow it: the words
are the filter's (each must be found in a field, or, with at least 4 characters, start the id),
and the words found are marked in each title. At most 50 sessions are listed; the footer then
says how many more match: `… · 3 more: type to narrow`.

In its field ↑ ↓ move the highlight, PgUp and PgDn by a page; Enter acts on the highlighted
session; Esc, or Ctrl+Shift+P again, closes the switcher, and the keyboard goes back where it
was; Tab and Shift+Tab do nothing; every other key is text (Ctrl+Shift+V too, which pastes as
the browser does). The footer names the keys and what
Enter does to the highlighted session: `↑ ↓ move · Enter switch · Esc close` for a session that
has a terminal of the window or runs in another terminal, `↑ ↓ move · Enter resume here · Esc
close` for one that has neither — a session that is not running, or one whose program runs
without skydeck knowing where (step 1's resume then refuses it). A click on a session does what
Enter does (a double click acts once); a click outside the panel closes the switcher.

**Enter** closes the switcher, selects the session and does what Enter on its row in the list
does:

- a session with a terminal of the window: its terminal shows and takes the keyboard (an ended
  one under its bar);
- a session that runs in another terminal: its card, and the list has the keyboard;
- every other session (`Enter resume here`): it is resumed into the window, the list has the
  keyboard until its terminal comes and takes it. A refusal (an expired session's, for one) shows
  on its card, or in the key bar when the list does not show the session.

When the list does not show that session, the list first changes so that it does, by what hides
it: the filter's field and the chips are cleared (the key bar says `the filter was cleared to
show <short id>`), done sessions are shown, Earlier is unfolded; a closed block opens by itself
for its selected session.

Enter acts only on the answer to what you typed: pressed right after a keystroke, it waits for that
answer (usually a fraction of a second) and then acts on the highlighted session of it, the first
one — the highlight goes to the first session of each new answer, and stays on its session while a
list only moves the sessions. Typing on, closing the switcher or a lost connection drops a waiting
Enter. While the page is not connected the switcher says `skydeck's server is not connected` in
place of its sessions, and Enter does nothing. When no session matches it says `No session matches.`

While the switcher is shown the window under it takes no click and no key. Every window chord but
Ctrl+Shift+P (and Ctrl+Shift+V, the field's paste) says `close the switcher first (Esc)` in the key
bar and does nothing else, Ctrl+Shift+H too (opening the switcher hides the key help); the reload
keys reload. While one of stage D's dialogs is open, Ctrl+Shift+P and `Switch…` say `close the edit
first (Esc)`. Each window has its own switcher.

**The restore offer** (stage C). After `Not now` on the restore banner, the switcher still offers
that restore until WSL restarts, in command form only: type `>restore` (or `>r`, `> rest`, `>
RESTORE`: a text whose first character is `>`, and after it at least the first letter of
`restore`; `>` alone lists nothing), and the
entry `Restore 3 sessions from yesterday at 18:02` is listed (the time as the banner says it),
while no restore runs. Enter on it, not a click (a click on it does nothing), restores the
sessions the banner had preselected, and the run's report shows where the banner's report shows;
the footer then says `↑ ↓ move · Enter restore · Esc close`. A text
that starts with `>` lists no session; without the offer it says `No command matches. > restore
is listed after Not now on the restore banner, until WSL restarts.` Every other text lists
sessions only (` >restore`, with a space first, looks for the word `>restore`), so the offer is
never one Enter away.

#### A selected session the list does not show (stage E)

When the list stops showing the selected session — the filter or a chip hides it, done sessions
are hidden again, or a filter is cleared while Earlier is folded and the session is in it (← and
a click on Earlier's header select the row above it before they fold) — no row is selected and
the list's keys act on none: `l`, F2, `g`, `n`, `p` and `d` say `no session selected`. When a
terminal of the window holds the session, the right side keeps it: the terminal with its header,
whose controls edit that session as usual (a click on the title, ✎, `Note`, `Done`, `Pull
requests`), and once its program has ended, the ended bar with Resume and Close. A session
without a terminal of the window shows nothing on the right then, no card. `Done` in the header
of such a session says `Marked done. Stays under Open while it runs; hidden once it
stops.` while it runs or starts, else `Marked done: hidden from the list. It comes back on new
activity.` The new form (Ctrl+Shift+N) starts in its directory while a terminal of the window
holds it. When the list shows the session again (the filter cleared), it is selected again.

#### The icon (stage E)

The page has an icon of its own, a deck of three session cards on a blue rounded square, the front
card white with a prompt (`>_`) on it, for
the window's taskbar button and its title bar; manual check W3 says whether Edge shows it there.
The page also has a manifest, for the icon: Edge's menu may offer to install the page as an app.
Do not: the window is opened by `skydeck window`, and the page is built not to be installable (its
manifest names no start address).

### Known limits of stage A

- **The keep-alive is not verified** (above; W14).
- **A second window** could open when `skydeck window` started a server while an old window was
  still open: after the server died or was stopped (`--stop`), or after a WSL restart. Since stage C
  the new server expects that window back and the command waits for it ("Restore after a restart
  (stage C)"); the cases that are left are in "Known limits of stage C". (After `--restart`, or an
  update that does not upgrade the database, the command waits for the open windows, so none opens
  then. An update by hand that upgrades the database can open one: close every skydeck window and
  tab before it, as "Updating by hand" says; `skydeck update` stops the old server first and needs
  no closing.)
- **Ctrl+C on a waiting `skydeck window`** leaves its launch address usable until its 30 seconds
  are over.
- **Another program on skydeck's port.** A program that listens on `127.0.0.1:<port>` on the Windows
  side, or inside WSL while no server runs, gets the window's page loads instead of skydeck's server
  (design-step-2.md, 15.3). An open window sends it nothing and says `something answers on port
  <n> that is not skydeck's server; nothing was sent to it`; a window opened meanwhile shows that
  program's page. Such a page can leave a service worker in the window's profile that keeps
  answering later loads: Chromium keeps it even when skydeck's server answers its script with 404
  (the page tests show it); whether Edge drops it is not known (W25). The way out: close every
  skydeck window, **delete the window's profile folder**, and run `skydeck window --new-secret`.
  `--new-secret` alone does not remove a worker.
- **A rebuilt screen.** After a server restart, or when a terminal is shown again after the page
  let it go (it keeps at most 8 attached), the screen is rebuilt from a snapshot. Not rebuilt: the
  scroll region, the saved cursor, the character sets and the tab stops; links written before the
  snapshot are not clickable after it (the rest of a link that was open comes out as plain text);
  underline styles and colours; and a few rarer cases (design-step-2.md, 7.2), among them a
  character cut off from the emoji it modifies at the moment of the snapshot, which takes a cell of
  its own. Most of it heals when the program draws that part again (W26).
- **Keys.** Ctrl+C with text selected in the terminal interrupts the program; Ctrl+Shift+C copies.
  On a keyboard layout whose letters are not Latin (Russian, Greek) the Ctrl+Shift letter chords,
  Ctrl+R and Ctrl+V are not recognised; US and Czech are not affected. A key pressed while the
  keyboard was outside the terminal never reaches the program, also when it brings the keyboard
  into the terminal (Enter on a row, Esc from the list) and is held: press it again.
- **Sizes.** A session started in the window (a card, the ended bar, the new form) starts at the
  size it keeps, with one exception: in a window that has not shown a session's header yet, the
  first terminal is asked for without the header's room, and it is resized once when it is shown.
  With several windows open, clicking into a window can give it the terminal's size while the
  program has asked for focus reports.
- **The list.** An expiring session says `expires soon`, without the number of days. From an empty
  filter field it is two Escs to the terminal. A resume card's warnings about flags (`original
  flags unknown; resuming with defaults`, flags not passed on) show until the terminal replaces
  the card, not after a successful resume. In one rare case
  (a click outside the list and, within a double click's time, a click on a row a list update has
  just moved under the pointer) that row is resumed as by a double click.
- **A flood of output.** When a program writes faster than skydeck can show (megabytes at once), a
  key pressed in that moment can be lost: press it again, Ctrl+C included.
- **A paste larger than the program takes.** While a program does not read its input, skydeck keeps
  only a few MiB of it waiting; what comes beyond that is not delivered, and the window says
  `this terminal is not taking input at the moment: not all of what you typed or pasted reached the
  program`. After a paste the program can then be
  left inside a bracketed paste (it takes what follows as pasted text, Enter included). skydeck
  cannot close the open paste. A new paste sends a new end marker, which a program that follows the
  bracketed-paste convention takes as the end; whether Claude Code does is not checked (W6).
- **A resume here of a session the window is starting.** A `skydeck resume` that starts `claude` in
  your terminal or a tab (not `--window`) of a session whose window terminal still shows
  `starting…` is not refused because of it: wait until it runs. (`--window` and `"terminal":
  "window"`, stage C, are refused then: `this session is already open in the window`.)

### Known limits of stage D

- **Two windows.** Label, group and done are last-write-wins between two windows, and between a
  window and a command, as between two commands. Only the note is guarded: a save over a note that
  changed meanwhile is refused, with your text kept in the box.
- **The toast's Undo has no key of its own.** It is a button: a click presses it, or Tab until
  it has the keyboard and then Enter. The toast is shown for 5 seconds, and the next toast
  replaces it. Once it is gone: `a` shows done sessions, then `d` on the session.
- **A long note** (over 64 KiB, 65,536 bytes of UTF-8) is edited with `skydeck note <short id>`
  only: its dialog says `this note is longer than the window edits; use skydeck note <short id>`.
  A label or group over 1,024 bytes is refused before it is sent (`the label is longer than skydeck
  takes: at most 1,024 bytes of UTF-8`).
- **Line breaks.** A note whose line breaks are CR or CRLF (another program wrote it) is saved
  with LF ones after an edit in the window.
- **Text in a dialog and a reload.** While a dialog holds changed text, closing the window, Edge's
  reload and the page's own reload when it reconnects to a server of another build (after an
  update) ask first, with Edge's own prompt; leaving loses the text. Staying after an update keeps
  the dialog and its text, but the page stays not connected (a save says `skydeck's server is not
  connected; try again`): copy the text, close the dialog (Esc; twice for a changed note), then
  press F5. Text typed between an F5 on an unchanged
  dialog and the reload is held back only by that prompt.
- **A busy database.** When the database was busy right after a save, a dialog opened then can
  start from the text before the save; a note saved from there is refused as changed elsewhere.
  Close the dialog and open it again.

### Known limits of stage B

- **Turns while no server runs.** A turn that ends while the window's server is not running, and
  every turn that ended before the update to stage B, is not recorded and never shows `finished`;
  neither does a turn so short that it starts and ends between two of the server's looks at Claude
  Code's files (it looks once a second).
- **Seen needs the window in front.** A session selected in a window that does not have the focus
  (behind another window, or on a second screen while you work elsewhere) is not seen, however long
  it shows there.
- **One notification, to one window**, the one that had the focus last, and only while no skydeck
  window has the focus. With no window open none comes, and none comes later for what happened
  meanwhile: the marks and the count are there when you open one. A browser tab of a
  `--print-url` address counts as a window: when it had the focus last, the notification goes to
  it, and it shows nothing unless that browser allows the page's notifications.
- **A notification keeps its first words** when its session's reason changes (it asked, then
  finished): only a start notifies. One that was shown before the page reloaded (after an update, or
  F5) is not closed by the new page; a session the filter or the folded Earlier hides keeps its
  notification until the list shows its row without a mark, or nothing needs you any more. A done
  session that has stopped never notifies, also when a window that shows done sessions marks it.
  What Windows does with a notification the page closes is manual check W11's.
- **What a notification shows**: the session's title and, for an ask, its detail, which may name a
  command or a path (W19). On a shared screen others can read it; judge for yourself whether to
  allow notifications there.
- **The first start of a stage B server.** A terminal of the window whose program ended
  unexpectedly while no server ran (its keeper waits up to 10 minutes for one) is marked `ended
  unexpectedly · not seen` by the next server, without a notification. At the first start of a
  server of stage B, which has no marks yet, that can be a session that ended before the update:
  its row shows `ended unexpectedly · not seen` once; select it, and it goes.

### Known limits of stage C

- **A window that connects during a restore** (opened or reloaded meanwhile) shows that one runs,
  and its report lines from then on, not the earlier ones.
- **A restore started from the banner has no Stop** in the window: `skydeck window --stop` ends it,
  and the sessions it opened go on starting.
- **`R` opens no window.** While it waits for the server's answer (up to 30 seconds while the
  server is still starting) the list draws nothing and takes your keys only after the answer. A
  line longer than the terminal is cut in the list's message line; `skydeck resume --window`
  prints it whole.
- **The waiting line names `--new-window`** also when `resume --window`, `new --window` or
  `restore` wait for the open window: that is an option of `skydeck window`.
- **The 7-second wait.** After a PC restart with the window left open, the first `skydeck window`
  can wait 7 seconds for a window that cannot come. A window that was minimised or hidden for more
  than 5 minutes is woken by Edge only once a minute (design-step-2.md 6.3), so it can come back
  after the command has opened a new one: close one of them. A server replaced within its own 7
  seconds (another `--restart`, a crash, another `wsl --shutdown`) no longer expects the window, and
  the next `skydeck window` opens a second one; so does a server that died within about 2 seconds
  of its first window's connect. When the server's start hangs, the waits add up (about half a
  minute before Edge is started).
- **The first update from stage A or B** can still open a second window once: their server keeps no
  mark of its open windows. Close every skydeck window first, as "Updating by hand" says.
- **A terminal whose keeper ended unexpectedly** (its bar says `the terminal's keeper ended
  unexpectedly; claude ended with it`): while its `claude` may still be running, for at most 60
  seconds, the window refuses to start the session again — Resume, `--window`, restore — with
  `<short id> is running (pid <n>)`. A `claude` that still runs after those 60 seconds and has not
  reported its start is no longer seen, and a start of its session then starts a second one.
  Closing the terminal, or restarting the server, ends the window's refusal sooner; then only the
  session's resume lock refuses, until 60 seconds after the launch. Wait a minute before you start
  such a session again.

### Known limits of stage E

- **How far search reads.** A word counts in its first 64 characters, and only the first 16 words
  of a text count: a longer filter is cut after its 16th word (the key bar says `the filter is
  cut to its first 16 words`), and the switcher's footer says `only the first 16 words are
  searched` (`only the first 1,024 bytes are searched` for a text over 1,024 bytes). Each field
  is searched in its first 16,384 characters (a long note in the first 16,384 characters of its
  text). Characters are counted as JavaScript counts them, in UTF-16 units: most emoji count as
  two.
- **The switcher lists at most 50 sessions**: type more to narrow it.
- **A title whose lower case is longer** than the title itself (a few letters such as `İ`) shows
  no marked words in the switcher.
- **A character you cannot see**, a zero-width space or a control character pasted into the field,
  is part of a word: a filter that looks empty, or like a plain word, can then list nothing. Clear
  the field (Esc) and type it again.
- **The `need you` count and a filter.** A done session that needs you and that a filter lists
  shows its mark, and Ctrl+Shift+J reaches it, but the title bar's count leaves it out (without
  the filter it is not listed), so the key bar's `… hidden by the filter or the fold` counts one
  too few for each such session.
- **`d` while filtering.** The toast says `Marked done: hidden from the list. It comes back on new
  activity.` while the filter still lists the session, with its `done` mark.
- **Blocks the window cannot close.** A block whose group is over 1,024 bytes (of UTF-8) cannot
  be closed: ← and its `×n` do nothing on it, and it stays open. A window remembers at most 64
  closed blocks: closing another opens the one closed first again.
- **A long group's `×n`.** The group before a head's title is not shortened, so with a group of
  about 46 characters or more the head's `×n` lies past the list's edge, where it cannot be
  clicked. ← and → in the list, and a click on the `+n more` line, still close and open the block;
  the line's ` · 1 needs you` always shows (the group is what gets shortened there).
- **The automatic pull-request refresh** (design.md 7.3) follows the sessions the list's
  sections show, and a selected session the list does not show while a terminal of the window
  holds it (its header shows its pull requests). So the sessions a closed block hides — under
  Open too — get no automatic refresh until you open the block (its head does), nor do the
  switcher's, as those of a folded Earlier never did: open the block, or use `↻` in the
  session's pull-request dialog.
- **A session that a terminal of the window went on in, and that ended before its first
  prompt**, has no transcript, so the list does not list it once its program has ended — for
  one, `/clear` in a resumed terminal (Claude Code goes on in a new session there), then `/exit`
  before any prompt. Selected, its ended terminal keeps stage A's bar, without Resume, and with
  Close only once the end is known. (A session started with Ctrl+Shift+N keeps its row while its
  terminal is there, with Resume on its ended bar.)

### What `doctor` says about the window

After the lines of step 1, `skydeck doctor` prints the window's. It starts no program for them but
`python3 --version`, nothing on Windows, signals nothing, never connects to a keeper and creates
nothing. Until the window's server has run once (skydeck's key is made then), every one of these
lines that would be a `problem` is `info`, so that an installation that uses only the commands is
judged as before.

| Check | A `problem` means |
|---|---|
| python3 | `python3` on `PATH` is missing, older than 3.9, or gives no version: the window opens no terminal. |
| `/usr/bin/python3` | It is missing or not executable: the server would run without the core limit that keeps it from writing crash dumps. |
| the window's server | Normally `info`: whether one runs, its pid, checkout, build, up time, pages, terminals, and where its environment came from. A problem when it runs another build of this checkout (`skydeck window --restart`), runs from another checkout, is alive but does not answer, answers its ping but not its status, or is starting and did not finish within 5 seconds. |
| port | Something that is not this installation's server listens on `127.0.0.1:<window.port>` inside WSL (`doctor` only reads `/proc/net/tcp`; a program on the Windows side cannot be seen from WSL). Stop it, or set `window.port`. |
| launch alarm | A launch address was used twice, so another program may have skydeck's key: run `skydeck window --new-secret`. |
| keep-alive | A server or a terminal runs and neither the keep-alive nor `instanceIdleTimeout=-1` is in effect (above). |
| interop | `WSL_INTEROP` is not set in this shell (it cannot start Windows programs), or `<runtimeDir>/interop`, the link the sessions' Windows programs (an image paste) go through, points at nothing that answers: `skydeck window --restart`. |
| the C: drive | It is not mounted at `/mnt/c`. |
| Edge | `window.edge` does not exist or is not a file. |
| profile folder | It cannot be found and `window.profileDir` is not set. |
| runtime directory | The directory of the server's and the keepers' sockets is not yours or not mode 700, or a socket path in it would be 108 bytes or longer. `info` when `XDG_RUNTIME_DIR` is passed over because you do not linger (`loginctl enable-linger <you>` makes it usable). |
| vendored files | A file of `vendor/MANIFEST.json` is missing or changed: a broken checkout (`git status`). |
| keepers | Never a problem: how many terminals run, and one line each. |

### Updating while the window runs

In a WSL terminal of your own:

```sh
skydeck update --check
skydeck update
```

`--check` only looks: it lists what is new and changes nothing else; the window and the sessions
stay as they are. `skydeck update` brings the checkout up to date and restarts the window's server
for the new code, and the window stays open: it says for a few seconds that the server is not
answering, then reloads itself for the new page and connects again, and the command waits up to 7
seconds for it, so it opens no second window. Sessions keep running; every terminal's screen is
rebuilt (see "Known limits"). Keepers that run keep the code they started with; new terminals get
the new keeper. No `npm ci`, no `skydeck install`. "Updating" below says what each line means,
when the command refuses and what to do then.

By hand — for a checkout that does not have `skydeck update` yet, or when it refuses —:

```sh
cd ~/skydeck
git pull
skydeck window
```

The commands run the new code at once, as before. The server keeps running the code it started
with until `skydeck window` finds that it is of another build and restarts it, with the line of
"Starting it" above, and waits up to 7 seconds for the open windows in the same way.

The update that brings stage D resizes every terminal of the window once, when a window first
shows it after the update: the header is two lines taller than stage A's (one for the pull
requests, one for the note), so the terminal under it gets a little less room, and Claude Code
redraws its screen, as at any resize. From then on the header has one height for every session,
and editing never resizes a terminal.

An update that upgrades the database is different when you update by hand: close every skydeck
window and tab first ("Updating by hand" below). A command of the new code that upgrades the database while
the old server still runs makes that server stop by itself (its windows say that it is not
answering), and the `skydeck window` that follows can open a second window beside the old one.
`skydeck update` needs no closing for it: it stops the old server before any code of the new
commit opens the database, and it says when an update may upgrade the database.

The update that brings stage B is one of them: close every skydeck window and tab, then `git
pull`, then `skydeck window` ("Updating by hand" below). Nothing is to be installed again: stage B adds no
hook entry (turn ends are read from the files Claude Code keeps), so `skydeck install` is not run
again and `skydeck doctor` says what it said before. It resizes no terminal: the header keeps its
height. Then click `Turn on notifications` once ("Which sessions need you (stage B)" above).

The update that brings stage C installs nothing either and resizes no terminal. From it on, the
server keeps a mark of its open windows, so that `skydeck window` after a WSL restart waits for the
old window instead of opening a second one; the server it replaces keeps none, so close every
skydeck window and tab first for this update too, as for stage B. The banner shows only after WSL
or the PC restarted; to have every command start in the window, set `"terminal": "window"`
("Starting sessions in the window from a terminal (stage C)" above).

The update that brings the terminal's frame (softer lines around the terminal, and a margin
between the terminal's text and the list, the header and the key bar) resizes every terminal of
the window once, when a window first shows it after the update: the margin takes a little room (at
a window of 1400 × 900, about two columns and one row), and Claude Code redraws its screen, as at any
resize. It installs nothing; from then on the terminal's size changes only with the window's.

## Checking: `skydeck doctor`

`doctor` prints one line per check, `ok`, `info` or `problem`, and exits 1 when any line is a
problem. It does not read new sessions in and creates nothing, so it can run on a broken
installation.

| Check | A `problem` means |
|---|---|
| hook entries | `SessionStart` or `SessionEnd` has no entry in the settings file that is exactly what install writes for `<dataDir>/skydeck-hook`. Run `skydeck install`. |
| the hook link | `<dataDir>/skydeck-hook` does not resolve to a file. Run `bin/skydeck install` from the checkout. |
| Node.js | The Node.js that runs `doctor` is older than 24.12. |
| database | The database does not exist (run `skydeck install`), cannot be opened, or is not writable. |
| spool, last event | `info`: how many hook events wait to be read, and how long ago the last one came. A problem only above 1000 waiting files. `no events yet` is normal until the first session starts after the install. |
| `spool/bad` | Hook files that could not be read are kept there for seven days, then removed. The line gives their count and age. |
| `hook.log` | `info`: its last five lines. The hook writes there when it had to drop an event. |
| scripted runs dropped | `info`: how many events of scripted runs (print mode, SDK hosts, editor extensions) were dropped; they are not sessions a person works in. A scripted run that holds a session skydeck knows is not dropped (see "If something goes wrong"). |
| last refresh | Something was skipped at the last command: a hook file, a process, or a transcript folder or file that could not be read. The line says what and why. |
| Claude Code's folders | `<claudeHome>/sessions` or something under `<claudeHome>/projects` cannot be read. A folder that does not exist yet is only `info`. |
| `gh` | `gh` is not installed, or not logged in, or GitHub cannot be reached. Run `gh auth status`. |
| terminal | With `"terminal": "wezterm"`: `wezterm cli --no-auto-start list` failed. Is a WezTerm window open? With `"here"` the line is `ok`, and with `"window"` too: `terminal: window (sessions start in the skydeck window; resume, new and restore need skydeck window to run)`; whether the server runs is the window's server line. |

## Updating

In a WSL terminal of your own (not a `!` command inside Claude Code):

```sh
skydeck update --check
skydeck update
```

`skydeck update` brings the checkout it runs from up to date with the branch of a remote that its
branch follows, and restarts the window's server for the new code. In this order:

1. **It looks.** The checkout must be a git checkout of its own, on a branch that follows a branch
   of a remote (`origin/main`), with no change to a tracked file that is not committed (files git
   does not track do not count). Then `git fetch` from that remote, in your terminal: a passphrase
   prompt works, and Ctrl+C ends it with nothing changed. Then what is new, newest first, at most
   20 commits (then `… and <n> more`):

   ```
   3 new commits on origin/main (1a2b3c4..5d6e7f8):
     5d6e7f8  the newest commit's subject
     4c5d6e7  the one before
     3b4c5d6  the oldest new one
   ```

   The ids are the first 7 digits of each commit's id, for reading only; the update itself uses
   the whole id. When the new commits change `src/store/migrations.ts`, one more line says so:
   `this update changes the database's upgrade steps: it may upgrade the database, and an upgraded
   database cannot be opened by an older checkout` (see "There is no way back" below). With
   nothing new it says `skydeck is up to date (main at 1a2b3c4, as origin/main)` and does nothing
   else: no server is looked at, stopped or started.
2. **`--check` ends here**, with `run skydeck update to apply it`. Its fetch has changed the
   checkout's remote-tracking refs (`origin/main`) and nothing else: not your files, not your
   branch, not the window or the sessions. It also works inside Claude Code.
3. **It stops the window's server** of this checkout (`skydeck: stopped skydeck's window server; 2
   terminals in the window keep running`), then **moves the branch forward** to the commit it
   listed (a fast-forward, never a merge commit), then, when a window was open, **runs the new
   checkout's `skydeck window`**: that upgrades the database when the new code brings a new
   version of it, starts the server of the new code and waits up to 7 seconds for the open window
   (`skydeck: waiting up to 7 s for the open window to come back; …`), which reloads itself and
   connects again (`skydeck window: a window is already open`). When no window was open it starts
   nothing and says `skydeck: the window's server was stopped for the update; skydeck window starts
   it again`. Last, `updated to 5d6e7f8`.

The look and the fetch can be ended with Ctrl+C: nothing is changed. **Once the stop of the
window's server has begun — or the fast-forward, when there is no server of this checkout to stop —
Ctrl+C (and a `kill`) no longer end the command**, so that it never leaves the server stopped or
the checkout being written without a word. One that comes during the
stop ends it there: no fast-forward, the window brought back on the code it had (when it was open),
and `skydeck: interrupted before the update was applied; the checkout was not changed` (exit 1).
One that comes later changes nothing: the fast-forward runs to its end (git runs it, and every look
at the checkout after it, in a session of its own, which Ctrl+C does not reach), and so does the
rest. (After a Ctrl+C the shell shows exit status 130 whatever the command printed: the launcher,
`bin/skydeck`, ends with 130 on Ctrl+C once node has ended. Its lines say what happened.) A
terminal closed in the middle ends the command (there is no one left to read what it would say),
but never cuts the fast-forward, which ends by itself: what is left is at worst a stopped server.
In a new terminal, in the checkout, `git status`: no changed file (files git does not track do not
count) and `Your branch is behind '<upstream>' by <n> commits`, the update was not applied —
`skydeck window`, then `skydeck update` again; no changed file and `Your branch is up to date with
'<upstream>'`, it was — `skydeck window`; otherwise see "the checkout may not be as it was"
below.

Each commit's line shows its subject's first 200 characters (a longer one ends with `…`).

The window may stay open, also for an update that upgrades the database: the old server is stopped
before any code of the new commit opens the database, so no old server is left to stop by itself
under it, and the window that was open is the one that comes back. A window whose key could not be
stored (Edge's storage for the page off) cannot reload itself: it says `this window's page is not
the one skydeck's server serves, and its key could not be stored, so it cannot reload itself; run
skydeck window again`. The `skydeck window` the update runs is that run: after its 7 seconds it
opens a new window; close the old one (its ×). The new server gets the environment of the shell you typed
`skydeck update` in, as with `skydeck window` ("Starting it" above): run it from a plain shell.
A window that was not open is never opened; one that does not come back within the 7 seconds is
replaced by a new one, as `skydeck window` does.

A server of another checkout is left as it is (`skydeck: the window's server runs from another
checkout (<path>); it is left as it is`), and so is the server when the database was written by a
newer skydeck (`skydeck: the database was written by a newer skydeck, so the window's server is not
looked at; it is left as it is`): the update goes on, and no server is stopped or started.

When it refuses, it says why in one line and changes nothing (exit 1):

| It says | What to do |
|---|---|
| `skydeck update is not run from inside a Claude Code session: …` | Run it in a WSL terminal of your own. `skydeck update --check` works anywhere. |
| `git was not found on PATH; skydeck update needs it` | Install git (`sudo apt install git`), or update the way you installed. |
| `<path> is not a git checkout; update it the way it was installed` | The checkout is not a clone of its own (a copy, a download, a folder inside another repository): update it the way you got it. |
| `this checkout is not on a branch (detached HEAD); update it with git yourself` | `git switch main`, then `skydeck update` again; or by hand. |
| `the branch <name> follows no branch of a remote; update it with git yourself` | `git branch --set-upstream-to=origin/<name>`, then again; or by hand. |
| `this checkout has changes that are not committed (<n> files, the first: <path>); commit or undo them first` | `git status` shows them: commit them, or undo them (`git restore <path>`), then again. |
| `git fetch from <remote> failed (git's own message is above); nothing was changed` | git's own message above it says why (the network, a login). Then again. |
| `this checkout changed while git fetch ran (<branch> at <id>); run skydeck update again` | The branch was switched, or a commit made, while the fetch waited (at a passphrase prompt, say): `skydeck update` again. |
| `this checkout has <n> commits that <upstream> does not have; update it with git yourself` | Commits of your own: push, rebase or drop them with git, then again. |
| `this checkout's git index is locked (<path>): another git command runs in it, or one was cut off and left the file; nothing was changed` | When a git command of yours runs there (an editor's git too), let it end, then again. When none runs, the file was left by one that was cut off: remove it (`rm <path>`), then again. |
| `the window's server (pid <n>) does not answer; skydeck window --restart stops it; nothing was changed` (or the line for a server that is starting) | `skydeck window --restart`, or wait for its start, then again. |
| `git <command> failed: <git's line>; nothing was changed` | git's line says why; `git status`. |
| a line of the window's server or of the database, then `; nothing was changed` | As that line says, then again. |

More ends, each with exit 1:

- `<why the server could not be stopped>; the checkout was not changed`: the server was asked to
  stop, or sent a signal, and did not end. `skydeck window --restart`, then `skydeck update` again.
- `interrupted before the update was applied; the checkout was not changed`: Ctrl+C (or a `kill`)
  came while the server was being stopped (above). `skydeck update` again when you want it.
- `the update could not be applied: <git's line>; the checkout is as it was`: git refused the
  fast-forward and changed nothing — most often a file git does not track is where the new commit
  puts one of its own — and the window was brought back as it was. Move the file away, then
  `skydeck update` again.
- Either of the two lines above can go on with `, but skydeck window ended with exit <n>; run
  skydeck window` (or `, but skydeck window could not be started or was ended by a signal; run
  skydeck window`): the window was to be brought back, and its `skydeck window` did not do it (its
  own lines above say why). The checkout is as the line says; run `skydeck window`.
- `the update could not be applied: <why>; the checkout may not be as it was: set it right as
  docs/install.md says ("Updating"), then run skydeck window`: the command could not tell that the
  checkout is as it was, and the window is not brought back on it. **Read `<why>` first, before you
  run any command that writes**, in a WSL terminal of your own, in the checkout:
  - **`<why>` is one of the command's own three** — `git merge timed out` (after 60 seconds), `git
    merge was ended by a signal`, `git merge ended, but HEAD is not at <id>` — **or git's line says
    that it could not write, create or remove a file or folder**, whatever its first word
    (`error: unable to write …`, `warning: unable to unlink …: Permission denied`, `fatal: cannot
    create directory at …`): git was cut off or failed while it wrote, and the files may be half
    new. Only then these four steps:
    1. Make sure no git command runs in the checkout (one of yours in another terminal, an
       editor's).
    2. When `.git/index.lock` is there, remove it (`rm .git/index.lock`): a git that was cut off
       leaves it, and while it is there every git command that writes refuses.
    3. `git reset --hard <upstream>`, with the upstream the command named in its first line (`…
       new commits on origin/main (…)`: `git reset --hard origin/main`): it puts the branch, the
       index and every tracked file at the new commit.
    4. `skydeck window`.

    In this case nothing of yours is lost by step 3, as long as you put nothing into the checkout
    while the command ran. `git reset --hard` discards changes to tracked files and staged files —
    you had none when you typed `skydeck update` (it refuses then, and looks again after the
    fetch) — and it replaces any file that lies where a file of the new commit goes. After a
    fast-forward that was cut off or failed while it wrote, every untracked file in such a place is
    the new commit's own: a file of yours there would have made git refuse before it wrote
    anything. So a file you put into
    the checkout while the command ran is the one thing at risk: move it away before step 3. Files
    git does not track elsewhere, and files it ignores, stay as they are.
  - **Any other `<why>`** — any other line of git's, such as `error: The following untracked
    working tree files would be overwritten by merge:`, `error: Updating the following directories
    would lose untracked files in them:` or `hint: Diverging branches can't be fast-forwarded, you
    need to either:` (a commit made in the checkout meanwhile) — means
    git refused and wrote nothing that matters; only the look after it could not tell (a file came
    into the checkout meanwhile, or the look took too long). `git status`, move away (or commit)
    what git names — it is yours —, `skydeck window`, then `skydeck update` again. No reset.
- `updated to <id>, but skydeck window ended with exit <n>; run skydeck window`: the update is in,
  but the new `skydeck window` failed (its own lines above say why); run `skydeck window`.
- `updated to <id>, but skydeck window could not be started or was ended by a signal; run skydeck
  window`: the update is in, but the new `skydeck window` did not run to its end; run
  `skydeck window`.

### Updating by hand

For a checkout that does not have `skydeck update` yet, and when it refuses, update in this order.
It is the one that is certain:

1. Close every skydeck window (its ×, or Alt+F4 while it is in front), also those opened with
   `--new-window`, and every browser tab of a `--print-url` address: one page left open is enough
   for the second window below. Your sessions keep running in their keepers.
2. In a WSL terminal of your own (not a `!` command inside Claude Code):

   ```sh
   cd ~/skydeck
   git pull
   skydeck window
   ```

   `skydeck window` upgrades the database when the new code brings a new version of it, restarts
   the window's server for the new code and opens the window again: every session is there. Then
   `skydeck doctor`, if you want.

Without the window, `git pull` is all. The links point into the checkout, so the command and the
hook are the new code at once, and the database upgrades itself the next time a command runs.
`npm ci` is needed only for development (`npm run check`); skip it otherwise. Then `skydeck doctor`.

Why the windows are closed first: an update can upgrade the database (the one that brings stage B
does: it adds a table), and the first command of the new code that opens it upgrades it — `skydeck
ls` or `doctor` as much as `skydeck window`. The window's server, still the old code, then stops by
itself at its next write, and the next `skydeck window` finds no server: it starts one and a new
window, and an old window or tab that is still open connects to the new server a moment later. Two
windows (close one). Even `skydeck window` run first is not certain: the old server can stop before
the command has asked it about its open windows. With every page closed there is none to come back.
`skydeck update` has no such order to keep: it stops the old server first.

**There is no way back to an older checkout.** A database that a newer skydeck has upgraded is not
opened by an older one: every command of an older checkout — a second clone, or this one moved back
with `git checkout` — refuses it with exit 1 and changes nothing:

```
skydeck: the database /home/you/.local/share/skydeck/skydeck.db was written by a newer skydeck (schema version 2, this one knows 1); update skydeck
```

and its `doctor` shows the same as a `problem` line of its report (`database … cannot be opened
(the database … was written by a newer skydeck …); the checks that need it are skipped`).

From the update that brings stage B's database (schema version 2) on, this is what every checkout
from before it says. The way back is forward: its `update skydeck` is `skydeck update` in a
checkout that has the command (from the update that brings it on), and `git pull` in an older one
(which prints the same `update skydeck` and has no `skydeck update`). `skydeck update` runs
on such a database, although no other command does: it says `skydeck: the database was written by
a newer skydeck, so the window's server is not looked at; it is left as it is`, brings the checkout
up to date and starts no server. skydeck keeps no copy of the database
from before an upgrade: putting one back would drop everything recorded since, and a copy of the
file taken while the window's server has it open may not be whole. An upgrade only adds to the
database; it changes nothing that is in it.

## When the checkout or Node.js changes

The links point at the checkout and at one Node.js binary. If you move the checkout, or delete it and
clone it somewhere else, the links dangle: the `skydeck` command is not found, and the hook records nothing (it
is silent, and never disturbs a session). If you remove the Node.js version that `<dataDir>/node`
points at, the launcher falls back to `node` on `PATH`, and stops with the message above when that
one is older than 24.12.

In both cases, run install again from where the checkout now is (with `SKYDECK_NODE` set if the
default `node` is older than 24.12):

```sh
cd ~/skydeck
bin/skydeck install
```

It re-points the links and says so (`linked ... -> ...`). The settings file is already right, so it
prints `hook entries already present` and changes nothing there.

## Uninstalling

```sh
skydeck uninstall
```

First the window: when the window's server runs, `uninstall` stops it as `skydeck window --stop`
does and says `stopped skydeck's window server; <n> terminals in the window keep running` (the
sessions in the window and their keepers are never stopped), and when the window's Edge profile
folder exists it names it: `the window's Edge profile is in
C:\Users\you\AppData\Local\skydeck\edge-profile; Edge wrote it and skydeck leaves it (delete it
yourself)`. Then it undoes the install, in this order:

1. **Settings.** When the settings file is still exactly what install wrote, and the backup install
   made still exists, the file is replaced by that backup (`restored ... from ...`). Otherwise (you
   or Claude Code changed the file since) it removes only the two hook entries that are exactly what
   install wrote, and leaves everything else (`removed the hook entries from ...`). A hook that
   merely mentions `<dataDir>/skydeck-hook`, or an entry of an install with another hook path, is
   not skydeck's and stays. This path writes the file in skydeck's formatting too: when that changes
   more than the removed entries, it first keeps the file as it is in a new backup and says so
   (`the rest of the file was rewritten in skydeck's formatting; the file as it was is kept in ...`,
   naming any number that lost digits). When there was no settings file before the install, and
   nobody changed it since, it removes the file.
2. **Links.** It removes `<dataDir>/skydeck-hook`, `~/.local/bin/skydeck` and `<dataDir>/node`, each
   only when it still points where install pointed it. One that points elsewhere (another checkout,
   or another Node.js) is left alone and named: `left ... alone: it points at ...`.
3. **Backups.** It names every backup of the settings file (`kept the backup ...`). It never removes
   one.

The database, the spool and `config.json` stay. Sessions that are running keep running: skydeck
never stops a process. `uninstall` creates nothing, except that one backup when it needs it.

```sh
skydeck uninstall --purge
```

does the same and then removes the data, state and configuration folders (`<dataDir>`, `<stateDir>`,
`<configDir>`): from each only what skydeck writes there — the database, the spool, `hook.log`,
`config.json`, the window's logs and runtime folder, a link inside them that `uninstall` left alone —
and then the folder. It cannot be undone. A folder that holds anything else (a file of yours, an
editor's backup), is a symbolic link, is another user's or cannot be read is left alone, whole; the
others are still purged, and the last line says which folder stayed and why (`skydeck is
uninstalled, but --purge did not remove …`, exit 1). It refuses, changing nothing, while `HOME`,
`SKYDECK_HOME` or one of `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` is
set but empty or not an absolute path: skydeck ignores such a value (see "Environment variables"),
or for `HOME` takes it as it is, and would purge the installation it then finds. It also refuses,
before anything is undone, while a terminal of the window may still run (`uninstall --purge removed
nothing: terminals of the window may still run: …; end those sessions first`): purging would remove
their keepers' sockets, and their screens could not be shown again. End those sessions in `claude`
first. It leaves the backups (they are in Claude
Code's folder) and the compile cache (`~/.cache/skydeck`, see "Environment variables"). To remove
skydeck altogether, delete the checkout last.

An example of the output:

```
restored /home/you/.claude/settings.json from /home/you/.claude/settings.json.skydeck-backup-20261113T090105Z
removed /home/you/.local/share/skydeck/skydeck-hook
removed /home/you/.local/bin/skydeck
removed /home/you/.local/share/skydeck/node
kept the backup /home/you/.claude/settings.json.skydeck-backup-20261113T090105Z
```

## Where things are

| What | Where |
|---|---|
| The code, and what the links point to | The checkout (`~/skydeck` above). |
| Labels, groups, notes, done marks, pull requests, what was recorded | The database, `<dataDir>/skydeck.db`. |
| What the hook recorded and the next command has not read yet | `<stateDir>/spool/`; files that could not be read go to `<stateDir>/spool/bad/`. |
| The hook's own errors | `<stateDir>/hook.log` |
| The settings file and its backups | `<claudeHome>/settings.json`, `<claudeHome>/settings.json.skydeck-backup-*` |
| The compile cache | `~/.cache/skydeck/compile-cache` (see "Environment variables") |
| The window's server and keepers: their own diagnostics, never conversation content | `<stateDir>/server.log`, `<stateDir>/keepers.log` (at 1 MiB copied to `.1` and emptied) |
| The window's sockets and `.pid` files (`server.json`, `server.sock`, `terms/`, the keep-alive's files, the `interop` link) | The runtime directory, which `skydeck doctor` names (see `XDG_RUNTIME_DIR` under "Environment variables") |
| The window's Edge profile | The profile folder on Windows ("The profile folder"); Edge's, not skydeck's |
| The window's xterm.js | `vendor/` in the checkout |

Sessions and transcripts live in Claude Code's folder, and skydeck only reads them. The screens of
the window's terminals live only in memory (the server's, the keepers', the page's), never in a
file.

## If something goes wrong

| You see | Do |
|---|---|
| `skydeck needs Node.js 24.12 or newer but found ...` | Set `SKYDECK_NODE` to a newer `node` (Install, step 2), then run `bin/skydeck install` so that the link `<dataDir>/node` points at it. |
| `skydeck: cannot run 'node'; install Node.js or set SKYDECK_NODE ...` (exit 127) | There is no `node` on `PATH` and no working link. Install Node.js 24.12 or newer, or set `SKYDECK_NODE`. |
| `skydeck: not started through bin/skydeck` | A `--here` start needs the launcher. Run skydeck as `~/.local/bin/skydeck` or `bin/skydeck`, not as `node bin/bootstrap.mjs`. |
| `doctor`: `no SessionStart hook entry ...` | Run `skydeck install`. Claude Code may have rewritten its settings file. |
| A session you expect is not in `skydeck ls` | A session that is not running and never received a prompt has no transcript and is not listed. One marked done needs `--all`. A scripted run (print mode, an SDK host, an editor extension) is not a session of its own and is not listed (`doctor` counts what it drops), and neither is a session whose transcript says it was not started by the interactive `claude` (its entry point is not `cli`). Run `skydeck doctor`. |
| `skydeck: <id> is running (pid <n>)` when you resume | The session runs in another terminal. skydeck never resumes a session twice (exit 4). |
| The same, but you see no such terminal | A scripted run (print mode such as `claude -p --resume <id>`, an SDK host, an editor extension) holds that session. skydeck shows it as `running`, `skydeck show <ref>` says `(scripted run)` next to the holder, and `resume` is refused until that process ends. |
| `skydeck: <id> is being resumed (<n> s ago); try again in <m> s` | A resume of that session started less than a minute ago. When skydeck printed a command for you to run, the same hold applies for that minute. |
| `skydeck: the window's server is not started from inside a Claude Code session: …` | `skydeck window` was run as a `!` command of a Claude Code session, or from a shell that inherited `CLAUDECODE`. Run it in a WSL terminal of your own. |
| `skydeck: Edge was not found at <path>; set window.edge in <config path>, or open the window in any browser with skydeck window --print-url` | Edge is not at the default place: set `window.edge`. The server keeps running. |
| `skydeck: Edge was started, but no window connected within 30 seconds; open the window in any browser with skydeck window --print-url` | Edge did not open the page in time (a slow cold start, a blocked start: write down what Windows showed, manual check W20). Run `skydeck window` again, or use `--print-url`. |
| `skydeck: port <n> on 127.0.0.1 is used by another program; set window.port in <config path>` | Another program inside WSL holds the port: stop it, or set `window.port`. |
| `skydeck: the window's server runs from <checkout>; run skydeck window there, or skydeck window --restart here to replace it` | A server of another checkout runs. |
| `skydeck: the window's server (pid <n>) does not answer; skydeck window --restart stops it` | The server hangs. `--restart` stops it (only that process, after checking it is the server); the sessions keep running. `<stateDir>/server.log` may say why. |
| `skydeck: the window's server did not start (exit <n> / no answer in 10 s); see <stateDir>/server.log` | Read the log; `skydeck doctor`. |
| `skydeck: the runtime directory <dir> cannot be used: <reason>; see skydeck doctor` | The sockets' directory is not yours or not mode 700, or its paths are too long (a long `SKYDECK_HOME`). |
| `skydeck: this window's launch address was used by another program, which may now have skydeck's key; run skydeck window --new-secret` (also in the window, and as `doctor`'s launch alarm) | A launch address was presented twice. Run `skydeck window --new-secret`, which replaces the key; close the windows opened before. |
| The window says `this window's key is not valid; run skydeck window again` | Its key was replaced (`--new-secret`), or a launch address was used too late. Close it and run `skydeck window`. |
| The window says `something answers on port <n> that is not skydeck's server; nothing was sent to it` | Another program holds the port (see "Known limits"). Find and stop it; if a window was opened while it held the port, close every window, delete the window's profile folder and run `skydeck window --new-secret`. |
| The window says `WSL has restarted since <time>: the sessions that were running have ended.` | WSL stopped (all its processes ended) and a new server answered. Resume the sessions in the window, or run `skydeck restore` in a terminal. Then see "Keeping WSL running". |
| A resume card says `python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)` | Install python3 (`sudo apt install python3`); the next terminal opens with it. |
