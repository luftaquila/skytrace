const TRACK_BREAK_MS = 10 * 60 * 1000;
const AIRCRAFT_ID_RE = /^~?[0-9a-f]{6}$/;

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
    )
    SELECT id, hex, positionAt, lat, lon, altBaro, altGeom, onGround
    FROM matched
    WHERE rowNumber <= ?
    ORDER BY hex ASC, positionAt ASC, id ASC
  `).all(...requestParams, from, to, limit);

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
