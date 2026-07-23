const NM_TO_M = 1852;
const FT_TO_M = 0.3048;

const CUBE_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pointAltitude(row) {
  return finiteNumber(row.alt_baro ?? row.alt_geom ?? row.altBaro ?? row.altGeom);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function gridIndex(field, x, y, z) {
  return x + field.nx * (y + field.ny * z);
}

function cellIndex(field, x, y, z) {
  return x + (field.nx - 1) * (y + (field.ny - 1) * z);
}

function gridPoint(field, x, y, z) {
  return [
    (field.minEastNm + x * field.horizontalStepNm) * NM_TO_M,
    (field.minNorthNm + y * field.horizontalStepNm) * NM_TO_M,
    (field.minAltitudeFt + z * field.verticalStepFt) * FT_TO_M,
  ];
}

function interpolate(a, b, aValue, bValue, isoLevel) {
  const span = bValue - aValue;
  const t = Math.abs(span) < 1e-12 ? 0.5 : clamp((isoLevel - aValue) / span, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function localPoint(row, origin, cosLat) {
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  const altitudeFt = pointAltitude(row);
  if (lat == null || lon == null || altitudeFt == null || altitudeFt < 0 || altitudeFt > 80000) return null;
  return {
    eastNm: (lon - origin.lon) * cosLat * 60,
    northNm: (lat - origin.lat) * 60,
    altitudeFt,
    hex: String(row.hex || ""),
    timeMs: Date.parse(row.position_at ?? row.positionAt ?? ""),
  };
}

function distance3Steps(a, b, horizontalStepNm, verticalStepFt) {
  return Math.max(
    Math.hypot(b.eastNm - a.eastNm, b.northNm - a.northNm) / horizontalStepNm,
    Math.abs(b.altitudeFt - a.altitudeFt) / verticalStepFt,
  );
}

function coverageSamples(points, options) {
  const samples = [...points];
  const byAircraft = new Map();
  for (const point of points) {
    if (!point.hex || !Number.isFinite(point.timeMs)) continue;
    const list = byAircraft.get(point.hex) || [];
    list.push(point);
    byAircraft.set(point.hex, list);
  }

  // Stored points normally arrive every five seconds. Interpolating only short, physically
  // plausible runs prevents polling gaps from punching slits through an otherwise observed
  // flight path without drawing bridges between separate flights or unrelated aircraft.
  for (const list of byAircraft.values()) {
    list.sort((a, b) => a.timeMs - b.timeMs);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      const dtSeconds = (b.timeMs - a.timeMs) / 1000;
      const horizontalNm = Math.hypot(b.eastNm - a.eastNm, b.northNm - a.northNm);
      if (!(dtSeconds > 0 && dtSeconds <= options.maxSegmentSeconds)
        || horizontalNm > options.maxSegmentNm
        || Math.abs(b.altitudeFt - a.altitudeFt) > options.maxSegmentAltitudeFt) continue;
      const steps = Math.min(24, Math.ceil(distance3Steps(a, b, options.horizontalStepNm * 0.75, options.verticalStepFt * 0.75)));
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        samples.push({
          eastNm: a.eastNm + (b.eastNm - a.eastNm) * t,
          northNm: a.northNm + (b.northNm - a.northNm) * t,
          altitudeFt: a.altitudeFt + (b.altitudeFt - a.altitudeFt) * t,
        });
      }
    }
  }

  // Repeated traffic in the same small cell cannot expand an observed-volume union. Removing
  // those duplicates keeps a 50k-point refresh comfortably below the five-minute budget.
  const unique = new Map();
  const h = options.horizontalStepNm * 0.5;
  const v = options.verticalStepFt * 0.5;
  for (const point of samples) {
    const key = `${Math.round(point.eastNm / h)},${Math.round(point.northNm / h)},${Math.round(point.altitudeFt / v)}`;
    if (!unique.has(key)) unique.set(key, point);
  }
  return [...unique.values()];
}

function fieldBounds(points, options) {
  let minEastNm = Infinity;
  let maxEastNm = -Infinity;
  let minNorthNm = Infinity;
  let maxNorthNm = -Infinity;
  let minAltitudeFt = Infinity;
  let maxAltitudeFt = -Infinity;
  for (const point of points) {
    minEastNm = Math.min(minEastNm, point.eastNm);
    maxEastNm = Math.max(maxEastNm, point.eastNm);
    minNorthNm = Math.min(minNorthNm, point.northNm);
    maxNorthNm = Math.max(maxNorthNm, point.northNm);
    minAltitudeFt = Math.min(minAltitudeFt, point.altitudeFt);
    maxAltitudeFt = Math.max(maxAltitudeFt, point.altitudeFt);
  }

  const horizontalPadding = options.horizontalSupportNm + options.horizontalStepNm;
  const verticalPadding = options.verticalSupportFt + options.verticalStepFt;
  return {
    minEastNm: Math.floor((minEastNm - horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    maxEastNm: Math.ceil((maxEastNm + horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    minNorthNm: Math.floor((minNorthNm - horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    maxNorthNm: Math.ceil((maxNorthNm + horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    minAltitudeFt: Math.max(
      -options.verticalSupportFt,
      Math.floor((minAltitudeFt - verticalPadding) / options.verticalStepFt) * options.verticalStepFt,
    ),
    maxAltitudeFt: Math.ceil((maxAltitudeFt + verticalPadding) / options.verticalStepFt) * options.verticalStepFt,
  };
}

function gridShape(bounds, horizontalStepNm, verticalStepFt) {
  const nx = Math.round((bounds.maxEastNm - bounds.minEastNm) / horizontalStepNm) + 1;
  const ny = Math.round((bounds.maxNorthNm - bounds.minNorthNm) / horizontalStepNm) + 1;
  const nz = Math.round((bounds.maxAltitudeFt - bounds.minAltitudeFt) / verticalStepFt) + 1;
  return { nx, ny, nz, gridNodes: nx * ny * nz };
}

export function sampleObservedCoverageField(field, eastNm, northNm, altitudeFt) {
  const gx = (eastNm - field.minEastNm) / field.horizontalStepNm;
  const gy = (northNm - field.minNorthNm) / field.horizontalStepNm;
  const gz = (altitudeFt - field.minAltitudeFt) / field.verticalStepFt;
  if (gx < 0 || gy < 0 || gz < 0 || gx > field.nx - 1 || gy > field.ny - 1 || gz > field.nz - 1) return 0;

  const x0 = Math.min(field.nx - 2, Math.floor(gx));
  const y0 = Math.min(field.ny - 2, Math.floor(gy));
  const z0 = Math.min(field.nz - 2, Math.floor(gz));
  const tx = clamp(gx - x0, 0, 1);
  const ty = clamp(gy - y0, 0, 1);
  const tz = clamp(gz - z0, 0, 1);
  let value = 0;
  for (let dz = 0; dz <= 1; dz += 1) {
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dx = 0; dx <= 1; dx += 1) {
        const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        value += field.values[gridIndex(field, x0 + dx, y0 + dy, z0 + dz)] * weight;
      }
    }
  }
  return value;
}

export function buildObservedCoverageField(rows, origin, rawOptions = {}) {
  let horizontalStepNm = Math.max(0.75, Number(rawOptions.horizontalStepNm) || 2.5);
  let verticalStepFt = Math.max(250, Number(rawOptions.verticalStepFt) || 1000);
  const supportHorizontalRatio = Math.max(1.25, (Number(rawOptions.horizontalSupportNm) || 4.5) / horizontalStepNm);
  const supportVerticalRatio = Math.max(1.25, (Number(rawOptions.verticalSupportFt) || 2500) / verticalStepFt);
  const maxCells = Math.max(25000, Number(rawOptions.maxCells) || 1200000);
  const requestedIsoLevel = clamp(Number(rawOptions.isoLevel) || 0.16, 0.02, 0.8);
  const cosLat = Math.cos(Number(origin.lat) * Math.PI / 180) || 1e-6;
  const points = rows.map((row) => localPoint(row, origin, cosLat)).filter(Boolean);
  if (points.length < 4) return null;

  let options;
  let bounds;
  let shape;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    options = {
      horizontalStepNm,
      verticalStepFt,
      horizontalSupportNm: supportHorizontalRatio * horizontalStepNm,
      verticalSupportFt: supportVerticalRatio * verticalStepFt,
      maxSegmentSeconds: Math.max(15, Number(rawOptions.maxSegmentSeconds) || 90),
      maxSegmentNm: Math.max(2, Number(rawOptions.maxSegmentNm) || 15),
      maxSegmentAltitudeFt: Math.max(1000, Number(rawOptions.maxSegmentAltitudeFt) || 6000),
    };
    bounds = fieldBounds(points, options);
    shape = gridShape(bounds, horizontalStepNm, verticalStepFt);
    if (shape.gridNodes <= maxCells) break;
    const scale = Math.max(1.08, Math.cbrt(shape.gridNodes / maxCells) * 1.04);
    horizontalStepNm *= scale;
    verticalStepFt *= scale;
  }
  if (shape.gridNodes > maxCells) {
    throw new Error(`coverage occupancy grid ${shape.nx}x${shape.ny}x${shape.nz} exceeds ${maxCells} nodes`);
  }

  const samples = coverageSamples(points, options);
  const field = {
    ...shape,
    ...options,
    minEastNm: bounds.minEastNm,
    minNorthNm: bounds.minNorthNm,
    minAltitudeFt: bounds.minAltitudeFt,
    values: new Float32Array(shape.gridNodes),
    points,
    samples,
    isoLevel: requestedIsoLevel,
  };

  for (const point of samples) {
    const minX = Math.max(0, Math.ceil((point.eastNm - field.horizontalSupportNm - field.minEastNm) / horizontalStepNm));
    const maxX = Math.min(field.nx - 1, Math.floor((point.eastNm + field.horizontalSupportNm - field.minEastNm) / horizontalStepNm));
    const minY = Math.max(0, Math.ceil((point.northNm - field.horizontalSupportNm - field.minNorthNm) / horizontalStepNm));
    const maxY = Math.min(field.ny - 1, Math.floor((point.northNm + field.horizontalSupportNm - field.minNorthNm) / horizontalStepNm));
    const minZ = Math.max(0, Math.ceil((point.altitudeFt - field.verticalSupportFt - field.minAltitudeFt) / verticalStepFt));
    const maxZ = Math.min(field.nz - 1, Math.floor((point.altitudeFt + field.verticalSupportFt - field.minAltitudeFt) / verticalStepFt));
    for (let z = minZ; z <= maxZ; z += 1) {
      const dz = (field.minAltitudeFt + z * verticalStepFt - point.altitudeFt) / field.verticalSupportFt;
      for (let y = minY; y <= maxY; y += 1) {
        const dy = (field.minNorthNm + y * horizontalStepNm - point.northNm) / field.horizontalSupportNm;
        for (let x = minX; x <= maxX; x += 1) {
          const dx = (field.minEastNm + x * horizontalStepNm - point.eastNm) / field.horizontalSupportNm;
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          if (distanceSquared >= 1) continue;
          const strength = (1 - distanceSquared) ** 2;
          const index = gridIndex(field, x, y, z);
          if (strength > field.values[index]) field.values[index] = strength;
        }
      }
    }
  }

  let minObservedField = Infinity;
  for (const point of points) {
    minObservedField = Math.min(minObservedField, sampleObservedCoverageField(field, point.eastNm, point.northNm, point.altitudeFt));
  }
  field.isoLevel = Math.min(requestedIsoLevel, minObservedField * 0.9);
  field.minObservedField = minObservedField;
  return field;
}

function pushQuad(indices, ids, reverse) {
  const [a, b, c, d] = reverse ? [ids[0], ids[3], ids[2], ids[1]] : ids;
  if (new Set([a, b, c, d]).size < 4) return;
  indices.push(a, b, c, a, c, d);
}

export function polygonizeObservedCoverageField(field, rawOptions = {}) {
  const isoLevel = field.isoLevel;
  const maxTriangles = Math.max(1000, Number(rawOptions.maxTriangles) || 200000);
  const cellIds = new Int32Array((field.nx - 1) * (field.ny - 1) * (field.nz - 1));
  cellIds.fill(-1);
  const positions = [];

  for (let z = 0; z < field.nz - 1; z += 1) {
    for (let y = 0; y < field.ny - 1; y += 1) {
      for (let x = 0; x < field.nx - 1; x += 1) {
        const values = CUBE_OFFSETS.map(([dx, dy, dz]) => field.values[gridIndex(field, x + dx, y + dy, z + dz)]);
        const insideCount = values.reduce((count, value) => count + (value >= isoLevel ? 1 : 0), 0);
        if (insideCount === 0 || insideCount === 8) continue;
        const points = CUBE_OFFSETS.map(([dx, dy, dz]) => gridPoint(field, x + dx, y + dy, z + dz));
        const crossings = [];
        for (const [a, b] of CUBE_EDGES) {
          if ((values[a] >= isoLevel) === (values[b] >= isoLevel)) continue;
          crossings.push(interpolate(points[a], points[b], values[a], values[b], isoLevel));
        }
        if (!crossings.length) continue;
        const vertex = crossings.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0])
          .map((value) => value / crossings.length);
        const id = positions.length / 3;
        positions.push(...vertex);
        cellIds[cellIndex(field, x, y, z)] = id;
      }
    }
  }

  const cellId = (x, y, z) => cellIds[cellIndex(field, x, y, z)];
  const indices = [];
  const crossing = (a, b) => (a >= isoLevel) !== (b >= isoLevel);
  const addQuad = (ids, reverse) => {
    if (ids.some((id) => id < 0)) return;
    pushQuad(indices, ids, reverse);
    if (indices.length / 3 > maxTriangles) throw new Error(`coverage occupancy mesh exceeds ${maxTriangles} triangles`);
  };

  // One quad surrounds every sign-changing grid edge. The four adjacent active cells share their
  // surface-net vertices, producing a compact, watertight indexed mesh instead of triangle soup.
  for (let z = 1; z < field.nz - 1; z += 1) {
    for (let y = 1; y < field.ny - 1; y += 1) {
      for (let x = 0; x < field.nx - 1; x += 1) {
        const a = field.values[gridIndex(field, x, y, z)];
        const b = field.values[gridIndex(field, x + 1, y, z)];
        if (crossing(a, b)) addQuad([
          cellId(x, y - 1, z - 1), cellId(x, y, z - 1), cellId(x, y, z), cellId(x, y - 1, z),
        ], a >= isoLevel);
      }
    }
  }
  for (let z = 1; z < field.nz - 1; z += 1) {
    for (let y = 0; y < field.ny - 1; y += 1) {
      for (let x = 1; x < field.nx - 1; x += 1) {
        const a = field.values[gridIndex(field, x, y, z)];
        const b = field.values[gridIndex(field, x, y + 1, z)];
        if (crossing(a, b)) addQuad([
          cellId(x - 1, y, z - 1), cellId(x - 1, y, z), cellId(x, y, z), cellId(x, y, z - 1),
        ], a < isoLevel);
      }
    }
  }
  for (let z = 0; z < field.nz - 1; z += 1) {
    for (let y = 1; y < field.ny - 1; y += 1) {
      for (let x = 1; x < field.nx - 1; x += 1) {
        const a = field.values[gridIndex(field, x, y, z)];
        const b = field.values[gridIndex(field, x, y, z + 1)];
        if (crossing(a, b)) addQuad([
          cellId(x - 1, y - 1, z), cellId(x, y - 1, z), cellId(x, y, z), cellId(x - 1, y, z),
        ], a >= isoLevel);
      }
    }
  }

  return { positions: Float32Array.from(positions), indices };
}

function encodeQuantizedMesh(surface) {
  const vertexCount = surface.positions.length / 3;
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < surface.positions.length; i += 3) {
    bounds[0] = Math.min(bounds[0], surface.positions[i]);
    bounds[1] = Math.min(bounds[1], surface.positions[i + 1]);
    bounds[2] = Math.min(bounds[2], surface.positions[i + 2]);
    bounds[3] = Math.max(bounds[3], surface.positions[i]);
    bounds[4] = Math.max(bounds[4], surface.positions[i + 1]);
    bounds[5] = Math.max(bounds[5], surface.positions[i + 2]);
  }
  const spans = [
    Math.max(1e-6, bounds[3] - bounds[0]),
    Math.max(1e-6, bounds[4] - bounds[1]),
    Math.max(1e-6, bounds[5] - bounds[2]),
  ];
  const quantized = new Uint16Array(surface.positions.length);
  for (let i = 0; i < surface.positions.length; i += 1) {
    const axis = i % 3;
    quantized[i] = Math.round((surface.positions[i] - bounds[axis]) / spans[axis] * 65535);
  }
  const IndexArray = vertexCount <= 65535 ? Uint16Array : Uint32Array;
  const indices = IndexArray.from(surface.indices);
  return {
    encoding: "quantized-uint16-le-base64",
    positions: Buffer.from(quantized.buffer).toString("base64"),
    positionBounds: bounds.map((value) => Number(value.toFixed(3))),
    indexEncoding: IndexArray === Uint16Array ? "uint16-le-base64" : "uint32-le-base64",
    indices: Buffer.from(indices.buffer).toString("base64"),
    vertexCount,
    triangleCount: indices.length / 3,
    binaryBytes: quantized.byteLength + indices.byteLength,
  };
}

export function buildObservedCoverageMesh(rows, origin, options = {}) {
  const startedAt = performance.now();
  const field = buildObservedCoverageField(rows, origin, options);
  if (!field) return null;
  const surface = polygonizeObservedCoverageField(field, options);
  if (!surface.positions.length || !surface.indices.length) return null;
  const encoded = encodeQuantizedMesh(surface);
  const occupiedNodes = field.values.reduce((count, value) => count + (value >= field.isoLevel ? 1 : 0), 0);
  return {
    type: "observed-occupancy-surface",
    origin: [Number(origin.lon.toFixed(6)), Number(origin.lat.toFixed(6))],
    ...encoded,
    sourcePointCount: field.points.length,
    samplePointCount: field.samples.length,
    horizontalStepNm: Number(field.horizontalStepNm.toFixed(3)),
    verticalStepFt: Number(field.verticalStepFt.toFixed(1)),
    supportHorizontalNm: Number(field.horizontalSupportNm.toFixed(3)),
    supportVerticalFt: Number(field.verticalSupportFt.toFixed(1)),
    isoLevel: Number(field.isoLevel.toFixed(6)),
    stats: {
      grid: [field.nx, field.ny, field.nz],
      gridNodes: field.values.length,
      occupiedNodes,
      minObservedField: Number(field.minObservedField.toFixed(6)),
      generatedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      binaryBytes: encoded.binaryBytes,
    },
  };
}
