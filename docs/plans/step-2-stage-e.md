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

**Task numbers** are 90–99 (stage D has 34–39, B 50–56, C 70–79), so that branch names,
pull-request titles and the lead's notes stay unique.

**Stages B, C and D are built at the same time.** Their plans were not merged when this one was
written. Each task here that edits a file of theirs names, in its **Waits for** line, the task of
the other stage that must be merged first, and is written against the code as that plan leaves
it; its **If absent** line says what the task does when that stage is not there. Where a name of
theirs on `main` differs from what their plan said, the implementer follows `main` and tells the
lead.

**CI stays as it is**: two Node legs, one job each. No task changes `.github/workflows/`,
`package.json` or a dependency.

**Added to the test rules.**
- No test starts the real `claude`, and a resume in a test resumes a session made by the test in
  its sandbox with the stand-in as `claudeCommand` (stage A's rule); so does every Enter in the
  switcher's tests.
- The icon's PNG files are drawn once, by the implementer of task 94, with `scripts/icons.ts`;
  no test and no CI step runs the script.
- No task runs `bin/skydeck` outside the test suite (task 99 included).

**Known flakes** (not stage E's to fix; a run that fails only with one of them is run once more,
and the pull request names both runs): `test/platform/real.test.ts` "a streamed answer that keeps
coming…" and its case at line 1005 (the wall clock steps back); `test/standin/standin.test.ts`
(records in the wrong order); `test/window/mapping.test.ts:623` (ENOTEMPTY at the sandbox's
clean-up); `test-page/terminal.test.ts` "input-full (the program stalled, a large paste)".

## 1. Tasks and waves

Task 0 is `main` at 9c5cbfb (stage A complete) with this plan merged.

| # | Task | Depends on (stage E) | Waits for (other stages, merged) | Wave | Shared files | Size (code + tests) |
|---|---|---|---|---|---|---|
| 90 | The filter's rule: words, the short id, the chips | 0 | — | 1 | — | ~450 |
| 91 | Stacks | 0 | — | 1 | — | ~350 |
| 94 | The page's own icon | 0 | — | 1 | — | ~350 + the icon files |
| 92 | The quick switcher's ranking | 90 | — | 2 | — | ~400 |
| 93 | The page's texts of search | 90 | — | 2 | — | ~250 |
| 95 | The selected session the list does not show | 0 | D 34, D 37, B 51, B 55, C 70, C 75 | 3 | yes | ~400 |
| 96 | Search in the list message | 90, 91, 92, 95 | D 34, B 51, C 70 | 4 | yes | ~650 |
| 97 | The list on the page: chips, stacks, the icon's links | 93, 94, 96 | D 34, D 37, B 55, C 75 | 5 | yes | ~700 |
| 98 | The quick switcher on the page | 97 | D 37, B 55, C 75 | 6 | yes | ~850 |
| 99 | Documentation of stage E | all | D 39, B 56, C 79 | 7 | yes | docs only |

```
wave 1:  90  91  94      start at once, beside stages B, C and D
wave 2:  92  93          once 90 is merged; still no file another stage edits
wave 3:  95              once the other stages' tasks of its row are merged (it may overlap wave 2)
wave 4:  96
wave 5:  97
wave 6:  98
wave 7:  99
```

**Can start at once:** 90, 91 and 94. They create only new files (94 also edits
`src/window/assets.ts` and its test, which no other stage touches). 92 and 93 follow 90 and are
just as free of shared files. Every later task edits files that stages B, C and D edit, and waits
for the tasks named in its row. Between themselves 95–98 run one after the other: 95 and 96 edit
the same files (`src/window/protocol.ts`, `build.ts` and their tests), 97 draws what 96 sends, and
98 uses 97's list (`reveal`) and page elements (`#switcher`, `search.css`). The critical path is
90 → 92 → 96 → 97 → 98 → 99. Task 99 may start its reading while 98 is built.

**Why the new modules are in a directory of their own.** `test/window/view/build.test.ts` pins
the exact list of files of `src/window/view/` (stage D's 34 and stage B's 51 each add one there):
a new file beside them would change that pinned line in wave 1. The files of
`src/window/view/search/` are not in it; task 90's `imports.test.ts` checks their import rule
(2.1), and task 96, which makes `build.ts` call them, adds them to `build.ts`'s allowed imports.

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
| 95 | `test-page/hidden-selection.test.ts` | **shared:** `src/window/protocol.ts`, `src/window/view/build.ts`, `web/pane.js`, `web/app.js` (one call), `test/window/view/build.test.ts` (new cases only), `test/web/pane.test.ts` (new cases only), `docs/design-step-2.md` (12.6, 12.9) |
| 96 | `test/window/view/search-list.test.ts`, `test/window/protocol-search.test.ts` | `src/window/view/search/filter.ts`, `stacks.ts`, `switcher.ts` (their message types now come from `protocol.ts`); **shared:** `src/window/protocol.ts`, `src/window/view/build.ts`, `test/window/protocol.test.ts` (the two cases that pin stage A's view without `chips`), `test/window/view/build.test.ts` (the allowed imports; the cases that pin design 7.4's filter in the window), `docs/design-step-2.md` (4.3, 8.2.3, 12.2, 12.8) |
| 97 | `web/chips.js`, `web/search.css`, `test-page/search.test.ts`, `test-page/icon.test.ts` | **shared:** `web/list.js`, `web/index.html`, `docs/design-step-2.md` (8.2.1, 12.12; 12.2's look of a stack; 12.9's ← → on a stack) |
| 98 | `web/switcher.js`, `test-page/switcher.test.ts` | `web/search.css` (the switcher's styles); **shared:** `web/app.js`, `web/keys.js`, `web/help.js`, `web/banner.js` (stage C's: one rule), `test/web/keys.test.ts`, `test-page/shell.test.ts` (the Ctrl+Shift+P step of the later-keys case), `test-page/keys.test.ts` (its Ctrl+Shift+P step), `docs/design-step-2.md` (12.7, 12.8's switcher, 12.9) |
| 99 | — | **shared:** `docs/install.md`, `docs/manual-checks.md`, `README.md`, `docs/design-step-2.md` (18, 19) |

Should an existing case of a file not in a task's row fail because of the task (a page case that
counts the list's elements, say), the implementer tells the lead the file and the case before
changing anything (stage D's B3 rule).

**The design, section by section.** Wave 1 and 2 tasks write no design text (the design is shared
by every stage); each decision of 1a names the later task that records it. 95 writes S2 12.6 and
12.9 (the hidden selection); 96 writes S2 4.3, 8.2.3, 12.2 (the rule of stacks) and 12.8 (the
filter, the chips, the switcher's ranking); 97 writes S2 8.2.1 and 12.12 (the icon), 12.2's
sentence on how a stack looks and 12.9's on ← → with a stack; 98 writes S2 12.7 (the offer in the
switcher), 12.8's sentences on a pick, and 12.9's on the switcher; 99 writes S2 18 and 19. Should a conflict come with another stage's text, the
second to merge rebases and keeps both edits.

## 1a. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| E1 | The rules of search are pure functions in `src/window/view/search/` (`filter.ts`, `stacks.ts`, `switcher.ts`), called by `build.ts`. They import values only from each other and from `text`'s `sanitize`, types from anywhere the view model may. The window's filter is S2 12.8's rule (E2); design 7.4's `matchesFilter` stays for `ls` and the interactive list, and `build.ts` no longer imports it (A8 keeps `isListed`). | S2 4.3: the view model is pure and in `src/window/view/`; a directory of its own lets the new rules be built beside the stages that edit `build.ts` (section 1). | 96 (4.3) |
| E2 | **The words.** A search text (the filter's, the switcher's) is split at white space (`/\s+/u`: spaces, tabs, line breaks, the no-break space), empty parts dropped, lower-cased with `toLowerCase()`, the first 16 kept, a repeated one once. A row matches when every word is found (`String.prototype.includes`) in one of its fields — the title, the group, the note (sanitised line by line), the directory, and of each attached pull request `owner/repo`, its number and `owner/repo#number` (design 7.4's fields) — or, for a word of at least 4 characters, when the session's id starts with it (S2 12.8's short id; the whole id too). | S2 12.8: "several words must all match", the short id. A prefix of at least 4 characters, so that a word like `2` or `fix 2` does not match nearly every session through the hex digits of its id. | 96 (12.8) |
| E3 | **The bounds.** A search text is at most 1,024 bytes of UTF-8 (stage A's limit of `view.filter`, and of `view.switcher`); at most 16 words count — the page cuts a longer text after its 16th word and says so (`the filter is cut to its first 16 words`), and the server, given more, uses the first 16; each field is searched in its first 16,384 UTF-16 units (a note in the first 16,384 units of its raw text); a row's lower-cased fields are made once per loaded row (a `WeakMap` on the row object, which the tick replaces when it reloads), not at every keystroke; no regular expression is ever built from a search text (the only one is the literal of E2), checked by a test; the matching runs over the rows the tick loaded, every known session. A named case with the largest input — 1,000 rows with notes of 16,384 units, 16 words of 64 characters — builds a list within 2 seconds (a guard against a pattern or a quadratic step, not a benchmark). | The brief: a search text is never a pattern run with unbounded cost; the cost is bounded by these sizes. | 96 (12.8) |
| E4 | **The chips** (S2 12.8): `Running` — the row is in Open (running or starting, in the window or elsewhere); `Open PR` — at least one attached pull request is not known to be merged or closed (S2 12.3's open ones: open, draft, never fetched, can't read); `Has note`. `view.chips` holds these three; every chip set must hold, together with every word. `Show done` is the fourth chip and is `view.showDone`, the same state as the list key `a` and the footer's `show`. | S2 12.8 names the four; three narrow the list, the fourth already exists. | 96 (8.2.3, 12.8) |
| E5 | **Filtering** is a word or a filtering chip. While filtering: done sessions are listed (with their `done` mark), every section is unfolded, every stack is flat, `doneHidden` is 0 (no footer); nothing folds (S2 12.9's rule extends to chips). `counts`, and stage B's `needYou.count`, ignore the filter as in stage A. Each window has its own filter, chips, opened stacks, folded Earlier, done shown, selection and switcher; what it shows of each session is the same in every window. | S2 12.8: "while a filter is set it includes done sessions and unfolds every section and stack"; S2 8.2.7. | 96 (12.8) |
| E6 | **Stacks** (S2 12.2). In This week and in Earlier, each on its own, the rows of one group (the row's group, compared as the sanitised text) stack under the newest when there are at least two; a row that a terminal of the window holds (running, starting or ended — it may hold a slot) never stacks, nor does Open (running sessions never stack). A stack is drawn open when `view.opened` names its group (the page's, at most 64) or when the selected session is one of its members other than the newest (the head). So the selection is never on a row hidden in a stack, however it got there (a click, Ctrl+Tab, the switcher). A section's `count` counts every row in it. | S2 12.2; S2 12.9: the selection is never on a row the list does not show; Ctrl+Shift+1–9 must always find a row on screen. | 96 (12.2) |
| E7 | **How a stack looks and is used.** The head shows `×4` after its ticket key (or group); a closed stack is followed by the line `+3 more in ORB-2107` (S2 12.2's example), which is no row (never selected, no `data-id`); an open stack's members follow the head, indented. A click on `×4` or on the `+3 more` line opens or closes the stack. → on a closed head opens it; ← on an open head closes it; ← on a member selects the head and closes the stack (as folding Earlier first selects the row above it); otherwise ← and → fold and unfold Earlier as in stage A. Ctrl+Shift+1–9 are unchanged: the rows with a slot never stack. | S2 12.2 ("a click or → expands the stack") leaves closing and the selection open. | 97 (12.2, 12.9) |
| E8 | **The switcher's state is the page's view.** `view.switcher` is the switcher's text while it is shown (null or absent while it is not); `list.switcher` carries its ranked items while it is shown, else null. Each change of the text is a `view`, which the server answers with a list at once (stage A's pages answer a view at once, outside the once-a-second rule). `view` also gains `chips` and `opened`. All three are optional fields of `view`, so that a page and the test helpers of stage A send views the parser still takes. | The ranking is the view model's (S2 4.3: "the switcher's ranking"); the page decides no rule. | 96 (8.2.3) |
| E9 | **The switcher's ranking** (S2 12.8). Over every session the list lists with done ones shown, also those the page's filter, chips, folded Earlier or closed stacks leave out: the rows whose fields match every word of its text (E2, E3; all rows for none), ranked — needs you (stage B's attention, in B's order), open (Open's order: slots, then by opening time, then those elsewhere), not running (most recent first), done (not running and done, most recent first). At most 50 items; `more` says how many were left out. Each item carries where the words are in its title (every occurrence of each word, overlapping ones merged, at most 32; none when lower-casing changes the title's length — a named limit) and why this page's list does not show it (`hiddenBy`, E10). | One matching rule for the filter and the switcher (question 1: the mockup matched titles by subsequence); a bounded message. | 96 (12.8) |
| E10 | **A pick** (Enter on an item, a click on one). The switcher closes; when the list does not show the picked row, the page first changes its view so that it does — the filter and the chips cleared (the key bar says `the filter was cleared to show <short id>`), done sessions shown, Earlier unfolded, as `hiddenBy` says; then it selects the row and does what Enter on that row in the list does (S2 12.6): a session with a terminal of the window shows it (an open one with the keyboard; an ended one under its bar); a session elsewhere shows its card; one that is not running is resumed into the window (11.3), and a refusal shows on its card (an expired one too, as the list's Enter). A closed stack needs nothing (E6). | S2 12.8: "Enter switches to a running one and resumes one that is not running"; S2 12.9: the selection is never on a row the list does not show, and the card must be shown for a refusal to be seen (question 2). | 98 (12.8) |
| E11 | **The switcher is modal**, by stage D's rule for its dialogs (D2): a scrim covers the window; while the switcher is shown `app.js` moves the keyboard nowhere (no `setZone`, `giveKeyboard`, `keepKeyboard` or `terminalView.focus` for a result, a list or a render) and acts on no list key; Ctrl+Shift+P closes it; Ctrl+Shift+H shows the help; every other window chord says `close the switcher first (Esc)` and does nothing else; the reload keys reload as usual (nothing typed there is worth keeping). In its field: ↑ ↓ move the highlight, PgUp PgDn by a page, Enter picks, Esc closes, Tab and Shift+Tab stay in the field (they do nothing); every other key is text. A click on an item picks it; a click outside the panel closes it. It closes when the connection is lost (its items would be stale). When it closes without a pick the keyboard goes back where it was; after a pick, where the pick puts it (a terminal this page's resume brought meanwhile takes it then, as after D's dialogs). Ctrl+Shift+P while one of D's dialogs is shown says D's `close the edit first (Esc)` and opens nothing. | The brief and D2; S2 12.9 names only the chord. | 98 (12.9) |
| E12 | **The restore offer in the switcher** (S2 12.7, stage C). While `list.banner` holds entries and no restore runs — whether the banner is shown or was dismissed with "Not now" — the switcher's first entry is `Restore <n> sessions from <time>` (`1 session`; `n` the preselected entries; the time as C's `activityTime`), shown while the switcher's text is empty or `restore` starts with each of its words; its Enter sends `act restore` with the preselected ids in the banner's order, as the banner's button does untouched. The run's report shows where stage C shows it, also when the banner was dismissed (one rule in C's `web/banner.js`: the report is drawn while it holds lines, whatever the payload says). With no offer there is no such entry. | S2 12.7: "the switcher still offers 'Restore 3 sessions from <time>' until the next WSL restart". The rule of the default set is C's view model; the page only shows what the banner payload holds. | 98 (12.7) |
| E13 | **The selected session the list does not show** (stage A's known limit, S2 12.6). `list` gains `selectedRow`: the row of the session `view.selected` names, as the sections would carry it, also when they leave it out (a filter, the chips, done hidden, a folded Earlier). A terminal of the window that holds such a session is shown with that row: its header (stage D's, so it can be edited) and its ended bar with Resume and Close at once. Without a terminal the right side shows nothing, as S2 12.9 says (ruled for stage A's task 27). The list still shows no row selected and its keys act on none; when the filter shows the row again it is selected again. | Stage D's plan leaves exactly this to stage E (its section 5). | 95 (12.6, 12.9) |
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
  the directory, whatever its name, and that none of them holds `RegExp(` (a constructor or a
  call). This prints nothing after every task:
  ```sh
  # no pattern is built from a search text
  rg -n "RegExp\s*\(" src/window/view/search web/search-text.js web/chips.js web/switcher.js
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
/** E3: each field is searched in its first FIELD_UNITS UTF-16 units. */
export const FIELD_UNITS = 16_384;
/** E2: a word matches the session id only as its start, and only with this many characters. */
export const ID_PREFIX_MIN = 4;
/** E9: the most ranges foundIn gives. */
export const MAX_FOUND = 32;

/** E4 (task 96 moves this type into protocol.ts, unchanged, and imports it from there). */
export type SearchChip = 'running' | 'open-pr' | 'note';
export const SEARCH_CHIPS: readonly SearchChip[]; // ['running', 'open-pr', 'note']

/** E2: the words of a search text — split at /\s+/u, empty parts dropped, toLowerCase, the first
 *  MAX_WORDS, then each once in order. */
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
  /** A terminal of the window holds the row (its `terminal` is not null): it never stacks. */
  readonly held: boolean;
}
/**
 * E6 for the rows of one section (This week or Earlier), in the section's order (most recent
 * first). Returns the rows to draw, in order: every row that is in no stack, at its place; each
 * head at its own place (the first of its group's rows that are not held); right after an open
 * stack's head, its other members in their order; a closed stack's other members left out. A
 * group with one row that is not held is no stack. `stack` is null for a row in no stack.
 */
export function stackRows<T extends StackEntry>(
  rows: readonly T[],
  opened: ReadonlySet<string>,
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
export interface SwitcherPayload {
  /** The text it answers (view.switcher), as the page sent it. */
  query: string;
  items: SwitchItem[];
  /** How many matching sessions were left out after MAX_ITEMS. */
  more: number;
}
export const MAX_ITEMS = 50;
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
 * candidates' order. The first MAX_ITEMS; `more` the rest.
 */
export function switcherPayload(
  query: string,
  candidates: readonly SwitchCandidate[],
  needOrder: readonly string[],
): SwitcherPayload;
```

### 2.3 Messages: `src/window/protocol.ts` (tasks 95, 96)

```ts
// Task 95. ListMessage gains — optional for the reader: a list without it (a scripted list of
// the helpers, a server before stage E) counts as null.
  /** E13: the row of the session view.selected names, as the sections would carry it (its
   *  `stack` null), also when they leave it out; null when the view selects none or a session
   *  the view model does not list even with done ones shown. */
  selectedRow?: RowPayload | null;

// Task 96. Moved here unchanged from src/window/view/search/: SearchChip, StackPayload,
// SwitchRank, HiddenBy, SwitchItem, SwitcherPayload (the search modules then import them).
/** E6: the most groups view.opened names. */
export const MAX_OPENED = 64;
// ViewMessage gains, each optional (absent: none — as a page before stage E sends):
  /** E4: each once. */
  chips?: SearchChip[];
  /** E6: the groups whose stacks the user opened; at most MAX_OPENED, each a text, each once. */
  opened?: string[];
  /** E8: the switcher's text while it is shown; null while it is not. */
  switcher?: string | null;
// RowPayload.stack: StackPayload | null        (stage A: null)
// ListMessage gains (optional for the reader, as selectedRow)
  /** E8, E9: while view.switcher is a string; else null. */
  switcher?: SwitcherPayload | null;
```

Limits `parsePageMessage` applies (stage A's rules for the rest): `chips` an array of distinct
values of `SearchChip`; `opened` an array of at most 64 distinct strings, each a text (1,024 bytes
of UTF-8, well formed); `switcher` null or a text (1,024 bytes, well formed). An unknown chip, a
repeated one, a 65th group, a group of 1,025 bytes, a switcher's text of 1,025 bytes and a lone
surrogate are each refused (`{ ok: false, kind }`, the kind holding none of the text).

### 2.4 The view model: `src/window/view/build.ts` (tasks 95, 96)

```ts
// ViewInput.view gains (optional, so that stage B's notifier and every caller of stages A–D
// compile unchanged):  chips?: readonly SearchChip[]; opened?: readonly string[]; switcher?: string | null
```

`buildListMessage` (task 95): `selectedRow` is the payload the loop made for the candidate whose
id is `view.selected` (listed, or a done one), with `stack: null`; null when there is none.

`buildListMessage` (task 96), changes to stage A's rule, in this order:
- `words = searchWords(view.filter)`, `chips = view.chips ?? []`; a row matches when
  `matchesWords(searchable(row), words) && matchesChips(row, open, chips)`;
  `filtering = isFiltering(words, chips)`.
- Listed as in stage A, but while filtering done rows are listed too (as with `showDone`), and
  `doneHidden` is 0; the sections show the matching rows; while filtering no section is folded.
- This week and Earlier, while not filtering: `stackRows(entries, new Set(view.opened ?? []),
  view.selected)`; each drawn row's payload gets its `stack`; a section's `rows` are the drawn
  rows, its `count`, `firstNs` and `lastNs` all its rows' (a folded Earlier: `rows: []` as in
  stage A). A row is `held` when its payload's `terminal` is not null.
- While `typeof view.switcher === 'string'`: `switcher = switcherPayload(view.switcher,
  candidates, needOrder)`, the candidates every row that is listed with done ones shown, sorted
  as 2.2 says (Open's comparator for the open ones, the recent-first one for the others), each
  with its `hiddenBy` for this view (2.2's meanings) and `need` = its payload's `attention` is not
  null; `needOrder` is stage B's `attentionOrder` over those that need you (B's 2.4), [] without
  stage B. Otherwise `switcher: null`.
- `counts`, stage B's `needYou` and stage C's banner are untouched by any of it.

### 2.5 The page's modules (tasks 93, 95, 97, 98): changes to stage A's contract 2.9

```js
// web/search-text.js — task 93; pure, no DOM (node:test and the root tsc load it)
export const MAX_WORDS = 16;
/** E3: `text` up to the end of its MAX_WORDS-th word, split as the server splits (/\s+/u); `cut`
 *  when a word came after it. searchWords(cutWords(t).text) equals searchWords(t) (task 93's
 *  parity test). */
export function cutWords(text) {}            // → { text: string, cut: boolean }
/** E7: `×4`. */
export function stackBadge(size) {}          // → string
/** E7: `+3 more in ORB-2107` for a stack of 4; the group passed through list-text.js's sanitize. */
export function moreText(size, group) {}     // → string
/** The parts of `text` with `found`'s ranges marked; ranges out of order, overlapping, empty or
 *  past the end are clamped or dropped, so that the parts always join to `text`. */
export function highlightParts(text, found) {} // → { text: string, found: boolean }[]
/** E9: 'Needs you', 'Open', 'Not running', 'Done'. */
export function rankHeading(rank) {}         // → string
/** The switcher's footer: `↑ ↓ move · Enter <action> · Esc close`, then ` · <n> more: type to
 *  narrow` when more > 0. action: 'switch' | 'resume here' | 'restore'. */
export function switcherFooter(action, more) {} // → string

// web/pane.js — task 95
// paneFor(selected, rows, terminals, newOpen, selectedRow = null): a selected session the rows
// lack, held by a terminal → { kind: 'terminal', row: selectedRow, term, ended } (stage A: row
// null); not held → { kind: 'none' } as in stage A. app.js passes `state.list?.selectedRow ?? null`.

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
// through hooks.view (at most 64 groups — the parser's MAX_OPENED, a number the page holds itself,
// since web/ imports only types from src/ —, the oldest dropped; a group over 1,024 bytes is
// never sent, so its stack opens only while a member is selected — a named limit). `filtering` is
// a word in the field or a chip (the empty line, and folding: nothing folds while filtering).
// Hooks kept for the shared helpers: exactly one `#list [data-id]` per drawn row (the `+n more`
// line carries `data-head`, never `data-id`); `data-selected="true"` on the selected row only;
// `#list input.list-filter` always there; `#list` takes the keyboard. A member's element carries
// `data-stack="member"`, a head's `data-stack="head"`.

// web/switcher.js — task 98
/** @param {HTMLElement} root  #switcher (index.html, task 97)
 *  @param {{ text(value: string): void,           // its field changed: app.js sends view.switcher
 *            pick(item: SwitchItem): void,        // Enter on the highlighted item, or a click on one
 *            restore(sessionIds: string[]): void, // Enter on the restore offer (E12)
 *            closed(): void,                      // once whenever it closes, whatever closed it
 *            now(): string }} deps                // the server's now (stage D's serverNow), for ages */
export function createSwitcher(root, deps) {}
// → { open(): void, close(): void, shown(): boolean,
//     update(list: ListMessage): void,   // every list while shown: its items, its offer; the
//                                        // highlight stays on the same session while it is there
//     escape(): void }                   // app.js hands it Esc while shown (capture phase), as D2
// Its field is `#switcher input.switcher-field`; each item `#switcher [data-id]` (not inside
// #list), the highlighted one `data-active="true"`. An item shows the state icon, the group dim
// before the title when the title does not start with it, the title with its found parts in
// `mark` elements, a second line (a running row's state line from list-text.js's rowText; else
// `not running · <age>`), then ` · <directory>`, and at the right the chip and the slot.

// web/keys.js — task 98
// windowChord: Ctrl+Shift+P gives { kind: 'switcher' } in both zones (stage A: `later`, stage E).
/** E11, the switcher's field: { kind: 'move', by: 1 | -1 | 'page-up' | 'page-down' } |
 *  { kind: 'pick' } | { kind: 'close' } | { kind: 'stay' } (Tab, Shift+Tab) | null — only without
 *  Ctrl, Alt and Meta, and with Shift only for Tab. */
export function switcherKey(e) {}
```

`web/app.js` (task 98) owns: `state.view.switcher`; `changeView` cuts the filter's and the
switcher's text after 1,024 bytes (stage A) and then after 16 words (`cutWords`), the key bar
saying `the filter is cut to its first 16 words` (the switcher's footer: `only the first 16 words
are searched`); the chord (open, or close when shown); E11's modal rule — stage D's `modal`
condition becomes "a dialog or the switcher is shown" —; `switcher.update(list)` at every list
while shown; the pick: `list.reveal(item.hiddenBy)` with E10's line when `filter` is in it, then
`select` and the activation rule of stage A's `activate`, applied to `item.row`; the restore
offer: `act restore` with its ids, a refusal in the key bar; `closed()`: the keyboard back where
it was, or to a terminal this page's resume brought meanwhile; a lost connection closes the
switcher; a click on the title bar's `Switch…` button opens it, as the chord does (the mockup's
button; like the rest of the page's chrome it takes no keyboard on its mousedown, and the switcher's
field then takes it). `web/index.html` (task 97) gains `<div class="switcher" id="switcher"
hidden></div>` at the body's level beside `#help`, the stylesheet `search.css`, the title bar's
`<button class="switch-button" id="switch-button" type="button">⌕ Switch… <kbd>Ctrl+Shift+P</kbd></button>`
(no action until task 98), the key bar's hint `<kbd>Ctrl+Shift+P</kbd> switch`, and the icon's two
links in place of `<link rel="icon" href="data:," />`.

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

**Depends on:** 0 · **Waits for:** — · **Wave:** 1 · **Design:** S2 4.3, 12.8, design 7.4 · **Contracts:** 2.1, 2.2 (`filter.ts`) · **Decisions:** E1, E2, E3, E4, E5 (recorded by 96) · **Shared files:** none

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
  and trailing white space; upper case lowered; a repeated word once; 17 words → the first 16.
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
- The bound of E3: 1,000 rows with notes of 16,384 `a`, 16 words of 63 `a` and a `b` →
  `matchesWords` over all of them within 2 seconds.
- `imports.test.ts`: every `.ts` file of `src/window/view/search/` imports values only as 2.1 says,
  and none holds `RegExp(`.

**Done when:** S2 12.8's matching, E2–E5, is a tested pure function and its bounds are pinned;
`npm run check` passes.

**Not in it:** the list message (96); the page (93, 97, 98).

---

### Task 91: Stacks

**Depends on:** 0 · **Waits for:** — · **Wave:** 1 · **Design:** S2 12.2, 12.9 · **Contracts:** 2.2 (`stacks.ts`) · **Decisions:** E6 (recorded by 96) · **Shared files:** none

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
- A held row of the group → drawn on its own, never in the stack, and not counted: with one other
  row of the group left, no stack.
- The order of the section is kept for every row that is drawn; nothing is drawn twice.

**Done when:** E6 is a tested pure function; `npm run check` passes.

**Not in it:** which rows a section holds (96); the drawing and the keys (97).

---

### Task 94: The page's own icon

**Depends on:** 0 · **Waits for:** — · **Wave:** 1 · **Design:** S2 8.2.1, 12.12, 15.4 · **Contracts:** 2.6 · **Decisions:** E14 (recorded by 97) · **Shared files:** none

**Goal.** skydeck's icon as committed files, and the two routes of S2 8.2.1 that serve the
favicon and the manifest. The page links them in task 97.

**Files**
- Create: `web/icons/skydeck.svg`, `web/icons/icon-16.png`, `web/icons/icon-32.png`,
  `web/icons/icon-48.png`, `web/icons/icon-192.png`, `web/icons/icon-512.png`,
  `web/icons/icon-192-maskable.png`, `web/icons/icon-512-maskable.png`, `web/icons/favicon.ico`,
  `web/manifest.webmanifest`, `scripts/icons.ts`, `test/window/icons.test.ts`
- Modify: `src/window/assets.ts`, `test/window/assets.test.ts` (the two cases that pinned
  `/manifest.webmanifest` and `/favicon.ico` as 404 now pin their answers)

**Behaviour.** The SVG is drawn for skydeck (a simple mark that reads at 16 pixels, the page's
accent colour; the mockup's logo is a rounded square with a blue gradient), square, self-contained:
no script, no `on…` attribute, no `<foreignObject>`, no `href` or `xlink:href` but to `#…`, no
`@import`, no `url(` but to `#…`. `scripts/icons.ts` as 2.6; the implementer runs it once and
commits what it wrote, and the pull request shows the 32 and 192 PNGs. The routes as 2.6.

**Tests** (platform: `testPlatform`; the files read from the checkout)
- `icons.test.ts`: each PNG starts with the PNG signature, its `IHDR` gives the size its name
  says, 8 bits per channel, with alpha (colour type 6) for the five with a transparent background;
  the ICO's directory names three images of 16, 32 and 48 pixels whose bytes
  are those of the three PNGs; the manifest is JSON with exactly `name`, `short_name`, `display`
  and `icons`, `skydeck`, `skydeck`, `standalone`, and seven icons whose `src` is
  `/assets/__VERSION__/web/icons/<file>` of a file that exists, with its `sizes` and `type`, the
  two maskable ones `purpose` `maskable`; the SVG holds none of what the behaviour forbids.
- `assets.test.ts`: `/manifest.webmanifest` → 200, `application/manifest+json`, `no-store`, the
  build in every `src` and no `__VERSION__` left; every `src` is served under the build, `image/png`;
  `/favicon.ico` → 200, `image/x-icon`, `no-store`, the ICO's bytes; both carry the security
  headers; `/assets/<build>/web/manifest.webmanifest` → 404; a checkout without them → both 404
  as before; the build changes when an icon's bytes change.

**Done when:** the icon's files are in the repository and served as S2 8.2.1 says; `npm run
check` passes.

**Not in it:** the links in `index.html` and the page test (97); whether Edge shows it (W3, 99).

---

### Task 92: The quick switcher's ranking

**Depends on:** 90 · **Waits for:** — · **Wave:** 2 · **Design:** S2 12.8, 12.4 (the order of those that need you), 12.1 (Open's order) · **Contracts:** 2.2 (`switcher.ts`) · **Decisions:** E9 (recorded by 96) · **Shared files:** none

**Goal.** S2 12.8's ranking of every session for the switcher, as one pure function.

**Files**
- Create: `src/window/view/search/switcher.ts`, `test/window/view/search/switcher.test.ts`

**Behaviour.** As 2.2; `matchesWords` and `foundIn` of task 90 do the matching. Nothing in it
knows stage B or C: `need` and `needOrder` are given.

**Tests** (platform: none — candidates built from step 1's builders through task 90's `searchable`)
- No text: every candidate, ranked need, open, not running, done; inside each the candidates'
  order; `need` in `needOrder`'s order, one that `needOrder` lacks after them.
- A done row that is open (a running session marked done) → `open`; a done row that needs you →
  `need`.
- Two words → only the candidates that match both; the id's prefix finds its session.
- 60 candidates → 50 items and `more` 10; with a text that 3 match → 3 and `more` 0.
- `found` is `foundIn(row.title, words)`; `hiddenBy` and `row` are passed on as they are; `query`
  is the text as given (not cut, not lower-cased).
- Nothing → `{ query, items: [], more: 0 }`.

**Done when:** E9 is a tested pure function; `npm run check` passes.

**Not in it:** the candidates and `hiddenBy` (96); the restore offer (98, from stage C's banner).

---

### Task 93: The page's texts of search

**Depends on:** 90 · **Waits for:** — · **Wave:** 2 · **Design:** S2 12.2, 12.8 · **Contracts:** 2.5 (`search-text.js`) · **Decisions:** E3, E7, E9 · **Shared files:** none

**Goal.** Every text of stage E that the page writes, without the DOM, so that node:test holds
them and the page's cut of a search text is the server's.

**Files**
- Create: `web/search-text.js`, `test/web/search-text.test.ts`

**Behaviour.** As 2.5. It imports `sanitize` of `web/list-text.js` and nothing else.

**Tests** (platform: none)
- Parity: for a table of texts (white space of every kind of E2, 16 and 17 words, repeated words,
  only white space, 1,024 bytes of one word) `searchWords(cutWords(t).text)` equals
  `searchWords(t)` of task 90, and `cut` is true exactly when a 17th word was there.
- `stackBadge(4)` → `×4`; `moreText(4, 'ORB-2107')` → `+3 more in ORB-2107`; a group holding an
  escape sequence → sanitised.
- `highlightParts`: two ranges → five parts that join to the text; ranges out of order,
  overlapping, empty, past the end, negative → clamped or dropped, the parts still join to the
  text; no range → one part.
- `rankHeading` of each rank; `switcherFooter` for each action, with and without `more`.

**Done when:** the texts are tested and the page's cut equals the server's; `npm run check`
passes.

**Not in it:** the DOM (97, 98).

---

### Task 95: The selected session the list does not show

**Depends on:** 0 · **Waits for:** D 34 (`protocol.ts`, `build.ts`, their tests, `test/web/pane.test.ts`), D 37 (`app.js`), B 51 (`protocol.ts`, `build.ts`), B 55 (`app.js`), C 70 (`protocol.ts`), C 75 (`app.js`) · **Wave:** 3 · **Design:** S2 12.6 (the ended bar's known limit), 12.9 (the selection) · **Contracts:** 2.3 (`selectedRow`), 2.4, 2.5 (`pane.js`) · **Decisions:** E13 (update S2 12.6, 12.9) · **Shared files:** `src/window/protocol.ts`, `src/window/view/build.ts`, `web/pane.js`, `web/app.js`, `test/window/view/build.test.ts`, `test/web/pane.test.ts`, `docs/design-step-2.md`

**Goal.** A terminal of the window whose session the filter (or the chips, or done hiding, or a
folded Earlier) hides is shown with its header and an ended bar that has Resume and Close, so
that the header of stage D can be edited and the bar used.

**If absent:** without stage D the header drawn is stage A's read-only one (with D, D's, which can
be edited); without B or C nothing differs.

**Files**
- Create: `test-page/hidden-selection.test.ts`
- Modify: `src/window/protocol.ts` (`ListMessage.selectedRow`), `src/window/view/build.ts`,
  `web/pane.js`, `web/app.js` (the one call of `paneFor`), `test/window/view/build.test.ts`
  (new cases only), `test/web/pane.test.ts` (new cases only), `docs/design-step-2.md` (12.6: the
  known limit goes, E13 in a sentence; 12.9: the sentence on the right side of a selection the
  list does not show)

**Behaviour.** As E13, 2.3, 2.4 and 2.5.

**Tests** (platform: none for `build.test.ts` and `pane.test.ts`; `realTestPlatform` for the page,
a test server with sessions made by step 1's helpers and the stand-in in a window terminal)
- `build.test.ts`: `selectedRow` for a selected session the filter hides equals the payload the
  sections carry once the filter is cleared; for a done one while done ones are hidden; for one
  in a folded Earlier; for one shown in the sections the same row; null with nothing selected and
  for an id no row has.
- `pane.test.ts`: a selected session the rows lack, held by a terminal → `terminal` with
  `selectedRow`; held by an ended terminal → the same with `ended`; not held → `none`; `selectedRow`
  absent (a list of stage A's helpers) → stage A's answer.
- `hidden-selection.test.ts`: a stand-in in a window terminal is selected; a filter that hides it
  → the list shows no row selected, the terminal is still shown and its header shows its title
  and short id; `/exit` in it → the ended bar with Resume and Close at once (before the exit
  arrives, too: "claude is not running in this terminal" with both); Resume → it runs again in
  the window; `/exit` again, then Close → the terminal is forgotten and the right side is empty;
  the filter cleared → the row is selected again. A selected session without a terminal hidden by the filter
  → the right side shows nothing (S2 12.9). With stage D merged: the header's label dialog opens
  for the hidden session. The page of the real server reports no problem at the end of each case.

**Done when:** the right side of a hidden selected session shows what E13 says, and stage A's
known limit is gone from S2 12.6; `npm run check` passes.

**Not in it:** search itself (96–98).

---

### Task 96: Search in the list message

**Depends on:** 90, 91, 92, 95 · **Waits for:** D 34, B 51, C 70 (`protocol.ts` and its test, `build.ts` and its test) · **Wave:** 4 · **Design:** S2 4.3, 8.2.3, 8.2.7, 12.1, 12.2, 12.8 · **Contracts:** 2.2, 2.3, 2.4 · **Decisions:** E1–E6, E8, E9 (update S2 4.3, 8.2.3, 12.2, 12.8) · **Shared files:** `src/window/protocol.ts`, `src/window/view/build.ts`, `test/window/protocol.test.ts`, `test/window/view/build.test.ts`, `docs/design-step-2.md`

**Goal.** The server sends each page the list its view asks for: the filter of several words and
the short id, done sessions while filtering, the chips, the stacks, and the switcher's items.

**If absent:** without stage B no row has attention, `needOrder` is [] and the switcher has no
Needs you rank (`build.ts` imports nothing of B's); without C or D nothing differs.

**Files**
- Create: `test/window/view/search-list.test.ts`, `test/window/protocol-search.test.ts`
- Modify: `src/window/protocol.ts` (2.3), `src/window/view/build.ts` (2.4),
  `src/window/view/search/filter.ts`, `stacks.ts`, `switcher.ts` (their message types imported
  from `protocol.ts`, nothing else), `test/window/protocol.test.ts` (the case "stage A's view has
  no chips" and the `@ts-expect-error` on a view with `chips`: a view with `chips: []` is now
  taken), `test/window/view/build.test.ts` (the allowed imports gain `./search/filter.ts`,
  `./search/stacks.ts`, `./search/switcher.ts` and lose `matchesFilter`; the cases that pinned
  design 7.4's filter in the window — one text, done sessions not shown while filtering — follow
  E2 and E5), `docs/design-step-2.md` (4.3: E1; 8.2.3: `view`'s `chips`, `opened`, `switcher`,
  `list`'s `switcher`, the stack on a row; 12.2: E6; 12.8: E2–E5, E9)

**Behaviour.** As 2.3 and 2.4.

**Tests** (platform: none — pure, step 1's builders; the protocol's cases as stage A's)
- `protocol-search.test.ts`: a view with each new field at its limits is taken, one over them
  refused (2.3's list); a view without them is taken (stage A's page); a kind never holds the
  text it refused (a marker in a group, a chip, a switcher's text).
- `search-list.test.ts`:
  - the filter: two words in two fields → that row only; the short id's first 4 characters;
    `fix 2` does not match through the id; the words' order does not matter;
  - done sessions: a filter that matches a done row lists it with its `done` mark and
    `doneHidden` 0; the chip `note` alone does the same; without a filter or a chip stage A's rule;
  - chips: each, and two together with a word; Earlier unfolded while a chip is set;
  - stacks: three rows of `ORB-1` in This week → one head with `stack` `{ size: 3, open: false,
    role: 'head' }`, `count` 3, `rows` 1; `opened: ['ORB-1']` → three rows; the selected member
    → open; the same group in Earlier → its own stack; a row with an ended window terminal of
    the group → on its own; a filter → no stack; Open never stacks;
  - the switcher: `switcher` null without `view.switcher`; with `''` every listed session with
    done ones, ranked; a done session and one the filter hides are items, with `hiddenBy`
    `['done']`, `['filter']`, `['filter', 'done', 'folded']` as 2.2 says; with stage B's facts the
    sessions that need you first in B's order; `counts` and `needYou` the same with and without a
    switcher;
  - every stage A, B and D case of `build.test.ts` passes but the filter's cases named above.

**Done when:** every rule of S2 12.2 and 12.8 that the server decides is in the list a page gets;
`npm run check` passes.

**Not in it:** the page (97, 98).

---

### Task 97: The list on the page — chips, stacks, the icon's links

**Depends on:** 93, 94, 96 · **Waits for:** D 34, B 55 (`web/list.js`), D 37, B 55, C 75 (`web/index.html`) · **Wave:** 5 · **Design:** S2 8.2.1, 12.1, 12.2, 12.8, 12.9 (the list zone), 12.12, 15.4 · **Contracts:** 2.1, 2.5 (`chips.js`, `list.js`, `index.html`) · **Decisions:** E4, E5, E7, E14 (update S2 8.2.1, 12.2, 12.12) · **Shared files:** `web/list.js`, `web/index.html`, `docs/design-step-2.md`

**Goal.** The list shows the chips, the stacks and done sessions while filtering exactly as the
server sends them, and the page has its icon.

**If absent:** without stage B, C or D nothing differs: the rows draw what `web/list-text.js`
gives on `main`.

**Files**
- Create: `web/chips.js`, `web/search.css`, `test-page/search.test.ts`, `test-page/icon.test.ts`
- Modify: `web/list.js` (the chips under the filter field; the stack's badge, its `+n more` line,
  its members; ← → on stacks; `filtering`; `reveal`), `web/index.html` (2.5: `#switcher`,
  `search.css`, the title bar's `Switch…`, the key bar's hint, the icon's links),
  `docs/design-step-2.md` (8.2.1: the two paths' answers; 12.12: E14; 12.2: E7's look; 12.9: E7's
  ← → on a stack)

**Behaviour.** As E4, E5, E7 and 2.5. The `+n more` line and every element list.js adds are made
once and kept across renders, as stage A's rows (a render never loses a click). The filter
field's placeholder names the short id. The chips and the `+n more` line take no keyboard on a
click.

**Tests** (platform: `realTestPlatform`; a test server with sessions made by step 1's helpers:
groups, notes, pull requests saved with `savePrResult`, done ones, old ones for Earlier)
- `search.test.ts`, the filter and the chips: two words typed → the rows of both; a short id's
  first characters → its row; a done session that matches shows with `done`, and the footer
  is gone; each chip pressed → `aria-pressed` and the rows the server sent, the keyboard where it
  was; `Show done`, `a` and the footer's `show` are one state (each turns the others on);
  `No session matches the filter.` for a chip that matches nothing; nothing folds while a chip is
  set.
- `search.test.ts`, stacks: three sessions of `ORB-1` in This week → one row with `×3` and the
  line `+2 more in ORB-1`; a click on the line → three rows, the members indented and marked;
  ← on a member → the head selected and the stack closed; → on the head → open; ← on the head →
  closed; ← on a row that is in no stack folds Earlier as before; ↓ from a closed head skips the
  hidden members and the line; Ctrl+Tab back to a member selected earlier → its stack is open;
  a filter → no stack; a hostile group `<img src=x onerror=…>` in the line and a hostile title on
  a member are text (`querySelector('img')` null); exactly one `#list [data-id]` per drawn row.
- `icon.test.ts`: the page's icon link names `/assets/<build>/web/icons/favicon.ico` and it
  answers 200 `image/x-icon`; the manifest link loads JSON whose icons answer 200; the page
  reports no problem (no CSP refusal, no failed load).
- At the end of every real-server case the page reports no problem.

**Done when:** every element of S2 12.2 and 12.8 that the list shows is drawn for its case, with
its keys, and the page links its icon; `npm run check` passes.

**Not in it:** the switcher and the `Switch…` button's action (98); `reveal`'s caller and its
tests (98); the page's cut after 16 words (98: until then the server uses the first 16, E3).

---

### Task 98: The quick switcher on the page

**Depends on:** 97 · **Waits for:** D 37, B 55, C 75 (`web/app.js`, `keys.js`, `help.js`, `test/web/keys.test.ts`, `test-page/shell.test.ts`), C 75 (`web/banner.js`) · **Wave:** 6 · **Design:** S2 11.3, 12.6, 12.7, 12.8, 12.9, 15.4 · **Contracts:** 2.5 (`switcher.js`, `keys.js`, `app.js`) · **Decisions:** E3, E10, E11, E12 (update S2 12.7, 12.8, 12.9) · **Shared files:** `web/app.js`, `web/keys.js`, `web/help.js`, `web/banner.js`, `test/web/keys.test.ts`, `test-page/shell.test.ts`, `test-page/keys.test.ts`, `docs/design-step-2.md`

**Goal.** Ctrl+Shift+P opens the quick switcher over every session; typing narrows it, Enter
switches to the session or resumes it, and the keyboard never leaves it while it is shown.

**If absent:** without stage D, `app.js` has no modal rule yet: this task adds one for the
switcher alone (`modal()` is "the switcher is shown"), `now()` counts on from the list's `nowNs`
in `app.js` as `web/list.js` does (there is no `serverNow` yet), and the case with a delayed resume
builds its scripted world in its own file from stage A's `standinServer` and `honest`; without B the
switcher shows no Needs you rank (the server sends none); without C there is no offer and
`web/banner.js` is not touched.

**Files**
- Create: `web/switcher.js`, `test-page/switcher.test.ts`
- Modify: `web/search.css` (the switcher's styles), `web/app.js` (2.5), `web/keys.js`
  (Ctrl+Shift+P, `switcherKey`), `web/help.js` (the Ctrl+Shift+P line no longer comes later: `the
  quick switcher: every session, done ones too — type to narrow, ↑ ↓ move, Enter switches to it or
  resumes it, Esc closes`; the `← →` line `fold or unfold Earlier; open or close a stack`; the `/`
  line `filter: several words, all must match, also the short id`), `web/banner.js` (E12's one
  rule), `test/web/keys.test.ts` (Ctrl+Shift+P gives `switcher`; `switcherKey`'s cases; `later`
  only where it remains), `test-page/shell.test.ts` (the later-keys case's Ctrl+Shift+P step: it
  opens the switcher), `test-page/keys.test.ts` (its Ctrl+Shift+P step: the program gets
  nothing and the switcher opens), `docs/design-step-2.md` (12.7: E12; 12.8: E10; 12.9: E11)

**Behaviour.** As E10, E11, E12 and 2.5. The panel lies over the page (the mockup's), with the
field on top, the items grouped under `rankHeading`'s headings, and the footer (`switcherFooter`);
`No session matches.` when nothing does. The highlight starts on the first item and follows
↑ ↓ PgUp PgDn, scrolled into view; a held key acts at each repeat for ↑ ↓ and once for Enter.

**Tests** (platform: `realTestPlatform`; a test server with sessions made by step 1's helpers and
the stand-in, unless a scripted world is named)
- `keys.test.ts`: Ctrl+Shift+P on a US and a Czech layout, both zones → `switcher`, cancelled;
  `switcherKey` for ↑ ↓ PgUp PgDn Enter Esc Tab Shift+Tab, and null with Ctrl, Alt or Meta and for
  a letter.
- `switcher.test.ts`, opening and typing: Ctrl+Shift+P from the terminal and from the list, and a
  click on the title bar's `Switch…` → the panel, the keyboard in its field; typing → items of the server's ranking, the matched parts in
  `mark` elements; a short id's first 4 characters → its session first; Esc → closed, the keyboard
  back where it was (the terminal; the list; the filter's field); Ctrl+Shift+P again → closed; a
  click outside → closed; 17 words typed → the footer's line and the server got 16.
- Enter on each kind: a session open in the window → its terminal shown with the keyboard; one not
  running → resumed into the window (the stand-in starts, slot given) and its terminal takes the
  keyboard; one elsewhere (a stand-in the test runs outside the window) → its card; an expired one
  → its card with the server's refusal; a done one → resumed, under Open with `done`; one in a
  folded Earlier → Earlier unfolded and the row selected; one the filter hides → the filter and
  the chips cleared, the key bar says so, the row selected. A click on an item does what Enter
  does.
- The modal rule (a scripted world that answers a resume after 500 ms — stage D's `editWorld`):
  Enter on a session that is not running in the list, then Ctrl+Shift+P at once and typing → every
  character in the switcher's field, the page sent no `input`; the resume's terminal takes the
  keyboard only when the switcher closes. While shown, a list that arrives moves the keyboard
  nowhere; `j`, `d` and `/` typed are text; Ctrl+Shift+1 and Ctrl+Shift+L say `close the switcher
  first (Esc)` and change nothing; Ctrl+Shift+H shows the help; a held Enter picks once and none
  of its repeats reaches the program (stage A's held-key rule). With stage D: Ctrl+Shift+P while a
  dialog is shown says `close the edit first (Esc)`.
- The offer (with stage C; a scripted list with a banner of three, two preselected, `shown`
  false): the first entry `Restore 2 sessions from …`; `res` keeps it, `x` hides it; Enter → `act
  restore` with the two ids; the report shows its lines. A banner that runs, or none → no entry.
- Text: a hostile title, group and directory in an item, and a hostile text typed, create no
  element; the test server's log lines hold no marker typed into the filter or the switcher.
- Two pages of one server: each its own switcher and filter; a pick in one changes nothing in the
  other's selection.
- At the end of every real-server case the page reports no problem.

**Done when:** every part of S2 12.8's switcher works for its case, the help lists Ctrl+Shift+P
as a key that acts, and no key typed while it is shown reaches a terminal; `npm run check`
passes.

**Not in it:** the documents (99).

---

### Task 99: Documentation of stage E

**Depends on:** all · **Waits for:** D 39, B 56, C 79 (the documents) · **Wave:** 7 · **Design:** S2 12.2, 12.8, 12.12, 18, 19 · **Contracts:** — · **Decisions:** — · **Shared files:** `docs/install.md`, `docs/manual-checks.md`, `README.md`, `docs/design-step-2.md`

**Goal.** A user can search, use the chips, the stacks and the switcher from the documents
alone, and knows which checks only they can make.

**If absent:** the documents name only what is on `main` (an offer to restore only with stage C,
Needs you only with stage B, the header's editing only with stage D).

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (S2 18
  gains W30 and W31 below, W3 names the icon; S2 19's stage E line names W3, W30, W31)

**Content (contract)**
- `docs/install.md`, "Using the window": the filter (several words, all must match; the fields;
  at least 4 characters of the start of the short id; done sessions shown while filtering; Esc),
  the chips, stacks (`×4`, `+3 more`, a click, → and ←, a filter flattens them, the stack of a
  selected member opens), the quick switcher (Ctrl+Shift+P, the order, the keys, what Enter does
  for each kind of session, that a pick clears a filter that hides the session, the restore offer
  with stage C, Esc), and the icon. "Known limits of stage E": a note is searched in its first
  16,384 characters; 16 words count; the switcher shows 50 sessions (type to narrow); a title
  whose lower case is longer is not highlighted; a group over 1,024 bytes opens its stack only
  while a member is selected; a stack opened by the selection closes when it leaves.
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
  (and written down as left out).
- The task runs no `skydeck` command; what a command prints is held by the sandboxed tests.

| # | Check | Stage | Decides |
|---|---|---|---|
| W30 | On the user's own sessions (about 105), without Enter: two words of a ticket in the filter, a short id's first characters, each chip, a stack opened and closed with → and ←, the switcher opened, typed into, moved through with ↑ ↓ and closed with Esc. Whether any answer comes late enough to notice, and whether the order of the switcher is the one wanted. Then the throwaway session found by its label in the switcher and Enter: it resumes into the window. | E | 12.2, 12.8 |
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
| S2 8.2.3, `view.chips` (and `opened`, `switcher`), the row's `stack`, `list`'s `selectedRow` and `switcher` | 95, 96 |
| S2 8.2.7, several windows | 96 (each page's view), 98 (two pages) |
| S2 12.2, stacks | 91 (rule), 96 (in the list), 97 (drawn, keys) |
| S2 12.6, the ended bar of a session the filter hides | 95 |
| S2 12.7, the switcher's offer | 98 |
| S2 12.8, the filter, done sessions, the chips | 90, 96, 97 |
| S2 12.8, the quick switcher | 92 (ranking), 96 (in the list), 93, 98 |
| S2 12.9, the list zone's ← →, the switcher's keys and its hold on the keyboard, the help | 97, 98 |
| S2 12.12, the icon | 94, 97 |
| S2 15.4, text never markup | 2.1; every page task's hostile-text case |
| S2 18, W3 (the icon), W30, W31 | 99 |
| S2 19, stage E | this plan |

## 5. What stage E needs from stages B, C and D, and what it leaves

Stage E reads, and never changes, what B, C and D build: B's `attention` on a row and its
`attentionOrder` (the Needs you rank), C's `list.banner` and `activityTime` (the offer), D's
`serverNow`, `editWorld` and modal rule D2 (which E11 extends to the switcher). It edits their
files only where its own lines are: in `protocol.ts` and `build.ts` the optional fields of 2.3 and
the steps of 2.4; in `app.js` the one call of 95 and the switcher's wiring; in `keys.js` only
Ctrl+Shift+P (the last `later`); in `help.js` three lines; in `list.js` the chips and the stacks;
in `index.html` the elements of 2.5; in `banner.js` one rule (E12). No migration, no new store key,
no server module. Section 1's tables list every file of every task, for the lead's check against
the other stages.

**The follow-up on stage E's path** (stage D's section 5): *the ended bar of a session the filter
hides* — **settled** by task 95 (E13).

## 6. Stage E is ready to try

When task 99 is merged. In a WSL terminal of your own (not a `!` command inside Claude Code), with
the window open as it is now:

```sh
cd ~/projects/mine/skydeck
git pull
skydeck window          # restarts the window's server for the new build; your sessions keep
                        # running, the window reloads itself
```

No `npm ci`, no `install` again: nothing of the hook or the store changes. If the taskbar button
still shows Edge's icon after the reload, close the window and run `skydeck window` again (W3
writes down which it took).

**What only you can check** (task 99's sections):

- **W3** — the window's taskbar button shows skydeck's icon, also after `skydeck window --restart`.
- **W30** — on your own sessions, without Enter: the filter, the chips, a stack, the switcher; any
  delay you notice; whether the switcher's order is the one you want. Enter only on the throwaway
  session.
- **W31** — the filter's and the switcher's fields on your Czech and US layouts.
- And the choices made for you, each yours to change: a word matches the short id from 4
  characters on (E2); the switcher matches words, not scattered letters (E9); a pick clears a
  filter that hides the session (E10); a row that has a terminal of the window never stacks, and
  a stack stays open while one of its members is selected (E6).

## 7. Questions for the lead

Planned around the reading given; each is the lead's or the user's to change.

1. **The switcher's matching** (E9). The mockup matched titles by subsequence (`orb7` finds
   `ORB-2107`) and ranked by where the match lies. Planned: the filter's words (one rule, fewer
   surprises over about 105 sessions), the order of S2 12.8 inside each rank. The other way is a
   second rule in `switcher.ts`, with its own bounds.
2. **A pick of a session the list does not show** (E10). Planned: the list is changed to show it
   (the filter and chips cleared, done ones shown, Earlier unfolded), so that S2 12.9's "the
   selection is never on a row the list does not show" holds and a refusal is seen on the card.
   The other way keeps the filter and shows the session's card under its header with no row
   selected in the list — which needs a change to S2 12.9's ruled "else nothing" (task 27).
3. **The short id** (E2). S2 12.8 says "short id"; planned: a prefix of at least 4 characters
   (also the whole id), not any part of the 8. Any part would make `2` match nearly every
   session.
4. **Stacks** (E6). S2 12.2 says running sessions never stack; planned: no row with a terminal of
   the window stacks either (an ended terminal keeps its slot, and Ctrl+Shift+1–9 must find it on
   screen). A stack also opens while one of its members is selected and closes again when the
   selection leaves (rows then move); the other way is for the page to remember it.
5. **The bounds** (E3): 16 words; a note searched in its first 16,384 characters; 50 items in the
   switcher. Planned as given; each is one constant.
6. **The report of a restore started from the switcher after "Not now"** (E12). Stage C shows the
   report only with the banner; planned: one rule in C's `web/banner.js` (the report is drawn
   while it has lines). The other way is for stage C's plan to say it.
7. **The check numbers.** W30 and W31 follow stage D's W27–W29; if another stage takes them, task
   99 uses the next free ones.
