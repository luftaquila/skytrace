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
        alt_geom, on_ground, gs, track, baro_rate, squawk, category, messages,
        rssi, seen_seconds, seen_pos_seconds, source_json, batch_id
      )
      VALUES (
        @receiverId, @hex, @observedAt, @positionAt, @lat, @lon, @flight, @altBaro,
        @altGeom, @onGround, @gs, @track, @baroRate, @squawk, @category, @messages,
        @rssi, @seenSeconds, @seenPosSeconds, @sourceJson, @batchId
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
        track = COALESCE(excluded.track, receiver_aircraft_current.track),
        baro_rate = COALESCE(excluded.baro_rate, receiver_aircraft_current.baro_rate),
        squawk = COALESCE(excluded.squawk, receiver_aircraft_current.squawk),
        category = COALESCE(excluded.category, receiver_aircraft_current.category),
        messages = COALESCE(excluded.messages, receiver_aircraft_current.messages),
        rssi = COALESCE(excluded.rssi, receiver_aircraft_current.rssi),
        seen_seconds = excluded.seen_seconds,
        seen_pos_seconds = excluded.seen_pos_seconds,
        source_json = excluded.source_json,
        batch_id = excluded.batch_id
      WHERE excluded.observed_at >= receiver_aircraft_current.observed_at
    `),
    latestTrack: db.prepare(`
      SELECT position_at FROM track_points
      WHERE hex = ? AND receiver_id = ?
      ORDER BY position_at DESC
      LIMIT 1
    `),
    insertTrack: db.prepare(`
      INSERT OR IGNORE INTO track_points (
        hex, receiver_id, observed_at, position_at, lat, lon, alt_baro, alt_geom,
        on_ground, gs, track, messages, batch_id
      )
      VALUES (
        @hex, @receiverId, @observedAt, @positionAt, @lat, @lon, @altBaro, @altGeom,
        @onGround, @gs, @track, @messages, @batchId
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
        track: observation.track,
        baroRate: observation.baroRate,
        squawk: observation.squawk,
        category: observation.category,
        messages: observation.messages,
        rssi: observation.rssi,
        seenSeconds: observation.seenSeconds,
        seenPosSeconds: observation.seenPosSeconds,
        sourceJson: JSON.stringify(observation.raw),
      };

      statements.upsertCurrent.run(row);
      statements.upsertSighting.run(row);
      acceptedCount += 1;
      changedHexes.add(observation.hex);

      if (row.lat != null && row.lon != null && row.positionAt) {
        const latest = statements.latestTrack.get(row.hex, receiverId);
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
      track: best.track,
      baroRate: best.baro_rate,
      squawk: best.squawk,
      category: best.category,
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
    lat: row.show_position ? row.lat : null,
    lon: row.show_position ? row.lon : null,
  }));
}

export function getTrack(db, hex, options = {}) {
  const normalizedHex = String(hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalizedHex)) return [];
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
        alt_geom AS altGeom, on_ground AS onGround, gs, track, messages
      FROM track_points
      WHERE hex = ? AND position_at >= ? AND position_at <= ?
      ORDER BY position_at ASC
      LIMIT ?
    `)
    .all(normalizedHex, from, to, limit)
    .map((row) => ({ ...row, onGround: Boolean(row.onGround) }));
}
