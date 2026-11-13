/**
 * The one session-id rule. It lives in a file of its own that imports nothing, so that the window's
 * protocol modules (`src/window/protocol.ts`, `src/window/frames.ts`), which the page's type check
 * reads, can use it without pulling in Node.js modules. `launch.ts` re-exports it.
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `text` is a session id: a lowercase UUID (8-4-4-4-12 hex digits) and nothing more. Every
 * session id skydeck takes from a Claude Code file passes through this check, because the id ends
 * up on a command line after `--resume`, where a value such as `--dangerously-skip-permissions`
 * would be read as a flag (principle 5). The one rule: `launch.ts` and `live.ts` re-export it,
 * `hookinput.ts` lowercases first and then asks it.
 */
export function isSessionId(text: string): boolean {
  return SESSION_ID.test(text);
}
