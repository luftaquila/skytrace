import { buildCoverageSnapshotFromRows } from "./ingest.mjs";

const DEFAULT_WINDOW_HOURS = 24 * 30;
const DEFAULT_CHUNK_SIZE = 5000;
const MAX_SEGMENT_STEPS = 24;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isoDate(value, fallback = new Date().toISOString()) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizeOptions(raw = {}) {
  const coverageWindowHours = Math.max(1, Number(raw.coverageWindowHours) || DEFAULT_WINDOW_HOURS);
  const horizontalStepNm = Math.max(0.75, Number(raw.coverageHorizontalStepNm) || 2);
  const verticalStepFt = Math.max(250, Number(raw.coverageVerticalStepFt) || 800);
  const cellHorizontalStepNm = Math.max(0.25, Number(raw.coverageCellHorizontalStepNm) || horizontalStepNm / 2);
  const cellVerticalStepFt = Math.max(100, Number(raw.coverageCellVerticalStepFt) || verticalStepFt / 2);
  const maxSegmentSeconds = Math.max(15, Number(raw.coverageMaxSegmentSeconds) || 90);
  const maxSegmentNm = Math.max(2, Number(raw.coverageMaxSegmentNm) || 15);
  const maxSegmentAltitudeFt = Math.max(1000, Number(raw.coverageMaxSegmentAltitudeFt) || 6000);
  const schemaKey = [
    "coverage-cells-v1",
    coverageWindowHours.toFixed(3),
    cellHorizontalStepNm.toFixed(6),
    cellVerticalStepFt.toFixed(3),
    maxSegmentSeconds.toFixed(1),
    maxSegmentNm.toFixed(3),
    maxSegmentAltitudeFt.toFixed(1),
  ].join(":");
  return {
    ...raw,
    coverageWindowHours,
    coverageHorizontalStepNm: horizontalStepNm,
    coverageVerticalStepFt: verticalStepFt,
    coverageCellHorizontalStepNm: cellHorizontalStepNm,
    coverageCellVerticalStepFt: cellVerticalStepFt,
    coverageMaxSegmentSeconds: maxSegmentSeconds,
    coverageMaxSegmentNm: maxSegmentNm,
    coverageMaxSegmentAltitudeFt: maxSegmentAltitudeFt,
    coverageAggregationChunkSize: clamp(
      Math.floor(Number(raw.coverageAggregationChunkSize) || DEFAULT_CHUNK_SIZE),
      100,
      50000,
    ),
    schemaKey,
  };
}

function pointAltitude(row) {
  return finiteNumber(row.altitude_ft ?? row.alt_baro ?? row.alt_geom ?? row.altBaro ?? row.altGeom);
}

function validPoint(row) {
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  const altitudeFt = pointAltitude(row);
  const timeMs = Date.parse(row.position_at ?? row.positionAt ?? "");
  if (lat == null || lon == null || altitudeFt == null || !Number.isFinite(timeMs)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || altitudeFt < 0 || altitudeFt > 80000) return null;
  return {
    id: Number(row.id) || 0,
    hex: String(row.hex || "").toLowerCase(),
    lat,
    lon,
    altitudeFt,
    positionAt: new Date(timeMs).toISOString(),
    timeMs,
  };
}

function localCoordinates(point, origin) {
  return {
    eastNm: (point.lon - origin.lon) * origin.cosLat * 60,
    northNm: (point.lat - origin.lat) * 60,
    altitudeFt: point.altitudeFt,
  };
}

function interpolatePoint(a, b, fraction) {
  return {
    lat: a.lat + (b.lat - a.lat) * fraction,
    lon: a.lon + (b.lon - a.lon) * fraction,
    altitudeFt: a.altitudeFt + (b.altitudeFt - a.altitudeFt) * fraction,
    positionAt: b.positionAt,
    timeMs: a.timeMs + (b.timeMs - a.timeMs) * fraction,
  };
}

