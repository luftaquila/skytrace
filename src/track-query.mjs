const TRACK_BREAK_MS = 10 * 60 * 1000;
const AIRCRAFT_ID_RE = /^~?[0-9a-f]{6}$/;
const EARTH_RADIUS_M = 6371008.8;
const RECORDED_SIMPLIFY_TOLERANCE_M = 500;

function normalizeRequests(requests, maxAircraft) {
  const unique = new Map();
  for (const request of requests || []) {
    const hex = String(request?.hex || "").trim().toLowerCase();
    if (!AIRCRAFT_ID_RE.test(hex) || unique.has(hex)) continue;
    const afterId = request?.afterId == null ? Number.NaN : Number(request.afterId);
    unique.set(hex, {
      hex,
      afterId: Number.isSafeInteger(afterId) && afterId >= 0 ? afterId : null,
    });
    if (unique.size >= maxAircraft) break;
  }
  return [...unique.values()];
}

function latestContinuousRun(points, gapMs = TRACK_BREAK_MS) {
  let start = 0;
  let previousTime = null;
  for (let index = 0; index < points.length; index += 1) {
    const time = Date.parse(points[index].positionAt);
    if (Number.isFinite(time) && Number.isFinite(previousTime) && time - previousTime > gapMs) start = index;
    if (Number.isFinite(time)) previousTime = time;
  }
  return points.slice(start);
}

function isoOr(value, fallback) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function safeRowId(value) {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function metricPoint(point, origin) {
  const latitude = Number(point.lat) * Math.PI / 180;
  let longitudeDelta = Number(point.lon) - origin.lon;
  longitudeDelta = ((longitudeDelta + 540) % 360) - 180;
  return {
    x: longitudeDelta * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(origin.latRadians),
    y: (latitude - origin.latRadians) * EARTH_RADIUS_M,
    z: Number(point.altBaro ?? point.altGeom ?? 0) * 0.3048,
  };
}

function segmentDistanceSquared(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (!lengthSquared) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    const pz = point.z - start.z;
    return px * px + py * py + pz * pz;
  }
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy + (point.z - start.z) * dz) / lengthSquared));
  const px = point.x - (start.x + projection * dx);
  const py = point.y - (start.y + projection * dy);
  const pz = point.z - (start.z + projection * dz);
  return px * px + py * py + pz * pz;
}

function simplifyRange(points, metric, start, end, toleranceSquared, keep) {
  const stack = [[start, end]];
  keep.add(start);
  keep.add(end);
  while (stack.length) {
    const [rangeStart, rangeEnd] = stack.pop();
    let furthest = -1;
    let furthestDistance = toleranceSquared;
    for (let index = rangeStart + 1; index < rangeEnd; index += 1) {
      const distance = segmentDistanceSquared(metric[index], metric[rangeStart], metric[rangeEnd]);
      if (distance > furthestDistance) {
        furthest = index;
        furthestDistance = distance;
      }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      stack.push([rangeStart, furthest], [furthest, rangeEnd]);
    }
  }
}

function simplifyContinuousRun(points, toleranceMeters) {
  if (points.length <= 2) return points;
  const origin = {
    lon: Number(points[0].lon),
    latRadians: Number(points[0].lat) * Math.PI / 180,
  };
  const metric = points.map((point) => metricPoint(point, origin));
  const mandatory = new Set([0, points.length - 1]);
  let altitudeAnchor = Number(points[0].altBaro ?? points[0].altGeom);
  let onGroundAnchor = Boolean(points[0].onGround);
  for (let index = 1; index < points.length; index += 1) {
    const onGround = Boolean(points[index].onGround);
    if (onGround !== onGroundAnchor) {
      mandatory.add(index - 1);
      mandatory.add(index);
      onGroundAnchor = onGround;
    }
    const altitude = Number(points[index].altBaro ?? points[index].altGeom);
    if (Number.isFinite(altitude)
      && (!Number.isFinite(altitudeAnchor) || Math.abs(altitude - altitudeAnchor) >= 500)) {
      mandatory.add(index);
      altitudeAnchor = altitude;
    }
  }
  const boundaries = [...mandatory].sort((a, b) => a - b);
  const keep = new Set();
  const toleranceSquared = toleranceMeters * toleranceMeters;
  for (let index = 1; index < boundaries.length; index += 1) {
    simplifyRange(points, metric, boundaries[index - 1], boundaries[index], toleranceSquared, keep);
  }
  return [...keep].sort((a, b) => a - b).map((index) => points[index]);
}

