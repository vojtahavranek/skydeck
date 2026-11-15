# skydeck step 2, stage D — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stage D of step 2 as specified in [`docs/design-step-2.md`](../design-step-2.md)
(section 19): label, group, note, done and undone, attaching and detaching pull requests, in the
window, with the Undo toast; the window's pull-request chip (S2 12.3) and the header's
pull-request and note lines (S2 12.5); the list keys `l`, `g`, `n`, `p`, `d` and F2; and the
ticket link of the group chip that the user asked for on 2026-11-15 (S2 12.5, 16.4). It works
without stages B, C and E.

**Architecture:** Every edit is an `act` of the page (S2 8.2.3) that the server carries out with
step 1's own rules and functions (`cleanLabel`, `setNote`, `attachManualPr`, …), never copies of
them; the server then loads the rows again and sends the lists, so that every window shows the
change. The page edits in dialogs of its own (the mockup's) that lie over the page, keeps the
header at one height, shows what the server sends, and decides no rule: the chip is a pure
function of the view model, the ticket address is built on the server from the configuration.

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
the recording Edge stub of every test server (A32), which is how a test sees them. No task runs
`bin/skydeck` outside the test suite (task 39 included).

**Known flakes** (not stage D's to fix): `test-page/terminal.test.ts` "input-full (the program
stalled, a large paste)" under load; `test/platform/real.test.ts:1005` (the wall clock) and its
case "a streamed answer that keeps coming…"; `test/standin/standin.test.ts`, records in the wrong
order now and then; `test/window/mapping.test.ts:623`, ENOTEMPTY at the sandbox's clean-up. A run
that fails only with one of them is run once more, and the pull request names both runs.

## 1. Tasks and waves

Task 0 is `main` at 9c5cbfb (stage A complete) with this plan merged.

| # | Task | Depends on | Wave | Size (code + tests) |
|---|---|---|---|---|
| 34 | Contracts and the window's chip | 0 | 1 | ~600 |
| 35 | The ticket address: `ticketUrl`, `ticketAddress`, `show` | 0 | 1 | ~400 |
| 36 | Editing on the server | 34, 35 | 2 | ~800 |
| 37 | The dialogs, the Undo toast and the list keys | 34 | 2 | ~850 |
| 38 | The header and the pull-request dialog's list | 36, 37 | 3 | ~700 |
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

**Every file each task creates or modifies.** Each task's own **Files** list below is exactly
this row; stages B and C run tasks beside these where the files are disjoint, so a file not in a
task's row is not that task's to touch.

| Task | Creates | Modifies |
|---|---|---|
| 34 | `src/window/view/chip.ts`, `test/window/view/chip.test.ts` | `src/window/protocol.ts`, `src/window/view/sections.ts`, `src/window/view/build.ts`, `src/window/selected.ts`, `src/window/actions.ts`, `web/list-text.js`, `web/list.js`, `web/list.css`, `web/format.js`; `test/window/protocol.test.ts`, `test/window/view/sections.test.ts`, `test/window/view/build.test.ts`, `test/window/selected.test.ts`, `test/window/actions.test.ts`, `test/helpers/pages.ts`, `test/web/list.test.ts`, `test/web/pane.test.ts`, `test/web/format.test.ts`, `test-page/list.test.ts`, `test-page/cards.test.ts`, `test-page/helpers/shell.ts`; `docs/design-step-2.md` (4.3, 8.2.3) |
| 35 | `src/sessions/ticket.ts`, `src/text/link.ts`, `test/sessions/ticket.test.ts` | `src/platform/config.ts`, `src/window/windows.ts`, `src/cli/output.ts`, `src/cli/commands/show.ts`; `test/platform/config.test.ts`, `test/cli/output.test.ts`, `test/cli/commands/show.test.ts` |
| 36 | `src/window/pr-fetches.ts`, `test/window/pr-fetches.test.ts`, `test/helpers/gh.ts`, `test/window/server-edits.test.ts` | `src/window/actions.ts`, `src/window/server.ts`, `src/window/tick.ts`, `src/window/selected.ts`, `src/sessions/meta.ts`, `src/cli/notes.ts` (it imports the two moved functions and re-exports `discardKeptNote`, so that `src/cli/commands/note.ts` is unchanged); `test/window/actions.test.ts`, `test/window/tick.test.ts`, `test/window/selected.test.ts`, `test/sessions/meta.test.ts`; `docs/design-step-2.md` (10.1; 12.5's paragraph "Editing (stage D)") |
| 37 | `web/edit.js`, `web/edit.css`, `web/toast.js`, `test-page/edit.test.ts`, `test-page/fixtures/recording-cards.js` | `web/app.js`, `web/keys.js`, `web/help.js`, `web/index.html`, `web/cards.js` (only `header`'s new parameters and the three deps of 2.4, unused); `test/web/keys.test.ts`, `test-page/shell.test.ts`, `test-page/helpers/shell.ts`; `docs/design-step-2.md` (12.9) |
| 38 | `web/header-text.js`, `test/web/header-text.test.ts`, `test-page/header.test.ts` | `web/cards.js`, `web/cards.css`, `web/edit.js` (the pull-request dialog's list), `web/edit.css`; `test-page/cards.test.ts`, `test-page/real-modules.test.ts` (only if a case's numbers move with the taller header); `docs/design-step-2.md` (19) |
| 39 | — | `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (18, 19) |

The files of 34's type change were found by applying 2.2's types and running both type checks:
every test file in its row is one `tsc` names, one whose case reads the chip's old shape at run
time (`test-page/cards.test.ts`), or one whose case pins the view's files and imports
(`test/window/view/build.test.ts`). Files more than one task edits, never two of one wave:
`src/window/selected.ts`, `src/window/actions.ts` and their tests (34, 36);
`test-page/helpers/shell.ts` (34, 37); `test-page/cards.test.ts` (34, 38); `web/cards.js`,
`web/edit.js`, `web/edit.css` (37, 38).

**The design, section by section.** Each task records its own decisions (1a) in its own pull
request: 34 writes S2 4.3 and 8.2.3; 36 writes S2 10.1 and the paragraph "Editing (stage D)" of
S2 12.5; 37 writes S2 12.9 (the dialogs' focus rule, beside the exception this plan's pull request
added); 38 writes S2 19; 39 writes S2 18 and 19. No two tasks of one wave write the same section
(review B found 36 and 37 both in S2 12.5 at 1f9e85c; 37 now writes only S2 12.9). Should a
conflict come anyway, the second to merge rebases and keeps both edits.

**The shared test files**, for scheduling stages B and C beside these tasks:
- `test-page/helpers/shell.ts` — 34 adds fields inside two existing fixtures (`scriptedList`'s
  terminals gain `openedNs`; `actsWorld`'s `selected` gains `note`, `noteTooLong`, `ticketUrl`);
  37 adds one new function, `editWorld`, at the end; nothing else changes.
- `test/helpers/pages.ts` — 34 adds `openedNs` to `defaultList`'s terminals; nothing else.
- `test-page/cards.test.ts` — 34 changes the chip fixtures inside existing cases (`count` becomes
  `open` and `merged`); 38 changes the existing cases that pinned stage A's header (the chip's
  place, the height) and adds no case (its cases are in `test-page/header.test.ts`).
- `test-page/real-modules.test.ts` — 38 only, and only if a case's numbers move with the taller
  header (its cases compare the size an act asks for with the size shown, so they should hold);
  no new case.
- Also: `test-page/shell.test.ts` — 37 changes one existing case (the six stage D keys);
  `test/web/pane.test.ts` and `test-page/list.test.ts` — 34 adds the new fields to their fixtures.

## 1a. Decisions this plan makes where the design is silent

Binding for the implementer, as stage A's A1–A38. The last column names the task that records the
decision in the design in its own pull request; `—` means it is an implementation detail or the
design already says it (this plan's pull request changed S2 12.5, 12.9, 16.4 and 19 by the
lead's rulings of 2026-11-15).

| # | Decision | Why | Design update |
|---|---|---|---|
| D1 | Label, group, note and the pull requests are edited in dialogs over the page (`web/edit.js`), as the mockup shows: a heading that names the session, the field (a text box for the note), a line of help, Cancel and Save — in the pull-request dialog Close and Attach, since Attach keeps it open and nothing is left to cancel (ruled on task 37's review 1; Esc closes it as every dialog). | The mockup the user approved (S2 12) has these dialogs; the header keeps one height (D12), so nothing is edited inside it. | — (S2 12.5) |
| D2 | A dialog is modal. A scrim covers the window and takes clicks without acting. While a dialog is shown, `app.js` moves the keyboard nowhere — no `setZone`, `giveKeyboard`, `keepKeyboard` or `terminalView.focus` for a result, a `list` or a render — and acts on no list key; every window chord but Ctrl+Shift+H says `close the edit first (Esc)` and does nothing else (Ctrl+Shift+V in a field stays the browser's paste, Z1). The dialog tells `app.js` when it closes, whatever closed it (`deps.closed()`, 2.4); then a terminal that this page's resume or new brought meanwhile takes the keyboard (`state.bringing` is kept until then), else the zone's holder gets it (`giveKeyboard`), without waiting for a `list`. The key that opened a dialog types nothing into it while it is held, and a click inside the dialog that selects no text gives the keyboard back to its field (both ruled on task 37's review 1); whenever nothing has the keyboard while a dialog is shown (a disabled Save, a click on the key help or the toast), the next key gives it back to the field first, and the auto-repeats of a key pressed in a dialog act on nothing once it is gone — a held Enter that closes a dialog over the list resumes nothing (task 37's review 2). An Enter or Esc of an IME composition is the IME's. After this page's own `ok` of a label, group or note, `l` / F2, `g`, `n` on that session wait for the list that holds the result — one that arrived since the act was sent, else the next one (named limit: a list pushed just before the server read the act counts as holding it) —, saying `the label is not here yet; press l again` (from the header's controls too); the pull-request dialog does not wait. A refusal whose dialog was closed meanwhile is the toast `not saved: <the error>` (`deps.toast`, no Undo). While `editor.changed()`, a `beforeunload` asks before the page goes (the tab's reload, closing the window, connection.js's reload for another build); named limits in S2 12.9: text typed between an unchanged F5 and the proof, and that reload, which only the prompt holds back (C1, C2, C4 of task 37's review 2, ruled). After an `ok` that no list followed, the page sends a `view`, which the server answers with a list at once (it sends no list equal to the last one, so a save that changed nothing shown would wait for good; review 2's re-check, M2). Enter saves (Ctrl+Enter in the note, where Enter is a line break); Esc and Cancel close, except that a note whose text was changed needs a second Esc (`Esc again discards your text`); the reload keys (F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R, BrowserRefresh) while it holds changed text say `save or cancel the edit first` and do not reload. | An edit belongs to the session it was opened for; review A showed a resume's result taking the keyboard out of the note's box and the rest of the note reaching Claude Code. One key must not lose typed text. | 37 (12.9) |
| D3 | What a dialog starts from: the label field holds the title when its source is the label, else nothing (the title as placeholder); the group field the group when the user set it (`groupSource` `meta`), else nothing (the title's key as placeholder); the note's text box the stored note. The note's `base` is the string `selected.note ?? ''` exactly as that `list` carried it when the dialog opened — never the text box's value, which normalises line breaks — and a later `list` never changes it. `n` acts only once a `list` carries the selected session's `selected`; before, the key bar says `the note is not here yet; press n again`. A note stored with CR line breaks is saved with LF ones after an edit in the window: a named limit. | S2 12.5: a save is refused when the stored note changed since the edit began; the page has the whole note only in `selected`. | — |
| D4 | The window's chip (S2 12.3) is the pure function `windowChip` in `src/window/view/chip.ts`; `RowPayload.chip` becomes `{ level, open, merged }` (2.2). `src/window/view/` may import `CHIP_ORDER` of `src/github.ts`, design 7.3's order, beside A8's two functions. `ls` and the interactive list keep design 7.3's chip. | One order of the pull-request states in one place; the rule is the view model's (S2 4.3). | 34 (4.3, 8.2.3) |
| D5 | A note's `text` and `base` hold at most 65,536 bytes of UTF-8 each, as `input.data`; S2 8.2.3's 1,024 bytes would refuse most notes. The largest note `act`, every character escaped by JSON, stays under the WebSocket's message limit (1 MiB). `selected.note` is null for a longer stored note, with `noteTooLong`; the window then does not edit it and says `this note is longer than the window edits; use skydeck note <short id>`. The page refuses a longer text before sending it (the server would close the connection for it). | A note is free text of any length (design 7.1); the list is sent whole on every change. | 34 (8.2.3) |
| D6 | `list` carries what the header and the dialogs need: `selected.note`, `selected.noteTooLong`, `selected.ticketUrl`; each pull request's `okAtNs`; each terminal's `openedNs` (2.2). The header gets them through `header(row, selected, term, now)` (2.4, ruled on review B): `selected` for every pane, the pane's terminal, and the list's estimate of the server's now (`serverNow`, moved from `web/list.js` into `web/format.js`); the header and the pull-request dialog repaint their ages on their own age tick, as the list does. `app.js` (task 37) passes all four, so that task 38 needs no `web/app.js`. | S2 12.5 shows "checked 4m ago", "last read 3h ago", "opened <time>", and a running session's chip needs `ticketUrl`; the page decides no rule (S2 4.3); ages are the page's (A18). | 34 (8.2.3) |
| D7 | An edit shows within a second: after an action that wrote to the store, the server loads the rows again and pushes the lists at once (`ActionDeps.changed`, `Tick.reloadNow`), within the pages' once-a-second rule; it does not wait for the next refresh. | The tick reloads after a write only at its next refresh, up to two seconds later; a dialog that closed should not show the old text that long. | 36 (10.1) |
| D8 | `pr-add` answers as soon as the pull request is attached; its fetch (design 7.3: at once, the 10-second timeout) and `pr-refresh`'s explicit refresh run in the background on the server (`src/window/pr-fetches.ts`), ended by the server's stop. One such fetch runs at a time per server: a request whose pull requests the one running already covers joins it; any other waits and runs, together with every request that came meanwhile, when it ends. The lists follow when a fetch saved something, or threw after it may have (ruled on #90, review 2); a failed one is logged: a failure saved on the pull requests as `prs: <n> of <m> pull requests could not be read` (fixed text with counts; the reason is on the pull request), a thrown one by kind (ruled on #90, review 1). A failed fetch shows on the pull request as `can't read`, as `pr add` leaves it. | The dialog must not wait up to 10 seconds; a ↻ pressed three times must not start three `gh` runs beside the tick's own (which runs one at a time). | 36 (12.5) |
| D9 | Refusals and conflicts are section 2.5's. An edit acts only on a session the store knows (`loadRows`; the id is whole, so nothing is resolved and no refresh runs first). A note whose stored text already equals the `text` sent, or whose `text` stores nothing (empty or white space) while there is no note, is `ok` with nothing written, whatever `base` says (a save sent again after a lost answer, also one that cleared the note; ruled on #90, review 1). Between two windows, label, group and done are last-write-wins, as two commands are; a note is refused by its `base`. | S2 12.5 names the note's conflict only; the rest is step 1's behaviour. | 36 (12.5) |
| D10 | A note saved in the window removes a note file that a failed editor kept (`<stateDir>/note-<id>.md`), as `note --set` does (design 7.1); `discardKeptNote` and the path rule move from `src/cli/notes.ts` to `src/sessions/meta.ts` so that the server can call them (`src/window/` never imports `src/cli/`). The dialog starts from the stored note, never from a kept file. | Otherwise the next `skydeck note` would open the old kept text over the window's note (ruled as planned). | 36 (12.5) |
| D11 | Two parts of S2 12.5 that S2 19 names for no stage are built in task 38: `pr-refresh` (S2 8.2.3) as the ↻ of the pull-request dialog, and "opened <time> · last active <age>" with where the title comes from, on the header's second line. | They are the header's facts and its pull-request detail (ruled: in task 38). | 38 (19) |
| D12 | The header keeps one height for every session and window width (S2 12.5, ruled): stage A's two lines and two more, the pull requests' line and the note's line, each one line cut with an ellipsis, there for every session. The pull requests' line: the window's chip, the open ones side by side (`owner/repo #7 · failing`) as far as they fit, and the button `Pull requests`, never cut; while none is attached, the hint `no pull request` in the dim style and the button `+ PR`. The note's line: its first line, `…` after it when there are more, or the hint `no note` in the dim style while there is none. `area()` and Z1's rule stay as on main: the header is still measured as it is, and it no longer changes with what skydeck knows about a session. | Review A on main's code: a height that follows the content resizes a running program whenever a pull request is attached by itself, merges, or a note is edited, moves the terminal's top edge between sessions, starts New at a wrong size, and has no bound. | — (S2 12.5) |
| D13 | The pull-request dialog (task 37's, with its list from task 38) lists every attached pull request on a line of its own: a click on the line that selected no text opens it (`act open-link`, S2 9.6), × detaches it (`pr-rm`) and shows the toast `Detached owner/repo #7 · Undo`, whose Undo sends `pr-add` with that address; merged and closed ones fold into `30 merged, 2 closed ▸` (the mockup's words), unfolded with the same controls; ↻ sends `pr-refresh`; the field attaches one, and Attach's `ok` empties the field and keeps the dialog open, so that the new line shows in the list (`not fetched`, then its state), while every other dialog closes on `ok` (ruled on review B's re-check; task 37); its other button is `Close` (D1). Words per state: `can't read · last read 3h ago · <error>` (`never read` without one), `not fetched`, `checks failing`, `changes requested`, `checks pending`, `review required`, `draft`, `approved, green`, then `· checked 4m ago` once read; `merged` and `closed` with no age (they are never read again, design 7.3); the error cut to 120 units (task 38). The pull request's title is the line's tooltip. The list follows every `list` while the dialog is shown (`editor.update`); the field's text never does. | S2 12.5 shows one example of each kind; the rest follows the chip's order. An address the user no longer sees cannot be attached again by hand. | — (S2 12.5) |
| D14 | The group chip opens the ticket when there is a link and shows that it is one (an arrow `↗` after the key, underlined); otherwise it is plain text. It never edits: the ✎ beside it and `g` edit the group, with and without a link; while there is no group the dashed `+ group` button sets one. | One element, one meaning (ruled). | — (S2 12.5) |
| D15 | The Undo toast: the mockup's words (`Marked done: hidden from the list. It comes back on new activity.`, and for a running session `Marked done. Stays under Open while it runs; hidden once it stops.`), one at a time, 5 seconds (the mockup's 4.2, rounded up for the reach to Undo); Undo sends `undone`; like the page's other chrome it takes no keyboard on a click, and it lies over the scrim of a dialog. `d` on a done row (shown with `a`) sends `undone` and shows no toast. `d` and the Done button act at the first keydown or click only (`d`'s auto-repeats are cancelled and do nothing; the second click of a double click on any button of the header does nothing, task 38), and not while their own act for that session waits. After this page's own `d` in the list, S2 12.9's exception: once the answer came and the list that holds its result — one that arrived since the act was sent (the real server sends it before the answer, unless a list went to the page within the last second, the once-a-second rule) and shows the write — the row gone from its section or marked done there; one that still shows it as not done is older than the write —, else the next one, which the page asks for with a `view` as after an edit's `ok` (D2); ruled 06:38Z and 08:15Z — no longer has the row, and only while that session is still the selected one (`d` on A, ↑ to Z before the list comes → the selection stays on Z), the row after it in the same section is selected, else the one before it, else none; never a row of Open. The Undo of that `d` selects the session again once it is back in the list, if the selection is still where that `d` left it (the row it selected, or none); moved meanwhile, it stays (both ruled on review A's re-check; task 37). That list decides once: a row it still has moves nothing later either; so a run of `d` marks one row each time, also when its lists come a second apart (review 2's S3, ruled). The Done button leaves the selection to S2 12.9's main rule. | S2 12.5 and 12.10 name the toast, not its words or time. Review A: a held `d` with done sessions shown sends `done`, then `undone`, at every list; a run of `d` needs the next row. | — (S2 12.9) |
| D16 | `skydeck show` prints the ticket address as a `ticket:` line after `group:`; `show --json` is unchanged. | Ruled; one line, no new interface. | — (S2 12.5, design 7.5) |
| D17 | In the header and the dialogs only buttons (`+ group`, ✎, `Pull requests` / `+ PR`, Note, Done / Undone, ×, ↻, the fold) cancel their mousedown, so that they take no keyboard; every text that acts — the title, the group chip with a link, a pull request's item or line, the note's line — acts on a click that selected no text, and can still be selected and copied by a drag, as on main. In a dialog, a click that selected no text gives the keyboard back to its field, and a drag over its heading or help selects that text and keeps it selected (ruled on task 37's review 1). | Review A: main lets the title, the group and the directory be selected and copied across lists (web/cards.js:11-14). | — |
| D18 | `linkToOpen` (S2 9.6) moves unchanged from `src/window/windows.ts` to `src/text/link.ts`, which imports nothing; `windows.ts` re-exports it, so that its callers and tests stay as they are. `ticketAddress` (`src/sessions/`) returns what `linkToOpen` gives for the filled address; `src/platform/config.ts`, which imports nothing, checks `ticketUrl` itself with the URL parser as S2 16.4 says. | The import rules of design 11: `src/sessions/` may import `src/text/`, never `src/window/`; `src/platform/` imports nothing. | — |

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
  `title` tooltip — never `innerHTML`, never an element built from it, never an `href`. Logs carry
  the kind of a failure, never a label, group, note or address that was sent (stage A's rule).

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
// RowPayload: chip becomes  ChipPayload | null   (stage A: { level, count } | null)
// TerminalPayload gains     openedNs: NsText   (when the window opened it; the header's "opened")
export interface SelectedPayload {
  /* stage A's: sessionId, command, flagsKnown, unknownFlags, ended, expiring, expired */
  /** The note exactly as stored — not sanitised: the page puts it only into a text box's value
   *  and sends it back as `base` — when it holds at most 65,536 bytes of UTF-8; null when there
   *  is none or it is longer (D5). */
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

// src/text/link.ts — task 35; moved from src/window/windows.ts unchanged (D18); windows.ts re-exports it
export function linkToOpen(url: string): string | null;

// src/sessions/ticket.ts — task 35; pure
/** S2 12.5's ticket link. The key is the text `groupPattern` matches in `group`, only when it
 *  matches /^[A-Za-z0-9][A-Za-z0-9._-]*$/. The address is linkToOpen of `ticketUrl` with its one
 *  `{key}` replaced by the key, and only when `ticketUrl` holds no white space or control
 *  character and no `%`, or `%` and one hex digit, right before `{key}`, and the parser reads
 *  `ticketUrl` with a stand-in that no key can be (`_key_`) in place of `{key}` without a user
 *  name or password and with the address's host. Null when `ticketUrl` or `group` is null,
 *  nothing matches, the match is not such a key, linkToOpen refuses, or one of those does not
 *  hold (ruled on #77, review 2). */
export function ticketAddress(group: string | null, groupPattern: string, ticketUrl: string | null): string | null;

// src/platform/config.ts — task 35
// Config gains   ticketUrl: string | null   (DEFAULT_CONFIG: null), checked as S2 16.4 says: where
// the key stands among the address's parts is decided by the URL parser, with two different sample
// keys, never by the text (ruled on #77: the text's rules are its length, its characters, `{key}`
// once, and no escape left unfinished right before it).

// src/sessions/meta.ts — task 36; moved from src/cli/notes.ts, behaviour unchanged (D10)
export function keptNotePath(deck: Deck, sessionId: string): string; // <stateDir>/note-<id>.md
export function discardKeptNote(deck: Deck, sessionId: string): void;

// src/window/pr-fetches.ts — task 36 (D8)
export interface PrFetches {
  /** design 7.3's fetch of these pull requests, in the background; never rejects. */
  fetch(urls: readonly string[]): void;
  /** An explicit refresh of the session's pull requests (refreshPrs with force), likewise. */
  refresh(sessionId: string): void;
  /** Resolves when no fetch runs or waits (the server's stop waits for it after aborting). */
  idle(): Promise<void>;
}
export function createPrFetches(deps: {
  deck: Deck;
  /** The server's stop: aborts a running fetch, starts no other. */
  signal: AbortSignal;
  /** Called when a fetch saved something (fetched + failed > 0), or threw after it may have
   *  (ruled on #90, review 2). */
  changed(): void;
  log: (line: string) => void;
}): PrFetches;

// src/window/actions.ts — task 36: ActionDeps gains
  /** The store was written on the server's own connection: rows again and lists now (D7). */
  changed(): void;
  /** task 36's PrFetches (the server passes one). */
  prs: Pick<PrFetches, 'fetch' | 'refresh'>;

// src/window/tick.ts — task 36: Tick gains
  /** D7: loadRows now and pages.pushList(); a failure is logged by kind and the reload is left to
   *  the next refresh. */
  reloadNow(): void;
```

### 2.4 The page's modules (tasks 37, 38): changes to stage A's contract 2.9

```js
// web/keys.js — task 37. listKey gains:
//   { kind: 'edit', what: 'label' | 'group' | 'note' | 'pr' }   (`l` and F2, `g`, `n`, `p`)
//   { kind: 'done' }                                           (`d`: done, or undone for a done row)
// The `later` kind keeps only windowChord's stages B and E. cancels() is unchanged in rule.

// web/format.js — task 34; pure, no DOM (moved from web/list.js, which then uses it)
/** The server's time now as the page estimates it: a list's `nowNs` counted on by the
 *  milliseconds since that list came; `listNowNs` itself when it is not a whole number. */
export function serverNow(listNowNs, elapsedMs) {} // → string

// web/edit.js — task 37 (task 38 adds the pull-request dialog's list)
/** @param {HTMLElement} root  #editor
 *  @param {{ act(action: Record<string, unknown> & { kind: string }): Promise<ResultMessage>,
 *            toast(text: string, undo: (() => void) | null): void,
 *            closed(): void,     // called once whenever a dialog closes, whatever closed it (D2)
 *            now(): string }} deps  // the server's now (serverNow); its ages repaint on its own 1 s tick */
export function createEditor(root, deps) {}
// → { open(what: 'label' | 'group' | 'note' | 'pr', row: RowPayload, selected: SelectedPayload | null): void,
//     update(list: ListMessage): void, // every list while shown: the dialog's session's row, for what
//                                      // it lists (task 38); never a field's text or the note's base
//     escape(): void,      // app.js hands it Esc while shown (capture phase): D2's rule
//     close(): void,
//     shown(): boolean,
//     changed(): boolean } // holds text the user typed and did not save (D2's reload rule)

// web/toast.js — task 37
/** @param {HTMLElement} root  #toast */
export function createToast(root) {} // → { show(text: string, undo: (() => void) | null): void, hide(): void }

// web/cards.js — task 38; task 37 adds the parameters and the deps, unused until 38
// createCards(root, deps): deps gains
//   edit(what: 'label' | 'group' | 'note' | 'pr', sessionId: string): void,
//   done(sessionId: string): void,     // done, or undone for a done row; D15's rules; the toast is app.js's
//   say(text: string): void            // a line in the key bar (a refused open-link of the chip or an item)
// header(row: RowPayload | null, selected: SelectedPayload | null, term: TerminalPayload | null,
//        now: () => string)
//   selected: list.selected when it is that row's session, else null — for EVERY pane (terminal,
//     elsewhere, resume), and part of app.js's render key (ruled on review B)
//   term: the pane's terminal (the terminal pane's), else null — its openedNs is "opened <time>"
//   now: serverNow of the list shown; the header repaints its ages on its own 1 s tick through it
// The header keeps stage A's hooks (`#cards .card-header`, `.header-title`, `.header-sub`,
// `.header-dir`, `.header-id`, `.header-chip`), so that app.js's `area()` and the shared helpers
// work unchanged.
```

`web/app.js` (task 37) owns: the new list keys on the selected row (`no session selected` when
there is none); one function every window chord passes before it acts, `windowChordGate(kind)` —
true when it may act; while a dialog is shown it passes `help`, passes `reload` unless the dialog
holds changed text, and says `close the edit first (Esc)` for the rest — through which later
stages send their own chord-like actions (stage B's notification click, stage E's switcher); `edit`, `done` and `say` given to the cards; `header(row, selected, term, now)`
for every pane, with `selected` in the render key; `closed` and `now` given to the editor;
`editor.update(list)` at every list while a dialog is shown; D2's rules (Esc to `editor.escape()`
in the capture phase, the chords, the keyboard moved nowhere, `closed()` giving it back, the
reload guard); D15's rules for `d` and Done (first keydown, one act per session at a time, the
toast, the selection after `d`); `overLimit`'s entries for the new kinds (label and group text
1,024 bytes, note text and base 65,536, URL 4,096), and its sentence, which today knows only
1,024 and 4,096, names 65,536 too; for these fields as for stage A's it also refuses text that is
not well formed (a lone surrogate), for which the server would close the connection and a dialog
would lose the user's text (task 34's review 2) — so that the page never sends what the server's
parser refuses. `index.html` gains `#editor` and `#toast` at the
body's level, beside `#help`, and the stylesheet `edit.css`.

### 2.5 What the server refuses, and how the page shows it

The dialog shows a refusal under its field and keeps the text and the keyboard in the field; a
refusal of an action without a dialog (`d`, Done, a link) is a line in the key bar; a refusal
whose dialog was closed meanwhile is the toast `not saved: <the error>` (ruled, task 37). Every line
passes the sanitiser before it is sent (stage A's `act`) and is shown as text.

| Case | The server answers | Where |
|---|---|---|
| A label or group design 7.1 refuses (a line break, a control character, a label starting with `-`) | `cleanLabel` / `cleanGroup`'s message, the same as `skydeck label` / `group` print | dialog |
| Empty or only white space | clears it (as the commands do) | — |
| The note changed since the dialog opened (another window, a command) | `the note was changed elsewhere while you edited it; your text is still in the box` (S2 12.5); nothing written | dialog |
| The stored note already equals the text sent, or the text stores nothing while there is no note (a save sent again after a lost answer, also one that cleared the note) | `ok`, nothing written (D9) | — |
| Two windows edit a label, group or done | the later write wins; every window's list follows (D7) | — |
| A session the store does not know (gone) | RefError's `no session matches '<id>'`, as `act resume` | dialog or key bar |
| A `new` session not started yet (A28's row) | `this session has not started yet; edit it once it runs` | dialog or key bar |
| A URL that is not a pull request | `requirePrKey`'s `not a GitHub pull-request URL: <text>` | dialog |
| `pr-rm` of one not attached | `detachSessionPr`'s `<url> is not attached to <short id>` | dialog |
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
- Create: `src/window/view/chip.ts`, `test/window/view/chip.test.ts`
- Modify: `src/window/protocol.ts` (2.2); `src/window/view/sections.ts` (`rowPayload`: the chip
  from `windowChip`, each pull request's `okAtNs`); `src/window/view/build.ts` (each terminal's
  `openedNs`); `src/window/selected.ts` (`note`, `noteTooLong`; `ticketUrl` null);
  `src/window/actions.ts` (one case: every stage D kind answers `skydeck cannot do that action
  yet`, nothing done, until task 36); `web/list-text.js` (`chipText` of a `ChipPayload`, the row's
  chip with its merged part apart, the tooltip); `web/list.js`, `web/list.css` (the `+30` dim, a
  `3 merged` or `closed` chip dim, `can't read` dotted as before; the list's own estimate of the
  server's now replaced by `serverNow`); `web/format.js` (`serverNow`, 2.4);
  `docs/design-step-2.md` (4.3: D4's import; 8.2.3: the limits of D5 and the fields of D6)
- Modify (tests and fixtures): `test/window/protocol.test.ts`, `test/window/view/sections.test.ts`,
  `test/window/view/build.test.ts` (its fixtures, and its case that pins the view's files and
  value imports: `chip.ts` joins `build.ts` and `sections.ts`, and `CHIP_ORDER` of
  `../../github.ts` and `windowChip` of `./chip.ts`, which `sections.ts` imports, join the
  allowed imports, D4; ruled by the lead on review B's re-check), `test/window/selected.test.ts`,
  `test/window/actions.test.ts`, `test/helpers/pages.ts` (`defaultList`'s terminals gain
  `openedNs`), `test/web/list.test.ts`, `test/web/pane.test.ts`, `test/web/format.test.ts`
  (`serverNow`), `test-page/list.test.ts`, `test-page/cards.test.ts` (its chip fixtures: `count`
  becomes `open` and `merged`), `test-page/helpers/shell.ts` (`scriptedList`'s terminals carry
  `openedNs`; `actsWorld`'s `selected` carries `note`, `noteTooLong` and `ticketUrl`)

**Behaviour.** The parser takes the new kinds with 2.2's limits. `windowChip` is S2 12.3's rule
over the levels step 1 computes (`prLevel`): a level other than `merged` and `closed` is open.
`chipText`: `PR · failing`, `3 PRs · failing`, then ` +30` for the merged ones; with none open
`3 merged`, else `closed`. The tooltip lists each open one (`owner/repo #7 · failing`, `owner/repo
#9 · can't read · last read 3h ago`, `never read` without a last read), then `30 merged · 1
closed`. Stage A's header keeps showing `chipText`'s whole text until task 38 rebuilds it
(`web/cards.js` needs no change: it passes the row's chip on).

**Tests** (platform: `testPlatform`; the page cases `realTestPlatform`)
- Protocol: each new kind accepted at its limits and refused one byte over (label text 1,025
  bytes, note text or base 65,537, URL 4,097), with an unknown or a missing field (a note without
  `base`), a session id that is not one, a lone surrogate; a note `act` at both limits made of
  U+0001 (six bytes each in JSON) is under `MAX_MESSAGE` as JSON.
- `windowChip`: every row of S2 12.3's table; none attached → null; only never-fetched ones; a
  can't-read one with merged ones.
- `rowPayload`: the chip and `okAtNs`; the list's terminals carry `openedNs`. The view's pinned
  files and imports are `build.ts`, `chip.ts`, `sections.ts` and A8's and D4's names
  (`CHIP_ORDER`, and `windowChip` from `./chip.ts`), no more.
- `serverNow`: a list's time plus the elapsed milliseconds, as `web/list.js` counted before; a
  time that is not a whole number given back as it is; the list's ages unchanged (its cases pass).
- `selectedPayload`: the note exactly as stored (an escape character and CRLF kept); null without
  one; a note of 65,536 bytes of UTF-8 sent, one of 65,537 (a multi-byte character across the
  limit) null with `noteTooLong`; `ticketUrl` null.
- Actions: a `label` act answers `ok: false` with `skydeck cannot do that action yet` and writes
  nothing.
- `list.test.ts` (node): `chipText` and the tooltip for every row of the table; a repository or an
  error with an escape sequence is shown sanitised. Page: a row with one open failing pull request
  and 30 merged shows `PR · failing` and a dim `+30`; the header shows the same chip's text.

**Done when:** every stage D message parses as 2.2 says; the list shows S2 12.3's chip; `npm run
check` passes.

**Not in it:** acting on an edit (36), editing in the page (37, 38), the ticket address (35, 36).

---

### Task 35: The ticket address: `ticketUrl`, `ticketAddress`, `show`

**Depends on:** 0 · **Wave:** 1 · **Design:** S2 12.5 ("The ticket link"), 16.4 (`ticketUrl`), 9.6, design 7.5 (`show`), 9.1, 11 · **Contracts:** 2.3 (`linkToOpen`, `ticketAddress`, `Config.ticketUrl`) · **Decisions:** D16, D18

**Goal.** The configuration key the user asked for, the one pure rule that turns a group into a
ticket's address, and `show`'s line. The window's chip uses it from task 36 on (the server) and
38 (the page).

**Files**
- Create: `src/sessions/ticket.ts`, `src/text/link.ts`, `test/sessions/ticket.test.ts`
- Modify: `src/platform/config.ts`; `src/window/windows.ts` (`linkToOpen` moved out, re-exported);
  `src/cli/output.ts` (`formatShow` gains a last parameter `ticket: string | null = null`);
  `src/cli/commands/show.ts`; `test/platform/config.test.ts`, `test/cli/output.test.ts`
  (`formatShow`'s new parameter), `test/cli/commands/show.test.ts`

**Behaviour.** The check of S2 16.4, decided by the URL parser: `ticketUrl` is null, or a string of
at most 2,048 characters with `{key}` exactly once and no white space, control character (S2 2:
U+0000–U+001F, U+007F, U+0080–U+009F), `"` or backslash, with no `%`, or `%` and one hex digit,
right before `{key}` (a key would finish that escape: `%2{key}` with `e.` makes `..`, with `6x` an
escaped `&`; ruled on #77, review 2), that parses (`URL.parse`) with `KEY-1` and with `OTHER-2` in
place of `{key}` into `http:` or `https:` without a user name or password and with the same host
both times: a host the key went into would differ. (Ruled on #77: the second condition of review A's
F1, "none of which holds the sample key", is dropped — a fuzz of 28 million different patterns in
Node 24's parser found nothing it refuses that the first accepts but a pattern whose own host holds
a sample key's text, `https://key-1.example.net/{key}`, a false refusal; a user name or password is
refused, as `show` would print it and Edge's command line carry it, which leaves the host as the one
part compared.) Anything else is the one message `<file>: "ticketUrl" must be null or an http or
https address with {key} once, after its host`. `ticketAddress` as 2.3 says: it holds the rules of
the text by itself, and gives no link for a `ticketUrl` with white space or a control character,
since the parser drops tabs and line breaks before it reads (`%2<tab>{key}`). `show` prints `ticket:
<address>` after `group:` when there is one; `--json` is unchanged (D16).
`test/window/windows.test.ts` keeps testing `linkToOpen` through the re-export, unchanged.

**Tests** (platform: `testPlatform`)
- Accepted: null; `https://example.atlassian.net/browse/{key}`; `http://host:8080/t?id={key}`;
  `https://host/#/{key}`; `https://Example.net:443/{key}`; a host of the pattern's own that holds
  a sample key's text, `https://key-1.example.net/{key}` (ruled on #77).
- Refused with the message, each a named case (also `%{key}`, `%2{key}`, `%a{key}`, `%A{key}`,
  `?id=%2{key}`, `#%2{key}`, while `?jql=key%3D{key}` and `%25{key}` are accepted; ruled on #77):
  `https:///{key}/x`, `https:////{key}`,
  `https:/{key}/x`, `https:{key}`, `https:///{key}@h/x` (review A's five: the parser reads the key
  as the host or the user name); `https://{key}.example.net/`; `https://user@{key}/`;
  `https://host{key}/`; `https://{key}@host/x`; `javascript:{key}`; `file:///{key}`;
  `ftp://host/{key}`; no `{key}`; two; a `"`, a backslash, a space, a tab, an escape character;
  2,049 characters; a number; a user name, a password, both (ruled on #77).
- `ticketAddress`: the default pattern on the group of a title `ABC-12 fix` →
  `https://example.atlassian.net/browse/ABC-12`; a group set by the user `ABC-12` and `ABC-12
  cleanup`; `https://Example.net:443/{key}` → `https://example.net/ABC-12` (what `linkToOpen`
  gives); no match, `ticketUrl` null, `group` null → null. With the pattern `^\S+` a group of each
  of `evil.com/x`, `a?b=1`, `a#b`, `u@h`, `a:b`, `..`, `.x`, `-x`, `%2e%2e`, `ÄBC-1` → null. An
  address that would be over 2,048 characters → null. A group taken from the title that a
  look-ahead in `groupPattern` no longer matches on its own → null (no link; safe). `ABC-12`, the
  default pattern and each of review A's five refused patterns above (`https:///{key}/x`, …) →
  null: `ticketAddress` holds the host by itself, whatever `ticketUrl` it is given (ruled on
  review A's re-check of a03677a); also with the keys `KEY-1`, `OTHER-2`, `abc-12`, `evil.com`,
  `x`, `a`, `e`, `s`, `1`, `0`, `8443`, `a_b` under `^\S+`, and for `https://host:{key}/x`,
  `https://[::{key}]/x`, `http{key}://host/x` (no key can be the stand-in). A `ticketUrl` with a
  user name or password of its own → null. An escape left unfinished right before `{key}` (ruled
  on #77, review 2): `…/browse/%2{key}` with a title `e. retry the upload` under `^\S+`;
  `%2{key}` with `e`, `E`, `e.`, `FOO-1`; `%{key}` with `2e`, `2E`, `2e.`, `41`; `.%2{key}`,
  `.%{key}`, `%2e%{key}`, `?id=%2{key}` with `6x`, `#%2{key}`, `%a{key}`, `%A{key}` → null;
  `%3D{key}`, `%25{key}`, `%7E{key}` → the link. A key `.` or `..` in a path → null; `ABC-12` in a
  path, a query and a fragment, and beside a `_key_` of the pattern's own text → the link. White
  space or a control character anywhere in `ticketUrl` (a tab or line break inside `%2{key}`, a
  space, a leading space, a trailing line break, ESC, DEL, U+009B, U+00A0, a tab in the host) →
  null.
- The key's allow-list: every printable ASCII character outside `[A-Za-z0-9._-]`, `ä`, U+00A0 and
  U+2028 inside a key → null (ruled on #77, review 2).
- `formatShow` (`test/cli/output.test.ts`): the `ticket:` line after `group:`, sanitised, and none
  for `null`. `show` (`test/cli/commands/show.test.ts`, the sandbox): with `ticketUrl` set and a
  ticket-key group the `ticket:` line; without either, none; with a `groupPattern` of the
  configuration's own, the key it finds (ruled on #77, review 2). These cases are what holds the
  line; nobody runs `show` by hand (task 39).

**Done when:** a wrong `ticketUrl` fails every command with that one line (exit 1), as every key
of the file; `show` prints the line; `npm run check` passes.

**Not in it:** `selected.ticketUrl` (36); the chip's link (38); `docs/install.md` (39).

---

### Task 36: Editing on the server

**Depends on:** 34, 35 · **Wave:** 2 · **Design:** S2 8.2.3 (the `act` kinds), 10.1, 12.5 (editing), 12.10, design 7.1, 7.3 · **Contracts:** 2.2, 2.3, 2.5 · **Decisions:** D7, D8, D9, D10

**Goal.** Every stage D `act` does what S2 12.5 says, through step 1's functions, refuses what 2.5
lists, and shows in every window within a second.

**Files**
- Create: `src/window/pr-fetches.ts`, `test/window/pr-fetches.test.ts`, `test/helpers/gh.ts` (a
  runner that answers `gh` with a canned `gh api graphql` answer of the test's choice — at once,
  held until the test lets it go, or held until the run's own abort signal fires (then it ends as
  an aborted run does) —, counts the runs, and passes every other command to the runner it wraps;
  never a real `gh`), `test/window/server-edits.test.ts`
- Modify: `src/window/actions.ts` (the cases, replacing task 34's interim one);
  `src/window/server.ts` (`createPrFetches` with the server's stop signal; `changed` →
  `tick.reloadNow()`; the stop waits for `idle()` after the abort, as for the tick's fetch);
  `src/window/tick.ts` (`reloadNow`); `src/window/selected.ts` (`ticketUrl` from
  `ticketAddress(row.group, config.groupPattern, config.ticketUrl)`); `src/sessions/meta.ts`
  (`keptNotePath`, `discardKeptNote`); `src/cli/notes.ts` (imports them and re-exports
  `discardKeptNote`, so that `src/cli/commands/note.ts`, which imports it from there, is
  unchanged; nothing else changes);
  `test/window/actions.test.ts`, `test/window/tick.test.ts`, `test/window/selected.test.ts`,
  `test/sessions/meta.test.ts`; `docs/design-step-2.md` (10.1: D7; 12.5's paragraph "Editing
  (stage D)": D8, D9, D10 in a sentence each)

**Behaviour.** Common to all: stage A's check of the action again; the session is a row of
`loadRows(deck)`, else a `new` terminal of the hub waits for it (the not-started refusal), else
RefError. After every write `deps.changed()`; the result is `ok` with no lines (a `pr-add`:
`attached <url>`), also when `changed()` or `prs.fetch` throws: the write is committed, and the
throw is logged by kind (ruled on #90, review 2). `label`:
`text.trim() === '' ? null : cleanLabel(text)`, then `setLabel` — the expression of
`skydeck label`; `group` likewise with `cleanGroup` and `setGroup`. `note`: in one store
transaction the stored note (`''` for none) is read — equal to `text`, or `''` while `text` stores
nothing (empty or white space; ruled on #90, review 1), `ok` and nothing written; different from
`base`, the refusal of 2.5 and no write; else `setNote(text)` (empty or white space clears) — and
after the commit `discardKeptNote` (D10).
`done`, `undone`: `markDone`, `markUndone`. `pr-add`: `attachManualPr` (origin `manual`; an earlier
detach cleared), `changed()`, then `deps.prs.fetch([key.url])` (D8). `pr-rm`: `detachSessionPr`.
`pr-refresh`: `deps.prs.refresh(sessionId)`, `ok` at once. `createPrFetches`: D8's one-at-a-time
rule; `fetchPrs` and `refreshPrs` of `src/github.ts` with the platform's runner, clock and
environment and the store; `changed()` when something was fetched or failed, and after a throw (a
batch may have been saved before; ruled on #90, review 2); a failure saved on the pull requests
logged as `prs: <n> of <m> pull requests could not be read`, a thrown one by kind (ruled on #90,
review 1).

**Tests** (platform: `testPlatform` through `testDeck` for the actions, the fetches and the tick;
`realTestPlatform` through `startTestServer` for `server-edits.test.ts`)
- For every refusal of design 7.1 (a line break, a control character, a label starting with `-`, a
  group with a tab) the window's message is the same message `skydeck label` / `group` print for
  the same text, without the command's `skydeck: ` prefix (the test runs the command on the same
  deck), and nothing is written; an empty and a
  white-space text clear; the stored label is the trimmed text.
- Note: `base` equal → stored exactly as typed (CRLF, trailing spaces, 65,536 bytes); empty →
  none; the stored note changed between the dialog's start and the save (`setNote` in between) →
  2.5's message, the stored note unchanged; the same save sent twice → both `ok`, one write; a
  stored note with CRLF and a save with that stored string as `base` and its LF form as `text` →
  saved; `base` `''` with no note → saved; a kept note file is removed after a save and stays
  after a refused one.
- `done` and `undone` set and clear the done time; `pr-add` of a URL that is not a pull request →
  `requirePrKey`'s message, nothing attached; of one → attached `manual`, an earlier detach gone,
  `prs.fetch` called once with its key URL, the answer given before the fetch ends; `pr-rm` of one
  not attached → its message; `pr-refresh` → `prs.refresh` with the id.
- An unknown session id → RefError's message; the id of a `new` terminal's session that has not
  started → the not-started message. Every write calls `changed()` once; a refusal never.
- Each new kind given to `createActions` straight, with a field over its limit of 2.2 → `skydeck
  cannot do that action`, nothing written. After every refused and every failed stage D act, the
  log lines hold nothing of the label, group, note or address sent (by kind only, as stage A).
- `pr-fetches.test.ts` (the `gh` stand-in holding its answer): three `refresh` of one session at
  once → `gh` ran once and `changed()` once; a `fetch` of another pull request while one runs →
  `gh` once more after it ends, with both requests' pull requests; a failed `gh` → one log line
  `prs: <n> of <m> pull requests could not be read` (fixed text with counts; the reason is on the
  pull request, ruled on #90, review 1), the pull request `can't read`; the signal aborted while
  one runs → `idle()` resolves, no other starts.
- `reloadNow`: the rows are loaded and the lists pushed at once; a busy store → one log line by
  kind, the rows loaded at the next refresh.
- `server-edits.test.ts`, two pages: a label set from page A is in page B's `list` within 1.5 s and
  in the store; a note saved from A, then from B with the old `base` → B refused with 2.5's
  message, the store holds A's; `pr-add` with `test/helpers/gh.ts` answering open, approved, checks
  passing → a list with the pull request `unfetched`, then one with `approved-green` and its
  `okAtNs`; the server stopped while a fetch waits (the stand-in holding its answer until the run's
  signal fires) → the stop does not wait the 10 seconds; a
  running session marked `done` stays in Open with its `done` mark; with `ticketUrl` in the
  sandbox's configuration and a label `ABC-12 try`, `selected.ticketUrl` is the address; a label
  holding an escape sequence → a refusal whose lines hold no control character.

**Done when:** every stage D `act` kind does what S2 12.5 says through step 1's functions; the
refusals are 2.5's; an edit shows in every window within a second; `npm run check` passes.

**Not in it:** the page (37, 38).

---

### Task 37: The dialogs, the Undo toast and the list keys

**Depends on:** 34 · **Wave:** 2 · **Design:** S2 12.5 (editing, the dialogs), 12.9 (`l`, `g`, `n`, `p`, `d`, F2; the focus rules; the selection after `d`), 12.10 (the toast) · **Contracts:** 2.4, 2.5 · **Decisions:** D1, D2, D3, D5, D15, D17

**Goal.** From the list, every stage D key does its action: the dialogs of D1, the Undo toast,
the selection after `d`, and the key help without the stage D keys marked as coming later. The
header's controls come with task 38 and call the same dialogs.

**Files**
- Create: `web/edit.js`, `web/edit.css` (the scrim, the dialogs and the toast above xterm.js's
  layers, and the key help's stacking level, so that Ctrl+Shift+H shows it over a dialog;
  `web/style.css` stays untouched; ruled), `web/toast.js`, `test-page/edit.test.ts`,
  `test-page/fixtures/recording-cards.js` (a whole cards module — `app.js` calls every member of
  contract 2.9 on it —: a copy of `test-page/fixtures/minimal-cards.js` that also records every
  `header(…)` call's arguments on the page, and the deps it is given, pinned with `pinModules`, so
  that a test sees what `app.js` passes and does what task 38's header controls will do; ruled)
- Modify: `web/app.js`, `web/keys.js`, `web/help.js` (the stage D lines: `l` and F2 label, `g`
  group, `n` note, `p` pull requests, `d` done or undone; and a note on the dialogs, ruled on
  review 1), `web/index.html` (`#editor`, `#toast`,
  `edit.css`), `web/cards.js` (only `header`'s new parameters and the three deps of 2.4, unused);
  `test/web/keys.test.ts` (the stage D cases), `test-page/shell.test.ts` (the one case that pinned
  `<key>: comes in a later stage` for these six keys), `test-page/helpers/shell.ts` (a new function
  `editWorld` at the end — a scripted stand-in, as `actsWorld`, that answers each `act` as the test
  says, when the test says, and sends the lists it is given); `docs/design-step-2.md` (12.9: D2)

**Behaviour.** The dialogs as D1–D3: the heading `Label — <title>`, `Group — <title>`, `Note —
<title>`, `Pull requests — <title>`; the mockup's help lines (`Shown as the title, and passed to
Claude Code as the session name on the next start or resume. Empty clears it.`, `Empty: the
ticket key at the start of the title is used.`, `Ctrl+Enter saves. Plain text, kept on this
machine.`, `Pull requests a session touched are attached by themselves.`). The pull-request
dialog of this task holds the field and Attach (task 38 adds the list above it). Save sends the
`act` and is disabled while it waits; `ok` closes the dialog, but Attach's `ok` empties the field
and keeps the pull-request dialog open (ruled, D13); a refusal stays in it (2.5). Every
close calls `deps.closed()`. D2's modal rules and reload guard; D15's toast, its first-keydown and
one-at-a-time rules for `d`, and the selection after `d`; D17 for the dialogs' buttons. The cards'
side of 2.4 as `app.js` sees it: `header(row, selected, term, now)` for every pane, `selected` in
the render key, `now` from `serverNow` with the time the shown list came; `overLimit` names
65,536 bytes in its sentence for the note and refuses text that is not well formed (2.4).

**Tests** (platform: `realTestPlatform` for the page; the scripted stand-in through `editWorld`)
- `keys.test.ts`: `l`, F2, `g`, `n`, `p`, `d` give 2.4's kinds; with Ctrl, Alt or Meta, nothing;
  `cancels` true for them in the list zone; `later` only for Ctrl+Shift+J and Ctrl+Shift+P.
- `edit.test.ts`, what the header gets (the recording cards, `editWorld`): a running row selected
  → `header` gets its row, the list's `selected` for it, its terminal and a `now` that counts on;
  a `list` that changes only `selected` (its `ticketUrl`) → `header` called again with it; the
  resume and elsewhere panes get `selected` too and `term` null.
- `edit.test.ts`, the keyboard after a close: `ok` → the keyboard on the list at once, before any
  further `list` comes (`deps.closed`).
- `edit.test.ts`, the dialogs: `l` on the selected row opens the label dialog with its label, the
  keyboard in the field; Enter sends `act label` with the text; `ok` closes, the keyboard back on
  the list; a refusal (`a label cannot start with '-' …`) shows under the field, the text and the
  keyboard stay. `g`'s field empty for a group taken from the title, filled for one the user set.
  `n`: the note in the box, Enter a line break, Ctrl+Enter sends `act note` whose `base` is the
  listed string exactly (a CRLF note too); a `list` with another note arriving meanwhile changes
  neither the box nor `base`; 2.5's conflict message keeps the text; a note of 65,537 bytes typed →
  refused in the dialog, nothing sent; `noteTooLong` → no Save and D5's sentence; a lone surrogate in the note → refused in the
  dialog, nothing sent, the text and the connection kept. `p` sends `pr-add` with the URL, and
  (named) Attach's `ok` empties the field and keeps the dialog open. A held Enter saves once; the held key that opened a dialog types nothing
  into it (ruled). A title `<img src=x onerror=…>` in the heading is text.
- `edit.test.ts`, the modal rules (review A's case first, named "a resume's answer and its terminal
  never take the keyboard from a dialog"): Enter on a row that is not running, its resume answered
  after 500 ms; `n` at once; typing a note through the answer and through the `list` that brings
  the terminal → every character is in the box, the page sent no `input` and no other `act`; on
  Esc twice the terminal of that resume has the keyboard. Esc on an unchanged dialog closes it; on
  a changed note the first Esc says `Esc again discards your text`, the second closes. F5 with
  changed text says `save or cancel the edit first` and does not reload; unchanged, it reloads
  after the server's proof, as stage A's case. The connection lost while saving → stage A's line
  in the dialog, the text kept. While a dialog is shown, Ctrl+Shift+1 and Ctrl+Shift+L say `close
  the edit first (Esc)` and change nothing, `j` and `d` typed in its field are text, Ctrl+Shift+H
  shows the help, a click on the scrim does nothing. (Named, ruled) a held Enter or Esc that
  closes a dialog opened over a terminal types nothing into the terminal; the next press does.
  (Ruled) a click inside a dialog that selects nothing gives the keyboard back to its field; a
  drag over its heading keeps the selection.
- `edit.test.ts`, `d` and the toast: `d` sends `done`; the toast shows D15's words; Undo sends
  `undone`; `d` on a done row sends `undone` and no toast. A held `d` (auto-repeats) sends one act;
  a second `d` while the first one's answer waits sends nothing. After `d` on a row of This week
  whose list then lacks it, the next row of This week is selected; on the last row, the one before
  it; on the only row, none; a `d` whose answer is a refusal moves nothing. (Ruled) `d` on A, ↑ to
  Z before the list comes → the selection stays on Z; the Undo of this page's `d` selects the
  session again when it is back, unless the selection was moved meanwhile.
- `shell.test.ts`: the six keys are cancelled in the list zone; with no row selected the key bar
  says `no session selected`.

**Done when:** from the list, `l`, F2, `g`, `n`, `p` and `d` do their actions through the server's
answer; no text the user typed is lost by one key, and none reaches a terminal while a dialog is
shown; `npm run check` passes.

**Not in it:** the header's controls and the pull-request dialog's list (38); the server's rules
(36).

---

### Task 38: The header and the pull-request dialog's list

**Depends on:** 36, 37 · **Wave:** 3 · **Design:** S2 9.6 (pull-request and ticket links), 12.3 (the tooltip), 12.5 (all of it, the ticket link included), 12.10 · **Contracts:** 2.4 (`cards.js`, `edit.js`), 2.5 · **Decisions:** D11, D12, D13, D14, D15, D17

**Goal.** Replace stage A's read-only header with S2 12.5's, at one height: every fact, the
pull requests' line, the note's line, the controls that open task 37's dialogs, the ticket link,
and Done; and fill the pull-request dialog with every attached pull request.

**Files**
- Create: `web/header-text.js` (no DOM: a pull request's words in the line and in the dialog and
  their tooltips, the fold's text, "opened <time> · last active <age>", the title's source in words,
  the note's line), `test/web/header-text.test.ts`, `test-page/header.test.ts`
- Modify: `web/cards.js` (the header), `web/cards.css`, `web/edit.js` (the pull-request dialog's
  list, through `update`), `web/edit.css`; `test-page/cards.test.ts` (the existing cases that
  pinned stage A's header: the chip's place, and the cases that took the header for buttonless; no
  new case),
  `test-page/real-modules.test.ts` (only if a case's numbers move with the taller header; no new
  case); `docs/design-step-2.md` (19: D11)

**Behaviour.** The four lines of D12, each one line of a fixed height whatever it holds, so that
nothing skydeck knows about a session resizes a shown terminal (ruled). Line 1: the title (a click
that selected no text opens the label dialog through `deps.edit`); the group chip as D14 (with
`selected.ticketUrl`: `DE-123 ↗`, underlined, tooltip the address, a click that selected no text
sends `act open-link` with it; else plain text, tooltip `group (from the title)` when it is), the ✎
(the group dialog), or the dashed `+ group` while there is no group; the state pill as stage A's;
the buttons Note (the note dialog) and Done / Undone (`deps.done`). When the line is short of room
the title, the chip and the state share it, each up to what it needs (the chip's key and the state
are bounded), so that none is cut away whole and the buttons never are. Line 2: the directory (one
line, ellipsis, at most half the line) as stage A's, `opened <time>` from `term.openedNs` when the
pane shows a terminal, `last active <age>`, the title's source (`title: your label`, `title: Claude
Code's name`, `title: Claude Code's summary`, `title: start time and folder`; the first to give way),
the short id (never cut, a click copies, as stage A's). Line 3: the window's chip (the list's own
words and tooltip, `rowText`), the open pull requests' items (`owner/repo #7 · failing`, the chip's
words; a click that selected no text opens it; the tooltip D13's words with the error whole, then
the title) as far as they fit — one that does not fit is left out whole, and only a first one wider
than the line alone ends in an ellipsis —, `Pull requests` / `+ PR`
(the pull-request dialog), never cut; while none is attached the hint `no pull request`. Line 4: the
note's first line and ` …` when the note has another line with something on it (the whole note of
`selected` decides; without it the list's head of the note), or `no note`, a click opening the note
dialog. A refused link through `deps.say`. The pull-request dialog's list as D13, above the field:
`no pull request attached` while there is none; the fold is closed at every open; × and ↻ send one
act while it waits, a double click on × is one press, and a × whose `pr-rm` was taken stays disabled
until a list no longer holds its line (or its Undo attaches it again) — forgotten when the dialog
closes, or at an `ok` that finds it closed, so that a pull request attached again elsewhere has a ×
that acts; a line's text is not drawn again while a mouse button is down on the list (until its
release, a drag and drop's end or the window's loss of focus) or a selection touches the line, so
that an age counting seconds neither ends a selection nor turns a drag into an open, and a line
made meanwhile is filled at once; a refused link, × or ↻ shows under the field, and one whose dialog was closed
meanwhile is the toast `not saved: <the error>` (as C4); an error is cut on its line to 120 UTF-16
units with `…`, never inside a surrogate pair, and its line's tooltip is the pull request's title,
then the whole error when the line cut it. The list follows every `list` (`editor.update`): a line
comes or goes with the list that holds the write, which the server pushes after it (D7) — usually
before the act's answer, else within a second (the once-a-second rule), or at its next refresh when
the store was busy; an address attached already changes nothing, so no list comes for it, and its
line is there. A dialog's field takes the auto-repeats only of a key whose first press it got, so
that Enter held on the header's Note opens the dialog and types nothing into it (S2 12.9's held
key, review 2). Buttons and texts as D17; the second click of a double click on a button of the
header does nothing, as on × (D15: Done would find the done row its first click made, and send
`undone`; review 2's S6, ruled). Every age — `last active`, `checked`, `last read` — is
counted from `now()` and repainted on the module's own 1 s tick, in the header and in the
pull-request dialog's list (`deps.now` of the editor), as the list repaints its ages (A18); a text is
set only when it changed, so a selection in it stays.

**Tests** (platform: `realTestPlatform`; the cases of heights, ages, what is drawn and the dialog's
refusals on a scripted stand-in, `editWorld`, so that a list holds exactly what the case says; the
cases of the controls on a test server with sessions made by step 1's helpers, pull requests
attached with `attachManualPr` and their status saved with `savePrResult`, notes with `setNote`;
`gh` through `test/helpers/gh.ts`; links seen by the Edge stub)
- `header-text.test.ts`: the words of every level, with and without a last read and an error;
  `30 merged`, `30 merged, 2 closed`, `1 closed`; ages; the error cut at 120 units (a surrogate pair
  whole); the tooltips; the note's line (`…` from the whole note); a repository or an error with an
  escape sequence sanitised.
- `header.test.ts`, one height: a session without pull requests or a note, one with three open
  pull requests, thirty merged and a note of five lines, one with a directory of 340 characters, and
  one with stage D's longest texts — a label of 1,024 bytes, a group of 200 characters, a note whose
  first line has 1,000 characters, eight open pull requests with long titles, a ticket address of
  1,900 characters — each at 1280 and at 900 px → the same header height in four lines of one line
  each, the buttons and the short id whole, no pull request cut by the line's edge (some left out
  with eight), the title, the chip and the state each at least 40 px wide, and no `resize` while
  only the content changes (ruled
  01:53Z); on the real server, a pull request attached and a note set, changed and cleared while the
  terminal runs → the same height and no `resize`.
- `header.test.ts`, ages: `last active 1m` becomes `last active 2m` (the page's clock moved on, no new
  `list`), in the header and in an open pull-request dialog's `checked`; a terminal of the window
  shows `opened <time>` from its `openedNs`, a session not running none.
- `header.test.ts`, the controls: an item's click → the stub got its URL; the button → the
  pull-request dialog, listing every attached one with D13's words, the fold opening and closing, a
  line's click → the stub got its URL; × → detached in the store, the toast `Detached owner/repo #7 ·
  Undo`, Undo → attached again; a URL in the field → attached, its line `not fetched`, then the
  stand-in's state while the dialog stays open; ↻ → `gh` asked again. The title's click → the label
  dialog → saved → the new title in the header and the list (end to end through task 36). With
  `ticketUrl` in the configuration: the chip shows `↗`, its click → the stub got the address; ✎ →
  the group dialog; a group whose match holds `/` or `?` (pattern `^\S+`) → no link, the chip plain
  text; without `ticketUrl` the chip is plain text and only ✎ edits; no group → `+ group` opens the
  dialog. The note's line shows its first line sanitised, a click → the dialog with the whole note.
  Done → the row done, the toast, Undo → undone; a running session's Done → it stays under Open,
  marked `done`; Done clicked twice while its answer waits → one act. Dragging over the title, the
  ticket link, a pull request or the note's line selects it and opens nothing; a selected title
  stays selected through a list that changes another text; a button's click leaves the keyboard
  where it was; only merged ones attached → `Pull requests`, no hint. The dialog's refusals and
  waits as in Behaviour: a double click on × with the list before the answer and after it, a slow
  click while the line is still there, a drag held 1.2 s over `checked 5s ago`, a press held 2.5 s
  on it while the field has the keyboard, a list during a press, a `dragend`, ↻ and × from the
  keyboard, a × forgotten by its list, by the close and by an `ok` after the close; Enter held on
  Note types nothing into the note, a fresh Enter does; a double click on Done of a running session
  whose list and answer come before its second click sends one `done` (review 2). A hostile title, group, note line, pull
  request's repository, title and error and ticket address appear as text and create no element.
- `header.test.ts`, the order of `list` and `result` (ruled 06:38Z): on the real server, a quiet
  page (no list for 1.5 s), `d` on a row of This week → the list of the write comes before the
  answer, and the next row of This week is selected.
- `cards.test.ts`: the cases that pinned stage A's header follow it — the chip on the pull requests'
  line; the three cases that took `#cards button` for the card's own button (the header has buttons
  now) name the card's; stage A's one-height case holds as it is.

**Done when:** every element of S2 12.5 is in the header or the pull-request dialog and does its
action; the header has one height for every session and width; the ticket link opens only what
S2 12.5 allows; `npm run check` passes.

**Not in it:** attention in the state pill (stage B); the header and the ended bar of a session the
filter hides (section 5).

---

### Task 39: Documentation of stage D

**Depends on:** all · **Wave:** 4 · **Design:** S2 12.5, 12.9, 16.4, 18, 19 · **Contracts:** — · **Decisions:** —

**Goal.** A user can edit in the window and set the ticket link from the documents alone, and
knows which checks only they can make.

**Files**
- Modify: `docs/install.md`, `docs/manual-checks.md`, `README.md`; `docs/design-step-2.md` (S2 18
  gains W27–W29 below; S2 19's stage D line names them)

**Content (contract)**
- `docs/install.md`: in "Using the window", editing: the keys `l` (F2), `g`, `n`, `p`, `d`, the
  header's lines and controls, the dialogs (Enter, Ctrl+Enter, Esc twice for a changed note, the
  chords that wait while one is open), the Undo toasts, the selection after `d`, the pull-request
  dialog and the window's chip; the configuration table's `ticketUrl` row with an example
  (`"https://example.atlassian.net/browse/{key}"`), its refusal line, that the server reads it
  when it starts (`skydeck window --restart`), and `show`'s `ticket:` line. "Updating while the
  window runs" names the one resize every open terminal gets after the update to stage D (the
  header is taller than stage A's). "Known limits of stage D": a CR line break comes back as LF
  (D3); a note over 64 KiB is edited with `skydeck note` only (D5); label, group and done are
  last-write-wins between two windows (D9); the Undo toast takes a click; a session the filter
  hides has no header and so no editing (section 5); text in a dialog is lost when the page
  reloads for a new build.
- `README.md`: one sentence in the window's paragraph — label, group, note, pull requests and the
  ticket link in the window.
- `docs/manual-checks.md`: a part "The window (step 2, stage D)" with W27–W29, each with what to
  set up, what to type, what to look at and what to write down. Every step uses the throwaway
  session of stage A's part ("A throwaway session in the window"), never a real work session, and
  before each key or click the user checks that the header's short id, or the dialog's heading, is
  the throwaway session's (`l` and Enter on a real row replace its label for good). After `d` the
  selection moves to the next row, which may be a real session: press Undo before the next key.
  W27 first copies `config.json` when it exists (`cp ~/.config/skydeck/config.json
  ~/.config/skydeck/config.json.before-w27`) and ends by putting the copy back or removing the key
  (and `skydeck window --restart`); it says that a mistake in the file makes every command name the
  key and exit 1, and nothing else. W28 attaches a pull request of the user's own and detaches it
  at the end. No step marks a real session done, edits a real note or closes a window.

| # | Check | Stage | Decides |
|---|---|---|---|
| W27 | With `ticketUrl` set to the user's ticket system's address and the throwaway session labelled with one of their ticket keys, the group chip shows `↗` and a click opens that ticket in their main Edge window, logged in; without `ticketUrl` the chip is plain text. | D | 12.5, 9.6 |
| W28 | `+ PR` with a pull request of the user's own on the throwaway session: its item and its line in the pull-request dialog show its state within seconds (their `gh` login), the list's chip agrees, `skydeck show` agrees; × detaches it. | D | 12.3, 12.5 |
| W29 | On the user's layouts (US, Czech): `l`, F2, `g`, `n`, `p` and `d` in the list; Enter saves a label, Ctrl+Enter a note, Esc twice discards a changed note; Undo in the toast brings the session back; `skydeck show <short id>` in a WSL terminal shows the same label, group and note. With changed text in the note's dialog, F5 and the keyboard's refresh key do not reload the window; if one does, the text is lost — write down which key, and report it (the reload guard of D2 does not hold in Edge for it). | D | 12.5, 12.9 |

**Steps**
- [ ] Check the new text against the code and the tests, never by running it: `show`'s lines are
      held by task 35's sandbox tests; `skydeck window` and every other command of the text are
      never run outside the test suite (the user's server runs on the default port).
- [ ] `npm run check` → pass. Open the pull request.

**Done when:** the user can use stage D from `docs/install.md` alone, and W27–W29 are in
`docs/manual-checks.md` and S2 18.

**Not in it:** code and tests; running any `skydeck` command; the checks of stages B, C and E.

## 4. Design coverage

| Design | Where |
|---|---|
| S2 8.2.3, the `act` kinds `label`, `group`, `note`, `done`, `undone`, `pr-add`, `pr-rm`, `pr-refresh` | 34 (types, limits), 36 (acting), 37 and 38 (sending) |
| S2 9.6, pull-request and ticket links | 35 (`linkToOpen` shared), 38, through stage A's `open-link` and its check |
| S2 10.1, the reload after a write | 36 (D7) |
| S2 12.3, the window's chip | 34 |
| S2 12.5, the header at one height and editing | 36 (rules), 37 (dialogs), 38 (header, the pull-request dialog's list); the ticket link 35, 36, 38 |
| S2 12.9, `l`, `g`, `n`, `p`, `d`, F2, the dialogs' focus, the selection after `d`, the key help | 37 |
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
Ctrl+Shift+P (E) still say they come later; in `web/app.js` it adds the dialogs, the toast and the
new list keys, and the dialogs' modal rule (D2) holds for whatever chords B and E bring; the
header keeps one height, so the size a terminal of stage C's restore starts at (`focus.area`) is
right for every session; the header leaves the state pill as it is, where B's attention will
show; in the list it changes only the chip, where B adds attention and E stacks and chips; in
`src/window/tick.ts` it adds only `reloadNow`, beside which B reads turn ends. No migration, no
new store key. Section 1's table lists every file of every task, for the lead's check against
stages B and C.

**Two follow-ups on stage D's path** (from the lead's list of what stage A left):
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

No `npm ci`, no `install` again. Every open terminal is resized once after the update: the header
is two lines taller than stage A's, and from then on its height never changes. The ticket link, if
you want it: add one key to `~/.config/skydeck/config.json` (create the file if it does not exist:
`{ }` with the key in it), your ticket system's address with `{key}` where the key goes, for Jira
`"ticketUrl": "https://<your site>.atlassian.net/browse/{key}"`; then `skydeck window --restart`
(the server reads the configuration when it starts) and `skydeck show <ref>` prints the `ticket:`
line. A mistake in the file makes every command say which key, and nothing else.

**What only you can check** (task 39's W27–W29, with the throwaway session):

- W27 — the group chip opens your ticket in your own Edge window, logged in.
- W28 — `+ PR` with one of your pull requests shows its state within seconds, through your `gh`.
- W29 — the keys `l`, F2, `g`, `n`, `p`, `d` on your US and Czech layouts; Ctrl+Enter in the note;
  Undo. After `d` the selection moves to the next row: press Undo before the next key.
- And three choices the lead made for you, each yours to change: the header's two fixed lines
  with the rest in the pull-request and note dialogs (S2 12.5), the chip that only opens the
  ticket while ✎ and `g` edit the group (S2 12.5), and the selection after `d` (S2 12.9).

## 7. Questions for the lead, and the rulings

Asked with the first version of this plan; the lead ruled on 2026-11-15 (01:10Z, with review A's
findings, all taken), and the plan above follows the rulings.

1. **The header's height.** Ruled: one height for every session and width, stage A's plus two
   lines (pull requests, note); the rest in dialogs over the page; `area()` unchanged. S2 12.5
   changed in this pull request (D12, D13).
2. **The selection after `d`.** Ruled: the proposal, with review A's four conditions (D15). S2
   12.9 changed in this pull request.
3. **A kept note file.** Ruled: as planned (D10).
4. **The ticket chip.** Ruled: it opens the ticket when there is a link and is plain text
   otherwise; it never edits; ✎ and `g` edit the group (D14). S2 12.5 changed in this pull
   request.
5. **`show --json`.** Ruled: unchanged (D16).
6. **`pr-refresh` and the header's facts.** Ruled: in task 38 (D11).

Also ruled from review A: the `ticketUrl` check is the URL parser's (S2 16.4, task 35, D18); the
dialogs move the keyboard nowhere (D2); one explicit fetch at a time (D8); a save sent twice is
`ok` (D9); the safety tests of task 36; `d` and Done act once (D15); × has an Undo (D13); only
buttons cancel their mousedown (D17); the design says "asked for by the user on 2026-11-15; the
details ruled by the lead that day"; task 39 runs no command outside the suite; W27–W29 check the
short id first and Undo after `d`.

Ruled from review B (01:11Z, all taken): `header(row, selected, term, now)` with `selected` for
every pane and in the render key, the terminal's `openedNs`, `serverNow` shared and the ages
repainted on a tick (D6, 2.4; this settles review A's open choice for "opened"); the editor's
`closed()` (D2, 2.4); section 1 names every file of every task, the design's sections per task
and what each task does to the shared test files; task 39 runs no command (its `ticket:` line is
held by task 35's tests); task 36's message comparison drops the `skydeck: ` prefix and its `gh`
stand-in can hold an answer until the run's signal fires; W29 uses `skydeck show` and checks the
reload keys with changed text; `overLimit` names 65,536; task 39 has its "Not in it"; task 37
stays whole; the plan names no file outside the repository.

Ruled after the plan was merged, and written into this text by task 37's pull request: Attach's
`ok` keeps the pull-request dialog open (D13); the selection after `d` moves only while the done
session is still selected, and the Undo of that `d` selects it again (D15, S2 12.9);
`recording-cards.js` is a whole cards module; the held Enter or Esc over a terminal is a named
case; `overLimit` refuses text that is not well formed (task 34's review 2); the gate every window
chord passes is one function, `windowChordGate` (2.4), for stages B, C and E — its name
confirmed on task 37's review 1, since tasks 55, 75 and 98 code against it. Ruled on the same
review, beyond the earlier text: the key that opened a dialog types nothing into it while held
(D2, S2 12.9); a click inside a dialog that selects nothing gives the keyboard back to its field
(D2, D17); the key help carries a note on the dialogs. Ruled on its review 2: a held key that
closed a dialog acts on nothing by its repeats (an Enter over the list resumes nothing); the field
takes the keyboard back whenever nothing has it; an IME's Enter and Esc are the IME's; C1, C2 (c)
and C4 as D2 says; the selection after `d` and C1 decide on the list that holds the act's result
(D15); after an unfollowed `ok` the page asks for that list (M2, ruled 07:38Z; also for `d`, S3, ruled 08:15Z, where a list that still shows the row as not done holds no result); S2 12.9's limit (a) says that the prompt holds the text; a busy store's stale list is a named limit for the dialogs. The pull-request dialog's buttons are
Close and Attach (D1, D13); `web/edit.css` gives the key help its stacking level over a dialog,
`web/style.css` untouched.
