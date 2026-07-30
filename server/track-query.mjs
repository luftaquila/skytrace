const MAX_BULK_TRACK_AIRCRAFT = 32;
const MAX_BULK_TRACK_ROWS = 10000;
const MAX_BULK_LOOKBACK_HOURS = 24;

const AIRCRAFT_ID_RE = /^~?[0-9a-f]{6}$/;
const statementsByDatabase = new WeakMap();

function statements(db) {
  let cached = statementsByDatabase.get(db);
  if (cached) return cached;
  cached = {
    cursor: db.prepare("SELECT hex, position_at FROM track_points WHERE id = ?"),
    compact: db.prepare(`
      SELECT
        id, position_at AS positionAt, lat, lon, alt_baro AS altBaro,
        alt_geom AS altGeom, on_ground AS onGround, track
      FROM track_points
      WHERE hex = ? AND id > ? AND position_at >= ?
      ORDER BY id ASC
      LIMIT ?
    `),
    detail: db.prepare(`
      SELECT
        id, position_at AS positionAt, observed_at AS observedAt, lat, lon,
        alt_baro AS altBaro, alt_geom AS altGeom, on_ground AS onGround,
        gs, ias, tas, mach, track, true_heading AS trueHeading,
        mag_heading AS magHeading, baro_rate AS baroRate, geom_rate AS geomRate,
        wd AS windDirection, ws AS windSpeed, oat, tat,
        source_type AS sourceType, messages, rssi
      FROM track_points
      WHERE hex = ? AND id > ? AND position_at >= ?
      ORDER BY id ASC
      LIMIT ?
    `),
  };
  statementsByDatabase.set(db, cached);
  return cached;
}

export function normalizeBulkTrackRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => !["aircraft", "detail"].includes(key))) return null;
  if (!Array.isArray(body.aircraft) || body.aircraft.length > MAX_BULK_TRACK_AIRCRAFT) return null;
  const detail = body.detail == null ? null : String(body.detail).trim().toLowerCase();
  if (detail != null && !AIRCRAFT_ID_RE.test(detail)) return null;
  const seen = new Set();
  const aircraft = [];
  for (const item of body.aircraft) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (Object.keys(item).some((key) => !["hex", "afterId"].includes(key))) return null;
    const hex = String(item.hex || "").trim().toLowerCase();
    const afterId = Number(item.afterId);
    if (
      !AIRCRAFT_ID_RE.test(hex)
      || seen.has(hex)
      || !Number.isSafeInteger(afterId)
      || afterId < 1
    ) return null;
    seen.add(hex);
    aircraft.push({ hex, afterId });
  }
  if (detail != null && !seen.has(detail)) return null;
  return { aircraft, detail };
}

export function queryAircraftTracks(db, request, options = {}) {
  const normalized = normalizeBulkTrackRequest(request);
  if (!normalized) throw new TypeError("invalid bulk track request");
  const nowMs = Date.parse(options.now || new Date().toISOString());
  const lookbackHours = Math.max(
    1,
    Math.min(MAX_BULK_LOOKBACK_HOURS, Number(options.lookbackHours) || MAX_BULK_LOOKBACK_HOURS),
  );
  const cutoff = new Date(nowMs - lookbackHours * 3600000).toISOString();
  const sql = statements(db);
  const valid = [];
  const reset = new Set();
  for (const item of normalized.aircraft) {
    const cursor = sql.cursor.get(item.afterId);
    if (!cursor || cursor.hex !== item.hex || cursor.position_at < cutoff || cursor.position_at > new Date(nowMs).toISOString()) {
      reset.add(item.hex);
    } else {
      valid.push(item);
    }
  }
  const share = valid.length ? Math.max(1, Math.floor(MAX_BULK_TRACK_ROWS / valid.length)) : 0;
  const tracks = normalized.aircraft.map((item) => {
    if (reset.has(item.hex)) {
      return {
        hex: item.hex,
        cursorId: item.afterId,
        hasMore: false,
        resetRequired: true,
        truncated: false,
        points: [],
      };
    }
    const statement = item.hex === normalized.detail ? sql.detail : sql.compact;
    const rows = statement.all(item.hex, item.afterId, cutoff, share + 1);
    const hasMore = rows.length > share;
    const points = rows.slice(0, share).map((row) => ({ ...row, onGround: Boolean(row.onGround) }));
    return {
      hex: item.hex,
      cursorId: points.at(-1)?.id ?? item.afterId,
      hasMore,
      resetRequired: false,
      truncated: hasMore,
      points,
    };
  });
  return { tracks };
}
