function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerNumber(value) {
  const n = finiteNumber(value);
  return n == null ? null : Math.trunc(n);
}

function cleanString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function normalizeHex(value) {
  const hex = cleanString(value)?.toLowerCase();
  if (!hex || !/^~?[0-9a-f]{6}$/.test(hex)) return null;
  return hex;
}

function parseAltitude(value) {
  if (value === "ground") return { altitude: 0, onGround: true };
  return { altitude: finiteNumber(value), onGround: false };
}

function isoMinusSeconds(baseMs, seconds) {
  const n = finiteNumber(seconds);
  if (n == null) return new Date(baseMs).toISOString();
  return new Date(baseMs - n * 1000).toISOString();
}

function sourceKind(raw) {
  const type = cleanString(raw?.type)?.toLowerCase();
  if (type?.includes("mlat") || Array.isArray(raw?.mlat) && raw.mlat.length) return "mlat";
  if (type?.includes("tisb") || Array.isArray(raw?.tisb) && raw.tisb.length) return "tisb";
  if (type?.includes("uat")) return "uat";
  if (type?.includes("adsb")) return "adsb";
  return type || "unknown";
}

export function normalizeReadsbPayload(payload, options = {}) {
  const receivedAt = options.receivedAt ? new Date(options.receivedAt) : new Date();
  const sourceNowNumber = finiteNumber(payload?.now);
  const sourceNowMs = sourceNowNumber == null ? receivedAt.getTime() : sourceNowNumber * 1000;
  const aircraft = Array.isArray(payload?.aircraft) ? payload.aircraft : [];

  return {
    sourceNow: new Date(sourceNowMs).toISOString(),
    aircraft: aircraft.map((raw) => normalizeAircraft(raw, sourceNowMs)).filter(Boolean),
  };
}

export function normalizeAircraft(raw, sourceNowMs = Date.now()) {
  const hex = normalizeHex(raw?.hex);
  if (!hex) return null;

  const baro = parseAltitude(raw.alt_baro);
  const positionAt = raw.seen_pos == null ? null : isoMinusSeconds(sourceNowMs, raw.seen_pos);
  const lat = finiteNumber(raw.lat);
  const lon = finiteNumber(raw.lon);
  const hasPosition = lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

  return {
    hex,
    nonIcao: hex.startsWith("~") || (raw?.type ? !String(raw.type).toLowerCase().includes("icao") : false),
    sourceType: cleanString(raw.type),
    sourceKind: sourceKind(raw),
    flight: cleanString(raw.flight),
    observedAt: isoMinusSeconds(sourceNowMs, raw.seen),
    positionAt: hasPosition ? positionAt || isoMinusSeconds(sourceNowMs, raw.seen) : null,
    lat: hasPosition ? lat : null,
    lon: hasPosition ? lon : null,
    altBaro: baro.altitude,
    altGeom: finiteNumber(raw.alt_geom),
    onGround: baro.onGround || raw.airground === "ground",
    gs: finiteNumber(raw.gs),
    ias: finiteNumber(raw.ias),
    tas: finiteNumber(raw.tas),
    mach: finiteNumber(raw.mach),
    track: finiteNumber(raw.track),
    trueHeading: finiteNumber(raw.true_heading),
    magHeading: finiteNumber(raw.mag_heading),
    baroRate: finiteNumber(raw.baro_rate),
    geomRate: finiteNumber(raw.geom_rate),
    trackRate: finiteNumber(raw.track_rate),
    roll: finiteNumber(raw.roll),
    squawk: cleanString(raw.squawk),
    category: cleanString(raw.category),
    emergency: cleanString(raw.emergency),
    navQnh: finiteNumber(raw.nav_qnh),
    navAltitudeMcp: finiteNumber(raw.nav_altitude_mcp),
    navAltitudeFms: finiteNumber(raw.nav_altitude_fms),
    navHeading: finiteNumber(raw.nav_heading),
    windDirection: finiteNumber(raw.wd),
    windSpeed: finiteNumber(raw.ws),
    oat: finiteNumber(raw.oat),
    tat: finiteNumber(raw.tat),
    nacP: integerNumber(raw.nac_p),
    nacV: integerNumber(raw.nac_v),
    nic: integerNumber(raw.nic),
    nicBaro: integerNumber(raw.nic_baro),
    rc: integerNumber(raw.rc),
    sil: integerNumber(raw.sil),
    silType: cleanString(raw.sil_type),
    version: integerNumber(raw.version),
    alert: integerNumber(raw.alert),
    spi: integerNumber(raw.spi),
    messages: integerNumber(raw.messages),
    rssi: finiteNumber(raw.rssi),
    seenSeconds: finiteNumber(raw.seen),
    seenPosSeconds: finiteNumber(raw.seen_pos),
    raw,
  };
}

export function isFreshObservation(observation, receivedAtIso, maxAgeSeconds) {
  const observed = Date.parse(observation.observedAt);
  const received = Date.parse(receivedAtIso);
  if (!Number.isFinite(observed) || !Number.isFinite(received)) return false;
  return received - observed <= maxAgeSeconds * 1000;
}

export function sanitizeReceiverId(value) {
  const id = cleanString(value);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) return null;
  return id;
}
