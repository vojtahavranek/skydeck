// Follow-up F40 (design 7.1, S2 12.6, 12.9): the carry-over bar — under the header, above the
// terminal or the card of a session that `/clear` started out of another one —, which offers to
// copy the old session's fields to it. The page decides no rule (S2 4.3): whether there is an
// offer, what it lists, which ticks it starts with and what may be carried are the server's
// (`list.selected.carryOver`); this module keeps only the ticks while the same offer (`rev`) is
// drawn, and sends one act per press.
//
// - One set of elements, made once and never replaced (put into the host at the first offer): a
//   render only sets texts, `checked` and `hidden`, so a control that has the keyboard keeps it
//   through every list.
// - No keyboard on a click: the bar's mousedown is cancelled everywhere but on its three texts
//   (the heading, the kept line, the message), which stay selectable; a click on a label's text
//   ticks its box without focusing it. focus() is called only for the list's `c` (`focus()`) and
//   to keep the keyboard inside the bar, never on a click.
// - The keyboard on the bar never falls into the terminal (S2 12.9): a checkbox that a new `rev`
//   hides hands the keyboard to the next visible checkbox, else the one before; a new `rev` takes
//   it off a button to the first checkbox; the bar going away with the keyboard on it gives it to
//   the list (`back`); Tab and Shift+Tab move among the bar's visible controls and wrap, always
//   cancelled (a focus trap); Esc gives the keyboard to the list. app.js keeps the page in the
//   list zone while a control of the bar has the keyboard, and swallows a held Enter's repeats.
// - The message (`carrying over…`, a refusal) lies over the heading on one line, so the bar's
//   height changes only when it comes and when it goes.
// Every text reaches the DOM through textContent.

/** @import { CarryField, CarryOverPayload, ResultMessage, RowPayload } from '../src/window/protocol.ts' */
import {
  APPLY_TEXT,
  DISMISS_TEXT,
  DISMISS_TITLE,
  DONE_TEXT,
  NOT_CARRIED,
  WAITING_TEXT,
  carryHeading,
  fieldText,
  keptText,
} from './carry-over-text.js';

/**
 * @typedef {object} CarryDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 *   app.js's: it adds `t` and `id`
 * @property {(text: string) => void} say a line in the key bar
 * @property {() => void} back gives the keyboard to the list (app.js's `setZone('list')`)
 */

/** The five fields, in the bar's order. @type {readonly CarryField[]} */
const FIELDS = ['label', 'group', 'ticket', 'note', 'prs'];
const REV = /^[0-9a-f]{16}$/;

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
 * @param {HTMLElement} target
 * @param {string} text
 */
