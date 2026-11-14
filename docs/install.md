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
| `resume`, `new`, `restore`, and `R` in the interactive list | They start `claude`. By default they do it in the terminal you are in: skydeck ends and `claude` takes its place. That works in any terminal. |
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
and every session started in it runs in a terminal of skydeck's own (see "The window (step 2)").

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
| `terminal` | `"here"` | Where `resume`, `new`, `restore` and `R` start `claude` when you give neither `--here` nor `--tab`: `"here"` (this terminal) or `"wezterm"` (a new WezTerm tab). |
| `wezterm.domain` | `null` | The WezTerm domain a tab opens in (`--domain-name`). `null` passes no domain. |
| `groupPattern` | `"^[A-Z][A-Z0-9]+-[0-9]+"` | A JavaScript regular expression (the source, no flags). When a session has no group, the text it matches in the session's title is the group. The default takes a ticket key such as `ABC-123` at the start of the title. |
| `firstRunDoneAfterDays` | `7` | install's one-time offer to mark sessions as done: those not running whose last activity is older than this many days. |
| `prRefreshMinutes` | `5` | The least time between two automatic attempts to read a pull request's status. |
| `restoreBatch` | `3` | How many sessions `restore` opens at a time. |
| `restoreMinFreeMb` | `4096` | `restore` stops (exit 5) before a batch when less memory than this (MiB, `MemAvailable`) is free. |
| `restoreStartTimeoutSeconds` | `120` | How long `restore` waits for the sessions of a batch to report their start. |
| `claudeHome` | `null` | Claude Code's folder. `null` means `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Must be an absolute path (no `~`). |
| `claudeCommand` | `"claude"` | The program `resume`, `new` and `restore` (and `R` in the list) run. One word: a name on `PATH` or an absolute path. It is not split into arguments. The window runs it too. |
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

This is stage A of step 2 ([design-step-2.md](design-step-2.md), section 19): the list, the
terminals, resume and new. Attention marks and notifications, restoring into the window, editing
the label, group, note and done mark in the window, and the search beyond one text come in later
stages. The commands of step 1 stay as they are, also while the window runs: `skydeck resume`,
`new` and `restore` start `claude` in the terminal you type them in, not in the window.

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
  two Windows programs, and only these, through interop: `msedge.exe` (the window, and links you
  Ctrl+click) and `wsl.exe` (the keep-alive). It writes nothing on the Windows side; Edge writes its
  profile folder (below).

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
| `window.edge` | `"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"` | The Edge program: an absolute path in WSL. Links you Ctrl+click in a terminal open with it too, in your own Edge profile. |
| `window.profileDir` | `null` | The window's Edge profile folder: an absolute Windows path (`C:\…`, every backslash doubled in JSON). `null`: found as above. |
| `window.keepAlive` | `"wsl"` | `"wsl"`: the server keeps WSL running while the window has anything running (below). `"off"`: it does not; for use with `instanceIdleTimeout=-1`. |

`terminal` stays `"here"` or `"wezterm"` in this stage; resuming into the window from the command
line comes later. An example, for a PC with two Windows users that have Edge (so the profile folder
cannot be found by itself) and another program on port 47613:

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
  another terminal; the window's terminals carry the slots 1–9), **This week** and **Earlier**
  (folded; a click on its header unfolds it). Done sessions are hidden: the footer's `show`, or
  `a`, shows them.
- **A session that is not running**: one click selects it and shows its resume card, with the
  exact command it will run. Enter, a double click or `Resume here` resumes it into the window.
- **A running session** of the window: a click shows its terminal. A session that runs in another
  terminal shows a card instead: it cannot be shown in the window. Once you `/exit` it there, it
  can be resumed here.
- **A new session**: Ctrl+Shift+N (in a browser tab the browser keeps Ctrl+Shift+N for itself:
  use the `+ New` button there), with its directory,
  label, group and `claude` flags.
- **A session that ended** keeps its last screen, dimmed, under a bar with Resume and Close.
- **Keys**: **Ctrl+Shift+H shows every key of the window**, those that come in later stages
  marked so (they say `<key>: comes in a later stage` when pressed). The window takes only Ctrl+Shift
  chords with a letter or a digit, and Ctrl+Tab, besides the list's own keys while the list has the
  keyboard; every other key goes to Claude Code (Alt chords, Ctrl with a letter, function keys, Esc
  in the terminal). Three to know from the start: Ctrl+Shift+L moves the keyboard between list and
  terminal, Ctrl+Shift+C copies from the terminal (plain Ctrl+C interrupts the program), and
  Ctrl+Shift+V is Claude Code's own image paste (it reads the Windows clipboard itself; Ctrl+V
  pastes text). The key bar at the bottom says where the keyboard is (`Focus: list`,
  `Focus: terminal`).

### Known limits of stage A

- **The keep-alive is not verified** (above; W14).
- **A second window** can open when `skydeck window` starts a server while an old window is still
  open: after the server died or was stopped (`--stop`), or after a WSL restart. The command sees no
  page and starts Edge, and the old window connects again a moment later. Close one of them. (After
  `--restart` or an update the command waits for the open windows, so none opens then.)
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
  filter field it is two Escs to the terminal. The ended bar of a selected session that the filter
  hides offers no Resume, and Close only once the end is known: clear the filter. A resume card's
  warnings about flags (`original flags unknown; resuming with defaults`, flags not passed on)
  show until the terminal replaces the card, not after a successful resume. The pull-request chip
  is the command line's (design.md 7.3): `3 PRs · …` counts the merged ones too; a chip that counts
  open and merged pull requests apart comes in a later stage. In one rare case
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
- **The command line does not use the window yet.** `skydeck resume`, `new` and `restore` start
  `claude` in the terminal you are in. After a WSL restart, resume the sessions one by one in the
  window (or run `skydeck restore` in a terminal, which brings them back there). A `skydeck resume`
  of a session whose window terminal still shows `starting…` is not refused because of it: wait
  until it runs.

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

```sh
cd ~/skydeck
git pull
skydeck window
```

The commands run the new code at once, as before. The server keeps running the code it started
with until `skydeck window` finds that it is of another build and restarts it, with the line of
"Starting it" above. Sessions keep running; every terminal's screen is rebuilt (see "Known
limits"), and the open windows reload themselves for the new page and connect again: the command
waits up to 7 seconds for them, so it opens no second window. Keepers that run keep the code they
started with; new terminals get the new keeper. No `npm ci`, no `skydeck install`.

When a command of the new code upgrades the database while the old server still runs, that server
stops by itself (its windows say that it is not answering): run `skydeck window`.

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
| terminal | With `"terminal": "wezterm"`: `wezterm cli --no-auto-start list` failed. Is a WezTerm window open? With `"here"` the line is `ok`. |

## Updating

```sh
cd ~/skydeck
git pull
```

That is all. The links point into the checkout, so the command and the hook are the new code at
once, and the database upgrades itself the next time a command runs. `npm ci` is needed only for
development (`npm run check`); skip it otherwise. Then `skydeck doctor`. When you use the window,
run `skydeck window` too: it restarts the window's server for the new code ("Updating while the
window runs").

A database written by a newer skydeck is not opened by an older one: the command stops with
`the database ... was written by a newer skydeck ...; update skydeck`.

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
