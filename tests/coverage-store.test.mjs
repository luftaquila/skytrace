import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../server/db.mjs";
import {
  buildCoverageFromCells,
  snapCoverageDatum,
  syncCoverageCells,
} from "../server/coverage-store.mjs";

async function withDatabase(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-coverage-store-"));
  const db = openDatabase(path.join(dir, "skytrace.db"));
  db.prepare(`
    INSERT INTO receivers (id, name, public_name, lat, lon, updated_at)
    VALUES ('rx-1', 'Receiver 1', 'Receiver 1', 37.5, 127.0, ?)
  `).run("2026-07-23T00:00:00.000Z");
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function insertTrackStatement(db) {
  return db.prepare(`
    INSERT INTO track_points (
      hex, receiver_id, observed_at, position_at, lat, lon, alt_baro
    )
    VALUES (@hex, @receiverId, @positionAt, @positionAt, @lat, @lon, @altitudeFt)
  `);
}

function addPoints(db, points) {
  const insert = insertTrackStatement(db);
  db.transaction(() => {
    for (const point of points) {
      insert.run({
        receiverId: "rx-1",
        hex: point.hex || "abc123",
        ...point,
      });
    }
  })();
}

const MESH_OPTIONS = {
  coverageWindowHours: 24 * 30,
  coverageHorizontalStepNm: 2,
  coverageVerticalStepFt: 800,
  coverageHorizontalSupportNm: 4.5,
  coverageVerticalSupportFt: 2500,
  coverageHorizontalInterpolationCells: 2,
  coverageHorizontalSmoothingPasses: 2,
  coverageVerticalSmoothingPasses: 4,
  coverageSmoothingIterations: 2,
  coverageMaxCells: 1200000,
  coverageMaxTriangles: 200000,
  coverageAggregationChunkSize: 5000,
};

function refreshWithStats(db, options) {
  const aggregation = syncCoverageCells(db, options);
  const snapshot = buildCoverageFromCells(db, options, aggregation, options.receiverCache || null);
  return { aggregation, snapshot };
}

test("coverage datum coarsens private receiver coordinates and normalizes the antimeridian", async () => {
  assert.deepEqual(snapCoverageDatum(37.61, 127.11), snapCoverageDatum(37.70, 127.20));
  assert.notDeepEqual(snapCoverageDatum(37.61, 127.11), { lat: 37.61, lon: 127.11 });
  assert.deepEqual(snapCoverageDatum(95, 180), { lat: 90, lon: -180 });

  await withDatabase(async (db) => {
    db.prepare("UPDATE receivers SET lat = 37.61, lon = 127.11 WHERE id = 'rx-1'").run();
    addPoints(db, [{
      positionAt: "2026-07-22T23:59:57.000Z",
      lat: 37.62,
      lon: 127.12,
      altitudeFt: 10000,
    }]);
    syncCoverageCells(db, {
      ...MESH_OPTIONS,
      now: "2026-07-23T00:00:00.000Z",
    });
    const state = db.prepare(`
      SELECT origin_lat AS lat, origin_lon AS lon
      FROM coverage_receiver_state
      WHERE receiver_id = 'rx-1'
    `).get();
    assert.deepEqual(state, { lat: 37.5, lon: 127 });
  });
});

test("coverage aggregation uses the full time window instead of truncating at 50k rows", async () => {
  await withDatabase(async (db) => {
    const nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    const insert = insertTrackStatement(db);
    const total = 50005;
    db.transaction(() => {
      for (let index = 0; index < total; index += 1) {
        const cell = index % 4;
        const positionAt = new Date(nowMs - (total - index) * 3000).toISOString();
        insert.run({
          receiverId: "rx-1",
          hex: "abc123",
          positionAt,
          lat: 37.5 + cell * 0.018,
          lon: 127.0 + cell * 0.018,
          altitudeFt: 8000 + cell * 800,
        });
      }
    })();

    const { aggregation, snapshot } = refreshWithStats(db, {
      ...MESH_OPTIONS,
      now: "2026-07-23T00:00:00.000Z",
    });
    assert.equal(aggregation.rawPoints, total);
    assert.ok(snapshot.aggregation.activeCells >= 4);
    assert.equal(snapshot.aggregation.rawPointsProcessed, undefined);
    assert.equal(snapshot.windowDays, 30);
    assert.equal(snapshot.receiverCount, 1);
    assert.ok(snapshot.areas[0].volumeMesh?.triangleCount > 0);
  });
});

test("coverage aggregation advances by track id and expires cells by time window", async () => {
  await withDatabase(async (db) => {
    addPoints(db, [
      {
        positionAt: "2026-07-01T00:00:00.000Z",
        lat: 37.35,
        lon: 126.85,
        altitudeFt: 4000,
      },
      ...[0, 1, 2, 3].map((index) => ({
        positionAt: `2026-07-22T23:59:${String(index * 3).padStart(2, "0")}.000Z`,
        lat: 37.5 + index * 0.018,
        lon: 127.0 + index * 0.018,
        altitudeFt: 8000 + index * 800,
      })),
    ]);
    const options = {
      ...MESH_OPTIONS,
      coverageWindowHours: 24 * 14,
      now: "2026-07-23T00:00:00.000Z",
    };
    const firstBuild = refreshWithStats(db, options);
    const first = firstBuild.snapshot;
    assert.equal(firstBuild.aggregation.rawPoints, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM coverage_cells WHERE lat < 37.4").get().count, 0);

    addPoints(db, [{
      positionAt: "2026-07-23T00:00:12.000Z",
      lat: 37.57,
      lon: 127.07,
      altitudeFt: 11200,
    }]);
    const secondBuild = refreshWithStats(db, {
      ...options,
      now: "2026-07-23T00:01:00.000Z",
    });
    const second = secondBuild.snapshot;
    assert.equal(secondBuild.aggregation.rawPoints, 1);
    assert.ok(second.aggregation.activeCells >= first.aggregation.activeCells);

    const maxTrackId = db.prepare("SELECT MAX(id) AS id FROM track_points WHERE receiver_id = 'rx-1'").get().id;
    const state = db.prepare("SELECT last_track_id FROM coverage_receiver_state WHERE receiver_id = 'rx-1'").get();
    assert.equal(state.last_track_id, maxTrackId);

    const expandedBuild = refreshWithStats(db, {
      ...options,
      coverageWindowHours: 24 * 30,
      now: "2026-07-23T00:01:00.000Z",
    });
    assert.equal(expandedBuild.aggregation.rawPoints, 6);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM coverage_cells WHERE lat < 37.4").get().count > 0);
  });
});

test("persistent worker cache rebuilds only changed receiver partitions", async () => {
  await withDatabase(async (db) => {
    db.prepare(`
      INSERT INTO receivers (id, name, public_name, lat, lon, updated_at)
      VALUES ('rx-2', 'Receiver 2', 'Receiver 2', 37.8, 127.3, ?)
    `).run("2026-07-23T00:00:00.000Z");
    const insert = insertTrackStatement(db);
    db.transaction(() => {
      for (const receiver of [
        { receiverId: "rx-1", lat: 37.5, lon: 127.0, hex: "abc123" },
        { receiverId: "rx-2", lat: 37.8, lon: 127.3, hex: "def456" },
      ]) {
        for (let index = 0; index < 4; index += 1) {
          insert.run({
            ...receiver,
            positionAt: `2026-07-22T23:59:${String(index * 3).padStart(2, "0")}.000Z`,
            lat: receiver.lat + index * 0.018,
            lon: receiver.lon + index * 0.018,
            altitudeFt: 8000 + index * 800,
          });
        }
      }
    })();

    const receiverCache = new Map();
    const firstBuild = refreshWithStats(db, {
      ...MESH_OPTIONS,
      receiverCache,
      now: "2026-07-23T00:00:00.000Z",
    });
    const first = firstBuild.snapshot;
    assert.equal(firstBuild.aggregation.receivers.filter((item) => item.changed).length, 2);
    assert.equal(first.receiverCount, 2);

    const unchangedBuild = refreshWithStats(db, {
      ...MESH_OPTIONS,
      receiverCache,
      now: "2026-07-23T00:01:00.000Z",
    });
    const unchanged = unchangedBuild.snapshot;
    assert.equal(unchangedBuild.aggregation.rawPoints, 0);
    assert.equal(unchanged.receiverCount, 2);

    addPoints(db, [{
      positionAt: "2026-07-23T00:01:03.000Z",
      lat: 37.57,
      lon: 127.07,
      altitudeFt: 11200,
    }]);
    const changedBuild = refreshWithStats(db, {
      ...MESH_OPTIONS,
      receiverCache,
      now: "2026-07-23T00:02:00.000Z",
    });
    const changed = changedBuild.snapshot;
    assert.equal(changedBuild.aggregation.rawPoints, 1);
    assert.equal(changedBuild.aggregation.receivers.filter((item) => item.changed).length, 1);
    assert.equal(changed.receiverCount, 2);
  });
});