function setText(target, text) {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

/**
 * @param {HTMLElement} target
 * @param {boolean} hidden
 */
function setHidden(target, hidden) {
  if (target.hidden !== hidden) {
    target.hidden = hidden;
  }
}

/**
 * @param {unknown} value
 * @returns {value is CarryField}
 */
function isField(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (FIELDS).includes(value);
}

/**
 * The offer as this page can use it, or null: a `rev` that is not 16 hex digits, an unknown or
 * repeated field name, no field at all, or a member of the wrong type is an offer the page does
 * not draw (the server would close the connection for its act).
 * @param {unknown} value
 * @returns {CarryOverPayload | null}
 */
export function offerOf(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const offer = /** @type {Record<string, unknown>} */ (value);
  const from = /** @type {Record<string, unknown> | null} */ (
    typeof offer['from'] === 'object' ? offer['from'] : null
  );
  if (
    typeof offer['rev'] !== 'string' ||
    !REV.test(offer['rev']) ||
    from === null ||
    typeof from['id'] !== 'string' ||
    typeof from['title'] !== 'string' ||
    !(from['ticket'] === null || typeof from['ticket'] === 'string') ||
    !Array.isArray(offer['fields']) ||
    offer['fields'].length === 0 ||
    !Array.isArray(offer['kept']) ||
    !Number.isSafeInteger(offer['prs']) ||
    /** @type {number} */ (offer['prs']) < 0
  ) {
    return null;
  }
  /** @type {CarryOverPayload['fields']} */
  const fields = [];
  const seen = new Set();
  for (const item of offer['fields']) {
    const field = /** @type {Record<string, unknown> | null} */ (
      typeof item === 'object' ? item : null
    );
    if (
      field === null ||
      !isField(field['name']) ||
      seen.has(field['name']) ||
      !(field['text'] === null || typeof field['text'] === 'string') ||
      typeof field['ticked'] !== 'boolean'
    ) {
      return null;
    }
    seen.add(field['name']);
    fields.push({ name: field['name'], text: field['text'], ticked: field['ticked'] });
  }
  const kept = offer['kept'];
  if (!kept.every(isField)) {
    return null;
  }
  const done = offer['done'];
  if (!(
    done === null ||
    (typeof done === 'object' &&
      typeof (/** @type {{ ticked?: unknown }} */ (done).ticked) === 'boolean')
  )) {
    return null;
  }
  return {
    from: { id: from['id'], title: from['title'], ticket: from['ticket'] },
    fields,
    prs: /** @type {number} */ (offer['prs']),
    kept: [...kept],
    done: done === null ? null : { ticked: /** @type {{ ticked: boolean }} */ (done).ticked },
    rev: offer['rev'],
  };
}

/**
 * A held Enter never presses a button again: its auto-repeats are cancelled.
 * @param {KeyboardEvent} event
 */
function refuseHeldEnter(event) {
  if (event.repeat && event.key === 'Enter') {
    event.preventDefault();
  }
}

/**
 * @param {HTMLElement} host the bar's element, which app.js puts between `#cards`'s header and card
 * @param {CarryDeps} deps
 */
export function createCarryOver(host, deps) {
  const headBox = element('span', 'carry-head');
  const heading = element('span', 'carry-heading');
  const message = element('span', 'carry-message');
  headBox.append(heading, message);
  /** Each field's checkbox, its label and its words. @type {Map<CarryField, { label: HTMLElement, box: HTMLInputElement, text: HTMLElement }>} */
  const checks = new Map();
  /**
   * @param {string} name
   * @returns {{ label: HTMLElement, box: HTMLInputElement, text: HTMLElement }}
   */
  const checkbox = (name) => {
    const label = element('label', 'carry-field');
    label.dataset['field'] = name;
    const box = /** @type {HTMLInputElement} */ (element('input', 'carry-check'));
    box.type = 'checkbox';
    const text = element('span', 'carry-field-text');
    label.append(box, text);
    return { label, box, text };
  };
  for (const name of FIELDS) {
    checks.set(name, checkbox(name));
  }
  const kept = element('span', 'carry-kept');
  const done = checkbox('done');
  done.label.classList.add('carry-done');
  setText(done.text, DONE_TEXT);
  const apply = /** @type {HTMLButtonElement} */ (
    element('button', 'card-button primary carry-apply', APPLY_TEXT)
  );
  apply.type = 'button';
  const dismiss = /** @type {HTMLButtonElement} */ (
    element('button', 'card-button carry-dismiss', DISMISS_TEXT)
  );
  dismiss.type = 'button';
  dismiss.title = DISMISS_TITLE;
  dismiss.setAttribute('aria-label', DISMISS_TITLE);
  // The elements are made here, once, and put into the host when the first offer is drawn: until
  // then the right side holds no control of the bar (an empty, hidden host).
  const elements = [
    headBox,
    ...FIELDS.map((name) => /** @type {HTMLElement} */ (checks.get(name)?.label)),
    kept,
    done.label,
    apply,
    dismiss,
  ];
  host.hidden = true;

  /** The pane's session and its offer as last rendered. */
  /** @type {string | null} */
  let sessionId = null;
  /** @type {CarryOverPayload | null} */
  let offer = null;
  /** The (session, rev) the ticks are of ('' before any). */
  let tickedKey = '';
  /** The page's ticks while that offer is drawn. @type {Map<CarryField | 'done', boolean>} */
  let ticks = new Map();
  /** The act that waits for its answer: 'carry' shows `carrying over…`; null when none waits. */
  /** @type {'carry' | 'dismiss' | null} */
  let waiting = null;
  /** The (session, rev) the waiting act is for: it is shown on that offer's bar only. */
  let waitingKey = '';
  /** The last refusal ('' when none), and the (session, rev) it is of: shown on that bar only. */
  let refusal = '';
  let refusalKey = '';
  /** The ticks' generation: it goes up at every restart of the ticks (a new offer, a new `rev`,
   *  also one that comes back to an earlier `rev`). */
  let generation = 0;
  /** The generation under which a control of the bar last had the keyboard: a button that gets
   *  the keyboard under another one gives it to the first checkbox (rule 3). */
  let seenGeneration = -1;
  /** What had the keyboard when a press on one of the bar's texts began, until its click ends. */
  /** @type {Element | null} */
  let pressFrom = null;
  /** The (session, rev) pairs answered `ok` here: hidden at once, before the list comes. */
  const answered = new Set();
  /** A new `rev` came while a button had the keyboard: the next draw gives it to the first box. */
  let toFirst = false;

  /** @returns {string} */
  const keyOf = () => (offer === null || sessionId === null ? '' : `${sessionId} ${offer.rev}`);

  /** Whether an act for the offer drawn now waits for its answer. */
  function busyHere() {
    return waiting !== null && waitingKey === keyOf();
  }

  /** Whether the bar is drawn for the offer as it stands. */
  function drawn() {
    return offer !== null && sessionId !== null && !answered.has(keyOf());
  }

  /** The bar's controls in their order: the five field checkboxes, done, the two buttons. */
  function controls() {
    return [
      ...FIELDS.map((name) => /** @type {HTMLElement} */ (checks.get(name)?.box)),
      done.box,
      apply,
      dismiss,
    ];
  }

  /**
   * The bar's visible controls, in their order.
   * @returns {HTMLElement[]}
   */
  function visibleControls() {
    return controls().filter((control) => control.closest('[hidden]') === null);
  }

  /**
   * The checkboxes the offer shows, in their order.
   * @param {CarryOverPayload} shown
   * @returns {HTMLInputElement[]}
   */
  function boxesOf(shown) {
    const offered = new Set(shown.fields.map((field) => field.name));
    const boxes = FIELDS.filter((name) => offered.has(name)).map(
      (name) => /** @type {HTMLInputElement} */ (checks.get(name)?.box),
    );
    return shown.done === null ? boxes : [...boxes, done.box];
  }

  function draw() {
    const show = drawn();
    const active = document.activeElement;
    const hasKeyboard = active instanceof HTMLElement && host.contains(active);
    const first = toFirst;
    toFirst = false;
    if (!show) {
      // Rule 4: the bar goes away under the keyboard: the list takes it first.
      if (hasKeyboard) {
        deps.back();
      }
      setHidden(host, true);
      return;
    }
    const shown = /** @type {CarryOverPayload} */ (offer);
    const all = [...FIELDS, 'done'];
    const wanted = new Set(boxesOf(shown));
    // First show what the offer adds, so that the keyboard can be given to it.
    for (const name of all) {
      const field = name === 'done' ? done : checks.get(/** @type {CarryField} */ (name));
      if (field !== undefined && wanted.has(field.box)) {
        setHidden(field.label, false);
      }
    }
    if (host.firstChild === null) {
      host.replaceChildren(...elements);
    }
    setHidden(host, false);
    if (first && hasKeyboard) {
      boxesOf(shown)[0]?.focus();
    } else if (hasKeyboard) {
      const order = [
        ...FIELDS.map((name) => /** @type {HTMLInputElement} */ (checks.get(name)?.box)),
        done.box,
      ];
      const at = order.indexOf(/** @type {HTMLInputElement} */ (active));
      if (at !== -1 && !wanted.has(order[at] ?? done.box)) {
        // Rule 3: a checkbox that goes away hands the keyboard to the next one shown, else the one
        // before it; there always is one.
        const next =
          order.slice(at + 1).find((box) => wanted.has(box)) ??
          order
            .slice(0, at)
            .reverse()
            .find((box) => wanted.has(box));
        next?.focus();
      }
    }
    for (const name of all) {
      const field = name === 'done' ? done : checks.get(/** @type {CarryField} */ (name));
      if (field !== undefined && !wanted.has(field.box)) {
        setHidden(field.label, true);
      }
    }
    setText(heading, carryHeading(shown.from));
    for (const field of shown.fields) {
      const parts = checks.get(field.name);
      if (parts === undefined) continue;
      setText(parts.text, fieldText(field, shown.prs));
      const checked = ticks.get(field.name) === true;
      if (parts.box.checked !== checked) {
        parts.box.checked = checked;
      }
    }
    const doneTicked = ticks.get('done') === true;
    if (done.box.checked !== doneTicked) {
      done.box.checked = doneTicked;
    }
    const keptWords = keptText(shown.kept);
    setText(kept, keptWords);
    setHidden(kept, keptWords === '');
    const here = keyOf();
    const waitsHere = busyHere();
    const words =
      waiting === 'carry' && waitsHere ? WAITING_TEXT : refusalKey === here ? refusal : '';
    setText(message, words);
    message.title = words;
    message.dataset['kind'] = waiting === 'carry' && waitsHere ? 'waiting' : 'refusal';
    setHidden(message, words === '');
    headBox.dataset['message'] = String(words !== '');
    const busy = String(waitsHere);
    for (const control of controls()) {
      if (control.getAttribute('aria-disabled') !== busy) {
        control.setAttribute('aria-disabled', busy);
      }
    }
    if (host.contains(document.activeElement)) {
      seenGeneration = generation; // the keyboard is on the bar while these ticks are drawn
    }
  }

  // No keyboard on a click: a press anywhere on the bar but on its three texts is cancelled. A
  // press on a text is let through, so that a drag selects it; a click on one that selects
  // nothing gives the keyboard back to what had it (a control of the bar, the list, the
  // terminal), before app.js's rule for a click on the right side would move it.
  host.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest('.carry-heading, .carry-kept, .carry-message') === null
    ) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0) {
      // A right or a middle press moves no keyboard; the context menu still opens.
      event.preventDefault();
      return;
    }
    pressFrom = document.activeElement;
  });
  addEventListener('mouseup', () => {
    const from = pressFrom;
    pressFrom = null;
    if (from === null) {
      return;
    }
    setTimeout(() => {
      const selection = getSelection();
      if (selection !== null && !selection.isCollapsed) {
        return; // a drag selected text: it stays selected to be copied
      }
      if (
        from instanceof HTMLElement &&
        from !== document.body &&
        from.isConnected &&
        from.checkVisibility()
      ) {
        from.focus();
      }
    }, 0);
  });
  // Rule 3: a button that gets the keyboard under ticks the bar did not have the keyboard under
  // (a dialog gives it back after a new `rev` came under it, or one that went away and back)
  // hands it to the first checkbox, so that Enter never presses a button for an offer, or for
  // ticks, the user has not seen.
  // The move is made once the code that gave the keyboard is done (a dialog's close checks that
  // what it gave the keyboard to has it), and only while the button still has it.
  for (const button of [apply, dismiss]) {
    button.addEventListener('focus', () => {
      if (seenGeneration === generation && drawn()) {
        return;
      }
      queueMicrotask(() => {
        if (document.activeElement !== button) {
          return;
        }
        if (offer === null || !drawn()) {
          deps.back();
        } else if (seenGeneration !== generation) {
          boxesOf(offer)[0]?.focus();
        }
      });
    });
  }
  host.addEventListener('focusin', (event) => {
    if (event.target !== apply && event.target !== dismiss) {
      seenGeneration = generation; // a checkbox has the keyboard: the user sees these ticks
    }
  });
  for (const parts of [...checks.values(), done]) {
    const { label, box } = parts;
    // A click on the label's text would give its checkbox the keyboard: it ticks the box without
    // that, as a click on the box.
    label.addEventListener('click', (event) => {
      if (event.target !== box) {
        event.preventDefault();
        box.click();
      }
    });
    box.addEventListener('click', (event) => {
      if (busyHere()) {
        event.preventDefault(); // while the answer waits a checkbox takes no press
      }
    });
    const name = label.dataset['field'] ?? '';
    box.addEventListener('change', () => {
      ticks.set(/** @type {CarryField | 'done'} */ (name), box.checked);
      refusal = '';
      refusalKey = '';
      draw();
    });
  }
  for (const button of [apply, dismiss]) {
    button.addEventListener('keydown', refuseHeldEnter);
  }

  // The focus trap (rule 5): Tab and Shift+Tab move among the visible controls and wrap; Esc
  // gives the keyboard to the list.
  host.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || !controls().includes(target)) {
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const shown = visibleControls();
      const at = shown.indexOf(target);
      const count = shown.length;
      if (count === 0) return;
      const next = event.shiftKey ? shown[(at - 1 + count) % count] : shown[(at + 1) % count];
      next?.focus();
      return;
    }
    if (event.key === 'Escape' && !event.shiftKey) {
      event.preventDefault();
      deps.back();
    }
  });

  /**
   * A refused act's words: over the heading of its own offer's bar while it is drawn, and in the
   * key bar.
   * @param {string} key the (session, rev) the act was for
   * @param {ResultMessage} result
   */
  function refused(key, result) {
    refusal = result.error ?? result.lines[0] ?? NOT_CARRIED;
    refusalKey = key;
    deps.say(refusal);
  }

  /**
   * After an act's answer: `ok` hides the bar of that offer at once.
   * @param {string} key the (session, rev) the act was for
   * @param {ResultMessage} result
   */
  function answer(key, result) {
    if (waitingKey === key) {
      waiting = null;
      waitingKey = '';
    }
    if (result.ok) {
      answered.add(key);
    } else {
      refused(key, result);
    }
    draw();
  }

  // The second click of a double click is no second press: its offer is about to go.
  apply.addEventListener('click', (event) => {
    if (event.detail > 1 || busyHere() || !drawn() || offer === null || sessionId === null) {
      return;
    }
    const shown = offer;
    const fields = shown.fields
      .filter((field) => ticks.get(field.name) === true)
      .map((field) => field.name);
    const key = keyOf();
    waiting = 'carry';
    waitingKey = key;
    refusal = '';
    refusalKey = '';
    draw();
    void deps
      .act({
        kind: 'carry-over',
        sessionId,
        rev: shown.rev,
        fields,
        done: shown.done !== null && ticks.get('done') === true,
      })
      .then((result) => answer(key, result));
  });

  dismiss.addEventListener('click', (event) => {
    if (event.detail > 1 || busyHere() || !drawn() || sessionId === null) {
      return;
    }
    const key = keyOf();
    waiting = 'dismiss';
    waitingKey = key;
    refusal = '';
    refusalKey = '';
    draw();
    void deps.act({ kind: 'dismiss-carry-over', sessionId }).then((result) => answer(key, result));
  });

  return {
    /**
     * The pane's session (`row`, null for a pane without one) and the offer of `list.selected`
     * when it is that session's (null for none).
     * @param {RowPayload | null} row
     * @param {unknown} value
     */
    render(row, value) {
      const next = row === null ? null : offerOf(value);
      const before = keyOf();
      const active = document.activeElement;
      sessionId = next === null || row === null ? null : row.id;
      offer = next;
      const key = keyOf();
      if (key !== '' && key !== tickedKey) {
        // A new offer (or a new `rev`): the ticks start again from its own (a refusal and a wait
        // are shown on the bar of their own offer only).
        ticks = new Map(next?.fields.map((field) => [field.name, field.ticked]) ?? []);
        ticks.set('done', next?.done?.ticked === true);
        tickedKey = key;
        generation++;
        // Rule 3: a new `rev` takes the keyboard off a button to the first checkbox, so that an
        // Enter presses nothing for an offer the user has not seen.
        toFirst = before !== '' && (active === apply || active === dismiss);
      }
      draw();
    },

    /**
     * `c` in the list (S2 12.9): the first checkbox takes the keyboard while the bar is drawn.
     * @returns {boolean} whether it did
     */
    focus() {
      if (!drawn() || host.hidden || offer === null) {
        return false;
      }
      const first = boxesOf(offer)[0];
      first?.focus();
      return first !== undefined && document.activeElement === first;
    },

    /** Whether the bar is drawn. */
    shown() {
      return !host.hidden;
    },
  };
}
