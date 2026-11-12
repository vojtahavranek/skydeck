// Plain JavaScript on purpose: this runs on whatever Node the launcher found, however old, before
// any TypeScript is loaded. Keep it free of syntax and APIs newer than Node 14.

/** The oldest Node.js skydeck runs on. Keep in step with "engines" in package.json. */
export const MINIMUM_NODE = '24.12';

/**
 * Checks a Node.js version string (process.versions.node) against {@link MINIMUM_NODE}.
 *
 * @param {string} found
 * @returns {string | undefined} one line saying what is wrong, or undefined when the version is fine
 */
export function checkNodeVersion(found) {
  const [neededMajor = 0, neededMinor = 0] = MINIMUM_NODE.split('.').map(Number);
  const match = /^(\d+)\.(\d+)\./.exec(`${found}.`);
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  const recent = major > neededMajor || (major === neededMajor && minor >= neededMinor);
  if (recent) {
    return undefined;
  }
  return (
    `skydeck needs Node.js ${MINIMUM_NODE} or newer but found ${found}; ` +
    'set SKYDECK_NODE to the path of a newer node binary.'
  );
}
