// The vendored xterm.js modules the server uses (plan A4): the headless terminal, the serialise
// addon and the width addon, loaded from `<appRoot>/vendor/xterm/` with a dynamic import of a
// `file:` URL. Users never run `npm ci`, so nothing is imported from `node_modules` at run time;
// the types come from the development dependencies. The server loads them before it listens (A35).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface XtermModules {
  Terminal: typeof import('@xterm/headless').Terminal;
  SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon;
  UnicodeGraphemesAddon: typeof import('@xterm/addon-unicode-graphemes').UnicodeGraphemesAddon;
}

/** Each module's file under the app root and the export the server takes from it. */
const FILES: { key: keyof XtermModules; path: string }[] = [
  { key: 'Terminal', path: 'vendor/xterm/headless/lib-headless/xterm-headless.mjs' },
  { key: 'SerializeAddon', path: 'vendor/xterm/addon-serialize/lib/addon-serialize.mjs' },
  {
    key: 'UnicodeGraphemesAddon',
    path: 'vendor/xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs',
  },
];

const loading = new Map<string, Promise<XtermModules>>();

async function load(appRoot: string): Promise<XtermModules> {
  const found: Partial<Record<keyof XtermModules, unknown>> = {};
  for (const { key, path } of FILES) {
    const module = (await import(pathToFileURL(join(appRoot, path)).href)) as Record<
      string,
      unknown
    >;
    if (typeof module[key] !== 'function') {
      throw new Error(`the vendored file ${path} has no export ${key}`);
    }
    found[key] = module[key];
  }
  return found as XtermModules;
}

/**
 * Loads the vendored modules of the checkout at `appRoot`, once: every later call for the same
 * root gives the same modules. A failed load is not remembered, so a later call tries again.
 */
export function loadXterm(appRoot: string): Promise<XtermModules> {
  let modules = loading.get(appRoot);
  if (modules === undefined) {
    modules = load(appRoot);
    loading.set(appRoot, modules);
    modules.catch(() => {
      if (loading.get(appRoot) === modules) {
        loading.delete(appRoot);
      }
    });
  }
  return modules;
}
