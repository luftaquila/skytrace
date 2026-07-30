import { isValidAircraftId } from "./ingest.mjs";

export const DEFAULT_HISTORY_PAGE_POINTS = 2000;
export const MAX_HISTORY_PAGE_POINTS = 5000;

const DETAIL_COLUMNS = `
  id, hex, receiver_id AS receiverId, observed_at AS observedAt,
  position_at AS positionAt, lat, lon, alt_baro AS altBaro,
  alt_geom AS altGeom, on_ground AS onGround, gs, ias, tas, mach,
  track, true_heading AS trueHeading, mag_heading AS magHeading,
  baro_rate AS baroRate, geom_rate AS geomRate,
  wd AS windDirection, ws AS windSpeed, oat, tat,
  source_type AS sourceType, messages, rssi
`;

const statementsByDatabase = new WeakMap();

function statements(db) {
  let cached = statementsByDatabase.get(db);
  if (cached) return cached;
  cached = {
    latest: db.prepare(`
      SELECT ${DETAIL_COLUMNS}
      FROM track_points
      WHERE hex = ? AND position_at >= ? AND position_at <= ?
      ORDER BY position_at DESC, id DESC
      LIMIT ?
    `),
    before: db.prepare(`
      SELECT ${DETAIL_COLUMNS}
      FROM track_points
      WHERE hex = ? AND position_at >= ?
        AND (position_at, id) < (?, ?)
      ORDER BY position_at DESC, id DESC
      LIMIT ?
    `),
    cursor: db.prepare("SELECT hex, position_at FROM track_points WHERE id = ?"),
    maxId: db.prepare(`
      SELECT MAX(id) AS id FROM track_points
      WHERE hex = ? AND position_at >= ? AND position_at <= ?
    `),
  };
  statementsByDatabase.set(db, cached);
  return cached;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    id: Number(row.id),
    hex: row.hex,
    at: row.positionAt,
  })).toString("base64url");
}

function decodeCursor(value) {
  if (typeof value !== "string" || !value || value.length > 256) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !decoded
      || !Number.isSafeInteger(decoded.id)
      || decoded.id < 1
      || !isValidAircraftId(decoded.hex)
      || typeof decoded.at !== "string"
      || !Number.isFinite(Date.parse(decoded.at))
      || encodeCursor({ id: decoded.id, hex: decoded.hex, positionAt: decoded.at }) !== value
    ) return null;
    return decoded;
  } catch {
    return null;
  }
}

function queryError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function queryAircraftHistory(db, hexValue, options = {}) {
  const hex = String(hexValue || "").trim().toLowerCase();
  if (!isValidAircraftId(hex)) throw queryError(400, "invalid aircraft id");
  const nowMs = Date.parse(options.now || new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new TypeError("invalid history clock");
  const now = new Date(nowMs).toISOString();
  const retentionDays = Math.max(1, Math.min(365, Number(options.retentionDays) || 90));
  const retentionCutoff = new Date(nowMs - retentionDays * 86400000).toISOString();
  const limit = Math.max(
    1,
    Math.min(MAX_HISTORY_PAGE_POINTS, Number(options.limit) || DEFAULT_HISTORY_PAGE_POINTS),
  );
  if (options.olderCursor && options.at) {
    throw queryError(400, "olderCursor and at cannot be used together");
  }
  const at = options.at ? new Date(options.at) : null;
  if (at && (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(retentionCutoff) || at.getTime() > nowMs)) {
    throw queryError(400, "at must be within retained history");
  }

  return db.transaction(() => {
    const sql = statements(db);
    const max = sql.maxId.get(hex, retentionCutoff, now);
    const liveCursorId = max?.id == null ? null : Number(max.id);
    let rows;
    if (options.olderCursor) {
      const cursor = decodeCursor(options.olderCursor);
      if (!cursor || cursor.hex !== hex) throw queryError(400, "invalid olderCursor");
      const boundary = sql.cursor.get(cursor.id);
      if (!boundary) {
        if (Date.parse(cursor.at) < Date.parse(retentionCutoff)) {
          throw queryError(410, "history cursor expired");
        }
        throw queryError(400, "invalid olderCursor");
      }
      if (boundary.hex !== hex || boundary.position_at !== cursor.at) {
        throw queryError(400, "invalid olderCursor");
      }
      if (boundary.position_at < retentionCutoff) throw queryError(410, "history cursor expired");
      rows = sql.before.all(hex, retentionCutoff, boundary.position_at, cursor.id, limit + 1);
    } else if (at) {
      rows = sql.before.all(hex, retentionCutoff, at.toISOString(), Number.MAX_SAFE_INTEGER, limit + 1);
    } else {
      rows = sql.latest.all(hex, retentionCutoff, now, limit + 1);
    }
    const hasOlder = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page.at(-1);
    page.reverse();
    return {
      hex,
      points: page.map((row) => ({ ...row, onGround: Boolean(row.onGround) })),
      liveCursorId,
      olderCursor: hasOlder && oldest ? encodeCursor(oldest) : null,
      hasOlder,
      retentionCutoff,
    };
  })();
}
