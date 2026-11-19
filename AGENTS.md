# Instructions for AI agents

## Part 1: if you were asked to install skydeck for someone

skydeck is a window and a command line for Claude Code, for people who run many sessions at once:
which session is about what, what each one is doing, which one needs its user. Installing it adds
([docs/install.md](docs/install.md), "What install changes"): two hook entries, `SessionStart`
and `SessionEnd`, to Claude Code's settings file `~/.claude/settings.json` (with a backup beside
it, when there was a file); a link `~/.local/bin/skydeck` to this checkout; skydeck's own folders
`~/.local/share/skydeck` (its database, two links), `~/.local/state/skydeck`, `~/.config/skydeck`;
and, only after a yes to `Turn the shortcut off?`, one key in `~/.claude.json` (after a backup).
If `CLAUDE_CONFIG_DIR` is set, it stands for `~/.claude`, its `.claude.json` for `~/.claude.json`.

The work is split. YOU check, clone, preview and explain. THE HUMAN answers install's questions
(one of them agrees to hooks in Claude Code's own settings) and opens the window, in a terminal of
their own. Never do the human's steps. When in doubt, stop and ask the human.

**1. Where it works.** Linux, or Windows with WSL2 with Claude Code running INSIDE WSL; the window
also needs Microsoft Edge on the Windows side. Run `uname -sr`:

- `Linux` with `WSL2` in the release: go on. `Linux` with no `microsoft` (in any case): plain
  Linux; go on, and tell the human that the commands work there, the window does not.
- Any other `Linux` (WSL1): STOP, skydeck needs WSL2. `Darwin`: STOP, macOS is not supported yet.
- Anything else, or no `uname` (PowerShell, Git Bash): you run on the Windows side, where skydeck
  would record nothing. STOP: both must run inside WSL; `skydeck install` refuses by itself there.

**2. Check what is there.** Run as it is; it changes nothing (`gh auth status` asks GitHub):

```sh
for p in node git python3 claude gh skydeck; do printf '%s: ' "$p"; command -v "$p" || echo missing; done
node --version; ls ~/.nvm/versions/node; python3 --version; claude --version; gh auth status
ls -ld "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ~/.local/bin/skydeck ~/.local/share/skydeck ~/skydeck
grep -c skydeck-hook "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
```

- A path under `/mnt/` is a Windows program seen from WSL: count it as missing.
- If `node` is older than 24.12 or missing, put `SKYDECK_NODE=<any node 24.12 or newer>` before
  every `bin/skydeck` below (nvm's, which your shell may not load, are
  `~/.nvm/versions/node/v24.x.y/bin/node`: take the newest). None: the human installs one.
- `git` missing: the human installs it. `claude` missing: STOP; Claude Code must be installed on
  this side and started once (no folder in the `ls`: they start it once). Any version will do.
- `python3` 3.9 or newer (only for the window's terminals) and `gh` (only for the status of pull
  requests and GitHub issues) are optional: tell the human what is missing, and go on.
- A machine without skydeck shows `skydeck: missing`, `No such file or directory` for the three
  skydeck paths and a count of 0 (or no settings file). Anything else: skydeck is, or was,
  installed or cloned here. STOP and tell the human what you found.
- Anything that needs `sudo`, a script from the internet or a login (`gh auth login`): PRINT it
  for the human (the guide's "On a fresh WSL" has them all); never run it yourself.

**3. Clone, and preview the change.** Ask where the checkout should live (`~/skydeck`, or their
choice: change it below); it stays there (install links to it). Reading this in a checkout they
want to keep? Use it, and skip the clone. A clone that asks for a login: STOP, it is the human's.

```sh
git clone https://github.com/vojtahavranek/skydeck.git ~/skydeck
cd ~/skydeck && bin/skydeck install </dev/null
```

No input means no answer, and no answer is a no: the second line shows the exact entries install
would add, changes nothing (every run of skydeck keeps a compile cache in `~/.cache/skydeck`) and
exits 1, which is expected here. It prints:

```text
skydeck will add these hook entries to /home/you/.claude/settings.json:
{ ... the two entries, as JSON ... }
Add them? [y/N] settings not changed
```

A line `the rest of the file will be rewritten …` means install would also reformat the file, and
names its backup; `ExperimentalWarning: SQLite …` (some Node.js 24 versions) is harmless. Show the
human the whole output. Anything else (a refusal, `hook entries already present`): STOP, show it.

**4. The human installs.** In a terminal of their own, where they read the questions and type the
answers, they run `cd ~/skydeck && bin/skydeck install` (with `SKYDECK_NODE=...` in front when
their `node` is older than 24.12); Enter alone is a no. Never answer for them (no option of
install does) and never feed them from a pipe (`printf 'y\n' |`, `yes |`). Tell them first what a
yes does (each question comes only when it applies):

- `Add them? [y/N]`: adds the two hook entries (after a backup of the file), so that skydeck
  records every session that starts from now on. A no ends the install with nothing changed.
- `Mark 3 sessions older than 7 days as done? [y/N]` (asked once, when there are such sessions;
  the number varies): hides them from skydeck's list. Nothing is stopped or deleted.
- `Turn the shortcut off? [y/N]` (while it is on): turns off Claude Code's ← shortcut in
  `~/.claude.json` (after a backup), so a ← meant for skydeck's list cannot send a session away.

**5. Check it.** Ask them to open a new terminal: `skydeck` is found there (if not, give them
`export PATH="$HOME/.local/bin:$PATH"` for their shell's startup file, `~/.bashrc` or `~/.zshrc`;
never edit it yourself). You may run `~/.local/bin/skydeck doctor` and `~/.local/bin/skydeck ls`
here and read them out. `doctor` prints a line per check, `ok`, `info` or `problem` (exit 1 on any
problem), the first three `info`: skydeck's and Claude Code's versions, the system. Normal on a new
install: `info     no events yet`; a `problem` for a missing or logged-out `gh` (fine without
pull-request status); `info` for the window's lines, Edge's too, until it is used. Other problems
say what to do; the fixes are the human's. `skydeck ls` lists the sessions, old and new.

**6. Tell the human, at the end:**

- What changed (above). `skydeck uninstall` undoes it: it takes the hook entries out, removes the
  links and stops the window's server; the database, the backups and the ← setting stay.
- The window is theirs: `skydeck window` in a terminal of their own, first with a new session in a
  scratch folder, one they can lose (without Edge, `skydeck window --print-url` gives an address for
  any browser).
- [docs/quick-start.md](docs/quick-start.md) takes them through their first ten minutes.

**Never:**

- Run `skydeck window`, `skydeck serve`, `skydeck update` or a bare `skydeck` here: the first three
  refuse inside Claude Code (the window's sessions would get this session's environment), and a bare
  one is the interactive list. Install, doctor and ls work here.
- Follow `docs/manual-checks.md`, the maintainer's checklist: it can uninstall skydeck or stop WSL.
- Run `skydeck uninstall` or `skydeck uninstall --purge` unasked: they undo the install, and
  `--purge` deletes the human's labels and notes for good.
- Edit Claude Code's settings files by hand: uninstall undoes exactly the change install made.
- Use `sudo`, or pipe a script from the internet into a shell: print it for the human.
- Run `npm ci` or the tests as part of an install: they are for changing the code (part 2).
- Paste what `doctor` or `ls` print outside this conversation unasked: paths, user names, titles.

## Part 2: if you were asked to change skydeck's code

- `src/`: commands (`src/cli/commands/`, a file each), the window's server; `web/`: the page (plain
  JavaScript); `bin/`: launcher, hook, keeper; `test/`, `test-page/`: tests and page tests; `docs/`.
- Node.js 24.12 or newer runs the TypeScript as it is. `npm ci`, `npm run format`, `npm run check`
  (format, types, tests, page tests; these need `npx playwright install chromium`, no `sudo`).
- Rules that must not break: no runtime dependency (Node.js's own modules only), and
  - nothing outside `src/platform/` reads the clock, the environment or `/proc`, or starts a
    program: every module gets them as parameters, so that tests pass fakes;
  - nothing outside `src/claude/` reads a Claude Code file; no conversation text is stored;
  - tests run only in the suite's sandbox (`test/helpers/`): never against a real home or
    `~/.claude`, never the real `claude`, never the window's real port, never the network.
- The design is `docs/design.md` (section 2, the principles, changes first if one must break) and
  `docs/design-step-2.md` (the window); a change in behaviour updates it in the same pull request.
