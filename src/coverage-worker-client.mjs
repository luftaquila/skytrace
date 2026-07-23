import { Worker } from "node:worker_threads";

export function createCoverageWorkerClient({ dbPath, options = {}, WorkerClass = Worker }) {
  const worker = new WorkerClass(new URL("./coverage-worker-thread.mjs", import.meta.url), {
    workerData: { dbPath, options },
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let terminalError = null;

  function rejectPending(error) {
    terminalError = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  worker.on("message", (message) => {
    const request = pending.get(message?.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) {
      request.resolve(message.snapshot);
      return;
    }
    const error = new Error(message?.error?.message || "coverage worker refresh failed");
    if (message?.error?.stack) error.stack = message.error.stack;
    request.reject(error);
  });
  worker.on("error", rejectPending);
  worker.on("exit", (code) => {
    if (!closed) rejectPending(new Error(`coverage worker exited unexpectedly with code ${code}`));
  });

  return {
    build(now) {
      if (closed) return Promise.reject(new Error("coverage worker is closed"));
      if (terminalError) return Promise.reject(terminalError);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "refresh", id, now });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectPending(new Error("coverage worker closed"));
      await worker.terminate();
    },
  };
}
