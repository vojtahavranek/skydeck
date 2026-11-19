# Instructions for AI agents

## Part 1: if you were asked to install skydeck for someone

skydeck is a window and a command line for Claude Code, for people who run many sessions at once. It
shows which session is about what, what each one is doing and which one needs its user. Installing
it adds (the guide, docs/install.md, "What install changes"): two hook entries, `SessionStart` and
`SessionEnd`, to Claude Code's settings file `~/.claude/settings.json`; a link
`~/.local/bin/skydeck` to this checkout; its folders `~/.local/share/skydeck` (database, links),
`~/.local/state/skydeck`, `~/.config/skydeck`; and, only after a yes to the ← question, one key in
`~/.claude.json`; each file of Claude Code's is backed up first. A set `CLAUDE_CONFIG_DIR` stands
for `~/.claude`, its `.claude.json` for `~/.claude.json`.

The work is split. YOU check, clone, preview and explain. THE HUMAN answers install's questions (one
of them agrees to hooks in Claude Code's own settings) and opens the window, in a terminal of their
own. Never do the human's steps. When in doubt, stop and ask the human.

**1. Where it works.** Linux, or Windows with WSL2 with Claude Code running INSIDE WSL; the window
also needs Microsoft Edge on the Windows side. Run `uname -sr`:

- `Linux` with `WSL2` in the release: go on. `Linux` with no `microsoft` (upper or lower case):
  plain Linux; go on, and tell the human that the commands work there, the window does not.
- Any other `Linux` (WSL1): STOP, skydeck needs WSL2. `Darwin`: STOP, macOS is not supported yet.
- Anything else, or no `uname` (PowerShell, Git Bash): you run on the Windows side, where skydeck
  would record nothing. STOP: both must run inside WSL; `skydeck install` refuses by itself there.

**2. Check what is there.** Run as it is; it changes nothing (`gh auth status` asks GitHub):

```sh
for p in node git python3 claude gh skydeck; do printf '%s: ' "$p"; command -v "$p" || echo missing; done
node --version; ls ~/.nvm/versions/node; python3 --version; claude --version; gh auth status
ls -ld "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ~/.local/bin/skydeck ~/.config/skydeck/config.json
ls -ld ~/.local/share/skydeck ~/skydeck
grep -c skydeck-hook "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
```

- A path under `/mnt/` is a Windows program seen from WSL: count it as missing.
- If `node` is older than 24.12 or missing, put `SKYDECK_NODE=<node binary>` (24.12 or newer) before
  every `bin/skydeck` below. nvm keeps them in `~/.nvm/versions/node/` (your shell may not load
  nvm): take the highest version (`ls` puts v24.9 after v24.19). None: the human installs one.
- `claude` missing: STOP; it must be installed and run once on this side (no folder in the `ls`:
  they run it once); any version goes on (the guide names 2.1.3xx). No `git`: theirs to install.
- `python3` 3.9 or newer (only for the window's terminals) and `gh` (only for the status of pull
  requests and GitHub issues) are optional: tell the human what is missing, and go on.
- Without skydeck: `skydeck: missing`, `No such file or directory` for the skydeck paths (nvm's
  folder too, without nvm), a count of 0 or no settings file. Installed (the link
  `~/.local/bin/skydeck`, whose `->` names its checkout, or a count above 0): STOP and run nothing
  more, not even the clone; tell the human what you found, and that an install from another folder
  re-points the links unasked: theirs, in their own terminal.
- `config.json` found: skydeck was set up here before, maybe for another Claude Code folder: STOP,
  ask the human. Only `~/skydeck` or `~/.local/share/skydeck` (a checkout; data an uninstall left,
  which install uses again): ask whether to go on. A `skydeck` on `PATH` not in `~/.local/bin` is
  another program: tell the human the first on `PATH` answers to `skydeck`; go on at their word.

**3. Clone, and preview the change.** Ask where the checkout should live (`~/skydeck`, or their
choice: change it below); it stays there (install links to it). Reading this in a checkout they want
to keep? Use it, and skip the clone. A clone that asks for a login: STOP, it is the human's.

```sh
git clone https://github.com/vojtahavranek/skydeck.git ~/skydeck
cd ~/skydeck && bin/skydeck install </dev/null
```

