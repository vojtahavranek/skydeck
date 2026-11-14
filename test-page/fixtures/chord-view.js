// Served as web/terminal-view.js by test-page/shell.test.ts: the minimal terminal view (served
// beside it as web/terminal-view-real.js), whose pane hands every key event to `deps.chord` as
// xterm.js's custom key handler does in task 28 (xterm.js calls it for keydown, keypress and
// keyup; true means "drop the event"), and which counts the calls the page makes on it in
// `globalThis.viewCalls`.
import { createTerminalView as createMinimal } from './terminal-view-real.js';

export function createTerminalView(root, deps) {
  const calls = { find: 0, copy: 0, pasteRaw: 0, dropped: [] };
  globalThis.viewCalls = calls;
  const view = createMinimal(root, deps);
  for (const type of ['keydown', 'keypress', 'keyup']) {
    root.addEventListener(type, (event) => {
      if (deps.chord(event)) {
        calls.dropped.push(`${type} ${event.key}`);
      }
    });
  }
  return {
    ...view,
    find() {
      calls.find++;
    },
    copy() {
      calls.copy++;
    },
    pasteRaw() {
      calls.pasteRaw++;
    },
  };
}
