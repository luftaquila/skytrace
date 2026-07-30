import path from "node:path";
import net from "node:net";

function configError(key, detail) {
  return new Error(`invalid ${key}: ${detail}`);
}

function intFromEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  if (!/^-?\d+$/.test(String(raw))) throw configError(key, "expected an integer");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw configError(key, `expected an integer from ${min} to ${max}`);
  }
  return n;
}

function numberFromEnv(env, key, fallback, { min = Number.MIN_VALUE, max = Number.MAX_VALUE } = {}) {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw configError(key, `expected a number from ${min} to ${max}`);
  }
  return n;
}

function rejectRemovedSettings(env, keys) {
  for (const key of keys) {
    if (env[key] != null && env[key] !== "") {
      throw configError(key, "this setting was removed");
    }
  }
}

function validReceiverId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value);
}

function parseReceiverTokens(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw configError("SKYTRACE_RECEIVER_TOKENS", "expected a JSON object");
    }
    const seenTokens = new Set();
    return Object.entries(parsed).map(([receiverId, token]) => {
      if (!validReceiverId(receiverId)) {
        throw configError("SKYTRACE_RECEIVER_TOKENS", `invalid receiver id ${JSON.stringify(receiverId)}`);
      }
      if (typeof token !== "string" || token.length < 32) {
        throw configError(
          "SKYTRACE_RECEIVER_TOKENS",
          `token for ${receiverId} must be a string of at least 32 characters`,
        );
      }
      if (seenTokens.has(token)) {
        throw configError("SKYTRACE_RECEIVER_TOKENS", "tokens must be unique");
      }
      seenTokens.add(token);
      return { receiverId, token };
    });
  } catch (error) {
    if (error?.message?.startsWith("invalid SKYTRACE_RECEIVER_TOKENS:")) throw error;
    throw configError("SKYTRACE_RECEIVER_TOKENS", "expected a JSON object");
  }
}

function parseTrustProxy(raw) {
  if (raw == null || raw === "") return 0;
  const text = String(raw).trim();
  if (text === "true" || text === "false") {
    throw configError("SKYTRACE_TRUST_PROXY", "expected 0 or an explicit IP/CIDR list, not a boolean");
  }
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops === 0) return 0;
    throw configError("SKYTRACE_TRUST_PROXY", "positive hop counts are unsafe; use explicit proxy IP/CIDR entries");
  }
  const entries = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (
    entries.length === 0
    || entries.some((entry) => {
      const [address, prefix, extra] = entry.split("/");
      const family = net.isIP(address);
      if (!family || extra != null) return true;
      if (prefix == null) return false;
      if (!/^\d+$/.test(prefix)) return true;
      return Number(prefix) > (family === 4 ? 32 : 128);
    })
  ) {
    throw configError("SKYTRACE_TRUST_PROXY", "expected 0 or a comma-separated IP/CIDR list");
  }
  return entries;
}

