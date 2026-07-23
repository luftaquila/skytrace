import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { openDatabase, syncReceiverTokens } from "./db.mjs";
import { createSseHub } from "./sse.mjs";

const config = loadConfig();
const db = openDatabase(config.dbPath);
syncReceiverTokens(db, config.receiverTokens);

const sseHub = createSseHub();
const app = createApp({ db, config, sseHub });

const server = app.listen(config.port, () => {
  console.log(`skytrace listening on :${config.port}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  app.locals.coverageCache?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
