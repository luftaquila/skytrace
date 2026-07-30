import { createAirfieldsStore } from "./airfields-store.mjs";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { openDatabase, syncReceiverTokens } from "./db.mjs";
import { createRetention } from "./retention.mjs";
import { createSseHub } from "./sse.mjs";

// SQLite may recreate WAL/SHM files after a checkpoint, and the airfield store also writes
// persistent snapshots. Keep every process-created data file private, including worker output.
process.umask(0o077);

const config = loadConfig();
const db = openDatabase(config.dbPath);
syncReceiverTokens(db, config.receiverTokens);
if (config.receiverTokens.length === 0) {
  console.warn("SKYTRACE_RECEIVER_TOKENS is empty; ingest is disabled");
}

const airfieldsStore = createAirfieldsStore({
  dir: config.airfieldsDir,
  airportsUrl: config.airfieldsAirportsUrl,
  runwaysUrl: config.airfieldsRunwaysUrl,
  refreshMs: config.airfieldsRefreshSeconds * 1000,
});
airfieldsStore.init();

const sseHub = createSseHub();
const app = createApp({ db, config, sseHub, airfieldsStore });
const retention = createRetention({
  dbPath: config.dbPath,
  trackRetentionDays: config.trackRetentionDays,
  batchRetentionDays: config.batchRetentionDays,
  currentRetentionHours: config.currentRetentionHours,
});

const server = app.listen(config.port, () => {
  console.log(`skytrace listening on :${config.port}`);
});
server.headersTimeout = 15000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
server.maxConnections = 512;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  const forceTimer = setTimeout(() => process.exit(1), 10000);
  forceTimer.unref();
  try {
    const serverClosed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await sseHub.close();
    server.closeIdleConnections?.();
    await serverClosed;
    await retention.close();
    await airfieldsStore.close();
    app.locals.requestLimits?.close();
    app.locals.ingestLimits?.close();
    await app.locals.coverageCache?.close();
    db.close();
    clearTimeout(forceTimer);
    process.exit(0);
  } catch {
    console.error("shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
