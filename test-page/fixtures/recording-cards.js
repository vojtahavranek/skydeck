// Test fixture: test-page/fixtures/minimal-cards.js (a verbatim copy of web/cards.js at 40f7886)
// that also records, on the page, every `header(…)` call's arguments and the deps app.js gives
// the cards — a whole cards module, since app.js calls every member of contract 2.9 on it
// (ruled for plan D task 37). test-page/edit.test.ts pins it with pinModules in place of
// web/cards.js, so that a test sees what app.js passes (plan D 2.4):
// - `globalThis.headerCalls`: one entry per call, `{ row, selected, term, now }` — `now` the
//   value `now()` gave at the call ('' when no function came);
// - `globalThis.headerNow`: the last call's `now` function;
// - `globalThis.cardsDeps`: the deps (`act`, `select`, and stage D's `edit`, `done`, `say`), so
//   that a test can do what the header's controls of task 38 will do.
//
// The right side's header and cards (S2 7.8, 7.9, 12.5, 12.6) — the smallest working version,
// replaced by task 29 (plan A16): a header line, the resume card with its button, the card of a
// session running elsewhere, the ended bar and a plain new form. Its interface is contract 2.9's.
// Every server string through textContent.
//
// How app.js calls it: on a change of what the right side shows, `hide()` (every card and the
// header), then `header(row)` and at most one card. `act` is app.js's: it adds `t` and `id`, and
// for `resume` and `new` the size of the terminal area when the action carries none; a
// successful resume or new selects its session there.

/** @import { ExitMessage, ResultMessage, RowPayload, SelectedPayload } from '../src/window/protocol.ts' */

/**
 * @typedef {object} CardsDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(id: string) => void} select
 */

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/**
 * @param {HTMLElement} root
 * @param {CardsDeps} deps
 */
export function createCards(root, deps) {
  /** @type {unknown[]} */
  const calls = [];
  Reflect.set(globalThis, 'headerCalls', calls);
  Reflect.set(globalThis, 'cardsDeps', deps);
  const head = element('div', 'card-header');
  const card = element('div', 'card');
  root.replaceChildren(head, card);
  head.hidden = true;
  card.hidden = true;

  /**
   * Shows `parts` as the one card; returns the card's line for results.
   * @param {HTMLElement[]} parts
   * @returns {HTMLElement}
   */
  const showCard = (parts) => {
    const lines = element('div', 'card-lines');
    card.replaceChildren(...parts, lines);
    card.hidden = false;
    return lines;
  };

  /**
   * @param {HTMLElement} lines
   * @param {ResultMessage} result
   */
  const showResult = (lines, result) => {
    lines.textContent = result.ok
      ? result.lines.join('\n')
      : (result.error ?? result.lines.join('\n'));
  };

  return {
    /**
     * @param {RowPayload | null} row
     * @param {unknown} [selected]
     * @param {unknown} [term]
     * @param {() => string} [now]
     */
    header(row, selected, term, now) {
      calls.push({
        row,
        selected: selected ?? null,
        term: term ?? null,
        now: typeof now === 'function' ? now() : '',
      });
      Reflect.set(globalThis, 'headerNow', now);
      if (row === null) {
        head.hidden = true;
        return;
      }
      head.textContent = `${row.title} · ${row.state}${row.dir === null ? '' : ` · ${row.dir}`}`;
      head.hidden = false;
    },
    /**
     * @param {RowPayload} row
     * @param {SelectedPayload | null} selected
     * @param {string[]} resultLines
     */
    resumeCard(row, selected, resultLines) {
      const command = element(
        'div',
        'card-command',
        selected?.command ?? 'skydeck cannot print the command for this session',
      );
      const button = /** @type {HTMLButtonElement} */ (
        element('button', 'card-button', 'Resume here')
      );
      button.disabled = selected?.expired === true;
      const lines = showCard([command, button]);
      lines.textContent = resultLines.join('\n');
      button.addEventListener('click', () => {
        void deps
          .act({ kind: 'resume', sessionId: row.id })
          .then((result) => showResult(lines, result));
      });
    },
    /** @param {RowPayload} row */
    elsewhere(row) {
      const where = row.elsewhere;
      showCard([
        element(
          'div',
          'card-elsewhere',
          `running in another terminal${where === null ? '' : ` (pid ${where.pid}${where.tty === null ? '' : `, ${where.tty}`})`}; it cannot be shown here`,
        ),
      ]);
    },
    /**
     * @param {RowPayload | null} row
     * @param {ExitMessage | null} exit
     */
    endedBar(row, exit) {
      const how =
        exit === null
          ? 'the program ended'
          : exit.notStarted !== null
            ? `claude was not started: ${exit.notStarted}`
            : exit.code !== null
              ? `claude exited (status ${exit.code})`
              : `claude ended by signal ${exit.signal}`;
      const parts = [element('span', 'card-ended', how)];
      /** @type {HTMLElement | null} */
      let lines = null;
      if (row !== null) {
        const resume = element('button', 'card-button', 'Resume');
        resume.addEventListener('click', () => {
          void deps.act({ kind: 'resume', sessionId: row.id }).then((result) => {
            if (lines !== null) showResult(lines, result);
          });
        });
        parts.push(resume);
        if (row.terminal !== null) {
          const term = row.terminal;
          const close = element('button', 'card-button', 'Close');
          close.addEventListener('click', () => {
            void deps.act({ kind: 'close-terminal', term }).then((result) => {
              if (lines !== null) showResult(lines, result);
            });
          });
          parts.push(close);
        }
      }
      lines = showCard(parts);
    },
    /** @param {{ dir: string, dirs: string[] }} defaults */
    newForm(defaults) {
      const form = /** @type {HTMLFormElement} */ (element('form', 'card-new'));
      /**
       * @param {string} name
       * @param {string} value
       * @returns {HTMLInputElement}
       */
      const field = (name, value) => {
        const input = /** @type {HTMLInputElement} */ (element('input', 'card-field'));
        input.name = name;
        input.placeholder = name;
        input.value = value;
        return input;
      };
      const dir = field('directory', defaults.dir);
      const label = field('label', '');
      const group = field('group', '');
      const flags = field('flags', '');
      const start = element('button', 'card-button', 'Start');
      form.append(dir, label, group, flags, start);
      const lines = showCard([element('div', 'card-title', 'New session'), form]);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void deps
          .act({
            kind: 'new',
            dir: dir.value,
            label: label.value,
            group: group.value,
            flags: flags.value,
          })
          .then((result) => showResult(lines, result));
      });
      dir.focus();
    },
    hide() {
      // Hidden, not removed: what had the keyboard in it is given back by app.js.
      head.hidden = true;
      card.hidden = true;
    },
  };
}
