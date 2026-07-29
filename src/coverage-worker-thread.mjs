import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "./db.mjs";
import { refreshCoverageSnapshot } from "./coverage-store.mjs";

if (!parentPort) throw new Error("coverage worker requires a parent port");

const db = openDatabase(workerData.dbPath, { migrate: false });
const options = workerData.options || {};
const receiverCache = new Map();

parentPort.on("message", (message) => {
  if (message?.type !== "refresh") return;
  try {
    const snapshot = refreshCoverageSnapshot(db, {
      ...options,
      now: message.now,
      receiverCache,
    });
    parentPort.postMessage({ id: message.id, ok: true, snapshot });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: {
        message: error?.message || String(error),
        stack: error?.stack || null,
      },
    });
  }
});

parentPort.on("close", () => {
  db.close();
});
