# Instructions for AI agents

## Part 1: if you were asked to install skydeck for someone

skydeck is a window and a command line for Claude Code, for people who run many sessions at once:
which session is about what, what each one is doing, which one needs its user. Installing it adds
([docs/install.md](docs/install.md), "What install changes"): two hook entries, `SessionStart`
and `SessionEnd`, to Claude Code's settings file `~/.claude/settings.json` (with a backup beside
it, when there was a file); a link `~/.local/bin/skydeck` to this checkout; skydeck's own folders
`~/.local/share/skydeck` (its database, two links), `~/.local/state/skydeck`, `~/.config/skydeck`;
and, only after a yes to its third question, one key in `~/.claude.json` (after a backup).

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

**2. Check what is there.** Run this block as it is; it only reads.

```sh
for p in node git python3 claude gh skydeck; do printf '%s: ' "$p"; command -v "$p" || echo missing; done
node --version; python3 --version; claude --version; gh auth status
ls -ld "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ~/.local/bin/skydeck ~/.local/share/skydeck
grep -c skydeck-hook "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
```

- A path under `/mnt/` is a Windows program seen from WSL: count it as missing.
- `node` must be `v24.12.0` or newer. Your shell may not load nvm: look in `~/.nvm/versions/node`;
  a new enough one there is used as `SKYDECK_NODE=$HOME/.nvm/versions/node/<version>/bin/node` in
  front of `bin/skydeck`. With none, the human installs one (the guide's "On a fresh WSL").
- `git` missing: the human installs it. `claude` missing: STOP; Claude Code must be installed on
  this side and started once (its folder missing in the `ls`: the human starts `claude` once).
- `python3` 3.9 or newer (only for the window's terminals) and `gh` (only for the status of pull
  requests and GitHub issues) are optional: tell the human what is missing, and go on.
- A machine without skydeck shows `skydeck: missing`, `No such file or directory` for the two
  skydeck paths and a count of 0 (or no settings file). Anything else: skydeck is, or was,
  installed here. STOP and tell the human what you found.

Anything that needs `sudo`, a script from the internet or a login (`gh auth login`): PRINT the
command for the human (the guide's "On a fresh WSL" has them all); never run it yourself.

**3. Clone, and preview the change.** Ask the human where the checkout should live; it must stay
there, since the install links to it (change `~/skydeck` below if they choose another place).

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

**4. The human installs.** They run `cd ~/skydeck && bin/skydeck install` in a terminal of their
own, where they can read the questions and type the answers (with your `SKYDECK_NODE=...` in front
of `bin/skydeck`, if you needed one). Up to three questions; Enter alone is a no. Never answer for
them (install has no option that does) and never feed them from a pipe (`printf 'y\n' |`,
`yes |`). Tell them first what a yes to each does:

1. `Add them? [y/N]`: adds the two hook entries (after a backup of the file), so that skydeck
   records every session that starts from now on. A no ends the install with nothing changed.
2. `Mark 3 sessions older than 7 days as done? [y/N]` (once, when there are such sessions; the
   number varies): hides them from skydeck's list. Nothing is stopped or deleted.
3. `Turn the shortcut off? [y/N]` (while it is on): turns off Claude Code's ← shortcut in
   `~/.claude.json` (after a backup), so a ← meant for skydeck's list cannot send a session away.

**5. Check it.** Ask them to open a new terminal, so that `skydeck` is found there. You may run
`~/.local/bin/skydeck doctor` and `~/.local/bin/skydeck ls` and read them to the human. `doctor`
prints one line per check (`ok`, `info` or `problem`; exit 1 on any `problem`); its first three,
`info`, name skydeck's and Claude Code's versions and the system. Normal on a new install:
`info     no events yet`, a `problem` for a missing or logged-out `gh`, `info` lines for the window
until it is used. Other `problem` lines say what to do. `skydeck ls` lists the sessions.

**6. Tell the human, at the end:**

- What changed (above). `skydeck uninstall` undoes it: it takes the hook entries out, removes the
  links and stops the window's server; the database, the backups and the ← setting stay.
- The window is theirs to open: `skydeck window` in a terminal of their own (it refuses inside a
  Claude Code session), first with a new session in a scratch folder, one they can lose.
- [docs/quick-start.md](docs/quick-start.md) takes them through their first ten minutes.

**Never:**

- Run `skydeck window`, `skydeck serve`, `skydeck update` or a bare `skydeck` from this session:
  the first three refuse inside Claude Code (every session in the window would inherit this
  session's environment), and a bare `skydeck` on a terminal is the interactive list.
- Follow `docs/manual-checks.md`: the maintainer's checklist, some items of which uninstall
  skydeck or stop WSL.
- Run `skydeck uninstall` or `skydeck uninstall --purge` unasked: they undo the install, and
  `--purge` deletes the human's labels and notes for good.
- Edit Claude Code's settings files by hand: uninstall undoes exactly the change install made.
- Use `sudo`, or pipe a script from the internet into a shell: print it for the human.
- Run `npm ci` or the tests as part of an install: they are for changing the code (part 2).
- Paste `doctor`'s output outside this conversation without asking: it holds paths and user names.

## Part 2: if you were asked to change skydeck's code

- `src/` the commands (one file each in `src/cli/commands/`) and the window's server, `web/` the
  window's page (plain JavaScript, no build), `bin/` the launcher, hook and keeper, `test/` the
  tests (helpers in `test/helpers/`), `test-page/` the page tests (headless Chromium), `docs/`.
- Node.js 24.12 or newer runs the TypeScript as it is. `npm ci`, `npm run format`, `npm run check`
  (format, types, tests, page tests; these need `npx playwright install chromium`, no `sudo`).
- Rules that must not break:
  - no runtime dependency: Node.js's own modules only;
  - nothing outside `src/platform/` reads the clock, the environment or `/proc`, or starts a
    program: every module gets them as parameters, so that tests pass fakes;
  - nothing outside `src/claude/` reads a Claude Code file or names a Claude Code field;
  - no conversation text is stored: not in the database, the logs or the test fixtures;
  - tests run only in the suite's sandbox (`test/helpers/`): never against a real home or
    `~/.claude`, never the real `claude`, never the window's real port, never the network.
- The design is `docs/design.md` (section 2, the principles, changes first if one must break) and
  `docs/design-step-2.md` (the window); a change in behaviour updates it in the same pull request.
