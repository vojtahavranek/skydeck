// The terminal view (S2 9, 12.6) — the smallest working version, replaced by task 28 (plan A16):
// it attaches the terminal it is shown, keeps every terminal it attached attached (detaching all
// but the shown one while the window is hidden), and says that the real view comes later. Its
// interface is contract 2.9's.

/** @import { ExitMessage, SizeMessage, SnapMessage, TerminalPayload } from '../src/window/protocol.ts' */

/**
 * @typedef {object} TerminalViewDeps
 * @property {(message: Record<string, unknown> & { t: string }) => void} send
 * @property {(e: KeyboardEvent) => boolean} chord
 * @property {(url: string) => void} openLink
 */

/**
 * @param {HTMLElement} root
 * @param {TerminalViewDeps} deps
 */
export function createTerminalView(root, deps) {
  /** @type {Set<string>} */
  const attached = new Set();
  /** @type {TerminalPayload | null} */
  let shown = null;
  let hidden = false;
  const placeholder = document.createElement('div');
  placeholder.className = 'terminal-placeholder';
  placeholder.tabIndex = -1;

  /** @param {TerminalPayload} term */
  const attach = (term) => {
    attached.add(term.id);
    deps.send({ t: 'attach', term: term.id, cols: term.cols, rows: term.rows });
  };

  return {
    /** @param {TerminalPayload | null} term */
    show(term) {
      shown = term;
      if (term === null) {
        root.replaceChildren();
        return;
      }
      if (!attached.has(term.id)) {
        attach(term);
      }
      placeholder.textContent = `terminal view comes with task 28 (terminal ${term.id}, ${term.state}, ${term.cols} × ${term.rows})`;
      if (placeholder.parentElement !== root) {
        root.replaceChildren(placeholder);
      }
    },
    /** @param {SnapMessage} _msg */
    snap(_msg) {},
    /**
     * @param {number} _channel
     * @param {Uint8Array} _bytes
     */
    output(_channel, _bytes) {},
    /** @param {SizeMessage} _msg */
    size(_msg) {},
    /** @param {ExitMessage} _msg */
    exit(_msg) {},
    /**
     * @param {string} _term
     * @param {'gap' | 'input-full' | 'newer-keeper'} _kind
     * @param {string} _text
     */
    notice(_term, _kind, _text) {},
    find() {},
    copy() {},
    pasteRaw() {},
    focus() {
      if (shown !== null) {
        placeholder.focus();
      }
    },
    /** @param {boolean} isHidden */
    setHidden(isHidden) {
      if (isHidden === hidden) {
        return;
      }
      hidden = isHidden;
      if (!hidden) {
        if (shown !== null && !attached.has(shown.id)) {
          attach(shown);
        }
        return;
      }
      for (const id of [...attached]) {
        if (id !== shown?.id) {
          attached.delete(id);
          deps.send({ t: 'detach', term: id });
        }
      }
    },
    /** @returns {string[]} */
    attached: () => [...attached],
  };
}
