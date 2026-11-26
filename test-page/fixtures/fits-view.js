// Served as web/terminal-view.js by test-page/shell.test.ts: the minimal terminal view (served
// beside it as web/terminal-view-real.js) with contract 2.9's optional `fits(width, height)`
// (task 28). It answers `globalThis.fitsAnswer` (77 × 33 until a test sets another, or null) and
// keeps every terminal area it was asked about, `[width, height]`, in `globalThis.fitsAsked`.
// Only the view of `#terminal` records and adds its own (issue #199: the page makes a second
// view, of the shells, in `#shell`; that one is the minimal view as it is).
import { createTerminalView as createMinimal } from './terminal-view-real.js';

export function createTerminalView(root, deps) {
  if (root.id !== 'terminal') {
    return createMinimal(root, deps); // issue #199: the shells' view records nothing
  }
  const view = createMinimal(root, deps);
  const asked = [];
  globalThis.fitsAsked = asked;
  globalThis.fitsAnswer = { cols: 77, rows: 33 };
  return {
    ...view,
    fits(width, height) {
      asked.push([width, height]);
      return globalThis.fitsAnswer;
    },
  };
}
