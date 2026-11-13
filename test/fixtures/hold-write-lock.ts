// Another skydeck holding a database's write lock, for doctor.test.ts: the store's own transaction
// (BEGIN IMMEDIATE), waiting inside it until the test lets go. It runs in a worker thread, so the
// test's own thread goes on and its writes meet the lock.
import { parentPort, workerData } from 'node:worker_threads';

import { openStore } from '../../src/store/store.ts';

const { path, signal } = workerData as { path: string; signal: SharedArrayBuffer };
const flag = new Int32Array(signal);
const store = openStore(path);
try {
  store.transaction(() => {
    parentPort?.postMessage('locked');
    Atomics.wait(flag, 0, 0, 60_000);
  });
} finally {
  store.close();
}
