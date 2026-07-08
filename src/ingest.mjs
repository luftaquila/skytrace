import { hashToken, nowIso } from "./db.mjs";
import { isFreshObservation, normalizeReadsbPayload, sanitizeReceiverId } from "./normalize-readsb.mjs";

function tokenHashSet(tokens) {
  return new Set((tokens || []).map((token) => hashToken(token)));
}

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

function secondsBetween(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 1000;
}

function toRadians(deg) {
  return deg * Math.PI / 180;
}

function toDegrees(rad) {
  return rad * 180 / Math.PI;
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

function initialBearingDegrees(aLat, aLon, bLat, bLon) {
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const dLon = toRadians(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function finiteLatLon(lat, lon) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
}

function roundCoord(value) {
  return Number(Number(value).toFixed(6));
}

function pointCoord(row) {
  return [roundCoord(row.lon), roundCoord(row.lat)];
}

function closeRing(coords) {
  if (coords.length < 3) return null;
  const [firstLon, firstLat] = coords[0];
  const [lastLon, lastLat] = coords[coords.length - 1];
  const ring = firstLon === lastLon && firstLat === lastLat ? coords : [...coords, coords[0]];
  return ring.length >= 4 ? ring : null;
}

function coverageRingForReceiver(rows, receiverLat, receiverLon, stepDegrees) {
  if (!finiteLatLon(receiverLat, receiverLon)) {
    return closeRing(convexHull(rows.map(pointCoord)));
  }

  const step = Math.max(0.1, Math.min(10, Number(stepDegrees) || 1));
  const buckets = new Map();
  for (const row of rows) {
    const bearing = initialBearingDegrees(receiverLat, receiverLon, row.lat, row.lon);
    const bucket = ((Math.round(bearing / step) * step) % 360).toFixed(3);
    const distance = distanceNauticalMiles(receiverLat, receiverLon, row.lat, row.lon);
    const existing = buckets.get(bucket);
    if (!existing || distance > existing.distance || (
      distance === existing.distance && String(row.position_at) > String(existing.row.position_at)
    )) {
      buckets.set(bucket, { bearing, distance, row });
    }
  }

  return closeRing([...buckets.values()]
    .sort((a, b) => a.bearing - b.bearing)
    .map(({ row }) => pointCoord(row)));
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points) {
  const unique = [...new Map(points.map((point) => [point.join(","), point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length <= 1) return unique;

  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function plausiblePosition(previous, row, options) {
  if (!previous || row.lat == null || row.lon == null || !row.positionAt) return true;
  const dtHours = secondsBetween(previous.position_at, row.positionAt) / 3600;
  if (!Number.isFinite(dtHours) || dtHours <= 0) return true;
  const nm = distanceNauticalMiles(previous.lat, previous.lon, row.lat, row.lon);
  const requiredKt = nm / dtHours;
  const maxKt = (options.positionFilterMaxMach || 3.5) * 666.739;
  return requiredKt <= maxKt;
}

export function isValidAircraftId(value) {
  return /^~?[0-9a-f]{6}$/.test(String(value || "").trim().toLowerCase());
}

export function authenticateIngest(db, config, token, receiverId = null) {
  if (!token) return { ok: false, reason: "missing token" };
  const tokenHash = hashToken(token);

  const receiverToken = db
    .prepare("SELECT receiver_id FROM receiver_tokens WHERE token_hash = ?")
    .get(tokenHash);
  if (receiverToken && (!receiverId || receiverToken.receiver_id === receiverId)) {
    db.prepare("UPDATE receiver_tokens SET last_used_at = ? WHERE token_hash = ?").run(nowIso(), tokenHash);
    return { ok: true, receiverId: receiverToken.receiver_id, mode: "receiver-token" };
  }

  if (tokenHashSet(config.ingestTokens).has(tokenHash)) {
    return { ok: true, receiverId, mode: "shared-token" };
  }

  return { ok: false, reason: "invalid token" };
}

export function ingestReadsb(db, payload, options) {
  const receivedAt = options.receivedAt || nowIso();
  const receiver = payload?.receiver || {};
  const receiverId = sanitizeReceiverId(options.receiverId || receiver.id);
  if (!receiverId) {
    const error = new Error("receiver id is required");
    error.status = 400;
    throw error;
  }

  const aircraftPayload = getPayloadAircraft(payload);
  const normalized = normalizeReadsbPayload(aircraftPayload, { receivedAt });
  const receiverName = String(receiver.name || receiverId).trim().slice(0, 120);
  const publicName = String(receiver.publicName || receiver.public_name || receiverName).trim().slice(0, 120);
  const showPosition = receiver.showPosition === true || receiver.publicPosition === true;
  const receiverLat = optionalNumber(receiver.lat);
  const receiverLon = optionalNumber(receiver.lon);

  const statements = {
    upsertReceiver: db.prepare(`
      INSERT INTO receivers (
        id, name, public_name, lat, lon, show_position, last_seen_at, last_ip,
        user_agent, total_ingests, updated_at
      )
      VALUES (
        @id, @name, @publicName, @lat, @lon, @showPosition, @receivedAt, @remoteAddr,
        @userAgent, 1, @receivedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, receivers.name),
        public_name = COALESCE(excluded.public_name, receivers.public_name),
        lat = COALESCE(excluded.lat, receivers.lat),
        lon = COALESCE(excluded.lon, receivers.lon),
        show_position = CASE WHEN excluded.show_position = 1 THEN 1 ELSE receivers.show_position END,
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
        seen_pos_seconds, source_json, batch_id
      )
      VALUES (
        @receiverId, @hex, @observedAt, @positionAt, @lat, @lon, @flight, @altBaro,
        @altGeom, @onGround, @gs, @ias, @tas, @mach, @track, @trueHeading, @magHeading,
        @baroRate, @geomRate, @trackRate, @roll, @squawk, @category, @sourceType,
        @sourceKind, @emergency, @navQnh, @navAltitudeMcp, @navAltitudeFms,
        @navHeading, @windDirection, @windSpeed, @oat, @tat, @nacP, @nacV, @nic,
        @nicBaro, @rc, @sil, @silType, @version, @alert, @spi, @nonIcao,
        @messages, @rssi, @seenSeconds, @seenPosSeconds, @sourceJson, @batchId
      )
      ON CONFLICT(receiver_id, hex) DO UPDATE SET
        observed_at = excluded.observed_at,
        position_at = COALESCE(excluded.position_at, receiver_aircraft_current.position_at),
        lat = COALESCE(excluded.lat, receiver_aircraft_current.lat),
        lon = COALESCE(excluded.lon, receiver_aircraft_current.lon),
        flight = COALESCE(excluded.flight, receiver_aircraft_current.flight),
        alt_baro = COALESCE(excluded.alt_baro, receiver_aircraft_current.alt_baro),
        alt_geom = COALESCE(excluded.alt_geom, receiver_aircraft_current.alt_geom),
        on_ground = excluded.on_ground,
        gs = COALESCE(excluded.gs, receiver_aircraft_current.gs),
        ias = COALESCE(excluded.ias, receiver_aircraft_current.ias),
        tas = COALESCE(excluded.tas, receiver_aircraft_current.tas),
        mach = COALESCE(excluded.mach, receiver_aircraft_current.mach),
        track = COALESCE(excluded.track, receiver_aircraft_current.track),
        true_heading = COALESCE(excluded.true_heading, receiver_aircraft_current.true_heading),
        mag_heading = COALESCE(excluded.mag_heading, receiver_aircraft_current.mag_heading),
        baro_rate = COALESCE(excluded.baro_rate, receiver_aircraft_current.baro_rate),
        geom_rate = COALESCE(excluded.geom_rate, receiver_aircraft_current.geom_rate),
        track_rate = COALESCE(excluded.track_rate, receiver_aircraft_current.track_rate),
        roll = COALESCE(excluded.roll, receiver_aircraft_current.roll),
        squawk = COALESCE(excluded.squawk, receiver_aircraft_current.squawk),
        category = COALESCE(excluded.category, receiver_aircraft_current.category),
        source_type = COALESCE(excluded.source_type, receiver_aircraft_current.source_type),
        source_kind = COALESCE(excluded.source_kind, receiver_aircraft_current.source_kind),
        emergency = COALESCE(excluded.emergency, receiver_aircraft_current.emergency),
        nav_qnh = COALESCE(excluded.nav_qnh, receiver_aircraft_current.nav_qnh),
        nav_altitude_mcp = COALESCE(excluded.nav_altitude_mcp, receiver_aircraft_current.nav_altitude_mcp),
        nav_altitude_fms = COALESCE(excluded.nav_altitude_fms, receiver_aircraft_current.nav_altitude_fms),
        nav_heading = COALESCE(excluded.nav_heading, receiver_aircraft_current.nav_heading),
        wd = COALESCE(excluded.wd, receiver_aircraft_current.wd),
        ws = COALESCE(excluded.ws, receiver_aircraft_current.ws),
        oat = COALESCE(excluded.oat, receiver_aircraft_current.oat),
        tat = COALESCE(excluded.tat, receiver_aircraft_current.tat),
        nac_p = COALESCE(excluded.nac_p, receiver_aircraft_current.nac_p),
        nac_v = COALESCE(excluded.nac_v, receiver_aircraft_current.nac_v),
        nic = COALESCE(excluded.nic, receiver_aircraft_current.nic),
        nic_baro = COALESCE(excluded.nic_baro, receiver_aircraft_current.nic_baro),
        rc = COALESCE(excluded.rc, receiver_aircraft_current.rc),
        sil = COALESCE(excluded.sil, receiver_aircraft_current.sil),
        sil_type = COALESCE(excluded.sil_type, receiver_aircraft_current.sil_type),
        version = COALESCE(excluded.version, receiver_aircraft_current.version),
        alert = COALESCE(excluded.alert, receiver_aircraft_current.alert),
        spi = COALESCE(excluded.spi, receiver_aircraft_current.spi),
        non_icao = excluded.non_icao,
        messages = COALESCE(excluded.messages, receiver_aircraft_current.messages),
        rssi = COALESCE(excluded.rssi, receiver_aircraft_current.rssi),
        seen_seconds = excluded.seen_seconds,
        seen_pos_seconds = excluded.seen_pos_seconds,
        source_json = excluded.source_json,
        batch_id = excluded.batch_id
      WHERE excluded.observed_at >= receiver_aircraft_current.observed_at
    `),
    latestTrack: db.prepare(`
      SELECT position_at, lat, lon FROM track_points
      WHERE hex = ? AND receiver_id = ?
      ORDER BY position_at DESC
      LIMIT 1
    `),
    insertTrack: db.prepare(`
      INSERT OR IGNORE INTO track_points (
        hex, receiver_id, observed_at, position_at, lat, lon, alt_baro, alt_geom,
        on_ground, gs, ias, tas, mach, track, true_heading, mag_heading,
        baro_rate, geom_rate, wd, ws, oat, tat, source_type, messages, rssi,
        batch_id
      )
      VALUES (
        @hex, @receiverId, @observedAt, @positionAt, @lat, @lon, @altBaro, @altGeom,
        @onGround, @gs, @ias, @tas, @mach, @track, @trueHeading, @magHeading,
        @baroRate, @geomRate, @windDirection, @windSpeed, @oat, @tat,
        @sourceType, @messages, @rssi, @batchId
      )
    `),
    upsertSighting: db.prepare(`
      INSERT INTO aircraft_sightings (hex, first_seen_at, last_seen_at, total_observations, last_flight)
      VALUES (@hex, @observedAt, @observedAt, 1, @flight)
      ON CONFLICT(hex) DO UPDATE SET
        last_seen_at = CASE
          WHEN excluded.last_seen_at > aircraft_sightings.last_seen_at
          THEN excluded.last_seen_at
          ELSE aircraft_sightings.last_seen_at
        END,
        total_observations = aircraft_sightings.total_observations + 1,
        last_flight = COALESCE(excluded.last_flight, aircraft_sightings.last_flight)
    `),
  };

  const tx = db.transaction(() => {
    statements.upsertReceiver.run({
      id: receiverId,
      name: receiverName || receiverId,
      publicName: publicName || receiverName || receiverId,
      lat: receiverLat,
      lon: receiverLon,
      showPosition: showPosition ? 1 : 0,
      receivedAt,
      remoteAddr: options.remoteAddr || null,
      userAgent: options.userAgent || null,
    });

    const batch = statements.insertBatch.run({
      receiverId,
      receivedAt,
      sourceNow: normalized.sourceNow,
      aircraftCount: aircraftPayload.aircraft.length,
      remoteAddr: options.remoteAddr || null,
    });

    let acceptedCount = 0;
    let trackPoints = 0;
    let staleCount = 0;
    let filteredPositionCount = 0;
    const changedHexes = new Set();

    for (const observation of normalized.aircraft) {
      if (!isFreshObservation(observation, receivedAt, options.maxObservationAgeSeconds)) {
        staleCount += 1;
        continue;
      }

      const row = {
        receiverId,
        batchId: batch.lastInsertRowid,
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
        sourceJson: JSON.stringify(observation.raw),
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
      statements.upsertSighting.run(row);
      acceptedCount += 1;
      changedHexes.add(observation.hex);

      if (row.lat != null && row.lon != null && row.positionAt) {
        if (!latest || secondsBetween(latest.position_at, row.positionAt) >= options.trackMinIntervalSeconds) {
          trackPoints += statements.insertTrack.run(row).changes;
        }
      }
    }

    statements.updateBatch.run({
      batchId: batch.lastInsertRowid,
      acceptedCount,
      trackPoints,
    });

    return {
      receiverId,
      batchId: batch.lastInsertRowid,
      receivedAt,
      sourceNow: normalized.sourceNow,
      aircraftCount: aircraftPayload.aircraft.length,
      acceptedCount,
      staleCount,
      filteredPositionCount,
      trackPoints,
      changedHexes: [...changedHexes],
    };
  });

  return tx();
}

export function getCurrentAircraft(db, options = {}) {
  const now = options.now || nowIso();
  const cutoff = new Date(Date.parse(now) - options.currentWindowSeconds * 1000).toISOString();
  const rows = db
    .prepare(`
      SELECT
        c.*,
        r.public_name AS receiver_public_name
      FROM receiver_aircraft_current c
      JOIN receivers r ON r.id = c.receiver_id
      WHERE c.observed_at >= ?
      ORDER BY c.hex, c.observed_at DESC
    `)
    .all(cutoff);

  const groups = new Map();
  for (const row of rows) {
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
    aircraft.push({
      hex,
      flight: best.flight,
      lat: best.lat,
      lon: best.lon,
      altBaro: best.alt_baro,
      altGeom: best.alt_geom,
      onGround: Boolean(best.on_ground),
      gs: best.gs,
      ias: best.ias,
      tas: best.tas,
      mach: best.mach,
      track: best.track,
      trueHeading: best.true_heading,
      magHeading: best.mag_heading,
      baroRate: best.baro_rate,
      geomRate: best.geom_rate,
      trackRate: best.track_rate,
      roll: best.roll,
      squawk: best.squawk,
      category: best.category,
      sourceType: best.source_type,
      sourceKind: best.source_kind,
      emergency: best.emergency,
      navQnh: best.nav_qnh,
      navAltitudeMcp: best.nav_altitude_mcp,
      navAltitudeFms: best.nav_altitude_fms,
      navHeading: best.nav_heading,
      windDirection: best.wd,
      windSpeed: best.ws,
      oat: best.oat,
      tat: best.tat,
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
      rssi: best.rssi,
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
  const rows = db
    .prepare(`
      SELECT
        r.id,
        r.public_name,
        r.lat,
        r.lon,
        r.show_position,
        r.last_seen_at,
        r.total_ingests,
        COUNT(c.hex) AS current_aircraft
      FROM receivers r
      LEFT JOIN receiver_aircraft_current c
        ON c.receiver_id = r.id AND c.observed_at >= ?
      GROUP BY r.id
      ORDER BY r.public_name, r.id
    `)
    .all(cutoff);

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

export function getTrack(db, hex, options = {}) {
  const normalizedHex = String(hex || "").trim().toLowerCase();
  if (!isValidAircraftId(normalizedHex)) return [];
  const nowMs = Date.parse(options.now || nowIso());
  const to = options.to ? new Date(options.to).toISOString() : new Date(nowMs).toISOString();
  const from = options.from
    ? new Date(options.from).toISOString()
    : new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.max(1, Math.min(options.limit || 10000, 50000));

  return db
    .prepare(`
      SELECT
        hex, receiver_id AS receiverId, observed_at AS observedAt,
        position_at AS positionAt, lat, lon, alt_baro AS altBaro,
        alt_geom AS altGeom, on_ground AS onGround, gs, ias, tas, mach,
        track, true_heading AS trueHeading, mag_heading AS magHeading,
        baro_rate AS baroRate, geom_rate AS geomRate,
        wd AS windDirection, ws AS windSpeed, oat, tat,
        source_type AS sourceType, messages, rssi
      FROM track_points
      WHERE hex = ? AND position_at >= ? AND position_at <= ?
      ORDER BY position_at ASC
      LIMIT ?
    `)
    .all(normalizedHex, from, to, limit)
    .map((row) => ({ ...row, onGround: Boolean(row.onGround) }));
}

export function getCoverage(db, options = {}) {
  const nowMs = Date.parse(options.now || nowIso());
  const from = new Date(nowMs - (options.coverageWindowHours || 720) * 3600 * 1000).toISOString();
  const limit = Math.max(100, Math.min(options.coverageMaxPoints || 50000, 250000));
  const rows = db.prepare(`
    SELECT
      t.receiver_id,
      r.public_name AS receiver_name,
      r.lat AS receiver_lat,
      r.lon AS receiver_lon,
      t.position_at,
      t.lat,
      t.lon,
      t.alt_baro,
      t.alt_geom
    FROM track_points t
    JOIN receivers r ON r.id = t.receiver_id
    WHERE t.position_at >= ?
      AND t.lat IS NOT NULL
      AND t.lon IS NOT NULL
    ORDER BY t.position_at DESC
    LIMIT ?
  `).all(from, limit);

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
    type: "observed-envelope",
    count: rows.length,
    receiverCount: groups.size,
    bounds: bounds.minLat == null ? null : [
      [roundCoord(bounds.minLat), roundCoord(bounds.minLon)],
      [roundCoord(bounds.maxLat), roundCoord(bounds.maxLon)],
    ],
    areas: [...groups.values()].map((group) => {
      const ring = coverageRingForReceiver(
        group.rows,
        group.receiverLat,
        group.receiverLon,
        options.coverageBearingStepDegrees,
      );
      return {
        receiverName: group.receiverName,
        count: group.count,
        maxAltitude: group.maxAltitude,
        lastSeenAt: group.lastSeenAt,
        polygon: ring ? { type: "Polygon", coordinates: [ring] } : null,
      };
    }).sort((a, b) => b.count - a.count),
    points: rows.map((row) => ({
      lat: roundCoord(row.lat),
      lon: roundCoord(row.lon),
      maxAltitude: row.alt_baro ?? row.alt_geom,
      lastSeenAt: row.position_at,
    })),
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