export function loadConfig(env = process.env) {
  rejectRemovedSettings(env, [
    "SKYTRACE_INGEST_TOKEN",
    "SKYTRACE_INGEST_TOKENS",
    "SKYTRACE_MAX_TRACK_QUERY_POINTS",
    "SKYTRACE_REQUIRE_HTTPS",
  ]);
  const coverageHorizontalStepNm = numberFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_STEP_NM", 2);
  const coverageVerticalStepFt = numberFromEnv(env, "SKYTRACE_COVERAGE_VERTICAL_STEP_FT", 800);
  const coverageWindowHours = intFromEnv(env, "SKYTRACE_COVERAGE_WINDOW_HOURS", 24 * 30, {
    min: 1,
    max: 24 * 365,
  });
  const trackRetentionDays = intFromEnv(env, "SKYTRACE_TRACK_RETENTION_DAYS", 90, {
    min: 1,
    max: 365,
  });
  const minimumRetentionDays = Math.ceil(coverageWindowHours / 24) + 1;
  if (trackRetentionDays < minimumRetentionDays) {
    throw configError(
      "SKYTRACE_TRACK_RETENTION_DAYS",
      `must be at least ${minimumRetentionDays} for the configured coverage window`,
    );
  }

  const dbPath = env.SKYTRACE_DB_PATH || path.resolve("data", "skytrace.db");
  return {
    port: intFromEnv(env, "PORT", 3000, { min: 0, max: 65535 }),
    dbPath,
    // The generated airfield dataset lives beside the database on the persistent volume, so a
    // weekly refresh survives restarts and never needs an image rebuild.
    airfieldsDir: env.SKYTRACE_AIRFIELDS_DIR || path.join(path.dirname(dbPath), "airfields"),
    airfieldsAirportsUrl: env.SKYTRACE_AIRFIELDS_AIRPORTS_URL || undefined,
    airfieldsRunwaysUrl: env.SKYTRACE_AIRFIELDS_RUNWAYS_URL || undefined,
    airfieldsRefreshSeconds: intFromEnv(env, "SKYTRACE_AIRFIELDS_REFRESH_SECONDS", 7 * 24 * 3600),
    // On-demand area traffic from a community aggregator ("v2" API URL template with {lat},
    // {lon} and {radius} slots). Unset = the feature is off and the route answers 404.
    areaFeedUrl: env.SKYTRACE_AREA_FEED_URL || "",
    areaFeedTtlSeconds: intFromEnv(env, "SKYTRACE_AREA_FEED_TTL_SECONDS", 5),
    areaFeedMinUpstreamMs: intFromEnv(env, "SKYTRACE_AREA_FEED_MIN_UPSTREAM_MS", 1100),
    staticDir: env.SKYTRACE_STATIC_DIR || path.resolve("web", "dist"),
    trustProxy: parseTrustProxy(env.SKYTRACE_TRUST_PROXY),
    receiverTokens: parseReceiverTokens(env.SKYTRACE_RECEIVER_TOKENS),
    currentWindowSeconds: intFromEnv(env, "SKYTRACE_CURRENT_WINDOW_SECONDS", 90),
    liveMaxAircraft: intFromEnv(env, "SKYTRACE_LIVE_MAX_AIRCRAFT", 5000, {
      min: 100,
      max: 20000,
    }),
    liveMaxBytes: intFromEnv(env, "SKYTRACE_LIVE_MAX_BYTES", 8 * 1024 * 1024, {
      min: 64 * 1024,
      max: 32 * 1024 * 1024,
    }),
    maxObservationAgeSeconds: intFromEnv(env, "SKYTRACE_MAX_OBSERVATION_AGE_SECONDS", 120),
    trackMinIntervalSeconds: intFromEnv(env, "SKYTRACE_TRACK_MIN_INTERVAL_SECONDS", 3),
    positionFilterMaxMach: numberFromEnv(env, "SKYTRACE_POSITION_FILTER_MAX_MACH", 3.5),
    trackRetentionDays,
    batchRetentionDays: intFromEnv(env, "SKYTRACE_INGEST_BATCH_RETENTION_DAYS", 7, {
      min: 1,
      max: 90,
    }),
    currentRetentionHours: 24,
    coverageWindowHours,
    coverageRefreshSeconds: intFromEnv(env, "SKYTRACE_COVERAGE_REFRESH_SECONDS", 180),
    coverageHorizontalStepNm,
    coverageVerticalStepFt,
    coverageCellHorizontalStepNm: numberFromEnv(
      env,
      "SKYTRACE_COVERAGE_CELL_HORIZONTAL_STEP_NM",
      coverageHorizontalStepNm / 2,
    ),
    coverageCellVerticalStepFt: numberFromEnv(
      env,
      "SKYTRACE_COVERAGE_CELL_VERTICAL_STEP_FT",
      coverageVerticalStepFt / 2,
    ),
    coverageAggregationChunkSize: intFromEnv(env, "SKYTRACE_COVERAGE_AGGREGATION_CHUNK_SIZE", 5000),
    coverageHorizontalSupportNm: numberFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_SUPPORT_NM", 4.5),
    coverageVerticalSupportFt: numberFromEnv(env, "SKYTRACE_COVERAGE_VERTICAL_SUPPORT_FT", 2500),
    coverageHorizontalInterpolationCells: intFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_INTERPOLATION_CELLS", 2),
    coverageHorizontalSmoothingPasses: intFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_SMOOTHING_PASSES", 2),
    coverageVerticalSmoothingPasses: intFromEnv(env, "SKYTRACE_COVERAGE_VERTICAL_SMOOTHING_PASSES", 4),
    coverageSmoothingIterations: intFromEnv(env, "SKYTRACE_COVERAGE_SMOOTHING_ITERATIONS", 5),
    coverageMaxCells: intFromEnv(env, "SKYTRACE_COVERAGE_MAX_CELLS", 1200000),
    coverageMaxTriangles: intFromEnv(env, "SKYTRACE_COVERAGE_MAX_TRIANGLES", 200000),
  };
}
