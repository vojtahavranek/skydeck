// The Undo toast (S2 12.5, 12.10; plan D15, D13): one line at a time over the page — over a
// dialog's scrim too (edit.css) —, with an Undo when the caller gives one, for 5 seconds (the
// mockup's 4.2, rounded up for the reach to Undo). A later line replaces the one shown. Like the
// page's other chrome it takes no keyboard on a click: its Undo cancels its mousedown, so the
// keyboard stays where the user was. Its interface is plan D's contract 2.4. Every text reaches
// the DOM as text.

/** How long a line stays. */
const SHOWN_MS = 5000;

/** @param {HTMLElement} root  #toast */
export function createToast(root) {
  const text = document.createElement('span');
  text.className = 'toast-text';
  const undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'toast-undo';
  undoButton.textContent = 'Undo';
  root.replaceChildren(text, undoButton);
  root.hidden = true;

  /** What the Undo of the line shown does. @type {(() => void) | null} */
  let undo = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const hide = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = null;
    undo = null;
    root.hidden = true;
  };

  undoButton.addEventListener('mousedown', (event) => event.preventDefault());
  undoButton.addEventListener('click', () => {
    const run = undo;
    hide(); // an Undo acts once
    run?.();
  });

  return {
    /**
     * @param {string} line
     * @param {(() => void) | null} onUndo
     */
    show(line, onUndo) {
      text.textContent = line;
      undo = onUndo;
      undoButton.hidden = onUndo === null;
      root.hidden = false;
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(hide, SHOWN_MS);
    },
    hide,
  };
}
