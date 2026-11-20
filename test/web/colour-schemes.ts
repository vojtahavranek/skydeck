// The colour schemes of a style sheet of web/, as the page computes them, for the tests that
// measure its variables: skydeck's own light (`:root`) and dark (the dark block; forced dark is its
// twin, test/web/theme.test.ts), and each colour theme of the title bar's second switch
// (web/theme-text.js PALETTES) laid over the scheme it belongs to, as style.css says: the scheme's
// values, with the theme's own in their place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PALETTES } from '../../web/theme-text.js';
import type { Scheme } from '../../web/theme-text.js';

/** One scheme as the page computes it: `light`, `dark`, or a scheme and its theme (`dark iris`). */
export interface ColourScheme {
  name: string;
  scheme: Scheme;
  values: Map<string, string>;
}

/** The custom properties of a block of CSS declarations. */
function properties(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name as string, (value as string).trim());
  }
  return found;
}

/** The default light and dark schemes of `file` (a style sheet of web/), then each colour theme
 *  it has, in PALETTES' order. */
export function colourSchemes(file: string): ColourScheme[] {
  const css = readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8').replaceAll(
    /\/\*[^]*?\*\//g,
    '',
  );
  const light = /:root\s*\{([^}]*)\}/.exec(css);
  const dark =
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(
      css,
    );
  assert.ok(light !== null && dark !== null, `${file} has a light and a dark :root`);
  const own: Record<Scheme, Map<string, string>> = {
    light: properties(light[1] ?? ''),
    dark: properties(dark[1] ?? ''),
  };
  const found: ColourScheme[] = [
    { name: 'light', scheme: 'light', values: own.light },
    { name: 'dark', scheme: 'dark', values: own.dark },
  ];
  for (const scheme of ['light', 'dark'] as const) {
    for (const palette of PALETTES[scheme]) {
      if (palette === 'default') continue;
      const rule =
        scheme === 'light'
          ? new RegExp(`:root\\[data-palette-light='${palette}'\\]\\s*\\{([^}]*)\\}`)
          : new RegExp(
              `:root\\[data-palette-dark='${palette}'\\]:not\\(\\[data-theme='light'\\]\\)\\s*\\{([^}]*)\\}`,
            );
      const block = rule.exec(css);
      // A sheet without colour themes (attention.css) has its schemes only; that style.css and
      // terminal-view.css have every theme is test/web/theme.test.ts's.
      if (block === null) continue;
      found.push({
        name: `${scheme} ${palette}`,
        scheme,
        values: new Map([...own[scheme], ...properties(block[1] ?? '')]),
      });
    }
  }
  return found;
}
