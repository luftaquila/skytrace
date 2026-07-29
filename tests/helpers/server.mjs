import fs from "node:fs/promises";

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function closeTestApp({
  server,
  app,
  sseHub,
  retention = null,
  airfieldsStore = null,
  db,
  dir = null,
}) {
  await closeServer(server);
  await sseHub?.close?.();
  await retention?.close?.();
  await airfieldsStore?.close?.();
  await app?.locals?.coverageCache?.close?.();
  app?.locals?.requestLimits?.close?.();
  app?.locals?.ingestLimits?.close?.();
  db?.close?.();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
}
