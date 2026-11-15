/**
 * S2 12.4's seen, a condition that holds (B9): a session is being seen while it is the selected
 * one in a page that has focus, from 1.5 s after that began, or at once from a typing into its
 * terminal. The server's attention takes the sessions being seen at each write; this module
 * only keeps the holds, on the server's clock.
 */
import type { Clock } from '../platform/types.ts';

/** S2 12.4: how long a focused page's selection must hold before it is seen. */
export const SEEN_AFTER_MS = 1500;

/**
 * What a terminal sends that the user did not type: focus reports (`CSI I`, `CSI O`, mode 1004,
 * which Claude Code asks for: one at every click, chord and return to the window) and SGR mouse
 * reports (`CSI <` b;x;y `M` or `m`, modes 1006 and 1016). xterm.js's only other mouse encoding,
 * X10, comes as `binary`.
 */
const REPORTS = /\x1b\[[IO]|\x1b\[<[0-9;]+[Mm]/g;

/**
 * B9: whether an `input` message is typing: not `binary`, and something is left once every focus
 * report (`ESC [ I`, `ESC [ O`) and every SGR mouse report (`ESC [ <` digits and `;` then `M` or
 * `m`) is taken out. Pure.
 */
export function isTyping(data: string, binary: boolean): boolean {
  return !binary && data.replace(REPORTS, '') !== '';
}

export interface Seen {
  /** A page's focus and selection now (its `start`: selected null; its `focus`). A change of
   *  either starts the page's 1.5 s again (Clock.after: a timer, which no wall-clock step moves);
   *  the same two again (a new area) change nothing. */
  focus(page: object, focused: boolean, selected: string | null): void;
  /** Typing (isTyping; pages.ts calls it for no other input) into a terminal that shows
   *  `sessionId`: seen at once — held, when it is the page's selection and the page has focus;
   *  else once, in the next take(). */
  typed(page: object, sessionId: string): void;
  /** The page ended: its hold goes, and later calls for it change nothing. */
  gone(page: object): void;
  /** The sessions being seen now: held by a focused page for 1.5 s or since a typing, and those
   *  typed into since the last call (given once). */
  take(): Set<string>;
  /** A session began to be seen (a hold completed, a typing). Listeners must not throw; a throw
   *  out of a completed hold is dropped so that the timer cannot end the server; `typed` throws
   *  only if a listener throws. */
  onChange(listener: () => void): () => void;
  /** Every timer stopped (the server's stop); nothing is seen or told after it. */
  stop(): void;
}

/** One page's part. */
interface Hold {
  focused: boolean;
  selected: string | null;
  /** The hold completed (1.5 s, or a typing): `selected` is being seen. */
  held: boolean;
  /** Cancels the running 1.5 s; null when none runs. */
  cancel: (() => void) | null;
}

export function createSeen(clock: Clock): Seen {
  const holds = new Map<object, Hold>();
  /** Typed into, not held: given once, by the next take(). */
  const typedOnce = new Set<string>();
  const listeners = new Set<() => void>();
  /** Pages told gone: a call that comes after its page's end must not start a hold nothing ends. */
  const ended = new WeakSet<object>();
  let stopped = false;

  /** Tells every listener (a copy: one may end its own subscription). */
  const tell = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const release = (hold: Hold): void => {
    hold.cancel?.();
    hold.cancel = null;
    hold.held = false;
  };

  return {
    focus(page, focused, selected) {
      if (stopped || ended.has(page)) return;
      let hold = holds.get(page);
      if (hold !== undefined && hold.focused === focused && hold.selected === selected) return;
      if (hold === undefined) {
        hold = { focused, selected, held: false, cancel: null };
        holds.set(page, hold);
      } else {
        release(hold);
        hold.focused = focused;
        hold.selected = selected;
      }
      if (focused && selected !== null) {
        const own = hold;
        own.cancel = clock.after(SEEN_AFTER_MS, () => {
          own.cancel = null;
          own.held = true;
          try {
            tell();
          } catch {
            // Dropped: Clock.after's callback must not throw (a throw there would end the server);
            // the listener logs its own failures (ruled, task 53).
          }
        });
      }
    },
    typed(page, sessionId) {
      if (stopped || ended.has(page)) return;
      const hold = holds.get(page);
      if (hold !== undefined && hold.focused && hold.selected === sessionId) {
        hold.cancel?.();
        hold.cancel = null;
        hold.held = true;
      } else {
        typedOnce.add(sessionId);
      }
      tell();
    },
    gone(page) {
      ended.add(page);
      const hold = holds.get(page);
      if (hold !== undefined) {
        release(hold);
        holds.delete(page);
      }
    },
    take() {
      const seen = new Set(typedOnce);
      typedOnce.clear();
      for (const hold of holds.values()) {
        if (hold.held && hold.selected !== null) {
          seen.add(hold.selected);
        }
      }
      return seen;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      stopped = true;
      for (const hold of holds.values()) {
        release(hold);
      }
      holds.clear();
      typedOnce.clear();
      listeners.clear();
    },
  };
}
