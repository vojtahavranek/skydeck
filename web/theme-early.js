// The window's theme before the page's first paint (follow-up F13; S2 12.1). A classic script,
// loaded with <script src> in index.html's <head> ahead of the style sheets — a module would run
// only after the page is parsed, too late —, so that a stored choice is on <html> before anything
// is drawn: no frame shows the other theme. It reads THEME_KEY of web/theme-text.js by that
// module's rule (`themeOf`; test/web/theme.test.ts holds the two equal): `light` or `dark` becomes
// `<html data-theme>`, which the style sheets read; anything else, or storage that throws or is
// missing, leaves the page following the system. Each scheme's colour theme likewise, by
// `paletteOf` and PALETTE_KEYS: a theme of that scheme but the default becomes
// `<html data-palette-light>` or `<html data-palette-dark>`; anything else leaves the default.
// web/theme.js keeps them from then on.
try {
  const stored = localStorage.getItem('skydeck-theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  }
  // PALETTES of web/theme-text.js without the default, which is no attribute.
  const palettes = { light: ['iris'], dark: ['iris', 'pleiades'] };
  const light = localStorage.getItem('skydeck-palette-light');
  if (light !== null && palettes.light.includes(light)) {
    document.documentElement.dataset.paletteLight = light;
  }
  const dark = localStorage.getItem('skydeck-palette-dark');
  if (dark !== null && palettes.dark.includes(dark)) {
    document.documentElement.dataset.paletteDark = dark;
  }
} catch {
  // No storage: the page follows the system, in the default colours.
}
