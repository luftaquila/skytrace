import test from "node:test";
import assert from "node:assert/strict";
import {
  buildObservedCoverageField,
  buildObservedCoverageMesh,
  sampleObservedCoverageField,
} from "../src/coverage-volume.mjs";

const ORIGIN = { lat: 36.372628, lon: 127.333295 };

function observation(eastNm, northNm, altitudeFt, extra = {}) {
  const cosLat = Math.cos(ORIGIN.lat * Math.PI / 180);
  return {
    lat: ORIGIN.lat + northNm / 60,
    lon: ORIGIN.lon + eastNm / cosLat / 60,
    alt_baro: altitudeFt,
    ...extra,
  };
}

function meshIndices(mesh) {
  const bytes = Buffer.from(mesh.indices, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bits = mesh.indexEncoding.startsWith("uint16") ? 16 : 32;
  return Array.from({ length: bytes.byteLength / (bits / 8) }, (_, i) => (
    bits === 16 ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true)
  ));
}

test("observed field contains every reception while retaining a genuinely empty centre", () => {
  const rows = [];
  for (const altitudeFt of [9000, 10500, 12000]) {
    for (let bearing = 0; bearing < 360; bearing += 20) {
      const angle = bearing * Math.PI / 180;
      rows.push(observation(12 * Math.sin(angle), 12 * Math.cos(angle), altitudeFt));
    }
  }

  const field = buildObservedCoverageField(rows, ORIGIN, {
    horizontalStepNm: 1.5,
    verticalStepFt: 750,
    horizontalSupportNm: 2.5,
    verticalSupportFt: 1500,
  });
  assert.ok(field);
  assert.ok(field.minObservedField > field.isoLevel);
  for (const point of field.points) {
    assert.ok(sampleObservedCoverageField(field, point.eastNm, point.northNm, point.altitudeFt) >= field.isoLevel);
  }
  assert.equal(sampleObservedCoverageField(field, 0, 0, 10500), 0);
});

test("short consecutive track segments fill their traversed cells without global gap filling", () => {
  const base = Date.parse("2026-07-23T00:00:00Z");
  const rows = [-8, -4, 4, 8].map((eastNm, index) => observation(eastNm, 0, 10000, {
    hex: "71f7d2",
    position_at: new Date(base + index * 30000).toISOString(),
  }));
  const field = buildObservedCoverageField(rows, ORIGIN, {
    horizontalStepNm: 1,
    verticalStepFt: 500,
    horizontalSupportNm: 1.5,
    verticalSupportFt: 1000,
  });
  assert.ok(sampleObservedCoverageField(field, 0, 0, 10000) >= field.isoLevel);

  const unrelated = [
    observation(-10, 0, 10000, { hex: "aaa001" }),
    observation(-10, 1, 10500, { hex: "aaa001" }),
    observation(10, 0, 10000, { hex: "bbb002" }),
    observation(10, -1, 10500, { hex: "bbb002" }),
  ];
  const separated = buildObservedCoverageField(unrelated, ORIGIN, {
    horizontalStepNm: 1,
    verticalStepFt: 500,
    horizontalSupportNm: 2,
    verticalSupportFt: 1000,
  });
  assert.equal(sampleObservedCoverageField(separated, 0, 0, 10000), 0);
});

test("horizontal interpolation fills a narrow corridor gap without bridging a wide void", () => {
  const nearbyCorridors = [
    observation(-2, 0, 10000),
    observation(-2, 0.1, 10000),
    observation(2, 0, 10000),
    observation(2, -0.1, 10000),
  ];
  const rawField = buildObservedCoverageField(nearbyCorridors, ORIGIN, {
    horizontalStepNm: 1,
    verticalStepFt: 500,
    horizontalSupportNm: 1.5,
    verticalSupportFt: 1000,
    horizontalInterpolationCells: 0,
  });
  assert.ok(sampleObservedCoverageField(rawField, 0, 0, 10000) < rawField.isoLevel);

  const interpolatedField = buildObservedCoverageField(nearbyCorridors, ORIGIN, {
    horizontalStepNm: 1,
    verticalStepFt: 500,
    horizontalSupportNm: 1.5,
    verticalSupportFt: 1000,
    horizontalInterpolationCells: 1,
  });
  assert.ok(sampleObservedCoverageField(interpolatedField, 0, 0, 10000) >= interpolatedField.isoLevel);

  const distantCorridors = [
    observation(-8, 0, 10000),
    observation(-8, 0.1, 10000),
    observation(8, 0, 10000),
    observation(8, -0.1, 10000),
  ];
  const separatedField = buildObservedCoverageField(distantCorridors, ORIGIN, {
    horizontalStepNm: 1,
    verticalStepFt: 500,
    horizontalSupportNm: 1.5,
    verticalSupportFt: 1000,
    horizontalInterpolationCells: 1,
  });
  assert.equal(sampleObservedCoverageField(separatedField, 0, 0, 10000), 0);
});

test("surface-net mesh is watertight, indexed, and compact", () => {
  const rows = [];
  for (const altitudeFt of [6000, 9000, 12000, 15000]) {
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const angle = bearing * Math.PI / 180;
      const range = 8 + altitudeFt / 3000;
      rows.push(observation(range * Math.sin(angle), range * Math.cos(angle), altitudeFt));
    }
  }
  const mesh = buildObservedCoverageMesh(rows, ORIGIN, {
    horizontalStepNm: 1.5,
    verticalStepFt: 750,
    horizontalSupportNm: 3,
    verticalSupportFt: 1800,
  });
  assert.equal(mesh.type, "observed-occupancy-surface");
  assert.equal(mesh.encoding, "quantized-uint16-le-base64");
  assert.ok(mesh.vertexCount > 0);
  assert.ok(mesh.triangleCount > 0);
  assert.equal(mesh.sourcePointCount, rows.length);
  assert.equal(Buffer.from(mesh.positions, "base64").byteLength, mesh.vertexCount * 3 * 2);

  const indices = meshIndices(mesh);
  assert.equal(indices.length, mesh.triangleCount * 3);
  assert.ok(Math.max(...indices) < mesh.vertexCount);
  const edges = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    for (const [a, b] of [[indices[i], indices[i + 1]], [indices[i + 1], indices[i + 2]], [indices[i + 2], indices[i]]]) {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  assert.equal([...edges.values()].filter((count) => count !== 2).length, 0);
  assert.ok(mesh.stats.binaryBytes < mesh.triangleCount * 9 * Float32Array.BYTES_PER_ELEMENT);
});
