// Desktop notifications (S2 13; plan B15, B16, contract 2.8): the title bar's `Turn on
// notifications` item, the only place the permission is asked (a click, a user gesture); a
// notification for each `notify` the server sends this page, shown only with the permission
// `granted` and never for the session the focused page has selected; a click on one brings the
// window to the front and goes through app.js's gate of a window chord (`deps.select`); and the
// notification of a session closed once the list says that session no longer needs you.
//
// The Notification API is read from `globalThis.Notification` at each use (a test's double, B17),
// and its absence or a refusal of it shows nothing and throws nothing. A notification's title and
// body are web/attention-text.js's, plain strings: never markup.

/** @import { ListMessage, NotifyMessage } from '../src/window/protocol.ts' */
import { notificationText } from './attention-text.js';

/**
 * The Notification API as the page reaches it, or null where there is none.
 * @returns {typeof Notification | null}
 */
function api() {
  const found = /** @type {unknown} */ (Reflect.get(globalThis, 'Notification'));
  return typeof found === 'function' ? /** @type {typeof Notification} */ (found) : null;
}

/**
 * The permission, or null without the API (or one whose permission cannot be read).
 * @returns {string | null}
 */
function permission() {
  try {
    return api()?.permission ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLButtonElement} item  #notify-on (index.html's title bar)
 * @param {{ select(id: string): void }} deps  `select`: app.js's gate of a window chord, then the
 *   selection (B15), not `select` itself
 */
export function createNotifications(item, deps) {
  /** The notification shown for each session, the latest (its `tag` replaced an older one). @type {Map<string, Notification>} */
  const shown = new Map();

  /** The item is shown exactly while the permission is `default` (S2 13). */
  const refresh = () => {
    const hidden = permission() !== 'default';
    if (item.hidden !== hidden) {
      item.hidden = hidden;
    }
  };

  // A held key asks once (S2 13: "asked once"; task 37's rule for a held key): its auto-repeats
  // on the item do nothing, so an Enter held while the permission stays `default` (a dismissed
  // prompt) is not one request per repeat.
  item.addEventListener('keydown', (event) => {
    if (event.repeat) {
      event.preventDefault();
    }
  });
  item.addEventListener('click', () => {
    const Api = api();
    if (Api === null || permission() !== 'default') {
      refresh();
      return;
    }
    /** @type {Promise<unknown> | undefined} */
    let answer;
    try {
      // A click is the user's gesture: the one time the page asks (S2 13).
      answer = Api.requestPermission();
    } catch {
      refresh();
      return;
    }
    Promise.resolve(answer).then(refresh, refresh);
  });
  // The permission can change outside the page (the browser's settings for the site): the item
  // follows it when the window comes back, and at each list (`update`).
  addEventListener('focus', refresh);
  refresh();

  /**
   * Closes the notification of `sessionId`, if one is shown.
   * @param {string} sessionId
   */
  const close = (sessionId) => {
    const notification = shown.get(sessionId);
    shown.delete(sessionId);
    try {
      notification?.close();
    } catch {
      // gone already
    }
  };

  return {
    /**
     * S2 13: a notification for `message`, with the session's title, B13's body and the session
     * as its `tag` (a newer one for a session replaces the older); none without the permission
     * `granted`, and none for the session that is selected while the page has focus.
     * @param {NotifyMessage} message
     * @param {{ focused: boolean, selected: string | null }} page
     */
    show(message, page) {
      const Api = api();
      const sessionId = message.sessionId;
      if (Api === null || permission() !== 'granted' || typeof sessionId !== 'string') {
        return;
      }
      if (page.focused && page.selected === sessionId) {
        return;
      }
      const { title, body } = notificationText(message);
      /** @type {Notification} */
      let made;
      try {
        made = new Api(title, { body, tag: sessionId });
      } catch {
        return; // the browser refused it: nothing is shown
      }
      shown.set(sessionId, made);
      made.addEventListener('close', () => {
        if (shown.get(sessionId) === made) {
          shown.delete(sessionId);
        }
      });
      made.addEventListener('click', () => {
        // B15: the window to the front, then the gate of a window chord, which selects the
        // session (or, while a dialog is shown, says so and selects nothing).
        window.focus();
        made.close(); // acted on: its `close` forgets it
        deps.select(sessionId);
      });
    },

    /**
     * B16 (ruled): closes the notification of each session that no longer needs you — the list
     * carries that session's row with no attention, or nothing needs you at all (`needYou.count`
     * 0, or no `needYou`, as in a list of stage A). A session the list merely does not show (a
     * filter, the folded Earlier) keeps its notification. Then the item, as `refresh`.
     * @param {ListMessage} list
     */
    update(list) {
      refresh();
      if (shown.size === 0) {
        return;
      }
      const count = list.needYou?.count;
      const none = !(typeof count === 'number' && Number.isInteger(count) && count > 0);
      const rows = new Map(
        (list.sections ?? []).flatMap((section) => section.rows).map((row) => [row.id, row]),
      );
      for (const sessionId of [...shown.keys()]) {
        const row = rows.get(sessionId);
        if (none || (row !== undefined && (row.attention ?? null) === null)) {
          close(sessionId);
        }
      }
    },

    refresh,
  };
}
