// The page side of test-page/smoke.test.ts: an xterm.js terminal and its addons from the vendored
// bundles, by the relative URLs the window's page uses (S2 8.2.1). Once the terminal has taken the
// write, what the test checks is in `window.smoke`.
import { Terminal } from '../vendor/xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../vendor/xterm/addon-fit/lib/addon-fit.mjs';
import { SearchAddon } from '../vendor/xterm/addon-search/lib/addon-search.mjs';
import { SerializeAddon } from '../vendor/xterm/addon-serialize/lib/addon-serialize.mjs';
import { UnicodeGraphemesAddon } from '../vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs';

const modules = { Terminal, FitAddon, SearchAddon, SerializeAddon, UnicodeGraphemesAddon };

const terminal = new Terminal({
  // The width addon uses the unicode API, which xterm.js 6.0.0 still marks as proposed (as the
  // screen side does, src/window/screen.ts).
  allowProposedApi: true,
  // Pure red, so that the test can tell the theme's red from any other colour.
  theme: { red: '#ff0000' },
});
const fit = new FitAddon();
const serialize = new SerializeAddon();
terminal.loadAddon(fit);
terminal.loadAddon(new SearchAddon());
terminal.loadAddon(serialize);
terminal.loadAddon(new UnicodeGraphemesAddon());
terminal.open(document.getElementById('terminal'));
fit.fit();

terminal.write('\x1b[31mred', () => {
  window.smoke = {
    modules: Object.fromEntries(
      Object.entries(modules).map(([name, value]) => [name, typeof value]),
    ),
    serialized: serialize.serialize(),
    unicodeVersion: terminal.unicode.activeVersion,
  };
});