Only where step 2 stopped nothing (no link, no count above 0, no `config.json`): with no input every
question gets a no, so the second line shows the exact entries install would add, changes nothing
(but skydeck's compile cache in `~/.cache/skydeck`) and exits 1, as expected. It prints:

```text
skydeck will add these hook entries to /home/you/.claude/settings.json:
{ ... the two entries, as JSON ... }
Add them? [y/N] settings not changed
```

A line `the rest of the file will be rewritten …` means install would also reformat the file, and
names its backup; `ExperimentalWarning: SQLite …` and its next line (some Node.js 24 versions, at
any place) are harmless. Show the human the whole output. Anything else (a refusal): STOP, show it.

**4. The human installs.** In a terminal of their own, where they can type the answers, they run
`cd ~/skydeck && bin/skydeck install` (with `SKYDECK_NODE=...` in front of `bin/skydeck` when their
`node` is older than 24.12); Enter alone is a no. Never answer for them (no option of install does)
or feed them from a pipe (`printf 'y\n' |`, `yes |`). Tell them first what a yes to each does:

- `Add them? [y/N]`: adds the two hook entries (after a backup of the file), so that skydeck records
  every session that starts from now on. A no ends the install with nothing changed.
- `Mark 3 sessions older than 7 days as done? [y/N]` (asked once, when there are such sessions; the
  number varies): hides them from skydeck's list. Nothing is stopped or deleted.
- `Turn the shortcut off? [y/N]` (while it is on): turns off Claude Code's ← shortcut in
  `~/.claude.json` (after a backup), so a ← meant for skydeck's list cannot send a session away.

**5. Check it.** Once they say it is done, have them run `command -v skydeck` in a new terminal and
tell you: it must print their `~/.local/bin/skydeck` (nothing: give them
`export PATH="$HOME/.local/bin:$PATH"` for `~/.bashrc` or `~/.zshrc`, which you never edit; another
path: tell them that program answers). Then run `~/.local/bin/skydeck doctor` and
`~/.local/bin/skydeck ls` and read them out. doctor's lines start `ok`, `info` or `problem`,
versions first; normal when new: `info     no events yet`, a `problem` (exit 1) for a missing or
logged-out `gh`, `info` for the window's until it is used. Other problems are theirs.

**6. Tell the human, at the end:** what changed (above), and that `skydeck uninstall` undoes it
(keeping the database, the backups and the ← setting); that `skydeck window` is theirs, in a
terminal of their own, first with a new session in a scratch folder they can lose (without Edge:
`skydeck window --print-url`); and that `docs/quick-start.md` is their first ten minutes.

**Never:**

- Run `skydeck window`, `skydeck serve`, `skydeck update` or a bare `skydeck` yourself: they are the
  human's, in their own terminal (the window's sessions get the environment of whoever starts its
  server; inside Claude Code the three refuse); a bare one is the interactive list. The preview,
  `doctor` and `ls` are yours; never `new`, `resume` or `restore` unasked (they start `claude`).
- Follow `docs/manual-checks.md`, the maintainer's checklist: it can uninstall skydeck or stop WSL.
- Run `skydeck uninstall` or `skydeck uninstall --purge` unasked: they undo the install, and
  `--purge` deletes the human's labels and notes for good.
- Edit Claude Code's settings files by hand: uninstall undoes exactly the change install made.
- Use `sudo`, pipe a script from the internet into a shell, or log in (`gh auth login`): PRINT such
  commands for the human (the guide's "On a fresh WSL" has them all).
- Run `npm ci` or the tests as part of an install: they are for changing the code (part 2).
- Paste what `doctor` or `ls` print outside this conversation unasked: paths, user names, titles.

## Part 2: if you were asked to change skydeck's code

- `src/`: commands (`src/cli/commands/`, a file each), the window's server; `web/`: the page (plain
  JavaScript); `bin/`: launcher, hook, keeper; `test/`, `test-page/`: tests and page tests; `docs/`.
- Node.js 24.12 or newer runs the TypeScript as it is. `npm ci`, `npm run format`, `npm run check`
  (format, types, tests, page tests; these need `npx playwright install chromium`, no `sudo`).
- Rules that must not break: no runtime dependency (Node.js's own modules only); nothing outside
  `src/platform/` reads the clock, the environment or `/proc` or starts a program (modules get them
  passed in, so tests pass fakes); nothing outside `src/claude/` reads a Claude Code file; no
  conversation text is stored; tests run only in the suite's sandbox (`test/helpers/`), never
  against a real home or `~/.claude`, the real `claude`, the window's real port or the network.
- The design is `docs/design.md` (section 2, the principles, changes first if one must break) and
  `docs/design-step-2.md` (the window); a change in behaviour updates it in the same pull request.
