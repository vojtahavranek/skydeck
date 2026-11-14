// Served as web/terminal-view.js by test-page/shell.test.ts: the minimal terminal view (served
// beside it as web/terminal-view-real.js), whose keyboard holder is a TEXT CONTROL inside
// `.xterm`, as xterm.js's helper textarea is (task 28): giving it the keyboard takes the page's
// text selection away, as xterm.js's does. The keys it gets — what xterm.js would send to the
// program — are kept in `globalThis.programGot`.
import { createTerminalView as createMinimal } from './terminal-view-real.js';

export function createTerminalView(root, deps) {
  const view = createMinimal(root, deps);
  const shell = document.createElement('div');
  shell.className = 'xterm';
  const holder = document.createElement('textarea');
  holder.className = 'xterm-helper-textarea';
  shell.append(holder);
  const got = [];
  globalThis.programGot = got;
  holder.addEventListener('keydown', (event) => {
    got.push(`${event.ctrlKey ? 'Ctrl+' : ''}${event.key}`);
  });
  return {
    ...view,
    show(term) {
      view.show(term);
      if (term !== null && shell.parentElement !== root) {
        root.append(shell);
      }
    },
    focus() {
      if (shell.parentElement === root) {
        holder.focus();
      }
    },
  };
}