// Recorded-history mode can cover months of five-second samples. Preserve every flight break,
// endpoint, turn, climb/descent shape and 500-ft colour transition while removing redundant
// collinear samples before JSON serialization and WebGL buffer construction.
export function simplifyRecordedTrack(points, toleranceMeters = RECORDED_SIMPLIFY_TOLERANCE_M) {
  if (!points?.length) return [];
  const simplified = [];
  let start = 0;
  for (let index = 1; index <= points.length; index += 1) {
    const previousTime = Date.parse(points[index - 1]?.positionAt);
    const time = Date.parse(points[index]?.positionAt);
    const isBreak = index === points.length
      || (Number.isFinite(time) && Number.isFinite(previousTime) && time - previousTime > TRACK_BREAK_MS);
    if (!isBreak) continue;
    simplified.push(...simplifyContinuousRun(points.slice(start, index), toleranceMeters));
    start = index;
  }
  return simplified;
}

// Bulk track query for the aircraft currently rendered by the client. Each aircraft carries its
// own row-id cursor, so refreshes return only newly stored points while one indexed SQL statement
// serves the whole visible set. The payload intentionally contains only fields used by trail
// rendering; the selected-aircraft endpoint remains the full telemetry/history API.
export function queryAircraftTracks(db, requests, options = {}) {
  const maxAircraft = Math.max(1, Math.min(options.maxAircraft || 250, 250));
  const normalized = normalizeRequests(requests, maxAircraft);
  const nowMs = Date.parse(options.now || new Date().toISOString());
  const to = isoOr(options.to, new Date(nowMs).toISOString());
  const from = isoOr(options.from, new Date(nowMs - 24 * 60 * 60 * 1000).toISOString());
  const limit = Math.max(1, Math.min(options.limit || 10000, 10000));
  const historic = options.historic === true;
  const maxId = safeRowId(options.maxId);

  if (!normalized.length) return { from, to, historic, tracks: [] };

  const values = normalized.map(() => "(?, ?)").join(", ");
  const requestParams = normalized.flatMap(({ hex, afterId }) => [hex, afterId]);
  const rows = db.prepare(`
    WITH requested(hex, after_id) AS (VALUES ${values}),
    matched AS (
      SELECT
        t.id, t.hex, t.position_at AS positionAt, t.lat, t.lon,
        t.alt_baro AS altBaro, t.alt_geom AS altGeom, t.on_ground AS onGround,
        ROW_NUMBER() OVER (
          PARTITION BY t.hex
          ORDER BY t.position_at DESC, t.id DESC
        ) AS rowNumber
      FROM track_points t
      JOIN requested r ON r.hex = t.hex
      WHERE t.position_at >= ? AND t.position_at <= ?
        AND (r.after_id IS NULL OR t.id > r.after_id)
        AND (? IS NULL OR t.id <= ?)
    )
    SELECT id, hex, positionAt, lat, lon, altBaro, altGeom, onGround
    FROM matched
    WHERE rowNumber <= ?
    ORDER BY hex ASC, positionAt ASC, id ASC
  `).all(...requestParams, from, to, maxId, maxId, limit);

  const byHex = new Map(normalized.map(({ hex }) => [hex, []]));
  for (const row of rows) {
    byHex.get(row.hex)?.push({ ...row, onGround: Boolean(row.onGround) });
  }

  return {
    from,
    to,
    historic,
    tracks: normalized.map(({ hex, afterId }) => {
      const points = byHex.get(hex) || [];
      const cursorId = points.reduce((max, point) => Math.max(max, point.id), afterId ?? 0) || null;
      return {
        hex,
        cursorId,
        truncated: points.length === limit,
        points: historic ? points : latestContinuousRun(points),
      };
    }),
  };
}