function cellForPoint(point, origin, options) {
  const local = localCoordinates(point, origin);
  const cellX = Math.round(local.eastNm / options.coverageCellHorizontalStepNm);
  const cellY = Math.round(local.northNm / options.coverageCellHorizontalStepNm);
  const cellZ = Math.round(local.altitudeFt / options.coverageCellVerticalStepFt);
  const eastNm = cellX * options.coverageCellHorizontalStepNm;
  const northNm = cellY * options.coverageCellHorizontalStepNm;
  return {
    cellX,
    cellY,
    cellZ,
    lat: origin.lat + northNm / 60,
    lon: origin.lon + eastNm / origin.cosLat / 60,
    altitudeFt: cellZ * options.coverageCellVerticalStepFt,
    lastSeenAt: point.positionAt,
    hitCount: 1,
  };
}

function addCell(cells, point, origin, options) {
  const cell = cellForPoint(point, origin, options);
  const key = `${cell.cellX},${cell.cellY},${cell.cellZ}`;
  const previous = cells.get(key);
  if (!previous) {
    cells.set(key, cell);
    return;
  }
  previous.hitCount += 1;
  if (cell.lastSeenAt > previous.lastSeenAt) previous.lastSeenAt = cell.lastSeenAt;
}

function addPointAndSegment(cells, previous, point, origin, options) {
  addCell(cells, point, origin, options);
  if (!previous) return;
  const dtSeconds = (point.timeMs - previous.timeMs) / 1000;
  if (!(dtSeconds > 0 && dtSeconds <= options.coverageMaxSegmentSeconds)) return;
  const a = localCoordinates(previous, origin);
  const b = localCoordinates(point, origin);
  const horizontalNm = Math.hypot(b.eastNm - a.eastNm, b.northNm - a.northNm);
  const altitudeDeltaFt = Math.abs(point.altitudeFt - previous.altitudeFt);
  if (horizontalNm > options.coverageMaxSegmentNm
    || altitudeDeltaFt > options.coverageMaxSegmentAltitudeFt) return;
  const steps = Math.min(MAX_SEGMENT_STEPS, Math.ceil(Math.max(
    horizontalNm / (options.coverageCellHorizontalStepNm * 0.75),
    altitudeDeltaFt / (options.coverageCellVerticalStepFt * 0.75),
  )));
  for (let step = 1; step < steps; step += 1) {
    addCell(cells, interpolatePoint(previous, point, step / steps), origin, options);
  }
}

function stateOrigin(db, receiver, cutoff) {
  const receiverLat = finiteNumber(receiver.lat);
  const receiverLon = finiteNumber(receiver.lon);
  if (receiverLat != null && receiverLon != null) return { lat: receiverLat, lon: receiverLon };
  const first = db.prepare(`
    SELECT lat, lon
    FROM track_points
    WHERE receiver_id = ? AND position_at >= ?
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY position_at ASC, id ASC
    LIMIT 1
  `).get(receiver.id, cutoff);
  return first ? { lat: Number(first.lat), lon: Number(first.lon) } : null;
}

function loadTrackState(db, receiverId) {
  const state = new Map();
  const rows = db.prepare(`
    SELECT hex, position_at, lat, lon, altitude_ft
    FROM coverage_track_state
    WHERE receiver_id = ?
  `).all(receiverId);
  for (const row of rows) {
    const point = validPoint(row);
    if (point) state.set(String(row.hex), { ...point, hex: String(row.hex) });
  }
  return state;
}

