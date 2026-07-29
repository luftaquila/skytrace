const STRING_LIMITS = {
  flight: 16,
  squawk: 8,
  category: 8,
  emergency: 32,
  sourceType: 32,
  silType: 16,
};

function noteInvalid(stats) {
  if (stats) stats.invalidFieldCount += 1;
}

function finiteInRange(value, min, max, stats) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    noteInvalid(stats);
    return null;
  }
  return n;
}

function safeInteger(value, stats) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    noteInvalid(stats);
    return null;
  }
  return n;
}

function boundedString(value, limit, stats) {
  if (value == null) return null;
  if (!["string", "number", "boolean"].includes(typeof value)) {
    noteInvalid(stats);
    return null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > limit) {
    if (stats) stats.truncatedFieldCount += 1;
    return text.slice(0, limit);
  }
  return text;
}

function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  if (!/^~?[0-9a-f]{6}$/.test(hex)) return null;
  return hex;
}

function heading(value, stats) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    noteInvalid(stats);
    return null;
  }
  return ((n % 360) + 360) % 360;
}

function altitude(value, stats) {
  if (value === "ground") return { value: 0, onGround: true };
  return { value: finiteInRange(value, -2000, 100000, stats), onGround: false };
}

function isoMinusSeconds(baseMs, seconds) {
  return new Date(baseMs - seconds * 1000).toISOString();
}

function sourceKind(raw, sourceType) {
  const type = sourceType?.toLowerCase();
  if (type?.includes("mlat") || Array.isArray(raw?.mlat) && raw.mlat.length) return "mlat";
  if (type?.includes("tisb") || Array.isArray(raw?.tisb) && raw.tisb.length) return "tisb";
  if (type?.includes("uat")) return "uat";
  if (type?.includes("adsb")) return "adsb";
  return type || "unknown";
}

function diagnosticSourceNow(value) {
  if (value == null || value === "") return null;
  let date;
  if (typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    const ms = n > 1e11 ? n : n * 1000;
    date = new Date(ms);
  } else {
    date = new Date(value);
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeReadsbPayload(payload, options = {}) {
  const receivedAt = options.receivedAt ? new Date(options.receivedAt) : new Date();
  if (!Number.isFinite(receivedAt.getTime())) throw new TypeError("receivedAt must be a valid date");
  const stats = {
    invalidFieldCount: 0,
    truncatedFieldCount: 0,
    invalidObservationCount: 0,
  };
  const aircraft = Array.isArray(payload?.aircraft) ? payload.aircraft : [];
  const normalized = aircraft
    .map((raw) => normalizeAircraft(raw, receivedAt.getTime(), {
      maxObservationAgeSeconds: options.maxObservationAgeSeconds,
      stats,
    }))
    .filter(Boolean);
  return {
    sourceNow: diagnosticSourceNow(payload?.now),
    aircraft: normalized,
    ...stats,
  };
}

export function normalizeAircraft(raw, receivedAtMs = Date.now(), options = {}) {
  const stats = options.stats || {
    invalidFieldCount: 0,
    truncatedFieldCount: 0,
    invalidObservationCount: 0,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    stats.invalidObservationCount += 1;
    return null;
  }
  const hex = normalizeHex(raw.hex);
  if (!hex) {
    stats.invalidObservationCount += 1;
    return null;
  }
  const maxAge = Number.isFinite(options.maxObservationAgeSeconds)
    ? options.maxObservationAgeSeconds
    : 120;
  const seen = finiteInRange(raw.seen, 0, maxAge, stats);
  if (seen == null) {
    stats.invalidObservationCount += 1;
    return null;
  }

  const seenPos = finiteInRange(raw.seen_pos, 0, maxAge, stats);
  const lat = finiteInRange(raw.lat, -90, 90, stats);
  const lon = finiteInRange(raw.lon, -180, 180, stats);
  const hasPosition = seenPos != null && lat != null && lon != null;
  const baro = altitude(raw.alt_baro, stats);
  const sourceType = boundedString(raw.type, STRING_LIMITS.sourceType, stats);

  return {
    hex,
    nonIcao: hex.startsWith("~") || (sourceType ? !sourceType.toLowerCase().includes("icao") : false),
    sourceType,
    sourceKind: sourceKind(raw, sourceType),
    flight: boundedString(raw.flight, STRING_LIMITS.flight, stats),
    observedAt: isoMinusSeconds(receivedAtMs, seen),
    positionAt: hasPosition ? isoMinusSeconds(receivedAtMs, seenPos) : null,
    lat: hasPosition ? lat : null,
    lon: hasPosition ? lon : null,
    altBaro: baro.value,
    altGeom: finiteInRange(raw.alt_geom, -2000, 100000, stats),
    onGround: baro.onGround,
    gs: finiteInRange(raw.gs, 0, 3000, stats),
    ias: finiteInRange(raw.ias, 0, 3000, stats),
    tas: finiteInRange(raw.tas, 0, 3000, stats),
    mach: finiteInRange(raw.mach, 0, 10, stats),
    track: heading(raw.track, stats),
    trueHeading: heading(raw.true_heading, stats),
    magHeading: heading(raw.mag_heading, stats),
    baroRate: finiteInRange(raw.baro_rate, -50000, 50000, stats),
    geomRate: finiteInRange(raw.geom_rate, -50000, 50000, stats),
    trackRate: finiteInRange(raw.track_rate, -50000, 50000, stats),
    roll: finiteInRange(raw.roll, -180, 180, stats),
    squawk: boundedString(raw.squawk, STRING_LIMITS.squawk, stats),
    category: boundedString(raw.category, STRING_LIMITS.category, stats),
    emergency: boundedString(raw.emergency, STRING_LIMITS.emergency, stats),
    navQnh: finiteInRange(raw.nav_qnh, 800, 1200, stats),
    navAltitudeMcp: finiteInRange(raw.nav_altitude_mcp, -2000, 100000, stats),
    navAltitudeFms: finiteInRange(raw.nav_altitude_fms, -2000, 100000, stats),
    navHeading: heading(raw.nav_heading, stats),
    windDirection: heading(raw.wd, stats),
    windSpeed: finiteInRange(raw.ws, 0, 500, stats),
    oat: finiteInRange(raw.oat, -200, 200, stats),
    tat: finiteInRange(raw.tat, -200, 200, stats),
    nacP: safeInteger(raw.nac_p, stats),
    nacV: safeInteger(raw.nac_v, stats),
    nic: safeInteger(raw.nic, stats),
    nicBaro: safeInteger(raw.nic_baro, stats),
    rc: safeInteger(raw.rc, stats),
    sil: safeInteger(raw.sil, stats),
    silType: boundedString(raw.sil_type, STRING_LIMITS.silType, stats),
    version: safeInteger(raw.version, stats),
    alert: safeInteger(raw.alert, stats),
    spi: safeInteger(raw.spi, stats),
    messages: safeInteger(raw.messages, stats),
    rssi: finiteInRange(raw.rssi, -500, 100, stats),
    seenSeconds: seen,
    seenPosSeconds: hasPosition ? seenPos : null,
  };
}

export function isFreshObservation(observation, receivedAtIso, maxAgeSeconds) {
  const observed = Date.parse(observation.observedAt);
  const received = Date.parse(receivedAtIso);
  if (!Number.isFinite(observed) || !Number.isFinite(received)) return false;
  const age = received - observed;
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

export function sanitizeReceiverId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) return null;
  return id;
}
