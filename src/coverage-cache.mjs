export function createCoverageCache({ build, refreshSeconds = 300, now = () => Date.now(), logger = console }) {
  const intervalMs = Math.max(1000, Number(refreshSeconds) * 1000 || 300000);
  let snapshot = null;
  let generatedAtMs = 0;

  function refresh() {
    const startedAt = now();
    const value = build(new Date(startedAt).toISOString());
    generatedAtMs = now();
    snapshot = {
      ...value,
      generatedAt: new Date(generatedAtMs).toISOString(),
      nextRefreshAt: new Date(generatedAtMs + intervalMs).toISOString(),
      refreshIntervalSeconds: intervalMs / 1000,
    };
    return snapshot;
  }

  // Do not spend startup time building a mesh nobody requested. The first request creates a
  // current snapshot; after that the server replaces it atomically every five minutes.
  const timer = setInterval(() => {
    if (!snapshot) return;
    try {
      refresh();
    } catch (error) {
      logger.error("coverage refresh failed", error);
    }
  }, intervalMs);
  timer.unref?.();

  return {
    get() {
      return snapshot || refresh();
    },
    refresh,
    close() {
      clearInterval(timer);
    },
    ageMs() {
      return snapshot ? Math.max(0, now() - generatedAtMs) : null;
    },
  };
}
