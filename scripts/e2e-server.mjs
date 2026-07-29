import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDatabase, syncReceiverTokens } from "../src/db.mjs";
import { createSseHub } from "../src/sse.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-e2e-"));
const config = loadConfig({
  PORT: process.env.SKYTRACE_E2E_PORT || "4173",
  SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
  SKYTRACE_RECEIVER_TOKENS: JSON.stringify({ "rx-1": TOKEN }),
  SKYTRACE_CURRENT_WINDOW_SECONDS: "120",
  SKYTRACE_MAX_OBSERVATION_AGE_SECONDS: "120",
  SKYTRACE_TRACK_MIN_INTERVAL_SECONDS: "0",
  SKYTRACE_STATIC_DIR: path.resolve("web", "dist"),
});
const db = openDatabase(config.dbPath);
syncReceiverTokens(db, config.receiverTokens);
const sseHub = createSseHub();
const coverageWorker = {
  async build(now) {
    return {
      type: "observed-occupancy",
      from: now,
      to: now,
      generatedAt: now,
      nextRefreshAt: now,
      receiverCount: 0,
      areas: [],
      points: [],
      aggregation: { type: "receiver-spatial-cells" },
    };
  },
  async close() {},
};
const app = createApp({ db, config, sseHub, coverageWorker });
await app.locals.coverageCache.ready();
const server = app.listen(config.port);
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
console.log(`skytrace e2e server listening on :${config.port}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await sseHub.close();
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
    });
  }
  app.locals.requestLimits?.close();
  app.locals.ingestLimits?.close();
  await app.locals.coverageCache?.close();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
