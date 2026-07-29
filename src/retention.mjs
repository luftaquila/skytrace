import { Worker } from "node:worker_threads";

const FIRST_RUN_MS = 5 * 60 * 1000;
const NORMAL_RUN_MS = 6 * 60 * 60 * 1000;
const RETRY_RUN_MS = 60 * 1000;

export function createRetention({
  dbPath,
  trackRetentionDays = 90,
  batchRetentionDays = 7,
  currentRetentionHours = 24,
  firstRunMs = FIRST_RUN_MS,
  intervalMs = NORMAL_RUN_MS,
  budgetMs = 30000,
  now = () => Date.now(),
  random = Math.random,
  logger = console,
} = {}) {
  const worker = new Worker(new URL("./retention-worker.mjs", import.meta.url), {
    workerData: { dbPath },
  });
  const pending = new Map();
  let nextId = 1;
  let timer = null;
  let closed = false;
  let running = false;
  let lastResult = null;
  let lastErrorAt = null;
  let workerStopped = false;

  worker.on("message", (message) => {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result ?? message);
    else waiter.reject(new Error(message.error || "retention worker failed"));
  });
  worker.on("error", (error) => {
    workerStopped = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  worker.on("exit", (code) => {
    workerStopped = true;
    const error = new Error(`retention worker exited with code ${code}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  function request(message) {
    return new Promise((resolve, reject) => {
      if (workerStopped) {
        reject(new Error("retention worker is not running"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id });
    });
  }

  function schedule(delay) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      runNow().catch(() => {});
    }, delay);
    timer.unref?.();
  }

  async function runNow() {
    if (closed || running) return lastResult;
    running = true;
    try {
      lastResult = await request({
        type: "run",
        now: new Date(now()).toISOString(),
        trackRetentionDays,
        batchRetentionDays,
        currentRetentionHours,
        budgetMs,
      });
      lastErrorAt = null;
      logger.info?.("retention completed", lastResult);
      for (const warning of lastResult.cursorWarnings || []) {
        logger.warn?.("retention removed rows ahead of coverage cursor", warning);
      }
      for (const future of lastResult.futureRows || []) {
        logger.warn?.("retention removed future-dated rows", future);
      }
      const jitter = Math.round(intervalMs * 0.1 * (random() * 2 - 1));
      schedule(lastResult.complete ? intervalMs + jitter : RETRY_RUN_MS);
      return lastResult;
    } catch (error) {
      lastErrorAt = new Date(now()).toISOString();
      logger.error?.("retention failed");
      schedule(RETRY_RUN_MS);
      throw error;
    } finally {
      running = false;
    }
  }

  schedule(firstRunMs);
  return {
    runNow,
    state: () => ({ running, lastResult, lastErrorAt }),
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (workerStopped) return;
      try {
        await request({ type: "close" });
      } finally {
        await worker.terminate();
      }
    },
  };
}
