// Doubles for the page's desktop notifications (S2 13, 17.4; plan B17, task 55): a recording
// `Notification` that shows nothing and asks nothing, and a `document.hasFocus` that answers what
// the case says. Both are init scripts or evaluations in the page: nothing here can show a
// notification on the desktop or ask for a permission (no case grants one through Playwright).
import type { Page } from 'playwright';

import { NOTIFICATION_DOUBLE } from './browser.ts';

/** A permission of the Notification API. */
export type Permission = 'default' | 'granted' | 'denied';

/** What the double saw, in order. */
export interface NotificationRecord {
  /** Each `new Notification(title, options)`: its strings as given, and their types. */
  made: { title: unknown; body: unknown; tag: unknown; types: string[] }[];
  /** The index in `made` of each notification whose `close()` was called, in order. */
  closed: number[];
  /** Each `requestPermission` call, with whether the page had user activation then. */
  asked: { active: boolean }[];
  /** The index in `made` of each notification the case clicked (`clickNotification`). */
  clicked: number[];
  /** How often the page called `window.focus()`. */
  focused: number;
}

/** Where the double keeps its record and its notifications in the page. */
const RECORD = 'skydeckNotificationRecord';
const MADE = 'skydeckNotificationsMade';
const SETTINGS = 'skydeckNotificationSettings';

/**
 * The double, run in the page: it sets B17's marker (so that the inert `Notification` of
 * `newContext` yields to it, in either order of the two init scripts), records what the page does
 * with `Notification` and `window.focus` (which it still calls), and answers `requestPermission`
 * with `answer`, which then is the permission. Self-contained: Playwright sends its source.
 */
export function installDouble(arg: {
  marker: string;
  record: string;
  made: string;
  settings: string;
  permission: string;
  answer: string;
}): void {
  const record = { made: [], closed: [], asked: [], clicked: [], focused: 0 } as {
    made: { title: unknown; body: unknown; tag: unknown; types: string[] }[];
    closed: number[];
    asked: { active: boolean }[];
    clicked: number[];
    focused: number;
  };
  const made: EventTarget[] = [];
  const settings = { permission: arg.permission, answer: arg.answer };
  class DoubleNotification extends EventTarget {
    static get permission(): string {
      return settings.permission;
    }
    static requestPermission(callback?: (permission: string) => void): Promise<string> {
      record.asked.push({ active: navigator.userActivation.isActive });
      settings.permission = settings.answer;
      callback?.(settings.permission);
      return Promise.resolve(settings.permission);
    }
    constructor(title: unknown, options: { body?: unknown; tag?: unknown } = {}) {
      super();
      record.made.push({
        title,
        body: options.body,
        tag: options.tag,
        types: [typeof title, typeof options.body, typeof options.tag],
      });
      made.push(this);
    }
    close(): void {
      record.closed.push(made.indexOf(this));
      this.dispatchEvent(new Event('close'));
    }
  }
  Object.defineProperty(globalThis, arg.marker, { value: true, configurable: true });
  Object.defineProperty(globalThis, 'Notification', {
    value: DoubleNotification,
    configurable: true,
    writable: true,
  });
  const focus = window.focus.bind(window);
  window.focus = () => {
    record.focused++;
    focus();
  };
  Object.defineProperty(globalThis, arg.record, { value: record, configurable: true });
  Object.defineProperty(globalThis, arg.made, { value: made, configurable: true });
  Object.defineProperty(globalThis, arg.settings, { value: settings, configurable: true });
}

/**
 * Installs the recording double in every document `page` loads from now on, with the permission
 * `permission`; `requestPermission` answers `answer` (default `granted`) and the permission is
 * that answer afterwards. Call it before the page loads.
 */
export async function notificationDouble(
  page: Page,
  permission: Permission,
  answer: Permission = 'granted',
): Promise<void> {
  await page.addInitScript(installDouble, {
    marker: NOTIFICATION_DOUBLE,
    record: RECORD,
    made: MADE,
    settings: SETTINGS,
    permission,
    answer,
  });
}

/** What the double has seen so far in the page's document. */
export async function notificationsOf(page: Page): Promise<NotificationRecord> {
  return page.evaluate(
    (name) => structuredClone(Reflect.get(globalThis, name)) as NotificationRecord,
    RECORD,
  );
}

/** Clicks the `index`-th notification the page made (a `click` event on it, as Chromium sends). */
export async function clickNotification(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ({ record, made, index }) => {
      const notification = (Reflect.get(globalThis, made) as EventTarget[])[index];
      if (notification === undefined) throw new Error(`no notification ${index}`);
      (Reflect.get(globalThis, record) as NotificationRecord).clicked.push(index);
      notification.dispatchEvent(new Event('click', { cancelable: true }));
    },
    { record: RECORD, made: MADE, index },
  );
}

/**
 * A `close` event on the `index`-th notification the page made, as the browser fires one later
 * (the notification was replaced by a newer one of the same `tag`, or the user dismissed it); it is
 * not recorded as the page's `close()`.
 */
export async function closedByBrowser(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ({ made, index }) => {
      const notification = (Reflect.get(globalThis, made) as EventTarget[])[index];
      if (notification === undefined) throw new Error(`no notification ${index}`);
      notification.dispatchEvent(new Event('close'));
    },
    { made: MADE, index },
  );
}

/** Changes the double's permission now, as the browser's own settings would. */
export async function setPermission(page: Page, permission: Permission): Promise<void> {
  await page.evaluate(
    ({ settings, permission }) => {
      (Reflect.get(globalThis, settings) as { permission: string }).permission = permission;
    },
    { settings: SETTINGS, permission },
  );
}

/**
 * `document.hasFocus` answering `focused` from now on, and a `focus` or `blur` event dispatched
 * on the window, as when the window comes to the front or leaves it.
 */
export async function pageFocus(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((focused) => {
    Object.defineProperty(document, 'hasFocus', {
      value: () => focused,
      configurable: true,
      writable: true,
    });
    dispatchEvent(new Event(focused ? 'focus' : 'blur'));
  }, focused);
}
