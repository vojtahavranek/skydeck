// A newer skydeck migrating the database, for store.test.ts: it takes the write lock (BEGIN
// IMMEDIATE), sets schema_version to `version`, says 'locked', and commits `holdMs` later. It runs in
// a worker thread, so the test's own thread can start a write that has to wait for this lock.
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const { path, version, holdMs } = workerData as { path: string; version: number; holdMs: number };
const db = new DatabaseSync(path);
try {
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(String(version));
  parentPort?.postMessage('locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  db.exec('COMMIT');
} finally {
  db.close();
}
