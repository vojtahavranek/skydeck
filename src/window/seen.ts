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
 * What a terminal sends by itself, told by its shape (B9; C1 of review 2, ruled): focus reports
 * (`CSI I`, `CSI O`, mode 1004, one at every click, chord and return to the window), SGR mouse
 * reports (`CSI <` b;x;y `M` or `m`, modes 1006 and 1016), and the answers to queries. xterm.js's
 * only other mouse encoding, X10, comes as `binary`. The page swallows the queries today (S2 9.3),
 * so no answer arrives; were one to come, it must not count as typing: a false "typing" clears a
 * mark unread, a false "not typing" costs the user 1.5 s. Keys never take these shapes but one:
 * F3 with any modifier (`CSI 1 ; m R`) has the bytes of a cursor position report, and the hold's
 * 1.5 s apply (ruled). An OSC or DCS counts only when it is whole in one message (BEL or ST at its
 * end), so Alt+] and Alt+Shift+P stay typing; a paste holds no ESC (S2 9.1) but its two brackets.
 */
const REPORTS = new RegExp(
  [
    // A private marker: SGR mouse reports, DA1 `?…c`, DA2 `>…c`, DEC mode reports `?…$y`,
    // DEC status reports `?…n`, DECXCPR `?…R`.
    /\x1b\[[<=>?][0-9;]*\$?[A-Za-z~]/.source,
    // No marker: focus reports `I` and `O`, status reports `n`, window reports `t`, ANSI mode
    // reports `$y`. A device attributes answer always has its marker (above).
    /\x1b\[[0-9;]*(?:[IOnt]|\$y)/.source,
    // A cursor position report.
    /\x1b\[[0-9]+;[0-9]+R/.source,
    // OSC answers (the colours of OSC 4, 10 and 11), ended by BEL or ST.
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.source,
    // DCS answers (DECRQSS, DA3, XTVERSION), ended by ST.
    /\x1bP[^\x1b]*\x1b\\/.source,
  ].join('|'),
  'g',
);

/**
 * B9: whether an `input` message is typing: not `binary`, and something is left once every report
 * a terminal sends by itself, told by its shape (REPORTS), is taken out. Pure.
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
  /** A session began to be seen: a hold completed, or a typing when it was not yet seen (a key
   *  into a session already being seen calls no listener: keys into one session call the
   *  listeners at most once between two `take()`s, unless a `focus` or `gone` in between ended
   *  the hold that made it seen). Listeners must not throw; a throw out of a completed hold is
   *  dropped so that the timer cannot end the server; `typed` throws only if a listener throws. */
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

  /** Whether take() would give `sessionId` now. */
  const beingSeen = (sessionId: string): boolean => {
    if (typedOnce.has(sessionId)) return true;
    for (const hold of holds.values()) {
      if (hold.held && hold.selected === sessionId) return true;
    }
    return false;
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
      // C4 of review 2 (ruled): a key into a session already being seen begins nothing, so that
      // the listeners do not run at every key press.
      const began = !beingSeen(sessionId);
      const hold = holds.get(page);
      if (hold !== undefined && hold.focused && hold.selected === sessionId) {
        hold.cancel?.();
        hold.cancel = null;
        hold.held = true;
      } else {
        typedOnce.add(sessionId);
      }
      if (began) {
        tell();
      }
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