function ensureReceiverState(db, receiver, cutoff, options, now) {
  const current = db.prepare(`
    SELECT receiver_id, schema_key, origin_lat, origin_lon, last_track_id
    FROM coverage_receiver_state
    WHERE receiver_id = ?
  `).get(receiver.id);
  const receiverLat = finiteNumber(receiver.lat);
  const receiverLon = finiteNumber(receiver.lon);
  const configuredOrigin = receiverLat != null && receiverLon != null
    ? { lat: receiverLat, lon: receiverLon }
    : null;
  const originChanged = configuredOrigin && current
    ? Math.abs(configuredOrigin.lat - Number(current.origin_lat)) > 1e-7
      || Math.abs(configuredOrigin.lon - Number(current.origin_lon)) > 1e-7
    : false;
  if (current?.schema_key === options.schemaKey && !originChanged) {
    return {
      receiverId: receiver.id,
      origin: {
        lat: Number(current.origin_lat),
        lon: Number(current.origin_lon),
        cosLat: Math.cos(Number(current.origin_lat) * Math.PI / 180) || 1e-6,
      },
      lastTrackId: Number(current.last_track_id) || 0,
      rebuilt: false,
    };
  }

  const originCoordinates = configuredOrigin
    || (current ? { lat: Number(current.origin_lat), lon: Number(current.origin_lon) } : null)
    || stateOrigin(db, receiver, cutoff);
  if (!originCoordinates) return null;
  const firstActive = db.prepare(`
    SELECT MIN(id) AS id
    FROM track_points
    WHERE receiver_id = ? AND position_at >= ?
  `).get(receiver.id, cutoff);
  const firstActiveId = Number(firstActive?.id);
  const lastTrackId = Number.isSafeInteger(firstActiveId) && firstActiveId > 0 ? firstActiveId - 1 : 0;

  db.transaction(() => {
    db.prepare("DELETE FROM coverage_cells WHERE receiver_id = ?").run(receiver.id);
    db.prepare("DELETE FROM coverage_track_state WHERE receiver_id = ?").run(receiver.id);
    db.prepare(`
      INSERT INTO coverage_receiver_state (
        receiver_id, schema_key, origin_lat, origin_lon, last_track_id, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(receiver_id) DO UPDATE SET
        schema_key = excluded.schema_key,
        origin_lat = excluded.origin_lat,
        origin_lon = excluded.origin_lon,
        last_track_id = excluded.last_track_id,
        updated_at = excluded.updated_at
    `).run(
      receiver.id,
      options.schemaKey,
      originCoordinates.lat,
      originCoordinates.lon,
      lastTrackId,
      now,
    );
  })();

  return {
    receiverId: receiver.id,
    origin: {
      ...originCoordinates,
      cosLat: Math.cos(originCoordinates.lat * Math.PI / 180) || 1e-6,
    },
    lastTrackId,
    rebuilt: true,
  };
}

function persistChunk(db, receiverState, cells, touchedTracks, cursor, options, now) {
  const upsertCell = db.prepare(`
    INSERT INTO coverage_cells (
      receiver_id, schema_key, cell_x, cell_y, cell_z,
      lat, lon, altitude_ft, last_seen_at, hit_count
    )
    VALUES (
      @receiverId, @schemaKey, @cellX, @cellY, @cellZ,
      @lat, @lon, @altitudeFt, @lastSeenAt, @hitCount
    )
    ON CONFLICT(receiver_id, schema_key, cell_x, cell_y, cell_z) DO UPDATE SET
      last_seen_at = CASE
        WHEN excluded.last_seen_at > coverage_cells.last_seen_at
        THEN excluded.last_seen_at
        ELSE coverage_cells.last_seen_at
      END,
      hit_count = coverage_cells.hit_count + excluded.hit_count
  `);
  const upsertTrack = db.prepare(`
    INSERT INTO coverage_track_state (
      receiver_id, hex, position_at, lat, lon, altitude_ft
    )
    VALUES (@receiverId, @hex, @positionAt, @lat, @lon, @altitudeFt)
    ON CONFLICT(receiver_id, hex) DO UPDATE SET
      position_at = excluded.position_at,
      lat = excluded.lat,
      lon = excluded.lon,
      altitude_ft = excluded.altitude_ft
    WHERE excluded.position_at > coverage_track_state.position_at
  `);
  const updateCursor = db.prepare(`
    UPDATE coverage_receiver_state
    SET last_track_id = ?, updated_at = ?
    WHERE receiver_id = ? AND schema_key = ?
  `);
  db.transaction(() => {
    for (const cell of cells.values()) {
      upsertCell.run({
        receiverId: receiverState.receiverId,
        schemaKey: options.schemaKey,
        ...cell,
      });
    }
    for (const point of touchedTracks.values()) {
      upsertTrack.run({
        receiverId: receiverState.receiverId,
        hex: point.hex,
        positionAt: point.positionAt,
        lat: point.lat,
        lon: point.lon,
        altitudeFt: point.altitudeFt,
      });
    }
    updateCursor.run(cursor, now, receiverState.receiverId, options.schemaKey);
  })();
}

