import path from "node:path";

function intFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function numberFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolFromEnv(env, key, fallback = false) {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function parseTokenList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseReceiverTokens(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];

  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    return Object.entries(parsed)
      .map(([receiverId, token]) => ({ receiverId, token: String(token || "") }))
      .filter((entry) => entry.receiverId && entry.token);
  }

  return text
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx === -1) return null;
      return {
        receiverId: pair.slice(0, idx).trim(),
        token: pair.slice(idx + 1).trim(),
      };
    })
    .filter((entry) => entry?.receiverId && entry?.token);
}

export function loadConfig(env = process.env) {
  const ingestTokens = [
    ...parseTokenList(env.SKYTRACE_INGEST_TOKEN),
    ...parseTokenList(env.SKYTRACE_INGEST_TOKENS),
  ];

  return {
    port: intFromEnv(env, "PORT", 3000),
    dbPath: env.SKYTRACE_DB_PATH || path.resolve("data", "skytrace.db"),
    publicOrigin: env.PUBLIC_ORIGIN || env.SKYTRACE_PUBLIC_ORIGIN || "http://localhost:3000",
    staticDir: env.SKYTRACE_STATIC_DIR || path.resolve("web", "dist"),
    trustProxy: boolFromEnv(env, "SKYTRACE_TRUST_PROXY", true),
    ingestTokens,
    receiverTokens: parseReceiverTokens(env.SKYTRACE_RECEIVER_TOKENS),
    currentWindowSeconds: intFromEnv(env, "SKYTRACE_CURRENT_WINDOW_SECONDS", 90),
    maxObservationAgeSeconds: intFromEnv(env, "SKYTRACE_MAX_OBSERVATION_AGE_SECONDS", 120),
    trackMinIntervalSeconds: intFromEnv(env, "SKYTRACE_TRACK_MIN_INTERVAL_SECONDS", 5),
    maxTrackQueryPoints: intFromEnv(env, "SKYTRACE_MAX_TRACK_QUERY_POINTS", 10000),
    positionFilterMaxMach: Number.parseFloat(env.SKYTRACE_POSITION_FILTER_MAX_MACH || "3.5"),
    coverageWindowHours: intFromEnv(env, "SKYTRACE_COVERAGE_WINDOW_HOURS", 24 * 30),
    coverageBearingStepDegrees: Number.parseFloat(env.SKYTRACE_COVERAGE_BEARING_STEP_DEGREES || "1"),
    coverageMaxPoints: intFromEnv(env, "SKYTRACE_COVERAGE_MAX_POINTS", 50000),
    coverageRefreshSeconds: intFromEnv(env, "SKYTRACE_COVERAGE_REFRESH_SECONDS", 300),
    coverageHorizontalStepNm: numberFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_STEP_NM", 2.5),
    coverageVerticalStepFt: numberFromEnv(env, "SKYTRACE_COVERAGE_VERTICAL_STEP_FT", 1000),
    coverageHorizontalSupportNm: numberFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_SUPPORT_NM", 4.5),
    coverageVerticalSupportFt: numberFromEnv(env, "SKYTRACE_COVERAGE_VERTICAL_SUPPORT_FT", 2500),
    coverageHorizontalInterpolationCells: intFromEnv(env, "SKYTRACE_COVERAGE_HORIZONTAL_INTERPOLATION_CELLS", 2),
    coverageMaxCells: intFromEnv(env, "SKYTRACE_COVERAGE_MAX_CELLS", 1200000),
    coverageMaxTriangles: intFromEnv(env, "SKYTRACE_COVERAGE_MAX_TRIANGLES", 200000),
  };
}
