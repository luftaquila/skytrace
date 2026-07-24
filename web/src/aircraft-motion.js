const KNOT_TO_MPS = 0.514444;
const EARTH_RADIUS_M = 6371008.8;
const GRAVITY_MPS2 = 9.80665;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export const DEFAULT_MAX_EXTRAPOLATION_MS = 8000;
export const DEFAULT_CORRECTION_MS = 750;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

export function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

export function shortestAngleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function turnRateFor(observation, speedMps) {
  if (Number.isFinite(observation.trackRate)) return clamp(observation.trackRate, -8, 8);
  if (observation.onGround || speedMps < 15 || !Number.isFinite(observation.roll)) return 0;
  // When track_rate is absent, a coordinated turn gives omega = g*tan(bank)/speed.
  // ADS-B roll > 0 is right-wing-down, matching increasing clockwise ground track.
  const bank = clamp(observation.roll, -45, 45) * DEG_TO_RAD;
  return clamp(GRAVITY_MPS2 * Math.tan(bank) / speedMps * RAD_TO_DEG, -8, 8);
}

export function normalizeMotionObservation(observation) {
  const hasTrack = Number.isFinite(observation.track);
  const speedMps = hasTrack && Number.isFinite(observation.gs)
    ? Math.max(0, observation.gs) * KNOT_TO_MPS
    : 0;
  const track = normalizeAngle(finite(observation.track));
  const roll = observation.onGround ? 0 : clamp(finite(observation.roll), -45, 45);
  return {
    lon: finite(observation.lon),
    lat: clamp(finite(observation.lat), -89.999999, 89.999999),
    z: Math.max(0, finite(observation.z)),
    track,
    pitch: observation.onGround ? 0 : clamp(finite(observation.pitch), -40, 40),
    roll,
    speedMps,
    verticalSpeed: observation.onGround ? 0 : finite(observation.verticalSpeed),
    turnRate: turnRateFor({ ...observation, roll }, speedMps),
    onGround: !!observation.onGround,
    key: String(observation.key ?? ""),
  };
}

// Constant-speed, constant-turn-rate short-horizon dead reckoning. The exact circular-arc
// integral avoids the sideways wobble produced by repeatedly lerping latitude/longitude.
export function extrapolateMotion(observation, elapsedMs, maxElapsedMs = DEFAULT_MAX_EXTRAPOLATION_MS) {
  const state = observation.speedMps == null ? normalizeMotionObservation(observation) : observation;
  const seconds = clamp(finite(elapsedMs) / 1000, 0, Math.max(0, maxElapsedMs) / 1000);
  const heading0 = state.track * DEG_TO_RAD;
  const omega = state.turnRate * DEG_TO_RAD;
  const heading1 = heading0 + omega * seconds;
  let east;
  let north;
  if (Math.abs(omega) < 1e-9) {
    east = state.speedMps * seconds * Math.sin(heading0);
    north = state.speedMps * seconds * Math.cos(heading0);
  } else {
    const radius = state.speedMps / omega;
    east = radius * (Math.cos(heading0) - Math.cos(heading1));
    north = radius * (Math.sin(heading1) - Math.sin(heading0));
  }
  const lat = state.lat + north / EARTH_RADIUS_M * RAD_TO_DEG;
  const meanLat = clamp((state.lat + lat) * 0.5, -89.999999, 89.999999) * DEG_TO_RAD;
  const lon = state.lon + east / (EARTH_RADIUS_M * Math.max(1e-6, Math.cos(meanLat))) * RAD_TO_DEG;
  return {
    lon,
    lat,
    z: Math.max(0, state.z + state.verticalSpeed * seconds),
    track: normalizeAngle(state.track + state.turnRate * seconds),
    pitch: state.pitch,
    roll: state.roll,
  };
}

function motionChanged(from, to) {
  return Math.abs(shortestAngleDelta(from.lon, to.lon)) > 1e-10
    || Math.abs(from.lat - to.lat) > 1e-10
    || Math.abs(from.z - to.z) > 0.01
    || Math.abs(shortestAngleDelta(from.track, to.track)) > 0.01
    || Math.abs(from.pitch - to.pitch) > 0.01
    || Math.abs(shortestAngleDelta(from.roll, to.roll)) > 0.01;
}

function correctionOffset(from, to) {
  return {
    lon: shortestAngleDelta(to.lon, from.lon),
    lat: from.lat - to.lat,
    z: from.z - to.z,
    track: shortestAngleDelta(to.track, from.track),
    pitch: from.pitch - to.pitch,
    roll: shortestAngleDelta(to.roll, from.roll),
  };
}

function applyDecayingCorrection(predicted, offset, amount) {
  const remaining = 1 - smoothstep(amount);
  return {
    lon: predicted.lon + offset.lon * remaining,
    lat: predicted.lat + offset.lat * remaining,
    z: predicted.z + offset.z * remaining,
    track: normalizeAngle(predicted.track + offset.track * remaining),
    pitch: predicted.pitch + offset.pitch * remaining,
    roll: predicted.roll + offset.roll * remaining,
  };
}

export function createAircraftMotionTracker({
  maxExtrapolationMs = DEFAULT_MAX_EXTRAPOLATION_MS,
  correctionMs = DEFAULT_CORRECTION_MS,
} = {}) {
  const entries = new Map();

  function sampleEntry(entry, nowMs) {
    const predicted = extrapolateMotion(entry.observation, nowMs - entry.receivedAt, maxExtrapolationMs);
    if (!entry.correctionOffset || correctionMs <= 0) return predicted;
    const elapsed = nowMs - entry.receivedAt;
    if (elapsed >= correctionMs) return predicted;
    // Decay a fixed position/orientation error on top of the new trajectory. Unlike lerping from a
    // frozen old point, this preserves forward motion at the exact update frame (no micro-stop).
    return applyDecayingCorrection(predicted, entry.correctionOffset, elapsed / correctionMs);
  }

  return {
    observe(hex, observation, nowMs) {
      const normalized = normalizeMotionObservation(observation);
      const previous = entries.get(hex);
      if (previous?.key === normalized.key) return sampleEntry(previous, nowMs);
      const correctionFrom = previous ? sampleEntry(previous, nowMs) : null;
      const correctionTarget = extrapolateMotion(normalized, 0, maxExtrapolationMs);
      entries.set(hex, {
        key: normalized.key,
        observation: normalized,
        receivedAt: nowMs,
        correctionOffset: correctionFrom && motionChanged(correctionFrom, correctionTarget)
          ? correctionOffset(correctionFrom, correctionTarget)
          : null,
      });
      return correctionFrom || correctionTarget;
    },
    sample(hex, nowMs) {
      const entry = entries.get(hex);
      return entry ? sampleEntry(entry, nowMs) : null;
    },
    isAnimating(hex, nowMs) {
      const entry = entries.get(hex);
      if (!entry) return false;
      const correcting = entry.correctionOffset && nowMs - entry.receivedAt < correctionMs;
      const moving = entry.observation.speedMps > 0.01
        || Math.abs(entry.observation.verticalSpeed) > 0.01
        || Math.abs(entry.observation.turnRate) > 0.001;
      return !!correcting || (moving && nowMs - entry.receivedAt <= maxExtrapolationMs);
    },
    retain(hexes) {
      for (const hex of entries.keys()) if (!hexes.has(hex)) entries.delete(hex);
    },
    clear() { entries.clear(); },
  };
}