function syncReceiver(db, receiver, cutoff, options, now) {
  const receiverState = ensureReceiverState(db, receiver, cutoff, options, now);
  if (!receiverState) {
    return {
      receiverId: receiver.id,
      rawPoints: 0,
      cellWrites: 0,
      changed: false,
      skipped: true,
    };
  }
  const target = db.prepare(`
    SELECT MAX(id) AS id
    FROM track_points
    WHERE receiver_id = ?
  `).get(receiver.id);
  const targetTrackId = Number(target?.id) || receiverState.lastTrackId;
  if (receiverState.lastTrackId >= targetTrackId) {
    return {
      receiverId: receiver.id,
      rawPoints: 0,
      cellWrites: 0,
      changed: receiverState.rebuilt,
      skipped: false,
    };
  }

  const selectChunk = db.prepare(`
    SELECT id, hex, position_at, lat, lon, alt_baro, alt_geom
    FROM track_points
    WHERE receiver_id = ?
      AND id > ?
      AND id <= ?
      AND position_at >= ?
      AND lat IS NOT NULL
      AND lon IS NOT NULL
    ORDER BY id ASC
    LIMIT ?
  `);
  const trackState = loadTrackState(db, receiver.id);
  let cursor = receiverState.lastTrackId;
  let rawPoints = 0;
  let cellWrites = 0;

  while (cursor < targetTrackId) {
    const rows = selectChunk.all(
      receiver.id,
      cursor,
      targetTrackId,
      cutoff,
      options.coverageAggregationChunkSize,
    );
    if (!rows.length) {
      persistChunk(db, receiverState, new Map(), new Map(), targetTrackId, options, now);
      cursor = targetTrackId;
      break;
    }

    const cells = new Map();
    const touchedTracks = new Map();
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.id) || cursor);
      const point = validPoint(row);
      if (!point) continue;
      const previous = trackState.get(point.hex);
      addPointAndSegment(cells, previous, point, receiverState.origin, options);
      if (!previous || point.timeMs > previous.timeMs) {
        trackState.set(point.hex, point);
        touchedTracks.set(point.hex, point);
      }
      rawPoints += 1;
    }
    const persistedCursor = rows.length < options.coverageAggregationChunkSize
      ? targetTrackId
      : cursor;
    persistChunk(db, receiverState, cells, touchedTracks, persistedCursor, options, now);
    cellWrites += cells.size;
    cursor = persistedCursor;
  }
  return {
    receiverId: receiver.id,
    rawPoints,
    cellWrites,
    changed: receiverState.rebuilt || rawPoints > 0,
    skipped: false,
  };
}

export function syncCoverageCells(db, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const now = isoDate(rawOptions.now);
  const cutoff = new Date(Date.parse(now) - options.coverageWindowHours * 3600 * 1000).toISOString();

  const expiredReceiverIds = new Set(db.prepare(`
    SELECT DISTINCT receiver_id
    FROM coverage_cells
    WHERE last_seen_at < ?
  `).all(cutoff).map((row) => row.receiver_id));
  db.transaction(() => {
    db.prepare("DELETE FROM coverage_cells WHERE last_seen_at < ?").run(cutoff);
    db.prepare("DELETE FROM coverage_track_state WHERE position_at < ?").run(cutoff);
  })();

  const receivers = db.prepare(`
    SELECT r.id, r.public_name, r.lat, r.lon
    FROM receivers r
    JOIN (
      SELECT DISTINCT receiver_id
      FROM track_points
      WHERE position_at >= ?
    ) active ON active.receiver_id = r.id
    ORDER BY r.id
  `).all(cutoff);

  const receiverStats = receivers.map((receiver) => {
    const stats = syncReceiver(db, receiver, cutoff, options, now);
    if (expiredReceiverIds.has(receiver.id)) stats.changed = true;
    return stats;
  });
  return {
    now,
    cutoff,
    schemaKey: options.schemaKey,
    receiverCount: receivers.length,
    rawPoints: receiverStats.reduce((sum, item) => sum + item.rawPoints, 0),
    cellWrites: receiverStats.reduce((sum, item) => sum + item.cellWrites, 0),
    receivers: receiverStats,
  };
}

function mergeBounds(current, next) {
  if (!next) return current;
  if (!current) return next;
  return [
    [Math.min(current[0][0], next[0][0]), Math.min(current[0][1], next[0][1])],
    [Math.max(current[1][0], next[1][0]), Math.max(current[1][1], next[1][1])],
  ];
}

