// What a page of the window does first (S2 8.2.2), for the fake Edge of this directory and for the
// tests of `skydeck window`: open /ws on 127.0.0.1:<port> with the page's Origin, answer the
// challenge with a hello in mode `launch` (a launch token) or `key` (the secret), and on `welcome`
// send `start`, so that the server counts the connection as a page. A 503 at the upgrade (the
// server is starting or stopping) is tried again, as a page does; whatever happens after the hello,
// the proof is never presented again on that connection.
import { randomBytes } from 'node:crypto';

import WebSocket from 'ws';

import { pageProof } from '../../../src/window/auth.ts';

/** How a presentation ended: welcomed (the connection stays open), or closed with a code. */
export type Presented =
  | { outcome: 'welcome'; ws: WebSocket }
  | { outcome: 'closed'; code: number }
  | { outcome: 'refused'; status: number };

/** How long a presentation keeps trying an upgrade the server answers with 503. */
const UPGRADE_TRIES_MS = 20_000;

function nonce(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * One upgrade: the open socket and the messages that came with it (a challenge can arrive in the
 * same chunk as the 101 answer, before a listener added after 'open' would see it), or the status
 * that refused it.
 */
function upgrade(
  port: number,
  origin: string,
): Promise<{ ws: WebSocket; early: string[] } | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    const early: string[] = [];
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (!isBinary) early.push(String(data));
    });
    ws.once('open', () => resolve({ ws, early }));
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('close', () => resolve(0));
  });
}

/**
 * Presents `key` (32 bytes: a launch token or the secret) in `mode` on the server at `port`. On
 * `welcome` it sends `start` and leaves the connection open (the caller closes it).
 */
export async function present(
  port: number,
  key: Uint8Array,
  mode: 'launch' | 'key',
): Promise<Presented> {
  const origin = `http://127.0.0.1:${port}`;
  const until = performance.now() + UPGRADE_TRIES_MS;
  let opened: { ws: WebSocket; early: string[] } | number;
  for (;;) {
    opened = await upgrade(port, origin);
    if (typeof opened !== 'number') break;
    if (opened !== 503 || performance.now() > until) return { outcome: 'refused', status: opened };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { ws: socket, early } = opened;
  return new Promise<Presented>((resolve) => {
    let challenged = false;
    const onText = (text: string): void => {
      const message = JSON.parse(text) as { t?: unknown; nonce?: unknown };
      if (message.t === 'challenge' && !challenged && typeof message.nonce === 'string') {
        challenged = true;
        const cN = nonce();
        socket.send(
          JSON.stringify({
            t: 'hello',
            protocol: 1,
            mode,
            nonce: cN,
            proof: pageProof(key, mode, message.nonce, cN, origin),
          }),
        );
      } else if (message.t === 'welcome') {
        const assetVersion = (message as { assetVersion?: unknown }).assetVersion;
        socket.send(
          JSON.stringify({
            t: 'start',
            assetVersion,
            windowId: randomBytes(8).toString('hex'),
            focused: true,
            theme: { fg: '#ffffff', bg: '#000000' },
          }),
        );
        resolve({ outcome: 'welcome', ws: socket });
      }
    };
    socket.removeAllListeners('message');
    socket.on('message', (data, isBinary) => {
      if (!isBinary) onText(String(data));
    });
    socket.on('close', (code) => resolve({ outcome: 'closed', code }));
    for (const text of early) onText(text);
    if (socket.readyState !== WebSocket.OPEN) resolve({ outcome: 'closed', code: 1006 });
  });
}

/** What a presentation is recorded as: its outcome without the socket. */
export function outcomeOf(presented: Presented): string {
  switch (presented.outcome) {
    case 'welcome':
      return 'welcome';
    case 'closed':
      return `closed ${presented.code}`;
    case 'refused':
      return `refused ${presented.status}`;
  }
}
