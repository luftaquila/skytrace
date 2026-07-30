import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { strongEtag } from "./http-response.mjs";

const gzipAsync = promisify(gzip);

function stableCoverage(value, refreshIntervalSeconds) {
  const payload = structuredClone(value);
  delete payload.from;
  delete payload.to;
  delete payload.generatedAt;
  delete payload.nextRefreshAt;
  if (payload.aggregation) {
    delete payload.aggregation.rawPointsProcessed;
    delete payload.aggregation.cellWrites;
    delete payload.aggregation.meshesRebuilt;
    delete payload.aggregation.meshesReused;
  }
  for (const area of payload.areas || []) {
    if (area.volumeMesh?.stats) delete area.volumeMesh.stats.generatedMs;
  }
  payload.refreshIntervalSeconds = refreshIntervalSeconds;
  return payload;
}

export function createCoverageCache({
  build,
  refreshSeconds = 180,
  now = () => Date.now(),
  logger = console,
  closeBuild = null,
  startImmediately = true,
}) {
  const intervalMs = Math.max(1000, Number(refreshSeconds) * 1000 || 180000);
  let snapshot = null;
  let representation = null;
  let contentIdentity = null;
  let generatedAtMs = 0;
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let inFlight = null;
  let closed = false;
  let lastErrorAt = null;
  let lastDurationMs = null;

  async function runRequestedBuilds() {
    while (!closed && completedGeneration < requestedGeneration) {
      const targetGeneration = requestedGeneration;
      const startedAt = now();
      try {
        const value = await build(new Date(startedAt).toISOString());
        generatedAtMs = now();
        lastDurationMs = Math.max(0, generatedAtMs - startedAt);
        const stable = stableCoverage(value, intervalMs / 1000);
        const identityWithoutTime = Buffer.from(JSON.stringify(stable));
        const nextIdentity = strongEtag(identityWithoutTime);
        if (nextIdentity !== contentIdentity) {
          snapshot = {
            ...stable,
            contentGeneratedAt: new Date(generatedAtMs).toISOString(),
          };
          const identity = Buffer.from(JSON.stringify(snapshot));
          const compressed = await gzipAsync(identity, { level: 6 });
          representation = {
            identity,
            gzip: compressed,
            identityEtag: strongEtag(identity),
            gzipEtag: strongEtag(compressed),
          };
          contentIdentity = nextIdentity;
        }
        lastErrorAt = null;
      } catch (error) {
        if (closed) return snapshot;
        lastErrorAt = new Date(now()).toISOString();
        logger.error("coverage refresh failed", error);
        if (!snapshot) throw error;
      } finally {
        completedGeneration = targetGeneration;
      }
    }
    return snapshot;
  }

  function requestBuild() {
    if (closed) return Promise.reject(new Error("coverage cache is closed"));
    requestedGeneration += 1;
    if (!inFlight) {
      inFlight = runRequestedBuilds().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  const timer = setInterval(() => {
    requestBuild().catch(() => {});
  }, intervalMs);
  timer.unref?.();

  if (startImmediately) requestBuild().catch(() => {});

  return {
    get() {
      return snapshot;
    },
    representation() {
      return representation;
    },
    async ready() {
      // A snapshot is not publicly ready until its identity/gzip buffers and validators have
      // finished building. Returning in that narrow window made callers observe a 503 directly
      // after awaiting ready().
      if (representation) return snapshot;
      if (inFlight) return inFlight;
      return requestBuild();
    },
    refresh() {
      return requestBuild();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (typeof closeBuild === "function") await closeBuild();
    },
    state() {
      return {
        ready: Boolean(snapshot),
        refreshing: Boolean(inFlight),
        requestedGeneration,
        completedGeneration,
        lastErrorAt,
        lastDurationMs,
      };
    },
  };
}
