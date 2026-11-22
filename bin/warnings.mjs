// Plain JavaScript, like node-version.mjs: bootstrap.mjs imports it before it checks the Node
// version, so it must load on any Node. Keep it free of syntax and APIs newer than Node 14.

/**
 * Node.js 24 warns that node:sqlite is experimental, once per process, on standard error, at
 * whatever point the module is first loaded: in the middle of a question, or above doctor's report.
 * skydeck relies on node:sqlite on purpose (design 10), so that one warning says nothing to its
 * user. From this call on, `proc.emitWarning` drops a warning of type `ExperimentalWarning` whose
 * message starts with `SQLite`; every other warning goes to Node's own `emitWarning` as before,
 * with its `--trace-warnings` hint.
 *
 * @param {NodeJS.Process} proc
 */
export function hideSqliteWarning(proc) {
  const emit = proc.emitWarning;
  /** @type {(warning: string | Error, ...rest: unknown[]) => void} */
  const filtered = function (warning, ...rest) {
    if (isSqliteWarning(warning, rest[0])) {
      return;
    }
    return Reflect.apply(emit, proc, [warning, ...rest]);
  };
  proc.emitWarning = /** @type {NodeJS.Process['emitWarning']} */ (filtered);
}

/**
 * Whether `emitWarning(warning, second)` is the SQLite warning: `second` is the type, or an options
 * object with a `type`; a warning that is an Error carries its type as its name.
 *
 * @param {unknown} warning
 * @param {unknown} second
 * @returns {boolean}
 */
function isSqliteWarning(warning, second) {
  let type;
  let message;
  if (warning instanceof Error) {
    type = warning.name;
    message = warning.message;
  } else {
    message = String(warning);
    if (typeof second === 'string') {
      type = second;
    } else if (typeof second === 'object' && second !== null) {
      type = /** @type {{ type?: unknown }} */ (second).type;
    }
  }
  return type === 'ExperimentalWarning' && message.startsWith('SQLite');
}
