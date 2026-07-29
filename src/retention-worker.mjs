import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "./db.mjs";

const CHUNK_SIZE = 2000;
const DEFAULT_BUDGET_MS = 30000;

function deleteChunks(db, sql, params, deadline) {
  const statement = db.prepare(sql);
  let deleted = 0;
  let firstAttempt = true;
  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false;
    const changes = statement.run(...params, CHUNK_SIZE).changes;
    deleted += changes;
    if (changes < CHUNK_SIZE) return { deleted, complete: true };
  }
  return { deleted, complete: false };
}

function runRetention(db, request) {
  const nowMs = Date.parse(request.now);
  if (!Number.isFinite(nowMs)) throw new Error("invalid retention clock");
  const now = new Date(nowMs).toISOString();
  const futureCutoff = new Date(nowMs + 5 * 60000).toISOString();
  const trackCutoff = new Date(nowMs - request.trackRetentionDays * 86400000).toISOString();
  const batchCutoff = new Date(nowMs - request.batchRetentionDays * 86400000).toISOString();
  const currentCutoff = new Date(nowMs - request.currentRetentionHours * 3600000).toISOString();
  const deadline = Date.now() + (request.budgetMs || DEFAULT_BUDGET_MS);
  const cursorWarnings = db.prepare(`
    SELECT t.receiver_id AS receiverId, COUNT(*) AS count, MAX(t.id) AS maxId,
           s.last_track_id AS coverageCursor
    FROM track_points t
    JOIN coverage_receiver_state s ON s.receiver_id = t.receiver_id
    WHERE t.position_at < ? AND t.id > s.last_track_id
    GROUP BY t.receiver_id
    ORDER BY t.receiver_id
  `).all(trackCutoff);
  const futureTrackRows = db.prepare(`
    SELECT receiver_id AS receiverId, COUNT(*) AS count, MAX(position_at) AS maxTimestamp
    FROM track_points
    WHERE position_at > ?
    GROUP BY receiver_id
    ORDER BY receiver_id
  `).all(futureCutoff).map((row) => ({ table: "track_points", ...row }));
  const futureCurrentRows = db.prepare(`
    SELECT receiver_id AS receiverId, COUNT(*) AS count, MAX(observed_at) AS maxTimestamp
    FROM receiver_aircraft_current
    WHERE observed_at > ?
    GROUP BY receiver_id
    ORDER BY receiver_id
  `).all(futureCutoff).map((row) => ({ table: "receiver_aircraft_current", ...row }));
  const results = {};
  const tasks = [
    ["trackOld", `
      DELETE FROM track_points WHERE id IN (
        SELECT id FROM track_points WHERE position_at < ? ORDER BY position_at ASC LIMIT ?
      )
    `, [trackCutoff]],
    ["trackFuture", `
      DELETE FROM track_points WHERE id IN (
        SELECT id FROM track_points WHERE position_at > ? ORDER BY position_at DESC LIMIT ?
      )
    `, [futureCutoff]],
    ["batches", `
      DELETE FROM ingest_batches WHERE id IN (
        SELECT id FROM ingest_batches WHERE received_at < ? ORDER BY received_at ASC LIMIT ?
      )
    `, [batchCutoff]],
    ["currentOld", `
      DELETE FROM receiver_aircraft_current WHERE rowid IN (
        SELECT rowid FROM receiver_aircraft_current
        WHERE observed_at < ? ORDER BY observed_at ASC LIMIT ?
      )
    `, [currentCutoff]],
    ["currentFuture", `
      DELETE FROM receiver_aircraft_current WHERE rowid IN (
        SELECT rowid FROM receiver_aircraft_current
        WHERE observed_at > ? ORDER BY observed_at DESC LIMIT ?
      )
    `, [futureCutoff]],
  ];
  let complete = true;
  for (const [name, sql, params] of tasks) {
    // Give every task one chunk per run even after the soft deadline. This both
    // prevents starvation and lets an already-empty task report completion.
    const result = deleteChunks(db, sql, params, deadline);
    results[name] = result.deleted;
    if (!result.complete) complete = false;
  }
  const storage = {
    pageCount: db.pragma("page_count", { simple: true }),
    freelistCount: db.pragma("freelist_count", { simple: true }),
  };
  return {
    now,
    complete,
    ...results,
    cursorWarnings,
    futureRows: [...futureTrackRows, ...futureCurrentRows],
    storage,
  };
}

const db = openDatabase(workerData.dbPath, { migrate: false });
parentPort.on("message", (message) => {
  if (message.type === "run") {
    try {
      parentPort.postMessage({ id: message.id, ok: true, result: runRetention(db, message) });
    } catch (error) {
      parentPort.postMessage({ id: message.id, ok: false, error: error?.message || "retention failed" });
    }
  } else if (message.type === "close") {
    db.close();
    parentPort.postMessage({ id: message.id, ok: true, closed: true });
    parentPort.close();
  }
});
