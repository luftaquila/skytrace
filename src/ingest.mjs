import { hashToken, nowIso } from "./db.mjs";
import { normalizeReadsbPayload, sanitizeReceiverId } from "./normalize-readsb.mjs";
import { buildObservedCoverageMesh } from "./coverage-volume.mjs";

const MAX_INGEST_AIRCRAFT = 1000;
const MAX_RECEIVER_CURRENT_AIRCRAFT = 20000;
const ingestStatementsByDatabase = new WeakMap();
const readStatementsByDatabase = new WeakMap();

function getPayloadAircraft(payload) {
  if (Array.isArray(payload?.aircraft)) return payload;
  if (Array.isArray(payload?.payload?.aircraft)) return payload.payload;
  return { ...payload, aircraft: [] };
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedText(value, limit, fallback = null) {
  if (value == null) return { value: fallback, invalid: false, truncated: false };
  if (!["string", "number", "boolean"].includes(typeof value)) {
    return { value: fallback, invalid: true, truncated: false };
  }
  const text = String(value).trim();
  if (!text) return { value: fallback, invalid: false, truncated: false };
  return {
    value: text.slice(0, limit),
    invalid: false,
    truncated: text.length > limit,
  };
}

function coordinate(value, min, max) {
  const number = optionalNumber(value);
  return number != null && number >= min && number <= max ? number : null;
}

function secondsBetween(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 1000;
}

function toRadians(deg) {
  return deg * Math.PI / 180;
}

function distanceNauticalMiles(aLat, aLon, bLat, bLon) {
  const radiusNm = 3440.065;
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusNm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function finiteLatLon(lat, lon) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
}

function roundCoord(value) {
  return Number(Number(value).toFixed(6));
}

function coverageCentroid(positioned) {
  return {
    lat: positioned.reduce((sum, row) => sum + row.lat, 0) / positioned.length,
    lon: positioned.reduce((sum, row) => sum + row.lon, 0) / positioned.length,
  };
}

function plausiblePosition(previous, row, options) {
  if (!previous || row.lat == null || row.lon == null || !row.positionAt) return true;
  const dtHours = secondsBetween(previous.position_at, row.positionAt) / 3600;
  if (!Number.isFinite(dtHours) || dtHours <= 0) return false;
  const nm = distanceNauticalMiles(previous.lat, previous.lon, row.lat, row.lon);
  const requiredKt = nm / dtHours;
  const maxKt = (options.positionFilterMaxMach || 3.5) * 666.739;
  return requiredKt <= maxKt;
}

export function isValidAircraftId(value) {
  return /^~?[0-9a-f]{6}$/.test(String(value || "").trim().toLowerCase());
}

function readStatements(db) {
  let statements = readStatementsByDatabase.get(db);
  if (statements) return statements;
  statements = {
    receiverToken: db.prepare("SELECT receiver_id FROM receiver_tokens WHERE token_hash = ?"),
    currentAircraft: db.prepare(`
      SELECT
        c.receiver_id, c.hex, c.observed_at, c.position_at, c.lat, c.lon,
        c.flight, c.alt_baro, c.alt_geom, c.on_ground, c.gs, c.ias, c.tas,
        c.mach, c.track, c.true_heading, c.mag_heading, c.baro_rate,
        c.geom_rate, c.track_rate, c.roll, c.squawk, c.category,
        c.source_type, c.source_kind, c.emergency, c.nav_qnh,
        c.nav_altitude_mcp, c.nav_altitude_fms, c.nav_heading, c.wd, c.ws,
        c.oat, c.tat, c.nac_p, c.nac_v, c.nic, c.nic_baro, c.rc, c.sil,
        c.sil_type, c.version, c.alert, c.spi, c.non_icao, c.messages, c.rssi
      FROM receiver_aircraft_current c
      WHERE c.observed_at >= ?
      ORDER BY c.hex, c.observed_at DESC
    `),
    publicReceivers: db.prepare(`
      SELECT
        r.id,
        r.public_name,
        r.last_seen_at,
        r.total_ingests,
        COUNT(c.hex) AS current_aircraft
      FROM receivers r
      LEFT JOIN receiver_aircraft_current c
        ON c.receiver_id = r.id AND c.observed_at >= ?
      GROUP BY r.id
      ORDER BY r.public_name, r.id
    `),
  };
  readStatementsByDatabase.set(db, statements);
  return statements;
}

export function authenticateIngest(db, token, receiverId = null) {
  if (!token) return { ok: false, reason: "missing token" };
  const tokenHash = hashToken(token);

  const receiverToken = readStatements(db).receiverToken.get(tokenHash);
  if (receiverToken && (!receiverId || receiverToken.receiver_id === receiverId)) {
    return { ok: true, receiverId: receiverToken.receiver_id, tokenHash };
  }
  return { ok: false, reason: "invalid token" };
}

function ingestStatements(db) {
  let statements = ingestStatementsByDatabase.get(db);
  if (statements) return statements;
  statements = {
    upsertReceiver: db.prepare(`
      INSERT INTO receivers (
        id, name, public_name, lat, lon, last_seen_at, last_ip,
        user_agent, total_ingests, updated_at
      )
      VALUES (
        @id, @name, @publicName, @lat, @lon, @receivedAt, @remoteAddr,
        @userAgent, 1, @receivedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, receivers.name),
        public_name = COALESCE(excluded.public_name, receivers.public_name),
        lat = COALESCE(excluded.lat, receivers.lat),
        lon = COALESCE(excluded.lon, receivers.lon),
        last_seen_at = excluded.last_seen_at,
        last_ip = excluded.last_ip,
        user_agent = excluded.user_agent,
        total_ingests = receivers.total_ingests + 1,
        updated_at = excluded.updated_at
    `),
    insertBatch: db.prepare(`
      INSERT INTO ingest_batches (
        receiver_id, received_at, source_now, aircraft_count, accepted_count,
        track_points, remote_addr
      )
      VALUES (@receiverId, @receivedAt, @sourceNow, @aircraftCount, 0, 0, @remoteAddr)
    `),
    updateBatch: db.prepare(`
      UPDATE ingest_batches
      SET accepted_count = @acceptedCount, track_points = @trackPoints
      WHERE id = @batchId
    `),
    upsertCurrent: db.prepare(`
      INSERT INTO receiver_aircraft_current (
        receiver_id, hex, observed_at, position_at, lat, lon, flight, alt_baro,
        alt_geom, on_ground, gs, ias, tas, mach, track, true_heading, mag_heading,
        baro_rate, geom_rate, track_rate, roll, squawk, category, source_type,
        source_kind, emergency, nav_qnh, nav_altitude_mcp, nav_altitude_fms,
        nav_heading, wd, ws, oat, tat, nac_p, nac_v, nic, nic_baro, rc, sil,
        sil_type, version, alert, spi, non_icao, messages, rssi, seen_seconds,
        seen_pos_seconds
      )
      VALUES (
        @receiverId, @hex, @observedAt, @positionAt, @lat, @lon, @flight, @altBaro,
        @altGeom, @onGround, @gs, @ias, @tas, @mach, @track, @trueHeading, @magHeading,
        @baroRate, @geomRate, @trackRate, @roll, @squawk, @category, @sourceType,
        @sourceKind, @emergency, @navQnh, @navAltitudeMcp, @navAltitudeFms,
        @navHeading, @windDirection, @windSpeed, @oat, @tat, @nacP, @nacV, @nic,
        @nicBaro, @rc, @sil, @silType, @version, @alert, @spi, @nonIcao,
        @messages, @rssi, @seenSeconds, @seenPosSeconds
      )
      ON CONFLICT(receiver_id, hex) DO UPDATE SET
        observed_at = excluded.observed_at,
        position_at = excluded.position_at,
        lat = excluded.lat,
        lon = excluded.lon,
        flight = excluded.flight,
        alt_baro = excluded.alt_baro,
        alt_geom = excluded.alt_geom,
        on_ground = excluded.on_ground,
        gs = excluded.gs,
        ias = excluded.ias,
        tas = excluded.tas,
        mach = excluded.mach,
        track = excluded.track,
        true_heading = excluded.true_heading,
        mag_heading = excluded.mag_heading,
        baro_rate = excluded.baro_rate,
        geom_rate = excluded.geom_rate,
        track_rate = excluded.track_rate,
        roll = excluded.roll,
        squawk = excluded.squawk,
        category = excluded.category,
        source_type = excluded.source_type,
        source_kind = excluded.source_kind,
        emergency = excluded.emergency,
        nav_qnh = excluded.nav_qnh,
        nav_altitude_mcp = excluded.nav_altitude_mcp,
        nav_altitude_fms = excluded.nav_altitude_fms,
        nav_heading = excluded.nav_heading,
        wd = excluded.wd,
        ws = excluded.ws,
        oat = excluded.oat,
        tat = excluded.tat,
        nac_p = excluded.nac_p,
        nac_v = excluded.nac_v,
        nic = excluded.nic,
        nic_baro = excluded.nic_baro,
        rc = excluded.rc,
        sil = excluded.sil,
        sil_type = excluded.sil_type,
        version = excluded.version,
        alert = excluded.alert,
        spi = excluded.spi,
        non_icao = excluded.non_icao,
        messages = excluded.messages,
        rssi = excluded.rssi,
        seen_seconds = excluded.seen_seconds,
        seen_pos_seconds = excluded.seen_pos_seconds
      WHERE excluded.observed_at >= receiver_aircraft_current.observed_at
    `),
    latestTrack: db.prepare(`
      SELECT position_at, lat, lon FROM track_points
      WHERE hex = ? AND receiver_id = ?
      ORDER BY id DESC
      LIMIT 1
    `),
    insertTrack: db.prepare(`
      INSERT OR IGNORE INTO track_points (
        hex, receiver_id, observed_at, position_at, lat, lon, alt_baro, alt_geom,
        on_ground, gs, ias, tas, mach, track, true_heading, mag_heading,
        baro_rate, geom_rate, wd, ws, oat, tat, source_type, messages, rssi
      )
      VALUES (
        @hex, @receiverId, @observedAt, @positionAt, @lat, @lon, @altBaro, @altGeom,
        @onGround, @gs, @ias, @tas, @mach, @track, @trueHeading, @magHeading,
        @baroRate, @geomRate, @windDirection, @windSpeed, @oat, @tat,
        @sourceType, @messages, @rssi
      )
    `),
    currentCount: db.prepare("SELECT count(*) AS count FROM receiver_aircraft_current WHERE receiver_id = ?"),
    currentExists: db.prepare(
      "SELECT 1 AS present FROM receiver_aircraft_current WHERE receiver_id = ? AND hex = ?",
    ),
    touchToken: db.prepare("UPDATE receiver_tokens SET last_used_at = ? WHERE token_hash = ?"),
  };
  ingestStatementsByDatabase.set(db, statements);
  return statements;
}

export function ingestReadsb(db, payload, options) {
  const receivedAt = options.receivedAt || nowIso();
  const receiver = payload?.receiver || {};
  const receiverId = sanitizeReceiverId(options.receiverId);
  if (!receiverId) {
    const error = new Error("receiver id is required");
    error.status = 400;
    throw error;
  }
  const aircraftPayload = getPayloadAircraft(payload);
  const rawAircraft = aircraftPayload.aircraft;
  const boundedPayload = {
    ...aircraftPayload,
    aircraft: rawAircraft.slice(0, MAX_INGEST_AIRCRAFT),
  };
  const normalized = normalizeReadsbPayload(boundedPayload, {
    receivedAt,
    maxObservationAgeSeconds: options.maxObservationAgeSeconds,
  });
  const receiverNameField = boundedText(receiver.name, 120, receiverId);
  const publicNameField = boundedText(
    receiver.publicName ?? receiver.public_name,
    120,
    receiverNameField.value,
  );
  const remoteAddrField = boundedText(options.remoteAddr, 64);
  const userAgentField = boundedText(options.userAgent, 256);
  const receiverLat = coordinate(receiver.lat, -90, 90);
  const receiverLon = coordinate(receiver.lon, -180, 180);
  let invalidFieldCount = normalized.invalidFieldCount
    + Number(receiverLat == null && receiver.lat != null)
    + Number(receiverLon == null && receiver.lon != null)
    + Number(receiverNameField.invalid)
    + Number(publicNameField.invalid)
    + Number(remoteAddrField.invalid)
    + Number(userAgentField.invalid);
  let truncatedFieldCount = normalized.truncatedFieldCount
    + Number(receiverNameField.truncated)
    + Number(publicNameField.truncated)
    + Number(remoteAddrField.truncated)
    + Number(userAgentField.truncated);
  const statements = ingestStatements(db);

  const tx = db.transaction(() => {
    statements.upsertReceiver.run({
      id: receiverId,
      name: receiverNameField.value || receiverId,
      publicName: publicNameField.value || receiverNameField.value || receiverId,
      lat: receiverLat,
      lon: receiverLon,
      receivedAt,
      remoteAddr: remoteAddrField.value,
      userAgent: userAgentField.value,
    });

    const batch = statements.insertBatch.run({
      receiverId,
      receivedAt,
      sourceNow: normalized.sourceNow,
      aircraftCount: rawAircraft.length,
      remoteAddr: remoteAddrField.value,
    });

    let acceptedCount = 0;
    let trackPoints = 0;
    let filteredPositionCount = 0;
    let trackBudgetDroppedCount = 0;
    let currentCapacityDroppedCount = 0;
    let currentCount = Number(statements.currentCount.get(receiverId).count);
    const changedHexes = new Set();

    for (const observation of normalized.aircraft) {
      const exists = Boolean(statements.currentExists.get(receiverId, observation.hex));
      if (!exists && currentCount >= MAX_RECEIVER_CURRENT_AIRCRAFT) {
        currentCapacityDroppedCount += 1;
        continue;
      }
      const row = {
        receiverId,
        hex: observation.hex,
        observedAt: observation.observedAt,
        positionAt: observation.positionAt,
        lat: observation.lat,
        lon: observation.lon,
        flight: observation.flight,
        altBaro: observation.altBaro,
        altGeom: observation.altGeom,
        onGround: observation.onGround ? 1 : 0,
        gs: observation.gs,
        ias: observation.ias,
        tas: observation.tas,
        mach: observation.mach,
        track: observation.track,
        trueHeading: observation.trueHeading,
        magHeading: observation.magHeading,
        baroRate: observation.baroRate,
        geomRate: observation.geomRate,
        trackRate: observation.trackRate,
        roll: observation.roll,
        squawk: observation.squawk,
        category: observation.category,
        sourceType: observation.sourceType,
        sourceKind: observation.sourceKind,
        emergency: observation.emergency,
        navQnh: observation.navQnh,
        navAltitudeMcp: observation.navAltitudeMcp,
        navAltitudeFms: observation.navAltitudeFms,
        navHeading: observation.navHeading,
        windDirection: observation.windDirection,
        windSpeed: observation.windSpeed,
        oat: observation.oat,
        tat: observation.tat,
        nacP: observation.nacP,
        nacV: observation.nacV,
        nic: observation.nic,
        nicBaro: observation.nicBaro,
        rc: observation.rc,
        sil: observation.sil,
        silType: observation.silType,
        version: observation.version,
        alert: observation.alert,
        spi: observation.spi,
        nonIcao: observation.nonIcao ? 1 : 0,
        messages: observation.messages,
        rssi: observation.rssi,
        seenSeconds: observation.seenSeconds,
        seenPosSeconds: observation.seenPosSeconds,
      };

      const latest = row.lat != null && row.lon != null && row.positionAt
        ? statements.latestTrack.get(row.hex, receiverId)
        : null;
      if (latest && !plausiblePosition(latest, row, options)) {
        row.positionAt = null;
        row.lat = null;
        row.lon = null;
        filteredPositionCount += 1;
      }

      statements.upsertCurrent.run(row);
      if (!exists) currentCount += 1;
      acceptedCount += 1;
      changedHexes.add(observation.hex);

      if (row.lat != null && row.lon != null && row.positionAt) {
        if (!latest || secondsBetween(latest.position_at, row.positionAt) >= options.trackMinIntervalSeconds) {
          const budget = options.consumeTrackBudget?.(receiverId) || { ok: true };
          if (budget.ok) trackPoints += statements.insertTrack.run(row).changes;
          else trackBudgetDroppedCount += 1;
        }
      }
    }

    statements.updateBatch.run({
      batchId: batch.lastInsertRowid,
      acceptedCount,
      trackPoints,
    });
    if (options.tokenHash) statements.touchToken.run(receivedAt, options.tokenHash);

    return {
      receiverId,
      batchId: batch.lastInsertRowid,
      receivedAt,
      sourceNow: normalized.sourceNow,
      aircraftCount: rawAircraft.length,
      truncatedCount: Math.max(0, rawAircraft.length - MAX_INGEST_AIRCRAFT),
      acceptedCount,
      invalidObservationCount: normalized.invalidObservationCount,
      invalidFieldCount,
      truncatedFieldCount,
      filteredPositionCount,
      currentCapacityDroppedCount,
      trackBudgetDroppedCount,
      trackPoints,
      changedHexes: [...changedHexes],
    };
  });

  return tx();
}

export function getCurrentAircraft(db, options = {}) {
  const now = options.now || nowIso();
  const cutoff = new Date(Date.parse(now) - options.currentWindowSeconds * 1000).toISOString();
  const rows = readStatements(db).currentAircraft.all(cutoff);

  const groups = new Map();
  for (const row of rows) {
    if (!row.position_at || row.position_at < cutoff || row.position_at > now) {
      row.position_at = null;
      row.lat = null;
      row.lon = null;
    }
    const group = groups.get(row.hex) || [];
    group.push(row);
    groups.set(row.hex, group);
  }

  const aircraft = [];
  for (const [hex, group] of groups) {
    group.sort((a, b) => {
      const aPos = a.lat != null && a.lon != null ? 1 : 0;
      const bPos = b.lat != null && b.lon != null ? 1 : 0;
      if (aPos !== bPos) return bPos - aPos;
      return String(b.position_at || b.observed_at).localeCompare(String(a.position_at || a.observed_at));
    });
    const best = group[0];
    const receiverIds = new Set(group.map((row) => row.receiver_id));
    const round = (value, digits) => value == null ? null : Number(Number(value).toFixed(digits));
    const integer = (value) => value == null ? null : Math.round(Number(value));
    aircraft.push({
      hex,
      flight: best.flight,
      lat: round(best.lat, 5),
      lon: round(best.lon, 5),
      altBaro: integer(best.alt_baro),
      altGeom: integer(best.alt_geom),
      onGround: Boolean(best.on_ground),
      gs: round(best.gs, 1),
      ias: round(best.ias, 1),
      tas: round(best.tas, 1),
      mach: round(best.mach, 3),
      track: round(best.track, 1),
      trueHeading: round(best.true_heading, 1),
      magHeading: round(best.mag_heading, 1),
      baroRate: integer(best.baro_rate),
      geomRate: integer(best.geom_rate),
      trackRate: integer(best.track_rate),
      roll: round(best.roll, 1),
      squawk: best.squawk,
      category: best.category,
      sourceType: best.source_type,
      sourceKind: best.source_kind,
      emergency: best.emergency,
      navQnh: round(best.nav_qnh, 1),
      navAltitudeMcp: integer(best.nav_altitude_mcp),
      navAltitudeFms: integer(best.nav_altitude_fms),
      navHeading: round(best.nav_heading, 1),
      windDirection: round(best.wd, 1),
      windSpeed: round(best.ws, 1),
      oat: round(best.oat, 1),
      tat: round(best.tat, 1),
      nacP: best.nac_p,
      nacV: best.nac_v,
      nic: best.nic,
      nicBaro: best.nic_baro,
      rc: best.rc,
      sil: best.sil,
      silType: best.sil_type,
      version: best.version,
      alert: best.alert,
      spi: best.spi,
      nonIcao: Boolean(best.non_icao),
      messages: best.messages,
      rssi: round(best.rssi, 1),
      observedAt: best.observed_at,
      positionAt: best.position_at,
      receiverCount: receiverIds.size,
      bestReceiverId: best.receiver_id,
      receivers: [...receiverIds].sort(),
    });
  }

  aircraft.sort((a, b) => {
    const aPos = a.lat != null && a.lon != null ? 1 : 0;
    const bPos = b.lat != null && b.lon != null ? 1 : 0;
    if (aPos !== bPos) return bPos - aPos;
    return String(a.flight || a.hex).localeCompare(String(b.flight || b.hex));
  });

  return {
    now,
    cutoff,
    count: aircraft.length,
    summary: {
      withPosition: aircraft.filter((item) => item.lat != null && item.lon != null).length,
      onGround: aircraft.filter((item) => item.onGround).length,
      nonIcao: aircraft.filter((item) => item.nonIcao).length,
      sources: aircraft.reduce((acc, item) => {
        const key = item.sourceKind || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    },
    aircraft,
  };
}

export function getPublicReceivers(db, options = {}) {
  const now = options.now || nowIso();
  const cutoff = new Date(Date.parse(now) - options.currentWindowSeconds * 1000).toISOString();
  const rows = readStatements(db).publicReceivers.all(cutoff);

  return rows.map((row) => ({
    id: row.id,
    name: row.public_name || row.id,
    online: row.last_seen_at ? Date.parse(now) - Date.parse(row.last_seen_at) <= options.currentWindowSeconds * 1000 : false,
    lastSeenAt: row.last_seen_at,
    totalIngests: row.total_ingests,
    currentAircraft: row.current_aircraft,
    lat: null,
    lon: null,
  }));
}

// Build the public response from already bounded observations. Raw track selection and
// aggregation intentionally live outside this renderer so a worker can feed it compact,
// receiver-partitioned coverage cells instead of repeatedly loading an unbounded history.
export function buildCoverageSnapshotFromRows(rows, options = {}) {
  const nowMs = Date.parse(options.now || nowIso());
  const windowHours = Math.max(1, Number(options.coverageWindowHours) || 720);
  const from = options.from
    ? new Date(options.from).toISOString()
    : new Date(nowMs - windowHours * 3600 * 1000).toISOString();
  const groups = new Map();
  const bounds = {
    minLat: null,
    minLon: null,
    maxLat: null,
    maxLon: null,
  };
  for (const row of rows) {
    if (!finiteLatLon(row.lat, row.lon)) continue;
    const group = groups.get(row.receiver_id) || {
      receiverName: row.receiver_name || row.receiver_id,
      receiverLat: row.receiver_lat,
      receiverLon: row.receiver_lon,
      rows: [],
      count: 0,
      maxAltitude: null,
      lastSeenAt: null,
    };
    group.rows.push(row);
    group.count += 1;
    const alt = row.alt_baro ?? row.alt_geom;
    if (alt != null && (group.maxAltitude == null || alt > group.maxAltitude)) group.maxAltitude = alt;
    if (!group.lastSeenAt || row.position_at > group.lastSeenAt) group.lastSeenAt = row.position_at;
    groups.set(row.receiver_id, group);

    bounds.minLat = bounds.minLat == null ? row.lat : Math.min(bounds.minLat, row.lat);
    bounds.minLon = bounds.minLon == null ? row.lon : Math.min(bounds.minLon, row.lon);
    bounds.maxLat = bounds.maxLat == null ? row.lat : Math.max(bounds.maxLat, row.lat);
    bounds.maxLon = bounds.maxLon == null ? row.lon : Math.max(bounds.maxLon, row.lon);
  }

  return {
    from,
    to: new Date(nowMs).toISOString(),
    windowHours,
    windowDays: Number((windowHours / 24).toFixed(2)),
    type: "observed-occupancy",
    count: rows.length,
    receiverCount: groups.size,
    bounds: bounds.minLat == null ? null : [
      [roundCoord(bounds.minLat), roundCoord(bounds.minLon)],
      [roundCoord(bounds.maxLat), roundCoord(bounds.maxLon)],
    ],
    areas: [...groups.values()].map((group) => {
      // The mesh origin is the reception centroid, never the private receiver position. The
      // origin is only a local tangent-plane anchor and does not alter occupancy geometry.
      const meshOrigin = coverageCentroid(group.rows);
      return {
        receiverName: group.receiverName,
        count: group.count,
        maxAltitude: group.maxAltitude,
        lastSeenAt: group.lastSeenAt,
        volumeMesh: buildObservedCoverageMesh(group.rows, meshOrigin, {
          horizontalStepNm: options.coverageHorizontalStepNm,
          verticalStepFt: options.coverageVerticalStepFt,
          horizontalSupportNm: options.coverageHorizontalSupportNm,
          verticalSupportFt: options.coverageVerticalSupportFt,
          horizontalInterpolationCells: options.coverageHorizontalInterpolationCells,
          horizontalSmoothingPasses: options.coverageHorizontalSmoothingPasses,
          verticalSmoothingPasses: options.coverageVerticalSmoothingPasses,
          smoothingIterations: options.coverageSmoothingIterations,
          maxCells: options.coverageMaxCells,
          maxTriangles: options.coverageMaxTriangles,
        }),
      };
    }).sort((a, b) => b.count - a.count),
    // Raw points are never sent. The indexed, quantized mesh is substantially smaller than
    // either time-windowed cell JSON or an unindexed triangle list.
    points: [],
  };
}

export function trackToKml(hex, points) {
  const safeHex = String(hex || "").replace(/[<>&'"]/g, "");
  const coordinates = points
    .filter((point) => point.lat != null && point.lon != null)
    .map((point) => `${point.lon},${point.lat},${point.altGeom ?? point.altBaro ?? 0}`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Skytrace ${safeHex.toUpperCase()} track</name>
    <Placemark>
      <name>${safeHex.toUpperCase()}</name>
      <Style><LineStyle><color>ff24bffb</color><width>3</width></LineStyle></Style>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;
}
