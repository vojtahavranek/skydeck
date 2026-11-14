/**
 * One connection from the server to a keeper (S2 8.1): connect to its unix socket, claim it (`C`,
 * the first frame of every connection), read the frames it sends through task 1's codec, write
 * frames without blocking. What the frames mean is the registry's (`terminals.ts`).
 */
import type { Socket } from 'node:net';

import type { Net } from '../platform/types.ts';
import { encodeFrame, frameReader } from './frames.ts';
import type { Frame, FrameType } from './frames.ts';

export interface LinkHandlers {
  /** Every frame the keeper sends, in order. */
  frame(frame: Frame): void;
  /** The keeper sent what the codec refuses (S2 8.1): the connection is closed. */
  refused(kind: 'unknown-type' | 'too-long'): void;
  /** Called once when the connection has ended, whoever ended it. */
  closed(): void;
}

export interface KeeperLink {
  /** Writes one frame; false when the connection is closed. Never blocks: Node keeps what waits. */
  send(type: FrameType, payload?: Uint8Array): boolean;
  /** Bytes written but not yet taken by the system (Node's queue for this connection). */
  unwritten(): number;
  isOpen(): boolean;
  /** Writes what waits, then closes; resolves when closed. */
  end(): Promise<void>;
  /** Closes at once; what waits is dropped. */
  destroy(): void;
  /** Stops reading the keeper's socket (frames of a read already made still arrive). */
  pause(): void;
  /** Reads it again. */
  resume(): void;
}

/**
 * Connects to the keeper's socket and claims it. Rejects as `Net.connectUnix` does (`code`
 * ECONNREFUSED, ENOENT …). A handler that throws closes the connection; the error is passed to
 * `closed`'s caller through `failed`, never rethrown into the socket's event loop.
 */
export async function claimKeeper(
  net: Net,
  path: string,
  handlers: LinkHandlers,
  failed: (error: unknown) => void,
): Promise<KeeperLink> {
  const socket: Socket = await net.connectUnix(path);
  const reader = frameReader();
  let open = true;
  let closedOnce = false;
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      open = false;
      resolve();
      if (!closedOnce) {
        closedOnce = true;
        guard(() => {
          handlers.closed();
        });
      }
    });
  });
  // A connection that breaks is reported through 'close'; the error itself says nothing more.
  socket.on('error', () => {});

  function guard(step: () => void): void {
    try {
      step();
    } catch (error) {
      socket.destroy();
      failed(error);
    }
  }

  socket.on('data', (chunk: Buffer) => {
    if (!open) return;
    const result = reader.push(chunk);
    if ('error' in result) {
      socket.destroy();
      guard(() => {
        handlers.refused(result.error);
      });
      return;
    }
    for (const frame of result) {
      if (!open || socket.destroyed) return;
      guard(() => {
        handlers.frame(frame);
      });
    }
  });

  const link: KeeperLink = {
    send(type, payload) {
      if (!open || socket.destroyed || socket.writableEnded) return false;
      socket.write(encodeFrame(type, payload));
      return true;
    },
    unwritten: () => socket.writableLength,
    isOpen: () => open && !socket.destroyed,
    end() {
      if (open && !socket.destroyed) {
        socket.end();
      }
      return closed;
    },
    destroy() {
      socket.destroy();
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
  };
  link.send('C');
  return link;
}
