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
  let generatedAtMs = 0;
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let inFlight = null;
  let closed = false;
  let lastError = null;

  async function runRequestedBuilds() {
    while (!closed && completedGeneration < requestedGeneration) {
      const targetGeneration = requestedGeneration;
      const startedAt = now();
      try {
        const value = await build(new Date(startedAt).toISOString());
        generatedAtMs = now();
        snapshot = {
          ...value,
          status: "ready",
          generatedAt: new Date(generatedAtMs).toISOString(),
          nextRefreshAt: new Date(generatedAtMs + intervalMs).toISOString(),
          refreshIntervalSeconds: intervalMs / 1000,
        };
        lastError = null;
      } catch (error) {
        if (closed) return snapshot;
        lastError = error;
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
    async ready() {
      if (snapshot) return snapshot;
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
    ageMs() {
      return snapshot ? Math.max(0, now() - generatedAtMs) : null;
    },
    state() {
      return {
        ready: Boolean(snapshot),
        refreshing: Boolean(inFlight),
        requestedGeneration,
        completedGeneration,
        lastError: lastError?.message || null,
      };
    },
  };
}
