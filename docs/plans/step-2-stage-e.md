# skydeck step 2, stage E — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stage E of step 2 as specified in [`docs/design-step-2.md`](../design-step-2.md)
(section 19): search — several words and the short id in the filter, done sessions while
filtering, the chips, stacks in This week and Earlier (S2 12.2, 12.8), the quick switcher
Ctrl+Shift+P — and the page's own icon (S2 12.12). It also settles stage A's known limit of a
selected session the filter hides (S2 12.6). It uses stage B's attention and stage C's restore
when they are there and works without them.

**Architecture:** Every rule that matches, stacks or ranks is a pure function of the view model,
in a directory of its own (`src/window/view/search/`), called by `buildListMessage`. The page
sends what it wants to see — the filter's text, the chips, the stacks it opened, the switcher's
text — in its `view`, and the server answers with the `list` for that view, the switcher's ranked
items included. The page draws what the server sends, as text. The icon is a set of committed
files served by the server under the page's security policy.

**Tech Stack:** as stage A — TypeScript on Node.js ≥ 24.12 through type stripping, `node:test`;
the page in plain JavaScript modules with JSDoc types and no build step; Playwright 1.60.0's
Chromium for the page suite (and, once, to draw the icon's PNG files).

---

## 0. How to use this plan

Stage A's plan (`docs/plans/step-2-stage-a.md`) section 0 holds for every task here: the execution
model (one pull request per task, tasks of one wave in parallel in their own worktrees, two
reviews before the lead merges), the sources of truth (the design wins over this plan; "design
7.4" is design.md, "S2 12.8" is design-step-2.md), what is fixed here and what is the
implementer's, the per-task workflow and the test rules (A31–A36: no real `claude`, no Windows
program, the sandbox, the two test platforms; page tests in headless Chromium through
`test-page/helpers/`). Its contracts (section 2) stay in force where this plan does not change
them; this plan's section 2 gives only the changes.

**Task numbers** are 90–99 (stage D has 34–39, B 50–56, C 70–81), so that branch names,
pull-request titles and the lead's notes stay unique.

**Stages B, C and D are built at the same time.** The plans of stages D and B are merged; C's
was under review when this one was written. For lines that tasks of several stages change, the lead
ruled the order D, then B, then C, then E, per file group: a later task is built in parallel and
merges `origin/main` after the earlier one has landed, resolving the places it names. So each
task here that edits a file of theirs names, in its **Merges after** line, the tasks of the
other stages that land first, and in its **To resolve** line the places where their lines and
its own meet (line numbers are those of 9c5cbfb); it is written against the code as their plans
leave it, and its **If absent** line says what it does when that stage is not there. Where a
name of theirs on `main` differs from what their plan said, the implementer follows `main` and
tells the lead.

**CI stays as it is**: two Node legs, one job each. No task changes `.github/workflows/`,
`package.json` or a dependency.

**Added to the test rules.**
- No test starts the real `claude`, and a resume in a test resumes a session made by the test in
  its sandbox with the stand-in as `claudeCommand` (stage A's rule); so does every Enter in the
  switcher's tests.
- The icon's PNG files are drawn once, by the implementer of task 94, with `scripts/icons.ts`;
  no test and no CI step runs the script. It is accepted as code that no test runs (ruled): a
  generator run once, headless, in the implementer's worktree, that aborts every request and
  starts nothing on the desktop; its output is what the tests hold, and the type check covers it.
- No task runs `bin/skydeck` outside the test suite (task 99 included).
- The page cases of tasks 95, 97 and 98 make their contexts through stage B's `newContext` of
  `test-page/helpers/browser.ts` (B17; no `.newContext(` of their own), also 98's case with two
  pages. None relies on the order of a context's and a page's init scripts: Playwright does not
  define it.

**Known flakes** (not stage E's to fix; a run that fails only with one of them is run once more,
and the pull request names both runs): `test/platform/real.test.ts` "a streamed answer that keeps
coming…" and its case at line 1005 (the wall clock steps back); `test/standin/standin.test.ts`
(records in the wrong order); `test/window/mapping.test.ts:623` (ENOTEMPTY at the sandbox's
clean-up); `test-page/terminal.test.ts` "input-full (the program stalled, a large paste)". A
candidate seen once under load: `test/cli/commands/window.test.ts:1772` ("--new-secret while a
server starts…", `the window's server does not run`) — re-run once, and name both runs to the
lead.

## 1. Tasks and waves

Task 0 is `main` with this plan merged: stage A complete at 9c5cbfb, the plans of stages D
(cadb490) and B (4437256) merged.

| # | Task | Depends on (stage E) | Merges after (other stages) | Wave | Shared files | Size (code + tests) |
|---|---|---|---|---|---|---|
| 90 | The filter's rule: words, the short id, the chips | 0 | — | 1 | — | ~450 |
| 91 | Stacks | 0 | — | 1 | — | ~350 |
| 94 | The page's own icon | 0 | — | 1 | — | ~350 + the icon files |
| 92 | The quick switcher's ranking | 90 | — | 2 | — | ~400 |
| 93 | The page's texts of search | 90 | — | 2 | — | ~250 |
| 96 | Search in the list message | 90, 91, 92 | D 34, B 51, C 70, C 73; B 55 (S2 12.2) | 3 | yes | ~650 |
| 95 | The selected session the list does not show | 96 | D 34, B 51, C 70; D 37, B 55, C 75; D 38 | 4 | yes | ~450 |
| 97 | The list on the page: chips, stacks, the icon's links | 93, 94, 96 | D 34, B 55; D 37, C 75 | 4 | yes | ~700 |
| 98 | The quick switcher on the page | 95, 97 | D 37, B 55, C 75; D 36, B 54, C 74; C 73 (S2 12.7) | 5 | yes | ~900 |
| 99 | Documentation of stage E | all | B 50, D 39, B 56, C 79 | 6 | yes | docs only |

```
wave 1:  90  91  94      start at once, beside stages B, C and D
wave 2:  92  93          once 90 is merged; still no file another stage edits
wave 3:  96              built at once; merges after the other stages' tasks of its row
wave 4:  95  97          their files are disjoint but for sentences of S2 12.9
wave 5:  98
wave 6:  99
```

**Can start at once:** 90, 91 and 94. They create only new files (94 also edits
`src/window/assets.ts` and its test, which no other stage touches), so they also merge at once.
92 and 93 follow 90 and are just as free of shared files. Every later task edits files that
stages B, C and D edit: by the order D → B → C → E it may be built before those stages' tasks of
its row are merged, and it merges `origin/main` after they have landed, resolving the places of
its **To resolve** line. Between themselves: 96 comes first (it needs only 90–92 of stage E);
95 follows it because both edit `src/window/protocol.ts`, `build.ts` and their tests; 97 draws
what 96 sends; 98 uses 95's helper in `web/app.js` and 97's list (`reveal`) and style sheet. The
critical path is 90 → 92 → 96 → {95, 97} → 98 → 99. Task 99 may start its reading while 98 is
built.

**Why the new modules are in a directory of their own.** `test/window/view/build.test.ts` pins
the exact list of files of `src/window/view/` and the values they may import (lines 1108–1126);
D 34, B 51 and C 73 each extend those lines, in that order. A new file beside theirs would tie
the first three tasks of stage E to C 73's merge. The pinned case reads only the files directly
in `src/window/view/`, so the files of `src/window/view/search/` do not change it; until task 96
the import rule of 2.1 holds for them through task 90's `imports.test.ts`. Task 96 — which makes
`build.ts` call them and merges after C 73 — extends the pinned case to the subdirectory (its
files pinned by name, the same rule for their imports), so that from then on the one case
covers every file of the view model.

**Every file each task creates or modifies.** Each task's own **Files** list below is exactly
this row; a file not in a task's row is not that task's to touch. Files of other stages are
marked **shared**.

| Task | Creates | Modifies |
|---|---|---|
| 90 | `src/window/view/search/filter.ts`, `test/window/view/search/filter.test.ts`, `test/window/view/search/imports.test.ts` | — |
| 91 | `src/window/view/search/stacks.ts`, `test/window/view/search/stacks.test.ts` | — |
| 92 | `src/window/view/search/switcher.ts`, `test/window/view/search/switcher.test.ts` | — |
| 93 | `web/search-text.js`, `test/web/search-text.test.ts` | — |
| 94 | `web/icons/skydeck.svg`, `web/icons/icon-16.png`, `web/icons/icon-32.png`, `web/icons/icon-48.png`, `web/icons/icon-192.png`, `web/icons/icon-512.png`, `web/icons/icon-192-maskable.png`, `web/icons/icon-512-maskable.png`, `web/icons/favicon.ico`, `web/manifest.webmanifest`, `scripts/icons.ts`, `test/window/icons.test.ts` | `src/window/assets.ts`, `test/window/assets.test.ts` |
| 96 | `test/window/view/search-list.test.ts`, `test/window/protocol-search.test.ts` | `src/window/view/search/filter.ts`, `stacks.ts`, `switcher.ts` (their message types now come from `protocol.ts`); **shared:** `src/window/protocol.ts`, `src/window/view/build.ts`, `test/window/protocol.test.ts` (the two cases that pin stage A's view without `chips`), `test/window/view/build.test.ts` (the pinned case extended to `search/`, the allowed imports; the cases that pin design 7.4's filter in the window), `test-page/list.test.ts` (its one case, at about line 487, that expects a done session to stay hidden while filtering), `docs/design-step-2.md` (4.3, 8.2.3, 12.2, 12.8) |
| 95 | `test-page/hidden-selection.test.ts` | **shared:** `src/window/protocol.ts`, `src/window/view/build.ts`, `web/pane.js`, `web/app.js` (the selected session's row, in three places), `web/edit.js` (stage D's: `update` reads that row), `test/window/view/build.test.ts` (new cases only), `test/web/pane.test.ts` (new cases only), `docs/design-step-2.md` (8.2.3's `selectedRow`, 12.6, 12.9) |
| 97 | `web/chips.js`, `web/search.css`, `test-page/search.test.ts`, `test-page/icon.test.ts` | **shared:** `web/list.js`, `web/index.html` (the style sheet and the icon's links only), `docs/design-step-2.md` (8.2.1, 12.12; 12.2's look of a stack; 12.9's ← → on a stack) |
| 98 | `web/switcher.js`, `test-page/switcher.test.ts`, `test/window/switcher-offer.test.ts` | `web/search.css` (the switcher's styles); **shared:** `src/window/server.ts` (the offer, one statement in `listFor`), `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html` (`#switcher`, the `Switch…` button, the key bar's hint), `test/web/keys.test.ts`, `test-page/shell.test.ts` (the Ctrl+Shift+P steps of the later-keys case), `test-page/keys.test.ts` (its Ctrl+Shift+P step), `docs/design-step-2.md` (12.7, 12.8's switcher, 12.9) |
| 99 | — | **shared:** `docs/install.md`, `docs/manual-checks.md`, `README.md`, `docs/design-step-2.md` (18, 19) |

Should an existing case of a file not in a task's row fail because of the task (a page case that
counts the list's elements, say), the implementer tells the lead the file and the case before
changing anything.

**The design, section by section.** Wave 1 and 2 tasks write no design text (the design is shared
by every stage); each decision of 1a names the later task that records it. 96 writes S2 4.3,
8.2.3 (`view`'s fields, the row's `stack`, `list`'s `switcher` and `filtering`), 12.2 (the rule
of stacks) and 12.8 (the filter, the chips, the switcher's ranking); 95 writes S2 8.2.3's
`selectedRow`, 12.6 and 12.9 (the hidden selection); 97 writes S2 8.2.1 and 12.12 (the icon),
12.2's sentence on how a stack looks and 12.9's on ← → with a stack; 98 writes S2 12.7 (the
offer in the switcher), 12.8's sentences on a pick, and 12.9's on the switcher; 99 writes S2 18
and 19. 95 and 97 both write sentences of S2 12.9, each its own: the second to merge keeps both.
Should a conflict come with another stage's text, the second to merge rebases and keeps both
edits.

## 1a. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| E1 | The rules of search are pure functions in `src/window/view/search/` (`filter.ts`, `stacks.ts`, `switcher.ts`), called by `build.ts`. They import values only from each other and from `text`'s `sanitize`, types from anywhere the view model may. The window's filter is S2 12.8's rule (E2); design 7.4's `matchesFilter` stays for `ls` and the interactive list, and `build.ts` no longer imports it (A8 keeps `isListed`). | S2 4.3: the view model is pure and in `src/window/view/`; a directory of its own lets the new rules be built beside the stages that edit `build.ts` (section 1). | 96 (4.3) |
| E2 | **The words.** A search text (the filter's, the switcher's) is split at white space (`/\s+/u`: spaces, tabs, line breaks, the no-break space), empty parts dropped, lower-cased with `toLowerCase()`, the first 16 kept, each cut to its first 64 UTF-16 units, a repeated one once. A row matches when every word is found (`String.prototype.includes`) in one of its fields — the title, the group, the note (sanitised line by line), the directory, and of each attached pull request `owner/repo`, its number and `owner/repo#number` (design 7.4's fields) — or, for a word of at least 4 characters, when the session's id starts with it (S2 12.8's short id; the whole id too). | S2 12.8: "several words must all match", the short id. A prefix of at least 4 characters, so that a word like `2` or `fix 2` does not match nearly every session through the hex digits of its id. | 96 (12.8) |
| E3 | **The bounds.** A search text is at most 1,024 bytes of UTF-8 (stage A's limit of `view.filter`, and of `view.switcher`); at most 16 words count — the page cuts a longer text after its 16th word and says so (`the filter is cut to its first 16 words`), and the server, given more, uses the first 16; a word counts in its first 64 UTF-16 units (the server cuts it; the page sends it as typed); each field is searched in its first 16,384 UTF-16 units (a note in the first 16,384 units of its raw text); a row's lower-cased fields are made once per loaded row (a `WeakMap` on the row object, which the tick replaces when it reloads), not at every keystroke; no regular expression is ever built from a search text (the only one is the literal of E2), checked by a test; the matching runs over the rows the tick loaded, every known session. The cost is linear (rows × words × units searched; the units of all a row's fields — title, group, note, directory, three per pull request — each at most 16,384, and nothing bounds how many pull requests a row has): at 1,000 full-size notes and 16 words it can reach about 2.5 s; a real store is two orders below. A named case — 1,000 rows whose notes are 16,384 units of `a` that end with the 16 words, each `a`×31, one other letter, `a`×32 (a different letter each), so that every word scans every note to its end and none ends a row's search early — matches within 2 seconds, the least of three runs (ruled: the least of three measures the code, not the machine's load, so that a loaded CI leg does not fail it; a guard against a pattern or a quadratic step, not a benchmark, with a wide margin). | A search text is never a pattern run with unbounded cost; the cost is bounded by these sizes. A word of 1,001 bytes against 1,000 notes measured 3 s per keystroke, on the server's one thread, in review: hence the 64 units. The sizes stay (ruled): a note is searched far enough to be useful. | 96 (12.8) |
| E4 | **The chips** (S2 12.8): `Running` — the row is in Open (running or starting, in the window or elsewhere); `Open PR` — at least one attached pull request is not known to be merged or closed (S2 12.3's open ones: open, draft, never fetched, can't read); `Has note`. `view.chips` holds these three; every chip set must hold, together with every word. `Show done` is the fourth chip and is `view.showDone`, the same state as the list key `a` and the footer's `show`. | S2 12.8 names the four; three narrow the list, the fourth already exists. | 96 (8.2.3, 12.8) |
| E5 | **Filtering** is a word or a filtering chip. While filtering: done sessions are listed (with their `done` mark), every section is unfolded, every stack is flat, `doneHidden` is 0 (no footer); nothing folds (S2 12.9's rule extends to chips). Whether a list is filtering is the server's answer (`list.filtering`): the page draws its empty line (`No session matches the filter.`) and refuses to fold from it, and decides no rule. `counts`, and stage B's `needYou.count`, are taken over the rows listed WITHOUT the filter — so neither the title bar nor `(n) skydeck` moves when a filter lists a done row. Each window has its own filter, chips, opened stacks, folded Earlier, done shown, selection and switcher; what it shows of each session is the same in every window. While filtering, stage D's toast after `d` (`Marked done: hidden from the list…`) is untrue for as long as the filter lists the row: a named limit. | S2 12.8: "while a filter is set it includes done sessions and unfolds every section and stack"; S2 8.2.7; S2 4.3: the page decides no rule. | 96 (12.8) |
| E6 | **Stacks** (S2 12.2). In This week and in Earlier, each on its own, the rows of one group (the row's group, compared as the sanitised text) stack under the newest when there are at least two; a row that is `held` never stacks: one that a terminal of the window holds (running, starting or ended — it may hold a slot) or one that needs you (stage B's attention, so that a row that needs you never sits inside a closed stack where no mark shows it); nor does Open (running sessions never stack). A stack is drawn open when `view.opened` names its group or when the selected session is one of its members other than the newest (the head); the page then remembers it (ruled: a stack whose member becomes selected is added to `opened` and stays open until the user closes it, so the list does not move when the selection leaves). So the selection is never on a row hidden in a stack, however it got there (a click, Ctrl+Tab, the switcher). A view WITHOUT `opened` gets no stacks at all (ruled): a page from before task 97 cannot draw them, so `main` never hides a session between the merges of 96 and 97; task 97's list always sends `opened` (`[]` at least). That is `stackRows`'s own rule, not only its caller's (ruled, task 91): it takes `view.opened` as it comes, `undefined` gives every row `stack` null, an array (an empty one too) gives stacks. A section's `count` counts every row in it. | S2 12.2; S2 12.9: the selection is never on a row the list does not show; Ctrl+Shift+1–9 must always find a row on screen. | 96 (12.2) |
| E7 | **How a stack looks and is used.** The head shows `×4` after its ticket key (or group); a closed stack is followed by the line `+3 more in ORB-2107` (S2 12.2's example), which is no row (never selected, no `data-id`); an open stack's members follow the head, indented. A click on `×4` or on the `+3 more` line opens or closes the stack. → on a closed head opens it; ← on an open head closes it; ← on a member selects the head and closes the stack (as folding Earlier first selects the row above it); otherwise ← and → fold and unfold Earlier as in stage A. Ctrl+Shift+1–9 are unchanged: the rows with a slot never stack. `d` on a closed stack's head marks that session only: the next member becomes the head (or the last one stands alone), and stage D's selection after `d` takes the row that is then next in the section. | S2 12.2 ("a click or → expands the stack") leaves closing and the selection open. | 97 (12.2, 12.9) |
| E8 | **The switcher's state is the page's view.** `view.switcher` is the switcher's text while it is shown (null or absent while it is not); `list.switcher` carries its ranked items while it is shown, else null. Each change of the text is a `view`, which the server answers with a list at once (stage A's pages answer a view at once, outside the once-a-second rule). `view` also gains `chips` and `opened`. All three are optional fields of `view`, so that a page and the test helpers of stage A send views the parser still takes. A known limit: the server's automatic pull-request refresh (`tick.listed`, fed from the sections' rows) does not cover the members of a closed stack, the switcher's items or a hidden `selectedRow` — as it never covered a folded Earlier's rows. | The ranking is the view model's (S2 4.3: "the switcher's ranking"); the page decides no rule. | 96 (8.2.3) |
| E9 | **The switcher's ranking** (S2 12.8). Over every session the list lists with done ones shown, also those the page's filter, chips, folded Earlier or closed stacks leave out: the rows whose fields match every word of its text (E2, E3; all rows for none), ranked — needs you (stage B's attention, in B's order), open (Open's order: slots, then by opening time, then those elsewhere), not running (most recent first), done (not running and done, most recent first). At most 50 items; `more` says how many were left out. Each item carries where the words are in its title (every occurrence of each word, overlapping ones merged, at most 32; none when lower-casing changes the title's length — a named limit) and why this page's list does not show it (`hiddenBy`, E10). | One matching rule for the filter and the switcher (question 1: the mockup matched titles by subsequence); a bounded message. | 96 (12.8) |
| E10 | **A pick** (Enter on an item, a click on one). Enter and a click act only while `list.switcher.query` is the text the page last sent (after the cuts of E3); otherwise Enter waits for that list and then acts on its highlighted item, and a click does nothing (ruled: so that a fast `orb`, Enter never picks an item of the list for `or`). The switcher closes; when the list does not show the picked row, the page first changes its view so that it does — the filter and the chips cleared (the key bar says `the filter was cleared to show <short id>`), done sessions shown, Earlier unfolded, as `hiddenBy` says; then it selects the row and does what Enter on that row in the list does (S2 12.6): a session with a terminal of the window shows it (an open one with the keyboard; an ended one under its bar); a session elsewhere shows its card; one that is not running is resumed into the window (11.3), and a refusal shows on its card (an expired one too, as the list's Enter). A closed stack needs nothing (E6). | S2 12.8: "Enter switches to a running one and resumes one that is not running"; S2 12.9: the selection is never on a row the list does not show, and the card must be shown for a refusal to be seen (question 2). | 98 (12.8) |
| E11 | **The switcher is modal**, by stage D's rule for its dialogs (D2): a scrim covers the window; while the switcher is shown `app.js` moves the keyboard nowhere (no `setZone`, `giveKeyboard`, `keepKeyboard` or `terminalView.focus` for a result, a list or a render) and acts on no list key; Ctrl+Shift+P closes it; every other window chord, Ctrl+Shift+H too, says `close the switcher first (Esc)` and does nothing else — its footer names its keys, and the help never covers its items; the reload keys reload as usual (nothing typed there is worth keeping). Opening it hides the help when the help is shown; stage D's toast lies under the switcher's panel and over its scrim, so that it never covers the items and its Undo can still be clicked. In its field: ↑ ↓ move the highlight, PgUp PgDn by a page, Enter picks, Esc closes, Tab and Shift+Tab stay in the field (they do nothing); every other key is text. A mousedown in the panel anywhere but in the field is cancelled, so that the keyboard never leaves the field (a heading or the footer would otherwise take it, and the modal rule would never give it back). A click on an item picks it; a click outside the panel closes it. While the page is not connected it shows `skydeck's server is not connected` in place of its items, and Enter waits (E10). When it closes without a pick the keyboard goes back where it was; after a pick, where the pick puts it (a terminal this page's resume brought meanwhile takes it then, as after D's dialogs). A held Esc that closes it over a terminal sends the program nothing (stage A's held-key rule); Esc while the New form is open closes the switcher only (app.js's Esc branch of the form comes after the modal check). Ctrl+Shift+P, and a click on the title bar's `Switch…` (which goes through the same gate of a window chord, stage B's B15), while one of D's dialogs is shown say D's `close the edit first (Esc)` and open nothing. | D2; S2 12.9 names only the chord. | 98 (12.9) |
| E12 | **The restore offer in the switcher** (S2 12.7, stage C) is never one Enter away (ruled). It is listed only in COMMAND FORM (ruled, as the mockup's toast says, "> restore"): a switcher's text whose first character is `>` (nothing trimmed before it) is a command whatever follows, and lists no session; the offer is listed when what follows the `>`, trimmed and lower-cased with `toLowerCase()`, is a start of `restore` of at least one letter (`>r`, `> rest`, `>Restore`, `> RESTORE`); `>` alone and `> foo` list neither the offer nor a session. Any other text searches sessions only, so `restore drill`, typed for a session, never puts the offer under the highlight, and ` >restore` (a space first) searches sessions for the word `>restore`. Never for an empty text. And only while stage C's banner is not shown (S2 12.7's case after "Not now": `banner.shown` false), holds preselected entries and no restore runs. Whether it is listed is the server's answer: `list.switcher.restore` (`restoreOffer`, 2.2), set by `listFor` after stage C has put the banner on the list. Listed, it is the switcher's first entry, `Restore <n> sessions from <time>` (`1 session`; `n` the preselected entries; the time from C's `activityTime` with the page's own clock in milliseconds, `Date.now()`, as C's banner calls it — never the switcher's `now()`, which is the server's time in nanoseconds); its Enter sends `act restore` with the preselected ids in the banner's order. Since the offer is listed only while the banner is not shown, no tick of the banner can disagree with those ids. The run's report shows where stage C shows it: C's banner draws its report while it holds lines, whatever the payload says (ruled for stage C's plan), so stage E changes nothing of C's page. | S2 12.7: "the switcher still offers 'Restore 3 sessions from <time>' until the next WSL restart"; S2 12.6: a resume costs a process, and Ctrl+Shift+P, Enter must not start every preselected session. | 98 (12.7) |
| E13 | **The selected session the list does not show** (stage A's known limit, S2 12.6). `list` gains `selectedRow`: the row of the session `view.selected` names, as the sections would carry it, also when they leave it out (a filter, the chips, done hidden, a folded Earlier). The page uses it only when its id is the page's own selection (the server's answer can be for the selection before, until the next list or while the connection is lost). One helper of the page, `sessionRow(list, id)` — the sections' row of that id, else `selectedRow` when its id is that id, else null — gives "the selected session's row" everywhere: to `paneFor`, to stage D's handlers of the header's `edit` and `done`, and to D's `editor.update`. With such a row the pane is decided as for a listed row, by `row.terminal` (the server's answer, not the page's guess from the terminals): a terminal of the window is shown with that row, its header (stage D's, so it can be edited) and its ended bar with Resume and Close at once. Without a terminal the right side shows nothing, as S2 12.9 says (ruled for stage A's task 27). The list still shows no row selected and its keys act on none; when the filter shows the row again it is selected again. A session the view model does not list even with done ones shown (an ended terminal of a session without a transcript) has no `selectedRow`: its bar stays stage A's, without Resume — the limit narrows to that case. | Stage D's plan leaves exactly this to stage E (its section 5). | 95 (8.2.3, 12.6, 12.9) |
| E14 | **The icon** (S2 12.12). `web/icons/skydeck.svg` is the source; `icon-16/32/48/192/512.png`, and `icon-192-maskable.png`, `icon-512-maskable.png` (the drawing inside the maskable safe zone, the middle 80 %, on a full background), and `favicon.ico` (the 16, 32 and 48 PNGs in one ICO) are made once from it by `scripts/icons.ts` with Playwright's Chromium and committed. `web/manifest.webmanifest` holds `name` and `short_name` `skydeck`, `display` `standalone` and the seven PNGs, their `src` with `/assets/__VERSION__/`; it is served only as `GET /manifest.webmanifest` with the build put in (as `index.html`), `application/manifest+json`; `GET /favicon.ico` is `web/icons/favicon.ico`, `image/x-icon`; both `no-store` (stage A's rule for paths outside `/assets/`) and with the headers every answer carries. `index.html` names the versioned `favicon.ico` (`sizes="16x16 32x32 48x48"`) and the manifest. Nothing is fetched from outside, at build time or at run time. | S2 8.2.1 lists both paths; S2 12.12 the files; no build step. | 97 (8.2.1, 12.12) |

## 2. Contracts

Every name below must exist with exactly this signature; stage A's contracts (its section 2), and
those of stages B, C and D as merged, hold where these do not change them.

### 2.1 Conventions

- Stage A's 2.1 holds: the import rules, only `src/platform/real.ts` opens a socket or starts a
  program, foreign input is parsed by validators that never throw, times in messages are
  nanoseconds as decimal strings.
- **`src/window/view/search/`** imports values only from `./*.ts` (its own files) and
  `../../../text/sanitize.ts`; types from `sessions`, `../../protocol.ts`, `../../hub.ts` and
  `../sections.ts`. Task 90's `test/window/view/search/imports.test.ts` checks every `.ts` file of
  the directory, whatever its name, and that none of them holds `RegExp(` (a constructor or a call).
  In every file of the directory it also refuses `.match(`, `.matchAll(` and `.search(` with an
  argument that is not a regular-expression literal: those three build a pattern from a string, a
  door the `rg` line below does not see, so in this directory a pattern is written as a literal
  where it is used (ruled on task 90's review 1; it binds tasks 91, 92 and 96); and it judges a bare
  `import '…'` and an `import('…')` by the same allowed sources as a static import. The check reads
  the files' text: it stops a slip, not code written to get past it (an alias of `RegExp`,
  `Reflect.construct`, `String.prototype.match.call`, a computed member such as `t['match']`,
  `import(name)`, an `import()` of a template or with a comment before its source
  (``import(`node:fs`)``, `import(/* x */ 'node:fs')`), a static import with a comment between
  `from` and its source (`from /* x */ 'node:fs'`), `process.getBuiltinModule('node:fs')`,
  `require('node:fs')`), which review keeps out (ruled on task 90's review 2). This prints nothing
  after task 90 and every later one (the globs leave out the page's files that are not there yet):
  ```sh
  # no pattern is built from a search text
  rg -n "RegExp\s*\(" src/window/view/search web -g '*.ts' -g 'search-text.js' -g 'chips.js' -g 'switcher.js'
  ```
- **Text, never markup.** Every text a user or a program wrote — a title, a label, a group, a
  note, a directory, a search text, a highlighted match, the group of a stack — reaches the DOM
  through `textContent` or a field's `value`, or a `title` tooltip; a highlight is built as text
  nodes and `mark` elements whose `textContent` is set. Never `innerHTML`, never an element built
  from such text, never an attribute but `title` (attributes hold ids and fixed words only). The
  ranges of a highlight are clamped to the title on the page, so that a wrong range shows less,
  never more.
- **Logs** carry kinds and counts only: never a filter, a switcher's text, a group, a title.

### 2.2 The view model of search: `src/window/view/search/` (tasks 90, 91, 92)

```ts
// src/window/view/search/filter.ts — task 90; pure
/** E3. */
export const MAX_WORDS = 16;
/** E3: a word counts in its first MAX_WORD_UNITS UTF-16 units. */
export const MAX_WORD_UNITS = 64;
/** E3: each field is searched in its first FIELD_UNITS UTF-16 units. */
export const FIELD_UNITS = 16_384;
/** E2: a word matches the session id only as its start, and only with this many characters. */
export const ID_PREFIX_MIN = 4;
/** E9: the most ranges foundIn gives. */
export const MAX_FOUND = 32;

/** E4 (task 96 moves this type into protocol.ts, unchanged, and imports it from there). */
export type SearchChip = 'running' | 'open-pr' | 'note';
export const SEARCH_CHIPS: readonly SearchChip[]; // ['running', 'open-pr', 'note']

/** E2, E3: the words of a search text — split at /\s+/u, empty parts dropped, toLowerCase, the
 *  first MAX_WORDS, each cut to its first MAX_WORD_UNITS units (never inside a surrogate pair),
 *  then each once in order. */
export function searchWords(text: string): string[];

/** What a row is searched in (E2, E3): its fields lower-cased and cut to FIELD_UNITS, and its id.
 *  Made once per row object (a WeakMap); the same row gives the same object. */
export interface Searchable { readonly fields: readonly string[]; readonly id: string }
export function searchable(row: ListRow): Searchable;

/** Every word is in a field, or (ID_PREFIX_MIN characters or more) starts the id. [] matches. */
export function matchesWords(target: Searchable, words: readonly string[]): boolean;

/** E4: every chip set holds. `open`: the row is in Open (build.ts knows it: running, or
 *  starting in a terminal of the window). [] matches. */
export function matchesChips(row: ListRow, open: boolean, chips: readonly SearchChip[]): boolean;

/** E5: a word or a chip. */
export function isFiltering(words: readonly string[], chips: readonly SearchChip[]): boolean;

/** E9: where the words are in `text` (a title as the row carries it): [start, end) in UTF-16
 *  units of text, every occurrence of each word, overlapping or touching ones merged, in order,
 *  the first MAX_FOUND; only in the first FIELD_UNITS units; [] when text.toLowerCase() has
 *  another length than text, or for no word. */
export function foundIn(text: string, words: readonly string[]): [number, number][];
```

```ts
// src/window/view/search/stacks.ts — task 91; pure
/** RowPayload.stack (E6; task 96 moves this type into protocol.ts, unchanged). */
export interface StackPayload {
  /** The group the stack is of (the rows' group, as sanitised). */
  group: string;
  /** Its rows, the head included: at least 2. */
  size: number;
  /** E6: `opened` names the group, or a member other than the head is selected. */
  open: boolean;
  role: 'head' | 'member';
  /** The head's session id. */
  head: string;
}
export interface StackEntry {
  readonly id: string;
  readonly group: string | null;
  /** E6: a terminal of the window holds the row (its `terminal` is not null), or it needs you
   *  (its `attention` is not null, stage B): it never stacks. */
  readonly held: boolean;
}
/**
 * E6 for the rows of one section (This week or Earlier), in the section's order (most recent
 * first). Returns the rows to draw, in order: every row that is in no stack, at its place; each
 * head at its own place (the first of its group's rows that are not held); right after an open
 * stack's head, its other members in their order; a closed stack's other members left out. A
 * group with one row that is not held is no stack. `stack` is null for a row in no stack.
 * `opened` is `view.opened` as it comes (ruled, task 91): `undefined` → no stacks at all, every
 * row as it is with `stack` null; an array, an empty one too → stacks, those of the groups it
 * names open (the function builds its own set).
 */
export function stackRows<T extends StackEntry>(
  rows: readonly T[],
  opened: readonly string[] | undefined,
  selected: string | null,
): { entry: T; stack: StackPayload | null }[];
```

```ts
// src/window/view/search/switcher.ts — task 92; pure (its types move into protocol.ts in task 96)
export type SwitchRank = 'need' | 'open' | 'not-running' | 'done';
/** E10: what the page changes so that its list shows the row, in this order of meaning:
 *  `filter` — its words or chips do not match the row; `done` — the row is done and not open and
 *  the view shows no done sessions once the filter is cleared; `folded` — the row is in Earlier
 *  and Earlier is folded once the filter is cleared. [] when the list shows the row. */
export type HiddenBy = 'filter' | 'done' | 'folded';
export interface SwitchItem {
  rank: SwitchRank;
  row: RowPayload;
  /** foundIn(row.title, words). */
  found: [number, number][];
  hiddenBy: HiddenBy[];
}
/** E12: stage C's offer, listed in the switcher. */
export interface RestoreOffer {
  /** The preselected entries: at least 1. */
  count: number;
  /** The banner's `lastActivityNs`. */
  lastActivityNs: NsText | null;
  /** The preselected entries' ids, in the banner's order. */
  sessionIds: string[];
}
export interface SwitcherPayload {
  /** The text it answers (view.switcher), as the page sent it; E10's picks compare it. */
  query: string;
  /** E12 (ruled): the text is in command form — its first character is `>` — so `items` is []
   *  and `more` 0; the page says so from this field and never tests the text itself. */
  command: boolean;
  items: SwitchItem[];
  /** How many matching sessions were left out after MAX_ITEMS. */
  more: number;
  /** E12: switcherPayload gives null; the server's listFor sets it (task 98). */
  restore: RestoreOffer | null;
}
export const MAX_ITEMS = 50;
/**
 * E12, over stage C's banner payload (structurally: only these fields are read): an offer when the
 * text is in command form and names the restore — its first character is `>` (nothing trimmed
 * before it) and what follows, trimmed and lower-cased with toLowerCase(), is a start of `restore`
 * of at least one letter (`>r`, `> rest`, `>Restore`, `> RESTORE`) — the banner is not null,
 * `shown` and `running` are false and at least one entry is preselected; else null. `>` alone and
 * `> foo` give none; a text whose first character is not `>` never does (ruled). The offer starts
 * programs, so what is not positively known gives none (ruled): `shown` and `running` must be
 * `false` itself, and an entry counts only when its `preselected` is `true`.
 */
export function restoreOffer(
  query: string,
  banner: {
    readonly entries: readonly { readonly sessionId: string; readonly preselected: boolean }[];
    readonly lastActivityNs: NsText | null;
    readonly shown: boolean;
    readonly running: boolean;
  } | null,
): RestoreOffer | null;
export interface SwitchCandidate {
  row: RowPayload;
  searchable: Searchable;
  /** In Open (running, or starting in a terminal of the window). */
  open: boolean;
  /** The row needs you (stage B's attention); false without stage B. */
  need: boolean;
  hiddenBy: HiddenBy[];
}
/**
 * E9. `candidates`: every session the list lists with done ones shown, in S2 12.1's order —
 * Open's rows in Open's order, then the others most recent first (build.ts sorts them). Those
 * whose row matches every word of searchWords(query) — all of them for none — ranked: `need`
 * (in needOrder's order, then any that needOrder lacks in the candidates' order), `open`,
 * `not-running` (not open, not done), `done` (not open, done); inside each rank in the
 * candidates' order. The first MAX_ITEMS; `more` the rest; `restore` null. A text in command
 * form — its first character `>`, whatever follows (E12, ruled) — lists no session: `command`
 * true, `items` [] and `more` 0; any other text gives `command` false.
 */
export function switcherPayload(
  query: string,
  candidates: readonly SwitchCandidate[],
  needOrder: readonly string[],
): SwitcherPayload;
```

### 2.3 Messages: `src/window/protocol.ts` (tasks 96, 95)

```ts
// Task 96. Moved here unchanged from src/window/view/search/: SearchChip, StackPayload,
// SwitchRank, HiddenBy, SwitchItem, RestoreOffer, SwitcherPayload (the search modules then
// import them).
/** E6: the most groups view.opened names. */
export const MAX_OPENED = 64;
// ViewMessage gains, each optional, after `selected` (absent: none — as a page before stage E
// sends; absent `opened`: no stacks at all, E6):
  /** E4: each once. */
  chips?: SearchChip[];
  /** E6: the groups whose stacks the user opened; at most MAX_OPENED, each a text, each once. */
  opened?: string[];
  /** E8: the switcher's text while it is shown; null while it is not. */
  switcher?: string | null;
// RowPayload.stack: StackPayload | null        (stage A: null; the line under B's `attention`)
// ListMessage gains, after `dirs`, each optional for the reader: a list without it (a scripted
// list of the helpers, a server before stage E) counts as null, or as false:
  /** E5: the view's words or chips are set (the page draws its empty line and folds nothing). */
  filtering?: boolean;
  /** E8, E9: while view.switcher is a string; else null. */
  switcher?: SwitcherPayload | null;

// Task 95. ListMessage gains, after `switcher`:
  /** E13: the row of the session view.selected names, as the sections would carry it (its
   *  `stack` null), also when they leave it out; null when the view selects none or a session
   *  the view model does not list even with done ones shown. The page uses it only when its id
   *  is the page's selection. */
  selectedRow?: RowPayload | null;
```

Limits `parsePageMessage` applies (stage A's rules for the rest): `chips` an array of distinct
values of `SearchChip`; `opened` an array of at most 64 distinct strings, each a text (1,024 bytes
of UTF-8, well formed); `switcher` null or a text (1,024 bytes, well formed). An unknown chip, a
repeated one, a 65th group, a group of 1,025 bytes, a switcher's text of 1,025 bytes and a lone
surrogate are each refused (`{ ok: false, kind }`, the kind holding none of the text).

### 2.4 The view model: `src/window/view/build.ts` (tasks 96, 95)

```ts
// ViewInput.view gains (optional, so that stage B's notifier and every caller of stages A–D
// compile unchanged):  chips?: readonly SearchChip[]; opened?: readonly string[]; switcher?: string | null
```

`buildListMessage` (task 96), changes to stage A's rule, in this order:
- `words = searchWords(view.filter)`, `chips = view.chips ?? []`; a row matches when
  `matchesWords(searchable(row), words) && matchesChips(row, open, chips)`;
  `filtering = isFiltering(words, chips)`, sent as `list.filtering`.
- Listed as in stage A, but while filtering done rows are listed too (as with `showDone`), and
  `doneHidden` is 0; the sections show the matching rows; while filtering no section is folded.
  `counts` and stage B's `needYou.count` are taken over the rows that are listed WITHOUT the
  filter (stage A's rule: `isListed` with `showDone`), not over those a filter adds (E5).
- This week and Earlier, while not filtering: `stackRows(entries, view.opened, view.selected)`,
  `view.opened` as it comes (absent: no stacks, E6 — `stackRows` gives every row `stack` null;
  never `new Set(view.opened)`, which is an empty set and would close every stack); each drawn row's
  payload gets its `stack`; a section's `rows` are the drawn rows, its `count`, `firstNs` and
  `lastNs` all its rows' (a folded Earlier: `rows: []` as in stage A). A row is `held` when its
  payload's `terminal` or its `attention` is not null.
- While `typeof view.switcher === 'string'`: `switcher = switcherPayload(view.switcher,
  candidates, needOrder)`, the candidates every row that is listed with done ones shown, sorted
  as 2.2 says (Open's comparator for the open ones, the recent-first one for the others), each
  with its `hiddenBy` for this view (2.2's meanings) and `need` = its payload's `attention` is not
  null; `needOrder` is stage B's `attentionOrder` over those that need you (B's 2.4), [] without
  stage B. Otherwise `switcher: null`. Its `restore` is null here; `listFor` sets it (2.6). Its
  `command` (2.2) is `switcherPayload`'s, passed on as it is.
- Stage B's `needYou.order`, stage C's banner and the rest are untouched by any of it.

`buildListMessage` (task 95): `selectedRow` is the payload the loop made for the candidate whose
id is `view.selected` (listed, or a done one), with `stack: null`; null when there is none.

### 2.5 The page's modules (tasks 93, 95, 97, 98): changes to stage A's contract 2.9

```js
// web/search-text.js — task 93; pure, no DOM (node:test and the root tsc load it)
export const MAX_WORDS = 16;
/** E3: `text` up to the end of its MAX_WORDS-th word, split as the server splits (/\s+/u; a
 *  zero-width or control character is part of a word); `cut` when a word came after it; a text
 *  with no more words as typed; a word never cut. searchWords(cutWords(t).text) equals
 *  searchWords(t) (task 93's parity test). */
export function cutWords(text) {}            // → { text: string, cut: boolean }
/** E7: `×4`. */
export function stackBadge(size) {}          // → string
/** E7: `+3 more in ORB-2107` for a stack of 4; the group passed through list-text.js's sanitize. */
export function moreText(size, group) {}     // → string
/** The parts of `text` with `found`'s ranges marked; ranges out of order, overlapping, empty or
 *  past the end are clamped or dropped (task 93 says how), so that the parts always join to
 *  `text`; a part is text for `textContent`, never markup. */
export function highlightParts(text, found) {} // → { text: string, found: boolean }[]
/** E9: 'Needs you', 'Open', 'Not running', 'Done'. */
export function rankHeading(rank) {}         // → string
/** The switcher's footer: `↑ ↓ move · Enter <action> · Esc close`, then ` · <n> more: type to
 *  narrow` when more > 0. action: 'switch' | 'resume here' | 'restore'. */
export function switcherFooter(action, more) {} // → string

// web/pane.js — task 95
/** E13: the selected session's row — the sections' row of `id`, else `list.selectedRow` when
 *  its id is `id`, else null (also for a null list or id). The one helper for it: app.js's call
 *  of paneFor, stage D's `edit` and `done` handlers in app.js and `editor.update` in edit.js use
 *  it, and nothing else looks the row up. */
export function sessionRow(list, id) {}      // → RowPayload | null
// paneFor(selected, rows, terminals, newOpen, selectedRow = null): `selectedRow` is what
// sessionRow gave for a session the rows lack (null otherwise). With a row — listed, or that one —
// the pane is decided by `row.terminal`, as for a listed row; with none, as in stage A (a terminal
// whose sessionId is the selection, with row null; else 'none').

// web/chips.js — task 97
/** @param {HTMLElement} root  the row of chips under the filter field (list.js makes it)
 *  @param {{ toggle(chip: 'running' | 'open-pr' | 'note' | 'done'): void }} hooks */
export function createChips(root, hooks) {}  // → { render(chips: readonly string[], showDone: boolean): void }
// Four buttons, `Running`, `Open PR`, `Has note`, `Show done`, each with aria-pressed; their
// mousedown is cancelled, so that a click leaves the keyboard where it was (D17).

// web/list.js — task 97
// hooks.view's change gains   chips?: SearchChip[], opened?: string[]
// createList returns also     reveal(hiddenBy: HiddenBy[]): void   — E10: `filter` clears the
//   field and the chips, `done` turns Show done on, `folded` unfolds Earlier; one hooks.view with
//   every field that changed, none when nothing did. Task 98 calls it.
// The list keeps the chips and the opened stacks as it keeps showDone: its own state, sent whole
// through hooks.view, `opened` in every view it sends (`[]` at least, E6) — at most 64 groups (the
// parser's MAX_OPENED, a number the page holds itself, since web/ imports only types from src/),
// the oldest dropped; a group that is not well formed or over 1,024 bytes is never sent (the
// server would refuse the view and close the connection), so its stack opens only while a member
// is selected (a named limit). E6's memory: when a list comes whose selected row is a `member`
// of a stack whose group `opened` lacks, the list adds the group and sends the view. Whether the
// list is filtering is `list.filtering` (absent: stage A's `filter.value !== ''`): the empty line,
// and folding (nothing folds while filtering).
// Hooks kept for the shared helpers: exactly one `#list [data-id]` per drawn row (the `+n more`
// line carries `data-head`, never `data-id`); `data-selected="true"` on the selected row only;
// `#list input.list-filter` always there; `#list` takes the keyboard. A member's element carries
// `data-stack="member"`, a head's `data-stack="head"`.

// web/switcher.js — task 98
/** @param {HTMLElement} root  #switcher (index.html, task 98)
 *  @param {{ text(value: string): string,         // its field changed: app.js sends view.switcher
 *                                                 // and answers the text it sent (after the cuts)
 *            pick(item: SwitchItem): void,        // Enter on the highlighted item, or a click on one
 *            restore(sessionIds: string[]): void, // Enter on the restore offer (E12)
 *            closed(): void,                      // once whenever it closes, whatever closed it
 *            now(): string }} deps                // the server's now (stage D's serverNow), for ages */
export function createSwitcher(root, deps) {}
// → { open(): void, close(): void, shown(): boolean,
//     update(list: ListMessage | null): void, // every list while shown, and null while the page is
//                                        // not connected: its items, its offer; the highlight
//                                        // stays on the same session while it is there
//     escape(): void }                   // app.js hands it Esc while shown (capture phase), as D2
// E10: it acts on Enter or a click only while `list.switcher.query` equals the text `deps.text`
// last answered; an Enter pressed before is kept and acts on the first list that answers that
// text; a click on an item of an older list does nothing.
// Its field is `#switcher input.switcher-field`; each item `#switcher [data-id]` (not inside
// #list), the highlighted one `data-active="true"`, the offer `#switcher [data-offer]`. An item
// shows the state icon, the group dim before the title when the title does not start with it, the
// title with its found parts in `mark` elements, a second line (a running row's state line from
// list-text.js's rowText; else `not running · <age>`), then ` · <directory>`, and at the right the
// chip, the slot and the short id (dim). The offer shows `Restore <n> sessions from <time>`, the
// time from stage C's `activityTime` with `Date.now()` (E12). A mousedown in the panel anywhere but
// in the field is cancelled (E11).

// web/keys.js — task 98
// windowChord: Ctrl+Shift+P gives { kind: 'switcher' } in both zones (stage A: `later`, stage E).
// The `later` kind is removed (ruled: after stages D and B and this, nothing gives it), with
// app.js's `case 'later'` branches and `keyName`, and help.js's LATER marking.
/** E11, the switcher's field: { kind: 'move', by: 1 | -1 | 'page-up' | 'page-down' } |
 *  { kind: 'pick' } | { kind: 'close' } | { kind: 'stay' } (Tab, Shift+Tab) | null — only without
 *  Ctrl, Alt and Meta, and with Shift only for Tab. */
export function switcherKey(e) {}
```

`web/app.js` (task 95) uses `sessionRow` for the selected session's row in its three places:
`render()`'s `paneFor` call, and stage D's `edit` and `done` handlers of the header (the row they
hand to `editor.open`); `web/edit.js`'s `update(list)` takes the dialog's session's row through
it, so that a dialog whose session a filter hides meanwhile goes on finding its row.

`web/app.js` (task 98) owns: `state.view.switcher`; `changeView` cuts the filter's and the
switcher's text after 1,024 bytes (stage A) and then after 16 words (`cutWords`), the key bar
saying `the filter is cut to its first 16 words` (the switcher's footer: `only the first 16 words
are searched`), and answers the switcher the text it sent; the chord (open, or close when shown),
and the title bar's `Switch…` button through the same gate of a window chord (stage B's B15);
E11's modal rule — stage D's modal condition becomes "a dialog or the switcher is shown" —, the
help hidden when the switcher opens; `switcher.update(list)` at every list while shown, and
`update(null)` when the connection is lost; the pick: `list.reveal(item.hiddenBy)` with E10's
line when `filter` is in it, then `select` and the activation rule of stage A's `activate`,
applied to `item.row`; the restore offer: `act restore` with its ids, a refusal in the key bar
(the report is stage C's banner's); `closed()`: the keyboard back where it was, or to a terminal
this page's resume brought meanwhile. `web/index.html` gains, in task 97, the style sheet
`search.css` and the icon's two links in place of `<link rel="icon" href="data:," />`; in task
98 (ruled: `main` never shows a control that does nothing), `<div class="switcher" id="switcher"
hidden></div>` at the body's level beside `#help`, the title bar's `<button class="switch-button"
id="switch-button" type="button">⌕ Switch… <kbd>Ctrl+Shift+P</kbd></button>`, and the key bar's
hint `<kbd>Ctrl+Shift+P</kbd> switch`.

`src/window/server.ts` (task 98), in `listFor` after stage C has set `banner` on the list: while
the list has a `switcher`, `switcher.restore = restoreOffer(view.switcher, banner)` (2.2). One
statement; nothing else of the server changes.

### 2.6 The icon's files and routes (task 94)

```ts
// src/window/assets.ts — task 94
// TYPES gains   '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
// NOT_SERVED gains 'web/manifest.webmanifest'
// loadAssets also serves, when the checkout has them:
//   '/manifest.webmanifest' → web/manifest.webmanifest with the build put in (withBuild, as '/')
//   '/favicon.ico'          → web/icons/favicon.ico's bytes
// (httpHandler unchanged: both are outside /assets/, so `no-store`, with securityHeaders.)
```

```ts
// scripts/icons.ts — task 94; run once by hand (node scripts/icons.ts), never by a test or CI
// Reads web/icons/skydeck.svg; draws it with Playwright's chromium, launched by the rules the page
// suite's test-page/helpers/browser.ts follows (whose `browser(t)` needs a test context, so the
// script launches by itself): HOME and TMPDIR in a new temporary directory that the script removes
// at its end, no DISPLAY, the user's own profile never touched, every request but the data: URL it
// loads aborted. It draws at 16, 32, 48, 192 and 512 pixels with a
// transparent background, and the two maskable ones (the drawing scaled to the middle 80 % on
// the full background colour); writes the PNGs and favicon.ico (the ICO directory with the 16,
// 32 and 48 PNGs as its images).
```

## 3. Tasks

### Task 90: The filter's rule — words, the short id, the chips

**Depends on:** 0 · **Merges after:** — · **Wave:** 1 · **Design:** S2 4.3, 12.8, design 7.4 · **Contracts:** 2.1, 2.2 (`filter.ts`) · **Decisions:** E1, E2, E3, E4, E5 (recorded by 96) · **Shared files:** none

**Goal.** The one rule by which the filter and the switcher match a session, with its bounds, as
pure functions, tested without a browser.

**Files**
- Create: `src/window/view/search/filter.ts`, `test/window/view/search/filter.test.ts`,
  `test/window/view/search/imports.test.ts`

**Behaviour.** As 2.2. `searchable` builds the fields of E2 from the row as step 1 loads it (its
strings are sanitised; the note is sanitised here, line by line, joined with `\n`), each
lower-cased and cut to `FIELD_UNITS` (the note's raw text is cut before it is sanitised, so that
the cost of a long note is bounded too).

**Tests** (platform: none — pure, step 1's builders of `test/helpers/derived.ts`)
- `searchWords`: spaces, tabs, a line break, the no-break space, U+3000 → separate words; leading
  and trailing white space; upper case lowered; a repeated word once; 17 words → the first 16; a
  word of 100 units → its first 64; a word whose 64th unit is the first half of a surrogate pair
  → cut before the pair.
- `matchesWords`: each field on its own (title, group, note, directory, `owner/repo`, the number,
  `owner/repo#number`); two words in two fields → match, one of them missing → no match; `[]`
  matches; a note's word after an escape sequence is found, the escape is not; the id: its first
  4 and its first 8 characters and the whole id match, 3 characters and a middle part do not.
- Parity with design 7.4: for every single word of a table and rows whose texts hold no control
  character, `matchesWords(searchable(row), [w])` equals `matchesFilter(row, w)` but for the words
  of the id rule.
- Literal matching: `.`, `.*`, `(`, `[a-z]`, `\d`, `^`, `$`, `|`, `+` match only themselves.
- The cut: a word that ends at unit 16,384 of a note is found, one that starts at 16,385 is not;
  the same for a title.
- The cache: the same row object gives the same `Searchable`; a reloaded copy of the row a new one.
- `matchesChips`: each chip on a row that has it and one that does not; `open-pr` true for
  `unfetched`, `cant-read`, `draft`, `approved-green`, false with only `merged` and `closed`; two
  chips together; `[]` matches. `isFiltering`: words only, a chip only, neither.
- `foundIn`: every occurrence of two words, overlapping and touching ones merged, case-insensitive;
  33 occurrences → 32; a title whose lower case is longer (`İ`) → `[]`; `[]` for no word.
- The bound of E3, the named case: 16 words, each `a`×31, one letter, `a`×32 (`b` for the first,
  `c` for the second, …); 1,000 rows whose notes are `a`s to 16,384 units with the 16 words at
  their end, so that every row matches and every word scans its note to the end → `matchesWords`
  over all of them within 2 seconds, the least of three runs (so that a loaded CI leg does not
  fail it), and every row matched (the case asserts both, so that a word that ended a row's
  search early would show).
- `imports.test.ts`: every `.ts` file of `src/window/view/search/` imports values only as 2.1 says,
  and none holds `RegExp(`, or `.match(` / `.matchAll(` / `.search(` with an argument that is not
  a literal (2.1, ruled); a bare import and an `import('…')` are judged by the same sources as a
  static import; cases of the check itself, for what it lets through and what it refuses.

**Done when:** S2 12.8's matching, E2–E5, is a tested pure function and its bounds are pinned;
`npm run check` passes.

**Not in it:** the list message (96); the page (93, 97, 98).

---

### Task 91: Stacks

**Depends on:** 0 · **Merges after:** — · **Wave:** 1 · **Design:** S2 12.2, 12.9 · **Contracts:** 2.2 (`stacks.ts`) · **Decisions:** E6 (recorded by 96) · **Shared files:** none

**Goal.** S2 12.2's rule of stacks as one pure function over a section's rows.

**Files**
- Create: `src/window/view/search/stacks.ts`, `test/window/view/search/stacks.test.ts`

**Behaviour.** As 2.2: generic over the entry, so that `build.ts` passes its own entries.

**Tests** (platform: none — plain entries)
- Two rows of one group → a stack, the first the head (`size` 2), the second left out while
  closed; one row of a group, a row without a group → no stack; three groups interleaved → three
  heads at their places, the rows in no stack between them at theirs.
- `opened` names the group → the members right after the head, `role` `member`, `head` the head's
  id, `open` true on all; another group named → closed.
- The selected session is a member → open, whatever `opened` says; the head is selected → as
  `opened` says.
- `opened` absent (`undefined`) → no stack at all, every row as it is, whatever is selected;
  `opened` `[]` → stacks, all closed (ruled, task 91).
- A held row of the group (the entry's `held`: a terminal, or a row that needs you) → drawn on
  its own, never in the stack, and not counted: with one other row of the group left, no stack.
- The order of the section is kept for every row that is drawn; nothing is drawn twice.

**Done when:** E6 is a tested pure function; `npm run check` passes.

**Not in it:** which rows a section holds (96); the drawing and the keys (97).

---

### Task 94: The page's own icon

**Depends on:** 0 · **Merges after:** — · **Wave:** 1 · **Design:** S2 8.2.1, 12.12, 15.4 · **Contracts:** 2.6 · **Decisions:** E14 (recorded by 97) · **Shared files:** none

**Goal.** skydeck's icon as committed files, and the two routes of S2 8.2.1 that serve the
favicon and the manifest. The page links them in task 97.

**Files**
- Create: `web/icons/skydeck.svg`, `web/icons/icon-16.png`, `web/icons/icon-32.png`,
  `web/icons/icon-48.png`, `web/icons/icon-192.png`, `web/icons/icon-512.png`,
  `web/icons/icon-192-maskable.png`, `web/icons/icon-512-maskable.png`, `web/icons/favicon.ico`,
  `web/manifest.webmanifest`, `scripts/icons.ts`, `test/window/icons.test.ts`
- Modify: `src/window/assets.ts`, `test/window/assets.test.ts` (new cases with a fixture that has
  the files; the two cases that pin `/manifest.webmanifest` and `/favicon.ico` as 404 use a fixture
  without them and stay as they are)

**Behaviour.** The SVG is drawn for skydeck (a simple mark that reads at 16 pixels, the page's
accent colour; the mockup's logo is a rounded square with a blue gradient), square, self-contained:
no script, no `on…` attribute, no `<foreignObject>`, no `href` or `xlink:href` but to `#…`, no
`@import`, no `url(` but to `#…`. `scripts/icons.ts` as 2.6; the implementer runs it once and
commits what it wrote, and the pull request shows the 32 and 192 PNGs. The routes as 2.6.
The manifest has no `start_url`, `scope` or `id` (ruled, review 2 of #87): the page is not meant
to be installed as an app. Without `start_url` Chromium counts it as not installable
(`start-url-not-valid`, run in the pinned Chromium with task 97's links), and the shortcut of an
installed app would hold no launch token (S2 5.1).

**Tests** (platform: `testPlatform`; the files read from the checkout)
- `icons.test.ts`: each PNG starts with the PNG signature, its `IHDR` gives the size its name
  says, 8 bits per channel, with alpha (colour type 6) for the five with a transparent background;
  the ICO's directory names three images of 16, 32 and 48 pixels whose bytes
  are those of the three PNGs; the manifest is JSON with exactly `name`, `short_name`, `display`
  and `icons`, `skydeck`, `skydeck`, `standalone`, and seven icons whose `src` is
  `/assets/__VERSION__/web/icons/<file>` of a file that exists, with its `sizes` and `type`, the
  two maskable ones `purpose` `maskable`, and no `start_url`, `scope` or `id` (a case of its
  own); the SVG holds none of what the behaviour forbids (checked by what it may hold: the
  elements and attributes of a drawing of shapes).
- `assets.test.ts`: `/manifest.webmanifest` → 200, `application/manifest+json`, `no-store`, the
  build in every `src` and no `__VERSION__` left; every `src` is served under the build, `image/png`;
  `/favicon.ico` → 200, `image/x-icon`, `no-store`, the ICO's bytes; both carry the security
  headers; `/assets/<build>/web/manifest.webmanifest` → 404; the existing cases on a checkout
  without them → both 404, unchanged; the build changes when an icon's bytes change.
- The manifest is written as Prettier formats JSON (`.webmanifest` gets Prettier's json parser,
  so `npm run format:check` reads it); the SVG, PNG and ICO files are not Prettier's.

**Done when:** the icon's files are in the repository and served as S2 8.2.1 says; `npm run
check` passes.

**Not in it:** the links in `index.html` and the page test (97); whether Edge shows it (W3, 99).

---

### Task 92: The quick switcher's ranking

**Depends on:** 90 · **Merges after:** — · **Wave:** 2 · **Design:** S2 12.8, 12.4 (the order of those that need you), 12.1 (Open's order), 12.7 (the offer) · **Contracts:** 2.2 (`switcher.ts`) · **Decisions:** E9, E12 (recorded by 96 and 98) · **Shared files:** none

**Goal.** S2 12.8's ranking of every session for the switcher, and E12's rule of the restore
offer, as pure functions.

**Files**
- Create: `src/window/view/search/switcher.ts`, `test/window/view/search/switcher.test.ts`

**Behaviour.** As 2.2; `matchesWords` and `foundIn` of task 90 do the matching. Nothing in it
knows stage B or C: `need` and `needOrder` are given, and `restoreOffer` reads only the four
fields of a banner that 2.2 names. The command form (E12, ruled): a text whose first character is
`>` lists no session in `switcherPayload`, whatever follows, and is the only text for which
`restoreOffer` can give the offer; the command after the `>` is trimmed and lower-cased with
`toLowerCase()`, so `> RESTORE` and `>Restore` name it as `>restore` does; `command` says that the
text is a command, so that the page never tests the text itself. The offer starts programs, so
what is not positively known gives none (ruled): `shown` and `running` must be `false` itself and
an entry counts only when its `preselected` is `true`; a banner that is no object, or entries that
are no array, are not guarded (the banner is the server's own typed value), and an id preselected
twice is task 73's to hold. The cost is linear in the candidates and in `needOrder` (no lookup in
`needOrder` per candidate, no sort).

**Tests** (platform: none — candidates built from step 1's builders through task 90's `searchable`)
- No text: every candidate, ranked need, open, not running, done; inside each the candidates'
  order; `need` in `needOrder`'s order, one that `needOrder` lacks after them.
- A done row that is open (a running session marked done) → `open`; a done row that needs you →
  `need`.
- Two words → only the candidates that match both; the id's prefix finds its session.
- 60 candidates → 50 items and `more` 10; with a text that 3 match → 3 and `more` 0.
- `found` is `foundIn(row.title, words)`; `hiddenBy` and `row` are passed on as they are; `query`
  is the text as given (not cut, not lower-cased); `restore` null.
- Nothing → `{ query, command: false, items: [], more: 0, restore: null }`. `command`: true for
  `>`, `> foo`, `>restore`, `>>`; false for ` >restore`, `\t>r`, `restore`, `foo >`, `''`.
- The command form (ruled): `>restore`, `>r`, `> rest`, `>Restore`, `> RESTORE`, `>`, `> `,
  `> foo`, `>foo` → `{ query, command: true, items: [], more: 0, restore: null }` over sessions
  whose titles hold those words; ` >restore` and `\t>r` (white space first) → searched as the
  session words `>restore` and `>r`; `restore` and `RESTORE old` → the sessions that hold the
  words. `switcherPayload` takes no banner: a `>` text lists no session with a banner or without
  one (task 98's case).
- `restoreOffer`: a banner with three entries, two preselected, `shown` false, `running` false →
  for `>r`, `>re`, `> rest`, `>restor`, `>restore`, `>  restore  `, `>\trestore\n`, every
  white space `trim()` strips after the `>` (U+00A0, U+FEFF, U+3000, U+2028) and, for case,
  `> RESTORE`, `>Restore`, `>R`, `>Rest` the offer (`count` 2, the two ids in the banner's order,
  its `lastActivityNs`); for `restore`, `RESTORE`, `restore old`, `x restore2`, `res`, `rest`, `x`
  and `xrestore` (no `>`: sessions only) null; for `''`, `>`, `> `, `>restores`, `>restore old`,
  `> re store`, `>x`, `> foo`, `>>restore`, `x >restore`, ` >restore`, `\t>r`, U+FEFF, U+00A0 or
  U+200B before the `>`, U+200B after it, a look-alike `>` or letter (U+FF1E, the Cyrillic
  U+0435, the long s U+017F, which `toUpperCase()` would take for `S`) and the command in quote
  marks, null; the same banner with `shown` true, with `running` true, with no entry
  preselected, and a null banner → null for `>restore`; through a cast, `shown` or `running`
  `undefined`, `null`, `0`, `''`, `'false'`, `NaN` or absent → null, and an entry whose
  `preselected` is `1`, `'true'`, `null`, `{}` or absent does not count.
- `more` counts the ranks after the one the cut falls in (55 not running and 7 done → 50 items,
  `more` 12); an id `needOrder` names twice counts at its first place; `found` is of the row's
  title (U+0130 + `stanbul fix` and `fix` → `[]`, foundIn's named limit).
- The cost: 40,000 candidates that all need you and match, `needOrder` their reverse → within
  1 second, the least of three runs (a guard against a lookup in `needOrder` per candidate).

**Done when:** E9 and E12's rule are tested pure functions; `npm run check` passes.

**Not in it:** the candidates and `hiddenBy` (96); where the offer is set (98, `listFor`, after
stage C's banner); the page (98).

---

### Task 93: The page's texts of search

**Depends on:** 90 · **Merges after:** — · **Wave:** 2 · **Design:** S2 12.2, 12.8 · **Contracts:** 2.5 (`search-text.js`) · **Decisions:** E3, E7, E9 · **Shared files:** none

**Goal.** Every text of stage E that the page writes, without the DOM, so that node:test holds
them and the page's cut of a search text is the server's.

**Files**
- Create: `web/search-text.js`, `test/web/search-text.test.ts`

**Behaviour.** As 2.5. It imports `sanitize` of `web/list-text.js` and nothing else. It is pure
page code as `web/list-text.js` is (no DOM, no clock; JSDoc types, checked by the root `tsc` and
`tsc -p web`). Ruled for task 93: the page and the server never disagree about a search text —
what a word is (E2: split at white space as `filter.ts` splits it, `/\s+/u`; a zero-width or
control character is part of a word), how many count (16, repeated ones too), that a word counts
in its first 64 units AFTER lower-casing (the server cuts it; the page sends it whole), within the
text's limit of 1,024 bytes of UTF-8 (stage A's cut in `app.js`, before `cutWords`); where this
module cuts, it gives what `filter.ts` reads from the same text. Every text a user or a program
wrote (a search text, a title, a group) is handed on as text for `textContent`, never as markup: a
highlight is given as parts, not as HTML. Nothing in the module builds a pattern from a text (no
`RegExp`, no `.match(` / `.matchAll(` / `.search(` but with a literal), and nothing is logged.
`highlightParts` takes the ranges in their order, each clamped to the text and to start no earlier
than where the last one ended, its ends moved inwards off the middle of a surrogate pair; one that
is then empty, or that is not a pair of whole numbers, is dropped; neighbouring parts marked alike
are one part and no part is empty (`[]` for an empty text). `rankHeading` of a rank it does not
know gives that rank's text sanitised and trimmed (as `sectionText` does for a section), of
anything that is not a string `''`.

**Tests** (platform: none; the test imports `filter.ts`, the page's module does not)
- Parity: for a table of texts (white space of every kind of E2 — a space, a tab, a line break,
  `\r\n`, the no-break space, U+3000, U+2028, U+FEFF … —, a zero-width space, a zero-width joiner,
  a control character, U+0085 and U+180E inside a word, 16 and 17 words, white space before and
  after them, repeated words, only white space, a word of 100 units, 1,024 bytes of one word (of
  one-byte, two-byte and four-byte characters), `İ` (lower-casing makes it two units: 40 of them,
  and 63 units then an `İ`), a surrogate pair at the server's 64th unit and at the page's cut, a
  lone surrogate, 17 words in 1,024 bytes, a 16th word of 100 units or of 70 `İ` before a 17th),
  for 17 words joined by each of the 65,536 UTF-16 units, and for 5,000 generated texts of those
  characters: `searchWords(cutWords(t).text)` equals `searchWords(t)` of task 90, `cut` is true
  exactly when a 17th word was there (for a unit: exactly when the server splits `a<unit>b` in
  two), the result is a prefix of `t`, uncut it is `t` as typed, cut it ends where the 16th word
  ends (the page does not cut a long word: the server counts its first 64 units, E3); a cut text
  is not cut again.
- `stackBadge(4)` → `×4`; `moreText(4, 'ORB-2107')` → `+3 more in ORB-2107`; a group holding an
  escape sequence, a control or a line break → sanitised; a group holding markup → as it is.
- `highlightParts`: two ranges → five parts that join to the text; ranges out of order,
  overlapping, touching, empty, reversed, past the end, negative, not whole numbers, not pairs
  (`[0, 2, 9]` too) → clamped or dropped, the parts still join to the text and none is empty; a
  range never splits a surrogate pair; a dropped range leaves no trace for the ranges after it;
  markup in a title stays text; no range → one part; the ranges of task 90's `foundIn` mark the
  words of a search text.
- `rankHeading` of each rank, of one it does not know and of no string; `switcherFooter` for each
  action, with and without `more`.
- The module's source (comments left out): no `RegExp`, no `.match(` / `.matchAll(` / `.search(`
  with an argument that is not a literal nor those names as a computed member, no `eval` or
  `Function(`, no `console`, no DOM, no clock or timer, no storage, no network, and its only
  import is `sanitize` of `./list-text.js` (no `export … from`, no `import(`).

**Done when:** the texts are tested and the page's cut equals the server's; `npm run check`
passes.

**Not in it:** the DOM (97, 98).

---

### Task 96: Search in the list message

**Depends on:** 90, 91, 92 · **Merges after:** D 34 → B 51 → C 70 (`protocol.ts` and its test, `build.ts`), D 34 → B 51 → C 73 (`build.test.ts`'s pinned case), B 55 (S2 12.2's words on a row) · **Wave:** 3 · **Design:** S2 4.3, 8.2.3, 8.2.7, 12.1, 12.2, 12.8 · **Contracts:** 2.2, 2.3, 2.4 · **Decisions:** E1–E6, E8, E9 (update S2 4.3, 8.2.3, 12.2, 12.8) · **Shared files:** `src/window/protocol.ts`, `src/window/view/build.ts`, `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `test-page/list.test.ts`, `docs/design-step-2.md`

**Goal.** The server sends each page the list its view asks for: the filter of several words and
the short id, done sessions while filtering, the chips, the stacks, and the switcher's items.

**To resolve when merging `origin/main`:** `RowPayload` in `protocol.ts` — B 51's `attention`
line sits right above `stack`, D 34 changed `chip` and the terminals' fields: only the `stack`
line is E's; the end of `ViewMessage` (E only) and of `ListMessage` (E's fields after `dirs`,
behind B 51's `needYou` after `counts` and C 70's `banner` line); `parsePageMessage`'s `view`
entry (E only); in `build.ts`, the candidates' loop where B 51 sets each row's `attention` beside
`rowPayload` and D 34 the terminals' fields, the counts (B 51's `needYou.count` and its
exclusion from `counts`), and the sections' sort; `build.test.ts` line 1111 (the pinned files:
D 34's `chip.ts`, B 51's `attention.ts`, C 73's `banner.ts`) and lines 1119–1126 (the allowed
imports: D 34's `windowChip` and `CHIP_ORDER`, B 51's): E extends the case to the subdirectory
and keeps every name theirs added; `protocol.test.ts` — its two view cases (lines 165–166,
573–582) are E's alone, beside D 34's `ROW`, B 51's `LIST` fixture and its ServerMessage case,
and C 70's cases at the end; `test-page/list.test.ts` — E's one case (lines 487–521), apart from
D 34's fixtures near line 249; S2 8.2.3's `view` and `list` rows, which D 34, B 51 and C 70 each
extend in that order: E's fields go last; S2 12.2, where B 55 writes the rows' words: E's rule of
stacks is its own paragraph.

**If absent:** without stage B no row has attention, `needOrder` is [] and the switcher has no
Needs you rank (`build.ts` imports nothing of B's), and `held` is a terminal alone; without C or
D nothing differs.

**Files**
- Create: `test/window/view/search-list.test.ts`, `test/window/protocol-search.test.ts`
- Modify: `src/window/protocol.ts` (2.3, but `selectedRow`), `src/window/view/build.ts` (2.4,
  but `selectedRow`), `src/window/view/search/filter.ts`, `stacks.ts`, `switcher.ts` (their
  message types imported from `protocol.ts`, nothing else), `test/window/protocol.test.ts` (the
  case "stage A's view has no chips" and the `@ts-expect-error` on a view with `chips`: a view
  with `chips: []` is now taken), `test/window/view/build.test.ts` (the pinned case also reads
  `src/window/view/search/`: its three files pinned by name, their value imports held to 2.1's
  rule; `build.ts`'s allowed imports gain `./search/filter.ts`, `./search/stacks.ts`,
  `./search/switcher.ts` and lose `matchesFilter`; the cases that pinned design 7.4's filter in
  the window — one text, done sessions not shown while filtering — follow E2 and E5),
  `test-page/list.test.ts` (its case at about line 487: typing `beta` while `beta done` is done
  now lists that session with its `done` mark, and no footer; nothing else of the file),
  `docs/design-step-2.md` (4.3: E1; 8.2.3: `view`'s `chips`, `opened`, `switcher`, the row's
  `stack`, `list`'s `filtering` and `switcher`; 12.2: E6; 12.8: E2–E5, E9, and the limit of
  `tick.listed`)

**Behaviour.** As 2.3 and 2.4.

**Tests** (platform: none — pure, step 1's builders; the protocol's cases as stage A's)
- `protocol-search.test.ts`: a view with each new field at its limits is taken, one over them
  refused (2.3's list); a view without them is taken (stage A's page); a kind never holds the
  text it refused (a marker in a group, a chip, a switcher's text).
- `search-list.test.ts`:
  - the filter: two words in two fields → that row only; the short id's first 4 characters;
    `fix 2` does not match through the id; the words' order does not matter; `filtering` true
    with a word or a chip, false with neither;
  - done sessions: a filter that matches a done row lists it with its `done` mark and
    `doneHidden` 0; the chip `note` alone does the same; without a filter or a chip stage A's rule;
  - the counts: `counts` and stage B's `needYou.count` are the same with and without a filter
    that lists a done row;
  - chips: each, and two together with a word; Earlier unfolded while a chip is set;
  - stacks: a view without `opened` → no stack at all, every row drawn (stage A's list); with
    `opened: []`, three rows of `ORB-1` in This week → one head with `stack` `{ size: 3, open:
    false, role: 'head' }`, `count` 3, `rows` 1; `opened: ['ORB-1']` → three rows; the selected
    member → open; the same group in Earlier → its own stack; a row with an ended window terminal
    of the group, and one that needs you (stage B's attention), → on their own; a filter → no
    stack; Open never stacks;
  - the switcher: `switcher` null without `view.switcher`; with `''` every listed session with
    done ones, ranked; a done session and one the filter hides are items, with `hiddenBy`
    `['done']`, `['filter']`, `['filter', 'done', 'folded']` as 2.2 says; with stage B's facts the
    sessions that need you first in B's order; `restore` null; `command` false for `''`, true
    with no item for `>restore`; `counts` and `needYou` the same with and without a switcher;
  - every stage A, B and D case of `build.test.ts` passes but the filter's cases named above.

**Done when:** every rule of S2 12.2 and 12.8 that the server decides is in the list a page gets,
and a page from before task 97 still gets stage A's list (no stacks); `npm run check` passes.

**Not in it:** `selectedRow` (95); the page (97, 98); the offer's place (98).

---

### Task 95: The selected session the list does not show

**Depends on:** 96 · **Merges after:** D 34 → B 51 → C 70 (`protocol.ts`, `build.ts`, `build.test.ts`; D 34 also `test/web/pane.test.ts`), D 37 → B 55 → C 75 (`app.js`), D 38 (`web/edit.js`, the header's controls) · **Wave:** 4 · **Design:** S2 8.2.3 (`selectedRow`), 12.6 (the ended bar's known limit), 12.9 (the selection) · **Contracts:** 2.3 (`selectedRow`), 2.4, 2.5 (`pane.js`, `app.js`) · **Decisions:** E13 (update S2 8.2.3, 12.6, 12.9) · **Shared files:** `src/window/protocol.ts`, `src/window/view/build.ts`, `web/pane.js`, `web/app.js`, `web/edit.js`, `test/window/view/build.test.ts`, `test/web/pane.test.ts`, `docs/design-step-2.md`

**To resolve when merging `origin/main`:** the end of `ListMessage` in `protocol.ts` (after
96's `switcher`); the object `buildListMessage` returns (B 51's `needYou`, D 34's terminal
fields, 96's fields): `selectedRow` goes last; `render()` in `app.js`, rebuilt by D 37 around
`header(row, selected, term, now)` and its render key, and touched by B 55 and C 75 (the title,
the banner): only its `paneFor(…)` call changes; D 37's `edit` and `done` handlers in `app.js`
(the row they look up) and D 38's `update(list)` in `web/edit.js` (the row it looks up): only that
lookup changes, to `sessionRow`; the ends of `build.test.ts` and `pane.test.ts`, where D 34, B 51
and C 73 add cases: E's cases go after theirs; S2 8.2.3's `list` row (after 96's fields); S2
12.6's paragraph on the ended terminal and S2 12.9's sentence on the selection (D's plan and task
97 write other sentences of 12.9: keep them).

**Goal.** A terminal of the window whose session the filter (or the chips, or done hiding, or a
folded Earlier) hides is shown with its header and an ended bar that has Resume and Close, and
stage D's header controls and dialogs find that session's row, so that it can be edited.

**If absent:** without stage D the header drawn is stage A's read-only one, and there are no
handlers or dialog to give the row to (`sessionRow` serves `paneFor` alone, `web/edit.js` is not
touched); without B or C nothing differs.

**Files**
- Create: `test-page/hidden-selection.test.ts`
- Modify: `src/window/protocol.ts` (`ListMessage.selectedRow`), `src/window/view/build.ts`,
  `web/pane.js` (`sessionRow`, `paneFor`), `web/app.js` (the selected session's row through
  `sessionRow` in `render()` and in stage D's `edit` and `done` handlers), `web/edit.js` (stage
  D's `update(list)` takes its session's row through `sessionRow`), `test/window/view/build.test.ts`
  (new cases only), `test/web/pane.test.ts` (new cases only), `docs/design-step-2.md` (8.2.3:
  `selectedRow`; 12.6: E13 in a sentence, the known limit narrowed to a session the view model
  does not list; 12.9: the sentence on the right side of a selection the list does not show)

**Behaviour.** As E13, 2.3, 2.4 and 2.5.

**Tests** (platform: none for `build.test.ts` and `pane.test.ts`; `realTestPlatform` for the page,
a test server with sessions made by step 1's helpers and the stand-in in a window terminal)
- `build.test.ts`: `selectedRow` for a selected session the filter hides equals the payload the
  sections carry once the filter is cleared; for a done one while done ones are hidden; for one
  in a folded Earlier; for one shown in the sections the same row; null with nothing selected and
  for an id no row has.
- `pane.test.ts`: `sessionRow` gives the sections' row, else `selectedRow` of that id, else null —
  and null for a `selectedRow` of another id (the selection before; the connection lost); a
  hidden session whose `selectedRow.terminal` names a running terminal → `terminal` with that row;
  an ended one → the same with `ended`; `selectedRow.terminal` null while a terminal's `sessionId`
  is the selection (an ended terminal of a session that runs again elsewhere) → not that
  terminal, decided by the row as for a listed row; a hidden session whose terminal is starting →
  `terminal`; no row at all → stage A's answer.
- `hidden-selection.test.ts`: a stand-in in a window terminal is selected; a filter that hides it
  → the list shows no row selected, the terminal is still shown and its header shows its title
  and short id, the header keeps its height and the page sends no `resize` (named: "a filter that
  hides the selected running session sends no resize"); `/exit` in it → the ended bar with Resume
  and Close at once (before the exit arrives, too: "claude is not running in this terminal" with
  both); Resume → it runs again in the window; `/exit` again, then Close → the terminal is
  forgotten and the right side is empty; the filter cleared → the row is selected again. A
  selected session without a terminal hidden by the filter → the right side shows nothing (S2
  12.9). With stage D: the header's label control opens the label dialog for the hidden session;
  with the filter `repo#12` matching the session only by a pull request, `p`'s dialog stays
  open after × detaches it and goes on listing the session's row (`update` finds it through
  `sessionRow`). The page of the real server reports no problem at the end of each case.

**Done when:** the right side of a hidden selected session shows what E13 says, stage D's controls
and dialogs find its row, and stage A's known limit is narrowed in S2 12.6 to a session the view
model does not list; `npm run check` passes.

**Not in it:** search itself (96–98); `docs/install.md` (99 takes out stage D's limit "a session
the filter hides has no header").

---

### Task 97: The list on the page — chips, stacks, the icon's links

**Depends on:** 93, 94, 96 · **Merges after:** D 34 → B 55 (`web/list.js`), D 37 → B 55 → C 75 (`web/index.html`) · **Wave:** 4 · **Design:** S2 8.2.1, 12.1, 12.2, 12.8, 12.9 (the list zone), 12.12, 15.4 · **Contracts:** 2.1, 2.5 (`chips.js`, `list.js`, `index.html`) · **Decisions:** E4, E5, E6 (the page's memory), E7, E14 (update S2 8.2.1, 12.2, 12.9, 12.12) · **Shared files:** `web/list.js`, `web/index.html`, `docs/design-step-2.md`

**Goal.** The list shows the chips, the stacks and done sessions while filtering exactly as the
server sends them, and the page has its icon.

**To resolve when merging `origin/main`:** in `list.js`, `makeRow` and `paintRow` (D 34's chip
with its dim `+30`, B 55's `data-attention` and second line), where E adds the stack's badge and
`data-stack`; `render()`'s loop over a section's rows, where E adds the `+n more` line; the
filter bar of `createList`, where E adds the chips; `paintCounts` (B 55's `need you`) stays theirs;
D 34 moved the list's `nowNs` into `web/format.js` (`serverNow`): E uses that. In `index.html`:
the style-sheet links (D 37's `edit.css`, B 55's `attention.css`, C 75's `banner.css`; E's
`search.css` after them) and the icon's `<link>` line (E only); S2 12.2 and 12.9, where B 55 and
D 37 wrote sentences of their own: keep them (and task 95's sentence of 12.9, whichever merges
first).

**If absent:** without stage B, C or D nothing differs: the rows draw what `web/list-text.js`
gives on `main`.

**Files**
- Create: `web/chips.js`, `web/search.css`, `test-page/search.test.ts`, `test-page/icon.test.ts`
- Modify: `web/list.js` (the chips under the filter field; `opened` in every view, and E6's
  memory; the stack's badge, its `+n more` line, its members; ← → on stacks; `list.filtering`;
  `reveal`), `web/index.html` (`search.css`; the icon's links), `docs/design-step-2.md` (8.2.1:
  the two paths' answers; 12.12: E14; 12.2: E7's look; 12.9: E7's ← → on a stack)

**Behaviour.** As E4, E5, E6, E7 and 2.5. The `+n more` line and every element list.js adds are
made once and kept across renders, as stage A's rows (a render never loses a click). The filter
field's placeholder names the short id. The chips and the `+n more` line take no keyboard on a
click.

**Tests** (platform: `realTestPlatform`; a test server with sessions made by step 1's helpers:
groups, notes, pull requests saved with `savePrResult`, done ones, old ones for Earlier; the
contexts through stage B's `newContext`)
- `search.test.ts`, the filter and the chips: two words typed → the rows of both; a short id's
  first characters → its row; a done session that matches shows with `done`, and the footer
  is gone; each chip pressed → `aria-pressed` and the rows the server sent, the keyboard where it
  was; `Show done`, `a` and the footer's `show` are one state (each turns the others on);
  `No session matches the filter.` for a chip that matches nothing; nothing folds while a chip is
  set; every view the page sends holds `opened`.
- `search.test.ts`, stacks: three sessions of `ORB-1` in This week → one row with `×3` and the
  line `+2 more in ORB-1`; a click on the line → three rows, the members indented and marked;
  ← on a member → the head selected and the stack closed; → on the head → open; ← on the head →
  closed; ← on a row that is in no stack folds Earlier as before; ↓ from a closed head skips the
  hidden members and the line; Ctrl+Tab back to a member selected earlier → its stack is open,
  and it stays open (the view's `opened` names it) when the selection goes to a row outside it;
  a filter → no stack; a group of 1,025 bytes → never in a view the page sends; a hostile group
  `<img src=x onerror=…>` in the line and a hostile title on a member are text
  (`querySelector('img')` null); exactly one `#list [data-id]` per drawn row.
- `icon.test.ts`: the page's icon link names `/assets/<build>/web/icons/favicon.ico` and it
  answers 200 `image/x-icon`; the manifest link loads JSON whose icons answer 200; the page
  reports no problem (no CSP refusal, no failed load).
- At the end of every real-server case the page reports no problem.

**Done when:** every element of S2 12.2 and 12.8 that the list shows is drawn for its case, with
its keys, and the page links its icon; `npm run check` passes.

**Not in it:** the switcher, `#switcher`, the `Switch…` button and the key bar's hint (98, ruled:
`main` never shows a control that does nothing); `reveal`'s caller and its tests (98); the page's
cut after 16 words (98: until then the server uses the first 16, E3).

---

### Task 98: The quick switcher on the page

**Depends on:** 95, 97 · **Merges after:** D 37 → B 55 → C 75 (`web/app.js`, `keys.js`, `help.js`, `index.html`, `test/web/keys.test.ts`, `test-page/shell.test.ts`), D 36 → B 54 → C 74 (`src/window/server.ts`), C 73 (S2 12.7) · **Wave:** 5 · **Design:** S2 11.3, 12.6, 12.7, 12.8, 12.9, 15.4 · **Contracts:** 2.2 (`restoreOffer`), 2.5 (`switcher.js`, `keys.js`, `app.js`, `index.html`, `server.ts`) · **Decisions:** E3, E10, E11, E12 (update S2 12.7, 12.8, 12.9) · **Shared files:** `src/window/server.ts`, `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html`, `test/web/keys.test.ts`, `test-page/shell.test.ts`, `test-page/keys.test.ts`, `docs/design-step-2.md`

**To resolve when merging `origin/main`:** in `server.ts`, `listFor` (D 36's deps, B 54's
attention passed to `buildListMessage`, C 74's `banner` set on its result: E's one statement
comes right after C's); in `app.js`, the imports and the modules made at load (D 37's editor and
toast, B 55's notifications, C 75's banner; E's switcher after them), `received()`'s `case 'list'`
(D 37's `editor.update`, B 55's `document.title`, C 75's `banner.render`; E's `switcher.update`
after them), `doChord` (B 55's `next-attention` beside E's `switcher`), the gate of a window chord
(B 55's, which D 37's modal rule feeds: E extends the condition and sends the `Switch…` button
through it), D 37's capture-phase Esc (E's branch beside `editor.escape()`), the `case 'later'`
branches and `keyName` (D 37 and B 55 removed their uses; E removes the rest), `changeView` (E
only), task 95's `sessionRow` calls (kept); in `keys.js`, `windowChord`'s `'p'` case right beside
B 55's `'j'`, and the `later` kind (D 37 removed stage D's, B 55 stage B's: E removes the last, and
the type with it); in `help.js` the window section's last two lines (Ctrl+Shift+P, and
Ctrl+Shift+J which B 55 changed), the list section's `←`/`→` and `/` lines (D 37 changed the
lines after them), and the LATER marking; in `index.html` the body's elements (D 37's `#editor`
and `#toast`; E's `#switcher` after them), the title bar (B 55's `#notify-on`; E's `Switch…` after
it), the key bar's hints; in `test/web/keys.test.ts` the `later` cases (lines 46, 103, 440–452 on
9c5cbfb), which D 37 and B 55 each narrowed; in `test-page/shell.test.ts` the later-keys case
(lines 162–261: D 37's six keys, B 55's Ctrl+Shift+J), where only the Ctrl+Shift+P steps are
E's; S2 12.7's paragraphs (C 73's rule, C 75's page) and 12.9 (D 37's D2 sentences, task 95's
and 97's): keep theirs.

**Goal.** Ctrl+Shift+P, or the title bar's `Switch…`, opens the quick switcher over every
session; typing narrows it, Enter switches to the session or resumes it, a typed `>restore` finds
stage C's offer, and the keyboard never leaves it while it is shown.

**If absent:** without stage D, `app.js` has no modal rule yet: this task adds one for the
switcher alone ("the switcher is shown"), with B's gate of a window chord, `now()` counts on from
the list's `nowNs` in `app.js` as `web/list.js` does (there is no `serverNow` yet), and the case
with a delayed answer builds its scripted world in its own file from stage A's `standinServer`
and `honest`; without B the switcher shows no Needs you rank (the server sends none) and the
modal rule has its own gate; without C there is no offer, `server.ts` is not touched and
`test/window/switcher-offer.test.ts` is not made.

**Files**
- Create: `web/switcher.js`, `test-page/switcher.test.ts`, `test/window/switcher-offer.test.ts`
- Modify: `src/window/server.ts` (2.5: the offer, one statement in `listFor`), `web/search.css`
  (the switcher's styles: the panel over its scrim and over stage D's toast), `web/app.js` (2.5;
  the `case 'later'` branches and `keyName` removed), `web/keys.js` (Ctrl+Shift+P, `switcherKey`;
  the `later` kind removed), `web/help.js` (the Ctrl+Shift+P line no longer comes later and names
  the switcher's keys as plain text, not `kbd`: `the quick switcher: every session, done ones too
  — type to narrow; in it ↑ ↓ move, Enter switches to the session or resumes it, Esc closes`; the
  `← →` line `fold or unfold Earlier; open or close a stack`; the `/` line `filter: several words,
  all must match, also the start of the short id`; the LATER constant and its marking removed),
  `web/index.html` (2.5: `#switcher`, the `Switch…` button, the key bar's hint),
  `test/web/keys.test.ts`, `test-page/shell.test.ts`, `test-page/keys.test.ts` (each as below),
  `docs/design-step-2.md` (12.7: E12; 12.8: E10; 12.9: E11)

**The edits of existing tests**, written out:
- `test/web/keys.test.ts`: the table's `['Ctrl+Shift+P', cs('P', 'KeyP'), { kind: 'later', stage:
  'E' }]` (line 46) gives `{ kind: 'switcher' }`; the case at line 103 gives `switcher` in both
  zones; the case "every later key" (line 450; after D 37 and B 55 it holds only Ctrl+Shift+P) is
  removed, and its `cancels(cs('P', 'KeyP'), zone, false) === true` for both zones moves into a
  case of its own, "Ctrl+Shift+P is cancelled in both zones"; new cases for `switcherKey`.
- `test-page/shell.test.ts`, the later-keys case (its page has no key and no connection; the
  switcher opens all the same, says `skydeck's server is not connected`, and Esc closes it): in
  the terminal zone's table, right after `['Control+Shift+P', true]` (line 202), the row
  `['Escape', true]` (the switcher's Esc, cancelled); the two lines after the table (221–222)
  become `pressed('Control+Shift+P')` → true, `#switcher` shown, `pressed('Escape')` → true,
  `#switcher` hidden; in the list zone's table, right after `['Control+Shift+P', true]` (line
  247), the row `['Escape', true]`. Every other row keeps its `cancelled`. The case's title loses
  "the keys of later stages say so" (none is left) and gains "Ctrl+Shift+P opens the switcher and
  Esc closes it".
- `test-page/keys.test.ts`, the case "… Ctrl+Shift+P → nothing" (its step at line 90): Ctrl+Shift+P
  → the stand-in records nothing and `#switcher` is shown; Esc → hidden, and the stand-in still
  records nothing (the Esc was the switcher's).
- `test-page/cards.test.ts`'s help check needs no edit: its `later` comparison then holds for no
  line, and the switcher's keys are plain text in the help.

**Behaviour.** As E10, E11, E12 and 2.5. The panel lies over the page (the mockup's), with the
field on top, the items grouped under `rankHeading`'s headings, and the footer (`switcherFooter`);
`No session matches.` when nothing does and `switcher.command` is false; while it is true the
switcher lists no session and shows the offer when there is one, or a line of its own for a
command that names none (its words are task 98's): the page decides it from `switcher.command`,
never from the text (S2 4.3). The highlight starts on the first item and follows
↑ ↓ PgUp PgDn, scrolled into view; a held key acts at each repeat for ↑ ↓ and once for Enter.

**Tests** (platform: `realTestPlatform`; a test server with sessions made by step 1's helpers and
the stand-in, unless a scripted world is named; the contexts through stage B's `newContext`)
- `keys.test.ts`: Ctrl+Shift+P on a US and a Czech layout, both zones → `switcher`, cancelled;
  `switcherKey` for ↑ ↓ PgUp PgDn Enter Esc Tab Shift+Tab, and null with Ctrl, Alt or Meta and for
  a letter.
- `switcher-offer.test.ts` (a real test server; sessions of an earlier boot made by stage C's
  helper for a server's sandbox, task 74): while the banner is shown, a view with `switcher:
  '>restore'` → `restore` null and no session listed; after `act dismiss-restore`, `''`, `restore` and `restore x` (no
  `>`: sessions only) → null, `>restore` and `> rest` → the offer with the preselected ids in the
  banner's order and no session listed; while a restore runs → null (E12, ruled).
- `switcher.test.ts`, opening and typing: Ctrl+Shift+P from the terminal and from the list, and a
  click on the title bar's `Switch…` → the panel, the keyboard in its field, the help hidden if it
  was shown; typing → items of the server's ranking, the matched parts in `mark` elements, each
  item's short id shown; a short id's first 4 characters → its session first; Esc → closed, the
  keyboard back where it was (the terminal; the list; the filter's field); Ctrl+Shift+P again →
  closed; a click outside → closed; a mousedown on a heading or the footer → the keyboard stays in
  the field; Tab → stays in the field; 17 words typed → the footer's line and the server got 16.
- Enter on each kind: a session open in the window → its terminal shown with the keyboard; one not
  running → resumed into the window (the stand-in starts, slot given) and its terminal takes the
  keyboard; one elsewhere (a stand-in the test runs outside the window) → its card; an expired one
  → its card with the server's refusal; a done one → resumed, under Open with `done`; one in a
  folded Earlier → Earlier unfolded and the row selected; one the filter hides → the filter and
  the chips cleared, the key bar says so, the row selected. A click on an item does what Enter
  does.
- The query (a scripted world that answers a `view` late): `or` answered, then `orb` typed and
  Enter while the answer for `orb` is held → nothing is picked; when it comes, its first item is
  picked; a click on an item of the list for `or` meanwhile does nothing.
- The modal rule (a scripted world that answers a resume after 500 ms — stage D's `editWorld`):
  Enter on a session that is not running in the list, then Ctrl+Shift+P at once and typing → every
  character in the switcher's field, the page sent no `input`; the resume's terminal takes the
  keyboard only when the switcher closes. While shown, a list that arrives moves the keyboard
  nowhere; `j`, `d` and `/` typed are text; Ctrl+Shift+1, Ctrl+Shift+L and Ctrl+Shift+H say `close
  the switcher first (Esc)` and change nothing; a held Enter picks once and none of its repeats
  reaches the program; a held Esc that closes it over a running terminal sends the program nothing
  (stage A's held-key rule); Esc while the New form is open closes the switcher only, the form's
  field has the keyboard again. With stage D: Ctrl+Shift+P and a click on `Switch…` (reached with
  Tab) while a dialog is shown say `close the edit first (Esc)`; a toast shown when the switcher
  opens is under the panel and over the scrim (at an item's centre `elementFromPoint` is the item;
  the toast's Undo can be clicked).
- The offer: (a real server with stage C, the banner dismissed) "Ctrl+Shift+P, Enter, with an
  offer, sends no `act restore`"; (a scripted list whose `switcher.restore` holds two ids) the
  first entry `Restore 2 sessions from …` with the time of `activityTime` at the page's clock;
  Enter → `act restore` with the two ids; a list without it → no entry.
- Text: a hostile title, group and directory in an item, and a hostile text typed, create no
  element; the test server's log lines hold no marker typed into the filter or the switcher, nor
  one in a group of `opened`.
- Two pages of one server: each its own switcher and filter; a pick in one changes nothing in the
  other's selection.
- At the end of every real-server case the page reports no problem.

**Done when:** every part of S2 12.8's switcher works for its case, the help lists Ctrl+Shift+P
as a key that acts, nothing gives `later` any more, no key typed while it is shown reaches a
terminal, and no Enter on an empty text restores; `npm run check` passes.

**Not in it:** stage C's banner and its report (C 75: it draws the report while it holds lines);
the documents (99).

---

### Task 99: Documentation of stage E

**Depends on:** all · **Merges after:** B 50 (`docs/install.md`, "Updating"), then D 39 → B 56 → C 79 (the documents) · **Wave:** 6 · **Design:** S2 12.2, 12.8, 12.12, 18, 19 · **Contracts:** — · **Decisions:** — · **Shared files:** `docs/install.md`, `docs/manual-checks.md`, `README.md`, `docs/design-step-2.md`

**Goal.** A user can search, use the chips, the stacks and the switcher from the documents
alone, and knows which checks only they can make.

**To resolve when merging `origin/main`:** `docs/install.md`'s "Using the window" and "Known
limits" paragraphs, which D 39, B 56 and C 79 each extend (E's text after theirs; B 50 changed
"Updating", which E leaves alone); the parts of `docs/manual-checks.md` each stage adds (E's part
after C's); S2 18's table rows and S2 19's stage lines. In `README.md` E adds one sentence to the
window's paragraph and no row to the command table (the formatter re-pads that table whole, so
any other edit of it conflicts).

**If absent:** the documents name only what is on `main` (an offer to restore only with stage C,
Needs you only with stage B, the header's editing only with stage D).

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (S2 18
  gains W30 and W31 below, W3 names the icon; S2 19's stage E line names W3, W30, W31)

**Not in it:** code, tests, and running any `skydeck` command.

**Content (contract)**
- `docs/install.md`, "Using the window": the filter (several words, all must match; the fields;
  at least 4 characters of the start of the short id; done sessions shown while filtering; Esc),
  the chips, stacks (`×4`, `+3 more`, a click, → and ←, a filter flattens them, a stack opened by
  selecting one of its members stays open until it is closed), the quick switcher (Ctrl+Shift+P or
  `Switch…`, the order, the keys, what Enter does for each kind of session, that a pick clears a
  filter that hides the session, the restore offer with stage C — found by typing `>restore` (the
  command form; a text without `>` lists sessions only), only after "Not now" —, Esc), the right
  side of a selected session the filter hides (its terminal with its header and the ended bar's
  Resume and Close), and the icon. Stage D's known limit "a
  session the filter hides has no header" is taken out of the text. "Known limits of stage E": a
  word counts in its first 64 characters, 16 words count, and a note is searched in its first
  16,384 characters; the switcher shows 50 sessions (type to narrow); a title whose lower case is
  longer is not highlighted; a group over 1,024 bytes opens its stack only while a member is
  selected; the automatic pull-request refresh leaves out a closed stack's members, the
  switcher's items and a hidden selected session (as a folded Earlier's rows); stage D's toast
  after `d` says "hidden from the list" while a filter still lists the row; a session the window
  does not list at all (it ended before its first prompt) keeps stage A's ended bar without
  Resume.
- `README.md`: one sentence in the window's paragraph — search, the chips, stacks and the quick
  switcher.
- `docs/manual-checks.md`: a part "The window (step 2, stage E)" with W30, W31 and the icon's half
  of W3, each with what to set up, what to type, what to look at and what to write down. Every
  step can do no harm (the rules of task 30's review): Enter is pressed only on stage A's
  throwaway session in `~/skydeck-try` ("A throwaway session in the window"), after the step says
  to check the highlighted item's short id is the throwaway's — Enter on a real session resumes
  a real `claude`; no step uses `l`, `g`, `n`, `p` or `d`, closes a window, ends a `claude`, reads
  a file under `~/.claude` or changes Edge's or Windows' settings; W3's WSL-restart part says that
  it ends every running session and is done only when the user restarts WSL anyway, or left out
  (and written down as left out); W3's icon part says: do not install the page as an app, and
  write down whether Edge offers to (its menu may, as the page has a manifest).
- The task runs no `skydeck` command; what a command prints is held by the sandboxed tests.

| # | Check | Stage | Decides |
|---|---|---|---|
| W30 | On the user's own sessions (about 105), without Enter: two words of a ticket in the filter, a short id's first characters, each chip, a stack opened and closed with → and ←, the switcher opened, typed into, moved through with ↑ ↓ and closed with Esc. Whether any answer comes late enough to notice, and whether the order of the switcher is the one wanted. Then the throwaway session found by its label in the switcher, its item's short id checked, and Enter: it resumes into the window. | E | 12.2, 12.8 |
| W31 | Czech and US layouts in the filter's and the switcher's fields: AltGr characters and dead keys type; Ctrl+Shift+P opens and closes the switcher on both. | E | 12.8, 12.9 |

**Steps**
- [ ] Check the new text against the code and the tests, never by running it: `skydeck window`
      and every other command of the text are not run outside the test suite (the user's server
      runs on the default port).
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage E from `docs/install.md` alone, and W30, W31 and W3's icon
are in `docs/manual-checks.md` and S2 18.

## 4. Design coverage

| Design | Where |
|---|---|
| S2 4.3, the view model's rules in `src/window/view/` | 90, 91, 92 (pure), 96 (E1) |
| S2 8.2.1, `/manifest.webmanifest` and `/favicon.ico` | 94, 97 |
| S2 8.2.3, `view.chips` (and `opened`, `switcher`), the row's `stack`, `list`'s `filtering`, `switcher` and `selectedRow` | 96, 95; the offer 92, 98 |
| S2 8.2.7, several windows | 96 (each page's view), 98 (two pages) |
| S2 12.2, stacks | 91 (rule), 96 (in the list), 97 (drawn, keys) |
| S2 12.6, the ended bar and the header of a session the filter hides | 95 (with stage D's handlers and dialogs) |
| S2 12.7, the switcher's offer | 92 (the rule), 98 (where it is set, the page) |
| S2 12.8, the filter, done sessions, the chips | 90, 96, 97 |
| S2 12.8, the quick switcher | 92 (ranking), 96 (in the list), 93, 98 |
| S2 12.9, the list zone's ← →, the switcher's keys and its hold on the keyboard, the help | 97, 98 |
| S2 12.12, the icon | 94, 97 |
| S2 15.4, text never markup | 2.1; every page task's hostile-text case |
| S2 18, W3 (the icon), W30, W31 | 99 |
| S2 19, stage E | this plan |

## 5. What stage E needs from stages B, C and D, and what it leaves

Stage E reads, and never changes, what B, C and D build: B's `attention` on a row and its
`attentionOrder` (the Needs you rank, and `held`), its gate of a window chord and its
`newContext`; C's banner payload on the list (the offer) and `activityTime`; D's `serverNow`,
`editWorld`, its header's handlers and dialogs (which read the selected session's row through
E's `sessionRow`) and modal rule D2 (which E11 extends to the switcher). It edits their files only
where its own lines are: in `protocol.ts` and `build.ts` the optional fields of 2.3 and the steps
of 2.4; in `server.ts` one statement after C's banner; in `app.js` 95's `sessionRow` and the
switcher's wiring; in `edit.js` the one lookup of `update`; in `keys.js` only Ctrl+Shift+P (and the
`later` kind, which goes); in `help.js` three lines and the LATER marking; in `list.js` the chips
and the stacks; in `index.html` the elements of 2.5. Nothing of stage C's page changes: C's banner
draws a restore's report whatever its payload says (ruled for C's plan). No migration, no new store
key, no server module. Section 1's tables list every file of every task, for the lead's check
against the other stages.

**The follow-up on stage E's path** (stage D's section 5): *the ended bar of a session the filter
hides* — **settled** by task 95 (E13), but for a session the view model does not list at all.

**Not stage E's** (a follow-up candidate for the user, ruled): a `Cross-Origin-Resource-Policy:
same-origin` header on every answer, so that another web page cannot load the fixed paths (the
icon, `/`) as an image and learn that skydeck runs; any page can probe the static files today (S2
15.1 calls them not secret).

## 6. Stage E is ready to try

When task 99 is merged. Update in the order `docs/install.md`, "Updating", gives (when a pull
brings stage B's migration 2 too, that order closes the window first). With nothing else to
update, in a WSL terminal of your own (not a `!` command inside Claude Code):

```sh
cd ~/projects/mine/skydeck
git pull
skydeck window          # restarts the window's server for the new build; your sessions keep
                        # running, the window reloads itself
```

No `npm ci`, no `install` again: nothing of the hook or the store changes. If the taskbar button
still shows Edge's icon after the reload, close the window and run `skydeck window` again (W3
writes down which it took). Do not install the page as an app if Edge offers it; W3 asks you to
write down whether it does.

**What only you can check** (task 99's sections):

- **W3** — the window's taskbar button shows skydeck's icon, also after `skydeck window --restart`.
- **W30** — on your own sessions, without Enter: the filter, the chips, a stack, the switcher; any
  delay you notice; whether the switcher's order is the one you want. Enter only on the throwaway
  session, after checking the short id its item shows.
- **W31** — the filter's and the switcher's fields on your Czech and US layouts.
- And the choices made for you, each yours to change: the switcher matches words, not scattered
  letters as the mockup did (E9); a word matches the short id from 4 characters on (E2); a pick
  clears a filter that hides the session (E10); a row that has a terminal of the window or needs
  you never stacks, and a stack opened by selecting a member stays open until you close it (E6);
  the restore offer is found only by typing `>restore` (or `>r`, the command form), after "Not
  now", and a text that starts with `>` lists no session (E12).

## 7. Questions for the lead, and the rulings

Asked with the first version of this plan; the lead ruled on 2026-11-15 (02:27Z with review A,
02:32Z with review B, 02:49Z on the directory), and the plan above follows the rulings.

1. **The switcher's matching** (E9): the filter's words, not the mockup's subsequence of a title.
   Ruled: as planned; the user is told.
2. **A pick of a session the list does not show** (E10): the list is changed to show it (the
   filter and chips cleared, done ones shown, Earlier unfolded). Ruled: as planned.
3. **The short id** (E2): a prefix of at least 4 characters, also the whole id. Ruled: as planned.
4. **Stacks** (E6): no row with a terminal of the window stacks (ruled, with review A's 7: nor a
   row that needs you). The open state was planned to follow the selection; ruled the other way:
   the page remembers — a stack whose member becomes selected is added to `opened` and stays open
   until the user closes it.
5. **The bounds** (E3): 16 words, a note in its first 16,384 characters, 50 items. Ruled: as
   planned, plus a word's first 64 units (review A's 4).
6. **The report of a restore started from the switcher after "Not now"** (E12). Ruled: stage C's
   plan says it (its banner draws a report while it holds lines); task 98 does not touch
   `web/banner.js`.
7. **The check numbers** W30 and W31. Ruled: free.

And on the pinned case of the view's files (asked with the second version): stage E's modules sit
in `src/window/view/search/`, which the pinned case of `build.test.ts` does not read, so that
tasks 90–92 merge at once; task 96 extends the case to the subdirectory. Ruled: as planned (the
earlier rule meant a file beside `build.ts`).

The reviews' other findings are in the text: review A's 1 (E12: the offer never one Enter away,
the server's answer), 2 (E10: Enter and a click only on the list of the text last sent), 3 (E13,
task 95: `selectedRow` only for its id, the pane by `row.terminal`, one `sessionRow` helper for
`paneFor`, D's handlers and `editor.update`, D 38 in 95's row, D's limit out of `install.md`), 4
(E3: 64 units, the named timing case's shape), 5 (95's no-`resize` case), 6 (E5: the counts over the rows
listed without the filter), 7 (E6: `held` includes attention), 8 (E11: the panel's mousedown, the
`Switch…` button through the gate, the held Esc and the New form, the help and the toast), 9 (the
short id in an item; section 6's order of the update), 10 (96 after C 73), and its notes (the
offer and `filtering` as the server's answers, the limit of `tick.listed`, `opened`'s well-formed
groups, the narrowed limit of S2 12.6, the toast while filtering and `d` on a stack's head, the
`opened` marker in the log case). Review B's 1 (`test-page/list.test.ts` in 96), 2 (no stacks
without `opened`), 3 (the waves: 96 before 95; 95 and 97 together), 4 (the waits: D 38, C 73,
B 55), 5 (no `banner.js`; the clock of `activityTime`), 6 (the edits of existing tests written
out; the `later` kind removed; plain text in the help), 7 (`Switch…` and the hint with 98), 8
(`selectedRow` in S2 8.2.3; both fields after `dirs`), 9 (94 leaves the 404 cases; the `rg`
line's globs), 10 (references; the flake; `scripts/icons.ts` accepted), 11 (98 stays one pull
request), 12 (`newContext`).
