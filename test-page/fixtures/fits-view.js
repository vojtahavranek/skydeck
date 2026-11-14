// Served as web/terminal-view.js by test-page/shell.test.ts: the minimal terminal view (served
// beside it as web/terminal-view-real.js) with contract 2.9's optional `fits(width, height)`
// (task 28). It answers `globalThis.fitsAnswer` (77 × 33 until a test sets another, or null) and
// keeps every terminal area it was asked about, `[width, height]`, in `globalThis.fitsAsked`.
import { createTerminalView as createMinimal } from './terminal-view-real.js';

export function createTerminalView(root, deps) {
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