export function buildCoverageFromCells(db, rawOptions = {}, aggregation = null, receiverCache = null) {
  const options = normalizeOptions(rawOptions);
  const now = isoDate(rawOptions.now);
  const cutoff = new Date(Date.parse(now) - options.coverageWindowHours * 3600 * 1000).toISOString();
  const receivers = db.prepare(`
    SELECT
      s.receiver_id,
      r.public_name AS receiver_name,
      r.lat AS receiver_lat,
      r.lon AS receiver_lon,
      COUNT(*) AS cell_count,
      MAX(c.last_seen_at) AS last_seen_at
    FROM coverage_receiver_state s
    JOIN receivers r ON r.id = s.receiver_id
    JOIN coverage_cells c
      ON c.receiver_id = s.receiver_id
      AND c.schema_key = s.schema_key
    WHERE s.schema_key = ?
      AND c.last_seen_at >= ?
    GROUP BY s.receiver_id
    ORDER BY s.receiver_id
  `).all(options.schemaKey, cutoff);

  const selectCells = db.prepare(`
    SELECT
      c.receiver_id,
      NULL AS hex,
      r.public_name AS receiver_name,
      r.lat AS receiver_lat,
      r.lon AS receiver_lon,
      c.last_seen_at AS position_at,
      c.lat,
      c.lon,
      c.altitude_ft AS alt_baro,
      NULL AS alt_geom
    FROM coverage_cells c
    JOIN receivers r ON r.id = c.receiver_id
    WHERE c.receiver_id = ?
      AND c.schema_key = ?
      AND c.last_seen_at >= ?
    ORDER BY c.cell_z, c.cell_y, c.cell_x
  `);

  const areas = [];
  let count = 0;
  let bounds = null;
  let meshesRebuilt = 0;
  let meshesReused = 0;
  const receiverStats = new Map((aggregation?.receivers || []).map((item) => [item.receiverId, item]));
  const activeReceiverIds = new Set();
  for (const receiver of receivers) {
    activeReceiverIds.add(receiver.receiver_id);
    const cached = receiverCache?.get(receiver.receiver_id);
    const stats = receiverStats.get(receiver.receiver_id);
    const receiverSignature = JSON.stringify([
      receiver.receiver_name,
      receiver.receiver_lat,
      receiver.receiver_lon,
    ]);
    const cacheValid = cached
      && cached.schemaKey === options.schemaKey
      && cached.receiverSignature === receiverSignature
      && !stats?.changed;
    let partial;
    if (cacheValid) {
      partial = cached.partial;
      meshesReused += 1;
    } else {
      const rows = selectCells.all(receiver.receiver_id, options.schemaKey, cutoff);
      partial = buildCoverageSnapshotFromRows(rows, {
        ...options,
        now,
        from: cutoff,
      });
      receiverCache?.set(receiver.receiver_id, {
        schemaKey: options.schemaKey,
        receiverSignature,
        partial,
      });
      meshesRebuilt += 1;
    }
    count += partial.count;
    bounds = mergeBounds(bounds, partial.bounds);
    areas.push(...partial.areas);
  }
  if (receiverCache) {
    for (const receiverId of receiverCache.keys()) {
      if (!activeReceiverIds.has(receiverId)) receiverCache.delete(receiverId);
    }
  }

  return {
    from: cutoff,
    to: now,
    windowHours: options.coverageWindowHours,
    windowDays: Number((options.coverageWindowHours / 24).toFixed(2)),
    type: "observed-occupancy",
    count,
    receiverCount: receivers.length,
    bounds,
    areas,
    points: [],
    aggregation: {
      type: "receiver-spatial-cells",
      schemaKey: options.schemaKey,
      cellHorizontalStepNm: options.coverageCellHorizontalStepNm,
      cellVerticalStepFt: options.coverageCellVerticalStepFt,
      rawPointsProcessed: aggregation?.rawPoints ?? 0,
      cellWrites: aggregation?.cellWrites ?? 0,
      activeCells: count,
      meshesRebuilt,
      meshesReused,
    },
  };
}

export function refreshCoverageSnapshot(db, rawOptions = {}) {
  const now = isoDate(rawOptions.now);
  const options = { ...rawOptions, now };
  const aggregation = syncCoverageCells(db, options);
  return buildCoverageFromCells(db, options, aggregation, rawOptions.receiverCache || null);
}

export function coverageCellSchemaKey(rawOptions = {}) {
  return normalizeOptions(rawOptions).schemaKey;
}
