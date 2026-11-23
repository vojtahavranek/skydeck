// The list's width before the page's first paint (issue #192; S2 12.1). A classic script, loaded
// with <script src> in index.html's <head> ahead of the style sheets, as web/theme-early.js is, so
// that a stored width is on <html> before anything is drawn: a reload does not jump. It reads
// LIST_WIDTH_KEY of web/list-width-text.js by that module's rule (`widthOf`;
// test/web/list-width.test.ts holds the two equal): a whole number, held to 240 … 800, becomes
// `--list-width: <n>px` on <html>, which style.css's `.main` reads (and holds to the window);
// anything else, or storage that throws or is missing, leaves the list at its default width.
// web/list-width.js keeps it from then on.
try {
  const stored = localStorage.getItem('skydeck-list-width');
  if (typeof stored === 'string' && /^-?[0-9]+$/.test(stored)) {
    const width = Math.min(800, Math.max(240, Number(stored)));
    document.documentElement.style.setProperty('--list-width', `${width}px`);
  }
} catch {
  // No storage: the list has its default width.
}
