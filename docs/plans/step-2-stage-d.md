# skydeck step 2, stage D — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stage D of step 2 as specified in [`docs/design-step-2.md`](../design-step-2.md)
(section 19): label, group, note, done and undone, attaching and detaching pull requests, in the
window, with the Undo toast; the window's pull-request chip (S2 12.3) and the header's
pull-request lines (S2 12.5); the list keys `l`, `g`, `n`, `p`, `d` and F2; and the ticket link
of the group chip that the user decided on 2026-11-15 (S2 12.5, 16.4). It works without stages
B, C and E.

**Architecture:** Every edit is an `act` of the page (S2 8.2.3) that the server carries out with
step 1's own rules and functions (`cleanLabel`, `setNote`, `attachManualPr`, …), never copies of
them; the server then loads the rows again and sends the lists, so that every window shows the
change. The page edits in dialogs of its own (the mockup's), shows what the server sends, and
decides no rule: the chip is a pure function of the view model, the ticket address is built on
the server from the configuration.

**Tech Stack:** as stage A — TypeScript on Node.js ≥ 24.12 through type stripping, `node:test`;
the page in plain JavaScript modules with JSDoc types and no build step; Playwright 1.60.0's
Chromium for the page suite.

---

## 0. How to use this plan

Stage A's plan (`docs/plans/step-2-stage-a.md`) section 0 holds for every task here: the execution
model (one pull request per task, tasks of one wave in parallel in their own worktrees, two
reviews before the lead merges), the sources of truth (the design wins over this plan; "design
7.1" is design.md, "S2 12.5" is design-step-2.md), what is fixed here and what is the
implementer's, the per-task workflow and the test rules (A32–A36: no real `claude`, no Windows
program, the sandbox, the two test platforms; page tests in headless Chromium through
`test-page/helpers/`). Its contracts (section 2) stay in force where this plan does not change
them; this plan's section 2 gives only the changes.

**Task numbers** go on from stage A's: 34–39, so that branch names, pull-request titles and the
notes of the lead stay unique. The implementer brief names the branch and the title.

**CI stays as it is**: two Node legs, one job each (the user's decision of 2026-11-14). No task
changes `.github/workflows/`, `package.json` or a dependency.

**Added to the test rules.** No test runs a real `gh`: the sandbox's `PATH` holds none, and the
tests that need a pull request's status either save it with the store's `savePrResult` or give
the server a runner that answers `gh` (`test/helpers/gh.ts`, task 36). Links the page opens reach
the recording Edge stub of every test server (A32), which is how a test sees them.

**Known flakes** (not stage D's to fix): `LEFT-TO-YOU.md` section 4, "Tests", lists them (the
input-full page case under load, `test/platform/real.test.ts:1005` and its streamed-answer case,
the stand-in's record order, `test/window/mapping.test.ts:623`). A run that fails only with one of
them is run once more, and the pull request names both runs.

## 1. Tasks and waves

Task 0 is `main` at 9c5cbfb (stage A complete) with this plan merged.

| # | Task | Depends on | Wave | Size (code + tests) |
|---|---|---|---|---|
| 34 | Contracts and the window's chip | 0 | 1 | ~600 |
| 35 | The ticket address: `ticketUrl`, `ticketAddress`, `show` | 0 | 1 | ~350 |
| 36 | Editing on the server | 34, 35 | 2 | ~750 |
| 37 | The editors, the Undo toast and the list keys | 34 | 2 | ~800 |
| 38 | The header: pull-request lines, the note, the controls | 36, 37 | 3 | ~700 |
| 39 | Documentation of stage D | all | 4 | docs only |

```
wave 1:  34  35
wave 2:  36  37
wave 3:  38
wave 4:  39
```

Task 37 builds against a scripted stand-in server (as stage A's `actsWorld`), so it does not wait
for task 36; task 38 is the first to drive editing end to end, through the real server and the
real dialogs. Task 39 may start its reading while 38 is built and merges last.

**Disjoint files in a wave.** Every new module is its own file with its own test file. The files
more than one task edits, and who edits them:

| File | Tasks (wave) |
|---|---|
| `src/window/protocol.ts`, `test/window/protocol.test.ts` | 34 (1) |
| `src/window/selected.ts`, `test/window/selected.test.ts` | 34 (1: `note`, `noteTooLong`, `ticketUrl` null), 36 (2: `ticketUrl`) |
| `src/window/actions.ts`, `test/window/actions.test.ts` | 34 (1: one interim case), 36 (2) |
| `src/window/view/sections.ts`, `src/window/view/build.ts` and their tests | 34 (1) |
| `web/list-text.js`, `web/list.js`, `web/list.css`, `test/web/list.test.ts`, `test-page/list.test.ts` | 34 (1) |
| fixtures the type change of 34 breaks (`test-page/helpers/shell.ts`'s `scriptedList`, `test/web/pane.test.ts`, `test-page/cards.test.ts`'s rows) | 34 (1); later tasks add new helper functions only |
| `src/platform/config.ts`, `src/cli/output.ts`, `src/cli/commands/show.ts` and their tests | 35 (1) |
| `src/window/server.ts`, `src/window/tick.ts`, `src/sessions/meta.ts`, `src/cli/notes.ts` | 36 (2) |
| `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html`, `test/web/keys.test.ts`, `test-page/shell.test.ts` | 37 (2) |
| `web/cards.js` | 37 (2: `header`'s second parameter and the three new deps, unused), 38 (3) |
| `web/cards.css`, `test-page/cards.test.ts` (its cases) | 38 (3) |
| `docs/design-step-2.md`, `docs/design.md` | each task records its decisions of 1a in the sections named there, disjoint within a wave; a conflict is rebased keeping both edits |
| `docs/install.md`, `docs/manual-checks.md`, `README.md` | 39 (4) only |

## 1a. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail.

| # | Decision | Why | Design update |
|---|---|---|---|
| D1 | Label, group, note and a pull request to attach are edited in a dialog over the page (`web/edit.js`), as the mockup shows: a heading that names the session, one field (a text box for the note), a line of help, Cancel and Save (Attach for a pull request). Not in place in the header. | The mockup the user approved (S2 12) has these dialogs; an editor inside the header would change its height under the terminal while the user types. | 37 (12.5) |
| D2 | The dialog is modal: a scrim covers the window and takes clicks without acting; while it is shown every window chord but Ctrl+Shift+H says `close the edit first (Esc)` and does nothing else (Ctrl+Shift+V in its field stays the browser's paste, Z1). Enter saves (Ctrl+Enter in the note, where Enter is a line break); Esc and Cancel close it, except that a note whose text was changed needs a second Esc (`Esc again discards your text`); the reload keys (F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R, BrowserRefresh) while it holds changed text say `save or cancel the edit first` and do not reload. The field has the keyboard while the dialog is shown; when it closes the zone's holder gets it (`giveKeyboard`). | An edit belongs to the session it was opened for; one key must not lose text the user typed. | 37 (12.9) |
| D3 | What a dialog starts from: the label field holds the title when its source is the label, else nothing (the title as placeholder); the group field the group when the user set it (`groupSource` `meta`), else nothing (the title's key as placeholder); the note's text box the stored note (`selected.note`). The note's `base` is that text as it was when the dialog opened; a later `list` never changes it. `n` acts only once a `list` carries the selected session's `selected`; before, the key bar says `the note is not here yet; press n again`. A text box normalises line breaks, so a note stored with CR line breaks is saved with LF ones: a named limit. | S2 12.5: a save is refused when the stored note changed since the edit began; the page has the whole note only in `selected`. | — |
| D4 | The window's chip (S2 12.3) is the pure function `windowChip` in `src/window/view/chip.ts`; `RowPayload.chip` becomes `{ level, open, merged }` (2.2). `src/window/view/` may import `CHIP_ORDER` of `src/github.ts`, design 7.3's order, beside A8's two functions. `ls` and the interactive list keep design 7.3's chip. | One order of the pull-request states in one place; the rule is the view model's (S2 4.3). | 34 (4.3, 8.2.3) |
| D5 | A note's `text` and `base` hold at most 65,536 bytes of UTF-8 each, as `input.data`; S2 8.2.3's 1,024 bytes would refuse most notes. The largest note `act`, every character escaped by JSON, stays under the WebSocket's message limit (1 MiB). `selected.note` is null for a longer stored note, with `noteTooLong`; the window then does not edit it and says `this note is longer than the window edits; use skydeck note <short id>`. The page refuses a longer text before sending it (the server would close the connection for it). | A note is free text of any length (design 7.1); the list is sent whole on every change. | 34 (8.2.3) |
| D6 | `list` carries what the header and the dialogs need: `selected.note`, `selected.noteTooLong`, `selected.ticketUrl`; each pull request's `okAtNs`; each terminal's `openedNs` (2.2). | S2 12.5 shows "checked 4m ago", "last read 3h ago", "opened <time>"; the page decides no rule (S2 4.3). | 34 (8.2.3) |
| D7 | An edit shows within a second: after an action that wrote to the store, the server loads the rows again and pushes the lists at once (`ActionDeps.changed`, `Tick.reloadNow`), within the pages' once-a-second rule; it does not wait for the next refresh. | The tick reloads after a write only at its next refresh, up to two seconds later; a dialog that closed should not show the old text that long. | 36 (10.1) |
| D8 | `pr-add` answers as soon as the pull request is attached; its fetch (design 7.3: at once, the 10-second timeout) and `pr-refresh`'s explicit refresh run in the background on the server, ended by the server's stop, and the lists follow when they saved something. A failed fetch shows on the pull request's line as `can't read`, as `pr add` leaves it. | The dialog must not wait up to 10 seconds; design 7.3's outcome is the same. | 36 (12.5) |
| D9 | Refusals and conflicts are section 2.5's. An edit acts only on a session the store knows (`loadRows`; the id is whole, so nothing is resolved and no refresh runs first). Between two windows, label, group and done are last-write-wins, as two commands are; a note is refused by its `base`. | S2 12.5 names the note's conflict only; the rest is step 1's behaviour. | 36 (12.5) |
| D10 | A note saved in the window removes a note file that a failed editor kept (`<stateDir>/note-<id>.md`), as `note --set` does (design 7.1); `discardKeptNote` and the path rule move from `src/cli/notes.ts` to `src/sessions/meta.ts` so that the server can call them (`src/window/` never imports `src/cli/`). The dialog starts from the stored note, never from a kept file. | Otherwise the next `skydeck note` would open the old kept text over the window's note. Question 3 in section 7. | 36 (design 7.1) |
| D11 | Two parts of S2 12.5 that S2 19 names for no stage are built here, in the header they belong to: `pr-refresh` (S2 8.2.3) as a `↻` on the header's pull-request line, and "opened <time> · last active <age>" with where the title comes from. | They are the header's pull-request detail and facts; each is a few lines. | 38 (19) |
| D12 | From stage D the header's height depends on the session's content only, never on the window's width or a text's length: stage A's two lines, one line per open pull request, one line for the merged fold, `+ PR` and `↻`, and the note's first three lines when there is a note; every line is one line, cut with an ellipsis. The terminal under it is resized when that content changes (a pull request attached, a note edited), not when the user switches between sessions whose content stayed. | S2 12.5's content cannot fit stage A's one height; stage A's reasons (no jump between sessions, the size known before a terminal is shown, Z1's `area()`) hold for each session. Question 1 in section 7. | 38 (12.5) |
| D13 | A pull request's line in the header: a click opens it (`act open-link`, S2 9.6), × detaches it (`pr-rm`, no Undo: `+ PR` attaches it again); merged and closed ones fold into `30 merged, 2 closed ▸` (the mockup's words), unfolded with the same controls. Words per state: `can't read · last read 3h ago · <error>` (`never read` without one), `not fetched`, `checks failing`, `changes requested`, `checks pending`, `review required`, `draft`, `approved, green`, then `· checked 4m ago` once read. The pull request's title is the line's tooltip. | S2 12.5 shows one example of each kind; the rest follows the chip's order. | 38 (12.5) |
| D14 | The group chip with a ticket link opens the ticket on a click; a ✎ beside it edits the group (and `g` does); without a link the chip edits the group. | The user asked for the link; the chip stays the one place for the group. Question 4 in section 7. | this plan's pull request (12.5) |
| D15 | The Undo toast: the mockup's words (`Marked done: hidden from the list. It comes back on new activity.`, and for a running session `Marked done. Stays under Open while it runs; hidden once it stops.`), one at a time, 5 seconds (the mockup's 4.2, rounded up for the reach to Undo); Undo sends `undone`; like the page's other chrome it takes no keyboard on a click. `d` on a done row (shown with `a`) sends `undone` and shows no toast. The selection after a done follows S2 12.9 as written: the row that left the list is no longer selected. | S2 12.5 and 12.10 name the toast, not its words or time. Question 2 in section 7 proposes another selection rule. | — |
| D16 | `skydeck show` prints the ticket address as a `ticket:` line after `group:`; `show --json` is unchanged. | The lead proposed it; one line, no new interface. Question 5 in section 7. | this plan's pull request (7.5) |

## 2. Contracts

Every name below must exist with exactly this signature; stage A's contracts (its section 2) hold
where these do not change them.

### 2.1 Conventions

- Stage A's 2.1 holds: the import rules (D4 adds `CHIP_ORDER` to what `src/window/view/` may
  import), only `src/platform/real.ts` opens a socket or starts a program, foreign input is parsed
  by validators that never throw, times in messages are nanoseconds as decimal strings.
- Step 1's functions are called, never copied: `cleanLabel`, `cleanGroup`, `setLabel`, `setGroup`,
  `setNote`, `markDone`, `markUndone`, `attachManualPr`, `detachSessionPr`, `requirePrKey`,
  `fetchPrs`, `refreshPrs` (S2 12.5). A refusal carries step 1's message.
- Every text a user or a program wrote reaches the DOM as text: `textContent`, a field's `value`, a
  `title` tooltip — never `innerHTML`, never an element built from it, never an `href`.

### 2.2 Messages: `src/window/protocol.ts` (task 34)

```ts
// Stage D's additions. Stage A's types stay as they are but where shown.
export type ActMessage =
  | /* stage A's: resume, new, close-terminal, open-link */
  | { t: 'act'; id: number; kind: 'label' | 'group'; sessionId: string; text: string }
  | { t: 'act'; id: number; kind: 'note'; sessionId: string; text: string; base: string }
  | { t: 'act'; id: number; kind: 'done' | 'undone' | 'pr-refresh'; sessionId: string }
  | { t: 'act'; id: number; kind: 'pr-add' | 'pr-rm'; sessionId: string; url: string };

export interface PrPayload {
  url: string; repo: string; number: number; title: string | null; level: string; error: string | null;
  /** The last successful read (design 7.3), null before one. */
  okAtNs: NsText | null;
}
/** S2 12.3, made by windowChip (2.3). */
export interface ChipPayload {
  /** The open one that most needs the user, in design 7.3's order without merged and closed;
   *  with none open, `merged` when one is merged, else `closed`. */
  level: string;
  /** Attached and not known to be merged or closed: open, draft, never fetched, can't read. */
  open: number;
  merged: number;
}
// RowPayload.chip: ChipPayload | null   (stage A: { level, count } | null)
// TerminalPayload gains   openedNs: NsText   (when the window opened it; the header's "opened")
export interface SelectedPayload {
  /* stage A's: sessionId, command, flagsKnown, unknownFlags, ended, expiring, expired */
  /** The note exactly as stored — not sanitised: the page puts it only into a text box's value —
   *  when it holds at most 65,536 bytes of UTF-8; null when there is none or it is longer (D5). */
  note: string | null;
  noteTooLong: boolean;
  /** S2 12.5's ticket address (`ticketAddress`, 2.3), null without one. Task 34 sends null;
   *  task 36 fills it. */
  ticketUrl: string | null;
}
```

Limits `parsePageMessage` applies (stage A's rules for the rest): `label.text` and `group.text`
text (1,024 bytes); `note.text` and `note.base` 65,536 bytes each (D5); `pr-add.url` and
`pr-rm.url` the URL limit (4,096 bytes); `sessionId` passes `isSessionId`; every string well
formed. An unknown field, a missing one or another type is `{ ok: false, kind }`.

### 2.3 Server interfaces (tasks 34, 35, 36)

```ts
// src/window/view/chip.ts — task 34; pure
/** S2 12.3 over a row's attached pull requests (merged and closed included); null for none.
 *  Closed ones are not counted. */
export function windowChip(prs: readonly { level: string }[]): ChipPayload | null;

// src/sessions/ticket.ts — task 35; pure, imports nothing but types
/** S2 12.5's ticket link: `ticketUrl` with its one `{key}` replaced by the text `groupPattern`
 *  matches in `group`. Null when `ticketUrl` or `group` is null, nothing matches, the match is not
 *  /^[A-Za-z0-9][A-Za-z0-9._-]*$/, or the address would be over 2,048 characters (S2 9.6). */
export function ticketAddress(group: string | null, groupPattern: string, ticketUrl: string | null): string | null;

// src/platform/config.ts — task 35
// Config gains   ticketUrl: string | null   (DEFAULT_CONFIG: null), checked as S2 16.4 says.

// src/sessions/meta.ts — task 36; moved from src/cli/notes.ts, behaviour unchanged (D10)
export function keptNotePath(deck: Deck, sessionId: string): string; // <stateDir>/note-<id>.md
export function discardKeptNote(deck: Deck, sessionId: string): void;

// src/window/actions.ts — task 36: ActionDeps gains
  /** The store was written on the server's own connection: rows again and lists now (D7). */
  changed(): void;
  /** Reads these pull requests' status (design 7.3, fetchPrs) in the background; changed() when
   *  it saved something; the server's stop ends it. Never rejects. */
  fetchPrs(urls: readonly string[]): void;
  /** An explicit refresh of the session's pull requests (refreshPrs with force), likewise. */
  refreshPrs(sessionId: string): void;

// src/window/tick.ts — task 36: Tick gains
  /** D7: loadRows now and pages.pushList(); a failure is logged by kind and the reload is left to
   *  the next refresh (reloadOwed). */
  reloadNow(): void;
```

### 2.4 The page's modules (tasks 37, 38): changes to stage A's contract 2.9

```js
// web/keys.js — task 37. listKey gains:
//   { kind: 'edit', what: 'label' | 'group' | 'note' | 'pr' }   (`l` and F2, `g`, `n`, `p`)
//   { kind: 'done' }                                           (`d`: done, or undone for a done row)
// The `later` kind keeps only windowChord's stages B and E. cancels() is unchanged in rule.

// web/edit.js — task 37
/** @param {HTMLElement} root  #editor
 *  @param {{ act(action: Record<string, unknown> & { kind: string }): Promise<ResultMessage> }} deps */
export function createEditor(root, deps) {}
// → { open(what: 'label' | 'group' | 'note' | 'pr', row: RowPayload, selected: SelectedPayload | null): void,
//     escape(): void,     // app.js hands it Esc while shown (capture phase): D2's rule
//     close(): void,
//     shown(): boolean,
//     changed(): boolean } // holds text the user typed and did not save (D2's reload rule)

// web/toast.js — task 37
/** @param {HTMLElement} root  #toast */
export function createToast(root) {} // → { show(text: string, undo: (() => void) | null): void, hide(): void }

// web/cards.js — task 38; task 37 adds the parameter and the deps, unused until 38
// createCards(root, deps): deps gains
//   edit(what: 'label' | 'group' | 'note' | 'pr', sessionId: string): void,
//   done(sessionId: string): void,     // done, or undone for a done row; the toast is app.js's
//   say(text: string): void            // a line in the key bar (a refused pr-rm, open-link, pr-refresh)
// header(row: RowPayload | null, selected: SelectedPayload | null)
//   selected: list.selected when it is that row's session, else null
```

`web/app.js` (task 37) owns: the new list keys on the selected row (`no session selected` when
there is none); `edit`, `done` and `say` given to the cards; the dialog's modal rules of D2 (Esc to
`editor.escape()` in the capture phase, the chords, the reload guard); the toast after a done;
`overLimit`'s entries for the new kinds (label and group text 1,024 bytes, note text and base
65,536, URL 4,096), so that the page never sends what the server's parser refuses. `index.html`
gains `#editor` and `#toast` at the body's level, beside `#help`, and the stylesheet `edit.css`.

### 2.5 What the server refuses, and how the page shows it

The dialog shows a refusal under its field and keeps the text and the keyboard in the field; a
refusal of an action without a dialog (`d`, ×, ↻, a link) is a line in the key bar. Every line
passes the sanitiser before it is sent (stage A's `act`) and is shown as text.

| Case | The server answers | Where |
|---|---|---|
| A label or group design 7.1 refuses (a line break, a control character, a label starting with `-`) | `cleanLabel` / `cleanGroup`'s message, the same as `skydeck label` / `group` print | dialog |
| Empty or only white space | clears it (as the commands do) | — |
| The note changed since the dialog opened (another window, a command) | `the note was changed elsewhere while you edited it; your text is still in the box` (S2 12.5); nothing written | dialog |
| Two windows edit a label, group or done | the later write wins; every window's list follows (D7) | — |
| A session the store does not know (gone) | RefError's `no session matches '<id>'`, as `act resume` | dialog or key bar |
| A `new` session not started yet (A28's row) | `this session has not started yet; edit it once it runs` | dialog or key bar |
| A URL that is not a pull request | `requirePrKey`'s `not a GitHub pull-request URL: <text>` | dialog |
| `pr-rm` of one not attached | `detachSessionPr`'s `<url> is not attached to <short id>` | key bar |
| Over the limits of 2.2 | the page refuses before sending, with stage A's sentence (`the label is longer than skydeck takes: …`); a message that reaches the server anyway is `skydeck cannot do that action` | dialog |
| The store is busy | `skydeck's database is busy; try again` (stage A) | dialog or key bar |
| Not connected, or the connection lost while waiting | stage A's lines (`… the action may or may not have been done`) | dialog, text kept |

## 3. Tasks

### Task 34: Contracts and the window's chip

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 8.2.3 (the `act` kinds `label` to `pr-refresh`), 12.3, 12.5 (what the header needs) · **Contracts:** 2.2, 2.3 (`windowChip`) · **Decisions:** D4, D5, D6

**Goal.** Fix as code every message the other stage D tasks meet at, and build the one part whose
type change must reach the page in the same pull request: S2 12.3's chip, made by the view model
and drawn by the list. After this task the list shows the window's chip; nothing can be edited
yet.

**Files**
- Create: `src/window/view/chip.ts`
- Modify: `src/window/protocol.ts` (2.2); `src/window/view/sections.ts` (`rowPayload`: the chip from
  `windowChip`, each pull request's `okAtNs`); `src/window/view/build.ts` (each terminal's
  `openedNs`); `src/window/selected.ts` (`note`, `noteTooLong`; `ticketUrl` null);
  `src/window/actions.ts` (one case: every stage D kind answers `skydeck cannot do that action
  yet`, nothing done, until task 36); `web/list-text.js` (`chipText` of a `ChipPayload`, the row's
  chip with its merged part apart, the tooltip); `web/list.js`, `web/list.css` (the `+30` dim, a
  `3 merged` or `closed` chip dim, `can't read` dotted as before)
- Test: `test/window/protocol.test.ts`, `test/window/view/chip.test.ts`,
  `test/window/view/sections.test.ts`, `test/window/view/build.test.ts`,
  `test/window/selected.test.ts`, `test/window/actions.test.ts`, `test/web/list.test.ts`,
  `test-page/list.test.ts`, and the fixtures the type change breaks (`tsc` names them)

**Behaviour.** The parser takes the new kinds with 2.2's limits. `windowChip` is S2 12.3's rule
over the levels step 1 computes (`prLevel`): a level other than `merged` and `closed` is open.
`chipText`: `PR · failing`, `3 PRs · failing`, then ` +30` for the merged ones; with none open
`3 merged`, else `closed`. The tooltip lists each open one (`owner/repo #7 · failing`, `owner/repo
#9 · can't read · last read 3h ago`, `never read` without a last read), then `30 merged · 1
closed`. Stage A's header keeps showing `chipText`'s whole text until task 38 replaces it with the
pull-request lines.

**Tests** (platform: `testPlatform`; the page case `realTestPlatform`)
- Protocol: each new kind accepted at its limits and refused one byte over (label text 1,025
  bytes, note text or base 65,537, URL 4,097), with an unknown or a missing field (a note without
  `base`), a session id that is not one, a lone surrogate; a note `act` at both limits made of
  U+0001 (six bytes each in JSON) is under `MAX_MESSAGE` as JSON.
- `windowChip`: every row of S2 12.3's table; none attached → null; only never-fetched ones; a
  can't-read one with merged ones.
- `rowPayload`: the chip and `okAtNs`; the list's terminals carry `openedNs`.
- `selectedPayload`: the note exactly as stored (an escape character and CRLF kept); null without
  one; a note of 65,536 bytes of UTF-8 sent, one of 65,537 (a multi-byte character across the
  limit) null with `noteTooLong`; `ticketUrl` null.
- Actions: a `label` act answers `ok: false` with `skydeck cannot do that action yet` and writes
  nothing.
- `list.test.ts` (node): `chipText` and the tooltip for every row of the table; a repository or an
  error with an escape sequence is shown sanitised. Page: a row with one open failing pull request
  and 30 merged shows `PR · failing` and a dim `+30`.

**Done when:** every stage D message parses as 2.2 says; the list shows S2 12.3's chip; `npm run
check` passes.

**Not in it:** acting on an edit (36), editing in the page (37, 38), the ticket address (35, 36).

---

### Task 35: The ticket address: `ticketUrl`, `ticketAddress`, `show`

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 12.5 ("The ticket link"), 16.4 (`ticketUrl`), design 7.5 (`show`), 9.1 · **Contracts:** 2.3 (`ticketAddress`, `Config.ticketUrl`) · **Decisions:** D16

**Goal.** The configuration key the user asked for, the one pure rule that turns a group into a
ticket's address, and `show`'s line. The window's chip uses it from task 36 on (the server) and
38 (the page).

**Files**
- Create: `src/sessions/ticket.ts`
- Modify: `src/platform/config.ts`; `src/cli/output.ts` (`formatShow` gains a last parameter
  `ticket: string | null = null`); `src/cli/commands/show.ts`
- Test: `test/platform/config.test.ts`, `test/sessions/ticket.test.ts`,
  `test/cli/commands/show.test.ts`

**Behaviour.** The check of S2 16.4: `ticketUrl` is null or a string with no character the
sanitiser would change, no white space, no `"` and no backslash; with `{key}` exactly once, after
the host (between `://` and `{key}` there is a `/`, a `?` or a `#`); that with a key put in parses
(WHATWG) as an `http:` or `https:` URL of at most 2,048 characters. Anything else is the one
message `<file>: "ticketUrl" must be null or an http or https address with {key} once, after its
host`. `ticketAddress` as 2.3 says. `show` prints `ticket: <address>` after `group:` when there is
one; `--json` is unchanged (D16).

**Tests** (platform: `testPlatform`)
- Accepted: null; `https://example.atlassian.net/browse/{key}`; `http://host:8080/t?id={key}`;
  `https://host/#/{key}`. Refused with the message: a number; `javascript:{key}`; `file:///{key}`;
  `ftp://host/{key}`; no `{key}`; two; `https://{key}.example.net/`; `https://user@{key}/`;
  `https://host{key}/`; a `"`, a backslash, a space, a tab, an escape character; 2,049 characters.
- `ticketAddress`: the default pattern on the group of a title `ABC-12 fix` → `…/browse/ABC-12`; a
  group set by the user `ABC-12` and `ABC-12 cleanup`; no match, `ticketUrl` null, `group` null →
  null. With the pattern `^\S+` a group of each of `evil.com/x`, `a?b=1`, `a#b`, `u@h`, `a:b`,
  `..`, `.x`, `-x`, `%2e%2e`, `ÄBC-1` → null. Every address it gives passes stage A's `linkToOpen`
  unchanged (the test imports it); one over 2,048 characters → null.
- `show`: with `ticketUrl` set and a ticket-key group the `ticket:` line; without either, none.

**Done when:** a wrong `ticketUrl` fails every command with that one line (exit 1), as every key
of the file; `show` prints the line.

**Not in it:** `selected.ticketUrl` (36); the chip's link (38); `docs/install.md` (39).

---

### Task 36: Editing on the server

**Depends on:** 34, 35 · **Wave:** 2 · **Design:** S2 8.2.3 (the `act` kinds), 10.1, 12.5 (editing), 12.10, design 7.1, 7.3 · **Contracts:** 2.2, 2.3, 2.5 · **Decisions:** D7, D8, D9, D10

**Goal.** Every stage D `act` does what S2 12.5 says, through step 1's functions, refuses what 2.5
lists, and shows in every window within a second.

**Files**
- Modify: `src/window/actions.ts` (the cases, replacing task 34's interim one);
  `src/window/server.ts` (the three new `ActionDeps`: `changed` → `tick.reloadNow()`; `fetchPrs`
  and `refreshPrs` → github.ts's functions with the platform's runner, clock and environment, the
  store, and the server's stop signal, then `changed()` when something was fetched or failed; the
  server's stop waits for them as it waits for the tick's fetch); `src/window/tick.ts`
  (`reloadNow`); `src/window/selected.ts` (`ticketUrl` from `ticketAddress(row.group,
  config.groupPattern, config.ticketUrl)`); `src/sessions/meta.ts` (`keptNotePath`,
  `discardKeptNote`); `src/cli/notes.ts` (imports them; nothing else changes)
- Create: `test/helpers/gh.ts` (a runner that answers `gh` with a canned `gh api graphql` answer
  of the test's choice and passes every other command to the runner it wraps; never a real `gh`),
  `test/window/server-edits.test.ts`
- Test: `test/window/actions.test.ts`, `test/window/tick.test.ts`, `test/window/selected.test.ts`

**Behaviour.** Common to all: stage A's check of the action again; the session is a row of
`loadRows(deck)`, else a `new` terminal of the hub waits for it (the not-started refusal), else
RefError. After every write `deps.changed()`; the result is `ok` with no lines (a `pr-add`:
`attached <url>`). `label`: `text.trim() === '' ? null : cleanLabel(text)`, then `setLabel` — the
expression of `skydeck label`; `group` likewise with `cleanGroup` and `setGroup`. `note`: in one
store transaction the stored note (`''` for none) is compared with `base` — different, the
refusal of 2.5 and no write; equal, `setNote(text)` (empty or white space clears) — and after the
commit `discardKeptNote` (D10). `done`, `undone`: `markDone`, `markUndone`. `pr-add`:
`attachManualPr` (origin `manual`; an earlier detach cleared), `changed()`, then
`deps.fetchPrs([key.url])` (D8). `pr-rm`: `detachSessionPr`. `pr-refresh`:
`deps.refreshPrs(sessionId)`, `ok` at once.

**Tests** (platform: `testPlatform` through `testDeck` for the actions and the tick;
`realTestPlatform` through `startTestServer` for `server-edits.test.ts`)
- For every refusal of design 7.1 (a line break, a control character, a label starting with `-`, a
  group with a tab) the window's message is exactly what `skydeck label` / `group` print for the
  same text (the test runs the command on the same deck), and nothing is written; an empty and a
  white-space text clear; the stored label is the trimmed text.
- Note: `base` equal → stored exactly as typed (CRLF, trailing spaces, 65,536 bytes); empty →
  none; the stored note changed between the dialog's start and the save (`setNote` in between) →
  2.5's message, the stored note unchanged; `base` `''` with no note → saved; a kept note file is
  removed after a save and stays after a refused one.
- `done` and `undone` set and clear the done time; `pr-add` of a URL that is not a pull request →
  `requirePrKey`'s message, nothing attached; of one → attached `manual`, an earlier detach gone,
  `fetchPrs` called once with its key URL, the answer given before the fetch ends; `pr-rm` of one
  not attached → its message; `pr-refresh` → `refreshPrs` with the id.
- An unknown session id → RefError's message; the id of a `new` terminal's session that has not
  started → the not-started message. Every write calls `changed()` once; a refusal never.
- `reloadNow`: the rows are loaded and the lists pushed at once; a busy store → one log line by
  kind, the rows loaded at the next refresh.
- `server-edits.test.ts`, two pages: a label set from page A is in page B's `list` within 1.5 s and
  in the store; a note saved from A, then from B with the old `base` → B refused with 2.5's
  message, the store holds A's; `pr-add` with `test/helpers/gh.ts` answering open, approved, checks
  passing → a list with the pull request `unfetched`, then one with `approved-green` and its
  `okAtNs`; the server stopped while a fetch waits → the stop does not wait the 10 seconds; a running
  session marked `done` stays in Open with its `done` mark; with `ticketUrl` in the sandbox's
  configuration and a label `ABC-12 try`, `selected.ticketUrl` is the address; a label holding an
  escape sequence → a refusal whose lines hold no control character.

**Done when:** every stage D `act` kind does what S2 12.5 says through step 1's functions; the
refusals are 2.5's; an edit shows in every window within a second; `npm run check` passes.

**Not in it:** the page (37, 38).

---

### Task 37: The editors, the Undo toast and the list keys

**Depends on:** 34 · **Wave:** 2 · **Design:** S2 12.5 (editing), 12.9 (`l`, `g`, `n`, `p`, `d`, F2; the focus rules), 12.10 (the toast) · **Contracts:** 2.4, 2.5 · **Decisions:** D1, D2, D3, D15

**Goal.** From the list, every stage D key does its action: the dialogs of D1, the Undo toast,
and the key help without the stage D keys marked as coming later. The header's controls come
with task 38 and call the same dialogs.

**Files**
- Create: `web/edit.js`, `web/edit.css`, `web/toast.js`
- Modify: `web/app.js`, `web/keys.js`, `web/help.js` (the stage D lines: `l` and F2 label, `g`
  group, `n` note, `p` attach a pull request, `d` done or undone), `web/index.html` (`#editor`,
  `#toast`, `edit.css`), `web/cards.js` (only `header`'s second parameter and the three deps of
  2.4, unused)
- Test: `test/web/keys.test.ts` (the stage D cases), `test-page/shell.test.ts` (the one case that
  pinned `<key>: comes in a later stage` for these six keys), `test-page/edit.test.ts` (new) with a
  new helper in `test-page/helpers/shell.ts`, `editWorld` — a scripted stand-in, as `actsWorld`,
  that answers each `act` as the test says and sends the lists it is given

**Behaviour.** The dialogs as D1–D3: the heading `Label — <title>`, `Group — <title>`, `Note —
<title>`, `Attach a pull request — <title>`; the mockup's help lines (`Shown as the title, and
passed to Claude Code as the session name on the next start or resume. Empty clears it.`, `Empty:
the ticket key at the start of the title is used.`, `Ctrl+Enter saves. Plain text, kept on this
machine.`, `Pull requests a session touched are attached by themselves.`). Save sends the `act`
and is disabled while it waits; `ok` closes the dialog; a refusal stays in it (2.5). The modal
rules and the reload guard of D2; the toast of D15 after a done from the list, Undo sending
`undone`.

**Tests** (platform: `realTestPlatform` for the page; the scripted stand-in through `editWorld`)
- `keys.test.ts`: `l`, F2, `g`, `n`, `p`, `d` give 2.4's kinds; with Ctrl, Alt or Meta, nothing;
  `cancels` true for them in the list zone; `later` only for Ctrl+Shift+J and Ctrl+Shift+P.
- `edit.test.ts`: `l` on the selected row opens the label dialog with its label, the keyboard in
  the field; Enter sends `act label` with the text; `ok` closes, the keyboard back on the list; a
  refusal (`a label cannot start with '-' …`) shows under the field, the text and the keyboard
  stay. `g`'s field empty for a group taken from the title, filled for one the user set. `n`:
  the note in the box, Enter a line break, Ctrl+Enter sends `act note` whose `base` is the listed
  note; a `list` with another note arriving meanwhile changes neither the box nor `base`; 2.5's
  conflict message keeps the text; a note of 65,537 bytes typed → refused in the dialog, nothing
  sent; `noteTooLong` → no Save and D5's sentence. `p` sends `pr-add` with the URL. Esc on an
  unchanged dialog closes it; on a changed note the first Esc says `Esc again discards your text`,
  the second closes. F5 with changed text says `save or cancel the edit first` and does not
  reload; unchanged, it reloads after the server's proof, as stage A's case. The connection lost
  while saving → stage A's line in the dialog, the text kept. While the dialog is shown,
  Ctrl+Shift+1 and Ctrl+Shift+L say `close the edit first (Esc)` and change nothing, Ctrl+Shift+H
  shows the help, a click on the scrim does nothing. A held Enter saves once. A title `<img
  src=x onerror=…>` in the heading is text. `d` sends `done`; the toast shows D15's words; Undo
  sends `undone`; `d` on a done row sends `undone` and no toast.
- `shell.test.ts`: the six keys are cancelled in the list zone; with no row selected the key bar
  says `no session selected`.

**Done when:** from the list, `l`, F2, `g`, `n`, `p` and `d` do their actions through the server's
answer; no text the user typed is lost by one key; `npm run check` passes.

**Not in it:** the header's controls (38); the server's rules (36).

---

### Task 38: The header: pull-request lines, the note, the controls

**Depends on:** 36, 37 · **Wave:** 3 · **Design:** S2 9.6 (pull-request and ticket links), 12.3 (the tooltip), 12.5 (all of it, the ticket link included), 12.10 · **Contracts:** 2.4 (`cards.js`), 2.5 · **Decisions:** D11, D12, D13, D14, D15

**Goal.** Replace stage A's read-only header with S2 12.5's: every fact, every pull request on a
line, the note's first lines, and the controls that open task 37's dialogs, detach, refresh, open
links, the ticket and mark done.

**Files**
- Create: `web/header-text.js` (no DOM: a pull request's line, the fold's text, "opened <time> ·
  last active <age>", the title's source in words), `test/web/header-text.test.ts`,
  `test-page/header.test.ts`
- Modify: `web/cards.js` (the header), `web/cards.css`, `test-page/cards.test.ts` (its height case
  becomes D12's rule)

**Behaviour.** The lines of D12. The title: a click opens the label dialog (`deps.edit`). The
group chip: dashed `+ group` without one; its tooltip says `(from the title)` when it is; with
`selected.ticketUrl` a click sends `act open-link` with that address, the tooltip is the address
and a ✎ beside it opens the group dialog; without one a click opens the dialog (D14). The state
pill, the directory and the short id as stage A's. `opened <time>` for a terminal of the window
(its `openedNs`), `last active <age>`, and where the title comes from (`title: your label`,
`Claude Code's name`, `Claude Code's summary`, `start time and folder`). Each open pull request
on its line (D13), its click and ×; the fold; `+ PR` (the dialog); `↻` (`pr-refresh`, tooltip
`read the status of this session's pull requests now`). The note's first three lines
(`noteHead`), a click opens the note dialog. The buttons Note and Done / Undone (`deps.done`, the
toast of D15). A refused action without a dialog says its line through `deps.say`. No control
takes the keyboard on a click (its mousedown's default is prevented, as the short id's copy), so
that the terminal or the list keeps it; a dialog that opens takes it.

**Tests** (platform: `realTestPlatform`; a test server with sessions made by step 1's helpers,
pull requests attached with `attachManualPr` and their status saved with `savePrResult`, notes
with `setNote`; `+ PR` and `↻` through `test/helpers/gh.ts`; links seen by the Edge stub)
- `header-text.test.ts`: the words of every level, with and without a last read and an error;
  `30 merged`, `30 merged, 2 closed`, `1 closed`; ages; a repository or an error with an escape
  sequence sanitised.
- `header.test.ts`: lines for no, one and three open pull requests and with merged ones; the fold
  opens and closes; a line's click → the stub got its URL; × → detached in the store, the line
  gone; `+ PR` → the dialog; a URL → attached, its line `not fetched`, then the stand-in's state;
  `↻` → `gh` asked again. The title's click → the label dialog → saved → the new title in the
  header and the list (end to end through task 36). With `ticketUrl` in the configuration: the
  chip's click → the stub got the address; ✎ → the group dialog; a group whose match holds `/` or
  `?` (pattern `^\S+`) → no link, a click edits; without `ticketUrl` a click edits. The note's
  first three lines shown sanitised, a click → the dialog with the whole note. Done → the row
  done, the toast, Undo → undone; a running session's Done → it stays under Open, marked `done`.
  A hostile title, note line, pull request's title and error appear as text and create no
  element. A click on any control leaves the keyboard where it was.
- `cards.test.ts`, height: the same content at 1280 and at 900 px and with a directory of 340
  characters → the same height; one more open pull request → one line more; a pull request
  attached while its terminal is shown → the terminal is resized once and not again.

**Done when:** every element of S2 12.5 is in the header and does its action; the ticket link
opens only what S2 12.5 allows; `npm run check` passes.

**Not in it:** attention in the state pill (stage B); the header and the ended bar of a session the
filter hides (section 5).

---

### Task 39: Documentation of stage D

**Depends on:** all · **Wave:** 4 · **Design:** S2 12.5, 16.4, 18, 19 · **Contracts:** — · **Decisions:** —

**Goal.** A user can edit in the window and set the ticket link from the documents alone, and
knows which checks only they can make.

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (S2 18
  gains W27–W29 below, S2 19's stage D line names them)

**Content (contract)**
- `docs/install.md`: in "Using the window", editing: the keys `l` (F2), `g`, `n`, `p`, `d`, the
  header's controls, the dialogs (Enter, Ctrl+Enter, Esc twice for a changed note), the Undo
  toast, the pull-request lines and the window's chip; the configuration table's `ticketUrl` row
  with an example (`"https://example.atlassian.net/browse/{key}"`), its refusal line, that the
  server reads it when it starts (`skydeck window --restart`), and `show`'s `ticket:` line;
  "Known limits of stage D": a CR line break comes back as LF (D3); a note over 64 KiB is edited
  with `skydeck note` only (D5); label, group and done are last-write-wins between two windows
  (D9); the Undo toast takes a click; a session the filter hides has no header and so no editing
  (section 5); text in a dialog is lost when the page reloads for a new build.
- `README.md`: one sentence in the window's paragraph — label, group, note, pull requests and the
  ticket link in the window.
- `docs/manual-checks.md`: a part "The window (step 2, stage D)" with W27–W29, each with what to
  set up, what to type, what to look at and what to write down. Every step uses the throwaway
  session of stage A's part ("A throwaway session in the window"), never a real work session.
  W27 first copies `config.json` when it exists (`cp ~/.config/skydeck/config.json
  ~/.config/skydeck/config.json.before-w27`) and ends by putting the copy back or removing the key
  (and `skydeck window --restart`); it says that a mistake in the file makes every command name the
  key and exit 1, and nothing else. W28 attaches a pull request of the user's own and detaches it
  at the end. No step marks a real session done, edits a real note or closes a window.

| # | Check | Stage | Decides |
|---|---|---|---|
| W27 | With `ticketUrl` set to the user's ticket system's address and the throwaway session labelled with one of their ticket keys, a click on the group chip opens that ticket in their main Edge window, logged in; without `ticketUrl` the chip has no link. | D | 12.5, 9.6 |
| W28 | `+ PR` with a pull request of the user's own on the throwaway session: its line shows its state within seconds (their `gh` login), the list's chip agrees, `skydeck show` agrees; × detaches it. | D | 12.3, 12.5 |
| W29 | On the user's layouts (US, Czech): `l`, F2, `g`, `n`, `p` and `d` in the list; Enter saves a label, Ctrl+Enter a note, Esc twice discards a changed note; Undo in the toast brings the session back; `skydeck ls` in a WSL terminal shows the same label, group and note. | D | 12.5, 12.9 |

**Steps**
- [ ] Run every command of the new install text on a clean `SKYDECK_HOME` (`show` with and without
      `ticketUrl`) to check it is exact.
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage D from `docs/install.md` alone, and W27–W29 are in
`docs/manual-checks.md` and S2 18.

## 4. Design coverage

| Design | Where |
|---|---|
| S2 8.2.3, the `act` kinds `label`, `group`, `note`, `done`, `undone`, `pr-add`, `pr-rm`, `pr-refresh` | 34 (types, limits), 36 (acting), 37 and 38 (sending) |
| S2 9.6, pull-request and ticket links | 38, through stage A's `open-link` and its check |
| S2 10.1, the reload after a write | 36 (D7) |
| S2 12.3, the window's chip | 34 |
| S2 12.5, the header and editing | 36 (rules), 37 (dialogs), 38 (header); the ticket link 35, 36, 38 |
| S2 12.9, `l`, `g`, `n`, `p`, `d`, F2 and the key help | 37 |
| S2 12.10, the Undo toast | 37, 38 |
| S2 16.4, `ticketUrl` | 35 |
| S2 18, W27–W29 | 39 |
| Design 7.1, label, group, note, done | 36 (step 1's functions; D10) |
| Design 7.3, `pr add`, `pr rm`, the explicit refresh | 36 |
| Design 7.5, `show` | 35 |

## 5. What stage D leaves for stages B, C and E

Stage D works without B, C and E and touches their files only where its own lines are. In
`src/window/protocol.ts` it adds `act` kinds and fields and leaves `attention`, `notify`,
`banner`, `stack`, the `restore` and `dismiss-restore` kinds and `view.chips` as stage A has them;
in `src/window/actions.ts` it adds its cases beside stage A's, where C adds `restore` and
`dismiss-restore`; in `web/keys.js` it removes only stage D's `later`, so Ctrl+Shift+J (B) and
Ctrl+Shift+P (E) still say they come later; in `web/app.js` it adds the dialog, the toast and the
new list keys, and the dialog's modal rule (D2) holds for whatever chords B and E bring; in the
header it leaves the state pill as it is, where B's attention will show; in the list it changes
only the chip, where B adds attention and E stacks and chips; in `src/window/tick.ts` it adds only
`reloadNow`, beside which B reads turn ends. No migration, no new store key.

**Two follow-ups on stage D's path** (`LEFT-TO-YOU.md` 3g and 4):
- *The chip that counts merged pull requests* — **settled** by task 34 for the window: S2 12.3
  counts the open ones and shows the merged ones only as a dim `+30`. `ls` and the interactive
  list keep design 7.3's chip, as S2 12.3 says.
- *The ended bar of a session the filter hides* — **left**. Its cause is that `list` carries no row
  for a selected session the filter hides; the header has the same gap, so stage D offers no
  editing for such a session (clear the filter first; task 39 names it). The fix changes what the
  filter's view model sends, which stage E (search) rebuilds anyway; doing it here would change
  stage A's contract for one case and again in E.

## 6. Stage D is ready to try

When task 39 is merged. In a WSL terminal of your own (not a `!` command inside Claude Code):

```sh
cd ~/projects/mine/skydeck
git pull
skydeck window          # restarts the window's server for the new build; your sessions keep
                        # running, the window reloads itself
```

No `npm ci`, no `install` again. The ticket link, if you want it: add one key to
`~/.config/skydeck/config.json` (create the file if it does not exist: `{ }` with the key in it),
your ticket system's address with `{key}` where the key goes, for Jira
`"ticketUrl": "https://<your site>.atlassian.net/browse/{key}"`; then `skydeck window --restart`
(the server reads the configuration when it starts) and `skydeck show <ref>` prints the `ticket:`
line. A mistake in the file makes every command say which key, and nothing else.

**What only you can check** (task 39's W27–W29, with the throwaway session):

- W27 — the group chip opens your ticket in your own Edge window, logged in.
- W28 — `+ PR` with one of your pull requests shows its state within seconds, through your `gh`.
- W29 — the keys `l`, F2, `g`, `n`, `p`, `d` on your US and Czech layouts; Ctrl+Enter in the note;
  Undo.
- And your judgement on two choices of section 7: the header that grows with its content
  (question 1), and the selection after `d` (question 2).

## 7. Questions for the lead

Planned around the reading given; each is the lead's or the user's to change.

1. **The header's height** (D12). S2 12.5 says that stage A's header has one height, so that the
   terminal does not jump between sessions; its own content for stage D (a line per open pull
   request, three note lines) cannot fit one height. Planned: the height follows the session's
   content only; the terminal is resized when that content changes. The other way would be a fixed
   number of lines with `+n more`, which hides pull requests behind a click.
2. **The selection after `d`.** S2 12.9 (ruled for task 27): when the selected row leaves the
   list, no row is selected. Planned as written. Marking several old sessions done in a row would
   then need ↓ before each `d`; the step 1 list moves to the row that takes the place (design
   7.4). Proposed: after the page's own `d`, select that row — a design change of 12.9.
3. **A kept note file** (D10). A note saved in the window removes the file a failed editor kept,
   as `note --set` does, so that the next `skydeck note` does not open old text over the window's
   note. That file holds text that was never stored; the alternative keeps it and lets
   `skydeck note` say so as it does today.
4. **The ticket chip** (D14, the user's to decide). Planned: a click opens the ticket, the ✎
   beside it edits the group. The other way: the chip always edits and a separate `↗` opens the
   ticket.
5. **`show --json`** (D16): planned unchanged; `ticketUrl` could be added to it as one field.
6. **Not named for any stage** (D11): `pr-refresh` and "opened · last active" with the title's
   source are built in task 38. Say if they should wait.