function recordedTrackResult(track) {
  const points = simplifyRecordedTrack(track.points);
  return {
    ...track,
    rawPointCount: track.points.length,
    points,
  };
}

function compactRecordedTrack(track) {
  return {
    ...track,
    points: track.points.map((point) => [
      point.id,
      point.positionAt,
      point.lat,
      point.lon,
      point.altBaro,
      point.altGeom,
      point.onGround ? 1 : 0,
    ]),
  };
}

// All-time recorded tracks use a stable max-id snapshot paged by aircraft hex. Once the snapshot
// is loaded, a single global row-id cursor returns only new points, including aircraft that first
// appear after the snapshot. This keeps refresh traffic proportional to new observations rather
// than the 100+ MB lifetime database.
export function queryRecordedAircraftTracks(db, options = {}) {
  const pageSize = Math.max(1, Math.min(Number(options.pageSize) || 250, 250));
  const perAircraftLimit = Math.max(1, Math.min(Number(options.limit) || 10000, 10000));
  const afterId = safeRowId(options.afterId);

  if (afterId != null) {
    const updateLimit = Math.max(1, Math.min(Number(options.updateLimit) || 50000, 50000));
    const rows = db.prepare(`
      SELECT id, hex, position_at AS positionAt, lat, lon,
        alt_baro AS altBaro, alt_geom AS altGeom, on_ground AS onGround
      FROM track_points
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(afterId, updateLimit + 1);
    const hasMore = rows.length > updateLimit;
    const included = hasMore ? rows.slice(0, updateLimit) : rows;
    const byHex = new Map();
    for (const row of included) {
      const points = byHex.get(row.hex) || [];
      points.push({ ...row, onGround: Boolean(row.onGround) });
      byHex.set(row.hex, points);
    }
    let tracks = [...byHex].map(([hex, points]) => ({
      hex,
      points: simplifyRecordedTrack(points.sort((a, b) =>
        String(a.positionAt).localeCompare(String(b.positionAt)) || a.id - b.id)),
    }));
    if (options.compact === true) tracks = tracks.map(compactRecordedTrack);
    return {
      mode: "incremental",
      historic: true,
      format: options.compact === true ? "compact-v1" : "objects-v1",
      cursorId: included.at(-1)?.id ?? afterId,
      hasMore,
      tracks,
    };
  }

  const requestedSnapshotId = safeRowId(options.snapshotId);
  const snapshotId = requestedSnapshotId
    ?? Number(db.prepare("SELECT COALESCE(MAX(id), 0) FROM track_points").pluck().get());
  const pageAfterHex = AIRCRAFT_ID_RE.test(String(options.pageAfterHex || "").toLowerCase())
    ? String(options.pageAfterHex).toLowerCase()
    : null;
  const hexRows = db.prepare(`
    SELECT hex
    FROM track_points
    WHERE id <= ? AND (? IS NULL OR hex > ?)
    GROUP BY hex
    ORDER BY hex ASC
    LIMIT ?
  `).all(snapshotId, pageAfterHex, pageAfterHex, pageSize + 1);
  const hasMore = hexRows.length > pageSize;
  const hexes = hexRows.slice(0, pageSize).map((row) => row.hex);
  const result = queryAircraftTracks(db, hexes.map((hex) => ({ hex })), {
    from: "1970-01-01T00:00:00.000Z",
    to: "9999-12-31T23:59:59.999Z",
    historic: true,
    limit: perAircraftLimit,
    maxAircraft: pageSize,
    maxId: snapshotId,
  });
  let tracks = result.tracks.map(recordedTrackResult);
  if (options.compact === true) tracks = tracks.map(compactRecordedTrack);
  return {
    mode: "snapshot",
    historic: true,
    format: options.compact === true ? "compact-v1" : "objects-v1",
    snapshotId,
    nextHex: hasMore ? hexes.at(-1) : null,
    tracks,
  };
}
